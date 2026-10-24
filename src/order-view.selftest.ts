// 08 第 7 步：证明包合成通用单的展示与新旧访问器隔离，不经建单或数据库投影。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLineOrder, orderDisplay, orderTotalFen, type LineOrder } from './core/order-view.js';
import type { Order } from './types.js';
import { createFixtureLineOrder } from './packs/__fixture/order-fixtures.js';

const lineOrder = createFixtureLineOrder();
const attrs = lineOrder.lines[0].attrs;
const legacy: Order = {
  id: 'ord_legacy',
  sessionId: 'wecom:wmlegacy',
  routeId: 'route-test',
  routeTitle: '合成旅游单',
  travelers: 2,
  departDate: '2026-11-01',
  totalPrice: 1330,
  status: 'pending_payment',
  createdAt: 100,
};

assert.equal(isLineOrder(lineOrder), true);
assert.equal(isLineOrder(legacy), false);
assert.equal(orderTotalFen(lineOrder), 133000);
assert.equal(orderTotalFen(legacy), 133000);
const display = orderDisplay(lineOrder);
assert.deepEqual(display, {
  title: '合成方盒甲等2项',
  summary: '2项 · 共250件',
  lines: [
    { title: '合成方盒甲', qtyText: '200件', unitPriceText: '3.65元/件', amountText: '730元', attrs },
    { title: '合成方盒乙', qtyText: '50件', unitPriceText: '12元/件', amountText: '600元' },
  ],
  totalFen: 133000,
  totalText: '1,330元',
});
assert.strictEqual(display.lines[0].attrs, attrs);
const single: LineOrder = { ...lineOrder, lines: [lineOrder.lines[0]], totalFen: 73000 };
assert.equal(orderDisplay(single).title, '合成方盒甲');
assert.equal(orderDisplay(single).summary, '1项 · 共200件');
const mixed: LineOrder = {
  ...lineOrder,
  lines: [lineOrder.lines[0], { ...lineOrder.lines[1]!, unit: '盒' }],
};
assert.equal(orderDisplay(mixed).summary, '2项');
assert.deepEqual(orderDisplay(mixed).lines[1], {
  title: '合成方盒乙',
  qtyText: '50盒',
  unitPriceText: '12元/盒',
  amountText: '600元',
});
const fractional: LineOrder = {
  ...single,
  lines: [{ ...single.lines[0], qty: 270, unitPriceFen: 5, amountFen: 1350 }],
  totalFen: 1350,
};
assert.equal(orderDisplay(fractional).totalText, '13.50元');
assert.equal(orderDisplay(fractional).lines[0].amountText, '13.50元');
assert.equal(orderDisplay(fractional).lines[0].unitPriceText, '0.05元/件');
assert.equal(orderTotalFen(fractional), 1350);
const fractionalTotal: LineOrder = {
  ...lineOrder,
  lines: [lineOrder.lines[0], { ...lineOrder.lines[1]!, unitPriceFen: 1201, amountFen: 60050 }],
  totalFen: 133050,
};
assert.equal(orderDisplay(fractionalTotal).totalText, '1,330.50元');
for (const order of [lineOrder, single, mixed, fractional, fractionalTotal]) {
  const text = JSON.stringify(orderDisplay(order));
  assert.doesNotMatch(text, /出行|出发|线路|¥|\d\s+[\p{Script=Han}]/u);
}
console.log('通用单展示：标题、同/混单位摘要、行文字、属性、整数/小数金额与不变量12通过');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-view-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1';
const newerLegacy: Order = { ...legacy, id: 'ord_newer', createdAt: 300 };
// 文件会话存储启动时直接载入两种单，避免依赖第 9 步才实现的建单路径。
fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify([legacy, lineOrder, newerLegacy]));
const { hostRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const store = await import('./store.js');
try {
  assert.equal(store.getOrder(lineOrder.id), undefined);
  assert.deepEqual(
    store.listOrders().map((o) => o.id),
    [newerLegacy.id, legacy.id],
  );
  const any = store.getAnyOrder(lineOrder.id);
  assert.deepEqual(any, lineOrder);
  assert.ok(any && isLineOrder(any));
  assert.strictEqual(
    store.listAnyOrders().find((o) => o.id === any.id),
    any,
  );
  assert.deepEqual(
    store.listAnyOrders().map((o) => o.id),
    [newerLegacy.id, lineOrder.id, legacy.id],
  );
  any.status = 'paid';
  any.paidAt = 250;
  assert.equal(store.getAnyOrder(any.id)?.status, 'paid');

  const old: Order | undefined = store.getOrder(legacy.id);
  assert.ok(old);
  assert.equal(old.travelers, 2);
  assert.equal(old.departDate, legacy.departDate);
  assert.strictEqual(old, hostRuntime().store.orders.get(old.id));
  assert.strictEqual(store.getAnyOrder(old.id), old);
  assert.strictEqual(
    store.listOrders().find((o) => o.id === old.id),
    old,
  );
  assert.strictEqual(
    store.listAnyOrders().find((o) => o.id === old.id),
    old,
  );
  old.status = 'superseded';
  old.supersededBy = newerLegacy.id;
  old.createdAt = 400;
  old.paidAt = 450;
  assert.equal(store.getOrder(old.id)?.status, 'superseded');
  assert.equal(store.getOrder(old.id)?.supersededBy, newerLegacy.id);
  assert.equal(store.getAnyOrder(old.id)?.paidAt, 450);
  assert.strictEqual(store.listOrders()[0], old);
  assert.strictEqual(store.listAnyOrders()[0], old);

  for (const id of ['', 'missing', 'malformed id']) {
    assert.equal(store.getOrder(id), undefined);
    assert.equal(store.getAnyOrder(id), undefined);
  }
  hostRuntime().store.orders.clear();
  assert.equal(store.getOrder(old.id), undefined);
  assert.equal(store.getAnyOrder(any.id), undefined);
  assert.deepEqual(store.listOrders(), []);
  assert.deepEqual(store.listAnyOrders(), []);
  console.log('订单访问器：新旧分流、活对象、倒序、旧版字段可写与空/不存在id通过');
} finally {
  const state = hostRuntime().store;
  state.fileBackend?.reset();
  if (state.maintenanceTimer) clearInterval(state.maintenanceTimer);
  if (state.changeTimer) clearTimeout(state.changeTimer);
  fs.rmSync(dir, { recursive: true, force: true });
}
