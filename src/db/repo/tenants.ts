// 租户（spec「数据库」）：tenants 不带 RLS，agent_app 只读，agent_platform 能新建；需要原子审计时由调用方传入事务。
import { eq } from 'drizzle-orm';
import type { BrandProfile } from '../../core/pack-api.js';
import type { Db, Tx } from '../client.js';
import { tenants } from '../schema.js';

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  packId: string;
  locale: string;
  region: string;
  status: 'trial' | 'active' | 'suspended';
}

export async function findTenantBySlug(db: Db | Tx, slug: string): Promise<TenantRow | null> {
  const [row] = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      packId: tenants.packId,
      locale: tenants.locale,
      region: tenants.region,
      status: tenants.status,
    })
    .from(tenants)
    .where(eq(tenants.slug, slug));
  return row ?? null;
}

export async function insertTenant(
  db: Db | Tx,
  t: { id?: string; slug: string; name: string; packId: string; locale: string; region: string; brand?: BrandProfile | null },
): Promise<TenantRow> {
  const [row] = await db.insert(tenants).values(t).returning();
  return row!;
}

/** 平台命令读待生效配置；forUpdate 在审计事务里串行化并发的 set/clear。 */
export async function readBrand(db: Db | Tx, tenantId: string, forUpdate = false): Promise<BrandProfile | null | undefined> {
  const query = db.select({ brand: tenants.brand }).from(tenants).where(eq(tenants.id, tenantId));
  const [row] = await (forUpdate ? query.for('update') : query);
  return row?.brand;
}

/** 只写 brand，不发布、不重渲染；调用方与字段名审计一起提交。 */
export async function updateBrand(tx: Tx, tenantId: string, brand: BrandProfile | null): Promise<void> {
  await tx.update(tenants).set({ brand }).where(eq(tenants.id, tenantId));
}

/** 05 R7：平台命令锁定租户后检查种类，再写目标列与审计。 */
export async function lockTenantKind(tx: Tx, tenantId: string): Promise<'standard' | 'sandbox' | undefined> {
  const [row] = await tx.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  return row?.kind;
}

/** 仅更新列级授权的 public_host；规范化与审计由命令负责，下次启动生效。 */
export async function updatePublicHost(tx: Tx, tenantId: string, publicHost: string | null): Promise<void> {
  await tx.update(tenants).set({ publicHost }).where(eq(tenants.id, tenantId));
}

/** standard 的软告警上限，null 取消；不更新租户的其他列。 */
export async function updateLlmDailyAlert(tx: Tx, tenantId: string, llmDailyAlertMilli: number | null): Promise<void> {
  await tx.update(tenants).set({ llmDailyAlertMilli }).where(eq(tenants.id, tenantId));
}

export interface RetentionSettings {
  leadDays: number;
  customerDays: number;
  traceDays: number;
}

/** 保留期三列（02 spec「隐私说明…」，开放问题 2）；tenant-retention 命令行读改前的值用 */
export async function readRetention(db: Db, tenantId: string): Promise<RetentionSettings | null> {
  const [row] = await db
    .select({ leadDays: tenants.retentionLeadDays, customerDays: tenants.retentionCustomerDays, traceDays: tenants.retentionTraceDays })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? null;
}

/** 平台命令行 tenant-retention：agent_platform 对这三列有列级 UPDATE 授权，不经 withTenant（tenants 不带 RLS） */
export async function updateRetention(db: Db, tenantId: string, patch: Partial<RetentionSettings>): Promise<void> {
  const set: Record<string, number> = {};
  if (patch.leadDays !== undefined) set.retentionLeadDays = patch.leadDays;
  if (patch.customerDays !== undefined) set.retentionCustomerDays = patch.customerDays;
  if (patch.traceDays !== undefined) set.retentionTraceDays = patch.traceDays;
  if (Object.keys(set).length === 0) return;
  await db.update(tenants).set(set).where(eq(tenants.id, tenantId));
}

/** 05 宿主启动清单：不装沙箱；无 public_host 的非宿主只记录并跳过。 */
export async function standardTenants(db: Db): Promise<{ id: string; slug: string; publicHost: string | null }[]> {
  return db
    .select({ id: tenants.id, slug: tenants.slug, publicHost: tenants.publicHost })
    .from(tenants)
    .where(eq(tenants.kind, 'standard'));
}

/** 14 R3：轮询只读取状态与上限，不携带租户的其他配置。 */
export async function readTenantLimits(
  db: Db | Tx,
  tenantId: string,
): Promise<{
  status: TenantRow['status'];
  monthlyQuota: number | null;
  dailyCapMilli: number | null;
} | null> {
  const [row] = await db
    .select({ status: tenants.status, monthlyQuota: tenants.monthlyReplyQuota, dailyCapMilli: tenants.llmDailyCapMilli })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? null;
}
