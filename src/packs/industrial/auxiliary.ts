import {
  getAnyOrder,
  quoteState,
  type FollowupTemplates,
  type InsightPrompts,
  type MockPolicy,
  type Session,
} from '../../core/pack-api.js';
import { inquiryLines } from './turn.js';
export const followupTemplates: FollowupTemplates = {
  idleMinutes: { quote: 1440, closing: 1440 },
  byStage: { quote: '需要我出一份正式报价单吗？', closing: '报价单收到了吗？有问题随时问我' },
  fallback: '询价有问题随时问我。',
  system:
    '你是工业品询价顾问，写一句简短跟进，只输出正文。报价阶段问是否需要正式报价单，促成阶段问报价单是否收到。不承诺库存、交期、替代或额外折扣，不编造金额与链接。',
};
export function followupGate(session: Session): boolean {
  const now = Date.now();
  return !session.orderIds.some((id) => {
    const order = getAnyOrder(id);
    return order && 'v' in order && order.sessionId === session.id && quoteState(order, now) === 'pending';
  });
}
export const insightPrompts: InsightPrompts = {
  insights: '分析工业品询价的型号、数量、候选歧义、起订量、报价审批与成交障碍，给出简短事实与下一步。',
  suggestion: '根据本次询价给销售顾问建议，不编造库存、交期、替代或金额，不替顾问批准报价。',
  draft: '代拟工业品询价回复，缺型号或数量先澄清；事实只来自工具与当前政策。',
  reach: { greeting: 0, discovery: 1, recommend: 2, quote: 3, closing: 4, paid: 5 },
  funnelNames: ['开始', '问需', '推荐', '报价', '促成', '已支付'],
  draftFallbackStage: 'discovery',
  stuckStages: ['recommend', 'quote', 'closing'],
  draftFallback: { discovery: '请告诉我型号和数量。', quote: '需要我出一份正式报价单吗？', closing: '报价单收到了吗？有问题随时问我' },
};
export const mock: MockPolicy = {
  async chat(opts) {
    const text = opts.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    if (/人工|投诉|退款/.test(text)) {
      await opts.executeTool('handoff_to_human', { reason: '客户要求顾问协助' });
      return '我请顾问继续跟您核对。';
    }
    const items = inquiryLines(text);
    if (items.length) {
      const result = JSON.parse(await opts.executeTool('quote_items', { items }));
      if (result.error) return '询价明细需要顾问核对。';
      return [
        ...result.lines.map((line: { partNo?: string; query: string; qty: number; amount?: number; delivery?: string; note?: string }) =>
          line.amount === undefined
            ? `${line.query}：${line.note === 'below_moq' ? '未达起订量' : '请确认具体型号'}`
            : `${line.partNo} 数量${line.qty}，金额${line.amount.toFixed(2)}元，${line.delivery}`,
        ),
        ...(typeof result.total === 'number' ? [`合计${result.total.toFixed(2)}元`] : []),
      ].join('\n');
    }
    if (/报价单|正式报价/.test(text)) {
      // 用本轮上下文中的摘要，不从自然语言中猜条目编号。
      const draft = /询价摘要：(\{[^\n]*\})/.exec(opts.contextNote ?? '');
      if (draft) {
        const lines = JSON.parse(draft[1]!).lines as { match: string; code?: string; qty: number }[];
        if (lines.length && lines.every((line) => line.match === 'exact')) {
          const result = JSON.parse(await opts.executeTool('create_quote_sheet', { items: lines.map(({ code, qty }) => ({ code, qty })) }));
          if (result.state === 'pending') return '最新的报价单还在顾问审核，审好马上发您';
          if (result.state === 'approved') return `报价单：${result.quoteUrl}\n合计${result.totalText}`;
        }
      }
      return '请先确认型号和数量，我帮您试算后起草正式报价单。';
    }
    if (/型号|[A-Za-z].*\d/.test(text)) {
      const result = JSON.parse(await opts.executeTool('find_parts', { query: text.replace(/^型号[:：]?\s*/, '').trim() }));
      return result.parts?.length
        ? result.parts.map((part: { partNo: string; name: string }) => `${part.partNo} ${part.name}`).join('\n') + '\n请确认型号和数量。'
        : '暂时没找到对应型号，请核对型号和规格。';
    }
    return '请告诉我型号和数量。';
  },
};
