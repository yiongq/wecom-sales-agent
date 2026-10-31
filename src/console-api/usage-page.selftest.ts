// 15 验收 5：真实 PG/引擎/usage writer/HTTP/前端贯穿，不以静态 UsageView 夹具替代计数。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import { hostRuntime, withTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import { createRealPgFixture, testConfigDeps } from '../db/testing.js';
import { openDb, holdTenantLock } from '../db/client.js';
import { importConfig } from '../config/transfer.js';
import { initConfig, closeConfig } from '../config/source.js';
import { initSessionStore, flushSession } from '../store.js';
import { handleMessage } from '../core/engine/index.js';
import { flushUsageDaily } from '../trace/usage-daily.js';
import { createUser } from '../auth/accounts.js';
import { runShutdownHooks } from '../shutdown.js';

if (!process.env.PG_TEST_URL) console.log('15 验收 5 REAL USAGE SKIP: PG_TEST_URL required');
else {
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  fs.mkdirSync('var', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('var/usage-page-'));
  Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', LLM_MOCK: '1', FOLLOWUP_ENABLED: '0' });
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'usage-page' });
  const app = await openDb(fx.urls.app),
    platform = await openDb(fx.urls.platform);
  let server: ReturnType<typeof serve> | undefined;
  try {
    const deps = testConfigDeps({ db: app.db }, { tenantSlug: 'usage-page', lock: (id) => holdTenantLock(fx.urls.app, id) });
    assert.equal(
      (await importConfig({ db: app.db, tenantSlug: deps.tenantSlug, dataDir: 'data', imageSop: deps.imageSop, lock: deps.lock })).code,
      0,
    );
    await initConfig(deps);
    await initSessionStore({ db: app.db, tenantId: rt.id, tenantSlug: rt.slug, varDir: dir });
    for (const role of ['owner', 'admin', 'agent'] as const)
      assert.equal(
        (
          await createUser(platform.db, {
            tenantSlug: rt.slug,
            email: `${role}@settings.example.test`,
            name: '合成成员',
            role,
            password: async () => 'synthetic-member-password',
          })
        ).code,
        0,
      );
    const { consoleApi, __consoleTest } = await import('./app.js');
    const http = new Hono().use('*', (_c, next) => withTenantScope(rt, next)).route('/', consoleApi);
    server = serve({ fetch: http.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await new Promise<void>((resolve) => server!.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const child = fork(path.resolve('console/src/settings/settings.selftest.tsx'), ['--real-usage'], {
      execArgv: ['--import', 'tsx'],
      silent: true,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        SETTINGS_TEST_ORIGIN: origin,
        TSX_TSCONFIG_PATH: path.resolve('console/tsconfig.json'),
      },
    });
    let output = '';
    child.stdout!.on('data', (b) => {
      output += String(b);
    });
    child.stderr!.on('data', (b) => {
      output += String(b);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('usage UI timeout'));
      }, 60_000);
      child.on('message', (message: { advanceUsage?: boolean }) => {
        if (message.advanceUsage)
          void withTenantScope(rt, async () => {
            assert.ok((await handleMessage('wecom:wmUsage', '你好', 'wecom')).text);
            await flushSession('wecom:wmUsage');
            await flushUsageDaily();
            const [row] = await fx.query<{ n: number }>(
              "select sum(calls)::int as n from usage_daily where tenant_id=$1 and purpose='reply'",
              [rt.id],
            );
            assert.equal(row.n, 1);
            child.send({ ready: true });
          }).catch((error) => {
            child.kill('SIGKILL');
            clearTimeout(timer);
            reject(error);
          });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`usage UI failed: ${output}`));
      });
    });
    console.log(
      output
        .split('\n')
        .filter((line) => line.includes('15 验收 5'))
        .join('\n'),
    );
    const login = async (role: string) => {
      const response = await consoleApi.request('/api/console/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${role}@settings.example.test`, password: 'synthetic-member-password' }),
      });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get('set-cookie')!.split(';')[0]! };
    };
    const headers = await login('admin');
    const get = () => consoleApi.request('/api/console/usage', { headers });
    assert.equal((await (await get()).json()).replies.used, 1);
    const now = new Date();
    __consoleTest.setClock(() => new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1);
    const previous = await (await get()).json();
    assert.equal(previous.replies.used, 0);
    assert.deepEqual(previous.days, []);
    __consoleTest.reset();
    assert.equal((await (await get()).json()).replies.used, 1);
    await fx.query('update tenants set monthly_reply_quota=0,llm_daily_cap_milli=0 where id=$1', [rt.id]);
    const zero = await (await get()).json();
    assert.equal(zero.replies.quota, 0);
    assert.equal(zero.daily.capMilli, 0);
    assert.equal((await consoleApi.request('/api/console/usage', { headers: await login('agent') })).status, 403);
    console.log('15 验收 5 REAL USAGE PASS: admin reads actual count; month boundary/empty month/zero limits; agent 403');
  } finally {
    (server as Server | undefined)?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await runShutdownHooks();
    await rt.store.pgBackend?.close();
    await closeConfig();
    await app.close();
    await platform.close();
    await fx.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
