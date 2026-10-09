// 消息（02 spec「消息只追加」「identity map 与写入」）：只有批量插入与按窗口读。agent_app 对这张表没有 UPDATE、DELETE
import { and, asc, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { conversations, messages } from '../schema.js';

export interface MessageValues {
  seq: number;
  role: 'customer' | 'agent' | 'system';
  author: 'ai' | 'human' | 'followup' | null;
  authorUserId: string | null;
  authorName: string | null;
  content: string;
  /** ChatMessage.at（毫秒） */
  at: Date;
  sentAt: Date | null;
  msgid: string | null;
  turnId: string | null;
  /** ChatMessage 上已知字段以外的键；没有就是 null */
  extra: Record<string, unknown> | null;
}

export interface MessageRow extends MessageValues {
  conversationId: string;
}

/** 一条 INSERT 的行数上限：13 列，远低于 65,535 个参数的上限 */
const CHUNK = 1000;

/** 落库第 3 步与导入：按 seq 插入一个会话的消息 */
export async function insertMessages(tx: Tx, conversationId: string, rows: readonly MessageValues[]): Promise<void> {
  const { tenantId } = currentTenantCtx();
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(messages).values(rows.slice(i, i + CHUNK).map((m) => ({ tenantId, conversationId, ...m })));
  }
}

/**
 * 预载：这批会话里 at >= since、带 msgid 的客户消息的 msgid（企微去重集合，02 spec「企微 · 去重与重放对齐」）。
 * 不看窗口：被重置、裁剪出窗口的也要
 */
export async function readRecentCustomerMsgids(
  tx: Tx,
  conversationIds: readonly string[],
  since: Date,
): Promise<{ conversationId: string; msgid: string }[]> {
  if (!conversationIds.length) return [];
  const rows = await tx
    .select({ conversationId: messages.conversationId, msgid: messages.msgid })
    .from(messages)
    .where(
      and(
        sql`${messages.conversationId} = any(${sql.param([...conversationIds])}::text[])`,
        eq(messages.role, 'customer'),
        isNotNull(messages.msgid),
        gte(messages.at, since),
      ),
    );
  return rows.map((r) => ({ conversationId: r.conversationId, msgid: r.msgid! }));
}

/** 一个会话 seq >= fromSeq 的消息，按 seq 排序（spill 回放比对「库里已经有了」时用） */
export async function readMessagesFrom(tx: Tx, conversationId: string, fromSeq: number): Promise<MessageRow[]> {
  return tx
    .select({
      conversationId: messages.conversationId,
      seq: messages.seq,
      role: messages.role,
      author: messages.author,
      authorUserId: messages.authorUserId,
      authorName: messages.authorName,
      content: messages.content,
      at: messages.at,
      sentAt: messages.sentAt,
      msgid: messages.msgid,
      turnId: messages.turnId,
      extra: messages.extra,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), gte(messages.seq, fromSeq)))
    .orderBy(asc(messages.seq));
}

/**
 * 后台「看更早的消息」（02 第 13 步，GET /conversations/:id/messages）：seq < beforeSeq 的最近 limit 条，按 seq 升序返回；
 * 多取一条判断再往前还有没有
 */
export async function readMessagesBefore(
  tx: Tx,
  conversationId: string,
  beforeSeq: number,
  limit: number,
): Promise<{ rows: MessageRow[]; hasEarlier: boolean }> {
  const rows = await tx
    .select({
      conversationId: messages.conversationId,
      seq: messages.seq,
      role: messages.role,
      author: messages.author,
      authorUserId: messages.authorUserId,
      authorName: messages.authorName,
      content: messages.content,
      at: messages.at,
      sentAt: messages.sentAt,
      msgid: messages.msgid,
      turnId: messages.turnId,
      extra: messages.extra,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), lt(messages.seq, beforeSeq)))
    .orderBy(desc(messages.seq))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit).toReversed(), hasEarlier: rows.length > limit };
}

/** 预载与导出：这批会话 seq >= window_start_seq 的消息，按会话、seq 排序 */
export async function readWindowMessages(tx: Tx, conversationIds: readonly string[]): Promise<MessageRow[]> {
  if (!conversationIds.length) return [];
  return tx
    .select({
      conversationId: messages.conversationId,
      seq: messages.seq,
      role: messages.role,
      author: messages.author,
      authorUserId: messages.authorUserId,
      authorName: messages.authorName,
      content: messages.content,
      at: messages.at,
      sentAt: messages.sentAt,
      msgid: messages.msgid,
      turnId: messages.turnId,
      extra: messages.extra,
    })
    .from(messages)
    .innerJoin(conversations, and(eq(conversations.tenantId, messages.tenantId), eq(conversations.id, messages.conversationId)))
    .where(
      and(
        sql`${messages.conversationId} = any(${sql.param([...conversationIds])}::text[])`,
        gte(messages.seq, conversations.windowStartSeq),
      ),
    )
    .orderBy(asc(messages.conversationId), asc(messages.seq));
}
