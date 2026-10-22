// 07 R14：政策问法进上下文。问法识别的正反例、条款取用、适用条款的天数边界、只追加不改已有行、不给金额。
// 引擎一侧的接线（本轮捕获的 policy、没有嵌入请求）在 src/policy-ask.selftest.ts。
import assert from 'node:assert/strict';
import { spokenMoney, todayIso, type Order, type Session, type TurnContext } from '../../core/pack-api.js';
import { FEES_REPLY, INSURANCE_REPLY } from './claim-words.js';
import { daysToDeparture, policyAsk, policyNote } from './policy-ask.js';
import { clauses, defaultTravelPolicy, type TravelPolicy } from './policy.js';
import { travelPriceThresholds } from './thresholds.js';
import { createTravelTurnHooks } from './turn.js';

let passed = 0;
const eq = <T>(actual: T, expected: T, msg: string): void => {
  assert.deepEqual(actual, expected, msg);
  passed++;
};

// ---------- 问法识别 ----------
const REFUND = ['refund', 'change'];
const asks: [string, string[]][] = [
  // 退款、退订、取消、改期：问法
  ['退改怎么算', REFUND],
  ['退改规则怎么算？', REFUND],
  ['如果临时去不了，能退吗', REFUND],
  ['能不能退款', REFUND],
  ['可以退订吗', REFUND],
  ['能全额退吗', REFUND],
  ['交了钱不去能退钱吗', REFUND],
  ['订金能退吗', REFUND],
  ['取消的话要扣钱吗', REFUND],
  ['付款后可以取消吗', REFUND],
  ['改期要加钱吗', REFUND],
  ['能改日期吗', REFUND],
  ['我想改个日期可以吗', REFUND],
  ['万一要改期，行不行', REFUND],
  ['之后如果要改期或者取消，规则是什么', REFUND],
  ['退改政策是什么', REFUND],
  ['想了解下退改政策', REFUND],
  ['退改政策', REFUND],
  ['取消规则', REFUND],
  ['能退多少，几天到账', REFUND],
  // K11：「保险起见」是副词，后面那半句才是问法
  ['保险起见 还是问下能退吗', REFUND],
  // 保险
  ['这条线含保险吗', ['insurance']],
  ['保险包不包', ['insurance']],
  ['万一在高原上出事了谁负责？保险包不包', ['insurance']],
  ['再发下支付链接 顺便问下含保险吗', ['insurance']],
  ['有意外险吗', ['insurance']],
  ['保险怎么赔', ['insurance']],
  ['保险保额多少', ['insurance']],
  ['要不要自己买保险', ['insurance']],
  ['保险是哪家公司的', ['insurance']],
  ['保险包括什么', ['insurance']],
  ['保险都有什么', ['insurance']],
  ['保险呢', ['insurance']],
  // 费用含不含
  ['机票包含吗', ['fees']],
  ['最后一天几点的飞机 机票包含吗', ['fees']],
  ['瑞士那条费用含机票吗', ['fees']],
  ['含不含早餐', ['fees']],
  ['费用含不含门票', ['fees']],
  ['团费包含什么', ['fees']],
  ['不包含哪些', ['fees']],
  ['有自费项目吗', ['fees']],
  ['有没有隐形消费', ['fees']],
  ['还要另外付钱吗', ['fees']],
  // 一句话问了几样，按条款顺序出
  ['机票和保险含不含', ['insurance', 'fees']],
  ['能退吗，保险含不含，机票呢，包含吗', [...REFUND, 'insurance', 'fees']],
  ['云南怎么样？含不含机票？退改怎么算？', [...REFUND, 'fees']],
];
for (const [text, topics] of asks) eq(policyAsk(text), topics as ReturnType<typeof policyAsk>, `问法：「${text}」`);

