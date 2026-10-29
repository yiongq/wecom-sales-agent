import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isHandoffKind, type HandoffKind } from '../../src/shared/conversation-types.js';
import { FIXTURE_CLOCK } from './runtime.js';

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
  z
    .object({
      kind: z.literal('handoff'),
      expected: z.boolean(),
      handoffKind: z.custom<HandoffKind>((value) => typeof value === 'string' && isHandoffKind(value), '无效转人工类型').optional(),
    })
    .strict(),
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
// 12 R13：客户脚本的一轮可以是附件。attach 是 eval/fixtures/attachments/ 下的样本文件名（不带路径）；
// 写了 say 就先说这句、再发文件（两条消息，与真实渠道一样），没写只发文件。
const scriptedTurn = z.union([
  z.string().min(1),
  z
    .object({
      say: z.string().min(1).optional(),
      attach: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '只能是 eval/fixtures/attachments/ 下的文件名'),
    })
    .strict(),
]);
const stage = z.enum(['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing', 'paid', 'handoff']);
const history = z.array(z.object({ role: z.enum(['customer', 'ai']), content: z.string().min(1) }).strict());
const initialSchema = z
  .object({
    stage: stage.optional(),
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
    history: history.optional(),
  })
  .strict();
const goalShape = {
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
  customerScript: z.array(scriptedTurn).optional(), // 前几轮客户原话（或附件）固定，之后交给客户模型
};
export const goalSchema = z
  .object({
    ...goalShape,
    // 08 R11：缺省就是 travel；travel 的写法与没有这个字段时完全相同，别的包走 packGoalSchema
    pack: z.literal('travel').optional(),
    initial: initialSchema.optional(), // 初始会话与订单（真 paid 走订单状态）
  })
  .strict();

// ---- 08 R11：非旅游包（pack 不是 travel） ----
// 画像只收 { attrs, notes }；订单只给条目和数量，单价与金额由包的 priceLine 算（不变量 7），通用单没有退款的两种状态
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const approvalSeed = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), requestedAt: timestamp }).strict(),
  z.object({ state: z.literal('approved'), requestedAt: timestamp, decidedAt: timestamp }).strict(),
]);
export type SimQuoteApprovalSeed = z.infer<typeof approvalSeed>;
const packInitialSchema = z
  .object({
    stage: stage.optional(),
    profile: z
      .object({ attrs: z.record(z.string(), z.string()).optional(), notes: z.array(z.string()).optional() })
      .strict()
      .optional(),
    orders: z
      .array(
        z
          .object({
            status: z.enum(['pending_payment', 'paid', 'cancelled', 'superseded']),
            approval: approvalSeed.optional(),
            lines: z
              .array(z.object({ kind: z.string().min(1), code: z.string().min(1), qty: z.number().int().positive() }).strict())
              .min(1),
          })
          .strict()
          .refine((o) => o.approval?.state !== 'pending' || o.status === 'pending_payment', 'pending 审批只能搭配 pending_payment')
          .refine(
            (o) => o.approval?.state !== 'approved' || o.approval.requestedAt <= o.approval.decidedAt,
            'requestedAt 不能晚于 decidedAt',
          ),
      )
      // 同一会话最多一张待付的通用单（R3）：种子按顺序建单，后建的单会把先建的待付单作废，所以 pending_payment 只能是最后一张
      .refine((orders) => orders.every((o, i) => o.status !== 'pending_payment' || i === orders.length - 1), {
        message: 'pending_payment 的订单只能排在最后，且最多一张',
      })
      .optional(),
    history: history.optional(),
  })
  .strict();
export const packGoalSchema = z
  .object({
    ...goalShape,
    pack: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, '只能含字母、数字、下划线和连字符')
      .refine((id) => id !== 'travel', 'travel 不写 pack 或写 "travel"，走旅游的 schema'),
    initial: packInitialSchema.optional(),
  })
  .strict();
export type TravelGoal = z.infer<typeof goalSchema>;
export type PackGoal = z.infer<typeof packGoalSchema>;
/** 运行器读的目标：旅游与非旅游包共用一个类型，pack 缺省 travel，initial 里的画像与订单按 pack 取旅游或通用单的形状 */
export type SimGoal = Omit<TravelGoal, 'pack' | 'initial'> & { pack?: string; initial?: TravelGoal['initial'] | PackGoal['initial'] };
export type Predicate = z.infer<typeof predicateSchema>;
/** 目标所属的包 id（缺省 travel） */
export const goalPack = (g: SimGoal): string => g.pack ?? 'travel';

/** 10 R15：在建任何种子订单之前整体验证，避免后面的非法种子留下半初始化状态。 */
export function validatePackInitial(value: unknown, now: number, quotes: boolean = true): z.infer<typeof packInitialSchema> {
  const initial = packInitialSchema.parse(value);
  for (const order of initial.orders ?? []) {
    const a = order.approval;
    if (!a) continue;
    if (!quotes) throw new Error('approval 种子只供声明 quotes 的包使用');
    if (a.requestedAt > now || (a.state === 'approved' && a.decidedAt > now)) throw new Error('approval 时间不能超前于模拟当前时间');
  }
  return initial;
}

export function validateGoal(value: unknown, file: string): SimGoal {
  // 按 pack 分支：没写或写 travel 走旅游（与以前相同），写了别的字符串走非旅游包；写成非字符串由旅游 schema 报错
  const pack = value && typeof value === 'object' && 'pack' in value ? value.pack : undefined;
  const result = (typeof pack === 'string' && pack !== 'travel' ? packGoalSchema : goalSchema).safeParse(value);
  if (result.success) {
    if (typeof pack === 'string' && pack !== 'travel' && result.data.initial)
      validatePackInitial(result.data.initial, Date.parse(FIXTURE_CLOCK));
    return result.data;
  }
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

/** 只留 tags 含 tag 的目标（07 R8：只有带 regression 的目标进闸）。一个都没有就抛错，不让闸空跑成「通过」。 */
export function selectByTag(goals: SimGoal[], tag: string): SimGoal[] {
  const selected = goals.filter((g) => g.tags?.includes(tag));
  if (!selected.length) throw new Error(`没有目标带标签 ${tag}`);
  return selected;
}
