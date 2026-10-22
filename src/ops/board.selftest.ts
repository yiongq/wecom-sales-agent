// 看板的来源与成交拆分的自测（07 spec R23、不变量 20、验收 11；plan 第 15 步）：不连库、不起服务，纯函数加源码扫描。
// 1. originOf 各分支：种子（会话前缀、订单前缀、seed 标记）、访客（宿主 sim-、沙箱里的非种子）、真实客户；种子优先于访客；
// 2. 成交拆分 dealsByOrigin：AI 独立成交与人机协同成交之和等于窗口内付过款的订单数；宿主种子不进「真实客户」，沙箱里访客自己的成交进「访客」；
//    其中已退款各列各的；窗口起点含、之前不算；待付款、已取消、被替代的单不算；
// 3. 本月汇总 summarizeOrders：顶层同第 4 步的口径（与旧循环逐项相等），三类来源之和等于顶层；
// 4. 按原因的转人工率 handoffStats：与手算一致，分子只数窗口内有轮次的会话（不超过 1），顾问主动接手单列次数，宿主的访客与种子结构上是空的；
// 5. admin.html 不再有「1 − 接管率」的口径，D1 守住的几处还在；insight 的转人工成交额按 handoffBeforePaid 算（D2）。
// 带库的部分（/metrics 的 SQL 与缓存、PGlite 与真实 PG）在 src/ops/ops.selftest.ts；handoffLog 的追加在 src/handoff/handoff.selftest.ts。
// 用法：npx tsx src/ops/board.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HandoffRow } from '../db/repo/metrics.js';
import type { Origin } from '../shared/origin.js';
import type { Order, Session } from '../types.js';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-board-selftest-'));
process.env.VAR_DIR = VAR_DIR;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));

const { originOf, ORIGINS } = await import('../shared/origin.js');
const { dealsByOrigin, summarizeOrders, handoffStats } = await import('./board.js');
const { aggregate } = await import('../core/insight.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const json = (x: unknown): string => JSON.stringify(x);
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, json(got) === json(want), `得到 ${json(got)}，应为 ${json(want)}`);

// ---------------- 1. originOf ----------------
const SBX = `sbx-${'a'.repeat(32)}`;
{
  const std = (x: Parameters<typeof originOf>[0]): Origin => originOf(x, 'standard');
  const sbx = (x: Parameters<typeof originOf>[0]): Origin => originOf(x, 'sandbox');
  eq('standard：企微真实客户', std({ sessionId: 'wecom:wmREAL01' }), 'customer');
  eq('standard：网页会话（web:）不是 sim-，算真实客户', std({ sessionId: `web:${'b'.repeat(32)}` }), 'customer');
  eq('standard：宿主里 sim- 开头的网页访客', std({ sessionId: `sim-${'c'.repeat(24)}` }), 'visitor');
  eq('standard：wecom:cust_ 开头的种子会话', std({ sessionId: 'wecom:cust_B01' }), 'seed');
  eq('standard：ord_seed_ 开头的订单（会话已不在）', std({ sessionId: 'wecom:wmGONE', orderId: 'ord_seed_A01' }), 'seed');
  eq('standard：带 seed: true 标记的会话', std({ sessionId: 'wecom:wmMARKED', seed: true }), 'seed');
  eq('standard：seed: false 不算种子', std({ sessionId: 'wecom:wmREAL01', seed: false }), 'customer');
  eq('standard：普通订单号不算种子', std({ sessionId: 'wecom:wmREAL01', orderId: 'ord_0123456789abcdef01234567' }), 'customer');
  eq(
    'standard：wecom:customer 这类只是长得像的 id 不是种子（前缀要带下划线，同库里的 CHECK）',
    std({ sessionId: 'wecom:customer1' }),
    'customer',
  );
  eq(
    '种子优先于访客：sim- 带 seed 标记、sim- 配种子订单号都算种子',
    [std({ sessionId: 'sim-x', seed: true }), std({ sessionId: 'sim-x', orderId: 'ord_seed_B01' })],
    ['seed', 'seed'],
  );
  eq('sandbox：沙箱里自己聊的访客（sbx-）', sbx({ sessionId: SBX }), 'visitor');
  eq('sandbox：开通时打了标的种子会话（也是 sbx- 开头）', sbx({ sessionId: SBX, seed: true }), 'seed');
  eq('sandbox：种子订单（会话 id 是 sbx-，订单号保留 ord_seed_）', sbx({ sessionId: SBX, orderId: 'ord_seed_A01' }), 'seed');
  eq(
    'sandbox：没有真实客户，非种子一律是访客',
    [sbx({ sessionId: 'wecom:wmREAL01' }), sbx({ sessionId: `sim-${'d'.repeat(24)}` })],
    ['visitor', 'visitor'],
  );
  eq('sandbox：wecom:cust_ 照样是种子', sbx({ sessionId: 'wecom:cust_A01' }), 'seed');
  eq('三类来源的固定顺序', ORIGINS, ['customer', 'visitor', 'seed']);
}

