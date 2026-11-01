// 手写合成存档；不调用引擎、模型、数据库或外部服务。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './audit.js';
import type { SimGoal } from './goals.js';
import type { Snapshot, SimTurn } from './judge.js';
import type { LineOrder } from '../../src/core/order-view.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { Freeze, LedgerLine, ReviewFile, RunMeta } from './report-types.js';
import type { Charge, RunResult } from './runner.js';
import {
  buildReport,
  checkFormal,
  LIMITS,
  main,
  readJournal,
  scanPublic,
  selectSamples,
  wilson,
  zeroUpper,
  type ReportInput,
} from './report.js';
import { renderCharts, renderReport, renderSample } from './report-render.js';

// 任何意外联网都会立即使自测失败。
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('报告自测不得联网');
};
let checked = 0;
function test(name: string, body: () => void): void {
  body();
  checked++;
  console.log(`✔ ${name}`);
}
const empty: Snapshot = { orders: [], handedOver: false, handoff: null, stage: 'greeting' };
const freeze: Freeze = {
  commit: 'frozen',
  trees: { evalSim: 'eval-tree', fixtures: 'fixture-tree', packData: 'pack-tree', src: 'src-tree' },
};
const meta: RunMeta = {
  runId: 'main-2',
  head: 'actual-head',
  freezeCommit: 'frozen',
  trees: freeze.trees,
  kind: 'main',
  startedAt: '2026-11-01T00:00:00Z',
  salesModel: 'fake-sales',
  hedgeModel: 'fake-hedge',
  hedgeMs: 2000,
  customerModel: 'fake-customer',
  k: 5,
  budget: 8,
  promptHash: 'prompt-hash',
  policyHash: 'policy-hash',
  pricesCheckedAt: '2026-11-01',
};
function goal(id: string): SimGoal {
  return {
    id,
    persona: '合成客户',
    pack: 'industrial',
    allowedTools: [],
    predicates: [],
    forbidden: [],
    journey: {
      family: id === 'b' ? '转人工' : '询价',
      split: 'holdout',
      expect: { end: 'no_quote', evidence: { reply: '暂无' } },
      baselineScript: ['合成询价'],
      facts: [],
    },
  };
}
function run(goalId: string, repetition = 1, status: RunResult['status'] = 'passed'): RunResult {
  return {
    goalId,
    repetition,
    status,
    endedBy: 'done',
    initial: empty,
    turns: [],
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
    finalState: empty,
    findings: [],
    runId: meta.runId,
    ...(status === 'failed' ? { bucket: 'quote_missing' as const } : {}),
  };
}
function finding(id: string, source: Finding['source'] = 'final', level: Finding['level'] = 'suspect', goalId = 'a'): Finding {
  return {
    id,
    rule: level === 'code' ? 'price_line' : 'discount_promise',
    level,
    source,
    goalId,
    repetition: 1,
    turn: 1,
    detail: '合成命中',
  };
}
function charge(side: Charge['side'], cny: number): Charge {
  return {
    side,
    cny,
    model: `fake-${side}`,
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: side === 'sales' ? 25 : 0,
    reasoningTokens: 0,
  };
}
function turn(ms: number, outcome: FinishedTurn['outcome'] = 'replied', guardNames: string[] = [], tools: string[] = []): SimTurn {
  return {
    customer: { say: '合成客户询价', done: false },
    reply: '合成销售回复',
    silent: outcome === 'silent',
    state: empty,
    trace: {
      outcome,
      durationMs: ms,
      finalText: '合成销售回复',
      stageBefore: 'greeting',
      stageAfter: 'quote',
      signals: null,
      input: '合成客户询价',
      turn: {
        turnId: `turn-${ms}-${outcome}`,
        conversationId: 'synthetic',
        startedAt: 0,
        sopVersion: 1,
        prefixHash: '',
        catalogVersions: {},
        calls: tools.map((name) => ({ name, args: {}, ms: 0, prefetch: true, resultHead: '', resultBytes: 0, startedAt: 0 })),
        llm: [],
        guards: guardNames.map((guard) => ({ guard, action: 'replace', removed: [], added: [], at: 0 })),
        guardVerdicts: null,
        draft: null,
      },
    },
  };
}
const order: LineOrder = {
  v: 2,
  id: 'quote',
  sessionId: 'synthetic',
  lines: [{ kind: 'part', code: 'demo', title: '合成件', qty: 1, unit: '件', unitPriceFen: 100, amountFen: 100 }],
  totalFen: 100,
  status: 'pending_payment',
  createdAt: 0,
  approval: { state: 'approved', requestedAt: 0, decidedBy: { userId: null, name: '审批替身' }, acceptedAt: 0 },
};
const goals = ['a', 'b', 'c', 'd', 'v'].map(goal);
goals[1]!.journey!.modelFree = true;
goals[1]!.journey!.expect = { end: 'handoff', kinds: ['agent'] };
goals[4]!.journey!.voided = { reason: '作者场景写错，保留记录' };
const runs = goals.flatMap((g) =>
  Array.from({ length: 5 }, (_, i) =>
    run(
      g.id,
      i + 1,
      g.id === 'd'
        ? 'customer_http'
        : (g.id === 'a' && i === 4) || (g.id === 'c' && i === 3)
          ? 'failed'
          : g.id === 'c' && i === 4
            ? 'customer_drift'
            : 'passed',
    ),
  ),
);
runs[0]!.turns = [
  turn(100, 'replied', ['price', 'price'], ['quote_items']),
  turn(200, 'replied', ['price', 'shape']),
  turn(8000),
  turn(8001),
  turn(10000),
  turn(999999, 'silent'),
  turn(999999, 'deterministic'),
  turn(999999, 'handoff'),
];
runs[0]!.finalState = { ...empty, orders: [order] };
runs[0]!.decided = [{ orderId: order.id, decision: 'approve' }];
runs[0]!.charges = [charge('sales', 2), charge('customer', 1)];
runs[0]!.findings = [finding('draft', 'draft'), finding('false-positive')];
runs[0]!.replaced = {
  ...run('a'),
  wasReplaced: true,
  status: 'customer_protocol',
  findings: [finding('replaced')],
  charges: [charge('sales', 100)],
};
runs[4]!.finalState = { ...empty, handedOver: true };
runs[5]!.finalState = { ...empty, handedOver: true };
runs[10]!.findings = [finding('code', 'final', 'code', 'c')];
const review: ReviewFile = {
  causes: [{ goalId: 'a', repetition: 5, cause: 'product', note: '合成根因' }],
  verdicts: [
    { findingId: 'false-positive', verdict: 'false_positive', reason: '只是转述客户条件', by: 'reviewer' },
    { findingId: 'replaced', verdict: 'false_positive', reason: '被替换的样本也裁定', by: 'reviewer' },
  ],
  personaChecks: [
    { goalId: 'a', repetition: 1, errors: [], blocksTask: false },
    { goalId: 'c', repetition: 5, errors: ['漏条件'], blocksTask: true },
  ],
  revisions: [{ what: '产品修复', before: '原结果 50%', after: '新结果 60%', reason: '修复记录', approvedBy: 'owner' }],
  aborts: [{ runId: 'killed', reason: '合成进程被杀' }],
};
function ledgerLine(runId: string, event: LedgerLine['event'], kind: LedgerLine['kind'] = 'main'): LedgerLine {
  return {
    runId,
    event,
    kind,
    at: '2026-11-01T00:00:00Z',
    commit: 'prepared-head',
    trees: freeze.trees,
    salesModel: 'fake-sales',
    customerModel: kind === 'customer_swap' ? 'other-customer' : 'fake-customer',
    k: 5,
    budget: 8,
  };
}
const ledger = [
  ledgerLine('main-1', 'start'),
  ledgerLine('main-1', 'end'),
  ledgerLine('killed', 'start'),
  ledgerLine('main-2', 'start'),
  ledgerLine('main-2', 'end'),
  ledgerLine('swap', 'start', 'customer_swap'),
  ledgerLine('swap', 'end', 'customer_swap'),
];
const archived = readJournal(
  [JSON.stringify({ type: 'head', meta }), ...runs.map((r) => JSON.stringify({ type: 'run', run: r })), ''].join('\n'),
);
const input: ReportInput = { ...archived, swapRuns: [], goals, ledger, freeze, review };
const baseline = buildReport(input);

