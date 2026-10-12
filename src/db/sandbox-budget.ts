// R15：预算恢复用一致快照；FORCE RLS 下逐租户读，不借平台凭据。
import { sql } from 'drizzle-orm';
import { rowsOf, withTenant, type Db } from './client.js';
import { systemContext } from './sandbox-process.js';

export async function readSandboxBudget(db: Db, tenantId: string) {
  return withTenant(
    db,
    systemContext(tenantId),
    async (tx) => {
      const [row] = rowsOf<{ calls: number; costMilli: number }>(
        await tx.execute(sql`
      select coalesce(sum(calls),0)::float8 as calls, coalesce(sum(cost_milli_cny),0)::float8 as "costMilli" from public.usage_daily`),
      );
      return row!;
    },
    { readOnly: true },
  );
}

/** 首次建共享索引没有所属租户，直接写池；与 purge 的加法 upsert 可并发。 */
export async function writeSandboxIndexUsage(db: Db, rows: { day: string; calls: number; costMilli: number }[]): Promise<void> {
  await withTenant(db, systemContext('00000000-0000-0000-0000-000000000000'), async (tx) => {
    for (const row of rows)
      await tx.execute(sql`
      insert into public.sandbox_pool_daily(day, calls, cost_milli) values (${row.day}::date, ${row.calls}, ${row.costMilli})
      on conflict(day) do update set calls = public.sandbox_pool_daily.calls + excluded.calls,
        cost_milli = public.sandbox_pool_daily.cost_milli + excluded.cost_milli`);
  });
}