const notAsks = [
  // 没有政策话题
  '想去西藏',
  '你好',
  '多少钱',
  '怎么付款',
  '我想了解下云南',
  '今天天气怎么样',
  // 提到这些词的陈述句不算
  '我想退款',
  '我要取消订单',
  '我们改期了',
  '已经取消了',
  '上次退款了，这次想去云南',
  '我们改期到明年再说',
  '我们自己买保险',
  '你们含保险，那我就放心了',
  '含早',
  '含税价',
  '不含机票',
  '没有什么保险',
  '不用什么自费',
  '没啥自费项目，挺好',
  // 「保险起见」「更保险」是副词，不是保险问法（K11）
  '保险起见，我想订两份',
  '保险起见 先问下',
  '3个人，保险起见先问下',
  '这样比较保险',
  '为了保险一点我们多留一天',
  // 细节问法归引擎的预取，不是政策问法（K9、K10、K22）
  '走路多不多',
  '累不累',
  '黄龙累不累',
  '住哪',
  '住哪都行 你看着安排',
  '那九寨那边住哪',
  '洱海边住哪',
  '九寨海拔高吗 我妈怕高反',
  '稻城海拔多少',
  '拉萨海拔多高',
  '北海道住哪',
  '包括我妈在内一共3个人',
  '不包括孩子',
  '我们几点下班才能走',
  '体力还行',
  // 别的「退」「包」「改」
  '几点退房',
  '高反吃什么药退烧',
  '退一步讲能便宜点吗',
  '能包车吗',
  '改天再聊',
];
for (const text of notAsks) eq(policyAsk(text), [], `不是政策问法：「${text}」`);
// 问的信号要和主题词在同一个句子里：前一句陈述、后一句问别的，不算
eq(policyAsk('我想退款。云南怎么样？'), [], '主题词与问法分在两个句子');
eq(policyAsk('我想退款。能退吗？'), REFUND as ReturnType<typeof policyAsk>, '问法在后一句里');

// ---------- 距出发天数 ----------
eq(daysToDeparture('2026-11-26', '2026-10-02'), 55, '出发日 − 今天');
eq(daysToDeparture('2026-10-02', '2026-10-02'), 0, '当天');
eq(daysToDeparture('2026-10-01', '2026-10-02'), -1, '已过');
eq(daysToDeparture('2028-03-01', '2028-02-28'), 2, '闰年 2 月有 29 天');
eq(daysToDeparture('2027-01-02', '2026-12-31'), 2, '跨年');
eq(daysToDeparture('下个月', '2026-10-02'), undefined, '读不出日期');

// ---------- 条款取用 ----------
// 订单的出发日都按「今天 + N 天」造，不依赖哪天跑；contextNote 一侧用的是引擎同一个 todayIso()
const TODAY = todayIso();
const addDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const orders = new Map<string, Order>();
const addOrder = (id: string, status: Order['status'], daysAhead: number, over: Partial<Order> = {}): void => {
  orders.set(id, {
    id,
    sessionId: 's',
    routeId: 'r-1',
    routeTitle: '云南测试线路',
    travelers: 2,
    departDate: addDays(TODAY, daysAhead),
    totalPrice: 33600,
    status,
    createdAt: 0,
    ...over,
  });
};
const note = (text: string, orderIds: string[] = [], policy: unknown = defaultTravelPolicy): string[] =>
  policyNote({ policy, text, orderIds, getOrder: (id) => orders.get(id), today: TODAY });

const HEADER = '可引用的条款（照原文说，说到哪条就在句末写出处）：';
const REFUND_LINES = [
  '（退改条款第1条）出发前30天及以上取消，退全款',
  '（退改条款第2条）出发前15–29天取消，退订单金额的80%',
  '（退改条款第3条）出发前7–14天取消，退订单金额的50%',
  '（退改条款第4条）出发前0–6天取消，不能自助退，由顾问为您处理',
  '（改期条款）出发前15天及以上可以改期一次，由顾问为您办理',
];
// 没有订单问「退改怎么算」（验收 7 第一条）：首行、全部档位、改期条款，没有「您这张单」
eq(note('退改怎么算'), [HEADER, ...REFUND_LINES], '没有订单：全部退改条款加改期条款');
for (const t of ['能退款吗', '能改期吗', '取消要扣钱吗', '可以退订吗'])
  eq(note(t), [HEADER, ...REFUND_LINES], `退款、退订、取消、改期都给同一组：「${t}」`);
