// 05 R2：实例锁、epoch 与事务 fencing。SQL 只留在数据库层。
import { sql } from 'drizzle-orm';
import { fenceSandboxEpoch, holdTenantLocks, rowsOf, withTenant, type Db, type Tx, type TenantCtx } from './client.js';
import { assertSandboxRunning } from '../tenancy/sandbox/lifecycle.js';
import { SandboxStartupError } from '../tenancy/sandbox/role.js';

export async function acquireSandboxProcess(url: string, onLost: () => void) {
  const lock = await holdTenantLocks(url, ['sandbox-process'], { waitMs: 30_000 });
  if (!lock) throw new SandboxStartupError('sandbox_already_running');
  lock.onLost(onLost);
  return {
    ...lock,
    reacquire: async () => {
      throw new Error('sandbox_lock_reacquire_forbidden');
    },
  };
}

export async function advanceSandboxEpoch(db: Db): Promise<string> {
  assertSandboxRunning();
  const [row] = rowsOf<{ epoch: string | number }>(
    await db.execute(sql`update public.sandbox_process_epoch set epoch = epoch + 1 where id = 1 returning epoch`),
  );
  if (!row) throw new SandboxStartupError('sandbox_epoch_missing');
  return String(row.epoch);
}

export { fenceSandboxEpoch, withSandboxEpoch } from './client.js';

export function withSandboxTenant<T>(db: Db, ctx: TenantCtx, epoch: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db, ctx, async (tx) => {
    await fenceSandboxEpoch(tx, epoch);
    return fn(tx);
  });
}

export async function checkSandboxStartup(db: Db, templateSlug: string, openKfid?: string): Promise<void> {
  const templates = rowsOf<{ id: string }>(
    await db.execute(sql`
    select id from public.tenants where slug = ${templateSlug} and kind = 'standard' and status <> 'suspended'`),
  );
  if (!templates.length) throw new SandboxStartupError('sandbox_template_invalid');
  // channel_accounts 套 FORCE RLS；每个 standard 都显式建立租户事务。
  if (openKfid) {
    const standards = rowsOf<{ id: string }>(await db.execute(sql`select id from public.tenants where kind = 'standard'`));
    for (const tenant of standards) {
      const conflict = await withTenant(db, systemContext(tenant.id), async (tx) =>
        rowsOf(await tx.execute(sql`select id from public.channel_accounts where open_kfid = ${openKfid} limit 1`)),
      );
      if (conflict.length) throw new SandboxStartupError('sandbox_wecom_conflict');
    }
  }
}

/** 必须在 epoch 推进成功后读取，才能包含旧进程受 fencing 保护的迟到开通。 */
export async function sandboxStartupRows(db: Db) {
  return rowsOf<{ id: string; slug: string; expiresAt: Date | string }>(
    await db.execute(sql`
    select id, slug, expires_at as "expiresAt" from public.tenants
    where kind = 'sandbox' and expires_at > now() and status <> 'suspended' order by id`),
  );
}

export function systemContext(tenantId: string): TenantCtx {
  return { tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } };
}

export async function expireBrokenSandbox(db: Db, tenantId: string): Promise<void> {
  await db.execute(sql`select public.sandbox_tenant_expire(${tenantId}::uuid)`);
}

/** 只读健康投影；不输出租户、凭据或令牌。后续开通、删除与预算步骤补充真实计数。 */
export async function sandboxPoolHealth(db: Db) {
  const [row] = rowsOf<{ day: string; provisioned: number; costMilli: number }>(
    await db.execute(sql`
    select current_date::text as day, coalesce(p.provisioned, 0)::int as provisioned,
      coalesce(p.cost_milli, 0)::int as "costMilli"
    from (select current_date as day) d left join public.sandbox_pool_daily p using (day)`),
  );
  return row!;
}
