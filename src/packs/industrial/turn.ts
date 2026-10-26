import type { DeterministicReply, TurnContext } from '../../core/pack-api.js';
import { latestQuoteCandidate } from './quote-candidate.js';

export const FIXED = {
  nonstandard: '非标和来图加工需要顾问确认，我请顾问继续跟您核对。',
  credit: '账期和月结需要顾问确认，我请顾问继续跟您核对。',
  sample: '样品需求需要顾问确认，我请顾问继续跟您核对。',
  long: '询价超过30行，我请顾问继续跟您核对。',
  accepted: '好的，顾问会尽快联系您确认付款和发货',
  pending: '最新的报价单还在顾问审核，审好马上发您',
} as const;
export function inquiryLines(text: string): { query: string; qty: number }[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => {
      // 只数当前消息内显式的型号 + 数量，不把型号自身的数字当数量。
      const match =
        /^\s*(?:型号[:：]?\s*)?([A-Za-z0-9][A-Za-z0-9×*\-_/ .]*?)\s*(?:[，,:：=]\s*|\s+|[×*]\s*)(\d+)\s*(?:件|个|套|米|千克|盒|pcs)?\s*$/i.exec(
          line,
        );
      return match && /[A-Za-z]/.test(match[1]!) ? [{ query: match[1]!.trim(), qty: Number(match[2]) }] : [];
    });
}
export function preModel(ctx: TurnContext): DeterministicReply | null {
  const type = /非标|定制|按图|来图|图纸|加工|改制/.test(ctx.text)
    ? 'nonstandard'
    : /账期|月结/.test(ctx.text)
      ? 'credit'
      : /样品/.test(ctx.text)
        ? 'sample'
        : inquiryLines(ctx.text).length > 30
          ? 'long'
          : null;
  if (type) return { text: FIXED[type], fixedId: `industrial.${type}`, handoff: { reason: FIXED[type] } };
  if (!/确认下单|确认报价|就按这个|可以下单|没问题下单吧/.test(ctx.text)) return null;
  // 仅明确确认才通知顾问；问法、否定与尚未决定不当成接受。
  if (/[?？]|吗|是否|能否|能不能|会不会|是不是|还没|尚未|暂不|先别|不(?:要|想|能|会|可以|确认)/.test(ctx.text)) return null;
  const now = Date.now();
  const candidate = latestQuoteCandidate(ctx.session, now);
  if (candidate?.kind !== 'quote') return null;
  if (candidate.state === 'pending') return { text: FIXED.pending, fixedId: 'industrial.pending' };
  if (candidate.state === 'expired') return null;
  return {
    text: FIXED.accepted,
    fixedId: 'industrial.accepted',
    statePatch: { confirmedQuoteAt: now },
    notify: { reason: 'quote_accepted', orderId: candidate.order.id },
  };
}
export function contextNote(ctx: TurnContext): string[] {
  const candidate = latestQuoteCandidate(ctx.session, Date.now());
  if (candidate?.kind === 'quote') {
    if (candidate.state === 'expired') return ['报价单已过期，需要重新调 quote_items 试算'];
    return [candidate.state === 'pending' ? '最新的报价单还在顾问审核' : '最新的是已批准且有效的报价单'];
  }
  return candidate ? ['最新的是本次试算，需要重新确认本次试算，不能确认上一份报价单'] : [];
}
