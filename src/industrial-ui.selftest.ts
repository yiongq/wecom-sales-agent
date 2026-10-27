// 10 R16：真实双租户 Host 路由、页面品牌与旧版字节。仅一次性 PGlite，不监听、不调用模型。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelAccount } from './channels/accounts.js';
import type { AnyOrder, LineOrder } from './core/order-view.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-ui-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SERVER_SELFTEST: '1',
  LLM_MOCK: '1',
  PUBLIC_BASE_URL: 'https://travel.example.invalid',
  SANDBOX_HOST: 'sandbox.example.invalid',
});
const tenancy = await import('./tenancy/runtime.js');
const { installPublicHost } = await import('./tenancy/hosts.js');
const host = tenancy.hostRuntime();
const config = await import('./config/source.js');
const { app } = await import('./server.js');
const { openTestDb, installSeededConfig } = await import('./db/testing.js');
const { installAccounts } = await import('./channels/accounts.js');
const { renderBrandPage, brandTexts } = await import('./core/brand.js');
const db = await openTestDb();
const other = tenancy.createTenantRuntime({
  id: 'industrial-ui',
  slug: 'industrial-demo',
  publicBase: 'https://industrial.example.invalid',
});
tenancy.registerRuntime(other);
const request = (url: string, industrial = true, method = 'GET') =>
  app.request(url, {
    method,
    headers: { host: industrial ? 'industrial.example.invalid' : 'travel.example.invalid' },
  });
