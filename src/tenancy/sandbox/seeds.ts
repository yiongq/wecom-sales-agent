// 唯一来源是已提交的种子夹具；每次开通生成新会话 id，所有相对时间统一平移。
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Order, Session } from '../../types.js';

export function sandboxSeeds(createdAt: number): { sessions: Session[]; orders: Order[] } {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../data/sandbox-seeds.json', import.meta.url), 'utf8')) as {
    sessions: Session[];
    orders: Order[];
  };
  const ids = new Map(fixture.sessions.map((session) => [session.id, `sbx-${randomBytes(16).toString('hex')}`]));
  const base = createdAt - 5 * 60_000;
  function shift(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shift);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          (key === 'at' || key.endsWith('At')) && typeof item === 'number' ? base + item : shift(item),
        ]),
      );
    return value;
  }
  return {
    sessions: fixture.sessions.map((session) => ({ ...(shift(session) as Session), id: ids.get(session.id)!, channel: 'simulator' })),
    orders: fixture.orders.map((order) => ({ ...(shift(order) as Order), sessionId: ids.get(order.sessionId)! })),
  };
}
