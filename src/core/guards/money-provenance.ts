// 08 R8：只接受工具账本、当前会话的通用单与包声明的静态金额；不推导价格。
import type { FollowupGuardContext, GuardStep, MoneyEntry, ReplyGuardContext, StepVerdict } from '../pack-api.js';
import { isLineOrder, type AnyOrder } from '../order-view.js';
import { parseMoney, parseMoneyHits, type MoneyParseOptions } from '../parse/money.js';
import { sentenceUnits } from '../parse/sentences.js';

export interface MoneyProvenanceOptions {
  /** 单位为分；policy 是本轮的已发布快照。 */
  staticAmounts(policy: unknown): readonly number[];
  /** 拒绝的话带着没出处的金额时换成这一句，不带金额；缺省时和别的句子一样删掉。 */
  refusal?: string;
  /** 接受报价这一轮删空时的固定句；未提供则沿用 fallback。 */
  acceptedFallback?: string;
  /** 只返回明确提到的对象及原文区间（UTF-16，end 不含）；缺省时只核对数值。也用于识别订单行标题。 */
  subjectMentions?(text: string): readonly { subject: string; start: number; end: number }[];
}

/** 组合入口注入读取能力；步骤本身不 import 存储或配置。 */
export interface MoneyProvenanceSources {
  money(): MoneyParseOptions;
  getOrder(id: string): AnyOrder | undefined;
  followupPolicy(): unknown;
}

const ASIDE = /[（(][^（）()]*[）)]/g;
/** 「能不能」「可不可以」是在问，不算拒绝。 */
const REFUSED = /(?<!能)不能|(?<!可)不可以|无法|没法|没办法|做不到|办不到|给不了|改不了|减不了|降不了|不接受|不支持|不行/;
const HEADING = /[：:]\s*$/;

type CheckedMoney = { at: number; end: number; backed: boolean };

/** 只裁完整分句；沿用原句的出处判定，不让删掉的型号改变后面金额的归属。 */
function trimFragments(unit: string, hits: CheckedMoney[]): { text: string; removed: string[] } | undefined {
  const ending = unit.match(/[。！!？?～~\s]*$/)![0];
  const body = unit.slice(0, unit.length - ending.length);
  const parts: { start: number; end: number }[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ('（(「“‘'.includes(char)) depth++;
    if ('）)」”’'.includes(char)) depth--;
    if (
      depth !== 0 ||
      !'，,、；;'.includes(char) ||
      hits.some((hit) => hit.at <= i && hit.end > i) ||
      (',，'.includes(char) && /[\d０-９]/.test(body[i - 1] ?? '') && /[\d０-９]/.test(body[i + 1] ?? ''))
    )
      continue;
    parts.push({ start, end: i });
    start = i + 1;
  }
  parts.push({ start, end: body.length });
  const bad = parts.map((part) => hits.some((hit) => hit.at < part.end && hit.end > part.start && !hit.backed));
  if (!bad.some(Boolean) || !parts.some((part, i) => !bad[i] && hits.some((hit) => hit.at >= part.start && hit.at < part.end))) return;

  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!bad[i]) continue;
    const first = i;
    while (bad[i + 1]) i++;
    ranges.push({ start: parts[first]!.start - (first ? 1 : 0), end: parts[i]!.end + (!first && i + 1 < parts.length ? 1 : 0) });
  }
  let text = body;
  for (const range of ranges.toReversed()) text = text.slice(0, range.start) + text.slice(range.end);
  // 不修补语义：残缺的标签、连接词或失去后半句的条件仍整句删。
  const remaining = parts.filter((_, i) => !bad[i]);
  const keptParts = remaining.map((part) => body.slice(part.start, part.end).trim());
  const connector = /^(?:但|但是|不过|另外|而且|并且|以及|同时|所以|因此|否则|则|或|和|为|是)$/;
  if (
    keptParts.some((part) => !part || connector.test(part) || /(?:[，,、；;：:]|为|是|从|到|按|以及|但是|而且|并且)$/.test(part)) ||
    (/^(?:如果|假如|假设|若|只要|当|一旦)/.test(keptParts.at(-1)!) &&
      !hits.some((hit) => hit.at >= remaining.at(-1)!.start && hit.at < remaining.at(-1)!.end)) ||
    (bad[0] && /^(?:但|不过|另外|而且|并且|因此|所以|则|也|其余)/.test(text.trim()))
  )
    return;
  return { text: text + ending, removed: ranges.map((range) => body.slice(range.start, range.end)) };
}

