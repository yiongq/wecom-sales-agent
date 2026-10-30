import { z } from 'zod';
import { live, refreshParts } from './live.js';
import { beforeTool } from './turn.js';
import {
  cleanText,
  createLineOrder,
  orderDisplay,
  yuanToFen,
  type PackSources,
  type ToolSpec,
  type TurnToolContext,
} from '../../core/pack-api.js';
import { MAX_QTY, priceLine, tiersOf, type Part } from './catalog.js';
import { normalizePartNo } from './normalize.js';
import { createMatcher } from './match.js';
import { writeState, type RfqDraft } from './state.js';

export function projectRejections(rejected: { code: string; reason: string; detail?: Record<string, unknown> }[]) {
  return rejected.map(({ code, reason, detail }) => {
    if (['empty_lines', 'kind_unknown', 'item_inactive', 'invalid_qty'].includes(reason)) return { code, reason };
    if (reason === 'below_moq' && Number.isSafeInteger(detail?.moq) && Number(detail?.moq) > 0)
      return { code, reason, moq: Number(detail!.moq) };
    throw new Error('未识别的建单拒绝结果');
  });
}
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function' as const,
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const moneyEntries = (values: readonly { value: number; label: string }[]) =>
  values.map(({ value, label }) => ({ fen: yuanToFen(value), label }));

