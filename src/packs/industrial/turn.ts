import type { DeterministicReply, TurnContext, PackSources, PrefetchResult, TurnToolContext } from '../../core/pack-api.js';
import { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } from './quote-candidate.js';
import { PartSchema } from './catalog.js';
import { matchInMemory } from './match.js';
import { FIXED, inquiryLines } from './inquiry.js';
import { confirmsIntake, intakeNewer, intakeParts, intakePreModel, intakeQuoteLines, sameQuoteItems } from './intake-turn.js';
import { pendingIntake, readState, type RfqIntake } from './state.js';

export { FIXED, inquiryLines };

/** 判定先后（12 R9）：超限提示 → 待确认清单的改行 → 10 原有判定 → 确认下单。 */
export function preModel(ctx: TurnContext, sources: Pick<PackSources, 'currentCatalog'>): DeterministicReply | null {
  const edited = intakePreModel(ctx, sources);
  if (edited) return edited;
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
  // 12 R9：报价单早于待确认的识别清单时，客户说的「确认下单」指向清单，不能当成接受这份旧报价。
  if (candidate.at < (pendingIntake(ctx.session)?.at ?? 0)) return null;
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
  // 12 R9：待确认的清单比报价候选新时，只带清单摘要（由 runtime 追加），不再带报价候选的说明。
  if (intakeNewer(ctx.session, Date.now())) return [];
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
/** 10 第 21 步的文字询价预取。清单待确认时不替模型续算过期报价单：那样的 quote_items 不是客户本句写的，会被工具闸拒绝。 */
async function textPrefetch(ctx: TurnContext, sources: PackSources, resumeExpired: boolean): Promise<PrefetchResult | null> {
  const candidate = latestQuoteCandidate(ctx.session, Date.now());
  if (resumeExpired && candidate?.kind === 'quote' && candidate.state === 'expired' && /确认|重新|续算/.test(ctx.text)) {
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
/** 12 R10：确认那一轮——已匹配的行按 q 一次试算，其余行通知顾问；清单同一次保存标 confirmed，之后不再触发。 */
async function confirmPrefetch(ctx: TurnContext, sources: PackSources): Promise<PrefetchResult> {
  const intake = pendingIntake(ctx.session)!;
  const parts = intakeParts(sources);
  const { items, unmatched } = intakeQuoteLines(intake, parts);
  // 目录变更造成确认时不再精确的行，也要保留待核状态；以后重新上架不能自动解除数量闸。
  const lines = intake.lines.map((line, i) =>
    line.m === 'exact' && unmatched.includes(i + 1)
      ? { ...line, m: line.qty === null ? ('bad_qty' as const) : matchInMemory(line.q, parts).match }
      : line,
  );
  const effects: NonNullable<PrefetchResult['effects']> = {
    statePatch: { rfqIntake: { ...intake, status: 'confirmed', lines } },
    ...(unmatched.length ? { notify: { reason: 'intake_unmatched', intakeId: intake.id, lines: unmatched } } : {}),
  };
  return { calls: items.length ? [await ctx.callTool('quote_items', { items })] : [], timings: [], effects };
}
export async function prefetch(ctx: TurnContext, sources: PackSources): Promise<PrefetchResult | null> {
  const intake = readState(ctx.session).rfqIntake;
  if (!intake || intake.status === 'superseded') return textPrefetch(ctx, sources, true);
  if (confirmsIntake(ctx.session, ctx.text)) return confirmPrefetch(ctx, sources);
  const result = await textPrefetch(ctx, sources, intake.status === 'confirmed');
  // 12 R9：客户这一轮自己打了带精确型号和数量的新询价，按文字询价走；当前清单随这一轮的回复标 superseded。
  if (!mentionedParts(ctx.text, sources).some((m) => m.match === 'exact' && m.qty !== undefined && m.qty > 0)) return result;
  return {
    calls: result?.calls ?? [],
    timings: result?.timings ?? [],
    effects: { ...result?.effects, statePatch: { ...result?.effects?.statePatch, rfqIntake: { ...intake, status: 'superseded' } } },
  };
}
const CONFIRMED_REJECT = '客户刚确认了识别清单：本轮只按清单里已匹配的行试算，不起草正式报价单，也不另查其他型号。';
const PENDING_REJECT = '识别清单还没确认：请客户回复确认或指出要改的行';
const UNMATCHED_REJECT = '这一行顾问还在核对：请客户直接写出型号和数量';
/** 12 R10：待确认清单与确认后待核行的工具闸；返回拒绝说明，放行返回 undefined。 */
function intakeGate(name: string, args: unknown, ctx: TurnToolContext, intake: RfqIntake, sources: PackSources) {
  const parts = intakeParts(sources);
  const text = ctx.text ?? '';
  if (intake.status === 'confirmed') {
    if (name !== 'quote_items') return undefined;
    const items = (args as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return UNMATCHED_REJECT;
    const { items: quoted, unmatched } = intakeQuoteLines(intake, parts);
    const quotedIds = new Set(quoted.map((item) => matchInMemory(item.query, parts).parts[0]!.id));
    const heldIds = new Set(
      unmatched.flatMap((n) => {
        const line = intake.lines[n - 1]!;
        const found = matchInMemory(line.q, parts);
        return (found.match === 'exact' ? found.parts : line.m === 'ambiguous' ? found.parts.slice(0, 3) : [])
          .filter((part) => !quotedIds.has(part.id))
          .map((part) => part.id);
      }),
    );
    const written = mentionedParts(text, sources).filter((m) => m.match === 'exact' && m.qty !== undefined);
    for (const item of items) {
      if (typeof item?.query !== 'string') continue; // 非法参数交工具 schema。
      const found = matchInMemory(item.query, parts);
      if (
        found.match === 'exact' &&
        heldIds.has(found.parts[0]!.id) &&
        !written.some((m) => m.parts[0]!.id === found.parts[0]!.id && m.qty === item.qty)
      )
        return UNMATCHED_REJECT;
    }
    return undefined;
  }
  // 确认那一轮：只放行入参恰好等于确认的那几行的 quote_items。
  if (confirmsIntake(ctx.session, text))
    return name === 'quote_items' && sameQuoteItems(args, intakeQuoteLines(intake, parts).items) ? undefined : CONFIRMED_REJECT;
  if (name === 'create_quote_sheet') return PENDING_REJECT;
  if (name !== 'quote_items') return undefined;
  // 其他轮次：只放行客户本句写出的精确型号和数量；清单里还没确认的行，哪怕型号被提到，数量也不能沿用。
  const items = (args as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return PENDING_REJECT;
  const written = mentionedParts(text, sources).filter((m) => m.match === 'exact' && m.qty !== undefined);
  const allowed = items.every((item: { query?: unknown; qty?: unknown } | null) => {
    if (typeof item?.query !== 'string' || typeof item.qty !== 'number') return false;
    const found = matchInMemory(item.query, parts);
    return found.match === 'exact' && written.some((m) => m.parts[0]!.id === found.parts[0]!.id && m.qty === item.qty);
  });
  return allowed ? undefined : PENDING_REJECT;
}
export function beforeTool(name: string, args: unknown, ctx: TurnToolContext, sources: PackSources) {
  const intake = readState(ctx.session).rfqIntake;
  const gated = intake && intake.status !== 'superseded' ? intakeGate(name, args, ctx, intake, sources) : undefined;
  if (gated) return { reject: gated };
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
