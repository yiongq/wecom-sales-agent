// 08 第 11 步：证明包工具 → 核心记账 → 护栏流水线、PGlite 持久化与重置。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MoneyEntry, ReplyGuardContext, ToolSpec, TurnToolContext } from './core/pack-api.js';
import type { FinishedTurn } from './trace/recorder.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-ledger-'));
Object.assign(process.env, { VAR_DIR: dir, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1' });
const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const testing = await withoutTenantScope(() => import('./db/testing.js'));
const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
const { bindPack } = await import('./core/pack-api.js');
const { packSources, closeConfig, __configTest } = await import('./config/source.js');
const { runtimeById, packById } = await import('./packs/registry.js');
const { createCatalogItem, activateCatalogItem } = await import('./config/catalog.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { loadGuardPipeline } = await import('./core/guards/execute.js');
const { handleMessage } = await import('./core/engine/index.js');
const { withTurnScope, startTurn, endTurn, onTurnEnd, noteGuard, noteGuardVerdict } = await import('./trace/recorder.js');
const { sessionState } = await import('./store/project.js');
const store = await import('./store.js');
const t = await testing.openTestDb();
try {
  await testing.installSeededConfig(t);
  const travelConfig = rt.config.loaded!;
  const travel = runtimeById('travel', packSources())!;
  assert.ok(![...travel.replySteps, ...travel.followupSteps].some((step) => step.id === 'money_provenance'));
  assert.ok(travel.tools.every((tool) => tool.amounts === undefined));
  const tourist = store.getOrCreateSession('sim-money', 'web');
  await createToolRegistry(travel.tools).execute(
    'search_routes',
    {},
    {
      session: tourist,
      hints: {},
      text: '',
      args: {},
      notes: {},
      handoffDeclined: false,
    },
  );
  assert.ok(!Object.hasOwn(sessionState(tourist), 'moneyLedger'));
  console.log('MONEY TRAVEL PASS：步骤表无新步骤、工具无 amounts、旅游 state 无 moneyLedger');

  await t.pg.exec('RESET ROLE');
  const tenant = await createFixtureTenant(t.db);
  const runtime = runtimeById('__fixture', packSources())!;
  identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: rt.isHost,
    publicBase: rt.publicBase,
    expiresAt: rt.expiresAt,
  });
  rt.config.loaded = {
    ...travelConfig,
    tenantId: tenant.id,
    tenantName: tenant.name,
    pack: packById('__fixture')!,
    deps: { ...travelConfig.deps, tenantSlug: tenant.slug },
    catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
    ords: {},
    history: new Map(),
  };
  bindPack(runtime, runtime.defaultBrand);
  const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const catalogCtx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  for (const item of [
    { id: 'w-a', title: '合成方盒甲', unitPrice: 3.65, unit: '件', tags: ['合成'] },
    { id: 'w-b', title: '合成方盒乙', unitPrice: 12, unit: '件', tags: ['合成'] },
    { id: 'w-unseen', title: '未查询方盒', unitPrice: 3.8, unit: '件', tags: ['合成'] },
  ]) {
    const row = await createCatalogItem(catalogCtx, 'widget', item);
    await activateCatalogItem(catalogCtx, 'widget', row.code, { rev: row.rev });
  }
  const s = store.getOrCreateSession('wecom:wmmoney', 'wecom');
  const ctx: TurnToolContext = { session: s, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
  const registry = createToolRegistry(runtime.tools);
  await registry.execute('fixture_inspect', {}, ctx);
  assert.ok(!Object.hasOwn(s, 'moneyLedger'));
  await registry.execute('fixture_quote', { code: 'missing' }, ctx);
  assert.ok(!Object.hasOwn(s, 'moneyLedger'));
  await registry.execute('fixture_quote', { code: 'w-a' }, ctx);
  assert.deepEqual(s.moneyLedger, [{ fen: 365, label: '查询单价' }]);

  // 与执行器自测相同的流水线夹具；真实 trace 接口接收事件与每步裁决。
  const money = runtime.replySteps.find((step) => step.id === 'money_provenance')!;
  const main = loadGuardPipeline([
    { id: 'stage_advance', run: () => ({ action: 'pass' as const }) },
    { ...money, after: ['stage_advance'] },
    { id: 'takeover_check:post', run: () => ({ action: 'pass' as const }) },
    { id: 'turn_failure', run: () => ({ action: 'pass' as const }) },
  ]);
  const forbidden = (): never => {
    throw new Error('护栏不应产生副作用');
  };
  const guardContext = (text: string): ReplyGuardContext =>
    ({
      session: s,
      text,
      turn: { flags: { guardHit: null } },
      toolSources: [],
      orderSources: [],
      brand: runtime.defaultBrand,
      thresholds: runtime.thresholds,
      createOrder: forbidden,
      callTool: forbidden,
      enterHandoff: forbidden,
      recordGuard: noteGuard,
    }) as unknown as ReplyGuardContext;
  const turns: FinishedTurn[] = [];
  const off = onTurnEnd((turn) => turns.push(turn));
  async function reply(text: string): Promise<string> {
    return withTurnScope(async () => {
      startTurn(s.id);
      const result = await main.run(guardContext(text), { onVerdict: noteGuardVerdict });
      endTurn('replied', result.text, s.stage, s.stage);
      return result.text;
    });
  }
  try {
    assert.equal(await reply('单价3.65元。'), '单价3.65元。');
    assert.deepEqual(turns.at(-1)!.turn.guardVerdicts![1], { id: 'money_provenance', action: 'pass' });
    assert.equal(turns.at(-1)!.turn.guards.length, 0);
    assert.equal(await reply('单价3.80元。请确认规格。'), '请确认规格。');
    assert.deepEqual(
      turns.at(-1)!.turn.guards.map(({ guard, action }) => ({ guard, action })),
      [{ guard: 'money_provenance', action: 'drop_sentence' }],
    );
    assert.equal(await reply('单价3.80元。'), '金额尚未核验，请先查询。');
    assert.equal(turns.at(-1)!.turn.guards[0]!.action, 'replace');
    assert.equal(await reply('合计7.30元。运费10元。'), '运费10元。');
    assert.equal((await loadGuardPipeline(runtime.followupSteps).run(guardContext('单价3.80元。'))).text, '');
    console.log('MONEY PIPELINE PASS：365 分放行、380 分删句/兜底、派生合计删除、静态运费、跟进只删；trace 事件与裁决正确');

    const ordered = JSON.parse(
      await registry.execute(
        'fixture_order',
        {
          lines: [
            { kind: 'widget', code: 'w-a', qty: 200 },
            { kind: 'widget', code: 'w-b', qty: 50 },
          ],
        },
        ctx,
      ),
    ) as { orderId: string };
    assert.equal(store.getAnyOrder(ordered.orderId)!.sessionId, s.id);
    assert.deepEqual(
      s.moneyLedger!.slice(-5).map(({ fen }) => fen),
      [365, 73000, 1200, 60000, 133000],
    );
    assert.equal(await reply('单价3.65元、12元。行金额730元、600元。合计1330元。'), '单价3.65元、12元。行金额730元、600元。合计1330元。');
    delete s.moneyLedger;
    assert.equal(await reply('单价3.65元、12元。行金额730元、600元。合计1330元。'), '单价3.65元、12元。行金额730元、600元。合计1330元。');
    console.log('MONEY ORDER PASS：第 9 步真实建单工具声明五个金额；无账本时仍经 getAnyOrder 放行单价、行金额、合计');
  } finally {
    off();
  }

  // 核心执行器：成功才记、以核正后的参数声明、整批校验后写入，保留最新 200 条且复制条目。
  let declarations = 0;
  let entries: MoneyEntry[] = Array.from({ length: 205 }, (_, fen) => ({ fen, label: '合成金额' }));
  const probe: ToolSpec<TurnToolContext> = {
    ...runtime.tools.find((tool) => tool.def.function.name === 'fixture_quote')!,
    async execute(args) {
      assert.deepEqual(args, { corrected: true });
      return 'ok';
    },
    amounts(result, args) {
      declarations++;
      assert.equal(result, 'ok');
      assert.deepEqual(args, { corrected: true });
      return entries;
    },
  };
  const probeRegistry = createToolRegistry([probe], { beforeTool: () => ({ args: { corrected: true } }) });
  await probeRegistry.execute('fixture_quote', {}, ctx);
  assert.equal(s.moneyLedger!.length, 200);
  assert.equal(s.moneyLedger![0]!.fen, 5);
  entries[204]!.fen = 999;
  assert.equal(s.moneyLedger!.at(-1)!.fen, 204);
  entries = [{ fen: 1001, label: '新金额' }];
  await probeRegistry.execute('fixture_quote', {}, ctx);
  assert.equal(s.moneyLedger![0]!.fen, 6);
  assert.equal(s.moneyLedger!.at(-1)!.fen, 1001);
  for (const bad of [
    { fen: -1, label: '负数' },
    { fen: 0.1, label: '非整数' },
    { fen: Number.MAX_SAFE_INTEGER + 1, label: '不安全整数' },
    { fen: 1, label: '字'.repeat(21) },
  ]) {
    const before: MoneyEntry[] | undefined = structuredClone(s.moneyLedger);
    entries = [{ fen: 888, label: '不能部分写入' }, bad];
    await assert.rejects(probeRegistry.execute('fixture_quote', {}, ctx), /amounts/);
    assert.deepEqual(s.moneyLedger, before);
  }
  const callsBefore = declarations;
  await createToolRegistry([probe], { beforeTool: () => ({ reject: '拒绝' }) }).execute('fixture_quote', {}, ctx);
  const failure = new Error('工具失败');
  await assert.rejects(
    createToolRegistry([
      {
        ...probe,
        execute: async () => {
          throw failure;
        },
      },
    ]).execute('fixture_quote', {}, ctx),
    (e) => e === failure,
  );
  assert.equal(declarations, callsBefore);
  entries = [{ fen: 0, label: '字'.repeat(20) }];
  await probeRegistry.execute('fixture_quote', {}, ctx);
  assert.deepEqual(s.moneyLedger!.at(-1), entries[0]);

  store.saveSession(s);
  await store.flushSession(s.id);
  const saved = await t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<{ state: { moneyLedger: MoneyEntry[] } }>('select state from conversations where id = $1', [s.id])).rows[0]!
      .state;
  });
  assert.deepEqual(saved.moneyLedger, s.moneyLedger);
  await handleMessage(s.id, '重置', 'wecom');
  assert.ok(!Object.hasOwn(s, 'moneyLedger'));
  await store.flushSession(s.id);
  assert.ok(!Object.hasOwn(sessionState(s), 'moneyLedger'));
  console.log('MONEY LEDGER PASS：成功边界、核正参数、上限200留最新、整数/标签校验、PGlite持久化、核心重置删除');

  // 组合入口的装载错误必须点名包与冲突步骤。
  assert.throws(
    () =>
      bindPack(
        {
          ...runtime,
          replyAnchors: { ...runtime.replyAnchors, 'takeover_check:post': 'shape_check' },
          replySteps: runtime.replySteps.map((step) => (step.id === 'money_provenance' ? { ...step, after: ['turn_failure'] } : step)),
        },
        null,
      ),
    /__fixture.*money_provenance/,
  );
} finally {
  await store.drainStore(5000);
  rt.store.pgBackend?.close();
  rt.store.fileBackend?.reset();
  if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
  if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
  await closeConfig();
  __configTest.reset();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('money ledger selftest: PASS（PGlite 必跑，无真实 PG）');
