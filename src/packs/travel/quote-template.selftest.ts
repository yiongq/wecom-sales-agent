// 06 第 12 步：R9 兜底报价模板、R15 残句新分支、R16 转人工话术的纯函数部分。
import assert from 'node:assert/strict';
import type { PriceGuardSources, Route } from '../../core/pack-api.js';
import { handoffHead, type ContactMode } from './contact-words.js';
import { createTravelPriceGuard } from './price-guard.js';
import { excludesRoundTripTransport, readableQuoteNote, renderQuoteLine } from './quote-template.js';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}
const yuan = (n: number): string => '¥' + n.toLocaleString('zh-CN');
const base = { title: '云南 丽江大理·洱海古城 6 日', travelers: 2, perPerson: 17380, total: 34760, yuan };

// ---- R9：三种日期情形 ----
eq(
  renderQuoteLine({ ...base, note: '10月为最佳出行季，价格上浮 10%', when: '10 月 12 日出发', excludesTransport: true }),
  '《云南 丽江大理·洱海古城 6 日》2 位、10 月 12 日出发，每人 ¥17,380，总价 ¥34,760（10 月为最佳出行季，上浮 10%）。不含往返大交通。',
  '有出发日',
);
eq(
  renderQuoteLine({ ...base, note: '10月为最佳出行季，价格上浮 10%', when: '国庆出发', excludesTransport: true }),
  '《云南 丽江大理·洱海古城 6 日》2 位、国庆出发，每人 ¥17,380，总价 ¥34,760（10 月为最佳出行季，上浮 10%）。不含往返大交通。',
  '只说了节日',
);
eq(
  renderQuoteLine({ ...base, note: '当前为标准价', excludesTransport: false }),
  '《云南 丽江大理·洱海古城 6 日》2 位，每人 ¥17,380，总价 ¥34,760（标准价）。出发日期定了我按日期实报。',
  '没有日期，也不含往返大交通的那句',
);
eq(
  renderQuoteLine({ ...base, note: '11月为最佳出行季，价格上浮 10%；4 人及以上享 95 折', when: '11 月出发', excludesTransport: false }),
  '《云南 丽江大理·洱海古城 6 日》2 位、11 月出发，每人 ¥17,380，总价 ¥34,760（11 月为最佳出行季，上浮 10%，4 人及以上享 95 折）。',
  '只说了月份、线路不含里没有往返大交通',
);
for (const when of [undefined, '国庆出发', '10 月 12 日出发']) {
  for (const excludesTransport of [true, false]) {
    const t = renderQuoteLine({ ...base, note: '当前为标准价', when, excludesTransport });
    assert.ok(!/起价|微调|系统|[*#`]/.test(t), t);
    assert.ok(t.includes('总价 ¥34,760'), t);
    assert.equal(t.includes('不含往返大交通'), excludesTransport, t);
    passed += 3;
  }
}
eq(readableQuoteNote(undefined), '标准价', '没有说明');
eq(readableQuoteNote('11月不在最佳季，不上浮'), '11 月不在最佳季，不上浮', '非最佳季');
eq(excludesRoundTripTransport(['各出发地往返成都的大交通', '个人消费']), true, '不含里有往返大交通');
eq(excludesRoundTripTransport(['中国往返巴厘岛国际机票及机场税']), true, '不含里有往返机票');
eq(excludesRoundTripTransport(['个人消费', '景区内小交通']), false, '没有往返大交通');
eq(excludesRoundTripTransport(undefined), false, '没有不含项');

// ---- R16：转人工开头的三种渲染 ----
const legacy: ContactMode = { channel: 'wecom', templateMode: false };
const web: ContactMode = { channel: 'web', templateMode: false };
const template: ContactMode = { channel: 'wecom', templateMode: true };
eq(handoffHead('request', legacy), '好的，马上为您转接资深顾问，顾问会在微信上联系您，请稍候～', '普通转人工，旧版');
eq(handoffHead('request', web), '好的，马上为您转接资深顾问，顾问会在这个页面里回复您，请稍候～', '普通转人工，网页');
eq(handoffHead('request', template), '好的，马上为您转接资深顾问，顾问会联系您，请稍候～', '普通转人工，模板模式不点名渠道');
eq(handoffHead('refund', legacy), '退改由资深顾问为您处理，马上为您转接，顾问会在微信上联系您，请稍候～', '退改，旧版');
eq(handoffHead('refund', web), '退改由资深顾问为您处理，马上为您转接，顾问会在这个页面里回复您，请稍候～', '退改，网页');
eq(handoffHead('refund', template), '退改由资深顾问为您处理，马上为您转接，顾问会联系您，请稍候～', '退改，模板模式');
eq(
  handoffHead('request', legacy, '我是云途定制旅行的 AI 旅行顾问'),
  '我是云途定制旅行的 AI 旅行顾问，马上为您转接资深顾问，顾问会在微信上联系您。',
  '合并句，旧版',
);
eq(handoffHead('request', template, '我是山海的 AI 顾问'), '我是山海的 AI 顾问，马上为您转接资深顾问，顾问会联系您。', '合并句，模板模式');
for (const mode of [legacy, web, template]) {
  for (const t of [
    handoffHead('request', mode),
    handoffHead('refund', mode),
    handoffHead('request', mode, '我是测试的 AI 顾问'),
    handoffHead('refund', mode, '我是测试的 AI 顾问'),
  ]) {
    assert.ok(!/付款|仍然有效|电话|7×24|云途.*云途/.test(t.replace('我是云途定制旅行的 AI 旅行顾问', '')), t);
    passed++;
  }
}
for (const t of [handoffHead('request', template), handoffHead('refund', template)]) assert.ok(!/微信|页面|云途/.test(t), t);
passed++;
// 合并句：首行含 AI、含连续「转接资深顾问」、只有一行
{
  const t = handoffHead('request', legacy, '我是云途定制旅行的 AI 旅行顾问');
  assert.ok(t.split('\n').length === 1 && t.includes('AI') && t.includes('转接资深顾问'), t);
  passed++;
}

// ---- R15：strandedShape 新分支，strandedAfterDrop 的口径不动 ----
const route = (id: string, title: string, destination: string): Route => ({
  id,
  title,
  destination,
  days: 5,
  priceFrom: 12800,
  hotelLevel: '五星',
  bestSeason: '4-10月',
  highlights: [],
  tags: [],
  segments: [],
});
const routes = [route('r-a', '云南 丽江大理·洱海古城 6 日', '云南'), route('r-b', '巴厘岛 乌布雨林蜜月 6 日', '巴厘岛')];
const sources: PriceGuardSources = {
  loadRoutes: () => routes,
  loadHotels: () => [],
  getOrder: () => undefined,
  isConfigNotReadyError: () => false,
  mentionsPlace: (text, word) => text.includes(word),
  isOriginMention: () => false,
  offCatalogPlaces: () => [],
};
const { strandedShape } = createTravelPriceGuard(sources);
const before = '给您看看这两条：\n· 云南 丽江大理·洱海古城 6 日，每人 18,000 元，编的价\n· 巴厘岛 乌布雨林蜜月 6 日，每人 22,800 起';
eq(strandedShape(before, '· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起'), 'lead', '引导句被删，分点里还有线路名：补引导句');
eq(strandedShape(before, '· 亮点：蓝湖温泉\n· 亮点：极光猎人'), 'replace', '剩下「亮点」条目没有线路名：整条换');
eq(strandedShape('报价如下 38,000 元：\n· 蓝湖', '我们有一条替代线路：'), 'replace', '引导句以冒号结尾，后面没有东西');
eq(strandedShape('每人 38,000 元。我们有：\n· 蓝湖\n· 极光', '我们有：\n· 蓝湖\n· 极光'), 'replace', '引导句后面不是线路名');
eq(
  strandedShape('报价 38,000：\n每人 16,511 元\n总价 66,044 元', '报价：\n每人 16,511 元\n总价 66,044 元'),
  null,
  '冒号后面是价钱，不算悬空',
);
eq(
  strandedShape('说几点实在的：\n· 付款只走官方链接\n· 签电子合同', '说几点实在的：\n· 付款只走官方链接'),
  null,
  '删的不是线路也不是价（没有价没有线路名）：不算残句',
);
eq(strandedShape(before, '· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起\n点此看方案书 /proposal/r-b/2'), null, '后面跟着链接：豁免');
eq(
  strandedShape('· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起——预算还能升级', '· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起'),
  null,
  '原文本来就是分点开头：不动',
);
eq(strandedShape('同一段话', '同一段话'), null, '没删过句子：不动');

console.log(`QUOTE TEMPLATE SELFTEST PASS: ${passed} 项断言全通`);
