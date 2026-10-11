// 05 第 10 步：作用域、双 writer、失败重试、释放、宿主文件与软上限。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-usage-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MAX_RETRY = '1';
process.env.ALERT_WEBHOOK_URL = '';
process.env.VISITOR_SESSION_LLM_CALLS = '1';
const r = await import('./runtime.js');
const usage = await import('../usage.js');
const visitor = await import('../budget.js');
const daily = await import('../trace/usage-daily.js');
const state = await import('./state.js');
const { gatedFetch, gateStatus, BudgetExhausted } = await import('../llm-gate.js');
const { initializeStandardBudget } = await import('./budget.js');
const a = r.hostRuntime();
const b = r.createTenantRuntime({ id: 'usage-b', slug: 'usage-b' });
const sandbox = r.createTenantRuntime({ id: 'usage-sbx', slug: 'usage-sbx', kind: 'sandbox' });
r.registerRuntime(b);
r.registerRuntime(sandbox);
r.configureTenancy({ role: 'host', standardCount: 2 });
const scope = <T>(rt: import('./runtime.js').TenantRuntime, fn: () => T): T => r.withTenantScope(rt, fn);
const writes = new Map<string, import('../trace/usage-daily.js').UsageDailyDelta[]>();
const timerScopes: (string | undefined)[] = [];
const hook = createHook({
  init: (_id, type) => {
    if (type === 'Timeout') timerScopes.push(r.scopedRuntime()?.id);
  },
});
const eventOwners: string[] = [];
const offUsage = usage.onUsage((e) => {
  assert.equal(e.tenantId, r.currentRuntime().id);
  eventOwners.push(e.tenantId);
});
const oldFetch = globalThis.fetch;
const oldWarn = console.warn;
const warnings: string[] = [];
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '));
};
let db: Awaited<ReturnType<typeof import('../db/testing.js').openTestDb>> | undefined;
try {
  assert.equal(fs.existsSync(path.join(dir, 'usage.json')), false);
  for (const access of [() => usage.recordUsage('glm-5.2', 1, 0), usage.usageToday, visitor.budgetStatus, daily.flushUsageDaily])
    assert.throws(access, r.TenantScopeMissing);
  await assert.rejects(
    gatedFetch('http://test.invalid/chat/completions', {}, () => AbortSignal.timeout(1000)),
    r.TenantScopeMissing,
  );

  hook.enable();
  for (const rt of [a, b])
    scope(rt, () =>
      daily.startUsageDaily(async (deltas) => {
        assert.equal(r.currentRuntime(), rt, '实例 timer 必须恢复 writer 的租户');
        const rows = writes.get(rt.id) ?? [];
        rows.push(...deltas);
        writes.set(rt.id, rows);
      }, 10),
    );
  scope(a, () => usage.recordUsage('glm-5.2', 100, 10, 'same'));
  scope(b, () => usage.recordUsage('glm-5.2', 200, 20, 'same', 0, 0, 'insight'));
  scope(sandbox, () => usage.recordUsage('glm-5.2', 300, 30, 'same'));
  scope(a, () => {
    assert.equal(visitor.tryReserveVisitorLLM('same'), true);
    assert.equal(visitor.tryReserveVisitorLLM('same'), false);
  });
  scope(b, () => {
    assert.equal(visitor.tryReserveVisitorLLM('same'), true);
    assert.equal(visitor.budgetStatus().calls, 0);
  });
  scope(sandbox, () => {
    assert.equal(usage.usageToday().totalCalls, 0);
    assert.equal(usage.sessionCost('same').calls, 0);
  });
  hook.disable();
  assert.ok(timerScopes.length > 0);
  assert.ok(
    timerScopes.every((id) => id === undefined),
    '计时器创建不得捕获首个租户',
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes.get(a.id)?.[0]?.promptTokens, 100);
  assert.equal(writes.get(b.id)?.[0]?.purpose, 'insight');
  assert.deepEqual(eventOwners.slice(0, 3), [a.id, b.id, sandbox.id]);
  scope(a, () => assert.equal(usage.usageToday().totalCalls, 1, '宿主口径不含其他 standard 与沙箱'));
  scope(b, () => assert.equal(daily.__usageDailyTest.pending()[0]?.calls, 0));

  let failed = true;
  let retryWrites = 0;
  scope(b, () =>
    daily.startUsageDaily(async (rows) => {
      assert.equal(r.currentRuntime(), b);
      if (failed) throw Object.assign(new Error('test'), { code: 'test_failure' });
      retryWrites += rows.reduce((n, row) => n + row.calls, 0);
    }, 60_000),
  );
  scope(b, () => usage.recordUsage('glm-5.2', 400, 40, undefined, 0, 0, 'draft'));
  await scope(b, daily.flushUsageDaily);
  scope(b, () => assert.equal(daily.__usageDailyTest.pending().find((row) => row.purpose === 'draft')?.calls, 1));
  failed = false;
  await Promise.all([scope(b, daily.flushUsageDaily), scope(b, daily.flushUsageDaily)]);
  assert.equal(retryWrites, 1, '重试与并发 flush 只提交一次');

  const request = { method: 'POST', body: JSON.stringify({ model: 'glm-5.2', max_tokens: 10, messages: [] }) };
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    if (fetches === 1) return new Response('retry', { status: 500 });
    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
  };
  const statusBefore = scope(b, () => b.budget.status());
  const result = await scope(b, () =>
    gatedFetch('http://test.invalid/chat/completions', request, () => AbortSignal.timeout(5000), { estimateMilli: 7 }),
  );
  assert.equal(result.attempts, 2);
  assert.equal(((await result.res.json()) as { usage: { prompt_tokens: number } }).usage.prompt_tokens, 100, '结算不得消耗调用方 body');
  const after = scope(b, () => b.budget.status());
  assert.equal(after.calls - statusBefore.calls, 2);
  assert.equal(after.costMilli - statusBefore.costMilli, 7 + usage.costOf('glm-5.2', 100, 10) * 1000);
  assert.equal(after.capCalls, null);
  assert.equal(gateStatus().inflight, 0);

  const denied = r.createTenantRuntime({ id: 'usage-denied', slug: 'usage-denied' });
  const rejecting = { ...denied, budget: { reserve: () => null, status: () => ({ calls: 0, costMilli: 0, capCalls: 0, capMilli: 0 }) } };
  const before = fetches;
  await assert.rejects(
    scope(rejecting, () => gatedFetch('http://test.invalid/chat/completions', request, () => AbortSignal.timeout(1000))),
    BudgetExhausted,
  );
  assert.equal(fetches, before);
  assert.equal(gateStatus().inflight, 0);

  state.resetTenantState();
  for (const rt of [a, b])
    scope(rt, () => {
      assert.equal(rt.budget.status().calls, 0);
      assert.equal(rt.budget.status().costMilli, 0);
      assert.equal(daily.__usageDailyTest.pending().length, 0, 'reset 清掉每个租户的累加');
    });

  const testing = await import('../db/testing.js');
  const store = await import('../store.js');
  db = await testing.openTestDb();
  // 验证真实 store 的 writer 接线，不能只直接调 startUsageDaily。
  for (const [rt, slug] of [
    [a, 'usage-a'],
    [b, 'usage-b'],
  ] as const) {
    await scope(rt, () => testing.installSeededConfig(db!, { slug }));
    const fixture = await scope(rt, () => testing.installPgSessionStore(db!, { slug, varDir: dir }));
    await scope(rt, () => store.initSessionStore(fixture.deps));
    await initializeStandardBudget(rt);
    scope(rt, () => daily.__usageDailyTest.rearm(60_000));
  }
  for (const rt of [a, b]) {
    scope(rt, () => usage.recordUsage('glm-5.2', 1000, 100));
    await scope(rt, daily.flushUsageDaily);
  }
  const dbRows = await db.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (
      await tx.query<{ tenant_id: string; calls: number }>('select tenant_id, sum(calls)::int as calls from usage_daily group by tenant_id')
    ).rows;
  });
  assert.ok(dbRows.some((row) => row.tenant_id === a.id));
  assert.ok(
    dbRows.some((row) => row.tenant_id === b.id),
    '非宿主也要有自己的 PG writer',
  );

  // 新运行时模拟重启，从库里读取软上限与已记用量；上限只影响告警。
  await db.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    await tx.query('update tenants set llm_daily_alert_milli = 0 where id = $1', [b.id]);
  });
  const restarted = r.createTenantRuntime({ id: b.id, slug: b.slug });
  restarted.config.loaded = b.config.loaded;
  r.unregisterRuntime(b.id);
  r.registerRuntime(restarted);
  await initializeStandardBudget(restarted);
  for (let i = 0; i < 3; i++) scope(restarted, () => restarted.budget.reserve('chat', 1)!.settle(1));
  const alertDeadline = Date.now() + 5000;
  while (!warnings.some((line) => line.includes('模型当日用量超过软上限')) && Date.now() < alertDeadline)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(warnings.filter((line) => line.includes('模型当日用量超过软上限')).length, 1);
  scope(restarted, () => assert.equal(restarted.budget.status().calls, 3, '越限后继续服务'));
  const realDate = globalThis.Date;
  const tomorrow = new realDate();
  tomorrow.setDate(tomorrow.getDate() + 1);
  globalThis.Date = new Proxy(realDate, {
    construct: (target, args) => (args.length ? Reflect.construct(target, args) : new realDate(tomorrow.getTime())),
  });
  try {
    scope(restarted, () => {
      restarted.budget.reserve('draft', 1)!.settle(1);
      restarted.budget.reserve('embedding', 1)!.settle(1);
    });
    const nextDeadline = Date.now() + 5000;
    while (warnings.filter((line) => line.includes('模型当日用量超过软上限')).length < 2 && Date.now() < nextDeadline)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(warnings.filter((line) => line.includes('模型当日用量超过软上限')).length, 2, '换天重新告警一次');
  } finally {
    globalThis.Date = realDate;
  }

  r.unregisterRuntime(restarted.id);
  r.registerRuntime(b);

  // 删除应释放每个登记项，取消宿主文件定时器，并且不影响另一个 writer。
  const late = scope(a, () => a.budget.reserve('chat', 5)!);
  a.state = 'closed';
  state.dropTenantState(a.id);
  late.settle(5);
  await scope(a, daily.flushUsageDaily);
  for (const [name, count] of Object.entries(state.tenantKeys(a.id)))
    if (name.startsWith('usage.') || name.startsWith('budget.')) assert.equal(count, 0, name);
  scope(b, () => usage.recordUsage('glm-5.2', 10, 1, 'same'));
  await scope(b, daily.flushUsageDaily);
  const beforeUsageFile = fs.existsSync(path.join(dir, 'usage.json')) ? fs.readFileSync(path.join(dir, 'usage.json'), 'utf8') : null;
  const beforeBudgetFile = fs.existsSync(path.join(dir, 'budget.json')) ? fs.readFileSync(path.join(dir, 'budget.json'), 'utf8') : null;
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal(fs.existsSync(path.join(dir, 'usage.json')) ? fs.readFileSync(path.join(dir, 'usage.json'), 'utf8') : null, beforeUsageFile);
  assert.equal(
    fs.existsSync(path.join(dir, 'budget.json')) ? fs.readFileSync(path.join(dir, 'budget.json'), 'utf8') : null,
    beforeBudgetFile,
  );
  assert.ok(warnings.some((line) => line.includes('test_failure')));
  console.log('TENANCY USAGE SELFTEST PASS: 双租户 / PG writer / 宿主口径 / timer 作用域 / 重试结算 / 软上限 / drop');
} finally {
  hook.disable();
  offUsage();
  globalThis.fetch = oldFetch;
  console.warn = oldWarn;
  const { __alertTest } = await import('../ops/alert.js');
  __alertTest.stopTimer();
  await r.withoutTenantScope(() => import('../shutdown.js').then(({ runShutdownHooks }) => runShutdownHooks(2000)));
  for (const rt of r.tenantRuntimes()) {
    state.dropTenantState(rt.id);
    r.unregisterRuntime(rt.id);
  }
  await db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
