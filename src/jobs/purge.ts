// retention_purge 任务（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」「隐私说明、敏感信息同意、保留期与行权」，
// R20、R23）：每天 3:30（服务器本地时间）一个，dedupe_key 是 retention_purge:<日期>。排程：startJobs 之后第一批认领之前排下一个
// 3:30 的，之后每小时补排一次（已有就什么都不做），执行完同一个事务里排下一天的（第 10 步已做）。
// 执行体（第 16 步，审查第二轮改过清除 SQL 期间的写队列处理）：列出候选会话（库里 updated_at 早于「两个保留期取较短的那个」
// 的，保守候选集，精确判断交给 purge_conversation 内部按租户设置与 paid_at 再核一次）；逐个先按两条与写队列无关的信号跳过
// ——内存里的 updatedAt 比我们读到的候选更新且仍在保留期内、这个会话有任务在跑（hasRunningJob，经 setRunningJobChecker 从
// jobs/runner.ts 注入，避免两个模块互相 import）；再尝试 store.holdForPurge 挂起这个会话的写队列（没有动静才能拿到持有，
// 原子地做在一次调用里，不像之前的 pendingWrite 那样留一段「检查完→真正调 SQL」之间的缝）——拿不到就算跳过。
// 持有期间带着候选读到的 lastSeq/updatedAt 当「预期值」调 purge_conversation：清除 SQL 一旦真的要删（返回 true），
// 提交之前再同步核一次持有期间有没有被改动（stillClean）；变了就 spec「逐个在它的写队列上处理」要求的「让路」——抛
// PurgeRaceSkip 让这笔事务回滚，这个候选算跳过，写照常补上落库（hold.release() 发现脏了会补一次 kick）。
// 没变就让事务提交，成功就同一个 tick 调 store.forgetSession 摘掉内存（墓碑照旧；只剩「提交之后、forgetSession 之前」那一瞬
// 真的来一笔新写的极窄窗口会被墓碑悄悄吞掉并记一行日志，这是 spec 墓碑设计认可的结果，见「实施记录 · 第 16 步」）。
// 最后 purge_expired_traces、purge_finished_jobs，写一行 system.purge 审计（diff 只有各类条数）。不属于某个会话的候选分页、
// trace／任务清理与审计都走 withJobsTx（与会话写队列无关的独立短事务）。
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
import { forgetSession, getOrder, getSession, holdForPurge, withJobsTx } from '../store.js';
import type { JobOutcome, JobSpec } from './runner.js';

/** 持有期间这个会话被改动了：清除事务按这个信号回滚、让这次写赢（不是真的错误，只是「这一轮清不掉」的信号） */
class PurgeRaceSkip extends Error {}

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
/** 仅供自测：见下面 purgeTickHook 调用点的注释 */
let purgeTickHook: (() => void) | null = null;
export function setPurgeTickHook(fn: (() => void) | null): void {
  purgeTickHook = fn;
}
/**
 * 仅供自测（第 16 步审查第二轮）：拿到持有之后、真正调清除 SQL 之前调一次，带着这个候选的 id，purgeOnce 等它。
 * 用来确定性地模拟「清除 SQL 正在执行时同一会话来了新消息」——这一刻持有已经挂起了写队列，测试在这里触发 saveSession
 * 不会立即落库（kick 被 purgeHeld 挡住）；钩子可以是 async 的，借一段真实延迟核一次 pendingWrite 仍是 true
 * （「去掉持有」这个变异会让 kick 不受拦截地真的去抢落库，本机真实 PG 的往返远小于这段延迟，核得出变红）
 */
let purgeHoldHook: ((sessionId: string) => void | Promise<void>) | null = null;
export function setPurgeHoldHook(fn: ((sessionId: string) => void | Promise<void>) | null): void {
  purgeHoldHook = fn;
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
      if (stillWithinRetentionInMemory(cand.id, now, settings) || runningJobChecker(cand.id)) {
        skipped += 1;
        preFiltered += 1;
        continue;
      }
      // 原子地挂起写队列：拿不到（有未落库的改动、在途落库或 poisoned）当「有动静」跳过，不留「检查完 → 真正调 SQL」之间的缝
      const hold = holdForPurge(cand.id);
      if (!hold) {
        skipped += 1;
        preFiltered += 1;
        continue;
      }
      // 仅供自测：持有已经挂起了这个会话的写队列（kick 被 purgeHeld 挡住），这一刻触发的 saveSession 不会立即落库
      if (purgeHoldHook) await purgeHoldHook(cand.id);
      let ok: boolean;
      try {
        ok = await withJobsTx(async (tx) => {
          const deleted = await purgeConversation(tx, cand.id, new Date(now), cand.lastSeq, cand.updatedAt);
          // 提交之前再同步核一次：持有期间这个会话被改动了（清除 SQL 的 await 期间来了一笔写）就让路——
          // 抛出去让这笔事务回滚，不提交删除，spec「逐个在它的写队列上处理」要求的结果是清理让步、写照常落库
          if (deleted && !hold.stillClean()) throw new PurgeRaceSkip();
          return deleted;
        });
      } catch (e) {
        if (!(e instanceof PurgeRaceSkip)) {
          console.error(`[jobs] retention_purge 清理一个会话失败（继续下一个）:`, e instanceof Error ? e.name : e);
        }
        hold.release();
        if (e instanceof PurgeRaceSkip) skipped += 1;
        continue;
      }
      // 仅供自测（第 16 步）：SQL 一resolve 就标一下，forgetSession（下一行，没有别的 await）是不是真的在同一个 tick 里调用，
      // 不用猜时序——核法见 store.ts 的 forgetSessionProbe 与 __storeTest.setForgetSessionProbe 的注释
      purgeTickHook?.();
      if (ok) {
        // 不调 hold.release()：entry 已经随 forgetSession 从写队列的簿记里摘掉，没有什么可释放的——提交与这里之间
        // 极窄窗口里真的又来一笔写，会带着没提交的改动被 forget() 一并丢弃并记一行日志（见 pg-backend.ts 的注释）
        forgetSession(cand.id);
        conversationsPurged += 1;
      } else {
        hold.release();
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
