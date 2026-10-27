import { z } from 'zod';
import { withItemRules, UNSTORABLE_TEXT, yuanToFen, type CatalogKindSpec } from '../../core/pack-api.js';
import { partEntity } from './console-pack.js';
import { normalizePartNo } from './normalize.js';

const text = z
  .string()
  .min(1)
  .refine((value) => !/[\0\p{Cs}]/u.test(value), UNSTORABLE_TEXT);
const price = z
  .number()
  .positive()
  .multipleOf(0.01)
  .max(Number.MAX_SAFE_INTEGER / 100);
const integer = z.number().int().nonnegative();
export const PartSchema = withItemRules(
  z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    partNo: text,
    name: text,
    brand: text,
    category: z.enum(['轴承', '紧固件', '气动元件', '低压电器']),
    specs: z.array(text),
    unit: z.enum(['件', '个', '套', '米', '千克', '盒']),
    unitPrice: price,
    moq: integer.min(1),
    tier2Qty: integer.min(1).optional(),
    tier2Price: price.optional(),
    tier3Qty: integer.min(1).optional(),
    tier3Price: price.optional(),
    tier4Qty: integer.min(1).optional(),
    tier4Price: price.optional(),
    stock: integer,
    leadDays: integer,
    aliases: z.array(text).optional(),
    substitutes: z.array(text).optional(),
    certs: z.array(text).optional(),
  }),
  partEntity,
);
export type Part = z.infer<typeof PartSchema>;
export const partCatalog: CatalogKindSpec = {
  schema: PartSchema,
  titleKey: 'partNo',
  lockedWhenActive: ['id', 'partNo', 'category', 'unit'],
  repriceFields: partEntity.fields.filter((f) => f.reprices).map((f) => f.key),
  moneyFields: ['unitPrice', 'tier2Price', 'tier3Price', 'tier4Price'].map((path) => ({ path, decimals: 2 as const })),
  retrieval: true,
  crossItemCheck(item, snapshot) {
    const part = PartSchema.parse(item);
    const others = (snapshot.items.part ?? []).map((value) => PartSchema.parse(value)).filter((value) => value.id !== part.id);
    const taken = new Set(others.flatMap((value) => [value.partNo, ...(value.aliases ?? [])].map(normalizePartNo)));
    const issues: { path: string; message: string }[] = [];
    if (taken.has(normalizePartNo(part.partNo))) issues.push({ path: 'partNo', message: '归一后的型号与已上架条目冲突' });
    if (part.aliases?.some((alias) => taken.has(normalizePartNo(alias))))
      issues.push({ path: 'aliases', message: '归一后的别名与已上架条目冲突' });
    const active = new Set([...others, part].map((value) => normalizePartNo(value.partNo)));
    if (part.substitutes?.some((value) => !active.has(normalizePartNo(value))))
      issues.push({ path: 'substitutes', message: '替代型号必须指向已上架条目' });
    return issues;
  },
};
export function tiersOf(part: Part): { minQty: number; unitPrice: number }[] {
  return [
    { minQty: part.moq, unitPrice: part.unitPrice },
    ...([2, 3, 4] as const).flatMap((n) =>
      part[`tier${n}Qty`] === undefined ? [] : [{ minQty: part[`tier${n}Qty`]!, unitPrice: part[`tier${n}Price`]! }],
    ),
  ];
}
export const MAX_QTY = 1_000_000;
export function priceLine(item: Readonly<Record<string, unknown>>, qty: number) {
  const part = PartSchema.parse(item);
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error('无效询价数量');
  if (qty < part.moq) return { reject: 'below_moq', detail: { moq: part.moq } };
  const tier = tiersOf(part)
    .filter((value) => value.minQty <= qty)
    .at(-1)!;
  const delivery =
    part.stock >= qty ? '现货' : part.stock > 0 ? `现货 ${part.stock} 件，其余约 ${part.leadDays} 天` : `约 ${part.leadDays} 天`;
  return { unitPriceFen: yuanToFen(tier.unitPrice), unit: part.unit, attrs: { 交期: delivery, 起订量: String(part.moq) } };
}
