// 08 R8：两个工厂的删句、兜底、金额来源与步骤位置契约。
import assert from 'node:assert/strict';
import type { GuardStep, ReplyGuardContext, StepVerdict } from '../pack-api.js';
import type { LineOrder } from '../order-view.js';
import { loadGuardPipeline } from './execute.js';
import { moneyProvenanceStep, moneyProvenanceFollowupStep, type MoneyProvenanceSources } from './money-provenance.js';

const policy = { freightFen: 1000 };
const options = { staticAmounts: (p: unknown) => [(p as typeof policy).freightFen], fallback: '金额尚未核验，请先查询。' };
const order: LineOrder = {
  v: 2,
  id: 'ord_fixture',
  sessionId: 'wecom:wmfixture',
  status: 'pending_payment',
  createdAt: 0,
  totalFen: 133000,
  lines: [
    { kind: 'widget', code: 'w-a', title: '合成方盒甲', qty: 200, unit: '件', unitPriceFen: 365, amountFen: 73000 },
    { kind: 'widget', code: 'w-b', title: '合成方盒乙', qty: 50, unit: '件', unitPriceFen: 1200, amountFen: 60000 },
  ],
};
const sources: MoneyProvenanceSources = {
  money: () => ({ minimumAmount: 0.01, precisionTolerance: 0.5, decimals: true }),
  getOrder: (id) => (id === order.id ? order : undefined),
  followupPolicy: () => policy,
};
const events: { guard: string; before: string; after: string; action: string }[] = [];
function context(text: string): ReplyGuardContext {
  return {
    session: {
      id: 'wecom:wmfixture',
      channel: 'wecom',
      stage: 'quote',
      profile: {},
      messages: [],
      orderIds: [],
      handedOver: false,
      createdAt: 0,
      updatedAt: 0,
      moneyLedger: [{ fen: 365, label: '单价' }],
    },
    text,
    policy,
    turn: { flags: { guardHit: null } },
    toolSources: [],
    orderSources: [],
    brand: null,
    thresholds: {},
    createOrder: async () => {
      throw new Error('禁止建单');
    },
    callTool: async () => {
      throw new Error('禁止调工具');
    },
    enterHandoff: () => {
      throw new Error('禁止转人工');
    },
    recordGuard: (...[guard, before, after, action]: Parameters<ReplyGuardContext['recordGuard']>) =>
      events.push({ guard, before, after, action }),
  } as unknown as ReplyGuardContext;
}
const noop = (id: string): GuardStep<ReplyGuardContext> => ({ id, run: () => ({ action: 'pass' }) });
const main = moneyProvenanceStep(options, () => sources);
const rows = [noop('stage_advance'), main, noop('takeover_check:post'), noop('turn_failure')];
const pipeline = loadGuardPipeline(rows);
let count = 0;
async function check(text: string, expected: string, action: StepVerdict['action']): Promise<void> {
  events.length = 0;
  const ctx = context(text);
  const result = await pipeline.run(ctx);
  assert.equal(result.text, expected);
  assert.deepEqual(result.verdicts[1], { id: 'money_provenance', action });
  assert.equal(ctx.turn.flags.guardHit, action === 'pass' ? null : 'price');
  assert.equal(events.length, action === 'pass' ? 0 : 1);
  if (action !== 'pass') assert.deepEqual(events[0], { guard: 'money_provenance', before: text, after: expected, action });
  count++;
}

await check('单价 3.65 元。', '单价 3.65 元。', 'pass');
await check('请确认规格。单价 3.80 元。', '请确认规格。', 'drop_sentence');
await check('单价 3.80 元。', options.fallback, 'replace');
await check('单价 3.65 元，但合计 7.30 元。继续核验。', '继续核验。', 'drop_sentence');
await check('相差 0.15 元。合计 7.30 元。乘起来 730 元。继续核验。', '继续核验。', 'drop_sentence');
await check('静态运费 10 元。', '静态运费 10 元。', 'pass');
await check('单价3块6毛5。', '单价3块6毛5。', 'pass');
await check('单价3块8毛。请确认规格。', '请确认规格。', 'drop_sentence');
await check('单价12.5元/件。请确认规格。', '请确认规格。', 'drop_sentence');
await check('交期3.5天，型号M8×30。', '交期3.5天，型号M8×30。', 'pass');
await check('请确认。\n单价3.80元！单价3.65元？', '请确认。\n单价3.65元？', 'drop_sentence');
await check('先看规格。单价3.80元。\n', '先看规格。\n', 'drop_sentence');
await check('  单价3.80元。\n', options.fallback, 'replace');