// ---------------- 2. 成交拆分 ----------------
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 6, 0, 0);
const SINCE = NOW - 6 * DAY;
let n = 0;
function order(sessionId: string, patch: Partial<Order> = {}): Order {
  n += 1;
  return {
    id: `ord_${String(n).padStart(24, '0')}`,
    sessionId,
    routeId: 'r-test',
    routeTitle: '测试线路',
    travelers: 2,
    departDate: '2099-01-01',
    totalPrice: 1000 * n,
    status: 'paid',
    createdAt: SINCE - DAY,
    paidAt: NOW - DAY,
    handoffBeforePaid: false,
    ...patch,
  };
}
const SBX_SEED = `sbx-${'5'.repeat(32)}`;
const SBX_VISITOR = `sbx-${'e'.repeat(32)}`;
/** 会话上的种子标记：沙箱开通时打在种子会话上（第 7 步），宿主里也可以有 */
const SEEDS = new Set<string>([SBX_SEED, 'wecom:wmMARKED']);
const seedOf = (id: string): boolean | undefined => (SEEDS.has(id) ? true : undefined);
const NO_DEALS = { aiOnly: 0, aiOnlyAmount: 0, aiOnlyRefunded: 0, assisted: 0, assistedAmount: 0, assistedRefunded: 0, refunded: 0 };
{
  const orders: Order[] = [
    // 宿主（standard）：真实客户 3 单（2 AI 独立含 1 单已退款、1 协同含退款中），访客 1 单协同，种子 2 单（会话前缀一单、订单前缀一单）
    order('wecom:wmREAL01', { totalPrice: 10_000 }),
    order('wecom:wmREAL02', { totalPrice: 20_000, status: 'refunded' }),
    order('wecom:wmREAL03', { totalPrice: 30_000, status: 'refund_pending', handoffBeforePaid: true }),
    order(`sim-${'f'.repeat(24)}`, { totalPrice: 4_000, handoffBeforePaid: true }),
    order('wecom:cust_B01', { totalPrice: 105_600, handoffBeforePaid: true }),
    order('wecom:wmGONE', { id: 'ord_seed_A01', totalPrice: 5_000 }),
    order('wecom:wmMARKED', { totalPrice: 6_000 }),
    // 不算的：待付款、已取消、被替代、窗口之前付的（含起点前 1 毫秒）、没有 paidAt 的
    order('wecom:wmREAL01', { status: 'pending_payment', paidAt: undefined }),
    order('wecom:wmREAL01', { status: 'cancelled', paidAt: undefined }),
    order('wecom:wmREAL01', { status: 'superseded', paidAt: undefined }),
    order('wecom:wmREAL01', { paidAt: SINCE - 1 }),
    order('wecom:wmREAL01', { paidAt: undefined }),
    // 窗口起点正好含在里面
    order('wecom:wmREAL01', { totalPrice: 700, paidAt: SINCE }),
    // 02 之前的老单没有 handoffBeforePaid：按没转过人工算（AI 独立）
    order('wecom:wmREAL04', { totalPrice: 800, handoffBeforePaid: undefined }),
  ];
  const d = dealsByOrigin(orders, SINCE, 'standard', seedOf);
  eq('宿主：真实客户的金额与「其中已退款」各列各的（已退款单按原成交额算在 AI 独立里）', d.customer, {
    aiOnly: 4,
    aiOnlyAmount: 10_000 + 20_000 + 700 + 800,
    aiOnlyRefunded: 1,
    assisted: 1,
    assistedAmount: 30_000,
    assistedRefunded: 0,
    refunded: 1,
  });
  eq('宿主：sim- 访客的成交进「访客」，不进真实客户', d.visitor, {
    aiOnly: 0,
    aiOnlyAmount: 0,
    aiOnlyRefunded: 0,
    assisted: 1,
    assistedAmount: 4_000,
    assistedRefunded: 0,
    refunded: 0,
  });
  eq('宿主：种子（会话前缀、订单前缀、seed 标记）的成交进「种子」，不进真实客户（不变量 20、验收 11）', d.seed, {
    aiOnly: 2,
    aiOnlyAmount: 5_000 + 6_000,
    aiOnlyRefunded: 0,
    assisted: 1,
    assistedAmount: 105_600,
    assistedRefunded: 0,
    refunded: 0,
  });
  const paidInWindow = orders.filter(
    (o) => o.paidAt != null && o.paidAt >= SINCE && (o.status === 'paid' || o.status === 'refund_pending' || o.status === 'refunded'),
  ).length;
  const sum = ORIGINS.reduce((k, o) => k + d[o].aiOnly + d[o].assisted, 0);
  check(
    'AI 独立成交与人机协同成交之和等于窗口内付过款的订单数（三类来源合计）',
    sum === paidInWindow && sum === 9,
    `${sum} / ${paidInWindow}`,
  );
  check(
    '每一类来源里 aiOnly + assisted 也等于该类窗口内付过款的订单数；refunded 等于两个「其中已退款」之和',
    ORIGINS.every((o) => d[o].refunded === d[o].aiOnlyRefunded + d[o].assistedRefunded),
  );

  // 沙箱：访客自己的成交计入「访客」；种子（打标的会话、ord_seed_ 的订单）计入「种子」；没有真实客户
  const sbxOrders: Order[] = [
    order(SBX_VISITOR, { totalPrice: 3_000 }),
    order(SBX_VISITOR, { totalPrice: 4_000, handoffBeforePaid: true, status: 'refunded' }),
    order(SBX_SEED, { totalPrice: 105_600, handoffBeforePaid: true }),
    order(SBX_VISITOR, { id: 'ord_seed_A01', totalPrice: 99_000 }),
  ];
  const s = dealsByOrigin(sbxOrders, SINCE, 'sandbox', seedOf);
  eq(
    '沙箱：访客自己的两单进「访客」（一单 AI 独立、一单协同已退款）',
    [s.visitor.aiOnly, s.visitor.assisted, s.visitor.assistedRefunded, s.visitor.assistedAmount],
    [1, 1, 1, 4_000],
  );
  eq('沙箱：打标的种子会话与 ord_seed_ 订单进「种子」，真实客户永远是空的', [s.seed.aiOnly, s.seed.assisted, s.customer], [1, 1, NO_DEALS]);
}

