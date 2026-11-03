// 08 R8：两个工厂的删句、兜底、金额来源与步骤位置契约。
import assert from 'node:assert/strict';
import type { GuardStep, MoneyEntry, ReplyGuardContext, StepVerdict } from '../pack-api.js';
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

// 16 验收：括号旁注编了数时只删旁注，括号外全有出处的价格保得住；括号外没有出处还是整句删。
await check('单价 3.65 元（税前 3.23 元），现货。', '单价 3.65 元，现货。', 'drop_sentence');
await check('单价 3.65 元（含税，税前 3.23 元）。请确认规格。', '单价 3.65 元。请确认规格。', 'drop_sentence');
await check('单价 3.65 元（含税）。', '单价 3.65 元（含税）。', 'pass');
await check('单价 3.65 元（含税）（税前 3.23 元）。', '单价 3.65 元（含税）。', 'drop_sentence');
await check('单价 3.80 元（税前 3.23 元）。继续核验。', '继续核验。', 'drop_sentence');
await check('（税前 3.23 元）请确认规格。继续核验。', '继续核验。', 'drop_sentence');
await check('单价 3.65 元（税前 3.23 元），合计 7.30 元。继续核验。', '继续核验。', 'drop_sentence');

// 16 验收：标题下面的内容删光时标题一起删，不留「试算结果：」；下面还有内容就保留。
await check('试算结果如下：\n单价 3.80 元。\n请确认规格。', '请确认规格。', 'drop_sentence');
await check('请确认规格。\n试算结果：单价 3.80 元。', '请确认规格。\n', 'drop_sentence');
await check('试算结果：\n单价 3.65 元。\n单价 3.80 元。', '试算结果：\n单价 3.65 元。\n', 'drop_sentence');
await check('试算结果：\n单价 3.80 元。', options.fallback, 'replace');
await check('试算结果：\n\n单价 3.80 元。\n\n需要起草吗？', '需要起草吗？', 'drop_sentence');
await check('请核对：\n型号 6205。', '请核对：\n型号 6205。', 'pass');

// 16 验收：拒绝的话带着没出处的金额时换成包给的固定句，客户不至于没等到答复；固定句不带数，放行集合不变。
const refusal = '价格按数量档位执行。';
const refusing = loadGuardPipeline([
  noop('stage_advance'),
  moneyProvenanceStep({ ...options, refusal }, () => sources),
  noop('takeover_check:post'),
  noop('turn_failure'),
]);
for (const [text, expected] of [
  ['抱歉，没法按1元一件报。请确认规格。', `${refusal}请确认规格。`],
  ['没法按1元一件报\n请确认规格。', `${refusal}\n请确认规格。`],
  ['550元这个整数额优惠给不了。', refusal],
  ['我不能改成1元或自行调价。', refusal],
  ['这个价做不到，90元实在不行。', refusal],
  // 暗示底价的说法同样不留数。
  ['不能低于9元。', refusal],
  // 一条回复只说一次。
  ['无法按1元报价。也不能给到2元。请确认规格。', `${refusal}请确认规格。`],
  // 「能不能」「可不可以」是在问，不是拒绝。
  ['能不能给到1.5元？请确认规格。', '请确认规格。'],
  ['可不可以按1.5元？请确认规格。', '请确认规格。'],
  // 不是拒绝的编价照旧删。
  ['可以按1.5元。请确认规格。', '请确认规格。'],
  // 拒绝的话里没有金额，或金额都有出处，不用动。
  ['价格不能改。单价 3.65 元。', '价格不能改。单价 3.65 元。'],
  ['单价 3.65 元不能改。', '单价 3.65 元不能改。'],
] as const) {
  assert.equal((await refusing.run(context(text))).text, expected, text);
  count++;
}
// 包没给固定句时拒绝的话照旧删，行为不变。
await check('没法按1元报。请确认规格。', '请确认规格。', 'drop_sentence');

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

