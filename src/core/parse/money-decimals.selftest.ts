// 08 R6：金额解析的 decimals 模式。spec「金额解析（R6，decimals: true）」表里的每一行都有用例，反例不少于正例；
// 另有对照：不传 decimals（旅游的写法）时新正例都识别不到，已有写法的结果不变。
import assert from 'node:assert/strict';
import {
  amountHits,
  normalizeMoneyText,
  parseAmounts,
  parseCnAmounts,
  parseMoney,
  parseRangeEndpoints,
  parseSpokenAmounts,
  spokenMoney,
  type MoneyParseOptions,
} from './money.js';
import type { PackRuntime } from '../pack-api.js';

const dec: MoneyParseOptions = { minimumAmount: 0.01, precisionTolerance: 0.5, decimals: true };
/** 同样的下限，不传 decimals */
const plain: MoneyParseOptions = { minimumAmount: 0.01, precisionTolerance: 0.5 };
/** 旅游的口径 */
const travel: MoneyParseOptions = { minimumAmount: 1000, precisionTolerance: 0.5 };

let passed = 0;
let positives = 0;
let negatives = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed += 1;
}

const amountsOf = (text: string, options: MoneyParseOptions = dec): number[] => parseMoney(text, options).map((m) => m.amount);

/** 正例：parseMoney 读出的金额恰为 want；只有一个金额时，客户侧的 spokenMoney 也读出同一个数 */
function yes(text: string, want: number[], options: MoneyParseOptions = dec): void {
  positives += 1;
  eq(amountsOf(text, options), want, `正例 ${text}`);
  if (want.length === 1) eq(spokenMoney(text, options).amounts, want, `正例（客户侧）${text}`);
}

/** 反例：各个读取入口都读不出金额 */
function no(text: string, options: MoneyParseOptions = dec): void {
  negatives += 1;
  const t = normalizeMoneyText(text);
  eq(parseMoney(text, options), [], `反例 ${text}`);
  eq(amountHits(t, options), [], `反例（amountHits）${text}`);
  eq(parseSpokenAmounts(t, options), [], `反例（口语）${text}`);
  eq(spokenMoney(text, options), { amounts: [], rangeEnds: [] }, `反例（客户侧）${text}`);
}

// ---------------- 表第 1 行：带单位，1–2 位小数，1–2 位整数 ----------------
for (const [text, want] of [
  ['3.65元', 3.65],
  ['¥0.85', 0.85],
  ['99块', 99],
  ['12.5元/件', 12.5],
  ['￥3.65', 3.65],
  ['３．６５元', 3.65], // 全角归一照旧
  ['３９块', 39],
  ['3.65 元', 3.65],
  ['5元', 5],
  ['0.01元', 0.01], // 恰好等于下限
  ['1,330.50元', 1330.5],
  ['¥3.65元', 3.65], // 前缀与后缀只读一次
] as const) {
  yes(text, [want]);
}
no('3.655元'); // 小数最多两位
no('¥3.655');
no('12,3元'); // 逗号只认标准千分位
no('0.005元');
no('3.65'); // 没有单位
no('3.65千克');
no('3.65.2元');
no('12,34元');
no('元3.65');

// 位置是原文位置：零头读进范围里，后面的字不算
{
  const hit = amountHits('单价3块6毛5，起订', dec)[0];
  eq([hit.at, hit.end, hit.raw, hit.value, hit.tol], [2, 7, 3.65, 3.65, 0], 'amountHits 的位置与以元计的值');
  eq(parseAmounts('单价3.65元', dec), [3.65], 'parseAmounts 以元计');
  eq(parseMoney('3.65元', dec), [{ amount: 3.65, currency: 'CNY', unit: '元' }], 'Money 的币种与单位');
  eq(parseMoney('¥0.85', dec), [{ amount: 0.85, currency: 'CNY', unit: '¥' }], '¥ 前缀');
}

