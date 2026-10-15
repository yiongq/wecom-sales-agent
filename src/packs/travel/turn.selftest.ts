// 包钩子的输入/输出契约：context 不提前沉淀画像、预取保留实际参数与部分成功结果。
import assert from 'node:assert/strict';
import { spokenMoney, type PrefetchedCall, type Route, type Session, type TurnContext, type TurnToolContext } from '../../core/pack-api.js';
import { createTravelTurnHooks } from './turn.js';
import { travelPriceThresholds } from './thresholds.js';

const routes: Route[] = ['云南', '四川'].map((destination, i) => ({
  id: `fixture-${i}`,
  title: `${destination}测试线路`,
  destination,
  days: 5,
  priceFrom: 10000,
  hotelLevel: '五星',
  bestSeason: '10月',
  highlights: [],
  tags: [],
  segments: [],
  itinerary: [],
}));
const hooks = createTravelTurnHooks({
  loadRoutes: () => routes,
  getOrder: () => undefined,
  searchRoutes: async () => routes,
  rememberShownRoutes: () => {},
  mentionsPlace: (text, word) => text.includes(word),
  isOriginMention: () => false,
  offCatalogPlaces: () => [],
  visitedDestinations: () => [],
  paymentMode: () => 'online',
  spokenMoney: (text) => spokenMoney(text, travelPriceThresholds),
  liftsBudget: () => false,
});
const session: Session = {
  id: 'simulator:turn-pack',
  channel: 'web',
  stage: 'discovery',
  profile: { nickname: '测试昵称', avatar: 'https://avatar.invalid/fixture' },
  messages: [],
  orderIds: [],
  handedOver: false,
  createdAt: 0,
  updatedAt: 0,
};
const text = '带爸妈去云南和四川哪个好，每人预算两万';
session.messages.push({ role: 'customer', content: text, at: 0 });
const before = structuredClone(session);
const executed: PrefetchedCall[] = [];
const ctx: TurnContext = {
  session,
  text,
  async callTool(name, args) {
    const call = { name, args: { ...args, query: '实际执行参数' }, result: '[{"id":"fixture-0"}]' };
    executed.push(call);
    return call;
  },
};
assert.deepEqual(hooks.contextNote(ctx), ['', '']);
assert.equal(hooks.preModel!(ctx), null);
assert.deepEqual(session, before, 'context 与模型前判断不提前推进阶段、抽取画像');
const prefetched = await hooks.prefetch!(ctx);
assert.deepEqual(
  executed.map((call) => [call.name, call.args.destination]),
  [
    ['search_routes', '云南'],
    ['search_routes', '四川'],
  ],
);
assert.equal(executed[0].args.segment, '银发');
assert.equal(executed[0].args.maxBudgetPerPerson, 20000);
assert.deepEqual(prefetched!.calls, executed, '还原模型输入时使用执行入口返回的参数与完整结果');
assert.equal(prefetched!.timings.length, 2);
assert.deepEqual(session, before, '预取钩子不在工具之外写画像与阶段');

let attempts = 0;
let errors = 0;
const oldError = console.error;
console.error = () => {
  errors++;
};
try {
  const partial = await hooks.prefetch!({
    ...ctx,
    async callTool() {
      if (++attempts === 2) throw new Error('预取夹具失败');
      return executed[0];
    },
  });
  assert.deepEqual(partial!.calls, [executed[0]], '后续预取失败保留此前成功的工具消息');
  assert.equal(partial!.timings.length, 1);
  assert.equal(errors, 1);
} finally {
  console.error = oldError;
}

