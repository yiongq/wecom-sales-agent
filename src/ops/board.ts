// 看板的成交数（07 spec R23）：按来源（src/shared/origin.ts）和有没有转过人工拆开。成交数从内存里的全部订单算（含 demo 类会话，
// 种子与网页访客也在），不查库；窗口和 /metrics 的运行数字相同（起点由调用方按服务器时区算好）。
// 纯函数加两个读 store 的薄包装：`/orders/summary` 与 `/metrics` 共用，来源的判定只调 originOf，不在这里再写一遍。
import type { HandoffRow } from '../db/repo/metrics.js';
import type { DealsPart, HandoffPart, OrderSummaryPart } from '../shared/console-api.js';
import { type HandoffKind, isHandoffKind } from '../shared/conversation-types.js';
import { originOf, type Origin } from '../shared/origin.js';
import { getSession, listOrders } from '../store.js';
import { currentRuntime } from '../tenancy/runtime.js';
import type { Order } from '../types.js';

type TenantKind = 'standard' | 'sandbox';
/** 会话的种子标记（Session.seed）：会话不在内存里（订单的会话已被清理）为 undefined */
type SeedOf = (sessionId: string) => boolean | undefined;

const emptyDeals = (): DealsPart => ({
  aiOnly: 0,
  aiOnlyAmount: 0,
  aiOnlyRefunded: 0,
  assisted: 0,
  assistedAmount: 0,
  assistedRefunded: 0,
  refunded: 0,
});
const emptySummary = (): OrderSummaryPart => ({
  paidTotal: 0,
  paidCount: 0,
  refundedTotal: 0,
  refundedCount: 0,
  refundPendingCount: 0,
  pendingTotal: 0,
  pendingCount: 0,
});

const originOfOrder = (o: Order, kind: TenantKind, seedOf: SeedOf): Origin =>
  originOf({ sessionId: o.sessionId, orderId: o.id, seed: seedOf(o.sessionId) }, kind);

/** 付过款的订单：写过 paid_at，状态是已付、退款中或已退款（退款不改 paid_at，也不改 handoffBeforePaid） */
const paidAtOf = (o: Order): number | null =>
  o.paidAt != null && (o.status === 'paid' || o.status === 'refund_pending' || o.status === 'refunded') ? o.paidAt : null;

/**
 * 窗口内（paid_at >= since）付过款的订单，按来源拆成 AI 独立成交（handoffBeforePaid 不是 true）和人机协同成交（是 true）。
 * 顾问收款模式下的确认价格、确认收款是收款流程，不改 handoffBeforePaid（它只在 markOrderPaid 时按会话有没有转过人工写一次），
 * 所以不算协同。已退款的单照算在两类里，另在「其中已退款」里单列
 */
export function dealsByOrigin(orders: readonly Order[], since: number, kind: TenantKind, seedOf: SeedOf): Record<Origin, DealsPart> {
  const out: Record<Origin, DealsPart> = { customer: emptyDeals(), visitor: emptyDeals(), seed: emptyDeals() };
  for (const o of orders) {
    const paidAt = paidAtOf(o);
    if (paidAt === null || paidAt < since) continue;
    const part = out[originOfOrder(o, kind, seedOf)];
    const refunded = o.status === 'refunded' ? 1 : 0;
    if (o.handoffBeforePaid === true) {
      part.assisted += 1;
      part.assistedAmount += o.totalPrice;
      part.assistedRefunded += refunded;
    } else {
      part.aiOnly += 1;
      part.aiOnlyAmount += o.totalPrice;
      part.aiOnlyRefunded += refunded;
    }
    part.refunded += refunded;
  }
  return out;
}

