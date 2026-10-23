// 沙箱种子的结构契约；只读已提交 JSON，不调用 Python（05 spec「开通与删除」）。
// 07 R21：相对出发日、seed: true、G01（退款待审批）的开通现算——时钟全部钉死在固定日期，不依赖真实此刻。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BrandProfile } from '../core/pack-api.js';
import { quoteRefund } from '../core/pack-api.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';
import { defaultTravelPolicy, travelPolicy, type TravelPolicy } from '../packs/travel/policy.js';
import { refundChooseText, refundNoticeText, refundQuoteText, refundTexts } from '../packs/travel/refund-words.js';
import { packById } from '../packs/registry.js';
import { paidNeedsHuman } from '../shared/conversation.js';
import { originOf } from '../shared/origin.js';
import type { Order, PaymentMode, Session } from '../types.js';
import { sandboxSeeds, type SeedContext, type SeedOrder } from './sandbox/seeds.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../../data/sandbox-seeds.json', import.meta.url), 'utf8')) as {
  $comment: string;
  sessions: Session[];
  orders: SeedOrder[];
};
const routes = JSON.parse(fs.readFileSync(new URL('../../data/routes.json', import.meta.url), 'utf8')) as {
  id: string;
  title: string;
  priceFrom: number;
}[];

assert.ok(fixture.$comment.includes('毫秒偏移'), '文件须说明相对时间约定');
assert.equal(fixture.sessions.length, 6, '必须有 6 个种子会话（默认场景的 5 个加沙箱专有的 G01）');
assert.equal(fixture.orders.length, 3, '必须有 3 个种子订单');

assert.deepEqual(fixture.sessions.map((s) => s.id).sort(), [
  'wecom:cust_A01',
  'wecom:cust_B01',
  'wecom:cust_C01',
  'wecom:cust_E01',
  'wecom:cust_F01',
  'wecom:cust_G01',
]);
assert.deepEqual(fixture.sessions.map((s) => s.stage).sort(), ['closing', 'discovery', 'handoff', 'paid', 'paid', 'quote']);
assert.deepEqual(fixture.orders.map((o) => o.status).sort(), ['paid', 'pending_payment', 'refund_pending']);
const sessions = new Map(fixture.sessions.map((session) => [session.id, session]));
const orders = new Map(fixture.orders.map((order) => [order.id, order]));
const routeIds = new Set(routes.map((route) => route.id));
assert.equal(sessions.size, fixture.sessions.length, '会话 id 必须唯一');
assert.equal(orders.size, fixture.orders.length, '订单 id 必须唯一');

function relativeTime(value: unknown, field: string): void {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value <= 0, `${field} 必须是 <=0 的整数毫秒偏移`);
}

// 递归检查嵌套记录及后来新增的时间戳，不能只查消息而漏掉 handoff.at 或 paidAt。
function checkTimes(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkTimes(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'at' || key.endsWith('At')) relativeTime(item, `${field}.${key}`);
      else checkTimes(item, `${field}.${key}`);
    }
  }
}
checkTimes(fixture, 'fixture');

const messageTimes: number[] = [];
for (const session of fixture.sessions) {
  assert.ok(typeof session.id === 'string' && session.id.length > 0, '会话 id 不能为空');
  relativeTime(session.createdAt, `${session.id}.createdAt`);
  relativeTime(session.updatedAt, `${session.id}.updatedAt`);
  assert.ok(session.messages.length > 0, `${session.id} 缺少消息`);
  for (const message of session.messages) {
    relativeTime(message.at, `${session.id}.messages.at`);
    assert.ok(message.at >= session.createdAt && message.at <= session.updatedAt, `${session.id} 消息须在会话时间范围内`);
    messageTimes.push(message.at);
  }
  if (session.handoff) relativeTime(session.handoff.at, `${session.id}.handoff.at`);
  assert.equal(session.seed, undefined, `${session.id}：seed 标记由开通时统一打，夹具里不写`);
  for (const orderId of session.orderIds) {
    const order = orders.get(orderId);
    assert.ok(order, `${session.id} 引用了不存在的订单 ${orderId}`);
    assert.equal(order.sessionId, session.id, `${orderId} 的会话引用须双向一致`);
  }
}
assert.equal(Math.max(...messageTimes), 0, '最新一条消息的偏移必须为 0');
assert.ok(
  messageTimes.some((at) => at < 0),
  '较早消息须为负偏移',
);