const toolCtx: TurnToolContext = { session, text, hints: {}, args: {}, notes: {}, handoffDeclined: false };
const grounded = hooks.beforeTool!('search_routes', { destination: '云南', segment: '蜜月', maxBudgetPerPerson: 50000 }, toolCtx);
assert.ok('args' in grounded);
assert.deepEqual(grounded.args, { destination: '云南', segment: '银发', maxBudgetPerPerson: 20000 });
assert.equal(toolCtx.args, grounded.args, 'afterTool 消费核正后的参数，不依赖记录器改写 context');
assert.match(toolCtx.notes.segmentNote, /客户没说过是蜜月/);
assert.equal(hooks.hintsFor('search_routes', toolCtx).elder, true);
assert.deepEqual(JSON.parse(hooks.withNotes('[{"id":"fixture-0"}]', toolCtx.notes)), [{ id: 'fixture-0', ...toolCtx.notes }]);
hooks.afterTool!('search_routes', '[{"destinationMiss":"没有现成线路"}]', toolCtx);
assert.deepEqual(
  session.missedDestinations?.map((miss) => miss.place),
  ['云南'],
);
assert.equal(session.stage, 'discovery');
assert.deepEqual(session.profile, before.profile, 'afterTool 仅补库外记录，画像仍由 stage_advance 消费本轮调用');
const error = '{"error":"工具失败"}';
assert.equal(hooks.withNotes(error, toolCtx.notes), error, '工具错误不附成功提醒');

