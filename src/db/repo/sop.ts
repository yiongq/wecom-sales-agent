// SOP 版本的数据访问（spec「版本与发布」）。只收发领域类型；事务、租户与配置写锁由调用方负责
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { sopVersions, type RenderInputs, type SopSectionRow } from '../schema.js';

export interface SopVersionRow {
  id: string;
  versionNo: number | null;
  status: 'draft' | 'published' | 'archived' | 'discarded';
  source: 'import' | 'console' | 'rollback' | 'rerender';
  packId: string;
  sections: SopSectionRow[];
  basedOn: string | null;
  rev: number;
  renderedPrompt: string | null;
  promptHash: string | null;
  toolsHash: string | null;
  prefixHash: string | null;
  sopHash: string | null;
  renderInputs: RenderInputs | null;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: Date;
  publishedByName: string | null;
  publishedAt: Date | null;
}

const columns = {
  id: sopVersions.id,
  versionNo: sopVersions.versionNo,
  status: sopVersions.status,
  source: sopVersions.source,
  packId: sopVersions.packId,
  sections: sopVersions.sections,
  basedOn: sopVersions.basedOn,
  rev: sopVersions.rev,
  renderedPrompt: sopVersions.renderedPrompt,
  promptHash: sopVersions.promptHash,
  toolsHash: sopVersions.toolsHash,
  prefixHash: sopVersions.prefixHash,
  sopHash: sopVersions.sopHash,
  renderInputs: sopVersions.renderInputs,
  changeNote: sopVersions.changeNote,
  createdByName: sopVersions.createdByName,
  createdAt: sopVersions.createdAt,
  publishedByName: sopVersions.publishedByName,
  publishedAt: sopVersions.publishedAt,
};

export async function readPublishedSop(tx: Tx): Promise<SopVersionRow | null> {
  const [row] = await tx.select(columns).from(sopVersions).where(eq(sopVersions.status, 'published'));
  return row ?? null;
}

export async function countSopVersions(tx: Tx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(sopVersions);
  return row?.n ?? 0;
}

export interface NewPublishedSop {
  tenantId: string;
  versionNo: number;
  source: 'import' | 'rollback' | 'rerender';
  packId: string;
  sections: SopSectionRow[];
  basedOn: string | null;
  renderedPrompt: string;
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
  renderInputs: RenderInputs;
  changeNote: string | null;
  createdBy: string | null;
  createdByName: string | null;
}

/** 直接写入一个已发布版本（导入、回滚、启动重渲染）。当前的已发布版本要先归档，否则撞部分唯一索引 */
export async function insertPublishedSop(tx: Tx, v: NewPublishedSop): Promise<SopVersionRow> {
  const [row] = await tx
    .insert(sopVersions)
    .values({
      ...v,
      status: 'published',
      publishedBy: v.createdBy,
      publishedByName: v.createdByName,
      publishedAt: sql`now()`,
    })
    .returning(columns);
  return row!;
}

/** 当前草稿，不加锁（只读事务里用：READ ONLY 事务不许 FOR UPDATE） */
export async function readDraft(tx: Tx): Promise<SopVersionRow | null> {
  const [row] = await tx.select(columns).from(sopVersions).where(eq(sopVersions.status, 'draft'));
  return row ?? null;
}

/** 当前草稿并加行锁（发布、丢弃、保存都先锁住它，同一份草稿的写入串行） */
export async function readDraftForUpdate(tx: Tx): Promise<SopVersionRow | null> {
  const [row] = await tx.select(columns).from(sopVersions).where(eq(sopVersions.status, 'draft')).for('update');
  return row ?? null;
}

export async function readVersionById(tx: Tx, id: string): Promise<SopVersionRow | null> {
  const [row] = await tx.select(columns).from(sopVersions).where(eq(sopVersions.id, id));
  return row ?? null;
}

/** 该租户的导入版本：可编辑节预算的基线 */
export async function readImportVersion(tx: Tx): Promise<SopVersionRow | null> {
  const [row] = await tx
    .select(columns)
    .from(sopVersions)
    .where(eq(sopVersions.source, 'import'))
    .orderBy(asc(sopVersions.versionNo))
    .limit(1);
  return row ?? null;
}

