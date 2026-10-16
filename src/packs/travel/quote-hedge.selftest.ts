// 06 第 16、17 步（R19）：出口兜底——删「按最终行程微调」那半句；报价轮里连「这是起价」一起删，非报价轮其余原样；
// 只剩「起价」的项目符号行整行删，不留孤立的逗号和空括号。
import assert from 'node:assert/strict';
import { dropQuoteHedge, isQuoteRound } from './quote-hedge.js';

// 报价轮的认法：有 create_quote 的结果；报错的、别的工具都不算
assert.equal(isQuoteRound([{ name: 'create_quote', result: '{"perPerson":16800}' }]), true);
assert.equal(isQuoteRound([{ name: 'create_quote', result: '{"error":"x"}' }]), false);
assert.equal(isQuoteRound([{ name: 'create_quote' }]), false);
assert.equal(isQuoteRound([{ name: 'search_routes', result: '[]' }]), false);
assert.equal(isQuoteRound([]), false);

// 锁定 V2、V5 的原话（第 17 步授权后）：报价轮里「这是起价」连标点和「微调」那半句一起删
assert.equal(dropQuoteHedge('比 11 月出发省了 5,200 元。这是起价，最终按行程微调。'), '比 11 月出发省了 5,200 元。');
assert.equal(dropQuoteHedge('国庆档期酒店都紧俏～\n这是起价，按最终行程微调。'), '国庆档期酒店都紧俏～');
assert.equal(
  dropQuoteHedge('每人 15,800 元，3 人总价 47,400 元。这是起价。您看可以吗？'),
  '每人 15,800 元，3 人总价 47,400 元。您看可以吗？',
);
assert.equal(dropQuoteHedge('总价 47,400 元，这是起价'), '总价 47,400 元');
assert.equal(
  dropQuoteHedge('每人 25,080 元\n（价格上浮了 10%；这是起价，按最终行程微调）\n超预算'),
  '每人 25,080 元\n（价格上浮了 10%）\n超预算',
);
assert.equal(dropQuoteHedge('三亚 5 日\n· 这是起价\n· 每人 15,800 元'), '三亚 5 日\n· 每人 15,800 元');
assert.equal(dropQuoteHedge('这是起价，不含机票。'), '不含机票。');

// 非报价轮：只删「微调」那半句，「起价」的说法和其余原样（q4 的原话）
assert.equal(
  dropQuoteHedge('链接里的价格是起价，按最终行程和出发日期微调，大头不会变。您更倾向哪条？', false),
  '链接里的价格是起价，大头不会变。您更倾向哪条？',
);
assert.equal(dropQuoteHedge('这是起价，最终按行程微调。', false), '这是起价。');
assert.equal(dropQuoteHedge('每人 16800 元，这是起价。', false), '每人 16800 元，这是起价。');
assert.equal(
  dropQuoteHedge('11 月 15 日出发：每人 17,380 元（起价，按最终行程微调）。', false),
  '11 月 15 日出发：每人 17,380 元（起价）。',
);
assert.equal(dropQuoteHedge('· 每人 16800 元\n· 起价，按最终行程微调', false), '· 每人 16800 元');
assert.equal(dropQuoteHedge('三亚 5 日（按最终行程微调）', false), '三亚 5 日');
assert.equal(dropQuoteHedge('价格以最终为准，按最终行程微调。', false), '价格以最终为准。');

// 各种写法：逗号可有可无，「最终」在前或在后，带「和出发日期」，前面是分号、顿号
for (const [input, expected] of [
  ['每人 17,380 元，总价 52,140 元，按最终行程微调。', '每人 17,380 元，总价 52,140 元。'],
  ['每人 17,380 元，总价 52,140 元，最终按行程微调。', '每人 17,380 元，总价 52,140 元。'],
  ['总价 52,140 元，按最终行程和出发日期微调，大头不会变。', '总价 52,140 元，大头不会变。'],
  ['总价 52,140 元（按最终行程微调）', '总价 52,140 元'],
  ['总价 52,140 元 按行程微调', '总价 52,140 元'],
  ['总价 52,140 元；按最终行程微调～', '总价 52,140 元～'],
] as const) {
  assert.equal(dropQuoteHedge(input), expected, input);
}

// 整句都是这半句：连标点一起删，不留「。。」
assert.equal(dropQuoteHedge('总价 52,140 元。按最终行程微调。您看可以吗？'), '总价 52,140 元。您看可以吗？');
assert.equal(dropQuoteHedge('总价 52,140 元。按最终行程微调，大头不会变。'), '总价 52,140 元。大头不会变。');

// 括号里的「（起价，按最终行程微调）」：删完括号也不留
assert.equal(
  dropQuoteHedge('11 月 15 日出发：每人 17,380 元，3 位总价 52,140 元（起价，按最终行程微调）。'),
  '11 月 15 日出发：每人 17,380 元，3 位总价 52,140 元。',
);

// 只剩「起价」的项目符号行整行删，前后的空行并成一个
assert.equal(
  dropQuoteHedge('报价出来了：\n\n· 云南 6 日\n· 每人 16800 起\n· 2 人总价 33600\n· 起价，按最终行程微调\n\n完整方案书也给您生成好了～'),
  '报价出来了：\n\n· 云南 6 日\n· 每人 16800 起\n· 2 人总价 33600\n\n完整方案书也给您生成好了～',
);
assert.equal(dropQuoteHedge('· 每人 16800 元\n· 起价，按最终行程微调'), '· 每人 16800 元');
assert.equal(dropQuoteHedge('三亚 5 日\n起价，按最终行程微调。'), '三亚 5 日');
assert.equal(dropQuoteHedge('中间\n\n· 起价，最终按行程微调\n\n后面'), '中间\n\n后面');

// 不碰的：本来就没有这半句的、本来就只写「起价」的（只有删了半句才整行删）、产品库里的「次日节奏微调」；
// 报价轮里不带「这是起价」的「起价」「起」也不碰
for (const same of [
  '· 每人 16800 起\n· 起价',
  '线路 5 日，每人 16800 起，含餐。',
  '目的地私人管家全程随行，每日行程复盘与次日节奏微调',
  '这条线路可以微调一下节奏，您看呢？',
  '',
]) {
  assert.equal(dropQuoteHedge(same), same, same);
  assert.equal(dropQuoteHedge(same, false), same, same);
}
// 非报价轮「这是起价」不动
assert.equal(dropQuoteHedge('每人 16800 元，总价 33600 元。这是起价。', false), '每人 16800 元，总价 33600 元。这是起价。');

// 幂等：删完再删，不变
for (const round of [true, false]) {
  const once = dropQuoteHedge('总价 52,140 元，这是起价，按最终行程微调。\n· 起价，按最终行程微调', round);
  assert.equal(dropQuoteHedge(once, round), once);
}

// 整段回复就是这半句：不把回复删空
assert.equal(dropQuoteHedge('按最终行程微调'), '按最终行程微调');

console.log('quote-hedge selftest ok');
