// 04 第 7 步：核心金额契约与旧入口适配；金额出处仍照旅游旧行为裁决。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  amountHits,
  normalizeMoneyText,
  parseMoney,
  parseRangeEndpoints,
  parseSpokenAmounts,
  sentenceUnits,
  spokenMoney,
  type MoneyParseOptions,
  type Session,
} from './core/pack-api.js';

const options: MoneyParseOptions = { minimumAmount: 1000, precisionTolerance: 0.5 };
let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed += 1;
}

eq(parseMoney('每人 12800 美元', options), [{ amount: 12800, currency: null, unit: '美元' }], '外币保留原单位');
for (const unit of [
  '美元',
  '美金',
  '日元',
  '欧元',
  '港币',
  '港元',
  '英镑',
  '澳元',
  '加元',
  '新加坡元',
  '新台币',
  '韩元',
  '泰铢',
  'USD',
  'GBP',
]) {
  eq(parseMoney(`每人3.8万${unit}`, options), [{ amount: 38000, currency: null, unit }], `口语外币：${unit}`);
}
for (const unit of ['元', '块', '人民币', 'RMB', 'rmb']) {
  eq(parseMoney(`每人3.8万${unit}`, options), [{ amount: 38000, currency: 'CNY', unit }], `人民币：${unit}`);
}
for (const unit of ['¥', '￥']) {
  eq(parseMoney(`${unit}12,800`, options), [{ amount: 12800, currency: 'CNY', unit }], `人民币前缀：${unit}`);
}
for (const [text, amount, unit] of [
  ['每人３８，０００元', 38000, '元'],
  ['每人叁萬捌仟元', 38000, '元'],
  ['每人三万八', 38000, '万'],
  ['每人38k', 38000, 'k'],
  ['每人１．５K', 1500, 'K'],
  ['每人 12800', 12800, ''],
  ['每人2000多块', 2000, '块'],
  ['每人两千多块', 2000, '块'],
] as const) {
  eq(parseMoney(text, options), [{ amount, currency: unit === '元' || unit === '块' ? 'CNY' : null, unit }], text);
}
eq(parseMoney('4K 巨幕。大陆风景。江孜十万佛塔。海拔三千六。总共 1,200 公里。', options), [], '非金额不误认');
eq(spokenMoney('预算五六千，另一档八到九千，或者1-2万', options).rangeEnds, [5000, 6000, 8000, 9000, 10000, 20000], '区间端点');
eq(parseRangeEndpoints('2026-10-15，两三万人', options), [], '日期和量词不作金额区间');
eq(parseSpokenAmounts('人均两三万', options), [], '回复不把相邻数字区间当报价');

const low = { ...options, minimumAmount: 500 };
eq(parseMoney('每人 800 元', low), [{ amount: 800, currency: 'CNY', unit: '元' }], '调用方下限 500 识别 800');
eq(parseMoney('每人 800 元', options), [], '下限回到 1000 不管 800');
eq(spokenMoney('预算800元，500-900元', low), { amounts: [800, 900, 500, 900], rangeEnds: [500, 900] }, '客户金额与区间同样使用调用方下限');
eq(
  parseSpokenAmounts('人均三万八', { ...options, precisionTolerance: 0 }).map((h) => h.tol),
  [0],
  '精度容差由调用方提供',
);

const positioned = '😀人均 ３８，０００元。每人叁万捌仟哦';
const normalized = normalizeMoneyText(positioned);
eq(normalized.length, positioned.length, '归一保留 UTF-16 位置');
eq(
  amountHits(normalized, options).map((h) => [h.at, h.end, positioned.slice(h.at, h.end)]),
  [[5, 12, '３８，０００元']],
  '阿拉伯金额原文边界',
);
eq(
  parseSpokenAmounts(normalized, options).map((h) => [h.at, h.end, positioned.slice(h.at, h.end)]),
  [[15, 19, '叁万捌仟']],
  '中文金额原文边界',
);
const lines = '好的～预算2~3万。方案 /proposal/demo/2?v=2！\n您看呢？';
eq(
  sentenceUnits(lines).map((u) => lines.slice(u.start, u.end)),
  ['好的～', '预算2~3万。', '方案 /proposal/demo/2?v=2！', '\n', '您看呢？'],
  '句末波浪号、金额区间、版本链接与换行',
);

// 旧门面的所有测试出口及数值、位置、人数仍有固定形状；不修改锁定套件。
const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-money-parse-'));
process.env.VAR_DIR = varDir;
process.env.CONFIG_SOURCE = 'file';
process.env.PRICE_GUARD = '';
try {
  const legacy = await import('./price-guard.js');
  const session: Session = {
    id: 'sim-money',
    channel: 'simulator',
    stage: 'quote',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: 0,
    updatedAt: 0,
  };
  eq(legacy.findUnbackedPrices('每人 12800 美元', session, ''), [12800], '美元无出处照旧拦');
  eq(legacy.findUnbackedPrices('每人 12800 美元', session, '预算 12800 元'), [], '美元有人民币数值出处照旧放行');
  eq(legacy.spokenMoney('预算叁万捌仟元'), { amounts: [38000], rangeEnds: [] }, '旧客户金额签名与返回形状');
  eq(legacy.priceMentions('两位一共 7.6 万'), [{ value: 76000, tol: 500, at: 5, end: 10, scope: 'total' }], '旧金额提及形状');
  eq(
    legacy.__priceGuardTest.parseWanAmounts('两位一共 7.6 万'),
    [{ value: 76000, tol: 500, scope: 'total', travelers: 2, at: 5, end: 10 }],
    '旧人数与金额语境适配',
  );
  eq(
    Object.keys(legacy.__priceGuardTest),
    [
      'parseAmounts',
      'parseWanAmounts',
      'parseCnAmounts',
      'parseRangeEndpoints',
      'CLOSING_PRICE',
      'hasClosingPrice',
      'routeNames',
      'namedRoutes',
    ],
    '旧测试出口键集合',
  );
  eq(legacy.sentenceUnits(lines), sentenceUnits(lines), '旧句子门面使用核心出口');
  const { sentenceDiff } = await import('./trace/recorder.js');
  eq(
    sentenceDiff('好的～人均三万八。方案 /proposal/demo/2?v=2！', '好的～方案 /proposal/demo/2?v=2！'),
    { removed: ['人均三万八。'], added: [] },
    'trace 与删句共用核心边界',
  );
} finally {
  fs.rmSync(varDir, { recursive: true, force: true });
}
console.log(
  `MONEY-PARSE SELFTEST PASS: ${passed} 项断言全通（币种与原单位 / 下限与容差 / 数字归一与位置 / 区间与句子 / 旧门面与美元混认）`,
);
