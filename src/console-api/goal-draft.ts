// 「存为回归用例」的草稿（07 spec R24）：把后台里的一轮对话整理成一份 SimGoal 草稿，作为附件下载，不落盘、不进仓库、不进库里的用例表。
// 草稿故意过不了 eval/sim/goals.ts 的校验：多一个 _draft 字段（目标 schema 是严格的）、predicates 是空数组（至少要一条）、persona 是空串。
// 开发者必须把客户原话改写成合成的话、写好谓词与客群描述、删掉 _draft，才能放进 eval/sim/goals/（07 不变量 21：客户原文不进仓库）。
// 号码类（手机号、证件号、银行卡号）按 mask.ts 打码；姓名、地名这些不打码，靠 schema 拒收和改写这一步守住仓库。
// 纯函数：查库与审计在 app.ts 里，这里只管形状。形状要与 eval/sim/goals.ts 的 goalSchema 对得上，由 traces.selftest.ts 拿它校验
import type { GuardVerdictView, ReplyShapeView } from '../shared/console-api.js';
import type { HandoffKind } from '../shared/conversation-types.js';
import type { Order } from '../types.js';
import { maskNumbers } from './mask.js';

/** eval/sim/goals.ts 的 initialSchema.stage 的取值（不 import eval/：运行镜像里没有它） */
const GOAL_STAGES: ReadonlySet<string> = new Set([
  'greeting',
  'discovery',
  'recommend',
  'quote',
  'objection',
  'closing',
  'paid',
  'handoff',
]);
/** initialSchema.orders[].status 的取值（没有 superseded：被换掉的旧单不带进初始状态） */
type GoalOrderStatus = 'pending_payment' | 'paid' | 'cancelled' | 'refund_pending' | 'refunded';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 初始状态里带几条这一轮之前的消息（spec：最近 10 条） */
export const GOAL_HISTORY_LIMIT = 10;

export interface GoalDraftInput {
  turnId: string;
  startedAt: Date;
  durationMs: number;
  outcome: string;
  sopVersion: number | null;
  stageBefore: string | null;
  stageAfter: string | null;
  /** 这一轮发出的回复（trace 的 final_text） */
  finalText: string | null;
  /** trace 的 calls：只读每一项的 name */
  calls: readonly unknown[];
  guardVerdicts: readonly GuardVerdictView[] | null;
  replyShape: ReplyShapeView | null;
  handoffKind: HandoffKind | null;
  /** 这一轮的客户原话；这一轮没有回复（沉默）时为 null */
  customerText: string | null;
  /** 这一轮之前的消息，旧的在前，不含 system；agent 包括 AI、顾问人工回复与自动跟进 */
  history: readonly { role: 'customer' | 'agent'; content: string }[];
  /** 会话名下的订单（现在的状态） */
  orders: readonly Order[];
}

/**
 * 订单在这一轮开始时的样子：这一轮才建的单不带；已付款、退款申请发生在这一轮或之后的，按当时的状态回推（待付款、已付款）。
 * 取消的订单没有记取消时刻，按取消带；被换掉的旧单（superseded）不带。出发日不是 YYYY-MM-DD 的不带（不合 initialSchema）
 */
export function ordersBeforeTurn(
  orders: readonly Order[],
  startedAtMs: number,
): { routeId: string; travelers: number; departDate: string; status: GoalOrderStatus }[] {
  const out: { routeId: string; travelers: number; departDate: string; status: GoalOrderStatus }[] = [];
  for (const o of orders) {
    if (o.createdAt >= startedAtMs || !DATE_RE.test(o.departDate)) continue;
    let status: GoalOrderStatus;
    switch (o.status) {
      case 'superseded':
        continue;
      case 'cancelled':
      case 'pending_payment':
        status = o.status;
        break;
      case 'paid':
        status = o.paidAt !== undefined && o.paidAt >= startedAtMs ? 'pending_payment' : 'paid';
        break;
      case 'refund_pending':
      case 'refunded': {
        const paidBefore = o.paidAt !== undefined && o.paidAt < startedAtMs;
        const requestedBefore = o.refund !== undefined && o.refund.requestedAt < startedAtMs;
        status = !paidBefore ? 'pending_payment' : requestedBefore ? o.status : 'paid';
        break;
      }
    }
    out.push({ routeId: o.routeId, travelers: o.travelers, departDate: o.departDate, status });
  }
  return out;
}

