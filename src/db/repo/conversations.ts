// 会话行（02 spec「数据库」「identity map 与写入」）：预载与导出的分批读，一次落库里「锁行 → 插消息 → 更新会话行」中会话行的几步。
// 只收发行的 TS 类型；Session 与行之间的投影在 src/store/project.ts。租户取 withTenant 的上下文
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { conversations } from '../schema.js';
import { readWindowMessages, type MessageRow } from './messages.js';
import { readLiveOrders, type OrderRow } from './orders.js';

/** 由 Session 投影出来、每次落库整行写入的列 */
export interface ConversationValues {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  handoffKind: string | null;
  handoffAt: Date | null;
  firstHandoffAt: Date | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  lastCustomerAt: Date | null;
  /** 会话对象去掉 messages 后的 JSON（经 normalizeForStore），键序原样 */
  state: Record<string, unknown>;
  createdAt: Date;
  /** = session.updatedAt；库里只进不退（触发器） */
  updatedAt: Date;
  /** 03 R11：session.channelAccountId 的投影，NULL 是渠道的默认账号。不给时插入写 NULL、更新不动这一列 */
  channelAccountId?: string | null;
}

/** seq 与落库的簿记列 */
export interface ConversationSeqs {
  lastSeq: number;
  windowStartSeq: number;
  flushId: string | null;
}

export interface ConversationRow extends ConversationValues, ConversationSeqs {
  /** 不含客户标识的引用（审计 target、日志） */
  ref: string;
}

const rowColumns = {
  id: conversations.id,
  ref: conversations.ref,
  channel: conversations.channel,
  stage: conversations.stage,
  handedOver: conversations.handedOver,
  handoffKind: conversations.handoffKind,
  handoffAt: conversations.handoffAt,
  firstHandoffAt: conversations.firstHandoffAt,
  assigneeUserId: conversations.assigneeUserId,
  assigneeName: conversations.assigneeName,
  lastCustomerAt: conversations.lastCustomerAt,
  lastSeq: conversations.lastSeq,
  windowStartSeq: conversations.windowStartSeq,
  state: conversations.state,
  flushId: conversations.flushId,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  channelAccountId: conversations.channelAccountId,
};

/** 预载与导出：按 id 分批，afterId（不含）之后的 limit 个；第一批传 null。走主键，批与批之间不重不漏 */
export async function readConversationsAfter(tx: Tx, afterId: string | null, limit: number): Promise<ConversationRow[]> {
  return tx
    .select(rowColumns)
    .from(conversations)
    .where(afterId === null ? undefined : gt(conversations.id, afterId))
    .orderBy(asc(conversations.id))
    .limit(limit);
}

/**
 * 这些会话 id 按 conversations.id 的排序（库的缺省排序规则，与 readConversationsAfter 的分页同序）排好。import-sessions 按它分批写入，
 * 库里本来没有会话时，每写完一批，上一批最后一个 id 之后的那一页正好就是这一批
 */
export async function orderLikeConversations(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`select u.id from unnest(${sql.param([...ids])}::text[]) as u(id) order by u.id`),
  );
  return rows.map((r) => r.id);
}

/** 启动预载与 import-sessions / export-sessions 读的一批：会话行、它们窗口内的消息（按会话、seq 排序）、未作废订单 */
export interface SessionBatch {
  rows: ConversationRow[];
  messages: MessageRow[];
  orders: OrderRow[];
}

/**
 * 预载与导入导出共用的读法（R2，不变量 14）：afterId（不含）之后按 id 的 limit 个会话，三条语句；没有会话行时只发第一条。
 * 重建在 src/store/project.ts 的 rebuildSessions、rowToOrder
 */
export async function readSessionBatch(tx: Tx, afterId: string | null, limit: number): Promise<SessionBatch> {
  const rows = await readConversationsAfter(tx, afterId, limit);
  if (!rows.length) return { rows, messages: [], orders: [] };
  const ids = rows.map((r) => r.id);
  const messages = await readWindowMessages(tx, ids);
  const orders = await readLiveOrders(tx, ids);
  return { rows, messages, orders };
}

/** 落库第 2 步：锁住这一行（SELECT … FOR UPDATE）；没有这一行返回 null */
export async function lockConversation(tx: Tx, id: string): Promise<ConversationSeqs | null> {
  const [row] = await tx
    .select({ lastSeq: conversations.lastSeq, windowStartSeq: conversations.windowStartSeq, flushId: conversations.flushId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .for('update');
  return row ?? null;
}

/**
 * 落库第 2 步「没有这一行就插入」：不给 seqs 时 last_seq = 0、window_start_seq = 1；导入一次写好时带上最终值。
 * ref 不给时由库生成（导入）；PG 后端给它建写队列时生成的那个（第 18 步：没提交过的新会话也有 ref）。
 * 返回这一行的 ref；这一行已经在了（主键冲突）返回 null、不报错，什么都不改：另一个事务插入还没提交时，插入在主键上
 * 等到它提交才返回，调用方接着 lockConversation 就看得见那一行（新会话第一次落库 COMMIT 断线之后的重试）
 */
export async function insertConversation(
  tx: Tx,
  row: ConversationValues & { ref?: string },
  seqs?: ConversationSeqs,
): Promise<{ ref: string } | null> {
  const { tenantId } = currentTenantCtx();
  const [out] = await tx
    .insert(conversations)
    .values({
      tenantId,
      ...row,
      lastSeq: seqs?.lastSeq ?? 0,
      windowStartSeq: seqs?.windowStartSeq ?? 1,
      flushId: seqs?.flushId ?? null,
    })
    .onConflictDoNothing({ target: [conversations.tenantId, conversations.id] })
    .returning({ ref: conversations.ref });
  return out ?? null;
}

/** 落库第 4 步：投影列、state、last_seq、window_start_seq、updated_at、flush_id 一起写；created_at 不动。返回是否改到了行 */
export async function updateConversation(tx: Tx, row: ConversationValues, seqs: ConversationSeqs): Promise<boolean> {
  const { tenantId } = currentTenantCtx();
  const { id, createdAt: _createdAt, ...values } = row;
  const out = await tx
    .update(conversations)
    .set({ ...values, lastSeq: seqs.lastSeq, windowStartSeq: seqs.windowStartSeq, flushId: seqs.flushId })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)))
    .returning({ id: conversations.id });
  return out.length === 1;
}
