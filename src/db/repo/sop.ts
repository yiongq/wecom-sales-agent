// SOP 版本的数据访问（spec「版本与发布」）。只收发领域类型；事务、租户与配置写锁由调用方负责
import { eq, sql } from 'drizzle-orm';
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
