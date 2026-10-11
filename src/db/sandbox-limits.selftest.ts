// 05 第 19 步：默认上限、HTTP 错误、持锁并发与重启后的持久计数。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { openDb, rowsOf, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { openTestDb, fakeLock, testConfigDeps } from './testing.js';
import { importConfig } from '../config/transfer.js';
import { closeConfig, currentCatalog, currentSop } from '../config/source.js';
import { createCatalogItem, updateCatalogItem, importCatalogCsv, listCatalog } from '../config/catalog.js';
import { saveSopDraft, publishSopDraft, rollbackSop } from '../config/sop.js';
import { getOrCreateSession, listSessions, flushSession } from '../store.js';
import { csrfFor } from '../auth/session.js';
import { sandboxApp, SandboxProcess } from '../tenancy/sandbox/process.js';
import { provisionSandbox, SandboxProvisionError } from '../tenancy/sandbox/provision.js';
import { loadSandboxRuntime } from '../tenancy/sandbox/load.js';
import { resolveSandboxSession } from '../tenancy/sandbox/session.js';
import { expireBrokenSandbox } from './sandbox-process.js';
import { dropShutdownHooks } from '../shutdown.js';
import { onTurnEnd, type TurnOutcome } from '../trace/recorder.js';
import {
  configureTenancy,
  createTenantRuntime,
  runtimeOf,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
} from '../tenancy/runtime.js';
import { dropTenantState, tenantKeys } from '../tenancy/state.js';
import {
  sandboxWriteLimits,
  validateSandboxLimits,
  assertSandboxProvisionAllowed,
  recordSandboxProvision,
  sandboxIpKey,
  assertSandboxWriteRate,
  assertSandboxWriteCapacity,
  claimSandboxStream,
  SandboxLimitError,
  __sandboxLimitsTest,
} from '../tenancy/sandbox/limits.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';

process.env.SERVER_SELFTEST = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
process.env.LLM_MOCK = '1';
process.env.ALERT_WEBHOOK_URL = '';
const { app: routes } = await import('../server.js');
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
const limited = (error: unknown) => error instanceof SandboxLimitError && error.reason === 'sandbox_write_limited';
const env = { SANDBOX_PER_HOUR: '100', SANDBOX_PER_IP_DAY: '100' };
// 任意运行时刻都选一个与 UTC 日期不同的会话时区。
const testTimezone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
const now = Date.now();
const input = { live: 0, provisioned: 0, day: '2026-10-11', ip: '192.0.2.1' };
check(() => assert.equal(sandboxIpKey('2001:db8:1:2::1'), sandboxIpKey('2001:0DB8:0001:0002:ffff::2')));
check(() => assert.notEqual(sandboxIpKey('2001:db8:1:2::1'), sandboxIpKey('2001:db8:1:3::1')));
check(() => assert.equal(sandboxIpKey('::ffff:192.0.2.1'), sandboxIpKey('192.0.2.1')));
check(() => assert.throws(() => assertSandboxProvisionAllowed({ ...input, live: 20 }, {}, now), SandboxLimitError));
check(() => assert.throws(() => assertSandboxProvisionAllowed({ ...input, provisioned: 50 }, {}, now), SandboxLimitError));
for (let i = 0; i < 10; i++) recordSandboxProvision(`192.0.2.${i + 1}`, input.day, now);
check(() => assert.throws(() => assertSandboxProvisionAllowed({ ...input, ip: '192.0.2.99' }, {}, now), SandboxLimitError));
check(() => assert.doesNotThrow(() => assertSandboxProvisionAllowed(input, {}, now + 60 * 60_000)));
__sandboxLimitsTest.resetProvisioned();
for (let i = 0; i < 3; i++) recordSandboxProvision('2001:db8:1:2::1', input.day, now);
check(() => assert.throws(() => assertSandboxProvisionAllowed({ ...input, ip: '2001:db8:1:2::2' }, {}, now), SandboxLimitError));
check(() => assert.doesNotThrow(() => assertSandboxProvisionAllowed({ ...input, ip: '2001:db8:1:3::2' }, {}, now)));
__sandboxLimitsTest.resetProvisioned();
for (let i = 0; i < 3; i++) recordSandboxProvision(input.ip, input.day, now);
check(() => assert.throws(() => assertSandboxProvisionAllowed(input, {}, now), SandboxLimitError));
check(() => assert.doesNotThrow(() => assertSandboxProvisionAllowed({ ...input, day: '2026-10-12' }, {}, now + 24 * 60 * 60_000)));
check(() => assert.throws(() => assertSandboxProvisionAllowed(input, { SANDBOX_MAX_LIVE: '0' }), /sandbox_limits_invalid/));
__sandboxLimitsTest.resetProvisioned();
check(() => assert.equal(sandboxWriteLimits({ SANDBOX_WRITE_LIMITS: '{"requestsPerMinute":2}' }).requestsPerMinute, 2));
check(() => assert.equal(sandboxWriteLimits({ SANDBOX_WRITE_LIMITS: '{"requestsPerMinute":2}' }).catalogItems, 80));
check(() =>
  assert.deepEqual(sandboxWriteLimits({}), {
    requestsPerMinute: 30,
    catalogItems: 80,
    versionsPerItem: 20,
    importRows: 80,
    sopPublishesPerDay: 20,
    quickReplies: 50,
  }),
);
for (const value of [
  '',
  ' ',
  'null',
  '[]',
  '{',
  '{"unknown":1}',
  '{"quickReplies":0}',
  '{"catalogItems":"80"}',
  '{"importRows":1.5}',
  '{"versionsPerItem":true}',
  '{"sopPublishesPerDay":9007199254740992}',
]) {
  check(() => assert.throws(() => sandboxWriteLimits({ SANDBOX_WRITE_LIMITS: value }), /sandbox_limits_invalid/));
  // 无 DATABASE_URL：必须在取锁、连库前立即得到明确配置错误。
  await assert.rejects(
    () =>
      new SandboxProcess({
        APP_ROLE: 'sandbox',
        DEPLOY_PROFILE: 'demo',
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        SANDBOX_TEMPLATE_SLUG: 'template',
        SANDBOX_HOST: 'sandbox.example.invalid',
        SANDBOX_WRITE_LIMITS: value,
      }).start(),
    /sandbox_limits_invalid: SANDBOX_WRITE_LIMITS/,
  );
  checks++;
}
for (const key of ['SANDBOX_MAX_LIVE', 'SANDBOX_PER_DAY', 'SANDBOX_PER_HOUR', 'SANDBOX_PER_IP_DAY', 'SANDBOX_MAX_CONVERSATIONS'])
  check(() => assert.throws(() => validateSandboxLimits({ [key]: '0' }), new RegExp(`sandbox_limits_invalid: ${key}`)));

