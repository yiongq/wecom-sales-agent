import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openTestDb } from '../testing.js';
import { withTenant } from '../client.js';
import { insertTenant } from './tenants.js';
import { writeAudit } from './audit.js';
import { checkpointTrialReset, assertTrialResetComplete, readTrialBatches } from './trial-reset.js';
import { planTrialReset } from '../../tenancy/trial/seeds.js';

const t = await openTestDb();
try {
  const tenant = await insertTenant(t.db, { slug: 'trial-audit', name: '合成批次', packId: 'industrial', locale: 'zh-CN', region: 'CN' });
  const other = await insertTenant(t.db, {
    slug: 'other-audit',
    name: '其他合成公司',
    packId: 'industrial',
    locale: 'zh-CN',
    region: 'CN',
  });
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  await t.pg.exec('SET ROLE agent_app');
  const first = planTrialReset([randomUUID()]);
  await withTenant(
    t.db,
    ctx,
    async (tx) => {
      await checkpointTrialReset(tx, first);
      // >500 个更新日志后，最早的未完成批次仍必须找到。
      for (let n = 0; n < 501; n++) {
        const p = planTrialReset([]);
        for (const phase of ['planned', 'revoked', 'erased', 'seeded', 'verified', 'complete'] as const)
          await checkpointTrialReset(tx, { ...p, phase });
      }
      await writeAudit(tx, { action: 'synthetic.unrelated', diff: { safe: true } });
    },
    { longRunning: true },
  );
  await assert.rejects(withTenant(t.db, ctx, assertTrialResetComplete), /trial_reset_incomplete/);
  assert.equal((await withTenant(t.db, ctx, readTrialBatches)).size, 502);
  await withTenant(t.db, { ...ctx, tenantId: other.id }, assertTrialResetComplete);
  console.log('PASS 15 验收 6：完整翻页发现早期未完成批次，跨租户不串');
  await withTenant(t.db, ctx, (tx) =>
    checkpointTrialReset(tx, { ...first, phase: 'complete', erasedConversationRefs: first.targetConversationRefs }),
  );
  await assert.rejects(withTenant(t.db, ctx, assertTrialResetComplete), /trial_checkpoint_conflict/);
  console.log('PASS 15 验收 6：跳阶段与损坏审计失败关闭');
} finally {
  await t.close();
}
