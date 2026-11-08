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
import { FIXED } from './packs/industrial/turn.js';
import { NEXT } from './packs/industrial/reply-blocks.js';
import { ACCEPT_ASK } from './packs/industrial/guards.js';
import { industrialFollowupGuard } from './packs/industrial/guards.js';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
import { claimsIndustrialHandoff, hasIndustrialHandoffNotice } from './packs/industrial/handoff-claims.js';
import { defaultIndustrialPolicy, quoteNotes } from './packs/industrial/policy.js';
import { writeState, readState, draftParts, StateSchema } from './packs/industrial/state.js';
import { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } from './packs/industrial/quote-candidate.js';
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
const { bindPack, createLineOrder, orderDisplay, partsOf, quoteState, quoteValidUntil } = await import('./core/pack-api.js');
const { snapshotQuoteApproval } = await import('./core/order-view.js');
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
  const { __llmTest } = await import('./core/llm/client.js');
  const { onTurnEnd } = await import('./trace/recorder.js');
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

  // 18 / 09 R11：待审重出只删违规金额句；真实工具负责取代旧待审单，价格块逐行标试算。
  {
    const action = mockAction;
    const seen: import('./trace/recorder.js').FinishedTurn[] = [];
    const stop = onTurnEnd((turn) => seen.push(turn));
    const followGuard = industrialFollowupGuard(config.packSources());
    const r11 = (text: string) => {
      for (const line of text.split('\n'))
        if (/(?:[¥￥]\s*\d|\d+(?:\.\d+)?\s*元)/.test(line)) assert.match(line, /试算/, `待审金额行标试算：${line}`);
    };
    try {
      setPolicy({ autoApproveMaxFen: 0 });
      for (const claim of ['原10件报价单作废处理。', '之前那张以本张为准。']) {
        const session = fresh();
        // 更早的已批准单仍有效，不应据此误改刚被取代的旧待审单的说明。
        await estimate(session, 5);
        const earlier = await make(session, 5);
        await actions.approveQuote(earlier.order.id, actor);
        await estimate(session, 10);
        const old = await make(session, 10);
        now++;
        mockAction = async (opts) => {
          await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 18 }] });
          await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 18 }] });
          return `试算：\n6205-2RS × 18：单价8元，小计144元\n合计144元\n新报价单已按18件重新起草，需顾问审核。${claim}`;
        };
        const reply = await handleMessage(session.id, '请作废旧报价单，改为6205-2RS共18件，重出正式报价单', 'wecom');
        const latest = store.getAnyOrder(session.orderIds.at(-1)!) as LineOrder;
        assert.equal(quoteState(old.order, now), 'superseded', '建新单立即取代旧待审单');
        assert.equal(old.order.supersededBy, latest.id);
        assert.equal(quoteState(earlier.order, now), 'approved');
        assert.equal(quoteState(latest, now), 'pending');
        assert.match(reply.text, /新报价单已按18件重新起草，需顾问审核/);
        assert.ok(reply.text.includes(claim), '旧待审单已被取代，保留真实说明');
        assert.match(reply.text, /6205-2RS × 18：试算单价8\.00元，小计144\.00元/);
        assert.match(reply.text, /试算合计144\.00元/);
        assert.equal(seen.at(-1)!.turn.blocks!.suppressed, false);
        r11(reply.text);
      }
      for (const claim of ['原10件报价单作废处理。', '之前那张以本张为准。', '之前那张10件的报价单您可以不予理会。']) {
        const session = fresh();
        await estimate(session, 10);
        const old = await make(session, 10);
        await actions.approveQuote(old.order.id, actor);
        now++;
        mockAction = async (opts) => {
          await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 18 }] });
          await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 18 }] });
          return `合计144元。新报价单已按18件重新起草，需顾问审核。${claim}`;
        };
        const reply = await handleMessage(session.id, '请作废旧报价单，改为6205-2RS共18件，重出正式报价单', 'wecom');
        assert.equal(quoteState(old.order, now), 'approved', '新单待审不取代已批准且有效的旧单');
        assert.equal(old.order.supersededBy, undefined);
        assert.ok(!reply.text.includes(claim), '删掉旧单已作废的不实说法');
        assert.match(reply.text, /原报价单仍有效，待新报价单审核通过后才会作废。/);
        assert.match(reply.text, /新报价单已按18件重新起草，需顾问审核/);
        assert.match(reply.text, /试算合计144\.00元/);
        assert.equal(seen.at(-1)!.turn.blocks!.suppressed, false, '纠正旧单状态仍属局部改写');
        r11(reply.text);
      }
      for (const draft of ['合计144元。', '试算正式报价单合计144元。', '试算：\n合计144元\n另外，']) {
        const session = fresh();
        await estimate(session, 18);
        await make(session, 18);
        now++;
        mockAction = async (opts) => {
          await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 18 }] });
          return draft;
        };
        const reply = await handleMessage(session.id, '请核对这次试算', 'wecom');
        assert.equal(reply.text, FIXED.pending, `删空或只剩残句仍整段兜底：${draft}`);
        assert.equal(seen.at(-1)!.turn.blocks!.suppressed, true);
        r11(reply.text);
      }
      const session = fresh();
      await estimate(session, 18);
      await make(session, 18);
      for (const [draft, expected] of [
        ['合计144元。新报价单在顾问审核中。', '新报价单在顾问审核中。'],
        ['试算正式报价单合计144元。请核对数量。', '请核对数量。'],
        ['合计144元。', ''],
        ['试算：\n合计144元。', '试算：'],
      ]) {
        const result = await followGuard.run({ session, text: draft, toolSources: [], recordGuard: () => undefined } as never);
        assert.equal(result && 'text' in result ? result.text : draft, expected, '跟进仍仅删句，不加固定话术或块');
        r11(expected);
      }
    } finally {
      stop();
      mockAction = action;
    }
    console.log('PENDING REPLY PASS: 重出保留正文、旧待审单被取代、逐行试算、删空抑制块、跟进不变');
  }

  // 18：已批准 / 本轮接受的报价不能再说待审，只换错的状态句，应付金额照常附上。
  {
    const action = mockAction;
    const seen: import('./trace/recorder.js').FinishedTurn[] = [];
    const stop = onTurnEnd((turn) => seen.push(turn));
    const truth = '这份报价已批准，顾问会尽快联系您确认付款和发货。';
    const prefix = '型号数量已核对。';
    const suffix = '有其他需要随时找我。';
    try {
      setPolicy({ autoApproveMaxFen: 0 });
      for (const claim of [
        '单子目前还在顾问审核中，审核通过后会安排后续订单与付款事宜，届时顾问会与您联系确认。',
        '这份报价待顾问审核。',
        '审核通过后才安排付款。',
        '新报价单还在审核中。',
        '报价单仍在顾问审核。审核通过后才安排发货。',
      ]) {
        for (const mode of ['approved', 'accepting', 'pending'] as const) {
          const session = fresh();
          await estimate(session, 15);
          const { order } = await make(session, 15);
          if (mode !== 'pending') await actions.approveQuote(order.id, actor);
          now++;
          mockAction = async () => `${prefix}${claim}${suffix}`;
          const reply = await handleMessage(
            session.id,
            mode === 'accepting' ? '报价单没问题，我接受这份报价，就按这个采购。' : '请说明这份报价的状态。',
            'wecom',
          );
          const expected = `${prefix}${mode === 'pending' ? claim : truth}${suffix}`;
          assert.equal(
            reply.text,
            mode === 'accepting' ? `${expected}\n您接受的这份报价合计120.00元` : expected,
            `${mode}：局部纠正、其余句子保留、多处错话只补一次实话`,
          );
          assert.equal(order.approval!.acceptedAt !== undefined, mode === 'accepting');
          assert.equal(seen.at(-1)!.turn.blocks!.suppressed, false, '状态句局部改写不抑制应付金额');
        }
      }
      const approved = fresh();
      await estimate(approved, 15);
      const { order } = await make(approved, 15);
      await actions.approveQuote(order.id, actor);
      for (const statement of [
        '这份报价已审核通过，不用再等顾问审核。',
        '审核通过后已经给您发出报价单。',
        '这份报价还在审核中吗？',
        '发票资料还在顾问审核中。',
      ]) {
        now++;
        mockAction = async () => statement;
        assert.equal((await handleMessage(approved.id, '请说明报价状态。', 'wecom')).text, statement, '否定、问句、其他事项不改');
      }

      // 接受入口选中旧批准单后，本轮模型另建新待审单；acceptedId 仍指向旧单，新单的待审说明属实。
      now++;
      const newPending = '新报价单审核通过后会通知您。';
      mockAction = async (opts) => {
        await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 18 }] });
        await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 18 }] });
        return `您接受的这份报价还在审核中。${newPending}${suffix}`;
      };
      const reply = await handleMessage(approved.id, '报价单没问题，我接受这份报价，就按这个采购。', 'wecom');
      const latest = store.getAnyOrder(approved.orderIds.at(-1)!) as LineOrder;
      assert.notEqual(latest.id, order.id);
      assert.equal(quoteState(latest, now), 'pending');
      assert.equal(quoteState(order, now), 'approved');
      assert.ok(order.approval!.acceptedAt);
      assert.match(reply.text, new RegExp(`^${truth}${newPending}${suffix}`));
      assert.match(reply.text, /您接受的这份报价合计120\.00元/);
      assert.equal(seen.at(-1)!.turn.blocks!.suppressed, false);
      // 没有 acceptingOrderId 时看最新单：不能借旧单的批准状态改写新单的真实待审状态。
      now++;
      mockAction = async () => `${newPending}单子目前还在顾问审核中。`;
      assert.equal((await handleMessage(approved.id, '请说明最新报价单的状态。', 'wecom')).text, `${newPending}单子目前还在顾问审核中。`);
    } finally {
      stop();
      mockAction = action;
    }
    console.log('APPROVED STATE PASS: 已批/接受局部纠正、应付块保留、真待审/另一张新单/否定与问句不改');
  }

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
  // R6 第 3 条按订单行判定：另一行精确也不能替这一行作证。
  for (const match of ['exact', 'ambiguous', 'none'] as const) {
    const session = fresh();
    const second = match === 'exact' ? { match, code: 'part-b', version: 1, qty: 1 } : { match, qty: 1 };
    writeState(session, { rfqDraft: { at: now, lines: [{ match: 'exact', code: data.id, version: 1, qty: 100 }, second] } });
    now++;
    const items = [
      { code: data.id, qty: 100 },
      { code: 'part-b', qty: 1 },
    ];
    const result = JSON.parse(await registry.execute('create_quote_sheet', { items }, context(session)));
    assert.equal(result.state, match === 'exact' ? 'approved' : 'pending', match);
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

  // 无快照旧单的 notes 调用范围与当前发布政策；新单页面和 JSON 共用批准快照。
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
  assert.deepEqual(publicApproved.body.notes, quoteNotes(defaultIndustrialPolicy), '已批准说明不随税费与运费政策改变');
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
  const legacyNotesOrder = (await make(fresh())).order;
  legacyNotesOrder.approval = { state: 'approved', requestedAt: now, decidedAt: now };
  store.saveOrder(legacyNotesOrder);
  assert.deepEqual((await getQuote(legacyNotesOrder.id)).body.notes, quoteNotes(config.currentPolicy().policy));
  runtime.quotes!.notes = () => [];
  assert.equal(Object.hasOwn((await getQuote(legacyNotesOrder.id)).body, 'notes'), false);
  delete runtime.quotes!.notes;
  assert.equal(Object.hasOwn((await getQuote(legacyNotesOrder.id)).body, 'notes'), false);
  runtime.quotes!.notes = () => frozen;
  assert.deepEqual((await getQuote(legacyNotesOrder.id)).body.notes, frozen);
  assert.deepEqual((await getQuote(approved.order.id)).body.notes, quoteNotes(defaultIndustrialPolicy));
  runtime.quotes!.notes = originalNotes;
  // 政策草稿不参与读取：返回值仍是内存已发布快照；底层发布记录由原旅游夹具持有，不修改。
  assert.deepEqual((await withTenant(t.db, { ...ctx, tenantId: original.tenantId }, readPublishedSop))!.policy, original.sop.policy);
  console.log('INDUSTRIAL NOTES PASS: approved/paid限定、其余状态/404保密、旧单当前发布政策与无钩子/空数组回退、新单说明及金额定格');

  // 两条实际批准路径：政策缩短不提前失效，延长不复活，下一张按新政策批准。
  const snapshotOrders: LineOrder[] = [];
  for (const mode of ['manual', 'auto'] as const) {
    setPolicy({ autoApproveMaxFen: 0, quoteValidDays: 1, taxIncluded: false });
    const session = fresh();
    await estimate(session);
    const waiting = mode === 'manual' ? (await make(session)).order : undefined;
    if (waiting) {
      assert.equal(waiting.approval!.validUntil, undefined);
      assert.equal(waiting.approval!.notes, undefined);
    }
    setPolicy({ autoApproveMaxFen: mode === 'auto' ? 100000 : 0, quoteValidDays: 7 });
    const order = waiting ?? (await make(session)).order;
    if (waiting) await actions.approveQuote(order.id, actor);
    const approval = structuredClone(order.approval!);
    assert.equal(approval.auto === true, mode === 'auto', mode);
    assert.equal(approval.validUntil, Date.parse('2026-11-02T15:59:59.999Z'), mode);
    assert.deepEqual(approval.notes, quoteNotes(defaultIndustrialPolicy), `${mode}: 批准时政策，非起草时政策`);
    snapshotOrders.push(structuredClone(order));
    const legacy = structuredClone(order);
    delete legacy.approval!.validUntil;
    delete legacy.approval!.notes;
    setPolicy({ autoApproveMaxFen: mode === 'auto' ? 100000 : 0, quoteValidDays: 0, taxIncluded: false });
    const afterShortDeadline = approval.decidedAt! + 2 * 86400000;
    assert.equal(quoteState(order, afterShortDeadline), 'approved', `${mode}: 改短不提前过期`);
    assert.equal(quoteState(legacy, afterShortDeadline), 'expired', `${mode}: 旧单仍按当前政策`);
    assert.equal(quoteValidUntil(order), approval.validUntil);
    const publicBefore = await getQuote(order.id);
    assert.equal(publicBefore.body.state, 'approved');
    assert.equal(publicBefore.body.validUntil, approval.validUntil);
    assert.deepEqual(publicBefore.body.notes, approval.notes);
    if (mode === 'manual') {
      await actions.approveQuote(order.id, actor);
      assert.deepEqual(order.approval, approval, '重复批准不覆盖首次快照');
    }
    const newSession = fresh();
    await estimate(newSession);
    const newShort = (await make(newSession)).order;
    if (mode === 'manual') await actions.approveQuote(newShort.id, actor);
    assert.equal(newShort.approval!.validUntil, Date.parse('2026-10-26T15:59:59.999Z'));
    assert.deepEqual(newShort.approval!.notes, quoteNotes(config.currentPolicy().policy));
    assert.notDeepEqual(newShort.approval!.notes, approval.notes);
    setPolicy({ autoApproveMaxFen: mode === 'auto' ? 100000 : 0, quoteValidDays: 30, taxIncluded: false });
    assert.equal(quoteState(order, approval.validUntil!), 'approved', `${mode}: 截止毫秒仍有效`);
    assert.equal(quoteState(order, approval.validUntil! + 1), 'expired', `${mode}: 改长不延后过期`);
    assert.equal(quoteState(legacy, approval.validUntil! + 1), 'approved', `${mode}: 旧单仍可随政策延长`);
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    const beforeRead = now;
    try {
      now = approval.validUntil! + 1;
      assert.equal((await getQuote(order.id)).body.state, 'expired');
    } finally {
      now = beforeRead;
    }
    const longSession = fresh();
    await estimate(longSession);
    const newLong = (await make(longSession)).order;
    if (mode === 'manual') await actions.approveQuote(newLong.id, actor);
    assert.equal(newLong.approval!.validUntil, Date.parse('2026-11-25T15:59:59.999Z'));
    assert.deepEqual(newLong.approval!.notes, quoteNotes(config.currentPolicy().policy));
  }
  // 空说明也要定格；复制钩子给的数组，后续增删不能改写客户手里的说明。
  setPolicy({ autoApproveMaxFen: 100000 });
  for (const hook of ['absent', 'empty', 'mutable'] as const) {
    const notes = hook === 'mutable' ? ['批准时说明'] : [];
    if (hook === 'absent') delete runtime.quotes!.notes;
    else runtime.quotes!.notes = () => notes;
    const session = fresh();
    await estimate(session);
    const order = (await make(session)).order;
    assert.deepEqual(order.approval!.notes, hook === 'mutable' ? ['批准时说明'] : []);
    notes.push('批准后新增');
    runtime.quotes!.notes = originalNotes;
    const response = await getQuote(order.id);
    assert.deepEqual(response.body.notes, hook === 'mutable' ? ['批准时说明'] : undefined);
  }
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  for (const order of snapshotOrders) {
    const stored = await t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<{ data: LineOrder }>('select data from orders where id=$1', [order.id])).rows[0]!.data;
    });
    assert.deepEqual(stored.approval, order.approval, '实际 orders.data 保存完整快照');
  }
  console.log(
    'QUOTE SNAPSHOT PASS: 人工/自动批准，起草与批准政策区分，缩短不失效、延长不复活，说明定格、旧单回退、新单新政策、空说明及数组隔离、JSON落库',
  );

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
    // 18 main-6 / j-standard-02 第 4 遍第 4 轮：原话，以及两种漏认分句各自成立。
    '这份报价我看过没问题，按6211-2RS 6件、合计115.20元接受，就走这单采购。',
    '按6211-2RS 6件、合计115.20元接受',
    // main-5 / j-bargain-03 第 4 遍第 6 轮原已认出，补条款后仍走长句的模型回复。
    '这份报价单我确认过了，按20件、含税合计1107元接受，就按这个报价采购。',
    '按这个价接受',
    '就走这单',
    '就走这单采购',
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
    '我再看看，按这个价可以接受吗？',
    '按这个价接受吗？',
    '如果有现货，按这个价接受',
    '不按这个价接受',
    '按这个价接受不了',
    '按这个价无法接受',
    '按这个价不予接受',
    '按这个价不太能接受',
    '按这个价难以接受',
    '按这个价接受前再核对库存',
    '按这个价接受，改成20件',
    '就走这单采购吗？',
    '如果能按这个价，我们就走这单',
    '能按这个价的话，就走这单采购',
    '假如有货，就走这单',
    '要是有货，就走这单采购',
    '只要有货，就走这单采购',
    '除非含运费，就走这单',
    '不想就走这单采购',
    '不接受这个价格，就走这单采购',
    '这次不采购，就走这单采购',
    '就走这单采购不了',
    '就走这单采购，改成20件',
    '领导说就走这单采购',
    // 全量 journal 对比时拦下的近似说法：压价条件、只认可交期，都不是接受正式报价。
    '那这样，135元的基础上再额外减30元，128的价格我就走这单。',
    '试算收到了，明细都对得上。麻烦你们出一份正式报价单，六行合一单就行，交期按目录的来可以接受。',
    '六行核对无误，交期按目录的可以接受。麻烦出一份正式报价单，六个型号合在同一单里，我这边要用于下单。',
    '好吧，五折的事就当我没提，不用走什么特批了。就按22件、19.35元的目录价来吧，交期按目录参考的15天我也能接受。麻烦给我出一份正式报价单。',
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

  // 接受这一轮：实际 quote_items 记行金额和合计，建新单取代旧单，再走引擎全部护栏。
  {
    const action = mockAction;
    const bearingA = { ...data, id: 'accept-a', partNo: '6208-2RS', unitPrice: 14.18 };
    const bearingB = { ...data, id: 'accept-b', partNo: '6211-2RS', unitPrice: 17.28 };
    const sameModel = { ...data, id: 'accept-c', partNo: 'HS9010', unitPrice: 18.99 };
    const valveA = { ...data, id: 'context-va', partNo: 'HS-PV25', unitPrice: 28 };
    const valveB = { ...data, id: 'context-vb', partNo: 'HS-PV27', unitPrice: 29.4 };
    const remaining = { ...data, id: 'context-rem', partNo: '6207-2RS', stock: 18, leadDays: 9 };
    for (const part of [bearingA, bearingB, sameModel, valveA, valveB, remaining]) {
      const draft = await createCatalogItem(ctx, 'part', part);
      await activateCatalogItem(ctx, 'part', draft.code, { rev: draft.rev });
    }
    const pricedOrder = async (session: Session, part: typeof data, qty: number) => {
      now++;
      await registry.execute('quote_items', { items: [{ query: part.partNo, qty }] }, context(session));
      now++;
      const result = JSON.parse(await registry.execute('create_quote_sheet', { items: [{ code: part.id, qty }] }, context(session)));
      const order = store.getAnyOrder(session.orderIds.at(-1)!) as LineOrder;
      if (result.state === 'pending') await actions.approveQuote(order.id, actor);
      assert.equal(quoteState(order, now), 'approved');
      return order;
    };
    // 旧型号已谈过并建过单，即使被新批准单取代，也不能再要求客户选一遍型号。
    {
      const session = fresh();
      const old = await pricedOrder(session, bearingA, 20);
      await pricedOrder(session, bearingB, 26);
      assert.equal(quoteState(old, now), 'superseded');
      const expected = '是的，6208-2RS那张报价单已经作废，请以6211-2RS的新报价单为准。';
      mockAction = async (opts) => {
        await opts.executeTool('find_parts', { query: '6208' });
        return expected;
      };
      now++;
      assert.equal(
        (await handleMessage(session.id, '6208那张是不是已经作废了？', 'wecom')).text,
        expected,
        'superseded quote still resolves model',
      );
    }
    // 接受轮的客户简称仍指向当前已批准单；真实预取、护栏、接受落账全走。
    {
      const session = fresh();
      const order = await pricedOrder(session, valveB, 100);
      mockAction = async () => '好的，已为您确认这份报价单：HS-PV27 气动阀 × 100件，合计2940元（含税）。';
      now++;
      const reply = await handleMessage(
        session.id,
        '这份报价我看过了，100件HS-PV气动阀，合计2940元，没问题，我接受这份报价，就按这个采购。',
        'wecom',
      );
      assert.ok(!reply.text.includes('候选'), reply.text);
      assert.match(reply.text, /HS-PV27/);
      assert.ok(order.approval!.acceptedAt !== undefined);
    }
    // 接受后即使模型顺手查了别的歧义系列，本轮也不能被候选确认覆盖。
    {
      const session = fresh();
      const order = await pricedOrder(session, valveB, 100);
      mockAction = async (opts) => {
        await opts.executeTool('find_parts', { query: '6208' });
        return 'HS-PV27，100件，已确认您接受这份报价。';
      };
      now++;
      assert.equal(
        (await handleMessage(session.id, '接受这份报价，能开专票吗？', 'wecom')).text,
        'HS-PV27，100件，已确认您接受这份报价。\n您接受的这份报价合计2940.00元',
      );
      assert.ok(order.approval!.acceptedAt !== undefined);
    }
    // 前置工具闸本来会拒绝替客户选型；此组暂时移除它，让真实工具写入，独立验证回复护栏。
    const beforeTool = runtime.beforeTool;
    runtime.beforeTool = undefined;
    try {
      // 旧型号简称或查询不应覆盖客户本轮讨论的新型号。
      {
        const session = fresh();
        await pricedOrder(session, bearingA, 20);
        mockAction = async (opts) => {
          await opts.executeTool('find_parts', { query: '6208' });
          await opts.executeTool('find_parts', { query: '6211-2RS' });
          now++;
          const result = JSON.parse(await opts.executeTool('quote_items', { items: [{ query: '6211-2RS', qty: 26 }] }));
          assert.equal(result.lines[0].code, bearingB.id);
          return '6211-2RS，26件，需要重新出报价单。';
        };
        for (const input of [
          '报价单收到了，不过需求有变化：型号改成6211-2RS，数量改为26件，麻烦按这个重新出单，刚才那张6208的报价单请作废。',
          '不是6208，我要的是6211-2RS，26件，麻烦重新出单。',
        ]) {
          now++;
          assert.equal(
            (await handleMessage(session.id, input, 'wecom')).text,
            '6211-2RS，26件，需要重新出报价单。\n试算：\n6211-2RS × 26：单价17.28元，小计449.28元；现货，以顾问确认为准\n合计449.28元',
          );
        }
      }
      // 无候选上下文仍要求客户自己选；唯一候选不称「多个」。
      for (const [input, query, modelText, expected] of [
        ['HS-PV 气动阀50件多少钱', 'HS-PV', 'HS-PV27，50件。', /多个候选[\s\S]*HS-PV25[\s\S]*HS-PV27/],
        ['6208 轴承20件多少钱', '6208', '6208-2RS，20件。', /查到的是 6208-2RS，请确认是不是这个型号/],
      ] as const) {
        const session = fresh();
        mockAction = async (opts) => {
          await opts.executeTool('find_parts', { query });
          return modelText;
        };
        now++;
        assert.match((await handleMessage(session.id, input, 'wecom')).text, expected);
      }
      // 客户没有选型号：本轮模型新写的草稿 / 新建的报价单都不能充当旧上下文。
      for (const [tool, elapsed] of [
        ['quote_items', 0],
        ['quote_items', 1],
        ['create_quote_sheet', 0],
        ['create_quote_sheet', 1],
      ] as const) {
        const session = fresh();
        mockAction = async (opts) => {
          await opts.executeTool('find_parts', { query: 'HS-PV' });
          now += elapsed;
          if (tool === 'quote_items') await opts.executeTool(tool, { items: [{ query: valveB.partNo, qty: 50 }] });
          // 建单工具内部也有同一道闸；用真实注册表的空工具文本模拟已穿过前置闸，客户原话不变。
          else await registry.execute(tool, { items: [{ code: valveB.id, qty: 50 }] }, context(session));
          return 'HS-PV27，50件，合计1470元。';
        };
        now++;
        const reply = await handleMessage(session.id, 'HS-PV 气动阀50件多少钱', 'wecom');
        assert.match(reply.text, /多个候选[\s\S]*HS-PV25[\s\S]*HS-PV27/, tool);
        if (tool === 'quote_items') assert.ok(readState(session).rfqDraft);
        else assert.equal(session.orderIds.length, 1);
      }
    } finally {
      runtime.beforeTool = beforeTool;
    }
    // 试算精确行也可解决简称候选，而不必先有正式单。
    {
      const session = fresh();
      await registry.execute('quote_items', { items: [{ query: valveB.partNo, qty: 100 }] }, context(session));
      mockAction = async (opts) => {
        await opts.executeTool('find_parts', { query: 'HS-PV' });
        return 'HS-PV27，100件。';
      };
      now++;
      assert.equal((await handleMessage(session.id, 'HS-PV这款再核对一下', 'wecom')).text, 'HS-PV27，100件。');
    }
    // 真正试算带出的部分现货依据与回复出口 JSON 删除。
    {
      const session = fresh();
      mockAction = async () =>
        '库存现货18件，其余14件约需9天到货，具体以顾问确认为准。\n询价摘要：{"at":1,"lines":[]}\n过期报价行：[]\n{"code":"context-rem","qty":32}';
      now++;
      assert.equal(
        (await handleMessage(session.id, '6207-2RS 32件多少钱', 'wecom')).text,
        '库存现货18件，其余14件约需9天到货，具体以顾问确认为准。\n试算：\n6207-2RS × 32：单价8.00元，小计256.00元；现货 18 件，其余约 9 天，以顾问确认为准\n合计256.00元',
      );
    }
    // 同内容试算不阻止接受；数量、型号、版本、行数不同仍是新需求。
    for (const mode of ['same', 'qty', 'model', 'version', 'extra', 'pending', 'expired'] as const) {
      const session = fresh();
      const order = await pricedOrder(session, bearingB, 26);
      if (mode === 'pending') {
        order.approval!.state = 'pending';
        order.approval!.requestedAt = now;
      }
      if (mode === 'expired') order.approval!.validUntil = now - 1;
      now++;
      if (mode === 'same') {
        mockAction = async (opts) => {
          await opts.executeTool('quote_items', { items: [{ query: bearingB.partNo, qty: 26 }] });
          return '这张6211-2RS，26件的报价单已由顾问批准。';
        };
        await handleMessage(session.id, '这张是按6211-2RS、26件重出的并且顾问已批准的报价单吗？', 'wecom');
        assert.deepEqual((await store.drainStore(5000)).undrained, []);
      } else
        await registry.execute(
          'quote_items',
          {
            items: [
              { query: mode === 'model' ? bearingA.partNo : bearingB.partNo, qty: mode === 'qty' ? 30 : 26 },
              ...(mode === 'extra' ? [{ query: bearingA.partNo, qty: 20 }] : []),
            ],
          },
          context(session),
        );
      if (mode === 'version') {
        const draft = readState(session).rfqDraft!;
        writeState(session, { rfqDraft: { ...draft, lines: [{ match: 'exact', code: bearingB.id, version: 999, qty: 26 }] } });
      }
      assert.equal(latestQuoteCandidate(session, now)?.kind, mode === 'same' ? 'quote' : 'draft', mode);
      if (mode === 'expired') {
        assert.equal(expiredQuoteAwaitingConfirmation(session, now), true);
        assert.match(
          runtime.contextNote!({
            session,
            text: '',
            policy: defaultIndustrialPolicy,
          } as unknown as import('./core/pack-api.js').TurnContext).join(''),
          /本次试算/,
        );
      }
      mockAction = async () => '已确认您接受这份报价。';
      now++;
      const reply = await handleMessage(session.id, '好，这张按6211-2RS 26件出的报价单我确认没问题，接受这单，就按这个价格采购。', 'wecom');
      assert.deepEqual((await store.drainStore(5000)).undrained, []);
      assert.equal(order.approval!.acceptedAt !== undefined, mode === 'same', mode);
      if (mode === 'same') assert.ok(!reply.text.includes(ACCEPT_ASK), reply.text);
    }
    // A 已批准，更新的 B 待审；再试算 A 不应删掉草稿而错误指向 B。
    {
      const session = fresh();
      const orderA = await pricedOrder(session, bearingA, 20);
      const policy = config.currentPolicy().policy as typeof defaultIndustrialPolicy;
      setPolicy({ autoApproveMaxFen: 0 });
      now++;
      const result = JSON.parse(
        await registry.execute('create_quote_sheet', { items: [{ code: bearingB.id, qty: 26 }] }, context(session)),
      );
      setPolicy(policy);
      assert.equal(result.state, 'pending');
      const orderB = store.getAnyOrder(session.orderIds.at(-1)!) as LineOrder;
      assert.equal(quoteState(orderA, now), 'approved');
      now++;
      await registry.execute('quote_items', { items: [{ query: bearingA.partNo, qty: 20 }] }, context(session));
      assert.equal(latestQuoteCandidate(session, now)?.kind, 'draft', 'older approved A must not hide draft behind pending B');
      mockAction = async () => '请确认本次试算。';
      now++;
      await handleMessage(session.id, '接受这份报价，能开专票吗？', 'wecom');
      assert.equal(orderA.approval!.acceptedAt, undefined);
      assert.equal(orderB.approval!.acceptedAt, undefined);
      assert.equal(await acceptanceJobs(orderA.id), 0);
    }
    console.log('CONTEXT REPLIES PASS: 接受轮/旧型号/草稿候选、无上下文/单候选、剩余交期/摘要、同内容试算及五种新需求/审批边界');
    const makePair = async (same = false) => {
      const session = fresh();
      const old = await pricedOrder(session, same ? sameModel : bearingA, same ? 10 : 20);
      const current = await pricedOrder(session, same ? sameModel : bearingB, same ? 18 : 26);
      assert.equal(quoteState(old, now), 'superseded');
      assert.equal(old.totalFen, same ? 18990 : 28360);
      assert.equal(current.totalFen, same ? 34182 : 44928);
      assert.equal(session.moneyLedger!.filter((entry) => entry.label === '试算合计').length, 2);
      return { session, current };
    };
    for (const [modelText, expected, same] of [
      ['已确认您接受这份报价。', '已确认您接受这份报价。\n您接受的这份报价合计449.28元', false],
      ['已为您确认6211-2RS×26件订单，货款283.60元请安排对公转账（款到发货），顾问将随后与您对接收款与开票事宜。', FIXED.accepted, false],
      ['货款283.60元请安排对公转账。', FIXED.accepted, false],
      ['HS9010×18件，货款189.90元请安排对公转账。', FIXED.accepted, true],
      [
        '6211-2RS×26件，单价17.28元，行金额449.28元，合计449.28元，运费0元。',
        '6211-2RS×26件，单价17.28元，行金额449.28元，合计449.28元，运费0元。',
        false,
      ],
    ] as const) {
      const { session, current } = await makePair(same);
      mockAction = async () => modelText;
      now++;
      const reply = await handleMessage(session.id, '接受这份报价，能开专票吗？', 'wecom');
      assert.equal(reply.text, expected, modelText);
      assert.ok(!reply.text.includes(ACCEPT_ASK));
      assert.ok(current.approval!.acceptedAt !== undefined);
      assert.equal(await acceptanceJobs(current.id), 1);
    }
    const { session, current } = await makePair();
    mockAction = async (opts) => {
      // 强制账本截断，验证 turnMoney 按对象身份识别新条目，而非按数组长度取尾部。
      for (let i = 0; i < 205; i++) await opts.executeTool('find_parts', { query: data.partNo });
      await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 100 }] });
      assert.equal(session.moneyLedger!.length, 200);
      return '6205-2RS 共100件，合计900元。';
    };
    now++;
    const reply = await handleMessage(session.id, '接受这份报价，另外 6205-2RS 100 件多少钱？', 'wecom');
    assert.equal(
      reply.text,
      `试算：\n6205-2RS × 100：单价9.00元，小计900.00元；现货，以顾问确认为准\n合计900.00元\n您接受的这份报价合计449.28元\n${NEXT.accepted}`,
      '18 金额句删空正文后块后补下一步',
    );
    assert.ok(current.approval!.acceptedAt !== undefined);
    const failed = await makePair();
    mockAction = async () => '已确认您接受这份报价。';
    now++;
    assert.equal((await handleMessage(failed.session.id, '先别接受这份报价，能开专票吗？', 'wecom')).text, ACCEPT_ASK);
    assert.equal(failed.current.approval!.acceptedAt, undefined);
    mockAction = action;
    console.log('ACCEPT TURN PASS: 长句已确认、旧型号/无型号/同型号旧金额拦截、正确金额和本轮新试算放行、未接受仍要求确认');
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
    assert.equal(reply.text, '已为您转交顾问，稍后与您对接付款和发货。\n您接受的这份报价合计900.00元');
    assert.ok(session.handedOver);
    assert.ok(order.approval!.acceptedAt !== undefined);
    assert.equal(await acceptanceJobs(order.id), 1);
    console.log('MODEL HANDOFF PASS: 回复照发、接受记下、顾问通知排上');
  }

  // 18：工业包转人工告知与实际状态一致；只桩模型，走真实工具、出口、消息追加和持久化。
  {
    for (const text of [
      '已转人工。',
      '已为您转交顾问，稍后联系您。',
      '我已将您的备货需求转给顾问评估。',
      '已经转接给人工处理。',
      '转给顾问了。',
      '问题已提交给顾问处理。',
      '顾问已经接手。',
      '目录里没有这个型号，已转给顾问核实。',
      '已转交采购顾问处理，请等候联系。',
    ]) {
      assert.equal(claimsIndustrialHandoff(text), true, text);
      assert.equal(hasIndustrialHandoffNotice(text), true, text);
    }
    for (const text of [
      '需要的话，我可以为您转接顾问。',
      '如果您需要，我已转给顾问处理。',
      '稍后我会转给顾问。',
      '我准备转给顾问。',
      '我已经记下需求，可以转给顾问。',
      '我还没有转给顾问。',
      '不是已经转给顾问。',
      '是否已转给顾问？',
      '您说已转给顾问。',
      '报价单已提交给顾问审核。',
      '顾问确认后再报价。',
      '库存和交期以顾问确认为准。',
    ])
      assert.equal(claimsIndustrialHandoff(text), false, text);
    for (const text of [
      '顾问会继续确认',
      '顾问会与您联系。',
      '稍后顾问会与您联系。',
      '我请顾问继续跟您核对。',
      '目前没有库存，顾问会与您联系。',
      '新报价单已提交，顾问会核对处理，请稍等联系。',
      '您希望进一步议价的话，我已把需求转给顾问，会尽快与您联系核对。',
      '正在为您转接顾问，请稍候。',
      '我帮您转给顾问核实。',
    ])
      assert.equal(hasIndustrialHandoffNotice(text), true, text);
    for (const text of [
      '需要的话顾问会与您联系。',
      '顾问会与您联系吗？',
      '顾问不会联系您。',
      '顾问未接手。',
      '我不转给顾问。',
      '库存和交期以顾问确认为准。',
      '需要的话，我可以为您转接顾问。',
    ])
      assert.equal(hasIndustrialHandoffNotice(text), false, text);

    const action = mockAction;
    const traces: import('./trace/recorder.js').FinishedTurn[] = [];
    const stop = onTurnEnd((turn) => traces.push(turn));
    try {
      const lost = fresh();
      mockAction = async (opts) => {
        await opts.executeTool('handoff_to_human', { reason: '额外优惠请顾问核实' });
        return '额外减50元超出了我能承诺的范围，我已转给顾问评估。您可以补充需求。';
      };
      const restored = await handleMessage(lost.id, '还能优惠吗？', 'wecom');
      assert.equal(restored.handoff, true);
      assert.equal(restored.silent, undefined);
      assert.match(restored.text, /顾问会继续确认/);
      assert.doesNotMatch(restored.text, /50元/);
      assert.ok(traces.at(-1)!.turn.guards.some((guard) => guard.guard === 'money_provenance'));
      assert.ok(traces.at(-1)!.turn.guards.some((guard) => guard.guard === 'handoff_claims'));

      const kept = fresh();
      const notice = '已为您转交顾问，稍后与您对接。';
      mockAction = async (opts) => {
        await opts.executeTool('handoff_to_human', { reason: '需要顾问核实' });
        return notice;
      };
      assert.equal((await handleMessage(kept.id, '请核实情况', 'wecom')).text, notice, '已有告知不重复补');
      const handoff = structuredClone(kept.handoff);
      mockAction = async () => {
        throw new Error('已转人工的旧会话不应调模型');
      };
      const silent = await handleMessage(kept.id, '再核实一下', 'wecom');
      assert.equal(silent.silent, true);
      assert.equal(silent.text, '');
      assert.deepEqual(kept.handoff, handoff);

      for (const [history, input] of [
        [[], '那就直接转给顾问核实吧'],
        [[['agent', '需要我转给顾问核实吗？']], '好的，麻烦了'],
        [
          [
            ['customer', '请转给顾问核实'],
            ['agent', '我来处理。'],
          ],
          '我等结果',
        ],
        [
          [
            ['agent', '需要我转给顾问核实吗？'],
            ['customer', '可以，麻烦了'],
            ['agent', '我来处理。'],
          ],
          '我等结果',
        ],
      ] as const) {
        const session = fresh();
        for (const [role, content] of history) session.messages.push({ role, content, at: now });
        mockAction = async () => '好的，已转给顾问核实。';
        const reply = await handleMessage(session.id, input, 'wecom');
        assert.equal(reply.handoff, true, input);
        assert.equal(reply.silent, undefined, 'claimed 不被后置接管检查误当成人工抢占');
        assert.equal(session.handoff?.kind, 'claimed');
        assert.equal(reply.text, '好的，已转给顾问核实。');
        assert.ok(session.messages.some((message) => message.role === 'system' && /AI 已转人工/.test(message.content)));
        assert.ok(traces.at(-1)!.turn.guardVerdicts?.some((verdict) => verdict.id === 'handoff_claims' && verdict.action === 'handoff'));
      }

      for (const [history, input] of [
        [[], '能开专票吗？'],
        [[], '如果还没结果，请转给顾问'],
        [
          [
            ['customer', '请转给顾问核实'],
            ['agent', '我来处理。'],
          ],
          '不用了',
        ],
        [[['agent', '请确认采购数量。']], '可以，数量没问题'],
        [
          [
            ['customer', '请转给顾问核实'],
            ['agent', '我来处理。'],
          ],
          '先不用转给顾问，你继续帮我查',
        ],
        [
          [
            ['customer', '请转给顾问核实'],
            ['agent', '我来处理。'],
            ['customer', '不用了'],
            ['agent', '好的。'],
          ],
          '能开专票吗？',
        ],
      ] as const) {
        const session = fresh();
        for (const [role, content] of history) session.messages.push({ role, content, at: now });
        mockAction = async () => '已转给顾问核实。您可以补充型号。';
        const reply = await handleMessage(session.id, input, 'wecom');
        assert.equal(session.handedOver, false, input);
        assert.doesNotMatch(reply.text, /已转给/);
        assert.match(reply.text, /这个我记下了，会请顾问跟您确认/);
        assert.match(reply.text, /您可以补充型号/);
        assert.ok(session.messages.some((message) => message.role === 'system' && /待顾问跟进/.test(message.content)));
      }
      const offered = fresh();
      mockAction = async () => '需要的话，我可以为您转接顾问。';
      const proposal = await handleMessage(offered.id, '还能优惠吗？', 'wecom');
      assert.equal(proposal.text, '需要的话，我可以为您转接顾问。');
      assert.equal(offered.handedOver, false);
      assert.equal(
        offered.messages.some((message) => /待顾问跟进/.test(message.content)),
        false,
      );

      // 金额合法但被放块步骤移走的整句，同样要恢复告知。
      const block = fresh();
      mockAction = async (opts) => {
        const quote = JSON.parse(await opts.executeTool('quote_items', { items: [{ query: data.partNo, qty: 100 }] }));
        await opts.executeTool('handoff_to_human', { reason: '顾问核对采购需求' });
        return `合计${quote.total}元，已转给顾问核实。`;
      };
      const blocked = await handleMessage(block.id, '请核实情况', 'wecom');
      assert.equal(blocked.handoff, true);
      assert.match(blocked.text, /顾问会继续确认/);
      assert.match(blocked.text, /试算：/);

      const long = fresh();
      mockAction = async (opts) => {
        await opts.executeTool('handoff_to_human', { reason: '顾问核对需求' });
        return Array.from({ length: 12 }, () => '您可以补充需求。').join('\n');
      };
      const bounded = await handleMessage(long.id, '请核实情况', 'wecom');
      assert.match(bounded.text, /顾问会继续确认/);
      assert.ok(bounded.text.split('\n').filter(Boolean).length <= 12);
      assert.ok([...bounded.text.replace(/\s/gu, '')].length <= 600);
      const { guardOutbound } = await import('./core/engine/index.js');
      const followup = fresh();
      await guardOutbound(followup, '已转给顾问核实。', { kind: 'followup' });
      assert.equal(followup.handedOver, false);
      assert.equal(followup.messages.length, 0);
    } finally {
      stop();
      mockAction = action;
    }
    console.log(
      'HANDOFF CLAIMS PASS: 工业词表正反例、金额删句/放块后补告知、不重复、本轮/上轮同意、未要求改待跟进、条件句、撤回与旧同意、已转静默、预算与跟进隔离',
    );
  }

  // 判定有效之后还隔着模型调用和异步步骤：这期间报价失效，不记接受、不通知顾问、不写确认状态。
  // 这一轮照常收场，发给客户的和会话记录是同一句，模型说的「已确认」不能发出去。
  const staleClaim = '好的，已确认您接受这份报价，可以开专票。';
  const withdrawnText = '这份报价单已撤回，顾问会跟您重新确认';
  const expiredText = '这份报价已过期，您这次确认没有生效。回复「重新报价」，我按原来的型号和数量重新算价。';
  const askAgain = '这份报价还需要您明确确认：请回复「接受这份报价」，我再通知顾问安排付款和发货。';
  const stateAfter = {
    withdrawn: 'invalid',
    superseded: 'superseded',
    expired: 'expired',
    paid: 'paid',
    filtered: 'invalid',
    repeat: 'invalid',
  };
  const turns: import('./trace/recorder.js').FinishedTurn[] = [];
  const stopTurns = onTurnEnd((turn) => turns.push(turn));
  for (const mode of ['withdrawn', 'superseded', 'expired', 'paid', 'filtered', 'repeat'] as const) {
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    now++;
    if (mode === 'repeat') await handleMessage(session.id, '确认下单', 'wecom');
    const before = { confirmedQuoteAt: readState(session).confirmedQuoteAt, acceptedAt: order.approval!.acceptedAt };
    const action = mockAction;
    mockAction = async (opts) => {
      if (mode === 'superseded') await opts.executeTool('create_quote_sheet', { items: [{ code: data.id, qty: 101 }] });
      else if (mode === 'expired') order.approval!.validUntil = now - 1;
      else if (mode === 'paid') await actions.markPaidByAdvisor(order.id, actor);
      else await actions.withdrawQuote(order.id, actor);
      if (mode === 'filtered') throw __llmTest.httpError(400, '{"code":1301}');
      return staleClaim;
    };
    const reply = await handleMessage(session.id, '确认下单，能开专票吗', 'wecom');
    mockAction = action;
    assert.equal(quoteState(order, now), stateAfter[mode], mode);
    const latest = store.getAnyOrder(readState(session).lastQuoteId as string) as LineOrder;
    const expected =
      mode === 'paid'
        ? `${staleClaim}\n您接受的这份报价合计${(order.totalFen / 100).toFixed(2)}元`
        : mode === 'superseded'
          ? `报价单：/quote/${latest.id}\n合计${orderDisplay(latest).totalText}\n${askAgain}`
          : mode === 'expired'
            ? expiredText
            : withdrawnText;
    assert.equal(reply.text, expected, mode);
    assert.equal(
      turns.at(-1)!.turn.blocks?.suppressed,
      mode === 'filtered' ? undefined : mode !== 'paid',
      '18 最终接受核验整段替换的块 trace 与实际回复一致',
    );
    assert.equal(session.messages.at(-1)!.content, reply.text, mode);
    if (mode === 'superseded')
      assert.deepEqual(
        partsOf(reply.text).map((part) => part.url),
        [`/quote/${latest.id}`],
      );
    if (mode === 'superseded')
      assert.deepEqual((session.messages.at(-1) as unknown as Record<string, unknown>).quoteStates, { [latest.id]: 'approved' });
    assert.equal(readState(session).confirmedQuoteAt, before.confirmedQuoteAt, mode);
    assert.equal(order.approval!.acceptedAt, before.acceptedAt, mode);
    assert.equal(await acceptanceJobs(order.id), mode === 'repeat' ? 1 : 0, mode);
    assert.equal(
      turns.at(-1)!.turn.guards.some((event) => event.guard === 'quote_accept_stale' && event.action === 'replace'),
      mode !== 'paid',
      mode,
    );
  }

  // 确定性路径：判定之后还要等核对固定句。
  {
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    now++;
    const fixed = runtime.fixedReplies!.find((entry) => entry.id === 'industrial.accepted')!;
    const samples = fixed.samples;
    fixed.samples = async () => {
      await actions.withdrawQuote(order.id, actor);
      return samples();
    };
    const reply = await handleMessage(session.id, '确认下单', 'wecom');
    fixed.samples = samples;
    assert.equal(reply.text, withdrawnText);
    assert.equal(session.messages.at(-1)!.content, reply.text);
    assert.equal(readState(session).confirmedQuoteAt, undefined);
    assert.equal(order.approval!.acceptedAt, undefined);
    assert.equal(await acceptanceJobs(order.id), 0);
  }

  // 判定和记接受是同一个时刻：时钟走过有效期末尾时，这一轮要么记下要么说实话，不能整轮报错。
  {
    const clock = Date.now;
    const action = mockAction;
    for (const [text, filtered] of [
      ['确认下单', false],
      ['确认下单，能开专票吗', false],
      ['确认下单，能开专票吗', true],
    ] as const) {
      mockAction = async () => {
        if (filtered) throw __llmTest.httpError(400, '{"code":1301}');
        return '可以开专票。';
      };
      const outcomes = new Set<boolean>();
      for (let margin = 0; margin < 200; margin++) {
        const label = `${text} ${filtered} ${margin}`;
        const session = fresh();
        await estimate(session);
        const { order } = await make(session);
        now++;
        assert.deepEqual((await store.drainStore(5000)).undrained, []);
        order.approval!.validUntil = now + margin;
        Date.now = () => now++;
        const reply = await handleMessage(session.id, text, 'wecom').finally(() => {
          Date.now = clock;
        });
        const recorded = order.approval!.acceptedAt !== undefined;
        outcomes.add(recorded);
        assert.notEqual(reply.text, recorded ? expiredText : '好的，顾问会尽快联系您确认付款和发货', label);
        assert.equal(session.messages.at(-1)!.content, reply.text, label);
        assert.equal(readState(session).confirmedQuoteAt !== undefined, recorded, label);
        assert.equal(await acceptanceJobs(order.id), recorded ? 1 : 0, label);
      }
      assert.equal(outcomes.size, 2, `${text} ${filtered}：有效期末尾两种结果都要走到`);
    }
    mockAction = action;
  }

  // 话里让客户回的那句要真能续算：不用重说型号和数量。
  {
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    now++;
    const action = mockAction;
    mockAction = async () => {
      order.approval!.validUntil = now - 1;
      return staleClaim;
    };
    assert.equal((await handleMessage(session.id, '确认下单，能开专票吗', 'wecom')).text, expiredText);
    mockAction = async () => '好的。';
    const reply = await handleMessage(session.id, '重新报价', 'wecom');
    mockAction = action;
    const unitPrice = order.lines[0]!.unitPriceFen / 100;
    assert.equal(
      reply.text,
      `原报价单已过期，已按当前价重新试算，合计${unitPrice * order.lines[0]!.qty}元。请确认本次试算，确认后再起草新的报价单。`,
    );
    assert.deepEqual(
      readState(session).rfqDraft!.lines.map((line) => ['code' in line ? line.code : null, line.qty]),
      order.lines.map((line) => [line.code, line.qty]),
    );
    assert.equal(order.approval!.acceptedAt, undefined);
    assert.equal(await acceptanceJobs(order.id), 0);
  }

  // 复核只认本会话的这张报价；替换用的固定句已登记。
  {
    const session = fresh();
    await estimate(session);
    const { order } = await make(session);
    assert.equal(actions.acceptanceState(session, order.id, now), 'approved');
    assert.equal(actions.acceptanceState({ ...session }, order.id, now), 'invalid');
    assert.equal(actions.acceptanceState(fresh(), order.id, now), 'invalid');
    assert.equal(actions.acceptanceState(session, 'ord_missing', now), 'invalid');
    const plain = await createLineOrder(session, [{ kind: 'part', code: data.id, qty: 1 }], { approval: false });
    assert.ok('order' in plain);
    assert.equal(actions.acceptanceState(session, plain.order.id, now), 'invalid');
    assert.throws(() => actions.recordQuoteAccepted(session, plain.order.id), actions.QuoteStateError);
    for (const [id, text] of [
      ['industrial.quote_expired', expiredText],
      ['industrial.quote.withdrawn', withdrawnText],
    ]) {
      const samples = await runtime.fixedReplies!.find((entry) => entry.id === id)!.samples();
      assert.ok(samples.every((sample) => sample.text === text));
    }
  }
  stopTurns();
  console.log('STALE ACCEPT PASS: 发送前报价失效：不记接受、不通知、不写确认状态，回复说实话且与会话记录一致');

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
      if (mode === 'expired') order.approval!.validUntil = now - 1;
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
  for (const expected of snapshotOrders) {
    const loaded = store.getAnyOrder(expected.id) as LineOrder;
    assert.notEqual(loaded, expected);
    assert.deepEqual(loaded.approval, expected.approval, '清空内存从库重载后批准快照保留');
    assert.equal(quoteValidUntil(loaded), expected.approval!.validUntil);
    assert.deepEqual((await getQuote(loaded.id)).body.notes, expected.approval!.notes);
  }
  console.log('QUOTE SNAPSHOT RELOAD PASS: 清空会话和订单缓存后从库恢复，人工/自动快照及公开说明不变');
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
  // 文件模式中旧单读当前 policy.json，新批准取当时政策，带快照单不读其他租户的政策。
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
      assert.deepEqual(((await res.json()) as PublicQuote).notes, approved.order.approval!.notes);
      delete readable.approval!.validUntil;
      delete readable.approval!.notes;
      const legacy = await app.request(`/api/quotes/${readable.id}`, { headers: { host: 'file.example.test' } });
      assert.deepEqual(((await legacy.json()) as PublicQuote).notes, quoteNotes(filePolicy));
      // 批准快照的文件政策读取与旧单回退使用同一 policy.json。
      readable.approval = snapshotQuoteApproval(readable, { state: 'approved', requestedAt: now, decidedAt: now });
      assert.deepEqual(readable.approval.notes, quoteNotes(filePolicy));
      const fileDeadline = readable.approval.validUntil;
      assert.equal(typeof fileDeadline, 'number');
      fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...filePolicy, quoteValidDays: 0, taxIncluded: true }));
      assert.equal(quoteValidUntil(readable), fileDeadline);
      const locked = await app.request(`/api/quotes/${readable.id}`, { headers: { host: 'file.example.test' } });
      assert.deepEqual(((await locked.json()) as PublicQuote).notes, quoteNotes(filePolicy));
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
