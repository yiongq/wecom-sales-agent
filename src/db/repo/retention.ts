// 保留期清理与行权删除（docs/architecture/02-conversations-workbench/spec.md「隐私说明、敏感信息同意、保留期与行权」「数据库」，R23）。
// 四个 SQL 函数（drizzle/0003_conversations_rls.sql，第 4 步已建好）的 TS 包装：purge_conversation、purge_expired_traces、
// purge_finished_jobs 只 GRANT 给 agent_app；erase_conversation 只 GRANT 给 agent_platform。都要求调用者已在 withTenant 里。
// 03（drizzle/0005_channels_rls.sql）：purge_conversation、erase_conversation 的删除范围加 channel_inbox、erase 的返回值加 inbox；
// 新函数 purge_channel_inbox 只 GRANT 给 agent_app
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { conversations, tenants } from '../schema.js';

export interface RetentionSettings {
  leadDays: number;
  customerDays: number;
}

/** 这个租户的线索与客户保留期（天）：retention_purge 任务算候选截止时间、逐个再核时用 */
export async function readRetentionSettings(tx: Tx): Promise<RetentionSettings> {
  const { tenantId } = currentTenantCtx();
  const [row] = await tx
    .select({ leadDays: tenants.retentionLeadDays, customerDays: tenants.retentionCustomerDays })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new Error('retention_purge：租户不存在');
  return row;
}

/** 候选会话的一页：按 id 排序、updated_at 早于 cutoff 的。真正是否到期由 purge_conversation 内部按租户的保留期与 paid_at 再判一次，
 *  这里只给一个保守的候选集（取 cutoff = 两个保留期里较短的那个），不精确也没关系 */
export async function readPurgeCandidates(
  tx: Tx,
  cutoff: Date,
  afterId: string | null,
  limit: number,
): Promise<{ id: string; lastSeq: number; updatedAt: Date }[]> {
  return tx
    .select({ id: conversations.id, lastSeq: conversations.lastSeq, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(lt(conversations.updatedAt, cutoff), afterId === null ? undefined : gt(conversations.id, afterId)))
    .orderBy(asc(conversations.id))
    .limit(limit);
}

/**
 * 清理一个会话（agent_app）：库里的 last_seq、updated_at 与两个预期值不符，或还没到期，返回 false（库不变）；
 * 否则删除会话（级联消息、trace、护栏事件、同意记录）、按 id 删发送账本与 payload 里 sessionId 是它的任务，
 * 订单 session_id 置空并去掉 data 里的 sessionId，返回 true
 */
export async function purgeConversation(tx: Tx, id: string, now: Date, expectedLastSeq: number, expectedUpdatedAt: Date): Promise<boolean> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ ok: boolean }>(
    await tx.execute(
      sql`select purge_conversation(${tenantId}::uuid, ${id}, ${now.toISOString()}::timestamptz, ${expectedLastSeq}, ${expectedUpdatedAt.toISOString()}::timestamptz) as ok`,
    ),
  );
  return r?.ok === true;
}

/** 删过期的 trace（级联护栏事件）与没有对应会话的过期发送账本行；返回删除条数之和 */
export async function purgeExpiredTraces(tx: Tx, now: Date): Promise<number> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ n: number }>(
    await tx.execute(sql`select purge_expired_traces(${tenantId}::uuid, ${now.toISOString()}::timestamptz) as n`),
  );
  return r?.n ?? 0;
}

/**
 * 入站记录（03 R2）：删结束了 7 天的（done、abandoned，按 updated_at）；收到超过 7 天还没结束的记 abandoned（too_old）、清掉原文。
 * 返回两类条数之和
 */
export async function purgeChannelInbox(tx: Tx, now: Date): Promise<number> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ n: number }>(
    await tx.execute(sql`select purge_channel_inbox(${tenantId}::uuid, ${now.toISOString()}::timestamptz) as n`),
  );
  return r?.n ?? 0;
}

/** 删 30 天前的已结束任务（done、cancelled、abandoned、failed）；返回删除条数 */
export async function purgeFinishedJobs(tx: Tx, now: Date): Promise<number> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ n: number }>(
    await tx.execute(sql`select purge_finished_jobs(${tenantId}::uuid, ${now.toISOString()}::timestamptz) as n`),
  );
  return r?.n ?? 0;
}

export interface EraseCounts {
  conversations: number;
  messages: number;
  traces: number;
  guardEvents: number;
  consents: number;
  outboundSends: number;
  orders: number;
  jobs: number;
  /** 03：channel_inbox 里这个会话的入站行 */
  inbox: number;
}

/** 行权删除（agent_platform）：不看保留期，删除范围与 purgeConversation 相同；写一行 platform.erase 审计；返回各类条数 */
export async function eraseConversation(tx: Tx, id: string, reason: string): Promise<EraseCounts> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ counts: EraseCounts }>(
    await tx.execute(sql`select erase_conversation(${tenantId}::uuid, ${id}, ${reason}) as counts`),
  );
  if (!r) throw new Error('erase_conversation 没有返回结果');
  return r.counts;
}
