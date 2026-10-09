// 数字、时间与月份区间写法的自测（docs/features/console-ux/spec.md，设计系统 §2.3、§6.1、§10.0、§11；plan 第 3.4 步）：
// 1. 金额与带单位的整数：千分位，单位紧跟数字，不出现「¥」和空格；
// 2. 时间：相对时间（从 shell/model.ts 挪来的那组）、绝对时间、完整时间、时间线的「今天 13:40」、按天分组的组标题；
//    时区钉成 Asia/Shanghai，场景时刻取设计系统 §10.0 的 2026-09-26（周六）14:30；
// 3. 月份区间：设计系统 §6.1 的几种写法；能不能解析与产品库 schema 一致（上架前检查与 safeParse 同进退，含越界月份）；
//    1–12 月的全部 4,096 种组合切段后能还原成原来的月份，段是最长的、按起始月排。
// 用法：npx tsx src/shared/format.selftest.ts
process.env.TZ = 'Asia/Shanghai';

import {
  absoluteTime,
  clockTime,
  dateText,
  dateWithWeekday,
  dayHeading,
  dayKey,
  dayTime,
  digits,
  fullTime,
  money,
  monthRangeSpoken,
  monthRangeText,
  monthSegments,
  parseMonthRange,
  percent,
  quantity,
  relativeTime,
  weekday,
} from './format.js';
import { RouteSchema } from './catalog.js';
import { SALES_SEGMENTS } from './catalog-types.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

// 时区真的生效：UTC 16:00 在上海是次日 0 点。不然下面「今天」「昨天」的边界测不出按本地日历算
check('时区钉成 Asia/Shanghai', new Date('2026-09-25T16:00:00Z').getHours() === 0);

// ---------------- 1. 数字与金额 ----------------

eq('千分位', [0, 7, 999, 1000, 13800, 42800, 207440, 1234567].map(digits), [
  '0',
  '7',
  '999',
  '1,000',
  '13,800',
  '42,800',
  '207,440',
  '1,234,567',
]);
eq('千分位：负数与写不出来的', [digits(-1200), digits(Number.NaN), digits(Number.POSITIVE_INFINITY)], ['-1,200', '—', '—']);
eq('金额：默认单位「元」', money(42800), '42,800元');
eq('金额：行业包的单位', [money(13800, '元/人'), money(1280, '元/㎡')], ['13,800元/人', '1,280元/㎡']);
eq('金额：写不出来', money(Number.NaN), '—');
eq('带单位的整数', [quantity(8, '天'), quantity(4700, '米'), quantity(60, '㎡')], ['8天', '4,700米', '60㎡']);
check('金额：不出现「¥」和空格', ![money(42800), money(13800, '元/人')].some((s) => /[¥\s]/.test(s)));
eq('百分比：四舍五入成整数', [percent(0.12), percent(0.125), percent(0), percent(1)], ['12%', '13%', '0%', '100%']);
eq('百分比：写不出来', [percent(Number.NaN), percent(Number.POSITIVE_INFINITY)], ['—', '—']);

// ---------------- 2. 时间 ----------------

const NOW = new Date('2026-09-26T14:30:00+08:00').getTime();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
eq('相对时间：不到一分钟', relativeTime(ago(30_000), NOW), '刚刚');
eq('相对时间：8 分钟', relativeTime(ago(8 * MIN), NOW), '8分钟前');
eq('相对时间：59 分钟', relativeTime(ago(59 * MIN + 59_000), NOW), '59分钟前');
eq('相对时间：整 1 小时', relativeTime(ago(60 * MIN), NOW), '1小时前');
eq('相对时间：今天 0 点', relativeTime('2026-09-26T00:00:00+08:00', NOW), '14小时前');
eq('相对时间：昨天最后一刻', relativeTime('2026-09-25T23:59:59.999+08:00', NOW), '昨天23:59');
eq('相对时间：昨天 21:40', relativeTime('2026-09-25T21:40:00+08:00', NOW), '昨天21:40');
eq('相对时间：昨天 0 点', relativeTime('2026-09-25T00:00:00+08:00', NOW), '昨天00:00');
eq('相对时间：更早写日期', relativeTime('2026-09-24T23:59:00+08:00', NOW), '9月24日');
eq('相对时间：跨年加年份', relativeTime('2025-12-31T10:00:00+08:00', NOW), '2025年12月31日');
eq('相对时间：写不出来', relativeTime('不是时间', NOW), '—');
eq('相对时间：时钟略快，时间在将来', relativeTime(NOW + 5_000, NOW), '刚刚');
eq(
  '相对时间：毫秒数与 Date 同样认',
  [relativeTime(NOW - 8 * MIN, NOW), relativeTime(new Date(NOW - 8 * MIN), NOW)],
  ['8分钟前', '8分钟前'],
);

