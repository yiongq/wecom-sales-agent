// 企微发送账本（02 spec「企微：发送账本、回执与去重」）：账本在内存里，落库时写行；收到 msg_send_fail 按 msgid 改状态
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { OutboundKind } from '../../shared/conversation-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { conversations, messages, outboundSends } from '../schema.js';

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

/**
 * 写账本行。同一个 msgid 再写一次是同一分段的后续（第 12 步：超时那一刻先记 unknown，之后重试成功升 accepted、最后一次尝试的时刻
 * 往后挪；或收到回执记 failed）：按 (tenant_id, channel_msgid) upsert，仍是一行（不变量 33）。只认三种变化：unknown 升 accepted、
 * unknown 刷新（errcode、sent_at）、还不是 failed 的记 failed；其余（比如已 failed 的又来一个 unknown）不动。sent_at 只往后挪。
 * 同一批里同一 msgid 只留最后一行（ON CONFLICT 不能在一条语句里改同一行两次）
 */
export async function insertOutboundSends(tx: Tx, rows: readonly OutboundSendRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  const last = new Map<string, OutboundSendRow>();
  for (const r of rows) {
    last.delete(r.channelMsgid);
    last.set(r.channelMsgid, r);
  }
  await tx
    .insert(outboundSends)
    .values([...last.values()].map((r) => ({ tenantId, ...r })))
    .onConflictDoUpdate({
      target: [outboundSends.tenantId, outboundSends.channelMsgid],
      set: {
        status: sql`excluded.status`,
        errcode: sql`excluded.errcode`,
        failType: sql`excluded.fail_type`,
        sentAt: sql`greatest(${outboundSends.sentAt}, excluded.sent_at)`,
      },
      setWhere: sql`${outboundSends.status} <> 'failed' and (excluded.status = 'failed' or (${outboundSends.status} = 'unknown' and excluded.status in ('unknown', 'accepted')))`,
    });
}

/** 后台「看更早的消息」（02 第 13 步）：这个会话里对应这几条消息（message_seq）的账本行，J 页据此写没送达的原因 */
export async function readOutboundForSeqs(tx: Tx, conversationId: string, seqs: readonly number[]): Promise<OutboundSendRow[]> {
  if (!seqs.length) return [];
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
    .where(and(eq(outboundSends.conversationId, conversationId), sql`${outboundSends.messageSeq} = any(${sql.param([...seqs])}::int[])`));
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
 * 预载（第 12 步）：这批会话里、各自最后一条客户消息之后的发送，按会话、时间排。发送窗口与重放对齐只看这一段；没有客户消息的会话
 * （last_customer_at 为空）窗口本来就没开，不读。「之后」与内存的账本同一个口径：从 last_customer_at（企微 send_time）与这条客户消息
 * 本机收到的时刻（messages.at）里较早的一个算起，本机钟比企微慢时也读得全
 */
export async function readOutboundAfterLastCustomer(tx: Tx, conversationIds: readonly string[]): Promise<OutboundSendRow[]> {
  if (!conversationIds.length) return [];
  const lastCustomerLocalAt = sql`select ${messages.at} from ${messages} where ${messages.tenantId} = ${outboundSends.tenantId} and ${messages.conversationId} = ${outboundSends.conversationId} and ${messages.role} = 'customer' order by ${messages.seq} desc limit 1`;
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
        gte(outboundSends.sentAt, sql`least(${conversations.lastCustomerAt}, (${lastCustomerLocalAt}))`),
        sql`${conversations.lastCustomerAt} is not null`,
      ),
    )
    .orderBy(outboundSends.conversationId, outboundSends.sentAt);
}
