// 后台的订单动作：确认价格、确认收款、取消订单（docs/architecture/02-conversations-workbench/spec.md「收款流程（价格确认闸）」、
// 不变量 39 的接口部分；02 第 13 步随后台接口接上，advisor 模式的对客文案、/pay 页与 SOP 在第 15 步）。
// 先查写库健康，改内存，随落库写一行审计；确认收款等提交（≤5 秒）之后才对客户发付款确认（不变量 20）。
// 操作者：owner、admin、supervisor 任何订单；agent（与共享工作台）只限订单所属会话的接手人本人，否则 NotHandlingError；
// 会话已被清除（订单不再指向内存里的会话）的订单只许 supervisor 以上
import { notifyPaid } from '../engine.js';
import {
  type Actor,
  awaitCommit,
  ForbiddenError,
  handlesConversations,
  isAssignee,
  NotHandlingError,
  pushToChannel,
  supervisesConversations,
} from '../handoff/takeover.js';
import { shortIdOf } from '../shared/conversation.js';
import { cleanText } from '../shared/text.js';
import { getOrder, getSession, markOrderPaid, queueAudit, saveOrder, saveSession, storeLagging, StoreLaggingError } from '../store.js';
import type { Order, OrderStatus } from '../types.js';
import { paymentMode } from './mode.js';

/** 订单状态不允许这个动作 → 409 order_state（unconfirmed：advisor 模式下还没确认价格就确认收款） */
export class OrderStateError extends Error {
  constructor(readonly status: OrderStatus | 'voided' | 'unconfirmed') {
    super(status === 'unconfirmed' ? '还没确认价格，不能确认收款' : `订单现在是 ${status}，不能这样改`);
  }
}
/** 内存里没有这张订单（不存在、或已作废移出内存）→ 404 */
export class OrderNotFoundError extends Error {
  constructor() {
    super('没有这张订单');
  }
}

/** 种子演示会话：对应的企微客户是编造的，付款确认必然推送失败，不记失败备注（与旧的模拟支付同一口径） */
const SEED_SESSION_RE = /^wecom:cust_/;
const PAY_NOTICE_FAILED = '⚠️ 上一条付款确认未能发送到客户（推送失败：可能是 48h 会话窗口已关闭或渠道配置问题），请另行告知客户已收到付款';

function orderFor(orderId: string, actor: Actor): Order {
  if (!handlesConversations(actor.role)) throw new ForbiddenError();
  const o = getOrder(orderId);
  if (!o) throw new OrderNotFoundError();
  if (supervisesConversations(actor.role)) return o;
  const s = o.sessionId ? getSession(o.sessionId) : undefined;
  if (!s || !isAssignee(s, actor)) throw new NotHandlingError();
  return o;
}

const who = (a: Actor) => ({ userId: a.userId, name: a.name });

/** 订单类审计（spec「后台接口」）：target 是订单号，diff 带所属会话的短码 */
function audit(o: Order, actor: Actor, entry: { action: string; diff: Record<string, unknown> }): void {
  queueAudit(
    o.sessionId,
    { kind: 'user', userId: actor.userId, name: actor.name, ip: actor.ip ?? null },
    { action: entry.action, targetType: 'order', targetId: o.id, diff: { shortId: shortIdOf(o.sessionId), ...entry.diff } },
  );
}

/** 确认价格：只对未作废的 pending_payment；重复确认幂等（不改、不再记审计）。调用方再 await flushSession */
export function confirmOrder(orderId: string, actor: Actor): Order {
  const o = orderFor(orderId, actor);
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (o.confirmedAt != null) return o;
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  o.confirmedAt = Date.now();
  o.confirmedBy = who(actor);
  audit(o, actor, { action: 'order.confirm', diff: { totalPrice: o.totalPrice } });
  saveOrder(o);
  return o;
}

/** 取消订单：pending_payment → cancelled，记原因（≤200 字）。调用方再 await flushSession */
export function cancelOrder(orderId: string, actor: Actor, reason: string): Order {
  const o = orderFor(orderId, actor);
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  o.status = 'cancelled';
  o.cancelReason = cleanText(reason.trim(), 200);
  audit(o, actor, { action: 'order.cancel', diff: { reason: o.cancelReason } });
  saveOrder(o);
  return o;
}

/**
 * 确认收款：advisor 模式要求已确认价格（OrderStateError('unconfirmed')）；已付的单幂等（不改、不再通知，但同样等提交，
 * 不能在上一次的改动还没提交时就说「已确认」——审查第 5 条，concurrency[1]）。
 * 调 markOrderPaid（记 handoffBeforePaid）、记操作者与审计，等提交（≤5 秒）之后才 notifyPaid 并经渠道发付款确认
 * （真超时也照发，persisted 为 false，调用方据此回 503 store_lagging；poisoned 或冲突时不会再提交，不发，直接 503）。
 * spec 的签名返回 Order，这里多带 persisted
 */
export async function markPaidByAdvisor(orderId: string, actor: Actor): Promise<{ order: Order; persisted: boolean }> {
  const o = orderFor(orderId, actor);
  if (o.status === 'paid') return { order: o, persisted: (await awaitCommit(o.sessionId)).persisted };
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (paymentMode() === 'advisor' && o.confirmedAt == null) throw new OrderStateError('unconfirmed');
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  o.paidMarkedBy = who(actor);
  markOrderPaid(o.id);
  audit(o, actor, { action: 'order.mark_paid', diff: { totalPrice: o.totalPrice } });
  // 不会再提交（poisoned 或冲突）时 awaitCommit 直接抛 StoreLaggingError：不发付款确认，调用方回 503（不变量 20）
  const { persisted } = await awaitCommit(o.sessionId);
  // 付款确认在提交之后才写进会话、发给客户（不变量 20）
  const notice = await notifyPaid(o.id);
  if (notice) {
    const sent = await pushToChannel(notice.sessionId, notice.text, { kind: 'notice', message: notice.message });
    const s = getSession(notice.sessionId);
    if (!sent && s && !SEED_SESSION_RE.test(s.id)) {
      s.messages.push({ role: 'system', content: PAY_NOTICE_FAILED, at: Date.now() });
      saveSession(s, false);
    }
  }
  return { order: o, persisted };
}
