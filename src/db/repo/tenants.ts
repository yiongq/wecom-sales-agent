// 租户（spec「数据库」）：tenants 不带 RLS，agent_app 只读，agent_platform 能新建。不经 withTenant
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
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

export async function findTenantBySlug(db: Db, slug: string): Promise<TenantRow | null> {
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
  db: Db,
  t: { slug: string; name: string; packId: string; locale: string; region: string },
): Promise<TenantRow> {
  const [row] = await db.insert(tenants).values(t).returning();
  return row!;
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
