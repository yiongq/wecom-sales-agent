// 任务表（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」，R17、不变量 38）：只在 db 存储下有。
// 排程：与会话有关的（跟进、转人工通知，payload 必带 sessionId）随这个会话的下一次落库提交（store 的 queueJobs），其余单独一个事务。
// 认领：每 5 秒一批，status='pending' AND run_at <= now ORDER BY run_at LIMIT 10 FOR UPDATE SKIP LOCKED，改成 running 并提交，再逐个执行。
// 执行体出错（还没到 sending）按 max_attempts 重试；跟进的 sending 与之后的状态由执行体经会话写队列改（记账与 sending 同一次提交）。
// 启动：先把上一个进程留下的 running、sending 归位（running 的跟进回 pending、sending 的跟进记 abandoned 不重发、其余 running 回 pending
// 且 attempts + 1，到 max_attempts 记 failed），再开始认领。停机 normal 段：不再认领，把还没进 sending 的 running 跟进改回 pending。
// 读路径不查库（不变量 9）：认领在后台定时器里，排程与取消经会话写队列。
import {
  cancelPendingJobs,
  claimDueJobs,
  enqueueJob,
  recoverJobsAtStartup,
  setJobStatus,
  type JobKind,
  type JobRow,
  type JobStatus,
} from '../db/repo/jobs.js';
import { onShutdown, queueJobs, sessionStoreMode, withJobsTx, type JobOp } from '../store.js';
import { followupJobs, type PushFn } from './followup.js';
import { runHandoffNotifyJob } from './notify.js';
import { retentionPurgeSpec, runRetentionPurgeJob } from './purge.js';

export type { JobKind, JobRow, JobStatus };

export interface JobSpec {
  kind: JobKind;
  dedupeKey: string;
  runAt: number;
  payload: unknown;
  maxAttempts: number;
}

/** 执行体的结果。done / cancelled / failed / pending 由认领者在一个短事务里写（只改仍是 running 的）；
 *  handled：执行体自己经会话写队列改了状态（跟进进了 sending）；stopped：停机中放弃，留在 running 等停机钩子改回 pending */
export type JobOutcome =
  | { status: 'done' | 'cancelled' | 'failed'; lastError?: string | null; enqueueNext?: JobSpec[] }
  | { status: 'pending'; runAt: number; lastError?: string | null }
  | { status: 'handled' }
  | { status: 'stopped' };
export interface JobCtx {
  /** 执行体把 running → sending 排进会话写队列的同一段同步代码里调：从这一刻起停机不再把它改回 pending */
  markSending(): void;
}
export type JobHandler = (job: JobRow, now: number, ctx: JobCtx) => Promise<JobOutcome>;

const TICK_MS = 5_000;
const BATCH = 10;
/** 执行体出错（推送之前）的重试退避：1、5、15 分钟，之后每 15 分钟 */
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** retention_purge 的排程多久补一次（启动时一次，之后每小时；执行完也排下一天的） */
const PURGE_ENSURE_MS = 3_600_000;
/** 认领与启动归位失败（库连不上）的日志至多每分钟一行 */
const CLAIM_LOG_MS = 60_000;

/** 与会话有关的任务：payload 里的 sessionId */
export function sessionIdOf(payload: unknown): string | null {
  const v = payload && typeof payload === 'object' ? (payload as { sessionId?: unknown }).sessionId : undefined;
  return typeof v === 'string' && v ? v : null;
}

export const enqueueOp = (spec: JobSpec): JobOp => ({ op: 'enqueue', ...spec });

/**
 * 排一个任务。同一 dedupeKey 已有 pending、running 或 sending 的任务时什么都不做（唯一索引兜底）。
 * payload 带 sessionId 的随这个会话的下一次落库提交（demo 类与文件存储下丢弃，R6），否则单独一个事务（失败只记一行）
 */
export function enqueue(spec: JobSpec): void {
  const sid = sessionIdOf(spec.payload);
  if (sid !== null) {
    queueJobs(sid, [enqueueOp(spec)]);
    return;
  }
  void withJobsTx((tx) =>
    enqueueJob(tx, {
      kind: spec.kind,
      dedupeKey: spec.dedupeKey,
      runAt: new Date(spec.runAt),
      payload: spec.payload,
      maxAttempts: spec.maxAttempts,
    }),
  ).catch((e: unknown) => console.error(`[jobs] 排程没写进去（${spec.kind}，${errName(e)}）`));
}

/** 取消这个 dedupeKey 还没开始执行的任务。给了 sessionId 就随那个会话的下一次落库提交，否则单独一个事务 */
export function cancel(dedupeKey: string, sessionId?: string): void {
  if (sessionId) {
    queueJobs(sessionId, [{ op: 'cancel', dedupeKey }]);
    return;
  }
  void withJobsTx((tx) => cancelPendingJobs(tx, dedupeKey)).catch((e: unknown) => console.error(`[jobs] 取消没写进去（${errName(e)}）`));
}

