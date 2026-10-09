// 产品库条目版本（02 spec「报价快照」）：只追加，启动时全量读进内存
import { and, asc, eq, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { catalogItemVersions } from '../schema.js';
import type { CatalogKind } from './catalog.js';

export interface CatalogVersionRow {
  kind: CatalogKind;
  code: string;
  version: number;
  /** 与 catalog_items.payload 同为 json，键序原样 */
  payload: Record<string, unknown>;
  source: 'backfill' | 'activate' | 'console' | 'fix';
  createdByName: string | null;
  createdAt: Date;
}

/** 上架、改动 active 条目、启动补写时写一个新版本（catalog_items.version 由调用方在同一事务里改） */
export async function insertCatalogVersion(tx: Tx, v: Omit<CatalogVersionRow, 'createdAt'>): Promise<void> {
  const { tenantId } = currentTenantCtx();
  await tx.insert(catalogItemVersions).values({ tenantId, ...v });
}

/** 本租户全部条目的全部版本，按 (kind, code, version) 排序 */
export async function readCatalogVersions(tx: Tx): Promise<CatalogVersionRow[]> {
  const rows = await tx
    .select({
      kind: catalogItemVersions.kind,
      code: catalogItemVersions.code,
      version: catalogItemVersions.version,
      payload: catalogItemVersions.payload,
      source: catalogItemVersions.source,
      createdByName: catalogItemVersions.createdByName,
      createdAt: catalogItemVersions.createdAt,
    })
    .from(catalogItemVersions)
    .orderBy(asc(catalogItemVersions.kind), asc(catalogItemVersions.code), asc(catalogItemVersions.version));
  // kind 列没有 CHECK，外键保证它是 catalog_items 里已有的 kind
  return rows.map((r) => ({ ...r, kind: r.kind as CatalogKind }));
}

/** 这一条已有的最大版本号；一行都没有时是 0。写新版本前在同一事务里取（条目行已经 FOR UPDATE 锁住，同一条的写入串行） */
export async function maxCatalogVersion(tx: Tx, kind: CatalogKind, code: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${catalogItemVersions.version}), 0)::int` })
    .from(catalogItemVersions)
    .where(and(eq(catalogItemVersions.kind, kind), eq(catalogItemVersions.code, code)));
  return row?.n ?? 0;
}
