// 17：采集证据与日指标同租户读取；检查点使用应用时钟，不取数据库 now()。
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { opsMetricCoverage } from '../schema.js';
import type { DayWindow } from './ops-metrics.js';

export interface CoverageRow {
  day: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  hasGap: boolean;
  hasDeletion: boolean;
}

export async function readCoverage(tx: Tx, windows: readonly DayWindow[]): Promise<CoverageRow[]> {
  if (!windows.length) return [];
  const { tenantId } = currentTenantCtx();
  return tx
    .select()
    .from(opsMetricCoverage)
    .where(
      and(
        eq(opsMetricCoverage.tenantId, tenantId),
        inArray(
          opsMetricCoverage.day,
          windows.map((w) => w.day),
        ),
      ),
    );
}

/** 调用者持租户锁且串行执行；跨日缺口与当日检查点在同一事务提交。 */
export async function writeCoverageCheckpoint(tx: Tx, day: string, at: Date, gap: boolean): Promise<void> {
  const { tenantId } = currentTenantCtx();
  const [latest] = await tx
    .select()
    .from(opsMetricCoverage)
    .where(eq(opsMetricCoverage.tenantId, tenantId))
    .orderBy(desc(opsMetricCoverage.lastSeenAt))
    .limit(1);
  const longGap = !!latest && at.getTime() - latest.lastSeenAt.getTime() > 120_000;
  if (longGap && latest.day !== day) {
    await tx
      .update(opsMetricCoverage)
      .set({ hasGap: true })
      .where(and(eq(opsMetricCoverage.tenantId, tenantId), eq(opsMetricCoverage.day, latest.day)));
  }
  await tx
    .insert(opsMetricCoverage)
    .values({ tenantId, day, firstSeenAt: at, lastSeenAt: at, hasGap: gap || longGap })
    .onConflictDoUpdate({
      target: [opsMetricCoverage.tenantId, opsMetricCoverage.day],
      set: {
        lastSeenAt: sql`greatest(${opsMetricCoverage.lastSeenAt}, excluded.last_seen_at)`,
        hasGap: sql`${opsMetricCoverage.hasGap} or excluded.has_gap`,
      },
    });
}