const errName = (e: unknown): string => {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code;
  return e instanceof Error ? e.name : 'unknown';
};

const handlers: Record<JobKind, JobHandler> = {
  followup: (job, now, ctx) => followupJobs.run(job, now, ctx),
  handoff_notify: (job) => runHandoffNotifyJob(job),
  retention_purge: (job, now) => runRetentionPurgeJob(job, now),
};

// ---------------- 认领与执行 ----------------

/** 本进程认领了、还没写下结果的任务：claimed（排着没开始）、started（执行中）、sending（跟进已进 sending）、settling（结果在写） */
type Phase = 'claimed' | 'started' | 'sending' | 'settling';
const mine = new Map<string, { job: JobRow; phase: Phase }>();

let started = false;
let stopping = false;
let recovered = false;
let timer: NodeJS.Timeout | null = null;
let tickTask: Promise<number> | null = null;
let lastPurgeEnsure = 0;
let lastClaimLog = 0;

/** 执行体出错：attempts + 1，到 max_attempts 记 failed，否则按退避改回 pending */
function retryOutcome(job: JobRow, now: number, e: unknown): JobOutcome & { attemptsDelta: number } {
  const attempts = job.attempts + 1;
  const lastError = errName(e);
  if (attempts >= job.maxAttempts) return { status: 'failed', lastError, attemptsDelta: 1 };
  return { status: 'pending', runAt: now + RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)]!, lastError, attemptsDelta: 1 };
}

/** 把执行体的结果写进库：只改仍是 running 的；done 之后要接着排的（retention_purge 的下一天）在同一个事务里排 */
async function settle(job: JobRow, out: JobOutcome & { attemptsDelta?: number }): Promise<void> {
  if (out.status === 'handled' || out.status === 'stopped') return;
  await withJobsTx(async (tx) => {
    if (out.status === 'pending') {
      await setJobStatus(tx, job.id, 'pending', {
        from: ['running'],
        runAt: new Date(out.runAt),
        lastError: out.lastError,
        attemptsDelta: out.attemptsDelta,
      });
      return;
    }
    await setJobStatus(tx, job.id, out.status, { from: ['running'], lastError: out.lastError, attemptsDelta: out.attemptsDelta });
    for (const spec of out.enqueueNext ?? []) {
      await enqueueJob(tx, {
        kind: spec.kind,
        dedupeKey: spec.dedupeKey,
        runAt: new Date(spec.runAt),
        payload: spec.payload,
        maxAttempts: spec.maxAttempts,
      });
    }
  });
}

async function runClaimed(job: JobRow, now: number): Promise<void> {
  const slot = mine.get(job.id)!;
  slot.phase = 'started';
  let out: JobOutcome & { attemptsDelta?: number };
  try {
    out = await handlers[job.kind](job, now, {
      markSending: () => {
        slot.phase = 'sending';
      },
    });
  } catch (e) {
    console.error(`[jobs] ${job.kind} 执行出错（${errName(e)}），按 max_attempts 重试`);
    // 已进 sending 的不能重来（最多发一次）：状态由执行体经会话写队列改，这里不动
    out = (slot.phase as Phase) === 'sending' ? { status: 'handled' } : retryOutcome(job, now, e);
  }
  if (out.status === 'stopped') return; // 留在 mine 里：停机钩子按它改回 pending
  slot.phase = 'settling';
  try {
    await settle(job, out);
  } catch (e) {
    // 结果没写进去：任务留在 running，本进程不会再认领它；下次启动按「启动时的去向」归位
    console.error(`[jobs] ${job.kind} 的结果没写进库（${errName(e)}），留到下次启动归位`);
  } finally {
    mine.delete(job.id);
  }
  if (job.kind === 'followup') followupJobs.afterSettle(job, out);
}

/** 启动时归位上一个进程留下的 running 与 sending。没做成之前不认领：本进程认领的 running 会被当成上一个进程的 */
async function recover(): Promise<boolean> {
  try {
    const r = await withJobsTx(recoverJobsAtStartup);
    recovered = true;
    const n = r.followupRequeued + r.followupAbandoned + r.otherRequeued + r.otherFailed;
    if (n) {
      console.log(
        `[jobs] 启动归位：跟进 ${r.followupRequeued} 个改回 pending、${r.followupAbandoned} 个 sending 记 abandoned（不重发）；` +
          `其余 ${r.otherRequeued} 个改回 pending、${r.otherFailed} 个用完重试记 failed`,
      );
    }
    return true;
  } catch (e) {
    if (Date.now() - lastClaimLog >= CLAIM_LOG_MS) {
      lastClaimLog = Date.now();
      console.error(`[jobs] 启动归位没做成（${errName(e)}），下一拍再试，之前不认领`);
    }
    return false;
  }
}

