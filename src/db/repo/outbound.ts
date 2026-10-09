// 企微发送账本（02 spec「企微：发送账本、回执与去重」；03 spec「出站：投递状态」、R4、不变量 7）。
// 02：账本在内存里，落库时写行；收到 msg_send_fail 按 msgid 改状态。03：库里的账号先落 pending 再发，每段先标 sending。
// 所有写入（会话落库的 upsert、各个短事务）都按 src/channels/transitions.ts 的迁移表生成同一种 WHERE：表外的写入什么都不改、
// 不报错，晚到的写入盖不回终态。env 账号与 02 留下的行照 02 只写四种结果，它们的每一种变化都在表里
import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import {
  canMoveOutbound,
  OUTBOUND_KEEPS_PAYLOAD,
  OUTBOUND_TRANSITIONS,
  outboundFromStates,
  type OutboundWriter,
} from '../../channels/transitions.js';
import type { OutboundStatus } from '../../shared/channel-types.js';
import type { OutboundKind } from '../../shared/conversation-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { conversations, messages, outboundSends } from '../schema.js';

/**
 * 读出的一行（预载、后台「看更早的消息」）。env 账号与 02 留下的行只有四种结果、account_id 为空；库里账号的行（第 8 步起）
 * 带账号 uuid，状态是 03 的七种之一（内存账本据 accountId 认出是哪种账号的行，03 spec「出站：投递状态」的映射表）
 */
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
  /** 库里的企微账号；02 的行与 env 账号为 null */
  accountId: string | null;
}

/** 写入的一行：02 的列加 03 的几列。03 的列不给就是 02 的写法（account_id、inbox_id、payload 为空，segment、attempts 为 0） */
export interface OutboundWriteRow extends Omit<OutboundSendRow, 'status' | 'accountId'> {
  status: OutboundStatus;
  accountId?: string | null;
  inboxId?: string | null;
  segment?: number;
  attempts?: number;
  /** 只在 pending 时写进去；别的状态一律写空（CHECK 与不变量 7） */
  payload?: unknown;
}

/** 库里没结果的一行（pending、sending）：启动恢复用，带 02 的预载不读的几列 */
export interface OpenOutboundRow extends Omit<OutboundSendRow, 'status'> {
  status: 'pending' | 'sending';
  inboxId: string | null;
  segment: number;
  attempts: number;
  payload: unknown;
}

/**
 * 经会话落库写的几类（R21：主事务里的 pending 插入与 cancelled、存档点里的结果；没有会话时、poisoned 之后的短事务与 spill 回放
 * 也走同一个函数）。不含 mark、unmark、recover：sending 只由 markSending 的短事务写，迁回 pending、恢复与导出各有自己的语句
 */
export const FLUSH_WRITERS: readonly OutboundWriter[] = ['plan', 'settle', 'cancel', 'receipt'];

/** 迁移表里的状态作为绑定参数进 SQL（显式标成 text，PGlite 与 node-postgres 推断一致） */
const lit = (s: string): SQL => sql`${s}::text`;
const litList = (xs: readonly string[]): SQL =>
  sql.join(
    xs.map((x) => lit(x)),
    sql`, `,
  );

/** 已有的行 → excluded 的那一格在不在 writers 的迁移表里：(status, excluded.status) in ((from, to), …) */
function conflictWhere(writers: readonly OutboundWriter[]): SQL {
  const pairs = OUTBOUND_TRANSITIONS.filter((t) => t.from !== null && t.by.some((w) => writers.includes(w)));
  if (!pairs.length) return sql`false`;
  return sql`(${outboundSends.status}, excluded.status) in (${sql.join(
    pairs.map((t) => sql`(${lit(t.from!)}, ${lit(t.to)})`),
    sql`, `,
  )})`;
}

/** 迁到 to 之前库里这一行必须是哪几种；只能插入、或根本不在表里时返回 null（这条 UPDATE 不用发） */
function fromWhere(to: OutboundStatus, writers: readonly OutboundWriter[]): SQL | null {
  const from = outboundFromStates(to, writers).filter((f): f is OutboundStatus => f !== null);
  return from.length ? sql`${outboundSends.status} in (${litList(from)})` : null;
}

const keepsPayload = (s: OutboundStatus): boolean => OUTBOUND_KEEPS_PAYLOAD.includes(s);

