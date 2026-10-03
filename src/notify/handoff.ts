// handoff_notify 任务的执行体，与库写不进去时的 unsaved 通知（docs/architecture/02-conversations-workbench/spec.md「通知」
// 「任务表与跟进」、R13、不变量 10 的例外、32；plan 第 14 步）。提醒经 Notifier 发到转人工通知群（企微群机器人，src/notify/notifier.ts），
// 内容只有类型、短码、时间与工作台链接。
//
// 执行体（db 存储，任务表的认领者调；发送失败抛出，认领者按 max_attempts 4 重试，用完记 failed）：
//   started            立即：还是这一次转人工、没人接手（升级的紧急情况有人接手也发）就发；unsaved 通知已经发过的不补发
//   unclaimed          10 分钟后：还是这一次转人工、仍没人接手才发，否则 done
//   window             企微 48 小时窗口剩不到 4 小时、还是这一次转人工、客户最后一句之后没有顾问回复、还能发（剩余条数 > 0）才发；
//                      窗口随客户说话后移了就改回 pending 顺延到新的「关闭前 4 小时」，有人回了或条数用完就顺延到窗口关闭的时刻再看
//   order_unconfirmed  待确认的订单（第 15 步接上排程）：订单仍是待付款、没确认过才发
// 「还是这一次转人工」按 payload 的 handoffCount（进入转人工的次数，升级不加）认，旧任务没有它就按 handoffAt 认：交还之后再转人工的
// 那一次有自己的一组任务，旧的到点不串。
//
// unsaved 通知（不变量 10 唯一的例外）：带 handoff.started 的那次落库失败时（PG 后端经 onHandoffUnsaved 报来），emergency 立即发一条
// unsaved: true 的提醒，其余在失败持续 30 秒之后（30 秒内提交了就不发，照常由任务提醒）；同一次转人工（会话 id 与时刻）只发一次。
// 发出之后：给还没提交的那个立即的 handoff_notify 标上 unsavedSent（停机写进 spill、重启回放之后也认得），并在内存里记下，
// 之后提交成功、任务执行到它时不补发。发送失败在内存里退避重试，最后也没发出去就忘掉它，提交之后由任务照常提醒。
import type { JobOutcome, JobRow } from '../jobs/runner.js';
import { activePack, isTerminalStage } from '../handoff/record.js';
import { startedNotifyKey, WINDOW_NOTICE_MS, type HandoffNotifyPayload, type HandoffNotifyReason } from '../jobs/notify.js';
import { sendWindow } from '../quota/ledger.js';
import { channelCustomerLabel, shortIdOf, type HandoffNoticeKind } from '../shared/conversation.js';
import { getOrder, getSession, onCommitted, onHandoffUnsaved, patchQueuedJob, type HandoffStartedEvent } from '../store.js';
import type { Session } from '../types.js';
import { NotifySendError, notifier, workbenchLink, type HandoffNotice } from './notifier.js';

const REASONS: ReadonlySet<HandoffNotifyReason> = new Set(['started', 'unclaimed', 'window', 'order_unconfirmed']);

function payloadOf(raw: unknown): HandoffNotifyPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<HandoffNotifyPayload>;
  if (typeof p.sessionId !== 'string' || !p.sessionId || !REASONS.has(p.reason as HandoffNotifyReason)) return null;
  return p as HandoffNotifyPayload;
}

/** 还是 payload 说的那一次转人工：仍在转人工中，进入次数相同（旧任务没有次数时比转人工的时刻） */
function inSameHandoff(s: Session, p: HandoffNotifyPayload): boolean {
  if (!s.handedOver) return false;
  if (typeof p.handoffCount === 'number') return s.handoffCount === p.handoffCount;
  return typeof p.handoffAt === 'number' && s.handoff?.at === p.handoffAt;
}

/** 客户最后一句之后有顾问的人工回复 */
function advisorRepliedSinceCustomer(s: Session): boolean {
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === 'customer') return false;
    if (m.role === 'agent' && m.author === 'human') return true;
  }
  return false;
}

const labelOf = (channel: string): string => channelCustomerLabel(channel, activePack().vocabulary.customer);