// 不放行客户提出的价格；也不读取整库或本轮工具结果里未声明的数。
const untrusted = context('就按3.80元成交。');
untrusted.session.messages.push({ role: 'customer', content: '3.80元就买', at: 0 });
untrusted.toolSources.push({ name: 'unannounced', args: {}, result: '{"price":3.8}' });
assert.equal((await pipeline.run(untrusted)).text, options.fallback);
count++;

// 订单来源独立于工具账本，认单价、逐行金额和合计；不认数量相乘之外的新推导值。
const ordered = context('单价3.65元、12元。行金额730元、600元。合计1330元。');
delete ordered.session.moneyLedger;
ordered.session.orderIds = [order.id, 'missing'];
assert.equal((await pipeline.run(ordered)).text, '单价3.65元、12元。行金额730元、600元。合计1330元。');
const foreign = context('合计1330元。');
foreign.session.id = 'wecom:wmother';
foreign.session.orderIds = [order.id];
assert.equal((await pipeline.run(foreign)).text, options.fallback);
const decimal = context('单价12.5元/件。');
decimal.session.moneyLedger = [{ fen: 1250, label: '单价' }];
assert.equal((await pipeline.run(decimal)).text, '单价12.5元/件。');
// 大金额也不能随数值放宽半分容差。
const large = context('合计90000000000000.02元。');
large.session.moneyLedger = [{ fen: 9000000000000000, label: '合计' }];
assert.equal((await pipeline.run(large)).text, options.fallback);
count++;

// 跟进全部删除时必须留空，不能兜底、转人工或写 guardHit；事件仍只一行。
const followup = loadGuardPipeline([moneyProvenanceFollowupStep(options, () => sources)]);
for (const [text, expected] of [
  ['单价3.80元。', ''],
  ['单价3.80元。请确认规格。', '请确认规格。'],
  ['单价3块8毛。', ''],
  ['单价12.5元/件。', ''],
  ['单价3块6毛5。运费10元。交期3.5天，型号M8×30。', '单价3块6毛5。运费10元。交期3.5天，型号M8×30。'],
]) {
  events.length = 0;
  const ctx = context(text!);
  const result = await followup.run(ctx);
  assert.equal(result.text, expected);
  const action = text === expected ? 'pass' : 'drop_sentence';
  assert.deepEqual(result.verdicts, [{ id: 'money_provenance', action }]);
  assert.equal(ctx.turn.flags.guardHit, null);
  assert.equal(ctx.session.handedOver, false);
  assert.equal(events.length, action === 'pass' ? 0 : 1);
  if (events.length) assert.equal(events[0]!.action, 'drop_sentence');
  count++;
}
// 跟进同样认会话订单。
const followOrder = context('合计1330元。');
followOrder.session.orderIds = [order.id];
assert.equal((await followup.run(followOrder)).text, '合计1330元。');
count++;

// 装载即拒绝：少 after、少写声明、放在后置接管或失败计数之后、缺安全尾部。
for (const bad of [
  [noop('stage_advance'), { ...main, after: [] }, noop('takeover_check:post'), noop('turn_failure')],
  [noop('stage_advance'), { ...main, writes: [] }, noop('takeover_check:post'), noop('turn_failure')],
  [noop('stage_advance'), noop('takeover_check:post'), main, noop('turn_failure')],
  [noop('stage_advance'), noop('takeover_check:post'), noop('turn_failure'), main],
  [main, noop('stage_advance'), noop('takeover_check:post'), noop('turn_failure')],
  [noop('stage_advance'), main],
]) {
  assert.throws(() => loadGuardPipeline(bad), /money_provenance/);
  count++;
}
console.log(`money provenance selftest: ${count} 组通过（主回复、跟进、来源隔离与位置拒绝）`);
