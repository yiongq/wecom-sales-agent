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
const status = z.enum(['pending_payment', 'paid', 'cancelled', 'superseded', 'refund_pending', 'refunded']);
const quote = z.strictObject({
  routeId: z.string(),
  routeTitle: z.string(),
  travelers: z.number(),
  perPerson: z.number().optional(),
  total: z.number().optional(),
  departDate: z.string().optional(),
});
// Record 型的扩展状态保留原值；已知会话字段的类型和拼写在这里校验。
const sessionBase = z.strictObject({
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
  reminders: z.strictObject({
    altitude: z.number().optional(),
    elderAge: z.number().optional(),
    proposalSent: z.number().optional(),
    paidNext: z.number().optional(),
  }),
  recommendedRoutes: z.array(z.strictObject({ id: z.string(), title: z.string() })),
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
});
const session = sessionBase.partial();
// 08 R11：非旅游包的会话夹具。画像只收 { attrs, notes }（昵称、头像不是业务字段），旅游的会话字段（R1 的那几个）一律不收，
// 包自有的状态槽 packState 是 Record；其余会话字段与旅游相同
const packSession = sessionBase
  .omit({
    lastQuote: true,
    quoteHistory: true,
    budgetGaps: true,
    lastShownRoutes: true,
    seenRouteIds: true,
    missedDestinations: true,
    reminders: true,
    recommendedRoutes: true,
    profile: true,
  })
  .extend({ profile: z.strictObject({ attrs: z.record(z.string(), z.string()).optional(), notes: strings.optional() }), packState: record })
  .partial();

const nonNegativeInt = z.number().int().nonnegative();
/** 本轮脚本与断言；orders.last 的形状由旅游（Record）和非旅游包（通用单）各给一份。 */
const turns = <L extends z.ZodType<Record<string, unknown>>>(last: L) =>
  z
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
          // 06：只看本轮 contextNote 那条 system 消息（第一次模型请求里以【当前会话状态】开头的那条）
          contextMatches: patterns.optional(),
          contextExcludes: patterns.optional(),
          stage: z.string().optional(),
          tools: strings.optional(),
          orders: z.strictObject({ count: nonNegativeInt, last: last.optional() }).optional(),
          silent: z.boolean().optional(),
          handoff: z.boolean().optional(),
          guardVerdicts: z.array(z.strictObject({ id: z.string(), action: z.string() })).optional(),
        }),
      }),
    )
    .min(1);

export const caseSchema = z.strictObject({
  version: z.literal(2),
  id: z.string().min(1),
  desc: z.string(),
  tags: strings,
  realOnly: z.boolean().optional(),
  brand: z.string().optional(),
  // 08 R11：缺省就是 travel；travel 的写法与没有这个字段时完全相同，别的包走 packCaseSchema
  pack: z.literal('travel').optional(),
  fixtures: z
    .strictObject({
      now: z.iso.datetime({ offset: true }).optional(),
      session: session.optional(),
      orders: z
        .array(z.strictObject({ status, travelers: z.number().int().min(1).max(50), departDate: z.iso.date(), routeId: z.string().min(1) }))
        .optional(),
    })
    .optional(),
  turns: turns(record),
});

// ---- 08 R11：非旅游包（pack 不是 travel） ----
// 通用单只有这四种状态（退款的两种不收）
const lineStatus = z.enum(['pending_payment', 'paid', 'cancelled', 'superseded']);
// 夹具里的订单行只给条目和数量：单价、行金额、合计一概不收，由包的 priceLine 算（不变量 7）
const lineFixture = z.strictObject({ kind: z.string().min(1), code: z.string().min(1), qty: z.number().int().positive() });
// orders.last 里的一行：只比对写出来的键（kind / code / qty / unitPriceFen / amountFen，以及 title / unit），其余不比
const lineExpect = z.strictObject({
  kind: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  title: z.string().optional(),
  unit: z.string().optional(),
  qty: nonNegativeInt.optional(),
  unitPriceFen: nonNegativeInt.optional(),
  amountFen: nonNegativeInt.optional(),
});
const packLast = z.strictObject({
  v: z.literal(2).optional(),
  status: lineStatus.optional(),
  totalFen: nonNegativeInt.optional(),
  lines: z.array(lineExpect).min(1).optional(),
});

export const packCaseSchema = z.strictObject({
  version: z.literal(2),
  id: z.string().min(1),
  desc: z.string(),
  tags: strings,
  realOnly: z.boolean().optional(),
  // 与 pack.json 的 id 同一字符集；配置目录是 data/packs/<pack>/
  pack: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, '只能含字母、数字、下划线和连字符')
    .refine((id) => id !== 'travel', 'travel 不写 pack 或写 "travel"，走旅游的 schema'),
  fixtures: z
    .strictObject({
      now: z.iso.datetime({ offset: true }).optional(),
      session: packSession.optional(),
      orders: z
        .array(z.strictObject({ status: lineStatus, lines: z.array(lineFixture).min(1) }))
        // 同一会话最多一张待付的通用单（R3）：夹具按顺序建单，后建的单会把先建的待付单作废，所以 pending_payment 只能是最后一张
        .refine(
          (orders) => orders.every((o, i) => o.status !== 'pending_payment' || i === orders.length - 1),
          'pending_payment 的订单只能排在最后，且最多一张',
        )
        .optional(),
    })
    .optional(),
  turns: turns(packLast),
});
export type TravelCase = z.infer<typeof caseSchema>;
export type PackCase = z.infer<typeof packCaseSchema>;
export type CaseV2 = TravelCase | PackCase;
/** pack 不是 travel（缺省或写 "travel" 都是旅游） */
export const isPackCase = (c: CaseV2): c is PackCase => c.pack !== undefined && c.pack !== 'travel';
/** 用例所属的包 id */
export const packOf = (c: CaseV2): string => c.pack ?? 'travel';
export type ScriptStep = NonNullable<CaseV2['turns'][number]['script']>[number];

export function validateCase(value: unknown): CaseV2 {
  // 按 pack 分支：没写或写 travel 走旅游（与以前相同），写了别的字符串走非旅游包；写成非字符串由旅游 schema 报错
  const pack = value && typeof value === 'object' && 'pack' in value ? value.pack : undefined;
  const result = (typeof pack === 'string' && pack !== 'travel' ? packCaseSchema : caseSchema).safeParse(value);
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
