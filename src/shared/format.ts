// 界面上数字、时间与月份区间的写法（docs/features/console-ux/spec.md，设计系统 §2.3、§6、§6.1、§10、§11）。
// 前后端共用，不依赖 React，只用本机时区：浏览器里是看的人的时区，自测把 TZ 钉成 Asia/Shanghai。
// 中文与数字之间不加空格（不变量 9，由 text-autospace 补）；日期与时刻之间、日期与星期之间留一个空格。
// 全站不出现「¥」，金额写「42,800元」。
import { bestSeasonParses, peakMonths } from './season.js';

// ---------------- 数字与金额 ----------------

/** 千分位：42800 → 「42,800」。只写整数（金额和带单位的整数都是整数），不是有限数时写「—」 */
export function digits(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额：「42,800元」「13,800元/人」。unit 是整个单位（行业包的 FieldDef.unit），默认「元」 */
export const money = (n: number, unit = '元'): string => (Number.isFinite(n) ? `${digits(n)}${unit}` : '—');

/** 带单位的整数：「8天」「4,700米」 */
export const quantity = (n: number, unit: string): string => (Number.isFinite(n) ? `${digits(n)}${unit}` : '—');

/** 0–1 的比例写成百分数整数：「12%」。不是有限数时写「—」（02 spec「运行数字」：转人工率、AI出错率） */
export const percent = (n: number): string => (Number.isFinite(n) ? `${digits(Math.round(n * 100))}%` : '—');

// ---------------- 时间 ----------------

/** 接口给的 ISO 串、毫秒数或 Date */
export type Instant = string | number | Date;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

const toDate = (at: Instant): Date => (at instanceof Date ? new Date(at.getTime()) : new Date(at));
const valid = (d: Date): boolean => Number.isFinite(d.getTime());
const pad2 = (n: number): string => String(n).padStart(2, '0');
const startOfDay = (d: Date): Date => {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
};
/** 相差几个日历日：今天 0、昨天 1（按本机时区，夏令时换日的那天也按日历算） */
function daysBefore(at: Date, now: Date): number {
  const a = startOfDay(at);
  const b = startOfDay(now);
  return Math.round((b.getTime() - a.getTime()) / (24 * HOUR));
}

/** 时刻：「13:40」 */
export function clockTime(at: Instant): string {
  const d = toDate(at);
  return valid(d) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '—';
}

/** 日期：「9月24日」，不是今年时加年份「2025年12月31日」 */
export function dateText(at: Instant, now: number): string {
  const d = toDate(at);
  if (!valid(d)) return '—';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 星期：「周六」 */
export function weekday(at: Instant): string {
  const d = toDate(at);
  return valid(d) ? WEEKDAYS[d.getDay()]! : '—';
}

/** 日期加星期：「9月26日 周六」（总览的状态句、审计的组标题） */
export const dateWithWeekday = (at: Instant, now: number): string => `${dateText(at, now)} ${weekday(at)}`;

/**
 * 绝对时间（设计系统 §11：审计和版本记录）：「9月26日 14:02」，跨年加年份。列表里的相对时间悬停也显示它
 */
export function absoluteTime(at: Instant, now: number): string {
  const d = toDate(at);
  return valid(d) ? `${dateText(d, now)} ${clockTime(d)}` : '—';
}

/** 完整时间（审计详情抽屉）：「2026-09-26 10:12:44」 */
export function fullTime(at: Instant): string {
  const d = toDate(at);
  if (!valid(d)) return '—';
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${ymd} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 时间线的时间（设计系统 §5.11「最近变更行」）：今天的写「今天 13:40」，更早的写绝对时间「9月25日 18:30」。
 * 同一天只在第一条写日期，之后的只写 clockTime，由调用方判断
 */
export function dayTime(at: Instant, now: number): string {
  const d = toDate(at);
  if (!valid(d)) return '—';
  return daysBefore(d, new Date(now)) === 0 ? `今天 ${clockTime(d)}` : absoluteTime(d, now);
}

/** 按本机日历日分组的键：「2026-09-26」 */
export function dayKey(at: Instant): string {
  const d = toDate(at);
  return valid(d) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '—';
}

/**
 * 审计按天分组的组标题（设计系统 §10.2 K 页），各段之间由调用方用 Sep 隔开：
 * 今天 ['今天', '9月26日 周六']、昨天 ['昨天', '9月25日 周五']、更早 ['9月24日 周四']
 */
export function dayHeading(at: Instant, now: number): string[] {
  const d = toDate(at);
  if (!valid(d)) return ['—'];
  const days = daysBefore(d, new Date(now));
  const date = dateWithWeekday(d, now);
  if (days === 0) return ['今天', date];
  if (days === 1) return ['昨天', date];
  return [date];
}

/**
 * 最后动静的相对时间（设计系统 §10.0 的会话表）：「刚刚」「8分钟前」「5小时前」「昨天21:40」「9月24日」，跨年加年份。
 * 「今天」「昨天」按本机时区的日历日算；悬停显示 absoluteTime
 */
export function relativeTime(at: Instant, now: number): string {
  const t = toDate(at);
  const diff = now - t.getTime();
  if (!Number.isFinite(diff)) return '—';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`;
  const days = daysBefore(t, new Date(now));
  if (days <= 0) return `${Math.floor(diff / HOUR)}小时前`;
  if (days === 1) return `昨天${clockTime(t)}`;
  return dateText(t, now);
}

// ---------------- 月份区间 ----------------

/** 一段连续的月份；to < from 表示跨年（11月到次年4月是 { from: 11, to: 4 }） */
export interface MonthSegment {
  from: number;
  to: number;
}

/** 解析后的月份区间：「全年」，或具体月份（升序，只含 1–12 月；写的全是越界月份时为空）连同连续段 */
export type MonthRange = { kind: 'yearRound' } | { kind: 'months'; months: number[]; segments: MonthSegment[] };

const next = (m: number): number => (m % 12) + 1;
const prev = (m: number): number => ((m + 10) % 12) + 1;

/** 月份集合按月历首尾相接切成连续段，按起始月排；12 个月都在时是一段 1–12 */
export function monthSegments(months: Iterable<number>): MonthSegment[] {
  const set = new Set([...months].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12));
  if (set.size === 12) return [{ from: 1, to: 12 }];
  const out: MonthSegment[] = [];
  for (const from of [...set].sort((a, b) => a - b)) {
    if (set.has(prev(from))) continue;
    let to = from;
    while (set.has(next(to))) to = next(to);
    out.push({ from, to });
  }
  return out;
}

/**
 * 按产品库 schema 同一个判定解析（src/shared/season.ts 的 bestSeasonParses：含「全年」即全年，否则 peakMonths 至少写出一个月份）：
 * 「5月-10月」「11月-次年4月」「全年（不加价）」。判定不过时是 null，这就是上架前检查的「月份区间能解析」，与 schema 的
 * safeParse 同进退（验收 15）。months 只留 1–12 月：「13月」这类写法 schema 放行（01 的规则），但画不出来，months 为空，
 * 文字写「—」
 */
export function parseMonthRange(text: string): MonthRange | null {
  if (!bestSeasonParses(text)) return null;
  if (text.includes('全年')) return { kind: 'yearRound' };
  // 在拷贝上排序，不用 toSorted：console 打包的代码要能在 Vite 默认构建目标（含 Firefox 114）里跑
  const months = [...peakMonths(text)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
  return { kind: 'months', months, segments: monthSegments(months) };
}

/**
 * 月份区间的文字（设计系统 §6.1 S 号右边的字、表单的「识别出」）：单段「5–10月」，多段「4–6、9–11月」，
 * 跨年「11月–次年4月」，单月「7月」；「全年」写行业包配的 yearRoundLabel（默认「全年」）
 */
export function monthRangeText(range: MonthRange, yearRoundLabel = '全年'): string {
  if (range.kind === 'yearRound') return yearRoundLabel;
  if (!range.segments.length) return '—';
  const plain = range.segments.filter((s) => s.to >= s.from).map((s) => (s.from === s.to ? `${s.from}` : `${s.from}–${s.to}`));
  const wraps = range.segments.filter((s) => s.to < s.from).map((s) => `${s.from}月–次年${s.to}月`);
  return [...(plain.length ? [`${plain.join('、')}月`] : []), ...wraps].join('、');
}

/** 读屏用（MonthStrip 的 aria-label）：「5月到10月」「4月到6月、9月到11月」「11月到次年4月」「7月」 */
export function monthRangeSpoken(range: MonthRange, yearRoundLabel = '全年'): string {
  if (range.kind === 'yearRound') return yearRoundLabel;
  if (!range.segments.length) return '—';
  return range.segments.map((s) => (s.from === s.to ? `${s.from}月` : `${s.from}月到${s.to < s.from ? '次年' : ''}${s.to}月`)).join('、');
}
