import { replyBlockBudget, stripMarkdown, type ReplyBlocks, type ReplyGuardContext } from '../../core/pack-api.js';
import { trimNote } from './guards.js';
import { latestQuoteCandidate } from './quote-candidate.js';

type Tier = { minQty: number; maxQty?: number; unitPrice: number };
type QuoteLine = {
  query: string;
  partNo?: string;
  qty: number;
  note?: string;
  moq?: number;
  unitPrice?: number;
  amount?: number;
  delivery?: string;
  nextTier?: Tier;
};
type Block = {
  name: string;
  head: string[];
  details: string[];
  /** 与 details 一一对应的归属型号；只有可分行放置的块有。 */
  keys?: string[];
  tail: string[];
  trimmed: number;
  confirmation?: { prefix: string; items: string[]; omitted: boolean };
};
const plain = (value: string): string =>
  stripMarkdown(value)
    .replace(/\{\{|\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const money = (amount: number): string => `${amount.toFixed(2)}元`;
/** 正文只剩块时补的下一步。 */
export const NEXT = {
  quoted: '数量没问题的话，我可以为您起草正式报价单。',
  tiers: '告诉我采购数量，我按档位为您试算。',
  accepted: '顾问会尽快联系您确认付款和发货。',
} as const;
const chars = (text: string): number => [...text.replace(/\s/g, '')].length;

function lastResult<T>(ctx: ReplyGuardContext, name: string): T | null {
  const result = ctx.toolSources.findLast((call) => call.name === name)?.result;
  if (!result) return null;
  try {
    return JSON.parse(result) as T;
  } catch {
    return null;
  }
}

/**
 * 09 R11：正式报价单待审时，每一句带金额的话都要标「试算」（护栏 `quoteBehaviorText` 逐句检查）。
 * 块不经过护栏，所以待审时块内每一行金额自己带上「试算」，不只靠块头。
 */
function pendingQuote(ctx: ReplyGuardContext): boolean {
  const quote = latestQuoteCandidate({ ...ctx.session, packState: {} }, Date.now());
  return quote?.kind === 'quote' && quote.state === 'pending';
}

function quoteBlock(ctx: ReplyGuardContext, pending: boolean): Block | null {
  const result = lastResult<{ lines?: QuoteLine[]; total?: number }>(ctx, 'quote_items');
  if (!result?.lines?.length) return null;
  const priced = result.lines.filter((line) => line.unitPrice !== undefined && line.amount !== undefined);
  const unpriced = result.lines.filter((line) => !priced.includes(line));
  const details = priced.map((line) => {
    const delivery = plain(line.delivery ?? '');
    return (
      `${plain(line.partNo ?? line.query)} × ${line.qty}：${pending ? '试算单价' : '单价'}${money(line.unitPrice!)}，小计${money(line.amount!)}` +
      (delivery ? `；${delivery}，以顾问确认为准` : '') +
      (line.nextTier ? `；满${line.nextTier.minQty}件${money(line.nextTier.unitPrice)}` : '')
    );
  });
  const confirmation = unpriced.length
    ? {
        prefix: priced.length ? `另有 ${unpriced.length} 行需确认：` : '暂时报不了价：',
        items: unpriced.map((line) => {
          const reason = line.note === 'below_moq' ? `起订量${line.moq}件` : line.note === 'over_max' ? '超过单次上限' : '未找到';
          return `${plain(line.partNo ?? line.query)}（${reason}）`;
        }),
        omitted: false,
      }
    : undefined;
  return {
    name: '试算明细',
    head: priced.length ? ['试算：'] : [],
    details,
    tail: priced.length && result.total !== undefined ? [`${pending ? '试算合计' : '合计'}${money(result.total)}`] : [],
    trimmed: 0,
    confirmation,
  };
}

export const industrialReplyBlocks: ReplyBlocks = {
  names: ['试算明细', '档位价', '应付金额'],
  autoAppend: ['试算明细', '应付金额'],
  render(ctx) {
    const blocks: Block[] = [];
    const pending = pendingQuote(ctx);
    const quote = quoteBlock(ctx, pending);
    if (quote) blocks.push(quote);
    // 只读本轮接受目标，不从会话里的旧单或新试算推导应付金额。
    const order = ctx.orderSources.find((order) => order.id === ctx.acceptingOrderId && order.sessionId === ctx.session.id);
    if (order && 'totalFen' in order)
      blocks.push({ name: '应付金额', head: [`您接受的这份报价合计${money(order.totalFen / 100)}`], details: [], tail: [], trimmed: 0 });
    type Found = { match: string; parts?: { partNo: string; moq: number; tiers: Tier[] }[] };
    const exact = new Map<string, NonNullable<Found['parts']>[number]>();
    // 本轮可能精确查到多个型号；按型号保留最近一次事实，不借历史缓存。
    for (const call of ctx.toolSources) {
      if (call.name !== 'find_parts' || !call.result) continue;
      try {
        const found = JSON.parse(call.result) as Found;
        if (found?.match === 'exact') for (const part of found.parts ?? []) exact.set(part.partNo, part);
      } catch {
        /* 失败工具不提供事实。 */
      }
    }
    // 档位始终可渲染，但未请求时不附加、不占试算预算。
    const keys = [...exact.values()].map((part) => plain(part.partNo));
    const details = [...exact.values()].map(
      (part) =>
        `${plain(part.partNo)}${pending ? ' 试算档位' : ''}：` +
        part.tiers
          .map((tier) => `${tier.minQty}${tier.maxQty === undefined ? '件起' : `–${tier.maxQty}件`}${money(tier.unitPrice)}`)
          .join('；') +
        `；起订量${part.moq}件`,
    );
    if (details.length) blocks.push({ name: '档位价', head: ['试算档位价：'], details, keys, tail: [], trimmed: 0 });
    const render = (block: Block): string =>
      [
        ...block.head,
        ...block.details,
        ...(block.confirmation
          ? [block.confirmation.prefix + block.confirmation.items.join('、') + (block.confirmation.omitted ? '等' : '')]
          : []),
        ...(block.trimmed ? [trimNote(block.trimmed)] : []),
        ...block.tail,
      ].join('\n');
    const active = blocks.filter(
      (block) => block.name !== '档位价' || (ctx.replyBlocks?.originalTokens.includes('档位价') ?? ctx.text.includes('{{档位价}}')),
    );
    const budget = replyBlockBudget(ctx);
    const size = () => {
      const text = active.map(render).join('\n');
      return { lines: text.split('\n').filter(Boolean).length, chars: chars(text) };
    };
    // 块头、合计、需确认摘要始终保留；只有可报价明细计入「已算好」。
    // 摘要只删尾部型号并补「等」，总待确认行数不随省略变化。
    for (let measured = size(); measured.lines > budget.lines || measured.chars > budget.chars; measured = size()) {
      const detail = active.findLast((block) => block.details.length > 0);
      const summary = active.findLast((block) => block.confirmation?.items.length)?.confirmation;
      if (measured.lines <= budget.lines && summary && (summary.items.length > 1 || !detail)) {
        summary.items.pop();
        summary.omitted = true;
      } else if (detail) {
        detail.details.pop();
        detail.trimmed++;
      } else break;
    }
    const values: Record<string, string | null> = {};
    for (const block of blocks) {
      values[block.name] = render(block);
      if (!ctx.replyBlocks) continue;
      ctx.replyBlocks.trimmedRows[block.name] = block.trimmed;
      // 模型在每个型号下各写一处占位符时按型号分行放；行内已带型号，不再重复块头。
      if (block.keys)
        ctx.replyBlocks.rows[block.name] = {
          rows: block.details.map((text, i) => ({ key: block.keys![i]!, text })),
          after: block.trimmed ? [trimNote(block.trimmed)] : [],
        };
    }
    return values;
  },
  nextStep(ctx, placed) {
    if (placed.includes('应付金额')) return NEXT.accepted;
    if (placed.includes('试算明细')) {
      const lines = lastResult<{ lines?: QuoteLine[] }>(ctx, 'quote_items')?.lines ?? [];
      const allPriced = lines.length > 0 && lines.every((line) => line.unitPrice !== undefined && line.amount !== undefined);
      // 待审正式单时下一步由顾问审核决定，不另说起草；裁过行时裁剪说明已经问了要不要正式报价单。
      const trimmed = (ctx.replyBlocks?.trimmedRows['试算明细'] ?? 0) > 0;
      return allPriced && !trimmed && !pendingQuote(ctx) ? NEXT.quoted : null;
    }
    return placed.includes('档位价') ? NEXT.tiers : null;
  },
};
