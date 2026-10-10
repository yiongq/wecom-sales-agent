// 入站记录（docs/architecture/03-channels-v2/spec.md「入站：channel_inbox」、R2、R3、不变量 2、8）：基本读写。
// acceptPage、load、beginAttempt 在 src/channels/inbox.ts，随会话落库的状态变化经 store 的 queueInboxState（第 9 步）。
// 状态只按 src/channels/transitions.ts 的迁移表往前走：库里这一行不是允许的出发状态（已结束、被清除、表外）时 UPDATE 命中 0 行，
// 当无操作；done、abandoned 的行另有触发器拦着。payload 是客户原文，调用方不打印
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { canMoveInbox, INBOX_FINISHED_STATES, INBOX_OPEN_STATES, inboxFromStates } from '../../channels/transitions.js';
import type { InboxAbandonReason, InboxKind, InboxState } from '../../shared/channel-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { channelInbox } from '../schema.js';

export interface InboxRecord {
  id: string;
  /** 插入顺序；派发与恢复都按它 */
  ord: number;
  accountId: string;
  msgid: string;
  kind: InboxKind;
  conversationId: string | null;
  sentAt: Date | null;
  receivedAt: Date;
  state: InboxState;
  reason: InboxAbandonReason | null;
  attempts: number;
  messageSeq: number | null;
  /** done、abandoned 时为 null */
  payload: unknown;
  updatedAt: Date;
}

export interface NewInboxRow {
  msgid: string;
  kind: InboxKind;
  /** 消息、菜单点击、回执、进入会话事件：id 前缀 + external_userid；只有 legacy 可以为空 */
  conversationId: string | null;
  sentAt: Date | null;
  /** 只能是迁移表里允许直接插入的：received、done、abandoned（带 reason） */
  state: InboxState;
  reason?: InboxAbandonReason | null;
  /** 缺省 0（R3：插入时不计次；channel-import 的在途按 02 的计数给） */
  attempts?: number;
  /** done、abandoned 一律写空 */
  payload?: unknown;
  /** 缺省是库的 now()；channel-import 的 legacy 行取记下的时间 */
  receivedAt?: Date;
}

const COLUMNS = {
  id: channelInbox.id,
  ord: channelInbox.ord,
  accountId: channelInbox.accountId,
  msgid: channelInbox.msgid,
  kind: channelInbox.kind,
  conversationId: channelInbox.conversationId,
  sentAt: channelInbox.sentAt,
  receivedAt: channelInbox.receivedAt,
  state: channelInbox.state,
  reason: channelInbox.reason,
  attempts: channelInbox.attempts,
  messageSeq: channelInbox.messageSeq,
  payload: channelInbox.payload,
  updatedAt: channelInbox.updatedAt,
};

/** reason 只跟着 abandoned（CHECK channel_inbox_reason_iff_abandoned）：对不上是调用方的错，不发 SQL */
function checkReason(state: InboxState, reason: InboxAbandonReason | null | undefined): InboxAbandonReason | null {
  if ((state === 'abandoned') !== (reason !== undefined && reason !== null)) {
    throw new Error(`channel_inbox: ${state} 与 reason ${reason ?? '空'} 不匹配（只有 abandoned 带 reason）`);
  }
  return reason ?? null;
}

/**
 * 按给定顺序插入一个账号的几条入站（ord 随之递增），同一（账号，msgid）已有的跳过（冲突即跳过，不变量 2）；
 * 返回真正新插入的行，按 ord。初始状态不在迁移表里（recorded、replied）的不插
 */
export async function insertInboxRows(tx: Tx, accountId: string, rows: readonly NewInboxRow[]): Promise<InboxRecord[]> {
  const ok = rows.filter((r) => canMoveInbox(null, r.state));
  if (!ok.length) return [];
  const { tenantId } = currentTenantCtx();
  const finished = (s: InboxState): boolean => INBOX_FINISHED_STATES.includes(s);
  const out = await tx
    .insert(channelInbox)
    .values(
      ok.map((r) => ({
        tenantId,
        accountId,
        msgid: r.msgid,
        kind: r.kind,
        conversationId: r.conversationId,
        sentAt: r.sentAt,
        state: r.state,
        reason: checkReason(r.state, r.reason),
        attempts: r.attempts ?? 0,
        payload: finished(r.state) ? null : (r.payload ?? null),
        ...(r.receivedAt !== undefined ? { receivedAt: r.receivedAt } : {}),
      })),
    )
    .onConflictDoNothing({ target: [channelInbox.tenantId, channelInbox.accountId, channelInbox.msgid] })
    .returning(COLUMNS);
  return out.toSorted((a, b) => a.ord - b.ord) as InboxRecord[];
}

/**
 * 一行入站的状态变化（R3）：库里这一行的状态是迁移表里迁到 change.state 的出发状态之一才改；命中 0 行（已结束、被清除、表外）
 * 返回 false，当无操作。messageSeq 给了才写；迁到 done、abandoned 时同一条语句把 payload 置空
 */
export async function setInboxState(
  tx: Tx,
  id: string,
  change: { state: InboxState; reason?: InboxAbandonReason; messageSeq?: number },
): Promise<boolean> {
  const reason = checkReason(change.state, change.reason);
  const from = inboxFromStates(change.state).filter((x): x is InboxState => x !== null);
  if (!from.length) return false;
  const out = await tx
    .update(channelInbox)
    .set({
      state: change.state,
      reason,
      ...(change.messageSeq !== undefined ? { messageSeq: change.messageSeq } : {}),
      ...(INBOX_FINISHED_STATES.includes(change.state) ? { payload: null } : {}),
    })
    .where(and(eq(channelInbox.id, id), inArray(channelInbox.state, from)))
    .returning({ id: channelInbox.id });
  return out.length === 1;
}

