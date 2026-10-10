// 04 第 8 步：通用解析契约与语境差异，不扩大既有识别范围。
import assert from 'node:assert/strict';
import {
  budgetHeadcount,
  dayInMonth,
  groupSizeIn,
  hasTotalHeadcount,
  headcountIn,
  isValidIsoDate,
  latestDepart,
  monthSaid,
  monthsOf,
  parseCountArg,
  parseDayCount,
  readDepartDates,
  resolveDepartDate,
  saysDay,
  spokenDepartDate,
  spokenHeadcounts,
  statedPastDate,
  whensIn,
  type DateParsePolicy,
} from '../pack-api.js';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}
const today = '2026-10-10';
for (const [raw, want] of [
  ['两', 2],
  ['十二', 12],
  ['九十九', 99],
  ['100', 100],
  ['三五', null],
  ['零', null],
  ['0', null],
  ['两百', null],
] as const) {
  eq(parseDayCount(raw), want, `确定数字：${raw}`);
}
for (const [text, want] of [
  ['两位', 2],
  ['三十五个人', 35],
  ['2个人，4个人', 'ambiguous'],
  ['两个大人一个孩子', 'ambiguous'],
  ['2大1小', 'ambiguous'],
  ['一共3人，两个大人一个孩子', 3],
  ['再加一个人', 'delta'],
  ['一个人多少钱', undefined],
  ['三五个人', 'ambiguous'],
  ['100人', undefined],
  ['3人次', undefined],
] as const) {
  eq(headcountIn(text), want, `总人数：${text}`);
}
eq(spokenHeadcounts('两位，再加一个人'), { counts: [2], delta: true }, '增减不当总数');
eq(hasTotalHeadcount('合计三个人'), true, '总数标记');
eq(headcountIn('我们俩'), undefined, '严格人头不认省略单位');
eq(groupSizeIn('我们俩'), 2, '集体说法由调用方选择');
eq(groupSizeIn('我们三个月'), undefined, '月份不当人数');
eq(budgetHeadcount('三十五个人'), undefined, '预算沿用单中文数字的窄口径');
eq(budgetHeadcount('2个人，4个人'), 2, '预算沿用第一处人数');
eq(budgetHeadcount('一个人多少钱'), 1, '预算语境保留原读法，与出方案语境不同');
const range = { min: 1, max: 50 };
for (const [raw, want] of [
  [1, 1],
  [' 50 ', 50],
  [51, null],
  [0, null],
  [-1, null],
  [1.5, null],
  ['两', null],
  ['2位', null],
  [true, null],
  [null, null],
  ['2e0', 2],
] as const) {
  eq(parseCountArg(raw, range), want, `执行端人数转换：${String(raw)}`);
}
eq(parseCountArg(51, { min: 1, max: 100 }), 51, 'core 不固化行业人数上限');
for (const [raw, want] of [
  ['2028-02-29', true],
  ['2027-02-29', false],
  ['2026-02-31', false],
  ['2026-2-01', false],
  ['明天', false],
  ['0099-01-01', false],
  [20261010, false],
] as const) {
  eq(isValidIsoDate(raw), want, `ISO 硬校验：${raw}`);
}
eq(spokenDepartDate('10月2号出发', today), { kind: 'date', iso: '2027-10-02', exact: true }, '未写年取最近未来');
eq(spokenDepartDate('2020年1月1号出发', today), { kind: 'date', iso: undefined, exact: true }, '中文明写过去年份不给日期');
eq(spokenDepartDate('2020-01-01出发', today), { kind: 'date', iso: '2020-01-01', exact: true }, 'ISO 沿用旧解析，由执行端拒绝过去日期');
eq(spokenDepartDate('2月31号出发', today), { kind: 'date', iso: undefined, exact: true }, '非法月日不给日期');
eq(spokenDepartDate('明天再说', today), null, '约联系时间不改变出发日');
eq(spokenDepartDate('十月三号', today), { kind: 'vague' }, '不扩大中文月日识别');
eq(readDepartDates('12月1号出发，玩到12月7号', today).exact, ['2026-12-01'], '返程不当出发');
eq(readDepartDates('12月1号出发，改到12月7号', today).pick, { kind: 'date', iso: '2026-12-07', exact: true }, '同句明确改口');
eq(latestDepart(['12月1号出发', '改成月底吧'], today)?.pick, { kind: 'vague' }, '模糊改口遮住旧日期');
eq(
  latestDepart(['12月1号出发', '12月去会不会冷'], today)?.pick,
  { kind: 'date', iso: '2026-12-01', exact: true },
  '同月顺口询问不覆盖具体日',
);
eq(resolveDepartDate('2026-12-01', '改成月底吧', today), undefined, '改口不回退画像');
eq(saysDay('十二月三号', '2026-12-03'), true, '确认哪天语境可认中文月日');
eq(saysDay('丽江6日游', '2026-12-06'), false, '天数不当日期');
eq(monthSaid('明年1-2月', today), undefined, '月份区间不猜其中一个月');
eq(statedPastDate('2020年1月1号出发', today), '2020-01-01', '明写过去日期拦截');
eq(statedPastDate('2020年1月1号去过，这次12月去', today), null, '过去经历不拦截');
eq(dayInMonth({ y: 2026, mo: 10 }, today), today, '当月锚定今天');
eq(dayInMonth({ y: 2026, mo: 9 }, today), undefined, '过去月份不补日期');
// 没有行业配置的核心不自带节日；换一个虚构日期政策即可解析它。
const custom: DateParsePolicy = {
  holidayPattern: '纪念节',
  holidayDate: () => ({ kind: 'date', iso: '2026-12-20', exact: false }),
};
eq(spokenDepartDate('纪念节出发', today), null, '无政策不猜行业节日');
eq(spokenDepartDate('纪念节出发', today, custom), { kind: 'date', iso: '2026-12-20', exact: false }, '行业日期由调用方解析');
const monthPolicy = { holidayPattern: '纪念节', holidayMonths: { 纪念节: [12] } };
eq(
  whensIn('纪念节或者十一月', monthPolicy),
  [
    { months: [12], at: 0, end: 3 },
    { months: [11], at: 5, end: 8 },
  ],
  '月份来源与 UTF-16 位置',
);
eq(monthsOf('两月', monthPolicy), [], '规则月份保持旧数字集合');
eq(whensIn('十一月和两月', { holidayPattern: '', holidayMonths: {} }), [{ months: [11], at: 0, end: 3 }], '不提供行业节日时只认通用月份');
console.log(`date-count selftest: ${passed} passed`);