try {
  test('区间字面量：0/n、n/n、0 分母、手算 12/14 与场景 1/3', () => {
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
    assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
    near(wilson(0, 5).high, 0.43449149475208104);
    near(wilson(1, 5).low, 0.565508505247919);
    near(wilson(12 / 14, 14).low, 0.600580922361363);
    near(wilson(12 / 14, 14).high, 0.9599069262620787);
    near(wilson(1 / 3, 3).low, 0.0614903152761605);
    near(wilson(1 / 3, 3).high, 0.792345044873512);
    near(zeroUpper(26), 0.1088303557607848);
    near(zeroUpper(5), 0.4507197283469412);
    assert.equal(zeroUpper(0), 1);
  });
  test('成功率与剔除：12/14、保守12/20、去modelFree 7/9、全剔除场景和作废场景', () => {
    assert.equal(baseline.success.rate, 12 / 14);
    assert.equal(baseline.success.conservative, 0.6);
    assert.equal(baseline.success.withoutModelFree, 7 / 9);
    assert.equal(baseline.success.passK, 1 / 3);
    assert.deepEqual(baseline.success.byRuns, wilson(12 / 14, 14));
    assert.deepEqual(baseline.success.byScenes, wilson(1 / 3, 3));
    assert.deepEqual(baseline.scenes, [
      { id: 'a', family: '询价', passed: 4, total: 5, excluded: 0, voided: false },
      { id: 'b', family: '转人工', passed: 5, total: 5, excluded: 0, voided: false },
      { id: 'c', family: '询价', passed: 3, total: 5, excluded: 1, voided: false },
      { id: 'd', family: '询价', passed: 0, total: 5, excluded: 5, voided: false },
      { id: 'v', family: '询价', passed: 5, total: 5, excluded: 0, voided: true },
    ]);
    assert.deepEqual(baseline.buckets, { quote_missing: 2, customer_drift: 1, customer_http: 5 });
    assert.equal(baseline.status, 'unstable');
    assert.deepEqual(baseline.zeroUpper, { byRuns: zeroUpper(26), byScenes: zeroUpper(5) });
  });
  test('漏斗、混淆矩阵、护栏按轮计、时延只算replied并用最近秩', () => {
    assert.deepEqual(baseline.funnel, { quoted: 1, built: 1, approved: 1, accepted: 1 });
    assert.deepEqual(baseline.handoffMatrix, { expectedYes: { yes: 1, no: 4 }, expectedNo: { yes: 1, no: 14 } });
    assert.deepEqual(baseline.guards, [
      { guard: 'price', turns: 2 },
      { guard: 'shape', turns: 1 },
    ]);
    assert.deepEqual(baseline.latency, {
      samples: 5,
      p50: 8000,
      p90: 10000,
      p95: 10000,
      max: 10000,
      over8sShare: 0.4,
      deterministicTurns: 1,
    });
    assert.deepEqual(baseline.cost, { salesPerRun: 0.08, customerPerRun: 0.04, salesPerAccepted: 2, cacheHitRate: 0.25 });
    const failed = structuredClone(input);
    failed.runs[1]!.failedTurn = turn(999999, 'error', ['error_guard']).trace;
    assert.equal(buildReport(failed).latency.samples, 5);
    assert.ok(buildReport(failed).guards.some((g) => g.guard === 'error_guard' && g.turns === 1));
    failed.runs[0]!.replaced!.turns = [turn(300, 'replied', ['replacement_guard'])];
    failed.runs[1]!.status = 'budget_stop';
    failed.runs[1]!.turns = [turn(400, 'replied', ['budget_guard'])];
    const workload = buildReport(failed);
    assert.equal(workload.latency.samples, 7);
    assert.ok(workload.guards.some((g) => g.guard === 'replacement_guard' && g.turns === 1));
    assert.ok(workload.guards.some((g) => g.guard === 'budget_guard' && g.turns === 1));
  });
  test('元数据、次数、中止原因、根因、修订、抽检、裁定理由全部保留', () => {
    assert.deepEqual(baseline.meta, meta);
    assert.equal(baseline.attempt, 3); // main-1、main-2 和被杀的 killed
    assert.deepEqual(baseline.aborts, [{ runId: 'killed', reason: '合成进程被杀' }]);
    assert.deepEqual(baseline.ledger, ledger);
    assert.deepEqual(baseline.causes, review.causes);
    assert.deepEqual(baseline.revisions, review.revisions);
    assert.deepEqual(baseline.personaChecks, { sampled: 2, withErrors: 1, blocksTask: 1 });
    assert.equal(baseline.findings.find((f) => f.id === 'false-positive')!.reason, '只是转述客户条件');
    assert.equal(baseline.findings.find((f) => f.id === 'draft')!.verdict, null);
  });
  test('裁定两阶段：只降级passed，失败、客户问题、被替换的确认仍计违规', () => {
    const amended = structuredClone(input);
    amended.runs[0]!.findings!.push(finding('confirmed-pass'));
    amended.runs[4]!.findings!.push({ ...finding('confirmed-fail'), repetition: 5 });
    amended.runs[19]!.findings!.push({ ...finding('confirmed-customer', 'final', 'suspect', 'd'), repetition: 5 });
    amended.runs[0]!.replaced!.findings!.push(finding('confirmed-replaced'));
    for (const id of ['confirmed-pass', 'confirmed-fail', 'confirmed-customer', 'confirmed-replaced'])
      amended.review.verdicts.push({ findingId: id, verdict: 'confirmed', reason: '合成确认', by: 'reviewer' });
    const result = buildReport(amended);
    assert.equal(result.success.rate, 11 / 14);
    assert.equal(result.success.conservative, 0.55);
    assert.equal(result.success.withoutModelFree, 2 / 3);
    assert.deepEqual(result.buckets, { rule_violation: 1, quote_missing: 2, customer_drift: 1, customer_http: 5 });
    assert.equal(result.zeroUpper, null);
    assert.deepEqual(
      result.rules.find((r) => r.rule === 'discount_promise'),
      { rule: 'discount_promise', level: 'suspect', draftHits: 1, finalHits: 6, confirmed: 4, falsePositive: 2 },
    );
    assert.deepEqual(
      result.rules.find((r) => r.rule === 'price_line'),
      { rule: 'price_line', level: 'code', draftHits: 0, finalHits: 1, confirmed: 0, falsePositive: 0 },
    );
    assert.equal(amended.runs[0]!.status, 'passed');
    assert.deepEqual(buildReport({ ...input, review: { ...review, causes: [] } }), { ...baseline, causes: [] });
  });
  test('正式/不稳/未跑完优先级，10%边界，单场景剔除>2单独触发', () => {
    const all = [goal('a'), goal('b')];
    const ten = all.flatMap((g) => Array.from({ length: 5 }, (_, i) => run(g.id, i + 1)));
    ten[0]!.status = 'customer_protocol';
    const stable = { ...input, goals: all, runs: ten };
    assert.equal(buildReport(stable).status, 'formal');
    assert.deepEqual(checkFormal({ ...stable, ledgerCommitted: true }), []);
    ten[1]!.status = 'customer_http';
    assert.equal(buildReport(stable).status, 'unstable');
    assert.ok(checkFormal({ ...stable, ledgerCommitted: true }).some((r) => r.includes('仿真不稳')));
    assert.equal(buildReport({ ...stable, runs: ten.slice(1) }).status, 'incomplete');
    const manyGoals = Array.from({ length: 7 }, (_, i) => goal(`g${i}`));
    const many = manyGoals.flatMap((g) => Array.from({ length: 5 }, (_, i) => run(g.id, i + 1)));
    for (let i = 0; i < 3; i++) many[i]!.status = 'customer_http';
    assert.equal(buildReport({ ...input, goals: manyGoals, runs: many }).status, 'unstable');
    many[0]!.status = 'budget_stop';
    assert.equal(buildReport({ ...input, goals: manyGoals, runs: many }).status, 'incomplete');
  });
  test('0分母、0/n、n/n、无时延、无确认、尚未审计，不产生NaN', () => {
    const one = { ...input, goals: [goal('a')], meta: { ...meta, k: 1 }, runs: [run('a', 1, 'customer_http')] };
    const result = buildReport(one);
    assert.deepEqual(result.success, {
      rate: 0,
      conservative: 0,
      withoutModelFree: 0,
      byRuns: { low: 0, high: 1 },
      byScenes: { low: 0, high: 1 },
      passK: 0,
    });
    assert.equal(result.cost.salesPerAccepted, null);
    assert.deepEqual(result.latency, { samples: 0, p50: 0, p90: 0, p95: 0, max: 0, over8sShare: 0, deterministicTurns: 0 });
    assert.equal(buildReport({ ...one, runs: [run('a', 1, 'failed')] }).success.rate, 0);
    assert.equal(buildReport({ ...one, runs: [run('a')] }).success.rate, 1);
    const unreviewed = run('a');
    delete unreviewed.findings;
    assert.deepEqual(buildReport({ ...one, runs: [unreviewed] }).zeroUpper, { byRuns: 1, byScenes: 1 });
    assert.ok(!JSON.stringify(result).includes('NaN'));
  });
  test('换客户模型单列：不裁定、不进D4，不稳或未跑满时对比无效', () => {
    const swapRuns = goals.flatMap((g) => Array.from({ length: 5 }, (_, i) => run(g.id, i + 1)));
    swapRuns[0]!.findings = [finding('swap-final'), finding('swap-draft', 'draft')];
    const result = buildReport({ ...input, swapRuns });
    assert.deepEqual(result.swap, { customerModel: 'other-customer', rate: 1, byScenes: wilson(1, 4), suspects: 1, valid: true });
    assert.deepEqual(result.findings, baseline.findings);
    assert.deepEqual(result.rules, baseline.rules);
    assert.deepEqual(result.zeroUpper, baseline.zeroUpper);
    swapRuns[0]!.status = 'customer_http';
    swapRuns[1]!.status = 'customer_http';
    swapRuns[2]!.status = 'customer_http';
    assert.equal(buildReport({ ...input, swapRuns }).swap!.valid, false);
    assert.equal(buildReport({ ...input, swapRuns: swapRuns.slice(1) }).swap!.valid, false);
  });
  test('正式保护：未裁定final、替换样本、未提交、旧main；原稿不拦', () => {
    const stable = { ...input, goals: [goal('a')], meta: { ...meta, k: 1 }, runs: [run('a')], ledgerCommitted: true };
    assert.deepEqual(checkFormal(stable), []);
    assert.deepEqual(checkFormal({ ...stable, ledgerCommitted: false }), ['主跑账本行没有全部提交']);
    assert.deepEqual(checkFormal({ ...stable, meta: { ...stable.meta, runId: 'main-1' } }), ['journal 不是账本里最后一次完整 main']);
    stable.runs[0]!.findings = [finding('pending', 'draft')];
    assert.deepEqual(checkFormal(stable), []);
    stable.runs[0]!.replaced = { ...run('a'), findings: [finding('pending')] };
    assert.deepEqual(checkFormal(stable), ['最终回复的疑似尚未全部裁定']);
  });
  test('journal半行丢弃、同遍最后一行、预算截断费保留，替换费用不重复', () => {
    const stopped = { ...run('a', 1, 'budget_stop'), charges: [charge('sales', 3), charge('customer', 2)] };
    const final = { ...run('a'), charges: [charge('sales', 1)] };
    const text = [
      JSON.stringify({ type: 'head', meta: { ...meta, k: 1 } }),
      JSON.stringify({ type: 'run', run: stopped }),
      JSON.stringify({ type: 'run', run: final }),
      '{"type":',
    ].join('\n');
    const read = readJournal(text);
    assert.equal(read.runs.length, 1);
    assert.equal(read.runs[0]!.status, 'passed');
    assert.equal(read.runs[0]!.charges.length, 3);
    const result = buildReport({ ...input, ...read, goals: [goal('a')] });
    assert.equal(result.status, 'formal');
    assert.deepEqual(result.cost, { salesPerRun: 4, customerPerRun: 2, salesPerAccepted: null, cacheHitRate: 0.25 });
    const unfinished = buildReport({ ...input, meta: { ...meta, k: 1 }, goals: [goal('a')], runs: [stopped] });
    assert.equal(unfinished.status, 'incomplete');
    assert.equal(unfinished.cost.salesPerRun, 3);
    assert.throws(() => readJournal('{"type":"head"'), /head/);
  });
  test('抽样固定SHA256顺序：每失败桶1、成功5、客户扮演20，两个构建完全一致', () => {
    // 固定输入 frozen+a+遍号，哈希顺序已独立用 Python hashlib 核对。
    const sampleInput = { runs: Array.from({ length: 8 }, (_, i) => run('a', i + 1)), freeze, review };
    assert.deepEqual(selectSamples(sampleInput), [
      ...[1, 8, 4, 6, 2].map((repetition) => ({ goalId: 'a', repetition, bucket: 'passed' })),
      ...[1, 8, 4, 6, 2, 5, 3, 7].map((repetition) => ({ goalId: 'a', repetition, bucket: 'passed', persona: true })),
    ]);
    const samples = selectSamples(input);
    assert.deepEqual(
      samples.filter((s) => !s.persona),
      [
        { goalId: 'v', repetition: 2, bucket: 'passed' },
        { goalId: 'd', repetition: 3, bucket: 'customer_http' },
        { goalId: 'a', repetition: 1, bucket: 'passed' },
        { goalId: 'v', repetition: 1, bucket: 'passed' },
        { goalId: 'b', repetition: 2, bucket: 'passed' },
        { goalId: 'c', repetition: 5, bucket: 'customer_drift' },
        { goalId: 'a', repetition: 4, bucket: 'passed' },
        { goalId: 'a', repetition: 5, bucket: 'quote_missing' },
      ],
    );
    assert.equal(samples.filter((s) => !s.persona && s.bucket === 'passed').length, 5);
    for (const bucket of ['quote_missing', 'customer_drift', 'customer_http'])
      assert.equal(samples.filter((s) => !s.persona && s.bucket === bucket).length, 1);
    assert.equal(samples.filter((s) => s.persona).length, 20);
    const before = JSON.stringify(input);
    assert.deepEqual(buildReport(input), buildReport(input));
    assert.equal(renderReport(buildReport(input)), renderReport(buildReport(input)));
    assert.equal(JSON.stringify(input), before);
  });
  test('LIMITS十条逐字核对，基础条目被删时构建失败', () => {
    assert.deepEqual(LIMITS, [
      '客户是模型演的。公开研究显示模型扮用户比真人更配合、更早说全信息，成功率和真人结果有系统偏差，多数情况偏高。它不等于线上转化率或解决率。',
      '场景是作者自己写的。留出集防的是对着题调，防不了作者的盲区；运行者也能看到中间结果，约束靠 owner 逐次授权和账本。',
      '产品库只有 40 条合成数据，真实商家的型号、单位和价格结构可能更乱。',
      '顾问批准是确定性替身，错单也批，不含真人判断和等待。',
      '没走企微：时延不含收发，也没经过分段、额度和回执；客户看到的是卡片文字，没打开报价单页。配置来自文件，线上来自数据库。',
      '零违规说的是没有漏到客户，不是模型没犯，原稿命中数见第 5 章；它也不等于不会违规，只给出本次的上界。审计和产品出自同一作者，独立的只是代码。',
      '结果绑定这一个模型版本和这一个时段；接口快慢会变，费用按当时标准单价算，不含已取消的对冲请求。换模型扮客户，成功率也会变，本次的差值见第 3 章。',
      '判分不看话术：语气差、表达绕的回复也可能算通过。',
      '根因是 AI 标注，疑似裁定是 AI 初裁加 AI 复核；误报 owner 全看，其余抽查，不是人工逐条审。',
      '不证明商业价值：转化率、节省人力都没测。',
    ]);
    const mutable = LIMITS as unknown as string[];
    const last = mutable.pop()!;
    try {
      assert.throws(() => buildReport(input), /基础条目/);
    } finally {
      mutable.push(last);
    }
  });
  test('页面：九章齐全、数字与统计一致、状态标记、图表可重现、开发集单列', () => {
    const page = renderReport(baseline);
    const titles = [...page.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(titles, [
      '1. 结论',
      '2. 跑了什么',
      '3. 成功率',
      '4. 失败原因',
      '5. 规则',
      '6. 成本与时延',
      '7. 这些数字不能证明什么',
      '8. 复现与账本',
      '9. 抽样对话',
    ]);
    for (const line of LIMITS) assert.ok(page.includes(line), line);
    assert.ok(page.includes('留出集成功率 | 85.7%（12/14）'));
    assert.ok(page.includes('保守成功率 | 60.0%（12/20）'));
    assert.ok(page.includes(`第 ${baseline.attempt} 次跑留出集`));
    assert.equal(page, renderReport(structuredClone(baseline)));
    assert.ok(renderReport({ ...baseline, status: 'formal' }).startsWith('# 工业询价仿真报告\n\n状态：正式'));
    assert.ok(renderReport({ ...baseline, status: 'unstable' }).includes('> 仿真不稳：'));
    assert.ok(renderReport({ ...baseline, status: 'incomplete' }).includes('> 未跑完：'));
    assert.ok(renderReport(baseline, { draft: true }).includes('> 草稿：'));
    const failedGate = { ...baseline, rules: baseline.rules.map((r) => (r.rule === 'moq' ? { ...r, finalHits: 1 } : r)) };
    assert.ok(renderReport(failedGate).includes('未达标，不发布'));
    const charts = renderCharts(baseline);
    assert.deepEqual(Object.keys(charts).toSorted(), ['charts/families.svg', 'charts/funnel.svg', 'charts/rules.svg']);
    assert.deepEqual(charts, renderCharts(structuredClone(baseline)));
    for (const svg of [page, ...Object.values(charts)]) scanPublic(svg);
    const dev = buildReport({
      ...input,
      dev: { runs: [run('dev-goal', 1, 'passed'), run('dev-goal', 2, 'failed')], goals: [goal('dev-goal')], k: 2 },
    });
    assert.deepEqual(dev.dev, { rate: 0.5, runs: 2 });
    assert.ok(renderReport(dev).includes('开发集最后一次的成功率是 50.0%（2 遍）'));
    const sample = renderSample({ goalId: 'a', repetition: 1, bucket: 'not_accepted', run: run('a', 1, 'failed') });
    assert.ok(sample.includes('客户确认没记下') && sample.includes('合成'));
  });
  test('独立公开扫描：本机路径、密钥、模型地址（含JSON转义）', () => {
    for (const text of [
      ['', 'Users', 'someone', 'project'].join('/'),
      'C:\\workspace\\project',
      'sk-' + 'x'.repeat(24),
      'https://model.example/v1',
      'api_key=' + 'x'.repeat(24),
      'f'.repeat(32) + '.' + 'x'.repeat(16),
      String.raw`\u002fUsers\u002fsomeone\u002fproject`,
    ])
      assert.throws(() => scanPublic(text), /公开边界/);
    scanPublic(JSON.stringify(baseline));
    scanPublic(renderReport(baseline));
  });

  // CLI 的账本提交检查在独立的临时 git 仓库验证，绝不提交当前工作树。
  const originalCwd = process.cwd();
  await fs.mkdir('var', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('var/report-selftest-'));
  try {
    const cliGoal = goal('cli');
    const devGoal = goal('dev');
    devGoal.journey!.split = 'dev';
    const cliMeta = { ...meta, k: 1 };
    const cliRun = run('cli');
    const devMeta = { ...cliMeta, runId: 'dev', kind: 'dev' as const };
    const rows = [ledgerLine(meta.runId, 'start'), ledgerLine(meta.runId, 'end')];
    const journal = (m: RunMeta, r: RunResult) =>
      [JSON.stringify({ type: 'head', meta: m }), JSON.stringify({ type: 'run', run: r }), ''].join('\n');
    await fs.writeFile(path.join(root, 'main.jsonl'), journal(cliMeta, cliRun));
    await fs.writeFile(path.join(root, 'dev.jsonl'), journal(devMeta, run('dev', 1, 'failed')));
    await fs.writeFile(path.join(root, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await fs.writeFile(path.join(root, 'freeze.json'), JSON.stringify(freeze));
    await fs.writeFile(
      path.join(root, 'review.json'),
      JSON.stringify({ causes: [], verdicts: [], personaChecks: [], revisions: [], aborts: [] }),
    );
    await fs.writeFile(path.join(root, 'goals.json'), JSON.stringify([cliGoal, devGoal]));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, timeout: 10000, stdio: 'pipe' });
    git(['init', '--quiet']);
    git(['add', 'ledger.jsonl']);
    git(['-c', 'user.name=Selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '--quiet', '-m', 'test: synthetic ledger']);
    process.chdir(root);
    const args = [
      '--main',
      'main.jsonl',
      '--dev',
      'dev.jsonl',
      '--ledger',
      'ledger.jsonl',
      '--freeze',
      'freeze.json',
      '--review',
      'review.json',
      '--date',
      '2026-11-01',
      '--out',
      'out',
      '--goals',
      'goals.json',
    ];
    // oxfmt 从原项目调用；PATH 中的 pnpm 仍用原项目的依赖。
    const originalPath = process.env.PATH;
    process.env.PATH = `${path.join(originalCwd, 'node_modules/.bin')}${path.delimiter}${originalPath}`;
    try {
      await main(args);
      const output = JSON.parse(await fs.readFile('out/2026-11-01/summary.json', 'utf8'));
      assert.deepEqual(output.dev, { rate: 0, runs: 1 });
      assert.equal(output.success.rate, 1);
      assert.equal(output.status, 'formal');
      assert.equal((await fs.readdir('out/2026-11-01/samples')).length, 3);
      const first = await fs.readFile('out/2026-11-01/summary.json', 'utf8');
      await main(args.map((s) => (s === 'out' ? 'out-second' : s)));
      assert.equal(await fs.readFile('out-second/2026-11-01/summary.json', 'utf8'), first);
      await assert.rejects(main(args), /EEXIST/);
      cliRun.turns = [turn(100)];
      cliRun.turns[0]!.reply = 'https://model.example/v1';
      await fs.writeFile('main.jsonl', journal(cliMeta, cliRun));
      await assert.rejects(main(args.map((s) => (s === 'out' ? 'unsafe' : s))), /公开边界扫描失败/);
      await assert.rejects(fs.stat('unsafe/2026-11-01'));
      cliRun.turns = [];
      await fs.writeFile('main.jsonl', journal(cliMeta, cliRun));
      await fs.appendFile('ledger.jsonl', JSON.stringify(ledgerLine('new-main', 'start')) + '\n');
      await assert.rejects(main(args.map((s) => (s === 'out' ? 'refused' : s))), /没有全部提交/);
      await assert.rejects(fs.stat('refused/2026-11-01'));
      checked++;
      console.log('✔ CLI：读写、格式化、开发集单列、可重现、拒绝未提交账本和覆盖');
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = previousFetch;
}
console.log(`report.selftest: ${checked} passed`);