const pastCtx: TurnToolContext = { ...toolCtx, text: '2020年10月3号出发', notes: {} };
const rejected = hooks.beforeTool!('create_order', { departDate: '2099-10-03', travelers: 2 }, pastCtx);
assert.ok('reject' in rejected);
assert.match(rejected.reject, /这是过去的日期/);
// 成单安全网的下单意图与选线（审查 F01：否定句、只要报价、并列报价未选线都被兜底建了单）
{
  const mk = (id: string, title: string, destination: string, days: number, aliases: string[]): Route => ({
    ...routes[0],
    id,
    title,
    destination,
    days,
    aliases,
  });
  const lijiang = mk('net-lijiang', '丽江大理·洱海古城 6 日', '云南', 6, ['丽江']);
  const xgll = mk('net-xgll', '香格里拉·梅里雪山松赞环线 8 日', '云南', 8, ['香格里拉']);
  const netHooks = createTravelTurnHooks({
    loadRoutes: () => [lijiang, xgll],
    getOrder: () => undefined,
    searchRoutes: async () => [],
    rememberShownRoutes: () => {},
    mentionsPlace: (t, w) => t.includes(w),
    isOriginMention: () => false,
    offCatalogPlaces: () => [],
    visitedDestinations: () => [],
    paymentMode: () => 'online',
    spokenMoney: (t) => spokenMoney(t, travelPriceThresholds),
    liftsBudget: () => false,
  });
  const entry = (r: Route, total: number) => ({ routeId: r.id, travelers: 2, perPerson: total / 2, total, departDate: '2027-02-06' });
  const quoteOf = (r: Route, total: number) => ({ ...entry(r, total), routeTitle: r.title });
  const base = {
    id: 'x',
    channel: 'wecom',
    stage: 'quote',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const single = { ...base, lastQuote: quoteOf(lijiang, 33600), quoteHistory: [entry(lijiang, 33600)] } as Session;
  const both = {
    ...base,
    lastQuote: quoteOf(xgll, 100760),
    quoteHistory: [entry(lijiang, 33600), entry(xgll, 100760)],
  } as Session;
  const { netOrderIntent, netQuoteFor } = netHooks;

  const no = (cases: string[], why: string) => {
    for (const t of cases) assert.equal(netOrderIntent(t), false, `${why}：「${t}」不触发成单安全网`);
  };
  no(['行，说法我听到了，我回去考虑考虑，先不下单。', '先不下单', '暂时不下单', '不急着下单', '不下单，我再看看'], '否定');
  no(['我回去考虑考虑，下单的事回头再说', '再商量一下，晚点再定吧，下单不急', '等等再定，到时候下单'], '推迟 / 犹豫');
  no(['就它了，请帮我出报价', '确认下单前先出个报价', '就这个吧，发方案给我', '就它了，报个价'], '只要报价 / 方案');
  no(['可以下单吗', '怎么下单', '下单要先付定金吗', '能不能先下单再付款'], '疑问 / 问流程');
  for (const t of [
    '好，就它了，下单吧',
    '确认下单',
    '帮我下单',
    '好的，就订这个',
    '没问题，就订吧',
    '不用再看看了，就订这个',
    '考虑好了，下单吧',
  ]) {
    assert.equal(netOrderIntent(t), true, `正例仍触发：「${t}」`);
  }

  assert.equal(netQuoteFor(single, '确认下单')?.routeId, lijiang.id, '单条报价：按 lastQuote 建单');
  assert.equal(netQuoteFor(both, '确认下单'), undefined, '并列两条报价、没点名没序号：不触发');
  assert.equal(netQuoteFor(both, '好，就订这个吧'), undefined, '并列两条报价、只说「这个」：不触发');
  assert.equal(netQuoteFor(both, '第一条，下单')?.routeId, lijiang.id, '序号「第一条」：选 lijiang，不是 lastQuote');
  assert.equal(netQuoteFor(both, '2')?.routeId, xgll.id, '只回数字 2：选第二条');
  assert.equal(netQuoteFor(both, '就订第二个')?.routeId, xgll.id, '序号「第二个」：选 xgll');
  assert.equal(netQuoteFor(both, '丽江那条，下单')?.total, 33600, '点名别名「丽江」：按丽江的报价（¥33,600），不是 lastQuote');
  assert.equal(netQuoteFor(both, '8天的，确认下单')?.routeId, xgll.id, '点名天数「8天」：选 xgll');
  assert.equal(netQuoteFor(both, '确认下单，2个人'), undefined, '「2个人」是人数不是序号：仍不触发');
}

// 06 R17：每人预算的说法补「每个人、每一位、每位」，不放宽成「个人」；方案书缺日期时沿用最近报价的出发日
{
  const budgetOf = async (text: string): Promise<unknown[]> => {
    const s: Session = {
      ...structuredClone(session),
      stage: 'discovery',
      profile: {},
      messages: [{ role: 'customer', content: text, at: 0 }],
    };
    const calls: Record<string, unknown>[] = [];
    await hooks.prefetch!({
      session: s,
      text,
      async callTool(name, args) {
        calls.push(args);
        return { name, args, result: '[]' };
      },
    });
    return calls.map((a) => a.maxBudgetPerPerson);
  };
  assert.deepEqual(await budgetOf('想去云南，每个人预算一万五'), [15000]);
  assert.deepEqual(await budgetOf('想去云南，每一位预算两万'), [20000]);
  assert.deepEqual(await budgetOf('想去云南，每位一万八'), [18000]);
  assert.deepEqual(await budgetOf('想去云南，每人预算一万五'), [15000], '原有的说法照旧');
  assert.deepEqual(await budgetOf('想去云南，两个人预算5万'), [], '「个人」不放宽：说了钱却认不出每人上限，不预取');

  const quoted: Session = {
    ...structuredClone(session),
    lastQuote: { routeId: 'fixture-0', routeTitle: '云南测试线路', travelers: 2, departDate: '2099-12-10', perPerson: 10000, total: 20000 },
  };
  const blank = { session: quoted, text: '发个方案书', hints: {}, args: {}, notes: {}, handoffDeclined: false } as TurnToolContext;
  const withDate = hooks.beforeTool!('generate_proposal', { routeId: 'fixture-0', travelers: 2 }, blank);
  assert.ok('args' in withDate && (withDate.args as Record<string, unknown>).departDate === '2099-12-10', '缺日期沿用最近报价的出发日');
  const keep = hooks.beforeTool!(
    'generate_proposal',
    { routeId: 'fixture-0', travelers: 2 },
    { ...blank, session: { ...quoted, lastQuote: { ...quoted.lastQuote!, departDate: undefined } } },
  );
  assert.ok('args' in keep && (keep.args as Record<string, unknown>).departDate === undefined, '最近报价没带出发日：不补');
  const past = hooks.beforeTool!(
    'generate_proposal',
    { routeId: 'fixture-0', travelers: 2 },
    { ...blank, session: { ...quoted, lastQuote: { ...quoted.lastQuote!, departDate: '2020-01-01' } } },
  );
  assert.ok('args' in past && (past.args as Record<string, unknown>).departDate === undefined, '过去的日子不沿用');
  const quote = hooks.beforeTool!('create_quote', { routeId: 'fixture-0', travelers: 2 }, blank);
  assert.ok('args' in quote && (quote.args as Record<string, unknown>).departDate === undefined, '只有方案书沿用，报价不补');
}

console.log('TRAVEL TURN SELFTEST PASS: context、预取实际参数/顺序/部分失败与工具核正/结果/画像边界/成单安全网意图与选线');