eq('时刻', clockTime('2026-09-26T09:05:00+08:00'), '09:05');
eq(
  '日期：今年不写年份，别的年份写',
  [dateText('2026-01-02T08:00:00+08:00', NOW), dateText('2027-01-02T08:00:00+08:00', NOW)],
  ['1月2日', '2027年1月2日'],
);
eq('星期：设计系统 §10.0 的三天', ['2026-09-26T14:30:00+08:00', '2026-09-25T18:30:00+08:00', '2026-09-24T10:05:00+08:00'].map(weekday), [
  '周六',
  '周五',
  '周四',
]);
eq('星期：周日', weekday('2026-09-27T12:00:00+08:00'), '周日');
eq('日期加星期（总览的状态句）', dateWithWeekday(NOW, NOW), '9月26日 周六');
eq('绝对时间（审计、版本记录）', absoluteTime('2026-09-26T14:02:00+08:00', NOW), '9月26日 14:02');
eq('绝对时间：跨年加年份', absoluteTime('2025-12-31T23:59:00+08:00', NOW), '2025年12月31日 23:59');
eq('绝对时间：按本机时区（UTC 的前一天 18:30 是上海的 02:30）', absoluteTime('2026-09-25T18:30:00Z', NOW), '9月26日 02:30');
eq('绝对时间：写不出来', absoluteTime('x', NOW), '—');
eq('完整时间（详情抽屉）', fullTime('2026-09-26T10:12:44+08:00'), '2026-09-26 10:12:44');
eq('完整时间：个位数补零', fullTime('2026-01-02T03:04:05+08:00'), '2026-01-02 03:04:05');
// 设计系统 §10.2 A 页「最近变更」的时间列：今天写「今天」，昨天及更早写日期
eq(
  '时间线的时间',
  [
    '2026-09-26T13:40:00+08:00',
    '2026-09-26T00:00:00+08:00',
    '2026-09-25T18:30:00+08:00',
    '2026-09-24T10:05:00+08:00',
    '2025-12-31T09:00:00+08:00',
  ].map((at) => dayTime(at, NOW)),
  ['今天 13:40', '今天 00:00', '9月25日 18:30', '9月24日 10:05', '2025年12月31日 09:00'],
);
// 设计系统 §10.2 K 页的组标题
eq(
  '按天分组的组标题',
  [
    '2026-09-26T13:40:00+08:00',
    '2026-09-25T23:59:59.999+08:00',
    '2026-09-25T00:00:00+08:00',
    '2026-09-24T10:05:00+08:00',
    '2025-12-31T09:00:00+08:00',
  ].map((at) => dayHeading(at, NOW)),
  [['今天', '9月26日 周六'], ['昨天', '9月25日 周五'], ['昨天', '9月25日 周五'], ['9月24日 周四'], ['2025年12月31日 周三']],
);
eq('按天分组的键：本机日历日', [dayKey('2026-09-25T16:00:00Z'), dayKey('2026-09-25T15:59:59Z')], ['2026-09-26', '2026-09-25']);
// 中文与数字之间不加空格（不变量 9）：只有日期与时刻、日期与星期之间有一个空格
const samples = [
  relativeTime(ago(8 * MIN), NOW),
  relativeTime('2026-09-25T21:40:00+08:00', NOW),
  absoluteTime(NOW, NOW),
  dayTime(NOW, NOW),
  ...dayHeading(NOW, NOW),
  money(42800),
];
check(
  '时间与金额：除了日期（含「今天」）与时刻、日期与星期之间，没有空格',
  samples.every((s) => !/\s/.test(s.replace(/([日天]) (?=\d{2}:\d{2}|周)/g, '$1'))),
  samples.join(' | '),
);

// ---------------- 3. 月份区间 ----------------

