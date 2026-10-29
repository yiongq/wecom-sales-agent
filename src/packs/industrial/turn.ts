import type { DeterministicReply, TurnContext, PackSources, PrefetchResult, TurnToolContext } from '../../core/pack-api.js';
import { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } from './quote-candidate.js';
import { PartSchema } from './catalog.js';
import { matchInMemory } from './match.js';

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
    if (candidate.state === 'expired')
      return [
        '报价单已过期，需要重新调 quote_items 试算；沿用下列型号和数量，不确认旧单、不发旧链接',
        `过期报价行：${JSON.stringify(candidate.order.lines.map((line) => ({ query: line.title, code: line.code, qty: line.qty })))}`,
      ];
    return [candidate.state === 'pending' ? '最新的报价单还在顾问审核' : '最新的是已批准且有效的报价单'];
  }
  return candidate ? ['最新的是本次试算，需要重新确认本次试算，不能确认上一份报价单'] : [];
}

/** 只识别客户原话中的字面型号；不从模型挑出的候选反推客户选择。 */
export function mentionedParts(text: string, sources: PackSources) {
  const parts = (sources.currentCatalog().items.part ?? []).map((part) => PartSchema.parse(part));
  const tokens = [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9_×*\-/]*/g)];
  const mentions = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let query = token[0];
    let end = token.index! + query.length;
    let found = matchInMemory(query, parts);
    // 6205 2rs 等带空格的完整型号优先，不能先把 6205 当成未决系列。
    for (let j = Math.min(i + 2, tokens.length - 1); j > i; j--) {
      const last = tokens[j]!;
      const candidate = text.slice(token.index, last.index! + last[0].length);
      if (!/^[A-Za-z0-9_×*\-/ \t]+$/.test(candidate)) continue;
      const exact = matchInMemory(candidate, parts);
      if (exact.match !== 'exact') continue;
      query = candidate;
      end = last.index! + last[0].length;
      found = exact;
      i = j;
      break;
    }
    if (found.match === 'none') continue;
    // 型号与数量之间可夹品名（「6205-2RS轴承100个」）；隔了逗号只认「数量 / 要 / 共」（「6205-2RS，数量19件」），免得把别处的数量算到它头上；
    // 不带单位时数量须在行尾或标点前（「6205-2RS 100」）；夹着否定词不算
    const qtyText =
      /^(?:\s*(\p{Script=Han}{0,6})|\s*[，,]\s*((?:数量|一共|总共|共|要)?[为是]?))\s*[:：]?\s*(?:[×*xX]\s*)?(?:([0-9]+|两|二|一)\s*(?:件|个|套|米|千克|盒|pcs)|([0-9]+)(?=\s*(?:$|[，,。；;、\n])))/iu.exec(
        text.slice(end),
      );
    const raw = qtyText && !/[不别没无]/.test(qtyText[1] ?? qtyText[2] ?? '') ? (qtyText[3] ?? qtyText[4]) : undefined;
    const qty = raw ? ({ 一: 1, 二: 2, 两: 2 }[raw] ?? Number(raw)) : undefined;
    mentions.push({ query, ...found, qty });
  }
  return mentions;
}
export function unresolvedParts(text: string, sources: PackSources) {
  const mentions = mentionedParts(text, sources);
  return mentions.filter(
    (mention) =>
      mention.match === 'ambiguous' &&
      !mentions.some((other) => other.match === 'exact' && mention.parts.some((part) => part.id === other.parts[0]?.id)),
  );
}
/** quote_items 整份替换 rfqDraft：只在没有进行中的询价，或这句把进行中的各行都重说了一遍时，才替模型试算。 */
function restatesDraft(session: TurnContext['session'], ids: ReadonlySet<string>): boolean {
  const candidate = latestQuoteCandidate(session, Date.now());
  if (!candidate) return true;
  const lines = candidate.kind === 'draft' ? candidate.draft.lines : candidate.order.lines;
  return lines.every((line) => 'code' in line && ids.has(line.code));
}
/** 同一条目只查一次，至多 5 个。 */
function lookups(mentions: ReturnType<typeof mentionedParts>): string[] {
  const seen = new Set<string>();
  return mentions
    .filter((m) => !seen.has(m.parts[0]!.id) && seen.add(m.parts[0]!.id))
    .slice(0, 5)
    .map((m) => m.query);
}
export async function prefetch(ctx: TurnContext, sources: PackSources): Promise<PrefetchResult | null> {
  const candidate = latestQuoteCandidate(ctx.session, Date.now());
  if (candidate?.kind === 'quote' && candidate.state === 'expired' && /确认|重新|续算/.test(ctx.text)) {
    const parts = (sources.currentCatalog().items.part ?? []).map((part) => PartSchema.parse(part));
    const items = candidate.order.lines.map((line) => ({
      query: parts.find((part) => part.id === line.code)?.partNo ?? line.title,
      qty: line.qty,
    }));
    return { calls: [await ctx.callTool('quote_items', { items })], timings: [] };
  }
  const calls: PrefetchResult['calls'] = [];
  const mentions = mentionedParts(ctx.text, sources);
  // 发现 4：型号精确时引擎先替模型查或试算，模型一次往返就能答（原先查、算、答三次串行往返，整轮十余秒）。
  // 有未决候选时照下面的旧路，由模型列候选让客户选。
  if (!unresolvedParts(ctx.text, sources).length) {
    const exact = mentions.filter((m) => m.match === 'exact');
    const priced = exact.filter((m) => m.qty !== undefined && m.qty > 0);
    const ids = new Set(priced.map((m) => m.parts[0]!.id));
    if (priced.length && ids.size === priced.length && restatesDraft(ctx.session, ids)) {
      calls.push(await ctx.callTool('quote_items', { items: priced.map(({ query, qty }) => ({ query, qty })) }));
      for (const query of lookups(exact.filter((m) => !ids.has(m.parts[0]!.id)))) calls.push(await ctx.callTool('find_parts', { query }));
      return { calls, timings: [] };
    }
    if (!priced.length && exact.length) {
      for (const query of lookups(exact)) calls.push(await ctx.callTool('find_parts', { query }));
      return { calls, timings: [] };
    }
  }
  const below = mentions.filter((m) => m.match === 'exact' && m.qty !== undefined && m.qty > 0 && m.qty < m.parts[0]!.moq);
  if (below.length) calls.push(await ctx.callTool('quote_items', { items: below.map(({ query, qty }) => ({ query, qty })) }));
  for (const { query } of unresolvedParts(ctx.text, sources)) calls.push(await ctx.callTool('find_parts', { query }));
  return calls.length ? { calls, timings: [] } : null;
}
export function beforeTool(name: string, args: unknown, ctx: TurnToolContext, sources: PackSources) {
  const latestOrder = latestQuoteCandidate({ ...ctx.session, packState: {} }, Date.now());
  const confirming =
    /确认(?:本次|这次)?(?:试算|报价)|确认下单|就按这个|可以下单|(?:出|起草|生成)(?:一份|新的|新)?正式报价单/.test(ctx.text ?? '') &&
    !/[?？]|吗|暂不|先别|不确认|不要|不出/.test(ctx.text ?? '');
  if (
    name === 'create_quote_sheet' &&
    latestOrder?.kind === 'quote' &&
    latestOrder.state === 'expired' &&
    (expiredQuoteAwaitingConfirmation(ctx.session, Date.now()) || !confirming)
  )
    return { reject: '报价单已过期，请先调用 quote_items 按当前价重新试算，向客户说明试算价格，等客户下一轮确认后再起草新报价单。' };
  const ambiguous = unresolvedParts(ctx.text ?? '', sources);
  if (
    ambiguous.length &&
    (name === 'create_quote_sheet' ||
      (name === 'quote_items' &&
        (args as { items?: { query?: string }[] })?.items?.some((item) => !ambiguous.some((m) => m.query === item.query))))
  )
    return { reject: '型号有多个候选，请列出候选并让客户选择，不能替客户选定型号。' };
  return { args };
}
