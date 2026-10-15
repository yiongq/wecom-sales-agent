// 06 第 11 步：R13 越权说法词表。每类正例、D 类审查原话、否定句与链接句反例、固定句穿过不变、换上去的话不再命中。
import assert from 'node:assert/strict';
import { dejargon, type Order, type PriceGuardSources, type Route } from '../../core/pack-api.js';
import { claimWordsTest, cheapestOverall, parseSpokenAmount, rewriteClaimWords, type ClaimWordsContext } from './claim-words.js';
import { paymentPendingReply, type ContactMode } from './contact-words.js';
import { dejargonVocab } from './dejargon-vocab.js';
import { createTravelPriceGuard } from './price-guard.js';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}

const route = (id: string, title: string, priceFrom: number): Route => ({
  id,
  title,
  destination: title.slice(0, 2),
  days: 5,
  priceFrom,
  hotelLevel: '五星',
  bestSeason: '4-10月',
  highlights: [],
  tags: [],
  segments: [],
});
const routes = [
  route('r-a', '云南 丽江大理 6 日', 16800),
  route('r-b', '贵州 荔波小七孔 5 日', 5800),
  route('r-c', '四川 九寨黄龙 6 日', 12800),
];
const sources: PriceGuardSources = {
  loadRoutes: () => routes,
  loadHotels: () => [],
  getOrder: () => undefined,
  isConfigNotReadyError: () => false,
  mentionsPlace: (text, word) => text.includes(word),
  isOriginMention: () => false,
  offCatalogPlaces: () => [],
};
const { dropSentences } = createTravelPriceGuard(sources);

const legacy: ContactMode = { channel: 'wecom', templateMode: false };
const order = (o: Partial<Order>): Order =>
  ({
    id: 'o1',
    sessionId: 's1',
    routeId: 'r-a',
    routeTitle: '云南 丽江大理 6 日',
    travelers: 2,
    departDate: '2027-03-10',
    totalPrice: 33600,
    status: 'pending_payment',
    createdAt: 0,
    ...o,
  }) as Order;
const base: ClaimWordsContext = { mode: legacy, orders: [], routes, yuan: (n) => '¥' + n.toLocaleString('zh-CN') };
const run = (text: string, ctx: Partial<ClaimWordsContext> = {}) => rewriteClaimWords(text, { ...base, ...ctx }, { dropSentences }).text;
const same = (text: string, ctx: Partial<ClaimWordsContext> = {}, label = text) => eq(run(text, ctx), text, `原样: ${label}`);
const lacks = (text: string, gone: RegExp | string, ctx: Partial<ClaimWordsContext> = {}) => {
  const out = run(text, ctx);
  assert.ok(typeof gone === 'string' ? !out.includes(gone) : !gone.test(out), `应删去 ${String(gone)}: ${text} -> ${out}`);
  passed++;
  return out;
};

const { POLICY_REPLY, VISA_REPLY, INVOICE_REPLY, HOTEL_REPLY, MEDIA_REPLY, OLD_ORDER_REPLY } = claimWordsTest();

// ---- D 类：审查原话（正向词表，不套否定守卫，「别担心」「放心」不放过）----
const sensitive =
  '西藏和新疆都是成熟的旅游目的地，现在正常接待游客，我们今年的客人一直都在发团出行。\n边防证这类手续我们行程里会协助办好，不用担心。\n· 西藏：拉林铁路线海拔从三千六缓降至三千，身体负担小\n· 新疆：伊犁独库公路线最高海拔只有三千五，几乎无高反压力\n放心，西藏和新疆都是成熟的旅游目的地，景区和主要线路一直正常开放，我们全年都有客人在走，旺季更是热门。\n如果是护照签证方面您多虑了——都是国内线，带上身份证就行，不用办任何特殊手续。';
