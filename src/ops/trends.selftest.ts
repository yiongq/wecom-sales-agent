// 17 验收 6/11：同一组合成数据跑 PGlite/真实 PG；HTTP 必须经过完整 server 入口。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { DailyMetricsRow } from '../db/repo/ops-metrics.js';
import type { MetricsTrendsView, Role } from '../shared/console-api.js';

const mode = process.env.TRENDS_SELFTEST_CHILD;
const root = fileURLToPath(new URL('../../', import.meta.url));
if (!mode) {
  if (process.env.CI === 'true' && !process.env.PG_TEST_URL) throw new Error('CI 下必须设 PG_TEST_URL');
  for (const child of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : []), 'dst']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, TRENDS_SELFTEST_CHILD: child, TZ: child === 'dst' ? 'America/New_York' : 'Asia/Shanghai' },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, `${child}: ${result.error ?? result.signal ?? 'failed'}`);
  }
  if (!process.env.PG_TEST_URL) console.log('TRENDS：未设 PG_TEST_URL，跳过真实 PG');
  console.log('TRENDS SELFTEST PASS');
} else {
  fs.mkdirSync(path.join(root, 'var'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'var/trends-selftest-'));
  for (const name of ['data', 'public', 'console']) fs.symlinkSync(path.join(root, name), path.join(directory, name));
  process.chdir(directory); // 不读取开发目录的 env；所有运行时文件仅在本次目录。
  Object.assign(process.env, { VAR_DIR: path.join(directory, 'state'), CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', LLM_MOCK: '1' });
  const trends = await import('./trends.js');
  try {
    if (mode === 'dst') {
      for (const [day, hours] of [
        ['2026-03-08', 23],
        ['2026-11-01', 25],
      ] as const) {
        const w = trends.dayWindow(day);
        assert.equal((w.to.getTime() - w.from.getTime()) / 3_600_000, hours);
        assert.equal(w.from.getHours(), 0);
        assert.equal(w.to.getHours(), 0);
      }
      console.log('DST PASS：America/New_York 春季 23 小时、秋季 25 小时');
    } else {
      await suite();
    }
  } finally {
    process.chdir(root);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  async function suite(): Promise<void> {
    const testing = await import('../db/testing.js');
    const { withTenant, openDb } = await import('../db/client.js');
    const { readDailyMetrics } = await import('../db/repo/ops-metrics.js');
    const { configRuntime, initConfig, closeConfig } = await import('../config/source.js');
    const { hostRuntime, createTenantRuntime } = await import('../tenancy/runtime.js');
    const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
    const { createUser } = await import('../auth/accounts.js');
    const { importConfig } = await import('../config/transfer.js');
    const host = hostRuntime();
    enterTenantScopeForTest(host);
    type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
    let db: Db;
    let su: Query;
    let platform: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
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
      platform = async (fn) => {
        await t.pg.exec('SET ROLE agent_platform');
        try {
          return await fn(db);
        } finally {
          await t.pg.exec('SET ROLE agent_app');
        }
      };
      closeDb = () => t.close();
    } else {
      const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!);
      const appDb = await openDb(fx.urls.app, { max: 1 });
      const platformDb = await openDb(fx.urls.platform, { max: 1 });
      db = appDb.db;
      su = (text, params) => fx.query(text, params);
      platform = (fn) => fn(platformDb.db);
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
      closeDb = async () => {
        await appDb.close();
        await platformDb.close();
        await fx.drop();
      };
    }
    const { app } = await import('../server.js');
    const { __consoleTest } = await import('../console-api/app.js');
    const { __profileTest } = await import('../profile.js');
    const { initSessionStore } = await import('../store.js');
    const { runShutdownHooks } = await import('../shutdown.js');
    const now = new Date(2026, 9, 30, 12).getTime();
    let clock = now;
    __consoleTest.setClock(() => clock);
    const tenantId = configRuntime().tenantId;
    const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const roles: Role[] = ['owner', 'admin', 'supervisor', 'agent', 'viewer'];
    const tokens = new Map<Role, string>();
    const request = (role?: Role, suffix = '') =>
      app.request(`/api/console/metrics/trends${suffix}`, {
        headers: role ? { cookie: tokens.get(role)! } : {},
      });
    try {
      // 文件存储用例先跑；随后只装一次真实 DB 会话后端。
      for (const role of roles) {
        const made = await platform((p) =>
          createUser(p, {
            tenantSlug: 'demo',
            email: `${role}@trends.example.test`,
            name: role,
            role,
            password: async () => `synthetic-${role}-password`,
          }),
        );
        assert.equal(made.code, 0, made.message);
        const body = JSON.stringify({ email: `${role}@trends.example.test`, password: `synthetic-${role}-password` });
        const login = await app.request('/api/console/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
          body,
        });
        assert.equal(login.status, 200, await login.clone().text());
        tokens.set(role, login.headers.get('set-cookie')!.split(';')[0]!);
      }
      for (const role of [undefined, ...roles]) {
        const response = await request(role, '?days=invalid');
        const allowed = role === 'owner' || role === 'admin';
        assert.equal(response.status, !role ? 401 : allowed ? 503 : 403, `file permissions ${role}`);
        assert.equal((await response.json()).error, !role ? 'unauthorized' : allowed ? 'store_file_mode' : 'forbidden');
      }
      await initSessionStore({ db, tenantId, tenantSlug: 'demo', varDir: process.env.VAR_DIR! });
      await su("update tenants set created_at='2026-10-01T00:00:00+08', retention_trace_days=7 where id=$1", [tenantId]);
      const other = (await su("insert into tenants(slug,name,pack_id) values('trends-other','合成','travel') returning id"))[0]!.id;
      // 旧前缀正常不落库；仅此一次性测试库放开 CHECK，证明 SQL 与 originOf 三种来源一致。
      await su('alter table conversations drop constraint conversations_id_check');
      const { originOf } = await import('../shared/origin.js');
      const conversations = [
        { id: 'customer-a', seed: false, expected: 'customer' },
        { id: 'customer-b', seed: false, expected: 'customer' },
        { id: 'customer-c', seed: false, expected: 'customer' },
        { id: 'wecom:custX', seed: false, expected: 'customer' },
        { id: 'marked-seed', seed: true, expected: 'seed' },
        { id: 'wecom:cust_seed', seed: false, expected: 'seed' },
        { id: 'sim-visitor', seed: false, expected: 'visitor' },
      ];
      for (const c of conversations) {
        assert.equal(originOf({ sessionId: c.id, seed: c.seed }, 'standard'), c.expected);
        await su(
          `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
          values($1,$2,'wecom','new',false,$3,'2026-10-01','2026-10-01')`,
          [tenantId, c.id, JSON.stringify({ id: c.id, seed: c.seed })],
        );
      }
      await su(
        `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
        values($1,'customer-a','wecom','new',false,'{"id":"customer-a"}','2026-10-01','2026-10-01')`,
        [other],
      );
      let seq = 0;
      async function turn(
        conversationId: string,
        outcome = 'replied',
        duration = 1000,
        author: string | null | false = 'ai',
        llm: unknown[] = [],
        at = '2026-10-29T12:00:00+08',
        tenant: unknown = tenantId,
        wrongConversation = false,
        customerMessage = false,
      ): Promise<void> {
        const id = randomUUID();
        await su(
          `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
          values($1,$2,$3,$4,$5,$6,$7,'{}','[]',$8)`,
          [tenant, id, conversationId, at, duration, outcome, 'a'.repeat(64), JSON.stringify(llm)],
        );
        if (author !== false) {
          await su(
            `insert into messages(tenant_id,conversation_id,seq,role,author,content,at,turn_id)
            values($1,$2,$3,$4,$5,'合成回复',$6,$7)`,
            [
              tenant,
              wrongConversation ? 'customer-a' : conversationId,
              ++seq,
              customerMessage ? 'customer' : 'agent',
              customerMessage ? null : author,
              at,
              id,
            ],
          );
        }
      }
      await turn('customer-a', 'replied', 1000, null, [{ error: 'synthetic' }, { error: 'retry' }, {}]);
      await turn('customer-a', 'replied', 3000);
      // 同一轮分段消息只贡献一个样本。
      await su(
        `insert into messages select tenant_id,conversation_id,999,role,author,author_user_id,author_name,content,at,sent_at,msgid,turn_id,extra
        from messages where tenant_id=$1 and seq=2`,
        [tenantId],
      );
      await turn('customer-a', 'handoff', 1500, false);
      await turn('customer-b', 'error', 900, false, [{ error: 'synthetic' }, { error: 'again' }]);
      await turn('customer-b', 'replied', 9000, false);
      await turn('customer-b', 'deterministic', 0, null);
      await turn('customer-b', 'replied', -1);
      await turn('customer-b', 'replied', 7000, 'human');
      await turn('customer-b', 'replied', 8000, 'followup');
      for (const outcome of ['silent', 'reset', 'budget']) await turn('customer-b', outcome, 10000);
      await turn('customer-b', 'replied', 11000, null, [], undefined, undefined, false, true);
      await turn('customer-b', 'replied', 13000, null, [], undefined, undefined, true);
      await turn('customer-c', 'replied', 5000);
      await turn('wecom:custX', 'replied', 2000);
      for (const c of conversations.filter((c) => c.expected !== 'customer')) await turn(c.id, 'replied', 99000);
      await turn('customer-a', 'replied', 99000, 'ai', [], undefined, other);
      // 边界与迟到：昨天的上一天、今天零点，都不算昨天。
      await turn('customer-c', 'replied', 4000, 'ai', [], '2026-10-28T23:59:59+08');
      await turn('customer-c', 'replied', 6000, 'ai', [], '2026-10-30T00:00:00+08');
      for (const [id, session, status, paid, voided] of [
        ['paid', 'customer-a', 'paid', '2026-10-29T01:00:00+08', null],
        ['refund', 'customer-b', 'refunded', '2026-10-29T02:00:00+08', null],
        ['pending-refund', 'customer-b', 'refund_pending', '2026-10-29T03:00:00+08', null],
        ['void', 'customer-a', 'paid', '2026-10-29T04:00:00+08', '2026-10-29T05:00:00+08'],
        ['quote', 'customer-a', 'pending_payment', null, null],
        ['outside', 'customer-a', 'paid', '2026-10-30T00:00:00+08', null],
        ['ord_seed_test', 'customer-a', 'paid', '2026-10-29T02:00:00+08', null],
        ['marked', 'marked-seed', 'paid', '2026-10-29T02:00:00+08', null],
        ['seed-prefix', 'wecom:cust_seed', 'paid', '2026-10-29T02:00:00+08', null],
        ['visitor', 'sim-visitor', 'paid', '2026-10-29T02:00:00+08', null],
      ]) {
        await su(
          `insert into orders(tenant_id,id,session_id,route_id,status,total_price,created_at,paid_at,voided_at,void_reason,data)
          values($1,$2,$3,'synthetic',$4,100,'2026-10-27',$5,$6,$7,$8)`,
          [tenantId, id, session, status, paid, voided, voided ? 'reset' : null, JSON.stringify({ id, sessionId: session })],
        );
      }
      await su(
        `insert into usage_daily(tenant_id,day,model,purpose,calls,cost_milli_cny) values
        ($1,'2026-10-29','chat','chat',2,123),($1,'2026-10-29','draft','draft',1,7),
        ($1,'2026-10-29','-','reply',100,0),($2,'2026-10-29','chat','chat',1,9999)`,
        [tenantId, other],
      );
      const windows = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map(trends.dayWindow);
      const raw = await withTenant(db, ctx, (tx) => readDailyMetrics(tx, windows));
      const expected: DailyMetricsRow = {
        day: '2026-10-29',
        receptions: 4,
        turns: 16,
        replySamples: 4,
        replyP90Ms: 4400,
        handoffSessions: 1,
        aiErrorTurns: 2,
        costMilli: 130,
        paidOrders: 3,
      };
      assert.deepEqual(raw[2], expected, 'R5 每项分子分母/p90/厘/paid_at/来源/跨租户');
      assert.equal(raw[0]!.turns, 0);
      assert.equal(raw[1]!.turns, 1);
      assert.equal(raw[3]!.turns, 1);
      const coverage = (day: string, patch = {}) => {
        const w = trends.dayWindow(day);
        return { day, firstSeenAt: w.from, lastSeenAt: w.to, hasGap: false, hasDeletion: false, ...patch };
      };
      trends.__trendsTest.use({ coverage: async (_tx, ws) => ws.map((w) => coverage(w.day)) });
      const full = trends.buildPoint(windows[2]!, raw[2]!, coverage(expected.day), now);
      assert.deepEqual(full, {
        day: expected.day,
        coverage: 'complete',
        receptions: 4,
        turns: 16,
        replySamples: 4,
        replyP90Ms: 4400,
        handoffRate: 1 / 4,
        aiErrorRate: 2 / 16,
        costMilli: 130,
        paidOrders: 3,
      });
      const zero = trends.buildPoint(windows[0]!, raw[0]!, coverage('2026-10-27'), now);
      assert.deepEqual(zero, {
        day: '2026-10-27',
        coverage: 'complete',
        receptions: 0,
        turns: 0,
        replySamples: 0,
        replyP90Ms: null,
        handoffRate: null,
        aiErrorRate: null,
        costMilli: 0,
        paidOrders: 0,
      });
      assert.equal(trends.buildPoint(windows[0]!, raw[0]!, undefined, now).coverage, 'unavailable');
      assert.deepEqual(
        trends.buildPoint(
          windows[2]!,
          { ...raw[0]!, day: expected.day, receptions: 1, turns: 1, replySamples: 1, replyP90Ms: 0 },
          undefined,
          now,
        ),
        {
          day: expected.day,
          coverage: 'partial',
          receptions: 1,
          turns: 1,
          replySamples: 1,
          replyP90Ms: 0,
          handoffRate: 0,
          aiErrorRate: 0,
          costMilli: null,
          paidOrders: null,
        },
        '非完整日计数只保留正值，分母存在时比率与 p90 的 0 是事实',
      );
      const observedZero = trends.buildPoint(
        windows[2]!,
        { ...raw[0]!, day: expected.day, receptions: 1, turns: 1, replySamples: 1, replyP90Ms: 0 },
        coverage(expected.day),
        now,
      );
      assert.equal(observedZero.replyP90Ms, 0);
      assert.equal(observedZero.handoffRate, 0);
      assert.equal(observedZero.aiErrorRate, 0);

      assert.equal(trends.buildPoint(windows[3]!, { ...raw[0]!, day: '2026-10-30' }, undefined, now).coverage, 'partial');
      for (const patch of [
        { hasGap: true },
        { hasDeletion: true },
        { firstSeenAt: new Date(windows[2]!.from.getTime() + 120001) },
        { lastSeenAt: new Date(windows[2]!.to.getTime() - 120001) },
      ]) {
        assert.equal(trends.buildPoint(windows[2]!, raw[2]!, coverage(expected.day, patch), now).coverage, 'partial');
        assert.equal(trends.buildPoint(windows[0]!, raw[0]!, coverage('2026-10-27', { hasGap: true }), now).coverage, 'unavailable');
      }
      assert.equal(
        trends.buildPoint(
          windows[2]!,
          raw[2]!,
          coverage(expected.day, {
            firstSeenAt: new Date(windows[2]!.from.getTime() + 120000),
            lastSeenAt: new Date(windows[2]!.to.getTime() - 120000),
          }),
          now,
        ).coverage,
        'complete',
      );
      let aggregations = 0;
      trends.__trendsTest.use({
        aggregate: async (tx, ws) => {
          aggregations++;
          return readDailyMetrics(tx, ws);
        },
      });
      const view = () => trends.readTrendsView(ctx, 30, clock);
      const a = await view();
      assert.equal(a.days, 7);
      assert.equal(a.fromDay, '2026-10-24');
      assert.deepEqual(a.partialReasons, ['retention', 'today']);
      assert.deepEqual(
        a.points.find((p) => p.day === expected.day),
        full,
      );
      assert.deepEqual(await withTenant(db, ctx, (tx) => trends.readDailyPoint(tx, expected.day, clock)), full, '摘要绕过缓存共用日点');
      assert.equal(aggregations, 2);
      await view();
      assert.equal(aggregations, 2);
      clock += 59_999;
      await view();
      assert.equal(aggregations, 2);
      clock++;
      await view();
      assert.equal(aggregations, 3, 'TTL 恰好 60 秒失效');
      trends.invalidateTrends();
      await Promise.all([view(), view(), view()]);
      assert.equal(aggregations, 4, '并发只聚合一次');
      await su('update tenants set retention_trace_days=30 where id=$1', [tenantId]);
      const longer = await view();
      assert.equal(longer.days, 30);
      assert.equal(aggregations, 5);
      await su("update tenants set created_at='2026-10-28T12:00:00+08' where id=$1", [tenantId]);
      const opened = await view();
      assert.equal(opened.days, 3);
      assert.ok(opened.partialReasons.includes('collection_start'));
      clock = new Date(2026, 9, 31, 0).getTime();
      assert.equal((await view()).toDay, '2026-10-31');
      clock = now;
      trends.__trendsTest.reset();
      assert.ok((await view()).partialReasons.includes('unknown_history'));
      trends.__trendsTest.use({
        coverage: async (_tx, ws) =>
          ws.map((w) => coverage(w.day, { hasDeletion: w.day === expected.day, hasGap: w.day === '2026-10-28' })),
      });
      trends.invalidateTrends();
      const missing = await view();
      assert.ok(missing.partialReasons.includes('deletion'));
      assert.ok(missing.partialReasons.includes('unknown_history'));
      assert.equal(missing.points.find((p) => p.day === expected.day)!.coverage, 'partial');
      trends.__trendsTest.use({
        aggregate: async () => {
          throw new Error('synthetic_sql_failure');
        },
      });
      trends.invalidateTrends();
      await assert.rejects(view(), /synthetic_sql_failure/);
      trends.__trendsTest.use({ aggregate: readDailyMetrics });
      assert.equal((await view()).days, 3, '失败不缓存');
      // 已缓存的历史日迟到一轮：缓存期内不动，显式作废后按 started_at 重查。
      const before = (await view()).points.find((p) => p.day === '2026-10-28')!.turns;
      await turn('customer-c', 'replied', 2000, 'ai', [], '2026-10-28T23:59:58+08');
      assert.equal((await view()).points.find((p) => p.day === '2026-10-28')!.turns, before);
      trends.invalidateTrends();
      assert.equal((await view()).points.find((p) => p.day === '2026-10-28')!.turns, before! + 1);
      console.log(`${mode} SQL/COVERAGE/CACHE PASS：R5、窗口、零值、留存、开通、迟到、TTL、跨日、并发、失败`);

      let switched = 0;
      trends.__trendsTest.use({
        aggregate: async (tx, ws) => {
          switched++;
          return readDailyMetrics(tx, ws);
        },
      });
      trends.invalidateTrends();
      for (const days of [7, 30, 7, 30] as const) await trends.readTrendsView(ctx, days, clock);
      assert.equal(switched, 2, '7/30 天各自缓存，切换不重复聚合');
      trends.__trendsTest.use({ aggregate: readDailyMetrics });

      for (const profile of ['demo', 'prod'] as const) {
        __profileTest.use({ DEPLOY_PROFILE: profile });
        for (const role of [undefined, ...roles]) {
          const response = await request(role);
          assert.equal(response.status, !role ? 401 : role === 'owner' || role === 'admin' ? 200 : 403, `${profile} ${role}`);
        }
      }
      assert.equal((await request('owner', '?days=14')).status, 400);
      const response = await request('owner', '?days=30');
      assert.equal(((await response.json()) as MetricsTrendsView).requestedDays, 30);
      const defaultResponse = await request('owner');
      assert.equal(((await defaultResponse.json()) as MetricsTrendsView).requestedDays, 7);
      // 包一层只提供沙箱会话，路由仍经过 server.ts 的全部入口与中间件。
      const { Hono } = await import('hono');
      const { setSandboxSession } = await import('../tenancy/sandbox/session.js');
      const sandbox = createTenantRuntime({ id: randomUUID(), slug: 'trends-sandbox', kind: 'sandbox' });
      sandbox.config.dbInstalled = true;
      const sandboxApp = new Hono()
        .use('*', async (c, next) => {
          setSandboxSession(c, {
            status: 'ok',
            token: 'synthetic',
            runtime: sandbox,
            expiresAt: new Date(now + 60000).toISOString(),
            user: { userId: randomUUID(), tenantId: sandbox.id, role: 'owner', displayName: '合成', csrf: 'synthetic' },
          });
          return next();
        })
        .route('/', app);
      const refused = await sandboxApp.request('/api/console/metrics/trends?days=invalid');
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error, 'observability_unavailable');
      // 旧路径的响应以原 reader/冻结 DTO 比对，且趋势调用前后字节一致。
      const headers = { cookie: tokens.get('owner')! };
      const legacyBefore = await (await app.request('/api/console/metrics', { headers })).text();
      const usageBefore = await (await app.request('/api/console/usage', { headers })).text();
      const legacy = JSON.parse(legacyBefore);
      assert.deepEqual(
        Object.keys(legacy).sort(),
        [
          'days',
          'turns',
          'replyP90Ms',
          'handoffRate',
          'aiErrorRate',
          'costTodayYuan',
          'costRangeYuan',
          'handoffByKind',
          'takeovers',
          'handoffByOrigin',
          'deals',
        ].sort(),
      );
      assert.deepEqual(JSON.parse(usageBefore), {
        status: 'active',
        month: '2026-10',
        replies: { used: 100, quota: null },
        daily: { costMilli: 0, capMilli: null },
        days: [{ day: '2026-10-29', replies: 100, costMilli: 130 }],
      });
      await request('owner');
      assert.equal(await (await app.request('/api/console/metrics', { headers })).text(), legacyBefore);
      assert.equal(await (await app.request('/api/console/usage', { headers })).text(), usageBefore);
      await su("update tenants set status='suspended' where id=$1", [tenantId]);
      await assert.rejects(view(), /tenant_suspended/);
      assert.equal((await request('owner')).status, 401);
      console.log(`${mode} HTTP PASS：完整 server、逐角色、匿名、沙箱、文件模式、参数顺序、停用、旧 metrics/usage`);
    } finally {
      trends.__trendsTest.reset();
      __consoleTest.reset();
      __profileTest.reset();
      await runShutdownHooks();
      await host.store.pgBackend?.close();
      await closeConfig();
      await closeDb();
    }
  }
}