export function createIndustrialTools(sources: PackSources): ToolSpec<TurnToolContext>[] {
  const match = createMatcher(sources);
  return [
    {
      def: def(
        'find_parts',
        '收到型号即可查询，无需数量。query 是客户型号或名称，不是内部 code；仅多个候选时让客户选择',
        { query: { type: 'string' }, category: { type: 'string' } },
        ['query'],
      ),
      sideEffects: ['session'],
      cacheable: false,
      blocksRetry: false,
      async execute(input, { session, cancel }) {
        const args = z.object({ query: z.string().min(1), category: z.string().optional() }).parse(input);
        const found = await match(args.query, args.category);
        if (sources.erp?.active('part') && found.match === 'exact') {
          await refreshParts(sources, found.parts, session);
          found.parts = found.parts.map((part) => live(part, sources.erp.fresh('part', normalizePartNo(part.partNo))));
        }
        cancel?.throwIfAborted();
        // 工具展示的替代型号也进入同一有界缓存，只接受当前已上架的目标。
        const alternatives = new Set(found.parts.flatMap((part) => part.substitutes ?? []).map(normalizePartNo));
        const shownAlternatives = (sources.currentCatalog().items.part ?? []) as Part[];
        writeState(session, {}, [
          ...shownAlternatives
            .filter((part) => alternatives.has(normalizePartNo(part.partNo)))
            .map((part) => ({ partNo: part.partNo, specs: [] })),
          ...found.parts,
        ]);
        sources.saveSession(session);
        return JSON.stringify({
          match: found.match,
          parts: found.parts.map((part) => ({
            code: part.id,
            partNo: part.partNo,
            name: part.name,
            unit: part.unit,
            specs: part.specs,
            moq: part.moq,
            tiers: tiersOf(part),
            stock: part.stock >= part.moq ? '现货' : part.stock > 0 ? '部分现货' : '无现货',
            leadDays: part.leadDays,
            substitutes: part.substitutes ?? [],
          })),
        });
      },
      amounts(result) {
        const value = JSON.parse(result) as { parts?: { tiers: { unitPrice: number }[] }[] };
        return moneyEntries(
          (value.parts ?? []).flatMap((part) => part.tiers.map((tier) => ({ value: tier.unitPrice, label: '档位单价' }))),
        );
      },
    },
    {
      def: def(
        'quote_items',
        '型号与数量齐全必须试算，一次最多30行。query 是客户型号或名称，不是内部 code；可直接匹配，单价与合计由代码计算',
        {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { query: { type: 'string' }, qty: { type: 'integer' } },
              required: ['query', 'qty'],
              additionalProperties: false,
            },
          },
        },
        ['items'],
      ),
      sideEffects: ['session'],
      cacheable: false,
      blocksRetry: false,
      async execute(input, { session, cancel }) {
        const args = z.object({ items: z.array(z.object({ query: z.string().min(1), qty: z.number().int().positive() })) }).parse(input);
        if (args.items.length > 30) return JSON.stringify({ error: 'too_many_lines', limit: 30 });
        const at = Date.now();
        const draft: RfqDraft = { at, lines: [] };
        const shown = [];
        const lines = [];
        let totalFen = 0;
        let unmatched = 0;
        let matches;
        if (sources.erp?.active('part')) {
          matches = [];
          for (const { query } of args.items) matches.push(await match(query));
          await refreshParts(
            sources,
            matches.flatMap((found) => (found.match === 'exact' ? found.parts : [])),
            session,
          );
        }
        for (const [index, { query, qty }] of args.items.entries()) {
          const found = matches ? matches[index]! : await match(query);
          shown.push(...found.parts);
          if (found.match !== 'exact') {
            draft.lines.push({ match: found.match, qty });
            unmatched++;
            lines.push({
              query,
              qty,
              match: found.match,
              note: found.match,
              ...(found.parts.length ? { candidates: found.parts.map((part) => part.partNo) } : {}),
            });
            continue;
          }
          const part = found.parts[0]!;
          const version =
            sources.currentCatalog().versions[sources.catalogVersionKey('part', part.id)] ??
            (sources.configMode() === 'file' ? 1 : undefined);
          if (!version) throw new Error('询价条目缺少版本');
          draft.lines.push({ code: part.id, version, qty, match: 'exact' });
          const base = { query, qty, match: 'exact' as const, code: part.id, partNo: part.partNo };
          if (qty > MAX_QTY) {
            unmatched++;
            lines.push({ ...base, note: 'over_max' });
            continue;
          }
          const current = sources.erp?.active('part') ? live(part, sources.erp.fresh('part', normalizePartNo(part.partNo))) : part;
          const price = priceLine(current, qty);
          if ('reject' in price) {
            unmatched++;
            lines.push({ ...base, note: 'below_moq', moq: part.moq });
            continue;
          }
          const fen = price.unitPriceFen! * qty;
          totalFen += fen;
          if (!Number.isSafeInteger(fen) || !Number.isSafeInteger(totalFen)) throw new Error('询价金额超出范围');
          lines.push({ ...base, unitPrice: price.unitPriceFen! / 100, amount: fen / 100, delivery: price.attrs!['交期'] });
        }
        cancel?.throwIfAborted();
        writeState(session, { rfqDraft: draft }, shown);
        sources.saveSession(session);
        return JSON.stringify({ lines, ...(unmatched === 0 ? { total: totalFen / 100 } : {}), unmatched });
      },
      amounts(result) {
        const value = JSON.parse(result) as { lines?: { unitPrice?: number; amount?: number }[]; total?: number };
        return moneyEntries([
          ...(value.lines ?? []).flatMap((line) => [
            ...(line.unitPrice === undefined ? [] : [{ value: line.unitPrice, label: '试算单价' }]),
            ...(line.amount === undefined ? [] : [{ value: line.amount, label: '试算行金额' }]),
          ]),
          ...(value.total === undefined ? [] : [{ value: value.total, label: '试算合计' }]),
        ]);
      },
    },
    {
      def: def(
        'create_quote_sheet',
        '客户要求正式报价时才起草，新建缺省人审。code 必须取查询或试算返回的编号，不是型号；数量沿用客户确认值',
        {
          items: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              properties: { code: { type: 'string' }, qty: { type: 'integer' } },
              required: ['code', 'qty'],
              additionalProperties: false,
            },
          },
        },
        ['items'],
      ),
      sideEffects: ['session', 'order', 'notify'],
      cacheable: false,
      blocksRetry: true,
      async execute(input, ctx) {
        const { session, cancel } = ctx;
        const allowed = beforeTool('create_quote_sheet', input, ctx, sources);
        if ('reject' in allowed) return JSON.stringify({ error: allowed.reject });
        const args = z.object({ items: z.array(z.object({ code: z.string(), qty: z.number() })).max(30) }).parse(input);
        cancel?.throwIfAborted();
        if (sources.erp?.active('part')) {
          const ids = new Set(args.items.map((item) => item.code));
          const parts = (sources.currentCatalog().items.part ?? []) as Part[];
          await refreshParts(
            sources,
            parts.filter((part) => ids.has(part.id)),
            session,
          );
          cancel?.throwIfAborted();
        }
        const result = await createLineOrder(
          session,
          args.items.map(({ code, qty }) => ({ kind: 'part', code, qty })),
          { approval: true },
        );
        if ('rejected' in result) return JSON.stringify({ rejected: projectRejections(result.rejected) });
        writeState(session, { lastQuoteId: result.order.id });
        sources.saveSession(session);
        if (result.order.approval?.state === 'pending') return JSON.stringify({ state: 'pending' });
        if (result.order.approval?.state !== 'approved') throw new Error('报价状态异常');
        return JSON.stringify({
          state: 'approved',
          quoteUrl: `/quote/${result.order.id}`,
          totalText: orderDisplay(result.order).totalText,
        });
      },
    },
    {
      def: def('handoff_to_human', '客户需要人工时转交顾问', { reason: { type: 'string' } }, ['reason']),
      sideEffects: ['session', 'handoff', 'notify'],
      cacheable: false,
      blocksRetry: true,
      async execute(input, { session, cancel }) {
        const args = z.object({ reason: z.string() }).parse(input);
        cancel?.throwIfAborted();
        const reason = cleanText(args.reason, 120) || sources.modelHandoffReason;
        sources.enterHandoff(session, { kind: 'model', at: Date.now(), reason });
        session.messages.push({ role: 'system', content: `AI 已转人工：${reason}`, at: Date.now() });
        sources.saveSession(session);
        return JSON.stringify({ ok: true, reason, note: '已转交顾问，请等候联系' });
      },
    },
  ];
}
