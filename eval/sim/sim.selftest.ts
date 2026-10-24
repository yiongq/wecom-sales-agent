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
check('目标支持 tags', validateGoal({ ...goal(), tags: ['regression'] }, 'test.json').tags?.[0] === 'regression');
assert.throws(() => validateGoal({ ...goal(), tags: [''] }, 'test.json'), /tags/);
assert.throws(() => validateGoal({ ...goal(), unknown: true }, 'test.json'), /Unrecognized key/);
// 08 R11：pack（缺省 travel）。travel 的写法与没有这个字段时相同；别的包的画像只收 { attrs, notes }，订单只收 { status, lines }，一概不收金额
{
  const lineOrder = { status: 'pending_payment', lines: [{ kind: 'widget', code: 'w-a', qty: 200 }] };
  const packGoal = (initial: unknown) => ({ ...goal(), pack: '__fixture', initial });
  check('pack: travel 与不写 pack 同样通过', validateGoal({ ...goal(), pack: 'travel' }, 'test.json').pack === 'travel');
  check('pack 缺省', validateGoal(goal(), 'test.json').pack === undefined);
  const seeded = validateGoal(
    packGoal({ profile: { attrs: { color: '红' }, notes: ['老客户'] }, orders: [{ status: 'paid', lines: lineOrder.lines }, lineOrder] }),
    'test.json',
  );
  check(
    '非旅游包：画像 { attrs, notes } 与 { status, lines } 订单通过',
    seeded.pack === '__fixture' && seeded.initial?.orders?.length === 2,
  );
  for (const [name, bad] of [
    ['画像里的旅游字段', packGoal({ profile: { destinationInterest: '云南' } })],
    ['旅游形状的订单', packGoal({ orders: [{ routeId: 'r-sichuan-mid', travelers: 2, departDate: '2027-03-10', status: 'paid' }] })],
    ['订单行里的单价', packGoal({ orders: [{ ...lineOrder, lines: [{ kind: 'widget', code: 'w-a', qty: 1, unitPriceFen: 1 }] }] })],
    ['订单行里的行金额', packGoal({ orders: [{ ...lineOrder, lines: [{ kind: 'widget', code: 'w-a', qty: 1, amountFen: 1 }] }] })],
    ['订单上的合计', packGoal({ orders: [{ ...lineOrder, totalFen: 1 }] })],
    ['数量不是正整数', packGoal({ orders: [{ ...lineOrder, lines: [{ kind: 'widget', code: 'w-a', qty: 0 }] }] })],
    ['没有订单行', packGoal({ orders: [{ status: 'paid', lines: [] }] })],
    ['退款状态', packGoal({ orders: [{ ...lineOrder, status: 'refunded' }] })],
    ['待付单不在最后', packGoal({ orders: [lineOrder, { status: 'paid', lines: lineOrder.lines }] })],
    ['pack 不是字符串', { ...goal(), pack: 7 }],
    ['pack 字符集', { ...goal(), pack: 'bad pack' }],
    ['旅游目标写通用单', { ...goal(), initial: { orders: [lineOrder] } }],
    ['pack: travel 写通用单', { ...goal(), pack: 'travel', initial: { orders: [lineOrder] } }],
  ] as const) {
    assert.throws(() => validateGoal(bad, 'test.json'), /test\.json.*test/, name);
    assertions++;
  }
  // 证明包的目标按包装载（只过 schema，不需要登记证明包）
  const fixtureGoals = await loadGoals('eval/sim/goals/__fixture');
  check('证明包至少 2 个目标，都是 __fixture 的', fixtureGoals.length >= 2 && fixtureGoals.every((g) => g.pack === '__fixture'));
}
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
// 06 R1 回归集：eval/sim/goals/quality
const quality = await loadGoals('eval/sim/goals/quality');
check('回归集不少于 30 个目标', quality.length >= 30);
const issueIds = [...'ABCDEFGHIJKLMNOPQRSTUVW'];
const covered = new Set(quality.flatMap((g) => g.covers ?? []));
check(
  'covers 覆盖问题表全部 ID（X、Y、Z 除外）',
  issueIds.every((id) => covered.has(id)),
);
check(
  'covers 里只有问题表的 ID，没有 X、Y、Z',
  [...covered].every((id) => issueIds.includes(id)),
);
check(
  '每个目标都标了 severity 与 covers（缺口场景的 covers 为空数组）',
  quality.every((g) => (g.severity === 'safety' || g.severity === 'quality') && Array.isArray(g.covers)),
);
check(
  '至少一个种子订单是 paid',
  quality.some((g) => g.initial?.orders?.some((o) => o.status === 'paid')),
);
check(
  '种子订单有待付款也有已付款',
  quality.some((g) => g.initial?.orders?.some((o) => o.status === 'pending_payment')),
);
check(
  '固定客户话术不超过 maxTurns',
  quality.every((g) => (g.customerScript?.length ?? 0) <= (g.maxTurns ?? 12)),
);
check(
  '种子订单的出发日期都在夹具时钟之后',
  quality.every((g) => (g.initial?.orders ?? []).every((o) => 'departDate' in o && o.departDate > '2026-10-10')),
);
check(
  'shape 谓词的 minShare 是 owner 定的 P1 = 0.70',
  quality.every((g) => g.predicates.every((p) => p.kind !== 'shape' || p.minShare === 0.7)),
);
check('回归集不带本机路径', !JSON.stringify(quality).includes('/Users/'));
// 07 R8：只有带 regression 标签的目标进发布闸。06 的 safety 目标全部在内，加上之后各批加的回归目标；总数不写死（各批合并后会变）
const safetyGoals = quality.filter((g) => g.severity === 'safety');
const regressionGoals = quality.filter((g) => g.tags?.includes('regression'));
check('06 的 16 个 safety 目标都带 regression 标', safetyGoals.length >= 16 && safetyGoals.every((g) => g.tags?.includes('regression')));
check('带 regression 标的目标至少 18 个（16 个 safety + 第 10、11 步的 2 个）', regressionGoals.length >= 18);
check('带 regression 标的目标 id 不重复', new Set(regressionGoals.map((g) => g.id)).size === regressionGoals.length);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-goals-test-'));
try {
  await fs.writeFile(path.join(temp, 'one.json'), JSON.stringify({ ...goal(), tags: ['regression'] }));
  check('从文件读取 tags', (await loadGoals(temp))[0].tags?.[0] === 'regression');
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
  // 08 R11：运行时只装载一个包；目标的 pack 不是它就在开跑前被拒（证明包的目标在另一个进程里用证明包跑，见 fixture.selftest.ts）
  check('旅游运行时装载的是 travel', runtime.deps.pack === 'travel');
  const requestsBeforePack = sales.requests.length + customer.requests.length;
  await assert.rejects(simulate([{ ...goal(), pack: '__fixture' }], 1, meter, runtime.deps), /test: pack: .*__fixture.*travel/);
  assertions++;
  check('包不符的目标一个请求都没发', sales.requests.length + customer.requests.length === requestsBeforePack);
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
    // 第一遍两次都坏，整遍重跑一次，重跑的两次也坏：才算 customer_protocol
    customer.script.push({ content: bad }, { content: bad }, { content: bad }, { content: bad });
    report = await execute();
    check(
      '协议错误单列',
      report.customer_protocol === 1 &&
        report.summary[0]!.failed === 0 &&
        report.runs[0]!.reasons.join() === 'customer_protocol' &&
        report.runs[0]!.rerun,
    );
    check(
      '协议错误不计入分母、整个目标要改脚本',
      report.summary[0]!.denominator === 0 && !report.summary[0]!.passK && report.summary[0]!.needsScriptFix,
    );
  }
  // 第一遍协议失败、重跑一遍成功：照常计入
  customer.script.push({ content: '坏 JSON' }, { content: '坏 JSON' }, say('你好', true));
  sales.script.push({ content: '您好，您想去哪旅行？' });
  report = await execute();
  check(
    '协议失败重跑一遍后通过',
    report.runs[0]!.rerun &&
      report.runs[0]!.status === 'passed' &&
      report.customer_protocol === 0 &&
      report.summary[0]!.denominator === 1 &&
      report.summary[0]!.passK &&
      !report.summary[0]!.needsScriptFix,
  );
  check('重跑的费用并进同一遍', report.runs[0]!.charges.length >= 3);
  // k=2：一遍通过、一遍两次协议失败：分母 1、通过 1，pass^k 达标，但协议失败占 50%，标客户脚本要改
  customer.script.push(say('你好', true), ...Array.from({ length: 4 }, () => ({ content: '坏 JSON' })));
  sales.script.push({ content: '您好，您想去哪旅行？' });
  report = await execute(goal(), 2);
  check(
    '协议失败不计入 pass^k 的分母，单列',
    report.summary[0]!.passed === 1 &&
      report.summary[0]!.denominator === 1 &&
      report.summary[0]!.customer_protocol === 1 &&
      report.summary[0]!.passK &&
      report.summary[0]!.needsScriptFix,
  );
  // 超过 20% 才标：5 遍里 1 遍 = 20%，不标
  const share = (protocol: number, k: number) => (protocol / k > 0.2 ? 1 : 0);
  check('20% 的边界', share(1, 5) === 0 && share(1, 4) === 1);
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
  // customerScript：前几轮客户原话固定，不调客户模型；之后才交给客户模型
  const requestsBefore = customer.requests.length;
  customer.script.push(say('先这样', true));
  sales.script.push({ content: '您好，您想去哪旅行？' }, { content: '不客气。' }, { content: '好的。' });
  report = await execute({ ...goal(), customerScript: ['你好', '谢谢'] });
  check(
    'customerScript 固定前几轮，之后交给客户模型',
    report.runs[0]!.turns.map((t) => t.customer.say).join('|') === '你好|谢谢|先这样' && customer.requests.length === requestsBefore + 1,
  );
  check(
    '客户模型看得到固定的前几轮',
    customer.requests.at(-1)!.messages.some((m) => m.role === 'assistant' && m.content === '你好') &&
      customer.requests.at(-1)!.messages.some((m) => m.role === 'user' && m.content === '您好，您想去哪旅行？'),
  );
  // 脚本把 maxTurns 用完：一次客户模型也不调
  const requestsBeforeFull = customer.requests.length;
  sales.script.push({ content: '您好。' }, { content: '好的。' });
  report = await execute({ ...goal(), maxTurns: 2, customerScript: ['你好', '谢谢'] });
  check('脚本占满轮数，不调客户模型', customer.requests.length === requestsBeforeFull && report.runs[0]!.turns.length === 2);
  // initial：订单走真实的订单状态，已付款的单是真的 paid
  const seeded: SimGoal = {
    ...goal([{ kind: 'order', count: 1, fields: { status: 'paid' } }]),
    initial: {
      orders: [{ routeId: 'r-sichuan-mid', travelers: 2, departDate: '2027-03-10', status: 'paid' }],
      history: [
        { role: 'customer', content: '我们要订四川那条' },
        { role: 'ai', content: '好的，已为您生成订单' },
      ],
    },
  };
  customer.script.push(say('行程怎么安排', true));
  sales.script.push({ content: '您好，订单已收到付款。' });
  report = await execute(seeded);
  const seed = report.runs[0]!.initial;
  check(
    '种子订单是真的 paid，阶段随之为 paid',
    seed.orders.length === 1 && seed.orders[0]!.status === 'paid' && seed.orders[0]!.paidAt !== undefined && seed.stage === 'paid',
  );
  const seeded0 = seed.orders[0]!;
  check('种子订单金额由真实报价算出', 'totalPrice' in seeded0 && seeded0.totalPrice > 0 && seeded0.routeTitle.includes('熊猫'));
  check('种子订单参与 order 谓词', report.summary[0]!.passK);
  check(
    '种子对话进客户模型的视角',
    customer.requests.at(-1)!.messages.some((m) => m.role === 'assistant' && m.content === '我们要订四川那条') &&
      customer.requests.at(-1)!.messages.some((m) => m.role === 'user' && m.content === '好的，已为您生成订单'),
  );
  check(
    '种子对话进会话',
    sales.requests.at(-1)!.messages.some((m) => m.content === '我们要订四川那条') &&
      sales.requests.at(-1)!.messages.some((m) => m.content === '好的，已为您生成订单'),
  );
  customer.script.push(say('你好', true));
  sales.script.push({ content: '您好。' });
  report = await execute({
    ...goal([{ kind: 'order', count: 1, fields: { status: 'pending_payment' } }]),
    initial: { orders: [{ routeId: 'r-sichuan-mid', travelers: 2, departDate: '2027-03-10', status: 'pending_payment' }] },
  });
  check('待付款种子订单与阶段缺省', report.summary[0]!.passK && report.runs[0]!.initial.stage === 'greeting');

  for (const status of ['refund_pending', 'refunded'] as const) {
    const started = await runtime.deps.start({ orders: [{ routeId: 'r-sichuan-mid', travelers: 2, departDate: '2027-03-10', status }] });
    check(
      `07：${status} 初始订单带 paidAt，阶段仍 paid`,
      started.initial.orders[0]?.status === status && started.initial.orders[0]?.paidAt !== undefined && started.initial.stage === 'paid',
    );
    await runtime.deps.end(started.id);
  }
  const probe = await runtime.deps.start();
  check('每遍结束清掉种子订单', report.runs[0]!.initial.orders.length === 1 && probe.initial.orders.length === 0);
  await runtime.deps.end(probe.id);
  // 回归集的种子都能起：真实订单状态、阶段与对话落进会话，脚本不超轮数（不调模型）
  for (const g of quality.filter((q) => q.initial)) {
    const started = await runtime.deps.start(g.initial);
    const want = g.initial!.orders ?? [];
    check(
      `${g.id} 种子能起，订单与状态一致`,
      started.initial.orders.length === want.length &&
        want.every((o, i) => started.initial.orders[i]!.status === o.status) &&
        started.initial.orders.filter((o) => o.status === 'paid').every((o) => o.paidAt !== undefined),
    );
    check(
      `${g.id} 阶段随种子`,
      started.initial.stage === (g.initial!.stage ?? (want.some((o) => o.status === 'paid') ? 'paid' : 'greeting')),
    );
    await runtime.deps.end(started.id);
  }
  // 假模型冒烟：每个目标的固定客户话术都能读完，按序进引擎（不花钱，回复内容不看）
  for (const g of quality) {
    sales.script.length = 0;
    customer.script.length = 0;
    const scripted = g.customerScript ?? [];
    sales.script.push(...Array.from({ length: g.maxTurns ?? 12 }, () => ({ content: '好的。' })));
    if (scripted.length < (g.maxTurns ?? 12)) customer.script.push(say('', true));
    const salesRequestsBefore = sales.requests.length;
    const smoke = await simulate([g], 1, meter, runtime.deps);
    const said = smoke.runs[0]!.turns.map((t) => t.customer.say);
    check(`${g.id} 固定话术读完`, scripted.every((line, i) => said[i] === line) && smoke.runs[0]!.status !== 'customer_protocol');
    if (g.id === 'qa-self-refund-auto' || g.id === 'qa-self-refund-approval') {
      check(
        `${g.id} 退款回归全部谓词通过且零模型请求：${JSON.stringify(smoke.runs[0]!.reasons)}`,
        smoke.summary[0]!.passK && sales.requests.length === salesRequestsBefore,
      );
    }
  }
  sales.script.length = 0;
  customer.script.length = 0;
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
  check(
    '报告带汇总数',
    typeof report.metrics.shape.total === 'number' && report.runs.every((r) => r.turnMetrics.length === r.turns.length),
  );
  console.log(
    `SIM SELFTEST PASS: ${assertions} 项断言全通（全部谓词正反例 / 禁用短语 / 越权工具 / 结束协议 / JSON 一次重试 / 两边预算 / pass^k / 真实引擎观察口）`,
  );
} finally {
  await runtime.close();
  await Promise.all([customer.close(), sales.close()]);
}