// ---------------- 表第 2 行：不带单位，紧跟「单价 / 报价 / 价格 / 每件 / 每个」 ----------------
for (const [text, want] of [
  ['单价3.80', 3.8],
  ['报价 12.5', 12.5],
  ['价格99', 99],
  ['每件2.5', 2.5],
  ['每个0.85', 0.85],
  ['单价是3.8', 3.8], // 中间可以有一个虚词，同 TIGHT_HINT
  ['单价：3.80', 3.8], // 价格词后允许一个冒号
  ['报价: 12.5', 12.5],
  ['价格：99', 99],
  ['单价3.80。', 3.8], // 句号不是小数点
] as const) {
  yes(text, [want]);
}
no('3.80'); // 没有价格词
no('型号 3.80');
no('编号12.5');
no('单价3.5天'); // 后面是量词
no('报价3档');
no('每个2人');
no('价格2026.10.23'); // 日期
no('单价3.805'); // 三位小数
no('价格表3.80'); // 价格词没有紧贴数字
no('每个月3号');
no('报价单');
no('规格：3.5'); // 冒号前不是价格词
no('型号：6205');
no('日期：2026.10.23');
no('单价：3.5天'); // 冒号后是量词
no('报价：3档');
no('备注：每个月3号');
// 已知的误报，不处理：「每个」「每件」是普通词，后面的量词表沿用 MEASURE_AFTER，
// 不在表里的量词会让 `每个2盒` 读成 2 元。给裸数再加汉字白名单会漏掉 `单价3.8美元` 一类，得不偿失。

// ---------------- 表第 3 行：口语 3块6、3块6毛5、三块六毛五 ----------------
for (const [text, want] of [
  ['3块6', 3.6],
  ['3块6毛5', 3.65],
  ['三块六毛五', 3.65],
  ['3块六毛五', 3.65],
  ['三块6毛5', 3.65],
  ['３块６毛５', 3.65],
  ['3块6毛', 3.6],
  ['3块6毛5分', 3.65],
  ['3块半', 3.5],
  ['两块五', 2.5],
  ['三块六', 3.6],
  ['十五块六毛', 15.6],
  ['三块钱', 3],
  ['3元5角', 3.5],
  ['三元五角', 3.5],
  ['单价3块6，起订200', 3.6],
  ['9块9包邮', 9.9],
  ['3块6一件', 3.6],
] as const) {
  yes(text, [want]);
}
no('三块'); // 汉字数的「三块」本身常是量词，必须带零头或「钱」才认
no('单价三块');
no('三块砖');
no('两块布');
no('三块五条'); // 零头后面紧跟量词
no('买了三块五香牛肉'); // 零头后面紧跟名词
no('一块二手板');
no('三块六个');
no('一块儿');
no('三块手表');

// 零头读不成时，「3块」自己照常读，不会读成 3.6
eq(amountsOf('3块6个'), [3], '3块6个：3 块一个，6 个另算');
eq(amountsOf('3块5厘米厚'), [3], '3块5厘米厚：5 不是零头');
eq(amountsOf('3块6毛巾'), [3], '3块6毛巾：毛巾是名词');
eq(amountsOf('3块6块'), [3, 6], '3块6块：两个价');
eq(amountsOf('3块 6'), [3], '块和尾数之间有空格：不是零头');
eq(amountsOf('3块6毛5分钟'), [3], '分钟里的分不是零头，整段不当成 3.65');
eq(amountsOf('3元6'), [3], '元不带裸尾数：3元6 只读 3 元');

// 汉字数开头的口语金额走口语那一路，阿拉伯数字开头的走 amountHits，两边不重复、不遗漏
eq(parseSpokenAmounts('三块六毛五', dec), [{ raw: 3.65, value: 3.65, tol: 0, at: 0, end: 5 }], '三块六毛五：口语金额，精确到分，容差 0');
eq(parseSpokenAmounts('3块6毛5', dec), [], '3块6毛5 由 amountHits 读，口语那一路不重复');
eq(parseCnAmounts('三块六毛五', dec), [3.65], '客户侧的汉字数口语金额留到分');
eq(parseCnAmounts('预算两万五千', dec), [25000], '汉字数的万级金额照旧');
eq(
  parseSpokenAmounts('单价三块六，十五块六毛，三块半', dec).map((h) => h.value),
  [3.6, 15.6, 3.5],
  '口语金额按原文位置排序',
);

// ---------------- 表第 4 行：倍率照旧 ----------------
yes('12.5k', [12500]);
yes('报价3.5k', [3500]); // 紧跟价格词
yes('3.8万', [38000]);
eq(parseMoney('12.5k', dec), [{ amount: 12500, currency: null, unit: 'k' }], '倍率保留原写法');
eq(amountsOf('12.5k', dec), amountsOf('12.5k', plain), '12.5k：开不开 decimals 一样');
eq(amountsOf('12.5k', dec), amountsOf('12.5k', travel), '12.5k：与旅游口径一样');
no('4K 巨幕'); // k 只认两位以上或带小数
no('12.5kg');
no('3k');
no('约3.5万公里'); // 万 后面是量词
no('3万人');
no('1万步');

