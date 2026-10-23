import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import type { Order } from '../types.js';
import type { Actor } from '../handoff/takeover.js';

if (!process.env.REFUND_BACKEND) {
  for (const backend of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename], {
      env: { ...process.env, REFUND_BACKEND: backend },
      encoding: 'utf8',
      timeout: 90000,
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.status, 0, `${backend} 退款持久化自测失败：${child.error ?? ''}`);
  }
  process.exit(0);
}

enterTenantScopeForTest(hostRuntime());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-selftest-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SESSION_STORE = 'db';
process.env.LLM_MOCK = '1';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const testing = await withoutTenantScope(() => import('../db/testing.js'));
const config = await withoutTenantScope(() => import('../config/source.js'));
const store = await withoutTenantScope(() => import('../store.js'));
const takeover = await withoutTenantScope(() => import('../handoff/takeover.js'));
const { OrderStateError } = await withoutTenantScope(() => import('./orders.js'));
const { approveRefund, rejectRefund, requestRefund, settleRefund } = await withoutTenantScope(() => import('./refunds.js'));
const { quoteRefund } = await import('../core/refund.js');
const { defaultTravelPolicy } = await import('../packs/travel/policy.js');
const { __profileTest } = await import('../profile.js');
const t = process.env.REFUND_BACKEND === 'pglite' ? await testing.openTestDb() : null;
const real = t ? null : await testing.createRealPgFixture(process.env.PG_TEST_URL!);
const gated = real ? await testing.openGatedDb(real.urls.app) : null;
await config.initConfig(null);
const fx = t ? await testing.installPgSessionStore(t, { varDir: dir }) : null;
const faults = fx?.faults ?? gated!.faults;
const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
  if (real) return real.query<T>(sql, params);
  return t!.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<T>(sql, params)).rows;
  });
};
await store.initSessionStore(fx?.deps ?? { db: gated!.db, tenantId: real!.tenantId, tenantSlug: 'demo', varDir: dir });
const supervisor: Actor = { userId: null, name: '合成主管', role: 'supervisor' };
const agent: Actor = { userId: null, name: '共享工作台', role: 'shared' };
const viewer: Actor = { userId: null, name: '只读', role: 'viewer' };
const terms = defaultTravelPolicy.refund;
let serial = 0;
async function paid(amount = 40000): Promise<Order> {
  const s = store.getOrCreateSession(`wecom:refund-${++serial}`, 'wecom');
  s.messages.push({ role: 'customer', content: '合成退款请求', at: Date.now() });
  const order = store.createOrder({
    sessionId: s.id,
    routeId: 'r-test',
    routeTitle: '合成线路',
    travelers: 2,
    departDate: '2099-12-10',
    totalPrice: amount,
  });
  s.orderIds.push(order.id);
  store.saveSession(s);
  store.markOrderPaid(order.id);
  await store.flushSession(s.id);
  return order;
}
function request(order: Order) {
  const quote = quoteRefund(order, terms, 'published-hash', '2099-10-31');
  assert.ok(!('ineligible' in quote));
  return requestRefund(quote, terms);
}
async function auditRows(order: Order) {
  await store.flushSession(order.sessionId);
  return query<{ action: string; actor_kind: string }>('select action, actor_kind from audit_log where target_id = $1 order by id', [
    order.id,
  ]);
}
const notices: string[] = [];
let sendOk = true;
let release: (() => void) | undefined;
takeover.setReplyTransport(async (_sid, text) => {
  notices.push(text);
  return sendOk;
});
try {
  const auto = await paid(30000);
  const quote = quoteRefund(auto, terms, 'hash', '2099-10-31');
  assert.ok(!('ineligible' in quote));
  assert.throws(() => requestRefund({ ...quote, amount: quote.amount + 1 }, terms), OrderStateError);
  assert.equal(auto.status, 'paid', '报价金额被改不能申请');
  const first = requestRefund(quote, terms);
  assert.ok(!('busy' in first) && first.created && !first.needsHuman);
  assert.equal(auto.status, 'refunded');
  assert.equal(auto.refund!.approval, 'auto');
  assert.equal(auto.refund!.settled!.by, null);
  assert.match(auto.refund!.id, /^rf_[0-9a-f]{12}$/);
  assert.equal(notices.length, 0, '申请函数不发通知，核心提交负责');
  const twice = requestRefund(quote, terms);
  assert.ok(!('busy' in twice) && !twice.created && twice.order.refund === auto.refund);
  assert.deepEqual(await auditRows(auto), [{ action: 'order.refund_request', actor_kind: 'system' }]);
  await assert.rejects(() => rejectRefund(auto.id, supervisor, '迟到的驳回'), OrderStateError);
  await assert.rejects(() => approveRefund(auto.id, supervisor), OrderStateError);

  const o = await paid();
  const pending = request(o);
  assert.ok(!('busy' in pending) && pending.needsHuman && o.refund!.approval === 'pending');
  await store.flushSession(o.sessionId);
  await assert.rejects(() => approveRefund(o.id, { ...agent, role: 'agent' }), takeover.ForbiddenError);
  await assert.rejects(() => rejectRefund(o.id, viewer, '越权'), takeover.ForbiddenError);
  faults.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const approval = approveRefund(o.id, supervisor);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(notices.length, 0, '落库暂停时不能先通知');
  const dbBefore = await query<{ status: string }>('select status from orders where id = $1', [o.id]);
  assert.equal(dbBefore[0]!.status, 'refund_pending');
  faults.gate = null;
  release!();
  assert.ok((await approval).persisted);
  assert.equal(o.status, 'refunded');
  assert.equal(o.refund!.approval, 'approved');
  assert.equal(o.refund!.settled!.by, null);
  assert.ok(notices.at(-1)!.includes('模拟退款'));
  const dbAfter = await query<{ status: string }>('select status from orders where id = $1', [o.id]);
  assert.equal(dbAfter[0]!.status, 'refunded');
  await Promise.all([approveRefund(o.id, supervisor), approveRefund(o.id, supervisor)]);
  assert.equal(notices.length, 1);
  assert.deepEqual(
    (await auditRows(o)).map((r) => r.action),
    ['order.refund_request', 'order.refund_approve'],
  );

  const rejected = await paid();
  request(rejected);
  sendOk = false;
  await rejectRefund(rejected.id, supervisor, '合成原因');
  assert.equal(rejected.status, 'paid');
  assert.equal(rejected.refund!.approval, 'rejected');
  assert.equal(rejected.refund!.decision!.reason, '合成原因');
  assert.ok(store.getSession(rejected.sessionId)!.messages.at(-1)!.content.includes('退款通知未能发送'));
  assert.deepEqual(quoteRefund(rejected, terms, 'hash', '2099-10-31'), { ineligible: 'rejected_before' });
  const n = notices.length;
  await rejectRefund(rejected.id, supervisor, '重复点击');
  assert.equal(notices.length, n);
  assert.deepEqual(
    (await auditRows(rejected)).map((r) => r.action),
    ['order.refund_request', 'order.refund_reject'],
  );
  sendOk = true;

  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  const manual = await paid();
  request(manual);
  await assert.rejects(() => settleRefund(manual.id, supervisor), OrderStateError);
  await approveRefund(manual.id, supervisor);
  assert.equal(manual.status, 'refund_pending');
  assert.equal(notices.length, n, '顾问模式仅批准不通知办结');
  await assert.rejects(() => settleRefund(manual.id, agent), takeover.NotHandlingError);
  const session = store.getSession(manual.sessionId)!;
  session.handedOver = true;
  session.assignee = { userId: null, name: '共享工作台', at: Date.now() };
  store.saveSession(session);
  await settleRefund(manual.id, agent);
  assert.equal(manual.status, 'refunded');
  assert.equal(manual.refund!.settled!.by!.name, agent.name);
  const settledCount = notices.length;
  await Promise.all([settleRefund(manual.id, agent), settleRefund(manual.id, supervisor)]);
  assert.equal(notices.length, settledCount);
  assert.deepEqual(
    (await auditRows(manual)).map((r) => r.action),
    ['order.refund_request', 'order.refund_approve', 'order.refund_settle'],
  );
  const manualAuto = await paid(500);
  const created = request(manualAuto);
  assert.ok(!('busy' in created) && created.needsHuman && manualAuto.refund!.approval === 'auto');
  await settleRefund(manualAuto.id, supervisor);
  assert.equal(manualAuto.status, 'refunded');
  __profileTest.reset();

  const noPaidAt = await paid();
  delete noPaidAt.paidAt;
  assert.throws(() => request(noPaidAt), OrderStateError);
  const busy = await paid();
  const busyPending = await paid();
  request(busyPending);
  await store.flushSession(busyPending.sessionId);
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  const busySettle = await paid(500);
  request(busySettle);
  await store.flushSession(busySettle.sessionId);
  __profileTest.reset();
  faults.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.saveSession(store.getSession(busy.sessionId)!);
  await new Promise((r) => setTimeout(r, 30));
  const clock = Date.now;
  const now = clock();
  Date.now = () => now + 6000;
  try {
    const before = JSON.stringify(busy);
    assert.deepEqual(request(busy), { busy: true });
    assert.equal(JSON.stringify(busy), before);
    const original = JSON.stringify(busyPending);
    await assert.rejects(() => approveRefund(busyPending.id, supervisor), store.StoreLaggingError);
    await assert.rejects(() => rejectRefund(busyPending.id, supervisor, '积压'), store.StoreLaggingError);
    assert.equal(JSON.stringify(busyPending), original);
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    const settleBefore = JSON.stringify(busySettle);
    await assert.rejects(() => settleRefund(busySettle.id, supervisor), store.StoreLaggingError);
    assert.equal(JSON.stringify(busySettle), settleBefore);
    __profileTest.reset();
  } finally {
    Date.now = clock;
    faults.gate = null;
    release!();
  }
  await store.flushSession(busy.sessionId);
  assert.equal((await auditRows(busy)).length, 0);

  const timeout = await paid();
  request(timeout);
  await store.flushSession(timeout.sessionId);
  faults.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const count = notices.length;
  const result = await approveRefund(timeout.id, supervisor);
  assert.equal(result.persisted, false);
  assert.equal(notices.length, count, '提交超时不发退款成功通知');
  faults.gate = null;
  release!();
  await store.flushSession(timeout.sessionId);
  assert.equal((await auditRows(timeout)).length, 2);
  const rows = await query<{ data: Order }>('select data from orders where id = $1', [manual.id]);
  assert.equal(rows[0]!.data.refund!.approval, 'approved');
  assert.ok(rows[0]!.data.refund!.settled);
  console.log(`REFUNDS SELFTEST PASS (${process.env.REFUND_BACKEND}): 状态、权限、幂等审计、积压、提交前不通知、超时、失败备注与持久化`);
} finally {
  faults.gate = null;
  release?.();
  __profileTest.reset();
  await store.drainStore(5000);
  await gated?.close();
  await t?.close();
  await real?.drop();
}
process.exit(0);