function noticeFor(
  sessionId: string,
  channel: string,
  kind: HandoffNoticeKind,
  at: number,
  paidCustomer: boolean,
  unsaved = false,
): HandoffNotice {
  return { shortId: shortIdOf(sessionId), kind, paidCustomer, at, link: workbenchLink(), unsaved, label: labelOf(channel) };
}

const done = (lastError: string | null = null): JobOutcome => ({ status: 'done', lastError });

/** 发出去；失败抛 NotifySendError（认领者按 max_attempts 重试，last_error 是错误码，不含地址） */
async function deliver(n: HandoffNotice): Promise<JobOutcome> {
  await notifier().send(n);
  return done();
}

/** handoff_notify 的执行体（runner 的 handlers 调）。没什么可发的记 done，last_error 写为什么没发 */
export async function runHandoffNotifyJob(job: JobRow, now: number): Promise<JobOutcome> {
  const p = payloadOf(job.payload);
  if (!p) return done('bad_payload');
  if (p.reason === 'order_unconfirmed') {
    const o = p.orderId ? getOrder(p.orderId) : undefined;
    const s = getSession(p.sessionId);
    if (!o || o.sessionId !== p.sessionId || o.status !== 'pending_payment' || o.confirmedAt != null) return done('order_settled');
    if (!s) return done('no_session');
    return deliver(noticeFor(s.id, s.channel, 'order_unconfirmed', o.createdAt, isTerminalStage(s.stage)));
  }
  if (p.reason === 'started') {
    // 库写不进去时 unsaved 通知已经发过（或正在发）：提交之后不再补发
    const key = unsavedKey(p.sessionId, p.handoffAt);
    const st = unsaved.get(key);
    if (p.unsavedSent || st?.state === 'sent') {
      unsaved.delete(key);
      return done('unsaved_sent');
    }
    if (st?.state === 'sending') return { status: 'pending', runAt: now + unsavedTiming.recheckMs, lastError: 'unsaved_sending' };
  }
  const s = getSession(p.sessionId);
  if (!s) return done('no_session');
  if (!inSameHandoff(s, p)) return done('not_in_handoff');
  const paid = isTerminalStage(s.stage);
  const at = typeof p.handoffAt === 'number' ? p.handoffAt : (s.handoff?.at ?? now);
  if (p.reason === 'started') {
    // 有人接手了（后台接手本身就是 agent 类的转人工）就不发「等人接手」；升级的紧急情况照发
    if (s.assignee && !p.escalated) return done('assigned');
    return deliver(noticeFor(s.id, s.channel, p.kind ?? s.handoff?.kind ?? 'request', at, paid));
  }
  if (p.reason === 'unclaimed') {
    if (s.assignee) return done('assigned');
    return deliver(noticeFor(s.id, s.channel, 'still_waiting', at, paid));
  }
  // window：到点重判（窗口随客户每句话后移）
  const w = sendWindow(s.id, now);
  if (w.closesAt === null || now >= w.closesAt) return done('window_closed');
  if (w.closesAt - now > WINDOW_NOTICE_MS) return { status: 'pending', runAt: w.closesAt - WINDOW_NOTICE_MS, lastError: 'window_moved' };
  if (w.remaining <= 0 || advisorRepliedSinceCustomer(s)) {
    // 顾问已经回了、或这一轮条数用完了：先不提醒，到窗口关闭的时刻再看（客户再说话窗口就后移，那时重判）
    return { status: 'pending', runAt: w.closesAt, lastError: w.remaining <= 0 ? 'quota_exhausted' : 'advisor_replied' };
  }
  return deliver(noticeFor(s.id, s.channel, 'window_closing', w.closesAt, paid));
}

// ---------------- 库写不进去时的 unsaved 通知 ----------------

/** 同一次转人工：会话 id 与转人工（或升级）的时刻 */
const unsavedKey = (sessionId: string, at: number | undefined): string => `${sessionId}:${at ?? ''}`;

