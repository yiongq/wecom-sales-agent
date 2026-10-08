// retention_purge 任务（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」「隐私说明、敏感信息同意、保留期与行权」，
// R20、R23）：每天 3:30（服务器本地时间）一个，dedupe_key 是 retention_purge:<日期>。排程：startJobs 之后第一批认领之前排下一个
// 3:30 的，之后每小时补排一次（已有就什么都不做），执行完同一个事务里排下一天的（第 10 步已做）。
// 执行体（第 16 步）：列出候选会话（库里 updated_at 早于「两个保留期取较短的那个」的，保守候选集，精确判断交给 purge_conversation
// 内部按租户设置与 paid_at 再核一次）；逐个按写队列上的动静跳过——内存里有未落库的改动或正在落库（store.pendingWrite）、
// 内存里的 updatedAt 比我们读到的候选更新且仍在保留期内、这个会话有任务在跑（hasRunningJob，经 setRunningJobChecker 从
// jobs/runner.ts 注入，避免两个模块互相 import）；否则带着候选读到的 lastSeq/updatedAt 当「预期值」调 purge_conversation，
// 成功就同一个 tick 调 store.forgetSession 摘掉内存。最后 purge_expired_traces、purge_finished_jobs，写一行 system.purge 审计
// （diff 只有各类条数）。不属于某个会话的候选分页、trace／任务清理与审计都走 withJobsTx（与会话写队列无关的独立短事务）。
import { writeAudit } from '../db/repo/audit.js';
import type { JobRow } from '../db/repo/jobs.js';
import {
  purgeConversation,
  purgeExpiredTraces,
  purgeFinishedJobs,
  readPurgeCandidates,
  readRetentionSettings,
  type RetentionSettings,
} from '../db/repo/retention.js';
import { forgetSession, getOrder, getSession, pendingWrite, withJobsTx } from '../store.js';
import type { JobOutcome, JobSpec } from './runner.js';

export const RETENTION_PURGE_HOUR = 3;
export const RETENTION_PURGE_MINUTE = 30;
const RETENTION_PURGE_MAX_ATTEMPTS = 3;
/** 每页候选会话数：与启动预载同一量级，一次事务不扫太久 */
const PAGE = 200;

/** jobs/runner.ts 的 hasRunningJob：这个会话有没有本进程正在处理的任务。两个模块互相 import 会循环，经注入打破 */
let runningJobChecker: (sessionId: string) => boolean = () => false;
export function setRunningJobChecker(fn: (sessionId: string) => boolean): void {
  runningJobChecker = fn;
}

/** 本地日期 YYYY-MM-DD */
function localDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** now 之后（含正好这一刻）最近的一个 3:30 */
export function nextPurgeAt(now: number): number {
  const d = new Date(now);
  d.setHours(RETENTION_PURGE_HOUR, RETENTION_PURGE_MINUTE, 0, 0);
  if (d.getTime() < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 下一个要排的 retention_purge（不属于某个会话，payload 不带 sessionId，单独一个事务排） */
export function retentionPurgeSpec(now: number): JobSpec {
  const runAt = nextPurgeAt(now);
  return {
    kind: 'retention_purge',
    dedupeKey: `retention_purge:${localDate(runAt)}`,
    runAt,
    payload: { day: localDate(runAt) },
    maxAttempts: RETENTION_PURGE_MAX_ATTEMPTS,
  };
}

/** 这个会话在内存里现在算不算「还在保留期内」：有没有已付订单决定按哪个保留期算，用的是内存当下的状态，比候选读到的更新 */
function stillWithinRetentionInMemory(sessionId: string, now: number, settings: RetentionSettings): boolean {
  const s = getSession(sessionId);
  if (!s) return false;
  const paid = s.orderIds.some((id) => getOrder(id)?.paidAt != null);
  const days = paid ? settings.customerDays : settings.leadDays;
  return now - s.updatedAt < days * 86_400_000;
}

export interface PurgeResult {
  conversations: number;
  traces: number;
  jobs: number;
  /** 候选里没清掉的，两种原因都算：preFiltered（写队列上有动静、内存更新或有任务在跑，没调 SQL）+ sqlDeclined（调了，SQL 内部重判不符） */
  skipped: number;
  /** 其中有动静被挡在 SQL 调用之前的那部分（变异测试带出的区分：这部分没有它，功能上也大体不出错——SQL 自己的
   *  乐观并发与保留期重判兜底——但停了这道口子，生产上的会话会更容易撞见「清理与写入抢跑」触发的优雅停机，不是纯粹的性能优化） */
  preFiltered: number;
}

/** 执行一次清理：候选分页、逐个清理、trace 与任务清理、写审计。供执行体与自测共用 */
export async function purgeOnce(now: number): Promise<PurgeResult> {
  const settings = await withJobsTx((tx) => readRetentionSettings(tx));
  const cutoff = new Date(now - Math.min(settings.leadDays, settings.customerDays) * 86_400_000);
  let conversationsPurged = 0;
  let skipped = 0;
  let preFiltered = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await withJobsTx((tx) => readPurgeCandidates(tx, cutoff, afterId, PAGE));
    if (!page.length) break;
    afterId = page[page.length - 1]!.id;
    for (const cand of page) {
      if (pendingWrite(cand.id) || stillWithinRetentionInMemory(cand.id, now, settings) || runningJobChecker(cand.id)) {
        skipped += 1;
        preFiltered += 1;
        continue;
      }
      let ok: boolean;
      try {
        ok = await withJobsTx((tx) => purgeConversation(tx, cand.id, new Date(now), cand.lastSeq, cand.updatedAt));
      } catch (e) {
        console.error(`[jobs] retention_purge 清理一个会话失败（继续下一个）:`, e instanceof Error ? e.name : e);
        continue;
      }
      if (ok) {
        forgetSession(cand.id);
        conversationsPurged += 1;
      } else {
        skipped += 1;
      }
    }
    if (page.length < PAGE) break;
  }
  const traces = await withJobsTx((tx) => purgeExpiredTraces(tx, new Date(now)));
  const jobsDeleted = await withJobsTx((tx) => purgeFinishedJobs(tx, new Date(now)));
  // writeAudit 取事务里的 ctx.actor（withJobsTx 内部的 systemCtx：kind='system'、name=null）
  await withJobsTx((tx) =>
    writeAudit(tx, { action: 'system.purge', diff: { conversations: conversationsPurged, traces, jobs: jobsDeleted } }),
  );
  return { conversations: conversationsPurged, traces, jobs: jobsDeleted, skipped, preFiltered };
}

/**
 * 到点执行体：清理一次、标 done，同一个事务里排下一天的。清理本身用真实时钟（Date.now()），不用认领者传入的 now——
 * 那个 now 是「排程判断到点」用的（测试会传一个模拟的未来值来快进排程），SQL 函数要求 p_now 与库的时钟相差不超过 5 分钟，
 * 传一个模拟的未来值进去只会被它拒绝；enqueueNext 仍按 max(now, job.runAt) 算，下一天排到哪一天不受影响
 */
export async function runRetentionPurgeJob(job: JobRow, now: number): Promise<JobOutcome> {
  const r = await purgeOnce(Date.now());
  console.log(
    `[jobs] ${job.dedupeKey} 保留期清理完成：清除会话 ${r.conversations} 个（跳过 ${r.skipped} 个）、` +
      `trace+账本 ${r.traces} 条、过期任务 ${r.jobs} 条`,
  );
  return { status: 'done', enqueueNext: [retentionPurgeSpec(Math.max(now, job.runAt.getTime()) + 1)] };
}