/** 一张订单加进本月汇总（口径同第 4 步的 /orders/summary：成交额含退款中，已退款单按原付款月份的原成交额单列，退款中与待付款不限月份） */
function addToSummary(part: OrderSummaryPart, o: Order, from: number, to: number): void {
  const inMonth = o.paidAt != null && o.paidAt >= from && o.paidAt < to;
  if (o.status === 'refund_pending') part.refundPendingCount += 1;
  if (o.status === 'refunded' && inMonth) {
    part.refundedTotal += o.totalPrice;
    part.refundedCount += 1;
  } else if ((o.status === 'paid' || o.status === 'refund_pending') && inMonth) {
    part.paidTotal += o.totalPrice;
    part.paidCount += 1;
  } else if (o.status === 'pending_payment') {
    part.pendingTotal += o.totalPrice;
    part.pendingCount += 1;
  }
}

/** /orders/summary 的数：顶层是全部来源的合计，byOrigin 是同一口径按来源拆开（三类之和等于合计） */
export function summarizeOrders(
  orders: readonly Order[],
  from: number,
  to: number,
  kind: TenantKind,
  seedOf: SeedOf,
): { total: OrderSummaryPart; byOrigin: Record<Origin, OrderSummaryPart> } {
  const total = emptySummary();
  const byOrigin: Record<Origin, OrderSummaryPart> = { customer: emptySummary(), visitor: emptySummary(), seed: emptySummary() };
  for (const o of orders) {
    addToSummary(total, o, from, to);
    addToSummary(byOrigin[originOfOrder(o, kind, seedOf)], o, from, to);
  }
  return { total, byOrigin };
}

const liveSeedOf: SeedOf = (sessionId) => getSession(sessionId)?.seed;

/** 当前租户内存里的全部订单（含 demo 类）的成交拆分 */
export function liveDeals(since: number): Record<Origin, DealsPart> {
  return dealsByOrigin(listOrders(), since, currentRuntime().kind, liveSeedOf);
}

/** 当前租户内存里的全部订单的本月汇总 */
export function liveOrderSummary(from: number, to: number): ReturnType<typeof summarizeOrders> {
  return summarizeOrders(listOrders(), from, to, currentRuntime().kind, liveSeedOf);
}

/**
 * 按原因的转人工率（07 R23）：窗口内有轮次的会话是分母，其中窗口内 handoffLog 里有这类记录的会话是分子（一个会话同一原因记几次只算一个）。
 * 比率不会超过 1：分子只数窗口内有轮次的会话。顾问主动接手（kind agent）不经轮次，次数单列：窗口内更新过的会话里 agent 记录的条数。
 * 只算进库的会话，所以宿主的种子与 sim- 访客结构上是空的（sessions 为 0）；沙箱里三类都进库。
 * 返回全部来源合计（all）和按来源拆开（byOrigin）。库里读回的未知类型丢掉
 */
export function handoffStats(rows: readonly HandoffRow[], kind: TenantKind): { all: HandoffPart; byOrigin: Record<Origin, HandoffPart> } {
  interface Acc {
    sessions: number;
    sessionsByKind: Map<HandoffKind, number>;
    takeovers: number;
  }
  const accs: Record<Origin | 'all', Acc> = {
    customer: { sessions: 0, sessionsByKind: new Map(), takeovers: 0 },
    visitor: { sessions: 0, sessionsByKind: new Map(), takeovers: 0 },
    seed: { sessions: 0, sessionsByKind: new Map(), takeovers: 0 },
    all: { sessions: 0, sessionsByKind: new Map(), takeovers: 0 },
  };
  for (const r of rows) {
    const kinds = r.kinds.filter(isHandoffKind);
    for (const acc of [accs[originOf({ sessionId: r.id, seed: r.seed }, kind)], accs.all]) {
      acc.takeovers += kinds.filter((k) => k === 'agent').length;
      if (!r.active) continue;
      acc.sessions += 1;
      for (const k of new Set(kinds)) acc.sessionsByKind.set(k, (acc.sessionsByKind.get(k) ?? 0) + 1);
    }
  }
  const part = (acc: Acc): HandoffPart => ({
    sessions: acc.sessions,
    byKind: Object.fromEntries([...acc.sessionsByKind].map(([k, n]) => [k, n / acc.sessions])),
    takeovers: acc.takeovers,
  });
  return { all: part(accs.all), byOrigin: { customer: part(accs.customer), visitor: part(accs.visitor), seed: part(accs.seed) } };
}
