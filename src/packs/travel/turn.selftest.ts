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
console.log('TRAVEL TURN SELFTEST PASS: context、预取实际参数/顺序/部分失败与工具核正/结果/画像边界');