eq(note('退改怎么算').length >= defaultTravelPolicy.refund.tiers.length + 1 + 1, true, '条数不少于档位数 + 1（再加首行）');
// 保险、费用主题各只给一句口径，不带退改条款，有订单也不加适用那一行
addOrder('o-far', 'paid', 55);
eq(note('这条线含保险吗'), [HEADER, `（保险说明）${INSURANCE_REPLY}`], '保险主题只给一句');
eq(note('机票包含吗'), [HEADER, `（费用说明）${FEES_REPLY}`], '费用主题只给一句');
eq(note('这条线含保险吗', ['o-far']), [HEADER, `（保险说明）${INSURANCE_REPLY}`], '保险主题有订单也不加适用那一行');
eq(
  note('机票和保险含不含', ['o-far']),
  [HEADER, `（保险说明）${INSURANCE_REPLY}`, `（费用说明）${FEES_REPLY}`],
  '一句问了保险和费用：各一句，按条款顺序',
);
// 不是政策问法、没有 policy：什么都不加，也不碰订单
const noOrderLookup = (): Order => assert.fail('没有政策问法时不该查订单');
for (const t of ['想去西藏', '我想退款', '保险起见', '走路多不多'])
  eq(
    policyNote({ policy: defaultTravelPolicy, text: t, orderIds: ['o-far'], getOrder: noOrderLookup, today: TODAY }),
    [],
    `不加：「${t}」`,
  );
for (const policy of [undefined, null])
  eq(
    policyNote({ policy, text: '退改怎么算', orderIds: [], getOrder: noOrderLookup, today: TODAY }),
    [],
    `本轮没有 policy 快照（${policy}）：不加`,
  );
eq(
  policyNote({ policy: defaultTravelPolicy, text: '这条线含保险吗', orderIds: ['o-far'], getOrder: noOrderLookup, today: TODAY }),
  [HEADER, `（保险说明）${INSURANCE_REPLY}`],
  '保险主题不查订单',
);

