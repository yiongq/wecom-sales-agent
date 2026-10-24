// 07 第 7 步（R21、验收 10）：新开沙箱里的 G01 走完整条退款链路，再在模拟器里从头走一遍，两边的状态逐项对得上。
// 全程真实路由（访客 cookie、console API、/api/chat、/api/orders/:id/pay）、假模型（LLM_MOCK=1）；PGlite 一遍，有 PG_TEST_URL 再跑真实 PG。
// 日期都从库里的 created_at 与固定的偏移算，不读「现在是几点」；看板用 7 天窗口，不依赖自然月。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../db/client.js';
import { createRealPgFixture, fakeLock, openTestDb, purgeTestSandbox, testConfigDeps } from '../../db/testing.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig, currentCatalog, currentPolicy } from '../../config/source.js';
import { expireBrokenSandbox } from '../../db/sandbox-process.js';
import { csrfFor, __authTest } from '../../auth/session.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { todayIso } from '../../env.js';
import { flushSession, getOrder, getSession, listOrders, listSessions, createOrder, saveSession } from '../../store.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import { packById } from '../../packs/registry.js';
import { paidNeedsHuman } from '../../shared/conversation.js';
import type { ConversationPage, DealsPart, MetricsView, OrderView } from '../../shared/console-api.js';
import type { Order, Session } from '../../types.js';
import {
  configureTenancy,
  createTenantRuntime,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
  type TenantRuntime,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { SandboxProcess, sandboxApp } from './process.js';
import { provisionSandbox } from './provision.js';
import { __sandboxLimitsTest } from './limits.js';
import { resolveSandboxSession } from './session.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-refund-seed-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app: routes } = await import('../../server.js');
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
async function cleanup(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
}
/** 开通日加天数，用年月日分量让 Date 进位（不走被测代码的算法） */
function plusDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const zero = (): DealsPart => ({
  aiOnly: 0,
  aiOnlyAmount: 0,
  aiOnlyRefunded: 0,
  assisted: 0,
  assistedAmount: 0,
  assistedRefunded: 0,
  refunded: 0,
});
const plus = (a: DealsPart, b: DealsPart): DealsPart =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof DealsPart] + b[k as keyof DealsPart]])) as never;

