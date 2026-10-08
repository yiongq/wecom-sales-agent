// 快捷回复（02 spec「后台接口」、plan 第 22 步）：增改、归档、上下移；不删，归档后不再列出
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { QuickReplyDefault } from '../../shared/quick-reply-defaults.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { quickReplies } from '../schema.js';

export interface QuickReplyRow {
  id: string;
  ord: number;
  title: string;
  body: string;
  archivedAt: Date | null;
  updatedByName: string | null;
  updatedAt: Date;
}

const columns = {
  id: quickReplies.id,
  ord: quickReplies.ord,
  title: quickReplies.title,
  body: quickReplies.body,
  archivedAt: quickReplies.archivedAt,
  updatedByName: quickReplies.updatedByName,
  updatedAt: quickReplies.updatedAt,
};
const live = isNull(quickReplies.archivedAt);

/** 没归档的，按 ord（相同时按 id）排序 */
export async function listQuickReplies(tx: Tx): Promise<QuickReplyRow[]> {
  return tx.select(columns).from(quickReplies).where(live).orderBy(asc(quickReplies.ord), asc(quickReplies.id));
}

/** 这个租户是不是一条快捷回复都没有过（含归档的，不止没归档的）：判断「空表」用（RLS 已经按租户过滤） */
export async function anyQuickReplyRow(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(quickReplies)
    .limit(1);
  return row !== undefined;
}

/**
 * 新租户首次读到空表时，按行业包默认模板写入（没有默认模板时什么都不做）；只写一次：并发的几次首次读都会调它，
 * 先抢同一把事务级 advisory 锁（按租户区分，锁到提交自动放），拿到锁以后再确认一遍真的还是空表才插——抢不到锁的
 * 等到拿到时表已经不空，原样返回，不会插出两份。调用方要用一条新的、可写的事务（listQuickReplies 的只读事务插不了）
 */
export async function ensureDefaultQuickReplies(tx: Tx, defaults: readonly QuickReplyDefault[]): Promise<void> {
  if (defaults.length === 0) return;
  const { tenantId } = currentTenantCtx();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`qr-seed:${tenantId}`}, 0))`);
  if (await anyQuickReplyRow(tx)) return;
  await tx.insert(quickReplies).values(defaults.map((d, i) => ({ tenantId, ord: i, title: d.title, body: d.body, updatedByName: null })));
}

/** 新建，排在最后 */
export async function createQuickReply(tx: Tx, q: { title: string; body: string; byName: string | null }): Promise<QuickReplyRow> {
  const { tenantId } = currentTenantCtx();
  const [max] = await tx.select({ n: sql<number>`coalesce(max(${quickReplies.ord}), -1)::int` }).from(quickReplies);
  const [row] = await tx
    .insert(quickReplies)
    .values({ tenantId, ord: (max?.n ?? -1) + 1, title: q.title, body: q.body, updatedByName: q.byName })
    .returning(columns);
  return row!;
}

/** 改标题与正文；已归档或不存在返回 null */
export async function updateQuickReply(
  tx: Tx,
  id: string,
  q: { title: string; body: string; byName: string | null },
): Promise<QuickReplyRow | null> {
  const [row] = await tx
    .update(quickReplies)
    .set({ title: q.title, body: q.body, updatedByName: q.byName, updatedAt: sql`now()` })
    .where(and(eq(quickReplies.id, id), live))
    .returning(columns);
  return row ?? null;
}

/** 归档；已归档或不存在返回 false */
export async function archiveQuickReply(tx: Tx, id: string, byName: string | null): Promise<boolean> {
  const out = await tx
    .update(quickReplies)
    .set({ archivedAt: sql`now()`, updatedByName: byName, updatedAt: sql`now()` })
    .where(and(eq(quickReplies.id, id), live))
    .returning({ id: quickReplies.id });
  return out.length === 1;
}

/**
 * 在没归档的里与上一条或下一条交换位置；已在最前（最后）、已归档或不存在返回 false。
 * 锁住整张列表，按交换后的顺序把 ord 重排成 0..n-1（并发新建可能留下相同的 ord，只换两个值换不动）
 */
export async function moveQuickReply(tx: Tx, id: string, dir: 'up' | 'down', byName: string | null): Promise<boolean> {
  const list = await tx
    .select({ id: quickReplies.id, ord: quickReplies.ord })
    .from(quickReplies)
    .where(live)
    .orderBy(asc(quickReplies.ord), asc(quickReplies.id))
    .for('update');
  const i = list.findIndex((r) => r.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j]!, list[i]!];
  for (const [ord, r] of list.entries()) {
    if (r.ord === ord && r.id !== id) continue;
    await tx
      .update(quickReplies)
      .set({ ord, ...(r.id === id ? { updatedByName: byName, updatedAt: sql`now()` } : {}) })
      .where(eq(quickReplies.id, r.id));
  }
  return true;
}
