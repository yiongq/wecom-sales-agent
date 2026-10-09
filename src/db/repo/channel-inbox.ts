// 入站记录（docs/architecture/03-channels-v2/spec.md「入站：channel_inbox」、R2、R3、不变量 2、8）：本步只有基本读写，
// acceptPage、load、beginAttempt 与随会话落库的状态变化在 src/channels/inbox.ts 与 store（第 9 步）。
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

/** 出队开始处理（R3 的计次）：没结束的行 attempts 加 1，返回加之后的值；行不在或已结束返回 null */
export async function bumpInboxAttempts(tx: Tx, id: string): Promise<number | null> {
  const out = await tx
    .update(channelInbox)
    .set({ attempts: sql`${channelInbox.attempts} + 1` })
    .where(and(eq(channelInbox.id, id), inArray(channelInbox.state, [...INBOX_OPEN_STATES])))
    .returning({ attempts: channelInbox.attempts });
  return out[0]?.attempts ?? null;
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
