import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const count = z.number().int().nonnegative();
const regex = z.string().refine((s) => {
  try {
    void new RegExp(s, 'u').source;
    return true;
  } catch {
    return false;
  }
}, '不是合法正则');
export const predicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order'), count, fields: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ kind: z.literal('no_order_before'), turnMatches: regex }).strict(),
  z.object({ kind: z.literal('handoff'), expected: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('tool_called'), name: z.string().min(1), min: count.optional(), max: count.optional() })
    .strict()
    .refine((p) => p.max === undefined || p.max >= (p.min ?? 1), 'max 小于 min'),
  z.object({ kind: z.literal('reply_matches'), pattern: regex, scope: z.enum(['any', 'all', 'last']) }).strict(),
  z
    .object({
      kind: z.literal('reply_excludes'),
      pattern: regex,
      scope: z.enum(['any', 'all', 'last']),
      // 命中处所在的分句里带否定词（没有 / 不 / 无……）就不算命中
      negationAware: z.boolean().optional(),
      // 只看某个工具第一次被调用的那一轮及之后的回复；工具一次都没调用则无从违反，通过（要求必须调用的用 tool_called 另守）
      after: z
        .object({ tool: z.string().min(1) })
        .strict()
        .optional(),
    })
    .strict(),
  // 推荐 / 报价类（本轮有线路、报价、方案书、订单类工具结果，含预取）≤richMax 行、其余 ≤plainMax 行的回复占比不低于 minShare
  z
    .object({
      kind: z.literal('shape'),
      richMax: z.number().int().positive(),
      plainMax: z.number().int().positive(),
      minShare: z.number().min(0).max(1),
    })
    .strict(),
  // 同一类句子（pattern 命中的句子）不在两条回复里出现；客户那一轮的话命中 unlessCustomer（客户再问）则不计
  z.object({ kind: z.literal('no_repeat'), pattern: regex, unlessCustomer: regex.optional() }).strict(),
]);
const initialSchema = z
  .object({
    stage: z.enum(['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing', 'paid', 'handoff']).optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
    orders: z
      .array(
        z
          .object({
            routeId: z.string().min(1),
            travelers: z.number().int().positive(),
            departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '需要 YYYY-MM-DD'),
            status: z.enum(['pending_payment', 'paid', 'cancelled', 'refund_pending', 'refunded']),
          })
          .strict(),
      )
      .optional(),
    history: z.array(z.object({ role: z.enum(['customer', 'ai']), content: z.string().min(1) }).strict()).optional(),
  })
  .strict();
export const goalSchema = z
  .object({
    id: z.string().min(1),
    persona: z.string().min(1),
    brand: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    allowedTools: z.array(z.string().min(1)),
    predicates: z.array(predicateSchema).min(1),
    forbidden: z.array(z.string().min(1)),
    severity: z.enum(['safety', 'quality']).optional(), // 缺省 quality
    tags: z.array(z.string().min(1)).optional(),
    covers: z.array(z.string().min(1)).optional(), // 问题表里的 ID
    initial: initialSchema.optional(), // 初始会话与订单（真 paid 走订单状态）
    customerScript: z.array(z.string().min(1)).optional(), // 前几轮客户原话固定，之后交给客户模型
  })
  .strict();
export type SimGoal = z.infer<typeof goalSchema>;
export type Predicate = z.infer<typeof predicateSchema>;

export function validateGoal(value: unknown, file: string): SimGoal {
  const result = goalSchema.safeParse(value);
  if (result.success) return result.data;
  const id = value && typeof value === 'object' && 'id' in value ? String(value.id) : '<无 id>';
  throw new Error(`${file} (${id}): ${result.error.issues.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`);
}

export async function loadGoals(input: string): Promise<SimGoal[]> {
  const stat = await fs.stat(input);
  const files = stat.isDirectory()
    ? (await fs.readdir(input))
        .filter((f) => f.endsWith('.json'))
        .toSorted()
        .map((f) => path.join(input, f))
    : [input];
  const goals: SimGoal[] = [];
  for (const file of files) {
    let data: unknown;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new Error(`${file} (<无 id>): <root>: JSON 读取失败`);
    }
    for (const [i, value] of (Array.isArray(data) ? data : [data]).entries()) goals.push(validateGoal(value, `${file}[${i}]`));
  }
  if (!goals.length) throw new Error(`${input}: 没有目标`);
  const ids = new Set<string>();
  for (const g of goals) {
    if (ids.has(g.id)) throw new Error(`${input} (${g.id}): id: 重复目标`);
    ids.add(g.id);
  }
  return goals;
}
