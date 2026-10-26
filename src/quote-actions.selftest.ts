// 09 D：状态表、条件并发、提交重读、权限审计、单卡片发送和持久化提醒。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { LineOrder } from './core/order-view.js';

// 独立新进程读取同一份磁盘库，证明去重不靠父进程的内存。
if (process.argv[2] === '--restart') {
  const [varDir, tenantId, slug, orderId, expectedAt] = process.argv.slice(3) as [string, string, string, string, string];
  Object.assign(process.env, { VAR_DIR: varDir, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' });
  const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('./db/testing.js'));
  const t = await testing.openTestDb({ dataDir: path.join(varDir, 'pg') });
  const config = await import('./config/source.js');
  const store = await import('./store.js');
  try {
    await testing.installSeededConfig(t);
    identifyRuntime(rt, { id: tenantId, slug, kind: rt.kind, isHost: rt.isHost, publicBase: rt.publicBase, expiresAt: rt.expiresAt });
    rt.config.loaded!.tenantId = tenantId;
    rt.config.loaded!.deps.tenantSlug = slug;
    const { packById } = await import('./packs/registry.js');
    rt.config.loaded!.pack = packById('__fixture')!;
    const { createFixtureQuoteRuntime } = await import('./packs/__fixture/runtime.js');
    const { bindPack } = await import('./core/pack-api.js');
    const runtime = createFixtureQuoteRuntime(config.packSources());
    bindPack(runtime, runtime.defaultBrand);
    const fx = await testing.installPgSessionStore(t, { slug, varDir });
    await store.initSessionStore(fx.deps);
    const order = store.getAnyOrder(orderId) as LineOrder;
    assert.equal(order.approval!.acceptedAt, Number(expectedAt));
    const { recordQuoteAccepted } = await import('./payment/orders.js');
    assert.equal(recordQuoteAccepted(store.getSession(order.sessionId)!, orderId), false);
    await store.drainStore(5000);
    await t.pg.exec('RESET ROLE');
    const jobs = await t.pg.query<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [`quote_accepted:${orderId}`]);
    assert.equal(jobs.rows[0]!.n, 1);
    console.log('QUOTE PROCESS RESTART PASS: 新进程再次确认，首次时间保留、已完成任务仍只有一个');
  } finally {
    rt.store.pgBackend?.close();
    rt.store.fileBackend?.reset();
    if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
    if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
    await config.closeConfig();
    await t.close();
  }
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-actions-'));
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
const { createCatalogItem, activateCatalogItem } = await import('./config/catalog.js');
const { createLineOrder, quoteState } = await import('./core/order-view.js');
const { __profileTest } = await import('./profile.js');
const store = await import('./store.js');
const t = await testing.openTestDb({ dataDir: path.join(dir, 'pg') });
let dbClosed = false;
const realNow = Date.now;
let now = realNow();
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
    { id: 'w-a', title: '合成方盒甲', unitPrice: 3.65, unit: '件', tags: ['合成'] },
    { id: 'w-b', title: '合成方盒乙', unitPrice: 12, unit: '件', tags: ['合成'] },
  ]) {
    const row = await createCatalogItem(ctx, 'widget', item);
    await activateCatalogItem(ctx, 'widget', row.code, { rev: row.rev });
  }
  Date.now = () => now;
  const s = store.getOrCreateSession('wecom:wmquote', 'wecom');
  const make = async (qty: number, session = s): Promise<LineOrder> => {
    const result = await createLineOrder(session, [{ kind: 'widget', code: 'w-a', qty }]);
    assert.ok('order' in result);
    return result.order;
  };
  const actions = await import('./payment/orders.js');
  const tk = await import('./handoff/takeover.js');
  const { conversationDetail } = await import('./console-api/workbench.js');
  const { __notifierTest, noticeText } = await import('./notify/notifier.js');
  const { runHandoffNotifyJob } = await import('./notify/handoff.js');
  const { quoteNotifyOps } = await import('./jobs/notify.js');
  const { messageToRow } = await import('./store/project.js');
  const { claimDueJobs, setJobStatus } = await withoutTenantScope(() => import('./db/repo/jobs.js'));
  const { withTenant } = await withoutTenantScope(() => import('./db/client.js'));
  const actor = { userId: null, name: '合成主管', role: 'supervisor' as const };
  const agent = { userId: 'a1000000-0000-4000-8000-000000000001', name: '合成顾问', role: 'agent' as const };
  const other = { userId: 'a1000000-0000-4000-8000-000000000002', name: '另一顾问', role: 'agent' as const };
  await t.pg.exec('RESET ROLE');
  for (const who of [agent, other])
    await t.pg.query("insert into users (id,email,display_name,password_hash) values ($1,$2,$3,'synthetic-unused')", [
      who.userId,
      `${who.name}@example.com`,
      who.name,
    ]);
  await t.pg.exec('SET ROLE agent_app');
  const sent: { id: string; text: string; opts: import('./types.js').PushOpts }[] = [];
  tk.setReplyTransport(async (id, text, opts) => {
    sent.push({ id, text, opts });
    return true;
  });
  let seq = 0;
  type State = 'pending' | 'approved' | 'expired' | 'rejected' | 'withdrawn' | 'superseded' | 'paid';
  const fresh = async (state: State = 'pending', channel: 'wecom' | 'simulator' = 'wecom') => {
    const session = store.getOrCreateSession(`wecom:wmD${++seq}`, channel);
    const order = await make(500, session);
    if (state !== 'pending') {
      order.approval!.state = state === 'rejected' || state === 'withdrawn' ? state : 'approved';
      order.approval!.decidedAt = state === 'expired' ? now - 10 * 86_400_000 : now;
      if (state === 'paid' || state === 'superseded') order.status = state;
      if (state === 'withdrawn' || state === 'rejected') order.status = 'cancelled';
      store.saveOrder(order);
    }
    await store.flushSession(session.id);
    return { session, order };
  };
  const code = (expected: string) => (e: unknown) => e instanceof actions.QuoteStateError && e.code === expected;
  // 状态表的审批、驳回、撤回、收款逐格断言；建新单与重置也各遍历七状态。
  const matrix: Record<State, readonly (string | null)[]> = {
    pending: [null, null, null, 'not_approved'],
    approved: [null, 'already_decided', null, null],
    expired: [null, 'already_decided', null, null],
    rejected: ['already_decided', 'invalid', null, 'invalid'],
    withdrawn: ['invalid', 'invalid', null, 'invalid'],
    superseded: ['superseded', 'superseded', 'superseded', 'superseded'],
    paid: ['paid', 'paid', 'paid', null],
  };
  for (const state of Object.keys(matrix) as State[]) {
    for (const [i, act] of [
      actions.approveQuote,
      actions.rejectQuote,
      actions.withdrawQuote,
      (id: string, a: typeof actor) => actions.markPaidByAdvisor(id, a),
    ].entries()) {
      const { session, order } = await fresh(state);
      const before = JSON.stringify(order);
      const lines = JSON.stringify(order.lines);
      const sendBefore = sent.length;
      const invoke = () => act(order.id, actor, '仅顾问可见');
      const expected = matrix[state][i];
      if (expected) {
        await assert.rejects(invoke(), code(expected), `${state}/${i}`);
        assert.equal(JSON.stringify(order), before);
      } else {
        await invoke();
        const next = i === 0 ? (state === 'pending' ? 'approved' : state) : i === 3 ? 'paid' : 'invalid';
        assert.equal(quoteState(order, now), next, `${state}/${i}`);
        if (i === 0) assert.equal(sent.length - sendBefore, state === 'pending' ? 1 : 0, '一次批准只发一次');
        if (i === 1) {
          assert.equal(order.cancelReason, '顾问驳回：仅顾问可见');
          assert.equal(session.assignee?.name, actor.name);
          assert.equal(session.handoff?.kind, 'agent');
          assert.doesNotMatch(sent.at(-1)!.text, /仅顾问可见/);
        }
        if (i === 2) assert.equal(sent.length - sendBefore, ['approved', 'expired'].includes(state) ? 1 : 0);
      }
      assert.equal(JSON.stringify(order.lines), lines, '审批不改报价行金额');
    }
    for (const auto of [false, true]) {
      const { session, order } = await fresh(state);
      await make(auto ? 1 : 501, session);
      const replaced = state === 'pending' || state === 'expired' || (auto && state === 'approved');
      assert.equal(
        quoteState(order, now),
        replaced ? 'superseded' : state === 'rejected' || state === 'withdrawn' ? 'invalid' : state,
        `建新单/${state}/${auto}`,
      );
    }
    const { session, order } = await fresh(state);
    const approval = structuredClone(order.approval);
    store.deleteOrdersOfSession(session.id);
    session.orderIds = [];
    store.saveSession(session);
    await store.flushSession(session.id);
    assert.equal(store.getAnyOrder(order.id), undefined);
    assert.deepEqual(order.approval, approval, '重置不改审批历史');
  }
  console.log('QUOTE MATRIX PASS: 七状态 × 六动作（新单含自动批准），金额不可变、过期撤回仍通知');

  for (const first of ['approve', 'reject'] as const) {
    const { order } = await fresh();
    const outcomes = await Promise.allSettled(
      first === 'approve'
        ? [actions.approveQuote(order.id, actor), actions.rejectQuote(order.id, actor, '需调整')]
        : [actions.rejectQuote(order.id, actor, '需调整'), actions.approveQuote(order.id, actor)],
    );
    assert.equal(outcomes[0]!.status, 'fulfilled');
    assert.equal(outcomes[1]!.status, 'rejected');
    assert.ok(code('already_decided')((outcomes[1] as PromiseRejectedResult).reason));
  }
  for (const initial of ['pending', 'approved'] as const)
    for (const change of ['withdraw', 'reset', 'supersede'] as const) {
      const { session, order } = await fresh(initial);
      const sendBefore = sent.length;
      let release!: () => void;
      fx.faults.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // 幂等批准也要真的处于等提交中：先留一条尚未提交的会话写入。
      session.messages.push({ role: 'customer', content: '请核对报价', at: now });
      store.saveSession(session, false);
      const deciding = actions.approveQuote(order.id, actor);
      let changing: Promise<unknown> | undefined;
      if (change === 'withdraw') changing = actions.withdrawQuote(order.id, actor);
      if (change === 'reset') {
        store.deleteOrdersOfSession(session.id);
        session.orderIds = [];
        store.saveSession(session);
      }
      if (change === 'supersede') {
        const newer = await make(501, session);
        changing = actions.approveQuote(newer.id, actor);
      }
      const failed = assert.rejects(deciding, code(change === 'supersede' ? 'superseded' : 'invalid'));
      fx.faults.gate = null;
      release();
      await failed;
      await changing;
      const approvals = sent.slice(sendBefore).filter((m) => m.text === `/quote/${order.id}`);
      assert.equal(approvals.length, 0, `${change}: 提交后失效不发旧报价`);
    }
  console.log('QUOTE CONCURRENCY PASS: 审批两种先后、提交期间撤回/重置/另一单批准，旧链接零推送');

  for (const role of ['owner', 'admin', 'supervisor', 'agent', 'viewer', 'shared'] as const) {
    for (const ownership of ['ai', 'mine', 'other', 'unassigned'] as const) {
      for (const act of ['approve', 'reject', 'withdraw'] as const) {
        const { session, order } = await fresh();
        if (ownership !== 'ai') {
          tk.takeover(session.id, ownership === 'other' ? other : agent);
          if (ownership === 'unassigned') session.assignee = null;
        }
        const who = { ...agent, role };
        const allowed = ['owner', 'admin', 'supervisor'].includes(role) || (role === 'agent' && ['ai', 'mine'].includes(ownership));
        assert.equal(actions.canDecideQuote(session, who), allowed);
        const invoke = () =>
          act === 'approve'
            ? actions.approveQuote(order.id, who)
            : act === 'reject'
              ? actions.rejectQuote(order.id, who, '合成调整')
              : actions.withdrawQuote(order.id, who);
        if (allowed) {
          await invoke();
          if (act === 'reject' && ownership === 'other') {
            assert.equal(session.assignee?.userId, other.userId);
            assert.ok(session.messages.some((m) => m.role === 'system' && m.content.includes('驳回了报价单')));
          }
        } else await assert.rejects(invoke(), role === 'agent' ? tk.NotHandlingError : tk.ForbiddenError);
      }
    }
  }
  const empty = await fresh();
  await assert.rejects(actions.rejectQuote(empty.order.id, actor, '  '));
  await assert.rejects(actions.rejectQuote(empty.order.id, actor, '长'.repeat(121)));
  assert.equal(empty.order.approval!.state, 'pending');
  console.log('QUOTE PERMISSIONS PASS: 6 身份 × 4 接手关系 × 3 动作，拒绝空/过长原因，已有接手人不改派');

  // HTTP 真正登录，验证三接口 viewer=403、agent 在 AI 接待会话成功、请求体校验。
  const { app } = await withoutTenantScope(() => import('./server.js'));
  const accounts = await import('./auth/accounts.js');
  const { csrfFor } = await import('./auth/session.js');
  const cookies = new Map<string, string>();
  for (const role of ['agent', 'viewer'] as const) {
    await t.pg.exec('SET ROLE agent_platform');
    const made = await accounts.createUser(t.db, {
      tenantSlug: tenant.slug,
      email: `${role}@example.com`,
      name: role,
      role,
      password: async () => 'synthetic-password',
    });
    assert.equal(made.code, 0);
    await t.pg.exec('SET ROLE agent_app');
    Date.now = realNow;
    const body = JSON.stringify({ email: `${role}@example.com`, password: 'synthetic-password' });
    const res = await app.request('/api/console/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(res.status, 200, await res.clone().text());
    cookies.set(role, res.headers.get('set-cookie')!.split(';')[0]!);
    Date.now = () => now;
  }
  const post = (role: string, id: string, action: string, json = {}) => {
    const cookie = cookies.get(role)!;
    const body = JSON.stringify(json);
    return app.request(`/api/console/orders/${id}/quote/${action}`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'x-csrf': csrfFor(cookie.slice(cookie.indexOf('=') + 1)),
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
  };
  tk.setReplyTransport(async (id, text, opts) => {
    sent.push({ id, text, opts });
    return true;
  });
  for (const act of ['approve', 'reject', 'withdraw']) {
    const { session, order } = await fresh();
    for (const role of ['agent', 'viewer']) {
      const detailResponse = await app.request(`/api/console/conversations/${encodeURIComponent(session.id)}`, {
        headers: { cookie: cookies.get(role)! },
      });
      assert.equal(detailResponse.status, 200);
      const detail = (await detailResponse.json()) as import('./shared/console-api.js').ConversationDetail;
      for (const action of ['approveQuote', 'rejectQuote', 'withdrawQuote'] as const) assert.equal(detail.can[action], role === 'agent');
    }
    const res = await post('viewer', order.id, act, { reason: '调整' });
    assert.equal(res.status, 403);
    if (act === 'reject') {
      for (const reason of ['', ' ', '长'.repeat(121)]) assert.equal((await post('agent', order.id, act, { reason })).status, 400);
    }
    assert.equal((await post('agent', order.id, act, act === 'reject' ? { reason: '内部调整' } : {})).status, 200);
    const user = { id: agent.userId, role: 'agent', name: '合成顾问' } as unknown as Parameters<typeof conversationDetail>[1];
    const detail = conversationDetail(session, user, new Map(), now);
    assert.ok(detail.orders.some((o) => 'approval' in o && o.approval));
  }
  await store.drainStore(5000);
  await t.pg.exec('RESET ROLE');
  const audits = await t.pg.query<{ action: string; actor_kind: string; actor_name: string; actor_user_id: string | null }>(
    "select action,actor_kind,actor_name,actor_user_id from audit_log where action like 'quote.%'",
  );
  for (const action of ['quote.approve', 'quote.reject', 'quote.withdraw']) {
    assert.ok(audits.rows.some((a) => a.action === action && a.actor_kind === 'user' && a.actor_name === 'agent' && a.actor_user_id));
  }
  await t.pg.exec('SET ROLE agent_app');
  console.log('QUOTE HTTP/AUDIT PASS: 三路由 agent=200、viewer=403，400 原因校验，三动作审计操作者完整');

  // 原适配器 + 假 fetch：没有单独文字，只有一张卡片，账本照实记一次。
  process.env.WECOM_CORP_ID = 'synthetic-corp';
  process.env.WECOM_APP_SECRET = 'synthetic-secret';
  process.env.WECOM_KF_OPEN_KFID = 'synthetic-kf';
  const { wecomAdapter } = await import('./adapters/wecom.js');
  const { __ledgerTest } = await import('./quota/ledger.js');
  const originalFetch = globalThis.fetch;
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('gettoken')) return Response.json({ errcode: 0, access_token: 'synthetic-token', expires_in: 7200 });
    if (url.includes('media/upload')) return Response.json({ errcode: 0, media_id: 'synthetic-media', created_at: now });
    if (url.includes('/kf/send_msg')) {
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ errcode: 0, msgid: `msg${payloads.length}` });
    }
    throw new Error('未预期的外部请求');
  }) as typeof fetch;
  try {
    const { session, order } = await fresh();
    // env 账号通过现有适配器记账；明确设置可发送窗口的客户消息。
    session.messages.push({ role: 'customer', content: '请准备报价单', at: now, sentAt: now });
    identifyRuntime(rt, {
      id: rt.id,
      slug: rt.slug,
      kind: rt.kind,
      isHost: rt.isHost,
      publicBase: 'https://fixture.example.com',
      expiresAt: rt.expiresAt,
    });
    store.saveSession(session);
    tk.setReplyTransport((id, text, opts) => wecomAdapter.push(id, text, opts));
    await actions.approveQuote(order.id, agent);
    assert.equal(payloads.length, 1, JSON.stringify(payloads));
    assert.equal(payloads[0]!.msgtype, 'link');
    assert.equal((payloads[0]!.link as { title: string }).title, '报价单');
    const { partsOf } = await import('./core/message-parts.js');
    assert.deepEqual(partsOf(`/quote/${order.id}`, rt.publicBase, session), [
      { kind: 'link', linkKind: 'quote', url: `/quote/${order.id}`, title: '报价单' },
    ]);
    assert.equal(__ledgerTest.rows(session.id).length, 1);
    assert.equal(__ledgerTest.rows(session.id)[0]!.status, 'accepted');
    const message = session.messages.at(-1)!;
    assert.deepEqual(messageToRow(message, 1).extra?.quoteStates, { [order.id]: 'approved' });
    await actions.approveQuote(order.id, agent);
    assert.equal(payloads.length, 1);
    await store.drainStore(5000);
    await t.pg.exec('RESET ROLE');
    const stored = await t.pg.query<{ extra: { quoteStates?: Record<string, string> } }>(
      "select extra from messages where (extra::jsonb->'quoteStates') ? $1",
      [order.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.deepEqual(stored.rows[0]!.extra.quoteStates, { [order.id]: 'approved' });
    await t.pg.exec('SET ROLE agent_app');
    const extra = messageToRow(message, 1).extra;
    now += 10 * 86_400_000;
    assert.equal(quoteState(order, now), 'expired');
    assert.deepEqual(extra?.quoteStates, { [order.id]: 'approved' }, '按外发时状态保留证据');
    now = realNow();
  } finally {
    globalThis.fetch = originalFetch;
  }
  tk.setReplyTransport(async () => false);
  const failed = await fresh();
  await actions.approveQuote(failed.order.id, agent);
  assert.ok(failed.session.messages.some((m) => m.role === 'system' && m.content.includes('报价单发送失败')));
  for (const id of ['wecom:cust_D01', 'wecom:wmSeed']) {
    const session = store.getOrCreateSession(id, 'wecom');
    if (id.endsWith('wmSeed')) session.seed = true;
    const order = await make(502, session);
    await actions.approveQuote(order.id, actor);
    assert.equal(session.messages.filter((m) => m.role === 'agent').length, 0);
  }
  console.log('QUOTE DELIVERY PASS: 真实企微路径单卡片、账本 1 次、extra 外发快照、重复零推送、种子零推送与失败备注');

  // 持久化提醒：按真实 jobs 认领/完成流程执行，完成后重复与重载后都不排第二个。
  const notices: import('./notify/notifier.js').HandoffNotice[] = [];
  __notifierTest.use({
    async send(n) {
      notices.push(n);
    },
  });
  const pendingNotice = await fresh();
  assert.strictEqual(await make(500, pendingNotice.session), pendingNotice.order);
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, ctx, fn);
  const runJobs = async () => {
    await store.drainStore(5000);
    const rows = await tx((db) => claimDueJobs(db, new Date(now), 1000, ['handoff_notify']));
    for (const row of rows) {
      const result = await runHandoffNotifyJob(row, now);
      assert.ok(result.status === 'done');
      await tx((db) => setJobStatus(db, row.id, 'done', { from: ['running'] }));
    }
  };
  await runJobs();
  const { shortIdOf } = await import('./shared/conversation.js');
  assert.equal(notices.filter((n) => n.shortId === shortIdOf(pendingNotice.session.id) && n.kind === 'quote_pending').length, 1);
  assert.ok(notices.some((n) => n.kind === 'quote_pending' && noticeText(n).includes('有报价单等你审核')));
  const accepted = await fresh('approved');
  assert.equal(accepted.session.handedOver, false);
  assert.equal(actions.recordQuoteAccepted(accepted.session, accepted.order.id, now), true);
  assert.equal(actions.recordQuoteAccepted(accepted.session, accepted.order.id, now + 1), false);
  await runJobs();
  const count = notices.filter((n) => n.kind === 'quote_accepted').length;
  assert.equal(count, 1);
  assert.ok(notices.filter((n) => n.kind === 'quote_pending' || n.kind === 'quote_accepted').every((n) => n.link.endsWith('/console')));
  assert.ok(noticeText(notices.find((n) => n.kind === 'quote_accepted')!).includes('客户确认了报价单，等你安排付款发货'));
  assert.equal(actions.recordQuoteAccepted(accepted.session, accepted.order.id), false);
  await runJobs();
  assert.equal(notices.filter((n) => n.kind === 'quote_accepted').length, count);
  await t.pg.exec('RESET ROLE');
  const jobs = await t.pg.query<{ dedupe_key: string; payload: { reason: string } }>('select dedupe_key,payload from jobs');
  assert.equal(jobs.rows.filter((j) => j.dedupe_key === `quote_accepted:${accepted.order.id}`).length, 1);
  assert.ok(!jobs.rows.some((j) => j.payload.reason === 'order_unconfirmed'));
  await t.pg.exec('SET ROLE agent_app');
  const pendingOps = quoteNotifyOps(pendingNotice.session.id, pendingNotice.order.id, 'quote_pending', now);
  const staleJob = { payload: (pendingOps[0] as { payload: unknown }).payload } as import('./jobs/runner.js').JobRow;
  pendingNotice.order.approval!.state = 'withdrawn';
  assert.equal(((await runHandoffNotifyJob(staleJob, now)) as { lastError: string }).lastError, 'order_settled');
  await store.drainStore(5000);
  rt.store.pgBackend!.close();
  rt.store.pgBackend = null;
  rt.store.sessions.clear();
  rt.store.orders.clear();
  await store.initSessionStore(fx.deps);
  const loaded = store.getAnyOrder(accepted.order.id) as LineOrder;
  assert.equal(loaded.approval!.acceptedAt, now);
  assert.equal(actions.recordQuoteAccepted(store.getSession(loaded.sessionId)!, loaded.id), false);
  await runJobs();
  assert.equal(notices.filter((n) => n.kind === 'quote_accepted').length, count);
  console.log('QUOTE NOTIFY PASS: 待审去重、两类文案、非转人工确认、完成后/重载后去重、过时跳过、无旧原因');

  // 在 jobs 写入时用 CHECK 失败，确保同事务中的 acceptedAt 也回滚；移除测试约束后整份快照恢复。
  const atomic = await fresh('approved');
  await t.pg.exec('RESET ROLE');
  await t.pg.exec("ALTER TABLE jobs ADD CONSTRAINT quote_test_failure CHECK (payload->>'reason' <> 'quote_accepted') NOT VALID");
  await t.pg.exec('SET ROLE agent_app');
  actions.recordQuoteAccepted(atomic.session, atomic.order.id, now);
  await assert.rejects(store.flushSession(atomic.session.id, { timeoutMs: 200 }));
  await t.pg.exec('RESET ROLE');
  const persisted = await t.pg.query<{ accepted: string | null }>(
    "select data->'approval'->>'acceptedAt' as accepted from orders where id=$1",
    [atomic.order.id],
  );
  assert.equal(persisted.rows[0]!.accepted, null);
  const half = await t.pg.query<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [
    `quote_accepted:${atomic.order.id}`,
  ]);
  assert.equal(half.rows[0]!.n, 0);
  await t.pg.exec('ALTER TABLE jobs DROP CONSTRAINT quote_test_failure');
  await t.pg.exec('SET ROLE agent_app');
  // 约束错误属于 poisoned；该会话快照保留在内存/停机恢复，测试不再对它继续写。
  console.log('QUOTE ATOMIC PASS: 注入 jobs 事务失败，订单首次确认时间与提醒均未落库');
  __notifierTest.use(null);
  await store.drainStore(500);
  rt.store.pgBackend!.close();
  rt.store.pgBackend = null;
  rt.store.sessions.clear();
  rt.store.orders.clear();
  await t.close();
  dbClosed = true;
  const restart = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--restart', dir, tenant.id, tenant.slug, accepted.order.id, String(now)],
    { encoding: 'utf8', timeout: 60_000, env: process.env },
  );
  assert.equal(restart.status, 0, `${restart.stdout}\n${restart.stderr}`);
  assert.match(restart.stdout, /QUOTE PROCESS RESTART PASS/);
  console.log('QUOTE PROCESS RESTART PASS: 新进程再次确认，首次时间保留、已完成任务仍只有一个');
  if (process.env.PG_TEST_URL) {
    await store.drainStore(500);
    rt.store.sessions.clear();
    rt.store.orders.clear();
    const real = await testing.createRealPgFixture(process.env.PG_TEST_URL);
    const db = await testing.openGatedDb(real.urls.app);
    try {
      identifyRuntime(rt, {
        id: real.tenantId,
        slug: 'demo',
        kind: rt.kind,
        isHost: rt.isHost,
        publicBase: rt.publicBase,
        expiresAt: rt.expiresAt,
      });
      rt.config.loaded!.tenantId = real.tenantId;
      await store.initSessionStore({ db: db.db, tenantId: real.tenantId, tenantSlug: 'demo', varDir: dir });
      const { session, order } = await fresh('approved');
      await real.query("ALTER TABLE jobs ADD CONSTRAINT quote_test_failure CHECK (payload->>'reason' <> 'quote_accepted') NOT VALID");
      actions.recordQuoteAccepted(session, order.id);
      await assert.rejects(store.flushSession(session.id, { timeoutMs: 300 }));
      const rows = await real.query<{ accepted: string | null }>(
        "select data->'approval'->>'acceptedAt' as accepted from orders where id=$1",
        [order.id],
      );
      assert.equal(rows[0]!.accepted, null);
      assert.equal(
        (await real.query<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [`quote_accepted:${order.id}`]))[0]!.n,
        0,
      );
      await real.query('ALTER TABLE jobs DROP CONSTRAINT quote_test_failure');
      console.log('QUOTE REAL PG PASS: FORCE RLS 下订单与提醒事务失败无半写入');
    } finally {
      (rt.store as typeof rt.store).pgBackend?.close();
      rt.store.pgBackend = null;
      await db.close();
      await real.drop();
    }
  } else console.log('QUOTE REAL PG SKIP: 未设置 PG_TEST_URL（交 CI 一次性 pgvector:pg17）');
} finally {
  Date.now = realNow;
  __profileTest.reset();
  await store.drainStore(500);
  rt.store.pgBackend?.close();
  rt.store.fileBackend?.reset();
  if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
  if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
  await closeConfig();
  __configTest.reset();
  if (!dbClosed) await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
