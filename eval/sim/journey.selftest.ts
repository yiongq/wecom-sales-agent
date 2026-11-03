// 16 R1–R3：假模型走真实引擎与审批入口，不调用外部服务。
import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LineOrder } from '../../src/core/order-view.js';
import { loadGoals, validateGoal, type JourneyEnd, type SimGoal } from './goals.js';
import { engineRuntime, SalesTurnError } from './runtime.js';
import { Meter, simulate, summaryTable, type RunResult, type SimDeps, type FailBucket, type RunStatus } from './runner.js';
import { fakeService, fakeEnv, fakePrices, say } from './fake.js';
import { judgeJourney } from './journey.js';
import type { SimTurn, Snapshot } from './judge.js';

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✔ ${name}`);
}
const empty: Snapshot = { orders: [], handedOver: false, handoff: null, stage: 'greeting' };
function goal(expect: JourneyEnd = { end: 'quote_accepted', lines: [{ code: 'bearing-02', qty: 2 }], totalFen: 2000 }): SimGoal {
  return validateGoal(
    {
      id: 'journey-test',
      persona: '合成询价客户，问到再补充数量。',
      pack: 'industrial',
      maxTurns: 6,
      journey: {
        family: 'standard',
        split: 'dev',
        expect,
        facts: [],
        baselineScript: ['6205-2RS 两件'],
        ...(expect.end === 'quote_accepted' ? { approver: { decision: 'approve' } } : {}),
        ...(expect.end === 'quote_rejected' ? { approver: { decision: 'reject', reason: '需要核对' } } : {}),
      },
    },
    'synthetic.json',
  );
}
function order(): LineOrder {
  return {
    v: 2,
    id: 'ord_0123456789abcdef01234567',
    sessionId: 'sim-test',
    createdAt: 10,
    status: 'pending_payment',
    totalFen: 2000,
    lines: [{ kind: 'part', code: 'bearing-02', qty: 2, title: '6205-2RS', unit: '件', unitPriceFen: 1000, amountFen: 2000 }],
    approval: { state: 'approved', requestedAt: 1, decidedAt: 2, decidedBy: { userId: null, name: '审批替身' }, acceptedAt: 3 },
  };
}
function turn(reply = '请确认报价', customer = '6205-2RS 两件', state: Snapshot = empty): SimTurn {
  return {
    customer: { say: customer, done: false },
    reply,
    silent: false,
    state: structuredClone(state),
    trace: {
      turn: {
        turnId: 'test',
        conversationId: 'sim-test',
        startedAt: 1,
        sopVersion: null,
        prefixHash: '',
        catalogVersions: {},
        calls: [],
        llm: [],
        guards: [],
        guardVerdicts: null,
        draft: reply,
      },
      outcome: 'replied',
      finalText: reply,
      stageBefore: 'greeting',
      stageAfter: 'greeting',
      durationMs: 5,
      signals: null,
      input: customer,
    },
  };
}
function run(state: Snapshot = { ...empty, orders: [order()] }): RunResult {
  return {
    goalId: 'journey-test',
    repetition: 1,
    initial: structuredClone(empty),
    finalState: structuredClone(state),
    turns: [turn()],
    status: 'failed',
    endedBy: 'done',
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
  };
}
function expectVerdict(name: string, g: SimGoal, r: RunResult, status: RunStatus, bucket?: FailBucket): void {
  check(name, () =>
    assert.deepEqual(judgeJourney(g, r), { status, ...(bucket ? { bucket } : {}), reasons: status === 'passed' ? [] : [bucket ?? status] }),
  );
}
const accepted = goal();
const acceptedRun = run();
const pending = order();
pending.approval = { state: 'pending', requestedAt: 1 };
const pendingState = { ...empty, orders: [pending] };
const handoff: Snapshot = { ...empty, handedOver: true, handoff: { kind: 'agent', at: 1, reason: '顾问接手' } };
const rejected = goal({ end: 'quote_rejected' });
const rejectedOrder = order();
rejectedOrder.status = 'cancelled';
rejectedOrder.approval!.state = 'rejected';
const rejectedState = { ...handoff, orders: [rejectedOrder] };
const human = goal({ end: 'handoff', kinds: ['agent'] });
const noQuote = goal({ end: 'no_quote', evidence: { tool: 'find_parts', reply: '未查到' } });
const noQuoteRun = run(empty);
noQuoteRun.turns = [turn('未查到')];
noQuoteRun.turns[0]!.trace.turn.calls = [
  { name: 'find_parts', args: {}, ms: 1, prefetch: false, resultHead: '{}', resultBytes: 2, startedAt: 1 },
];

// R3 顺序表：前面的错误盖过后面的终态 / 客户偏离。
const violation = {
  id: 'test',
  rule: 'markdown' as const,
  level: 'code' as const,
  source: 'final' as const,
  goalId: 'journey-test',
  repetition: 1,
  turn: 1,
  detail: 'test',
};
expectVerdict(
  '顺序 0 budget_stop',
  accepted,
  { ...acceptedRun, status: 'budget_stop', endedBy: 'runner_error', findings: [violation] },
  'budget_stop',
);
for (const status of ['customer_protocol', 'customer_http'] as const)
  expectVerdict(
    `顺序 1 ${status}`,
    accepted,
    { ...acceptedRun, status, endedBy: 'runner_error', failedTurn: { ...turn().trace, outcome: 'error' } },
    status,
  );
expectVerdict(
  '顺序 2 outcome error',
  accepted,
  { ...acceptedRun, failedTurn: { ...turn().trace, outcome: 'error' }, endedBy: 'runner_error' },
  'failed',
  'model_error',
);
const llmFailed = turn().trace;
llmFailed.turn.llm = [
  {
    model: 'fake',
    hedged: false,
    ms: 1,
    tools: [],
    toolMs: 0,
    reused: [],
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    error: 'http_5xx',
    startedAt: 1,
  },
];
expectVerdict('顺序 2 llm error', accepted, { ...acceptedRun, failedTurn: llmFailed, endedBy: 'runner_error' }, 'failed', 'model_error');
expectVerdict(
  '顺序 3 runner_error',
  accepted,
  { ...acceptedRun, failedTurn: turn().trace, endedBy: 'runner_error', findings: [violation] },
  'failed',
  'runner_error',
);
expectVerdict('顺序 4 code final', accepted, { ...acceptedRun, findings: [violation] }, 'failed', 'rule_violation');
expectVerdict('顺序 5 终态通过，轮数用尽也通过', accepted, { ...acceptedRun, endedBy: 'maxTurns' }, 'passed');
expectVerdict(
  '原稿与疑似不降级',
  accepted,
  {
    ...acceptedRun,
    findings: [
      { ...violation, source: 'draft' },
      { ...violation, level: 'suspect' },
    ],
  },
  'passed',
);
// 16 开发集：单、批准、确认都对，顾问接手付款不算失败。
expectVerdict('quote_accepted 确认后转人工仍通过', accepted, run({ ...handoff, orders: [order()] }), 'passed');
expectVerdict('quote_rejected 通过', rejected, run(rejectedState), 'passed');
expectVerdict('handoff 通过', human, run(handoff), 'passed');
expectVerdict('no_quote 两项证据都满足', noQuote, noQuoteRun, 'passed');

const failureCases: [string, SimGoal, Snapshot, FailBucket][] = [
  ['accepted 多转优先', accepted, { ...handoff, orders: [pending] }, 'unneeded_handoff'],
  ['accepted 缺单', accepted, empty, 'quote_missing'],
  ['accepted 行错误', accepted, { ...empty, orders: [{ ...order(), lines: [{ ...order().lines[0], qty: 3 }] }] }, 'wrong_lines'],
  ['accepted 金额错误', accepted, { ...empty, orders: [{ ...order(), totalFen: 3000 }] }, 'wrong_total'],
  ['accepted 未批准', accepted, pendingState, 'not_approved'],
  [
    'accepted 未确认',
    accepted,
    { ...empty, orders: [{ ...order(), approval: { ...order().approval!, acceptedAt: undefined } }] },
    'not_accepted',
  ],
  ['rejected 缺单', rejected, empty, 'quote_missing'],
  ['rejected 未驳回', rejected, { ...empty, orders: [order()] }, 'not_rejected'],
  ['rejected 未转人工', rejected, { ...empty, orders: [rejectedOrder] }, 'not_rejected'],
  ['handoff 漏转', human, empty, 'missed_handoff'],
  ['handoff 错误类型', human, { ...handoff, handoff: { ...handoff.handoff!, kind: 'request' } }, 'wrong_handoff'],
  ['handoff 有待审单', human, { ...handoff, orders: [pending] }, 'unexpected_quote'],
  ['handoff 有有效单', human, { ...handoff, orders: [order()] }, 'unexpected_quote'],
  ['no_quote 多转', noQuote, handoff, 'unneeded_handoff'],
  ['no_quote 建过单', noQuote, { ...empty, orders: [rejectedOrder] }, 'unexpected_quote'],
  ['no_quote 缺证据', noQuote, empty, 'no_evidence'],
];
for (const [name, g, state, bucket] of failureCases) expectVerdict(`失败桶 ${name}`, g, run(state), 'failed', bucket);
expectVerdict(
  'no_quote 预取不算证据',
  noQuote,
  {
    ...noQuoteRun,
    turns: [
      {
        ...noQuoteRun.turns[0]!,
        trace: {
          ...noQuoteRun.turns[0]!.trace,
          turn: { ...noQuoteRun.turns[0]!.trace.turn, calls: noQuoteRun.turns[0]!.trace.turn.calls.map((c) => ({ ...c, prefetch: true })) },
        },
      },
    ],
  },
  'failed',
  'no_evidence',
);
expectVerdict(
  'no_quote 缺文字证据',
  noQuote,
  { ...noQuoteRun, turns: [{ ...noQuoteRun.turns[0]!, reply: '请稍候' }] },
  'failed',
  'no_evidence',
);
expectVerdict(
  'no_quote 静默不算文字证据',
  noQuote,
  { ...noQuoteRun, turns: [{ ...noQuoteRun.turns[0]!, silent: true }] },
  'failed',
  'no_evidence',
);
const wrongActor = order();
wrongActor.approval!.decidedBy!.name = '其他人';
expectVerdict('批准人必须是常量审批替身', accepted, run({ ...empty, orders: [wrongActor] }), 'failed', 'not_approved');
expectVerdict(
  '被替代旧单不影响成交',
  accepted,
  run({ ...empty, orders: [{ ...order(), status: 'superseded', supersededBy: order().id, createdAt: 20 }, order()] }),
  'passed',
);
expectVerdict('最新按 createdAt 而非数组顺序', accepted, run({ ...empty, orders: [order(), { ...pending, createdAt: 1 }] }), 'passed');
expectVerdict('同终态换话术仍通过', accepted, { ...acceptedRun, turns: [turn('已经收到，稍后联系您')] }, 'passed');
const multi = order();
multi.lines.push({ ...multi.lines[0], code: 'second' });
expectVerdict(
  '报价行比较不看顺序',
  goal({
    end: 'quote_accepted',
    lines: [
      { code: 'second', qty: 2 },
      { code: 'bearing-02', qty: 2 },
    ],
    totalFen: 2000,
  }),
  run({ ...empty, orders: [multi] }),
  'passed',
);

const facts = goal();
facts.journey!.facts = [{ fact: '19\\s*(件|PCS)', asked: '多少件|HOW MANY' }];
expectVerdict(
  '顺序 6 问过后遗漏事实',
  facts,
  { ...run(empty), turns: [turn('请问需要多少件？', '6205-2RS'), turn('再见', '再见')], endedBy: 'maxTurns' },
  'customer_drift',
);
expectVerdict('顺序 7 从没问数量，客户结束', facts, { ...run(empty), turns: [turn('您好', '再见')] }, 'failed', 'quote_missing');
expectVerdict(
  'asked / fact 忽略大小写、客户先说过',
  facts,
  { ...run(empty), turns: [turn('how many?', '需要19pcs'), turn('收到19pcs', '谢谢')] },
  'failed',
  'quote_missing',
);
expectVerdict(
  '销售复述不算客户事实',
  facts,
  { ...run(empty), turns: [turn('需要多少件？', '轴承'), turn('19件可以吗', '再见')] },
  'customer_drift',
);
expectVerdict(
  '销售静默不算问过',
  facts,
  { ...run(empty), turns: [{ ...turn('多少件', '再见'), silent: true }] },
  'failed',
  'quote_missing',
);
expectVerdict(
  '问过后误转人工不剔除',
  facts,
  { ...run(handoff), turns: [turn('多少件', '轴承')], endedBy: 'handoff' },
  'failed',
  'unneeded_handoff',
);
expectVerdict('终态通过优先于客户事实遗漏', facts, { ...acceptedRun, turns: [turn('多少件', '你好')] }, 'passed');
const afterApproval = order();
delete afterApproval.approval!.acceptedAt;
const afterApprovalState = { ...empty, orders: [afterApproval] };
const silentExit = { ...run(afterApprovalState), turns: [turn('待审核', '正式报价', pendingState)], leftSilently: true as const };
expectVerdict('第二种 drift：通知后无话离开', accepted, silentExit, 'customer_drift');
expectVerdict(
  '批准落在最后轮、轮数用尽不剔除',
  accepted,
  { ...silentExit, leftSilently: undefined, endedBy: 'maxTurns' },
  'failed',
  'not_accepted',
);
expectVerdict(
  '批准后说过话再结束不剔除',
  accepted,
  { ...silentExit, turns: [...silentExit.turns, turn('收到', '谢谢', afterApprovalState)] },
  'failed',
  'not_accepted',
);

const env = { ...process.env };
const sales = await fakeService();
const customer = await fakeService();
fakeEnv(sales.url, customer.url);
try {
  const meter = new Meter(1);
  const runtime = await engineRuntime(meter, 'sim-fake-customer', fakePrices);
  try {
    const goals = await loadGoals('eval/sim/goals/quality/26-post-handoff-silence.json');
    const report = await simulate(goals, 1, meter, runtime.deps);
    const run = report.runs[0]!;
    const baseline = { status: run.status, turns: run.turns.length, customer: customer.requests.length, sales: sales.requests.length };
    console.log('qa-post-handoff-silence baseline:', baseline);
    assert.deepEqual(baseline, { status: 'passed', turns: 3, customer: 0, sales: 0 });
    check('旧目标输出不加 journey 字段', () => {
      assert.equal(Object.hasOwn(run, 'finalState'), false);
      assert.equal(Object.hasOwn(run, 'notices'), false);
      assert.equal(Object.hasOwn(report, 'customer_http'), false);
      assert.equal(Object.hasOwn(report.summary[0]!, 'customer_drift'), false);
      assert.doesNotMatch(summaryTable(report), /customer_http|customer_drift/);
    });
  } finally {
    await runtime.close();
  }

  await fs.mkdir('var', { recursive: true });
  const temp = await fs.mkdtemp(path.join('var', 'journey-selftest-'));
  try {
    const dev = path.join(temp, 'journey', 'dev');
    await fs.mkdir(dev, { recursive: true });
    const file = path.join(dev, 'one.json');
    await fs.writeFile(file, JSON.stringify(goal()));
    assert.equal((await loadGoals(dev))[0]!.journey!.split, 'dev');
    const wrong = goal();
    wrong.journey!.split = 'holdout';
    await fs.writeFile(file, JSON.stringify(wrong));
    await assert.rejects(loadGoals(file), /journey.split 与目录不一致/);
    console.log('✔ loadGoals 校验目录 split');
    checks++;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }

  // 客户问题单列、重跑保留原记录，外层费用只计一次。
  const catalog = JSON.parse(await fs.readFile('data/packs/industrial/catalog/part.json', 'utf8')) as SimDeps['catalog'];
  const mockDeps = (overrides: Partial<SimDeps> = {}): SimDeps => ({
    customerModel: 'fake',
    pack: 'industrial',
    catalog,
    price: () => 0.001,
    customer: async () => ({ raw: '{', tokens: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0 } }),
    start: () => ({ id: 'sim-test', initial: structuredClone(empty) }),
    sales: async (_id, message) => turn('需要多少件？', message.say),
    end: async () => {},
    ...overrides,
  });
  const protocol = await simulate([goal()], 1, new Meter(1), mockDeps());
  check('整遍重跑保留 replaced、wasReplaced、审计与费用', () => {
    const r = protocol.runs[0]!;
    assert.equal(r.status, 'customer_protocol');
    assert.equal(r.rerun, true);
    assert.equal(r.replaced!.wasReplaced, true);
    assert.deepEqual(r.replaced!.findings, []);
    assert.equal(r.replaced!.charges.length, 2);
    assert.equal(r.charges.length, 4);
    assert.equal(protocol.cost.total, 0.004);
    assert.deepEqual(r.finalState, empty);
    assert.equal(protocol.summary[0]!.denominator, 0);
  });
  const http = await simulate(
    [goal()],
    1,
    new Meter(1),
    mockDeps({
      customer: async () => {
        throw new Error('customer_http');
      },
    }),
  );
  check('customer_http 单列且不重跑、不进分母', () => {
    assert.equal(http.runs[0]!.status, 'customer_http');
    assert.equal(http.runs[0]!.rerun, false);
    assert.equal(http.summary[0]!.customer_http, 1);
    assert.equal(http.customer_http, 1);
    assert.equal(http.summary[0]!.denominator, 0);
    assert.match(summaryTable(http), /customer_http=1; customer_drift=0/);
  });
  const driftGoal = goal();
  driftGoal.customerScript = ['6205-2RS'];
  driftGoal.journey!.facts = [{ fact: '19件', asked: '多少件' }];
  const drift = await simulate(
    [driftGoal],
    1,
    new Meter(1),
    mockDeps({
      customer: async () => ({
        raw: JSON.stringify({ say: '', done: true }),
        tokens: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
      }),
    }),
  );
  check('customer_drift 单列、不进分母、空结束写 leftSilently', () => {
    assert.equal(drift.runs[0]!.status, 'customer_drift');
    assert.equal(drift.runs[0]!.leftSilently, true);
    assert.equal(drift.summary[0]!.customer_drift, 1);
    assert.equal(drift.summary[0]!.denominator, 0);
    assert.equal(drift.summary[0]!.failed, 0);
  });
  const brokenGoal = goal();
  brokenGoal.customerScript = ['咨询'];
  const broken = await simulate(
    [brokenGoal],
    1,
    new Meter(1),
    mockDeps({
      sales: async () => {
        throw new SalesTurnError(new Error('fake'), turn().trace);
      },
    }),
  );
  check('销售非错误 trace 的异常归 runner_error', () => assert.equal(broken.runs[0]!.bucket, 'runner_error'));
  const budgetMeter = new Meter(0.001);
  const budget = await simulate([goal()], 1, budgetMeter, mockDeps());
  check('预算截断优先于客户协议失败', () => assert.equal(budget.runs[0]!.status, 'budget_stop'));

  let decisions = 0;
  const stopGoal = goal({ end: 'quote_rejected' });
  stopGoal.customerScript = ['正式报价'];
  const twoPending = { ...empty, orders: [pending, { ...pending, id: 'ord_abcdef0123456789abcdef01' }] };
  const stopped = await simulate(
    [stopGoal],
    1,
    new Meter(1),
    mockDeps({
      sales: async () => turn('待审核', '正式报价', twoPending),
      decide: async () => {
        decisions++;
        return { notice: '驳回通知', state: rejectedState };
      },
    }),
  );
  check('审批引发转人工后不再决定下一张单', () => {
    assert.equal(decisions, 1);
    assert.equal(stopped.runs[0]!.endedBy, 'handoff');
    assert.equal(stopped.runs[0]!.status, 'passed');
  });

  const industrialMeter = new Meter(10);
  const industrial = await engineRuntime(industrialMeter, 'sim-fake-customer', fakePrices, { configDir: 'data/packs/industrial' });
  try {
    check('审计产品库直接读取配置目录 JSON', () => assert.ok(industrial.deps.catalog!.length === 40));
    const enqueueQuote = () => {
      customer.script.push(say('6205-2RS'), say('6205-2RS 2件'), say('请出正式报价单'));
      sales.script.push(
        { content: '您需要多少件？' },
        { content: '6205-2RS 2件，单价10元，合计20元。需要正式报价单吗？' },
        { tools: [{ name: 'create_quote_sheet', args: { items: [{ code: 'bearing-02', qty: 2 }] } }] },
        { content: '最新的报价单还在顾问审核，审好马上发您' },
      );
    };
    enqueueQuote();
    customer.script.push(say('确认下单', true));
    const buyGoal = goal();
    // journey 的终态判分不受旧谓词、禁词和工具白名单影响。
    buyGoal.predicates = [{ kind: 'order', count: 0 }];
    buyGoal.forbidden = ['顾问'];
    const bought = (await simulate([buyGoal], 1, industrialMeter, industrial.deps)).runs[0]!;
    check('验收 1 询价→试算→建单→真实批准→客户确认', () => {
      assert.equal(bought.status, 'passed', JSON.stringify(bought.reasons));
      assert.equal(bought.turns.length, 4);
      const final = bought.finalState!.orders[0] as LineOrder;
      assert.equal(final.approval!.decidedBy!.name, '审批替身');
      assert.ok(final.approval!.acceptedAt);
      assert.equal(final.totalFen, 2000);
      assert.deepEqual(bought.decided, [{ orderId: final.id, decision: 'approve' }]);
      const history = customer.requests.at(-1)!.messages;
      const notice = bought.notices![0]!;
      assert.match(notice, /报价单 · 1 项/);
      assert.match(notice, /合计 20元/);
      assert.match(notice, /有效期至/);
      assert.ok(history.some((m) => m.role === 'user' && m.content === notice));
      assert.equal(bought.turns[2]!.state.orders[0]!.status, 'pending_payment');
      assert.equal((bought.turns[2]!.state.orders[0] as LineOrder).approval!.state, 'pending');
      assert.ok(bought.turns.flatMap((t) => t.trace.turn.calls).some((c) => c.name === 'quote_items'));
      assert.equal(sales.script.length, 0);
      assert.equal(customer.script.length, 0);
    });

    enqueueQuote();
    const rejectedRun = (await simulate([goal({ end: 'quote_rejected' })], 1, industrialMeter, industrial.deps)).runs[0]!;
    check('验收 2 真实驳回后的终态、通知与即时停止', () => {
      assert.equal(rejectedRun.status, 'passed', JSON.stringify(rejectedRun.reasons));
      assert.equal(rejectedRun.endedBy, 'handoff');
      assert.equal(rejectedRun.turns.length, 3);
      assert.equal(rejectedRun.finalState!.orders[0]!.status, 'cancelled');
      assert.equal(rejectedRun.finalState!.handoff!.kind, 'agent');
      assert.equal((rejectedRun.finalState!.orders[0] as LineOrder).approval!.decidedBy!.name, '审批替身');
      assert.deepEqual(rejectedRun.notices, ['这份报价需要顾问再核对一下，顾问会直接联系您']);
      assert.equal(rejectedRun.turns.at(-1)!.state.handedOver, false);
      assert.equal(sales.script.length, 0);
      assert.equal(customer.script.length, 0);
    });

    const before = { sales: sales.requests.length, customer: customer.requests.length };
    const attachmentHandoff = goal({ end: 'handoff', kinds: ['request'] });
    attachmentHandoff.customerScript = [{ say: '我要人工客服，请转人工', attach: 'rfq-small.xlsx' }];
    const handed = (await simulate([attachmentHandoff], 1, industrialMeter, industrial.deps)).runs[0]!;
    check('验收 3 转人工后不发同轮附件、不调任何模型', () => {
      assert.equal(handed.status, 'passed');
      assert.equal(handed.endedBy, 'handoff');
      assert.equal(handed.turns.length, 1);
      assert.equal(handed.turns[0]!.customer.say, '我要人工客服，请转人工');
      assert.deepEqual({ sales: sales.requests.length, customer: customer.requests.length }, before);
    });

    // 假服务脚本用尽返回 500；仍走真实 sales / handleMessage / trace 错误路径。
    const failure = goal();
    failure.customerScript = ['6205-2RS'];
    const errored = (await simulate([failure], 1, industrialMeter, industrial.deps)).runs[0]!;
    check('验收 4 假 HTTP 500 经真实引擎归 model_error', () => {
      assert.equal(errored.status, 'failed');
      assert.equal(errored.bucket, 'model_error');
      assert.ok(errored.failedTurn);
      assert.ok(errored.failedTurn.turn.llm.some((c) => c.error === 'http_5xx'));
      assert.equal(errored.turns.length, 0);
      assert.deepEqual(errored.finalState, errored.initial);
    });
  } finally {
    await industrial.close();
  }
  console.log(`journey selftest: ${checks} checks passed`);
} finally {
  await sales.close();
  await customer.close();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
