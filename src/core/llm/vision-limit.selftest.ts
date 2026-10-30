import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { z } from 'zod';
import { openDb, withTenant, type Db } from '../../db/client.js';
import { createRealPgFixture, fakeLock, openTestDb, testConfigDeps } from '../../db/testing.js';
import { importConfig } from '../../config/transfer.js';
import { initConfig } from '../../config/source.js';
import { createTenantRuntime, withTenantScope } from '../../tenancy/runtime.js';
import { dropTenantState, tenantKeys } from '../../tenancy/state.js';
import { todayIso } from '../../env.js';
import { addUsage } from '../../db/repo/usage.js';
import { insertTurnTraces } from '../../db/repo/traces.js';
import { startUsageDaily, flushUsageDaily } from '../../trace/usage-daily.js';
import { withTurnScope, startTurn, endTurn, onTurnEnd, type FinishedTurn } from '../../trace/recorder.js';
import { vision } from './vision.js';

process.env.LLM_MOCK = '1';
process.env.LLM_VISION_MODEL = '';
process.env.VISION_DAILY_PER_TENANT = '200';
let network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  network++;
  throw new Error('禁止网络请求');
};
type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
const req = (sessionId = 'same') => ({
  sessionId,
  signal: new AbortController().signal,
  bytes: Uint8Array.of(1),
  mime: 'image/png' as const,
  prompt: '合成样本',
  schema: z.object({ qty: z.number() }),
  maxOutputTokens: 20,
  mock: { qty: 1 },
});
const limit = { ok: false, reason: 'limit' };

