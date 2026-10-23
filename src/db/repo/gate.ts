// 07 R7：所有查询都在调用方的 withTenant 事务内，照常受 FORCE RLS 约束。
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { sopGateRuns } from '../schema.js';

export type GateRow = typeof sopGateRuns.$inferSelect;
export async function insertGate(tx: Tx, input: Omit<typeof sopGateRuns.$inferInsert, 'tenantId'>): Promise<GateRow> {
  const [row] = await tx
    .insert(sopGateRuns)
    .values({ ...input, tenantId: currentTenantCtx().tenantId })
    .returning();
  return row!;
}
export async function readGate(tx: Tx, id: string): Promise<GateRow | null> {
  return (await tx.select().from(sopGateRuns).where(eq(sopGateRuns.id, id)))[0] ?? null;
}
export async function gatesSince(tx: Tx, since: Date): Promise<GateRow[]> {
  return tx.query.sopGateRuns.findMany({ where: (t, { gte }) => gte(t.createdAt, since) });
}
export async function baselineFor(tx: Tx, key: string, mock: boolean): Promise<GateRow | null> {
  const rows = await tx
    .select()
    .from(sopGateRuns)
    .where(
      and(eq(sopGateRuns.status, 'done'), eq(sopGateRuns.mock, mock), or(eq(sopGateRuns.draftKey, key), eq(sopGateRuns.baselineKey, key))),
    )
    .orderBy(desc(sopGateRuns.finishedAt));
  return rows.find((r) => (r.draftKey === key ? r.results?.draft.length : r.results?.baseline?.length)) ?? null;
}
export async function gatesForDraft(tx: Tx, draftId: string): Promise<GateRow[]> {
  return tx.select().from(sopGateRuns).where(eq(sopGateRuns.draftId, draftId)).orderBy(desc(sopGateRuns.createdAt));
}
export async function updateGate(tx: Tx, id: string, values: Partial<typeof sopGateRuns.$inferInsert>): Promise<void> {
  await tx
    .update(sopGateRuns)
    .set(values)
    .where(and(eq(sopGateRuns.id, id), inArray(sopGateRuns.status, ['queued', 'running'])));
}
export async function abandonGates(tx: Tx): Promise<void> {
  await tx
    .update(sopGateRuns)
    .set({ status: 'abandoned', verdict: null, error: 'restart', finishedAt: new Date() })
    .where(inArray(sopGateRuns.status, ['queued', 'running']));
}
