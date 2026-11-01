import { and, eq, sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { opsDailyReports } from '../schema.js';
import type { DailyOpsPoint } from '../../shared/console-api.js';
import { enqueueJob } from './jobs.js';

export type Report = typeof opsDailyReports.$inferSelect;
export type ReportError = NonNullable<Report['errorCode']>;
export async function opsTimeout(tx: Tx): Promise<void> {
  await tx.execute(sql`set local statement_timeout = '5s'`);
}
export async function readReport(tx: Tx, day: string, lock = false): Promise<Report | null> {
  const q = tx.select().from(opsDailyReports).where(eq(opsDailyReports.day, day));
  const [row] = await (lock ? q.for('update') : q);
  return row ?? null;
}
export async function ensureReport(tx: Tx, day: string, now: number): Promise<void> {
  await tx.insert(opsDailyReports).values({ tenantId: currentTenantCtx().tenantId, day }).onConflictDoNothing();
  const report = await readReport(tx, day, true);
  if (report?.status !== 'pending') return;
  await enqueueJob(tx, {
    kind: 'ops_daily_digest',
    dedupeKey: `ops_daily_digest:${day}`,
    payload: { day },
    runAt: report.nextAttemptAt ?? new Date(now),
    maxAttempts: 10,
  });
}
/** 每次转换都带前置状态；发送结果额外校验令牌。 */
export async function changeReport(
  tx: Tx,
  day: string,
  from: Report['status'],
  patch: Partial<Omit<Report, 'tenantId' | 'day' | 'reportId'>>,
  token?: string,
): Promise<boolean> {
  const rows = await tx
    .update(opsDailyReports)
    .set(patch)
    .where(and(eq(opsDailyReports.day, day), eq(opsDailyReports.status, from), token ? eq(opsDailyReports.claimToken, token) : undefined))
    .returning({ day: opsDailyReports.day });
  return rows.length === 1;
}
export async function freezeReport(tx: Tx, day: string, snapshot: DailyOpsPoint, at: number): Promise<boolean> {
  return changeReport(tx, day, 'pending', { snapshot, computedAt: new Date(at) });
}
export async function recoverReports(tx: Tx): Promise<number> {
  const changed = await tx
    .update(opsDailyReports)
    .set({ status: 'unknown', errorCode: 'restart_in_sending', claimToken: null })
    .where(eq(opsDailyReports.status, 'sending'))
    .returning({ day: opsDailyReports.day });
  return changed.length;
}
export async function expireReports(tx: Tx, yesterday: string): Promise<number> {
  return rowsOf(
    await tx.execute(sql`update ops_daily_reports set status='failed', error_code='deadline', next_attempt_at=null
    where status='pending' and day < ${yesterday}::date returning day`),
  ).length;
}
export async function reportHasDeletion(tx: Tx, day: string, lock = false): Promise<boolean> {
  return (
    rowsOf<{ deleted: boolean }>(
      await tx.execute(sql`
    select has_deletion as deleted from ops_metric_coverage where day=${day}::date ${lock ? sql`for share` : sql``}
  `),
    )[0]?.deleted ?? false
  );
}
export async function reportCommand(tx: Tx, command: 'retry' | 'prepare-rollback', day?: string): Promise<void> {
  const tenantId = currentTenantCtx().tenantId;
  if (command === 'retry') await tx.execute(sql`select public.ops_report_retry(${tenantId}::uuid, ${day}::date)`);
  else await tx.execute(sql`select public.ops_report_prepare_rollback(${tenantId}::uuid)`);
}
