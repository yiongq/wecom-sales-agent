// 14 第 1 步：月度计数、快照竞态、轮询恢复与租户隔离；PGlite + 真实 PG 共用行为套件。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHook } from 'node:async_hooks';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-test-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.ALERT_WEBHOOK_URL = '';
const r = await import('./runtime.js');
const limits = await import('./limits.js');
const daily = await import('../trace/usage-daily.js');
const usage = await import('../usage.js');
const store = await import('../store.js');
const testing = await import('../db/testing.js');
const { openDb, withTenant, pgErrorOf } = await import('../db/client.js');
const { importConfig } = await import('../config/transfer.js');
const { initConfig } = await import('../config/source.js');
const { readUsageMonth } = await import('../db/repo/usage.js');
const { readMetrics } = await import('../db/repo/metrics.js');
const { tenantKeys, dropTenantState } = await import('./state.js');
const { runShutdownHooks } = await import('../shutdown.js');
type Runtime = import('./runtime.js').TenantRuntime;
type Db = import('../db/client.js').Db;
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const ctx = (rt: Runtime) => ({ tenantId: rt.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
const scope = r.withTenantScope;

async function suite(db: Db, query: Query, label: string): Promise<void> {
  let now = new Date(2026, 9, 30, 12).getTime();
  const alerts: { id: string; percent: number; month: string }[] = [];
  limits.__limitsTest.configure({ now: () => now, alert: (rt, percent, month) => alerts.push({ id: rt.id, percent, month }) });
  const runtimes: Runtime[] = [];
  const timers: (string | undefined)[] = [];
  const hook = createHook({
    init: (_id, type, _trigger, resource) => {
      if (type === 'Timeout' && (resource as { _repeat?: number })._repeat === 30_000) timers.push(r.scopedRuntime()?.id);
    },
  });
  const setup = async (slug: string): Promise<Runtime> => {
    await query("insert into tenants(slug,name,pack_id) values ($1,$1,'travel') on conflict do nothing", [slug]);
    const rt = r.createTenantRuntime({ id: slug, slug, isHost: slug.endsWith('-a') });
    r.registerRuntime(rt);
    runtimes.push(rt);
    await scope(rt, async () => {
      const deps = testing.testConfigDeps({ db }, { tenantSlug: slug });
      const imported = await importConfig({
        db,
        tenantSlug: slug,
        dataDir: 'data',
        imageSop: deps.imageSop,
        lock: async () => testing.fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await initConfig(deps);
      await store.initSessionStore({ db, tenantId: rt.id, tenantSlug: slug, varDir: dir });
      daily.__usageDailyTest.rearm(3600_000);
    });
    return rt;
  };
  const poll = (rt: Runtime) => scope(rt, () => limits.initializeTenantLimits(rt));
  const value = (rt: Runtime) => scope(rt, () => limits.getTenantLimits()!);
  const verdict = (rt: Runtime) => scope(rt, limits.limitVerdict);
  const reply = (rt: Runtime, n = 1) =>
    scope(rt, () => {
      for (let i = 0; i < n; i++) limits.noteAiReply();
    });
  const flush = (rt: Runtime) => scope(rt, daily.flushUsageDaily);
  const rows = (rt: Runtime, month: string) => scope(rt, () => withTenant(db, ctx(rt), (tx) => readUsageMonth(tx, month)));
  const metrics = (rt: Runtime) =>
    scope(rt, () =>
      withTenant(db, ctx(rt), (tx) =>
        readMetrics(tx, {
          since: new Date(2026, 9, 1),
          sinceDay: '2026-10-01',
          today: '2026-10-31',
        }),
      ),
    );
  try {
    hook.enable();
    const a = await setup(`limits-${label}-a`);
    const b = await setup(`limits-${label}-b`);
    hook.disable();
    assert.ok(timers.length > 0 && timers.every((owner) => owner === undefined), '定时器不捕获首个租户');
    assert.equal(limits.__limitsTest.timer()?.hasRef(), false);
    assert.deepEqual(value(a), { status: 'active', monthlyQuota: null, monthlyUsed: 0, dailyCapMilli: null });
    assert.equal(verdict(a), 'ok');
    await query('update tenants set monthly_reply_quota=10, llm_daily_cap_milli=321 where id=$1', [a.id]);
    await poll(a);
    assert.equal(value(a).monthlyQuota, 10);
    assert.equal(value(a).dailyCapMilli, 321);
    reply(a, 7);
    assert.equal(alerts.length, 0);
    reply(a);
    assert.deepEqual(
      alerts.map((a) => a.percent),
      [80],
    );
    reply(a, 2);
    assert.equal(verdict(a), 'quota');
    reply(a, 2);
    assert.deepEqual(
      alerts.map((a) => a.percent),
      [80, 100],
      '同月每个阈值一次',
    );
    assert.equal(value(b).monthlyUsed, 0);
    reply(b, 3);
    assert.equal(value(a).monthlyUsed, 12);
    assert.equal(value(b).monthlyUsed, 3);
    assert.ok(alerts.every((alert) => alert.id === a.id));
    await flush(a);
    await flush(b);
    assert.deepEqual(await rows(b, '2026-10'), [{ day: '2026-10-30', replies: 3, costMilli: 0 }], 'RLS 不读到另一个租户');
    const beforeUsage = scope(a, usage.usageToday);
    const beforeCost = scope(a, () => usage.sessionCost('same'));
    const beforeMetrics = await metrics(a);
    reply(a);
    await flush(a);
    assert.deepEqual(scope(a, usage.usageToday), beforeUsage, '/api/usage 的数据逐字节不变');
    assert.deepEqual(
      scope(a, () => usage.sessionCost('same')),
      beforeCost,
    );
    assert.deepEqual(await metrics(a), beforeMetrics, '后台运行数字、费用图不受 reply 行影响');
    scope(a, () => usage.recordUsage('glm-5.2', 1000, 100, 'same'));
    await flush(a);
    assert.equal(scope(a, usage.usageToday).totalCalls, beforeUsage.totalCalls + 1);
    assert.ok((await metrics(a)).costRangeMilliCny > beforeMetrics.costRangeMilliCny);
    assert.equal((await rows(a, '2026-10'))[0]!.replies, 13, '模型调用不加 AI 回复数');
    const replyRows = await query<{ model: string; calls: number; tokens: number; cost: number }>(
      "select model,calls,(prompt_tokens+completion_tokens+cached_tokens+reasoning_tokens)::float8 as tokens,cost_milli_cny::float8 as cost from usage_daily where tenant_id=$1 and purpose='reply'",
      [a.id],
    );
    assert.deepEqual(replyRows, [{ model: '-', calls: 13, tokens: 0, cost: 0 }]);
    now = new Date(2026, 9, 31, 12).getTime();
    reply(a);
    assert.equal(value(a).monthlyUsed, 14, '跨日不归零');
    await flush(a);
    await poll(a);
    assert.equal(value(a).monthlyUsed, 14, '轮询不能重复计入已提交的本进程用量');
    assert.equal((await rows(a, '2026-10')).length, 2);

    // 读库失败必须保留最后一次配置；故障期间继续计数与落库，恢复不能重复计数。
    const originalRead = limits.__limitsTest.reader();
    limits.__limitsTest.configure({
      read: async () => {
        throw new Error('synthetic_read_failure');
      },
    });
    await query("update tenants set status='suspended', monthly_reply_quota=50, llm_daily_cap_milli=999 where id=$1", [a.id]);
    await poll(a);
    assert.equal(value(a).status, 'active');
    assert.equal(value(a).monthlyQuota, 10);
    assert.equal(value(a).dailyCapMilli, 321);
    reply(a);
    await flush(a);
    limits.__limitsTest.configure({ read: originalRead });
    await poll(a);
    assert.equal(value(a).monthlyUsed, 15);
    assert.equal(value(a).monthlyQuota, 50);
    assert.equal(value(a).dailyCapMilli, 999);
    assert.equal(verdict(a), 'suspended');
    assert.equal(value(b).monthlyUsed, 3);
    await query("update tenants set status='trial', monthly_reply_quota=0, llm_daily_cap_milli=0 where id=$1", [a.id]);
    await limits.__limitsTest.poll();
    assert.equal(verdict(a), 'quota', 'trial 和 active 同口径；0 全拦');
    await query('update tenants set monthly_reply_quota=null, llm_daily_cap_milli=null where id=$1', [a.id]);
    await poll(a);
    assert.equal(verdict(a), 'ok', 'NULL 不限');

    // 启动读失败期间已提交的回复，恢复时不能把 4 算成 8。
    limits.__limitsTest.configure({
      read: async () => {
        throw new Error('synthetic_start_failure');
      },
    });
    let c = await setup(`limits-${label}-c`);
    reply(c, 4);
    await flush(c);
    limits.__limitsTest.configure({ read: originalRead });
    await poll(c);
    assert.equal(value(c).monthlyUsed, 4, '恢复扣除本进程已提交部分');
    // 新运行时模拟重启：重建所有内存状态，用库中历史月用量作为新基数。
    const old = c;
    const config = { ...c.config };
    const pack = c.pack;
    await c.store.pgBackend!.close();
    old.state = 'closed';
    dropTenantState(old.id);
    r.unregisterRuntime(old.id);
    runtimes.splice(runtimes.indexOf(old), 1);
    c = r.createTenantRuntime({ id: old.id, slug: old.slug });
    Object.assign(c.config, config);
    c.pack = pack;
    r.registerRuntime(c);
    runtimes.push(c);
    await scope(c, () => store.initSessionStore({ db, tenantId: c.id, tenantSlug: c.slug, varDir: dir }));
    scope(c, () => daily.__usageDailyTest.rearm(3600_000));
    assert.equal(value(c).monthlyUsed, 4, '重启接上数据库中的计数');

    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    limits.__limitsTest.configure({
      read: async (rt, month) => {
        entered();
        await gate;
        return originalRead(rt, month);
      },
    });
    const pendingPoll = poll(c);
    await started;
    reply(c, 2);
    const pendingFlush = flush(c);
    release();
    await Promise.all([pendingPoll, pendingFlush]);
    assert.equal(value(c).monthlyUsed, 6, '读取中到达的回复不丢、不重复');
    limits.__limitsTest.configure({ read: originalRead });
    await poll(c);
    assert.equal(value(c).monthlyUsed, 6);

    now = new Date(2026, 10, 1, 0, 0, 1).getTime();
    assert.equal(verdict(a), 'ok');
    assert.equal(value(a).monthlyUsed, 0, '判定同步跨月归零');
    reply(a);
    await flush(a);
    await poll(a);
    assert.equal(value(a).monthlyUsed, 1);
    assert.equal(
      (await rows(a, '2026-10')).reduce((n, row) => n + row.replies, 0),
      15,
    );
    assert.deepEqual(await rows(a, '2026-11'), [{ day: '2026-11-01', replies: 1, costMilli: 0 }]);

    await query('update tenants set monthly_reply_quota=10 where id=$1', [a.id]);
    await poll(a);
    const previousAlerts = alerts.length;
    reply(a, 7);
    assert.equal(alerts.length, previousAlerts + 1, '新月份可再次到达 80%');
    reply(a, 2);
    assert.equal(alerts.length, previousAlerts + 2, '新月份可再次到达 100%');
    const returned = value(a);
    returned.monthlyUsed = -100;
    assert.equal(value(a).monthlyUsed, 10, '读取返回副本');
    await assert.rejects(
      query(
        `insert into tenants(slug,name,pack_id,kind,expires_at,template_tenant_id,monthly_reply_quota)
      values ($1,$1,'travel','sandbox',now()+interval '1 hour',$2,1)`,
        [`limits-${label}-bad`, a.id],
      ),
      (e) => pgErrorOf(e).code === '23514',
    );
    for (const column of ['monthly_reply_quota', 'llm_daily_cap_milli'])
      await assert.rejects(query(`update tenants set ${column}=-1 where id=$1`, [a.id]), (e) => pgErrorOf(e).code === '23514');
    assert.ok(limits.__limitsTest.timer());
    await runShutdownHooks();
    assert.equal(limits.__limitsTest.timer(), null, '关闭钩子清掉轮询');
    console.log(`LIMITS ${label} PASS: 月度跨日/跨月/重启、NULL/0、轮询失败、在途回复、双租户、80/100 告警、旧数字不变`);
  } finally {
    hook.disable();
    limits.stopTenantLimits();
    for (const rt of runtimes) {
      await scope(rt, daily.flushUsageDaily);
      await rt.store.pgBackend?.close();
      rt.state = 'closed';
      dropTenantState(rt.id);
      assert.equal(tenantKeys(rt.id)['limits.current'], 0);
      r.unregisterRuntime(rt.id);
    }
    limits.__limitsTest.reset();
  }
}

try {
  const host = r.hostRuntime();
  const sandbox = r.createTenantRuntime({ id: 'limits-sandbox', slug: 'limits-sandbox', kind: 'sandbox' });
  for (const rt of [host, sandbox])
    scope(rt, () => {
      limits.noteAiReply();
      assert.equal(limits.limitVerdict(), 'ok');
      assert.equal(limits.getTenantLimits(), null);
      assert.equal(daily.__usageDailyTest.pending().length, 0, '文件模式与沙箱不累加、不写库');
    });
  const test = await testing.openTestDb();
  try {
    await test.migrate();
    await test.pg.exec('SET ROLE agent_app');
    await suite(
      test.db,
      <T>(sql: string, params?: unknown[]) =>
        test.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<T>(sql, params)).rows;
        }),
      'pglite',
    );
  } finally {
    await test.close();
  }
  if (process.env.PG_TEST_URL) {
    const fixture = await testing.createRealPgFixture(process.env.PG_TEST_URL);
    const app = await openDb(fixture.urls.app);
    try {
      await suite(app.db, fixture.query, 'pg');
    } finally {
      await app.close();
      await fixture.drop();
    }
  } else if (process.env.CI === 'true') throw new Error('CI 必须设 PG_TEST_URL');
  else console.log('LIMITS：未设 PG_TEST_URL，真实 PG 待补跑');
  await runShutdownHooks();
  assert.equal(limits.__limitsTest.timer(), null);
  console.log('LIMITS SELFTEST PASS');
} finally {
  limits.__limitsTest.reset();
  await runShutdownHooks();
  fs.rmSync(dir, { recursive: true, force: true });
}
