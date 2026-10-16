// 06 R5、R6：订单与付款状态、敏感问法口径进 contextNote。三种对客渲染、触发边界、不触发时逐字节不变。
import assert from 'node:assert/strict';
import { spokenMoney, type BrandProfile, type Order, type Session, type TurnContext } from '../../core/pack-api.js';
import { createTravelTurnHooks } from './turn.js';
import { travelPriceThresholds } from './thresholds.js';

const orders = new Map<string, Order>();
const addOrder = (id: string, status: Order['status'], departDate: string): void => {
  orders.set(id, {
    id,
    sessionId: 's',
    routeId: 'r-1',
    routeTitle: '云南测试线路',
    travelers: 2,
    departDate,
    totalPrice: 33600,
    status,
    createdAt: 0,
  });
};
const hooks = createTravelTurnHooks({
  loadRoutes: () => [],
  getOrder: (id) => orders.get(id),
  searchRoutes: async () => [],
  rememberShownRoutes: () => {},
  mentionsPlace: (text, word) => text.includes(word),
  isOriginMention: () => false,
  offCatalogPlaces: () => [],
  visitedDestinations: () => [],
  paymentMode: () => 'online',
  spokenMoney: (text) => spokenMoney(text, travelPriceThresholds),
  liftsBudget: () => false,
});
const brand: BrandProfile = {
  brandName: '山海旅行',
  advisorTitle: '旅行顾问',
  aiTitle: 'AI 旅行顾问',
  scopeNoun: '旅行',
  identityLine: '山海旅行的旅行顾问',
};
const make = (channel: string, orderIds: string[]): Session => ({
  id: `${channel}:state-note`,
  channel,
  stage: 'discovery',
  profile: {},
  messages: [],
  orderIds,
  handedOver: false,
  createdAt: 0,
  updatedAt: 0,
});
const ctxOf = (session: Session, text: string, b?: BrandProfile | null): TurnContext => ({
  session,
  text,
  brand: b,
  callTool: async () => assert.fail('contextNote 不预取'),
});
const note = (session: Session, text: string, b?: BrandProfile | null): string[] =>
  hooks.contextNote(ctxOf(session, text, b)).filter(Boolean);

// 不触发：没有订单、没说已付、不是敏感问法 → 与开工时相同（两个空串）
{
  const s = make('wecom', []);
  assert.deepEqual(hooks.contextNote(ctxOf(s, '想去西藏')), ['', '']);
  for (const t of ['想去西藏', '新疆几月去好', '酒店是哪几家', '还没付款，怎么付', '没转账，先问下优惠', '付款之后怎么安排']) {
    assert.deepEqual(note(s, t), [], `不触发：「${t}」`);
  }
}

// R5 订单行：待付款 / 已付款，不给金额，日期写 N月N日，作废的不列，最多最近 3 张
addOrder('o1', 'pending_payment', '2099-12-10');
addOrder('o2', 'cancelled', '2099-12-11');
addOrder('o3', 'superseded', '2099-12-12');
addOrder('o4', 'paid', '2099-12-13');
addOrder('o5', 'pending_payment', '2099-12-14');
addOrder('o6', 'pending_payment', '2099-12-15');
{
  const lines = note(make('wecom', ['o1']), '酒店是哪几家');
  assert.deepEqual(lines, ['订单: 《云南测试线路》2 位、2099年12月10日出发，待付款']);
  assert.ok(!/¥|33600|33,600|元|报价时机|\d号/.test(lines.join('\n')), '不给金额，不含「报价时机」与「N号」');
  const many = note(make('wecom', ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']), '酒店是哪几家');
  assert.equal(many.length, 2);
  assert.equal(
    many[0],
    '订单: 《云南测试线路》2 位、2099年12月13日出发，已付款；《云南测试线路》2 位、2099年12月14日出发，待付款；《云南测试线路》2 位、2099年12月15日出发，待付款',
  );
  assert.equal(many[1], '已付款的单：顾问会发行程确认书、拉服务群；说过就别再说');
  assert.deepEqual(note(make('wecom', ['o2', 'o3']), '酒店是哪几家'), [], '只有作废的单：什么都不加');
}

// R5 自称已付：没有已付款订单才加；三种渲染；有已付款订单、否定、疑问「之后」不加
{
  const legacy = note(make('wecom', ['o1']), '我已经付款了').at(-1)!;
  assert.match(legacy, /^客户说已付款，但系统还没收到到账：不要说已到账、订单生效、订单已确认；/);
  assert.ok(legacy.includes('顾问核实后会在微信上联系您'));
  assert.ok(
    note(make('web', ['o1']), '付好了')
      .at(-1)!
      .includes('顾问核实后会在这个页面里回复您'),
  );
  const tpl = note(make('wecom', ['o1']), '转账了', brand).at(-1)!;
  assert.ok(tpl.includes('顾问核实后会联系您') && !tpl.includes('微信') && !tpl.includes('云途'));
  for (const t of ['已付', '付完了', '付好了', '转账了', '打款了']) {
    assert.ok(
      note(make('wecom', []), t).some((l) => l.startsWith('客户说已付款')),
      `触发：「${t}」`,
    );
  }
  assert.ok(!note(make('wecom', ['o4']), '我已经付款了').some((l) => l.startsWith('客户说已付款')), '已有已付款订单：不加');
}

// R6：只认问法，不认地名；与订单行可共存
{
  const asks = [
    '西藏现在安全吗',
    '去新疆要办边防证吗',
    '日本签证要多久',
    '这个地方开放吗',
    '要办什么手续',
    '要不要通行证',
    '出入境要注意什么',
  ];
  for (const t of asks) {
    const l = note(make('wecom', []), t);
    assert.equal(l.length, 1, `触发：「${t}」`);
    assert.match(
      l[0],
      /^客户问到敏感地区、安全或证件手续：统一说「这块政策会变，由顾问按您的出行时间确认」，不转人工；通行证只照线路的「含 \/ 不含」说；不给签证时长和费用；/,
    );
    assert.ok(!/报价时机|\d号/.test(l[0]));
  }
  assert.equal(note(make('wecom', ['o1']), '西藏安全吗').length, 2);
}

console.log('TRAVEL STATE NOTE SELFTEST PASS: 订单行、自称已付三种渲染、敏感问法、不触发时无新增行');
