// 05 R3 / R5：启动策略、异步续体、后端回调与两个最小运行时的隔离。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!mode) {
  for (const child of ['fallback', 'strict', 'sandbox', 'multi', 'pg']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), child], {
      env: {
        ...process.env,
        CONFIG_SOURCE: 'file',
        TENANCY_STRICT: child === 'strict' || child === 'pg' ? '1' : '',
        APP_ROLE: child === 'sandbox' ? 'sandbox' : 'host',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${child}: ${result.stdout}\n${result.stderr}`);
  }
  console.log('TENANCY RUNTIME SELFTEST PASS: 回落 / 严格 / 沙箱 / 多 standard / snapshot / 后端去抖 / 状态登记');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-runtime-'));
  process.env.VAR_DIR = path.join(dir, 'host');
  process.env.DEMO_PRUNE_HOURS = '0';
  const r = await import('./runtime.js');
  const s = await import('../store.js');
  const c = await import('../config/source.js');
  const p = await import('../core/pack-api.js');
  const states = await import('./state.js');
  const { createFileBackend } = await import('../store/file-backend.js');
  const { runShutdownHooks, onShutdown } = await import('../shutdown.js');
  const host = r.hostRuntime();
  const a = r.createTenantRuntime({ id: 'a', slug: 'a', isHost: true });
  const b = r.createTenantRuntime({ id: 'b', slug: 'b', isHost: true });
  r.registerRuntime(a);
  r.registerRuntime(b);
  if (mode === 'multi') r.configureTenancy({ role: 'host', standardCount: 2 });
  const strict = mode !== 'fallback';
  try {
    if (strict) {
      for (const access of [r.currentRuntime, () => s.getSession('same'), c.currentPack, c.currentCatalog])
        assert.throws(access, r.TenantScopeMissing);
      // 删到只剩一个也不能变成隐式回落。
      r.unregisterRuntime(b.id);
      r.unregisterRuntime(a.id);
      assert.throws(r.currentRuntime, r.TenantScopeMissing);
      r.registerRuntime(a);
      r.registerRuntime(b);
    } else {
      assert.equal(r.currentRuntime(), host);
      // 兼容模式不因测试里登记第二个运行时而临时切换策略。
      assert.equal(
        r.withTenantScope(a, () => r.withoutTenantScope(r.currentRuntime)),
        host,
      );
    }
    await r.withTenantScope(a, async () => {
      assert.equal(r.currentRuntime(), a);
      await Promise.resolve();
      assert.equal(r.currentRuntime(), a);
      r.withTenantScope(b, () => assert.equal(r.currentRuntime(), b));
      assert.equal(r.currentRuntime(), a);
    });
    const detached = r.withoutTenantScope(() => AsyncLocalStorage.snapshot());
    r.withTenantScope(a, () =>
      detached(() => {
        if (strict) assert.throws(r.currentRuntime, r.TenantScopeMissing);
        r.withTenantScope(a, () => assert.equal(r.currentRuntime(), a));
      }),
    );
    const runtime = r.withTenantScope(a, () => c.currentPack().runtime);
    const pipelinesA = r.withTenantScope(a, () => {
      p.bindPack(runtime, null);
      return c.currentPack().pipelines;
    });
    r.withTenantScope(b, () => {
      p.bindPack(runtime, null);
      assert.notEqual(c.currentPack().pipelines, pipelinesA);
    });
    r.withTenantScope(a, () => assert.equal(c.currentPack().pipelines, pipelinesA));
    const sessionA = { id: 'same' } as import('../types.js').Session;
    const sessionB = { id: 'same' } as import('../types.js').Session;
    a.store.sessions.set('same', sessionA);
    b.store.sessions.set('same', sessionB);
    r.withTenantScope(a, () => assert.equal(s.getSession('same'), sessionA));
    r.withTenantScope(b, () => assert.equal(s.getSession('same'), sessionB));

    const seen: string[] = [];
    r.withoutTenantScope(() => {
      a.events.storeEvents.on('change', () => seen.push(r.currentRuntime().id));
      b.events.storeEvents.on('change', () => seen.push(r.currentRuntime().id));
    });
    r.withTenantScope(a, s.__storeTest.committedChange);
    r.withTenantScope(b, s.__storeTest.committedChange);
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.deepEqual(seen.sort(), ['a', 'b']);
    // 文件后端也在空作用域注册计时器，再进入自己的作用域发提交事件。
    const backend = createFileBackend({
      runtime: a,
      varDir: path.join(dir, 'a'),
      sessions: new Map(),
      orders: new Map(),
      owns: () => true,
      ownsOrder: () => true,
      isReal: () => false,
      afterPersist: () => seen.push(r.currentRuntime().id),
    });
    r.withTenantScope(b, () => backend.markChanged(['same']));
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.equal(seen.at(-1), 'a');
    backend.reset();

    if (strict) {
      let warnings = 0,
        alerts = 0;
      const oldError = console.error;
      const off = r.onTenantScopeMissing(() => {
        alerts++;
        assert.throws(r.currentRuntime, r.TenantScopeMissing);
      });
      console.error = (...args) => {
        assert.equal(args[0], '[tenancy] tenant_scope_missing');
        warnings++;
      };
      try {
        assert.equal(
          r.withoutTenantScope(() => r.backgroundEntry(() => s.getSession('same'))),
          undefined,
        );
        assert.equal(warnings, 1);
        assert.equal(alerts, 1);
        await r.withoutTenantScope(() =>
          r.backgroundEntry(async () => {
            await Promise.resolve();
            r.currentRuntime();
          }),
        );
        assert.equal(warnings, 2);
        assert.equal(alerts, 2);
        // 回调热路径是 void 异步派发：缺租户时不能留下未捕获的 rejection。
        const wecom = await r.withTenantScope(a, () => import('../adapters/wecom.js'));
        await wecom.syncAccountFromCallback('missing', 'unused');
        assert.equal(warnings, 3);
        assert.equal(alerts, 3);
      } finally {
        console.error = oldError;
        off();
      }
    }
    if (mode === 'pg') {
      const { openTestDb, installPgSessionStore } = await import('../db/testing.js');
      const { withTenant } = await import('../db/client.js');
      const db = await openTestDb();
      const pgRt = r.createTenantRuntime({ id: 'pg', slug: 'pg-scope', isHost: true });
      r.registerRuntime(pgRt);
      try {
        const fixture = await r.withTenantScope(pgRt, () => installPgSessionStore(db, { slug: pgRt.slug, varDir: path.join(dir, 'pg') }));
        r.identifyRuntime(pgRt, { id: fixture.deps.tenantId, slug: pgRt.slug, isHost: true });
        await r.withTenantScope(pgRt, () => s.initSessionStore(fixture.deps));
        const committed: string[] = [];
        const off = s.onCommitted(() => committed.push(r.currentRuntime().id));
        try {
          await r.withTenantScope(pgRt, () =>
            withTenant(db.db, { tenantId: pgRt.id, actor: { kind: 'system', userId: null, name: null, ip: null } }, async () => {
              const session = s.getOrCreateSession('wecom:wmScope', 'wecom');
              session.messages.push({ role: 'customer', content: '你好', at: Date.now() });
              s.saveSession(session);
            }),
          );
          // 写队列经模块加载期 snapshot，不能继承刚才的 DB 事务；但必须恢复 pgRt。
          await r.withTenantScope(pgRt, () => s.flushSession('wecom:wmScope'));
          assert.ok(committed.length > 0);
          assert.ok(committed.every((id) => id === pgRt.id));
        } finally {
          off();
        }
      } finally {
        states.dropTenantState(pgRt.id);
        r.unregisterRuntime(pgRt.id);
        await db.close();
      }
    }
    const { Hono } = await import('hono');
    const http = new Hono().get('/', () => {
      r.withoutTenantScope(() => {
        if (strict) s.getSession('same');
      });
      return new Response('ok');
    });
    http.onError(() => new Response('Internal Server Error', { status: 500 }));
    assert.equal((await http.request('/')).status, strict ? 500 : 200);

    const shutdown: string[] = [];
    r.withTenantScope(a, () =>
      onShutdown(() => {
        shutdown.push(r.currentRuntime().id);
      }),
    );
    r.withTenantScope(b, () =>
      onShutdown(() => {
        shutdown.push(r.currentRuntime().id);
      }),
    );
    await r.withoutTenantScope(() => runShutdownHooks(500));
    assert.deepEqual(shutdown.sort(), ['a', 'b']);
    assert.equal(states.tenantKeys(a.id)['store.sessions'], 1);
    states.dropTenantState(a.id);
    assert.equal(states.tenantKeys(a.id)['store.sessions'], 0);
    assert.equal(b.store.sessions.size, 1);
  } finally {
    for (const rt of r.tenantRuntimes()) {
      states.dropTenantState(rt.id);
      r.unregisterRuntime(rt.id);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
