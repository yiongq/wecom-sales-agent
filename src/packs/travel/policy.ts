// 07 R2：政策数字与文字的单一来源；不读取租户配置，不依赖 thresholds。
import { z } from 'zod';
import { deepFreeze, type PackPolicy, type PolicyClause } from '../../core/pack-api.js';
import { FEES_REPLY, INSURANCE_REPLY, VISA_REPLY } from './claim-words.js';

export const travelPolicySchema = z
  .object({
    version: z.literal(1),
    pricing: z
      .object({
        peakMultiplier: z.number().min(1),
        groupMinimum: z.number().int().positive(),
        groupDiscount: z.number().positive().max(1),
      })
      .strict(),
    booking: z.object({ maxDepartMonths: z.number().int().positive() }).strict(),
    refund: z
      .object({
        selfService: z.boolean(),
        approvalThresholdYuan: z.number().int().nonnegative(),
        tiers: z
          .array(
            z
              .object({
                id: z.string().min(1),
                minDays: z.number().int().nonnegative(),
                maxDays: z.number().int().nonnegative().nullable(),
                percent: z.number().int().min(0).max(100),
              })
              .strict()
              .refine((t) => t.maxDays === null || t.maxDays >= t.minDays, 'maxDays 小于 minDays'),
          )
          .min(1),
      })
      .strict(),
    change: z.string().min(1),
  })
  .strict();

export type TravelPolicy = z.infer<typeof travelPolicySchema>;

export const defaultTravelPolicy: TravelPolicy = deepFreeze({
  version: 1,
  pricing: { peakMultiplier: 1.1, groupMinimum: 4, groupDiscount: 0.95 },
  booking: { maxDepartMonths: 12 },
  refund: {
    selfService: true,
    approvalThresholdYuan: 30000,
    tiers: [
      { id: 'd30', minDays: 30, maxDays: null, percent: 100 },
      { id: 'd15', minDays: 15, maxDays: 29, percent: 80 },
      { id: 'd7', minDays: 7, maxDays: 14, percent: 50 },
    ],
  },
  change: '出发前15天及以上可以改期一次，由顾问为您办理',
});

/** schema 的字段顺序固定；输入对象的插入顺序不参与哈希。 */
export function canonical(p: TravelPolicy): string {
  return JSON.stringify(travelPolicySchema.parse(p));
}

/** 只补缺字段：null、错误类型和未知字段留给严格 schema 拒绝，数组不按下标补档位。 */
export function upgrade(old: unknown): TravelPolicy {
  function fill(value: unknown, fallback: unknown): unknown {
    if (value === undefined) return structuredClone(fallback);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      fallback &&
      typeof fallback === 'object' &&
      !Array.isArray(fallback)
    ) {
      const result = { ...value } as Record<string, unknown>;
      for (const [key, defaultValue] of Object.entries(fallback)) result[key] = fill(result[key], defaultValue);
      return result;
    }
    return value;
  }
  return travelPolicySchema.parse(fill(old, defaultTravelPolicy));
}

/** 对客出处按距出发天数从远到近编号：档位 id 是稳定的内部键，租户增删档位时出处随之重排。 */
export function clauses(p: TravelPolicy): PolicyClause[] {
  const tiers = p.refund.tiers.toSorted((a, b) => b.minDays - a.minDays);
  const refund: PolicyClause[] = tiers.map((tier, i) => ({
    id: tier.id,
    topic: 'refund',
    title: `退改条款第${i + 1}条`,
    text: `出发前${tier.maxDays === null ? `${tier.minDays}天及以上` : `${tier.minDays}–${tier.maxDays}天`}取消，${tier.percent === 100 ? '退全款' : `退订单金额的${tier.percent}%`}`,
  }));
  const minimum = Math.min(...tiers.map((tier) => tier.minDays));
  if (minimum > 0)
    refund.push({
      id: 'below-min',
      topic: 'refund',
      title: `退改条款第${tiers.length + 1}条`,
      text: `出发前0–${minimum - 1}天取消，不能自助退，由顾问为您处理`,
    });
  return [
    ...refund,
    { id: 'change', topic: 'change', title: '改期条款', text: p.change },
    { id: 'visa', topic: 'visa', title: '签证说明', text: VISA_REPLY },
    { id: 'insurance', topic: 'insurance', title: '保险说明', text: INSURANCE_REPLY },
    { id: 'fees', topic: 'fees', title: '费用说明', text: FEES_REPLY },
  ];
}