// ---------------- 3. 本月汇总 ----------------
{
  const from = Date.UTC(2026, 9, 1);
  const to = Date.UTC(2026, 10, 1);
  const inMonth = Date.UTC(2026, 9, 10);
  const orders: Order[] = [
    order('wecom:wmREAL01', { totalPrice: 100, paidAt: inMonth }),
    order('wecom:wmREAL01', { totalPrice: 200, paidAt: inMonth, status: 'refund_pending' }),
    order('wecom:wmREAL01', { totalPrice: 400, paidAt: inMonth, status: 'refunded' }),
    order('wecom:wmREAL01', { totalPrice: 800, paidAt: from - 1, status: 'refunded' }),
    order('wecom:wmREAL01', { totalPrice: 1_600, paidAt: from - 1, status: 'refund_pending' }),
    order('wecom:wmREAL01', { totalPrice: 3_200, paidAt: from - 1 }),
    order(`sim-${'f'.repeat(24)}`, { totalPrice: 6_400, paidAt: inMonth }),
    order('wecom:cust_A01', { totalPrice: 12_800, paidAt: to }),
    order('wecom:cust_A01', { totalPrice: 25_600, status: 'pending_payment', paidAt: undefined }),
    order(`sim-${'f'.repeat(24)}`, { totalPrice: 51_200, status: 'pending_payment', paidAt: undefined }),
    order('wecom:cust_A02', { totalPrice: 102_400, status: 'cancelled', paidAt: undefined }),
  ];
  // 第 4 步的旧循环原样搬来当参照：顶层的数必须逐项相等（别改它们的口径）
  const old = { paidTotal: 0, paidCount: 0, refundedTotal: 0, refundedCount: 0, refundPendingCount: 0, pendingTotal: 0, pendingCount: 0 };
  for (const o of orders) {
    if (o.status === 'refund_pending') old.refundPendingCount += 1;
    if (o.status === 'refunded' && o.paidAt != null && o.paidAt >= from && o.paidAt < to) {
      old.refundedTotal += o.totalPrice;
      old.refundedCount += 1;
    } else if ((o.status === 'paid' || o.status === 'refund_pending') && o.paidAt != null && o.paidAt >= from && o.paidAt < to) {
      old.paidTotal += o.totalPrice;
      old.paidCount += 1;
    } else if (o.status === 'pending_payment') {
      old.pendingTotal += o.totalPrice;
      old.pendingCount += 1;
    }
  }
  const { total, byOrigin } = summarizeOrders(orders, from, to, 'standard', seedOf);
  eq('本月汇总：顶层与第 4 步的旧口径逐项相等', total, old);
  eq('本月汇总：成交额含退款中；已退款按原付款月份的原成交额单列；退款中不限月份；待付款不限月份；月外的不算', total, {
    paidTotal: 100 + 200 + 6_400,
    paidCount: 3,
    refundedTotal: 400,
    refundedCount: 1,
    refundPendingCount: 2,
    pendingTotal: 25_600 + 51_200,
    pendingCount: 2,
  });
  eq(
    '本月汇总：三类来源之和等于顶层（逐项）',
    ORIGINS.map((o) => byOrigin[o]).reduce((a, b) => ({
      paidTotal: a.paidTotal + b.paidTotal,
      paidCount: a.paidCount + b.paidCount,
      refundedTotal: a.refundedTotal + b.refundedTotal,
      refundedCount: a.refundedCount + b.refundedCount,
      refundPendingCount: a.refundPendingCount + b.refundPendingCount,
      pendingTotal: a.pendingTotal + b.pendingTotal,
      pendingCount: a.pendingCount + b.pendingCount,
    })),
    total,
  );
  eq(
    '本月汇总：真实客户不含 sim- 访客与种子',
    [byOrigin.customer.paidTotal, byOrigin.visitor.paidTotal, byOrigin.visitor.pendingTotal, byOrigin.seed.pendingTotal],
    [300, 6_400, 51_200, 25_600],
  );
}