for (const order of fixture.orders) {
  assert.ok(typeof order.id === 'string' && order.id.length > 0, '订单 id 不能为空');
  const session = sessions.get(order.sessionId);
  assert.ok(session, `${order.id} 引用了不存在的会话 ${order.sessionId}`);
  assert.ok(session.orderIds.includes(order.id), `${order.id} 必须出现在所属会话的 orderIds 中`);
  assert.ok(routeIds.has(order.routeId), `${order.id} 引用了不存在的线路 ${order.routeId}`);
  relativeTime(order.createdAt, `${order.id}.createdAt`);
  if (order.status === 'paid' || order.status === 'refund_pending') relativeTime(order.paidAt, `${order.id}.paidAt`);
  // 出发日要么是绝对日期文本，要么是相对开通日的天数，二选一
  assert.ok(
    (order.departDate === undefined) !== (order.departOffsetDays === undefined),
    `${order.id} 的 departDate 与 departOffsetDays 二选一`,
  );
  if (order.departDate !== undefined) assert.match(order.departDate, /^\d{4}-\d{2}-\d{2}$/, `${order.id} 的出发日必须是日期文本`);
}
const withOffset = fixture.orders.filter((o) => o.departOffsetDays !== undefined);
assert.deepEqual(
  withOffset.map((o) => o.id),
  ['ord_seed_7c41a9'],
  '只有 G01 用相对出发日；A01 的出发日照旧是过去的日子',
);
assert.equal(orders.get('ord_seed_A01')!.departDate, '2026-10-15');
assert.equal(orders.get('ord_seed_B01')!.departDate, '2026-11-10');

// G01 的夹具：对客的报价句、提交句和转人工原因都只放占位，文字由开通时的行业包现算，不抄进 JSON。
const g01 = sessions.get('wecom:cust_G01')!;
const g01Order = orders.get('ord_seed_7c41a9')!;
// 订单号保留 ord_seed_ 前缀（来源判定认它），后面是 6 位小写十六进制：客户在报价句里看到的「订单尾号」像真单号
assert.match(g01Order.id, /^ord_seed_[0-9a-f]{6}$/);
assert.equal(g01Order.id.slice(-6), '7c41a9');
assert.equal(originOf({ sessionId: 'sbx-0123456789abcdef0123456789abcdef', orderId: g01Order.id }, 'sandbox'), 'seed');
assert.equal(originOf({ sessionId: 'sbx-0123456789abcdef0123456789abcdef', orderId: g01Order.id, seed: true }, 'sandbox'), 'seed');
assert.equal(g01Order.departOffsetDays, 40);
assert.equal(g01Order.status, 'refund_pending');
assert.equal(g01Order.handoffBeforePaid, false);
assert.ok(g01Order.refundSeed && !('refund' in g01Order), '退款记录由开通时按已发布 policy 补全');
const g01Route = routes.find((r) => r.id === g01Order.routeId)!;
assert.equal(g01Order.routeTitle, g01Route.title);
assert.equal(g01Order.totalPrice, g01Route.priceFrom * g01Order.travelers);
assert.ok(g01Order.totalPrice > defaultTravelPolicy.refund.approvalThresholdYuan, 'G01 的总价（100% 档的退款额）必须超过默认审批阈值');
assert.equal(g01.stage, 'paid');
assert.equal(g01.handedOver, true);
const tail = g01.messages.slice(-4);
assert.deepEqual(
  tail.map((m) => [m.role, m.content]),
  [
    ['customer', '我要退款'],
    ['agent', '{refund_quote}'],
    ['customer', '确认退款'],
    ['agent', '{refund_submitted}'],
  ],
);
assert.equal(g01.handoff!.reason, '{refund_reason}');
assert.deepEqual(
  Object.keys(JSON.parse(JSON.stringify(g01.afterSale)) as object).sort(),
  ['at', 'step'],
  '报价对象由开通时按 policy 补，夹具里不写',
);
for (const session of fixture.sessions.filter((s) => s !== g01))
  assert.ok(!JSON.stringify(session).includes('{refund_'), `${session.id} 不该有退款占位`);

