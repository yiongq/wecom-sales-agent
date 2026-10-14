// 第 21 步：独立沙箱角色进程，避免宿主兼容状态影响严格模式的验证。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CHANNEL_KEY_ENV } from '../../channels/secrets.js';
import type { Db, TenantLock } from '../../db/client.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-isolation-'));
Object.assign(process.env, {
  APP_ROLE: 'sandbox',
  CONFIG_SOURCE: 'db',
  SESSION_STORE: 'db',
  TENANCY_STRICT: '1',
  SERVER_SELFTEST: '1',
  VAR_DIR: temp,
  LLM_MOCK: '0',
  LLM_PROVIDER: 'default',
  LLM_API_KEY: 'fixture-model',
  LLM_MODEL: 'fixture-model',
  LLM_MODEL_CHEAP: 'fixture-model',
  LLM_MAX_RETRY: '0',
  LLM_MAX_INFLIGHT: '2',
  LLM_HEDGE_MODEL: '',
  EMBED_API_KEY: 'fixture-model',
  ZHIPU_API_KEY: '',
  ALERT_WEBHOOK_URL: '',
  NOTIFY_WEBHOOK_URL: '',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  SANDBOX_LLM_CALLS: '100',
  SANDBOX_LLM_CNY: '100',
  SANDBOX_POOL_DAILY_CNY: '1000',
});
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('WECOM_') ||
    key.startsWith('SANDBOX_WECOM_') ||
    [CHANNEL_KEY_ENV, 'NOTIFY_WEBHOOK_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'LLM_HEDGE_MODEL', 'DEFAULT_TENANT_SLUG'].includes(key)
  )
    delete process.env[key];
}
process.env.SANDBOX_HOST = 'sandbox.example.invalid';
process.env.SANDBOX_TEMPLATE_SLUG = 'template';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await pause(10);
  assert.ok(check(), label);
}
const r = await import('../runtime.js');
const state = await import('../state.js');
const testing = await import('../../db/testing.js');
const client = await import('../../db/client.js');
const store = await import('../../store.js');
const config = await import('../../config/source.js');
const retrieval = await import('../../core/retrieval.js');
const { importConfig } = await import('../../config/transfer.js');
const { handleMessage } = await import('../../engine.js');
const { provisionSandbox } = await import('./provision.js');
const { advanceSandboxEpoch } = await import('../../db/sandbox-process.js');
const { SandboxReaper } = await import('./reaper.js');
const { sandboxApp, SandboxProcess } = await import('./process.js');
const { resolveSandboxSession } = await import('./session.js');
const { Hono } = await import('hono');
const { consoleApi } = await import('../../console-api/app.js');
const sharedApp = new Hono().route('/', consoleApi);
const hub = await import('../../console-api/events.js');
const shutdown = await import('../../shutdown.js');
const events = await import('../../store/events.js');
const { shanhaiBrand } = await import('../../packs/travel/brand-fixture.js');
const { __sandboxLimitsTest } = await import('./limits.js');
const { closeSandboxBudgetPool } = await import('./budget.js');
const originalFetch = globalThis.fetch;
let blockedTenant = '',
  release = () => {},
  block: Promise<void> | null = null;
