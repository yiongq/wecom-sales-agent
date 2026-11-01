import { eq, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { opsLatencyState } from '../schema.js';
export type LatencyState = typeof opsLatencyState.$inferSelect;
export async function readLatency(tx: Tx, lock = false): Promise<LatencyState | null> {
  const query = tx.select().from(opsLatencyState);
  return (await (lock ? query.for('update') : query))[0] ?? null;
}
export async function lockLatency(tx: Tx): Promise<LatencyState> {
  await tx.insert(opsLatencyState).values({ tenantId: currentTenantCtx().tenantId }).onConflictDoNothing();
  return (await readLatency(tx, true))!;
}
export async function updateLatency(tx: Tx, previous: LatencyState, next: LatencyState): Promise<boolean> {
  const rows = await tx
    .update(opsLatencyState)
    .set(next)
    .where(sql`
    ${opsLatencyState.lastWindowEnd} is not distinct from ${previous.lastWindowEnd?.toISOString() ?? null}::timestamptz
    and ${opsLatencyState.paused} = ${previous.paused}
  `)
    .returning({ tenantId: opsLatencyState.tenantId });
  return rows.length === 1;
}
export async function pauseLatency(tx: Tx): Promise<void> {
  await lockLatency(tx);
  await tx.update(opsLatencyState).set({ paused: true, badStreak: 0, goodStreak: 0 }).where(eq(opsLatencyState.paused, false));
}
