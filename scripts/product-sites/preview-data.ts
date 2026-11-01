// 仅由 preview-stack 在一次性数据库和隔离 cwd 中调用；全部内容为合成数据。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, holdTenantLock, withTenant } from '../../src/db/client.js';
import { insertTenant, updatePublicHost, updateRetention } from '../../src/db/repo/tenants.js';
import { createUser } from '../../src/auth/accounts.js';
import { findUserByEmail } from '../../src/db/repo/auth.js';
import { importConfig, defaultDataDir } from '../../src/config/transfer.js';
import { readImageSop } from '../../src/config/brand.js';
import { trialBaseline } from '../../src/db/repo/trial-reset.js';
import { buildTrialSeeds, planTrialReset } from '../../src/tenancy/trial/seeds.js';
import { writeSeedSessions } from '../../src/cli/session-transfer.js';
import { insertTurnTraces } from '../../src/db/repo/traces.js';
import { addUsage } from '../../src/db/repo/usage.js';

export interface PreviewAccount {
  email: string;
  password: string;
}
export async function seedPreview(urls: { app: string; platform: string }, accounts: { owner: PreviewAccount; agent: PreviewAccount }) {
  const platform = await openDb(urls.platform);
  const app = await openDb(urls.app);
  let stage = 'tenants';
  try {
    let industrialId = '';
    for (const [slug, packId, name, host] of [
      ['preview-travel', 'travel', '合成旅游宿主', '127.0.0.1'],
      ['preview-industrial', 'industrial', '合成工业预览', 'localhost'],
    ]) {
      const tenant = await insertTenant(platform.db, {
        id: randomUUID(),
        slug,
        name,
        packId,
        locale: 'zh-CN',
        region: 'CN',
        brand: packId === 'industrial' ? JSON.parse(fs.readFileSync('data/packs/industrial/brand.json', 'utf8')) : null,
      });
      await withTenant(
        platform.db,
        { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'preview-stack', ip: null } },
        (tx) => updatePublicHost(tx, tenant.id, host),
      );
      stage = `import_${packId}`;
      const imported = await importConfig({
        db: app.db,
        tenantSlug: slug,
        dataDir: defaultDataDir(packId),
        imageSop: readImageSop(packId),
        lock: (id) => holdTenantLock(urls.app, id),
      });
      if (imported.code !== 0) throw new Error('preview_config_import');
      if (packId === 'industrial') industrialId = tenant.id;
    }
    stage = 'accounts';
    await updateRetention(platform.db, industrialId, { leadDays: 7, customerDays: 7, traceDays: 7 });
    for (const role of ['owner', 'agent'] as const) {
      const user = await createUser(platform.db, {
        tenantSlug: 'preview-industrial',
        email: accounts[role].email,
        name: role === 'owner' ? '合成管理员' : '共享顾问',
        role,
        password: async () => accounts[role].password,
      });
      if (user.code !== 0) throw new Error('preview_account_create');
    }
    const agent = await findUserByEmail(platform.db, accounts.agent.email);
    if (!agent) throw new Error('preview_agent_missing');
    stage = 'seeds';
    await withTenant(
      app.db,
      { tenantId: industrialId, actor: { kind: 'system', userId: null, name: 'preview-stack', ip: null } },
      async (tx) => {
        const baseline = await trialBaseline(tx);
        const seeds = buildTrialSeeds(planTrialReset([]), Date.now() - 60_000, baseline, agent.id);
        await writeSeedSessions(tx, seeds.sessions, seeds.orders);
        const conversationId = seeds.sessions.find((s) => !s.handedOver)!.id;
        const days = Array.from({ length: 7 }, (_, index) => {
          const date = new Date();
          date.setDate(date.getDate() - (6 - index));
          date.setHours(12, 0, 0, 0);
          const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          return { date, day, index };
        });
        await insertTurnTraces(
          tx,
          days.map(({ date, index }) => ({
            id: randomUUID(),
            conversationId,
            startedAt: date,
            durationMs: 900 + index * 100,
            outcome: index === 3 ? 'handoff' : 'replied',
            sopVersion: baseline.sop.versionNo,
            prefixHash: baseline.sop.prefixHash!,
            catalogVersions: {},
            stageBefore: 'discovery',
            stageAfter: 'quote',
            draft: '合成示例：正在核对型号和数量。',
            finalText: '合成示例：请确认规格和数量。',
            calls: [],
            llm: [],
            signals: null,
          })),
        );
        await addUsage(
          tx,
          days.flatMap(({ day, index }) => [
            {
              day,
              model: '-',
              purpose: 'reply' as const,
              calls: 8 + index,
              promptTokens: 0,
              completionTokens: 0,
              cachedTokens: 0,
              reasoningTokens: 0,
              costMilliCny: 0,
            },
            {
              day,
              model: 'synthetic-preview',
              purpose: 'chat' as const,
              calls: 8 + index,
              promptTokens: 2000,
              completionTokens: 500,
              cachedTokens: 0,
              reasoningTokens: 0,
              costMilliCny: 123 + index * 20,
            },
          ]),
        );
      },
    );
    return industrialId;
  } catch {
    throw new Error(`preview_seed_${stage}`);
  } finally {
    await app.close();
    await platform.close();
  }
}