// ---------------- 开通现算（sandboxSeeds） ----------------

/** 固定的开通时刻与开通日：不读真实时钟，也不依赖一天里跑的时刻 */
const CREATED_AT = Date.UTC(2026, 9, 22, 3, 0, 0);
const TODAY = '2026-10-22';
const words = { quoteText: refundQuoteText, chooseText: refundChooseText, texts: refundTexts, noticeText: refundNoticeText };
const PACK = packById('travel')!;

function context(over: Partial<{ policy: TravelPolicy; brand: BrandProfile | null; mode: PaymentMode; today: string }> = {}): SeedContext {
  const policy = over.policy ?? defaultTravelPolicy;
  return {
    today: over.today ?? TODAY,
    refund: {
      terms: travelPolicy.refund(policy),
      policy,
      policyHash: 'policy-hash-fixture',
      brand: over.brand === undefined ? shanhaiBrand : over.brand,
      paymentMode: over.mode ?? 'online',
      words,
      clauseTitle: (id) => travelPolicy.clauses(policy).find((c) => c.id === id)?.title ?? '退改条款',
    },
  };
}
/** 开通日加天数的独立算法（不走 seeds.ts 的实现）：用年月日分量，让 Date 自己进位 */
function plusDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function g01Of(out: { sessions: Session[]; orders: Order[] }) {
  const order = out.orders.find((o) => o.id === 'ord_seed_7c41a9');
  const session = out.sessions.find((s) => s.orderIds.includes('ord_seed_7c41a9'));
  return { order, session };
}

// 出发日：有 departOffsetDays 的单是开通日加天数，没有的照旧；跨月、跨年、闰年都对
for (const today of ['2026-10-22', '2026-12-05', '2027-12-30', '2028-01-25', '2026-01-01']) {
  const out = sandboxSeeds(CREATED_AT, context({ today }));
  assert.equal(out.orders.find((o) => o.id === 'ord_seed_7c41a9')!.departDate, plusDays(today, 40), `开通日 ${today}`);
  assert.equal(out.orders.find((o) => o.id === 'ord_seed_A01')!.departDate, '2026-10-15', 'A01 的出发日不随开通日变');
  assert.equal(out.orders.find((o) => o.id === 'ord_seed_B01')!.departDate, '2026-11-10');
  assert.ok(
    out.orders.every((o) => !('departOffsetDays' in o) && !('refundSeed' in o)),
    '夹具里的辅助字段不进订单',
  );
}
assert.equal(plusDays('2026-10-22', 40), '2026-12-01');
assert.equal(plusDays('2028-01-25', 40), '2028-03-05');

const out = sandboxSeeds(CREATED_AT, context());
assert.equal(out.sessions.length, 6);
assert.equal(out.orders.length, 3);
assert.ok(
  out.sessions.every((s) => s.seed === true && s.channel === 'simulator' && /^sbx-[a-f0-9]{32}$/.test(s.id)),
  '每段种子都打 seed: true',
);
assert.ok(!JSON.stringify(out).includes('{refund_'), '占位全部替换');
for (const t of out.sessions.flatMap((s) => [s.createdAt, s.updatedAt, ...s.messages.map((m) => m.at)]))
  assert.ok(t <= CREATED_AT - 5 * 60_000, '种子时间都在开通前，不会被当成访客自己的会话');
assert.equal(Math.max(...out.sessions.flatMap((s) => s.messages.map((m) => m.at))), CREATED_AT - 5 * 60_000, '最新一条消息在开通前 5 分钟');