// ---------------- 4. 按原因的转人工率 ----------------
{
  const row = (id: string, active: boolean, kinds: string[], seed = false): HandoffRow => ({ id, seed, active, kinds });
  const rows: HandoffRow[] = [
    row('wecom:wmR1', true, ['request', 'request', 'model']),
    row('wecom:wmR2', true, ['complaint']),
    row('wecom:wmR3', true, []),
    row('wecom:wmR4', true, ['agent']),
    // 窗口内没有轮次、只有顾问接手：不进分母，也不进各原因的分子（比率不超过 1），接手次数照数
    row('wecom:wmR5', false, ['agent', 'agent']),
    row('wecom:wmR6', false, ['request']),
    // 库里读回的脏数据：未知类型丢掉
    row('wecom:wmR7', true, ['bogus', 'sentiment']),
  ];
  const std = handoffStats(rows, 'standard');
  eq('转人工率：分母是窗口内有轮次的会话（5 个：R1 R2 R3 R4 R7）', std.all.sessions, 5);
  eq('转人工率：按原因，一个会话同一原因记几次只算一个；分子只数有轮次的会话', std.all.byKind, {
    request: 1 / 5,
    model: 1 / 5,
    complaint: 1 / 5,
    agent: 1 / 5,
    sentiment: 1 / 5,
  });
  eq('顾问主动接手：单列次数，不论会话窗口内有没有轮次（R4 一次、R5 两次）', std.all.takeovers, 3);
  check(
    '比率都在 0–1 之间',
    Object.values(std.all.byKind).every((r) => r >= 0 && r <= 1),
  );
  eq(
    '宿主：库里的会话都是真实客户，访客与种子结构上是空的',
    [std.byOrigin.customer.sessions, std.byOrigin.visitor, std.byOrigin.seed],
    [5, { sessions: 0, byKind: {}, takeovers: 0 }, { sessions: 0, byKind: {}, takeovers: 0 }],
  );
  eq('没有会话时各原因的比率是空的（不是 NaN）', handoffStats([], 'standard').all, { sessions: 0, byKind: {}, takeovers: 0 });

  // 沙箱里三类都进库
  const sbxRows: HandoffRow[] = [
    row(SBX_VISITOR, true, ['request']),
    row(`sbx-${'1'.repeat(32)}`, true, []),
    row(SBX_SEED, true, ['complaint', 'agent'], true),
  ];
  const sb = handoffStats(sbxRows, 'sandbox');
  eq(
    '沙箱：访客 2 个会话、1 个要找顾问；种子 1 个会话、投诉与接手各一；没有真实客户',
    [
      sb.byOrigin.visitor.sessions,
      sb.byOrigin.visitor.byKind,
      sb.byOrigin.seed.sessions,
      sb.byOrigin.seed.byKind,
      sb.byOrigin.seed.takeovers,
      sb.byOrigin.customer.sessions,
    ],
    [2, { request: 1 / 2 }, 1, { complaint: 1, agent: 1 }, 1, 0],
  );
  eq('沙箱：合计是三类相加', [sb.all.sessions, sb.all.takeovers], [3, 1]);
}

