// 订单（02 spec「数据库」「identity map 与写入」）：按 id upsert，读未作废的。data 列是整个 Order 对象，重建只读它
import { and, asc, isNull, sql } from 'drizzle-orm';
import type { OrderStatus } from '../../shared/conversation-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { orders } from '../schema.js';

export interface OrderRow {
  id: string;
  /** 会话被清除或删除后为 null */
  sessionId: string | null;
  routeId: string;
  status: OrderStatus;
  totalPrice: number;
  createdAt: Date;
  /** 写入之后不能改、不能清空（触发器） */
  paidAt: Date | null;
  confirmedAt: Date | null;
  voidedAt: Date | null;
  voidReason: 'reset' | 'resync' | null;
  /** 整个 Order 对象，键序原样 */
  data: Record<string, unknown>;
}

const CHUNK = 1000;

/** 落库第 5 步与导入、--resync：按 id upsert，除主键外的列都以这次为准 */
export async function upsertOrders(tx: Tx, rows: readonly OrderRow[]): Promise<void> {
  const { tenantId } = currentTenantCtx();
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insert(orders)
      .values(rows.slice(i, i + CHUNK).map((o) => ({ tenantId, ...o })))
      .onConflictDoUpdate({
        target: [orders.tenantId, orders.id],
        set: {
          sessionId: sql`excluded.session_id`,
          routeId: sql`excluded.route_id`,
          status: sql`excluded.status`,
          totalPrice: sql`excluded.total_price`,
          createdAt: sql`excluded.created_at`,
          paidAt: sql`excluded.paid_at`,
          confirmedAt: sql`excluded.confirmed_at`,
          voidedAt: sql`excluded.voided_at`,
          voidReason: sql`excluded.void_reason`,
          data: sql`excluded.data`,
        },
      });
  }
}

/** 预载与导出：这批会话的未作废订单，按创建时间排序 */
export async function readLiveOrders(tx: Tx, sessionIds: readonly string[]): Promise<OrderRow[]> {
  if (!sessionIds.length) return [];
  return tx
    .select({
      id: orders.id,
      sessionId: orders.sessionId,
      routeId: orders.routeId,
      status: orders.status,
      totalPrice: orders.totalPrice,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      confirmedAt: orders.confirmedAt,
      voidedAt: orders.voidedAt,
      voidReason: orders.voidReason,
      data: orders.data,
    })
    .from(orders)
    .where(and(sql`${orders.sessionId} = any(${sql.param([...sessionIds])}::text[])`, isNull(orders.voidedAt)))
    .orderBy(asc(orders.createdAt), asc(orders.id));
}
