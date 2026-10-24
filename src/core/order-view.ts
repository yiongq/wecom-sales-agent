// 08 R3、R12：通用单的形状与展示；旧版旅游单保留原来的渲染路径。
import type { Order, OrderStatus } from '../types.js';
import { formatYuan } from '../shared/format.js';

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
