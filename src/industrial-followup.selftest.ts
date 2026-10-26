// 10 第7/9/11步：真实生成、护栏、文件扫描和数据库任务，只桩模型与发送边界。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session, LineOrder, ChatOptions } from './core/pack-api.js';
import type { SessionWithFollowup } from './followup.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-followup-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  SOP_PATH: path.join(dir, 'sop.md'),
  CONFIG_SOURCE: 'file',
  FOLLOWUP_ENABLED: '1',
  LLM_MOCK: '0',
  LLM_PROVIDER: '',
  LLM_BASE_URL: 'https://model.example.test/v1',
  LLM_API_KEY: randomBytes(24).toString('hex'),
  LLM_MODEL: 'glm-5.3-flashx',
  LLM_MODEL_CHEAP: '',
  LLM_HEDGE_MODEL: '',
  LLM_MAX_RETRY: '0',
  SERVER_SELFTEST: '1',
  PUBLIC_BASE_URL: 'https://shop.example.test',
  NOTIFY_WEBHOOK_URL: '',
});
let completion = '';
let generated = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  generated++;
  return new Response(
    JSON.stringify({ choices: [{ message: { content: completion } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    { headers: { 'content-type': 'application/json' } },
  );
};
const tenancy = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = tenancy.hostRuntime();
enterTenantScopeForTest(rt);
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack, createLineOrder } = await import('./core/pack-api.js');
const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
const { defaultIndustrialPolicy } = await import('./packs/industrial/policy.js');
const { industrial } = await import('./packs/industrial/console-pack.js');
const { writeState } = await import('./packs/industrial/state.js');
const { handleMessage } = await import('./engine.js');
const followup = await import('./followup.js');
const quota = await import('./quota/ledger.js');
const realNow = Date.now;
let now = Date.parse('2026-10-26T04:00:00Z');
Date.now = () => now;
const part = {
  id: 'part-a',
  partNo: '6205-2RS',
  name: '合成轴承',
  brand: '合成品牌',
  category: '轴承',
  specs: ['内径25mm'],
  unit: '件',
  unitPrice: 10,
  moq: 1,
  stock: 100,
  leadDays: 7,
};
for (const file of ['sop.md', 'brand.json', 'pack.json']) fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
fs.mkdirSync(path.join(dir, 'catalog'));
fs.writeFileSync(path.join(dir, 'catalog/part.json'), JSON.stringify([part]));
fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...defaultIndustrialPolicy, autoApproveMaxFen: 100000 }));
const runtime = createIndustrialRuntime(config.packSources());
bindPack(runtime, runtime.defaultBrand);
const pushes: { id: string; text: string }[] = [];
const push = async (id: string, text: string) => {
  pushes.push({ id, text });
  return true;
};
let sequence = 0;
function silent(stage: Session['stage'] = 'quote', hours = 25): SessionWithFollowup {
  const s = store.getOrCreateSession(`wecom:wmIF${++sequence}`, 'wecom') as SessionWithFollowup;
  const at = now - hours * 3600000;
  s.stage = stage;
  s.createdAt = at - 60000;
  s.updatedAt = at;
  s.messages = [
    { role: 'customer', content: '6205-2RS 2件', at: at - 60000 },
    { role: 'agent', content: '需要正式报价单吗？', at },
  ];
  return s;
}
async function approved(s: Session): Promise<LineOrder> {
  const present = now;
  now = s.updatedAt;
  try {
    writeState(
      s,
      {
        rfqDraft: {
          at: now - 60000,
          lines: [{ code: part.id, version: config.currentCatalog().versions['part:part-a'] ?? 1, qty: 2, match: 'exact' }],
        },
      },
      [part],
    );
    const result = await createLineOrder(s, [{ kind: 'part', code: part.id, qty: 2 }]);
    assert.ok('order' in result);
    assert.equal(result.order.approval!.state, 'approved');
    await store.flushSession(s.id);
    return result.order;
  } finally {
    now = present;
  }
}
const ledgerSnapshot = (s: SessionWithFollowup) => ({
  meta: structuredClone(s.followup ?? {}),
  messages: structuredClone(s.messages),
  window: quota.sendWindow(s.id, now),
});
let testDb: Awaited<ReturnType<(typeof import('./db/testing.js'))['openTestDb']>> | undefined;
try {
  // 默认工业离线策略经真实引擎与工具运行，金额只能来自工具。
  process.env.LLM_MOCK = '1';
  const quoted = await handleMessage('web:imock', '6205-2RS 2件', 'web');
  assert.match(quoted.text, /金额20.00元/);
  assert.match(quoted.text, /合计20.00元/);
  now += 1000;
  const formal = await handleMessage('web:imock', '要正式报价单', 'web');
  assert.match(formal.text, /quote\/ord_/);
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(defaultIndustrialPolicy));
  await handleMessage('web:imock2', '6205-2RS 2件', 'web');
  now += 1000;
  assert.match((await handleMessage('web:imock2', '要正式报价单', 'web')).text, /顾问审核/);
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...defaultIndustrialPolicy, autoApproveMaxFen: 100000 }));
  process.env.LLM_MOCK = '0';
  // 同租户有效链接完整通过；非法 URL 与指针句从真实 followUpText 链路删除。
  const valid = silent('closing');
  const order = await approved(valid);
  const url = `https://shop.example.test/quote/${order.id}`;
  completion = `报价单：${url}`;
  assert.equal(await followup.followUpText(valid), completion);
  const invalid = [
    `https://other.example.test/quote/${order.id}`,
    `https://shop.example.test/quote/%6frd_${order.id.slice(4)}`,
    `https://shop.example.test/x/../quote/${order.id}`,
    'https://shop.example.test/unregistered',
  ];
  for (const link of invalid) {
    completion = `报价单：${link}`;
    assert.equal(await followup.followUpText(valid), '', link);
  }
  const stranger = silent();
  completion = `报价单：${url}`;
  assert.equal(await followup.followUpText(stranger), '');
  const foreign = tenancy.createTenantRuntime({
    id: 'industrial-foreign',
    slug: 'industrial-foreign',
    publicBase: 'https://shop.example.test',
  });
  tenancy.registerRuntime(foreign);
  try {
    await tenancy.withTenantScope(foreign, async () => {
      bindPack(createIndustrialRuntime(config.packSources()), runtime.defaultBrand);
      assert.equal(await followup.followUpText(valid), '');
    });
  } finally {
    tenancy.unregisterRuntime(foreign.id);
  }
  for (const state of ['pending', 'withdrawn', 'rejected'] as const) {
    order.approval!.state = state;
    assert.equal(await followup.followUpText(valid), '');
  }
  order.approval!.state = 'approved';
  order.approval!.decidedAt = now - 9 * 86400000;
  assert.equal(await followup.followUpText(valid), '');
  order.approval!.decidedAt = now;
  completion = '点击https://bad.example.test/quote/ord_fake';
  const empty = silent();
  store.saveSession(empty, false);
  const before = ledgerSnapshot(empty),
    p0 = pushes.length;
  assert.equal(await followup.runFollowUpScan(push), 0);
  assert.equal(pushes.length, p0);
  assert.deepEqual(ledgerSnapshot(empty), before);
  completion = `报价单：${url}`;
  store.saveSession(valid, false);
  assert.equal(await followup.runFollowUpScan(push), 1);
  assert.deepEqual(pushes.at(-1), { id: valid.id, text: completion });
  assert.equal(valid.followup!.count, 1);
  assert.deepEqual(valid.followup!.stages, ['closing']);
  assert.equal(valid.messages.at(-1)!.author, 'followup');
  // 文件路径的无输出模板仍过护栏；两个24小时阶段与窗口余量。
  empty.followupOptOut = { at: now, quote: '测试停发' };
  stranger.followupOptOut = { at: now, quote: '测试停发' };
  store.saveSession(empty, false);
  for (const stage of ['quote', 'closing'] as const) {
    const s = silent(stage, 23.99);
    assert.equal(followup.shouldFollowUp(s, now), false);
    s.updatedAt -= 60000;
    assert.equal(followup.shouldFollowUp(s, now), true);
    store.saveSession(s, false);
    completion = '';
    assert.equal(await followup.runFollowUpScan(push), 1);
    assert.equal(pushes.at(-1)!.text, runtime.followupTemplates.byStage[stage]);
  }
  const nearlyClosed = silent('quote', 47);
  store.saveSession(nearlyClosed, false);
  assert.equal(quota.followupWindowAllows(nearlyClosed.id, now), false);
  console.log('工业文件跟进：真实生成→护栏→扫描→发送、完整URL/非法删除、删空零发送/额度/消息/元数据、两个24小时阶段通过');

  // 旅游输入与删除订单号后的原模板字节相同；不改旧包。
  const { legacyTravelRuntime } = await import('./packs/registry.js');
  const travel = legacyTravelRuntime(config.packSources()).runtime;
  for (const s of store.listSessions()) s.followupOptOut = { at: now, quote: '测试结束' };
  delete process.env.SOP_PATH;
  try {
    bindPack(travel, null);
    const s = silent('quote', 4);
    store.saveSession(s, false);
    completion = `报价单：${url}`;
    assert.equal(await followup.followUpText(s), '报价单：', '旅游仍按旧法抹订单号并保留旧残句字节');
    completion = `https://shop.example.test/quote/${order.id}`;
    assert.equal(await followup.followUpText(s), travel.followupTemplates.byStage.quote);
    assert.equal(await followup.runFollowUpScan(push), 1);
    assert.equal(pushes.at(-1)!.text, travel.followupTemplates.byStage.quote);
    assert.equal(s.followup!.count, 1);
  } finally {
    process.env.SOP_PATH = path.join(dir, 'sop.md');
    bindPack(runtime, runtime.defaultBrand);
  }

  // PGlite：与生产相同的排程、认领、结果落库；不替换生成器、护栏或额度判断。
  store.flushStoreNow();
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  for (const s of store.listSessions()) store.forgetSession(s.id);
  config.__configTest.reset();
  delete process.env.SOP_PATH;
  const testing = await tenancy.withoutTenantScope(() => import('./db/testing.js'));
  testDb = await testing.openTestDb();
  process.env.LLM_MOCK = '1';
  await testing.installSeededConfig(testDb);
  process.env.LLM_MOCK = '0';
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  await testDb.pg.exec('RESET ROLE');
  const { insertTenant } = await import('./db/repo/tenants.js');
  const tenant = await insertTenant(testDb.db, {
    slug: 'industrial-followup',
    name: '合成询价跟进',
    packId: 'industrial',
    locale: 'zh-CN',
    region: 'CN',
    brand: runtime.defaultBrand,
  });
  tenancy.identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: true,
    publicBase: 'https://shop.example.test',
    expiresAt: rt.expiresAt,
  });
  const original = rt.config.loaded!;
  rt.config.loaded = {
    ...original,
    tenantId: tenant.id,
    pack: industrial,
    deps: { ...original.deps, tenantSlug: tenant.slug },
    catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
    ords: {},
    history: new Map(),
    sop: { ...original.sop, brand: runtime.defaultBrand, policy: { ...defaultIndustrialPolicy, autoApproveMaxFen: 100000 } },
  };
  bindPack(runtime, runtime.defaultBrand);
  const fx = await testing.installPgSessionStore(testDb, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const { createCatalogItem, activateCatalogItem } = await import('./config/catalog.js');
  const actor = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const item = await createCatalogItem(actor, 'part', part);
  await activateCatalogItem(actor, 'part', part.id, { rev: item.rev });
  const runner = await import('./jobs/runner.js');
  const { followupJobs } = await import('./jobs/followup.js');
  runner.__jobsTest.start(push);
  const sql = async <R = Record<string, unknown>>(query: string, params: unknown[] = []) => {
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    return testDb!.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(query, params)).rows;
    });
  };
  const dbEmpty = silent();
  store.saveSession(dbEmpty, false);
  await store.flushSession(dbEmpty.id);
  completion = '点击https://bad.example.test/quote/ord_fake';
  const m0 = ledgerSnapshot(dbEmpty),
    n0 = pushes.length;
  const sendsBefore = await sql('select id from outbound_sends where conversation_id=$1', [dbEmpty.id]);
  await runner.runJobsOnce(now);
  await store.flushSession(dbEmpty.id);
  assert.equal(pushes.length, n0);
  assert.deepEqual(ledgerSnapshot(dbEmpty), m0);
  const rows = await sql<{ status: string; last_error: string }>(
    "select status,last_error from jobs where kind='followup' and payload->>'sessionId'=$1",
    [dbEmpty.id],
  );
  assert.deepEqual(rows, [{ status: 'cancelled', last_error: 'guard_empty' }]);
  assert.deepEqual(await sql('select id from outbound_sends where conversation_id=$1', [dbEmpty.id]), sendsBefore);
  const g0 = generated;
  await runner.runJobsOnce(now + 1000);
  assert.equal(generated, g0, 'guard_empty 不立即重排');
  const dbValid = silent('closing');
  const dbOrder = await approved(dbValid);
  store.saveSession(dbValid, false);
  await store.flushSession(dbValid.id);
  completion = `报价单：https://shop.example.test/quote/${dbOrder.id}`;
  await runner.runJobsOnce(now);
  await store.flushSession(dbValid.id);
  assert.deepEqual(pushes.at(-1), { id: dbValid.id, text: completion });
  assert.equal(dbValid.followup!.count, 1);
  assert.equal(
    (await sql<{ status: string }>("select status from jobs where kind='followup' and payload->>'sessionId'=$1", [dbValid.id]))[0]!.status,
    'done',
  );
  const pending = silent('quote');
  const built = await approved(pending);
  built.approval!.state = 'pending';
  store.saveSession(pending, false);
  store.saveOrder(built);
  assert.equal(followup.followupStage(pending), null);
  const beforeGen = generated;
  await runner.runJobsOnce(now);
  assert.equal(generated, beforeGen);
  console.log(
    '工业数据库跟进：真实任务cancelled/guard_empty且不重排、零outbound/pending/额度/元数据；合法完整URL发送且只记一次、待审抑制通过',
  );

  // 实际引擎：非标转人工、注册固定句及schema patch、确认提醒事务去重、主护栏事件。
  process.env.LLM_MOCK = '1';
  const engine = store.getOrCreateSession('wecom:wmIFEngine', 'wecom');
  let action: (opts: ChatOptions) => Promise<string> = async () => '请告诉我型号和数量';
  runtime.mock = { chat: (opts) => action(opts) };
  const finish: import('./trace/recorder.js').FinishedTurn[] = [];
  const { onTurnEnd } = await import('./trace/recorder.js');
  const off = onTurnEnd((turn) => finish.push(turn));
  try {
    action = async (opts) => {
      await opts.executeTool('quote_items', { items: [{ query: part.partNo, qty: 2 }] });
      return `${part.partNo}今天发货。全网最低。`;
    };
    const guarded = await handleMessage(engine.id, '6205-2RS 2件', 'wecom');
    assert.match(guarded.text, /确认为准/);
    assert.doesNotMatch(guarded.text, /全网最低|今天发货/);
    assert.ok(finish.at(-1)!.turn.guards.some((g) => g.guard === 'industrial_claims'));
    // 每类编造都经真实主回复管线，事件落入guard_events。
    const unsafeCases = [
      {
        raw: '6205-2RS可以替代HS1000。',
        input: '请查6205-2RS，可以替代HS1000吗',
        expected: /能否替代请顾问确认/,
        guard: 'industrial_claims',
      },
      { raw: 'HS9999是现货。', input: '请查6205-2RS', expected: /请告诉我型号和数量/, guard: 'industrial_claims' },
      { raw: '报价含税。', input: '请查6205-2RS', expected: /报价不含税/, guard: 'industrial_claims', noTax: true },
      { raw: '全网最低。', input: '请查6205-2RS', expected: /请告诉我型号和数量/, guard: 'industrial_claims' },
      { raw: '单价1.23元。', input: '请查6205-2RS', expected: /金额需要先试算/, guard: 'money_provenance' },
    ];
    for (const sample of unsafeCases) {
      const s = store.getOrCreateSession(`wecom:wmIF${++sequence}`, 'wecom');
      const beforePolicy = rt.config.loaded!.sop.policy;
      if (sample.noTax) rt.config.loaded!.sop = { ...rt.config.loaded!.sop, policy: { ...defaultIndustrialPolicy, taxIncluded: false } };
      action = async (opts) => {
        await opts.executeTool('find_parts', { query: part.partNo });
        return sample.raw;
      };
      try {
        const reply = await handleMessage(s.id, sample.input, 'wecom');
        assert.match(reply.text, sample.expected);
        assert.ok(finish.at(-1)!.turn.guards.some((event) => event.guard === sample.guard));
        await store.flushSession(s.id);
        assert.ok(
          (await sql<{ guard: string }>('select guard from guard_events where turn_id=$1', [finish.at(-1)!.turn.turnId])).some(
            (event) => event.guard === sample.guard,
          ),
        );
      } finally {
        rt.config.loaded!.sop = { ...rt.config.loaded!.sop, policy: beforePolicy };
      }
    }
    const multi = store.getOrCreateSession(`wecom:wmIF${++sequence}`, 'wecom');
    action = async (opts) => {
      await opts.executeTool('quote_items', { items: [{ query: part.partNo, qty: 2 }] });
      return Array.from({ length: 15 }, () => `${part.partNo} 数量2，金额20.00元`).join('\n');
    };
    for (let i = 0; i < 2; i++) {
      const reply = await handleMessage(multi.id, '请试算6205-2RS 2件', 'wecom');
      assert.equal((reply.text.match(/6205-2RS/g) ?? []).length, 10);
      assert.match(reply.text, /另外 5 行已算好/);
      assert.ok(reply.text.split('\n').length <= 12);
    }
    action = async (opts) => {
      const quote = JSON.parse(await opts.executeTool('create_quote_sheet', { items: [{ code: part.id, qty: 2 }] }));
      return `报价单：${quote.quoteUrl}`;
    };
    now += 1000;
    await handleMessage(engine.id, '需要正式报价单', 'wecom');
    const confirmedOrder = store.getAnyOrder(engine.orderIds.at(-1)!) as LineOrder;
    now += 1000;
    const confirmed = await handleMessage(engine.id, '确认下单', 'wecom');
    assert.match(confirmed.text, /确认付款和发货/);
    assert.equal(engine.packState?.confirmedQuoteAt, now);
    const acceptedAt = confirmedOrder.approval!.acceptedAt;
    assert.ok(acceptedAt);
    now += 1000;
    await handleMessage(engine.id, '就按这个', 'wecom');
    assert.equal(confirmedOrder.approval!.acceptedAt, acceptedAt);
    assert.equal(
      (await sql<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [`quote_accepted:${confirmedOrder.id}`]))[0]!.n,
      1,
    );
    for (const text of ['非标', '来图加工', '月结', '要样品', Array.from({ length: 31 }, () => 'HS1000 2件').join('\n')]) {
      const s = store.getOrCreateSession(`wecom:wmIF${++sequence}`, 'wecom') as SessionWithFollowup;
      await handleMessage(s.id, text, 'wecom');
      assert.equal(s.handoff?.kind, 'pack');
      assert.ok(s.handedOver);
    }
  } finally {
    off();
  }
  console.log('工业真实引擎：护栏事件、固定句/patch、5类pack转人工、首次确认通知去重通过');
  followupJobs.stop();
  await runner.__jobsTest.stop();
} finally {
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  rt.store.pgBackend?.close();
  rt.store.pgBackend = null;
  await config.closeConfig();
  config.__configTest.reset();
  await testDb?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
