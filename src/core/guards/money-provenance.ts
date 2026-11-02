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

function dropUnbacked(
  ctx: FollowupGuardContext,
  options: MoneyProvenanceOptions,
  sources: MoneyProvenanceSources,
  policy: unknown,
): string {
  const money = sources.money();
  // 整条回复没有金额时，连订单行的型号识别也不需要做。
  if (options.subjectMentions && !parseMoneyHits(ctx.text, money).length) return ctx.text;
  const allowed: Pick<MoneyEntry, 'fen' | 'subject'>[] = options.staticAmounts(policy).map((fen) => ({ fen }));
  allowed.push(...(ctx.session.moneyLedger ?? []));
  for (const id of ctx.session.orderIds) {
    const order = sources.getOrder(id);
    if (!order || order.sessionId !== ctx.session.id || !isLineOrder(order)) continue;
    if (order.approval && order.approval.state !== 'approved') continue;
    allowed.push({ fen: order.totalFen });
    for (const line of order.lines) {
      const subjects = new Set(options.subjectMentions?.(line.title).map((mention) => mention.subject));
      const subject = subjects.size === 1 ? [...subjects][0] : undefined;
      allowed.push({ fen: line.unitPriceFen, subject }, { fen: line.amountFen, subject });
    }
  }
  const values = allowed.filter(({ fen }) => Number.isSafeInteger(fen) && fen >= 0);
  const backed = (text: string) => {
    if (!options.subjectMentions)
      return parseMoney(text, money).every(({ amount }) => values.some(({ fen }) => Math.abs(fen / 100 - amount) <= 0.005));
    const hits = parseMoneyHits(text, money);
    if (!hits.length) return true;
    const groups: { start: number; end: number; subjects: Set<string> }[] = [];
    for (const mention of options.subjectMentions(text).toSorted((a, b) => a.start - b.start)) {
      const previous = groups.at(-1);
      if (previous && !hits.some(({ at }) => at >= previous.end && at < mention.start)) {
        previous.end = mention.end;
        previous.subjects.add(mention.subject);
      } else groups.push({ start: mention.start, end: mention.end, subjects: new Set([mention.subject]) });
    }
    return hits.every(({ amount, at }) => {
      const records = values.filter(({ fen }) => Math.abs(fen / 100 - amount) <= 0.005);
      if (!records.length) return false;
      const left = groups.filter(({ end }) => end <= at);
      const clauseStart = Math.max(...['，', ',', '；', ';', '、'].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
      const group = left.findLast(({ start }) => start >= clauseStart) ?? left.at(-1);
      return !group || group.subjects.size > 1 || records.some(({ subject }) => subject === undefined || group.subjects.has(subject));
    });
  };
  const units = sentenceUnits(ctx.text).map(({ start, end }) => ctx.text.slice(start, end));
  let refused = false;
  const kept = units.map((unit): string | null => {
    if (backed(unit)) return unit;
    // 括号里的旁注编了数：括号外的金额全有出处时只删旁注，别让一句税前价把报价拖走。
    const trimmed = unit.replace(ASIDE, (aside) => (backed(aside) ? aside : ''));
    if (trimmed !== unit && backed(trimmed) && parseMoney(trimmed, money).length) return trimmed;
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
  return text === ctx.text ? text : text.trimStart();
}

export function moneyProvenanceStep(
  options: MoneyProvenanceOptions & { fallback: string },
  sources: () => MoneyProvenanceSources | Promise<MoneyProvenanceSources>,
): GuardStep<ReplyGuardContext> {
  return {
    id: 'money_provenance',
    after: ['stage_advance'],
    writes: ['guardHit'],
    async run(ctx): Promise<StepVerdict> {
      const kept = dropUnbacked(ctx, options, await sources(), ctx.policy);
      if (kept === ctx.text) return { action: 'pass' };
      const text = kept.trim() ? kept : options.fallback;
      const action = kept.trim() ? 'drop_sentence' : 'replace';
      ctx.turn.flags.guardHit = 'price';
      ctx.recordGuard('money_provenance', ctx.text, text, action);
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
      const kept = dropUnbacked(ctx, options, reads, reads.followupPolicy());
      if (kept === ctx.text) return { action: 'pass' };
      const text = kept.trim() ? kept : '';
      ctx.recordGuard('money_provenance', ctx.text, text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
