// 09 R11–R16：确定性副作用、固定句、统计、包钩子与评测谓词。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-replies-'));
Object.assign(process.env, { VAR_DIR: dir, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' });
const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const testing = await withoutTenantScope(() => import('./db/testing.js'));
const t = await testing.openTestDb();
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack } = await import('./core/pack-api.js');
const { createFixtureQuoteRuntime } = await import('./packs/__fixture/runtime.js');
const { createLineOrder } = await import('./core/order-view.js');
try {
  await testing.installSeededConfig(t);
  await t.pg.exec('RESET ROLE');
  const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
  const tenant = await createFixtureTenant(t.db);
  identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: rt.isHost,
    publicBase: rt.publicBase,
    expiresAt: rt.expiresAt,
  });
  const { packById } = await import('./packs/registry.js');
  rt.config.loaded = {
    ...rt.config.loaded!,
    tenantId: tenant.id,
    pack: packById('__fixture')!,
    deps: { ...rt.config.loaded!.deps, tenantSlug: tenant.slug },
    catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
    ords: {},
    history: new Map(),
  };
  const runtime = createFixtureQuoteRuntime(config.packSources());
  const brand = { ...runtime.defaultBrand, brandName: '合成<方盒>核验社' };
  bindPack(runtime, brand);
  rt.config.loaded!.sop = { ...rt.config.loaded!.sop, brand };
  const { createCatalogItem, activateCatalogItem } = await import('./config/catalog.js');
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const item = await createCatalogItem(ctx, 'widget', { id: 'w-page', title: '合成方盒', unitPrice: 12, unit: '件', tags: [] });
  await activateCatalogItem(ctx, 'widget', item.code, { rev: item.rev });
  const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const { handleMessage } = await import('./engine.js');
  const { approveQuote, withdrawQuote } = await import('./payment/orders.js');
  const { shouldFollowUp } = await import('./core/followup.js');
  const { handoffStats } = await import('./ops/board.js');
  const { createFixtureProofRuntime } = await import('./packs/__fixture/runtime.js');
  const { isRichTurn } = await import('../eval/sim/judge.js');
  const { judge } = await import('../eval/sim/judge.js');
  const { validateGoal } = await import('../eval/sim/goals.js');
  const { __profileTest } = await import('./profile.js');
  const originalPreModel = runtime.preModel;
  const actor = { userId: null, name: '合成核验员', role: 'supervisor' as const };
  const session = store.getOrCreateSession('wecom:wmEReply', 'wecom');
  const make = async (qty: number) => {
    const result = await createLineOrder(session, [{ kind: 'widget', code: 'w-page', qty }]);
    assert.ok('order' in result);
    return result.order;
  };
  const order = await make(100);
  const sent: string[] = [];
  const { setReplyTransport } = await import('./handoff/takeover.js');
  setReplyTransport(async (_id, text) => {
    sent.push(text);
    return true;
  });
  let events: string[] = [];
  const originalHook = runtime.onQuoteDecided;
  runtime.onQuoteDecided = (s, o, event) => {
    events.push(event);
    return originalHook!(s, o, event);
  };
  const stocked = await createCatalogItem(ctx, 'widget', {
    id: 'w-stock',
    title: '合成现货方盒',
    unitPrice: 50,
    unit: '件',
    tags: [],
    inStock: true,
  });
  await activateCatalogItem(ctx, 'widget', stocked.code, { rev: stocked.rev });
  const stockSession = store.getOrCreateSession('wecom:wmEStock', 'wecom');
  const exactly100 = await createLineOrder(stockSession, [{ kind: 'widget', code: 'w-stock', qty: 2 }]);
  assert.ok('order' in exactly100);
  assert.equal(exactly100.order.approval!.state, 'approved');
  assert.deepEqual(events, [], '自动批准不调用工作台钩子');
  const linkText = `/quote/${exactly100.order.id}`;
  const fixedReplies = runtime.fixedReplies;
  runtime.fixedReplies = [
    ...fixedReplies!,
    {
      id: 'fixture.stocklink',
      source: 'src/packs/__fixture/runtime.ts',
      kind: 'plain',
      producedBy: { outside: '自测' },
      samples: () => [{ mode: 'template', text: linkText }],
    },
  ];
  runtime.preModel = () => ({ text: linkText, fixedId: 'fixture.stocklink' });
  await handleMessage(stockSession.id, '核对报价', 'wecom');
  await store.flushSession(stockSession.id);
  assert.deepEqual((stockSession.messages.at(-1) as unknown as Record<string, unknown>).quoteStates, { [exactly100.order.id]: 'approved' });
  runtime.preModel = originalPreModel;
  runtime.fixedReplies = fixedReplies;
  const over100 = await createLineOrder(stockSession, [{ kind: 'widget', code: 'w-stock', qty: 3 }]);
  assert.ok('order' in over100);
  assert.equal(over100.order.approval!.state, 'pending');
  const mixed = await createLineOrder(stockSession, [
    { kind: 'widget', code: 'w-stock', qty: 1 },
    { kind: 'widget', code: 'w-page', qty: 1 },
  ]);
  assert.ok('order' in mixed);
  assert.equal(mixed.order.approval!.state, 'pending', '全部有现货才自动批准');
  await approveQuote(order.id, actor);
  assert.equal(session.stage, 'closing');
  await approveQuote(order.id, actor);
  assert.deepEqual(events, ['approved']);
  assert.equal(sent.length, 1);
  let reply = await handleMessage(session.id, '确认报价', 'wecom');
  assert.match(reply.text, /已记下您的报价确认/);
  assert.equal(session.packState?.quoteAccepted, true);
  assert.ok(order.approval!.acceptedAt);
  const acceptedAt = order.approval!.acceptedAt;
  await handleMessage(session.id, '确认报价', 'wecom');
  await store.flushSession(session.id);
  assert.equal(order.approval!.acceptedAt, acceptedAt);
  await t.pg.exec('RESET ROLE');
  assert.equal(
    (await t.pg.query<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [`quote_accepted:${order.id}`])).rows[0]!.n,
    1,
  );
  await t.pg.exec('SET ROLE agent_app');
  await withdrawQuote(order.id, actor);
  await withdrawQuote(order.id, actor);
  assert.deepEqual(events, ['approved', 'withdrawn']);
  const pending = await make(200);
  session.stage = 'quote';
  session.updatedAt = Date.now() - 3600000;
  session.messages.push({ role: 'agent', content: '报价单已提交，等顾问审核。', at: session.updatedAt });
  __profileTest.reset();
  process.env.FOLLOWUP_ENABLED = '1';
  assert.equal(shouldFollowUp(session, Date.now()), false);
  pending.approval!.state = 'withdrawn';
  pending.status = 'cancelled';
  assert.equal(shouldFollowUp(session, Date.now()), true);
  reply = await handleMessage(session.id, '需要非标方盒', 'wecom');
  assert.equal(reply.handoff, true);
  assert.equal(session.handoff!.kind, 'pack');
  assert.equal(session.handoff!.reason, '非标方盒需要人工核验');
  await store.flushSession(session.id);
  assert.equal(handoffStats([{ id: session.id, seed: false, active: true, kinds: ['pack'] }], 'standard').byOrigin.customer.byKind.pack, 1);
  const snapshot = { orders: [], handedOver: true, handoff: session.handoff!, stage: session.stage };
  const goal = validateGoal(
    {
      id: 'pack-handoff',
      pack: '__fixture',
      persona: '合成客户',
      allowedTools: [],
      forbidden: [],
      predicates: [{ kind: 'handoff', expected: true, handoffKind: 'pack' }],
    },
    'fixture',
  );
  assert.ok(judge(goal, { initial: snapshot, turns: [] }).every((v) => v.passed));
  assert.equal(
    judge({ ...goal, predicates: [{ kind: 'handoff', expected: true, handoffKind: 'agent' }] }, { initial: snapshot, turns: [] })[0]!
      .passed,
    false,
  );
  // 不匹配、漏 fixedId、无 schema 与越界 patch 都必须在发送/副作用之前失败。
  let seq = 0;
  for (const deterministic of [
    { text: '非标需求由顾问继续确认。', handoff: { reason: '合成原因' } },
    { text: '未登记', fixedId: 'missing', statePatch: { quoteAccepted: true } },
    { text: '错误正文', fixedId: 'fixture.accepted', statePatch: { quoteAccepted: true } },
    { text: '已记下您的报价确认，顾问会安排后续事项。', fixedId: 'fixture.accepted', statePatch: { unexpected: true } },
    { text: '非标需求由顾问继续确认。', fixedId: 'fixture.nonstandard', handoff: { reason: '长'.repeat(121) } },
  ]) {
    runtime.preModel = () => deterministic;
    const s = store.getOrCreateSession(`wecom:wmEBad${++seq}`, 'wecom');
    await assert.rejects(handleMessage(s.id, '核验请求', 'wecom'));
    assert.equal(s.messages.filter((m) => m.role === 'agent').length, 0);
    assert.equal(s.packState, undefined);
    assert.equal(s.handedOver, false);
  }
  // 模板正则必须匹配全文，并且不受 g/y 的 lastIndex 影响。
  const fixed = {
    id: 'fixture.variable',
    source: 'src/packs/__fixture/runtime.ts',
    kind: 'plain' as const,
    producedBy: { outside: '自测' },
    pattern: /合成品牌已记下[0-9]+件。/g,
    samples: () => [{ mode: 'template' as const, text: '合成品牌已记下1件。' }],
  };
  runtime.fixedReplies = [...runtime.fixedReplies!, fixed];
  runtime.preModel = () => ({ text: '合成品牌已记下2件。', fixedId: fixed.id, statePatch: { quoteAccepted: true } });
  for (let i = 0; i < 2; i++) assert.match((await handleMessage(`wecom:wmETpl${i}`, '确认请求', 'wecom')).text, /合成品牌已记下2件/);
  runtime.preModel = () => ({ text: '前缀合成品牌已记下2件。', fixedId: fixed.id });
  await assert.rejects(handleMessage('wecom:wmETplBad', '确认请求', 'wecom'), /固定句/);
  const stateSchema = runtime.sessionState;
  runtime.sessionState = undefined;
  runtime.preModel = () => ({ text: '非标需求由顾问继续确认。', fixedId: 'fixture.nonstandard', statePatch: { quoteAccepted: true } });
  await assert.rejects(handleMessage('wecom:wmENoSchema', '核验请求', 'wecom'), /schema/);
  runtime.sessionState = stateSchema;
  const realError = console.error;
  const errors: string[] = [];
  try {
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    runtime.preModel = () => ({ text: '合成未登记正文', fixedId: 'missing', statePatch: { quoteAccepted: true } });
    assert.match((await handleMessage('wecom:wmEProd', '核验请求', 'wecom')).text, /合成未登记正文/);
    assert.equal(store.getSession('wecom:wmEProd')!.packState!.quoteAccepted, true);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0]!, /合成未登记正文/);
  } finally {
    console.error = realError;
    __profileTest.reset();
  }
  runtime.preModel = originalPreModel;
  const historySession = store.getOrCreateSession('wecom:wmEHistory', 'wecom');
  const historyOrder = await createLineOrder(historySession, [{ kind: 'widget', code: 'w-page', qty: 100 }]);
  assert.ok('order' in historyOrder);
  await approveQuote(historyOrder.order.id, actor);
  historyOrder.order.status = 'paid';
  store.saveOrder(historyOrder.order);
  const nextOrder = await createLineOrder(historySession, [{ kind: 'widget', code: 'w-page', qty: 200 }]);
  assert.ok('order' in nextOrder);
  events = [];
  await approveQuote(nextOrder.order.id, actor);
  assert.deepEqual(events, ['approved'], '已付历史未取代，不调用取代钩子');
  bindPack(createFixtureProofRuntime(config.packSources()), brand);
  const rich = { trace: { turn: { calls: [{ name: 'fixture_quote_order' }] } } } as import('../eval/sim/judge.js').SimTurn;
  assert.equal(isRichTurn(rich), true);
  rich.trace.turn.calls[0]!.name = 'create_quote';
  assert.equal(isRichTurn(rich), false);
  console.log('QUOTE REPLIES PASS: 固定句/模板全文、schema拒绝、pack转人工与统计、确认去重、动作钩子幂等、待审跳过跟进');
} finally {
  await store.drainStore(5000);
  rt.store.pgBackend?.close();
  rt.store.fileBackend?.reset();
  if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
  if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
  await config.closeConfig();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
