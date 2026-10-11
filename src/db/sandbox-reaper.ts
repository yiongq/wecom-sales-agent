// R12 / R13：查询与 purge 共用库时钟；运行时取消及释放在 tenancy 层。
import { sql } from 'drizzle-orm';
import { rowsOf, withTenant, type Db } from './client.js';
import { systemContext } from './sandbox-process.js';
import { writeAudit } from './repo/audit.js';

export interface ReaperRow {
  id: string;
  slug: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  expired: boolean;
  overdue: boolean;
}
export async function listSandboxes(db: Db): Promise<ReaperRow[]> {
  return rowsOf<ReaperRow>(
    await db.execute(sql`
    select id, slug, created_at as "createdAt", expires_at as "expiresAt",
      expires_at <= now() as expired, expires_at < now() - interval '1 hour' as overdue
    from public.tenants where kind = 'sandbox' order by expires_at, id`),
  );
}

/** 主动结束与闲置回收的审计同到期修改一起提交，随后随租户删除。 */
export async function endSandbox(db: Db, tenantId: string): Promise<void> {
  await withTenant(db, systemContext(tenantId), async (tx) => {
    const [row] = rowsOf<{ ended: boolean }>(await tx.execute(sql`select public.sandbox_tenant_expire(${tenantId}::uuid) as ended`));
    if (row?.ended) await writeAudit(tx, { action: 'sandbox.end', targetType: 'tenant', targetId: tenantId });
  });
}

export async function purgeSandbox(db: Db, tenantId: string) {
  return withTenant(db, systemContext(tenantId), async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    const [usage] = rowsOf<{ calls: number; costMilli: number; turns: number }>(
      await tx.execute(sql`
      select coalesce(sum(calls), 0)::int as calls, coalesce(sum(cost_milli_cny), 0)::int as "costMilli",
        (select count(*)::int from public.turn_traces where tenant_id = ${tenantId}::uuid) as turns
      from public.usage_daily where tenant_id = ${tenantId}::uuid`),
    );
    const [result] = rowsOf<{ counts: Record<string, number> }>(
      await tx.execute(sql`select public.sandbox_tenant_purge(${tenantId}::uuid) as counts`),
    );
    return { ...usage!, counts: result!.counts };
  });
}