/**
 * 随会话落库（或单独短事务）写的一次入站状态变化（R3、R21）：会话写队列、spill（第 11 步）与短事务都用这一个形状，只有 JSON 能装的值
 */
export interface InboxStateWrite {
  inboxId: string;
  state: InboxState;
  /** 只跟着 abandoned */
  reason: InboxAbandonReason | null;
  /** recorded 时是这条客户消息分到的 seq；不写这一列为 null */
  messageSeq: number | null;
}

/**
 * 按给定顺序逐条写几次入站状态变化（同一行在同一批里的几次变化按先后各写一次：先 recorded 再 replied）。
 * 每条只按迁移表改（库里不是允许的出发状态就是无操作，会话与它的入站行被清除了也是无操作）；返回改中了几条
 */
export async function applyInboxStates(tx: Tx, writes: readonly InboxStateWrite[]): Promise<number> {
  let n = 0;
  for (const w of writes) {
    const ok = await setInboxState(tx, w.inboxId, {
      state: w.state,
      ...(w.reason !== null ? { reason: w.reason } : {}),
      ...(w.messageSeq !== null ? { messageSeq: w.messageSeq } : {}),
    });
    if (ok) n += 1;
  }
  return n;
}

/**
 * 出队开始处理（R3 的计次）：没结束的行 attempts 加 1，返回加之后的值；行不在或已结束返回 null。
 * 给了 expected（出队时读到的 attempts）时只在库里还是这个值时加（同一次出队的计次幂等，第 9 步评审）：没加上而库里已经比它大
 * （上一次加 1 其实提交了、只是回包丢了，调用方重试到这里）返回库里的值，不再加；行不在、已结束、或库里反而比它小返回 null
 */
export async function bumpInboxAttempts(tx: Tx, id: string, expected?: number): Promise<number | null> {
  const open = and(eq(channelInbox.id, id), inArray(channelInbox.state, [...INBOX_OPEN_STATES]));
  const out = await tx
    .update(channelInbox)
    .set({ attempts: sql`${channelInbox.attempts} + 1` })
    .where(expected === undefined ? open : and(open, eq(channelInbox.attempts, expected)))
    .returning({ attempts: channelInbox.attempts });
  if (out[0] || expected === undefined) return out[0]?.attempts ?? null;
  const [cur] = await tx.select({ attempts: channelInbox.attempts }).from(channelInbox).where(open);
  return cur && cur.attempts > expected ? cur.attempts : null;
}

/** 启动：这个账号没结束的行（received、recorded、replied），按 ord */
export async function readOpenInbox(tx: Tx, accountId: string): Promise<InboxRecord[]> {
  const rows = await tx
    .select(COLUMNS)
    .from(channelInbox)
    .where(and(eq(channelInbox.accountId, accountId), inArray(channelInbox.state, [...INBOX_OPEN_STATES])))
    .orderBy(asc(channelInbox.ord));
  return rows as InboxRecord[];
}

/** 渠道迁移工具：按 ord 读这个账号的入站（包括只用于去重的 legacy）。 */
export async function readAccountInbox(tx: Tx, accountId: string): Promise<InboxRecord[]> {
  return (await tx
    .select(COLUMNS)
    .from(channelInbox)
    .where(eq(channelInbox.accountId, accountId))
    .orderBy(asc(channelInbox.ord))) as InboxRecord[];
}

/** --resync 只替换未结束行的原文与计次，保留状态、seq 与 ord；终态的任何 UPDATE 都不发。 */
export async function resyncInboxPayload(tx: Tx, id: string, payload: unknown, attempts: number): Promise<boolean> {
  const rows = await tx
    .update(channelInbox)
    .set({ payload, attempts })
    .where(and(eq(channelInbox.id, id), inArray(channelInbox.state, [...INBOX_OPEN_STATES])))
    .returning({ id: channelInbox.id });
  return rows.length === 1;
}

/**
 * restore-cutoff（03 R7）：本租户没结束、`sent_at` 不晚于截止点的客户消息与菜单点击（启动时只补记、不回复的那几条），
 * 只要种类与会话 id。不读 payload
 */
export async function readOpenInboxUntil(tx: Tx, until: Date): Promise<{ kind: InboxKind; conversationId: string | null }[]> {
  return (await tx
    .select({ kind: channelInbox.kind, conversationId: channelInbox.conversationId })
    .from(channelInbox)
    .where(
      and(
        inArray(channelInbox.state, [...INBOX_OPEN_STATES]),
        inArray(channelInbox.kind, ['message', 'menu_click']),
        sql`${channelInbox.sentAt} <= ${until.toISOString()}::timestamptz`,
      ),
    )) as { kind: InboxKind; conversationId: string | null }[];
}

/** 每账号未结束入站的计数与最早收到时刻；不读取 payload 或会话标识。 */
export async function readInboxStats(tx: Tx): Promise<{ accountId: string; openInbox: number; oldestAt: Date | null }[]> {
  return tx
    .select({
      accountId: channelInbox.accountId,
      openInbox: sql<number>`count(*)::int`,
      oldestAt: sql<Date | null>`min(${channelInbox.receivedAt})`.mapWith(channelInbox.receivedAt),
    })
    .from(channelInbox)
    .where(inArray(channelInbox.state, [...INBOX_OPEN_STATES]))
    .groupBy(channelInbox.accountId);
}
