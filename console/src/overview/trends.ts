// 总览的趋势（17 spec R10）：把 GET /metrics/trends 的逐日点排成六张小图和一张数据表。不依赖 React，trends.selftest.tsx 直接 import。
// 缺失就是缺失：null 不画成零，线在这里断开；分母为零的比率也是 null。每张图一个单位，不画双轴。
import type { DailyOpsPoint, MetricsTrendsView, TrendPartialReason } from '../../../src/shared/console-api.js';
import { digits, percent } from '../../../src/shared/format.js';

export type TrendDays = 7 | 30;
export const TREND_RANGES: readonly { value: TrendDays; label: string }[] = [
  { value: 7, label: '7天' },
  { value: 30, label: '30天' },
];

export type TrendKey = 'receptions' | 'replyP90Ms' | 'handoffRate' | 'aiErrorRate' | 'costMilli' | 'paidOrders';

export interface TrendMetric {
  key: TrendKey;
  label: string;
  /** 计数和费用是逐日的量，用柱；比率和耗时看走向，用线 */
  form: 'column' | 'line';
  format(v: number): string;
  /** 纵轴刻度：比卡片上的数字短一点 */
  tick(v: number): string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}秒`;
const yuan = (milli: number): string => `${(milli / 1000).toFixed(2)}元`;

export const TREND_METRICS: readonly TrendMetric[] = [
  { key: 'receptions', label: '接待会话', form: 'column', format: (v) => `${digits(v)}个`, tick: digits },
  { key: 'replyP90Ms', label: '回复p90', form: 'line', format: seconds, tick: (v) => `${v / 1000}s` },
  { key: 'handoffRate', label: '转人工率', form: 'line', format: percent, tick: percent },
  { key: 'aiErrorRate', label: 'AI错误率', form: 'line', format: percent, tick: percent },
  { key: 'costMilli', label: '模型费用', form: 'column', format: yuan, tick: (v) => `${v / 1000}元` },
  { key: 'paidOrders', label: '已付订单', form: 'column', format: (v) => `${digits(v)}单`, tick: digits },
];

/** 窗口标题：请求 30 天但只能查 7 天时写明，不让人以为这就是 30 天 */
export function rangeText(view: { requestedDays: number; days: number }): string {
  return view.days < view.requestedDays ? `请求${view.requestedDays}天，可查询最近${view.days}天` : `近${view.days}天`;
}

const REASON_TEXT: Partial<Record<TrendPartialReason, string>> = {
  retention: '只显示保留期内的数据。',
  collection_start: '开通之前没有数据。',
  deletion: '部分日期有数据被清理或删除。',
  unknown_history: '部分日期没有完整的采集记录，缺失处断开，不按零算。',
};

export const reasonNotes = (reasons: readonly TrendPartialReason[]): string[] => reasons.flatMap((r) => REASON_TEXT[r] ?? []);

/** 这段时间一个接待都没有（包括全部缺失）：不画一排空图 */
export const trendsEmpty = (view: MetricsTrendsView): boolean => view.points.every((p) => !p.receptions);

/** 卡片上这一天的完整程度 */
export function coverageText(p: DailyOpsPoint, today: string): string {
  if (p.day === today) return '今天未结束';
  if (p.coverage === 'complete') return '完整';
  return p.coverage === 'partial' ? '数据可能不全' : '无数据';
}

export const shortDay = (day: string): string => day.slice(5);

/** 卡片默认显示最近一个有数的日子；一个都没有时 null */
export function latestIndex(points: readonly DailyOpsPoint[], key: TrendKey): number | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i]![key] !== null) return i;
  return null;
}

/** 刻度取 1、2、5 的整十倍；比率封顶 100%；全空或全零时给 1，图不塌 */
export function niceMax(max: number, ratio = false): number {
  if (!(max > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(max));
  const nice = [1, 2, 5, 10].find((m) => m * base >= max)! * base;
  return ratio ? Math.min(nice, 1) : nice;
}

export const PLOT = { left: 36, right: 8, top: 8, bottom: 22, height: 112 } as const;

export interface PlotPoint {
  x: number;
  /** 值的高度位置；null 表示这一天没有这个数 */
  y: number | null;
  /** 不是完整日：柱画空心、线画虚 */
  partial: boolean;
}
export interface Plot {
  points: PlotPoint[];
  band: number;
  baseline: number;
  max: number;
  /** 线段只连相邻两天都有数的：断开的地方就是缺失 */
  lines: { x1: number; y1: number; x2: number; y2: number; dashed: boolean }[];
  /** 前后都断开的孤点：没有线可画，要画点 */
  lone: number[];
}

export function plotOf(points: readonly DailyOpsPoint[], metric: TrendMetric, width: number): Plot {
  const inner = Math.max(width - PLOT.left - PLOT.right, 40);
  const band = inner / Math.max(points.length, 1);
  const baseline = PLOT.height - PLOT.bottom;
  const values = points.map((p) => p[metric.key]);
  const max = niceMax(Math.max(0, ...values.map((v) => v ?? 0)), metric.key === 'handoffRate' || metric.key === 'aiErrorRate');
  const yOf = (v: number): number => baseline - (Math.min(v, max) / max) * (baseline - PLOT.top);
  const plotted: PlotPoint[] = points.map((p, i) => {
    const v = p[metric.key];
    return { x: PLOT.left + band * (i + 0.5), y: v === null ? null : yOf(v), partial: p.coverage !== 'complete' };
  });
  const lines: Plot['lines'] = [];
  const lone: number[] = [];
  for (const [i, a] of plotted.entries()) {
    if (a.y === null) continue;
    const b = plotted[i + 1];
    if (b && b.y !== null) lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, dashed: a.partial || b.partial });
    if ((plotted[i - 1]?.y ?? null) === null && (b?.y ?? null) === null) lone.push(i);
  }
  return { points: plotted, band, baseline, max, lines, lone };
}

/** 顶圆底方的柱：高度不到圆角时退成矩形的高度 */
export function columnPath(x: number, y: number, width: number, baseline: number): string {
  const left = x - width / 2;
  const right = x + width / 2;
  const r = Math.min(4, width / 2, baseline - y);
  return `M${left} ${baseline}V${y + r}Q${left} ${y} ${left + r} ${y}H${right - r}Q${right} ${y} ${right} ${y + r}V${baseline}Z`;
}

/** 刻度标在首、中、尾，首尾总在：30 天不挤 */
export function dayTicks(n: number): number[] {
  return [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
}
