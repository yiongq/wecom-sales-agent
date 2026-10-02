// 消息（02 spec「消息只追加」「identity map 与写入」）：只有批量插入与按窗口读。agent_app 对这张表没有 UPDATE、DELETE
import { and, asc, eq, gte, sql } from 'drizzle-orm';
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
