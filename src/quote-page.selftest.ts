// 09 R9：公开白名单、七态、重置历史、品牌转义与页面实际脚本三态。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { LineOrder, PublicQuote, AnyOrder } from './core/order-view.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-page-'));
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
  const { app } = await import('./server.js');
  const { handleMessage } = await import('./engine.js');
  const source = fs.readFileSync('public/quote.html', 'utf8');
  assert.doesNotMatch(source, /¥|\/pay\/|innerHTML/);
  assert.doesNotMatch(source.match(/<head>[\s\S]*?<\/head>/)![0], /totalText|totalFen|unitPrice/);
  let n = 0;
  for (const state of ['pending', 'approved', 'expired', 'paid', 'rejected', 'withdrawn', 'superseded'] as const) {
    const s = store.getOrCreateSession(`wecom:wmEPage${++n}`, 'wecom');
    const made = await createLineOrder(s, [{ kind: 'widget', code: 'w-page', qty: 100 }]);
    assert.ok('order' in made);
    const order: LineOrder = made.order;
    if (state !== 'pending') {
      order.approval!.state = state === 'rejected' || state === 'withdrawn' ? state : 'approved';
      order.approval!.decidedAt = Date.now() - (state === 'expired' ? 10 * 86400000 : 0);
      if (state === 'paid' || state === 'superseded') order.status = state;
      if (state === 'rejected' || state === 'withdrawn') order.status = 'cancelled';
      order.approval!.reason = '合成内部原因';
      store.saveOrder(order);
    }
    await store.flushSession(s.id);
    const res = await app.request(`/api/quotes/${order.id}`);
    assert.equal(res.status, 200);
    const quote = (await res.json()) as PublicQuote;
    assert.equal(quote.state, state === 'rejected' || state === 'withdrawn' ? 'invalid' : state);
    assert.equal(!!quote.display, state === 'approved' || state === 'paid');
    assert.doesNotMatch(JSON.stringify(quote), /sessionId|approval|合成内部原因|decidedBy/);
    if (state === 'approved') assert.ok(quote.validUntil! > Date.now());
    const page = await app.request(`/quote/${order.id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /合成&lt;方盒&gt;核验社/);
    if (state === 'approved') {
      const { createTenantRuntime, registerRuntime, unregisterRuntime } = await import('./tenancy/runtime.js');
      const { sandboxWechatIndex } = await import('./tenancy/sandbox/outbound.js');
      const { sandboxApp } = await import('./tenancy/sandbox/process.js');
      const sandbox = createTenantRuntime({
        id: 'quote-sandbox',
        slug: 'quote-sandbox',
        kind: 'sandbox',
        publicBase: 'https://shop.example.test',
        expiresAt: Date.now() + 3600000,
      });
      sandbox.pack = { ...rt.pack!, brand };
      (sandbox.store.orders as Map<string, AnyOrder>).set(order.id, order);
      registerRuntime(sandbox);
      const token = 'Q'.repeat(43);
      sandboxWechatIndex.publishLink(sandbox, token);
      try {
        const outer = sandboxApp(
          {
            health: async () => {
              throw new Error('unused');
            },
            resolve: async () => ({ status: 'invalid' as const }),
            provision: async () => {
              throw new Error('unused');
            },
            end: async () => {},
          },
          'shop.example.test',
          app,
        );
        const headers = { host: 'shop.example.test', cookie: `__Host-sbxw=${token}` };
        const response = await outer.request(`https://shop.example.test/api/quotes/${order.id}`, { headers });
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as PublicQuote).display!.totalFen, 120000);
        assert.notEqual((await outer.request(`https://shop.example.test/api/quotes/${order.id}`, { method: 'POST', headers })).status, 200);
      } finally {
        sandboxWechatIndex.withdraw(sandbox.id);
        unregisterRuntime(sandbox.id);
      }
    }
    const approval = structuredClone(order.approval);
    await handleMessage(s.id, '重置', 'wecom');
    await store.flushSession(s.id);
    assert.equal((await app.request(`/quote/${order.id}`)).status, 404);
    assert.equal((await app.request(`/api/quotes/${order.id}`)).status, 404);
    await t.pg.exec('RESET ROLE');
    const rows = await t.pg.query<{ data: LineOrder; void_reason: string }>(
      'select data,void_reason from orders where id=$1 and tenant_id=$2',
      [order.id, tenant.id],
    );
    assert.deepEqual(rows.rows[0]!.data.approval, approval);
    assert.equal(rows.rows[0]!.void_reason, 'reset');
    await t.pg.exec('SET ROLE agent_app');
  }
  // 重新预载仍不读回任何重置单。
  await store.drainStore(5000);
  rt.store.pgBackend!.close();
  rt.store.pgBackend = null;
  rt.store.sessions.clear();
  rt.store.orders.clear();
  await store.initSessionStore(fx.deps);
  assert.equal(store.listAnyOrders().length, 0);
  assert.equal((await app.request('/quote/ord_000000000000000000000000')).status, 404);
  const staticPage = await app.request('/quote.html');
  assert.equal(staticPage.status, 200);
  assert.match(await staticPage.text(), /合成&lt;方盒&gt;核验社/);
  class Element {
    textContent = '';
    hidden = false;
    disabled = false;
    className = '';
    children: Element[] = [];
    events = new Map<string, () => Promise<void>>();
    replaceChildren() {
      this.children = [];
    }
    append(...els: Element[]) {
      this.children.push(...els);
    }
    addEventListener(name: string, fn: () => Promise<void>) {
      this.events.set(name, fn);
    }
  }
  const elements = new Map<string, Element>();
  for (const id of ['status', 'valid', 'brand', 'details', 'notes', 'retry']) elements.set(id, new Element());
  let result: Response | Error = Response.json({
    state: 'approved',
    brandName: '合成品牌',
    validUntil: Date.now(),
    display: { lines: [{ title: '<script>合成', qtyText: '2件', unitPriceText: '12元', amountText: '24元' }], totalText: '24元' },
  });
  let release: (() => void) | undefined;
  vm.runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: (id: string) => elements.get(id), createElement: () => new Element() },
    location: { pathname: '/quote/ord_000000000000000000000001', search: '' },
    URLSearchParams,
    Intl,
    encodeURIComponent,
    fetch: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const settle = async () => {
    release!();
    await new Promise((resolve) => setImmediate(resolve));
  };
  assert.equal(elements.get('status')!.textContent, '加载中…');
  assert.equal(elements.get('retry')!.disabled, true);
  await settle();
  assert.equal(elements.get('details')!.children.at(-1)!.textContent, '合计 24元');
  for (const [response, label] of [
    [new Error('offline'), '加载失败，请重试'],
    [new Response('', { status: 404 }), '报价单不存在'],
    [Response.json({ state: 'pending', brandName: '合成' }), '报价单待审核'],
  ] as const) {
    result = response;
    const retry = elements.get('retry')!.events.get('click')!();
    assert.equal(elements.get('details')!.children.length, 0);
    await settle();
    await retry;
    assert.equal(elements.get('status')!.textContent, label);
    assert.equal(elements.get('details')!.children.length, 0);
  }
  console.log('QUOTE PAGE PASS: 七状态响应、全部重置404与DB历史、重载、品牌和页面加载/空/错/重试');
} finally {
  rt.store.pgBackend?.close();
  rt.store.fileBackend?.reset();
  if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
  if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
  await config.closeConfig();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