async function cleanup(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
    check(() => assert.ok(Object.values(tenantKeys(rt.id)).every((n) => n === 0)));
  }
}
async function suite(db: Db, q: Query, real: boolean) {
  __sandboxLimitsTest.resetProvisioned();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('limits-template','测试模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: template!.id, slug: 'limits-template' });
  withTenantScope(host, () => {
    for (let i = 0; i < 50; i++) assertSandboxWriteRate();
    check(() => assert.doesNotThrow(() => assertSandboxWriteCapacity('catalogItems', 1000)));
  });
  const deps = testConfigDeps({ db }, { tenantSlug: host.slug, usePackRuntime: true });
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: host.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  check(() => assert.equal(imported.code, 0));
  const options = {
    deps,
    templateSlug: host.slug,
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: async () => fakeLock(),
    ip: input.ip,
    userAgent: null,
    env,
  };
  const [days] = await q<{ localDay: string; utcDay: string }>(
    `select current_date::text as "localDay", (now() at time zone 'UTC')::date::text as "utcDay"`,
  );
  check(() => assert.notEqual(days!.localDay, days!.utcDay));
  await q('insert into sandbox_pool_daily(day,provisioned) values($1,50)', [days!.utcDay]);
  await assert.rejects(
    () => provisionSandbox(options),
    (e) => e instanceof SandboxProvisionError && e.status === 429,
  );
  checks++;
  const [none] = await q<{ n: number }>("select count(*)::int as n from tenants where kind='sandbox'");
  check(() => assert.equal(none!.n, 0));
  await q('delete from sandbox_pool_daily');

  // 超限模板是部署错误：HTTP 503、不签 cookie、不建行或加计数，日志与实例告警都有固定诊断。
  const snapshot = async () =>
    JSON.stringify(
      await q(`select
    (select count(*) from tenants where kind='sandbox')::int as tenants,
    (select count(*) from auth_sessions)::int as sessions,
    (select coalesce(sum(provisioned),0) from sandbox_pool_daily)::int as provisioned`),
    );
  const before = await snapshot();
  const errors: string[] = [],
    alerts: string[] = [];
  const errorLog = console.error,
    warnLog = console.warn;
  console.error = (...args) => {
    errors.push(args.join(' '));
  };
  console.warn = (...args) => {
    alerts.push(args.join(' '));
  };
  try {
    const unavailableApp = (config: NodeJS.ProcessEnv) =>
      sandboxApp(
        {
          health: async () => ({}) as never,
          resolve: (token) => resolveSandboxSession(db, token),
          provision: (input) => provisionSandbox({ ...options, ...input, env: { ...env, ...config } }),
          end: (id) => expireBrokenSandbox(db, id),
        },
        options.host,
      );
    const rejected = async (config: NodeJS.ProcessEnv) => {
      const response = await unavailableApp(config).request('/api/sandbox', {
        method: 'POST',
        headers: { host: options.host, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      check(() => assert.equal(response.status, 503));
      const body = (await response.json()) as { error: string };
      check(() => assert.equal(body.error, 'sandbox_unavailable'));
      check(() => assert.ok(!response.headers.has('set-cookie') || response.headers.get('set-cookie')!.includes('Max-Age=0')));
      const after = await snapshot();
      check(() => assert.equal(after, before));
    };
    await rejected({ SANDBOX_WRITE_LIMITS: '{"catalogItems":1}' });
    await q(
      `insert into quick_replies(tenant_id,ord,title,body)
      select $1::uuid, i, '模板回复' || i, '正文' from generate_series(1,51) i`,
      [host.id],
    );
    await rejected({});
    for (const code of ['sandbox_template_catalog_limit', 'sandbox_template_quick_replies_limit']) {
      check(() => assert.ok(errors.some((s) => s.includes(code))));
      check(() => assert.ok(alerts.some((s) => s.includes(code))));
    }
    await q('delete from quick_replies where tenant_id=$1', [host.id]);
  } finally {
    console.error = errorLog;
    console.warn = warnLog;
  }

  // 注入午夜前的准入日期；创建事务仍在新的 UTC 日，IP 记账必须跟随创建事务。
  const execute = db.execute;
  let staleDay = true;
  db.execute = (async (...args: Parameters<Db['execute']>) => {
    const result = await execute.apply(db, args);
    const row = rowsOf<{ day?: string; provisioned?: number; costMilli?: number }>(result)[0];
    if (staleDay && row?.day && row.provisioned !== undefined && row.costMilli !== undefined) {
      row.day = new Date(Date.parse(`${row.day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      staleDay = false;
    }
    return result;
  }) as Db['execute'];
  // 真正的开通互斥：两个请求同时冲最后一个存活名额，只有一个事务提交。
  let attempts: PromiseSettledResult<Awaited<ReturnType<typeof provisionSandbox>>>[];
  try {
    attempts = await Promise.allSettled([
      provisionSandbox({ ...options, env: { ...env, SANDBOX_MAX_LIVE: '1' } }),
      provisionSandbox({ ...options, env: { ...env, SANDBOX_MAX_LIVE: '1' } }),
    ]);
  } finally {
    db.execute = execute;
  }
  const opened = attempts.find((r) => r.status === 'fulfilled');
  if (opened?.status !== 'fulfilled') throw new Error('开通失败');
  const a = opened.value;
  check(() => assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1));
  check(() =>
    assert.ok(
      attempts.some((r) => r.status === 'rejected' && r.reason instanceof SandboxProvisionError && r.reason.reason === 'sandbox_limited'),
    ),
  );
  const b = await provisionSandbox(options);
  await assert.rejects(
    () => provisionSandbox({ ...options, env: { ...env, SANDBOX_PER_IP_DAY: '2' } }),
    (e) => e instanceof SandboxProvisionError && e.reason === 'sandbox_limited',
  );
  checks++;
  const [pool] = await q<{ day: string; provisioned: number }>('select day::text as day,provisioned from sandbox_pool_daily');
  check(() => assert.equal(pool!.day, new Date(a.expiresAt.getTime() - 86400000).toISOString().slice(0, 10)));
  check(() => assert.equal(pool!.provisioned, 2));
  // daily 是库里的计数，清掉进程计数后仍挡；先前失败 / 拒绝不增加计数。
  __sandboxLimitsTest.resetProvisioned();
  await assert.rejects(
    () => provisionSandbox({ ...options, env: { ...env, SANDBOX_PER_DAY: '2' } }),
    (e) => e instanceof SandboxProvisionError && e.reason === 'sandbox_limited',
  );
  checks++;
  const rt = runtimeOf(a.tenantId)!;
  const app = sandboxApp(
    {
      health: async () => ({}) as never,
      resolve: (token) => resolveSandboxSession(db, token),
      provision: (input) => provisionSandbox({ ...options, ...input, env: { ...env, SANDBOX_PER_DAY: '2' } }),
      end: (id) => expireBrokenSandbox(db, id),
    },
    options.host,
    routes,
  );
  const request = (url: string, method = 'GET', body?: unknown, token = a.token) =>
    app.request(url, {
      method,
      headers: {
        host: options.host,
        cookie: `__Host-sbx=${token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-csrf': csrfFor(token),
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const expectLimit = async (res: Response, code = 'sandbox_write_limited') => {
    check(() => assert.equal(res.status, 429));
    check(() => assert.equal((res.headers.get('content-type') ?? '').includes('application/json'), true));
    const body = (await res.json()) as { error: string; retryAfter?: number };
    if (code === 'sandbox_limited' && res.headers.has('retry-after'))
      check(() => assert.equal(body.retryAfter, Number(res.headers.get('retry-after'))));
    check(() => assert.equal(body.error, code));
  };
  const dailyRefused = await request('/api/sandbox', 'POST', {}, '');
  check(() => assert.ok(Number(dailyRefused.headers.get('retry-after')) > 0));
  await expectLimit(dailyRefused, 'sandbox_limited');
  const reused = await request('/api/sandbox', 'POST', {});
  check(() => assert.equal(reused.status, 200));
  __sandboxLimitsTest.dropTenantLimits(rt.id);
  // 预算预占已拒绝、模型已走 mock 时写速率照计；另一沙箱有独立的桶。
  const reserve = rt.budget.reserve;
  let budgetRefusals = 0,
    fetches = 0;
  rt.budget.reserve = () => {
    budgetRefusals++;
    return null;
  };
  const outcomes: TurnOutcome[] = [];
  const stopTurns = withTenantScope(rt, () =>
    onTurnEnd((turn) => {
      outcomes.push(turn.outcome);
    }),
  );
  const settings = {
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_API_KEY: 'fixture',
    LLM_BASE_URL: 'http://llm.example.invalid',
    LLM_HEDGE_MODEL: '',
    SANDBOX_WRITE_LIMITS: '{"requestsPerMinute":2}',
  };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error('测试禁止网络请求');
  };
  Object.assign(process.env, settings);
  try {
    const seed = withTenantScope(rt, () => listSessions().find((s) => !s.handedOver && s.stage === 'discovery')!);
    assert.ok(seed);
    for (let i = 0; i < 2; i++) {
      const res = await request('/api/chat', 'POST', { text: '你好', sessionId: seed.id });
      check(() => assert.equal(res.status, 200));
      const body = (await res.json()) as { reply: { text: string } };
      check(() => assert.ok(body.reply.text.length > 0));
    }
    check(() => assert.deepEqual(outcomes, ['budget', 'budget']));
    check(() => assert.equal(budgetRefusals, 2));
    check(() => assert.equal(fetches, 0));
    await expectLimit(await request('/api/chat', 'POST', { text: '你好', sessionId: seed.id }));
    await expectLimit(await request('/api/console/quick-replies', 'POST', { title: '拒绝', body: '正文' }));
    check(() => assert.equal(budgetRefusals, 2));
    const otherReply = await request('/api/console/quick-replies', 'POST', { title: '另一沙箱', body: '正文' }, b.token);
    check(() => assert.equal(otherReply.status, 200));
    withTenantScope(rt, () => check(() => assert.doesNotThrow(() => assertSandboxWriteRate(Date.now() + 60_000))));
  } finally {
    stopTurns();
    rt.budget.reserve = reserve;
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __sandboxLimitsTest.dropTenantLimits(rt.id);
  }
  // 新会话种子不算；并发路径的核心同步创建在 store 里，超限时没有消息或模型调用。
  await withTenantScope(rt, async () => {
    check(() => assert.equal(listSessions().length, 13));
    for (let i = 0; i < 30; i++) {
      const id = `sbx-${i.toString(16).padStart(24, '0')}`;
      getOrCreateSession(id, 'simulator');
      await flushSession(id);
    }
    check(() => assert.equal(listSessions().length, 43));
    check(() => assert.throws(() => getOrCreateSession(`sbx-${'f'.repeat(24)}`, 'simulator'), SandboxLimitError));
    check(() => assert.doesNotThrow(() => getOrCreateSession(listSessions()[0]!.id, 'simulator')));
  });
  await expectLimit(await request('/api/chat', 'POST', { text: '你好', sessionId: `sim-${'e'.repeat(24)}` }), 'sandbox_limited');
  // 关闭 / 重装：种子排除与新会话计数仍成立。
  rt.state = 'closed';
  tenantStoreIfLoaded(rt)?.pgBackend?.close();
  await withTenantScope(rt, closeConfig);
  dropShutdownHooks(rt);
  dropTenantState(rt.id);
  unregisterRuntime(rt.id);
  const restored = await loadSandboxRuntime(deps, { id: a.tenantId, slug: a.slug, expiresAt: a.expiresAt }, options.host, async () =>
    fakeLock(),
  );
  assert.ok(restored);
  withTenantScope(restored, () =>
    check(() => assert.throws(() => getOrCreateSession(`sbx-${'d'.repeat(24)}`, 'simulator'), SandboxLimitError)),
  );
  // SSE 同一个会话的多连接也计数；真实 HTTP 拒绝第 11 条，断开后名额可用。
  const streams: Response[] = [];
  const sim = `sim-${'1'.repeat(24)}`;
  for (let i = 0; i < 10; i++) {
    const res = await request(`/api/stream/${sim}`);
    check(() => assert.equal(res.status, 200));
    streams.push(res);
  }
  await expectLimit(await request(`/api/stream/${sim}`), 'sandbox_limited');
  const otherStream = await request(`/api/stream/${sim}`, 'GET', undefined, b.token);
  check(() => assert.equal(otherStream.status, 200));
  await otherStream.body!.cancel();
  await streams.pop()!.body!.cancel();
  const replacement = await request(`/api/stream/${sim}`);
  check(() => assert.equal(replacement.status, 200));
  streams.push(replacement);
  for (const res of streams) await res.body!.cancel();
  // drop 会关闭登记的连接，迟到 release 幂等。
  let closed = 0;
  const release = withTenantScope(restored, () =>
    claimSandboxStream(() => {
      closed++;
    }),
  );
  __sandboxLimitsTest.dropTenantLimits(restored.id);
  release();
  release();
  check(() => assert.equal(closed, 1));
  const ctx = { tenantId: restored.id, actor: { kind: 'user' as const, userId: a.userId, name: '体验访客', ip: null } };
  await withTenantScope(restored, async () => {
    const sample = currentCatalog().routes[0]!;
    const count = (await listCatalog(ctx, 'route')).length + (await listCatalog(ctx, 'hotel')).length;
    for (let i = count; i < 79; i++) await createCatalogItem(ctx, 'route', { ...sample, id: `limit-${i}` });
    const results = await Promise.allSettled(['last-one', 'last-two'].map((id) => createCatalogItem(ctx, 'route', { ...sample, id })));
    check(() => assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1));
    check(() => assert.ok(results.some((r) => r.status === 'rejected' && limited(r.reason))));
    const items = [...(await listCatalog(ctx, 'route')), ...(await listCatalog(ctx, 'hotel'))];
    check(() => assert.equal(items.length, 80));
    await expectLimit(await request('/api/console/catalog/route', 'POST', { payload: { ...sample, id: 'over-limit' } }));
    let item = (await listCatalog(ctx, 'route')).find((r) => r.code === sample.id)!;
    for (let i = 2; i <= 20; i++)
      item = await updateCatalogItem(ctx, 'route', item.code, { rev: item.rev, set: { priceFrom: sample.priceFrom + i } });
    await assert.rejects(
      () => updateCatalogItem(ctx, 'route', item.code, { rev: item.rev, set: { priceFrom: sample.priceFrom + 21 } }),
      limited,
    );
    checks++;
    await expectLimit(
      await request(`/api/console/catalog/route/${item.code}`, 'PATCH', { rev: item.rev, set: { priceFrom: sample.priceFrom + 21 } }),
    );
    const unchanged = await updateCatalogItem(ctx, 'route', item.code, { rev: item.rev, set: { priceFrom: sample.priceFrom + 20 } });
    check(() => assert.equal(unchanged.rev, item.rev + 1));
    // CSV 使用合法酒店行；quoted newline 由真正 CSV 解析器处理，按数据行计数。
    const csv =
      'id,name,destination,stars,nightlyFrom,roomType,highlights,tags\n' +
      Array.from({ length: 81 }, (_, i) => `csv-${i},测试酒店,测试目的地,五星,1000,标准间,舒适,酒店`).join('\n');
    await assert.rejects(() => importCatalogCsv(ctx, 'hotel', csv), limited);
    checks++;
    await expectLimit(await request('/api/console/catalog/hotel/import-csv', 'POST', { csv }));
    // 已归档快捷回复也占存储条数；同一个写锁下的最后名额只给一个请求。
    await q("insert into quick_replies(tenant_id,ord,title,body) select $1,i,'测试回复','正文' from generate_series(0,48) i", [
      restored.id,
    ]);
    const qr = await Promise.all([
      request('/api/console/quick-replies', 'POST', { title: '最后一条', body: '正文' }),
      request('/api/console/quick-replies', 'POST', { title: '并发最后一条', body: '正文' }),
    ]);
    check(() => assert.equal(qr.filter((r) => r.status === 200).length, 1));
    await expectLimit(qr.find((r) => r.status !== 200)!);
    // SOP 初始导入不算发布，回滚同样产生新发布，防止绕过每日 20 次。
    const initial = currentSop();
    for (let i = 0; i < 20; i++) {
      const current = currentSop();
      const draft = await saveSopDraft(ctx, { basedOn: current.versionId, rev: null, edits: [] });
      await publishSopDraft(ctx, { rev: draft.rev!, changeNote: '限额验收发布' });
    }
    const current = currentSop();
    const draft = await saveSopDraft(ctx, { basedOn: current.versionId, rev: null, edits: [] });
    await expectLimit(await request('/api/console/sop/draft/publish', 'POST', { rev: draft.rev, changeNote: '超出上限' }));
    await assert.rejects(() => rollbackSop(ctx, { versionId: initial.versionId, changeNote: '回滚不能绕过' }), limited);
    checks++;
    check(() => assert.equal(currentSop().versionId, current.versionId));
  });
  const unaffected = await request('/api/console/quick-replies', 'POST', { title: 'B 不受影响', body: '正文' }, b.token);
  check(() => assert.equal(unaffected.status, 200));
  await cleanup();
  console.log(`SELFTEST ${real ? '真实 PG' : 'PGlite'}: 限额与六项写入上限通过`);
}

if (!process.env.PG_TEST_URL) {
  const f = await openTestDb();
  const q: Query = async (text, values) => {
    await f.pg.exec('RESET ROLE');
    try {
      return (await f.pg.query(text, values)).rows as never;
    } finally {
      await f.pg.exec('SET ROLE agent_app');
    }
  };
  try {
    await f.pg.exec(`SET ROLE agent_app; SET TIME ZONE '${testTimezone}'`);
    await suite(f.db, q, false);
  } finally {
    await cleanup();
    await f.close();
  }
} else {
  // 共用测试集群只创建自己的库，绝不 ALTER ROLE 或改别路的角色口令。
  const admin = new pg.Client({ connectionString: process.env.PG_TEST_URL });
  admin.on('error', () => {});
  await admin.connect();
  const name = `sandbox_limits_${randomBytes(6).toString('hex')}`;
  const url = new URL(process.env.PG_TEST_URL);
  url.pathname = `/${name}`;
  const roleUrl = (role: string) => {
    const u = new URL(url);
    u.searchParams.set('options', `-c role=${role} -c timezone=${testTimezone}`);
    return u.toString();
  };
  let db: Awaited<ReturnType<typeof openDb>> | undefined;
  let owner: pg.Client | undefined;
  try {
    await admin.query(`create database "${name}" owner agent_owner`);
    await runMigrations(roleUrl('agent_owner'));
    db = await openDb(roleUrl('agent_app'));
    owner = new pg.Client({ connectionString: url.toString() });
    owner.on('error', () => {});
    await owner.connect();
    await owner.query(`SET TIME ZONE '${testTimezone}'`);
    const q: Query = async (text, values) => (await owner!.query(text, values)).rows as never;
    await suite(db.db, q, true);
  } finally {
    await cleanup();
    await db?.close();
    await owner?.end();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}
console.log(`SELFTEST PASS: 沙箱限额 ${checks} 项`);
