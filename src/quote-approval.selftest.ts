// 09 C：数据库存储中验证审批建单、工具保密、复用/取代、上海自然日、旧六入口。
// openTestDb 当前使用 PGlite；设置 PG_TEST_URL 不会将本文件切换为真实 Postgres。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LineOrder } from './core/order-view.js';
import type { ReplyGuardContext, TurnToolContext } from './core/pack-api.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-approval-'));
Object.assign(process.env, { VAR_DIR: dir, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' });
const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const testing = await withoutTenantScope(() => import('./db/testing.js'));
const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
const { bindPack } = await import('./core/pack-api.js');
const { packSources, closeConfig, __configTest } = await import('./config/source.js');
const { packById } = await import('./packs/registry.js');
const { createFixtureQuoteRuntime } = await import('./packs/__fixture/runtime.js');
const { createCatalogItem, activateCatalogItem, updateCatalogItem } = await import('./config/catalog.js');
const { createLineOrder, quoteState } = await import('./core/order-view.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { handleMessage } = await import('./core/engine/index.js');
const { summarizeOrders } = await import('./ops/board.js');
const { __profileTest } = await import('./profile.js');
const store = await import('./store.js');
const t = await testing.openTestDb();
const realNow = Date.now;
let now = Date.parse('2026-12-30T15:59:59Z'); // 上海跨年边界前一秒。
try {
  await testing.installSeededConfig(t);
  const travel = rt.config.loaded!;
  await t.pg.exec('RESET ROLE');
  const tenant = await createFixtureTenant(t.db);
  identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: rt.isHost,
    publicBase: rt.publicBase,
    expiresAt: rt.expiresAt,
  });
  rt.config.loaded = {
    ...travel,
    tenantId: tenant.id,
    tenantName: tenant.name,
    pack: packById('__fixture')!,
    deps: { ...travel.deps, tenantSlug: tenant.slug },
    catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
    ords: {},
    history: new Map(),
  };
  const runtime = createFixtureQuoteRuntime(packSources());
  bindPack(runtime, runtime.defaultBrand);
  const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  for (const item of [
    { id: 'w-a', title: '合成方盒甲', unitPrice: 3.65, unit: '件', tags: ['合成'], inStock: true },
    { id: 'w-b', title: '合成方盒乙', unitPrice: 12, unit: '件', tags: ['合成'], inStock: true },
  ]) {
    const row = await createCatalogItem(ctx, 'widget', item);
    await activateCatalogItem(ctx, 'widget', row.code, { rev: row.rev });
  }
  Date.now = () => now;
  const picks = [
    { kind: 'widget', code: 'w-a', qty: 200 },
    { kind: 'widget', code: 'w-b', qty: 50 },
  ];
  const s = store.getOrCreateSession('wecom:wmquote', 'wecom');
  const make = async (qty: number, session = s): Promise<LineOrder> => {
    const result = await createLineOrder(session, [{ kind: 'widget', code: 'w-a', qty }]);
    assert.ok('order' in result);
    return result.order;
  };
  const toolCtx: TurnToolContext = { session: s, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
  const registry = createToolRegistry(runtime.tools);
  assert.deepEqual(JSON.parse(await registry.execute('fixture_order', { lines: picks }, toolCtx)), { state: 'pending' });
  const pending = store.getAnyOrder(s.orderIds[0]!) as LineOrder;
  assert.deepEqual(pending.approval, { state: 'pending', requestedAt: now });
  assert.equal(pending.totalFen, 133000);
  assert.equal(s.moneyLedger, undefined, '待审工具不声明正式金额');
  store.markOrderPaid(pending.id);
  assert.equal(pending.status, 'pending_payment', '存储付款入口也不能绕过审批');
  for (const result of await Promise.all([createLineOrder(s, picks.toReversed()), createLineOrder(s, picks)])) {
    assert.ok('order' in result && result.reused);
    assert.strictEqual(result.order, pending);
  }
  const money = runtime.replySteps.find((step) => step.id === 'money_provenance')!;
  const moneyText = async (text: string): Promise<string> => {
    const verdict = await money.run({
      session: s,
      text,
      policy: {},
      turn: { flags: {} },
      recordGuard() {},
    } as unknown as ReplyGuardContext);
    return verdict.action === 'pass' || verdict.action === 'abort' ? text : verdict.text;
  };
  assert.equal(await moneyText('合计1,330元。'), '金额尚未核验，请先查询。');
  await registry.execute('fixture_quote', { code: 'w-a' }, toolCtx);
  assert.deepEqual(s.moneyLedger, [{ fen: 365, label: '查询单价' }]);
  assert.equal(await moneyText('试算单价3.65元。'), '试算单价3.65元。');
  for (const state of ['rejected', 'withdrawn'] as const) {
    pending.approval!.state = state;
    assert.equal(await moneyText('合计1,330元。'), '金额尚未核验，请先查询。');
  }
  pending.approval!.state = 'approved';
  pending.approval!.decidedAt = now;
  assert.equal(await moneyText('合计1,330元。'), '合计1,330元。');
  pending.approval!.state = 'pending';
  delete pending.approval!.decidedAt;
  const newer = await make(201);
  assert.equal(quoteState(pending, now), 'superseded');
  assert.equal(pending.supersededBy, newer.id);
  const auto = await make(2);
  assert.equal(quoteState(newer, now), 'superseded');
  assert.deepEqual(auto.approval, { state: 'approved', requestedAt: now, auto: true, decidedAt: now });
  assert.equal(auto.confirmedAt, now);
  const allowed = runtime.siteLinks![0]!.allowed;
  const { coreSiteLinks } = await import('./core/site-links.js');
  const payCard = coreSiteLinks.find((link) => link.linkKind === 'order')!.card!;
  assert.equal(allowed(s, `/quote/${auto.id}`), true);
  assert.equal(allowed({ ...s, id: 'wecom:wmother' }, `/quote/${auto.id}`), false);
  const toolAuto = JSON.parse(await registry.execute('fixture_order', { lines: [{ kind: 'widget', code: 'w-a', qty: 2 }] }, toolCtx));
  assert.deepEqual(toolAuto, { state: 'approved', quoteUrl: `/quote/${auto.id}`, totalText: '7.30元' });
  const nextPending = await make(202);
  assert.equal(quoteState(auto, now), 'approved', '新待审单保留原正式单');
  assert.equal(allowed(s, `/quote/${nextPending.id}`), false);
  assert.strictEqual(await make(2), auto, '已批准有效单复用');
  const replacement = await make(1);
  assert.equal(quoteState(auto, now), 'superseded');
  assert.equal(quoteState(nextPending, now), 'superseded');
  assert.equal(allowed(s, `/quote/${auto.id}`), false);
  assert.equal(quoteState(replacement, now), 'approved');
  // 自动批准只看建单快照；调价不会撤回、改写原单，也不再次调用钩子。
  const frozenLines = JSON.stringify(replacement.lines);
  const b = await updateCatalogItem(ctx, 'widget', 'w-a', { rev: 2, set: { unitPrice: 120 } });
  assert.ok(b);
  assert.equal(quoteState(replacement, now), 'approved');
  assert.equal(JSON.stringify(replacement.lines), frozenLines);
  await updateCatalogItem(ctx, 'widget', 'w-a', { rev: b.rev, set: { unitPrice: 3.65 } });
  bindPack(
    {
      ...runtime,
      quotes: {
        ...runtime.quotes!,
        autoApprovable: () => {
          throw new Error('不应重审');
        },
      },
    },
    runtime.defaultBrand,
  );
  assert.strictEqual(await make(1), replacement);
  bindPack(runtime, runtime.defaultBrand);
  const last = Date.parse('2027-01-01T15:59:59Z');
  assert.equal(quoteState(replacement, last), 'approved');
  assert.equal(quoteState(replacement, last + 999), 'approved');
  assert.equal(quoteState(replacement, last + 1000), 'expired');
  now = last + 1000;
  assert.equal(allowed(s, `/quote/${replacement.id}`), false);
  assert.equal(summarizeOrders([replacement], 0, now + 1, 'standard', () => false).total.pendingCount, 0);
  assert.equal(replacement.status, 'pending_payment', '过期不写状态');
  const renewed = await make(1);
  assert.notEqual(renewed.id, replacement.id);
  assert.equal(replacement.status, 'superseded');
  assert.equal(renewed.status, 'pending_payment');
  const pendingOnly = await make(300);
  assert.equal(summarizeOrders([renewed, pendingOnly], 0, now + 1, 'standard', () => false).total.pendingCount, 1);
  // 无自动批准钩子的包全部人审；显式 false 保留无审批通用单。
  bindPack({ ...runtime, quotes: { approval: true, validDays: () => 2 } }, runtime.defaultBrand);
  const manual = await make(1, store.getOrCreateSession('wecom:wmmanual', 'simulator'));
  assert.equal(manual.approval!.state, 'pending');
  const legacy = await createLineOrder(s, picks, { approval: false });
  assert.ok('order' in legacy && !legacy.order.approval);
  assert.equal(quoteState(renewed, now), 'approved', '两种单据不互相取代');
  bindPack(runtime, runtime.defaultBrand);
  console.log('QUOTE DATA PASS: 待审结果仅 state、试算账本、正式金额隔离、并发复用、自动批准快照、两槽取代、上海跨年自然日');

  // 真正的一轮 mock 对话，经核心工具账本、金额护栏和链接护栏。
  let toolResult = '';
  bindPack(
    {
      ...runtime,
      mock: {
        async chat(opts) {
          await opts.executeTool('fixture_quote', { code: 'w-a' });
          toolResult = await opts.executeTool('fixture_order', { lines: picks });
          return `试算单价3.65元。报价单待顾问审核。\n请查看 /quote/${store.getSession('sim-quote-proof')!.orderIds[0]}。`;
        },
      },
    },
    runtime.defaultBrand,
  );
  const reply = await handleMessage('sim-quote-proof', '请试算并准备报价单', 'web');
  assert.deepEqual(JSON.parse(toolResult), { state: 'pending' });
  assert.match(reply.text, /3.65元/);
  assert.doesNotMatch(reply.text, /\/quote\//);
  assert.deepEqual(store.getSession('sim-quote-proof')!.moneyLedger, [{ fen: 365, label: '查询单价' }]);
  bindPack(runtime, runtime.defaultBrand);

  const { app } = await withoutTenantScope(() => import('./server.js'));
  const accounts = await import('./auth/accounts.js');
  const owner = { email: 'quote@example.com', password: 'quote-test-password' };
  await t.pg.exec('SET ROLE agent_platform');
  const created = await accounts.createUser(t.db, {
    tenantSlug: tenant.slug,
    email: owner.email,
    name: '合成所有者',
    role: 'owner',
    password: async () => owner.password,
  });
  assert.equal(created.code, 0, created.message);
  await t.pg.exec('SET ROLE agent_app');
  // 登录使用真实时钟，避免固定远期时钟影响 cookie 生命周期。
  Date.now = realNow;
  const login = await app.request('/api/console/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(owner))) },
    body: JSON.stringify(owner),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfFor } = await import('./auth/session.js');
  const csrf = csrfFor(cookie.slice(cookie.indexOf('=') + 1));
  const post = (id: string, action: string, body = {}) =>
    app.request(`/api/console/orders/${id}/${action}`, {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf': csrf,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify(body))),
      },
      body: JSON.stringify(body),
    });
  const { confirmOrder, QuoteStateError } = await import('./payment/orders.js');
  for (const mock_pay of [true, false]) {
    __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: mock_pay ? 'on' : 'off' });
    for (const state of ['pending', 'approved', 'rejected', 'withdrawn', 'superseded', 'paid', 'expired'] as const) {
      const session = store.getOrCreateSession(`quote-${mock_pay}-${state}`, 'simulator');
      const order = await make(400, session);
      if (state !== 'pending') order.approval!.state = state === 'rejected' || state === 'withdrawn' ? state : 'approved';
      order.approval!.decidedAt = state === 'expired' ? realNow() - 10 * 86_400_000 : realNow();
      if (state === 'rejected' || state === 'withdrawn') order.status = 'cancelled';
      if (state === 'superseded') order.status = 'superseded';
      if (state === 'paid') {
        order.status = 'paid';
        order.paidAt = realNow();
      }
      store.saveOrder(order);
      await store.flushSession(session.id);
      const frozen = JSON.stringify(order.lines);
      assert.equal(payCard(`/pay/${order.id}`, session), null, '报价单不借旧支付卡片泄露正式金额');
      assert.equal(allowed(session, `/quote/${order.id}`), state === 'approved', `${state}/quote.allowed`);
      for (const [url, method] of [
        [`/api/orders/${order.id}`, 'GET'],
        [`/pay/${order.id}`, 'GET'],
        [`/api/orders/${order.id}/pay`, 'POST'],
      ] as const) {
        const res = await app.request(url, { method });
        assert.equal(res.status, 404, `${mock_pay}/${state}/${url}`);
        assert.doesNotMatch(await res.text(), /1,460|146000|合成方盒/);
      }
      const confirmed = await post(order.id, 'confirm');
      assert.equal(confirmed.status, 409);
      assert.equal((await confirmed.json()).error, 'quote_order');
      assert.throws(
        () => confirmOrder(order.id, { userId: null, name: '合成', role: 'owner' }),
        (e) => e instanceof QuoteStateError && e.code === 'quote_order',
      );
      const pay = await post(order.id, 'mark-paid');
      const payable = ['approved', 'expired', 'paid'].includes(state);
      assert.equal(pay.status, payable ? 200 : 409, `${mock_pay}/${state}/mark-paid: ${await pay.clone().text()}`);
      if (!payable)
        assert.equal((await pay.json()).error, state === 'pending' ? 'not_approved' : state === 'superseded' ? 'superseded' : 'invalid');
      if (payable) assert.equal(order.status, 'paid');
      assert.equal(JSON.stringify(order.lines), frozen);
    }
  }
  for (const mock_pay of [true, false]) {
    __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: mock_pay ? 'on' : 'off' });
    for (const state of ['pending', 'approved', 'expired', 'rejected', 'withdrawn', 'superseded', 'paid'] as const) {
      const session = store.getOrCreateSession(`cancel-${mock_pay}-${state}`, 'simulator');
      const order = await make(400, session);
      order.approval!.state = ['rejected', 'withdrawn'].includes(state)
        ? (state as 'rejected' | 'withdrawn')
        : state === 'pending'
          ? 'pending'
          : 'approved';
      order.approval!.decidedAt = state === 'expired' ? realNow() - 10 * 86_400_000 : realNow();
      if (state === 'rejected' || state === 'withdrawn') order.status = 'cancelled';
      if (state === 'paid' || state === 'superseded') order.status = state;
      store.saveOrder(order);
      await store.flushSession(session.id);
      const before = JSON.stringify(order);
      const cancel = await post(order.id, 'cancel', { reason: '只给顾问看的撤回原因' });
      assert.equal(cancel.status, ['superseded', 'paid'].includes(state) ? 409 : 200, await cancel.clone().text());
      if (['superseded', 'paid'].includes(state)) assert.equal((await cancel.json()).error, state);
      if (['pending', 'approved', 'expired'].includes(state)) {
        assert.equal(order.status, 'cancelled');
        assert.equal(order.approval!.state, 'withdrawn');
      } else assert.equal(JSON.stringify(order), before, '终态取消幂等或拒绝，无写入');
      const notices = session.messages.filter((m) => m.role === 'agent');
      assert.equal(notices.length, ['approved', 'expired'].includes(state) ? 1 : 0);
      assert.ok(notices.every((m) => !m.content.includes('只给顾问')));
      const again = await post(order.id, 'cancel', { reason: '重复撤回' });
      assert.equal(again.status, cancel.status);
      assert.equal(session.messages.filter((m) => m.role === 'agent').length, notices.length);
    }
  }
  console.log('QUOTE ENTRIES PASS: 两种付款模式 × 七状态，旧三公开入口均 404，确认/收款错误码，取消七状态、过期通知与幂等');

  // 审批 JSON 经现有订单队列持久化，预载后仍能复用，且不重新自动审批。
  // drain 超时只返回未提交的会话，不会抛错；CI 负载下留足时间，并在关闭后端前确认全部提交。
  const { undrained } = await store.drainStore(30_000);
  assert.deepEqual(undrained, [], '重建存储前必须排空全部写队列');
  rt.store.pgBackend!.close();
  rt.store.pgBackend = null;
  rt.store.sessions.clear();
  rt.store.orders.clear();
  await store.initSessionStore(fx.deps);
  const loaded = store.getAnyOrder(pendingOnly.id) as LineOrder;
  assert.ok(loaded, '重新预载后必须存在原待审报价单');
  assert.deepEqual(loaded.approval, pendingOnly.approval);
  const loadedApproved = store.getAnyOrder(renewed.id) as LineOrder;
  assert.ok(loadedApproved, '重新预载后必须存在原自动批准报价单');
  assert.equal(loadedApproved.approval!.auto, true);
  assert.strictEqual(await make(300, store.getSession(s.id)!), loaded);
  console.log('QUOTE RECOVERY PASS: 数据库存储审批历史持久化与预载后复用');
} finally {
  Date.now = realNow;
  __profileTest.reset();
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
