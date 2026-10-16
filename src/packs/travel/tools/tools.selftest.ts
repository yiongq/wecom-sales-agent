import { toolDefs } from '../tool-defs.js';
// 工具声明与依赖注入契约；现有锁定套件继续覆盖七工具的客户行为与金额校验。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type Order, type Route, type Session, type ToolContext, type TravelToolSources } from '../../../core/pack-api.js';
import { createTravelTools } from './index.js';

const route: Route = {
  id: 'fixture',
  title: '测试线路',
  destination: '测试地',
  days: 5,
  priceFrom: 10001,
  hotelLevel: '五星',
  bestSeason: '10月',
  highlights: [],
  tags: [],
  segments: [],
  itinerary: [{ day: 1, title: '测试行程', detail: '测试行程安排', meals: '自理', hotel: '测试酒店' }],
};
const orders = new Map<string, Order>();
let saved = 0;
const sources: TravelToolSources = {
  configMode: () => 'db',
  currentCatalog: () => ({ tenantId: 'fixture', generation: 1, routes: [route], hotels: [], versions: { 'route:fixture': 2 } }),
  catalogVersionKey: (kind, code) => `${kind}:${code}`,
  catalogItemAt: () => route,
  indexReady: () => false,
  semanticRecall: async () => null,
  budgetVerdict: () => undefined,
  createOrder: (input) => {
    const order: Order = { ...input, id: `order-${orders.size}`, createdAt: 0, status: 'pending_payment' };
    orders.set(order.id, order);
    return order;
  },
  getOrder: (id) => orders.get(id),
  queueJobs: () => {},
  saveSession: () => {
    saved++;
  },
  supersedeOrder: (id, byId) => {
    const order = orders.get(id);
    if (!order || order.status !== 'pending_payment') return false;
    order.status = 'superseded';
    order.supersededBy = byId;
    return true;
  },
  todayIso: () => '2026-10-10',
  paymentMode: () => 'online',
  orderUnconfirmedNotifyOps: () => [],
  enterHandoff: (session, record) => {
    session.handedOver = true;
    session.handoff = record;
  },
  modelHandoffReason: 'AI 判断要请顾问处理',
};
const runtime = createTravelTools(sources);
const byName = new Map(runtime.tools.map((tool) => [tool.def.function.name, tool]));
const session: Session = {
  id: 'simulator:tools-pack',
  channel: 'web',
  stage: 'greeting',
  profile: {},
  messages: [],
  orderIds: [],
  handedOver: false,
  createdAt: 0,
  updatedAt: 0,
};
const ctx: ToolContext = { session, hints: {} };
const run = async (name: string, args: unknown) => JSON.parse(await byName.get(name)!.execute(args, ctx));
assert.equal(JSON.stringify(runtime.tools.map((tool) => tool.def)), JSON.stringify(toolDefs));
assert.equal(
  createHash('sha256').update(JSON.stringify(toolDefs)).digest('hex'),
  '64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1',
);
assert.deepEqual(
  runtime.tools.filter((t) => t.cacheable).map((t) => t.def.function.name),
  ['search_routes', 'get_route_detail'],
);
assert.deepEqual(
  runtime.tools.filter((t) => t.blocksRetry).map((t) => t.def.function.name),
  ['create_order', 'handoff_to_human'],
);
assert.deepEqual(
  runtime.tools.filter((t) => t.onReuse).map((t) => t.def.function.name),
  ['search_routes'],
);
assert.deepEqual(
  runtime.tools.filter((t) => t.sideEffects.length === 0).map((t) => t.def.function.name),
  ['search_hotels'],
);

const reuse = byName.get('search_routes')!.onReuse!;
reuse('[{"id":"first","title":"先查","priceFrom":1000}]', ctx);
reuse('[{"id":"second","title":"后查","priceFrom":2000}]', ctx);
reuse('[{"id":"first","title":"先查","priceFrom":1000}]', ctx);
assert.deepEqual(
  session.lastShownRoutes?.map((r) => r.id),
  ['first', 'second'],
);
assert.deepEqual(session.seenRouteIds, ['first', 'second']);
assert.equal(saved, 0, '复用只重放展示状态，不重新执行或落库');
reuse('not-json', ctx);
reuse('{"error":"搜索失败"}', ctx);
assert.deepEqual(
  session.lastShownRoutes?.map((r) => r.id),
  ['first', 'second'],
);