/**
 * 写账本行（会话落库与没有会话时的短事务）。同一个 msgid 再写一次是同一分段的后续（02：超时那一刻先记 unknown，之后重试成功升
 * accepted、最后一次尝试的时刻往后挪，或收到回执记 failed；03：pending 之后的结果、取消）：按 (tenant_id, channel_msgid) upsert，
 * 仍是一行（02 不变量 33）。库里已有的行只按迁移表（FLUSH_WRITERS 的格子）变，表外的不改状态与结果：pending 遇到已有的行不改、
 * 终态不回退；唯一的例外是 message_seq 从 NULL 补成值（不算状态变化，终态行也补）。没有这一行时只插入表里允许直接插入的状态（pending、三种结果、failed）；cancelled、sending 只能改已有的行。
 * sent_at、attempts 只往大里改。同一批里同一 msgid 的几次写按先后分轮写（一条 ON CONFLICT 不能改同一行两次），每一次都按迁移表判
 */
export async function insertOutboundSends(tx: Tx, rows: readonly OutboundWriteRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  const rounds: OutboundWriteRow[][] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = seen.get(r.channelMsgid) ?? 0;
    seen.set(r.channelMsgid, k + 1);
    (rounds[k] ??= []).push(r);
  }
  // 已有的行 → excluded 的那一格在不在迁移表里（只有在表里时状态与结果才改）
  const moved = conflictWhere(FLUSH_WRITERS);
  for (const round of rounds) {
    const inserts = round.filter((r) => canMoveOutbound(null, r.status, FLUSH_WRITERS));
    if (inserts.length) {
      await tx
        .insert(outboundSends)
        .values(
          inserts.map((r) => ({
            tenantId,
            conversationId: r.conversationId,
            channelMsgid: r.channelMsgid,
            messageSeq: r.messageSeq,
            kind: r.kind,
            sentAt: r.sentAt,
            status: r.status,
            errcode: r.errcode,
            failType: r.failType,
            accountId: r.accountId ?? null,
            inboxId: r.inboxId ?? null,
            segment: r.segment ?? 0,
            attempts: r.attempts ?? 0,
            payload: keepsPayload(r.status) ? (r.payload ?? null) : null,
          })),
        )
        .onConflictDoUpdate({
          target: [outboundSends.tenantId, outboundSends.channelMsgid],
          // 两件事分开判：状态迁移只按迁移表（moved）；message_seq 只从 NULL 补成值（03：pending 落库时对应的消息可能还没写进会话——
          // 跟进、引导提示送达之后才写——结果行带上 seq 时补上）。补 seq 不是状态变化：终态行（如回执先到记了 failed）也补，但状态、
          // 结果、payload 都不动，已有的 seq 不改。所以迁移表一格都没放宽（不变量 7）
          set: {
            status: sql`case when ${moved} then excluded.status else ${outboundSends.status} end`,
            errcode: sql`case when ${moved} then excluded.errcode else ${outboundSends.errcode} end`,
            failType: sql`case when ${moved} then excluded.fail_type else ${outboundSends.failType} end`,
            sentAt: sql`case when ${moved} then greatest(${outboundSends.sentAt}, excluded.sent_at) else ${outboundSends.sentAt} end`,
            attempts: sql`case when ${moved} then greatest(${outboundSends.attempts}, excluded.attempts) else ${outboundSends.attempts} end`,
            messageSeq: sql`coalesce(${outboundSends.messageSeq}, excluded.message_seq)`,
            payload: sql`case when ${moved} then (case when excluded.status in (${litList(OUTBOUND_KEEPS_PAYLOAD)}) then ${outboundSends.payload} else null end) else ${outboundSends.payload} end`,
          },
          setWhere: sql`(${moved}) or (${outboundSends.messageSeq} is null and excluded.message_seq is not null)`,
        });
    }
    for (const r of round) {
      if (inserts.includes(r)) continue;
      await transitionOutbound(tx, r.channelMsgid, r.status, FLUSH_WRITERS, {
        errcode: r.errcode,
        failType: r.failType,
        sentAt: r.sentAt,
        attempts: r.attempts,
      });
    }
  }
}

/**
 * 按 msgid 把一行迁到 to（短事务里用：markSending、迁回 pending、取消、恢复、导出、回执）。只在库里这一行的状态是 by 这几个写入方
 * 在迁移表里允许的出发状态时才改；表外的、行不在的都什么都不改，返回 null。改中了返回那一行的会话 id。
 * 迁到不留 payload 的状态时同一条语句把 payload 置空；errcode、failType 给了才写；sentAt、attempts 只往大里改
 */
