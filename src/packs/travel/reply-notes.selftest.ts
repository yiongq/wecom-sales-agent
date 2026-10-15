// 06 R7、R14：已提醒项与已推荐线路的认法、付款后寒暄的判定与三种渲染。
import assert from 'node:assert/strict';
import type { Route, Session } from '../../core/pack-api.js';
import { isPureChitchat, noteReply, paidChitchatReply, reminderLines, remindersIn, routesNamedIn, turnNumber } from './reply-notes.js';

const route = (i: number, title: string): Route => ({
  id: `r-${i}`,
  title,
  destination: '云南',
  days: 6,
  priceFrom: 10000,
  hotelLevel: '五星',
  bestSeason: '10月',
  highlights: [],
  tags: [],
  segments: [],
  itinerary: [],
});
const routes = [
  '云南 丽江大理·洱海古城 6 日',
  '四川 稻城亚丁·色达秘境 8 日',
  '西藏 拉萨·日喀则·珠峰大本营 7 日',
  '贵州 荔波小七孔·西江千户苗寨 6 日',
  '北京 故宫长城·皇家园林 5 日',
  '新疆 伊犁·独库公路越野摄影 9 日',
].map((t, i) => route(i, t));
const session = (customerTurns = 1): Session => ({
  id: 'web:reply-notes',
  channel: 'web',
  stage: 'discovery',
  profile: {},
  messages: Array.from({ length: customerTurns }, (_, i) => ({ role: 'customer' as const, content: `第${i + 1}句`, at: i })),
  orderIds: [],
  handedOver: false,
  createdAt: 0,
  updatedAt: 0,
});

// 提醒项的认法
assert.deepEqual(remindersIn('那一段海拔 3600 米，注意高反'), ['altitude']);
assert.deepEqual(remindersIn('爸妈今年多大了？身体怎么样'), ['elderAge']);
assert.deepEqual(remindersIn('方案书在这里 /proposal/abc'), ['proposalSent']);
assert.deepEqual(remindersIn('付款后顾问会发行程确认书、拉服务群'), ['paidNext']);
assert.deepEqual(remindersIn('您几位出行？大概哪天出发？'), [], '没有提醒项：什么都不认');
assert.deepEqual(remindersIn('今年多大了。爸妈坐飞机'), [], '年龄与长辈不在同一小句：不认');

// 线路点名：整个标题，或标题里的特色部分；只说目的地不算
assert.deepEqual(
  routesNamedIn('推荐《云南 丽江大理·洱海古城 6 日》', routes).map((r) => r.id),
  ['r-0'],
);
assert.deepEqual(
  routesNamedIn('丽江大理·洱海古城这条不错', routes).map((r) => r.id),
  ['r-0'],
);
assert.deepEqual(routesNamedIn('云南很好玩', routes), []);

// noteReply：只记第一次的轮次；线路去重、最多 5 条（挤掉最早的）；不追加任何消息
{
  const s = session(2);
  const before = s.messages.length;
  noteReply(s, '海拔 3600 米', routes);
  assert.deepEqual(s.reminders, { altitude: 2 });
  s.messages.push({ role: 'customer', content: '又问', at: 9 });
  noteReply(s, '再提一次高反', routes);
  assert.deepEqual(s.reminders, { altitude: 2 }, '只记第一次');
  assert.equal(s.messages.length, before + 1, 'note_reply 不往会话追加 system 消息');
  for (const r of routes) noteReply(s, `看看${r.title}`, routes);
  noteReply(s, `再看${routes[3].title}`, routes);
  assert.deepEqual(
    s.recommendedRoutes!.map((r) => r.id),
    ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'],
  );
  const empty = session(1);
  noteReply(empty, '您好～想去哪儿玩？', routes);
  assert.equal(empty.reminders, undefined);
  assert.equal(empty.recommendedRoutes, undefined, '没有可记的内容：字段保持 undefined');
  assert.deepEqual(reminderLines(empty), [], '没有记录：contextNote 不加行');
}

// contextNote 的两行
{
  const s = session(3);
  s.reminders = { altitude: 2, paidNext: 3 };
  s.recommendedRoutes = [
    { id: 'a', title: '甲线' },
    { id: 'b', title: '乙线' },
  ];
  assert.deepEqual(reminderLines(s), [
    '已对客户说过：海拔提醒（第 2 轮）、说过付款后安排（第 3 轮）——客户没再问就别重复',
    '本会话推荐过：《甲线》、《乙线》；做对比或总结时把这些都算上',
  ]);
  assert.ok(!/报价时机|\d号/.test(reminderLines(s).join('')));
  assert.equal(turnNumber(s), 3);
}

// R14 纯寒暄的判定
for (const t of ['你好', '您好！', '在吗', '谢谢', '谢谢您～', '好的', '嗯', '嗯嗯', '收到', 'ok', '好的😊', '你好，在吗', '哈喽']) {
  assert.equal(isPureChitchat(t), true, `纯寒暄：「${t}」`);
}
for (const t of [
  '酒店是哪几家',
  '你好，酒店是哪几家',
  '谢谢，什么时候发行程',
  '好的，那退款怎么办',
  '在吗，我想改日期',
  '',
  '好的好的好的好的好的',
  '收到了吗',
]) {
  assert.equal(isPureChitchat(t), false, `不是纯寒暄：「${t}」`);
}

// R14 回复：一行、不含确认书与拉群、三种渲染、轮换、说过付款后安排的不再提顾问安排
{
  const s = session(1);
  const legacy = paidChitchatReply(s, { channel: 'wecom', templateMode: false });
  assert.match(legacy, /在微信上联系您/);
  assert.match(paidChitchatReply(s, { channel: 'web', templateMode: false }), /在这个页面里回复您/);
  const tpl = paidChitchatReply(s, { channel: 'wecom', templateMode: true });
  assert.ok(tpl.includes('联系您') && !tpl.includes('微信') && !tpl.includes('云途'));
  const seen = new Set<string>();
  for (let n = 1; n <= 6; n++) {
    const r = paidChitchatReply(session(n), { channel: 'wecom', templateMode: true });
    seen.add(r);
    assert.ok(!r.includes('\n') && !/确认书|拉群|服务群|\*\*|#/.test(r));
  }
  assert.equal(seen.size, 3, '3 个变体轮换');
  const prior = session(2);
  const first = paidChitchatReply(prior, { channel: 'wecom', templateMode: true });
  prior.messages.push({ role: 'agent', content: first, at: 5 });
  assert.notEqual(paidChitchatReply(prior, { channel: 'wecom', templateMode: true }), first, '不连着发同一句');
  const told = session(2);
  told.reminders = { paidNext: 1 };
  for (let n = 1; n <= 4; n++) {
    told.messages = session(n).messages;
    assert.ok(!/后续安排|联系您|回复您|确认书|服务群/.test(paidChitchatReply(told, { channel: 'wecom', templateMode: false })));
  }
}

console.log('TRAVEL REPLY NOTES SELFTEST PASS: 提醒项与线路认法、note_reply 记录、contextNote 两行、付款后寒暄判定与渲染');