function dropUnbacked(
  ctx: FollowupGuardContext & Partial<Pick<ReplyGuardContext, 'acceptingOrderId' | 'turnMoney'>>,
  options: MoneyProvenanceOptions,
  sources: MoneyProvenanceSources,
  policy: unknown,
): { text: string; trace?: { before: string; after: string } } {
  const money = sources.money();
  // 整条回复没有金额时，连订单行的型号识别也不需要做。
  if (options.subjectMentions && !parseMoneyHits(ctx.text, money).length) return { text: ctx.text };
  const allowed: Pick<MoneyEntry, 'fen' | 'subject'>[] = options.staticAmounts(policy).map((fen) => ({ fen }));
  allowed.push(...(ctx.acceptingOrderId ? (ctx.turnMoney?.() ?? []) : (ctx.session.moneyLedger ?? [])));
  for (const id of ctx.session.orderIds) {
    const order = sources.getOrder(id);
    if (!order || order.sessionId !== ctx.session.id || !isLineOrder(order)) continue;
    if (ctx.acceptingOrderId && order.id !== ctx.acceptingOrderId) continue;
    if (order.status === 'superseded' || order.supersededBy) continue;
    if (order.approval && order.approval.state !== 'approved') continue;
    const lines = order.lines.map((line) => {
      const subjects = new Set(options.subjectMentions?.(line.title).map((mention) => mention.subject));
      const subject = subjects.size === 1 ? [...subjects][0] : undefined;
      return { line, subject };
    });
    allowed.push({ fen: order.totalFen, subject: lines.length === 1 ? lines[0]!.subject : undefined });
    for (const { line, subject } of lines) {
      allowed.push({ fen: line.unitPriceFen, subject }, { fen: line.amountFen, subject });
    }
  }
  const values = allowed.filter(({ fen }) => Number.isSafeInteger(fen) && fen >= 0);
  const checkMoney = (text: string) => {
    const hits = parseMoneyHits(text, money);
    if (!hits.length) return [];
    const groups: { start: number; end: number; subjects: Set<string> }[] = [];
    for (const mention of (options.subjectMentions?.(text) ?? []).toSorted((a, b) => a.start - b.start)) {
      const previous = groups.at(-1);
      if (previous && !hits.some(({ at }) => at >= previous.end && at < mention.start)) {
        previous.end = mention.end;
        previous.subjects.add(mention.subject);
      } else groups.push({ start: mention.start, end: mention.end, subjects: new Set([mention.subject]) });
    }
    return hits.map(({ amount, at, end }): CheckedMoney => {
      const records = values.filter(({ fen }) => Math.abs(fen / 100 - amount) <= 0.005);
      const left = groups.filter(({ end }) => end <= at);
      const clauseStart = Math.max(...['，', ',', '；', ';', '、'].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
      const group = left.findLast(({ start }) => start >= clauseStart) ?? left.at(-1);
      const backed =
        records.length > 0 &&
        (!group || group.subjects.size > 1 || records.some(({ subject }) => subject === undefined || group.subjects.has(subject)));
      return { at, end, backed };
    });
  };
  const backed = (text: string) => checkMoney(text).every((hit) => hit.backed);
  const units = sentenceUnits(ctx.text).map(({ start, end }) => ctx.text.slice(start, end));
  const fragments = new Map<number, string[]>();
  let refused = false;
  const kept = units.map((unit, i): string | null => {
    const hits = checkMoney(unit);
    if (hits.every((hit) => hit.backed)) return unit;
    // 括号里的旁注编了数：括号外的金额全有出处时只删旁注，别让一句税前价把报价拖走。
    const trimmed = unit.replace(ASIDE, (aside) => (backed(aside) ? aside : ''));
    if (trimmed !== unit && backed(trimmed) && parseMoney(trimmed, money).length) return trimmed;
    const partial = trimFragments(unit, hits);
    // 再按最终文字复核，防止拼接改变金额解析或型号绑定。
    if (partial && backed(partial.text)) {
      fragments.set(i, partial.removed);
      return partial.text;
    }
    if (!options.refusal || refused || !REFUSED.test(unit)) return null;
    refused = true;
    return options.refusal + (unit.endsWith('\n') ? '\n' : '');
  });
  // 标题下面的内容删掉了，标题也不留。
  kept.forEach((unit, i) => {
    if (unit === null || !HEADING.test(unit)) return;
    const next = units.findIndex((text, j) => j > i && text.trim());
    if (next >= 0 && kept[next] === null) kept[i] = null;
  });
  const text = kept.filter((unit) => unit !== null).join('');
  return {
    text: text === ctx.text ? text : text.trimStart(),
    ...(fragments.size
      ? {
          trace: {
            // recordGuard 按句求差；已保留的片段不伪记为删除后新增，独立换行让检测器逐片段读取。
            before: units.map((unit, i) => fragments.get(i)?.join('\n') ?? unit).join('\n'),
            after: kept.map((unit, i) => (fragments.has(i) ? '' : (unit ?? ''))).join('\n'),
          },
        }
      : {}),
  };
}

export function moneyProvenanceStep(
  options: MoneyProvenanceOptions & { fallback: string },
  sources: () => MoneyProvenanceSources | Promise<MoneyProvenanceSources>,
): GuardStep<ReplyGuardContext> {
  return {
    id: 'money_provenance',
    after: ['stage_advance'],
    writes: ['guardHit', 'blocksSuppressed'],
    async run(ctx): Promise<StepVerdict> {
      const { text: kept, trace } = dropUnbacked(ctx, options, await sources(), ctx.policy);
      if (kept === ctx.text) return { action: 'pass' };
      const text = kept.trim() ? kept : (ctx.acceptingOrderId && options.acceptedFallback) || options.fallback;
      const action = kept.trim() ? 'drop_sentence' : 'replace';
      if (!kept.trim()) ctx.turn.flags.blocksSuppressed = true;
      ctx.turn.flags.guardHit = 'price';
      ctx.recordGuard('money_provenance', trace?.before ?? ctx.text, trace?.after ?? text, action);
      return { action, text };
    },
  };
}

export function moneyProvenanceFollowupStep(
  options: MoneyProvenanceOptions,
  sources: () => MoneyProvenanceSources | Promise<MoneyProvenanceSources>,
): GuardStep<FollowupGuardContext> {
  return {
    id: 'money_provenance',
    async run(ctx): Promise<StepVerdict> {
      const reads = await sources();
      const { text: kept, trace } = dropUnbacked(ctx, options, reads, reads.followupPolicy());
      if (kept === ctx.text) return { action: 'pass' };
      const text = kept.trim() ? kept : '';
      ctx.recordGuard('money_provenance', trace?.before ?? ctx.text, trace?.after ?? text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