export async function transitionOutbound(
  tx: Tx,
  channelMsgid: string,
  to: OutboundStatus,
  by: OutboundWriter | readonly OutboundWriter[],
  fields: { errcode?: number | null; failType?: number | null; sentAt?: Date; attempts?: number } = {},
): Promise<string | null> {
  const where = fromWhere(to, typeof by === 'string' ? [by] : by);
  if (!where) return null;
  const out = await tx
    .update(outboundSends)
    .set({
      status: to,
      ...(keepsPayload(to) ? {} : { payload: null }),
      ...(fields.errcode !== undefined ? { errcode: fields.errcode } : {}),
      ...(fields.failType !== undefined ? { failType: fields.failType } : {}),
      ...(fields.sentAt !== undefined
        ? { sentAt: sql`greatest(${outboundSends.sentAt}, ${fields.sentAt.toISOString()}::timestamptz)` }
        : {}),
      ...(fields.attempts !== undefined ? { attempts: sql`greatest(${outboundSends.attempts}, ${fields.attempts})` } : {}),
    })
    .where(and(eq(outboundSends.channelMsgid, channelMsgid), where))
    .returning({ conversationId: outboundSends.conversationId });
  return out[0]?.conversationId ?? null;
}

/**
 * markSending 的库里那一步（R4）：pending → sending。没改中时同一事务再看这一行在不在：not_pending（在、已不是 pending：
 * 被取消、已有结果）不发；absent（库里没有这一行）由调用方按这一组的 commitOutbound 结果判。库不可用由调用方的 catch 判
 */
export async function markOutboundSending(tx: Tx, channelMsgid: string): Promise<'marked' | 'not_pending' | 'absent'> {
  if ((await transitionOutbound(tx, channelMsgid, 'sending', 'mark')) !== null) return 'marked';
  const [row] = await tx
    .select({ status: outboundSends.status })
    .from(outboundSends)
    .where(eq(outboundSends.channelMsgid, channelMsgid))
    .limit(1);
  return row ? 'not_pending' : 'absent';
}

/**
 * 后台「看更早的消息」（02 第 13 步）：这个会话里对应这几条消息（message_seq）的账本行，J 页据此写没送达的原因。按消息、段号排：
 * 同一条消息几段都没送达时，原因码取段号最小的那一段（不排序时取哪一段看库里行的物理顺序，结果不稳定）
 */
export async function readOutboundForSeqs(tx: Tx, conversationId: string, seqs: readonly number[]): Promise<OutboundSendRow[]> {
  if (!seqs.length) return [];
  const rows = await tx
    .select({
      conversationId: outboundSends.conversationId,
      channelMsgid: outboundSends.channelMsgid,
      messageSeq: outboundSends.messageSeq,
      kind: outboundSends.kind,
      sentAt: outboundSends.sentAt,
      status: outboundSends.status,
      errcode: outboundSends.errcode,
      failType: outboundSends.failType,
      accountId: outboundSends.accountId,
    })
    .from(outboundSends)
    .where(and(eq(outboundSends.conversationId, conversationId), sql`${outboundSends.messageSeq} = any(${sql.param([...seqs])}::int[])`))
    .orderBy(outboundSends.messageSeq, outboundSends.segment, outboundSends.sentAt);
  return rows as OutboundSendRow[];
}

/**
 * 按 msgid 改状态，只走迁移表里的格子（不指定写入方时表里任何写入方的格子都算）；errcode、failType 不给就不动。
 * 返回是否改到了这一行
 */
export async function setOutboundStatus(
  tx: Tx,
  channelMsgid: string,
  status: OutboundStatus,
  opts: { errcode?: number | null; failType?: number | null; by?: readonly OutboundWriter[] } = {},
): Promise<boolean> {
  const by = opts.by ?? [...new Set(OUTBOUND_TRANSITIONS.flatMap((t) => t.by))];
  return (await transitionOutbound(tx, channelMsgid, status, by, { errcode: opts.errcode, failType: opts.failType })) !== null;
}

/**
 * 收到 msg_send_fail（02 第 12 步）：按迁移表把那一行记 failed 与 fail_type（pending、sending、accepted、unknown 才改；
 * failed 之后任何写入都不改它）。返回那一行的会话 id；找不到、或表外（已是 failed、rejected、cancelled）返回 null，
 * 调用方据此不重复给会话加说明
 */
export async function markOutboundFailed(tx: Tx, channelMsgid: string, failType: number): Promise<string | null> {
  return transitionOutbound(tx, channelMsgid, 'failed', 'receipt', { failType });
}

/**
 * 预载（第 12 步）：这批会话里、各自最后一条客户消息之后的发送，按会话、时间排。发送窗口与重放对齐只看这一段；没有客户消息的会话
 * （last_customer_at 为空）窗口本来就没开，不读。「之后」与内存的账本同一个口径：从 last_customer_at（企微 send_time）与这条客户消息
 * 本机收到的时刻（messages.at）里较早的一个算起，本机钟比企微慢时也读得全
 */