async function suite(db: Db, q: Query, label: string) {
  const runtimes: ReturnType<typeof createTenantRuntime>[] = [];
  const setup = async (suffix: string) => {
    const slug = `vision-${suffix}`;
    const [{ id }] = await q<{ id: string }>("insert into tenants (slug,name,pack_id) values ($1,$1,'travel') returning id", [slug]);
    const rt = createTenantRuntime({ id, slug });
    runtimes.push(rt);
    const deps = testConfigDeps({ db }, { tenantSlug: slug });
    await withTenantScope(rt, async () => {
      const imported = await importConfig({ db, tenantSlug: slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() });
      assert.equal(imported.code, 0);
      await initConfig(deps);
    });
    return { rt, deps };
  };
  const seedUsage = async (id: string, calls: number, day = todayIso(), purpose = 'vision') => {
    await q('insert into usage_daily (tenant_id,day,model,purpose,calls) values ($1,$2,$3,$4,$5)', [
      id,
      day,
      'glm-5.3-flashx',
      purpose,
      calls,
    ]);
  };
  const seedTrace = async (id: string, sessionId: string, entries: unknown[], at = new Date()) => {
    await q(
      "insert into conversations (tenant_id,id,channel,stage,handed_over,state,created_at,updated_at) values ($1,$2,'wecom','greeting',false,json_build_object('id',$2::text),now(),now()) on conflict do nothing",
      [id, sessionId],
    );
    await q(
      "insert into turn_traces (tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm) values ($1,$2,$3,$4,0,'deterministic',repeat('a',64),'{}','[]',$5::json)",
      [id, randomUUID(), sessionId, at, JSON.stringify(entries)],
    );
  };
  try {
    const tenant = await setup('tenant');
    await seedUsage(tenant.rt.id, 200);
    assert.deepEqual(await withTenantScope(tenant.rt, () => vision(req())), limit, '租户超限');
    console.log(`${label}: tenant daily limit / no network PASS`);

    const session = await setup('session');
    // 不按模型名或轮次数猜：同一模型的 chat 不算，单轮的两个 vision 都算。
    await seedTrace(
      session.rt.id,
      'same',
      Array.from({ length: 18 }, () => ({ purpose: 'vision' })),
    );
    await seedTrace(session.rt.id, 'same', [
      { purpose: 'vision' },
      { purpose: 'vision' },
      { model: 'glm-5.3-flashx' },
      { purpose: 'chat' },
    ]);
    await seedUsage(session.rt.id, 1000, todayIso(), 'chat');
    assert.deepEqual(await withTenantScope(session.rt, () => vision(req())), limit, '会话 20 次上限');
    assert.equal((await withTenantScope(session.rt, () => vision(req('other')))).ok, true, '同租户另一会话仍能调用');
    console.log(`${label}: session daily limit / count vision entries / tenant and session isolation PASS`);

    const concurrent = await setup('concurrent');
    process.env.VISION_DAILY_PER_TENANT = '3';
    await seedUsage(concurrent.rt.id, 1);
    let release!: () => void;
    let entered = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = Array.from({ length: 3 }, (_, i) =>
      withTenantScope(concurrent.rt, () =>
        vision({
          ...req(`c${i}`),
          mock: async () => {
            entered++;
            await held;
            return { qty: 1 };
          },
        }),
      ),
    );
    try {
      assert.deepEqual(await Promise.race(started), limit, '并发读取同一个基数后，第三个立即拒绝');
      assert.equal(entered, 2, '含已在途请求也只能预占两次');
    } finally {
      release();
    }
    const results = await Promise.all(started);
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.deepEqual(await withTenantScope(concurrent.rt, () => vision(req('later'))), limit);
    assert.ok(tenantKeys(concurrent.rt.id)['vision.daily'] > 0, '内存预占已登记');
    console.log(`${label}: concurrent tenant reservations do not exceed limit PASS`);

    process.env.VISION_DAILY_PER_TENANT = '200';
    const raceSession = await setup('race-session');
    await seedTrace(
      raceSession.rt.id,
      'same',
      Array.from({ length: 19 }, () => ({ purpose: 'vision' })),
    );
    const sessionRace = await Promise.all(Array.from({ length: 3 }, () => withTenantScope(raceSession.rt, () => vision(req()))));
    assert.equal(sessionRace.filter((r) => r.ok).length, 1);
    assert.equal(sessionRace.filter((r) => !r.ok && r.reason === 'limit').length, 2);
    console.log(`${label}: concurrent session reservations do not exceed 20 PASS`);

    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(12, 0, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: nextDay });
    try {
      assert.equal((await withTenantScope(tenant.rt, () => vision(req()))).ok, true, '租户跨日重置');
      assert.equal((await withTenantScope(session.rt, () => vision(req()))).ok, true, '会话跨日重置');
    } finally {
      mock.timers.reset();
    }
    console.log(`${label}: local calendar day reset / previous day excluded PASS`);

    // 使用真正的 usage 累加器和 trace 序列化写回，再清空运行时状态模拟重启。
    const persistent = await setup('persistent');
    await seedUsage(persistent.rt.id, 18);
    await seedTrace(
      persistent.rt.id,
      'same',
      Array.from({ length: 18 }, () => ({ purpose: 'vision' })),
    );
    let finished: FinishedTurn | undefined;
    const off = onTurnEnd(
      (turn) => {
        finished = turn;
      },
      { owner: persistent.rt },
    );
    await withTenantScope(persistent.rt, async () => {
      await startUsageDaily((deltas) => withTenant(db, ctx(persistent.rt.id), (tx) => addUsage(tx, deltas)), 60_000);
      await withTurnScope(async () => {
        startTurn('same');
        assert.equal((await vision(req())).ok, true);
        // JSON/schema 失败仍耗费一次识别名额，写入 vision trace。
        assert.deepEqual(await vision({ ...req(), mock: '{bad' }), { ok: false, reason: 'failed' });
        endTurn('deterministic', '完成', 'greeting', 'greeting');
      });
      assert.deepEqual(
        finished!.turn.llm.map((c) => c.purpose),
        ['vision', 'vision'],
      );
      assert.equal(finished!.turn.llm[1]?.error, 'bad_response');
      await flushUsageDaily();
      await withTenant(db, ctx(persistent.rt.id), (tx) =>
        insertTurnTraces(tx, [
          {
            id: finished!.turn.turnId,
            conversationId: 'same',
            startedAt: new Date(finished!.turn.startedAt),
            durationMs: 0,
            outcome: 'deterministic',
            sopVersion: null,
            prefixHash: 'a'.repeat(64),
            catalogVersions: {},
            stageBefore: null,
            stageAfter: null,
            draft: null,
            finalText: null,
            calls: [],
            llm: finished!.turn.llm,
            signals: null,
          },
        ]),
      );
      assert.deepEqual(await vision(req()), limit, '刷写后也不重复计数或释放名额');
      assert.equal((await vision(req('other'))).ok, true, '20 次没误算成 40 次');
      await flushUsageDaily();
    });
    off();
    const [{ calls }] = await q<{ calls: number }>('select sum(calls)::int as calls from usage_daily where tenant_id=$1 and purpose=$2', [
      persistent.rt.id,
      'vision',
    ]);
    assert.equal(calls, 21, '每次调用只记一笔 vision');
    dropTenantState(persistent.rt.id);
    assert.equal(tenantKeys(persistent.rt.id)['vision.daily'], 0, 'drop 清掉限额状态');
    await withTenantScope(persistent.rt, () => initConfig(persistent.deps));
    assert.deepEqual(await withTenantScope(persistent.rt, () => vision(req())), limit, '重启从 trace 恢复会话次数');
    process.env.VISION_DAILY_PER_TENANT = '21';
    assert.deepEqual(await withTenantScope(persistent.rt, () => vision(req('new'))), limit, '重启从 usage_daily 恢复租户次数');
    console.log(`${label}: persisted trace and usage / restart recovery / no double count / state cleanup PASS`);
    assert.equal(network, 0, 'mock 与限额拒绝都不联网');
  } finally {
    process.env.VISION_DAILY_PER_TENANT = '200';
    mock.timers.reset();
    for (const rt of runtimes) dropTenantState(rt.id);
  }
}
try {
  const lite = await openTestDb();
  try {
    await lite.pg.exec('SET ROLE agent_app');
    await suite(
      lite.db,
      async <T>(text: string, params: unknown[] = []) =>
        lite.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<T>(text, params)).rows;
        }),
      'PGlite',
    );
  } finally {
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await createRealPgFixture(process.env.PG_TEST_URL);
    const conn = await openDb(pg.urls.app);
    try {
      await suite(conn.db, pg.query, 'PG');
    } finally {
      await conn.close();
      await pg.drop();
    }
  } else console.log('SKIP: 真实 PG 需要 PG_TEST_URL');
} finally {
  globalThis.fetch = originalFetch;
}
