// 07 R17–R19：真实引擎 + 两种存储，固定文字与金额、会话核验、提交前不报办结、幂等与旧安全网。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostRuntime, withoutTenantScope } from './tenancy/runtime.js';
import { enterTenantScopeForTest } from './tenancy/testing.js';
import type { Order, Session } from './types.js';

if (!process.env.AFTER_SALES_BACKEND) {
  for (const backend of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename], {
      env: { ...process.env, AFTER_SALES_BACKEND: backend },
      encoding: 'utf8',
      timeout: 120000,
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.status, 0, `${backend} 售后自测失败：${child.error ?? ''}`);
  }
  process.exit(0);
}

enterTenantScopeForTest(hostRuntime());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-selftest-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SESSION_STORE = 'db';
process.env.LLM_MOCK = '1';
process.env.SOP_PATH = path.join(dir, 'sop.md');
fs.copyFileSync(new URL('../data/sop.md', import.meta.url), process.env.SOP_PATH);
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const testing = await withoutTenantScope(() => import('./db/testing.js'));
const config = await withoutTenantScope(() => import('./config/source.js'));
const store = await withoutTenantScope(() => import('./store.js'));
const { handleMessage } = await withoutTenantScope(() => import('./engine.js'));
const { observeRequests } = await import('./core/llm/client.js');
const { __profileTest } = await import('./profile.js');
const { defaultTravelPolicy } = await import('./packs/travel/policy.js');
const { isRefundIntent } = await import('./packs/travel/after-sales.js');
const { todayIso } = await import('./env.js');
const { paidNeedsHuman } = await import('./shared/conversation.js');
const { packById } = await import('./packs/registry.js');
const t = process.env.AFTER_SALES_BACKEND === 'pglite' ? await testing.openTestDb() : null;
const real = t ? null : await testing.createRealPgFixture(process.env.PG_TEST_URL!);
const gated = real ? await testing.openGatedDb(real.urls.app) : null;
await config.initConfig(null);
const fx = t ? await testing.installPgSessionStore(t, { varDir: dir }) : null;
const faults = fx?.faults ?? gated!.faults;
await store.initSessionStore(fx?.deps ?? { db: gated!.db, tenantId: real!.tenantId, tenantSlug: 'demo', varDir: dir });
const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
  if (real) return real.query<T>(sql, params);
  return t!.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<T>(sql, params)).rows;
  });
};
const plusDays = (n: number) => new Date(Date.parse(`${todayIso()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let seq = 0;
async function orderSession(amount = 40000, days = 40, status: Order['status'] = 'paid') {
  const s = store.getOrCreateSession(`wecom:after-sales-${++seq}`, 'wecom');
  const o = store.createOrder({
    sessionId: s.id,
    routeId: 'r-test',
    routeTitle: '合成售后线路',
    travelers: 2,
    departDate: plusDays(days),
    totalPrice: amount,
  });
  s.orderIds.push(o.id);
  store.saveSession(s);
  if (status === 'paid') {
    store.markOrderPaid(o.id);
    s.stage = 'paid';
    store.saveSession(s);
  }
  await store.flushSession(s.id);
  return { s, o };
}
const say = (s: Session, text: string) => handleMessage(s.id, text, 'wecom');
let requests = 0;
observeRequests(() => {
  requests++;
});
config.currentPack().runtime.mock.chat = async () => '好的，您可以继续说。';
let release: (() => void) | undefined;
try {
  for (const text of ['我要退款', '退订', '退钱', '取消订单', '不去了', '这张单能不能退', '这张订单可以退吗', '能退多少']) {
    assert.ok(isRefundIntent(text), text);
  }
  for (const text of ['重置', '重新开始', '退改规则怎么算', '能取消吗', '退款政策是什么', '退款手续费多少', '退款比例怎么算']) {
    assert.equal(isRefundIntent(text), false, text);
  }
  const { s, o } = await orderSession();
  const before = requests;
  const quote = await say(s, '我要退款');
  for (const part of [o.routeTitle, o.id.slice(-6), '40 天', '退改条款第1条', '¥40,000', '确认退款'])
    assert.ok(quote.text.includes(part), part);
  assert.equal(o.status, 'paid');
  assert.equal(s.handedOver, false);
  assert.equal(requests, before);
  assert.equal(s.afterSale!.step, 'confirm');
  const pendingConfirmation = s.afterSale;
  if (pendingConfirmation?.step === 'confirm') {
    // JSONB 读回来的键顺序可能不同，不能因此把未变的报价当成新报价。
    pendingConfirmation.quote = Object.fromEntries(Object.entries(pendingConfirmation.quote).reverse()) as typeof pendingConfirmation.quote;
  }
  const confirmed = await say(s, '确认退款！');
  assert.ok(confirmed.handoff);
  assert.equal(o.status, 'refund_pending');
  assert.equal(s.stage, 'paid');
  assert.equal(s.handoff!.kind, 'refund');
  assert.equal(s.handoff!.reason, '退款待审批：¥40,000（退改条款第1条）');
  assert.ok(paidNeedsHuman(s, packById('travel')!));
  assert.match(confirmed.text, /超过 ¥30,000/);
  const refundId = o.refund!.id;
  assert.ok((await say(s, '确认退款')).silent);
  assert.equal(o.refund!.id, refundId);
  assert.equal(requests, before);

  await store.flushSession(s.id);
  const audits = await query<{ count: string }>(
    "select count(*)::text as count from audit_log where target_id = $1 and action = 'order.refund_request'",
    [o.id],
  );
  assert.equal(audits[0]!.count, '1');
  const saved = await query<{ state: Session }>('select state from conversations where id = $1', [s.id]);
  assert.equal(saved[0]!.state.afterSale!.step, 'confirm', '售后状态随会话持久化');

  const multi = await orderSession();
  const other = await orderSession(10000);
  // 不换订单所属会话，另在同一会话建第二张单。
  const second = store.createOrder({
    sessionId: multi.s.id,
    routeId: 'r-second',
    routeTitle: '合成第二线路',
    travelers: 1,
    departDate: plusDays(40),
    totalPrice: 20000,
  });
  multi.s.orderIds.push(second.id);
  store.markOrderPaid(second.id);
  store.saveSession(multi.s);
  const chosen = await say(multi.s, '我要退款');
  assert.match(chosen.text, /多张可退款订单/);
  for (const order of [multi.o, second]) {
    assert.ok(chosen.text.includes(order.id.slice(-6)) && chosen.text.includes(order.departDate));
  }
  assert.equal(multi.s.afterSale!.step, 'choose');
  const selected = await say(multi.s, second.id.slice(-6));
  assert.ok(selected.text.includes(second.routeTitle));
  const afterSelection = store.getSession(multi.s.id)!.afterSale;
  assert.equal(afterSelection?.step === 'confirm' && afterSelection.quote.orderId, second.id);
  assert.equal(requests, before);

  multi.o.departDate = plusDays(-1);
  store.saveOrder(multi.o);
  delete multi.s.afterSale;
  const onlyRefundable = await say(multi.s, '我要退款');
  assert.ok(onlyRefundable.text.includes(second.routeTitle));
  assert.doesNotMatch(onlyRefundable.text, /多张可退款订单/);

  // 只能用会话所属的订单：尾号和伪造引用都不能借另一会话的报价提交。
  multi.s.afterSale = { step: 'choose', orderIds: [other.o.id], at: Date.now() };
  await say(multi.s, other.o.id.slice(-6));
  assert.equal(multi.s.afterSale, undefined);
  const ownQuote = s.afterSale;
  other.s.afterSale = structuredClone(ownQuote);
  await say(other.s, '确认退款');
  assert.equal(other.o.status, 'paid');
  assert.equal(other.s.afterSale, undefined);

  // 模拟支付当场办结：先暂停落库，不能提前回复办结。
  const auto = await orderSession(30000);
  await say(auto.s, '能退多少');
  faults.gate = new Promise<void>((r) => {
    release = r;
  });
  let replied = false;
  const submitting = say(auto.s, '确认退款').then((r) => {
    replied = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(replied, false);
  assert.equal(
    auto.s.messages.some((m) => m.role === 'agent' && m.content.includes('已为您办好退款')),
    false,
  );
  assert.equal((await query<{ status: string }>('select status from orders where id = $1', [auto.o.id]))[0]!.status, 'paid');
  faults.gate = null;
  release!();
  const done = await submitting;
  assert.match(done.text, /已为您办好退款 ¥30,000/);
  assert.equal(auto.s.handedOver, false);
  assert.equal((await query<{ status: string }>('select status from orders where id = $1', [auto.o.id]))[0]!.status, 'refunded');
  const duplicate = await say(auto.s, '确认退款.');
  assert.equal(duplicate.text, '退款申请已经提交过了');
  assert.equal(auto.s.handedOver, false);

  const delayed = await orderSession(10000);
  await say(delayed.s, '不去了');
  faults.gate = new Promise<void>((r) => {
    release = r;
  });
  const releaseTimer = setTimeout(() => {
    faults.gate = null;
    release!();
  }, 6000);
  try {
    const result = await say(delayed.s, '确认退款');
    assert.match(result.text, /正在处理/);
    assert.doesNotMatch(result.text, /已为您办好/);
    assert.equal(delayed.s.handoff!.kind, 'refund');
    await store.flushSession(delayed.s.id);
    assert.equal(
      delayed.s.messages.some((m) => m.content.includes('已为您办好退款')),
      false,
    );
  } finally {
    clearTimeout(releaseTimer);
    faults.gate = null;
    release!();
  }

  const busy = await orderSession(10000);
  await say(busy.s, '我要退款');
  faults.gate = new Promise<void>((r) => {
    release = r;
  });
  store.saveSession(busy.s);
  await new Promise((r) => setTimeout(r, 30));
  const clock = Date.now;
  const now = clock();
  Date.now = () => now + 6000;
  try {
    const result = await say(busy.s, '确认退款');
    assert.match(result.text, /系统有点忙/);
    assert.equal(busy.o.status, 'paid');
    assert.equal(busy.s.handedOver, false);
    assert.equal(busy.s.afterSale!.step, 'confirm');
  } finally {
    Date.now = clock;
    faults.gate = null;
    release!();
  }
  await store.flushSession(busy.s.id);
  assert.match((await say(busy.s, '确认退款')).text, /已为您办好退款/);

  // 未过期确认仍要求同一个发布哈希；30 分钟、其它话、重置均清掉状态。
  for (const action of ['expired', 'policy', 'other', 'reset', 'invalid-tail']) {
    const test = await orderSession();
    if (action === 'invalid-tail') {
      const extra = store.createOrder({
        sessionId: test.s.id,
        routeId: 'r-x',
        routeTitle: '另一合成线路',
        travelers: 1,
        departDate: plusDays(40),
        totalPrice: 1000,
      });
      test.s.orderIds.push(extra.id);
      store.markOrderPaid(extra.id);
      store.saveSession(test.s);
    }
    await say(test.s, '我要退款');
    if (action === 'expired') test.s.afterSale!.at -= 30 * 60000;
    if (action === 'policy')
      fs.writeFileSync(
        path.join(dir, 'policy.json'),
        JSON.stringify({ ...defaultTravelPolicy, refund: { ...defaultTravelPolicy.refund, approvalThresholdYuan: 50000 } }),
      );
    const n = requests;
    await say(
      test.s,
      action === 'reset' ? '重置' : action === 'other' ? '我还要再考虑一下' : action === 'invalid-tail' ? 'wrong-tail' : '确认退款',
    );
    assert.equal(test.s.afterSale, undefined, action);
    if (action === 'other' || action === 'invalid-tail') assert.equal(requests, n + 1, '取消售后后照常走模型');
    if (action !== 'reset') assert.equal(test.o.status, 'paid');
    fs.rmSync(path.join(dir, 'policy.json'), { force: true });
  }

  for (const [text, days, rejected] of [
    ['能退多少', -1, false],
    ['不去了', 6, false],
    ['这张单能不能退', 40, true],
  ] as const) {
    const test = await orderSession(40000, days);
    if (rejected) {
      test.o.refund = { ...o.refund!, id: `rf_rejected-${seq}`, approval: 'rejected' };
      store.saveOrder(test.o);
    }
    const n = requests;
    const result = await say(test.s, text);
    assert.equal(test.s.handoff!.kind, 'refund');
    assert.match(result.text, /退改由资深顾问/);
    assert.doesNotMatch(result.text, /确认退款|可退全款/);
    assert.equal(requests, n);
  }
  const complaint = await orderSession();
  assert.match((await say(complaint.s, '你们骗人，我要退款')).text, /抱歉|对不起/);
  assert.equal(complaint.s.handoff!.kind, 'complaint');
  const negative = await orderSession();
  negative.s.negativeHits = [1];
  const unhappy = await say(negative.s, '不去了，你们太敷衍了');
  assert.equal(negative.s.handoff!.kind, 'sentiment');
  assert.match(unhappy.text, /抱歉|对不起/);
  const pending = await orderSession(10000, 40, 'pending_payment');
  assert.match((await say(pending.s, '我要退款')).text, /退改由资深顾问/);
  assert.equal(pending.o.status, 'pending_payment');
  const human = await orderSession();
  assert.match((await say(human.s, '转人工')).text, /您预订的/);
  assert.equal(human.s.handoff!.kind, 'request');
  const outsider = await orderSession();
  assert.match((await say(outsider.s, '我在另一个微信下的单')).text, /退改由资深顾问/);
  assert.equal(outsider.s.handoff!.kind, 'refund');
  const empty = store.getOrCreateSession('wecom:no-order', 'wecom');
  await say(empty, '我要退款');
  assert.equal(empty.handoff!.kind, 'refund');

  fs.writeFileSync(
    path.join(dir, 'policy.json'),
    JSON.stringify({ ...defaultTravelPolicy, refund: { ...defaultTravelPolicy.refund, selfService: false } }),
  );
  const disabled = await orderSession();
  assert.match((await say(disabled.s, '我要退款')).text, /退改由资深顾问/);
  assert.equal(disabled.o.status, 'paid');
  fs.rmSync(path.join(dir, 'policy.json'));

  const advisor = await orderSession(10000);
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  await say(advisor.s, '我要退款');
  const submitted = await say(advisor.s, '确认退款');
  assert.match(submitted.text, /按原付款方式退回/);
  assert.equal(advisor.o.refund!.approval, 'auto');
  assert.equal(advisor.o.status, 'refund_pending');
  assert.equal(advisor.s.handoff!.reason, '退款待打款：¥10,000（已自动批准，按原付款方式退回）');
  __profileTest.reset();
  console.log(
    `AFTER SALES SELFTEST PASS (${process.env.AFTER_SALES_BACKEND}): 选单、报价、确认零模型、幂等、落库门禁、6秒暂停、旧安全网与会话边界`,
  );
} finally {
  faults.gate = null;
  release?.();
  observeRequests(null);
  __profileTest.reset();
  await store.drainStore(5000);
  await gated?.close();
  await t?.close();
  await real?.drop();
}
process.exit(0);
