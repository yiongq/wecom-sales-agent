// 07 R19：同步改内存并排入订单所属会话的同一次提交；后台通知只在提交成功之后发送。
import { randomBytes } from 'node:crypto';
import { currentPack, currentPolicy } from '../config/source.js';
import type { RefundQuote, RefundTerms } from '../core/pack-api.js';
import {
  type Actor,
  awaitCommit,
  ForbiddenError,
  handlesConversations,
  isAssignee,
  NotHandlingError,
  prepareChannel,
  pushToChannel,
  supervisesConversations,
} from '../handoff/takeover.js';
import { shortIdOf } from '../shared/conversation.js';
import { cleanText } from '../shared/text.js';
import { getOrder, getSession, queueAudit, saveOrder, saveSession, storeLagging, StoreLaggingError } from '../store.js';
import type { ChatMessage, Order } from '../types.js';
import { paymentMode } from './mode.js';
import { OrderNotFoundError, OrderStateError } from './orders.js';

const who = (actor: Actor) => ({ userId: actor.userId, name: actor.name });

function audit(order: Order, entry: { action: string }, actor?: Actor): void {
  queueAudit(
    order.sessionId,
    actor ? { kind: 'user', ...who(actor), ip: actor.ip ?? null } : { kind: 'system', userId: null, name: null, ip: null },
    {
      action: entry.action,
      targetType: 'order',
      targetId: order.id,
      diff: {
        shortId: shortIdOf(order.sessionId),
        refundId: order.refund!.id,
        amount: order.refund!.amount,
        approval: order.refund!.approval,
        settlement: order.refund!.settlement,
        ...(order.refund!.decision?.reason ? { reason: order.refund!.decision.reason } : {}),
      },
    },
  );
}

function healthy(order: Order): void {
  if (storeLagging(order.sessionId)) throw new StoreLaggingError(order.sessionId);
}

function orderFor(orderId: string, actor: Actor, approval: boolean): Order {
  if (!handlesConversations(actor.role) || (approval && !supervisesConversations(actor.role))) throw new ForbiddenError();
  const order = getOrder(orderId);
  if (!order) throw new OrderNotFoundError();
  const session = getSession(order.sessionId);
  if (!supervisesConversations(actor.role) && (!session || !isAssignee(session, actor))) throw new NotHandlingError();
  return order;
}

export function requestRefund(
  quote: RefundQuote,
  terms: RefundTerms,
): { order: Order; created: boolean; needsHuman: boolean } | { busy: true } {
  const order = getOrder(quote.orderId);
  if (!order) throw new OrderNotFoundError();
  if (storeLagging(order.sessionId)) return { busy: true };
  if ((order.status === 'refund_pending' || order.status === 'refunded') && order.refund) {
    return { order, created: false, needsHuman: order.refund.approval !== 'auto' || order.refund.settlement !== 'mock' };
  }
  if (order.status !== 'paid' || order.paidAt == null || order.refund?.approval === 'rejected') throw new OrderStateError(order.status);
  const tier = terms.tiers.find((t) => t.id === quote.tier.id);
  if (
    !tier ||
    quote.daysBefore < tier.minDays ||
    (tier.maxDays !== null && quote.daysBefore > tier.maxDays) ||
    quote.tier.percent !== tier.percent ||
    quote.amount !== Math.floor((order.totalPrice * tier.percent) / 100)
  )
    throw new OrderStateError(order.status);
  const now = Date.now();
  order.status = 'refund_pending';
  order.refund = {
    id: `rf_${randomBytes(6).toString('hex')}`,
    requestedAt: now,
    daysBefore: quote.daysBefore,
    tierId: tier.id,
    percent: tier.percent,
    amount: quote.amount,
    policyHash: quote.policyHash,
    approval: quote.amount <= terms.approvalThresholdYuan ? 'auto' : 'pending',
    settlement: paymentMode() === 'online' ? 'mock' : 'advisor',
  };
  const needsHuman = order.refund.approval !== 'auto' || order.refund.settlement !== 'mock';
  if (!needsHuman) {
    order.status = 'refunded';
    order.refund.settled = { at: now, by: null };
  }
  audit(order, { action: 'order.refund_request' });
  saveOrder(order);
  return { order, created: true, needsHuman };
}

