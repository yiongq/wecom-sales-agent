// 产品库条目的数据访问（spec「产品库 · 存储」）。payload 是 json 列，读出来的键序与写入时相同
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { catalogItems } from '../schema.js';

export type CatalogKind = 'route' | 'hotel';

export interface CatalogRow {
  kind: CatalogKind;
  code: string;
  ord: number;
  status: 'draft' | 'active';
  rev: number;
  payload: Record<string, unknown>;
  updatedByName: string | null;
  updatedAt: Date;
}

const columns = {
  kind: catalogItems.kind,
  code: catalogItems.code,
  ord: catalogItems.ord,
  status: catalogItems.status,
  rev: catalogItems.rev,
  payload: catalogItems.payload,
  updatedByName: catalogItems.updatedByName,
  updatedAt: catalogItems.updatedAt,
};

/** active 条目，按 (kind, ord) 排序 */
export async function readActiveCatalog(tx: Tx): Promise<CatalogRow[]> {
  return tx
    .select(columns)
    .from(catalogItems)
    .where(eq(catalogItems.status, 'active'))
    .orderBy(asc(catalogItems.kind), asc(catalogItems.ord));
}

export async function countCatalogItems(tx: Tx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(catalogItems);
  return row?.n ?? 0;
}

export async function readCatalogItem(tx: Tx, kind: CatalogKind, code: string): Promise<CatalogRow | null> {
  const [row] = await tx
    .select(columns)
    .from(catalogItems)
    .where(and(eq(catalogItems.kind, kind), eq(catalogItems.code, code)));
  return row ?? null;
}

/** 导入：按原对象和数组下标写入，状态直接是 active */
export async function insertActiveItems(
  tx: Tx,
  tenantId: string,
  kind: CatalogKind,
  payloads: readonly Record<string, unknown>[],
  by: { userId: string | null; name: string | null },
): Promise<void> {
  if (!payloads.length) return;
  await tx.insert(catalogItems).values(
    payloads.map((payload, ord) => ({
      tenantId,
      kind,
      code: String(payload.id),
      ord,
      status: 'active' as const,
      payload,
      createdBy: by.userId,
      updatedBy: by.userId,
      updatedByName: by.name,
    })),
  );
}
