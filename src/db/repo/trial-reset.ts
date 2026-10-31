// 15 R10：批次只追加 audit_log；没有新授权、业务表或删除路径。
import { and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rowsOf, type Db, type Tx } from '../client.js';
import { channelInbox, conversations, memberships, orders, outboundSends, tenants } from '../schema.js';
import { readAudit, writeAudit } from './audit.js';
import { readPublishedSop } from './sop.js';
import { readActiveCatalog } from './catalog.js';
import { readCatalogVersions } from './catalog-versions.js';
import {
  TRIAL_RESET_AUDIT,
  TRIAL_RESET_PHASES,
  TRIAL_SEED_MANIFEST,
  TRIAL_SEED_VERSION,
  TRIAL_ORDER_ID_PATTERN,
  TRIAL_SEED_ID_PATTERN,
  type TrialResetCheckpoint,
} from '../../shared/product-surface.js';
import { createHash } from 'node:crypto';

function checkpointSchema() {
  return z.strictObject({
    version: z.literal(1),
    batch: z.string().regex(/^[0-9a-f]{16}$/),
    phase: z.enum(TRIAL_RESET_PHASES),
    seedVersion: z.literal(TRIAL_SEED_VERSION),
    targetConversationRefs: z.array(z.uuid()),
    erasedConversationRefs: z.array(z.uuid()),
    seedIds: z
      .array(
        z.strictObject({
          key: z.enum(TRIAL_SEED_MANIFEST.map((m) => m.key)),
          sessionId: z.string().regex(TRIAL_SEED_ID_PATTERN),
          orderId: z.string().regex(TRIAL_ORDER_ID_PATTERN).nullable(),
        }),
      )
      .length(TRIAL_SEED_MANIFEST.length),
  });
}
export interface TrialBatch {
  checkpoint: TrialResetCheckpoint;
  plannedAt: Date;
  updatedAt: Date;
}
export async function readTrialBatches(tx: Tx): Promise<Map<string, TrialBatch>> {
  const events = [];
  let beforeId: number | undefined;
  for (;;) {
    const page = await readAudit(tx, { limit: 500, beforeId, action: TRIAL_RESET_AUDIT.action });
    events.push(...page);
    if (page.length < 500) break;
    beforeId = page.at(-1)!.id;
  }
  const batches = new Map<string, TrialBatch>();
  for (const row of events.toReversed()) {
    const p = checkpointSchema().parse(row.diff);
    if (row.targetType !== TRIAL_RESET_AUDIT.targetType || row.targetId !== p.batch) throw new Error('trial_checkpoint_invalid');
    const old = batches.get(p.batch);
    if (!old && p.phase !== 'planned') throw new Error('trial_checkpoint_missing_plan');
    if (old) {
      const previous = old.checkpoint;
      const a = TRIAL_RESET_PHASES.indexOf(previous.phase),
        b = TRIAL_RESET_PHASES.indexOf(p.phase);
      if (
        b < a ||
        b > a + 1 ||
        JSON.stringify([previous.targetConversationRefs, previous.seedIds]) !== JSON.stringify([p.targetConversationRefs, p.seedIds]) ||
        previous.erasedConversationRefs.some((ref) => !p.erasedConversationRefs.includes(ref))
      )
        throw new Error('trial_checkpoint_conflict');
    }
    if (
      new Set(p.targetConversationRefs).size !== p.targetConversationRefs.length ||
      new Set(p.erasedConversationRefs).size !== p.erasedConversationRefs.length ||
      p.erasedConversationRefs.some((ref) => !p.targetConversationRefs.includes(ref))
    )
      throw new Error('trial_checkpoint_refs');
    for (const [i, manifest] of TRIAL_SEED_MANIFEST.entries()) {
      const seed = p.seedIds[i]!;
      if (
        seed.key !== manifest.key ||
        !seed.sessionId.startsWith(`trialseed-${p.batch}-`) ||
        (manifest.order === 'none' ? seed.orderId !== null : !seed.orderId?.startsWith(`ord_seed_${p.batch}-`))
      )
        throw new Error('trial_checkpoint_seeds');
    }
    if (new Set(p.seedIds.map((s) => s.sessionId)).size !== p.seedIds.length) throw new Error('trial_checkpoint_duplicate_seed');
    const orderIds = p.seedIds.flatMap((s) => (s.orderId ? [s.orderId] : []));
    if (
      new Set(orderIds).size !== orderIds.length ||
      (TRIAL_RESET_PHASES.indexOf(p.phase) >= 2 && p.erasedConversationRefs.length !== p.targetConversationRefs.length)
    )
      throw new Error('trial_checkpoint_incomplete');
    batches.set(p.batch, { checkpoint: p, plannedAt: old?.plannedAt ?? row.at, updatedAt: row.at });
  }
  return batches;
}
export async function assertTrialResetComplete(tx: Tx): Promise<Map<string, TrialBatch>> {
  const batches = await readTrialBatches(tx);
  for (const { checkpoint } of batches.values()) if (checkpoint.phase !== 'complete') throw new Error('trial_reset_incomplete');
  return batches;
}
export async function checkpointTrialReset(tx: Tx, checkpoint: TrialResetCheckpoint): Promise<void> {
  await writeAudit(tx, {
    action: TRIAL_RESET_AUDIT.action,
    targetType: TRIAL_RESET_AUDIT.targetType,
    targetId: checkpoint.batch,
    diff: checkpoint,
  });
}
export async function trialConversations(tx: Tx) {
  return tx
    .select({ ref: conversations.ref, id: conversations.id, state: conversations.state })
    .from(conversations)
    .orderBy(conversations.ref);
}
export async function trialOrderIds(tx: Tx): Promise<string[]> {
  return (await tx.select({ id: orders.id }).from(orders).orderBy(orders.id)).map((r) => r.id);
}
export async function trialBaseline(tx: Tx) {
  const sop = await readPublishedSop(tx);
  const catalog = await readActiveCatalog(tx);
  const versions = await readCatalogVersions(tx);
  if (
    !sop ||
    sop.packId !== 'industrial' ||
    !catalog.length ||
    catalog.some((r) => r.kind !== 'part' || !(r.payload.certs as unknown[])?.includes('合成演示数据'))
  )
    throw new Error('trial_synthetic_catalog_required');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({ sop: [sop.id, sop.rev, sop.sopHash], catalog: catalog.map((r) => [r.code, r.rev, r.version, r.payload]), versions }),
    )
    .digest('hex');
  return { hash, catalog, versions, sop };
}
export async function trialQuiescent(tx: Tx): Promise<void> {
  const [out] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(outboundSends)
    .where(sql`${outboundSends.status} in ('pending','sending','unknown')`);
  const [inbound] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(channelInbox)
    .where(sql`${channelInbox.state} not in ('done','abandoned')`);
  const [erp] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from erp_connectors where status = 'active'`));
  if (out?.n || inbound?.n || erp?.n) throw new Error('trial_recovery_or_erp_pending');
}
/** 平台逐租户检查 FORCE RLS 下的成员关系，不能在未设租户时把空结果当无关系。 */
export async function trialTenantRows(db: Db) {
  return db.select({ id: tenants.id, slug: tenants.slug, packId: tenants.packId, kind: tenants.kind }).from(tenants);
}
export async function trialMembers(tx: Tx) {
  return tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships);
}
export async function trialOldLinksDetached(tx: Tx, ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return true;
  const linked = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(sql`${orders.id} = any(${sql.param([...ids])}::text[])`, sql`${orders.sessionId} is not null`));
  return linked.length === 0;
}
export async function trialRole(db: Db): Promise<string> {
  const [r] = rowsOf<{ role: string }>(await db.execute(sql`select current_user as role`));
  return r?.role ?? '';
}