const sensitiveOut = run(sensitive);
for (const phrase of [
  '正常接待',
  '一直都在发团',
  '协助办好',
  '身体负担小',
  '几乎无高反',
  '一直正常开放',
  '全年都有客人在走',
  '带上身份证就行',
  '不用办任何特殊手续',
]) {
  assert.ok(!sensitiveOut.includes(phrase), `D 类原话应被拿掉: ${phrase} -> ${sensitiveOut}`);
  passed++;
}
eq(sensitiveOut.split(POLICY_REPLY).length - 1, 1, 'D 类换上的话整条回复只出现一次');
assert.ok(sensitiveOut.includes('成熟的旅游目的地'), '同一句里没越权的小句留着');
passed++;
for (const [t, gone] of [
  ['别担心，正常接待游客', '正常接待'],
  ['不用担心，西藏景区一直正常开放。', '一直正常开放'],
  ['手续方面不用办特殊手续，您放心。', '不用办特殊手续'],
  ['这条线路一直在发团。', '一直在发团'],
  ['九寨这条身体负担小不少。', '身体负担小'],
] as [string, string][]) {
  const out = run(t);
  assert.ok(!out.includes(gone), `${t} -> ${out}`);
  assert.ok(out.includes(POLICY_REPLY) || out.trim() === '', out);
  passed++;
}
// D 类反例：否定句、问句、条件句、别处已往顾问那儿引
same('没有儿童价，小朋友和大人同价。');
same('不是所有线路都要通行证，具体看目的地。');
same('不是正常开放的景区需要提前预约吗？');
same('您问的是不是一直正常开放？这个我帮您确认。');
same('如果身体负担小一点的线路更合适，我帮您挑。');
eq(run('西藏的手续不用办特殊手续，具体由顾问按出行时间跟您确认。'), '具体由顾问按出行时间跟您确认。', 'D 类别处已往顾问引，只删不换');
// 签证时长与费用
for (const t of ['日本签证一般 7 个工作日。', '签证大概两周就能下来。', '签证费大概 800 元一位。']) {
  const out = run(t);
  assert.ok(out.includes(VISA_REPLY) && !/工作日|两周|800/.test(out), `${t} -> ${out}`);
  passed++;
}
same('国内线不用签证，带好身份证就行。'.replace('带好身份证就行', '身份证要在有效期内'), {}, '不用签证');
same('这次是免签 15 天，具体入境要求看当地规定。');
// 普通发票
eq(
  run('发票可以开的，专票普票这些具体开具方式由顾问跟您确认，会照您的要求来。'),
  '专票普票这些具体开具方式由顾问跟您确认，会照您的要求来。',
  '发票（别处已引顾问）只删小句',
);
eq(run('可以给您开普通发票。'), INVOICE_REPLY, '发票换现有句');
same('发票（含专票）怎么开，由顾问跟您确认。');
same('不能开发票吗？这个我帮您问顾问。');
// 单订酒店
eq(run('可以单订，我们合作了三家松赞：'), `${HOTEL_REPLY}我们合作了三家松赞：`, '单订换句');
same('不可以单订，只能随线路订。');
same('您是想单独订酒店，还是想看看线路？');
// 照片、视频
for (const t of [
  '两家酒店的房型细节和实拍，出方案书时都会附在里面。',
  '不过酒店的实拍和房型照片，都在方案书里能看全。',
  '方案书里有酒店实拍。',
]) {
  const out = run(t);
  assert.ok(out.includes(MEDIA_REPLY), `${t} -> ${out}`);
  assert.ok(!/出方案书时|都在方案书|方案书里有/.test(out), out);
  passed++;
}
same('想看实拍图的话，留个说法，我请顾问在微信上把酒店照片发您，顺便您计划几号出发？');
same('照片我请顾问发您，方案书里有逐日行程。');
// 付款确认：没有已付款订单时拦，换到账口径
for (const t of ['付款已完成，订单生效。', '款项已确认，接下来的安排：', '已到账啦，谢谢。']) {
  const out = run(t);
  assert.ok(out.includes(paymentPendingReply(legacy)), `${t} -> ${out}`);
  assert.ok(!/付款已完成|款项已确认|已到账啦|订单生效/.test(out), out);
  passed++;
}
eq(run('付款已完成，订单生效。'), paymentPendingReply(legacy), '两处同一口径只出现一次');
eq(
  run('款项已确认。', { mode: { channel: 'web', templateMode: false } }),
  paymentPendingReply({ channel: 'web', templateMode: false }),
  '网页渠道的到账口径',
);
eq(
  run('款项已确认。', { mode: { channel: 'wecom', templateMode: true } }),
  paymentPendingReply({ channel: 'wecom', templateMode: true }),
  '模板模式',
);
same('付款已完成，订单生效。', { orders: [order({ status: 'paid', paidAt: 1 })] }, '有已付款订单不拦');
same('款项到账后您会收到确认，顾问核实后会联系您。');
same('等您付款完成后，我请顾问核实。');
same('款项还没到账，顾问核实后会在微信上联系您。');
// 「订单已确认」：带 confirmedAt 的订单是真话
const confirmed = [order({ confirmedAt: 5 })];
lacks('您的订单已确认。', '订单已确认');
same('您的订单已确认。', { orders: confirmed }, '顾问确认过的订单');
same('您的订单已确认。', { orders: [order({ status: 'paid', paidAt: 1 })] }, '已付款订单');
// 旧单失效：会话里有别的线路的待付款单时
const other = [order({ routeId: 'r-a' }), order({ id: 'o2', routeId: 'r-c', routeTitle: '四川 九寨黄龙 6 日' })];
for (const t of [
  '云南那张单还没付款，您不用管它，直接失效就行，不影响这张新的。',
  '之前云南那张单您还没付款，不用管它，链接不付款就无效。',
]) {
  const out = run(t, { orders: other, focusRouteId: 'r-c' });
  assert.ok(out.includes(OLD_ORDER_REPLY) && !/直接失效|不用管|就无效/.test(out), `${t} -> ${out}`);
  passed++;
}
same('云南那张单您不用管它，直接失效就行。', { orders: [order({})], focusRouteId: 'r-a' }, '只有同一条线的单');
same('云南那张单您不用管它，直接失效就行。', {}, '没有待付款单');
same('之前那张单已作废、旧链接失效，按这张新的付款。', { orders: other, focusRouteId: 'r-c' });
// 低于全库最低价
eq(cheapestOverall(routes)?.id, 'r-b', '全库最低起价');
eq(cheapestOverall([]), undefined, '空库');
eq(parseSpokenAmount('5000'), 5000, '金额 5000');
eq(parseSpokenAmount('3万'), 30000, '金额 3万');
eq(parseSpokenAmount('两万五'), 25000, '金额 两万五');
eq(parseSpokenAmount('1.5万'), 15000, '金额 1.5万');
{
  const out = run('我帮您找找 5000 以内能玩得好的线路？');
  assert.ok(out.includes('我们这边最实惠的一条是《贵州 荔波小七孔 5 日》，人均 ¥5,800 起。'), out);
  assert.ok(!out.includes('5000'), out);
  passed++;
}
lacks('可以的，帮您找找四千以内的'.replace('四千', '4000'), '4000');
same('我帮您找找 6000 以内的线路。', {}, '够得着最低价');
same('我帮您找找 1 万以内的线路。');
same('5000 元以内我们这边暂时没有现成的西藏线路，也不能压缩天数或降酒店档。');
// 锁名额类催单：删小句
eq(run('定了我帮您锁档期。'), '', '锁档期整句只有这一小句');
eq(run('想好了随时联系我，春节档期越早定越好安排。'), '想好了随时联系我。', '越早定越好');
eq(run('· 门票都是实名预约的，国庆期间兵马俑、陕历博一票难求，这块也含在里头'), '· 门票都是实名预约的，这块也含在里头', '一票难求');
same('三年后的行程确实没法现在锁名额或收定金。');
same('国庆是四川最旺的时段，建议您尽早确定日期。');
// 编价格理由：删小句
eq(
  run('10 月 2 号又赶上国庆，正处最佳出行季，价格按上浮后的算，节后出行会低一些。'),
  '10 月 2 号又赶上国庆，正处最佳出行季，价格按上浮后的算。',
  '节后会低一些',
);
lacks('比夏天上浮不少，已含旺季因素。', /上浮不少|已含旺季/);
// 转人工说法：当面 -> 渠道说法，不重复
eq(claimWordsTest().swapFaceToFace('顾问会联系您，当面跟您聊清楚。', legacy), '顾问会联系您，在微信上跟您聊清楚。', '当面换成在微信上');
eq(claimWordsTest().swapFaceToFace('顾问会在微信上当面跟您聊。', legacy), '顾问会在微信上跟您聊。', '前面已是微信上就不重复');
eq(claimWordsTest().swapFaceToFace('当面跟您聊，顾问在微信上跟您确认。', legacy), '跟您聊，顾问在微信上跟您确认。', '句子里已有渠道说法');
eq(claimWordsTest().swapFaceToFace('当面聊清楚。', { channel: 'web', templateMode: false }), '在这个页面里聊清楚。', '网页');
eq(claimWordsTest().swapFaceToFace('当面聊清楚。', { channel: 'wecom', templateMode: true }), '聊清楚。', '模板模式不点名渠道');
eq(
  run('好的，马上为您转接资深顾问，顾问会联系您，把云南的线路细节当面跟您聊清楚。'),
  '好的，马上为您转接资深顾问，顾问会联系您，把云南的线路细节在微信上跟您聊清楚。',
  '整句经 rewrite',
);
eq(run('在微信上当面聊'), '在微信上聊', '已有渠道说法只删当面');
same('我们不能当面跟您确认，抱歉。');