const travelWords = /旅行|旅游|行程|出行|目的地|方案书|云途|酒店|线路|西藏|云南|方盒核验社/;
try {
  await tenancy.withTenantScope(host, () => installSeededConfig(db));
  await db.pg.exec('RESET ROLE');
  await db.pg.query("insert into tenants (slug,name,pack_id,brand) values ('industrial-demo','合成工业','industrial',$1)", [
    fs.readFileSync('data/packs/industrial/brand.json', 'utf8'),
  ]);
  await tenancy.withTenantScope(other, () =>
    installSeededConfig(db, {
      slug: 'industrial-demo',
      dataDir: 'data/packs/industrial',
      deps: {
        usePackRuntime: true,
        imageDataDir: 'data/packs/industrial',
        imageSop: fs.readFileSync('data/packs/industrial/sop.md', 'utf8'),
      },
    }),
  );
  installPublicHost(host, 'travel.example.invalid');
  installPublicHost(other, 'industrial.example.invalid');
  tenancy.configureTenancy({ role: 'host', standardCount: 2 });
  const accounts: ChannelAccount[] = [host, other].map((rt) => ({
    id: `web-${rt.slug}`,
    tenantId: rt.id,
    key: 'rfq',
    kind: 'web',
    name: '合成渠道',
    status: 'active',
    source: 'db',
    wecom: null,
    web: { title: rt === host ? '旅游演示' : '衡石工业品', dailyNewConversations: 10, dailyTurns: 10 },
    inactiveReason: null,
  }));
  installAccounts(accounts);
  const binding = other.pack!;
  const brand = binding.brand!;
  const quote: LineOrder = {
    v: 2,
    id: 'ord_1234567890abcdef12345678',
    sessionId: 'web-ui',
    status: 'pending_payment',
    lines: [{ kind: 'part', code: 'bearing-02', title: '合成轴承', qty: 2, unit: '个', unitPriceFen: 1000, amountFen: 2000 }],
    totalFen: 2000,
    createdAt: Date.now(),
    approval: { state: 'pending', requestedAt: Date.now() },
  };
  (other.store.orders as Map<string, AnyOrder>).set(quote.id, quote);
  // 构建前用最小壳核对托管；构建后运行会直接核对真实产物。
  if (!fs.existsSync('console/dist/index.html')) {
    process.env.CONSOLE_DIST = path.join(dir, 'console');
    fs.mkdirSync(process.env.CONSOLE_DIST);
    fs.writeFileSync(
      path.join(process.env.CONSOLE_DIST, 'index.html'),
      '<!doctype html><html><head><title>AI销售工作台</title></head><body><div id="root"></div></body></html>',
    );
  }
  const expected = new Map([
    ['/', 302],
    ['/try', 302],
    ['/w/rfq', 200],
    [`/quote/${quote.id}`, 200],
    ['/quote.html', 200],
    ['/pay.html', 404],
    ['/proposal.html', 404],
    ['/proposal/missing', 404],
    ['/privacy.html', 404],
    ['/chat.html', 404],
    ['/admin.html', 404],
    ['/web.html', 404],
    ['/try.html', 200],
    ['/console/', 200],
    ['/console/login', 200],
    ['/api/console/entry', 200],
    ['/api/console/pack', 200],
    ['/api/console/me', 401],
  ]);
  for (const [url, status] of expected) {
    const res = await request(url);
    assert.equal(res.status, status, url);
    const body = await res.text();
    assert.doesNotMatch(body, travelWords, url);
    assert.doesNotMatch(body, /login-showcase\.png|share-cover\.png/, url);
    console.log(`PASS industrial Host ${url}: ${status}, 无旅游残留`);
  }
  for (const url of ['/PAY.html', '/%70ay.html', '/pay.html/', '/WEB.html', '/%77eb.html', '/web.html/']) {
    assert.equal((await request(url)).status, 404, url);
    assert.equal((await request(url, true, 'HEAD')).status, 404, `HEAD ${url}`);
  }
  for (const url of [`/pay/${quote.id}`, `/api/orders/${quote.id}`, `/api/orders/${quote.id}/pay`])
    assert.equal((await request(url, true, url.endsWith('/pay') ? 'POST' : 'GET')).status, 404, url);
  assert.equal((await request(`/pay.html?orderId=${quote.id}`)).status, 404);
  // 09 R4：包有审批能力也不能阻断既有不带审批通用单，测试后移除这张兼容夹具。
  const { approval: _approval, ...ordinary } = quote;
  (other.store.orders as Map<string, AnyOrder>).set(quote.id, ordinary);
  assert.equal((await request(`/pay.html?orderId=${quote.id}`)).status, 200);
  (other.store.orders as Map<string, AnyOrder>).set(quote.id, quote);
  assert.equal((await app.request('/api/console/entry', { headers: { host: 'unknown.invalid' } })).status, 404);
  const web = await (await request('/w/rfq')).text();
  assert.match(web, /AI 询价顾问 · 可转真人/);
  assert.match(web, /placeholder="请告诉我型号和数量…"/);
  const webConfig = JSON.parse(/id="web-config">([\s\S]*?)<\/script>/.exec(web)![1]!);
  assert.equal((webConfig.welcome.match(/虚构/g) ?? []).length, 1);
  assert.match(webConfig.welcome, /AI/);
  assert.match(webConfig.welcome, /人工/);
  for (const url of [`/quote/${quote.id}`, '/quote.html']) {
    const html = await (await request(url)).text();
    assert.match(html, /<title>报价单 · 衡石工业品（虚构）<\/title>/);
    assert.match(html, /property="og:title" content="报价单 · 衡石工业品（虚构）"/);
  }
  const custom = { ...brand, brandName: '合成<商家>"&', aiTitle: 'AI <顾问>' };
  for (const page of ['web', 'quote']) {
    const html = renderBrandPage(fs.readFileSync(`public/${page}.html`, 'utf8'), page, binding.runtime, custom);
    assert.doesNotMatch(html, travelWords);
    assert.doesNotMatch(html, /合成<商家>|AI <顾问>/);
    assert.match(html, page === 'web' ? /AI &lt;顾问&gt;/ : /合成&lt;商家&gt;&quot;&amp;/);
  }
  const noSlots = { ...binding.runtime, templates: { ...binding.runtime.templates, pages: {} } };
  const neutral = renderBrandPage(fs.readFileSync('public/web.html', 'utf8'), 'web', noSlots, brand);
  assert.match(neutral, /请描述您的需求…/);
  assert.doesNotMatch(neutral, travelWords);
  assert.equal((brandTexts(binding.runtime, brand).webWelcome.match(/虚构/g) ?? []).length, 1);
  // 旅游品牌为空：静态 HTML 与网页 HTML（仅注入配置）必须与原文件逐字相同。
  assert.equal(host.pack!.brand, null);
  for (const page of ['pay', 'proposal', 'chat', 'web']) {
    assert.equal(await (await request(`/${page}.html`, false)).text(), fs.readFileSync(`public/${page}.html`, 'utf8'), page);
  }
  const travelWeb = await (await request('/w/rfq', false)).text();
  assert.equal(
    travelWeb.replace(/(<script type="application\/json" id="web-config">)[\s\S]*?(<\/script>)/, '$1__WEB_CONFIG__$2'),
    fs.readFileSync('public/web.html', 'utf8'),
  );
  const travelEntry = JSON.stringify({
    tryUrl: '/try',
    showcase: { src: '/login-showcase.png', alt: '企业微信会话示例：客户问云南6日游，AI推荐线路并报价；另一位客户在等人接手' },
  });
  const industrialBrand = { name: brand.brandName, subtitle: brand.aiTitle, image: null };
  // 同一进程交错 Host：不串公开投影、不泄露品牌内部成员，空品牌连键也不增加。
  for (const industrial of [true, false, true, false]) {
    const entry = await request('/api/console/entry', industrial);
    assert.equal(entry.headers.get('cache-control'), 'no-store');
    const raw = await entry.text();
    if (industrial) assert.deepEqual(JSON.parse(raw), { tryUrl: '/try', showcase: null, brand: industrialBrand });
    else {
      assert.equal(raw, travelEntry);
      assert.equal(Object.hasOwn(JSON.parse(raw), 'brand'), false);
    }
  }
  const published = tenancy.withTenantScope(other, config.currentSop);
  tenancy.withTenantScope(other, () => config.replacePublishedSop({ ...published, versionNo: published.versionNo + 1, brand: custom }));
  try {
    const entry = await request('/api/console/entry');
    assert.match(entry.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await entry.json(), {
      tryUrl: '/try',
      showcase: null,
      brand: { name: custom.brandName, subtitle: custom.aiTitle, image: null },
    });
    assert.equal(await (await request('/api/console/entry', false)).text(), travelEntry);
  } finally {
    tenancy.withTenantScope(other, () => config.replacePublishedSop({ ...published, versionNo: published.versionNo + 2 }));
  }
  const { __profileTest } = await import('./profile.js');
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    assert.deepEqual(await (await request('/api/console/entry')).json(), {
      tryUrl: null,
      showcase: null,
      brand: industrialBrand,
    });
    assert.equal((await request('/api/console/pack')).status, 401);
  } finally {
    __profileTest.reset();
  }
  const { __privacyTest } = await import('./privacy/privacy.js');
  const { consentMenuText } = await import('./handoff/consent.js');
  tenancy.withTenantScope(other, () => {
    __privacyTest.set({ version: 1, body: '合成工业隐私说明' });
    for (const category of ['health', 'minor'] as const) {
      const text = consentMenuText(category);
      assert.doesNotMatch(text, travelWords);
      assert.match(text, /您可以随时撤回。不提供也能继续咨询/);
      assert.match(text, /https:\/\/industrial\.example\.invalid\/privacy/);
    }
  });
  const privacy = await request('/privacy');
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /合成工业隐私说明/);
  tenancy.withTenantScope(other, __privacyTest.reset);
  console.log('INDUSTRIAL UI PASS: Host隔离、公开页面、品牌转义、中性缺省、欢迎语、旅游HTML/入口逐字节');
} finally {
  installAccounts([]);
  for (const rt of [host, other]) await tenancy.withTenantScope(rt, config.closeConfig);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
