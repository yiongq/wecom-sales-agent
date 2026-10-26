// 后台的订单动作：确认价格、确认收款、取消订单（docs/architecture/02-conversations-workbench/spec.md「收款流程（价格确认闸）」、
// 不变量 39 的接口部分；02 第 13 步随后台接口接上，advisor 模式的对客文案、/pay 页与 SOP 在第 15 步）。
// 先查写库健康，改内存，随落库写一行审计；确认收款等提交（≤5 秒）之后才对客户发付款确认（不变量 20）。
// 操作者：owner、admin、supervisor 任何订单；agent（与共享工作台）只限订单所属会话的接手人本人，否则 NotHandlingError；
// 会话已被清除（订单不再指向内存里的会话）的订单只许 supervisor 以上
import { currentPack } from '../config/source.js';
import { notifyPaid } from '../engine.js';
import {
  type Actor,
  awaitCommit,
  ForbiddenError,
  handlesConversations,
  isAssignee,
  NotHandlingError,
  pushToChannel,
  prepareChannel,
  supervisesConversations,
  takeover,
} from '../handoff/takeover.js';
import { shortIdOf } from '../shared/conversation.js';
import { cleanText } from '../shared/text.js';
import {
  getAnyOrder,
  getSession,
  markOrderPaid,
  queueAudit,
  saveOrder,
  saveSession,
  storeLagging,
  StoreLaggingError,
  supersedeOrder,
  listAnyOrders,
  queueJobs,
} from '../store.js';
import { isLineOrder, orderTotalFen, quoteState, type LineOrder, type AnyOrder } from '../core/order-view.js';
import type { ChatMessage, OrderStatus } from '../types.js';
import { terminalStageKey } from '../handoff/record.js';
import { quoteNotifyOps } from '../jobs/notify.js';
import { RejectQuoteBody, WithdrawQuoteBody } from '../shared/console-api.js';
import { paymentMode } from './mode.js';