// 有订单时标出适用的那一条：档位边界 30、29、15、14、7、6、0 天与已出发
const applicable = (days: number, status: Order['status'] = 'paid'): string | undefined => {
  addOrder('o-edge', status, days);
  return note('退改怎么算', ['o-edge']).slice(1 + REFUND_LINES.length)[0];
};
eq(applicable(55), '您这张单离出发55天，适用退改条款第1条', '验收 7 的示例：55 天适用第1条');
eq(applicable(31), '您这张单离出发31天，适用退改条款第1条', '31 天');
eq(applicable(30), '您这张单离出发30天，适用退改条款第1条', '30 天是第1条的下界');
eq(applicable(29), '您这张单离出发29天，适用退改条款第2条', '29 天是第2条的上界');
eq(applicable(15), '您这张单离出发15天，适用退改条款第2条', '15 天是第2条的下界');
eq(applicable(14), '您这张单离出发14天，适用退改条款第3条', '14 天是第3条的上界');
eq(applicable(7), '您这张单离出发7天，适用退改条款第3条', '7 天是第3条的下界');
eq(applicable(6), '您这张单离出发6天，适用退改条款第4条', '6 天落在低于最低档的第4条');
eq(applicable(1), '您这张单离出发1天，适用退改条款第4条', '1 天');
eq(applicable(0), '您这张单今天出发，适用退改条款第4条', '出发当天');
eq(applicable(-1), '您这张单的出发日已过，不适用上面的退改条款', '已出发：不套档位');
eq(applicable(40, 'pending_payment'), '您这张单离出发40天，适用退改条款第1条', '待付款的单也标');
// 租户存的档位不一定按天数排好序：适用条款不依赖数组顺序，条款编号也一样
{
  const shuffled: TravelPolicy = {
    ...defaultTravelPolicy,
    refund: { ...defaultTravelPolicy.refund, tiers: [...defaultTravelPolicy.refund.tiers].reverse() },
  };
  eq(note('退改怎么算', [], shuffled), [HEADER, ...REFUND_LINES], '档位倒着存：条款和默认的一样');
  for (const [days, clause] of [
    [55, 1],
    [30, 1],
    [29, 2],
    [15, 2],
    [14, 3],
    [7, 3],
    [6, 4],
    [0, 4],
  ] as const) {
    addOrder('o-shuffled', 'paid', days);
    eq(
      note('退改怎么算', ['o-shuffled'], shuffled).at(-1),
      days ? `您这张单离出发${days}天，适用退改条款第${clause}条` : `您这张单今天出发，适用退改条款第${clause}条`,
      `档位倒着存：${days} 天适用第${clause}条`,
    );
  }
}
// 适用那一行紧跟在改期条款后面，在前面的条款不变
{
  const lines = (addOrder('o-edge', 'paid', 20), note('能改期吗', ['o-edge']));
  eq(lines.slice(0, 1 + REFUND_LINES.length), [HEADER, ...REFUND_LINES], '条款原样');
  eq(lines.at(-1), '您这张单离出发20天，适用退改条款第2条', '适用那一行在最后');
  eq(lines.length, 1 + REFUND_LINES.length + 1, '只多一行');
}
// 多张单按最近一张没作废的（orderIds 是下单顺序），作废、被替代的不算
addOrder('o-a', 'pending_payment', 40);
addOrder('o-b', 'paid', 10);
addOrder('o-c', 'cancelled', 3);
addOrder('o-d', 'superseded', 2);
eq(note('退改怎么算', ['o-a', 'o-b']).at(-1), '您这张单离出发10天，适用退改条款第3条', '两张都有效：取后下的');
eq(note('退改怎么算', ['o-b', 'o-a']).at(-1), '您这张单离出发40天，适用退改条款第1条', '顺序反过来取另一张');
eq(note('退改怎么算', ['o-a', 'o-b', 'o-c', 'o-d']).at(-1), '您这张单离出发10天，适用退改条款第3条', '后面作废、被替代的跳过');
eq(note('退改怎么算', ['o-c', 'o-d']), [HEADER, ...REFUND_LINES], '只有作废的单：和没有订单一样');
eq(note('退改怎么算', ['o-missing']), [HEADER, ...REFUND_LINES], '订单查不到：和没有订单一样');
addOrder('o-bad-date', 'paid', 5, { departDate: '待定' });
eq(note('退改怎么算', ['o-bad-date']), [HEADER, ...REFUND_LINES], '出发日读不出：不标适用条款');

