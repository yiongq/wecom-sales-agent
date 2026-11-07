import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promote, main } from './promote.js';
import { readJournal, type Journal } from './journal.js';
import { triageRun, type DetectorId, type TriagePart, type TriageVerdict } from './triage.js';
import { runCaseV2 } from '../v2/run.js';
import { validateCase } from '../v2/schema.js';
import type { SimTurn, Snapshot } from './judge.js';
import type { RunResult } from './runner.js';
import type { TraceCall, TraceLlmCall } from '../../src/trace/recorder.js';
import type { LineOrder } from '../../src/core/order-view.js';

// 合成会话配公开虚构产品库；不读取任何历史 journal。
const catalog = JSON.parse(
  await fs.readFile(new URL('../../data/packs/industrial/catalog/part.json', import.meta.url), 'utf8'),
) as TriagePart[];
const now = Date.parse('2026-10-10T12:00:00+08:00');
const snap = (orders: LineOrder[] = []): Snapshot => ({ orders, handedOver: false, handoff: null, stage: 'quote' });
const call = (name: string, args: Record<string, unknown>, result: unknown, prefetch = false): TraceCall => {
  const resultHead = JSON.stringify(result);
  return { name, args, resultHead, resultBytes: Buffer.byteLength(resultHead), prefetch, ms: 0, startedAt: now };
};
const llm = (tools: string[] = []): TraceLlmCall => ({
  model: 'local',
  hedged: false,
  ms: 0,
  tools,
  toolMs: 0,
  reused: [],
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  error: null,
  startedAt: now,
});
function turn(reply = '请稍候。'): SimTurn {
  return {
    sessionBefore: {
      session: {
        id: 'sim-synthetic',
        channel: 'simulator',
        stage: 'quote',
        profile: { attrs: { company: '合成公司' }, notes: ['合成'] },
        messages: [],
        orderIds: [],
        handedOver: false,
        createdAt: now - 1000,
        updatedAt: now - 1000,
        packState: {},
        turnSignals: [0, 1],
        negativeHits: [0],
        moneyLedger: [{ fen: 900, label: '合成试算' }],
      },
      orders: [],
    },
    customer: { say: '6205-2RS要20件，多少钱？', done: false },
    reply,
    silent: false,
    state: snap(),
    trace: {
      turn: {
        turnId: 'synthetic',
        conversationId: 'sim-synthetic',
        startedAt: now,
        sopVersion: null,
        prefixHash: '',
        catalogVersions: {},
        calls: [
          call(
            'quote_items',
            { items: [{ query: '6205-2RS', qty: 20 }] },
            { lines: [{ code: 'bearing-02', partNo: '6205-2RS', qty: 20, match: 'exact', unitPrice: 9, amount: 180 }], total: 180 },
            true,
          ),
        ],
        llm: [llm()],
        guards: [],
        guardVerdicts: [],
        draft: reply,
      },
      outcome: 'replied',
      finalText: reply,
      stageBefore: 'quote',
      stageAfter: 'quote',
      durationMs: 0,
      signals: null,
      input: '合成输入',
    },
  };
}
function run(turns: SimTurn[]): RunResult {
  return {
    runId: 'synthetic-run',
    goalId: 'synthetic-goal',
    repetition: 1,
    initial: snap(),
    turns,
    status: 'passed',
    endedBy: 'done',
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
  };
}
function journal(...turns: SimTurn[]): Journal {
  return readJournal(
    Buffer.from(
      JSON.stringify({ type: 'head', meta: { runId: 'synthetic-run', startedAt: 'synthetic' } }) +
        '\n' +
        JSON.stringify({ type: 'run', run: run(turns) }) +
        '\n',
    ),
  );
}
function candidate(j: Journal, detector: DetectorId) {
  const c = triageRun(j.runs[0]!, catalog, j.meta.runId).find((c) => c.detector === detector);
  assert.ok(c, `${detector} 必须真实命中`);
  return c;
}
const reviews = (id: string): TriageVerdict[] => [{ id, verdict: 'confirmed', note: '人工核对合成片段' }];
function generated(t: SimTurn, detector: DetectorId = 'price_withheld') {
  const j = journal(t);
  const c = candidate(j, detector);
  return promote(j, reviews(c.id), c.id, 'q18-synthetic', catalog);
}
let checks = 0;
function test(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✔ ${name}`);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-selftest-'));
try {
  const t = turn();
  const j = journal(t);
  const c = candidate(j, 'price_withheld');
  test('拒绝无裁定、误报、重复裁定和空理由', () => {
    for (const review of [
      [],
      [{ id: c.id, verdict: 'false_positive' as const, note: '误报' }],
      [...reviews(c.id), ...reviews(c.id)],
      [{ id: c.id, verdict: 'confirmed' as const, note: '' }],
    ])
      assert.throws(() => promote(j, review, c.id, 'q18-test', catalog), /未确认/);
    assert.throws(() => promote(j, reviews('missing'), 'missing', 'q18-test', catalog), /找不到唯一候选/);
  });
  test('旧 journal 明确提示只能手写用例', () => {
    const old = structuredClone(j);
    delete old.runs[0]!.turns[0]!.sessionBefore;
    assert.throws(() => promote(old, reviews(c.id), c.id, 'q18-test', catalog), /旧 journal 只能手写用例/);
  });
  test('完整会话保留，预取不进入脚本，客户输入照抄，validateCase 通过', () => {
    const g = generated(t);
    assert.deepEqual(g.turns[0]!.script, [{ content: t.trace.turn.draft }]);
    assert.equal(g.turns[0]!.say, t.customer.say);
    assert.deepEqual(g.fixtures?.session?.turnSignals, [0, 1]);
    assert.doesNotThrow(() => validateCase(g));
    assert.ok(g.turns[0]!.expect.replyMatches!.some((p) => new RegExp(p).test('6205-2RS 单价9.00元')));
    assert.ok(g.turns[0]!.expect.replyMatches!.every((p) => !new RegExp(p).test('买9件')));
  });
  test('仅 find_parts 的要价轮也按客户明确数量生成正确档位价断言', () => {
    const x = turn();
    x.trace.turn.calls = [
      call('find_parts', { query: '6205-2RS' }, { match: 'exact', parts: [{ code: 'bearing-02', partNo: '6205-2RS' }] }, true),
    ];
    const g = generated(x);
    assert.ok(g.turns[0]!.expect.replyMatches!.some((p) => new RegExp(p).test('6205-2RS 单价9.00元')));
  });
  test('订单、acceptingOrderId、账本、历史、脚本参数和原稿中的 id 都换成序号', () => {
    const a: LineOrder = {
      v: 2,
      id: 'ord_000000000000000000000001',
      sessionId: 'sim-synthetic',
      status: 'superseded',
      createdAt: now - 1000,
      totalFen: 2000,
      lines: [{ kind: 'part', code: 'bearing-02', qty: 2, title: '合成', unit: '件', unitPriceFen: 1000, amountFen: 2000 }],
    };
    const b: LineOrder = {
      ...structuredClone(a),
      id: 'ord_000000000000000000000002',
      status: 'pending_payment',
      approval: { state: 'approved', requestedAt: now - 1000, decidedAt: now - 500 },
    };
    const x = turn('{"state":"内部"}');
    x.sessionBefore!.orders = [a, b];
    x.state = snap([a, b]);
    Object.assign(x.sessionBefore!.session, {
      orderIds: [a.id, b.id],
      packState: { acceptingOrderId: b.id, lastQuoteId: a.id },
      moneyLedger: [{ fen: 2000, label: '合成', subject: b.id }],
      messages: [{ role: 'agent', content: `/quote/${a.id}`, at: now - 500 }],
    });
    x.trace.turn.calls = [call('get_order', { orderId: b.id }, {}), call('find_parts', { query: '6205-2RS' }, {}, true)];
    x.trace.turn.llm = [llm(['get_order']), llm()];
    x.trace.turn.draft += ` ${b.id}`;
    const g = generated(x, 'internal_leak');
    assert.ok(!JSON.stringify(g).includes(a.id) && !JSON.stringify(g).includes(b.id));
    assert.deepEqual(g.fixtures?.session?.orderIds, ['{{order:0.id}}', '{{order:1.id}}']);
    assert.deepEqual(g.turns[0]!.script![0], { toolCalls: [{ name: 'get_order', args: { orderId: '{{order:1.id}}' } }] });
    assert.equal((g.fixtures!.session as { packState: { acceptingOrderId: string } }).packState.acceptingOrderId, '{{order:1.id}}');
  });
  test('截断工具证据、歧义复用参数、夹具不能表达的审批都明确拒绝', () => {
    const truncated = turn();
    truncated.trace.turn.calls[0]!.resultBytes = 4097;
    assert.throws(() => generated(truncated), /截断/);
    const ambiguous = turn('{"state":"内部"}');
    ambiguous.trace.turn.calls.push(call('quote_items', { items: [{ query: '6205-ZZ', qty: 20 }] }, {}, true));
    ambiguous.trace.turn.llm = [{ ...llm(['quote_items']), reused: ['quote_items'] }, llm()];
    assert.throws(() => generated(ambiguous, 'internal_leak'), /无法无歧义/);
    const accepted = turn('{"state":"内部"}');
    accepted.sessionBefore!.orders = [
      {
        v: 2,
        id: 'ord_000000000000000000000004',
        sessionId: 'sim-synthetic',
        status: 'pending_payment',
        createdAt: now - 1000,
        totalFen: 2000,
        lines: [{ kind: 'part', code: 'bearing-02', qty: 2, title: '合成', unit: '件', unitPriceFen: 1000, amountFen: 2000 }],
        approval: { state: 'approved', requestedAt: now - 1000, decidedAt: now - 500, acceptedAt: now - 100 },
      },
    ];
    assert.throws(() => generated(accepted, 'internal_leak'), /无法表达的审批状态或已接受状态/);
  });
  test('模型并行与跨请求工具调用保持分组，模型主动复用唯一预取仍进脚本', () => {
    const x = turn('{"state":"内部"}');
    x.trace.turn.calls.push(
      call('find_parts', { query: 'A' }, {}),
      call('find_parts', { query: 'B' }, {}),
      call('quote_items', { items: [] }, {}),
    );
    x.trace.turn.llm = [llm(['find_parts', 'find_parts']), llm(['quote_items']), llm()];
    assert.deepEqual(
      generated(x, 'internal_leak').turns[0]!.script!.map((s) => (s.toolCalls ? s.toolCalls.length : 0)),
      [2, 1, 0],
    );
    x.trace.turn.calls = [t.trace.turn.calls[0]!];
    x.trace.turn.llm = [{ ...llm(['quote_items']), reused: ['quote_items'] }, llm()];
    assert.equal(generated(x, 'internal_leak').turns[0]!.script![0]!.toolCalls![0]!.name, 'quote_items');
  });
  test('内部泄漏、悬空、重复、删对各生成能检出原问题的断言', () => {
    const variants: [DetectorId, SimTurn][] = [
      ['internal_leak', turn('{"match":"exact"}')],
      ['dangling', turn('报价明细：')],
      ['duplicate_text', turn('请顾问核实数量。请顾问核实数量！')],
    ];
    const deleted = turn();
    deleted.trace.turn.draft = '6205-2RS单价9元。';
    deleted.trace.turn.guards = [
      { guard: 'money_provenance', action: 'drop_sentence', removed: ['6205-2RS单价9元。'], added: [], at: now },
    ];
    variants.push(['correct_deleted', deleted]);
    for (const [detector, x] of variants) {
      const expect = generated(x, detector).turns[0]!.expect;
      assert.ok(
        expect.replyMatches?.some((p) => !new RegExp(p).test(x.reply)) || expect.replyExcludes?.some((p) => new RegExp(p).test(x.reply)),
        detector,
      );
    }
  });
  test('接受后再确认、错误应付金额、选择覆盖都生成能检出问题的断言', () => {
    const x = turn('请确认报价单，应付金额30元。');
    const o: LineOrder = {
      v: 2,
      id: 'ord_000000000000000000000003',
      sessionId: 'sim-synthetic',
      status: 'pending_payment',
      createdAt: now - 1000,
      totalFen: 18000,
      lines: [{ kind: 'part', code: 'bearing-02', qty: 20, title: '合成', unit: '件', unitPriceFen: 900, amountFen: 18000 }],
      approval: { state: 'approved', requestedAt: now - 1000, decidedAt: now - 500 },
    };
    x.sessionBefore!.orders = [structuredClone(o)];
    x.sessionBefore!.session.orderIds = [o.id];
    o.approval!.acceptedAt = now;
    x.state = snap([o]);
    for (const detector of ['ask_after_accept', 'amount_not_order'] as const) {
      const e = generated(x, detector).turns[0]!.expect;
      assert.ok(e.replyExcludes!.some((p) => new RegExp(p).test(x.reply)));
    }
    const choice = turn('查到多个候选，请选择。');
    choice.trace.turn.guards = [{ guard: 'test', action: 'replace', removed: [], added: [], at: now }];
    const chosen = generated(choice, 'choice_overridden').turns[0]!.expect;
    assert.ok(chosen.replyExcludes!.some((p) => new RegExp(p).test(choice.reply)));
    assert.ok(chosen.replyMatches!.some((p) => new RegExp(p).test('6205-2RS 已选型号')));
  });
  const journalFile = path.join(root, 'synthetic.jsonl');
  const reviewFile = path.join(root, 'triage-review.json');
  const out = path.join(root, 'q18-generated.json');
  await fs.writeFile(
    journalFile,
    JSON.stringify({ type: 'head', meta: j.meta }) + '\n' + JSON.stringify({ type: 'run', run: j.runs[0] }) + '\n',
  );
  await fs.writeFile(reviewFile, JSON.stringify(reviews(c.id)));
  await main(['--journal', journalFile, '--review', reviewFile, '--id', c.id, '--out', out]);
  const written = validateCase(JSON.parse(await fs.readFile(out, 'utf8')));
  // 18 R1 之后，模型原稿缺价时价格块会补上单价：同一条用例现在应当通过，即「修复后通过」。
  const healed = await runCaseV2(written);
  assert.equal(healed.pass, true, healed.failures.join('\n'));
  checks++;
  console.log('✔ CLI 生成的缺价用例经真实 v2 runner：价格块补上单价后通过（全部本机 mock）');
  // 「问题存在时失败」改用价格块管不到的问题演示：同一条回复里重复的句子。
  const dupCase = generated(turn('请顾问核实数量。请顾问核实数量！'), 'duplicate_text');
  const dupBad = await runCaseV2(dupCase);
  assert.equal(dupBad.pass, false, '重复原稿必须失败');
  assert.match(dupBad.failures.join('\n'), /replyExcludes/);
  const dupFixed = structuredClone(dupCase);
  dupFixed.turns[0]!.script!.at(-1)!.content = '请顾问核实数量。';
  const dupGood = await runCaseV2(dupFixed);
  assert.equal(dupGood.pass, true, dupGood.failures.join('\n'));
  checks++;
  console.log('✔ 生成的重复句用例经真实 v2 runner：重复原稿失败、去重后通过（全部本机 mock）');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'eval/sim/promote.ts',
      '--journal',
      journalFile,
      '--review',
      reviewFile,
      '--id',
      'missing',
      '--out',
      path.join(root, 'q18-refused.json'),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  test('CLI 未确认候选非零退出且不产生输出', () => {
    assert.equal(child.status, 1);
    assert.match(child.stderr, /未确认/);
  });
  test('候选 id 维持五元哈希契约', () =>
    assert.equal(c.id, createHash('sha256').update('synthetic-runsynthetic-goal11price_withheld').digest('hex').slice(0, 12)));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log(`promote 自测：${checks}/${checks} 通过`);