const { order, session } = g01Of(out);
assert.ok(order && session);
assert.equal(order.sessionId, session.id);
assert.equal(order.departDate, '2026-12-01');
assert.equal(order.status, 'refund_pending');
assert.equal(order.totalPrice, 33_600);
assert.equal(order.travelers, 2);
assert.equal(order.handoffBeforePaid, false);
assert.equal(order.paidAt, CREATED_AT - 5 * 60_000 + g01Order.paidAt!);
const quote = quoteRefund({ ...order, status: 'paid' }, defaultTravelPolicy.refund, 'policy-hash-fixture', TODAY);
assert.ok(!('ineligible' in quote));
assert.equal(quote.daysBefore, 40);
const refund = order.refund!;
assert.match(refund.id, /^rf_[0-9a-f]{12}$/);
assert.deepEqual(
  { ...refund, id: 'rf', requestedAt: 0 },
  {
    id: 'rf',
    requestedAt: 0,
    daysBefore: 40,
    tierId: quote.tier.id,
    percent: 100,
    amount: 33_600,
    policyHash: 'policy-hash-fixture',
    approval: 'pending',
    settlement: 'mock',
  },
);
assert.equal(refund.requestedAt, CREATED_AT - 5 * 60_000 + g01Order.refundSeed!.requestedAt);
assert.ok(refund.requestedAt > order.paidAt!, '退款申请在付款之后');

// 报价句、提交句、转人工原因：与第 5 步的文字逐字一致（独立写死的整句，加上直接调第 5 步函数的结果）
const textCtx = { policy: defaultTravelPolicy, channel: 'simulator', brand: shanhaiBrand };
const customerLines = session.messages.slice(-4);
assert.equal(
  customerLines[1]!.content,
  '《云南 丽江大理·洱海古城 6 日》2 位、12 月 1 日出发（订单尾号 7c41a9）：离出发 40 天，按退改条款第1条可退全款 ¥33,600。确认退款请回复「确认退款」。',
);
assert.equal(customerLines[1]!.content, refundQuoteText({ ...order, status: 'paid' }, quote, textCtx));
assert.equal(customerLines[3]!.content, refundTexts(quote, textCtx).submitted);
assert.ok(customerLines[3]!.content.startsWith('退款申请已提交：¥33,600。金额超过 ¥30,000 要顾问审核，'));
assert.deepEqual(
  customerLines.map((m) => m.role),
  ['customer', 'agent', 'customer', 'agent'],
);
assert.equal(customerLines[0]!.content, '我要退款');
assert.equal(customerLines[2]!.content, '确认退款');
assert.ok(customerLines.every((m, i) => i === 0 || m.at > customerLines[i - 1]!.at));

// 会话状态：与真实走一遍之后一致——终态阶段不变、转人工 kind refund、在「已成交客户要人工」里
assert.equal(session.stage, 'paid');
assert.equal(session.handedOver, true);
assert.equal(session.assignee, null);
assert.deepEqual(session.handoff, {
  kind: 'refund',
  at: refund.requestedAt,
  reason: '退款待审批：¥33,600（退改条款第1条）',
  quote: '确认退款',
});
assert.equal(session.stageBeforeHandoff, 'paid');
assert.equal(session.firstHandoffAt, refund.requestedAt);
assert.equal(session.handoffCount, 1);
assert.deepEqual(session.handoffLog, [{ kind: 'refund', at: refund.requestedAt }]);
assert.equal(session.afterSale?.step, 'confirm');
if (session.afterSale?.step === 'confirm') assert.deepEqual(session.afterSale.quote, quote);
assert.ok(paidNeedsHuman(session, PACK), 'G01 在「已成交客户要人工」里');
assert.ok(!out.sessions.some((s) => s !== session && paidNeedsHuman(s, PACK)), '其余种子不在这一组里');
assert.deepEqual(session.profile.dates, undefined);

