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
  z.object({ kind: z.enum(['reply_matches', 'reply_excludes']), pattern: regex, scope: z.enum(['any', 'all', 'last']) }).strict(),
]);
export const goalSchema = z
  .object({
    id: z.string().min(1),
    persona: z.string().min(1),
    brand: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    allowedTools: z.array(z.string().min(1)),
    predicates: z.array(predicateSchema).min(1),
    forbidden: z.array(z.string().min(1)),
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
