import type { Order, RefundQuote, RefundTexts, RefundTextContext } from '../../core/pack-api.js';
import { advisorContact } from './contact-words.js';
import { clauses, travelPolicySchema } from './policy.js';

const yuan = (n: number): string => `¥${n.toLocaleString('en-US')}`;
const contactMode = (ctx: RefundTextContext) => ({ channel: ctx.channel, templateMode: ctx.brand !== null });
/** 出处标题始终取发布条款生成器，不把档位 id 当作条款序号。 */
export function refundClauseTitle(tierId: string, ctx: RefundTextContext): string {
  return clauses(travelPolicySchema.parse(ctx.policy)).find((c) => c.id === tierId)?.title ?? '退改条款';
}

export function refundQuoteText(order: Order, quote: RefundQuote, ctx: RefundTextContext): string {
  const [, month, day] = order.departDate.split('-').map(Number);
  return `《${order.routeTitle}》${order.travelers} 位、${month} 月 ${day} 日出发（订单尾号 ${order.id.slice(-6)}）：离出发 ${quote.daysBefore} 天，按${refundClauseTitle(quote.tier.id, ctx)}可退${quote.tier.percent === 100 ? '全款 ' : ' '}${yuan(quote.amount)}。确认退款请回复「确认退款」。`;
}

export function refundChooseText(orders: readonly Order[]): string {
  return `您有多张可退款订单，请回复要退款的订单尾号：\n${orders.map((o) => `《${o.routeTitle}》、${o.departDate} 出发、尾号 ${o.id.slice(-6)}`).join('\n')}`;
}

export function refundTexts(quote: RefundQuote, ctx: RefundTextContext): RefundTexts {
  const threshold = travelPolicySchema.parse(ctx.policy).refund.approvalThresholdYuan;
  const contact = advisorContact(contactMode(ctx));
  return {
    done: `已为您办好退款 ${yuan(quote.amount)}（${refundClauseTitle(quote.tier.id, ctx)}）。这是演示环境的模拟退款，不产生真实打款。`,
    submitted:
      quote.amount > threshold
        ? `退款申请已提交：${yuan(quote.amount)}。金额超过 ${yuan(threshold)} 要顾问审核，${contact}。`
        : `退款申请已提交：${yuan(quote.amount)}，顾问会按原付款方式退回，并${contact.slice('顾问会'.length)}。`,
    duplicate: '退款申请已经提交过了',
    busy: '系统有点忙，请稍后再回一次「确认退款」',
    delayed: '退款申请已收到，正在处理，顾问核实后会联系您',
  };
}

export function refundNoticeText(order: Order, kind: 'settled' | 'rejected', ctx: RefundTextContext): string {
  if (kind === 'rejected') {
    const mode = contactMode(ctx);
    const tail = mode.channel === 'web' ? '在这个页面里跟您说明' : mode.templateMode ? '联系您说明' : '在微信上跟您说明';
    return `退款申请没有通过，顾问会${tail}。`;
  }
  const r = order.refund!;
  const amount = yuan(r.amount);
  const title = refundClauseTitle(r.tierId, ctx);
  return r.settlement === 'mock'
    ? `已为您办好退款 ${amount}（${title}）。这是演示环境的模拟退款，不产生真实打款。`
    : `顾问已确认按原付款方式退回 ${amount}（${title}），请留意到账情况。`;
}