// 型号绑定：同一套用例同时约束主回复与跟进，仍按原来的句子单位删句。
const subjectMentions = (text: string) =>
  [...text.matchAll(/A100|B200|C300|ALIAS-A/g)].map((match) => ({
    subject: match[0] === 'ALIAS-A' ? 'A100' : match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
const boundLedger: MoneyEntry[] = [
  { fen: 365, label: '单价', subject: 'A100' },
  { fen: 1200, label: '单价', subject: 'B200' },
  { fen: 133000, label: '合计' },
];
const approved: LineOrder = {
  ...order,
  approval: { state: 'approved', requestedAt: 0, decidedAt: 0 },
  lines: [
    { ...order.lines[0], title: 'A100' },
    { ...order.lines[1], title: 'B200' },
  ],
};
const boundSources = { ...sources, getOrder: (id: string) => (id === approved.id ? approved : undefined) };
for (const mode of ['reply', 'followup'] as const) {
  const step =
    mode === 'reply'
      ? moneyProvenanceStep({ ...options, subjectMentions }, () => boundSources)
      : moneyProvenanceFollowupStep({ ...options, subjectMentions }, () => boundSources);
  const empty = mode === 'reply' ? options.fallback : '';
  const cases: { text: string; expected?: string; ledger?: MoneyEntry[]; ordered?: boolean }[] = [
    { text: 'A100单价12元。B200单价3.65元。', expected: empty },
    { text: 'A100单价3.65元。B200单价12元。' },
    { text: 'A100单价3.80元。', expected: empty },
    { text: 'A100单价12元，B200单价12元。', ledger: [...boundLedger, { fen: 1200, label: '同价', subject: 'A100' }] },
    { text: 'A100单价3.65元，B200单价3.65元。继续核验。', expected: '继续核验。' },
    { text: 'A100单价3.65元，B200单价12元。' },
    { text: 'A100单价12元，B200单价3.65元。继续核验。', expected: '继续核验。' },
    { text: 'A100合计1330元。' },
    { text: '单价12元。单价3.65元。' },
    { text: 'ALIAS-A单价3.65元。' },
    { text: 'ALIAS-A单价12元。', expected: empty },
    { text: 'A100单价12元。', ledger: [{ fen: 1200, label: '旧账本' }] },
    { text: 'A100单价12元。', ledger: [...boundLedger, { fen: 1200, label: '旧账本' }] },
    { text: 'A100运费10元。' },
    { text: '单价12元，A100。' },
    { text: 'A100。单价12元。' },
    // 同一分句优先；没有型号的分句往同一句左侧找，逗号/分号/顿号均不清空关联。
    ...['，', ',', '；', ';', '、'].flatMap((mark) => [
      { text: `A100${mark}单价12元。`, expected: empty },
      { text: `A100${mark}单价3.65元${mark}B200单价12元。` },
    ]),
    { text: 'A100 B200单价3.65元。' },
    { text: 'A100和B200的单价分别为3.65元、12元。' },
    // 多型号列表拿不准关联：即使数值互换也放行，这是避免误杀的代价。
    { text: 'A100和B200的单价分别为12元、3.65元。' },
    // 多型号组完全跳过错配；数值已有出处即可，即便出处属于组外的型号。
    { text: 'A100和B200单价3元。', ledger: [{ fen: 300, label: '单价', subject: 'C300' }] },
    {
      text: 'A100、B200、C300分别为1元、2元、3元。',
      ledger: [
        { fen: 100, label: '单价', subject: 'A100' },
        { fen: 200, label: '单价', subject: 'B200' },
        { fen: 300, label: '单价', subject: 'C300' },
      ],
    },
    { text: 'A100和B200一共15.65元，A100单价12元。', ledger: [...boundLedger, { fen: 1565, label: '合计' }], expected: empty },
    // 同一型号及其别名不构成多个不同对象；列表也不能放行没有出处的数。
    { text: 'A100和ALIAS-A单价12元。', expected: empty },
    { text: 'A100和B200单价3.80元。', expected: empty },
    { text: 'A100单价3块6毛5，B200单价12元。' },
    { text: 'A100单价3.65元（B200单价3.65元）。', expected: 'A100单价3.65元。' },
    { text: 'A100单价3.65元（B200单价12元）。' },
    { text: '试算结果：\nA100单价12元。\n请确认规格。', expected: '请确认规格。' },
    { text: 'A100单价12元。B200单价3.65元。', ledger: [], ordered: true, expected: empty },
    { text: 'A100行金额600元。B200行金额730元。', ledger: [], ordered: true, expected: empty },
    { text: 'A100单价3.65元、行金额730元，B200单价12元、行金额600元。', ledger: [], ordered: true },
    { text: 'A100合计1330元。', ledger: [], ordered: true },
  ];
  for (const { text, expected = text, ledger = boundLedger, ordered: useOrder } of cases) {
    const ctx = context(text);
    ctx.session.moneyLedger = ledger;
    if (useOrder) ctx.session.orderIds = [approved.id];
    const result = await step.run(ctx);
    assert.ok(result && result.action !== 'abort');
    assert.equal(result.action === 'pass' ? text : result.text, expected, `${mode}: ${text}`);
    assert.equal(result.action, text === expected ? 'pass' : mode === 'reply' && expected === empty ? 'replace' : 'drop_sentence');
    count++;
  }
  // 不提供识别能力的包，即便账本带 subject，错配外观也维持原来的数值判定与输出字节。
  const legacy = mode === 'reply' ? moneyProvenanceStep(options, () => sources) : moneyProvenanceFollowupStep(options, () => sources);
  const ctx = context('  A100单价12元，B200单价3.65元。\n');
  ctx.session.moneyLedger = boundLedger;
  assert.deepEqual(await legacy.run(ctx), { action: 'pass' });
  count++;

  let calls = 0;
  const skipOptions = {
    ...options,
    subjectMentions: (text: string) => {
      calls++;
      return subjectMentions(text);
    },
  };
  const skip =
    mode === 'reply' ? moneyProvenanceStep(skipOptions, () => boundSources) : moneyProvenanceFollowupStep(skipOptions, () => boundSources);
  const noMoney = context('A100和B200请核对规格。');
  noMoney.session.orderIds = [approved.id];
  assert.deepEqual(await skip.run(noMoney), { action: 'pass' });
  assert.equal(calls, 0, '无金额回复不识别型号，也不识别订单行');
  const mixed = context('请核对规格。A100单价3.65元。');
  mixed.session.moneyLedger = boundLedger;
  assert.deepEqual(await skip.run(mixed), { action: 'pass' });
  assert.equal(calls, 1, '只识别含金额的句子');
  count += 2;
}

// 接受轮只认接受单、静态金额和本轮新增条目；历史试算含真实的行金额与合计形状。
{
  const old: LineOrder = {
    ...approved,
    id: 'ord_old',
    status: 'superseded',
    supersededBy: 'ord_current',
    totalFen: 28360,
    lines: [{ ...approved.lines[0]!, title: 'A100', qty: 20, unitPriceFen: 1418, amountFen: 28360 }],
  };
  const current: LineOrder = {
    ...approved,
    id: 'ord_current',
    totalFen: 44928,
    lines: [{ ...approved.lines[0]!, title: 'B200', qty: 26, unitPriceFen: 1728, amountFen: 44928 }],
  };
  const reads = { ...sources, getOrder: (id: string) => [old, current].find((order) => order.id === id) };
  const acceptedFallback = '已记下接受，顾问将联系您。';
  const step = moneyProvenanceStep({ ...options, subjectMentions, acceptedFallback }, () => reads);
  for (const [text, expected] of [
    ['货款283.60元。', acceptedFallback],
    ['A100货款283.60元。', acceptedFallback],
    ['B200货款283.60元。', acceptedFallback],
    ['B200单价17.28元，行金额449.28元，合计449.28元，运费10元。', undefined],
    ['A100货款30元。', undefined],
  ] as const) {
    const ctx = context(text);
    ctx.acceptingOrderId = current.id;
    ctx.turnMoney = () => [
      { fen: 3000, label: '试算行金额', subject: 'A100' },
      { fen: 3000, label: '试算合计', subject: 'A100' },
    ];
    ctx.session.orderIds = [old.id, current.id];
    ctx.session.moneyLedger = [
      { fen: 1418, label: '试算单价', subject: 'A100' },
      { fen: 28360, label: '试算行金额', subject: 'A100' },
      { fen: 28360, label: '试算合计', subject: 'A100' },
    ];
    events.length = 0;
    const result = await step.run(ctx);
    assert.ok(result && result.action !== 'abort');
    assert.equal(result.action === 'pass' ? text : result.text, expected ?? text, text);
    assert.equal(result.action, expected ? 'replace' : 'pass');
    if (expected) assert.equal(events[0]!.action, 'replace');
    count++;
  }
  // 被取代的单独立于账本不再背书；有试算账本的非接受轮仍照旧放行。
  for (const mode of ['reply', 'followup'] as const) {
    const testStep = mode === 'reply' ? step : moneyProvenanceFollowupStep({ ...options, subjectMentions }, () => reads);
    const ctx = context('A100货款283.60元。');
    ctx.session.orderIds = [old.id];
    ctx.session.moneyLedger = [];
    const result = await testStep.run(ctx);
    assert.ok(result && result.action !== 'abort' && result.action !== 'pass');
    assert.equal(result.text, mode === 'reply' ? options.fallback : '');
    ctx.session.moneyLedger = [
      { fen: 28360, label: '试算行金额', subject: 'A100' },
      { fen: 28360, label: '试算合计', subject: 'A100' },
    ];
    assert.deepEqual(await testStep.run(ctx), { action: 'pass' });
    // 单行订单的合计不能把另一个型号的金额错配洗成合法。
    ctx.session.orderIds = [current.id];
    ctx.session.moneyLedger = [];
    ctx.text = 'A100货款449.28元。';
    assert.notEqual((await testStep.run(ctx))?.action, 'pass');
    count += 3;
  }
  // 其他仍有效订单也不属于本轮接受单；没有提供 acceptedFallback 时逐字沿用旧兜底。
  const ctx = context('货款1330元。');
  ctx.acceptingOrderId = current.id;
  ctx.turnMoney = () => [];
  ctx.session.orderIds = [approved.id, current.id];
  const legacy = moneyProvenanceStep(options, () => ({ ...reads, getOrder: (id) => (id === approved.id ? approved : reads.getOrder(id)) }));
  assert.deepEqual(await legacy.run(ctx), { action: 'replace', text: options.fallback });
  count++;
}

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
