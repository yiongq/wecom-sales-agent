// db 存储下的跟进（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」，R17、不变量 38）：
// 排程——会话落库时（saveSession 的订阅者，与这次 saveSession 同一段同步代码，排出的任务随同一次落库提交）：
//   满足 shouldFollowUp 的静态条件就排 followup:<会话>:<阶段>，runAt = 最后动静 + 该阶段阈值，落在夜间顺延；客户回话即取消。
// 执行——到点：查发送账本（不看话术，在生成之前）→ 生成话术并过出口护栏 → 在活对象上重判 shouldFollowUp 与额度 → 记账（count、
//   stages、pendingAt）并把任务改成 sending（带认领令牌），随同一次会话落库提交 → 确认 sending 改中了 → 推送 → 成功 done；明确失败
//   退账、failed、失败计数加 1（之后按扫描器的节奏再排一次）；推送结果不明（抛异常，或返回 false 而发送账本里这条有 unknown /
//   accepted 的分段：企微超时、网络异常，第 12 步）按已发处理：账不退、记 abandoned。
//   记账与 sending 提交之后才推送，推送不在落库事务里。
// 资格判断、话术、护栏、夜间时段与文件存储下的扫描器共用 src/followup.ts。
import type { JobRow } from '../db/repo/jobs.js';
import {
  deferQuiet,
  FOLLOWUP_RETRY_MS,
  FOLLOWUP_STAGES,
  followUpText,
  followupEnabled,
  followupStage,
  shouldFollowUp,
  type SessionWithFollowup,
} from '../followup.js';
import { followupWindowAllows, holdSend, mayHaveDelivered } from '../quota/ledger.js';
import { shortIdOf } from '../shared/conversation.js';
import { flushSession, getSession, jobOpApplied, onSessionSaved, queueJobs, saveSession, type JobOp } from '../store.js';
import type { ChatMessage, PushOpts, Session } from '../types.js';
import type { JobCtx, JobOutcome } from './runner.js';

export type PushFn = (sessionId: string, text: string, opts?: PushOpts) => Promise<boolean>;

/** 跟进任务的重试上限：只管推送之前的执行体出错（推送失败另有 MAX_PUSH_FAILURES） */
const FOLLOWUP_MAX_ATTEMPTS = 3;
/** 记账与 sending 提交的等待上限：等不到就不推送（宁可漏一条，不重发） */
const LEDGER_TIMEOUT_MS = 5_000;

export const followupKey = (sessionId: string, stage: string): string => `followup:${sessionId}:${stage}`;
const short = (id: string): string => shortIdOf(id) || '?';

const enqueueOp = (sessionId: string, stage: string, runAt: number): JobOp => ({
  op: 'enqueue',
  kind: 'followup',
  dedupeKey: followupKey(sessionId, stage),
  runAt,
  // 与会话有关的任务 payload 必带 sessionId：清除与行权删除据它把任务一并删掉（验收 27）
  payload: { sessionId, stage },
  maxAttempts: FOLLOWUP_MAX_ATTEMPTS,
});
const cancelOp = (dedupeKey: string): JobOp => ({ op: 'cancel', dedupeKey });
/**
 * 执行体改这个任务的状态：只改仍是本次认领的那一行（claimed_at 等于认领时写下的，认领令牌）。report：提交之后经 jobOpApplied
 * 报回改中了没有（running → sending 用它：锁丢失期间另一个进程归位、重新认领过这一行，就改不中，这次不推送）
 */
const statusOp = (
  job: JobRow,
  status: 'sending' | 'done' | 'failed' | 'abandoned',
  from: 'running' | 'sending',
  opts: { lastError?: string; report?: boolean } = {},
): JobOp => ({
  op: 'status',
  id: job.id,
  status,
  from: [from],
  ...(job.claimedAt ? { claimedAt: job.claimedAt.getTime() } : {}),
  ...(opts.lastError ? { lastError: opts.lastError } : {}),
  ...(opts.report ? { report: true } : {}),
});

/**
 * 本进程知道的、这个会话没结束的那个跟进任务（键与 runAt）。值为 null：确知没有；Map 里没有：不知道（重启之后还没落过库），
 * 这时客户回话按全部阶段的键取消，排程不先取消（库里已有的留着，到点时按活对象重判、早了就顺延）
 */
const known = new Map<string, { key: string; runAt: number } | null>();
/** 执行体自己的 saveSession：账与任务状态由执行体一并排，落库钩子跳过这一次 */
let selfSaving: string | null = null;

