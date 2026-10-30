// R8 / R9：只读会话与已发布配置；跟进版本只删，不调用业务工具。
import {
  partsOf,
  sentenceUnits,
  type FollowupGuardContext,
  type GuardStep,
  type PackSources,
  type ReplyGuardContext,
} from '../../core/pack-api.js';
import { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } from './quote-candidate.js';
import { mentionedParts, unresolvedParts, FIXED } from './turn.js';
import { draftParts, readState } from './state.js';
import { MAX_QTY, priceLine } from './catalog.js';
import { normalizePartNo } from './normalize.js';
import { live } from './live.js';
import { IndustrialPolicySchema, taxInvoiceText } from './policy.js';

export const INVENTORY_FALLBACK = '库存和交期以顾问确认为准';
export const SUBSTITUTE_FALLBACK = '能否替代请顾问确认';
export const TRIM_FALLBACK = '询价明细较多，需要的话我出一份正式报价单。';
export const trimNote = (n: number): string => `另外 ${n} 行已算好，需要的话我出一份正式报价单`;
const nonAssertion = /[?？]|如果|假如|若是|的话|是否|有没有|能不能|可以吗|以.{0,8}确认为准|不能|不可|不保证|不承诺|不是|没有|无现货/;
const inventoryClaim = /现货|有货|库存(?:充足|有?\s*\d+)|今天.{0,3}发|明天.{0,3}发|\d+\s*天|保证交期|交期\s*(?:约|预计)?\s*\d+\s*天/;
const substituteClaim = /可以替代|可替代|通用|一样的|能互换/;
const internalRule =
  /代码与工具决定|本轮已发布政策|询价太长时只列前\d+行|(?:find_parts|quote_items|create_quote_sheet)\s*[（(]|【硬性要求】/;
const pricePromise = /全网最低|保证不涨价|还能再便宜/;
// 数字单位、材料 / 防护等级、螺纹是规格，不是待校验的型号。
const specToken =
  /^(?:\d+(?:\.\d+)?(?:MM|CM|M|MPA|KPA|PA|V|KV|W|KW|A|MA|HZ|KG|G|NM)|DC\d+(?:\.\d+)?V|AC\d+(?:\.\d+)?V|IP\d{2,3}|Q\d{3}|A[24]-\d+|[GR]\d+\/\d+)$/i;
const tokens = (text: string): string[] => text.match(/[A-Za-z0-9]+(?:[-_/×.*][A-Za-z0-9]+)*/g) ?? [];
const hasModel = (text: string, model: string): boolean => normalizePartNo(text).includes(normalizePartNo(model));

type Evidence = { partNo: string; stock?: string; leadDays?: number; substitutes?: string[]; delivery?: string };
function evidence(ctx: FollowupGuardContext, sources: PackSources): Evidence[] {
  // 摘要的版本不随缓存淘汰；只有 exact 试算行才可借历史版本恢复库存 / 交期依据。
  const state = readState(ctx.session);
  const parts = draftParts(ctx.session, sources);
  const entries: Evidence[] = parts.flatMap((part) => {
    const line = state.rfqDraft?.lines.find((line) => line.match === 'exact' && line.code === part.id);
    if (!line || !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) return [];
    let current = part;
    if (sources.erp?.active('part')) {
      const value = sources.erp.fresh('part', part.id);
      if (!value) return [{ partNo: part.partNo, substitutes: part.substitutes }];
      current = live(part, value);
    }
    const priced = priceLine(current, line.qty);
    if ('reject' in priced) return [];
    return [{ partNo: part.partNo, delivery: priced.attrs?.['交期'], substitutes: part.substitutes }];
  });
  for (const call of ctx.toolSources) {
    if (!call.result || !['find_parts', 'quote_items'].includes(call.name)) continue;
    try {
      const result = JSON.parse(call.result);
      for (const item of result.parts ?? result.lines ?? []) {
        if (typeof item.partNo === 'string') entries.push(item);
      }
    } catch {
      // 失败工具不是事实来源。
    }
  }
  // 本轮工具的同型号结果覆盖较早的摘要证据，不混用两次库存。
  const latest = new Map<string, Evidence>();
  for (const entry of entries) {
    const key = normalizePartNo(entry.partNo);
    latest.set(key, { substitutes: latest.get(key)?.substitutes, ...entry });
  }
  return [...latest.values()];
}

// 09 R1：工具账本证明金额出处，试算标识证明身份；待审正式金额不能借账本放行。
const moneyText = /(?:[¥￥]\s*\d|\d+(?:\.\d+)?\s*元)/;
function quoteBehaviorText(ctx: FollowupGuardContext, sources: PackSources, followup: boolean): string {
  const quote = latestQuoteCandidate({ ...ctx.session, packState: {} }, Date.now());
  let text = ctx.text;
  if (quote?.kind === 'quote' && quote.state === 'pending') {
    const unsafe = (unit: string) => moneyText.test(unit) && (!/试算/.test(unit) || /正式报价单[^。！？\n]*\d+(?:\.\d+)?\s*元/.test(unit));
    const units = sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
    if (units.some(unsafe)) text = followup ? units.filter((unit) => !unsafe(unit)).join('') : FIXED.pending;
  }
  if (quote?.kind === 'quote' && quote.state === 'expired') {
    if (followup) {
      text = sentenceUnits(text)
        .map(({ start, end }) => text.slice(start, end))
        .filter((unit) => !/(?:报价单|新报价).*(?:已|审核)|(?:已|正在).*(?:起草|提交|审核)|确认下单|付款和发货/.test(unit))
        .join('');
    } else if (expiredQuoteAwaitingConfirmation(ctx.session, Date.now())) {
      const call = ctx.toolSources.findLast((call) => call.name === 'quote_items' && call.result);
      if (call?.result) {
        const result = JSON.parse(call.result) as { total?: number; unmatched?: number };
        if (result.unmatched === 0 && result.total !== undefined)
          text = `原报价单已过期，已按当前价重新试算，合计${result.total}元。请确认本次试算，确认后再起草新的报价单。`;
      }
    }
  }
  const draft = readState(ctx.session).rfqDraft;
  const below = draftParts(ctx.session, sources).filter((part) =>
    draft?.lines.some((line) => line.match === 'exact' && line.code === part.id && line.qty < part.moq),
  );
  if (below.length) {
    const units = sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
    text = units
      .filter(
        (unit) => !(moneyText.test(unit) && (below.some((part) => hasModel(unit, part.partNo)) || below.length === draft?.lines.length)),
      )
      .join('');
  }
  const input = 'inputText' in ctx ? String(ctx.inputText) : (ctx.session.messages.findLast((m) => m.role === 'customer')?.content ?? '');
  const ambiguous = unresolvedParts(input, sources);
  // 非字面（语义）候选也由工具结果决定，不把候选缓存当成已选型号。
  const candidates = ambiguous.flatMap((m) => m.parts.map((part) => part.partNo));
  for (const call of ctx.toolSources) {
    if (call.name !== 'find_parts' || !call.result) continue;
    const result = JSON.parse(call.result) as { match?: string; parts?: { partNo: string }[] };
    if (
      result.match === 'ambiguous' &&
      !mentionedParts(input, sources).some((m) => m.match === 'exact' && result.parts?.some((part) => part.partNo === m.parts[0]?.partNo))
    )
      candidates.push(...(result.parts ?? []).map((part) => part.partNo));
  }
  const models = [...new Set(candidates)];
  if (models.length) {
    if (followup)
      text = sentenceUnits(text)
        .map(({ start, end }) => text.slice(start, end))
        .filter((unit) => !/已.*(?:选|确定)|(?:就|先|按).*报价|为您.*选/.test(unit) && !moneyText.test(unit))
        .join('');
    else if (
      !models.every((model) => hasModel(text, model)) ||
      !/哪种|哪个|哪一款|选择|确认.{0,6}型号|型号.{0,6}确认/.test(text) ||
      /已为您选|替您选/.test(text)
    )
      text = `查到多个候选，请选择需要的型号：\n${models.map((model) => `· ${model}`).join('\n')}`;
  }
  return text;
}

function guardedText(ctx: FollowupGuardContext, sources: PackSources, followup: boolean, rawPolicy: unknown): string {
  ctx = { ...ctx, text: quoteBehaviorText(ctx, sources, followup) };
  const policy = IndustrialPolicySchema.parse(rawPolicy);
  const cache = readState(ctx.session).partsInPlay ?? [];
  const known = new Set(cache.map((part) => normalizePartNo(part.partNo)));
  const specs = cache.flatMap((part) => part.specs).map(normalizePartNo);
  const input =
    'inputText' in ctx
      ? String(ctx.inputText)
      : ctx.session.messages
          .filter((m) => m.role === 'customer')
          .map((m) => m.content)
          .join('\n');
  const intakeQueries = readState(ctx.session).rfqIntake?.lines.map((line) => normalizePartNo(line.q)) ?? [];
  const inputNormalized = normalizePartNo(input);
  const facts = evidence(ctx, sources);
  const models = [...new Set([...cache.map((part) => part.partNo), ...facts.map((fact) => fact.partNo)])];
  const mentionedModels = (text: string): string[] => {
    const normalized = normalizePartNo(text);
    const named = models.filter((model) => {
      const key = normalizePartNo(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![A-Z0-9])${key}(?![A-Z0-9])`).test(normalized);
    });
    // 客户提过但缓存没有的型号，也不能借其他型号的事实背书。
    return [
      ...new Set(
        [
          ...named,
          ...tokens(text).filter((token) => token.length >= 4 && /[A-Za-z]/.test(token) && /\d/.test(token) && !specToken.test(token)),
        ].map(normalizePartNo),
      ),
    ];
  };
  // 型号标题常独占一行；延续最近显式主语，新型号（包括未知型号）必须覆盖它。
  let subject: string[] = [];
  return sentenceUnits(ctx.text)
    .map(({ start, end }) => {
      const unit = ctx.text.slice(start, end);
      // 按完整句删内部指令，避免逗号分句后留下“不得自行计算”等指令残片。
      if (internalRule.test(unit)) {
        subject = [];
        return '';
      }
      const replacements = new Set<string>();
      return (unit.replace(/[（(](?:内部)?编号\s*[a-z0-9-]+[）)]/gi, '').match(/[^，,；;]+[，,；;]?/g) ?? [])
        .flatMap((unit) => unit.split(/(?=但是|但(?!是)|不过|然而)/))
        .map((sentence) => {
          const explicit = mentionedModels(sentence);
          if (explicit.length) subject = explicit;
          if (pricePromise.test(sentence)) return '';
          const withoutLinks = partsOf(sentence)
            .reduce((text, link) => text.replaceAll(link.url, ''), sentence)
            .replace(/https?:\/\/[^\s，。！？]+/gi, '');
          const unknown = tokens(withoutLinks).some((token) => {
            const normalized = normalizePartNo(token);
            return (
              token.length >= 4 &&
              /[A-Za-z]/.test(token) &&
              /\d/.test(token) &&
              !specToken.test(token) &&
              !known.has(normalized) &&
              !inputNormalized.includes(normalized) &&
              !intakeQueries.some((q) => q.includes(normalized)) &&
              !specs.some((spec) => spec.includes(normalized)) &&
              !/^https?:/i.test(sentence.trim())
            );
          });
          if (unknown) return '';
          let text = sentence;
          const assertions = !nonAssertion.test(sentence);
          const inventory = sentence.replace(/报价(?:单)?有效期(?:为|是|[:：])?\s*\d+\s*天/g, '');
          if (assertions && inventoryClaim.test(inventory)) {
            const supported =
              subject.length > 0 &&
              subject.every((model) => {
                const fact = facts.find((entry) => normalizePartNo(entry.partNo) === model);
                if (!fact) return false;
                if (/库存(?:有?\s*\d+)|保证交期|今天.{0,3}发|明天.{0,3}发|\d+\s*天到/.test(inventory)) return false;
                const delivery = fact.delivery ?? '';
                const stock = fact.stock ?? (delivery === '现货' ? '现货' : delivery.startsWith('现货') ? '部分现货' : '无现货');
                if (/有货|库存充足|全(?:部|都)?现货/.test(inventory) && stock !== '现货') return false;
                if (/现货/.test(inventory)) {
                  const amount = /现货\s*(\d+)/.exec(inventory)?.[1];
                  if (amount && amount !== /现货\s*(\d+)/.exec(delivery)?.[1]) return false;
                  if (/部分现货|其余|剩余|余量/.test(inventory)) {
                    if (stock !== '部分现货') return false;
                  } else if (!amount && stock !== '现货') return false;
                }
                const days = [...inventory.matchAll(/(?:交期\s*)?(\d+)\s*天(?:发)?/g)].map((match) => Number(match[1]));
                return days.every(
                  (day) => day === fact.leadDays || new RegExp(`(?<![0-9])${day}天`).test((fact.delivery ?? '').replace(/\s/g, '')),
                );
              });
            if (!supported) text = followup ? '' : INVENTORY_FALLBACK + '。';
          }
          if (text && assertions && substituteClaim.test(sentence)) {
            const relation = substituteClaim.exec(sentence)!;
            const left = mentionedModels(sentence.slice(0, relation.index));
            const right = mentionedModels(sentence.slice(relation.index + relation[0].length));
            const pairs =
              left.length && right.length
                ? left.flatMap((from) => right.map((to) => [from, to]))
                : subject.flatMap((from, i) => subject.slice(i + 1).map((to) => [from, to]));
            const supported =
              pairs.length > 0 &&
              pairs.every(([from, to]) =>
                facts.find((fact) => normalizePartNo(fact.partNo) === from)?.substitutes?.some((other) => normalizePartNo(other) === to),
              );
            if (!supported) text = followup ? '' : SUBSTITUTE_FALLBACK + '。';
          }
          if (text && !/[?？]|如果|假如|的话|是否|能不能/.test(sentence) && /含税|不含税|税率|专票|专用发票/.test(sentence)) {
            const tax = /不含税/.test(sentence) ? false : /含税/.test(sentence) ? true : null;
            const offersInvoice = !/不能开|不开|不支持|无法开|不能提供/.test(sentence);
            const invoiceOk = !/专票|专用发票/.test(sentence) || offersInvoice === policy.invoice.some((kind) => /专用|专票/.test(kind));
            const rate = /税率\s*(\d+(?:\.\d+)?)%/.exec(sentence);
            if ((tax !== null && tax !== policy.taxIncluded) || !invoiceOk || (rate && Number(rate[1]) !== policy.taxRate))
              text = followup ? '' : taxInvoiceText(policy);
          }
          if (text !== sentence && text) {
            if (replacements.has(text)) return '';
            replacements.add(text);
          }
          return text;
        })
        .join('');
    })
    .join('')
    .trim();
}

/** 保留原始行 id，重建补句时统计最终完全删空的询价行；保护链接超限必须终止。 */
export function trimRfq(text: string, models: readonly string[], followup = false): string {
  const original = text.replace(/\r\n?/g, '\n').split('\n');
  const inquiry = original.map((line) => models.some((model) => hasModel(line, model)));
  const lines = original.map((line) => line);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (inquiry[i] && ++seen > 10) lines[i] = '';
  const render = (): string => {
    const kept = lines
      .filter((line) => line.trim())
      .join('\n')
      .trim();
    const n = inquiry.filter((yes, i) => yes && !lines[i]?.trim()).length;
    return !followup && n ? [kept, trimNote(n)].filter(Boolean).join('\n') : kept;
  };
  const fits = (value: string): boolean => value.split('\n').length <= 12 && [...value.replace(/\s/gu, '')].length <= 600;
  while (!fits(render())) {
    let removed = false;
    for (let i = lines.length - 1; i >= 0 && !removed; i--) {
      const line = lines[i]!;
      for (const { start, end } of sentenceUnits(line).toReversed()) {
        const unit = line.slice(start, end);
        if (!unit.trim() || /https?:\/\//i.test(unit) || partsOf(unit).length) continue;
        lines[i] = line.slice(0, start) + line.slice(end);
        removed = true;
        break;
      }
    }
    if (!removed) return followup ? '' : TRIM_FALLBACK;
  }
  return render();
}
export function industrialReplyGuard(sources: PackSources): GuardStep<ReplyGuardContext> {
  return {
    id: 'industrial_claims',
    after: ['stage_advance'],
    run(ctx) {
      const text = guardedText(ctx, sources, false, ctx.policy ?? sources.currentPolicy().policy);
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('industrial_claims', ctx.text, text, 'replace');
      return { action: 'replace', text };
    },
  };
}
export function industrialFollowupGuard(sources: PackSources): GuardStep<FollowupGuardContext> {
  return {
    id: 'industrial_claims',
    after: ['link_whitelist'],
    run(ctx) {
      const text = guardedText(ctx, sources, true, sources.currentPolicy().policy);
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('industrial_claims', ctx.text, text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
export function rfqTrimStep(sources: PackSources): GuardStep<ReplyGuardContext> {
  return {
    id: 'rfq_trim',
    after: ['money_provenance'],
    run(ctx) {
      const text =
        trimRfq(
          ctx.text,
          draftParts(ctx.session, sources).map((part) => part.partNo),
        ) || '请告诉我型号和数量。';
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('rfq_trim', ctx.text, text, 'replace');
      return { action: 'replace', text };
    },
  };
}
export function rfqTrimFollowupStep(sources: PackSources): GuardStep<FollowupGuardContext> {
  return {
    id: 'rfq_trim',
    after: ['money_provenance'],
    run(ctx) {
      const text = trimRfq(
        ctx.text,
        draftParts(ctx.session, sources).map((part) => part.partNo),
        true,
      );
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('rfq_trim', ctx.text, text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
