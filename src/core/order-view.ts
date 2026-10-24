// 08 R3、R12：通用单的形状与展示；旧版旅游单保留原来的渲染路径。
import type { Order, OrderStatus, Session } from '../types.js';
import { formatYuan } from '../shared/format.js';

export interface LinePick {
  kind: string;
  code: string;
  qty: number;
}

export interface OrderLine {
  kind: string;
  code: string;
  version?: number;
  title: string;
  qty: number;
  unit: string;
  unitPriceFen: number;
  /** unitPriceFen × qty，整数分。 */
  amountFen: number;
  attrs?: Readonly<Record<string, string>>;
}

export interface LineOrder {
  v: 2;
  id: string;
  sessionId: string;
  lines: [OrderLine, ...OrderLine[]];
  /** 各行 amountFen 之和，整数分。 */
  totalFen: number;
  status: Exclude<OrderStatus, 'refund_pending' | 'refunded'>;
  createdAt: number;
  paidAt?: number;
  supersededBy?: string;
  handoffBeforePaid?: boolean;
  confirmedAt?: number;
  confirmedBy?: Order['confirmedBy'];
  paidMarkedBy?: Order['paidMarkedBy'];
  cancelReason?: string;
}

export type AnyOrder = Order | LineOrder;

export interface OrderDisplay {
  title: string;
  summary: string;
  lines: { title: string; qtyText: string; unitPriceText: string; amountText: string; attrs?: Record<string, string> }[];
  totalFen: number;
  totalText: string;
}

/** /api/orders/:id 对通用单的白名单。 */
export interface PublicLineOrder {
  id: string;
  status: OrderStatus;
  display: OrderDisplay;
  paidAt?: number;
  payable: boolean;
}

export function isLineOrder(o: AnyOrder): o is LineOrder {
  return 'v' in o && o.v === 2;
}

export function orderTotalFen(o: AnyOrder): number {
  return isLineOrder(o) ? o.totalFen : o.totalPrice * 100;
}

/** 08 R3：只读条目与数量，先完整计价再修改存储；同步段内完成复用/作废，不留并发建单窗口。 */
export async function createLineOrder(
  session: Session,
  picks: readonly LinePick[],
): Promise<
  { order: LineOrder; reused: boolean } | { rejected: { kind: string; code: string; reason: string; detail?: Record<string, unknown> }[] }
> {
  // 展示与类型访问器保持无存储副作用；只有实际建单才装配写路径。
  const [{ currentCatalog, currentPack, catalogVersionKey }, { assertKind, CatalogKindUnknownError }, store] = await Promise.all([
    import('../config/source.js'),
    import('../config/catalog.js'),
    import('../store.js'),
  ]);
  const { runtime } = currentPack();
  if (!runtime.priceLine) throw new Error(`行业包 ${runtime.id} 未提供 priceLine`);
  const maxQty = runtime.maxQty ?? 100000;
  if (!Number.isSafeInteger(maxQty) || maxQty < 1) throw new Error(`行业包 ${runtime.id} 的 maxQty 无效`);
  const snapshot = currentCatalog();
  const lines: OrderLine[] = [];
  const rejected: { kind: string; code: string; reason: string; detail?: Record<string, unknown> }[] = [];
  if (!picks.length) return { rejected: [{ kind: '', code: '', reason: 'empty_lines' }] };
  let totalFen = 0;
  const money = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`行业包 ${runtime.id} 的 priceLine 金额无效`);
    return value;
  };
  for (const { kind, code, qty } of picks) {
    try {
      assertKind(runtime.id, kind);
    } catch (error) {
      if (!(error instanceof CatalogKindUnknownError)) throw error;
      rejected.push({ kind, code, reason: 'kind_unknown' });
      continue;
    }
    const item = snapshot.items[kind]?.find((value) => (value as Record<string, unknown>).id === code) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (!item) {
      rejected.push({ kind, code, reason: 'item_inactive' });
      continue;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) {
      rejected.push({ kind, code, reason: 'invalid_qty' });
      continue;
    }
    const price = runtime.priceLine(item, qty, { kind, session });
    if ('reject' in price) {
      rejected.push({ kind, code, reason: price.reject, ...(price.detail === undefined ? {} : { detail: price.detail }) });
      continue;
    }
    const unitPriceFen = money(price.unitPriceFen);
    const amountFen = money(unitPriceFen * qty);
    totalFen = money(totalFen + amountFen);
    lines.push({
      kind,
      code,
      version: snapshot.versions[catalogVersionKey(kind, code)],
      title: String(item[runtime.catalog[kind]!.titleKey]),
      qty,
      unit: price.unit,
      unitPriceFen,
      amountFen,
      ...(price.attrs === undefined ? {} : { attrs: { ...price.attrs } }),
    });
  }
  if (rejected.length) return { rejected };
  const pending = store
    .listAnyOrders()
    .filter((order): order is LineOrder => isLineOrder(order) && order.sessionId === session.id && order.status === 'pending_payment');
  const key = (rows: readonly OrderLine[]): string =>
    JSON.stringify(rows.map(({ kind, code, qty, unitPriceFen }) => JSON.stringify([kind, code, qty, unitPriceFen])).toSorted());
  const reused = pending.find((order) => key(order.lines) === key(lines));
  if (reused) return { order: reused, reused: true };
  const order = store.createStoredLineOrder({ v: 2, sessionId: session.id, lines: lines as LineOrder['lines'], totalFen });
  for (const old of pending) store.supersedeOrder(old.id, order.id);
  session.orderIds.push(order.id);
  store.saveSession(session);
  return { order, reused: false };
}

/** 只展示通用单；所有金额均经 formatYuan。 */
export function orderDisplay(o: LineOrder): OrderDisplay {
  const first = o.lines[0];
  const count = o.lines.length;
  const sameUnit = o.lines.every((line) => line.unit === first.unit);
  return {
    title: first.title + (count > 1 ? `等${count}项` : ''),
    summary: `${count}项` + (sameUnit ? ` · 共${o.lines.reduce((qty, line) => qty + line.qty, 0)}${first.unit}` : ''),
    lines: o.lines.map((line) => ({
      title: line.title,
      qtyText: `${line.qty}${line.unit}`,
      unitPriceText: `${formatYuan(line.unitPriceFen)}/${line.unit}`,
      amountText: formatYuan(line.amountFen),
      ...(line.attrs === undefined ? {} : { attrs: line.attrs }),
    })),
    totalFen: o.totalFen,
    totalText: formatYuan(o.totalFen),
  };
}