/** 跟进的排程时刻：最后动静 + 这个阶段的阈值，落在夜间顺延到 9:00 */
export function followupRunAt(s: Session, idleMs: number, notBefore = 0): number {
  return deferQuiet(Math.max(s.updatedAt + idleMs, notBefore));
}

/** 会话落库时排、取消跟进（db 存储的真实会话，store 只为它们调）。FOLLOWUP_ENABLED 不是 1 时什么都不排 */
function onSaved(s: Session): void {
  if (!followupEnabled() || selfSaving === s.id) return;
  const ops = planOps(s);
  if (ops.length) queueJobs(s.id, ops);
}

function planOps(s: SessionWithFollowup): JobOp[] {
  const k = known.get(s.id);
  const last = (s.messages ?? []).filter((m) => m.role !== 'system').at(-1);
  const due = last?.role === 'customer' ? null : followupStage(s);
  if (!due) {
    // 客户回话（或会话不再满足资格：转了人工、成交了、说了「别发了」……）：取消排着的
    if (k === null) return [];
    known.set(s.id, null);
    if (k) return [cancelOp(k.key)];
    return FOLLOWUP_STAGES.map((st) => cancelOp(followupKey(s.id, st)));
  }
  const key = followupKey(s.id, due.stage);
  const runAt = followupRunAt(s, due.idleMs);
  // 同一个任务、排的时刻不早于该排的：不动（推送失败之后排的重试比「最后动静 + 阈值」晚，不能被拉回来）
  if (k && k.key === key && runAt <= k.runAt) return [];
  known.set(s.id, { key, runAt });
  // 换了阶段，或最后动静往后挪了：先取消旧的再排（只取消 pending 的；唯一索引只拦没结束的）
  return [...(k ? [cancelOp(k.key)] : []), enqueueOp(s.id, due.stage, runAt)];
}

/** 执行体的 saveSession：账与任务状态在同一段同步代码里排进这个会话的下一次落库 */
function saveWith(s: Session, ops: JobOp[]): void {
  selfSaving = s.id;
  try {
    saveSession(s, false); // touch=false：跟进不刷新最后动静（与扫描器相同）
  } finally {
    selfSaving = null;
  }
  queueJobs(s.id, ops);
}

// ---------------- 执行 ----------------

let push: PushFn | null = null;
let installed = false;
let stopping = false;
/** 正在等话术生成的执行体：停机时叫醒，让它放弃这次（还没记账、什么都没发，停机钩子把任务改回 pending） */
const composeWaiters = new Set<() => void>();

async function composeUnlessStopping(s: Session): Promise<string | null> {
  const composing = followUpText(s);
  composing.catch(() => undefined);
  let wake!: () => void;
  const stopped = new Promise<null>((r) => {
    wake = () => r(null);
  });
  composeWaiters.add(wake);
  try {
    return await Promise.race([composing, stopped]);
  } finally {
    composeWaiters.delete(wake);
  }
}

/**
 * 发送账本的额度判断（R18、不变量 34：跟进要求窗口剩余 ≥2 条且 ≥2 小时，src/quota/ledger.ts，只读内存）。额度不够不算失败
 * （任务记 cancelled、不退账也不计失败次数），也不再排：窗口只在客户再开口时重开，那时客户回话取消、AI 回复落库重排。
 * 不看话术，所以在生成之前判（不够就不调模型）；记账之前在活对象上再判一次
 */
const ledgerAllows = (s: Session, now: number): boolean => followupWindowAllows(s.id, now);
let quotaAllows: (s: Session, now: number) => boolean = ledgerAllows;
export function followupQuotaAllows(s: Session, now: number): boolean {
  return quotaAllows(s, now);
}

