// 第 6 步评审回归：真实 boot 边界、HTTP 错误、模块装载、文件拒绝与退出恢复。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
if (!mode) {
  for (const child of ['single', 'multi', 'zero', 'storage', 'schema']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), child], {
      env: { ...process.env, CONFIG_SOURCE: 'file', TENANCY_STRICT: '1', APP_ROLE: child === 'zero' ? 'sandbox' : 'host' },
      encoding: 'utf8',
      timeout: 45_000,
    });
    assert.equal(result.status, 0, `${child}: ${result.stdout}\n${result.stderr}`);
    if (result.stdout.includes('EPERM')) console.log(`${child}: listen 被沙箱拒绝，已验证 boot 创建的 HTTP 异步资源与应用请求路径`);
  }
  console.log('TENANCY REVIEW SELFTEST PASS: 启动 / 模块订阅 / HTTP 500 / SSE 摘监听 / 文件拒绝 / exit / schema');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-review-'));
  process.env.VAR_DIR = path.join(dir, 'host');
  process.env.SERVER_SELFTEST = '1';
  const r = await import('./runtime.js');
  // 必须在任何 runtime 登记、任何 withTenantScope 之前加载；复现严格模式模块加载期订阅。
  await import('../core/retrieval.js');
  assert.equal(r.scopedRuntime(), undefined);
  assert.equal(r.tenantRuntimes().length, 0);
  const s = await import('../store.js');
  try {
    if (mode === 'zero') {
      const { Hono } = await import('hono');
      const app = new Hono().use('*', r.tenantScopeMiddleware).get('/', (c) => c.text('ok'));
      app.onError((e, c) => {
        assert.ok(e instanceof r.TenantScopeMissing);
        return c.text('internal', 500);
      });
      assert.equal((await app.request('/')).status, 500);
      assert.equal(r.tenantRuntimes().length, 0);
      assert.equal(fs.existsSync(process.env.VAR_DIR!), false);
    } else if (mode === 'storage') {
      const bad = r.createTenantRuntime({ id: 'bad', slug: 'bad' });
      const host = r.hostRuntime();
      const lazy = r.createTenantRuntime({ id: 'lazy', slug: 'lazy', isHost: true });
      r.registerRuntime(bad);
      r.registerRuntime(lazy);
      r.identifyRuntime(host, { id: 'host', slug: 'host' }); // 宿主现在在登记表末尾。
      assert.equal(bad.store.fileBackend, null);
      assert.throws(
        () => r.withTenantScope(bad, () => s.saveSession({ id: 'same', messages: [] } as unknown as import('../types.js').Session)),
        /只有宿主/,
      );
      const { createFileBackend } = await import('../store/file-backend.js');
      const backend = createFileBackend({
        runtime: bad,
        varDir: path.join(dir, 'bad'),
        sessions: new Map(),
        orders: new Map(),
        owns: () => true,
        ownsOrder: () => true,
        isReal: () => true,
        afterPersist: () => assert.fail('非宿主不能异步写文件'),
      });
      assert.throws(() => backend.markChanged(['same']), /只有宿主/);
      assert.throws(() => backend.scheduleOrder('same'), /只有宿主/);
      assert.equal(backend.keyCount(), 0);
      await new Promise((resolve) => setTimeout(resolve, 240));
      assert.equal(fs.existsSync(path.join(dir, 'bad')), false);
      const visited: string[] = [];
      const file = host.store.fileBackend!;
      const oldSpill = file.spillSync;
      file.spillSync = () => {
        assert.equal(r.currentRuntime(), host);
        visited.push('host');
        return 0;
      };
      const pg = {
        spillSync: () => {
          assert.equal(r.currentRuntime(), bad);
          visited.push('bad');
          throw new Error('broken');
        },
      } as unknown as NonNullable<import('../store.js').TenantStore['pgBackend']>;
      bad.store.pgBackend = pg;
      const oldError = console.error;
      const errors: unknown[][] = [];
      console.error = (...args) => {
        errors.push(args);
      };
      try {
        s.spillStoresSync();
        assert.deepEqual(visited, ['host', 'bad']);
        assert.equal(errors.length, 1);
        assert.equal(r.tenantStoreIfLoaded(lazy), undefined);
      } finally {
        console.error = oldError;
        file.spillSync = oldSpill;
        bad.store.pgBackend = null;
      }
      assert.equal(host.events.last, 0);
      assert.notEqual(host.events.ring, bad.events.ring);
      assert.notEqual(host.events.listeners, bad.events.listeners);
    } else if (mode === 'schema') {
      const { openTestDb } = await import('../db/testing.js');
      const { __configTest, ConfigStartupError } = await import('../config/source.js');
      const db = await openTestDb();
      const deps = { db: db.db } as import('../config/source.js').ConfigDeps;
      try {
        const tenants = await __configTest.loadStandardTenants(deps);
        assert.ok(Array.isArray(tenants));
        await db.pg.exec('DROP TABLE tenants CASCADE');
        await assert.rejects(
          __configTest.loadStandardTenants(deps),
          (e: unknown) => e instanceof ConfigStartupError && e.reason === 'db_unreachable',
        );
        await db.pg.exec('DROP SCHEMA drizzle CASCADE');
        await assert.rejects(
          __configTest.loadStandardTenants(deps),
          (e: unknown) => e instanceof ConfigStartupError && e.reason === 'schema_behind',
        );
      } finally {
        await db.close();
      }
    } else {
      const host = r.hostRuntime();
      if (mode === 'multi') r.registerRuntime(r.createTenantRuntime({ id: 'other', slug: 'other' }));
      r.configureTenancy({ role: 'host', standardCount: mode === 'multi' ? 2 : 1 });
      const { app } = await import('../server.js');
      const { boot } = await import('../boot.js');
      const { onShutdown, runShutdownHooks } = await import('../shutdown.js');
      let stopped = false;
      const { serve } = await import('@hono/node-server');
      let resource: AsyncResource | undefined;
      let server: ReturnType<typeof serve> | undefined;
      let base: string | undefined;
      let alerts = 0,
        warnings = 0;
      const off = r.onTenantScopeMissing(() => {
        alerts++;
      });
      const oldError = console.error;
      console.error = (...args) => {
        if (args[0] === '[tenancy] tenant_scope_missing') warnings++;
        else oldError(...args);
      };
      const empty = () => assert.equal(r.scopedRuntime(), undefined);
      let finish!: () => void;
      let fail!: (e: unknown) => void;
      const listening = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      try {
        // 真实 boot 即使被错误地从宿主调用，也必须在空作用域创建监听资源。
        await r.withTenantScope(host, () =>
          boot({
            initConfig: async () => {
              r.withTenantScope(host, () => assert.equal(r.currentRuntime(), host));
            },
            initSessionStore: async () => {},
            initChannels: async () => {},
            serve: (onListening) => {
              empty();
              resource = new AsyncResource('HTTPServer');
              server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
                base = `http://127.0.0.1:${info.port}`;
                onListening();
                finish();
              });
              server.once('error', (e: NodeJS.ErrnoException) => {
                if (e.code !== 'EPERM') {
                  fail(e);
                  return;
                }
                console.log('EPERM listen: 以同一 boot 的 HTTP 异步资源驱动请求');
                resource!.runInAsyncScope(onListening);
                finish();
              });
            },
            preflight: empty,
            buildIndex: async () => {
              empty();
              await Promise.resolve();
              r.currentRuntime();
            },
            storeMode: () => {
              empty();
              return 'file';
            },
            startChannels: empty,
            startJobs: () => assert.fail('file 不能起 jobs'),
            startFollowUpScheduler: () => {
              empty();
              setTimeout(() => r.backgroundEntry(r.currentRuntime), 0);
            },
            startAlerts: empty,
            startPrivacy: async () => {
              empty();
              onShutdown(() => {
                empty();
                stopped = true;
              });
            },
            exit: () => assert.fail('不应拒绝启动'),
          }),
        );
        await listening;
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(warnings, 2);
        assert.equal(alerts, 2);
        await runShutdownHooks(500);
        assert.equal(stopped, true);
        const request = (route: string, init?: RequestInit): Promise<Response> =>
          base ? fetch(`${base}${route}`, init) : Promise.resolve(resource!.runInAsyncScope(() => app.request(route, init)));
        assert.equal((await request('/healthz')).status, mode === 'multi' ? 500 : 200);
        if (mode === 'multi')
          assert.equal(
            (await request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
            500,
          );
        else {
          const events = host.events.storeEvents;
          const before = events.listenerCount('change');
          const controller = new AbortController();
          const response = await request('/api/admin/stream', { signal: controller.signal });
          assert.equal(response.status, 200);
          const reader = response.body!.getReader();
          await reader.read();
          assert.equal(events.listenerCount('change'), before + 1);
          r.withoutTenantScope(() => controller.abort());
          await reader.cancel().catch(() => undefined);
          const until = Date.now() + 2000;
          while (events.listenerCount('change') !== before && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(events.listenerCount('change'), before);
        }
      } finally {
        off();
        console.error = oldError;
        resource?.emitDestroy();
        if (server?.listening)
          await new Promise<void>((resolve) => {
            server!.close(() => resolve());
            if ('closeAllConnections' in server!) server!.closeAllConnections();
          });
      }
    }
  } finally {
    const { dropTenantState } = await import('./state.js');
    for (const rt of r.tenantRuntimes()) {
      dropTenantState(rt.id);
      r.unregisterRuntime(rt.id);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
