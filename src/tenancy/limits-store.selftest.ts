// 14：poisoned 已服务回复计数一次，真实 spill 回放不重复计数。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-store-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', ALERT_WEBHOOK_URL: '' });
const runtime = await import('./runtime.js');
const { dropTenantState } = await import('./state.js');
const store = await import('../store.js');
const limits = await import('./limits.js');
const config = await import('../config/source.js');
const testing = await import('../db/testing.js');
const { openDb } = await import('../db/client.js');
const { importConfig } = await import('../config/transfer.js');
const { openPgBackend } = await import('../store/pg-backend.js');
const { flushUsageDaily } = await import('../trace/usage-daily.js');
type Db = import('../db/client.js').Db;
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

async function suite(db: Db, query: Query, label: string) {
  const slug = `limits-store-${label}`;
  const rt = runtime.createTenantRuntime({ id: slug, slug });
  const varDir = path.join(dir, label);
  fs.mkdirSync(varDir);
  await query("insert into tenants(slug,name,pack_id) values ($1,$1,'travel')", [slug]);
  await runtime.withTenantScope(rt, async () => {
    try {
      const deps = testing.testConfigDeps({ db }, { tenantSlug: slug });
      const imported = await importConfig({
        db,
        tenantSlug: slug,
        dataDir: 'data',
        imageSop: deps.imageSop,
        lock: async () => testing.fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await config.initConfig(deps);
      await store.initSessionStore({ db, tenantId: rt.id, tenantSlug: slug, varDir });
      const s = store.getOrCreateSession('wecom:wmCountBad', 'wecom');
      s.messages.push({ role: 'customer', content: '第一条', at: Date.now() });
      store.saveSession(s);
      await store.flushSession(s.id);
      // 可恢复的数据类故障，保留连续 seq，回放时不修改消息或 spill 内容。
      await query(
        `create function review_poison() returns trigger language plpgsql as $$ begin raise check_violation using message='synthetic_poison'; end $$`,
      );
      await query('create trigger review_poison before insert on messages for each row execute function review_poison()');
      s.messages.push({ role: 'customer', content: '故障期间入站', at: Date.now() });
      store.saveSession(s);
      await assert.rejects(store.flushSession(s.id), store.StoreLaggingError);
      assert.equal(rt.store.pgBackend!.isPoisoned(s.id), true);
      const before = limits.getTenantLimits()!.monthlyUsed;
      const reply = { role: 'agent' as const, content: '故障期间已服务的回复', at: Date.now() };
      s.messages.push(reply);
      store.saveSession(s);
      const seq = store.seqOf(reply);
      assert.equal(seq, 3, 'poisoned 宽松序号仍只分配一次');
      assert.equal(limits.getTenantLimits()!.monthlyUsed, before + 1);
      store.saveSession(s);
      store.saveSession(s, false);
      assert.equal(store.seqOf(reply), seq);
      assert.equal(limits.getTenantLimits()!.monthlyUsed, before + 1, '重复保存不重复计数');
      await flushUsageDaily();
      const count = async () =>
        (
          await query<{ n: number }>("select coalesce(sum(calls),0)::int as n from usage_daily where tenant_id=$1 and purpose='reply'", [
            rt.id,
          ])
        )[0]!.n;
      assert.equal(await count(), 1);
      assert.equal(rt.store.pgBackend!.spillSync(), 1);
      const spill = fs.readdirSync(varDir).find((name) => name.startsWith('store-spill-') && name.endsWith('.json'))!;
      const original = fs.readFileSync(path.join(varDir, spill));
      rt.store.pgBackend!.close();
      await query('drop trigger review_poison on messages');
      await query('drop function review_poison()');
      const replay = async () => {
        const backend = await openPgBackend({
          runtime: rt,
          db,
          tenantId: rt.id,
          varDir,
          sessions: new Map(),
          orders: new Map(),
          writable: () => true,
          onConflict: (detail) => assert.fail(detail),
        });
        backend.install();
        const stats = backend.stats();
        backend.close();
        return stats;
      };
      assert.equal((await replay()).replayed, 1);
      assert.equal(await count(), 1, 'spill 直接回放行，不经新消息计数');
      assert.equal(limits.getTenantLimits()!.monthlyUsed, before + 1);
      assert.equal(
        (await query("select * from messages where tenant_id=$1 and conversation_id=$2 and role='agent'", [rt.id, s.id])).length,
        1,
      );
      // 模拟回放提交后、删 spill 前崩溃，再启动仍幂等。
      fs.writeFileSync(path.join(varDir, spill), original);
      assert.equal((await replay()).replaySkipped, 1);
      assert.equal(await count(), 1);
      await limits.initializeTenantLimits();
      assert.equal(limits.getTenantLimits()!.monthlyUsed, before + 1);
      console.log(`14 验收 2 ${label}：poisoned 新回复只计 1；重复保存、spill 回放和提交后崩溃再回放均不重复`);
    } finally {
      limits.stopTenantLimits();
      rt.store.pgBackend?.close();
      await config.closeConfig();
      rt.state = 'closed';
      dropTenantState(rt.id);
      runtime.unregisterRuntime(rt.id);
    }
  });
}
try {
  const t = await testing.openTestDb();
  try {
    await t.migrate();
    await t.pg.exec('SET ROLE agent_app');
    await suite(
      t.db,
      <T>(sql: string, params?: unknown[]) =>
        t.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<T>(sql, params)).rows;
        }),
      'pglite',
    );
  } finally {
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL);
    const app = await openDb(fx.urls.app);
    try {
      await suite(app.db, fx.query, 'pg');
    } finally {
      await app.close();
      await fx.drop();
    }
  } else if (process.env.CI === 'true') throw new Error('CI 必须设 PG_TEST_URL');
  console.log('LIMITS STORE SELFTEST PASS');
} finally {
  limits.stopTenantLimits();
  fs.rmSync(dir, { recursive: true, force: true });
}
