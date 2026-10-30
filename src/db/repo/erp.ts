// 11 R3、R5：仅在 withTenant 事务内使用，隔离与授权由 FORCE RLS / 列权限保证。
// 包含地址、数据库名和密文的行只供内部使用，不得输出；审计由命令行负责。
import { and, asc, eq } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { erpConnectors, erpItemLinks } from '../schema.js';

export type ErpConnectorRow = Omit<typeof erpConnectors.$inferSelect, 'tenantId'>;
export type NewErpConnector = Omit<typeof erpConnectors.$inferInsert, 'tenantId' | 'createdAt' | 'updatedAt'>;
export type ErpConnectorPatch = Partial<
  Pick<ErpConnectorRow, 'status' | 'baseUrl' | 'database' | 'settings' | 'secretsCt' | 'secretsKeyId'>
>;
export type ErpItemLink = Omit<typeof erpItemLinks.$inferSelect, 'tenantId'>;

const CONNECTOR_COLUMNS = {
  id: erpConnectors.id,
  kind: erpConnectors.kind,
  status: erpConnectors.status,
  baseUrl: erpConnectors.baseUrl,
  database: erpConnectors.database,
  settings: erpConnectors.settings,
  secretsCt: erpConnectors.secretsCt,
  secretsKeyId: erpConnectors.secretsKeyId,
  createdAt: erpConnectors.createdAt,
  updatedAt: erpConnectors.updatedAt,
};
const LINK_COLUMNS = {
  connectorId: erpItemLinks.connectorId,
  kind: erpItemLinks.kind,
  code: erpItemLinks.code,
  remoteId: erpItemLinks.remoteId,
  remoteCode: erpItemLinks.remoteCode,
  remoteUomId: erpItemLinks.remoteUomId,
  source: erpItemLinks.source,
  checkedAt: erpItemLinks.checkedAt,
};

/** 与渠道账号一样只读本租户，启动方负责逐租户调用；第一期每租户至多一行。 */
export async function listErpConnectors(tx: Tx): Promise<ErpConnectorRow[]> {
  return tx.select(CONNECTOR_COLUMNS).from(erpConnectors).orderBy(asc(erpConnectors.createdAt));
}

export async function readErpConnector(tx: Tx): Promise<ErpConnectorRow | null> {
  const [row] = await listErpConnectors(tx);
  return row ?? null;
}

export async function insertErpConnector(tx: Tx, input: NewErpConnector): Promise<ErpConnectorRow> {
  const { tenantId } = currentTenantCtx();
  const [row] = await tx
    .insert(erpConnectors)
    .values({ ...input, tenantId })
    .returning(CONNECTOR_COLUMNS);
  if (!row) throw new Error('erp_connectors：插入没有返回行');
  return row;
}

export async function updateErpConnector(tx: Tx, id: string, patch: ErpConnectorPatch): Promise<boolean> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ErpConnectorPatch;
  if (!Object.keys(set).length) return false;
  const rows = await tx.update(erpConnectors).set(set).where(eq(erpConnectors.id, id)).returning({ id: erpConnectors.id });
  return rows.length === 1;
}

const linkKey = (connectorId: string, kind: string, code: string) =>
  and(eq(erpItemLinks.connectorId, connectorId), eq(erpItemLinks.kind, kind), eq(erpItemLinks.code, code));

export async function listErpItemLinks(tx: Tx, connectorId: string): Promise<ErpItemLink[]> {
  return tx
    .select(LINK_COLUMNS)
    .from(erpItemLinks)
    .where(eq(erpItemLinks.connectorId, connectorId))
    .orderBy(asc(erpItemLinks.kind), asc(erpItemLinks.code));
}

export async function readErpItemLink(tx: Tx, connectorId: string, kind: string, code: string): Promise<ErpItemLink | null> {
  const [row] = await tx
    .select(LINK_COLUMNS)
    .from(erpItemLinks)
    .where(linkKey(connectorId, kind, code));
  return row ?? null;
}

export async function upsertErpItemLink(tx: Tx, link: ErpItemLink): Promise<void> {
  const { tenantId } = currentTenantCtx();
  await tx
    .insert(erpItemLinks)
    .values({ ...link, tenantId })
    .onConflictDoUpdate({
      target: [erpItemLinks.tenantId, erpItemLinks.connectorId, erpItemLinks.kind, erpItemLinks.code],
      set: {
        remoteId: link.remoteId,
        remoteCode: link.remoteCode,
        remoteUomId: link.remoteUomId,
        source: link.source,
        checkedAt: link.checkedAt,
      },
    });
}

export async function deleteErpItemLink(tx: Tx, connectorId: string, kind: string, code: string): Promise<boolean> {
  const rows = await tx
    .delete(erpItemLinks)
    .where(linkKey(connectorId, kind, code))
    .returning({ code: erpItemLinks.code });
  return rows.length === 1;
}
