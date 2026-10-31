// 09 B：登记、渠道投影、网页标题与沙箱租户/方法边界。旅游逐字节等价另由 link-bytes 固定夹具守住。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixtureRuntime } from './packs/__fixture/runtime.js';
import type { ReplyGuardContext, Session } from './core/pack-api.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-links-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SERVER_SELFTEST: '1',
  PACK_FIXTURES: '1',
  PUBLIC_BASE_URL: 'https://shop.example.test',
});
const { hostRuntime, createTenantRuntime, registerRuntime, unregisterRuntime, withTenantScope } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const { currentPack } = await import('./config/source.js');
const travel = currentPack();
const { getOrCreateSession, createOrder, drainStore } = await import('./store.js');
const { partsOf, bindPack, linkWhitelistStep } = await import('./core/pack-api.js');
const { siteLinks, isSiteHtml } = await import('./core/site-links.js');
const { wxPage, wxResource, sandboxWechatIndex } = await import('./tenancy/sandbox/outbound.js');
const { sandboxApp } = await import('./tenancy/sandbox/process.js');
const { webReply } = await import('./adapters/web.js');
const { __test } = await import('./adapters/wecom.js');
const { packPipelines } = await import('./core/engine/pipelines.js');
const { Hono } = await import('hono');
const BASE = 'https://shop.example.test';
const quote = '/quote/ord_0123456789abcdef01234567';
const data = '/api/quotes/ord_0123456789abcdef01234567';
const session = getOrCreateSession('wecom:wmLinks', 'wecom');
const fixture = createFixtureRuntime();
const rt = createTenantRuntime({
  id: 'links-proof',
  slug: 'links-proof',
  kind: 'sandbox',
  publicBase: BASE,
  expiresAt: Date.now() + 3600000,
});
withTenantScope(rt, () => bindPack(fixture, fixture.defaultBrand));
registerRuntime(rt);
const travelRt = createTenantRuntime({
  id: 'links-travel',
  slug: 'links-travel',
  kind: 'sandbox',
  publicBase: BASE,
  expiresAt: Date.now() + 3600000,
});
travelRt.pack = travel;
registerRuntime(travelRt);
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
try {
  const { runtimeById } = await import('./packs/registry.js');
  const { packSources } = await import('./config/source.js');
  const industrialLinks = runtimeById('industrial', packSources())!.siteLinks![0]!;
  const seed = 'ord_seed_0123456789abcdef-0123456789abcdef01234567';
  assert.equal(industrialLinks.pattern.test(`/quote/${seed}`), true);
  for (const bad of [seed.slice(0, -1), `${seed}a`, seed.replace('seed_', 'seed-'), `${seed}/extra`, seed.toUpperCase()]) {
    assert.equal(industrialLinks.pattern.test(`/quote/${bad}`), false);
    assert.equal(industrialLinks.resources![0]!.pattern.test(`/api/quotes/${bad}`), false);
  }
  console.log('PASS 15 验收 6：种子报价及资源只认精确批次格式');
  // 模式与方法集合逐项对照 spec 沙箱清单，而不是只测几个正例。
  const rules = siteLinks().flatMap((def) => [
    { pattern: def.pattern.source, methods: ['GET', 'HEAD'] },
    ...(def.resources ?? []).map((r) => ({ pattern: r.pattern.source, methods: [...r.methods] })),
  ]);
  assert.deepEqual(rules, [
    { pattern: '^\\/privacy$', methods: ['GET', 'HEAD'] },
    { pattern: '^\\/pay\\/[A-Za-z0-9_-]+$', methods: ['GET', 'HEAD'] },
    { pattern: '^\\/api\\/orders\\/[A-Za-z0-9_-]+$', methods: ['GET', 'HEAD'] },
    { pattern: '^\\/api\\/orders\\/[A-Za-z0-9_-]+\\/pay$', methods: ['POST'] },
    { pattern: '^\\/proposal\\/[A-Za-z0-9_-]+(?:\\/[A-Za-z0-9_-]+)*$', methods: ['GET', 'HEAD'] },
    { pattern: '^\\/api\\/proposal\\/[A-Za-z0-9_-]+$', methods: ['GET', 'HEAD'] },
  ]);
  assert.deepEqual(partsOf(`${BASE}${quote}`, BASE, session), []);
  assert.equal(__test.extractCard(`${BASE}${quote}`, BASE, session), null);
  assert.equal(isSiteHtml('/PROPOSAL.html'), true);
  assert.equal(isSiteHtml('/quote.html'), false);
  assert.equal(isSiteHtml('/privacy.html'), false);
  const order = createOrder({
    sessionId: session.id,
    routeId: 'synthetic',
    routeTitle: '合成线路',
    travelers: 2,
    departDate: '2027-01-01',
    totalPrice: 2000,
  });
  const orderDef = siteLinks().find((d) => d.linkKind === 'order')!;
  assert.equal(orderDef.allowed(session, `/pay/${order.id}`), true);
  assert.equal(orderDef.allowed({ ...session, id: 'wecom:wmOther' }, `/pay/${order.id}`), false);
  order.supersededBy = 'ord_replacement';
  assert.equal(orderDef.allowed(session, `/pay/${order.id}`), false);
  delete order.supersededBy;

  bindPack(fixture, fixture.defaultBrand);
  const quoteDef = fixture.siteLinks![0]!;
  assert.equal(quoteDef.allowed(session, quote), false, '审批尚未实现时默认拒绝');
  assert.deepEqual(partsOf(quote, BASE, session), [{ kind: 'link', linkKind: 'quote', url: quote, title: '报价单' }]);
  assert.equal(__test.extractCard(`${BASE}${quote}`, BASE, session), null);
  // 本批用合成放行条件验证消费契约；不提前实现报价状态或页面。
  const liveDef = { ...quoteDef, allowed: (s: Session, p: string) => s.id === session.id && p === quote };
  fixture.siteLinks = [liveDef];
  assert.deepEqual(__test.extractCard(`${BASE}${quote}`, BASE, session), {
    title: '报价单',
    desc: '查看报价明细',
    url: `${BASE}${quote}`,
    raw: `${BASE}${quote}`,
  });
  assert.equal(__test.extractCard(`${BASE}${quote}`, BASE, { ...session, id: 'wecom:wmOther' }), null);
  assert.equal(__test.extractCard(`${BASE}${quote}\n${BASE}/pay/${order.id}`, BASE, session), null, '多卡不吞另一条链接');
  assert.deepEqual(partsOf('/privacy', BASE, session), [{ kind: 'link', linkKind: 'site', url: '/privacy' }]);
  for (const [input, expected] of [
    [quote, ''],
    [`就是这份报价单：${quote}`, '就是这份报价单，见下方卡片'],
    [`请点这里 👉 ${BASE}${quote} 👈`, '请点下方卡片'],
    [`费用明细：\n${quote}\n交期明天确认。`, '费用明细，见下方卡片。\n交期明天确认。'],
    [`就是这份报价单：${quote}，合计100元`, '就是这份报价单，见下方卡片，合计100元'],
    [`${quote}\n${BASE}${quote}\n/privacy`, '/privacy'],
    [`https://evil.example.test${quote}\n${quote}`, `https://evil.example.test${quote}`],
    [`${quote} ${quote}`, ''],
  ]) {
    const reply = webReply(input!, session);
    assert.equal(reply.text, expected, input);
    assert.deepEqual(reply.parts, partsOf(input!, BASE, session), '只改正文，保留部件字节');
  }
  assert.deepEqual(webReply(`站外 https://evil.example.test${quote}`, session), {
    text: `站外 https://evil.example.test${quote}`,
    parts: [],
  });
  fixture.siteLinks = [{ ...liveDef, partTitle: () => null }];
  assert.deepEqual(partsOf(quote, BASE, session), [{ kind: 'link', linkKind: 'quote', url: quote }]);
  assert.equal(webReply(quote, session).text, quote, '没有标题的部件不去正文');
  fixture.siteLinks = [liveDef];
  assert.equal(isSiteHtml('/quote.html'), true);
  assert.ok(packPipelines(fixture).reply.steps.some((s) => s.id === 'link_whitelist'));
  assert.deepEqual(
    packPipelines(travel.runtime).reply.steps.find((s) => s.id === 'link_whitelist')!.after,
    ['order_net'],
    '旅游保留原有修补步骤',
  );

  const clean = async (text: string, owner = session): Promise<string> => {
    const ctx = { text, session: owner, recordGuard() {} } as unknown as ReplyGuardContext;
    const verdict = await linkWhitelistStep().run(ctx);
    return verdict.action === 'pass' || verdict.action === 'abort' ? text : verdict.text;
  };
  assert.equal(await clean(`请点击这里查看：${BASE}${quote}。`), `请点击这里查看：${BASE}${quote}。`);
  assert.equal(await clean(`请点击这里查看：${BASE}${quote}。`, { ...session, id: 'wecom:wmOther' }), '');
  assert.equal(await clean('点这里 /unknown/item。\n明天确认交期。'), '明天确认交期。');
  assert.equal(await clean(`报价单：${BASE}/unknown/item。订单：/pay/missing。`), '');
  assert.equal(await clean(`请查看 https://evil.example.test${quote}。`), '');
  assert.equal(await clean(`查看 ${BASE}${quote}?redirect=//evil.test。`), '');
  assert.equal(await clean(`请查看 //evil.test${quote}。`), '');
  assert.equal(await clean(`请查看 javascript:${quote}。`), '');
  assert.equal(await clean(`交期明天确认，链接 ${BASE}/unknown/item。`), '交期明天确认，链接 。');
  assert.equal(await clean(`请查看。\n点这里 /unknown/item。`), '请查看。', '只删除删链接后悬空的引导语');
  assert.equal(await clean(`隐私说明 /privacy。\n点这里 /unknown/item。`), '隐私说明 /privacy。');

  // 执行正式 web.js 的真实渲染函数；标题以文本传给节点，缺省保持旧标题。
  const js = fs.readFileSync('public/web.js', 'utf8');
  const renderSource = js.slice(js.indexOf('  function renderParts('), js.indexOf('  function addMessage('));
  type Node = { text: string; children: Node[]; append(...nodes: Node[]): void };
  const node = (_tag: string, _class = '', text = ''): Node => ({
    text,
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
  });
  const render = new Function('node', `${renderSource}; return renderParts;`)(node) as (wrap: Node, parts: unknown[]) => void;
  const wrap = node('div');
  render(wrap, [...partsOf(quote, BASE, session), ...partsOf('/privacy', BASE, session)]);
  assert.equal(wrap.children[0]!.children[0]!.text, '报价单');
  assert.equal(wrap.children[1]!.children[0]!.text, '查看详情');
  render(wrap, [{ kind: 'link', linkKind: 'custom', url: '/custom', title: '<img src=x>' }]);
  assert.equal(wrap.children[2]!.children[0]!.text, '<img src=x>');

  // 真正的中间件只凭链接 cookie 分租户，不借全局种类并集放行。
  const tokens = ['F'.repeat(43), 'T'.repeat(43)];
  sandboxWechatIndex.publishLink(rt, tokens[0]!);
  sandboxWechatIndex.publishLink(travelRt, tokens[1]!);
  const app = sandboxApp(
    {
      health: async () => {
        throw new Error('不检查健康');
      },
      resolve: async () => ({ status: 'invalid' as const }),
      provision: async () => {
        throw new Error('不创建沙箱');
      },
      end: async () => {},
    },
    'shop.example.test',
    new Hono().get(quote, (c) => c.html('<html><body><script>void 0</script></body></html>')).all('*', (c) => c.json({ reached: true })),
  );
  for (const [tenant, token] of [
    [rt, tokens[0]],
    [travelRt, tokens[1]],
  ] as const) {
    for (const [pathname, methods] of [
      [quote, ['GET', 'HEAD']],
      [data, ['GET']],
    ] as const) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const allowed = tenant === rt && methods.some((m) => m === method);
        assert.equal(wxResource(pathname, method, tenant.pack.runtime), allowed);
        const res = await app.request(`${BASE}${pathname}`, {
          method,
          headers: { host: 'shop.example.test', cookie: `__Host-sbxw=${token}` },
        });
        assert.equal(res.status === 200, allowed, `${tenant.id} ${method} ${pathname}`);
        if (allowed && pathname === quote && method === 'GET')
          assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self' 'sha256-/);
      }
    }
    const res = await app.request(`${BASE}/wx/${token}${quote}`, { headers: { host: 'shop.example.test' } });
    assert.equal(res.status, tenant === rt ? 302 : 404);
    assert.equal(wxPage(quote, tenant.pack.runtime), tenant === rt);
    for (const bad of [`${quote}/extra`, '/quote/ord_bad', '/quote/ord_%30', `${data}/extra`])
      assert.equal(wxResource(bad, 'GET', tenant.pack.runtime), false);
  }
  await withTenantScope(travelRt, () => assert.deepEqual(partsOf(quote, BASE, session), []));
  console.log('SITE LINKS SELFTEST PASS: 登记清单、按租户卡片/部件隔离、可选标题、白名单删链/孤立引导语、沙箱 cookie 与显式方法');
} finally {
  bindPack(travel.runtime, travel.brand);
  sandboxWechatIndex.drop(rt.id);
  sandboxWechatIndex.drop(travelRt.id);
  unregisterRuntime(rt.id);
  unregisterRuntime(travelRt.id);
  await drainStore(5000);
}