assert.equal((await run('get_route_detail', { routeId: route.id })).id, route.id);
assert.deepEqual(await run('search_hotels', {}), []);
const quote = await run('create_quote', { routeId: route.id, travelers: '4', departDate: '2026-10-20' });
assert.equal(quote.perPerson, 10451, '旺季先取整，再团体折扣取整');
assert.equal(quote.total, 41804);
const proposal = await run('generate_proposal', { routeId: route.id, travelers: 4, departDate: '2026-10-20' });
assert.equal(proposal.proposalUrl, '/proposal/fixture/4/2026-10-20?v=2');
const order = await run('create_order', { routeId: route.id, travelers: 4, departDate: '2026-10-20' });
assert.equal(order.total, quote.total);
assert.equal(orders.get(order.orderId)?.catalogVersion, 2);
assert.equal(session.lastQuote, undefined);
assert.equal((await run('create_order', { routeId: route.id, travelers: 4, departDate: '2026-10-20' })).reused, true);
assert.equal(orders.size, 1);
const before = saved;
assert.equal(typeof (await run('create_quote', { routeId: route.id, travelers: 51 })).error, 'string');
assert.equal(typeof (await run('generate_proposal', { routeId: route.id, travelers: 2, departDate: '2026-02-30' })).error, 'string');
assert.equal(typeof (await run('create_order', { routeId: route.id, travelers: 2, departDate: '2026-10-09' })).error, 'string');
assert.equal(saved, before, '非法参数不落库');
// 06 R20：出发日期超过 12 个月（按日历月数，今天 2026-10-10，2027-10-31 还在范围内）不出确定价，也不下单
{
  const edge = await run('create_quote', { routeId: route.id, travelers: 2, departDate: '2027-10-31' });
  assert.equal(edge.farFuture, undefined, '12 个月整的最后一天照常报价');
  assert.equal(edge.perPerson, 11001);
  const edgeQuote = JSON.stringify(session.lastQuote);
  const far = await run('create_quote', { routeId: route.id, travelers: 2, departDate: '2027-11-01' });
  assert.equal(far.farFuture, true);
  assert.equal(far.perPerson, undefined, 'farFuture 不带确定价');
  assert.equal(far.total, undefined);
  assert.equal(far.priceFrom, route.priceFrom, '参考价只给线路起价');
  assert.ok(/12 个月/.test(far.note) && /不出确定价/.test(far.note) && /不要调 create_order/.test(far.note), far.note);
  assert.equal(JSON.stringify(session.lastQuote), edgeQuote, 'farFuture 不改最近报价（成单安全网据它建单）');
  assert.ok(session.seenRouteIds?.includes(route.id), '参考价的线路记为本会话出现过（价格护栏认它的起价）');
  const ordersBefore = orders.size;
  const refused = await run('create_order', { routeId: route.id, travelers: 2, departDate: '2027-11-01' });
  assert.ok(typeof refused.error === 'string' && /不下单/.test(refused.error), JSON.stringify(refused));
  assert.equal(orders.size, ordersBefore, '太远的出发日期不建单');
  assert.equal(typeof (await run('create_order', { routeId: route.id, travelers: 2, departDate: '2027-10-31' })).orderId, 'string');
}
// 06 R20：search_routes 的 overBudget 结果附 cheapestOverall（全库最低起价那一条）；够得着预算的不带
{
  const over = await run('search_routes', { destination: '测试地', maxBudgetPerPerson: 5000 });
  assert.equal(over.length, 1);
  assert.ok(typeof over[0].overBudget === 'string');
  assert.deepEqual(over[0].cheapestOverall, { id: route.id, title: route.title, priceFrom: route.priceFrom });
  const fine = await run('search_routes', { destination: '测试地', maxBudgetPerPerson: 20000 });
  assert.equal(fine[0].overBudget, undefined);
  assert.equal(fine[0].cheapestOverall, undefined);
  const replay = { ...session, seenRouteIds: [] as string[] };
  byName.get('search_routes')!.onReuse!(JSON.stringify(over), { ...ctx, session: replay });
  assert.deepEqual(replay.seenRouteIds, [route.id], '复用时也把 cheapestOverall 的线路记为出现过');
}
ctx.hints.handoff = { quote: '请顾问处理', departNote: '明年出行' };
assert.equal((await run('handoff_to_human', { reason: '请顾问处理' })).ok, true);
assert.equal(session.handoff?.quote, '请顾问处理');
assert.equal(session.handoff?.departNote, '明年出行');
console.log('travel tools selftest: 声明、复用、定价取整、版本、订单幂等与校验通过');