// ---------------- 5. admin.html 与 insight ----------------
{
  const admin = fs.readFileSync(path.resolve('public/admin.html'), 'utf8');
  check(
    'admin.html 不再用「1 − 接管率」冒充 AI 独立完成：没有 autoRate、「AI 自动化率」、会话数减接管数',
    !/autoRate|AI 自动化率|sess\.length\s*-\s*handoff/.test(admin),
  );
  check(
    'admin.html 的 KPI 改成同口径的「AI 独立成交」，按 handoffBeforePaid 数',
    admin.includes("kpi('AI 独立成交'") && admin.includes('handoffBeforePaid'),
  );
  check('admin.html 的 KPI 文案里不再有「AI 独立完成」', !/kpi\([^\n]*AI 独立完成/.test(admin));
  check(
    'D1：admin.html 的已被替代标签、liveOrder(s)、会话 id 存储键与请求头还在',
    admin.includes("'已被替代'") && admin.includes('liveOrder(s)') && admin.includes("'x-sim-session'"),
  );
  const insight = fs.readFileSync(path.resolve('src/core/insight.ts'), 'utf8');
  check(
    'insight.ts 不再用会话的 handedOver 算转人工贡献的成交额',
    !/sessions\.find\([^\n]*handedOver/.test(insight) && insight.includes('handoffBeforePaid'),
  );

  // D2：转人工贡献的成交额按付款时有没有转过人工算；会话已交还（handedOver=false）的协同单照样算，从没转过的不算
  const sess = (id: string, handedOver: boolean): Session =>
    ({
      id,
      channel: 'simulator',
      stage: 'paid',
      profile: {},
      messages: [],
      orderIds: [],
      handedOver,
      createdAt: 1,
      updatedAt: 1,
    }) as Session;
  const sessions = [sess('wecom:wmI1', false), sess('wecom:wmI2', true), sess('wecom:wmI3', false)];
  const orders = [
    order('wecom:wmI1', { totalPrice: 600, handoffBeforePaid: true }), // 转过人工、已交还
    order('wecom:wmI2', { totalPrice: 300, handoffBeforePaid: false }), // 现在还在转人工，但付款时没转过
    order('wecom:wmI3', { totalPrice: 100, handoffBeforePaid: false }),
  ];
  const agg = aggregate(sessions, orders);
  check(
    'insight：转人工贡献的成交额占比按 handoffBeforePaid 算（600/1000 = 60%，不是按现在是否转人工的 30%）',
    agg.handoffGmvPct === 60 && agg.gmv === 1000,
    json({ pct: agg.handoffGmvPct, gmv: agg.gmv }),
  );
}

if (fails.length) {
  console.error(`BOARD SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `BOARD SELFTEST PASS: ${pass} 项断言全通（originOf 各分支 / 成交拆分与来源 / 本月汇总口径不变 / 按原因的转人工率 / admin.html 与 insight 的老口径下线）`,
);
process.exit(0);
