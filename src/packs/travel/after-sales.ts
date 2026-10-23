import { quoteRefund, type AfterSalesInput, type AfterSalesStep, type Order, type PackSources } from '../../core/pack-api.js';
import { travelPolicySchema } from './policy.js';
import { refundChooseText, refundQuoteText, refundTexts } from './refund-words.js';

/** 不接管泛问规则；指定这张单、退款金额的问法可以无副作用地报价。 */
export function isRefundIntent(text: string): boolean {
  if (/退改|规则|政策|条款|手续费|退款比例/.test(text)) return false;
  return /退款|退订|退钱|取消订单|不去了|不想去了|能退多少|(?:这张单|这笔单|这单|这个订单|这张订单).{0,8}(?:能不能退|能退吗|可以退吗)|(?:能不能退|能退吗|可以退吗).{0,8}(?:这张单|这单|订单)/.test(
    text,
  );
}

export function createTravelAfterSales(
  sources: Pick<PackSources, 'getOrder' | 'handoffReasons'>,
  handoffReply: (input: AfterSalesInput) => string,
): (input: AfterSalesInput) => AfterSalesStep | null {
  return (input) => {
    const { session, text, policy, policyHash, brand, today } = input;
    const terms = travelPolicySchema.parse(policy).refund;
    const previous = session.afterSale;
    // 这几个出口仍走原来的引擎流程；旧报价不能跨过它们继续使用。
    if (!terms.selfService || /转人工|人工|真人|顾问/.test(text)) {
      delete session.afterSale;
      return null;
    }
    const handoff = (): AfterSalesStep => {
      delete session.afterSale;
      return {
        kind: 'handoff',
        text: handoffReply(input),
        record: { kind: 'refund', reason: sources.handoffReasons.refund, quote: text },
      };
    };
    if (
      /(?:另一个|另外一个|其他|别的|另一个人[的]?)微信.{0,12}(?:下的?单|订单|订的?)|(?:下的?单|订单).{0,12}(?:另一个|别的|其他)微信/.test(
        text,
      )
    )
      return handoff();
    const ctx = { policy, brand, channel: session.channel };
    const owned = (id: string) => {
      const order = sources.getOrder(id);
      return order?.sessionId === session.id && session.orderIds.includes(id) ? order : undefined;
    };
    const paid = session.orderIds.map(owned).filter((o): o is Order => o?.status === 'paid');
    const quoteOrder = (order: Order): AfterSalesStep => {
      const quote = quoteRefund(order, terms, policyHash, today);
      if ('ineligible' in quote) return handoff();
      session.afterSale = { step: 'confirm', quote, at: Date.now() };
      return { kind: 'reply', text: refundQuoteText(order, quote, ctx) };
    };
    if (previous) {
      delete session.afterSale;
      if (Date.now() - previous.at >= 30 * 60_000) return null;
      if (previous.step === 'confirm') {
        if (!/^\s*确认退款[。.!！?？，,、；;…]*\s*$/.test(text) || previous.quote.policyHash !== policyHash) return null;
        const order = owned(previous.quote.orderId);
        if (!order) return null;
        // 已提交的同一报价交给核心的幂等分支；别的状态变化重新核验。
        if (order.status === 'paid') {
          const checked = quoteRefund(order, terms, policyHash, today);
          if ('ineligible' in checked) return handoff();
          if (
            checked.daysBefore !== previous.quote.daysBefore ||
            checked.amount !== previous.quote.amount ||
            checked.tier.id !== previous.quote.tier.id ||
            checked.tier.percent !== previous.quote.tier.percent
          )
            return quoteOrder(order);
        } else if (!['refund_pending', 'refunded'].includes(order.status)) return handoff();
        session.afterSale = previous; // busy 可以重试，重复确认仍由 requestRefund 幂等处理。
        return { kind: 'submit', quote: previous.quote, texts: refundTexts(previous.quote, ctx) };
      }
      const matching = previous.orderIds.map(owned).filter((o): o is Order => o?.status === 'paid' && o.id.slice(-6) === text.trim());
      if (matching.length === 1) return quoteOrder(matching[0]);
      return null;
    }
    if (!isRefundIntent(text) || !paid.length) return null;
    const refundable = paid.filter((order) => !('ineligible' in quoteRefund(order, terms, policyHash, today)));
    if (!refundable.length) return handoff();
    if (refundable.length === 1) return quoteOrder(refundable[0]);
    session.afterSale = { step: 'choose', orderIds: refundable.map((o) => o.id), at: Date.now() };
    return { kind: 'reply', text: refundChooseText(refundable) };
  };
}
