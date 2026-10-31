import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { setSandboxSession } from '../tenancy/sandbox/session.js';
import { csrfFor } from '../auth/session.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import { hostRuntime, createTenantRuntime, withTenantScope } from '../tenancy/runtime.js';
import { createRealPgFixture, openTestDb, installSeededConfig, testConfigDeps } from '../db/testing.js';
import { openDb, holdTenantLock } from '../db/client.js';
import { importConfig } from '../config/transfer.js';
import { initConfig, closeConfig, reloadFromDb } from '../config/source.js';
import { createUser } from '../auth/accounts.js';
import { __profileTest } from '../profile.js';
import { SETTINGS_URLS, type SettingsResponses } from '../shared/console-api.js';

fs.mkdirSync('var', { recursive: true });
const dir = fs.mkdtempSync(path.resolve('var/settings-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1';
process.env.SERVER_SELFTEST = '1';
enterTenantScopeForTest(hostRuntime());
const pg = process.env.PG_TEST_URL ? await createRealPgFixture(process.env.PG_TEST_URL) : null;
const local = pg ? null : await openTestDb();
const app = pg ? await openDb(pg.urls.app) : null;
const platform = pg ? await openDb(pg.urls.platform) : null;
const db = app?.db ?? local!.db;
const query = pg
  ? pg.query
  : async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
      local!.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(text, params)).rows;
      });
