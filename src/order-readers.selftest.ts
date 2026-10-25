// 08 第 15 步：PGlite 证明包的订单出口、付款与只读状态的读者；旅游字节由 legacy-bytes 独立锁定。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobRow } from './db/repo/jobs.js';
import type { HandoffNotice } from './notify/notifier.js';
import type { OrderView } from './shared/console-api.js';

if (process.argv[2] !== 'worker') {
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
    env: { ...process.env, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-readers-'));
  process.env.VAR_DIR = dir;
  for (const key of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[key] = '';
  const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('./db/testing.js'));
  const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
  const { bindPack } = await import('./core/pack-api.js');
  const { packSources, closeConfig, __configTest } = await import('./config/source.js');
  const { packById, runtimeById } = await import('./packs/registry.js');
  const { createCatalogItem, activateCatalogItem } = await import('./config/catalog.js');
  const { createLineOrder, orderDisplay } = await import('./core/order-view.js');
  const { confirmOrder, cancelOrder, markPaidByAdvisor, OrderStateError } = await import('./payment/orders.js');
  const { release } = await import('./handoff/takeover.js');
  const { runHandoffNotifyJob } = await import('./notify/handoff.js');
  const { __notifierTest } = await import('./notify/notifier.js');
  const { purgeOnce } = await import('./jobs/purge.js');
  const { aggregate } = await import('./core/insight.js');
  const { dealsByOrigin, summarizeOrders } = await import('./ops/board.js');
  const { __profileTest } = await import('./profile.js');
  const store = await import('./store.js');
  const t = await testing.openTestDb();
  const notices: HandoffNotice[] = [];
  __notifierTest.use({
    async send(notice) {
      notices.push(notice);
    },
  });
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
    const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const actor = { userId: null, name: '合成顾问', role: 'owner' as const };
    for (const payload of [
      { id: 'w-a', title: '合成方盒甲', unitPrice: 3.8, unit: '件', tags: ['合成'], tiers: [{ minQty: 100, unitPrice: 3.65 }] },
      { id: 'w-b', title: '合成方盒乙', unitPrice: 12, unit: '件', tags: ['合成'] },
    ]) {
      const row = await createCatalogItem(ctx, 'widget', payload);
      await activateCatalogItem(ctx, 'widget', row.code, { rev: row.rev });
    }
    const picks = [
      { kind: 'widget', code: 'w-a', qty: 200 },
      { kind: 'widget', code: 'w-b', qty: 50 },
    ];
    async function makeOrder(id: string) {
      const session = store.getOrCreateSession(id, 'simulator');
      store.saveSession(session);
      const made = await createLineOrder(session, picks);
      assert.ok('order' in made);
      await store.flushSession(id);
      return { session, order: made.order };
    }
    const { session, order } = await makeOrder('readers-main');
    assert.equal(order.totalFen, 133000);
    const display = orderDisplay(order);
    const { app } = await withoutTenantScope(() => import('./server.js'));
    const { __test: wecom } = await import('./adapters/wecom.js');
    const { orderView } = await import('./console-api/workbench.js');
    const { handleMessage, notifyPaid } = await import('./core/engine/index.js');
    const get = (url: string) => app.request(url, { headers: { 'x-forwarded-for': '198.51.100.47' } });
    const publicResponse = await get(`/api/orders/${order.id}`);
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json();
    assert.deepEqual(publicBody, { id: order.id, status: 'pending_payment', display, payable: true });
    assert.equal(publicBody.display.totalText, '1,330元');
    assert.equal(publicBody.display.lines.length, 2);
    const payResponse = await get(`/pay/${order.id}`);
    assert.equal(payResponse.status, 200);
    const html = await payResponse.text();
    const head = html.match(/<title>[\s\S]*?<\/title>[\s\S]*?<meta property="og:description"[^>]*>/)?.[0] ?? '';
    assert.ok(head.includes(`<title>${display.title} · 订单支付</title>`));
    assert.ok(head.includes(`content="${display.summary} · 合计 ${display.totalText}"`));
    const card = wecom.extractCard(`/pay/${order.id}`, 'https://shop.example.test');
    assert.deepEqual(card, {
      title: `${display.title} · 待支付`,
      desc: `${display.summary} · 合计 ${display.totalText}`,
      url: `https://shop.example.test/pay/${order.id}`,
      raw: `/pay/${order.id}`,
    });
    // 同步的付款卡只依赖订单：会话不在内存时也能展示。
    rt.store.sessions.delete(session.id);
    assert.deepEqual(wecom.extractCard(`/pay/${order.id}`, 'https://shop.example.test'), card);
    rt.store.sessions.set(session.id, session);
    const projected = orderView(order);
    assert.ok('display' in projected);
    assert.deepEqual(projected.display, display);
    assert.equal(projected.totalFen, 133000);
    assert.equal(projected.totalText, '1,330元');
    for (const text of [JSON.stringify(publicBody), html, JSON.stringify(card), JSON.stringify(projected)]) {
      assert.doesNotMatch(text, /出行|出发|线路/);
    }
    for (const text of [JSON.stringify(publicBody), head, JSON.stringify(card), JSON.stringify(projected)]) {
      assert.doesNotMatch(text, /routeId|routeTitle|travelers|departDate|totalPrice/);
    }
    const escaped = await makeOrder('readers-escape');
    escaped.order.lines[0].title = '<合成&"$&>';
    store.saveOrder(escaped.order);
    const escapedHtml = await (await get(`/pay/${escaped.order.id}`)).text();
    assert.ok(escapedHtml.includes('&lt;合成&amp;&quot;$&amp;&gt;'));
    console.log('ORDER READERS PASS：133000分、公开白名单、支付完整 HTML 无旅游词、同步企微卡、后台两行投影，无旅游字段，HTML 转义');

    // 方案书能力门禁与旅游回归由同一个 app 验证。
    for (const url of ['/proposal/r-yunnan-mid/2', '/proposal/r-yunnan-mid', '/api/proposal/r-yunnan-mid', '/proposal.html']) {
      assert.equal((await get(url)).status, 404);
    }
    assert.equal(wecom.extractCard('/proposal/r-yunnan-mid/2', 'https://shop.example.test'), null);
    const goal = await get(`/api/console/conversations/${session.id}/turns/00000000-0000-0000-0000-000000000001/goal-draft`);
    // 未登录请求由鉴权拦截；下方登录后再核 404。
    assert.ok([401, 404].includes(goal.status));
    assert.equal(runtime.documents, undefined);

    const accounts = await import('./auth/accounts.js');
    const auth = await import('./auth/session.js');
    await t.pg.exec('SET ROLE agent_platform');
    const owner = { email: 'readers@example.com', password: 'readers-test-password' };
    try {
      const made = await accounts.createUser(t.db, {
        tenantSlug: tenant.slug,
        ...owner,
        name: '合成所有者',
        role: 'owner',
        password: async () => owner.password,
      });
      assert.equal(made.code, 0, made.message);
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
    const login = await app.request('/api/console/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify(owner))),
        'x-forwarded-for': '198.51.100.48',
      },
      body: JSON.stringify(owner),
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const token = cookie.slice(cookie.indexOf('=') + 1);
    assert.ok(token && cookie.startsWith(auth.SESSION_COOKIE));
    const consoleGet = (url: string) => app.request(`/api/console${url}`, { headers: { cookie, 'x-forwarded-for': '198.51.100.49' } });
    const pending = await consoleGet('/orders?status=pending_payment');
    assert.equal(pending.status, 200);
    const pendingBody = (await pending.json()) as { items: OrderView[] };
    assert.deepEqual(
      pendingBody.items.find((o) => o.id === order.id),
      orderView(order),
    );
    const detail = await consoleGet(`/conversations/${session.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).orders, [projected]);
    assert.equal((await consoleGet(`/conversations/${session.id}/turns/00000000-0000-0000-0000-000000000001/goal-draft`)).status, 404);
    const legacyList = await get('/api/orders');
    assert.ok(!(await legacyList.json()).some((o: { id: string }) => o.id === order.id));
    console.log('ORDER READERS PASS：A2 与会话详情包含通用单，旧管理列表不混入；证明包方案书/草稿路由 404');

    // 只读成员关联订单的标题与会话行使用同一个打码入口，两条 HTTP 出口都不能漏号码。
    const originalProfile = session.profile;
    session.profile = { attrs: { color: '红', size: '13812345678' } };
    store.saveSession(session);
    await store.flushSession(session.id);
    const viewerLoginBody = JSON.stringify({ email: 'viewer-readers@example.com', password: 'readers-test-password' });
    await t.pg.exec('SET ROLE agent_platform');
    try {
      const made = await accounts.createUser(t.db, {
        tenantSlug: tenant.slug,
        email: 'viewer-readers@example.com',
        name: '合成只读成员',
        role: 'viewer',
        password: async () => 'readers-test-password',
      });
      assert.equal(made.code, 0, made.message);
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
    const viewerLogin = await app.request('/api/console/auth/login', {
      method: 'POST',
      body: viewerLoginBody,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(viewerLoginBody)),
        'x-forwarded-for': '198.51.100.50',
      },
    });
    assert.equal(viewerLogin.status, 200);
    const viewerCookie = (viewerLogin.headers.get('set-cookie') ?? '').split(';')[0]!;
    const viewerGet = (url: string) =>
      app.request(`/api/console${url}`, { headers: { cookie: viewerCookie, 'x-forwarded-for': '198.51.100.51' } });
    const viewerDetailResponse = await viewerGet(`/conversations/${session.id}`);
    assert.equal(viewerDetailResponse.status, 200);
    const viewerDetail = await viewerDetailResponse.json();
    assert.equal(viewerDetail.row.needSummary, '红*******5678');
    assert.equal(viewerDetail.orders[0].conversation.needSummary, viewerDetail.row.needSummary);
    const viewerOrdersResponse = await viewerGet('/orders?status=pending_payment');
    assert.equal(viewerOrdersResponse.status, 200);
    const viewerOrders = await viewerOrdersResponse.json();
    assert.equal(viewerOrders.items.find((item: OrderView) => item.id === order.id).conversation.needSummary, '红*******5678');
    assert.doesNotMatch(JSON.stringify([viewerDetail, viewerOrders]), /13812345678/);
    const ownerDetail = await (await consoleGet(`/conversations/${session.id}`)).json();
    assert.equal(ownerDetail.orders[0].conversation.needSummary, '红13812345678');
    session.profile = originalProfile;
    store.saveSession(session);
    await store.flushSession(session.id);
    console.log('ORDER READERS PASS：viewer 会话详情与待付款列表的关联标题均打码，所有者仍看原值');

    let seenOrderIds: string[] = [];
    bindPack(
      {
        ...runtime,
        replySteps: [
          ...runtime.replySteps,
          {
            id: 'fixture_order_readers',
            after: ['stage_advance'],
            run(context) {
              seenOrderIds = context.orderSources.map((source) => source.id);
              return { action: 'pass' };
            },
          },
        ],
      },
      runtime.defaultBrand,
    );
    await handleMessage(session.id, '合成核验需求', 'simulator');
    assert.deepEqual(seenOrderIds, [order.id]);
    bindPack(runtime, runtime.defaultBrand);
    console.log('ORDER READERS PASS：引擎 orderSources 包含本会话通用单');

    const unusable = await makeOrder('readers-no-terminal');
    confirmOrder(unusable.order.id, actor);
    await store.flushSession(unusable.session.id);
    const configBefore = rt.config.loaded!;
    const stateBefore = JSON.stringify([unusable.order, unusable.session]);
    const { withTenant: auditTx } = await import('./db/client.js');
    const { readAudit: audits } = await import('./db/repo/audit.js');
    const auditBefore = await auditTx(t.db, ctx, (tx) => audits(tx, { limit: 100, action: 'order.mark_paid' }));
    let paidHookCalled = false;
    rt.config.loaded = { ...configBefore, pack: { ...pack, stages: pack.stages.filter((stage) => !stage.terminal) } };
    bindPack(
      {
        ...runtime,
        stages: runtime.stages.filter((stage) => !stage.terminal),
        engineHooks: {
          ...runtime.engineHooks,
          paidLineText: () => {
            paidHookCalled = true;
            return '不应调用';
          },
        },
      },
      runtime.defaultBrand,
    );
    try {
      await assert.rejects(notifyPaid(unusable.order.id), /__fixture.*终态/);
      assert.equal(paidHookCalled, false);
      const refused = await app.request(`/api/orders/${unusable.order.id}/pay`, { method: 'POST' });
      assert.equal(refused.status, 500);
      await assert.rejects(markPaidByAdvisor(unusable.order.id, actor), /__fixture.*终态/);
      assert.equal(JSON.stringify([unusable.order, unusable.session]), stateBefore);
      const auditAfter = await auditTx(t.db, ctx, (tx) => audits(tx, { limit: 100, action: 'order.mark_paid' }));
      assert.deepEqual(auditAfter, auditBefore);
    } finally {
      rt.config.loaded = configBefore;
      bindPack(runtime, runtime.defaultBrand);
    }
    console.log('ORDER READERS PASS：缺终态在通知、模拟付款与顾问收款前拒绝，不改订单/会话、不记收款审计');

    // owner 2026-10-24 定（plan Open 2）：默认确认与包覆盖两条路径都要发消息、进入终态。
    assert.equal(runtime.engineHooks.paidLineText, undefined);
    const paid = await app.request(`/api/orders/${order.id}/pay`, { method: 'POST' });
    assert.equal(paid.status, 200, await paid.clone().text());
    assert.deepEqual((await paid.json()).order, {
      id: order.id,
      status: 'paid',
      display,
      paidAt: order.paidAt,
      payable: false,
    });
    assert.equal(session.messages.at(-1)?.content, '已收到您的付款1,330元，订单共2项。');
    assert.equal(session.stage, 'paid');
    const paidAt = order.paidAt;
    const count = session.messages.length;
    assert.equal((await app.request(`/api/orders/${order.id}/pay`, { method: 'POST' })).status, 200);
    assert.equal(order.paidAt, paidAt);
    assert.equal(session.messages.length, count);
    bindPack({ ...runtime, engineHooks: { ...runtime.engineHooks, paidLineText: (o) => `合成确认${o.totalFen}分` } }, runtime.defaultBrand);
    const custom = await notifyPaid(order.id);
    assert.equal(custom?.text, '合成确认133000分');
    bindPack(runtime, runtime.defaultBrand);
    session.handedOver = true;
    session.stage = 'handoff';
    session.stageBeforeHandoff = 'closing';
    release(session.id, actor);
    assert.equal(session.stage, 'paid');
    assert.equal(session.handedOver, false);
    const summary = await consoleGet('/orders/summary');
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).paidTotal, 1330);
    assert.equal(aggregate([session], [order]).gmv, 1330);
    // 分累加只在出口除以 100，避免多张小额通用单出现二进制小数累加误差。
    const pennies = [1, 2].map((totalFen) => ({ ...order, totalFen, paidAt: Date.now(), handoffBeforePaid: false }));
    assert.equal(summarizeOrders(pennies, 0, Date.now() + 1000, 'standard', () => false).total.paidTotal, 0.03);
    assert.equal(dealsByOrigin(pennies, 0, 'standard', () => false).customer.aiOnlyAmount, 0.03);
    assert.equal(aggregate([], pennies).gmv, 0.03);
    console.log('ORDER READERS PASS：模拟支付幂等、默认/包自定义付款确认、交还 AI 保持终态；看板与洞察按分累加');

    const awaiting = await makeOrder('readers-advisor');
    __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
    assert.equal((await (await get(`/api/orders/${awaiting.order.id}`)).json()).payable, false);
    await assert.rejects(markPaidByAdvisor(awaiting.order.id, actor), (e) => e instanceof OrderStateError && e.status === 'unconfirmed');
    const job: JobRow = {
      id: '00000000-0000-0000-0000-000000000015',
      kind: 'handoff_notify',
      dedupeKey: 'readers-unconfirmed',
      runAt: new Date(),
      status: 'running',
      attempts: 1,
      maxAttempts: 4,
      payload: { sessionId: awaiting.session.id, reason: 'order_unconfirmed', orderId: awaiting.order.id },
      lastError: null,
      createdAt: new Date(),
      claimedAt: new Date(),
      finishedAt: null,
    };
    const beforeNotice = notices.length;
    assert.deepEqual(await runHandoffNotifyJob(job, Date.now()), { status: 'done', lastError: null });
    assert.equal(notices.length, beforeNotice + 1);
    assert.equal(notices.at(-1)?.kind, 'order_unconfirmed');
    confirmOrder(awaiting.order.id, actor);
    assert.equal((await (await get(`/api/orders/${awaiting.order.id}`)).json()).payable, true);
    assert.deepEqual(await runHandoffNotifyJob(job, Date.now()), { status: 'done', lastError: 'order_settled' });
    assert.equal(notices.length, beforeNotice + 1);
    assert.equal((await markPaidByAdvisor(awaiting.order.id, actor)).persisted, true);
    __profileTest.reset();
    const cancelled = await makeOrder('readers-cancel');
    cancelOrder(cancelled.order.id, actor, '合成取消');
    assert.equal((await app.request(`/api/orders/${cancelled.order.id}/pay`, { method: 'POST' })).status, 409);
    assert.equal((await (await get(`/api/orders/${cancelled.order.id}`)).json()).payable, false);
    const replaced = await makeOrder('readers-replaced');
    const replacement = await createLineOrder(replaced.session, [{ ...picks[0]!, qty: 201 }, picks[1]!]);
    assert.ok('order' in replacement);
    assert.equal((await app.request(`/api/orders/${replaced.order.id}/pay`, { method: 'POST' })).status, 409);
    assert.ok((await (await get(`/pay/${replaced.order.id}`)).text()).includes('订单已被替代'));
    console.log('ORDER READERS PASS：确认/收款/取消动作支持通用单；未确认提醒送达，确认后停止；取消和替代后禁止付款');

    const { withTenant } = await import('./db/client.js');
    const { readAudit } = await import('./db/repo/audit.js');
    // 审计既记录整数分，也以两位小数格式展示；旧旅游退款的金额分支不改。
    const auditRows = await withTenant(t.db, ctx, (tx) => readAudit(tx, { limit: 100 }));
    assert.ok(auditRows.some((entry) => entry.action === 'order.mark_paid' && (entry.diff as { totalFen?: number })?.totalFen === 133000));
    assert.ok(auditRows.some((entry) => entry.action === 'order.confirm' && (entry.diff as { totalFen?: number })?.totalFen === 133000));
    const { describeAudit } = await import('./shared/audit-text.js');
    for (const action of ['order.confirm', 'order.mark_paid']) {
      const row = auditRows.find((entry) => entry.action === action)!;
      assert.equal(describeAudit({ ...row, at: row.at.toISOString(), diff: { totalFen: 133050 } }, pack).tail, '（1,330.50元）');
    }

    // 从种子导入历史会话：updated_at 只进不退，不倒改已有记录，也不绕过清理 SQL 的数据库时钟校验。
    const { writeSeedSessions } = await import('./cli/session-transfer.js');
    const oldAt = Date.now() - 200 * 86_400_000;
    const retainedOrder = { ...order, id: 'ord_readers_retained', sessionId: 'readers-retained', createdAt: oldAt, paidAt: oldAt };
    const retainedSession = {
      ...session,
      id: retainedOrder.sessionId,
      orderIds: [retainedOrder.id],
      messages: [],
      createdAt: oldAt,
      updatedAt: oldAt,
    };
    await withTenant(t.db, ctx, (tx) => writeSeedSessions(tx, [retainedSession], [retainedOrder]));
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(fx.deps);
    const purged = await purgeOnce(Date.now());
    assert.equal(purged.preFiltered, 1);
    assert.ok(store.getSession(retainedSession.id));
    console.log('ORDER READERS PASS：通用单审计 totalFen；仅有通用已付单的客户按成交保留期预过滤保护');

    // 旅游能力显式开启，原公开方案路由与卡片继续可用。
    const fixtureConfig = rt.config.loaded;
    rt.config.loaded = travel;
    const travelRuntime = runtimeById('travel', packSources())!;
    bindPack(travelRuntime, null);
    try {
      assert.deepEqual(travelRuntime.documents, { proposal: true });
      assert.equal((await get('/proposal/r-yunnan-mid/2')).status, 200);
      assert.equal((await get('/api/proposal/r-yunnan-mid')).status, 200);
      assert.ok(wecom.extractCard('/proposal/r-yunnan-mid/2', 'https://shop.example.test'));
    } finally {
      rt.config.loaded = fixtureConfig;
      bindPack(runtime, runtime.defaultBrand);
    }
    console.log('ORDER READERS PASS：旅游显式声明方案书，公开路由和企微方案卡照常');
  } finally {
    __profileTest.reset();
    __notifierTest.use(null);
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