// ---- 带链接的句子整句不动 ----
for (const t of [
  '好的，已为您锁定名额，点此完成支付：/pay/o-abc123',
  '付款已完成，订单链接：/pay/o-abc123',
  '方案书里有酒店实拍，点开看：/proposal/r-a/2',
  '可以单订，链接在这 /proposal/r-a/1?v=2',
]) {
  same(t, { orders: [] });
}
// 冒号收尾、后面的信息块里带支付链接的引出句也不动
same('好的，订单已确认好啦：\n云南 6 日，2 位出行\n订单总价：¥33,600\n支付链接：/pay/o-abc123\n\n付款后顾问会联系您。');
lacks('好的，订单已确认好啦：\n云南 6 日，2 位出行\n\n支付链接：/pay/o-abc123', '订单已确认');
// 前一小句是没有下文就悬着的从句：连它一起删
eq(run('如果您感兴趣，可以单独订房，也可以包进线路里一起安排。'), `${HOTEL_REPLY}也可以包进线路里一起安排。`, '悬着的条件从句一起删');
eq(run('两位既然是头回上高原，九寨这条身体负担小不少。'), POLICY_REPLY, '悬着的「既然」从句一起删，整句换');
// 模型自己已经说了「发不了」：不再补一句
eq(run('照片我这边发不了。\n方案书里有酒店实拍。'), '照片我这边发不了。', '媒体句别处已说过只删');
// 紧挨着链接行、或自己在引出支付的句子不动；带金额的小句归价格护栏
same('好的，已为您锁定名额，点此完成支付～\n/pay/o-abc123\n名额以付款为准。');
same('好的，已为您锁定名额，点此完成支付～');
same('好的，就按 19999元 给您锁定名额，我这就帮您下单');
same('好的，就按每人一万八千三给您锁定名额');
same('好的，就按 6,800 元给您锁定名额');
same('国庆是四川最旺的时段，价格以付款链接 /pay/o-1 为准，节后会低一些。');