// ---------------- 表第 5 行：「块」后面紧跟汉字名词是量词 ----------------
no('2块样板');
no('50块钢板');
no('3块砖');
no('20块板子');
no('5块布');
no('4块橡皮');
no('10块巧克力');
no('3.5块肥皂');
no('2000多块钢板');
no('共3块钢板，每块要运费'); // 量词不吞掉后面的「每块」
// 对照：块后面是价格说法时，块是钱
for (const [text, want] of [
  ['2块钱', 2],
  ['50块的', 50],
  ['50块一斤', 50],
  ['20块起', 20],
  ['99块包邮', 99],
  ['99块（含税）', 99],
  ['10块/件', 10],
  ['20块左右', 20],
  ['3.5块每件', 3.5],
  ['共3块钢板，每块50元', 50],
] as const) {
  yes(text, [want]);
}

// ---------------- 表第 6 行：没有金额单位，也没有紧跟价格词 ----------------
no('3.5天');
no('v2.1');
no('6205-2RS');
no('M8×30');
no('2026.10.23');
no('2026-10-23');
no('3.5折');
no('50%');
no('iPhone 15.2');
no('GB/T 3.5-2008');
no('A4 21.0×29.7');
no('304不锈钢，3.5天到货，M8×30，v2.1');
// 对照：同样的字眼旁边有真正的价，只读价
yes('v2.1版，单价3.80', [3.8]);
yes('M8×30 的螺栓，每件0.85元', [0.85]);
yes('3.5天到货，运费8元', [8]);
yes('2026.10.23发货，报价 12.5', [12.5]);

// 区间的两头也一样：没有单位的 6205-2RS、日期不是区间金额
eq(parseRangeEndpoints('6205-2RS', dec), [], '6205-2RS 不是区间');
eq(parseRangeEndpoints('2026-10-15', dec), [], '日期不是区间');
eq(parseRangeEndpoints('3-5元', dec), [3, 5], '带单位的区间两头都记');
eq(parseRangeEndpoints('3.5-4.5元', dec), [3.5, 4.5], '区间两头留到分');
eq(parseRangeEndpoints('五六千', dec), [5000, 6000], '汉字数的区间照旧');
eq(parseRangeEndpoints('8000-9000', travel), [8000, 9000], '旅游口径下无单位的大数区间照旧');

// ---------------- 表第 7 行：低于 minimumAmount 的不是金额 ----------------
no('0元');
no('0.00元');
no('0块');
no('¥0');
no('0.0元');
no('单价0');
no('0.85元', { ...dec, minimumAmount: 1 });
no('3.65元', { ...dec, minimumAmount: 5 });
yes('6.5元', [6.5], { ...dec, minimumAmount: 5 });
yes('0.85元', [0.85], { ...dec, minimumAmount: 0.85 });

// ---------------- R6 末句：约数词跟在小数后面，不按约数算，容差取最末一位的半个单位 ----------------
{
  const [one] = amountHits('12.5多块', dec);
  eq([one.raw, one.value, one.tol, one.at, one.end], [12.5, 12.5, 0.05, 0, 6], '12.5多块 = 12.5 ± 0.05（半个 0.1），不是 12.5~13.5');
  const [two] = amountHits('3.65多元', dec);
  eq([two.raw, two.value, two.tol], [3.65, 3.65, 0.005], '3.65多元 = 3.65 ± 0.005（半个 0.01）');
  const [three] = amountHits('12.50余元', dec);
  eq([three.value, three.tol], [12.5, 0.005], '写了末尾的 0 就按两位算');
  const [four] = amountHits('单价12.5来', dec);
  eq([four.value, four.tol], [12.5, 0.05], '紧跟价格词的裸数同理');
  const [exact] = amountHits('12.5元', dec);
  eq([exact.value, exact.tol], [12.5, 0], '没有约数词的小数是精确金额，容差 0');
  // 整数后面的约数词照旧：2000多 = 2000~3000，99多 = 99~100
  const [wide] = amountHits('2000多块', dec);
  eq([wide.raw, wide.value, wide.tol], [2000, 2500, 500], '整数的约数不变：2000多块');
  const [narrow] = amountHits('99多块', dec);
  eq([narrow.raw, narrow.value, narrow.tol], [99, 99.5, 0.5], '整数的约数不变：99多块');
  assert.notEqual(one.tol, 0.5); // 不是整数那套的「半个量级」
  passed += 1;
}

