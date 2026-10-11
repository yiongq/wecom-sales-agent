// 沙箱种子的结构契约；只读已提交 JSON，不调用 Python（05 spec「开通与删除」）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Order, Session } from '../types.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../../data/sandbox-seeds.json', import.meta.url), 'utf8')) as {
  $comment: string;
  sessions: Session[];
  orders: Order[];
};
const routes = JSON.parse(fs.readFileSync(new URL('../../data/routes.json', import.meta.url), 'utf8')) as { id: string }[];

assert.ok(fixture.$comment.includes('毫秒偏移'), '文件须说明相对时间约定');
assert.equal(fixture.sessions.length, 13, '必须有 13 个种子会话');
assert.equal(fixture.orders.length, 3, '必须有 3 个种子订单');

const sessions = new Map(fixture.sessions.map((session) => [session.id, session]));
const orders = new Map(fixture.orders.map((order) => [order.id, order]));
const routeIds = new Set(routes.map((route) => route.id));
assert.equal(sessions.size, fixture.sessions.length, '会话 id 必须唯一');
assert.equal(orders.size, fixture.orders.length, '订单 id 必须唯一');

function relativeTime(value: unknown, field: string): void {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value <= 0, `${field} 必须是 <=0 的整数毫秒偏移`);
}

// 递归检查嵌套记录及后来新增的时间戳，不能只查消息而漏掉 handoff.at 或 paidAt。
function checkTimes(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkTimes(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'at' || key.endsWith('At')) relativeTime(item, `${field}.${key}`);
      else checkTimes(item, `${field}.${key}`);
    }
  }
}
checkTimes(fixture, 'fixture');

const messageTimes: number[] = [];
for (const session of fixture.sessions) {
  assert.ok(typeof session.id === 'string' && session.id.length > 0, '会话 id 不能为空');
  relativeTime(session.createdAt, `${session.id}.createdAt`);
  relativeTime(session.updatedAt, `${session.id}.updatedAt`);
  assert.ok(session.messages.length > 0, `${session.id} 缺少消息`);
  for (const message of session.messages) {
    relativeTime(message.at, `${session.id}.messages.at`);
    assert.ok(message.at >= session.createdAt && message.at <= session.updatedAt, `${session.id} 消息须在会话时间范围内`);
    messageTimes.push(message.at);
  }
  if (session.handoff) relativeTime(session.handoff.at, `${session.id}.handoff.at`);
  for (const orderId of session.orderIds) {
    const order = orders.get(orderId);
    assert.ok(order, `${session.id} 引用了不存在的订单 ${orderId}`);
    assert.equal(order.sessionId, session.id, `${orderId} 的会话引用须双向一致`);
  }
}
assert.equal(Math.max(...messageTimes), 0, '最新一条消息的偏移必须为 0');
assert.ok(
  messageTimes.some((at) => at < 0),
  '较早消息须为负偏移',
);

for (const order of fixture.orders) {
  assert.ok(typeof order.id === 'string' && order.id.length > 0, '订单 id 不能为空');
  const session = sessions.get(order.sessionId);
  assert.ok(session, `${order.id} 引用了不存在的会话 ${order.sessionId}`);
  assert.ok(session.orderIds.includes(order.id), `${order.id} 必须出现在所属会话的 orderIds 中`);
  assert.ok(routeIds.has(order.routeId), `${order.id} 引用了不存在的线路 ${order.routeId}`);
  relativeTime(order.createdAt, `${order.id}.createdAt`);
  if (order.status === 'paid') relativeTime(order.paidAt, `${order.id}.paidAt`);
}

console.log('SELFTEST PASS: 沙箱种子 13 个会话、3 个订单，引用与线路有效，时间均为相对毫秒偏移');
