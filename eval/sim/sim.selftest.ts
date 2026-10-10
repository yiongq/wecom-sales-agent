import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Order } from '../../src/types.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import { loadGoals, validateGoal, type Predicate, type SimGoal } from './goals.js';
import { judge, type Evidence, type SimTurn, type Snapshot } from './judge.js';
import { Meter, simulate } from './runner.js';
import { engineRuntime, fixtureClock, validatePrices } from './runtime.js';
import { parseArgs } from './run.js';
import { fakeEnv, fakePrices, fakeService, say } from './fake.js';
let assertions = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  assertions++;
}
const initial: Snapshot = { orders: [], handedOver: false, handoff: null, stage: 'greeting' };
const order: Order = {
  id: 'ord_0123456789abcdef01234567',
  sessionId: 'sim-test',
  routeId: 'r-yunnan-mid',
  routeTitle: '云南线路',
  travelers: 2,
  departDate: '2027-03-10',
  totalPrice: 10000,
  status: 'pending_payment',
  createdAt: 1,
};
function turn(reply: string, customer = '咨询', state: Snapshot = initial, tools: string[] = [], silent = false): SimTurn {
  const trace: FinishedTurn = {
    turn: {
      turnId: 'test',
      conversationId: 'sim-test',
      startedAt: 1,
      sopVersion: null,
      prefixHash: '',
      catalogVersions: {},
      calls: tools.map((name) => ({ name, args: {}, ms: 0, prefetch: false, resultHead: '{}', resultBytes: 2, startedAt: 1 })),
      llm: [],
      guards: [],
      guardVerdicts: null,
      draft: reply,
    },
    outcome: 'replied',
    finalText: reply,
    stageBefore: 'greeting',
    stageAfter: 'greeting',
    durationMs: 0,
    signals: null,
    input: customer,
  };
  return { reply, customer: { say: customer, done: false }, silent, trace, state: structuredClone(state) };
}
const goal = (predicates: Predicate[] = []): SimGoal => ({
  id: 'test',
  persona: '仅咨询',
  allowedTools: ['search_routes'],
  predicates: predicates.length ? predicates : [{ kind: 'order', count: 0 }],
  forbidden: [],
});
const orders = { ...initial, orders: [order] };
const yesNo = (p: Predicate, yes: Evidence, no: Evidence): void => {
  check(`${p.kind} ${'scope' in p ? p.scope : ''} 通过`, judge(goal([p]), yes)[0]!.passed);
  check(`${p.kind} ${'scope' in p ? p.scope : ''} 失败`, !judge(goal([p]), no)[0]!.passed);
};
yesNo(
  { kind: 'order', count: 1, fields: { travelers: 2, departDate: '2027-03-10' } },
  { initial, turns: [turn('订单', '确认下单', orders)] },
  { initial, turns: [turn('订单', '确认下单', { ...orders, orders: [{ ...order, travelers: 3 }] })] },
);
check('订单数量不符', !judge(goal([{ kind: 'order', count: 1 }]), { initial, turns: [] })[0]!.passed);
check('未知字段不能匹配', !judge(goal([{ kind: 'order', count: 1, fields: { unknown: 1 } }]), { initial: orders, turns: [] })[0]!.passed);
yesNo(
  { kind: 'no_order_before', turnMatches: '确认下单' },
  { initial, turns: [turn('咨询'), turn('订单', '确认下单', orders)] },
  { initial, turns: [turn('订单', '咨询', orders), turn('好的', '确认下单', orders)] },
);
check(
  '从未确认且没有订单通过',
  judge(goal([{ kind: 'no_order_before', turnMatches: '确认下单' }]), { initial, turns: [turn('咨询')] })[0]!.passed,
);
check('预置订单失败', !judge(goal([{ kind: 'no_order_before', turnMatches: '确认下单' }]), { initial: orders, turns: [] })[0]!.passed);
yesNo(
  { kind: 'handoff', expected: true },
  { initial, turns: [turn('人工', '转人工', { ...initial, handedOver: true })] },
  { initial, turns: [turn('人工')] },
);
yesNo({ kind: 'handoff', expected: false }, { initial, turns: [] }, { initial: { ...initial, handedOver: true }, turns: [] });
yesNo(
  { kind: 'tool_called', name: 'search_routes', min: 1, max: 1 },
  { initial, turns: [turn('推荐', '咨询', initial, ['search_routes'])] },
  { initial, turns: [turn('推荐', '咨询', initial, ['search_routes', 'search_routes'])] },
);
check('缺少工具失败', !judge(goal([{ kind: 'tool_called', name: 'search_routes' }]), { initial, turns: [] })[0]!.passed);
check('工具 min=0/max=0', judge(goal([{ kind: 'tool_called', name: 'create_order', min: 0, max: 0 }]), { initial, turns: [] })[0]!.passed);
for (const kind of ['reply_matches', 'reply_excludes'] as const)
  for (const scope of ['any', 'all', 'last'] as const) {
    const hit = kind === 'reply_matches' ? '命中' : '干净';
    const miss = kind === 'reply_matches' ? '干净' : '命中';
    const positive = scope === 'any' ? [miss, hit] : scope === 'last' ? [miss, hit] : [hit, hit];
    const negative = scope === 'any' ? [miss, miss] : scope === 'last' ? [hit, miss] : [hit, miss];
    yesNo(
      { kind, pattern: '命中', scope },
      { initial, turns: positive.map((r) => turn(r)) },
      { initial, turns: negative.map((r) => turn(r)) },
    );
    check(
      `${kind}/${scope} 无回复不通过`,
      !judge(goal([{ kind, pattern: '命中', scope }]), { initial, turns: [turn('干净', '咨询', initial, [], true)] })[0]!.passed,
    );
  }