try {
  if (pg) {
    const deps = testConfigDeps({ db }, { lock: (id) => holdTenantLock(pg.urls.app, id) });
    assert.equal((await importConfig({ db, tenantSlug: 'demo', dataDir: 'data', imageSop: deps.imageSop, lock: deps.lock })).code, 0);
    await initConfig(deps);
  } else await installSeededConfig(local!);
  const tenant = hostRuntime().id;
  const { consoleApi } = await import('./app.js');
  for (const role of ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const) {
    if (local) await local.pg.exec('SET ROLE agent_platform');
    const r = await createUser(platform?.db ?? db, {
      tenantSlug: 'demo',
      name: role,
      role,
      email: `${role}@settings.example.test`,
      password: async () => 'synthetic-member-password',
    });
    assert.equal(r.code, 0, r.message);
  }
  if (local) await local.pg.exec('SET ROLE agent_app');
  const cookies = new Map<string, string>();
  for (const [i, role] of ['owner', 'admin', 'supervisor', 'agent', 'viewer'].entries()) {
    const r = await consoleApi.request('/api/console/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i + 1}` },
      body: JSON.stringify({ email: `${role}@settings.example.test`, password: 'synthetic-member-password' }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    cookies.set(role, r.headers.get('set-cookie')!.split(';')[0]!);
  }
  const get = (page: Exclude<keyof SettingsResponses, 'usage'>, role?: string, suffix = '') =>
    consoleApi.request(SETTINGS_URLS[page] + suffix, { headers: role ? { cookie: cookies.get(role)! } : {} });
  const pages = ['organization', 'members', 'channels', 'onboarding'] as const;
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  for (const page of pages) {
    const anonymous = await get(page);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.equal((await get(page, 'owner')).headers.get('cache-control'), 'no-store');
    for (const role of ['owner', 'admin', 'supervisor', 'agent', 'viewer'])
      assert.equal((await get(page, role)).status, ['owner', 'admin'].includes(role) ? 200 : 403, `15 验收 3 ${page}/${role}`);
    for (const param of ['tenantId', 'tenant_id', 'actor', 'role'])
      assert.equal((await get(page, 'owner', `?${param}=forged`)).status, 403);
  }
  __profileTest.use({ DEPLOY_PROFILE: 'demo' });
  for (const page of pages) assert.equal((await get(page)).status, 403);
  console.log('15 验收 3 PASS: real login, four APIs, five roles, anonymous prod/demo, forged identity');
  const sandbox = createTenantRuntime({ id: randomUUID(), slug: 'settings-sandbox', kind: 'sandbox' });
  sandbox.config.dbInstalled = true;
  const sandboxApp = new Hono()
    .use('*', async (c, next) => {
      setSandboxSession(c, {
        status: 'ok',
        token: 'synthetic',
        runtime: sandbox,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: { userId: 'synthetic', tenantId: sandbox.id, role: 'owner', displayName: '合成沙箱', csrf: 'synthetic' },
      });
      return withTenantScope(sandbox, next);
    })
    .route('/', consoleApi);
  for (const page of pages) {
    assert.equal((await sandboxApp.request(SETTINGS_URLS[page])).status, 403, '15 验收 3 sandbox owner');
    assert.equal(
      (
        await consoleApi.request(SETTINGS_URLS[page], {
          method: 'POST',
          headers: {
            cookie: cookies.get('owner')!,
            'x-csrf': csrfFor(cookies.get('owner')!.slice(cookies.get('owner')!.indexOf('=') + 1)),
          },
        })
      ).status,
      404,
      '15 验收 4 no write routes',
    );
  }
  const members = (await (await get('members', 'owner')).json()) as SettingsResponses['members'];
  assert.equal(members.items.length, 5);
  assert.deepEqual(Object.keys(members.items[0]!).sort(), ['disabled', 'displayName', 'email', 'role', 'userId']);
  const org = (await (await get('organization', 'owner')).json()) as SettingsResponses['organization'];
  assert.equal(org.publishedBrandName, null);
  assert.equal(org.pendingBrandChange, false);
  const brand = JSON.parse(fs.readFileSync('data/packs/industrial/brand.json', 'utf8'));
  await query('update tenants set brand=$2 where id=$1', [tenant, JSON.stringify(brand)]);
  const pending = (await (await get('organization', 'owner')).json()) as SettingsResponses['organization'];
  assert.equal(pending.publishedBrandName, null);
  assert.equal(pending.pendingBrandChange, true);
  await query('update tenants set brand=null where id=$1', [tenant]);
  const webId = randomUUID(),
    wecomId = randomUUID();
  await query(
    `insert into channel_accounts(tenant_id,id,key,name,kind,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id) values
    ($1,$2,'web-test','合成网页','web','active',null,null,null,null,null),($1,$3,'wc-test','合成企微','wecom_kf','disabled','wecom:','synthetic-corp','synthetic-kf',decode('0000','hex'),'synthetic')`,
    [tenant, webId, wecomId],
  );
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  const channels = (await (await get('channels', 'owner')).json()) as SettingsResponses['channels'];
  assert.equal(channels.items.length, 2);
  assert.equal(channels.items.find((a) => a.accountId === webId)!.blockedByProfile, true);
  assert.ok(channels.items.every((a) => !a.loaded && a.lastInboundAt === null));
  assert.equal(channels.items.find((a) => a.accountId === wecomId)!.credentialsConfigured, true);
  assert.ok(!JSON.stringify(channels).includes('synthetic-corp'));
  assert.ok(!JSON.stringify(channels).includes('synthetic-kf'));
  let steps = ((await (await get('onboarding', 'owner')).json()) as SettingsResponses['onboarding']).steps;
  assert.equal(steps.find((s) => s.key === 'team')!.state, 'done');
  assert.equal(steps.find((s) => s.key === 'catalog')!.state, 'done');
  assert.equal(steps.find((s) => s.key === 'sop')!.state, 'done');
  assert.equal(steps.find((s) => s.key === 'channel')!.state, 'blocked');
  assert.ok(steps.every((s) => s.href.startsWith('/console/') && !s.href.includes(':kind')));
  for (let i = 0; i < 2; i++) await get('onboarding', 'owner');
  steps = ((await (await get('onboarding', 'owner')).json()) as SettingsResponses['onboarding']).steps;
  assert.equal(steps.find((s) => s.key === 'channel')!.state, 'blocked', 'clicks never mark done');
  console.log('15 验收 4/5 PASS: published/pending brand, member whitelist, channel configuration/runtime/profile, factual onboarding');
  const others = members.items.filter((m) => m.role !== 'owner').map((m) => m.userId);
  await query('update users set disabled_at=now() where id=any($1::uuid[])', [others]);
  assert.equal(
    ((await (await get('onboarding', 'owner')).json()) as SettingsResponses['onboarding']).steps.find((s) => s.key === 'team')!.state,
    'todo',
  );
  assert.ok(
    ((await (await get('members', 'owner')).json()) as SettingsResponses['members']).items
      .filter((m) => m.role !== 'owner')
      .every((m) => m.disabled),
  );
  await query('update users set disabled_at=null where id=any($1::uuid[])', [others]);
  await query('revoke execute on function public.console_members_read(uuid,text) from agent_app');
  try {
    const failed = await get('members', 'owner');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal' });
  } finally {
    await query('grant execute on function public.console_members_read(uuid,text) to agent_app');
  }
  console.log('15 验收 4 PASS: query failure returns internal, never an empty success or SQL detail');
  const other = (
    await query<{ id: string }>("insert into tenants(slug,name,pack_id) values ('settings-other','合成乙','travel') returning id")
  )[0]!.id;
  await query("insert into channel_accounts(tenant_id,key,name,kind,status) values ($1,'other-web','隔离网页','web','disabled')", [other]);
  assert.equal(((await (await get('channels', 'owner')).json()) as SettingsResponses['channels']).items.length, 2);
  await query("update memberships set role='agent' where tenant_id=$1 and user_id=$2", [
    tenant,
    members.items.find((m) => m.role === 'admin')!.userId,
  ]);
  for (const page of pages) assert.equal((await get(page, 'admin')).status, 403);
  await query("update auth_sessions set expires_at=now()-interval '1 hour' where user_id=$1", [
    members.items.find((m) => m.role === 'owner')!.userId,
  ]);
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  for (const page of pages) assert.equal((await get(page, 'owner')).status, 401);
  await reloadFromDb();
  console.log(`15 验收 3 PASS: ${pg ? 'real PG' : 'PGlite'} RLS, CLI-equivalent changes, immediate downgrade/expiry`);
} finally {
  __profileTest.reset();
  await closeConfig();
  await platform?.close();
  await app?.close();
  await local?.close();
  await pg?.drop();
  fs.rmSync(dir, { recursive: true, force: true });
}
