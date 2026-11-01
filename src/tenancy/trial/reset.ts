import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { withTenant, type Db, type TenantCtx, type TenantLock } from '../../db/client.js';
import { findUserByEmail, setUserPassword, deleteSessionsOfUser } from '../../db/repo/auth.js';
import { eraseConversation } from '../../db/repo/retention.js';
import { readRetention } from '../../db/repo/tenants.js';
import { readSessionBatch } from '../../db/repo/conversations.js';
import { MIN_PASSWORD_LENGTH } from '../../auth/accounts.js';
import { hashPassword } from '../../auth/password.js';
import { writeAudit } from '../../db/repo/audit.js';
import { writeSeedSessions } from '../../cli/session-transfer.js';
import { normalizeForStore, rebuildSessions, rowToOrder, SPILL_FILE_RE } from '../../store/project.js';
import { RESTORE_SENTINEL } from '../../channels/markers.js';
import {
  checkpointTrialReset,
  readTrialBatches,
  trialBaseline,
  trialConversations,
  trialMembers,
  trialOrderIds,
  trialQuiescent,
  trialRole,
  trialTenantRows,
  trialOldLinksDetached,
} from '../../db/repo/trial-reset.js';
import { buildTrialSeeds, planTrialReset } from './seeds.js';

/** 平台私有盘点文件，不进仓库。精确 ref 清单是人工确认数据用途后的签收，不能根据消息内容猜正式/试用。 */
export function trialApprovalSchema() {
  return z.strictObject({
    allowlist: z
      .array(
        z.strictObject({
          tenantId: z.uuid(),
          slug: z.string().min(1),
          packId: z.literal('industrial'),
          kind: z.literal('standard'),
          isHost: z.literal(false),
        }),
      )
      .min(1),
    sharedEmail: z.email(),
    reviewedConversationRefs: z.array(z.uuid()),
    reviewedOrderIds: z.array(z.string()),
    baselineHash: z.string().regex(/^[a-f0-9]{64}$/),
  });
}
export type TrialApproval = z.infer<ReturnType<typeof trialApprovalSchema>>;
export function checkTrialFiles(varDir: string): void {
  // 不存在/不可读也拒绝，避免传错共享目录得到假阴性。
  const names = fs.readdirSync(fs.realpathSync(varDir));
  if (names.some((name) => SPILL_FILE_RE.test(name) || name === RESTORE_SENTINEL)) throw new Error('trial_spill_or_restore_pending');
}
const ctx = (tenantId: string, platform: boolean): TenantCtx => ({
  tenantId,
  actor: { kind: platform ? 'platform' : 'system', userId: null, name: 'trial-reset', ip: null },
});
const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length || new Set(a).size !== a.length) return false;
  const right = b.toSorted();
  return a.toSorted().every((v, i) => v === right[i]);
};
export interface TrialResetOptions {
  app: Db;
  platform: Db;
  tenantSlug: string;
  hostSlug: string;
  varDir: string;
  approval: TrialApproval;
  batch?: string;
  lock: () => Promise<TenantLock | null>;
  password: () => Promise<string>;
}
export async function resetTrial(o: TrialResetOptions): Promise<string> {
  const approval = trialApprovalSchema().parse(o.approval);
  if (!o.hostSlug || o.hostSlug === o.tenantSlug) throw new Error('trial_host_forbidden');
  if ((await trialRole(o.app)) !== 'agent_app' || (await trialRole(o.platform)) !== 'agent_platform')
    throw new Error('trial_database_roles');
  const all = await trialTenantRows(o.app);
  const tenant = all.find((t) => t.slug === o.tenantSlug);
  const allowed = approval.allowlist.filter((a) => a.slug === o.tenantSlug);
  if (
    !tenant ||
    allowed.length !== 1 ||
    allowed[0]!.tenantId !== tenant.id ||
    tenant.kind !== 'standard' ||
    tenant.packId !== 'industrial' ||
    !all.some((t) => t.slug === o.hostSlug)
  )
    throw new Error('trial_allowlist_mismatch');
  // 两个连接必须看到同一个精确租户目录；角色仍分别检查，不能用 owner 绕权限。
  if (
    !isDeepStrictEqual(
      all.toSorted((a, b) => a.id.localeCompare(b.id)),
      (await trialTenantRows(o.platform)).toSorted((a, b) => a.id.localeCompare(b.id)),
    )
  )
    throw new Error('trial_database_mismatch');
  checkTrialFiles(o.varDir);
  const lock = await o.lock();
  if (!lock) throw new Error('trial_lock_held');
  const lost = new AbortController();
  lock.onLost(() => lost.abort(new Error('trial_lock_lost')));
  const check = () => {
    lost.signal.throwIfAborted();
    checkTrialFiles(o.varDir);
  };
  const app = <T>(fn: Parameters<typeof withTenant<T>>[2]) => {
    check();
    return withTenant(o.app, ctx(tenant.id, false), fn, { signal: lost.signal });
  };
  const platform = <T>(fn: Parameters<typeof withTenant<T>>[2]) => {
    check();
    return withTenant(o.platform, ctx(tenant.id, true), fn, { signal: lost.signal });
  };
  try {
    const retention = await readRetention(o.app, tenant.id);
    if (!retention || Object.values(retention).some((n) => n !== 7)) throw new Error('trial_retention_must_be_7');
    const user = await findUserByEmail(o.platform, approval.sharedEmail);
    if (!user || user.disabledAt) throw new Error('trial_shared_user_missing');
    let agentCount = 0;
    for (const t of all) {
      check();
      const members = await withTenant(o.platform, ctx(t.id, true), trialMembers, { signal: lost.signal });
      if (members.some((m) => m.userId === user.id && (t.id !== tenant.id || m.role !== 'agent')))
        throw new Error('trial_shared_user_cross_tenant');
      if (t.id === tenant.id) {
        agentCount = members.filter((m) => m.role === 'agent').length;
        if (!members.some((m) => m.userId === user.id && m.role === 'agent')) throw new Error('trial_shared_user_role');
      }
    }
    if (agentCount !== 1) throw new Error('trial_single_agent_required');
    const batches = await app(readTrialBatches);
    const pending = [...batches.values()].filter((b) => b.checkpoint.phase !== 'complete');
    if (pending.length > 1 || (!o.batch && pending.length)) throw new Error('trial_resume_batch_required');
    let batch = o.batch ? batches.get(o.batch) : undefined;
    if (o.batch && !batch) throw new Error('trial_batch_unknown');
    if (pending.length && pending[0] !== batch) throw new Error('trial_pending_batch');
    const baseline = await app(trialBaseline);
    if (baseline.hash !== approval.baselineHash) throw new Error('trial_baseline_changed');
    await app(trialQuiescent);
    let rows = await app(trialConversations);
    const oldIds = approval.reviewedOrderIds;
    const seedOrderIds = batch?.checkpoint.seedIds.flatMap((s) => (s.orderId ? [s.orderId] : [])) ?? [];
    const actualOrders = await app(trialOrderIds);
    const hasSeeds = batch && ['seeded', 'verified', 'complete'].includes(batch.checkpoint.phase);
    if (!sameSet(actualOrders, [...oldIds, ...(hasSeeds ? seedOrderIds : [])])) throw new Error('trial_unreviewed_orders');
    if (!batch) {
      if (
        !sameSet(
          rows.map((r) => r.ref),
          approval.reviewedConversationRefs,
        )
      )
        throw new Error('trial_unreviewed_conversations');
      const p = planTrialReset(rows.map((r) => r.ref));
      // 所有前置校验和种子构建先完成；失败不会留下 planned。
      buildTrialSeeds(p, Date.now(), baseline, user.id);
      await platform((tx) => checkpointTrialReset(tx, p));
      batch = (await app(readTrialBatches)).get(p.batch)!;
    }
    let p = batch.checkpoint;
    // 合同没有让恢复命令覆盖配置；版本时间由 PG 生成，审批文件不能借换 hash 接受批次后的新版本。
    if (
      !baseline.sop.publishedAt ||
      baseline.sop.publishedAt > batch.plannedAt ||
      baseline.catalog.some((r) => r.updatedAt > batch.plannedAt) ||
      baseline.versions.some((v) => v.createdAt > batch.plannedAt)
    )
      throw new Error('trial_baseline_after_plan');
    if (!sameSet(p.targetConversationRefs, approval.reviewedConversationRefs)) throw new Error('trial_review_changed');
    const expectedRefs = p.targetConversationRefs.filter((ref) => !p.erasedConversationRefs.includes(ref));
    const expectedSeeds = hasSeeds ? p.seedIds.map((s) => s.sessionId) : [];
    if (
      !sameSet(
        rows.filter((r) => !expectedSeeds.includes(r.id)).map((r) => r.ref),
        expectedRefs,
      )
    )
      throw new Error('trial_remaining_refs_conflict');
    const seeds = buildTrialSeeds(p, batch.plannedAt.getTime(), baseline, user.id);
    const advance = async (phase: typeof p.phase) => {
      const next = { ...p, phase };
      await platform((tx) => checkpointTrialReset(tx, next));
      p = next;
    };
    if (p.phase === 'planned') {
      check();
      const password = await o.password();
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error('trial_password_too_short');
      const passwordHash = await hashPassword(password);
      check();
      const next = { ...p, phase: 'revoked' as const };
      // 与 user-password 复用受控输入、hash/密码长度、repo 与审计语义；这里加入批次，整次改密/吊销/阶段同事务。
      await platform(async (tx) => {
        await setUserPassword(tx, user.id, passwordHash);
        const revokedSessions = await deleteSessionsOfUser(tx, user.id);
        await writeAudit(tx, {
          action: 'platform.user_password',
          targetType: 'user',
          targetId: user.id,
          diff: { email: user.email, revokedSessions },
        });
        await checkpointTrialReset(tx, next);
      });
      p = next;
    }
    if (p.phase === 'revoked') {
      for (const ref of p.targetConversationRefs) {
        if (p.erasedConversationRefs.includes(ref)) continue;
        const row = rows.find((r) => r.ref === ref);
        if (!row) throw new Error('trial_erase_unproven');
        const next = { ...p, erasedConversationRefs: [...p.erasedConversationRefs, ref] };
        // 行权证据和逐项 checkpoint 同一平台事务，不存在删除已提交但进度未记的窗口。
        await platform(async (tx) => {
          const counts = await eraseConversation(tx, row.id, `trial_reset:${p.batch}:${ref}`);
          if (counts.conversations !== 1) throw new Error('trial_erase_conflict');
          await checkpointTrialReset(tx, next);
        });
        p = next;
      }
      await advance('erased');
    }
    if (p.phase === 'erased') {
      if ((await app(trialConversations)).length) throw new Error('trial_erase_incomplete');
      const next = { ...p, phase: 'seeded' as const };
      await app(async (tx) => {
        await writeSeedSessions(tx, seeds.sessions, seeds.orders);
        await checkpointTrialReset(tx, next);
      });
      p = next;
    }
    // 读与预载相同的行和消息，验证 seq、状态、订单快照，且旧订单均去关联。
    const stored = await app(async (tx) => {
      const data = await readSessionBatch(tx, null, 100);
      return { sessions: rebuildSessions(data.rows, data.messages).map((r) => r.session), orders: data.orders.map(rowToOrder) };
    });
    const sorted = <T extends { id: string }>(items: T[]) => items.toSorted((a, b) => a.id.localeCompare(b.id));
    if (
      stored.sessions.some((s) => !s) ||
      !isDeepStrictEqual(normalizeForStore(sorted(stored.sessions as typeof seeds.sessions)), normalizeForStore(sorted(seeds.sessions))) ||
      !isDeepStrictEqual(normalizeForStore(sorted(stored.orders)), normalizeForStore(sorted(seeds.orders)))
    )
      throw new Error('trial_seed_verification_failed');
    const afterBaseline = await app(trialBaseline);
    if (afterBaseline.hash !== approval.baselineHash) throw new Error('trial_baseline_changed');
    rows = await app(trialConversations);
    if (rows.some((r) => p.targetConversationRefs.includes(r.ref))) throw new Error('trial_old_conversation_survived');
    if (!(await app((tx) => trialOldLinksDetached(tx, oldIds)))) throw new Error('trial_old_link_survived');
    if (p.phase === 'seeded') await advance('verified');
    if (p.phase === 'verified') await advance('complete');
    check();
    return p.batch;
  } finally {
    await lock.release();
  }
}