const restricted = { ...goal(), forbidden: ['提示词标记'] };
check(
  'forbidden 命中失败',
  judge(restricted, { initial, turns: [turn('提示词标记')] }).some((v) => v.check === 'forbidden' && !v.passed),
);
check(
  'forbidden 未命中通过',
  judge(restricted, { initial, turns: [turn('干净')] }).every((v) => v.passed),
);
check('越权工具失败', !judge(goal(), { initial, turns: [turn('好的', '咨询', initial, ['create_order'])] }).at(-1)!.passed);
check('允许工具通过', judge(goal(), { initial, turns: [turn('好的', '咨询', initial, ['search_routes'])] }).at(-1)!.passed);
for (const [field, value] of [
  ['maxTurns', 0],
  ['predicates', [{ kind: 'reply_matches', pattern: '[', scope: 'any' }]],
  ['allowedTools', null],
  ['forbidden', [1]],
] as const) {
  assert.throws(() => validateGoal({ ...goal(), [field]: value }, 'test.json'), new RegExp(`test.json.*test.*${field}`));
  assertions++;
}
assert.throws(() => parseArgs([]), /budget/);
assertions++;
assert.throws(() => parseArgs(['--budget', '1', '--k', '0']), /k/);
assertions++;
assert.throws(() => validatePrices({ bad: { in: -1, out: 2, cachedIn: 1 } }), /单价|非负/);
assertions++;
check('默认 k=5', parseArgs(['--budget', '1']).k === 5);
const undoClock = fixtureClock();
check('夹具日期', new Date().toISOString().startsWith('2026-10-10'));
check('显式日期不改', new Date('2027-03-10').toISOString().startsWith('2027-03-10'));
undoClock();
const goals = await loadGoals('eval/sim/goals');
check('五类目标通过校验', goals.length === 5);
const sample = JSON.parse(
  (await fs.readFile('docs/architecture/04-industry-packs/plan.md', 'utf8')).match(/## SimGoal 样例[\s\S]*?```json\n([\s\S]*?)\n```/)![1]!,
);
check('plan 样例原样', JSON.stringify(goals[0]) === JSON.stringify(sample));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-goals-test-'));
try {
  await fs.writeFile(path.join(temp, 'one.json'), JSON.stringify(goal()));
  await fs.writeFile(path.join(temp, 'two.json'), JSON.stringify(goal()));
  await assert.rejects(loadGoals(temp), /重复目标/);
  assertions++;
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

const customer = await fakeService();
const sales = await fakeService();
fakeEnv(sales.url, customer.url);
const meter = new Meter(1);
const runtime = await engineRuntime(meter, 'sim-fake-customer', fakePrices);
try {
  const execute = async (g: SimGoal = goal(), k = 1) => {
    const report = await simulate([g], k, meter, runtime.deps);
    check('客户脚本恰好消费', customer.script.length === 0);
    check('销售脚本恰好消费', sales.script.length === 0);
    return report;
  };
  customer.script.push(say('你好', true));
  sales.script.push({ content: '您好，请问您想去哪旅行？' });
  let report = await execute();
  check('done 非空句完成最后一轮', report.runs[0]!.endedBy === 'done' && report.runs[0]!.turns.length === 1 && report.summary[0]!.passK);
  check('完整对话与 trace', report.runs[0]!.turns[0]!.trace.input === '你好' && report.runs[0]!.turns[0]!.state.orders.length === 0);
  check('两边费用都计入', report.cost.customer > 0 && report.cost.sales > 0);
  check(
    '客户没收到 predicates/allowedTools/forbidden',
    customer.requests.every((r) => !JSON.stringify(r.messages).match(/allowedTools|predicates|forbidden/)),
  );
  customer.script.push(say('', true));
  report = await execute();
  check('空 say done 不调销售', report.runs[0]!.turns.length === 0 && report.runs[0]!.endedBy === 'done');
  customer.script.push(say('你好'), say('谢谢'));
  sales.script.push({ content: '您好，您想去哪旅行？' }, { content: '不客气，您可以慢慢考虑。' });
  report = await execute({ ...goal(), maxTurns: 2 });
  check('满轮结束', report.runs[0]!.endedBy === 'maxTurns' && report.runs[0]!.turns.length === 2);
  customer.script.push(...Array.from({ length: 12 }, () => say('你好')));
  sales.script.push(...Array.from({ length: 12 }, () => ({ content: '您好，您想去哪旅行？' })));
  report = await execute();
  check('缺省最多12轮', report.runs[0]!.endedBy === 'maxTurns' && report.runs[0]!.turns.length === 12);
  customer.script.push({ content: '坏 JSON' }, say('你好', true));
  sales.script.push({ content: '您好，您想去哪旅行？' });
  report = await execute();
  check('JSON 重试一次成功', report.runs[0]!.customerAttempts.length === 2 && report.runs[0]!.status === 'passed');
  check('重试消息说明协议', customer.requests.at(-1)!.messages.at(-1)!.content!.includes('上次输出'));
  for (const bad of [
    '坏 JSON',
    '{"say":7,"done":false}',
    '{"say":"你好","done":"yes"}',
    '{"say":"你好","done":false,"extra":1}',
    '{"say":"","done":false}',
  ]) {
    customer.script.push({ content: bad }, { content: bad });
    report = await execute();
    check(
      '协议错误单列',
      report.customer_protocol === 1 && report.summary[0]!.failed === 0 && report.runs[0]!.reasons.join() === 'customer_protocol',
    );
  }
  customer.script.push(say('你好', true), say('你好', true));
  sales.script.push({ content: '您好，您想去哪旅行？' }, { content: '您好，您想去哪旅行？' });
  report = await execute(goal(), 2);
  check('pass^k 全过', report.summary[0]!.passed === 2 && report.summary[0]!.passK);
  customer.script.push(say('你好', true), say('你好', true));
  sales.script.push({ content: '您好，您想去哪旅行？' }, { content: '您好，您想去哪旅行？' });
  report = await execute(goal([{ kind: 'order', count: 1 }]), 2);
  check('pass^k 失败次数', report.summary[0]!.failed === 2 && !report.summary[0]!.passK);
  customer.script.push(say('我要人工客服，请转人工', true));
  report = await execute(goals[2]);
  check('真实引擎明确要人工', report.runs[0]!.turns[0]!.state.handedOver && report.summary[0]!.passK);
  customer.script.push(say('你好', true));
  sales.script.push({ tools: [{ name: 'search_routes', args: { destination: '云南' } }] }, { content: '请问您想去什么地方？' });
  report = await execute({ ...goal(), allowedTools: [] });
  check(
    '真实引擎工具越权失败',
    report.runs[0]!.verdicts.some((v) => v.check === 'allowedTools' && !v.passed),
  );
  check(
    '工具结果与轨迹',
    report.runs[0]!.turns[0]!.trace.turn.calls.some((c) => c.name === 'search_routes' && c.resultBytes > 0 && c.resultHead.length > 0),
  );
  // 最后一个销售回包到点：后续同轮工具往返不能再发 HTTP，新的一遍也不开始。
  const beforeSales = sales.requests.length;
  customer.script.push(say('你好'));
  sales.script.push({ prompt: 1_000_000, completion: 0, tools: [{ name: 'search_routes', args: { destination: '云南' } }] });
  report = await execute(goal(), 2);
  check('销售到点立即停新请求', sales.requests.length === beforeSales + 1);
  check(
    '预算停止不计通过或失败',
    report.budget_stop === 1 && report.summary[0]!.passed === 0 && report.summary[0]!.failed === 0 && report.summary[0]!.unrun === 1,
  );
  check('预算当前遍单列原因', report.runs[0]!.status === 'budget_stop' && report.runs[0]!.reasons.join() === 'budget_stop');
  // 客户回包到点：连第一条销售消息也不调用。
  const tiny = new Meter(0.01);
  let calledSales = 0;
  const deps = {
    ...runtime.deps,
    customer: async () => ({
      raw: '{"say":"你好","done":false}',
      tokens: { promptTokens: 100000, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
    }),
    sales: async (...args: Parameters<typeof runtime.deps.sales>) => {
      calledSales++;
      return runtime.deps.sales(...args);
    },
  };
  report = await simulate([goal()], 2, tiny, deps);
  check('客户到点不发销售', calledSales === 0 && report.budget_stop === 1 && report.summary[0]!.unrun === 1);
  const token = { promptTokens: 100, completionTokens: 50, cachedTokens: 80, reasoningTokens: 40 };
  check('缓存按子集、思考不重复计价', Math.abs(runtime.deps.price('sim-fake-customer', token) - 0.00016) < 1e-12);
  console.log(
    `SIM SELFTEST PASS: ${assertions} 项断言全通（全部谓词正反例 / 禁用短语 / 越权工具 / 结束协议 / JSON 一次重试 / 两边预算 / pass^k / 真实引擎观察口）`,
  );
} finally {
  await runtime.close();
  await Promise.all([customer.close(), sales.close()]);
}