async function run(job: JobRow, now: number, ctx: JobCtx): Promise<JobOutcome> {
  const p = (job.payload ?? {}) as { sessionId?: unknown; stage?: unknown };
  const sid = typeof p.sessionId === 'string' ? p.sessionId : '';
  const s = sid ? (getSession(sid) as SessionWithFollowup | undefined) : undefined;
  if (!s) return { status: 'cancelled', lastError: 'no_session' };
  const due = followupStage(s);
  if (!due || due.stage !== p.stage) return { status: 'cancelled', lastError: 'not_eligible' };
  // 还没沉默够（排程之后又有了动静）或正赶上夜里（停机期间错过、启动时是夜里）：改回 pending、顺延，不算一次尝试
  const at = followupRunAt(s, due.idleMs, now);
  if (at > now) return { status: 'pending', runAt: at };
  if (!push) return { status: 'pending', runAt: now + FOLLOWUP_RETRY_MS, lastError: 'no_push' };
  // 排程按认领时给的「现在」往后走（自测拨钟时也一致）；账上记的时刻用真钟
  const t0 = Date.now();
  const clock = (): number => now + (Date.now() - t0);
  // 额度不够：不生成话术（不调模型），记 cancelled、之后不再排（见 afterSettle）
  if (!followupQuotaAllows(s, clock())) return { status: 'cancelled', lastError: 'quota' };
  const text = await composeUnlessStopping(s);
  if (text === null || stopping) return { status: 'stopped' };
  // 生成话术要几秒到几十秒，这期间客户可能回了消息：在活对象上重判（spec：到点后在活对象上重判 shouldFollowUp）
  const fresh = getSession(sid) as SessionWithFollowup | undefined;
  if (!fresh || !shouldFollowUp(fresh, clock()) || fresh.stage !== p.stage) {
    return { status: 'cancelled', lastError: 'changed' };
  }
  // 生成期间额度可能被别的发送用掉（顾问在后台发了消息）：记账之前在活对象上再判一次
  if (!followupQuotaAllows(fresh, clock())) return { status: 'cancelled', lastError: 'quota' };
  // 消息对象先建好交给发送账本（送达才写进会话，写进去的是同一个对象，账本行据它取 seq）。判过额度就在同一段同步代码里占一个名额：
  // 下面要等记账落库才推送，这段时间里顾问的人工回复看得到它（不变量 34）；推送的第一个分段接过这一行，推送结束后没用上的撤掉
  const message: ChatMessage = { role: 'agent', content: text, at: Date.now(), author: 'followup' };
  const release = holdSend(sid, 'followup', message);
  try {
    return await sendAfterLedger({ job, ctx, fresh, sid, text, message, release, clock, push });
  } finally {
    release();
  }
}

/** 记账、改成 sending 并提交之后推送（run 的后半段；release 在推送一返回就调，结果不明的判断不算预占的那一行） */
async function sendAfterLedger(a: {
  job: JobRow;
  ctx: JobCtx;
  fresh: SessionWithFollowup;
  sid: string;
  text: string;
  message: ChatMessage;
  release: () => void;
  clock: () => number;
  push: PushFn;
}): Promise<JobOutcome> {
  const { job, ctx, fresh, sid, text, message, release, clock } = a;
  // 记账并把任务改成 sending，同一段同步代码里排进同一次落库；提交之后才推送（最多发一次）
  const meta = (fresh.followup ??= {});
  const stage = fresh.stage;
  const before = { count: meta.count, stages: meta.stages, lastAt: meta.lastAt };
  meta.count = (meta.count ?? 0) + 1;
  meta.stages = [...(meta.stages ?? []), stage];
  meta.lastAt = Date.now();
  meta.pendingAt = Date.now();
  saveWith(fresh, [statusOp(job, 'sending', 'running', { report: true })]);
  ctx.markSending();
  known.set(sid, null);
  try {
    await flushSession(sid, { timeoutMs: LEDGER_TIMEOUT_MS });
  } catch {
    // 记账没提交上（库积压、会话 poisoned）：不推送。账已在内存里、随之后的落库或 spill 写下，任务记 abandoned（不再执行）
    console.error(`[followup] 跟进 ${short(sid)} 的记账没能落库，不推送`);
    queueJobs(sid, [statusOp(job, 'abandoned', 'sending', { lastError: 'ledger_not_committed' })]);
    return { status: 'handled' };
  }
  if (!jobOpApplied(sid, job.id)) {
    // running → sending 提交了却没改中：这一行已不在本次认领手里（租户锁丢失期间另一个进程启动归位、重新认领过它，由那边发）。
    // 不推送；已提交的账不退（多记一次是安全的一侧，宁可漏一条），任务状态以库里的为准
    console.error(`[followup] 跟进 ${short(sid)} 的任务已不在本次认领手里（sending 没改中），不推送`);
    return { status: 'handled' };
  }
  let ok: boolean;
  try {
    ok = await a.push(sid, text, { kind: 'followup', message });
  } catch (e) {
    // 结果不明（可能已经送达）：按已发处理——账不退、pendingAt 留着，任务记 abandoned，不重试
    console.error(`[followup] 跟进 ${short(sid)} 推送结果不明，按已发处理、不再重试（${e instanceof Error ? e.name : 'unknown'}）`);
    queueJobs(sid, [statusOp(job, 'abandoned', 'sending', { lastError: 'push_unknown' })]);
    return { status: 'handled' };
  } finally {
    release();
  }
  if (!ok && mayHaveDelivered(sid, message)) {
    // 企微超时、网络异常（发送账本里记 unknown）或只发出去一部分：同样是结果不明，按已发处理（02 第 12 步）
    console.error(`[followup] 跟进 ${short(sid)} 推送结果不明（超时或网络异常），按已发处理、不再重试`);
    queueJobs(sid, [statusOp(job, 'abandoned', 'sending', { lastError: 'push_unknown' })]);
    return { status: 'handled' };
  }
  delete meta.pendingAt;
  if (!ok) {
    // 明确没送达：退账、失败计数加 1、任务 failed。还没到 MAX_PUSH_FAILURES 就按扫描器的节奏再排一次（同一个键，旧的已结束）
    Object.assign(meta, before);
    meta.failures = (meta.failures ?? 0) + 1;
    const ops = [statusOp(job, 'failed', 'sending', { lastError: 'push_failed' })];
    const again = followupStage(fresh);
    if (again && again.stage === stage) {
      const runAt = followupRunAt(fresh, again.idleMs, clock() + FOLLOWUP_RETRY_MS);
      ops.push(enqueueOp(sid, stage, runAt));
      known.set(sid, { key: followupKey(sid, stage), runAt });
    }
    saveWith(fresh, ops);
    console.error(`[followup] 跟进消息未送达 ${short(sid)}（第 ${meta.failures} 次失败${again ? '' : '，不再重试'}）`);
    return { status: 'handled' };
  }
  // 后台按 author 标「自动跟进」（02 spec「消息只追加」）
  message.at = Date.now();
  fresh.messages.push(message);
  meta.failures = 0;
  saveWith(fresh, [statusOp(job, 'done', 'sending')]);
  console.log(`[followup] 已跟进 ${short(sid)}（阶段=${stage}）`);
  return { status: 'handled' };
}

