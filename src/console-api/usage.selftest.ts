// 14 验收 10：真实成员登录、逐角色授权、租户 RLS、月份边界；响应只含 R9 的聚合字段。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { hostRuntime, createTenantRuntime, withTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import { setSandboxSession } from '../tenancy/sandbox/session.js';

fs.mkdirSync('var', { recursive: true });
const directory = fs.mkdtempSync(path.resolve('var/console-usage-'));
process.env.VAR_DIR = directory;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
const host = hostRuntime();
enterTenantScopeForTest(host);
const { openTestDb, installSeededConfig, installPgSessionStore } = await import('../db/testing.js');
const { createUser } = await import('../auth/accounts.js');
const { SESSION_COOKIE } = await import('../auth/session.js');
const { initSessionStore } = await import('../store.js');
const { runShutdownHooks } = await import('../shutdown.js');
const { __profileTest } = await import('../profile.js');
const t = await openTestDb();
try {
  await installSeededConfig(t);
  const su = async (sql: string, params: unknown[] = []) =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<Record<string, unknown>>(sql, params)).rows;
    });
  const roles = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
  for (const role of roles) {
    await t.pg.exec('SET ROLE agent_platform');
    const result = await createUser(t.db, {
      tenantSlug: 'demo',
      email: `${role}@erp.example.test`,
      name: role,
      role,
      password: async () => `synthetic-${role}-password`,
    });
    assert.equal(result.code, 0, result.message);
  }
  await t.pg.exec('SET ROLE agent_app');
  const fixture = await installPgSessionStore(t, { varDir: directory });
  await initSessionStore(fixture.deps);
  const { consoleApi, __consoleTest } = await import('./app.js');
  const now = new Date(2026, 9, 3, 0, 30).getTime();
  __consoleTest.setClock(() => now);
  const tokens = new Map<string, string>();
  for (const [i, role] of roles.entries()) {
    const response = await consoleApi.request('/api/console/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${i + 1}`,
      },
      body: JSON.stringify({ email: `${role}@erp.example.test`, password: `synthetic-${role}-password` }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const token = response.headers.get('set-cookie')?.match(/^[^=]+=([^;]+)/)?.[1];
    assert.ok(token);
    tokens.set(role, token);
  }
  await su('update tenants set monthly_reply_quota=10,llm_daily_cap_milli=500 where id=$1', [host.id]);
  const other = await su("insert into tenants(slug,name,pack_id) values ('usage-other','合成租户','travel') returning id");
  await su(
    `insert into usage_daily(tenant_id,day,model,purpose,calls,cost_milli_cny) values
    ($1,'2026-10-01','-','reply',2,0), ($1,'2026-10-03','-','reply',3,0),
    ($1,'2026-10-03','synthetic-chat','chat',99,123), ($1,'2026-10-03','synthetic-draft','draft',5,10),
    ($1,'2026-09-30','-','reply',777,0), ($1,'2026-11-01','-','reply',888,0),
    ($2,'2026-10-03','-','reply',999,0), ($2,'2026-10-03','synthetic-chat','chat',9,9999)`,
    [host.id, other[0]!.id],
  );
  const headers = (role?: string): Record<string, string> =>
    role ? { cookie: `${SESSION_COOKIE}=${tokens.get(role)}`, 'x-forwarded-for': '203.0.113.100' } : {};
  const expected = {
    status: 'active',
    month: '2026-10',
    replies: { used: 5, quota: 10 },
    daily: { costMilli: 133, capMilli: 500 },
    days: [
      { day: '2026-10-01', replies: 2, costMilli: 0 },
      { day: '2026-10-03', replies: 3, costMilli: 133 },
    ],
  };
  for (const role of roles) {
    const response = await consoleApi.request('/api/console/usage', { headers: headers(role) });
    const allowed = role === 'owner' || role === 'admin';
    assert.equal(response.status, allowed ? 200 : 403, `14 验收 10 ${role}`);
    if (allowed) assert.deepEqual(await response.json(), expected, `14 验收 10 ${role} 本月与逐日用量，不含会话内容`);
    else assert.equal((await response.json()).error, 'forbidden');
    console.log(`14 验收 10 PASS: ${role} → ${response.status}`);
  }
  for (const profile of ['demo', 'prod'] as const) {
    __profileTest.use({ DEPLOY_PROFILE: profile });
    const response = await consoleApi.request('/api/console/usage');
    assert.equal(response.status, 403, `14 验收 10 ${profile} 匿名`);
    console.log(`14 验收 10 PASS: ${profile} 匿名 → 403`);
  }
  __profileTest.reset();
  const sandbox = createTenantRuntime({ id: 'usage-sandbox', slug: 'usage-sandbox', kind: 'sandbox' });
  sandbox.config.dbInstalled = true;
  const sandboxApp = new Hono()
    .use('*', async (c, next) => {
      setSandboxSession(c, {
        status: 'ok',
        token: 'synthetic',
        runtime: sandbox,
        expiresAt: new Date(now + 60_000).toISOString(),
        user: { userId: 'synthetic', tenantId: sandbox.id, role: 'owner', displayName: '合成沙箱', csrf: 'synthetic' },
      });
      return withTenantScope(sandbox, next);
    })
    .route('/', consoleApi);
  const sandboxResponse = await sandboxApp.request('/api/console/usage');
  assert.equal(sandboxResponse.status, 403, '14 验收 10 沙箱 owner');
  console.log('14 验收 10 PASS: 沙箱 owner → 403');
  await su('delete from usage_daily where tenant_id=$1', [host.id]);
  await su('update tenants set monthly_reply_quota=null,llm_daily_cap_milli=0 where id=$1', [host.id]);
  assert.deepEqual(
    await (await consoleApi.request('/api/console/usage', { headers: headers('owner') })).json(),
    {
      status: 'active',
      month: '2026-10',
      replies: { used: 0, quota: null },
      daily: { costMilli: 0, capMilli: 0 },
      days: [],
    },
    '14 验收 10 空月份/NULL/0',
  );
  await su("update tenants set status='suspended' where id=$1", [host.id]);
  assert.equal((await consoleApi.request('/api/console/usage', { headers: headers('owner') })).status, 403, '停用会话失效后按匿名拒绝');
  __consoleTest.reset();
  console.log('CONSOLE USAGE SELFTEST PASS: 14 验收 10、月边界/时区、空月、用途分账、跨租户隔离、停用鉴权');
} finally {
  __profileTest.reset();
  await runShutdownHooks();
  await host.store.pgBackend?.close();
  await t.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