/** 发过（sent）与正在发（sending）的；sent 的留 7 天（这一次转人工的任务到点时取走） */
const unsaved = new Map<string, { state: 'sending' | 'sent'; at: number }>();
/** 非紧急的：等失败持续 30 秒（提交了就取消） */
const waiting = new Map<string, NodeJS.Timeout>();
const unsavedTiming = {
  /** 非紧急的转人工落库失败持续多久才发 */
  delayMs: 30_000,
  /** 发送失败的退避（之后不再试，提交之后由任务照常提醒） */
  retryMs: [5_000, 30_000, 120_000] as readonly number[],
  /** 立即的那个任务赶上 unsaved 通知还在发：过多久再看 */
  recheckMs: 30_000,
};
const KEEP_MS = 7 * 86_400_000;
let installed = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const codeOf = (e: unknown): string => (e instanceof NotifySendError ? e.code : e instanceof Error ? e.name : 'unknown');

function noteUnsaved(ev: HandoffStartedEvent): void {
  const key = unsavedKey(ev.id, ev.at);
  if (unsaved.has(key) || waiting.has(key)) return;
  if (ev.kind === 'emergency') {
    void fireUnsaved(ev, key);
    return;
  }
  const t = setTimeout(() => {
    waiting.delete(key);
    void fireUnsaved(ev, key);
  }, unsavedTiming.delayMs);
  t.unref();
  waiting.set(key, t);
}

/** 提交成功：还在等 30 秒的那条不发了（照常由任务提醒） */
function noteCommitted(ev: HandoffStartedEvent): void {
  const key = unsavedKey(ev.id, ev.at);
  const t = waiting.get(key);
  if (!t) return;
  clearTimeout(t);
  waiting.delete(key);
}

async function fireUnsaved(ev: HandoffStartedEvent, key: string): Promise<void> {
  const now = Date.now();
  for (const [k, v] of unsaved) if (v.state === 'sent' && now - v.at > KEEP_MS) unsaved.delete(k);
  unsaved.set(key, { state: 'sending', at: now });
  let n: HandoffNotice;
  try {
    n = noticeFor(ev.id, getSession(ev.id)?.channel ?? 'wecom', ev.kind, ev.at, ev.paidCustomer, true);
  } catch (e) {
    unsaved.delete(key);
    console.error(`[notify] 记录暂未保存的转人工提醒没能生成（${codeOf(e)}），会话 ${shortIdOf(ev.id)}`);
    return;
  }
  for (let i = 0; ; i++) {
    try {
      await notifier().send(n);
      break;
    } catch (e) {
      const delay = unsavedTiming.retryMs[i];
      if (delay === undefined) {
        unsaved.delete(key);
        console.error(
          `[notify] 记录暂未保存的转人工提醒没发出去（${codeOf(e)}，试了 ${i + 1} 次），会话 ${n.shortId}；提交之后由任务照常提醒`,
        );
        return;
      }
      console.warn(`[notify] 记录暂未保存的转人工提醒没发出去（${codeOf(e)}），${delay / 1000} 秒后再试，会话 ${n.shortId}`);
      await sleep(delay);
    }
  }
  unsaved.set(key, { state: 'sent', at: Date.now() });
  // 还没提交的那次落库里立即的那个通知标上 unsavedSent：之后提交、或停机写进 spill 重启回放，执行到它时都不补发
  patchQueuedJob(ev.id, startedNotifyKey(ev.id, ev.at), { unsavedSent: true });
  console.warn(`[notify] 会话 ${n.shortId} 的转人工还没写进库，已先发一条「记录暂未保存」的提醒`);
}

/** db 存储下由 startJobs 装上（文件存储没有库写不进去这回事）：订阅 PG 后端报来的没落库的转人工与提交成功的事件 */
export function installUnsavedNotices(): void {
  if (installed) return;
  installed = true;
  onHandoffUnsaved(noteUnsaved);
  onCommitted((ev) => {
    if (ev.type === 'handoff.started') noteCommitted(ev);
  });
}

/** 仅供自测 */
export const __handoffNotifyTest = {
  setTiming(t: Partial<typeof unsavedTiming>): void {
    Object.assign(unsavedTiming, t);
  },
  unsavedState: (sessionId: string, at: number): 'sending' | 'sent' | 'waiting' | null =>
    unsaved.get(unsavedKey(sessionId, at))?.state ?? (waiting.has(unsavedKey(sessionId, at)) ? 'waiting' : null),
  reset(): void {
    for (const t of waiting.values()) clearTimeout(t);
    waiting.clear();
    unsaved.clear();
  },
};
