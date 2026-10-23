import type { Order } from '../types.js';
import type { RefundTerms, RefundTier } from './pack-api.js';

export type RefundQuote = { orderId: string; daysBefore: number; tier: RefundTier; amount: number; policyHash: string };
export type RefundTexts = { done: string; submitted: string; duplicate: string; busy: string; delayed: string };

/** 07 R16：只按传入的日期与已发布条款计算；UTC 午夜相减避免夏令时造成半天误差。 */
export function quoteRefund(
  order: Order,
  terms: RefundTerms,
  policyHash: string,
  today: string,
): RefundQuote | { ineligible: 'not_paid' | 'departed' | 'no_tier' | 'rejected_before' } {
  if (order.status !== 'paid') return { ineligible: 'not_paid' };
  if (order.refund?.approval === 'rejected') return { ineligible: 'rejected_before' };
  const daysBefore = (Date.parse(`${order.departDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (daysBefore < 0) return { ineligible: 'departed' };
  const tier = terms.tiers.find((t) => daysBefore >= t.minDays && (t.maxDays === null || daysBefore <= t.maxDays));
  if (!tier) return { ineligible: 'no_tier' };
  return { orderId: order.id, daysBefore, tier: { ...tier }, amount: Math.floor((order.totalPrice * tier.percent) / 100), policyHash };
}