export async function readOutboundAfterLastCustomer(tx: Tx, conversationIds: readonly string[]): Promise<OutboundSendRow[]> {
  if (!conversationIds.length) return [];
  const lastCustomerLocalAt = sql`select ${messages.at} from ${messages} where ${messages.tenantId} = ${outboundSends.tenantId} and ${messages.conversationId} = ${outboundSends.conversationId} and ${messages.role} = 'customer' order by ${messages.seq} desc limit 1`;
  const rows = await tx
    .select({
      conversationId: outboundSends.conversationId,
      channelMsgid: outboundSends.channelMsgid,
      messageSeq: outboundSends.messageSeq,
      kind: outboundSends.kind,
      sentAt: outboundSends.sentAt,
      status: outboundSends.status,
      errcode: outboundSends.errcode,
      failType: outboundSends.failType,
      accountId: outboundSends.accountId,
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
    .orderBy(outboundSends.conversationId, outboundSends.sentAt, outboundSends.segment);
  return rows as OutboundSendRow[];
}

/**
 * 启动恢复的保底（03「渠道行与会话落库（R21）」：received 的行名下已有出站行的按 replied 处理）：这几条入站名下的出站行，
 * 任何状态，只要 inbox_id 与状态
 */
export async function readOutboundOfInboxes(
  tx: Tx,
  inboxIds: readonly string[],
): Promise<{ inboxId: string; channelMsgid: string; status: OutboundStatus }[]> {
  if (!inboxIds.length) return [];
  const rows = await tx
    .select({ inboxId: outboundSends.inboxId, channelMsgid: outboundSends.channelMsgid, status: outboundSends.status })
    .from(outboundSends)
    .where(inArray(outboundSends.inboxId, [...inboxIds]));
  return rows as { inboxId: string; channelMsgid: string; status: OutboundStatus }[];
}

/**
 * 启动恢复（03「重启、崩溃与恢复」）：这个账号没结果的出站行（pending、sending），带 payload、segment、inbox_id；
 * 按建这一行的时刻、段号排。accountId 为 null 时读 02 的默认账号的行（account_id 为空）
 */
export async function readOpenOutbound(tx: Tx, accountId: string | null): Promise<OpenOutboundRow[]> {
  const rows = await tx
    .select({
      conversationId: outboundSends.conversationId,
      channelMsgid: outboundSends.channelMsgid,
      messageSeq: outboundSends.messageSeq,
      kind: outboundSends.kind,
      sentAt: outboundSends.sentAt,
      status: outboundSends.status,
      errcode: outboundSends.errcode,
      failType: outboundSends.failType,
      accountId: outboundSends.accountId,
      inboxId: outboundSends.inboxId,
      segment: outboundSends.segment,
      attempts: outboundSends.attempts,
      payload: outboundSends.payload,
    })
    .from(outboundSends)
    .where(
      and(
        accountId === null ? sql`${outboundSends.accountId} is null` : eq(outboundSends.accountId, accountId),
        inArray(outboundSends.status, ['pending', 'sending']),
      ),
    )
    .orderBy(outboundSends.sentAt, outboundSends.segment);
  return rows as OpenOutboundRow[];
}

/** 非文本重放不查出站账本；只要名下存在任何出站，导出就无法保证不会重复发送。 */
export async function hasOutboundForInboxIds(tx: Tx, accountId: string, inboxIds: string[]): Promise<boolean> {
  if (!inboxIds.length) return false;
  const rows = await tx
    .select({ inboxId: outboundSends.inboxId })
    .from(outboundSends)
    .where(and(eq(outboundSends.accountId, accountId), sql`${outboundSends.inboxId} = any(${sql.param(inboxIds)}::uuid[])`))
    .limit(1);
  return rows.length !== 0;
}

/** 导出前检查部分送达：同一入站有 pending 又有可能已送达的段时，02 无法补完。 */
export async function hasPartlyDeliveredOutbound(tx: Tx, accountId: string): Promise<boolean> {
  const rows = await tx
    .select({ inboxId: outboundSends.inboxId })
    .from(outboundSends)
    .where(and(eq(outboundSends.accountId, accountId), sql`${outboundSends.inboxId} is not null`))
    .groupBy(outboundSends.inboxId)
    .having(sql`bool_or(${outboundSends.status} = 'pending') and bool_or(${outboundSends.status} in ('accepted', 'unknown', 'sending'))`)
    .limit(1);
  return rows.length !== 0;
}