/** 草稿里 _draft.note 的话：下载的人第一眼就看到该做什么 */
export const GOAL_DRAFT_NOTE =
  '这是回归用例草稿，不能直接放进 eval/sim/goals/：把 customerScript 里的客户原话改写成合成的话（姓名、地名、号码都换掉）、写好 persona 和 predicates、核对 allowedTools 与 initial，最后删掉整个 _draft。';

export interface GoalDraft {
  id: string;
  persona: string;
  allowedTools: string[];
  predicates: never[];
  forbidden: string[];
  tags: ['regression'];
  initial?: {
    stage?: string;
    orders?: ReturnType<typeof ordersBeforeTurn>;
    history?: { role: 'customer' | 'ai'; content: string }[];
  };
  customerScript: string[];
  _draft: {
    note: string;
    turnId: string;
    startedAt: string;
    outcome: string;
    durationMs: number;
    sopVersion: number | null;
    stageBefore: string | null;
    stageAfter: string | null;
    handoffKind: HandoffKind | null;
    /** 触发过的护栏：guard_verdicts 里 action 不是 pass 的步骤（id 与动作） */
    guards: GuardVerdictView[];
    replyShape: ReplyShapeView | null;
    /** 这一轮发出的回复（号码已打码），写谓词时对照用 */
    reply: string | null;
  };
}

const callNames = (calls: readonly unknown[]): string[] => [
  ...new Set(
    calls.flatMap((c) => {
      const name = typeof c === 'object' && c !== null && 'name' in c ? (c as { name: unknown }).name : null;
      return typeof name === 'string' && name ? [name] : [];
    }),
  ),
];

/** 草稿的第一版：predicates 空、persona 空、带 _draft，所以 goalSchema 一定拒收（见文件头） */
export function buildGoalDraft(input: GoalDraftInput): GoalDraft {
  const mask = (t: string): string => maskNumbers(t.trim());
  const history = input.history.flatMap((m) =>
    m.content.trim() ? [{ role: m.role === 'customer' ? ('customer' as const) : ('ai' as const), content: mask(m.content) }] : [],
  );
  const orders = ordersBeforeTurn(input.orders, input.startedAt.getTime());
  const stage = input.stageBefore !== null && GOAL_STAGES.has(input.stageBefore) ? input.stageBefore : undefined;
  const initial: NonNullable<GoalDraft['initial']> = {
    ...(stage ? { stage } : {}),
    ...(orders.length ? { orders } : {}),
    ...(history.length ? { history } : {}),
  };
  return {
    id: `draft-${input.turnId.slice(0, 8)}`,
    persona: '',
    allowedTools: callNames(input.calls),
    predicates: [],
    forbidden: [],
    tags: ['regression'],
    ...(Object.keys(initial).length ? { initial } : {}),
    customerScript: input.customerText?.trim() ? [mask(input.customerText)] : [],
    _draft: {
      note: GOAL_DRAFT_NOTE,
      turnId: input.turnId,
      startedAt: input.startedAt.toISOString(),
      outcome: input.outcome,
      durationMs: input.durationMs,
      sopVersion: input.sopVersion,
      stageBefore: input.stageBefore,
      stageAfter: input.stageAfter,
      handoffKind: input.handoffKind,
      guards: (input.guardVerdicts ?? []).filter((v) => v.action !== 'pass'),
      replyShape: input.replyShape,
      reply: input.finalText ? mask(input.finalText) : null,
    },
  };
}

/** 下载的文件名：只含轮次 id 的前 8 位，不带会话 id 与客户标识 */
export const goalDraftFilename = (turnId: string): string => `goal-draft-${turnId.slice(0, 8)}.json`;