// ---- 固定句穿过词表不变 ----
for (const t of [
  '发票（含专票）怎么开，由顾问跟您确认。',
  '付款只走我们发给您的官方支付链接。',
  '付款以订单链接和顾问发给您的收款方式为准。',
  '具体档期和余位由顾问跟您确认。',
  '机票代订的事由顾问跟您确认。',
  '顾问会在微信上联系您。',
  '款项到账后您会收到确认，顾问核实后会在微信上联系您。',
  '这块政策会变，由顾问按您的出行时间跟您确认。',
  '签证怎么办、要多久，由顾问跟您确认。',
  '酒店我可以推荐，要订请顾问确认房态。',
  '照片和视频我这边发不了，请顾问发给您。',
  '之前那张单请先别付款，我请顾问帮您处理。',
  '没付款不算锁定名额，名额以付款为准。',
  '这个我记下了，会请顾问在微信上跟您确认。',
  '起价是按最佳季算的，具体以报价为准。',
  '国内线不用签证、不倒时差，带好身份证就行'.replace('，带好身份证就行', '，出行前看下天气'),
]) {
  same(t, { orders: other, focusRouteId: 'r-c' });
}

// ---- 换上去的话不再命中任何规则，也不含品牌名与 markdown ----
const replies = [
  POLICY_REPLY,
  VISA_REPLY,
  INVOICE_REPLY,
  HOTEL_REPLY,
  MEDIA_REPLY,
  OLD_ORDER_REPLY,
  paymentPendingReply(legacy),
  paymentPendingReply({ channel: 'web', templateMode: false }),
  paymentPendingReply({ channel: 'wecom', templateMode: true }),
  '我们这边最实惠的一条是《贵州 荔波小七孔 5 日》，人均 ¥5,800 起。',
];
for (const r of replies) {
  const out = run(r, { orders: other, focusRouteId: 'r-c' });
  eq(out, r, `换上去的话不再命中: ${r}`);
  assert.ok(!r.includes('云途') && !/[*#`]/.test(r), r);
}
for (const rule of claimWordsTest().rules) assert.ok(rule.re instanceof RegExp && rule.id);
passed++;

// ---- 内部用语并进 dejargon 词表：整句特征才收，裸「系统」「工具」不收 ----
const dj = (t: string) => dejargon(t, 'wm-claim-words', dejargonVocab);
eq(dj('这条线的价格是系统按行程定的，我个人没法直接减两千。'), '这条线的价格是按行程定的，我个人没法直接减两千。', '系统按行程定的');
eq(dj('· 报价是 17,380/人，这是工具实报出来的数'), '· 报价是 17,380/人，这是实报出来的数', '工具实报的');
for (const t of ['系统繁忙，请稍后再试。', '这本工具书很有用。', '我们的系统会自动记录。', '用工具查一下。', '价格是按行程定的。']) {
  eq(dj(t), t, `不误伤: ${t}`);
}

console.log(`CLAIM WORDS SELFTEST PASS: ${passed} 项断言全通`);
