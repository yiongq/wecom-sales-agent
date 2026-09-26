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

/** 某个 kind 的全部条目（含 draft），按 ord 排序：v0 条目只有几十条，不分页 */
export async function readCatalogOfKind(tx: Tx, kind: CatalogKind): Promise<CatalogRow[]> {
  return tx.select(columns).from(catalogItems).where(eq(catalogItems.kind, kind)).orderBy(asc(catalogItems.ord));
}

/** 单条并加行锁：同一条的写入串行 */
export async function readCatalogItemForUpdate(tx: Tx, kind: CatalogKind, code: string): Promise<CatalogRow | null> {
  const [row] = await tx
    .select(columns)
    .from(catalogItems)
    .where(and(eq(catalogItems.kind, kind), eq(catalogItems.code, code)))
    .for('update');
  return row ?? null;
}

/** 该 kind 已用过的最大 ord；一条都没有时是 -1 */
export async function maxOrd(tx: Tx, kind: CatalogKind): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${catalogItems.ord}), -1)::int` })
    .from(catalogItems)
    .where(eq(catalogItems.kind, kind));
  return row?.n ?? -1;
}

export async function insertDraftItem(
  tx: Tx,
  d: {
    tenantId: string;
    kind: CatalogKind;
    ord: number;
    payload: Record<string, unknown>;
    by: { userId: string | null; name: string | null };
  },
): Promise<CatalogRow> {
  const [row] = await tx
    .insert(catalogItems)
    .values({
      tenantId: d.tenantId,
      kind: d.kind,
      code: String(d.payload.id),
      ord: d.ord,
      status: 'draft',
      payload: d.payload,
      createdBy: d.by.userId,
      updatedBy: d.by.userId,
      updatedByName: d.by.name,
    })
    .returning(columns);
  return row!;
}

/** 按 rev 乐观锁整条替换 payload；rev 对不上返回 null。rev 加 1 与 updated_at 由触发器负责 */
export async function updateItemPayload(
  tx: Tx,
  kind: CatalogKind,
  code: string,
  rev: number,
  payload: Record<string, unknown>,
  by: { userId: string | null; name: string | null },
): Promise<CatalogRow | null> {
  const [row] = await tx
    .update(catalogItems)
    .set({ payload, updatedBy: by.userId, updatedByName: by.name })
    .where(and(eq(catalogItems.kind, kind), eq(catalogItems.code, code), eq(catalogItems.rev, rev)))
    .returning(columns);
  return row ?? null;
}

/** draft → active；rev 对不上或已不是 draft 返回 null */
export async function activateItem(
  tx: Tx,
  kind: CatalogKind,
  code: string,
  rev: number,
  by: { userId: string | null; name: string | null },
): Promise<CatalogRow | null> {
  const [row] = await tx
    .update(catalogItems)
    .set({ status: 'active', updatedBy: by.userId, updatedByName: by.name })
    .where(and(eq(catalogItems.kind, kind), eq(catalogItems.code, code), eq(catalogItems.rev, rev), eq(catalogItems.status, 'draft')))
    .returning(columns);
  return row ?? null;
}
