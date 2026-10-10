// 04 第 9 步：包阈值实际影响金额出处裁决，注入能力仍按本轮现读。
import assert from 'node:assert/strict';
import { parseDayCount, type Order, type PaymentMode, type PriceGuardSources, type Route, type Session } from '../../core/pack-api.js';
import { createTravelPriceGuard } from './price-guard.js';
import { createTravelPriceRules } from './price-rules.js';
import { travelPriceThresholds } from './thresholds.js';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}

function session(): Session {
  return {
    id: 'simulator:price-pack',
    channel: 'wecom',
    stage: 'greeting',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: 0,
    updatedAt: 0,
  };
}
const route: Route = {
  id: 'r-test',
  title: '测试线路',
  destination: '测试地',
  days: 5,
  priceFrom: 12800,
  hotelLevel: '五星',
  bestSeason: '4-10月',
  highlights: [],
  tags: [],
  segments: [],
  maxAltitude: 2499,
};
let routes: Route[] = [];
let order: Order | undefined;
let mode: PaymentMode = 'online';
const notReady = new Error('配置源未就绪夹具');
let loadError: Error | undefined;
const sources: PriceGuardSources = {
  loadRoutes: () => {
    if (loadError) throw loadError;
    return routes;
  },
  loadHotels: () => [],
  getOrder: (id) => (order?.id === id ? order : undefined),
  isConfigNotReadyError: (error) => error === notReady,
  mentionsPlace: (text, word) => text.includes(word),
  isOriginMention: () => false,
  offCatalogPlaces: () => [],
};
const ruleSources = { ...sources, paymentMode: () => mode };
const guard = createTravelPriceGuard(sources);
const rules = createTravelPriceRules(ruleSources, guard);
const originalEnv = process.env.PRICE_GUARD;
try {
  delete process.env.PRICE_GUARD;
  const s = session();
  const low = { ...travelPriceThresholds, minimumAmount: 500 };
  const lowGuard = createTravelPriceGuard(sources, low);
  const lowRules = createTravelPriceRules(ruleSources, lowGuard, low);
  eq(lowGuard.findUnbackedPrices('每人 800 元', s, ''), [800], '验收 11：下限 500 时 800 无出处被拦');
  eq(lowGuard.findUnbackedPriceHits('每人 800 元', s, ''), [{ value: 800, at: 3, end: 8 }], '下限覆盖仍返回原文偏移');
  eq(lowGuard.findUnbackedPrices('每人 800 元', s, '预算800元'), [], '800 的客户出处照常放行');
  eq(lowGuard.findUnbackedPrices('就按每人800元给您锁定', s, '预算800元'), [800], '成交价不能采用客户给的 800');
  s.messages.push({ role: 'customer', content: '每人预算800元', at: 0 });
  eq(lowRules.budgetCap(s)?.amount, 800, '下限覆盖也用于预算读取');
  eq(rules.budgetCap(s), undefined, '下限 1000 忽略 800 预算');
  eq(lowRules.liftsBudget('预算不是问题 每人800元以内'), false, '新金额覆盖放开预算的说法');
  eq(rules.liftsBudget('预算不是问题 每人800元以内'), true, '默认下限仍忽略小额');
  eq(
    Object.keys(guard.__priceGuardTest).sort(),
    [
      'parseAmounts',
      'parseWanAmounts',
      'parseCnAmounts',
      'parseRangeEndpoints',
      'CLOSING_PRICE',
      'hasClosingPrice',
      'routeNames',
      'namedRoutes',
    ].sort(),
    '价格测试出口键集合照旧',
  );
  eq(
    Object.keys(rules.__priceRulesTest).sort(),
    [
      'whensIn',
      'NO_SUCH_RULE',
      'SCARCITY',
      'DATE_COMPARE',
      'BUDGET_CLAIM',
      'OFF_PEAK_WORD',
      'PEAK_WORD',
      'CANT_CHANGE',
      'ALTITUDE_ASSURANCE',
    ].sort(),
    '规则测试出口键集合照旧',
  );
  const restored = createTravelPriceGuard(sources);
  eq(restored.findUnbackedPrices('每人 800 元', session(), ''), [], '验收 11：恢复 1000 后不管 800');
  eq(travelPriceThresholds.minimumAmount, 1000, '临时覆盖未污染默认政策');
  eq(guard.__priceGuardTest.parseWanAmounts('每人三万八')[0].tol, 500, '默认精度容差 0.5');
  const exact = createTravelPriceGuard(sources, { ...travelPriceThresholds, precisionTolerance: 0 });
  eq(exact.__priceGuardTest.parseWanAmounts('每人三万八')[0].tol, 0, '容差通过包政策注入');

  // 新核心解析有更宽的读法；窄价格人数解析保留旧结果，不能直接替换。
  for (const [raw, old, core] of [
    ['0', 0, null],
    ['一十', undefined, 10],
    ['二十两', undefined, 22],
    ['两十', undefined, 20],
  ] as const) {
    eq(guard.__priceGuardTest.parseWanAmounts(`${raw}位总共7.6万`)[0].travelers, old, `守卫保留人数口径：${raw}`);
    eq(parseDayCount(raw), core, `core 人数口径：${raw}`);
  }
  for (const [raw, count] of [
    ['两', 2],
    ['二十五', 25],
    ['五十', 50],
  ] as const) {
    eq(guard.__priceGuardTest.parseWanAmounts(`${raw}位总共7.6万`)[0].travelers, count, `原有确定人数：${raw}`);
  }

  // 装载之后才换产品/订单，护栏须在调用时看到它们；本轮工具记录仍能给线路出处。
  routes = [route];
  const seen = session();
  const calls = [{ name: 'get_route_detail', args: { routeId: route.id } }];
  eq(guard.findUnbackedPrices('每人12800元', seen, ''), [12800], '库内价尚未出现仍拦');
  eq(guard.findUnbackedPrices('每人12800元', seen, '', calls), [], '本轮工具给出线路出处');
  seen.seenRouteIds = [route.id];
  eq(guard.findUnbackedPrices('三位总价4.224万', seen, ''), [], '三人旺季价 1.1 不打团体折扣');
  eq(guard.findUnbackedPrices('四位总价5.3504万', seen, ''), [], '四人旺季价先上浮后按 0.95 取整');
  eq(guard.findUnbackedPrices('五十位总价66.88万', seen, ''), [], '白名单枚举仍到五十人');
  const lateGroup = createTravelPriceGuard(sources, { ...travelPriceThresholds, groupMinimum: 6 });
  eq(lateGroup.findUnbackedPrices('四位总价5.3504万', seen, ''), [53504], '团价人数门槛实际取包政策');
  const smallGroups = createTravelPriceGuard(sources, { ...travelPriceThresholds, maxTravelers: 20 });
  eq(smallGroups.findUnbackedPrices('五十位总价66.88万', seen, ''), [668800], '白名单人数上界实际取包政策');
  order = {
    id: 'o-test',
    sessionId: seen.id,
    routeId: route.id,
    routeTitle: route.title,
    travelers: 2,
    departDate: '2027-05-01',
    totalPrice: 34578,
    status: 'pending_payment',
    createdAt: 0,
  };
  const ordered = session();
  ordered.orderIds = [order.id];
  eq(guard.findUnbackedPrices('总价34578元', ordered, ''), [], '注入订单提供真实总价出处');
  eq(guard.findUnbackedPrices('每人17289元', ordered, ''), [], '订单总价折回人均');
  const quoted = session();
  quoted.lastQuote = { routeId: route.id, routeTitle: route.title, travelers: 2, perPerson: 12800, total: 25600 };
  eq(rules.dropUnbackedClaims('全程不用担心高反。', quoted).text, '全程不用担心高反。', '2500 米以下担保有出处');
  routes = [{ ...route, maxAltitude: 2500 }];
  eq(rules.dropUnbackedClaims('全程不用担心高反。', quoted).text, '', '2500 米边界不属于低海拔');
  eq(rules.dropUnbackedClaims('您的款项全程第三方监管。', quoted).text, '付款只走我们发给您的官方支付链接。', 'online 服务规则保持原文');
  mode = 'advisor';
  eq(rules.dropUnbackedClaims('您的款项全程第三方监管。', quoted).text, '付款以订单链接和顾问发给您的收款方式为准。', '付款模式调用时现读');
  eq(rules.dropUnbackedClaims('电话联系您。', { ...quoted, channel: 'web' }).text, '在这个页面里回复您。', '网页联系承诺保持原文');
  eq(rules.dropUnbackedClaims('电话联系您。', quoted).text, '在微信上联系您。', '企微联系承诺保持原文');

  loadError = notReady;
  assert.throws(
    () => guard.findUnbackedPrices('每人12800元', quoted, ''),
    (e) => e === notReady,
  );
  passed++;
  assert.throws(
    () => rules.dropUnbackedClaims('您好。', quoted),
    (e) => e === notReady,
  );
  passed++;
  loadError = new Error('产品文件解析失败夹具');
  eq(guard.findUnbackedPrices('每人12800元', session(), ''), [12800], '产品解析失败降级为空表');
  eq(rules.dropUnbackedClaims('您好。', session()).text, '您好。', '规则仍吞产品解析失败');
  process.env.PRICE_GUARD = '0';
  eq(guard.findUnbackedPrices('每人80000元', s, ''), [], '已有 PRICE_GUARD env 仍生效');
  eq(rules.dropUnbackedClaims('名额紧张。', s), { text: '名额紧张。', dropped: [] }, '关闭价格规则守卫仍照旧');
} finally {
  if (originalEnv === undefined) delete process.env.PRICE_GUARD;
  else process.env.PRICE_GUARD = originalEnv;
}
console.log(`travel price selftest: ${passed} passed`);
