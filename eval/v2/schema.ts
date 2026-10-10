import { z } from 'zod';

const strings = z.array(z.string());
const record = z.record(z.string(), z.unknown());
const patterns = z.array(
  z.string().superRefine((value, ctx) => {
    try {
      RegExp(value.replace(/\{\{(?:call|order):[^}]+\}\}/g, 'placeholder'), 'm');
    } catch {
      ctx.addIssue({ code: 'custom', message: '无效正则表达式' });
    }
  }),
);
const stage = z.enum(['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing', 'paid', 'handoff']);
const status = z.enum(['pending_payment', 'paid', 'cancelled', 'superseded']);
const quote = z.strictObject({
  routeId: z.string(),
  routeTitle: z.string(),
  travelers: z.number(),
  perPerson: z.number().optional(),
  total: z.number().optional(),
  departDate: z.string().optional(),
});
// Record 型的扩展状态保留原值；已知会话字段的类型和拼写在这里校验。
const session = z
  .strictObject({
    id: z.string(),
    channel: z.string(),
    stage,
    profile: z.strictObject({
      destinationInterest: z.string().optional(),
      segment: z.enum(['家庭', '亲子', '蜜月', '商务', '银发']).optional(),
      travelers: z.string().optional(),
      dates: z.string().optional(),
      budget: z.string().optional(),
      notes: strings.optional(),
      nickname: z.string().optional(),
      avatar: z.string().optional(),
    }),
    messages: z.array(
      z.strictObject({
        role: z.enum(['customer', 'agent', 'system']),
        content: z.string(),
        at: z.number(),
        msgid: z.string().optional(),
        sentAt: z.number().optional(),
        author: z.enum(['ai', 'human', 'followup']).optional(),
        authorId: z.string().nullable().optional(),
        authorName: z.string().optional(),
      }),
    ),
    orderIds: strings,
    handedOver: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastQuote: quote,
    quoteHistory: z.array(record),
    stageBeforeHandoff: stage,
    budgetGaps: z.array(z.number()),
    lastShownRoutes: z.array(record),
    seenRouteIds: strings,
    missedDestinations: z.array(record),
    handoff: record,
    firstHandoffAt: z.number(),
    handoffCount: z.number(),
    assignee: record.nullable(),
    turnSignals: z.array(z.number()),
    negativeHits: z.array(z.number()),
    followupOptOut: record,
    consent: record,
    consentAskCount: record,
    channelAccountId: z.string(),
  })
  .partial();

export const caseSchema = z.strictObject({
  version: z.literal(2),
  id: z.string().min(1),
  desc: z.string(),
  tags: strings,
  realOnly: z.boolean().optional(),
  brand: z.string().optional(),
  fixtures: z
    .strictObject({
      now: z.iso.datetime({ offset: true }).optional(),
      session: session.optional(),
      orders: z
        .array(z.strictObject({ status, travelers: z.number().int().min(1).max(50), departDate: z.iso.date(), routeId: z.string().min(1) }))
        .optional(),
    })
    .optional(),
  turns: z
    .array(
      z.strictObject({
        say: z.string(),
        script: z
          .array(
            z.strictObject({
              content: z.string().optional(),
              toolCalls: z.array(z.strictObject({ name: z.string().min(1), args: record })).optional(),
            }),
          )
          .optional(),
        expect: z.strictObject({
          replyMatches: patterns.optional(),
          replyExcludes: patterns.optional(),
          stage: z.string().optional(),
          tools: strings.optional(),
          orders: z.strictObject({ count: z.number().int().nonnegative(), last: record.optional() }).optional(),
          silent: z.boolean().optional(),
          handoff: z.boolean().optional(),
          guardVerdicts: z.array(z.strictObject({ id: z.string(), action: z.string() })).optional(),
        }),
      }),
    )
    .min(1),
});
export type CaseV2 = z.infer<typeof caseSchema>;
export type ScriptStep = NonNullable<CaseV2['turns'][number]['script']>[number];

export function validateCase(value: unknown): CaseV2 {
  const result = caseSchema.safeParse(value);
  if (result.success) return result.data;
  const id = value && typeof value === 'object' && 'id' in value ? String(value.id) : '(无 id)';
  throw new Error(
    `[${id}] ${result.error.issues
      .map((i) => {
        const path = i.path.join('.') || '$';
        return i.code === 'unrecognized_keys' ? i.keys.map((k) => `${path}.${k}: 未知字段`).join('; ') : `${path}: ${i.message}`;
      })
      .join('; ')}`,
  );
}

export function validateCases(values: unknown[]): CaseV2[] {
  const cases = values.map(validateCase);
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`[${c.id}] id: 重复`);
    ids.add(c.id);
  }
  return cases;
}