/** 文字与品牌在等待提交前捕获。超时不发办结通知，调用方回 503；重复点击也不再排通知或审计。 */
async function committed(order: Order, notice?: 'settled' | 'rejected'): Promise<{ order: Order; persisted: boolean }> {
  const pack = currentPack();
  const session = getSession(order.sessionId);
  const text =
    notice && session && pack.runtime.engineHooks.refund
      ? cleanText(
          pack.runtime.engineHooks.refund.noticeText(order, notice, {
            policy: currentPolicy().policy,
            channel: session.channel,
            brand: pack.brand,
          }),
        )
      : null;
  const { persisted } = await awaitCommit(order.sessionId);
  if (persisted && text && session) {
    const message: ChatMessage = { role: 'agent', content: text, at: Date.now() };
    session.messages.push(message);
    saveSession(session);
    const prepared = prepareChannel(session.id, text, { kind: 'notice', message });
    const sent = await pushToChannel(session.id, text, { kind: 'notice', message, prepared });
    if (!sent && !session.id.startsWith('wecom:cust_')) {
      session.messages.push({
        role: 'system',
        content: '⚠️ 上一条退款通知未能发送到客户（推送失败：可能是会话窗口已关闭或渠道配置问题），请另行告知客户退款处理结果',
        at: Date.now(),
      });
      saveSession(session, false);
    }
  }
  return { order, persisted };
}

export async function approveRefund(orderId: string, actor: Actor): Promise<{ order: Order; persisted: boolean }> {
  const order = orderFor(orderId, actor, true);
  const refund = order.refund;
  if (refund?.approval === 'approved' && (order.status === 'refund_pending' || order.status === 'refunded')) return committed(order);
  if (order.status !== 'refund_pending' || !refund || refund.approval !== 'pending' || order.paidAt == null)
    throw new OrderStateError(order.status);
  healthy(order);
  refund.approval = 'approved';
  refund.decision = { at: Date.now(), by: who(actor) };
  if (refund.settlement === 'mock') {
    order.status = 'refunded';
    refund.settled = { at: Date.now(), by: null };
  }
  audit(order, { action: 'order.refund_approve' }, actor);
  saveOrder(order);
  return committed(order, order.status === 'refunded' ? 'settled' : undefined);
}

export async function rejectRefund(orderId: string, actor: Actor, reason: string): Promise<{ order: Order; persisted: boolean }> {
  const order = orderFor(orderId, actor, true);
  const refund = order.refund;
  if (order.status === 'paid' && refund?.approval === 'rejected') return committed(order);
  if (order.status !== 'refund_pending' || !refund || refund.approval !== 'pending') throw new OrderStateError(order.status);
  healthy(order);
  order.status = 'paid';
  refund.approval = 'rejected';
  refund.decision = { at: Date.now(), by: who(actor), reason: cleanText(reason.trim(), 200) };
  audit(order, { action: 'order.refund_reject' }, actor);
  saveOrder(order);
  return committed(order, 'rejected');
}

export async function settleRefund(orderId: string, actor: Actor): Promise<{ order: Order; persisted: boolean }> {
  const order = orderFor(orderId, actor, false);
  const refund = order.refund;
  if (paymentMode() !== 'advisor' || !refund || refund.settlement !== 'advisor' || !['auto', 'approved'].includes(refund.approval))
    throw new OrderStateError(order.status);
  if (order.status === 'refunded') return committed(order);
  if (order.status !== 'refund_pending' || order.paidAt == null) throw new OrderStateError(order.status);
  healthy(order);
  order.status = 'refunded';
  refund.settled = { at: Date.now(), by: who(actor) };
  audit(order, { action: 'order.refund_settle' }, actor);
  saveOrder(order);
  return committed(order, 'settled');
}
