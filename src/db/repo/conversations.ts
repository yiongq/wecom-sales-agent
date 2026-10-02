// 会话行（02 spec「数据库」「identity map 与写入」）：预载与导出的分批读，一次落库里「锁行 → 插消息 → 更新会话行」中会话行的几步。
// 只收发行的 TS 类型；Session 与行之间的投影在 src/store/project.ts。租户取 withTenant 的上下文
import { and, asc, eq, gt } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { conversations } from '../schema.js';

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
 * 返回库里生成的 ref；这一行已经在了（主键冲突）返回 null、不报错，什么都不改：另一个事务插入还没提交时，插入在主键上
 * 等到它提交才返回，调用方接着 lockConversation 就看得见那一行（新会话第一次落库 COMMIT 断线之后的重试）
 */
export async function insertConversation(tx: Tx, row: ConversationValues, seqs?: ConversationSeqs): Promise<{ ref: string } | null> {
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
