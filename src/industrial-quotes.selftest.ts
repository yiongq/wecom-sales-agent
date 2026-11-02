// 10 R6 / R7 / R13：实际工具、引擎、工作台动作、公开路由和存储；只桩模型策略与发送边界。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { industrial } from './packs/industrial/console-pack.js';
import { industrialFollowupGuard } from './packs/industrial/guards.js';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
import { defaultIndustrialPolicy, quoteNotes } from './packs/industrial/policy.js';
import { writeState, readState, draftParts, StateSchema } from './packs/industrial/state.js';
import { latestQuoteCandidate } from './packs/industrial/quote-candidate.js';
import type { LineOrder, Session, TurnToolContext, ChatOptions } from './core/pack-api.js';
import type { PublicQuote, AnyOrder } from './core/order-view.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-quotes-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SERVER_SELFTEST: '1',
  PUBLIC_BASE_URL: 'https://shop.example.test',
});
const tenancy = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = tenancy.hostRuntime();
enterTenantScopeForTest(rt);
const testing = await tenancy.withoutTenantScope(() => import('./db/testing.js'));
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack, createLineOrder, partsOf, quoteState } = await import('./core/pack-api.js');
await import('./core/engine/sources.js');
const { insertTenant } = await import('./db/repo/tenants.js');
const { createCatalogItem, activateCatalogItem, updateCatalogItem } = await import('./config/catalog.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { withTenant, queryCount } = await import('./db/client.js');
const { readPublishedSop } = await import('./db/repo/sop.js');
const t = await testing.openTestDb();
const realNow = Date.now;
let now = Date.parse('2026-10-26T04:00:00Z');
let mockAction: (opts: ChatOptions) => Promise<string> = async () => '请告诉我型号和数量';
try {
  await testing.installSeededConfig(t);
  await t.pg.exec('RESET ROLE');
  const runtime = createIndustrialRuntime(config.packSources());
  const brand = { ...runtime.defaultBrand, brandName: '合成零件商店' };
  const tenant = await insertTenant(t.db, {
    slug: 'industrial-quotes',
    name: '合成工业报价租户',
    packId: 'industrial',
    locale: 'zh-CN',
    region: 'CN',
    brand,
  });
  tenancy.identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: rt.isHost,
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
    sop: { ...original.sop, brand, policy: defaultIndustrialPolicy },
  };
  runtime.mock = { chat: (opts) => mockAction(opts) };
  bindPack(runtime, brand);
  const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const { app } = await import('./server.js');
  const { handleMessage } = await import('./core/engine/index.js');
  const actions = await import('./payment/orders.js');
  const takeover = await import('./handoff/takeover.js');
  const sent: { id: string; text: string }[] = [];
  takeover.setReplyTransport(async (id, text) => {
    sent.push({ id, text });
    return true;
  });
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const actor = { userId: null, name: '合成顾问', role: 'supervisor' as const };
  const data = {
    id: 'part-a',
    partNo: '6205-2RS',
    name: '深沟球轴承',
    brand: '合成品牌',
    category: '轴承',
    specs: ['内径25mm'],
    unit: '件',
    unitPrice: 8,
    moq: 1,
    stock: 1000,
    leadDays: 7,
  };
  const draft = await createCatalogItem(ctx, 'part', data);
  let active = await activateCatalogItem(ctx, 'part', draft.code, { rev: draft.rev });
  const b = await createCatalogItem(ctx, 'part', { ...data, id: 'part-b', partNo: '6205-ZZ', substitutes: [data.partNo] });
  await activateCatalogItem(ctx, 'part', b.code, { rev: b.rev });
  Date.now = () => now;
  let sequence = 0;
  const fresh = () => store.getOrCreateSession(`wecom:wmIQ${++sequence}`, 'wecom');
  const registry = createToolRegistry(runtime.tools);
  const context = (session: Session): TurnToolContext => ({ session, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false });
  const estimate = async (session: Session, qty = 100) =>
    JSON.parse(await registry.execute('quote_items', { items: [{ query: data.partNo, qty }] }, context(session)));
  const make = async (session: Session, qty = 100) => {
    now++;
    const result = JSON.parse(await registry.execute('create_quote_sheet', { items: [{ code: data.id, qty }] }, context(session)));
    return { result, order: store.getAnyOrder(session.packState!.lastQuoteId as string) as LineOrder };
  };
  const setPolicy = (patch: Partial<typeof defaultIndustrialPolicy>) => {
    rt.config.loaded!.sop = { ...rt.config.loaded!.sop, policy: { ...defaultIndustrialPolicy, ...patch } };
  };
  const getQuote = async (id: string) => {
    const response = await app.request(`/api/quotes/${id}`);
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? ((await response.json()) as PublicQuote)
        : ({} as PublicQuote),
    };
  };
  const jobs = async (id: string) => {
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    return t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<{ n: number }>("select count(*)::int as n from jobs where payload->>'orderId'=$1", [id])).rows[0]!.n;
    });
  };
  const sourceQueries = queryCount();
  assert.equal(config.packSources().currentPolicy().policy, rt.config.loaded!.sop.policy);
  assert.equal((await import('./core/engine/sources.js')).packSources().currentPolicy().policy, rt.config.loaded!.sop.policy);
  assert.equal(queryCount(), sourceQueries, '读取已发布内存政策不查库');
  // 默认人审 → 实际人工批准 → 相同行项重复建单；复用原 approved，不重审或通知。
  const manual = fresh();
  await estimate(manual);
  const pending = await make(manual);
  assert.deepEqual(pending.result, { state: 'pending' });
  assert.equal(pending.order.totalFen, 80000);
  assert.deepEqual(await getQuote(pending.order.id).then((value) => Object.keys(value.body).toSorted()), ['brandName', 'id', 'state']);
  const pendingJobs = await jobs(pending.order.id);
  assert.equal(pendingJobs, 1);
  assert.deepEqual((await make(manual)).result, { state: 'pending' });
  assert.equal(manual.orderIds.length, 1);
  assert.equal(await jobs(pending.order.id), pendingJobs);
  now++;
  await actions.approveQuote(pending.order.id, actor);
  assert.equal(manual.stage, 'closing');
  assert.equal(sent.filter((message) => message.text.includes(pending.order.id)).length, 1);
  const lineBytes = JSON.stringify(pending.order.lines);
  const approvedLink = `/quote/${pending.order.id}`;
  let autoCalls = 0;
  const originalAuto = runtime.quotes!.autoApprovable!;
  runtime.quotes!.autoApprovable = (...args) => {
    autoCalls++;
    return originalAuto(...args);
  };
  const reused = await make(manual);
  assert.deepEqual(reused.result, { state: 'approved', quoteUrl: approvedLink, totalText: '800元' });
  assert.equal(reused.order.id, pending.order.id);
  assert.equal(autoCalls, 0);
  assert.equal(manual.orderIds.length, 1);
  assert.equal(await jobs(pending.order.id), pendingJobs);
  assert.equal(sent.filter((message) => message.text.includes(pending.order.id)).length, 1);
  const coreReuse = await createLineOrder(manual, [{ kind: 'part', code: data.id, qty: 100 }], { approval: true });
  assert.ok('order' in coreReuse);
  assert.equal(coreReuse.reused, true);
  assert.equal(coreReuse.order.id, pending.order.id);
  console.log('INDUSTRIAL REUSE PASS: 默认人审、pending复用、人工批准、approved复用原id/链接/金额，不重审/通知');

  {
    const id = 'ord_seed_0123456789abcdef-0123456789abcdef01234567';
    const seed = structuredClone(store.getAnyOrder(pending.order.id)!) as LineOrder;
    seed.id = id;
    (rt.store.orders as unknown as Map<string, AnyOrder>).set(id, seed);
    const def = runtime.siteLinks![0]!;
    assert.equal(def.pattern.test(`/quote/${id}`), true);
    assert.equal(def.resources![0]!.pattern.test(`/api/quotes/${id}`), true);
    assert.equal(def.allowed(manual, `/quote/${id}`), true);
    assert.equal(def.allowed({ ...manual, id: 'wecom:wmOther' }, `/quote/${id}`), false);
    seed.approval!.state = 'pending';
    assert.equal(def.allowed(manual, `/quote/${id}`), false);
    rt.store.orders.delete(id);
    console.log('PASS 15 验收 6：精确种子报价格式仍校验关联会话与审批状态');
  }
  // 新建自动批准三个条件分别失败；实际当前库存无法读取时也不放行。
  setPolicy({ autoApproveMaxFen: 100000 });
  const auto = fresh();
  await estimate(auto);
  const approved = await make(auto);
  assert.equal(approved.result.state, 'approved');
  assert.equal(approved.order.totalFen, 80000);
  assert.equal(approved.order.approval!.auto, true);
  assert.equal(await jobs(approved.order.id), 0);
  for (const mode of ['threshold', 'stock', 'ambiguous', 'missing-draft'] as const) {
    const session = fresh();
    if (mode !== 'missing-draft') await estimate(session);
    if (mode === 'threshold') setPolicy({ autoApproveMaxFen: 79999 });
    if (mode === 'stock') active = await updateCatalogItem(ctx, 'part', data.id, { rev: active.rev, set: { stock: 99 } });
    if (mode === 'ambiguous') writeState(session, { rfqDraft: { at: now, lines: [{ match: 'ambiguous', qty: 100 }] } });
    const made = await make(session);
    assert.equal(made.result.state, 'pending', mode);
    setPolicy({ autoApproveMaxFen: 100000 });
    if (mode === 'stock') active = await updateCatalogItem(ctx, 'part', data.id, { rev: active.rev, set: { stock: 1000 } });
  }
  const inaccessible = { ...config.packSources(), currentCatalog: () => ({ ...config.currentCatalog(), items: {} }) };
  assert.equal(createIndustrialRuntime(inaccessible).quotes!.autoApprovable!(approved.order, auto), false);
  console.log('INDUSTRIAL AUTO PASS: 800元/1000元阈值、全现货、exact批准；三条件各自失败及读不到库存均待审');

  const link = runtime.siteLinks![0]!;
  assert.equal(link.allowed(auto, approved.result.quoteUrl), true);
  assert.equal(link.allowed(manual, approved.result.quoteUrl), false);
  assert.equal(link.allowed(auto, `/quote/${pending.order.id}`), false);
  assert.deepEqual(
    link.resources?.map((resource) => [resource.pattern.source, resource.methods]),
    [['^\\/api\\/quotes\\/ord_(?:[0-9a-f]{24}|seed_[0-9a-f]{16}-[0-9a-f]{24})$', ['GET']]],
  );
  assert.deepEqual(link.card!(approved.result.quoteUrl, auto), {
    title: '合成零件商店报价单 · 1 项',
    desc: '合计 800元 · 有效期至 11月2日',
  });
  assert.equal(partsOf(approved.result.quoteUrl, 'https://shop.example.test', auto)[0]!.title, '合成零件商店报价单 · 1 项');
  const { __test: wecom } = await import('./adapters/wecom.js');
  assert.match(
    wecom.extractCard(`https://shop.example.test${approved.result.quoteUrl}`, 'https://shop.example.test', auto)!.title,
    /合成零件商店报价单/,
  );
  assert.equal(link.card!(`/quote/${(await make(fresh())).order.id}`, auto), null);
  const other = tenancy.createTenantRuntime({ id: 'industrial-other', slug: 'industrial-other' });
  tenancy.registerRuntime(other);
  try {
    await tenancy.withTenantScope(other, async () => {
      bindPack(createIndustrialRuntime(config.packSources()), brand);
      assert.equal(link.allowed(auto, approved.result.quoteUrl), false);
      assert.equal((await getQuote(approved.order.id)).status, 404);
    });
  } finally {
    tenancy.unregisterRuntime(other.id);
  }
  console.log('INDUSTRIAL LINKS PASS: 网页标题/企微卡片/显式GET资源、跨会话与跨租户隔离');

  // notes 调用范围与当前发布政策；页面和 JSON 共用同一 publicQuote。
  const originalNotes = runtime.quotes!.notes!;
  let noteCalls = 0;
  const frozen = Object.freeze(['合成只读说明']);
  runtime.quotes!.notes = (order, policy) => {
    noteCalls++;
    assert.equal(policy, config.currentPolicy().policy);
    return originalNotes(order, policy);
  };
  for (const state of ['pending', 'approved', 'paid', 'expired', 'rejected', 'withdrawn', 'superseded'] as const) {
    const session = fresh();
    setPolicy({ autoApproveMaxFen: 0 });
    const made = await make(session);
    if (state !== 'pending') {
      made.order.approval!.state = state === 'rejected' || state === 'withdrawn' ? state : 'approved';
      made.order.approval!.decidedAt = state === 'expired' ? now - 10 * 86400000 : now;
    }
    if (state === 'paid' || state === 'superseded') made.order.status = state;
    if (state === 'rejected' || state === 'withdrawn') made.order.status = 'cancelled';
    store.saveOrder(made.order);
    const before = noteCalls;
    const response = await getQuote(made.order.id);
    assert.equal(response.status, 200);
    assert.equal(noteCalls - before, state === 'approved' || state === 'paid' ? 1 : 0, state);
    assert.equal(Object.hasOwn(response.body, 'notes'), state === 'approved' || state === 'paid', state);
    if (state === 'approved' || state === 'paid') assert.deepEqual(response.body.notes, quoteNotes(config.currentPolicy().policy));
  }
  const before404 = noteCalls;
  assert.equal((await getQuote(`ord_${'f'.repeat(24)}`)).status, 404);
  assert.equal(noteCalls, before404);
  setPolicy({ taxIncluded: false, shipping: { freeOverFen: 50000, feeFen: 1200 } });
  const publicApproved = await getQuote(approved.order.id);
  assert.deepEqual(publicApproved.body.notes, ['报价不含税，税率13%', '满500.00元免运费，未满运费12.00元', '库存与交期以顾问确认为准']);
  const page = await app.request(`/quote/${approved.order.id}`);
  assert.equal(page.status, 200);
  class Element {
    textContent = '';
    hidden = false;
    disabled = false;
    className = '';
    children: Element[] = [];
    replaceChildren() {
      this.children = [];
    }
    append(...items: Element[]) {
      this.children.push(...items);
    }
    addEventListener() {}
  }
  const elements = new Map(['status', 'valid', 'brand', 'details', 'notes', 'retry'].map((id) => [id, new Element()]));
  vm.runInNewContext((await page.text()).match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: (id: string) => elements.get(id), createElement: () => new Element() },
    location: { pathname: `/quote/${approved.order.id}`, search: '' },
    URLSearchParams,
    Intl,
    encodeURIComponent,
    fetch: (url: string) => app.request(url),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    elements.get('notes')!.children.map((row) => row.textContent),
    publicApproved.body.notes,
  );
  active = await updateCatalogItem(ctx, 'part', data.id, { rev: active.rev, set: { unitPrice: 9 } });
  const repricedSession = fresh();
  assert.equal((await estimate(repricedSession)).total, 900);
  assert.equal((await make(repricedSession)).order.totalFen, 90000);
  assert.equal((await getQuote(approved.order.id)).body.display!.totalFen, 80000, '已批准的报价金额不随现价改变');
  assert.equal(JSON.stringify(pending.order.lines), lineBytes);
  assert.equal(pending.order.totalFen, 80000);
  runtime.quotes!.notes = () => [];
  assert.equal(Object.hasOwn((await getQuote(approved.order.id)).body, 'notes'), false);
  delete runtime.quotes!.notes;
  assert.equal(Object.hasOwn((await getQuote(approved.order.id)).body, 'notes'), false);
  runtime.quotes!.notes = () => frozen;
  assert.deepEqual((await getQuote(approved.order.id)).body.notes, frozen);
  runtime.quotes!.notes = originalNotes;
  // 政策草稿不参与读取：返回值仍是内存已发布快照；底层发布记录由原旅游夹具持有，不修改。
  assert.deepEqual((await withTenant(t.db, { ...ctx, tenantId: original.tenantId }, readPublishedSop))!.policy, original.sop.policy);
  console.log('INDUSTRIAL NOTES PASS: approved/paid限定、其余状态/404保密、当前发布政策、无钩子/空数组省略、冻结金额不变');

  // 真实 handleMessage → stage_advance；测试 mock 只发工具动作，不替换引擎或阶段推进。
  setPolicy({ autoApproveMaxFen: 100000 });
  const discovery = fresh();
  await handleMessage(discovery.id, '请帮我确认型号和数量', 'wecom');
  assert.equal(discovery.stage, 'discovery');
  for (const query of ['6205', '6205-ZZ']) {
    const recommendation = fresh();
    mockAction = async (opts) => {
      await opts.executeTool('find_parts', { query });
      return '请确认需要的型号';
    };
    await handleMessage(recommendation.id, `请找${query}`, 'wecom');
    assert.equal(recommendation.stage, 'recommend', '多候选或替代型号进入推荐');
  }
  const engine = fresh();
  mockAction = async (opts) => {
    await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 100 }] });
    return '已完成试算';
  };
  await handleMessage(engine.id, '请试算，公司：合成工厂，交货城市：合成市，开票类型：普票，用途：检修', 'wecom');
  assert.equal(engine.stage, 'quote');
  assert.equal(engine.profile.attrs?.company, '合成工厂');
  assert.deepEqual(
    Object.keys(
      runtime.profileForPrompt({
        ...engine.profile,
        nickname: '私密昵称',
        avatar: 'https://example.test/avatar',
        attrs: { ...engine.profile.attrs, hidden: '私密' },
      }).attrs as object,
    ).toSorted(),
    ['company', 'deliveryCity', 'invoiceType', 'usage'],
  );
  now++;
  mockAction = async (opts) => {
    await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 100 }] });
    return '报价单已批准';
  };
  await handleMessage(engine.id, '请出正式报价单', 'wecom');
  const engineOrder = store.getAnyOrder(engine.orderIds.at(-1)!) as LineOrder;
  assert.equal(engineOrder.approval!.auto, true);
  assert.equal(engine.stage, 'closing');
  now++;
  mockAction = async (opts) => {
    await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 101 }] });
    return '已重新试算';
  };
  await handleMessage(engine.id, '改成101件重新试算', 'wecom');
  assert.equal(engine.stage, 'quote', '新试算覆盖旧的已批准报价阶段');
  now++;
  mockAction = async (opts) => {
    await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 101 }] });
    return '新的报价单已批准';
  };
  await handleMessage(engine.id, '按新的数量出单', 'wecom');
  assert.equal(engine.stage, 'closing');
  assert.equal(quoteState(engineOrder, now), 'superseded');
  const payable = store.getAnyOrder(engine.orderIds.at(-1)!) as LineOrder;
  const paid = await actions.markPaidByAdvisor(payable.id, actor);
  assert.equal(paid.persisted, true);
  assert.equal(engine.stage, 'paid');
  setPolicy({ autoApproveMaxFen: 0 });
  const rejectedSession = fresh();
  mockAction = async (opts) => {
    await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 1 }] });
    return '等顾问审核';
  };
  await handleMessage(rejectedSession.id, '请出报价单', 'wecom');
  assert.equal(rejectedSession.stage, 'quote');
  const rejectedOrder = store.getAnyOrder(rejectedSession.orderIds[0]!) as LineOrder;
  await actions.rejectQuote(rejectedOrder.id, actor, '合成内部调整理由');
  assert.equal(rejectedSession.stage, 'quote');
  assert.ok(sent.some((message) => message.text === '这份报价需要顾问再核对一下，顾问会直接联系您'));
  assert.ok(!sent.some((message) => message.text.includes('合成内部调整理由')));
  const withdraw = fresh();
  const withdrawOrder = await make(withdraw, 1);
  await actions.approveQuote(withdrawOrder.order.id, actor);
  assert.equal(withdraw.stage, 'closing');
  await actions.withdrawQuote(withdrawOrder.order.id, actor);
  assert.equal(withdraw.stage, 'quote');
  assert.ok(sent.some((message) => message.text === '这份报价单已撤回，顾问会跟您重新确认'));
  console.log('INDUSTRIAL STAGES PASS: AI试算→报价、自动批准/取代→促成、工作台批准→促成、驳回/撤回→报价、实际收款→已支付');

  // 16 D8：每条语料用独立的已批准报价单，真实引擎决定接受；模型只回答业务问题。
  const positives = [
    '没问题，下单吧',
    '好的，下单吧',
    '下单吧',
    '确认',
    '同意这个报价',
    '接受报价',
    '就按这个，什么时候能发货？',
    '确认下单，能开专票吗',
    '确认下单',
    '确认报价',
    '就按这个',
    '可以下单',
    '没问题下单吧',
    '确认了',
    '确认无误',
    '下单',
    '接受',
    '同意',
    '成交',
    '就这个',
    '就这样',
    '就它了',
    '按这个来',
    '安排吧',
    '行，确认下单',
    '可以，接受报价',
    '嗯，下单吧',
    '好的确认报价',
    '没问题就按这个',
    '不用改了，确认下单',
    '确认下单。什么时候能发货？',
    '能开专票吗？确认下单',
    '确认下单；能开专票吗？',
    '确认下单\n什么时候能发货？',
    '那就按这个下单吧',
    '价格没问题，下单吧',
    '我接受这个价格',
    '帮我下单',
    '好的，这个报价我接受',
    '行，就这么定了',
    '那就这么办',
    'OK，确认',
    '这批物料我愿意按这份报价采购',
    '愿意按这份报价采购',
    '这份报价我们认可，同意采购',
    '我们决定采购',
    '可以，我接受这份报价并采购',
    '这个价格可以接受',
    '好的，这份报价单我确认没问题，就按24件、合计455.76元接受，我们准备下单采购了。',
    '这份报价我确认接受，24件6208-2RS，含税合计340.32元，我们就按这个单子采购。',
    '报价单收到，885.6元含税、有效期到10月17日没问题，我们确认接受这份报价，按这个方案采购HS-PV33共16件。',
    '我们确认接受这份报价，麻烦安排',
    '这张HS-PV30、4件、207元的报价单我确认没问题，就按这个来采购，请安排吧。',
    '这份报价没问题，合计885.60元在预算内，我们确认按这个价格采购16件HS-PV33。',
    '报价单收到，核过价格和数量都没问题，就按这份885.60元的报价来采购。',
    '报价单收到了，我这边确认没问题，就按24件、合计340.32元来采购。',
  ];
  const negatives = [
    '好的',
    '行',
    '可以',
    '嗯',
    '收到',
    '谢谢',
    '没问题',
    '确认一下价格',
    '帮我确认下库存',
    '确认价格',
    '请确认报价',
    '可以下单吗',
    '能确认吗',
    '确认下单？',
    '是否就按这个',
    '能不能下单',
    '确认报价是否含税',
    '先别下单',
    '暂不下单',
    '还没确认下单',
    '再想想',
    '考虑一下',
    '等等',
    '问问领导',
    '回头再说',
    '不确认',
    '不要确认下单',
    '不想下单',
    '不能下单',
    '不会下单',
    '不可以下单',
    '尚未确认报价',
    '先别确认报价',
    '确认下单前再想想',
    '确认报价后问问领导',
    '等领导同意这个报价',
    '如果有货就下单',
    '下单的话要多久',
    '我想下单但还没决定',
    '确认一下价格，下单要多久？',
    '可以下单吗，谢谢',
    '收到，好的',
    '不同意这个报价',
    '不接受报价',
    '等一下再确认下单',
    '确认下单，再加 10 个',
    '确认下单，等等',
    '就按这个，我再想想',
    '确认下单，改成 20 件',
    '请确认',
    '帮我确认',
    '接受不了',
    '我不同意',
    '准备采购',
    '采购部还在看',
    '这个价格可以接受吗',
    '不愿意按这份报价采购',
    '采购要走流程',
    '等领导同意采购',
    '如果确认接受的话我再告诉你',
    '不接受这份报价',
    '这份报价我们不接受',
    '没有确认接受',
    '领导决定采购再说',
    '按这个型号采购的话要多久',
    '就按100件算一下',
    '就按这个规格问问能不能采购',
    '按这个数量采购多少钱',
    '报价确认一下',
    '这个报价确认下',
  ];
  let modelCalls = 0;
  mockAction = async () => {
    modelCalls++;
    return '库存和交期以顾问确认为准。可以开专票。';
  };
  setPolicy({ autoApproveMaxFen: 100000 });
  const acceptanceJobs = async (id: string) => {
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    return t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (
        await tx.query<{ n: number }>(
          "select count(*)::int as n from jobs where kind='handoff_notify' and payload->>'orderId'=$1 and payload->>'reason'='quote_accepted'",
          [id],
        )
      ).rows[0]!.n;
    });
  };
  for (const [group, corpus, expected] of [
    ['正例', positives, true],
    ['反例', negatives, false],
  ] as const) {
    let hits = 0;
    for (const text of corpus) {
      const session = fresh();
      await estimate(session);
      const { order } = await make(session);
      now++;
      const callsBefore = modelCalls;
      const reply = await handleMessage(session.id, text, 'wecom');
      const accepted = order.approval!.acceptedAt !== undefined;
      hits += Number(accepted);
      {
        assert.equal(accepted, expected, text);
        assert.equal(await acceptanceJobs(order.id), expected ? 1 : 0, text);
        assert.equal(readState(session).confirmedQuoteAt !== undefined, expected, text);
        // 带问题、数量或金额的长句：记下接受，再交模型回。
        if (expected && /什么时候|能开|合计|含税|麻烦安排|请安排吧|885/.test(text)) {
          assert.equal(modelCalls, callsBefore + 1, text);
          assert.match(reply.text, /交期以顾问确认为准|可以开专票/, text);
        } else if (expected) {
          assert.equal(modelCalls, callsBefore, text);
          assert.equal(reply.text, '好的，顾问会尽快联系您确认付款和发货', text);
        }
      }
    }
    console.log(`CONFIRM CORPUS ${group}: ${hits}/${corpus.length}`);
  }

  // 16 开发集：模型在客户接受的同一轮调 handoff_to_human，回复照发，接受不丢。
  {
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    now++;
    const action = mockAction;
    mockAction = async (opts) => {
      await opts.executeTool('handoff_to_human', { reason: '客户要顾问对接付款' });
      return '已为您转交顾问，稍后与您对接付款和发货。';
    };
    const reply = await handleMessage(session.id, '这份报价我确认接受，请安排后续对接', 'wecom');
    mockAction = action;
    assert.equal(reply.silent, undefined);
    assert.equal(reply.text, '已为您转交顾问，稍后与您对接付款和发货。');
    assert.ok(session.handedOver);
    assert.ok(order.approval!.acceptedAt !== undefined);
    assert.equal(await acceptanceJobs(order.id), 1);
    console.log('MODEL HANDOFF PASS: 回复照发、接受记下、顾问通知排上');
  }

  // 16 复核：模型说报价单已提交却没调工具。客户要了就补建，照常人审；没要就改回实话。
  {
    const action = mockAction;
    const said = '好的，报价单已提交，合计885元，顾问审核中。';
    mockAction = async () => said;
    const stateOf = (session: Session) => {
      const quote = latestQuoteCandidate({ ...session, packState: {} }, now);
      return quote?.kind === 'quote' ? quote.state : undefined;
    };

    setPolicy({ autoApproveMaxFen: 0 });
    const pending = fresh();
    await estimate(pending);
    now++;
    const held = await handleMessage(pending.id, '麻烦出一份正式报价单给我', 'wecom');
    assert.equal(held.text, '最新的报价单还在顾问审核，审好马上发您', '待审不说金额');
    assert.equal(stateOf(pending), 'pending', '补建的单走人审');
    assert.equal(pending.stage, 'quote', '补建算进这一轮的阶段');

    setPolicy({ autoApproveMaxFen: 100000 });
    const approved = fresh();
    await estimate(approved);
    now++;
    const link = await handleMessage(approved.id, '麻烦出一份正式报价单给我', 'wecom');
    assert.match(link.text, /^报价单：\/quote\/ord_[0-9a-f]+\n合计/);
    assert.equal(stateOf(approved), 'approved');

    setPolicy({ autoApproveMaxFen: 0 });
    for (const text of ['好的，我等结果', '先别出正式报价单']) {
      const session = fresh();
      await estimate(session);
      now++;
      assert.equal((await handleMessage(session.id, text, 'wecom')).text, '报价单还没有提交，需要的话请告诉我，我马上起草。', text);
      assert.equal(session.orderIds.length, 0, text);
    }

    // 草稿里有没对上的行：不能只拿精确行建一张缺行的单，改回实话。
    setPolicy({ autoApproveMaxFen: 100000 });
    for (const match of ['ambiguous', 'none'] as const) {
      const partial = fresh();
      await estimate(partial);
      const { at, lines } = readState(partial).rfqDraft!;
      writeState(partial, { rfqDraft: { at, lines: [...lines, { match, qty: 5 }] } });
      now++;
      const reply = await handleMessage(partial.id, '麻烦出一份正式报价单给我', 'wecom');
      assert.equal(reply.text, '报价单还没有提交，需要的话请告诉我，我马上起草。', match);
      assert.equal(partial.orderIds.length, 0, match);
    }
    setPolicy({ autoApproveMaxFen: 0 });

    // 已有单时模型说的是真话，不动也不重复建。
    const existing = fresh();
    await estimate(existing);
    await make(existing);
    now++;
    mockAction = async () => '报价单已提交，顾问审核中。';
    assert.equal((await handleMessage(existing.id, '麻烦出一份正式报价单给我', 'wecom')).text, '报价单已提交，顾问审核中。');
    assert.equal(existing.orderIds.length, 1);
    mockAction = action;
    console.log('QUOTE CLAIM PASS: 要了就补建并人审，没要改回实话，已有单不重复建');
  }

  // 手机实测：批准后客户只回「可以」不算接受，模型却说已确认，顾问收不到通知。
  {
    const action = mockAction;
    setPolicy({ autoApproveMaxFen: 100000 });
    const claims = [
      '好的，您已确认该报价单，订单已进入处理流程。',
      '已收到您的确认，我们开始安排。',
      '已按这份报价为您确认采购。',
      '订单已进入发货流程。',
    ];
    const ask = '这份报价还需要您明确确认：请回复「接受这份报价」，我再通知顾问安排付款和发货。';
    const followGuard = industrialFollowupGuard((await import('./core/engine/sources.js')).packSources());
    for (const claim of claims) {
      const session = fresh();
      await estimate(session);
      const { order } = await make(session);
      now++;
      mockAction = async () => `${claim}\n付款方式：款到发货，对公转账。`;
      const reply = await handleMessage(session.id, '可以', 'wecom');
      assert.equal(reply.text, `${ask}\n付款方式：款到发货，对公转账。`, claim);
      assert.equal(order.approval!.acceptedAt, undefined, claim);
      assert.equal(await acceptanceJobs(order.id), 0, claim);
      const result = await followGuard.run({
        session,
        text: `${claim}还有别的型号吗？`,
        toolSources: [],
        recordGuard: () => undefined,
      } as never);
      assert.equal(result && 'text' in result ? result.text : '', '还有别的型号吗？', claim);
    }

    // 话里让客户回的那句要真能记下接受；记下之后再说已确认就是真话，不改。
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    now++;
    assert.equal(ask.includes('接受这份报价'), true);
    await handleMessage(session.id, '接受这份报价', 'wecom');
    assert.ok(order.approval!.acceptedAt !== undefined);
    assert.equal(await acceptanceJobs(order.id), 1);
    now++;
    const said = '您已确认该报价单，顾问会联系您安排付款。';
    mockAction = async () => said;
    assert.equal((await handleMessage(session.id, '什么时候能联系我', 'wecom')).text, said);

    // 批准但未接受时的正常话术不改。
    const open = fresh();
    await estimate(open);
    await make(open);
    now++;
    const fine = '报价单已审核通过，确认后顾问会与您对接付款安排。';
    mockAction = async () => fine;
    assert.equal((await handleMessage(open.id, '报价有效期多久', 'wecom')).text, fine);
    mockAction = action;
    console.log('ACCEPT CLAIM PASS: 没记下接受时改成请客户确认，建议说法能记下，真接受和正常话术不改');
  }

  // 非接受终态、更新的试算/清单和转人工仍先于客户接受；纯接受与混合问题都验证。
  for (const mode of [
    'pending',
    'expired',
    'intake',
    'draft',
    'none',
    'paid',
    'cancelled',
    'superseded',
    'nonstandard',
    'credit',
    'sample',
  ] as const) {
    for (const text of ['好的，下单吧', '确认下单，能开专票吗']) {
      const session = fresh();
      setPolicy({ autoApproveMaxFen: mode === 'pending' ? 0 : 100000 });
      await estimate(session);
      const { order } = await make(session);
      session.packState = {};
      if (mode === 'expired') order.approval!.decidedAt = now - 9 * 86400000;
      if (mode === 'paid' || mode === 'cancelled' || mode === 'superseded') order.status = mode;
      if (mode === 'none') session.orderIds = [];
      now++;
      if (mode === 'intake')
        writeState(session, {
          rfqIntake: {
            id: 'int_123456abcdef',
            at: now,
            status: 'pending',
            lines: [{ q: data.partNo, qty: 100, m: 'exact' }],
          },
        });
      if (mode === 'draft')
        writeState(session, { rfqDraft: { at: now, lines: [{ code: data.id, version: 1, match: 'exact', qty: 100 }] } });
      store.saveOrder(order);
      const prefix = mode === 'nonstandard' ? '非标，' : mode === 'credit' ? '账期，' : mode === 'sample' ? '样品，' : '';
      const reply = await handleMessage(session.id, prefix + text, 'wecom');
      assert.equal(order.approval!.acceptedAt, undefined, `${mode}: ${text}`);
      assert.equal(await acceptanceJobs(order.id), 0, `${mode}: ${text}`);
      if (mode === 'pending') assert.equal(reply.text, '最新的报价单还在顾问审核，审好马上发您');
      if (prefix) assert.equal(reply.handoff, true, mode);
      if (mode === 'expired' && /确认/.test(text)) assert.ok(readState(session).rfqDraft, '过期报价仍重新试算');
      if (mode === 'intake') assert.equal(readState(session).rfqIntake!.status, 'pending');
    }
  }
  console.log('CONFIRM BOUNDARIES PASS: 待审/过期/更新清单/新试算/无候选/终态/三类转人工，纯接受与混合问题');

  // 混合问题还要经过真实 HTTP 模型客户端；仅放行本套自建的回环假服务。
  const requests: { messages: { role: string; content?: string }[] }[] = [];
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '库存和交期以顾问确认为准。可以开专票。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const fakeBase = `http://127.0.0.1:${(fake.address() as import('node:net').AddressInfo).port}`;
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, {
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: fakeBase,
    LLM_API_KEY: 'fixture',
    LLM_MODEL: 'fixture',
    LLM_HEDGE_AFTER_MS: '0',
  }); // gitleaks:allow
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, `${fakeBase}/chat/completions`, '只准访问本套假服务');
    return savedFetch(input, init);
  };
  try {
    setPolicy({ autoApproveMaxFen: 100000 });
    for (const text of ['就按这个，什么时候能发货？', '确认下单，能开专票吗']) {
      const session = fresh();
      await estimate(session);
      const { order } = await make(session);
      now++;
      const requestCount = requests.length;
      const reply = await handleMessage(session.id, text, 'wecom');
      assert.equal(requests.length, requestCount + 1);
      assert.ok(requests.at(-1)!.messages.some((message) => message.role === 'user' && message.content?.includes(text)));
      assert.match(reply.text, text.includes('专票') ? /可以开专票/ : /交期以顾问确认为准/);
      assert.equal(order.approval!.acceptedAt, now);
      assert.equal(readState(session).confirmedQuoteAt, now);
      assert.equal(await acceptanceJobs(order.id), 1);
      const acceptedAt = order.approval!.acceptedAt;
      now++;
      await handleMessage(session.id, text, 'wecom');
      assert.equal(order.approval!.acceptedAt, acceptedAt, '重复确认保留首次接受时间');
      assert.equal(await acceptanceJobs(order.id), 1, '重复确认不重复排顾问通知');
    }
    console.log('CONFIRM HTTP PASS: 两条接受+问题均到假服务、回答问题、acceptedAt和quote_accepted任务保存，重复确认去重');
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fake.closeAllConnections();
    await new Promise<void>((resolve, reject) => fake.close((error) => (error ? reject(error) : resolve())));
  }

  // 缓存淘汰前后 R6 / R11 使用同一完整摘要与订单；D 批复用同一候选函数。
  setPolicy({ autoApproveMaxFen: 100000 });
  now++;
  const bounded = fresh();
  await estimate(bounded);
  const boundedOrder = await make(bounded);
  const snapshot = structuredClone(readState(bounded).rfqDraft);
  const candidateBefore = JSON.stringify(latestQuoteCandidate(bounded, now));
  const autoBefore = originalAuto(boundedOrder.order, bounded);
  writeState(bounded, { confirmedQuoteAt: now }, [{ partNo: '超长'.repeat(10000), specs: ['\\"\n规格'.repeat(10000)] }]);
  assert.deepEqual(readState(bounded).rfqDraft, snapshot);
  assert.equal(JSON.stringify(latestQuoteCandidate(bounded, now)), candidateBefore);
  assert.equal(originalAuto(boundedOrder.order, bounded), autoBefore);
  assert.equal(readState(bounded).partsInPlay!.length, 0);
  assert.equal(draftParts(bounded, config.packSources())[0]!.partNo, data.partNo);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.packState)) <= 8192);
  assert.equal(StateSchema.safeParse(bounded.packState).success, true);
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  const persistedBeforeReset = await t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<{ state: { packState: unknown } }>('select state from conversations where id=$1', [bounded.id])).rows[0]!.state
      .packState;
  });
  assert.deepEqual(persistedBeforeReset, bounded.packState);
  await handleMessage(bounded.id, '重新开始', 'wecom');
  assert.deepEqual(bounded.packState ?? {}, {});
  assert.equal(latestQuoteCandidate(bounded, now), null);
  assert.equal(originalAuto(boundedOrder.order, bounded), false);
  assert.deepEqual(draftParts(bounded, config.packSources()), []);
  assert.equal((await getQuote(boundedOrder.order.id)).status, 404);
  assert.equal(bounded.stage, 'greeting');
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  // 重启会话存储仍保持重置结果，审批历史不删除。
  const resetId = bounded.id;
  rt.store.pgBackend!.close();
  rt.store.pgBackend = null;
  rt.store.sessions.clear();
  rt.store.orders.clear();
  await store.initSessionStore(fx.deps);
  assert.deepEqual(store.getSession(resetId)!.packState ?? {}, {});
  assert.equal((await getQuote(boundedOrder.order.id)).status, 404);
  assert.equal(
    await t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<{ n: number }>('select count(*)::int as n from orders where id=$1', [boundedOrder.order.id])).rows[0]!.n;
    }),
    1,
  );
  assert.deepEqual(store.getSession(engine.id)!.profile.attrs, engine.profile.attrs);
  // 文件模式同样读当前 policy.json，两个装配入口共用既有读取；公开 notes 不读其他租户。
  const { installPublicHost } = await import('./tenancy/hosts.js');
  const fileRuntime = tenancy.createTenantRuntime({
    id: 'industrial-file',
    slug: 'industrial-file',
    publicBase: 'https://file.example.test',
  });
  const originalSopPath = process.env.SOP_PATH;
  process.env.SOP_PATH = path.join(dir, 'file-sop.md');
  const filePolicy = { ...defaultIndustrialPolicy, taxIncluded: false, autoApproveMaxFen: 12345 };
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(filePolicy));
  installPublicHost(fileRuntime, 'file.example.test');
  tenancy.registerRuntime(fileRuntime);
  try {
    await tenancy.withTenantScope(fileRuntime, async () => {
      const pack = createIndustrialRuntime(config.packSources());
      bindPack(pack, brand);
      assert.deepEqual(config.packSources().currentPolicy().policy, filePolicy);
      assert.deepEqual((await import('./core/engine/sources.js')).packSources().currentPolicy().policy, filePolicy);
      const readable = structuredClone(approved.order);
      const orders: Map<string, AnyOrder> = fileRuntime.store.orders;
      orders.set(readable.id, readable);
      const res = await app.request(`/api/quotes/${readable.id}`, { headers: { host: 'file.example.test' } });
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as PublicQuote).notes, quoteNotes(filePolicy));
      assert.equal((await app.request(`/api/quotes/${pending.order.id}`, { headers: { host: 'file.example.test' } })).status, 404);
    });
  } finally {
    tenancy.unregisterRuntime(fileRuntime.id);
    if (originalSopPath === undefined) delete process.env.SOP_PATH;
    else process.env.SOP_PATH = originalSopPath;
  }
  console.log('INDUSTRIAL STATE PASS: 淘汰不改自动批准/最新候选、空缓存仍读版本型号、四键真实重置、重载后旧单404且审批历史保留');
} finally {
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  Date.now = realNow;
  rt.store.pgBackend?.close();
  rt.store.pgBackend = null;
  await config.closeConfig();
  config.__configTest.reset();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
