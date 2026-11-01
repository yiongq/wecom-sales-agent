// 17：检查点、真实清理与 boot 分钟入口；同一契约跑 PGlite 与真实 app 角色。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import type { Db, TenantCtx } from '../db/client.js';
import type { StoreHealth } from '../store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.env.COVERAGE_SELFTEST_CHILD;
if (!mode) {
  if (process.env.CI === 'true' && !process.env.PG_TEST_URL) throw new Error('CI 下必须设 PG_TEST_URL');
  for (const child of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, COVERAGE_SELFTEST_CHILD: child, TZ: 'Asia/Shanghai' },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, `${child}: ${result.error ?? result.signal ?? 'failed'}`);
  }
  if (!process.env.PG_TEST_URL) console.log('COVERAGE：未设 PG_TEST_URL，跳过真实 PG');
  console.log('COVERAGE SELFTEST PASS');
} else {
  fs.mkdirSync(path.join(root, 'var'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'var/coverage-selftest-'));
  for (const name of ['data', 'public', 'console']) fs.symlinkSync(path.join(root, name), path.join(directory, name));
  process.chdir(directory);
  Object.assign(process.env, { VAR_DIR: path.join(directory, 'state'), CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' });
  try {
    await suite();
  } finally {
    process.chdir(root);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  async function suite(): Promise<void> {
    const testing = await import('../db/testing.js');
    const { openDb, withTenant } = await import('../db/client.js');
    const { initConfig, configRuntime, closeConfig } = await import('../config/source.js');
    const { importConfig } = await import('../config/transfer.js');
    const runtime = await import('../tenancy/runtime.js');
    const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
    const { initSessionStore, storeHealth, runShutdownHooks } = await import('../store.js');
    const { checkpointCoverage } = await import('./coverage.js');
    const { readCoverage } = await import('../db/repo/ops-coverage.js');
    const { readDailyMetrics } = await import('../db/repo/ops-metrics.js');
    const trends = await import('./trends.js');
    const { purgeOnce } = await import('../jobs/purge.js');
    const { boot } = await import('../boot.js');
    const { startOpsMinute } = await import('./minute.js');
    const { withTenantScope: scope } = runtime;
    let host = runtime.hostRuntime();
    enterTenantScopeForTest(host);
    type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
    let db: Db;
    let su: Query;
    let closeDb: () => Promise<void>;
    if (mode === 'pglite') {
      const t = await testing.openTestDb();
      db = t.db;
      await testing.installSeededConfig(t);
      su = (text, params = []) =>
        t.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<Record<string, unknown>>(text, params)).rows;
        });
      closeDb = () => t.close();
    } else {
      const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!);
      const app = await openDb(fx.urls.app, { max: 1 });
      db = app.db;
      su = (text, params) => fx.query(text, params);
      closeDb = async () => {
        await app.close();
        await fx.drop();
      };
      const deps = testing.testConfigDeps({ db });
      const imported = await importConfig({
        db,
        tenantSlug: 'demo',
        dataDir: path.join(root, 'data'),
        imageSop: deps.imageSop,
        lock: async () => testing.fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await initConfig(deps);
    }
    const otherId = String(
      (await su("insert into tenants(slug,name,pack_id) values('coverage-other','合成','travel') returning id"))[0]!.id,
    );
    let other = runtime.createTenantRuntime({ id: otherId, slug: 'coverage-other' });
    runtime.registerRuntime(other);
    const owners = [host, other];
    const context = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });
    const healthy: StoreHealth = { mode: 'db', conversations: 0, dirty: 0, lagMs: 0, lastError: null, conflict: false, poisoned: [] };
    const time = (day: string, clock = '00:00:00') => new Date(`${day}T${clock}+08:00`).getTime();
    const rows = (rt = host, days = ['2026-10-28']) =>
      scope(rt, () => withTenant(db, context(rt.id), (tx) => readCoverage(tx, days.map(trends.dayWindow))));
    const point = (view: Awaited<ReturnType<typeof trends.readTrendsView>>, day: string) => view.points.find((p) => p.day === day)!;
    const beat = (at: number, health = healthy, rt = host) => scope(rt, () => checkpointCoverage(at, health));
    try {
      for (const rt of owners)
        await scope(rt, async () => {
          if (rt === other) {
            const deps = testing.testConfigDeps({ db }, { tenantSlug: rt.slug });
            const imported = await importConfig({
              db,
              tenantSlug: rt.slug,
              dataDir: path.join(root, 'data'),
              imageSop: deps.imageSop,
              lock: async () => testing.fakeLock(),
            });
            assert.equal(imported.code, 0, imported.message);
            await initConfig(deps);
          }
          fs.mkdirSync(path.join(directory, rt.slug), { recursive: true });
          const config = configRuntime();
          await initSessionStore({ db, tenantId: rt.id, tenantSlug: config.deps.tenantSlug, varDir: path.join(directory, rt.slug) });
        });
      await su("update tenants set created_at='2026-10-01', retention_trace_days=30 where id in ($1,$2)", [host.id, other.id]);
      // 首次/重启标志来自运行时状态；常规日之前先成功启动。
      await beat(time('2026-10-27', '23:59:00'));
      assert.equal((await rows(host, ['2026-10-27']))[0]!.hasGap, true, '启动置 gap');
      const start = time('2026-10-28');
      await beat(start);
      await beat(start + 120_000);
      assert.equal((await rows())[0]!.hasGap, false, '120 秒不是缺口');
      await beat(start + 120_000 + 121_000);
      assert.equal((await rows())[0]!.hasGap, true, '121 秒是缺口');
      const last = (await rows())[0]!.lastSeenAt.getTime();
      await beat(start + 60_000);
      assert.equal((await rows())[0]!.lastSeenAt.getTime(), last, '应用时钟回拨不回退检查点');
      assert.equal((await rows())[0]!.hasGap, true, 'gap 不清除');
      assert.equal((await rows(other)).length, 0, 'RLS：另一租户不可见');
      await beat(time('2026-10-27', '23:59:00'), healthy, other);
      // 每分钟持续采集两个自然日，含午夜 60 秒跨日。
      for (let at = start; at <= time('2026-10-30', '23:59:00'); at += 60_000) await beat(at, healthy, other);
      const complete = await scope(other, () => trends.readTrendsView(context(other.id), 7, time('2026-10-30', '12:00:00')));
      for (const day of ['2026-10-28', '2026-10-29']) assert.equal(point(complete, day).coverage, 'complete', `午夜正常：${day}`);
      assert.ok(complete.partialReasons.includes('unknown_history'), '无行历史日未知');
      assert.equal(point(complete, '2026-10-26').turns, null);
      const gapView = await scope(host, () => trends.readTrendsView(context(host.id), 7, time('2026-10-30', '12:00:00')));
      assert.notEqual(point(gapView, '2026-10-28').coverage, 'complete');
      // 长间隔跨午夜，两端日期均降级；边界用 121 秒。
      assert.equal((await rows(other, ['2026-10-30']))[0]!.hasGap, false, '跨日缺口之前上一日完整');
      await beat(time('2026-10-30', '23:59:00'), healthy, other);
      await beat(time('2026-10-31', '00:01:01'), healthy, other);
      assert.ok((await rows(other, ['2026-10-30', '2026-10-31'])).every((r) => r.hasGap));
      // 每种健康异常先恢复一个无 gap 的新日，异常仍独立触发。
      let day = 1;
      for (const patch of [{ conflict: true }, { poisoned: ['synthetic'] }, { lagMs: 60_001 }]) {
        const at = time(`2026-11-0${day}`);
        await beat(at - 60_000);
        await beat(at);
        assert.equal((await rows(host, [`2026-11-0${day}`]))[0]!.hasGap, false);
        await beat(at + 60_000, { ...healthy, ...patch });
        assert.equal((await rows(host, [`2026-11-0${day}`]))[0]!.hasGap, true);
        day++;
      }
      await beat(time('2026-11-04') - 60_000);
      await beat(time('2026-11-04'), { ...healthy, lagMs: 60_000 });
      assert.equal((await rows(host, ['2026-11-04']))[0]!.hasGap, false, '积压 60 秒仍健康');
      // 新运行时复用同一租户持久行，证明进程内 first flag 不从库中推断。
      await scope(other, async () => {
        await other.store.pgBackend?.close();
        await closeConfig();
      });
      (await import('../tenancy/state.js')).dropTenantState(other.id);
      runtime.unregisterRuntime(other.id);
      fs.mkdirSync(path.join(directory, 'restart'), { recursive: true });
      other = runtime.createTenantRuntime({ id: other.id, slug: other.slug });
      owners[1] = other;
      await scope(other, async () => {
        await initConfig(testing.testConfigDeps({ db }, { tenantSlug: other.slug }));
        await initSessionStore({ db, tenantId: other.id, tenantSlug: other.slug, varDir: path.join(directory, 'restart') });
        await checkpointCoverage(time('2026-10-29', '23:59:30'), healthy);
      });
      assert.equal((await rows(other, ['2026-10-29']))[0]!.hasGap, true, '重启已有完整日也置 gap');
      console.log(`${mode} CHECKPOINT PASS：120/121 秒、午夜、重启、健康、回拨、RLS、真实趋势 complete/unknown/gap`);

      // 真实 purgeOnce：trace 到期和会话到期分别证明失效，另一租户缓存仍命中。
      const now = Date.now();
      const old = new Date(now - 8 * 86_400_000);
      const oldDay = (await import('../env.js')).todayIso(old);
      await su('update tenants set retention_trace_days=7, retention_lead_days=7, retention_customer_days=7 where id=$1', [host.id]);
      await su(
        `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
        values($1,'coverage-purge','wecom','new',false,'{"id":"coverage-purge"}',$2,$2)`,
        [host.id, new Date(now)],
      );
      await su(
        `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
        values($1,$2,'coverage-purge',$3,10,'replied',$4,'{}','[]','[]')`,
        [host.id, randomUUID(), old, 'a'.repeat(64)],
      );
      await su(
        `insert into ops_metric_coverage(tenant_id,day,first_seen_at,last_seen_at)
        values($1,$2,$3,$4) on conflict(tenant_id,day) do update set first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,has_gap=false`,
        [host.id, oldDay, trends.dayWindow(oldDay).from, trends.dayWindow(oldDay).to],
      );
      let aggregates = 0;
      trends.__trendsTest.use({
        aggregate: async (tx, ws) => {
          aggregates++;
          return readDailyMetrics(tx, ws);
        },
      });
      const view = (rt = host) => scope(rt, () => trends.readTrendsView(context(rt.id), 7, now));
      const otherCached = await view(other);
      const before = await view();
      const count = aggregates;
      const purged = await scope(host, () => purgeOnce(now));
      assert.ok(purged.traces > 0, '真实 trace 到期删除');
      assert.notStrictEqual(await view(), before, 'trace 删除后在 TTL 内重新聚合');
      assert.equal(aggregates, count + 1);
      assert.strictEqual(await view(other), otherCached, '另一租户缓存不受影响');
      // 会话到期时仍有保留期内的 trace：删除必须改变可见日值和删除证据。
      await su('update tenants set retention_trace_days=30 where id=$1', [host.id]);
      await su(
        `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
        values($1,'coverage-expired','wecom','new',false,'{"id":"coverage-expired"}',$2,$2)`,
        [host.id, old],
      );
      const recent = new Date(now - 2 * 86_400_000);
      const recentDay = (await import('../env.js')).todayIso(recent);
      await su(
        `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
        values($1,$2,'coverage-expired',$3,10,'replied',$4,'{}','[]','[]')`,
        [host.id, randomUUID(), recent, 'a'.repeat(64)],
      );
      await su(
        `insert into ops_metric_coverage(tenant_id,day,first_seen_at,last_seen_at)
        values($1,$2,$3,$4) on conflict(tenant_id,day) do update set first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,has_gap=false`,
        [host.id, recentDay, trends.dayWindow(recentDay).from, trends.dayWindow(recentDay).to],
      );
      scope(host, trends.invalidateTrends);
      const beforeConversation = await view();
      assert.equal(point(beforeConversation, recentDay).turns, 1);
      assert.equal(point(beforeConversation, recentDay).coverage, 'complete');
      const purgedConversation = await scope(host, () => purgeOnce(now));
      assert.equal(purgedConversation.conversations, 1);
      const deletionView = await view();
      assert.notStrictEqual(deletionView, beforeConversation, '会话删除也在 TTL 内失效');
      assert.equal(point(deletionView, recentDay).turns, null, '60 秒缓存内读到删除后的值');
      assert.ok(deletionView.partialReasons.includes('deletion'));
      assert.notEqual(point(deletionView, recentDay).coverage, 'complete');
      assert.equal((await rows(host, [recentDay]))[0]!.hasDeletion, true, '删除函数持久标记');
      await beat(trends.dayWindow(recentDay).to.getTime() - 60_000);
      assert.equal((await rows(host, [recentDay]))[0]!.hasDeletion, true, '再采集不清除删除标记');
      assert.ok((await view()).partialReasons.includes('deletion'));
      assert.strictEqual(await view(other), otherCached);
      console.log(`${mode} PURGE PASS：真实 purgeOnce、trace/会话分别失效、跨租户缓存、deletion 不清除`);
      trends.__trendsTest.reset();

      // 释放旧进程状态，boot 必须真正重新装配置与存储，再调生产分钟入口。
      const hostId = host.id;
      await scope(host, async () => {
        await host.store.pgBackend?.close();
        await closeConfig();
      });
      (await import('../tenancy/state.js')).dropTenantState(host.id);
      runtime.unregisterRuntime(host.id);
      host = runtime.createTenantRuntime({ id: hostId, slug: 'demo', isHost: true });
      owners[0] = host;
      runtime.registerRuntime(host);
      // 真实 boot() 调生产 startOpsMinute；仅用 Node 时钟驱动 setInterval，不调用业务测试钩子。
      mock.timers.enable({ apis: ['setInterval'] });
      const observed: number[] = [];
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      let cleared = false;
      let minuteCallbacks = 0;
      let unrefs = 0;
      let minuteHandle: ReturnType<typeof setInterval> | undefined;
      globalThis.setInterval = ((fn: () => void, ms: number) => {
        observed.push(ms);
        const handle = realSetInterval(() => {
          if (ms === 60_000) minuteCallbacks++;
          fn();
        }, ms);
        const unref = handle.unref.bind(handle);
        handle.unref = () => {
          if (ms === 60_000) unrefs++;
          return unref();
        };
        if (ms === 60_000) minuteHandle = handle;
        return handle;
      }) as typeof setInterval;
      globalThis.clearInterval = ((handle) => {
        if (minuteHandle && handle === minuteHandle) cleared = true;
        realClearInterval(handle);
      }) as typeof clearInterval;
      const countToday = async () =>
        Number(
          (
            await su('select count(*) as n from ops_metric_coverage where tenant_id=$1 and day=$2', [
              host.id,
              (await import('../env.js')).todayIso(),
            ])
          )[0]!.n,
        );
      const settle = async () => {
        for (let i = 0; i < 200; i++) {
          if (!host.inflight.size && !other.inflight.size) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('minute did not finish');
      };
      try {
        const order: string[] = [];
        await su('delete from ops_metric_coverage where tenant_id=$1 and day=$2', [host.id, (await import('../env.js')).todayIso()]);
        assert.equal(await countToday(), 0);
        await boot({
          initConfig: () => scope(host, () => initConfig(testing.testConfigDeps({ db }))),
          initSessionStore: () =>
            scope(host, () => initSessionStore({ db, tenantId: host.id, tenantSlug: 'demo', varDir: path.join(directory, 'demo') })),
          initChannels: async () => {},
          initErp: async () => {},
          serve: (listen) => listen(),
          preflight: () => {},
          buildIndex: async () => {},
          storeMode: () => 'db',
          startFollowUpScheduler: () => assert.fail('db scheduler'),
          startJobs: () => {
            order.push('jobs');
          },
          startOpsMinute: () => {
            order.push('minute');
            startOpsMinute();
          },
          startChannels: () => {},
          exit: () => assert.fail('boot exit'),
        });
        await settle();
        assert.deepEqual(order, ['jobs', 'minute']);
        assert.equal(await countToday(), 1, 'boot 不调用业务测试钩子即可落 coverage');
        startOpsMinute();
        assert.equal(observed.filter((ms) => ms === 60_000).length, 1, '进程只有一个分钟定时器');
        assert.equal(unrefs, 1);
        let queries = 0;
        trends.__trendsTest.use({
          aggregate: async (tx, ws) => {
            queries++;
            return readDailyMetrics(tx, ws);
          },
        });
        await view();
        mock.timers.tick(60_000);
        await settle();
        await view();
        assert.equal(queries, 2, '真实分钟回调写检查点并作废缓存');
        for (const guard of ['closing', 'lost', 'taken'] as const) {
          const cached = await view();
          const otherBefore = await view(other);
          if (guard === 'closing') host.state = 'closing';
          if (guard === 'lost') host.config.lockState = 'lost';
          if (guard === 'taken') host.config.lockTaken = true;
          try {
            mock.timers.tick(60_000);
            await settle();
            assert.strictEqual(await view(), cached, `${guard} 不写检查点`);
            assert.notStrictEqual(await view(other), otherBefore, `${guard} 不妨碍另一租户`);
          } finally {
            host.state = 'serving';
            host.config.lockState = 'held';
            host.config.lockTaken = false;
          }
        }
        // 一租户 SQL 失败不能中止逐租户循环，也不能泄漏错误原文；30 分钟只记一次。
        await su(`alter table ops_metric_coverage add constraint coverage_failure_probe check(tenant_id <> '${host.id}'::uuid) not valid`);
        const warn = console.warn;
        let failureLogs = 0;
        console.warn = (...args) => {
          if (String(args[0]).startsWith('[ops]')) failureLogs++;
          else warn(...args);
        };
        try {
          for (let i = 0; i < 2; i++) {
            const cached = await view();
            const otherBefore = await view(other);
            mock.timers.tick(60_000);
            await settle();
            assert.strictEqual(await view(), cached, '失败没有假写成功');
            assert.notStrictEqual(await view(other), otherBefore, '单租户失败不影响另一租户采集');
          }
          assert.equal(failureLogs, 1, '错误日志节流');
        } finally {
          console.warn = warn;
          await su('alter table ops_metric_coverage drop constraint coverage_failure_probe');
        }
        await runtime.withoutTenantScope(() => runShutdownHooks());
        assert.equal(cleared, true, '停机显式清除分钟句柄');
        const afterCallbacks = minuteCallbacks;
        const after = queries;
        mock.timers.tick(120_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await view();
        assert.equal(queries, after, '停机清定时器，不再写检查点/失效缓存');
        assert.equal(minuteCallbacks, afterCallbacks, '停机后分钟回调不再触发');
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        mock.timers.reset();
      }
      console.log(`${mode} BOOT PASS：生产分钟入口、立即落库、60 秒、幂等、unref、停机清除`);
      assert.equal(scope(host, storeHealth).mode, 'db');
    } finally {
      mock.timers.reset();
      trends.__trendsTest.reset();
      await runtime.withoutTenantScope(() => runShutdownHooks());
      for (const rt of owners)
        await scope(rt, async () => {
          await rt.store.pgBackend?.close();
          await closeConfig();
        });
      runtime.unregisterRuntime(other.id);
      await closeDb();
    }
  }
}