export function peakPercent(p: TravelPolicy): number {
  return Math.round((p.pricing.peakMultiplier - 1) * 100);
}

function groupDiscount(p: TravelPolicy): string {
  // 沿用现有中文口径：0.95 → 95 折，0.9 → 9 折。
  return String(Math.round(p.pricing.groupDiscount * 100)).replace(/0$/, '');
}

/** note:peak 保留 {month} 占位符，由调用处填入出发月份。 */
export const segments = {
  'sop:price-rules': (p: TravelPolicy) =>
    `1. 出发月份落在线路的最佳季（bestSeason）内，每人价上浮 ${peakPercent(p)}%；不在最佳季就是标准价，不上浮。\n` +
    `2. ${p.pricing.groupMinimum} 人及以上，每人价打 ${groupDiscount(p)} 折。\n` +
    `（「${segments['note:peak'](p).replace('{month}', '10')}」「4月不在最佳季，不上浮」）`,
  'sop:far-future': (p: TravelPolicy) =>
    `出发日期超过 ${p.booking.maxDepartMonths} 个月的只能给参考：create_quote 返回 farFuture 时没有确定价，按结果里的 priceFrom 说「参考价」，讲明到时价格可能有变，不下单（不调 create_order），具体由顾问到时确认。`,
  'note:peak': (p: TravelPolicy) => `{month}月为最佳出行季，价格上浮 ${peakPercent(p)}%`,
  'note:group': (p: TravelPolicy) => `${p.pricing.groupMinimum} 人及以上享 ${groupDiscount(p)} 折`,
  // 预订月数的对客说法（07 R22 的 policy_claims 换上去的话）。sop:far-future 是给模型的指令，不能发给客户；不带上浮，只随 booking 变
  'note:far-future': (p: TravelPolicy) => `目前只受理 ${p.booking.maxDepartMonths} 个月以内出发的订单，更远的日期只能给参考价`,
  'help:price': (p: TravelPolicy) =>
    `填淡季、${p.pricing.groupMinimum}人以下的价；旺季上浮${peakPercent(p)}%、${p.pricing.groupMinimum}人及以上${groupDiscount(p)}折由系统算`,
  'help:season': (p: TravelPolicy) => `这些月份出发报价上浮${peakPercent(p)}%，「全年」不加价`,
};

export const travelPolicy = {
  schema: travelPolicySchema,
  defaults: defaultTravelPolicy,
  editable: ['refund', 'change'],
  canonical,
  upgrade,
  clauses,
  refund: (p: TravelPolicy) => p.refund,
  // 核心以 unknown 持有各行业 policy；在这个边界校验后交给有类型的生成器。
  segments: Object.fromEntries(Object.entries(segments).map(([id, render]) => [id, (p: unknown) => render(travelPolicySchema.parse(p))])),
} satisfies PackPolicy<TravelPolicy>;

/** 只定位 SOP 的生成片段；检查失败时点名，写回也不触碰其余内容。 */
export function sopPolicyMirror(source: string, policy: TravelPolicy, write = false): string {
  const price = segments['sop:price-rules'](policy).split('\n');
  const parts = [
    { id: 'sop:price-rules (规则1)', re: /^1\. 出发月份落在线路的最佳季（bestSeason）内，[^\n]*$/gm, text: price[0] },
    { id: 'sop:price-rules (规则2)', re: /^2\. \d+ 人及以上，每人价打 [^\n]*$/gm, text: price[1] },
    { id: 'sop:price-rules (note示例)', re: /（「\d+月为最佳出行季，[^」]*」「4月不在最佳季，不上浮」）/g, text: price[2] },
    { id: 'sop:far-future', re: /^出发日期超过 [^\n]*$/gm, text: segments['sop:far-future'](policy) },
  ];
  let result = source;
  for (const part of parts) {
    const hits = [...result.matchAll(part.re)];
    if (hits.length !== 1) throw new Error(`${part.id}: 应恰好命中一次，实际 ${hits.length}`);
    if (!write && hits[0][0] !== part.text) throw new Error(`${part.id}: 与默认 policy 渲染不一致`);
    result = result.replace(part.re, () => part.text);
  }
  return result;
}
