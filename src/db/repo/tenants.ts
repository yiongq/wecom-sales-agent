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
