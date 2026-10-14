// R12 / R13：查询与 purge 共用库时钟；运行时取消及释放在 tenancy 层。
import { sql } from 'drizzle-orm';
import { rowsOf, withTenant, type Db, type WithTenantOpts } from './client.js';
import { systemContext } from './sandbox-process.js';
import { writeAudit } from './repo/audit.js';
import { todayIso } from '../env.js';

export interface ReaperRow {
  id: string;
  slug: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  lastSeenAt: Date | string;
  expired: boolean;
  overdue: boolean;
}
export async function listSandboxes(db: Db): Promise<ReaperRow[]> {
  const rows = rowsOf<ReaperRow>(
    await db.execute(sql`
    select id, slug, created_at as "createdAt", expires_at as "expiresAt", seen.last_seen_at as "lastSeenAt",
      expires_at <= now() as expired, expires_at < now() - interval '1 hour' as overdue
    from public.tenants join public.sandbox_last_seen() seen on seen.tenant_id = id
    where kind = 'sandbox' order by expires_at, id`),
  );
  // 微信收件已有 append-only 消息，重启时也用它恢复活动时刻，不给登录表另开写权限。
  for (const row of rows) {
    const [wechat] = await withTenant(
      db,
      systemContext(row.id),
      async (tx) =>
        rowsOf<{ at: Date | string | null }>(
          await tx.execute(sql`select max(m.at) as at from public.messages m join public.conversations c
        on c.tenant_id = m.tenant_id and c.id = m.conversation_id
        where m.tenant_id = ${row.id}::uuid and c.channel = 'wecom' and m.role = 'customer'`),
        ),
      { readOnly: true, sandboxMaintenance: true },
    );
    if (wechat?.at && new Date(wechat.at).getTime() > new Date(row.lastSeenAt).getTime()) row.lastSeenAt = wechat.at;
  }
  return rows;
}

/** 主动结束与闲置回收的审计同到期修改一起提交，随后随租户删除。 */
export async function endSandbox(db: Db, tenantId: string, opts: WithTenantOpts = {}): Promise<void> {
  await withTenant(
    db,
    systemContext(tenantId),
    async (tx) => {
      const [row] = rowsOf<{ ended: boolean }>(await tx.execute(sql`select public.sandbox_tenant_expire(${tenantId}::uuid) as ended`));
      if (row?.ended) await writeAudit(tx, { action: 'sandbox.end', targetType: 'tenant', targetId: tenantId });
    },
    { ...opts, sandboxMaintenance: true },
  );
}

export async function purgeSandbox(db: Db, tenantId: string, opts: WithTenantOpts = {}) {
  return withTenant(
    db,
    systemContext(tenantId),
    async (tx) => {
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
    },
    { ...opts, sandboxMaintenance: true, sandboxDay: todayIso() },
  );
}