const text = (s: string, label?: string): string | null => {
  const r = parseMonthRange(s);
  return r ? monthRangeText(r, label) : null;
};
const spoken = (s: string): string | null => {
  const r = parseMonthRange(s);
  return r ? monthRangeSpoken(r) : null;
};
// 设计系统 §6.1：单段「5–10月」，多段「4–6、9–11月」，跨年「11月–次年4月」；「全年」写 yearRoundLabel
eq('月份区间：单段', text('5月-10月'), '5–10月');
eq(
  '月份区间：数据里常见的写法',
  [text('6-9月'), text('4-6月、9-11月'), text('3月–6月，9月–11月')],
  ['6–9月', '4–6、9–11月', '3–6、9–11月'],
);
eq('月份区间：跨年', text('11月-次年4月'), '11月–次年4月');
eq('月份区间：单月与不连续的单月', [text('7月'), text('4月、10月')], ['7月', '4、10月']);
eq('月份区间：一段加一段跨年', text('6-7月、12月-次年2月'), '6–7月、12月–次年2月');
eq('月份区间：十二个月都在是一段 1–12', text('1月-12月'), '1–12月');
eq('月份区间：「全年」写行业包配的文字，默认「全年」', [text('全年'), text('全年适游', '全年（不加价）')], ['全年', '全年（不加价）']);
eq('月份区间：写不出月份是 null（上架前检查拦下）', [parseMonthRange('春秋两季'), parseMonthRange('')], [null, null]);
// 上架前检查的「月份区间能解析」就是 parseMonthRange 不是 null：与产品库 schema 的 safeParse 同进退（验收 15），越界月份也一样
const ROUTE_BASE = {
  id: 'r-x',
  title: '线路',
  destination: '某地',
  days: 1,
  priceFrom: 1000,
  hotelLevel: '四星',
  highlights: ['亮点'],
  tags: [],
  segments: [SALES_SEGMENTS[0]],
  itinerary: [{ day: 1, title: '第一天', detail: '行程', hotel: '酒店', meals: '早餐' }],
  overseas: false,
};
check('月份区间：schema 夹具本身过得了', RouteSchema.safeParse({ ...ROUTE_BASE, bestSeason: '5月-10月' }).success);
const seasons = ['5月-10月', '11月-次年4月', '全年', '全年适游', '春秋两季', '', '13月', '0月', '99月', '0月-3月', '12月-13月', '3-5'];
const disagree = seasons.filter((s) => RouteSchema.safeParse({ ...ROUTE_BASE, bestSeason: s }).success !== (parseMonthRange(s) !== null));
check('月份区间：能不能解析与 schema 一致（含越界月份）', disagree.length === 0, disagree.join(' | '));
eq(
  '月份区间：越界月份不画，只剩越界月份时写「—」',
  [text('13月'), text('0月'), text('0月-3月'), spoken('13月'), parseMonthRange('13月')],
  ['—', '—', '1–3月', '—', { kind: 'months', months: [], segments: [] }],
);
eq('月份区间：解析结果', parseMonthRange('11月-次年4月'), {
  kind: 'months',
  months: [1, 2, 3, 4, 11, 12],
  segments: [{ from: 11, to: 4 }],
});
eq(
  '月份区间：读屏的说法',
  [
    monthRangeSpoken(parseMonthRange('5月-10月')!),
    monthRangeSpoken(parseMonthRange('4-6月、9-11月')!),
    monthRangeSpoken(parseMonthRange('11月-次年4月')!),
    monthRangeSpoken(parseMonthRange('7月')!),
    monthRangeSpoken(parseMonthRange('全年')!, '全年（不加价）'),
  ],
  ['5月到10月', '4月到6月、9月到11月', '11月到次年4月', '7月', '全年（不加价）'],
);
check(
  '月份区间：文字里没有空格和「¥」',
  ['5月-10月', '4-6月、9-11月', '11月-次年4月', '6-7月、12月-次年2月'].every((s) => !/[\s¥]/.test(text(s) ?? ' ')),
);

// 全部 4,096 种月份组合：段展开后正好是原来的月份；段按起始月排，彼此不相接（是最长的段）；跨年段至多一个
const expand = (s: { from: number; to: number }): number[] => {
  const out = [s.from];
  for (let m = s.from; m !== s.to;) {
    m = (m % 12) + 1;
    out.push(m);
  }
  return out;
};
const bad: string[] = [];
for (let mask = 0; mask < 4096; mask += 1) {
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => mask & (1 << (m - 1)));
  const segs = monthSegments(months);
  const covered = segs.flatMap(expand).toSorted((a, b) => a - b);
  const starts = segs.map((s) => s.from);
  const touching = segs.some((a) => segs.some((b) => a !== b && (a.to % 12) + 1 === b.from));
  const wraps = segs.filter((s) => s.to < s.from).length;
  const ok =
    JSON.stringify(covered) === JSON.stringify(months) &&
    new Set(covered).size === covered.length &&
    starts.every((s, i) => i === 0 || s > starts[i - 1]!) &&
    (months.length === 12 ? segs.length === 1 : !touching) &&
    wraps <= 1;
  if (!ok) bad.push(`${months.join(',')} → ${JSON.stringify(segs)}`);
}
check('月份区间：4,096 种组合都切得对', bad.length === 0, bad.slice(0, 3).join(' | '));

if (fails.length) {
  console.error(`FORMAT SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(`FORMAT SELFTEST PASS: ${pass} 项断言全通（金额与带单位的整数 / 相对、绝对、完整时间与按天分组 / 月份区间的写法与切段）`);