async function ensurePurge(now: number): Promise<void> {
  if (now - lastPurgeEnsure < PURGE_ENSURE_MS) return;
  const spec = retentionPurgeSpec(now);
  try {
    await withJobsTx((tx) =>
      enqueueJob(tx, {
        kind: spec.kind,
        dedupeKey: spec.dedupeKey,
        runAt: new Date(spec.runAt),
        payload: spec.payload,
        maxAttempts: spec.maxAttempts,
      }),
    );
    lastPurgeEnsure = now;
  } catch (e) {
    console.error(`[jobs] retention_purge 没排上（${errName(e)}），下一拍再试`);
  }
}

async function tickOnce(now: number): Promise<number> {
  if (!recovered && !(await recover())) return 0;
  await ensurePurge(now);
  let claimed: JobRow[];
  try {
    claimed = await withJobsTx((tx) => claimDueJobs(tx, new Date(now), BATCH));
  } catch (e) {
    if (Date.now() - lastClaimLog >= CLAIM_LOG_MS) {
      lastClaimLog = Date.now();
      console.error(`[jobs] 认领失败（${errName(e)}），5 秒后再试`);
    }
    return 0;
  }
  for (const job of claimed) mine.set(job.id, { job, phase: 'claimed' });
  const t0 = Date.now();
  for (const job of claimed) {
    if (stopping) break; // 没开始的留在 running：跟进由停机钩子改回 pending，其余由下次启动归位
    await runClaimed(job, now + (Date.now() - t0));
  }
  return claimed.length;
}

/** 认领并执行一批（定时器每 5 秒调一次；自测直接调，now 可以给一个将来的时刻）。上一批没跑完就不叠一批 */
export function runJobsOnce(now = Date.now()): Promise<number> {
  if (stopping || tickTask || sessionStoreMode() !== 'db') return Promise.resolve(0);
  const task = tickOnce(now).finally(() => {
    if (tickTask === task) tickTask = null;
  });
  tickTask = task;
  return task;
}

/**
 * 停机 normal 段：不再认领；叫醒正在生成话术的跟进（放弃这次）；把本进程认领了、还没进 sending 的跟进改回 pending（下次启动再追）；
 * 再等手上那条推送回来（好把结果记进会话与任务），等不到也不影响会不会重发
 */
async function stopJobs(): Promise<void> {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  followupJobs.stop();
  const back = [...mine.values()]
    .filter((m) => m.job.kind === 'followup' && (m.phase === 'claimed' || m.phase === 'started'))
    .map((m) => m.job.id);
  if (back.length) {
    try {
      await withJobsTx(async (tx) => {
        for (const id of back) await setJobStatus(tx, id, 'pending', { from: ['running'] });
      });
      for (const id of back) mine.delete(id);
      console.log(`[jobs] 停机：${back.length} 个还没发出的跟进改回 pending，下次启动再追`);
    } catch (e) {
      console.error(`[jobs] 停机时跟进没能改回 pending（${errName(e)}），下次启动归位`);
    }
  }
  await tickTask?.catch(() => undefined);
}

/**
 * db 存储下代替 startFollowUpScheduler（boot 的启动顺序）：装上跟进的落库钩子（排程、客户回话即取消），每 5 秒认领一批；
 * 第一批之前先做启动归位。push 是推给客户的那一下（server 传 adapterFor 的 push），跟进到点时用。文件存储下什么都不做
 */
export function startJobs(push: PushFn): void {
  if (sessionStoreMode() !== 'db') {
    console.log('[jobs] 文件存储没有任务表：跟进由扫描器驱动');
    return;
  }
  if (started) return;
  started = true;
  followupJobs.install(push);
  onShutdown(stopJobs);
  console.log(`[jobs] 任务表已启动：每 ${TICK_MS / 1000} 秒认领一批（跟进${process.env.FOLLOWUP_ENABLED === '1' ? '已启用' : '未启用'}）`);
  void runJobsOnce();
  timer = setInterval(() => void runJobsOnce(), TICK_MS);
  timer.unref();
}

/** 仅供自测 */
export const __jobsTest = {
  /** 装上跟进钩子与停机钩子、不起定时器（自测自己调 runJobsOnce） */
  start(push: PushFn): void {
    if (started) return;
    started = true;
    followupJobs.install(push);
    onShutdown(stopJobs);
  },
  stop: stopJobs,
  /** 清回刚启动的样子（不卸钩子）：之后第一批之前照样先做启动归位 */
  reset(): void {
    stopping = false;
    recovered = false;
    tickTask = null;
    lastPurgeEnsure = 0;
    mine.clear();
    followupJobs.reset();
  },
  mine: () => [...mine.values()].map((m) => ({ id: m.job.id, kind: m.job.kind, phase: m.phase })),
};
