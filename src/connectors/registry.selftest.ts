// 11 第 4 步：用可推进时钟验证真实队列；HTTP 模拟只验证 JSON-2 的错误边界。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AlertOpts } from '../ops/alert.js';
import type { ErpConnectorRow, ErpItemLink } from '../db/repo/erp.js';
import type { ErpConnector, ErpErrorCode } from './types.js';
import type { KeyRing } from '../channels/secrets.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-registry-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.ALERT_WEBHOOK_URL = '';
process.env.LLM_MOCK = '1';
const { __erpTest: test, erpSources: erp, withErpTurn, erpTurnStats, initErpInScope } = await import('./registry.js');
const r = await import('../tenancy/runtime.js');
const { dropTenantState } = await import('../tenancy/state.js');
const { bindPack } = await import('../core/pack-api.js');
const { packSources } = await import('../core/engine/sources.js');
const { createIndustrialRuntime } = await import('../packs/industrial/runtime.js');
const { runtimeById } = await import('../packs/registry.js');
const { sealConnectorSecrets } = await import('./secrets.js');
const { ErpError } = await import('./types.js');
const { boot } = await import('../boot.js');
const { startOdooMock } = await import('./odoo-mock.js');
const { createOdooConnector } = await import('./odoo.js');
const { createEgress } = await import('../net/egress.js');
const a = r.createTenantRuntime({ id: randomUUID(), slug: 'erp-a', isHost: true });
const b = r.createTenantRuntime({ id: randomUUID(), slug: 'erp-b' });
const sandbox = r.createTenantRuntime({ id: randomUUID(), slug: 'erp-sandbox', kind: 'sandbox' });
for (const rt of [a, b, sandbox]) r.registerRuntime(rt);
r.configureTenancy({ role: 'host', standardCount: 2 });
const inside = <T>(fn: () => T, rt = a) => r.withTenantScope(rt, fn);
for (const rt of [a, b, sandbox]) inside(() => bindPack(createIndustrialRuntime(packSources()), null), rt);
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
class Clock {
  at = Date.parse('2026-10-01T00:00:00+08:00');
  timers = new Set<{ at: number; done(): void }>();
  now = () => this.at;
  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const entry = {
        at: this.at + ms,
        done: () => {
          this.timers.delete(entry);
          signal?.removeEventListener('abort', entry.done);
          resolve();
        },
      };
      this.timers.add(entry);
      signal?.addEventListener('abort', entry.done, { once: true });
    });
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    while (true) {
      const next = [...this.timers].filter((timer) => timer.at <= target).toSorted((x, y) => x.at - y.at)[0];
      if (!next) break;
      this.at = next.at;
      for (const timer of this.timers) if (timer.at <= this.at) timer.done();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
const key = Buffer.alloc(32, 0x31);
const ring: KeyRing = { current: { id: 'synthetic', key }, all: new Map([['synthetic', key]]) };
function row(rt = a): ErpConnectorRow {
  const id = randomUUID();
  const sealed = sealConnectorSecrets(ring, { tenantId: rt.id, connectorId: id }, { apiKey: 'synthetic-key' });
  return {
    id,
    kind: 'odoo',
    status: 'active',
    baseUrl: 'https://erp.example.test',
    database: null,
    settings: { locationId: 10, uom: { 件: 1 }, keyExpiresAt: '2030-01-01' },
    secretsCt: sealed.ct,
    secretsKeyId: sealed.keyId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
function links(connectorId: string, size = 40): ErpItemLink[] {
  return Array.from({ length: size }, (_, i) => ({
    connectorId,
    kind: 'part',
    code: `P${i + 1}`,
    remoteId: i + 1,
    remoteCode: `P${i + 1}`,
    remoteUomId: 1,
    source: 'auto',
    checkedAt: new Date(),
  }));
}
let clock = new Clock();
const alerts: { text: string; opts: AlertOpts }[] = [];
const requests: { ids: readonly number[]; at: number; deadline: number }[] = [];
let delay = 0;
let fault: ErpErrorCode | null = null;
let flight = 0;
let maxFlight = 0;
let stock: ErpConnector['stock'];
function setup() {
  test.reset();
  clock = new Clock();
  alerts.length = requests.length = 0;
  delay = flight = maxFlight = 0;
  fault = null;
  stock = async (ids, deadline) => {
    requests.push({ ids: [...ids], at: clock.at, deadline });
    flight++;
    maxFlight = Math.max(maxFlight, flight);
    try {
      if (delay) await clock.sleep(Math.min(delay, Math.max(0, deadline - clock.at)));
      if (clock.at >= deadline) throw new ErpError('timeout');
      if (fault) throw new ErpError(fault);
      return new Map(ids.map((id) => [id, { freeQty: id + 0.9, uomId: 1, active: true }]));
    } finally {
      flight--;
    }
  };
  test.configure({
    now: clock.now,
    sleep: clock.sleep,
    factory: () => ({
      stock: (...args) => stock(...args),
      products: async () => [],
      check: async () => ({ companyCurrency: 'CNY', locationOk: true }),
    }),
    alert: (text, opts) => alerts.push({ text, opts }),
  });
  inside(() => {
    const input = row();
    test.install(input, links(input.id), ring);
  });
  for (const rt of [a, b]) inside(() => bindPack(createIndustrialRuntime(packSources()), null), rt);
}
let passed = 0;
function pass(name: string) {
  passed++;
  console.log(`ERP registry ✔ ${name}`);
}
try {
  setup();
  await inside(async () => {
    assert.equal(erp.active('part'), true);
    assert.equal(erp.active('route'), false);
    const values = await erp.availability('part', ['P1', 'P1', 'unmapped']);
    assert.deepEqual([...values], [['P1', { onHand: 1, at: clock.at }]]);
    const at = clock.at;
    await clock.advance(30_000);
    assert.equal((await erp.availability('part', ['P1'])).get('P1')!.at, at);
    assert.equal(requests.length, 1);
    await clock.advance(1);
    fault = 'server';
    assert.equal((await erp.availability('part', ['P1'])).get('P1')!.at, at);
    assert.equal(requests.length, 2);
    await clock.advance(29_999);
    assert.ok(erp.fresh('part', 'P1'));
    assert.deepEqual([...(await erp.availability('part', ['P1']))], [['P1', erp.fresh('part', 'P1')]]);
    await clock.advance(1);
    assert.equal(erp.fresh('part', 'P1'), undefined);
    fault = null;
    await clock.advance(1);
    assert.ok((await erp.availability('part', ['P1'])).has('P1'));
    assert.equal(alerts.filter((item) => item.opts.resolved).length, 1);
  });
  assert.equal(clock.timers.size, 0);
  pass('30 秒命中、30 秒+1 重取、60 秒含边界、刷新失败共用 fresh、恢复');

  setup();
  await inside(() =>
    withErpTurn(async () => {
      delay = 700;
      const pending = erp.availability('part', ['P1']);
      await clock.advance(700);
      assert.equal((await pending).size, 1);
      const before = clock.at;
      assert.equal((await erp.availability('part', ['P2'])).size, 0);
      assert.equal(clock.at, before);
      assert.equal(requests.length, 1);
      assert.deepEqual(erpTurnStats(), { ms: 700, cacheHit: false, deadlineReached: false });
    }),
  );
  pass('慢而成功后，同轮第二次需要请求立即退回，总 ERP 等待 700ms');

  setup();
  await inside(async () => {
    stock = async () => new Map([[1, { freeQty: 7, active: true, uomId: 1 }]]);
    await erp.availability('part', ['P1']);
    await clock.advance(29_000);
    await withErpTurn(async () => {
      assert.equal((await erp.availability('part', ['P1'])).get('P1')?.onHand, 7);
      stock = async (ids) => new Map(ids.map((id) => [id, { freeQty: 0, active: true, uomId: 1 }]));
      await clock.advance(2000);
      assert.equal((await erp.availability('part', ['P1'])).get('P1')?.onHand, 7, '缓存过了 30 秒，本轮仍用已读到的值');
      await clock.advance(60_000);
      assert.equal(erp.fresh('part', 'P1')?.onHand, 7, '跨过 60 秒也不换');
      assert.equal((await erp.availability('part', ['P2'])).size, 1, '本轮没读过的编号照常取');
    });
    assert.equal(erp.fresh('part', 'P1'), undefined);
    await clock.advance(1000);
    assert.equal((await erp.availability('part', ['P1'])).get('P1')?.onHand, 0, '下一轮才换');
  });
  await inside(async () => {
    setup();
    stock = async () => {
      throw new ErpError('server');
    };
    await withErpTurn(async () => {
      assert.equal((await erp.availability('part', ['P1'])).size, 0);
      stock = async () => new Map([[1, { freeQty: 7, active: true, uomId: 1 }]]);
      await clock.advance(31_000);
      assert.equal((await erp.availability('part', ['P1'])).size, 0, '本轮没取到的也不换');
      assert.equal(erp.fresh('part', 'P1'), undefined);
    });
  });
  pass('同一轮看到同一份：读到的值与没取到都固定到本轮结束，下一轮才换');

  setup();
  await inside(() =>
    withErpTurn(async () => {
      delay = Infinity;
      const pending = erp.availability('part', ['P1']);
      await clock.advance(999);
      let finished = false;
      void pending.then(() => {
        finished = true;
      });
      await flush();
      assert.equal(finished, false);
      await clock.advance(1);
      assert.equal((await pending).size, 0);
      assert.equal(erpTurnStats()!.deadlineReached, true);
      assert.equal(erpTurnStats()!.ms, 1000);
      assert.equal((await erp.availability('part', ['P2'])).size, 0);
      assert.equal(requests.length, 1);
    }),
  );
  assert.equal(clock.timers.size, 0);
  pass('挂起请求与同轮后续等待共用 1 秒截止时间');

  setup();
  await inside(async () => {
    delay = 1500;
    const short = withErpTurn(() => erp.availability('part', ['P1']));
    const long = erp.availability('part', ['P2']);
    await clock.advance(1000);
    assert.equal((await short).size, 0);
    assert.equal(flight, 1);
    await clock.advance(500);
    assert.equal((await long).size, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].deadline - requests[0].at, 5000);
  });
  pass('同批取最晚截止时间，短等待者到点返回不影响长等待者');

  setup();
  await inside(() =>
    withErpTurn(async () => {
      delay = 700;
      const pending = Promise.all([erp.availability('part', ['P1']), erp.availability('part', ['P2'])]);
      await clock.advance(700);
      await pending;
      assert.equal(erpTurnStats()!.ms, 700);
      await erp.availability('part', ['P1']);
      assert.equal(requests.length, 1);
    }),
  );
  pass('同轮并行等待只计一次 ERP 耗时，缓存不重取');

  setup();
  await inside(async () => {
    fault = 'auth';
    await erp.availability('part', ['P1']);
    await clock.advance(600_000);
    await erp.availability('part', ['P1']);
    assert.equal(alerts.length, 1);
    fault = 'forbidden';
    await clock.advance(600_000);
    await erp.availability('part', ['P1']);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].opts.escalate, true);
    fault = null;
    await clock.advance(600_000);
    await erp.availability('part', ['P1']);
    assert.equal(alerts.length, 3);
    assert.equal(alerts[2].opts.resolved, true);
    await erp.availability('part', ['P1']);
    assert.equal(alerts.length, 3);
  });
  pass('失败状态机：相同错误不重推、换码立即推、恢复只推一次');

  setup();
  await inside(async () => {
    delay = 1500;
    const long = erp.availability('part', ['P1']); // 作用域外 5 秒
    await clock.advance(100);
    const short = withErpTurn(async () => {
      const pending = erp.availability('part', ['P2']);
      await clock.advance(1000);
      assert.equal((await pending).size, 0);
      assert.equal(erpTurnStats()!.ms, 1000);
    });
    await short;
    assert.equal(flight, 1);
    assert.equal(requests.length, 1);
    await clock.advance(400);
    assert.equal((await long).size, 1);
    assert.equal(requests.length, 1); // 已截止的 P2 不再发
  });
  pass('排队等待计入本轮 1 秒，等待者独立到期，在途请求继续');

  setup();
  await inside(async () => {
    delay = 1500;
    const first = erp.availability('part', ['P1']);
    await flush();
    const second = erp.availability(
      'part',
      Array.from({ length: 39 }, (_, i) => `P${i + 2}`),
    );
    const third = erp.availability('part', ['P2', 'P3']);
    await clock.advance(4500);
    assert.equal((await first).size, 1);
    assert.equal((await second).size, 39);
    assert.equal((await third).size, 2);
    assert.deepEqual(
      requests.map((request) => request.ids.length),
      [1, 30, 9],
    );
    assert.equal(maxFlight, 1);
    for (let i = 1; i < requests.length; i++) assert.ok(requests[i].at - requests[i - 1].at >= 1000);
  });
  assert.equal(clock.timers.size, 0);
  pass('排队合并去重、每批 ≤30、溢出留下一批、最大在途 1');

  setup();
  await inside(async () => {
    await erp.availability('part', ['P1']);
    let done = false;
    const pending = erp.availability('part', ['P2']).then(() => {
      done = true;
    });
    await clock.advance(999);
    assert.equal(done, false);
    await clock.advance(1);
    await pending;
    assert.equal(requests[1].at - requests[0].at, 1000);
  });
  pass('快速请求仍按发起时间每秒一次');

  setup();
  await inside(async () => {
    stock = async (ids) =>
      new Map(ids.filter((id) => id !== 2).map((id) => [id, { freeQty: id, active: id !== 3, uomId: id === 4 ? 2 : 1 }]));
    const result = await erp.availability('part', ['P1', 'P2', 'P3', 'P4']);
    assert.deepEqual([...result.keys()], ['P1']);
    stock = async () => {
      throw new Error('不应请求');
    };
    await clock.advance(60_000);
    assert.equal((await erp.availability('part', ['P2', 'P3', 'P4'])).size, 0);
    stock = async (ids) => {
      requests.push({ ids, at: clock.at, deadline: clock.at });
      return new Map();
    };
    await clock.advance(1);
    await erp.availability('part', ['P2']);
    assert.equal(requests.length, 1);
    assert.ok(alerts[0].text.includes('unmapped'));
    // 单个产品读不到不算连接器故障：接着一批全部读到时不发「已恢复」。
    stock = async (ids) => new Map(ids.map((id) => [id, { freeQty: id, active: true, uomId: 1 }]));
    await clock.advance(1000);
    assert.equal((await erp.availability('part', ['P1'])).get('P1')?.onHand, 1);
    assert.ok(alerts.every((sent) => !sent.text.includes('已恢复')));
  });
  pass('已删、归档、单位变化逐条无值 60 秒，其他编号仍成功，不进连接器健康状态');

  setup();
  inside(() => {
    const input = row(b);
    test.install(input, links(input.id), ring);
  }, b);
  await inside(() => erp.availability('part', ['P1']));
  inside(() => assert.equal(erp.fresh('part', 'P1'), undefined), b);
  await inside(() => erp.availability('part', ['P2']), b);
  inside(() => assert.equal(erp.fresh('part', 'P2'), undefined));
  dropTenantState(a.id);
  inside(() => assert.equal(erp.active('part'), false));
  inside(() => assert.ok(erp.fresh('part', 'P2')), b);
  assert.throws(() => erp.active('part'), r.TenantScopeMissing);
  pass('严格模式两个租户缓存独立，删除一个不影响另一个');

  setup();
  await inside(async () => {
    test.install(null, [], ring);
    assert.equal(erp.active('part'), false);
    assert.equal((await erp.availability('part', ['P1'])).size, 0);
    await initErpInScope(null);
    assert.equal(erp.active('part'), false);
    const input = row();
    test.install({ ...input, status: 'disabled' }, [], ring);
    assert.equal(erp.active('part'), false);
    test.install(input, links(input.id), ring);
    bindPack(runtimeById('travel', packSources())!, null);
    assert.equal(erp.active('part'), false);
    bindPack(createIndustrialRuntime(packSources()), null);
  });
  inside(() => {
    const input = row(sandbox);
    test.install(input, links(input.id), ring);
    assert.equal(erp.active('part'), false);
  }, sandbox);
  pass('文件、沙箱、未配置、停用、包未声明 ERP 都不启用');

  setup();
  await inside(async () => {
    const input = row();
    const order: string[] = [];
    for (const broken of [
      { ...input, secretsCt: Buffer.alloc(30) },
      { ...input, baseUrl: 'https://127.0.0.1' },
    ]) {
      await boot({
        initConfig: async () => {},
        initSessionStore: async () => {},
        initChannels: async () => {
          order.push('channels');
        },
        initErp: async () => {
          test.install(broken, [], ring);
          order.push('erp');
        },
        serve: () => {
          order.push('serve');
        },
        preflight() {},
        buildIndex: async () => {},
        storeMode: () => 'file',
        startFollowUpScheduler() {},
        startJobs() {},
        startChannels() {},
        exit() {
          assert.fail('不能拒绝启动');
        },
      });
      assert.equal(erp.active('part'), false);
    }
    assert.deepEqual(order, ['channels', 'erp', 'serve', 'channels', 'erp', 'serve']);
    assert.equal(alerts.length, 2);
    assert.ok(alerts[0].text.includes('auth'));
    assert.ok(alerts[1].text.includes('egress'));
    const output = JSON.stringify(alerts);
    for (const secret of ['127.0.0.1', 'erp.example.test', 'synthetic-key', input.secretsCt.toString('hex')])
      assert.ok(!output.includes(secret));
  });
  pass('解密失败/IP 字面量按停用、启动继续、各告警一次且脱敏，装载顺序');

  setup();
  inside(() => {
    const input = row();
    input.settings.keyExpiresAt = '2026-10-15';
    test.install(input, [], ring);
    test.checkExpiries();
    assert.equal(alerts.length, 1);
    clock.at = Date.parse('2026-10-11T23:59:59+08:00');
    test.checkExpiries();
    assert.equal(alerts.length, 1);
    clock.at += 1000;
    test.checkExpiries();
    assert.equal(alerts.length, 2);
    test.checkExpiries();
    assert.equal(alerts.length, 2);
    assert.ok(alerts[0].text.includes('key_expiry_14'));
    assert.ok(alerts[1].text.includes('key_expiry_3'));
  });
  pass('上海日历日 14/3 天到期告警、启动立即检查与进程内去重');

  setup();
  await inside(async () => {
    const { handleMessage } = await import('../core/engine/index.js');
    const runtime = createIndustrialRuntime(packSources());
    const prefetch = runtime.prefetch;
    let scoped = false;
    runtime.prefetch = async (ctx) => {
      scoped = erpTurnStats() !== undefined;
      await erp.availability('part', ['P1']);
      return (await prefetch?.(ctx)) ?? null;
    };
    bindPack(runtime, null);
    await handleMessage('erp-turn', '你好', 'web');
    assert.equal(scoped, true);
    assert.equal(erpTurnStats(), undefined);
    const travel = runtimeById('travel', packSources())!;
    const travelPrefetch = travel.prefetch;
    travel.prefetch = async (ctx) => {
      assert.equal(erpTurnStats(), undefined);
      return (await travelPrefetch?.(ctx)) ?? null;
    };
    bindPack(travel, null);
    await handleMessage('erp-travel', '你好', 'web');
  });
  pass('真实引擎预取进入 ERP 作用域，轮末退出，旅游预取不进入');

  const { openTestDb, createRealPgFixture } = await import('../db/testing.js');
  const { openDb, withTenant } = await import('../db/client.js');
  const { insertErpConnector, upsertErpItemLink, updateErpConnector } = await import('../db/repo/erp.js');
  type Query = <T>(text: string, values: unknown[]) => Promise<T[]>;
  async function databaseSuite(db: import('../db/client.js').Db, query: Query) {
    setup();
    for (const rt of [a, b]) {
      await query("insert into tenants(id,slug,name,pack_id) values ($1,$2,$2,'industrial')", [rt.id, rt.slug]);
      const input = row(rt);
      const context = { tenantId: rt.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
      await withTenant(db, context, async (tx) => {
        await insertErpConnector(tx, input);
        await upsertErpItemLink(tx, links(input.id)[0]);
      });
      await inside(() => initErpInScope({ db, keyRing: ring }), rt);
      inside(() => assert.equal(erp.active('part'), true), rt);
      await inside(() => erp.availability('part', ['P1']), rt);
      if (rt === a) inside(() => assert.equal(erp.fresh('part', 'P1'), undefined), b);
      // 命令行改设置必须重启生效；当前请求只读启动快照。
      await withTenant(db, context, (tx) => updateErpConnector(tx, input.id, { status: 'disabled' }));
      inside(() => assert.ok(erp.active('part')), rt);
      await inside(() => initErpInScope({ db, keyRing: ring }), rt);
      inside(() => assert.equal(erp.active('part'), false), rt);
    }
  }
  const db = await openTestDb();
  try {
    await databaseSuite(db.db, async <T>(sql: string, values: unknown[]) => {
      await db.pg.exec('RESET ROLE');
      try {
        return (await db.pg.query<T>(sql, values)).rows;
      } finally {
        await db.pg.exec('SET ROLE agent_app');
      }
    });
  } finally {
    await db.close();
  }
  pass('PGlite：按租户读取全部映射、解密装载、只读启动快照、重载识别停用');
  if (process.env.PG_TEST_URL) {
    const fixture = await createRealPgFixture(process.env.PG_TEST_URL);
    const app = await openDb(fixture.urls.app);
    try {
      await databaseSuite(app.db, fixture.query);
    } finally {
      await app.close();
      await fixture.drop();
    }
    pass('真实 PG：agent_app / FORCE RLS 下两租户装载和映射互不串');
  } else console.log('未设 PG_TEST_URL：真实 PG 装载由 CI 重跑');

  const mock = await startOdooMock({ version: 20 });
  try {
    for (const [status, html, code, cooldown, text] of [
      [401, false, 'auth', 600_000, 'API key 无效或已到期，请 set-secrets'],
      [403, false, 'forbidden', 600_000, '机器人用户缺少读产品或库存的权限'],
      [404, false, 'not_found', 600_000, '连接器配置与 Odoo 不符'],
      [400, false, 'invalid', 600_000, '连接器配置与 Odoo 不符'],
      [422, false, 'invalid', 600_000, '连接器配置与 Odoo 不符'],
      [500, false, 'server', 30_000, 'ERP 库存暂不可用'],
      [502, true, 'server', 30_000, 'ERP 库存暂不可用'],
    ] as const) {
      setup();
      const send = createEgress(mock.url, {
        allowLoopback: true,
        resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] },
      });
      test.configure({
        factory: (opts) => createOdooConnector({ ...opts, send: (request) => send({ ...request, deadline: Date.now() + 5000 }) }),
      });
      inside(() => {
        const input = row();
        test.install(input, links(input.id), ring);
      });
      await inside(async () => {
        mock.enqueue({ status, html });
        const start = mock.requests.length;
        await erp.availability('part', ['P1']);
        assert.equal(mock.requests.length, start + 1);
        assert.ok(alerts[0].text.includes(code) && alerts[0].text.includes(text));
        await clock.advance(cooldown - 1);
        await erp.availability('part', ['P1']);
        assert.equal(mock.requests.length, start + 1);
        await clock.advance(1);
        await erp.availability('part', ['P1', 'P5']); // P5 在模拟 Odoo 中已删
        assert.equal(mock.requests.length, start + 2);
        assert.ok(erp.fresh('part', 'P1'));
        assert.equal(erp.fresh('part', 'P5'), undefined);
        await clock.advance(1000);
        await erp.availability('part', ['P2']);
        assert.equal(alerts.filter((item) => item.opts.resolved).length, 1);
      });
    }
    assert.equal(mock.maxInFlight, 1);
  } finally {
    await mock.close();
  }
  pass('模拟 Odoo 401/403/404/400/422/500/HTML502：归类、冷却、告警文字、恢复、已删产品、在途≤1');
  console.log(`ERP REGISTRY SELFTEST PASS: ${passed} 组契约`);
} finally {
  test.reset();
  for (const rt of [a, b, sandbox]) r.unregisterRuntime(rt.id);
  fs.rmSync(dir, { recursive: true, force: true });
}