/** 已分配过的最大版本号；一个都没有时是 0。版本号在发布时才分配，按发布顺序严格递增 */
export async function maxVersionNo(tx: Tx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`coalesce(max(${sopVersions.versionNo}), 0)::int` }).from(sopVersions);
  return row?.n ?? 0;
}

/**
 * 新草稿的 rev：接在该租户所有后台草稿（含已发布、已丢弃的，行从不删除）的最大 rev 之后，一个都没有时是 1。
 * 草稿的 rev 只增不减，所以丢弃或发布之后新建的草稿不会与旧草稿撞上同一个 rev，拿着旧 rev 的请求落不到新草稿上。
 * 调用方持着配置写锁
 */
export async function nextDraftRev(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${sopVersions.rev}), 0)::int` })
    .from(sopVersions)
    .where(eq(sopVersions.source, 'console'));
  return (row?.n ?? 0) + 1;
}

export async function insertDraft(
  tx: Tx,
  d: {
    tenantId: string;
    packId: string;
    sections: SopSectionRow[];
    basedOn: string;
    rev: number;
    createdBy: string | null;
    createdByName: string | null;
  },
): Promise<SopVersionRow> {
  const [row] = await tx
    .insert(sopVersions)
    .values({ ...d, status: 'draft', source: 'console' })
    .returning(columns);
  return row!;
}

/** 按 rev 乐观锁改草稿的节；rev 对不上（或已不是草稿）返回 null。rev 由触发器加 1 */
export async function updateDraftSections(tx: Tx, id: string, rev: number, sections: SopSectionRow[]): Promise<SopVersionRow | null> {
  const [row] = await tx
    .update(sopVersions)
    .set({ sections })
    .where(and(eq(sopVersions.id, id), eq(sopVersions.rev, rev), eq(sopVersions.status, 'draft')))
    .returning(columns);
  return row ?? null;
}

export async function archivePublished(tx: Tx, id: string): Promise<void> {
  await tx
    .update(sopVersions)
    .set({ status: 'archived' })
    .where(and(eq(sopVersions.id, id), eq(sopVersions.status, 'published')));
}

export interface ReleaseFields {
  versionNo: number;
  sections: SopSectionRow[];
  basedOn: string | null;
  renderedPrompt: string;
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
  renderInputs: RenderInputs;
  changeNote: string;
  publishedBy: string | null;
  publishedByName: string | null;
}

/** 草稿 → published：写入合并后的节、分配版本号与四个哈希。rev 对不上返回 null */
export async function publishDraft(tx: Tx, id: string, rev: number, f: ReleaseFields): Promise<SopVersionRow | null> {
  const [row] = await tx
    .update(sopVersions)
    .set({ ...f, status: 'published', publishedAt: sql`now()` })
    .where(and(eq(sopVersions.id, id), eq(sopVersions.rev, rev), eq(sopVersions.status, 'draft')))
    .returning(columns);
  return row ?? null;
}

/** 草稿 → discarded。rev 对不上返回 false */
export async function discardDraft(tx: Tx, id: string, rev: number): Promise<boolean> {
  const rows = await tx
    .update(sopVersions)
    .set({ status: 'discarded' })
    .where(and(eq(sopVersions.id, id), eq(sopVersions.rev, rev), eq(sopVersions.status, 'draft')))
    .returning({ id: sopVersions.id });
  return rows.length > 0;
}

/** 已发布与已归档的版本，按版本号倒序；beforeVersionNo 翻页 */
export async function listReleased(tx: Tx, limit: number, beforeVersionNo?: number): Promise<SopVersionRow[]> {
  const released = inArray(sopVersions.status, ['published', 'archived']);
  return tx
    .select(columns)
    .from(sopVersions)
    .where(beforeVersionNo === undefined ? released : and(released, lt(sopVersions.versionNo, beforeVersionNo)))
    .orderBy(desc(sopVersions.versionNo))
    .limit(limit);
}
