// R6 / R12 / R13：已发布政策、说明片段和发布前一致性检查。
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
  clauses: (raw) => {
    const policy = IndustrialPolicySchema.parse(raw);
    return quoteNotes(policy).map((text, i) => ({ id: `industrial.fees.${i}`, topic: 'fees' as const, title: '询价政策', text }));
  },
  refund: () => null,
  segments: {
    'note:tax': (raw) => {
      const p = IndustrialPolicySchema.parse(raw);
      return `报价${p.taxIncluded ? '含税' : '不含税'}，税率${p.taxRate}%`;
    },
    'note:shipping': (raw) => quoteNotes(raw)[1]!,
    'note:payment': (raw) => IndustrialPolicySchema.parse(raw).paymentTerms,
    'note:invoice': (raw) => IndustrialPolicySchema.parse(raw).invoice.join('、'),
    'note:approval': (raw) => {
      const p = IndustrialPolicySchema.parse(raw);
      return p.autoApproveMaxFen > 0
        ? `新建报价在${(p.autoApproveMaxFen / 100).toFixed(2)}元内、全现货且精确匹配才自动批准；复用不重审`
        : '新建缺省人审；复用不重审';
    },
  },
  lint(raw, sections = []) {
    const parsed = IndustrialPolicySchema.safeParse(raw);
    if (!parsed.success) return [{ code: 'policy_invalid', sectionKey: null, detail: '工业询价政策字段无效' }];
    const p = parsed.data;
    return sections.flatMap(({ key, text }) => {
      const bad = text.split(/[。！!？?\n]+/).filter((sentence) => {
        const days = /有效期(?:为)?\s*(\d+)\s*天/.exec(sentence);
        const taxRate = /税率\s*(\d+(?:\.\d+)?)%/.exec(sentence);
        const tax = /不含税/.test(sentence) ? false : /含税/.test(sentence) ? true : null;
        return (
          (days && Number(days[1]) !== p.quoteValidDays) ||
          (taxRate && Number(taxRate[1]) !== p.taxRate) ||
          (tax !== null && tax !== p.taxIncluded && !/是否|按政策|以政策/.test(sentence)) ||
          /无需审核|一律自动批准|待审直接发链接/.test(sentence)
        );
      });
      return bad.map((match) => ({
        code: 'policy_mismatch' as const,
        sectionKey: key,
        detail: '文案与当前询价政策或审批边界不一致',
        match,
      }));
    });
  },
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

export function taxInvoiceText(raw: unknown): string {
  const policy = IndustrialPolicySchema.parse(raw);
  return `报价${policy.taxIncluded ? '含税' : '不含税'}，税率${policy.taxRate}%，${policy.invoice.length ? `可开${policy.invoice.join('、')}` : '开票种类请顾问确认'}。`;
}
