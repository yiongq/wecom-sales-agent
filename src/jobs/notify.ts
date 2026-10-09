// handoff_notify 任务的排程（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」「通知」）：转人工提交后立即排一个，
// 10 分钟后若仍没人接手再排一个（这一个在转人工时就排好，到点时由执行体判断还有没有人接手）；企微窗口剩不到 4 小时、仍在转人工中时
// 排一个（同样在转人工时排好，到点重判）；advisor 模式下建单后排一个「待确认的订单」（第 15 步接上排程）。至多重试 3 次。
// 执行体在 src/notify/handoff.ts（第 14 步：发到企微群机器人）。不 import handoff/record.ts（它调这里排程）。
import type { HandoffKind } from '../shared/conversation-types.js';
import type { JobOp } from '../store.js';

/** 首次加至多重试 3 次 */
export const HANDOFF_NOTIFY_MAX_ATTEMPTS = 4;
/** 转人工之后多久仍没人接手就再通知一次 */
export const HANDOFF_UNCLAIMED_MS = 10 * 60_000;
/** 企微 48 小时窗口剩不到这么久、仍在转人工中且没人回时提醒一次 */
export const WINDOW_NOTICE_MS = 4 * 3_600_000;

/** started 立即、unclaimed 10 分钟仍没人接手、window 企微窗口剩不到 4 小时、order_unconfirmed 待确认的订单 */
export type HandoffNotifyReason = 'started' | 'unclaimed' | 'window' | 'order_unconfirmed';

/**
 * 任务的 payload。sessionId 必带（清除与行权删除据它一并删掉，验收 27）；handoffAt 是这次转人工（或升级）的时刻，键里也有它：
 * 交还之后再转人工是另一组键。kind、handoffCount 第 14 步起带：kind 是转人工的类型（提醒的正文），handoffCount 是会话进入
 * 转人工的次数（只在进入时加 1，升级不加），执行体据它认出「还是不是同一次转人工」（升级会改写转人工记录里的时刻）。
 * unsavedSent：库写不进去时 unsaved 通知已经发过，立即的那个不再补发（src/notify/handoff.ts 在落库之前改它）
 */
export interface HandoffNotifyPayload {
  sessionId: string;
  reason: HandoffNotifyReason;
  handoffAt?: number;
  escalated?: boolean;
  kind?: HandoffKind;
  handoffCount?: number;
  orderId?: string;
  unsavedSent?: boolean;
}

/** 立即的那个通知的键（unsaved 通知发出之后据它给 payload 标 unsavedSent） */
export const startedNotifyKey = (sessionId: string, at: number): string => `handoff_notify:${sessionId}:${at}:started`;

/**
 * 进入（或升级）转人工时排的通知任务，随这个会话的下一次落库提交（enterHandoff 与转人工的改动在同一段同步代码里）。
 * 升级（emergency）只排立即的那一个，10 分钟与窗口的那两个首次进入时已排。windowClosesAt 给了（企微会话的发送窗口）就再排
 * 窗口那一个，runAt 是窗口关闭前 4 小时（已经不到 4 小时就是现在）；到点时重判（窗口随客户说话后移）
 */
export function handoffNotifyOps(
  sessionId: string,
  at: number,
  opts: { escalated: boolean; kind?: HandoffKind; handoffCount?: number; windowClosesAt?: number | null },
): JobOp[] {
  const op = (reason: HandoffNotifyReason, runAt: number): JobOp => {
    const payload: HandoffNotifyPayload = { sessionId, reason, handoffAt: at, escalated: opts.escalated };
    if (opts.kind !== undefined) payload.kind = opts.kind;
    if (opts.handoffCount !== undefined) payload.handoffCount = opts.handoffCount;
    return {
      op: 'enqueue',
      kind: 'handoff_notify',
      dedupeKey: reason === 'started' ? startedNotifyKey(sessionId, at) : `handoff_notify:${sessionId}:${at}:${reason}`,
      runAt,
      payload,
      maxAttempts: HANDOFF_NOTIFY_MAX_ATTEMPTS,
    };
  };
  if (opts.escalated) return [op('started', at)];
  const ops = [op('started', at), op('unclaimed', at + HANDOFF_UNCLAIMED_MS)];
  if (typeof opts.windowClosesAt === 'number' && opts.windowClosesAt > at) {
    ops.push(op('window', Math.max(at, opts.windowClosesAt - WINDOW_NOTICE_MS)));
  }
  return ops;
}

/**
 * advisor 模式下建单之后排的「待确认的订单」提醒（spec「收款流程」：建单后排一次 handoff_notify），随这个会话的下一次落库提交。
 * 第 15 步在 create_order 的 advisor 分支里调（queueJobs(sessionId, orderUnconfirmedNotifyOps(…))）；执行体到点时看订单还在不在
 * 待付款、确认过没有
 */
export function orderUnconfirmedNotifyOps(sessionId: string, orderId: string, at: number): JobOp[] {
  const payload: HandoffNotifyPayload = { sessionId, reason: 'order_unconfirmed', orderId };
  return [
    {
      op: 'enqueue',
      kind: 'handoff_notify',
      dedupeKey: `handoff_notify:${sessionId}:order:${orderId}`,
      runAt: at,
      payload,
      maxAttempts: HANDOFF_NOTIFY_MAX_ATTEMPTS,
    },
  ];
}

/**
 * 重置时取消这个会话所有待执行的转人工通知（02 spec「消息只追加」重置那一行），随重置那次落库提交。按 payload 的 sessionId 取消，
 * 不按转人工记录拼键：升级会覆盖记录里的时刻。已在执行的（running）不动，与 cancel 的口径相同；执行体到点照样看会话的现状
 */
export function cancelHandoffNotifyOps(sessionId: string): JobOp[] {
  return [{ op: 'cancelSession', kind: 'handoff_notify', sessionId }];
}