/**
 * 认领者写下结果之后：任务没进 sending 就结束了（取消、重试用完记 failed、改回 pending），本进程对这个会话的认识要跟着改。
 * 只有「生成期间客户回了话」（cancelled、changed）要按活对象再排一次：那段时间里 AI 回复的排程撞上了还没结束的这条（同一个键），
 * 什么都没排。其余结束的（重试用完、额度不够、不再满足资格、会话不在）都不再排，记成「确知没有」，等客户下一次回话、AI 回复
 * 落库时照正常排程再来：failed 之后立刻同键重排，max_attempts 就封顶不了；额度不够时重排，每 5 秒就要调一次模型
 */
function afterSettle(job: JobRow, out: JobOutcome): void {
  const sid = (job.payload as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sid !== 'string') return;
  if (out.status === 'pending') {
    known.set(sid, { key: job.dedupeKey, runAt: out.runAt });
    return;
  }
  if (out.status === 'handled' || out.status === 'stopped') return;
  const k = known.get(sid);
  const same = k?.key === job.dedupeKey;
  if (out.status !== 'cancelled' || out.lastError !== 'changed') {
    // 不知道（重启之后）也记成没有：之后哪次与客户无关的落库都不会把它立刻再排出来
    if (k === undefined || same) known.set(sid, null);
    return;
  }
  if (same) known.delete(sid);
  const s = getSession(sid);
  if (s && followupEnabled()) {
    const ops = planOps(s);
    if (ops.length) queueJobs(sid, ops);
  }
}

/** 认领者的结果补写也没写进库（任务留在 running，等下次启动归位）：本进程不再自以为排着这个键 */
function forget(job: JobRow): void {
  const sid = (job.payload as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sid === 'string' && known.get(sid)?.key === job.dedupeKey) known.delete(sid);
}

export const followupJobs = {
  /** startJobs 调：记下推送函数，装上落库钩子（只装一次） */
  install(fn: PushFn): void {
    push = fn;
    if (installed) return;
    installed = true;
    onSessionSaved(onSaved);
  },
  run,
  afterSettle,
  forget,
  /** 停机 normal 段：叫醒正在生成话术的执行体，此后不再进 sending */
  stop(): void {
    stopping = true;
    for (const wake of composeWaiters) wake();
  },
  /** 仅供自测：清回刚启动的样子（钩子不卸） */
  reset(): void {
    stopping = false;
    known.clear();
    selfSaving = null;
  },
  /** 仅供自测：换掉额度判断（null 换回发送账本的判断） */
  setQuotaForTest(fn: ((s: Session, now: number) => boolean) | null): void {
    quotaAllows = fn ?? ledgerAllows;
  },
};