let failEmbeddings = true;
const calls: { tenant: string; system: string; tools: string; wire: string }[] = [];
const embedOwners: string[] = [];
const model = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const tenant = String(req.headers['x-fixture-tenant']);
  if (req.url === '/embeddings') {
    embedOwners.push(tenant);
    if (failEmbeddings) {
      res.writeHead(500);
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })), usage: { prompt_tokens: 1 } }));
    return;
  }
  const system = body.messages.find((m: { role: string }) => m.role === 'system').content;
  calls.push({ tenant, system, tools: JSON.stringify(body.tools), wire: JSON.stringify(body) });
  if (tenant === blockedTenant && block) await block;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { role: 'assistant', content: system.includes('山海旅行') ? '您好，山海旅行欢迎您。' : '您好，云途旅行欢迎您。' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
process.env.LLM_BASE_URL = process.env.EMBED_BASE_URL = base;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, base, '套件禁止非假上游的网络请求');
  const headers = new Headers(init?.headers);
  headers.set('x-fixture-tenant', r.currentRuntime().id);
  return originalFetch(input, { ...init, headers });
};
type Query = <T = Record<string, unknown>>(sql: string, args?: unknown[]) => Promise<T[]>;
async function suite(db: Db, q: Query, acquire: (id: string) => Promise<TenantLock | null>, fault: { fail: boolean }, label: string) {
  r.configureTenancy({ role: 'sandbox', standardCount: 0 });
  __sandboxLimitsTest.resetProvisioned();
  assert.equal(r.tenantRuntimes().length, 0);
  assert.throws(() => store.getSession('sbx-same'), r.TenantScopeMissing);
  assert.throws(config.currentPack, r.TenantScopeMissing);
  assert.throws(config.currentCatalog, r.TenantScopeMissing);
  const missing: string[] = [];
  const offMissing = r.onTenantScopeMissing(() => missing.push('missing'));
  const streams: { text: string; done: boolean; reader: ReadableStreamDefaultReader<Uint8Array>; pump: Promise<void> }[] = [];
  const hooksSeen: string[] = [];
  const committed: { owner: string; actual: string; id: string }[] = [];
  const unsaved: string[] = [];
  retrieval.__retrievalTest.setBackoff([100]);
  calls.length = 0;
  embedOwners.length = 0;
  failEmbeddings = true;
  const reaper = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 24 * 60 * 60_000 });
  const deps = testing.testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  const epoch = await advanceSandboxEpoch(db);
  const scope = r.withTenantScope;
  async function seed(slug: string, brand?: unknown) {
    if (brand) await q('update tenants set brand=$2::json where slug=$1', [slug, JSON.stringify(brand)]);
    const rt = r.createTenantRuntime({ id: (await q<{ id: string }>('select id from tenants where slug=$1', [slug]))[0]!.id, slug });
    const result = await scope(rt, () =>
      importConfig({ db, tenantSlug: slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => testing.fakeLock() }),
    );
    assert.equal(result.code, 0, result.message);
  }
  try {
    await seed('template');
    await q("insert into tenants(slug,name,pack_id) values('template-b','B','travel')");
    await seed('template-b', shanhaiBrand);
    const open = (templateSlug: string) =>
      provisionSandbox({
        deps,
        templateSlug,
        epoch,
        host: 'sandbox.example.invalid',
        acquireTenant: acquire,
        ip: null,
        userAgent: null,
        env: { SANDBOX_PER_HOUR: '100', SANDBOX_PER_IP_DAY: '100' },
      });
    const aResult = await open('template');
    assert.equal(r.tenantRuntimes().length, 1);
    const bResult = await open('template-b');
    assert.equal(r.tenantRuntimes().length, 2);
    const a = r.runtimeOf(aResult.tenantId)!,
      b = r.runtimeOf(bResult.tenantId)!;
    const expected = new Map(
      [a, b].map((rt) => [rt.id, scope(rt, () => ({ system: config.currentSop().promptHash, tools: config.currentSop().toolsHash }))]),
    );
    for (const rt of [a, b])
      scope(rt, () => {
        events.onCommitted((ev) => committed.push({ owner: rt.id, actual: r.currentRuntime().id, id: ev.id }));
        events.onHandoffUnsaved(() => unsaved.push(rt.id));
        shutdown.onShutdown(() => {
          assert.equal(r.currentRuntime(), rt);
          hooksSeen.push(rt.id);
        });
        hub.__eventsTest.setTiming({ heartbeatMs: 20, recheckMs: 40, countsDebounceMs: 5 });
      });
    // 两个初建均失败后才放行；重试由各自捕获的运行时发起。
    await until(() => [a, b].every((rt) => state.tenantKeys(rt.id)['retrieval.retryTimer'] === 1), '两个索引均排了重试');
    failEmbeddings = false;
    await until(() => [a, b].every((rt) => scope(rt, retrieval.indexReady)), '索引自动重试完成');
    assert.ok(embedOwners.includes(a.id) && embedOwners.includes(b.id));
    blockedTenant = b.id;
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = 'sbx-0123456789abcdef01234567';
    const pendingB = scope(b, () => handleMessage(id, '您好，介绍一下你们', 'simulator'));
    await until(() => calls.some((c) => c.tenant === b.id), 'B 模型请求在途');
    const replyA = await scope(a, () => handleMessage(id, '您好，介绍一下你们', 'simulator'));
    assert.match(replyA.text, /云途/);
    assert.doesNotMatch(replyA.text, /山海/);
    release();
    block = null;
    const replyB = await pendingB;
    assert.match(replyB.text, /山海/);
    assert.doesNotMatch(replyB.text, /云途/);
    const second = await Promise.all([a, b].map((rt) => scope(rt, () => handleMessage(id, '请再介绍一下', 'simulator'))));
    assert.match(second[0]!.text, /云途/);
    assert.doesNotMatch(second[0]!.text, /山海/);
    assert.match(second[1]!.text, /山海/);
    assert.doesNotMatch(second[1]!.text, /云途/);
    for (const c of calls) {
      assert.equal(createHash('sha256').update(c.system).digest('hex'), expected.get(c.tenant)!.system);
      assert.equal(createHash('sha256').update(c.tools).digest('hex'), expected.get(c.tenant)!.tools);
      assert.doesNotMatch(c.wire, c.tenant === a.id ? /山海/ : /云途/);
    }
    assert.equal(calls.length, 4);
    for (const rt of [a, b]) await scope(rt, () => store.flushSession(id, { timeoutMs: 5000 }));
    const app = sandboxApp(
      {
        resolve: (token) => resolveSandboxSession(db, token),
        health: () => new SandboxProcess({}).health(),
        provision: () => open('template'),
        end: (id) => reaper.end(id),
      },
      'sandbox.example.invalid',
      sharedApp,
    );
    const request = (token: string, url = '/api/console/events') =>
      app.request(url, { headers: { host: 'sandbox.example.invalid', cookie: `__Host-sbx=${token}` } });
    async function tap(token: string) {
      const response = await request(token);
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      const reader = response.body!.getReader();
      const s = { text: '', done: false, reader, pump: Promise.resolve() };
      s.pump = (async () => {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            s.text += new TextDecoder().decode(item.value);
          }
        } finally {
          s.done = true;
        }
      })();
      streams.push(s);
      return s;
    }
    const sa = await tap(aResult.token),
      sb = await tap(bResult.token);
    await until(() => sa.text.includes('counts') && sb.text.includes('counts'), '两个 SSE 建立');
    const before = committed.length;
    fault.fail = true;
    scope(a, () => {
      const s = store.getSession(id)!;
      s.profile.nickname = 'only-a-retry';
      store.saveSession(s);
      store.emitAfterCommit(id, {
        type: 'handoff.started',
        id,
        kind: 'emergency',
        at: Date.now(),
        escalated: false,
        paidCustomer: false,
        assigned: false,
      });
    });
    await until(() => scope(a, () => store.__storeTest.pgStats()!.retries) > 0, '写队列自动失败');
    assert.equal(committed.length, before, '失败不发提交事件');
    assert.deepEqual(unsaved, [], '沙箱不进入外部失败通知');
    const aCount = (sa.text.match(/event: conversation/g) ?? []).length;
    fault.fail = false;
    scope(b, () => {
      const s = store.getSession(id)!;
      s.profile.nickname = 'only-b';
      store.saveSession(s);
    });
    await scope(b, () => store.flushSession(id, { timeoutMs: 5000 }));
    await until(() => sb.text.includes(id), 'B 收到自己的提交');
    assert.equal((sa.text.match(/event: conversation/g) ?? []).length, aCount, 'B 的提交不进入 A');
    await scope(a, () => store.flushSession(id, { timeoutMs: 5000 }));
    await until(() => sa.text.includes('handoff'), '自动重试成功才给 A 发提交事件');
    assert.doesNotMatch(sb.text, /handoff/);
    for (const row of committed) assert.equal(row.actual, row.owner);
    const stored = await q<{ tenant_id: string; nickname: string }>(
      "select tenant_id, state::jsonb->'profile'->>'nickname' as nickname from conversations where id=$1 order by tenant_id",
      [id],
    );
    assert.equal(stored.length, 2);
    assert.equal(stored.find((row) => row.tenant_id === a.id)!.nickname, 'only-a-retry');
    assert.equal(stored.find((row) => row.tenant_id === b.id)!.nickname, 'only-b');
    assert.ok(scope(a, retrieval.indexReady), 'B 的索引回收不影响 A');
    // 不触发 drop：让实际 SSE 定时复核看见失效的登录会话。
    await q('delete from auth_sessions where tenant_id=$1', [b.id]);
    await until(() => sb.done && sb.text.includes('event: auth'), 'SSE 复核关闭 B');
    assert.equal(sa.done, false);
    await reaper.end(b.id);
    await reaper.tick();
    assert.equal(r.tenantRuntimes().length, 1);
    assert.ok(Object.values(state.tenantKeys(b.id)).every((n) => n === 0));
    assert.equal((await request(aResult.token, '/api/console/me')).status, 200, '只剩 A 仍严格服务');
    assert.match((await scope(a, () => handleMessage(id, '再次介绍一下', 'simulator'))).text, /云途/);
    await scope(a, () => store.flushSession(id, { timeoutMs: 5000 }));
    assert.equal(await shutdown.runShutdownHooks(5000), true);
    assert.deepEqual(hooksSeen, [a.id], '删除 B 后只执行 A 的停机钩子');
    await reaper.end(a.id);
    await reaper.tick();
    assert.equal(r.tenantRuntimes().length, 0);
    assert.ok(Object.values(state.tenantKeys(a.id)).every((n) => n === 0));
    await until(() => sa.done, '删除 A 物理关闭 SSE');
    assert.throws(config.currentCatalog, r.TenantScopeMissing);
    assert.deepEqual(missing, [], '0→2→1→0 无后台作用域缺失');
    assert.deepEqual(fs.readdirSync(temp), [], '沙箱不写文件');
    console.log(`SANDBOX ISOLATION ${label} PASS: 0→2→1→0 / 交错前缀 / 提交失败与重试 / SSE 复核 / 索引重试 / 停机钩子`);
  } finally {
    fault.fail = false;
    release();
    block = null;
    reaper.stop();
    offMissing();
    for (const s of streams) {
      await s.reader.cancel().catch(() => {});
      await s.pump.catch(() => {});
    }
    for (const rt of r.tenantRuntimes()) {
      rt.store.pgBackend?.close();
      await scope(rt, config.closeConfig);
      state.dropTenantState(rt.id);
      shutdown.dropShutdownHooks(rt);
      r.unregisterRuntime(rt.id);
    }
    await closeSandboxBudgetPool();
  }
}
try {
  const t = await testing.openTestDb();
  const fault = { fail: false };
  client.registerDriver(t.db, {
    acquire: async () => {
      if (fault.fail && r.scopedRuntime()) throw testing.fakeDbError('08006');
      return { db: t.db, release: async () => {} };
    },
  });
  try {
    await t.pg.query("insert into tenants(slug,name,pack_id) values('template','模板','travel')");
    await t.pg.exec('SET ROLE agent_app');
    const q: Query = (sql, args = []) =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query(sql, args)).rows as never;
      });
    await suite(t.db, q, async () => testing.fakeLock(), fault, 'PGlite');
  } finally {
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    const app = await testing.openGatedDb(pg.urls.app);
    const locks: TenantLock[] = [];
    const acquire = async (id: string) => {
      const held = await client.holdTenantLock(pg.urls.app, id);
      if (held) locks.push(held);
      return held;
    };
    const realFault = {
      get fail() {
        return app.faults.acquire !== null;
      },
      set fail(value: boolean) {
        app.faults.acquire = value ? testing.fakeDbError('08006') : null;
      },
    };
    try {
      await suite(app.db, pg.query, acquire, realFault, 'REAL PG');
    } finally {
      for (const held of locks) await held.release();
      await app.close();
      await pg.drop();
    }
  } else console.log('SANDBOX ISOLATION REAL PG: 未设 PG_TEST_URL，跳过');
} finally {
  globalThis.fetch = originalFetch;
  release();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  fs.rmSync(temp, { recursive: true, force: true });
}