// 只给条款与天数，不给金额；不带 markdown；出处是句末全角括号前的原句（R14）
{
  addOrder('o-money', 'paid', 20, { totalPrice: 33600 });
  const text = note('退改怎么算，保险含不含，机票包含吗', ['o-money']).join('\n');
  assert.ok(!/[¥￥]|33,?600|30,?000|3万|元/.test(text), `不给金额：${text}`);
  assert.ok(!/[*#`[\]]/.test(text), `不带 markdown：${text}`);
  passed += 2;
}

// 租户改了政策：条款、编号和适用条款都跟着本轮的快照走，不看默认值
{
  const tenant: TravelPolicy = {
    ...defaultTravelPolicy,
    refund: {
      ...defaultTravelPolicy.refund,
      tiers: [
        { id: 'd30', minDays: 30, maxDays: null, percent: 100 },
        { id: 'd15', minDays: 15, maxDays: 29, percent: 80 },
        { id: 'd10', minDays: 10, maxDays: 14, percent: 60 },
        { id: 'd3', minDays: 3, maxDays: 9, percent: 30 },
      ],
    },
    change: '出发前20天及以上可以改期一次，由顾问为您办理',
  };
  const refundTitles = clauses(tenant)
    .filter((c) => c.topic === 'refund')
    .map((c) => c.title);
  eq(refundTitles.length, 5, '4 档加低于最低档一条');
  const lines = note('退改怎么算', [], tenant);
  eq(lines.length, 1 + 5 + 1, '首行 + 5 条退改 + 改期');
  eq(lines[3], '（退改条款第3条）出发前10–14天取消，退订单金额的60%', '增加的档位按天数编号');
  eq(lines[5], '（退改条款第5条）出发前0–2天取消，不能自助退，由顾问为您处理', '低于最低档排最后');
  eq(lines.at(-1), '（改期条款）出发前20天及以上可以改期一次，由顾问为您办理', '改期句取租户的');
  addOrder('o-t', 'paid', 12);
  eq(note('退改怎么算', ['o-t'], tenant).at(-1), '您这张单离出发12天，适用退改条款第3条', '适用条款按租户档位');
  addOrder('o-t2', 'paid', 2);
  eq(note('退改怎么算', ['o-t2'], tenant).at(-1), '您这张单离出发2天，适用退改条款第5条', '落到租户的最后一条');
  assert.throws(() => note('退改怎么算', [], { version: 1 }), '快照不合 schema 是代码错误，不悄悄吞掉');
  passed++;
}

// ---------- 并进 contextNote：只追加在已有各行之后 ----------
{
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
  const session = (orderIds: string[]): Session => ({
    id: 'wecom:policy-ask',
    channel: 'wecom',
    stage: 'discovery',
    profile: {},
    messages: [],
    orderIds,
    handedOver: false,
    createdAt: 0,
    updatedAt: 0,
  });
  const ctx = (s: Session, text: string, policy?: unknown): TurnContext => ({
    session: s,
    text,
    policy,
    callTool: async () => assert.fail('contextNote 不预取'),
  });
  const withoutPolicy = (s: Session, text: string): string[] => hooks.contextNote(ctx(s, text));
  const withPolicy = (s: Session, text: string): string[] => hooks.contextNote(ctx(s, text, defaultTravelPolicy));
  // 不是政策问法：有没有 policy、有没有订单，contextNote 都逐项相同（不变量 17）
  for (const ids of [[], ['o-far']])
    for (const t of ['想去西藏', '我想退款', '保险起见，先看看', '酒店是哪几家', '走路多不多', '谢谢']) {
      const s = session(ids);
      eq(withPolicy(s, t), withoutPolicy(s, t), `不是政策问法，逐项不变：「${t}」${ids.length ? '（有订单）' : ''}`);
    }
  eq(withPolicy(session([]), '想去西藏'), ['', ''], '没有订单、不是政策问法：和 06 一样只有两个空串');
  // 政策问法：已有各行原样在前（订单行也是），条款行追加在最后
  for (const [ids, t] of [
    [[], '退改怎么算'],
    [['o-far'], '退改怎么算'],
    [['o-far'], '这条线含保险吗'],
  ] as [string[], string][]) {
    const s = session(ids);
    const before = withoutPolicy(s, t);
    const after = withPolicy(s, t);
    eq(after.slice(0, before.length), before, `已有各行文字与顺序不变：「${t}」`);
    eq(after.slice(before.length), note(t, ids), `追加的就是条款行：「${t}」`);
  }
  assert.ok(
    withPolicy(session(['o-far']), '能退吗').some((l) => l.startsWith('订单: ')),
    '订单行还在',
  );
  passed++;
}

console.log(`POLICY ASK SELFTEST PASS: ${passed} 项断言全通`);
