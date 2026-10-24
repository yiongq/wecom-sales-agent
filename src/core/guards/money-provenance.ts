// 08 R8：只接受工具账本、当前会话的通用单与包声明的静态金额；不推导价格。
import type { FollowupGuardContext, GuardStep, ReplyGuardContext, StepVerdict } from '../pack-api.js';
import { isLineOrder, type AnyOrder } from '../order-view.js';
import { parseMoney, type MoneyParseOptions } from '../parse/money.js';
import { sentenceUnits } from '../parse/sentences.js';

export interface MoneyProvenanceOptions {
  /** 单位为分；policy 是本轮的已发布快照。 */
  staticAmounts(policy: unknown): readonly number[];
}

/** 组合入口注入读取能力；步骤本身不 import 存储或配置。 */
export interface MoneyProvenanceSources {
  money(): MoneyParseOptions;
  getOrder(id: string): AnyOrder | undefined;
  followupPolicy(): unknown;
}

function dropUnbacked(
  ctx: FollowupGuardContext,
  options: MoneyProvenanceOptions,
  sources: MoneyProvenanceSources,
  policy: unknown,
): string {
  const money = sources.money();
  const allowed = new Set<number>(options.staticAmounts(policy));
  for (const entry of ctx.session.moneyLedger ?? []) allowed.add(entry.fen);
  for (const id of ctx.session.orderIds) {
    const order = sources.getOrder(id);
    if (!order || order.sessionId !== ctx.session.id || !isLineOrder(order)) continue;
    allowed.add(order.totalFen);
    for (const line of order.lines) {
      allowed.add(line.unitPriceFen);
      allowed.add(line.amountFen);
    }
  }
  const values = [...allowed].filter((fen) => Number.isSafeInteger(fen) && fen >= 0).map((fen) => fen / 100);
  return sentenceUnits(ctx.text)
    .filter(({ start, end }) =>
      parseMoney(ctx.text.slice(start, end), money).every(({ amount }) => values.some((value) => Math.abs(value - amount) <= 0.005)),
    )
    .map(({ start, end }) => ctx.text.slice(start, end))
    .join('');
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
