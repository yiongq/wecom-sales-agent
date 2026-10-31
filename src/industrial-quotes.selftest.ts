// 10 R6 / R7 / R13：实际工具、引擎、工作台动作、公开路由和存储；只桩模型策略与发送边界。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { industrial } from './packs/industrial/console-pack.js';
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