/** 订单状态不允许这个动作 → 409 order_state（unconfirmed：advisor 模式下还没确认价格就确认收款） */
export class OrderStateError extends Error {
  constructor(readonly status: OrderStatus | 'voided' | 'unconfirmed') {
    super(status === 'unconfirmed' ? '还没确认价格，不能确认收款' : `订单现在是 ${status}，不能这样改`);
  }
}
/** 09 状态表的报价拒绝码；旧订单的 order_state 口径保持不变。 */
export class QuoteStateError extends Error {
  constructor(readonly code: 'quote_order' | 'not_approved' | 'invalid' | 'superseded' | 'paid' | 'already_decided') {
    super(code);
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

function orderFor(orderId: string, actor: Actor, quoteAction = false): AnyOrder {
  if (!handlesConversations(actor.role) || (quoteAction && actor.role === 'shared')) throw new ForbiddenError();
  const o = getAnyOrder(orderId);
  if (!o) throw new OrderNotFoundError();
  if (supervisesConversations(actor.role)) return o;
  const s = o.sessionId ? getSession(o.sessionId) : undefined;
  if (!s || !(quoteAction ? canDecideQuote(s, actor) : isAssignee(s, actor))) throw new NotHandlingError();
  return o;
}

const who = (a: Actor) => ({ userId: a.userId, name: a.name });

/** 订单类审计（spec「后台接口」）：target 是订单号，diff 带所属会话的短码 */
function audit(o: AnyOrder, actor: Actor, entry: { action: string; diff: Record<string, unknown> }): void {
  queueAudit(
    o.sessionId,
    { kind: 'user', userId: actor.userId, name: actor.name, ip: actor.ip ?? null },
    { action: entry.action, targetType: 'order', targetId: o.id, diff: { shortId: shortIdOf(o.sessionId), ...entry.diff } },
  );
}

/** R7 的报价动作权限；确认收款仍沿用订单权限。 */
export function canDecideQuote(session: import('../types.js').Session, actor: Actor): boolean {
  return supervisesConversations(actor.role) || (actor.role === 'agent' && (!session.handedOver || isAssignee(session, actor)));
}

function quoteFor(orderId: string, actor: Actor): LineOrder & { approval: NonNullable<LineOrder['approval']> } {
  const order = orderFor(orderId, actor, true);
  if (!isLineOrder(order) || !order.approval) throw new QuoteStateError('invalid');
  return order as LineOrder & { approval: NonNullable<LineOrder['approval']> };
}

async function quoteCommitted(order: LineOrder): Promise<void> {
  if (!(await awaitCommit(order.sessionId)).persisted) throw new StoreLaggingError(order.sessionId);
}

function recheckApproved(order: LineOrder, allowExpired = false): void {
  const session = getSession(order.sessionId);
  if (getAnyOrder(order.id) !== order || !session || !session.orderIds.includes(order.id)) throw new QuoteStateError('invalid');
  const after = quoteState(order, Date.now());
  if (after !== 'approved' && !(allowExpired && after === 'expired'))
    throw new QuoteStateError(after === 'superseded' || after === 'paid' ? after : 'invalid');
}

/** 同步条件写入同一会话队列，等提交后重新核对 identity map；此后到发送之间没有异步间隙。 */
export async function approveQuote(orderId: string, actor: Actor): Promise<LineOrder> {
  const order = quoteFor(orderId, actor);
  const state = quoteState(order, Date.now());
  if (state === 'paid' || state === 'superseded') throw new QuoteStateError(state);
  if (order.approval.state === 'rejected') throw new QuoteStateError('already_decided');
  if (state === 'invalid') throw new QuoteStateError('invalid');
  if (order.approval.state === 'approved') {
    await quoteCommitted(order);
    recheckApproved(order, true);
    return order;
  }
  if (storeLagging(order.sessionId)) throw new StoreLaggingError(order.sessionId);
  const now = Date.now();
  order.approval = { ...order.approval, state: 'approved', decidedAt: now, decidedBy: who(actor) };
  order.confirmedAt = now;
  order.confirmedBy = who(actor);
  for (const old of listAnyOrders()) {
    if (old.id !== order.id && old.sessionId === order.sessionId && isLineOrder(old) && old.approval?.state === 'approved')
      supersedeOrder(old.id, order.id);
  }
  audit(order, actor, { action: 'quote.approve', diff: { totalFen: orderTotalFen(order) } });
  saveOrder(order);
  await quoteCommitted(order);
  recheckApproved(order);
  await quoteNotice(order, `/quote/${order.id}`, '报价单发送失败，请另行告知客户。', true);
  return order;
}

async function quoteNotice(order: LineOrder, text: string | undefined, failure: string, approved = false): Promise<void> {
  const session = getSession(order.sessionId);
  if (!text || !session || session.seed || SEED_SESSION_RE.test(session.id)) return;
  // 未知消息字段由现有投影写进 messages.extra；不改变旅游消息的形状。
  const message: ChatMessage = Object.assign(
    { role: 'agent' as const, content: text, at: Date.now() },
    approved ? { quoteStates: { [order.id]: 'approved' } } : {},
  );
  const prepared = prepareChannel(session.id, text, { kind: 'notice', message });
  session.messages.push(message);
  saveSession(session, false);
  const sent = await pushToChannel(session.id, text, { kind: 'notice', message, prepared });
  if (!sent && getSession(session.id) === session) {
    session.messages.push({ role: 'system', content: failure, at: Date.now() });
    saveSession(session, false);
  }
}

export async function rejectQuote(orderId: string, actor: Actor, reason: string): Promise<LineOrder> {
  const input = RejectQuoteBody.parse({ reason });
  const order = quoteFor(orderId, actor);
  const state = quoteState(order, Date.now());
  if (state === 'paid' || state === 'superseded') throw new QuoteStateError(state);
  if (order.approval.state === 'approved') throw new QuoteStateError('already_decided');
  if (state !== 'pending') throw new QuoteStateError('invalid');
  if (storeLagging(order.sessionId)) throw new StoreLaggingError(order.sessionId);
  const session = getSession(order.sessionId);
  const text = currentPack().runtime.engineHooks.quoteRejectedText?.(order);
  order.approval = { ...order.approval, state: 'rejected', decidedAt: Date.now(), decidedBy: who(actor), reason: input.reason };
  order.status = 'cancelled';
  order.cancelReason = `顾问驳回：${input.reason}`;
  audit(order, actor, { action: 'quote.reject', diff: { reason: input.reason } });
  if (session) {
    if (!session.handedOver) takeover(session.id, actor);
    else {
      session.messages.push({ role: 'system', content: `${actor.name}驳回了报价单：${input.reason}`, at: Date.now() });
      saveSession(session, false);
    }
  }
  saveOrder(order);
  await quoteCommitted(order);
  if (getAnyOrder(order.id) === order && getSession(order.sessionId)?.orderIds.includes(order.id))
    await quoteNotice(order, text, '报价单驳回通知发送失败，请另行告知客户。');
  return order;
}

/** R8：同步段内把首次确认时间和提醒一起入会话快照。R11 的确定性回复复用此入口。 */
export function recordQuoteAccepted(session: import('../types.js').Session, orderId: string, at = Date.now()): boolean {
  const order = getAnyOrder(orderId);
  if (!order || !isLineOrder(order) || !order.approval || order.sessionId !== session.id || getSession(session.id) !== session)
    throw new QuoteStateError('invalid');
  if (order.approval.acceptedAt != null) return false;
  if (quoteState(order, at) !== 'approved') throw new QuoteStateError('invalid');
  if (storeLagging(session.id)) throw new StoreLaggingError(session.id);
  order.approval.acceptedAt = at;
  queueJobs(session.id, quoteNotifyOps(session.id, order.id, 'quote_accepted', at));
  saveOrder(order);
  saveSession(session, false);
  return true;
}

export async function withdrawQuote(orderId: string, actor: Actor, reason = ''): Promise<LineOrder> {
  const input = WithdrawQuoteBody.parse({ reason });
  quoteFor(orderId, actor);
  return (await cancelOrderAndNotify(orderId, actor, input.reason ?? '')) as LineOrder;
}

/** 确认价格：只对未作废的 pending_payment；重复确认幂等（不改、不再记审计）。调用方再 await flushSession */
export function confirmOrder(orderId: string, actor: Actor): AnyOrder {
  const o = orderFor(orderId, actor);
  if (isLineOrder(o) && o.approval) throw new QuoteStateError('quote_order');
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (o.confirmedAt != null) return o;
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  o.confirmedAt = Date.now();
  o.confirmedBy = who(actor);
  audit(o, actor, { action: 'order.confirm', diff: isLineOrder(o) ? { totalFen: orderTotalFen(o) } : { totalPrice: o.totalPrice } });
  saveOrder(o);
  return o;
}

/** 取消订单：pending_payment → cancelled，记原因（≤200 字）。调用方再 await flushSession */
export function cancelOrder(orderId: string, actor: Actor, reason: string): AnyOrder {
  const candidate = getAnyOrder(orderId);
  const o = orderFor(orderId, actor, !!candidate && isLineOrder(candidate) && !!candidate.approval);
  if (isLineOrder(o) && o.approval) {
    const state = quoteState(o, Date.now());
    if (state === 'superseded' || state === 'paid') throw new QuoteStateError(state);
    if (state === 'invalid') return o;
    if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
    o.approval = { ...o.approval, state: 'withdrawn', decidedAt: Date.now(), decidedBy: who(actor), reason: cleanText(reason.trim(), 120) };
    o.status = 'cancelled';
    o.cancelReason = o.approval.reason;
    audit(o, actor, { action: 'quote.withdraw', diff: { reason: o.approval.reason } });
    saveOrder(o);
    return o;
  }
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  o.status = 'cancelled';
  o.cancelReason = cleanText(reason.trim(), 200);
  audit(o, actor, { action: 'order.cancel', diff: { reason: o.cancelReason } });
  saveOrder(o);
  return o;
}

/** console 取消入口：先提交再通知；只对本次撤回且曾批准的单发送，不泄露原因。 */
export async function cancelOrderAndNotify(orderId: string, actor: Actor, reason: string): Promise<AnyOrder> {
  const candidate = getAnyOrder(orderId);
  const before = orderFor(orderId, actor, !!candidate && isLineOrder(candidate) && !!candidate.approval);
  if (!isLineOrder(before) || !before.approval) return cancelOrder(orderId, actor, reason);
  const notify = before.approval.state === 'approved' && before.status === 'pending_payment';
  const text = notify ? currentPack().runtime.engineHooks.quoteWithdrawnText?.(before) : undefined;
  const order = cancelOrder(orderId, actor, reason);
  const { persisted } = await awaitCommit(order.sessionId);
  if (!persisted) throw new StoreLaggingError(order.sessionId);
  const session = getSession(order.sessionId);
  if (
    text &&
    session &&
    getAnyOrder(order.id) === order &&
    session.orderIds.includes(order.id) &&
    order.status === 'cancelled' &&
    !session.seed &&
    !SEED_SESSION_RE.test(session.id)
  ) {
    const message: ChatMessage = { role: 'agent', content: text, at: Date.now() };
    const prepared = prepareChannel(session.id, text, { kind: 'notice', message });
    session.messages.push(message);
    saveSession(session, false);
    const sent = await pushToChannel(session.id, text, { kind: 'notice', message, prepared });
    if (!sent) {
      session.messages.push({ role: 'system', content: '报价单撤回通知发送失败，请另行告知客户。', at: Date.now() });
      saveSession(session, false);
    }
  }
  return order;
}

/**
 * 确认收款：advisor 模式要求已确认价格（OrderStateError('unconfirmed')）；已付的单幂等（不改、不再通知，但同样等提交，
 * 不能在上一次的改动还没提交时就说「已确认」——审查第 5 条，concurrency[1]）。
 * 调 markOrderPaid（记 handoffBeforePaid）、记操作者与审计，等提交（≤5 秒）之后才 notifyPaid 并经渠道发付款确认
 * （真超时也照发，persisted 为 false，调用方据此回 503 store_lagging；poisoned 或冲突时不会再提交，不发，直接 503）。
 * spec 的签名返回 Order，这里多带 persisted
 */
export async function markPaidByAdvisor(orderId: string, actor: Actor): Promise<{ order: AnyOrder; persisted: boolean }> {
  const o = orderFor(orderId, actor);
  if (o.status === 'paid') return { order: o, persisted: (await awaitCommit(o.sessionId)).persisted };
  if (isLineOrder(o) && o.approval) {
    const state = quoteState(o, Date.now());
    if (state === 'superseded' || state === 'invalid') throw new QuoteStateError(state);
    if (o.approval.state !== 'approved') throw new QuoteStateError('not_approved');
  }
  if (o.status !== 'pending_payment') throw new OrderStateError(o.status);
  if (!(isLineOrder(o) && o.approval) && paymentMode() === 'advisor' && o.confirmedAt == null) throw new OrderStateError('unconfirmed');
  if (storeLagging(o.sessionId)) throw new StoreLaggingError(o.sessionId);
  if (isLineOrder(o)) terminalStageKey();
  o.paidMarkedBy = who(actor);
  markOrderPaid(o.id);
  audit(o, actor, { action: 'order.mark_paid', diff: isLineOrder(o) ? { totalFen: orderTotalFen(o) } : { totalPrice: o.totalPrice } });
  // 不会再提交（poisoned 或冲突）时 awaitCommit 直接抛 StoreLaggingError：不发付款确认，调用方回 503（不变量 20）
  const { persisted } = await awaitCommit(o.sessionId);
  // 付款确认在提交之后才写进会话、发给客户（不变量 20）
  const notice = await notifyPaid(o.id);
  if (notice) {
    const sent = await pushToChannel(notice.sessionId, notice.text, { kind: 'notice', message: notice.message, prepared: notice.prepared });
    const s = getSession(notice.sessionId);
    if (!sent && s && !SEED_SESSION_RE.test(s.id)) {
      s.messages.push({ role: 'system', content: PAY_NOTICE_FAILED, at: Date.now() });
      saveSession(s, false);
    }
  }
  return { order: o, persisted };
}