// 三种联系方式的渲染：旧版与品牌模板的提交句不同，但都与第 5 步当前的输出逐字一致，且没有 markdown
for (const brand of [null, shanhaiBrand]) {
  const mode = sandboxSeeds(CREATED_AT, context({ brand }));
  const g = g01Of(mode);
  const ctx = { policy: defaultTravelPolicy, channel: 'simulator', brand };
  const q = quoteRefund({ ...g.order!, status: 'paid' }, defaultTravelPolicy.refund, 'policy-hash-fixture', TODAY);
  assert.ok(!('ineligible' in q));
  assert.equal(g.session!.messages.at(-1)!.content, refundTexts(q, ctx).submitted);
  assert.ok(g.session!.messages.slice(-4).every((m) => !/\*\*|^#{1,6}\s/m.test(m.content)));
  if (brand) assert.ok(!/云途/.test(g.session!.messages.at(-1)!.content), '模板模式不出现「云途」');
}

// 支付模式：settlement 跟着走
assert.equal(g01Of(sandboxSeeds(CREATED_AT, context({ mode: 'advisor' }))).order!.refund!.settlement, 'advisor');
assert.equal(g01Of(sandboxSeeds(CREATED_AT, context({ mode: 'advisor' }))).order!.refund!.approval, 'pending');

// 政策变了，G01 跟着变（而不是抄死在 JSON 里）
{
  const custom = structuredClone(defaultTravelPolicy);
  custom.refund.approvalThresholdYuan = 20_000;
  custom.refund.tiers = custom.refund.tiers.map((t) => (t.id === quote.tier.id ? { ...t, percent: 90 } : t));
  const g = g01Of(sandboxSeeds(CREATED_AT, context({ policy: custom })));
  assert.equal(g.order!.refund!.amount, 30_240);
  assert.equal(g.order!.refund!.percent, 90);
  assert.ok(g.session!.messages.at(-3)!.content.includes('¥30,240'));
  assert.ok(g.session!.messages.at(-1)!.content.includes('金额超过 ¥20,000 要顾问审核'));
  assert.equal(g.session!.handoff!.reason, '退款待审批：¥30,240（退改条款第1条）');
}

// 真实流程不会停在「退款中、要人」的情形，G01 整段不要（不留半拉子的会话）：自助退款关着、阈值不低于退款额且模拟支付（当场办完）、
// 没有适用的档位、包没有退款能力
{
  const noSelf = structuredClone(defaultTravelPolicy);
  noSelf.refund.selfService = false;
  const high = structuredClone(defaultTravelPolicy);
  high.refund.approvalThresholdYuan = 40_000;
  const noTier = structuredClone(defaultTravelPolicy);
  noTier.refund.tiers = noTier.refund.tiers.filter((t) => t.minDays > 40);
  const dropped = [
    sandboxSeeds(CREATED_AT, context({ policy: noSelf })),
    sandboxSeeds(CREATED_AT, context({ policy: high })),
    sandboxSeeds(CREATED_AT, context({ policy: noTier })),
    sandboxSeeds(CREATED_AT, { today: TODAY, refund: null }),
  ];
  for (const d of dropped) {
    assert.equal(d.sessions.length, 5);
    assert.equal(d.orders.length, 2);
    assert.ok(d.sessions.every((s) => s.seed === true));
    assert.ok(d.orders.every((o) => o.id !== 'ord_seed_7c41a9') && d.sessions.every((s) => !s.orderIds.includes('ord_seed_7c41a9')));
  }
  // 阈值不低于退款额但收款是顾问确认：要等顾问把钱退回，同样是「退款中、要人」，原因写「待打款」
  const advisor = g01Of(sandboxSeeds(CREATED_AT, context({ policy: high, mode: 'advisor' })));
  assert.equal(advisor.order!.refund!.approval, 'auto');
  assert.equal(advisor.order!.refund!.settlement, 'advisor');
  assert.equal(advisor.session!.handoff!.reason, '退款待打款：¥33,600（已自动批准，按原付款方式退回）');
  assert.ok(advisor.session!.messages.at(-1)!.content.includes('按原付款方式退回'));
}

console.log('SELFTEST PASS: 沙箱种子 6 个会话、3 个订单，引用与线路有效，时间均为相对毫秒偏移；相对出发日、seed 标记与 G01 开通现算');
