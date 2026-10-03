// 企微发送账本（02 spec「企微：发送账本、回执与去重」）：账本在内存里，落库时写行；收到 msg_send_fail 按 msgid 改状态
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { OutboundKind } from '../../shared/conversation-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { conversations, outboundSends } from '../schema.js';

export type OutboundStatus = 'accepted' | 'rejected' | 'unknown' | 'failed';

export interface OutboundSendRow {
  conversationId: string;
  /** 我们生成、随 send_msg 下发；同一分段重试沿用 */
  channelMsgid: string;
  /** 对应的会话消息；欢迎语、同意菜单为 null */
  messageSeq: number | null;
  kind: OutboundKind;
  sentAt: Date;
  status: OutboundStatus;
  errcode: number | null;
  failType: number | null;
}

export async function insertOutboundSends(tx: Tx, rows: readonly OutboundSendRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.insert(outboundSends).values(rows.map((r) => ({ tenantId, ...r })));
}

/** 按 msgid 改状态（回执）；errcode、failType 不给就不动。返回是否找到了这一行 */
export async function setOutboundStatus(
  tx: Tx,
  channelMsgid: string,
  status: OutboundStatus,
  opts: { errcode?: number | null; failType?: number | null } = {},
): Promise<boolean> {
  const out = await tx
    .update(outboundSends)
    .set({
      status,
      ...(opts.errcode !== undefined ? { errcode: opts.errcode } : {}),
      ...(opts.failType !== undefined ? { failType: opts.failType } : {}),
    })
    .where(eq(outboundSends.channelMsgid, channelMsgid))
    .returning({ id: outboundSends.id });
  return out.length === 1;
}

/**
 * 收到 msg_send_fail（第 12 步）：按 msgid 把还不是 failed 的那一行记 failed 与 fail_type。返回那一行的会话 id；
 * 找不到、或已经记过 failed（回执重复）返回 null，调用方据此不重复给会话加说明
 */
export async function markOutboundFailed(tx: Tx, channelMsgid: string, failType: number): Promise<string | null> {
  const out = await tx
    .update(outboundSends)
    .set({ status: 'failed', failType })
    .where(and(eq(outboundSends.channelMsgid, channelMsgid), ne(outboundSends.status, 'failed')))
    .returning({ conversationId: outboundSends.conversationId });
  return out[0]?.conversationId ?? null;
}

/**
 * 预载（第 12 步）：这批会话里、各自最后一条客户消息（conversations.last_customer_at）之后的发送，按会话、时间排。
 * 发送窗口与重放对齐只看这一段；没有客户消息的会话窗口本来就没开，不读
 */
export async function readOutboundAfterLastCustomer(tx: Tx, conversationIds: readonly string[]): Promise<OutboundSendRow[]> {
  if (!conversationIds.length) return [];
  return tx
    .select({
      conversationId: outboundSends.conversationId,
      channelMsgid: outboundSends.channelMsgid,
      messageSeq: outboundSends.messageSeq,
      kind: outboundSends.kind,
      sentAt: outboundSends.sentAt,
      status: outboundSends.status,
      errcode: outboundSends.errcode,
      failType: outboundSends.failType,
    })
    .from(outboundSends)
    .innerJoin(conversations, and(eq(conversations.tenantId, outboundSends.tenantId), eq(conversations.id, outboundSends.conversationId)))
    .where(
      and(
        sql`${outboundSends.conversationId} = any(${sql.param([...conversationIds])}::text[])`,
        gte(outboundSends.sentAt, conversations.lastCustomerAt),
      ),
    )
    .orderBy(outboundSends.conversationId, outboundSends.sentAt);
}