async function suite(db: Db, q: Query, real: boolean): Promise<void> {
  __authTest.reset();
  __sandboxLimitsTest.resetProvisioned();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>("select id from tenants where slug='template'");
  const host = createTenantRuntime({ id: template!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  await q('update tenants set brand=$2::json where id=$1', [host.id, JSON.stringify(shanhaiBrand)]);
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: 'template', dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  check(() => assert.equal(imported.code, 0, imported.message));
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'体验隐私说明')", [host.id]);
  const service = {
    health: () => new SandboxProcess({}).health(),
    resolve: (token: string | undefined) => resolveSandboxSession(db, token),
    provision: (input: { ip: string | null; userAgent: string | null }) =>
      provisionSandbox({
        ...input,
        deps,
        templateSlug: 'template',
        host: 'sandbox.example.invalid',
        epoch: '0',
        acquireTenant: async () => fakeLock(),
      }),
    end: (tenantId: string) => expireBrokenSandbox(db, tenantId),
  };
  const app = sandboxApp(service, 'sandbox.example.invalid', routes);
  const request = (url: string, token?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', 'SANDBOX.example.invalid.:443');
    if (token) headers.set('cookie', `__Host-sbx=${token}`);
    if (init.body) headers.set('content-length', String(Buffer.byteLength(String(init.body))));
    return app.request(url, { ...init, headers });
  };
  const post = (url: string, token?: string, body: unknown = {}) =>
    request(url, token, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(token ? { 'x-csrf': csrfFor(token) } : {}) },
    });
  const json = async <T>(r: Response, status = 200): Promise<T> => {
    check(() => assert.equal(r.status, status));
    return (await r.json()) as T;
  };
  const openStream = async (url: string, token: string) => {
    const abort = new AbortController();
    const response = await request(url, token, { signal: abort.signal });
    check(() => assert.equal(response.status, 200));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value, { stream: true });
    const pumping = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    })();
    return {
      text: () => received,
      async until(predicate: (text: string) => boolean, name: string) {
        const deadline = Date.now() + 3000;
        while (!predicate(received) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        check(() => assert.ok(predicate(received), name));
      },
      async close() {
        abort.abort();
        await reader.cancel();
        await pumping;
      },
    };
  };

  // ---------- 新开一个沙箱 ----------
  const opened = await post('/api/sandbox');
  check(() => assert.equal(opened.status, 201));
  const token = opened.headers.get('set-cookie')!.match(/^__Host-sbx=([^;]+)/)![1]!;
  const resolved = await service.resolve(token);
  assert.equal(resolved.status, 'ok');
  if (resolved.status !== 'ok') throw new Error('session_invalid');
  const a: TenantRuntime = resolved.runtime;
  const [created] = await q<{ created_at: Date | string }>('select created_at from tenants where id=$1', [a.id]);
  const provisionDay = todayIso(new Date(created!.created_at));
  const departDay = plusDays(provisionDay, 40);
  const pack = packById('travel')!;
  // 成交拆分（deals）每次请求现算，不进 60 秒缓存：下面所有「前后对比」都用同一个 days=7 紧接着取，缓存若还在就会读到旧数；
  // 转人工统计走库、照旧缓存（按租户与天数），要看转人工那部分就换一个天数拿一份新算的。窗口都覆盖开通前 50 小时的 G01 付款
  const metricsView = async (days = 7) => json<MetricsView>(await request(`/api/console/metrics?days=${days}`, token));
  const metrics = async () => (await metricsView()).deals;
  const sum = (d: Record<'customer' | 'visitor' | 'seed', DealsPart>) => plus(plus(d.customer, d.visitor), d.seed);

  // G01：出发日 = 开通日 + 40、订单退款中、在「已成交客户要人工」里
  const g01 = withTenantScope(a, () => getOrder('ord_seed_7c41a9'))!;
  check(() => assert.equal(g01.departDate, departDay));
  check(() => assert.equal(g01.status, 'refund_pending'));
  check(() => assert.equal(g01.refund?.approval, 'pending'));
  check(() => assert.equal(g01.refund?.settlement, 'mock'));
  check(() => assert.equal(g01.refund?.amount, 33_600));
  check(() => assert.ok(g01.totalPrice > 30_000, '总价超过默认审批阈值'));
  const g01Id = g01.sessionId;
  const paidGroup = await json<ConversationPage>(await request('/api/console/conversations?group=paid_needs_human', token));
  check(() =>
    assert.deepEqual(
      paidGroup.items.map((r) => r.id),
      [g01Id],
    ),
  );
  check(() =>
    assert.deepEqual(
      paidGroup.items[0]!.handoff && { kind: paidGroup.items[0]!.handoff.kind, reason: paidGroup.items[0]!.handoff.reason },
      {
        kind: 'refund',
        reason: '退款待审批：¥33,600（退改条款第1条）',
      },
    ),
  );
  const orderViews = await json<{ items: OrderView[] }>(await request('/api/console/orders?limit=50', token));
  const g01View = orderViews.items.find((o) => o.id === 'ord_seed_7c41a9')!;
  check(() => assert.equal(g01View.status, 'refund_pending'));
  check(() => assert.ok('departDate' in g01View && g01View.departDate === departDay));
  check(() =>
    assert.deepEqual(
      { ...g01View.refund, requestedAt: 0 },
      {
        amount: 33_600,
        tierId: g01.refund!.tierId,
        percent: 100,
        approval: 'pending',
        settlement: 'mock',
        requestedAt: 0,
        settledAt: null,
        tierTitle: '退改条款第1条',
      },
    ),
  );

  // 状态快照：留着和「从头走一遍」逐项比
  const project = (session: Session, order: Order) => {
    const tail = order.id.slice(-6);
    const norm = (text: string) => text.replaceAll(tail, 'TAIL');
    const r = order.refund!;
    return {
      session: {
        stage: session.stage,
        handedOver: session.handedOver,
        assignee: session.assignee ?? null,
        handoff: session.handoff && { kind: session.handoff.kind, reason: session.handoff.reason, quote: session.handoff.quote },
        stageBeforeHandoff: session.stageBeforeHandoff,
        handoffCount: session.handoffCount,
        handoffLogKinds: session.handoffLog?.map((e) => e.kind),
        afterSale:
          session.afterSale?.step === 'confirm'
            ? { step: 'confirm', quote: { ...session.afterSale.quote, orderId: 'ORDER' } }
            : session.afterSale,
        last4: session.messages.slice(-4).map((m) => [m.role, norm(m.content)]),
        hasFirstHandoffAt: session.firstHandoffAt != null,
      },
      order: {
        status: order.status,
        routeId: order.routeId,
        routeTitle: order.routeTitle,
        travelers: order.travelers,
        totalPrice: order.totalPrice,
        departDate: order.departDate,
        handoffBeforePaid: order.handoffBeforePaid,
        hasPaidAt: order.paidAt != null,
        refund: { ...r, id: 'rf', requestedAt: 0 },
      },
    };
  };
  const g01Session = withTenantScope(a, () => getSession(g01Id))!;
  const seedState = project(g01Session, g01);
  check(() =>
    assert.equal(
      seedState.session.last4[1]![1],
      `《${g01.routeTitle}》2 位、${Number(departDay.slice(5, 7))} 月 ${Number(departDay.slice(8))} 日出发（订单尾号 TAIL）：离出发 40 天，按退改条款第1条可退全款 ¥33,600。确认退款请回复「确认退款」。`,
    ),
  );
  check(() =>
    assert.ok(
      withTenantScope(a, () => listSessions().every((s) => s.seed === true)),
      '每段种子都打了 seed: true',
    ),
  );
  check(() => assert.equal(currentPolicyHash(a), g01.refund!.policyHash, '政策哈希用的是沙箱已发布的那份'));

  // ---------- 看板：开通时种子在「种子」视图里，G01 还没退 ----------
  const before = await metrics();
  check(() => assert.equal(before.seed.refunded, 0));
  check(() => assert.equal(before.seed.aiOnly, 2, 'A01 与 G01 两张已付单都是种子'));
  check(() => assert.deepEqual(before.visitor, zero()));
  check(() => assert.deepEqual(before.customer, zero()));

  // ---------- 点「批准退款」：supervisor 以上经后台路由批准 ----------
  const notice = await openStream(`/api/stream/${g01Id}`, token);
  const messagesBefore = withTenantScope(a, () => getSession(g01Id)!.messages.length);
  try {
    const approved = await json<OrderView>(await post('/api/console/orders/ord_seed_7c41a9/refund/approve', token));
    check(() => assert.equal(approved.status, 'refunded'));
    check(() => assert.equal(approved.refund?.approval, 'approved'));
    check(() => assert.ok(approved.refund?.settledAt != null));
    const done = '已为您办好退款 ¥33,600（退改条款第1条）。这是演示环境的模拟退款，不产生真实打款。';
    await notice.until((text) => text.includes(JSON.stringify(done).slice(1, -1)), '批准后沙箱模拟器的 SSE 收到退款通知');
    check(() =>
      assert.equal(
        withTenantScope(a, () => getSession(g01Id)!.messages.at(-1)!.content),
        done,
      ),
    );
    check(() =>
      assert.equal(
        withTenantScope(a, () => getSession(g01Id)!.messages.length),
        messagesBefore + 1,
      ),
    );
    // 重复点击幂等：原样返回，不再发通知、不再多一条消息
    const again = await json<OrderView>(await post('/api/console/orders/ord_seed_7c41a9/refund/approve', token));
    check(() => assert.equal(again.status, 'refunded'));
    check(() =>
      assert.equal(
        withTenantScope(a, () => getSession(g01Id)!.messages.length),
        messagesBefore + 1,
      ),
    );
  } finally {
    await notice.close();
  }
  await withTenantScope(a, () => flushSession(g01Id, { timeoutMs: 5000 }));
  const [row] = await q<{ status: string; approval: string }>(
    "select status, data->'refund'->>'approval' as approval from orders where tenant_id=$1 and id='ord_seed_7c41a9'",
    [a.id],
  );
  check(() => assert.deepEqual(row, { status: 'refunded', approval: 'approved' }));
  const audits = await q<{ action: string }>(
    "select action from audit_log where tenant_id=$1 and target_id='ord_seed_7c41a9' order by id",
    [a.id],
  );
  check(() => assert.ok(audits.some((r) => r.action === 'order.refund_approve')));
  const afterApprove = await metrics();
  // 「其中已退款」：种子视图与全部视图各加 1，另两个来源不动
  check(() => assert.equal(afterApprove.seed.refunded, before.seed.refunded + 1));
  check(() => assert.equal(afterApprove.seed.aiOnlyRefunded, before.seed.aiOnlyRefunded + 1));
  check(() => assert.equal(afterApprove.seed.aiOnly, before.seed.aiOnly));
  check(() => assert.equal(sum(afterApprove).refunded, sum(before).refunded + 1));
  check(() => assert.deepEqual(afterApprove.visitor, before.visitor));
  check(() => assert.deepEqual(afterApprove.customer, before.customer));

  // ---------- 在模拟器里从头走一遍：下单、模拟付款、「我要退款」、「确认退款」 ----------
  const chat = async (sessionId: string | undefined, text: string) =>
    json<{ sessionId: string; reply: { text: string; handoff?: boolean; silent?: boolean } }>(
      await post('/api/chat', token, { sessionId, text }),
    );
  async function walk(routeId: string, travelers: number, departDate: string) {
    const first = await chat(undefined, '你好');
    const sessionId = first.sessionId;
    check(() => assert.match(sessionId, /^sbx-[a-f0-9]{24}$/));
    // 下单：与 create_order 工具落库的内容相同（线路标题、人数、总价来自沙箱自己的产品库）
    const order = withTenantScope(a, () => {
      const route = currentCatalog().routes.find((r) => r.id === routeId)!;
      const session = getSession(sessionId)!;
      const o = createOrder({
        sessionId,
        routeId,
        routeTitle: route.title,
        travelers,
        departDate,
        totalPrice: route.priceFrom * travelers,
      });
      session.orderIds.push(o.id);
      saveSession(session);
      return o;
    });
    // 模拟付款（真实路由）
    const paid = await json<{ ok: boolean; order: { status: string } }>(await post(`/api/orders/${order.id}/pay`, token));
    check(() => assert.equal(paid.order.status, 'paid'));
    await withTenantScope(a, () => flushSession(sessionId, { timeoutMs: 5000 }));
    const quote = await chat(sessionId, '我要退款');
    const confirm = await chat(sessionId, '确认退款');
    await withTenantScope(a, () => flushSession(sessionId, { timeoutMs: 5000 }));
    return { sessionId, order, quote: quote.reply, confirm: confirm.reply };
  }

  // 高于阈值：与 G01 同一条线路、人数、出发日，退款中、要人工；逐项和开通时的 G01 比
  const m1 = await metrics();
  const high = await walk(g01.routeId, g01.travelers, g01.departDate);
  check(() => assert.ok(high.confirm.handoff));
  check(() => assert.match(high.confirm.text, /^退款申请已提交：¥33,600。金额超过 ¥30,000 要顾问审核，/));
  const walked = withTenantScope(a, () => project(getSession(high.sessionId)!, getOrder(high.order.id)!));
  check(() => assert.deepEqual(walked, seedState, 'G01 的状态与真实走一遍之后逐项一致'));
  check(() => assert.ok(withTenantScope(a, () => paidNeedsHuman(getSession(high.sessionId)!, pack))));
  // 转人工统计：种子（打了 seed 标记）没有轮次，不进分母，也不会算成访客；访客自己这一单的退款转人工记在「访客」里
  const handoffView = await metricsView(8);
  check(() => assert.equal(handoffView.handoffByOrigin.seed.sessions, 0));
  check(() => assert.deepEqual(handoffView.handoffByOrigin.seed.byKind, {}));
  check(() => assert.ok((handoffView.handoffByOrigin.visitor.byKind.refund ?? 0) > 0));
  check(() => assert.ok((handoffView.handoffByKind.refund ?? 0) > 0));
  const m2 = await metrics();
  check(() => assert.equal(m2.visitor.aiOnly, m1.visitor.aiOnly + 1, '成交记在「访客」视图'));
  check(() => assert.equal(m2.visitor.aiOnlyAmount, m1.visitor.aiOnlyAmount + 33_600));
  check(() => assert.equal(m2.visitor.refunded, m1.visitor.refunded));
  check(() => assert.deepEqual(m2.seed, m1.seed));
  check(() => assert.equal(m2.customer.aiOnly, 0));
  await json<OrderView>(await post(`/api/console/orders/${high.order.id}/refund/approve`, token));
  const m3 = await metrics();
  check(() => assert.equal(m3.visitor.refunded, m2.visitor.refunded + 1, '退款记在「访客」视图'));
  check(() => assert.equal(m3.visitor.aiOnlyRefunded, m2.visitor.aiOnlyRefunded + 1));
  check(() => assert.deepEqual(m3.seed, m2.seed));
  check(() =>
    assert.equal(
      withTenantScope(a, () => getOrder(high.order.id)!.status),
      'refunded',
    ),
  );

  // 低于阈值：当场办完，不转人工
  const low = await walk('r-guizhou', 1, plusDays(todayIso(), 40));
  check(() => assert.match(low.quote.text, /按退改条款第1条可退全款 ¥15,800/));
  check(() => assert.equal(low.confirm.text, '已为您办好退款 ¥15,800（退改条款第1条）。这是演示环境的模拟退款，不产生真实打款。'));
  check(() => assert.ok(!low.confirm.handoff));
  const lowSession = withTenantScope(a, () => getSession(low.sessionId)!);
  check(() => assert.equal(lowSession.handedOver, false));
  check(() =>
    assert.equal(
      withTenantScope(a, () => getOrder(low.order.id)!.status),
      'refunded',
    ),
  );
  const m4 = await metrics();
  check(() => assert.equal(m4.visitor.aiOnly, m3.visitor.aiOnly + 1));
  check(() => assert.equal(m4.visitor.refunded, m3.visitor.refunded + 1));
  check(() => assert.deepEqual(m4.seed, m3.seed));

  // 收尾：关掉这个沙箱
  withTenantScope(a, () => check(() => assert.equal(listOrders().filter((o) => o.status === 'refund_pending').length, 0)));
  await withTenantScope(a, () => flushSession(g01Id, { timeoutMs: 5000 }));
  const ended = await post('/api/sandbox/end', token);
  check(() => assert.equal(ended.status, 200));
  tenantStoreIfLoaded(a)?.pgBackend?.close();
  await purgeTestSandbox(db, a.id);
  console.log(
    `SELFTEST ${real ? '真实 PG' : 'PGlite'}: G01 批准到已退款、看板「其中已退款」加 1、模拟器从头走一遍（高于、低于阈值）与 G01 逐项一致`,
  );
}
function currentPolicyHash(rt: TenantRuntime): string {
  return withTenantScope(rt, () => currentPolicy().policyHash);
}

try {
  await cleanup();
  const t = await openTestDb();
  try {
    await t.pg.query("insert into tenants(slug,name,pack_id) values('template','模板','travel')");
    const q: Query = async (text, params = []) => {
      await t.pg.exec('RESET ROLE');
      try {
        return (await t.pg.query(text, params)).rows as never;
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    };
    await t.pg.exec('SET ROLE agent_app');
    await suite(t.db, q, false);
  } finally {
    await cleanup();
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const f = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    const app = await openDb(f.urls.app);
    try {
      await suite(app.db, f.query, true);
    } finally {
      await cleanup();
      await app.close();
      await f.drop();
    }
  } else console.log('SKIP: 真实 PG 上的 G01 链路需要 PG_TEST_URL');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`SELFTEST PASS: 沙箱种子退款链路 ${checks} 项`);
