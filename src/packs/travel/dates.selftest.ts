// 04 第 8 步：旅游政策经通用解析后仍保持节日、月份与可订范围口径。
import assert from 'node:assert/strict';
import { latestDepart, monthSaid, spokenDepartDate, whensIn } from '../../core/pack-api.js';
import { holidayIn, latestBookableDate, travelDatePolicy, travelMonthPolicy } from './dates.js';
import { travelDateThresholds } from './thresholds.js';
let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}
const today = '2026-10-10';
for (const [text, iso] of [
  ['国庆出发', '2027-10-01'],
  ['十一假期出发', '2027-10-01'],
  ['劳动节出发', '2027-05-01'],
  ['春节出发', '2027-02-06'],
  ['大年初一出发', '2027-02-06'],
  ['端午出发', '2027-06-09'],
  ['中秋出发', '2027-09-15'],
  ['八月十五出发', '2027-09-15'],
] as const) {
  eq(spokenDepartDate(text, today, travelDatePolicy), { kind: 'date', iso, exact: false }, text);
}
eq(spokenDepartDate('十一个人', today, travelDatePolicy), null, '十一人数不当节日');
eq(spokenDepartDate('2029年春节出发', today, travelDatePolicy), { kind: 'vague' }, '农历表外不猜');
for (const text of ['过完年去', '年后去', '春节后去', '过完春节去']) {
  eq(monthSaid(text, today, travelDatePolicy), { y: 2027, mo: 2, said: text.replace(/去$/, '') }, `春节后月份：${text}`);
}
eq(monthSaid('年前去', today, travelDatePolicy), { y: 2027, mo: 1, said: '年前' }, '春节前一周月份');
eq(monthSaid('春节人太多 暑假带孩子去', today, travelDatePolicy), undefined, '排除的节日不补月份');
eq(monthSaid('暑假或者过年去', today, travelDatePolicy), undefined, '未选中的春节不补月份');
eq(spokenDepartDate('春节人太多 暑假带孩子去', today, travelDatePolicy), { kind: 'vague' }, '暑假仍是模糊时间');
eq(
  spokenDepartDate('春节期间人多吗', '2028-01-28', travelDatePolicy),
  { kind: 'vague', ongoing: { from: '2028-01-28', to: '2028-02-01' } },
  '表外下一次节日仍保留眼下假期',
);
eq(
  latestDepart(['2月1号出发', '春节期间人多吗'], '2028-01-28', travelDatePolicy)?.pick,
  { kind: 'date', iso: '2028-02-01', exact: true },
  '跨月假期询问不覆盖具体日',
);
eq(holidayIn('去年国庆去过，明年五一想去', '2027-05-01'), '五一', '多个节日按实际日子取名');
eq(
  whensIn('春节和中秋，十一月，十一个人', travelMonthPolicy).map((v) => v.months),
  [[1, 2], [9, 10], [11]],
  '价格规则保留多个可能月份且不误认十一人数',
);
eq(latestBookableDate(2026), '2029-12-31', '可订截止当前年加三');
eq(travelDateThresholds.maxTravelers, 50, '执行端旅游人数上限');
console.log(`travel dates selftest: ${passed} passed`);