// ---------------- 对照：不传 decimals（旅游的写法）时，新正例都读不到 ----------------
const newPositives = [
  '3.65元',
  '¥0.85',
  '99块',
  '12.5元/件',
  '单价3.80',
  '报价 12.5',
  '单价：3.80',
  '价格99',
  '每件2.5',
  '3块6',
  '3块6毛5',
  '三块六毛五',
  '3块半',
  '两块五',
  '三块钱',
  '1,330.50元',
  '3元5角',
  '12.5多块',
  '5元',
  '0.01元',
  '３．６５元',
];
for (const text of newPositives) {
  eq(parseMoney(text, plain), [], `不传 decimals（下限 0.01）读不到：${text}`);
  eq(parseMoney(text, { ...plain, decimals: false }), [], `decimals: false 读不到：${text}`);
  eq(parseMoney(text, travel), [], `旅游口径读不到：${text}`);
  eq(spokenMoney(text, plain), { amounts: [], rangeEnds: [] }, `不传 decimals，客户侧读不到：${text}`);
  eq(amountHits(normalizeMoneyText(text), plain), [], `不传 decimals，amountHits 读不到：${text}`);
}
// 「读不到」不是因为下限：同样的下限下，大于等于三位的整数金额本来就认
eq(amountsOf('120元', plain), [120], '下限 0.01 时三位整数照认');
// 缺省与 decimals: false 逐项相同，开了 decimals 以后老写法的结果也不变
for (const text of [
  '人均38000元，两位总共7万6',
  '每人 2000多块，¥12,345',
  '预算一万九千八，差价两千八',
  '人均三万八；每人两万五呢',
  '8000-9000，五六千',
  '1.5万、3.8万元、12.5k',
  '今年4K巨幕，海拔三千六',
  '2026-10-15 出发，共5天',
]) {
  for (const options of [travel, plain]) {
    const off = { ...options, decimals: false };
    eq(parseMoney(text, off), parseMoney(text, options), `decimals: false 与缺省相同 ${text}`);
    eq(spokenMoney(text, off), spokenMoney(text, options), `decimals: false 与缺省相同（客户侧）${text}`);
    eq(parseSpokenAmounts(text, off), parseSpokenAmounts(text, options), `decimals: false 与缺省相同（口语）${text}`);
    eq(amountHits(text, off), amountHits(text, options), `decimals: false 与缺省相同（amountHits）${text}`);
  }
}
// 老写法在 decimals 模式下照认
for (const [text, want] of [
  ['人均38000元', [38000]],
  ['每人 2000多块', [2000]],
  ['¥12,345', [12345]],
  ['人均三万八', [38000]],
  ['预算一万九千八', [19800]],
  ['每人两万五呢', [25000]],
] as const) {
  eq(amountsOf(text, dec), want, `老写法在 decimals 模式下照认 ${text}`);
  eq(amountsOf(text, travel), want, `老写法的旅游口径 ${text}`);
}

// ---------------- 句子里混着读 ----------------
eq(amountsOf('这款单价3.65元，200件起订，总价730元'), [3.65, 730], '句子：单价与总价，件数不算');
eq(amountsOf('500克装，每件12.5元，满100件包邮'), [12.5], '句子：克数与件数不算');
eq(amountsOf('优惠5折，折后99块'), [99], '句子：折扣不算');
eq(amountsOf('尺寸M8×30，材质304，3.5天到货，运费8元'), [8], '句子：规格与工期不算');
eq(amountsOf('共计1,330元，其中运费12.50元'), [1330, 12.5], '句子：千分位与两位小数');
eq(amountsOf('单价3.80元/件，折合三块八'), [3.8, 3.8], '句子：数字写法与口语各读一次');
eq(amountsOf('买一块10块钱的'), [10], '句子：一块是量词，10块钱是价');

// 口语金额的币种按人民币记，单位保留「块」
eq(parseMoney('3块6毛5', dec), [{ amount: 3.65, currency: 'CNY', unit: '块' }], '3块6毛5 的币种与单位');
eq(parseMoney('三块六毛五', dec), [{ amount: 3.65, currency: 'CNY', unit: '块' }], '三块六毛五 的币种与单位');
eq(parseMoney('单价3.80', dec), [{ amount: 3.8, currency: null, unit: '' }], '不带单位不推断币种');

// ---------------- PackRuntime.money 是可选的选项成员（类型层面，typecheck 检查） ----------------
const noMoney: Pick<PackRuntime, 'money'> = {};
const withMoney: Pick<PackRuntime, 'money'> = { money: dec };
eq(noMoney.money, undefined, 'PackRuntime.money 可以不给');
eq(withMoney.money?.decimals, true, 'PackRuntime.money 带 decimals');

assert.ok(negatives >= positives, `反例（${negatives}）不得少于正例（${positives}）`);
console.log(`money-decimals selftest: ${passed} passed (正例 ${positives}, 反例 ${negatives})`);
