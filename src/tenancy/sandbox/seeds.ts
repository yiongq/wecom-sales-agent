// 唯一来源是已提交的种子夹具；每次开通生成新会话 id，所有相对时间统一平移。
// 07 R21：订单的 departOffsetDays 开通时按开通日算出 departDate；每段种子会话打 seed: true；
// 带 refundSeed 的订单（G01）开通时按已发布的 policy 补全退款记录，对客的报价句、提交句和转人工原因用行业包的退款文字现算，
// 状态与真实走一遍「我要退款 → 确认退款」之后一致（src/core/engine/index.ts 的 submit 分支）。
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { quoteRefund } from '../../core/refund.js';
import type { BrandProfile, EnginePackHooks, RefundTerms } from '../../core/pack-api.js';
import { cleanText } from '../../shared/text.js';
import type { Order, PaymentMode, RefundRecord, Session } from '../../types.js';

/** 退款种子要用的已发布配置；包没有退款能力或自助退款关着时调用方给 null，G01 就不生成 */
export interface SeedRefundContext {
  terms: RefundTerms;
  policy: unknown;
  policyHash: string;
  brand: BrandProfile | null;
  paymentMode: PaymentMode;
  words: NonNullable<EnginePackHooks['refund']>;
  /** 档位 id → 对客出处，如「退改条款第1条」 */
  clauseTitle(tierId: string): string;
}
export interface SeedContext {
  /** 开通日（服务器时区的 YYYY-MM-DD），出发日与退款天数都从它算 */
  today: string;
  refund: SeedRefundContext | null;
}

/** 夹具里的订单：出发日可以写成相对开通日的天数；refundSeed 标出要补全退款记录的那一张 */
export type SeedOrder = Omit<Order, 'departDate'> & {
  departDate?: string;
  departOffsetDays?: number;
  refundSeed?: { requestedAt: number };
};

const REFUND_QUOTE = '{refund_quote}';
const REFUND_SUBMITTED = '{refund_submitted}';
const REFUND_REASON = '{refund_reason}';

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * 补全一张退款种子订单：返回退款记录与要写进会话的三样现算内容；做不到真实流程那样的「要人工」状态（自助退款关着、报价办不了、
 * 低于阈值且模拟支付当场办完）就返回 null，调用方整段不要。
 */
function buildRefund(order: SeedOrder & { departDate: string }, requestedAt: number, ctx: SeedRefundContext, today: string) {
  if (!ctx.terms.selfService) return null;
  const quote = quoteRefund({ ...order, status: 'paid' }, ctx.terms, ctx.policyHash, today);
  if ('ineligible' in quote) return null;
  const approval: RefundRecord['approval'] = quote.amount <= ctx.terms.approvalThresholdYuan ? 'auto' : 'pending';
  const settlement: RefundRecord['settlement'] = ctx.paymentMode === 'online' ? 'mock' : 'advisor';
  if (approval === 'auto' && settlement === 'mock') return null;
  const refund: RefundRecord = {
    id: `rf_${randomBytes(6).toString('hex')}`,
    requestedAt,
    daysBefore: quote.daysBefore,
    tierId: quote.tier.id,
    percent: quote.tier.percent,
    amount: quote.amount,
    policyHash: quote.policyHash,
    approval,
    settlement,
  };
  const textCtx = { policy: ctx.policy, brand: ctx.brand, channel: 'simulator' };
  const amount = `¥${quote.amount.toLocaleString('en-US')}`;
  return {
    quote,
    refund,
    quoteText: cleanText(ctx.words.quoteText(order, quote, textCtx)),
    submittedText: cleanText(ctx.words.texts(quote, textCtx).submitted),
    reason:
      approval === 'pending'
        ? `退款待审批：${amount}（${ctx.clauseTitle(quote.tier.id)}）`
        : `退款待打款：${amount}（已自动批准，按原付款方式退回）`,
  };
}

export function sandboxSeeds(createdAt: number, ctx: SeedContext): { sessions: Session[]; orders: Order[] } {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../data/sandbox-seeds.json', import.meta.url), 'utf8')) as {
    sessions: Session[];
    orders: SeedOrder[];
  };
  const ids = new Map(fixture.sessions.map((session) => [session.id, `sbx-${randomBytes(16).toString('hex')}`]));
  const base = createdAt - 5 * 60_000;
  function shift(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shift);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          (key === 'at' || key.endsWith('At')) && typeof item === 'number' ? base + item : shift(item),
        ]),
      );
    return value;
  }
  let sessions = fixture.sessions.map((session) => ({
    ...(shift(session) as Session),
    id: ids.get(session.id)!,
    channel: 'simulator',
    seed: true,
  }));
  let orders = fixture.orders.map((order) => {
    const { departOffsetDays, ...rest } = shift(order) as SeedOrder;
    return {
      ...rest,
      sessionId: ids.get(order.sessionId)!,
      ...(departOffsetDays === undefined ? {} : { departDate: addDays(ctx.today, departOffsetDays) }),
    } as SeedOrder;
  });

  const dropped = new Set<string>();
  orders = orders.flatMap((seed) => {
    const { refundSeed, ...order } = seed;
    if (!refundSeed) return [order];
    const built = ctx.refund && buildRefund(order as SeedOrder & { departDate: string }, refundSeed.requestedAt, ctx.refund, ctx.today);
    if (!built) {
      dropped.add(order.id);
      return [];
    }
    sessions = sessions.map((session) => {
      if (!session.orderIds.includes(order.id)) return session;
      const text: Record<string, string> = { [REFUND_QUOTE]: built.quoteText, [REFUND_SUBMITTED]: built.submittedText };
      return {
        ...session,
        messages: session.messages.map((m) => (Object.hasOwn(text, m.content) ? { ...m, content: text[m.content]! } : m)),
        ...(session.afterSale?.step === 'confirm' ? { afterSale: { ...session.afterSale, quote: built.quote } } : {}),
        ...(session.handoff?.reason === REFUND_REASON ? { handoff: { ...session.handoff, reason: built.reason } } : {}),
      };
    });
    return [{ ...order, status: 'refund_pending' as const, refund: built.refund }];
  });
  if (dropped.size) sessions = sessions.filter((session) => !session.orderIds.some((id) => dropped.has(id)));
  return { sessions, orders: orders as Order[] };
}
