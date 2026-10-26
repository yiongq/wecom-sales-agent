// R6 / R13 所需的政策数据；SOP、政策文案契约与后台配置在 E 批补齐。
import { z } from 'zod';
import { deepFreeze, type PackPolicy } from '../../core/pack-api.js';
const fen = z.number().int().nonnegative();
const text = z.string().min(1);
export const IndustrialPolicySchema = z.strictObject({
  quoteValidDays: z.number().int().nonnegative(),
  autoApproveMaxFen: fen,
  taxIncluded: z.boolean(),
  taxRate: z.number().min(0).max(100),
  shipping: z.strictObject({ freeOverFen: fen, feeFen: fen }),
  paymentTerms: text,
  invoice: z.array(text),
});
export type IndustrialPolicy = z.infer<typeof IndustrialPolicySchema>;
export const defaultIndustrialPolicy: IndustrialPolicy = deepFreeze({
  quoteValidDays: 7,
  autoApproveMaxFen: 0,
  taxIncluded: true,
  taxRate: 13,
  shipping: { freeOverFen: 0, feeFen: 0 },
  paymentTerms: '款到发货，对公转账',
  invoice: ['增值税普通发票', '增值税专用发票'],
});
export const industrialPolicy: PackPolicy = {
  schema: IndustrialPolicySchema,
  defaults: defaultIndustrialPolicy,
  editable: Object.keys(defaultIndustrialPolicy),
  canonical: (policy) => JSON.stringify(IndustrialPolicySchema.parse(policy)),
  upgrade(old) {
    if (old === undefined) return IndustrialPolicySchema.parse(defaultIndustrialPolicy);
    // 与既有政策升级口径一致：只补缺省字段，未知键与错误类型交严格 schema 拒绝。
    if (!old || typeof old !== 'object' || Array.isArray(old)) return IndustrialPolicySchema.parse(old);
    const value = { ...defaultIndustrialPolicy, ...old };
    if (value.shipping && typeof value.shipping === 'object' && !Array.isArray(value.shipping))
      value.shipping = { ...defaultIndustrialPolicy.shipping, ...value.shipping };
    return IndustrialPolicySchema.parse(value);
  },
  clauses: () => [],
  refund: () => null,
  segments: {},
};
export function quoteNotes(raw: unknown): string[] {
  const policy = IndustrialPolicySchema.parse(raw);
  const yuan = (value: number) => `${(value / 100).toFixed(2)}元`;
  return [
    `报价${policy.taxIncluded ? '含税' : '不含税'}，税率${policy.taxRate}%`,
    policy.shipping.freeOverFen > 0
      ? `满${yuan(policy.shipping.freeOverFen)}免运费，未满运费${yuan(policy.shipping.feeFen)}`
      : `运费${yuan(policy.shipping.feeFen)}`,
    '库存与交期以顾问确认为准',
  ];
}
