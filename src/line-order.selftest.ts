// 08 第 9 步：确定性计价、金额注入隔离、整单拒绝、复用/作废与退款边界；PGlite 必跑。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PackRuntime, RefundTerms } from './core/pack-api.js';
import type { LinePick } from './core/order-view.js';

if (process.argv[2] !== 'worker') {
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
    env: { ...process.env, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-order-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('./db/testing.js'));
  const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
  const { bindPack } = await import('./core/pack-api.js');
  const { currentCatalog, packSources, closeConfig, __configTest } = await import('./config/source.js');
  const { packById, runtimeById, validatePackCatalog } = await import('./packs/registry.js');
  const { checkItem } = await import('./shared/pack.js');
  const { createCatalogItem, activateCatalogItem, updateCatalogItem } = await import('./config/catalog.js');
  const { catalogMoneyValues } = await import('./shared/catalog-money.js');
  const { createLineOrder, isLineOrder, orderDisplay } = await import('./core/order-view.js');
  const { quoteRefund } = await import('./core/refund.js');
  const { requestRefund, approveRefund, rejectRefund, settleRefund } = await import('./payment/refunds.js');
  const { OrderStateError } = await import('./payment/orders.js');
  const store = await import('./store.js');
  const { withTenant } = await import('./db/client.js');
  const { readLiveOrders } = await import('./db/repo/orders.js');
  const t = await testing.openTestDb();
  try {
    await testing.installSeededConfig(t);
    const travel = rt.config.loaded!;
    await t.pg.exec('RESET ROLE');
    const tenant = await createFixtureTenant(t.db);
    const pack = packById(tenant.packId)!;
    const runtime = runtimeById(pack.id, packSources())!;
    identifyRuntime(rt, {
      id: tenant.id,
      slug: tenant.slug,
      kind: rt.kind,
      isHost: rt.isHost,
      publicBase: rt.publicBase,
      expiresAt: rt.expiresAt,
    });
    validatePackCatalog(pack, runtime);
    const price = runtime.priceLine!;
    rt.config.loaded = {
      ...travel,
      tenantId: tenant.id,
      tenantName: tenant.name,
      pack,
      deps: { ...travel.deps, tenantSlug: tenant.slug },
      catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
      ords: {},
      history: new Map(),
    };
    bindPack(runtime, runtime.defaultBrand);
    const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
    await store.initSessionStore(fx.deps);
    const s = store.getOrCreateSession('wecom:wmline', 'wecom');
    store.saveSession(s);
    const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const a = {
      id: 'w-a',
      title: '合成方盒甲',
      unitPrice: 3.8,
      unit: '件',
      tags: ['合成'],
      moq: 10,
      tiers: [
        { minQty: 500, unitPrice: 3.5 },
        { minQty: 100, unitPrice: 3.65 },
      ],
    };
    const b = { id: 'w-b', title: '合成方盒乙', unitPrice: 12, unit: '件', tags: ['合成'], moq: 5 };
    const schema = runtime.catalog.widget!.schema;
    for (const payload of [a, b]) {
      assert.equal(schema.safeParse(payload).success, true);
      assert.deepEqual(checkItem(pack.entities[0]!, payload).required, []);
      const row = await createCatalogItem(ctx, 'widget', payload);
      await activateCatalogItem(ctx, 'widget', row.code, { rev: row.rev });
    }
    await createCatalogItem(ctx, 'widget', { ...b, id: 'w-draft' });
    for (const payload of [
      { ...a, tiers: [{ minQty: 100, unitPrice: 3.655 }] },
      { ...a, tiers: [{ minQty: 0, unitPrice: 3.65 }] },
      { ...a, moq: 1.5 },
    ]) {
      assert.equal(schema.safeParse(payload).success, false);
      assert.ok(checkItem(pack.entities[0]!, payload).required.length);
    }
    assert.deepEqual(catalogMoneyValues(a, runtime.catalog.widget!.moneyFields), [3.8, 3.5, 3.65]);
    for (const [qty, fen] of [
      [10, 380],
      [99, 380],
      [100, 365],
      [499, 365],
      [500, 350],
      [100000, 350],
    ]) {
      assert.deepEqual(price(a, qty!, { kind: 'widget', session: s }), { unitPriceFen: fen, unit: '件' });
    }
    assert.deepEqual(price({ ...b, unit: '盒' }, 5, { kind: 'widget', session: s }), { unitPriceFen: 1200, unit: '盒' });
    assert.deepEqual(
      price(
        {
          ...a,
          tiers: [
            { minQty: 100, unitPrice: 4 },
            { minQty: 100, unitPrice: 3.65 },
          ],
        },
        100,
        { kind: 'widget', session: s },
      ),
      { unitPriceFen: 365, unit: '件' },
    );
    assert.deepEqual(price(a, 9, { kind: 'widget', session: s }), { reject: 'below_moq', detail: { moq: 10 } });
    console.log('LINE PRICE PASS：两档阈值、乱序取最低档价、缺省价格、单位、起订量与字段/schema/moneyFields 一致');

    const picks: LinePick[] = [
      { kind: 'widget', code: 'w-a', qty: 200 },
      { kind: 'widget', code: 'w-b', qty: 50 },
    ];
    const injected = picks.map((pick) => ({ ...pick, unitPriceFen: 1, amountFen: 1, totalFen: 1 }));
    const first = await createLineOrder(s, injected);
    assert.ok('order' in first);
    const order = first.order;
    assert.equal(first.reused, false);
    assert.match(order.id, /^ord_[0-9a-f]{24}$/);
    assert.equal(order.totalFen, 133000);
    assert.deepEqual(
      order.lines.map((line) => [line.title, line.version, line.unitPriceFen, line.amountFen]),
      [
        ['合成方盒甲', currentCatalog().versions['widget:w-a'], 365, 73000],
        ['合成方盒乙', currentCatalog().versions['widget:w-b'], 1200, 60000],
      ],
    );
    assert.ok(!Object.hasOwn(order.lines[0], 'totalFen'));
    assert.deepEqual(s.orderIds, [order.id]);
    await store.flushSession(s.id);
    const rows = () => withTenant(fx.deps.db, ctx, (tx) => readLiveOrders(tx, [s.id]));
    let saved = (await rows()).find((row) => row.id === order.id)!;
    assert.equal(saved.totalFen, 133000);
    assert.equal(saved.totalPrice, 1330);
    assert.deepEqual(saved.data, order);
    const again = await Promise.all([createLineOrder(s, picks.toReversed()), createLineOrder(s, picks)]);
    for (const result of again) {
      assert.ok('order' in result);
      assert.strictEqual(result.order, order);
      assert.equal(result.reused, true);
    }
    const changedPicks = [{ ...picks[0]!, qty: 201 }, picks[1]!];
    const changed = await createLineOrder(s, changedPicks);
    assert.ok('order' in changed);
    assert.equal(changed.reused, false);
    assert.equal(changed.order.totalFen, 133365);
    assert.equal(order.status, 'superseded');
    assert.equal(order.supersededBy, changed.order.id);
    await store.flushSession(s.id);
    saved = (await rows()).find((row) => row.id === order.id)!;
    assert.equal(saved.status, 'superseded');
    assert.equal(saved.data.supersededBy, changed.order.id);
    assert.equal((await rows()).filter((row) => row.status === 'pending_payment').length, 1);

    const tool = runtime.tools.find((entry) => entry.def.function.name === 'fixture_order')!;
    assert.deepEqual(tool.sideEffects, ['session', 'order']);
    assert.equal(tool.cacheable, false);
    assert.equal(tool.blocksRetry, true);
    const toolSession = store.getOrCreateSession('wecom:wmtool', 'wecom');
    const toolContext = { session: toolSession, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
    const result = JSON.parse(await tool.execute({ lines: injected, unitPriceFen: 0, amountFen: 0, totalFen: 0 }, toolContext));
    const toolOrder = store.getAnyOrder(result.orderId)!;
    assert.ok(isLineOrder(toolOrder));
    assert.equal(toolOrder.totalFen, 133000);
    assert.deepEqual(result.display, orderDisplay(toolOrder));
    assert.match(result.text, /1,330元/);
    await store.flushSession(toolSession.id);
    assert.equal(JSON.parse(await tool.execute({ lines: injected.toReversed() }, toolContext)).reused, true);
    assert.ok(JSON.parse(await tool.execute({ lines: null }, toolContext)).error);
    console.log('LINE ORDER PASS：函数与工具均为 365/1200 分、133000分/1330元落库；金额注入丢弃；乱序并发复用、改单作废落库');

    const before = JSON.stringify([s.orderIds, store.listAnyOrders()]);
    const reject = await createLineOrder(s, [
      { kind: 'widget', code: 'w-a', qty: 9 },
      { kind: 'widget', code: 'w-b', qty: 4 },
      { kind: 'route', code: 'w-a', qty: 1 },
      { kind: 'constructor', code: 'w-a', qty: 1 },
      { kind: 'widget', code: 'w-draft', qty: 5 },
      { kind: 'widget', code: 'missing', qty: 5 },
      ...[0, 1.5, 100001].map((qty) => ({ kind: 'widget', code: 'w-b', qty })),
      picks[0]!,
    ]);
    assert.ok('rejected' in reject);
    assert.deepEqual(
      reject.rejected.map((row) => row.reason),
      [
        'below_moq',
        'below_moq',
        'kind_unknown',
        'kind_unknown',
        'item_inactive',
        'item_inactive',
        'invalid_qty',
        'invalid_qty',
        'invalid_qty',
      ],
    );
    assert.deepEqual(
      reject.rejected.slice(0, 2).map((row) => row.detail),
      [{ moq: 10 }, { moq: 5 }],
    );
    assert.equal(JSON.stringify([s.orderIds, store.listAnyOrders()]), before);
    assert.ok('rejected' in (await createLineOrder(s, [])));
    bindPack({ ...runtime, maxQty: 49 }, runtime.defaultBrand);
    assert.deepEqual(await createLineOrder(s, [picks[1]!]), { rejected: [{ kind: 'widget', code: 'w-b', reason: 'invalid_qty' }] });
    for (const maxQty of [0, 1.5, Infinity]) {
      bindPack({ ...runtime, maxQty }, runtime.defaultBrand);
      await assert.rejects(createLineOrder(s, picks), /maxQty 无效/);
    }
    const badPrices = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER];
    for (const unitPriceFen of badPrices) {
      bindPack({ ...runtime, priceLine: () => ({ unitPriceFen, unit: '件' }) }, runtime.defaultBrand);
      await assert.rejects(createLineOrder(s, picks), /priceLine.*金额无效/);
    }
    // 每行合法，合计溢出也不能建单。
    bindPack({ ...runtime, priceLine: () => ({ unitPriceFen: Number.MAX_SAFE_INTEGER, unit: '件' }) }, runtime.defaultBrand);
    await assert.rejects(
      createLineOrder(s, [
        { kind: 'widget', code: 'w-b', qty: 1 },
        { kind: 'widget', code: 'w-b', qty: 1 },
      ]),
      /金额无效/,
    );
    bindPack({ ...runtime, priceLine: undefined }, runtime.defaultBrand);
    await assert.rejects(createLineOrder(s, picks), /未提供 priceLine/);
    assert.equal(JSON.stringify([s.orderIds, store.listAnyOrders()]), before);
    bindPack(runtime, runtime.defaultBrand);
    console.log('LINE REJECTION PASS：逐行拒绝含 moq 明细，整单无写入；kind/active/数量/上限与安全整数护栏');

    const terms: RefundTerms = {
      selfService: true,
      approvalThresholdYuan: 30000,
      tiers: [{ id: 'far', minDays: 0, maxDays: null, percent: 100 }],
    };
    const refundQuote = { orderId: toolOrder.id, daysBefore: 30, tier: terms.tiers[0]!, amount: 1330, policyHash: 'synthetic' };
    for (const status of ['pending_payment', 'paid', 'cancelled', 'superseded'] as const) {
      toolOrder.status = status;
      toolOrder.paidAt = 100;
      assert.deepEqual(quoteRefund(toolOrder, terms, 'synthetic', '2026-11-01'), { ineligible: 'not_paid' });
      assert.throws(() => requestRefund(refundQuote, terms), OrderStateError);
    }
    const actor = { userId: null, name: '合成主管', role: 'supervisor' as const };
    await assert.rejects(approveRefund(toolOrder.id, actor), OrderStateError);
    await assert.rejects(rejectRefund(toolOrder.id, actor, '合成拒绝'), OrderStateError);
    await assert.rejects(settleRefund(toolOrder.id, actor), OrderStateError);
    toolOrder.status = 'paid';
    store.saveOrder(toolOrder);
    await store.flushSession(toolSession.id);
    assert.equal((await withTenant(fx.deps.db, ctx, (tx) => readLiveOrders(tx, [toolSession.id])))[0]!.status, 'paid');
    console.log('LINE REFUND PASS：报价 ineligible，申请与后台退款动作 OrderStateError，通用单未进入退款状态');

    // 同数量但确定性价格变更时须重建；已付的其他会话不受影响。
    const row = await updateCatalogItem(ctx, 'widget', 'w-b', { rev: 2, set: { unitPrice: 12.01 } });
    assert.ok(row);
    const repriced = await createLineOrder(s, changedPicks);
    assert.ok('order' in repriced && !repriced.reused);
    assert.equal(repriced.order.lines[1]!.unitPriceFen, 1201);
    assert.equal(changed.order.status, 'superseded');
    assert.equal(toolOrder.status, 'paid');
    const attrsRuntime: PackRuntime = {
      ...runtime,
      priceLine: (item, qty, context) => ({ ...price(item, qty, context), attrs: { note: '合成属性' } }),
    };
    bindPack(attrsRuntime, runtime.defaultBrand);
    const attrSession = store.getOrCreateSession('wecom:wmattrs', 'wecom');
    const withAttrs = await createLineOrder(attrSession, [picks[1]!]);
    assert.ok('order' in withAttrs);
    assert.deepEqual(withAttrs.order.lines[0].attrs, { note: '合成属性' });
    await store.flushSession(attrSession.id);
    await store.flushSession(s.id);
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(fx.deps);
    const loaded = store.getSession(s.id)!;
    const afterReload = await createLineOrder(loaded, changedPicks.toReversed());
    assert.ok('order' in afterReload && afterReload.reused);
    assert.equal(afterReload.order.id, repriced.order.id);
    assert.equal(store.getAnyOrder(order.id)!.status, 'superseded');
    assert.equal(store.getAnyOrder(toolOrder.id)!.status, 'paid');
    console.log('LINE RECOVERY PASS：改价重建、属性快照、已付单保护、PGlite 预载后继续复用');
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
  process.exit(0);
}
