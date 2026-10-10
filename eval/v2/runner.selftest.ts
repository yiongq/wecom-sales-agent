import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaseV2, runCasesV2, runV2, V2Worker, loadCases, type CaseResult } from './run.js';
import { validateCase, type CaseV2 } from './schema.js';
import { normalize, resolveValues, resolvePattern } from './values.js';
import { startFakeModel } from './fake-model.js';
import { resetCaseState, resetModuleNames } from './isolation.js';
import { compareCaseSnapshot, createSnapshot, observeTurn, readBaseline, serializeSnapshot } from './snapshot.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { Order } from '../../src/types.js';

// 临时目录断言只检查本次自测，允许独立评测同时运行。
const selftestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-v2-selftest-'));
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = selftestDir;
process.once('exit', () => fs.rmSync(selftestDir, { recursive: true, force: true }));

const base: CaseV2 = {
  version: 2,
  id: 'v2-selftest',
  desc: '脚本消费契约',
  tags: [],
  fixtures: { now: '2026-10-02T12:00:00+08:00' },
  turns: [{ say: '你好，想了解旅游', script: [{ content: '您好，请问想去哪里玩？' }], expect: {} }],
};
let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

await test('缺清理回调时在重置之前报缺失文件与搬家提示', async () => {
  const resets = Reflect.get(globalThis, Symbol.for('wecom.eval.v2.resets')) as Map<string, () => void>;
  const previous = new Map(resets);
  let calls = 0;
  try {
    for (const name of resetModuleNames) resets.set(name, () => calls++);
    resets.delete('llm.ts');
    await assert.rejects(resetCaseState(selftestDir), {
      message: 'v2 isolation: 清理回调未登记：llm.ts；模块搬家后要同步改 eval/v2/isolation.ts',
    });
    assert.equal(calls, 0);
    assert.ok(fs.existsSync(selftestDir));
  } finally {
    resets.clear();
    for (const [name, reset] of previous) resets.set(name, reset);
  }
});

await test('脚本耗尽报 case / 轮次 / 请求', async () => {
  const c = structuredClone(base);
  c.turns[0].script = [];
  const r = await runCaseV2(c);
  assert.equal(r.pass, false);
  assert.match(r.failures.join('\n'), /\[v2-selftest\] 第1轮 第1次请求：脚本耗尽/);
});
await test('脚本剩余报下一个请求位置', async () => {
  const c = structuredClone(base);
  c.turns[0].script!.push({ content: '多余脚本' });
  const r = await runCaseV2(c);
  assert.equal(r.pass, false);
  assert.match(r.failures.join('\n'), /第1轮 第2次请求：脚本剩余 1 项/);
});
await test('未解析占位在脚本和 expect 都失败，保留占位原文', async () => {
  for (const location of ['script', 'expect']) {
    const c = structuredClone(base);
    const token = '{{call:missing.payUrl}}';
    if (location === 'script') c.turns[0].script = [{ content: token }];
    else c.turns[0].expect.replyMatches = [token];
    const r = await runCaseV2(c);
    assert.equal(r.pass, false);
    assert.ok(r.failures.some((s) => s.includes(token)));
  }
});
await test('订单号与方案版本归一后相等，并实际用于回复正反断言', async () => {
  const a = 'ord_0123456789abcdef01234567';
  const b = 'ord_abcdef0123456789abcdef01';
  assert.equal(normalize(`/pay/${a} /proposal/r/2?v=8`), normalize(`/pay/${b} /proposal/r/2`));
  assert.equal(normalize('/proposal/r/2?a=1&v=8&b=2'), '/proposal/r/2?a=1&b=2');
  assert.equal(normalize('^/proposal/r/2\\?v=8$'), '^/proposal/r/2$');
  const cases = loadCases(path.resolve('eval/cases-v2'));
  const c = cases.find((item) => item.id === 'travel-engine-164-order-smoke')!;
  c.turns[0].expect.replyMatches = [`/pay/${a}`];
  c.turns[0].expect.replyExcludes = [`/pay/${a}/bad`];
  assert.equal((await runCaseV2(c)).pass, true);
});
await test('字段类型、版本和未知字段报 case id 与完整字段路径', () => {
  assert.throws(() => validateCase({ ...base, version: 3 }), /v2-selftest.*version/);
  assert.throws(() => validateCase({ ...base, surprise: true }), /v2-selftest.*\$\.surprise/);
  const c = structuredClone(base) as unknown as { turns: { expect: { tools: unknown } }[] };
  c.turns[0].expect.tools = [5];
  assert.throws(() => validateCase(c), /v2-selftest.*turns\.0\.expect\.tools\.0/);
  assert.throws(() => validateCase({ ...base, fixtures: { session: { typo: 1 } } }), /fixtures\.session\.typo/);
  const invalidRegex = structuredClone(base);
  invalidRegex.turns[0].expect.replyMatches = ['['];
  assert.throws(() => validateCase(invalidRegex), /turns\.0\.expect\.replyMatches\.0.*无效正则/);
});
await test('嵌套字段 / 数组索引与整串参数占位保留数字类型', () => {
  const values = { calls: new Map<string, unknown>([['quote', { rows: [{ total: 123 }] }]]), orders: () => [{ id: 'fixture-order' }] };
  assert.deepEqual(resolveValues({ total: '{{call:quote.rows.0.total}}', content: '单号 {{order:0.id}}' }, values), {
    total: 123,
    content: '单号 fixture-order',
  });
  assert.throws(() => resolveValues('{{order:9.id}}', values), /\{\{order:9.id\}\}/);
  assert.equal(resolveValues('{{call:quote.rows.0.total}}', values, false), '123');
  values.calls.set('quote', { title: '线路(A)+[体验]' });
  assert.ok(new RegExp(resolvePattern('^{{call:quote.title}}$', values)).test('线路(A)+[体验]'));
});
await test('本轮预取结果可用于工具参数，上一轮工具结果可用于下一轮脚本', async () => {
  const c = structuredClone(base);
  c.turns = [
    {
      say: '想去云南，2人，2026-12-10出发，请报个价',
      script: [
        { toolCalls: [{ name: 'create_quote', args: { routeId: '{{call:search_routes.0.id}}', travelers: 2, departDate: '2026-12-10' } }] },
        { content: '请问还需要了解什么？<state>{"stage":"quote"}</state>' },
      ],
      expect: { stage: 'quote', tools: ['search_routes', 'create_quote'], orders: { count: 0 } },
    },
    {
      say: '刚才报价是哪条线路？',
      script: [{ content: '刚才是{{call:create_quote.routeTitle}}。' }],
      expect: { replyMatches: ['{{call:create_quote.routeTitle}}'] },
    },
  ];
  const result = await runCaseV2(c);
  assert.equal(result.pass, true, result.failures.join('\n'));
});
await test('服务断言失败后 finally 关闭监听；SSE 与非流式工具响应', async () => {
  const fake = await startFakeModel('close-test', { calls: new Map(), orders: () => [] });
  const endpoint = `${fake.url}/chat/completions`;
  try {
    fake.begin(1, [{ toolCalls: [{ name: 'create_quote', args: { travelers: 2 } }] }]);
    const json = (await (await fetch(endpoint, { method: 'POST', body: JSON.stringify({ messages: [] }) })).json()) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"travelers":2}');
    fake.begin(2, [{ content: '流式', toolCalls: [{ name: 'search_routes', args: {} }] }]);
    const streamed = await (await fetch(endpoint, { method: 'POST', body: JSON.stringify({ messages: [], stream: true }) })).text();
    assert.match(streamed, /"delta".*流式.*"index":0/);
    assert.match(streamed, /data: \[DONE\]/);
    fake.begin(3, []);
    await fetch(endpoint, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    assert.throws(() => assert.equal(fake.errors.length, 0));
  } finally {
    await fake.close();
  }
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(1000) }));
});
await test('文本工具调用兜底的完整结果也可解析占位', async () => {
  const c = structuredClone(base);
  c.turns[0].say = '想去云南，2人，2026-12-10出发，请报个价';
  c.turns[0].script = [
    {
      content:
        '<tool_call>create_quote<arg_key>routeId</arg_key><arg_value>{{call:search_routes.0.id}}</arg_value><arg_key>travelers</arg_key><arg_value>2</arg_value></tool_call>',
    },
    { content: '刚才是{{call:create_quote.routeTitle}}。<state>{"stage":"quote"}</state>' },
  ];
  c.turns[0].expect = { replyMatches: ['{{call:create_quote.routeTitle}}'], stage: 'quote', tools: ['search_routes', 'create_quote'] };
  const result = await runCaseV2(c);
  assert.equal(result.pass, true, result.failures.join('\n'));
});
await test('失败 / 超时后临时目录已清理且后续 case 可跑', async () => {
  const dirs = () =>
    fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith('wecom-eval-v2-'))
      .toSorted();
  const before = dirs();
  const c = structuredClone(base);
  c.turns[0].expect.stage = 'paid';
  assert.equal((await runCaseV2(c)).pass, false);
  const timed = await runCaseV2(base, 1);
  assert.equal(timed.pass, false);
  assert.match(timed.failures.join('\n'), /超时/);
  assert.deepEqual(dirs(), before);
  assert.equal((await runCaseV2(base)).pass, true);
});
// 只归一运行随机量：比较客户全文、阶段、所有订单业务字段与工具名顺序。
function comparable(result: CaseResult) {
  const turns = (result.turns ?? []) as {
    reply: Record<string, unknown>;
    orders: Record<string, unknown>[];
    trace?: { turn: { calls: { name: string }[] } };
  }[];
  return {
    id: result.id,
    pass: result.pass,
    checks: result.checks,
    guardSkipped: result.guardSkipped,
    failures: result.failures.map(normalize),
    turns: turns.map((t) => ({
      reply: JSON.parse(normalize(JSON.stringify(t.reply))),
      orders: t.orders.map((order) =>
        Object.fromEntries(
          Object.entries(order)
            .filter(([key]) => !['createdAt', 'paidAt', 'confirmedAt'].includes(key))
            .map(([key, value]) => [key, typeof value === 'string' ? normalize(value) : value]),
        ),
      ),
      tools: t.trace?.turn.calls.map((c) => c.name),
    })),
  };
}

const all = loadCases(path.resolve('eval/cases-v2'));
const snapshotStarted = performance.now();
let snapshotResults: CaseResult[] = [];
await test('快照稳定：同一组真实引擎 case 两遍逐字节相同，case/键排序且保留护栏与订单', async () => {
  const previous = process.env.CONFIG_TEST_DB;
  process.env.CONFIG_TEST_DB = '';
  const worker = new V2Worker();
  try {
    const cases = [base, all.find((c) => c.id === 'travel-engine-1693-02')!];
    const first: CaseResult[] = [];
    const second: CaseResult[] = [];
    for (const c of cases) first.push(await worker.run(c));
    for (const c of cases) second.push(await worker.run(c));
    for (const r of [...first, ...second]) assert.equal(r.pass, true, r.failures.join('\n'));
    assert.equal(await serializeSnapshot(createSnapshot(first)), await serializeSnapshot(createSnapshot(second.reverse())));
    assert.ok(first[1].observations![1].guard_events.length > 0);
    assert.equal(first[1].observations![1].orders.last!.travelers, 2);
    assert.match(first[1].observations![1].text, /ord_NORMALIZED/);
    snapshotResults = first;
  } finally {
    await worker.close();
    if (previous === undefined) delete process.env.CONFIG_TEST_DB;
    else process.env.CONFIG_TEST_DB = previous;
  }
});
await test('快照抓住一个字、额外工具、缺少护栏、订单人数的变化，错误定位到对应字段', () => {
  const original = structuredClone(snapshotResults[1]);
  original.observations![1].text = '前'.repeat(45) + '原';
  const expected = createSnapshot([original]).cases[0];
  for (const [field, change] of [
    ['text', (r: CaseResult) => (r.observations![1].text = '前'.repeat(45) + '改')],
    ['tools.length', (r: CaseResult) => r.observations![1].tools.push('create_quote')],
    ['guard_events.length', (r: CaseResult) => r.observations![1].guard_events.pop()],
    ['orders.last.travelers', (r: CaseResult) => (r.observations![1].orders.last!.travelers = 3)],
  ] as const) {
    const changed = structuredClone(original);
    change(changed);
    const errors = compareCaseSnapshot(changed, expected);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.ok(errors[0].includes(`[${original.id}] 第2轮 snapshot.${field}:`), errors[0]);
    if (field === 'text') {
      assert.ok(errors[0].includes(changed.observations![1].text));
      assert.ok(errors[0].includes(expected.turns[1].text.head));
      assert.ok(errors[0].includes(expected.turns[1].text.sha256));
    }
  }
  const changedGuard = structuredClone(original);
  changedGuard.observations![1].guard_events[0].removed[0] += '改';
  assert.match(compareCaseSnapshot(changedGuard, expected).join('\n'), /snapshot\.guard_events\.0\.removed\.0/);
  assert.match(compareCaseSnapshot(original).join('\n'), /snapshot\.case/);
});
await test('归一只处理已知运行量；业务日期、金额、条目 id 与重复护栏摘要保持可比', () => {
  const order = {
    id: 'ord_0123456789abcdef01234567',
    sessionId: 'eval:test',
    createdAt: 1790913600123,
    routeId: 'r-yunnan',
    routeTitle: '云南',
    travelers: 2,
    departDate: '2026-12-10',
    totalPrice: 12345,
    status: 'pending_payment',
    catalogVersion: 1,
  } as Order;
  const finished = {
    turn: {
      conversationId: order.sessionId,
      turnId: 'random-turn',
      startedAt: order.createdAt,
      calls: [{ name: 'search_routes' }],
      guards: [{ guard: 'order_net', action: 'replace', removed: ['旧', '旧'], added: [order.id], at: order.createdAt }],
    },
  } as FinishedTurn;
  const text = `${order.id} /proposal/r/2?v=8 ${order.sessionId} random-turn ${order.createdAt} ${new Date(order.createdAt).toISOString()} 2026-12-10 12345 r-yunnan`;
  const observation = observeTurn({ text, stage: 'closing' }, true, [order], finished);
  assert.equal(
    observation.text,
    'ord_NORMALIZED /proposal/r/2 SESSION_NORMALIZED TURN_NORMALIZED TIME_NORMALIZED TIME_NORMALIZED 2026-12-10 12345 r-yunnan',
  );
  assert.deepEqual(observation.orders.last, {
    routeId: 'r-yunnan',
    routeTitle: '云南',
    travelers: 2,
    departDate: '2026-12-10',
    totalPrice: 12345,
    status: 'pending_payment',
  });
  assert.deepEqual(observation.guard_events, [{ guard: 'order_net', action: 'replace', removed: ['旧', '旧'], added: ['ord_NORMALIZED'] }]);
});
await test('运行入口支持自定义基线、差异判失败、off 跳过比对，失败时不覆盖快照', async () => {
  const previous = process.env.EVAL_V2_BASELINE;
  const previousDb = process.env.CONFIG_TEST_DB;
  const previousArgv = process.argv;
  const log = console.log;
  const output: string[] = [];
  const target = path.join(selftestDir, 'snapshot.json');
  const content = await serializeSnapshot(createSnapshot(snapshotResults));
  fs.writeFileSync(target, content);
  process.env.CONFIG_TEST_DB = '';
  process.argv = [process.execPath, 'eval/run.ts', '--cases-v2', 'selftest'];
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  try {
    process.env.EVAL_V2_BASELINE = target;
    const c = structuredClone(base);
    c.turns[0].script = [{ content: '您好，请问想去哪里玩呀？' }];
    assert.equal(await runV2([c]), false);
    assert.match(output.join('\n'), /v2-selftest.*第1轮 snapshot\.text:/);
    output.length = 0;
    process.env.EVAL_V2_BASELINE = 'off';
    assert.equal(readBaseline(), undefined);
    assert.equal(await runV2([c]), true);
    assert.ok(!output.join('\n').includes('快照比对'));
    process.argv.push('--v2-snapshot-write', target);
    c.turns[0].script = [];
    assert.equal(await runV2([c]), false);
    assert.equal(fs.readFileSync(target, 'utf8'), content);
    c.turns[0].script = base.turns[0].script;
    assert.equal(await runV2([c]), true);
    assert.equal(fs.readFileSync(target, 'utf8'), await serializeSnapshot(createSnapshot([snapshotResults[0]])));
  } finally {
    process.argv = previousArgv;
    console.log = log;
    if (previous === undefined) delete process.env.EVAL_V2_BASELINE;
    else process.env.EVAL_V2_BASELINE = previous;
    if (previousDb === undefined) delete process.env.CONFIG_TEST_DB;
    else process.env.CONFIG_TEST_DB = previousDb;
  }
});
console.log(`v2 快照新增自测耗时：${((performance.now() - snapshotStarted) / 1000).toFixed(2)}s`);
// 每个来源文件取前两条，再补重置、订单全流程及相隔较远的节假日。
const fullSample = fs
  .readdirSync('eval/cases-v2')
  .filter((f) => f.endsWith('.json'))
  .toSorted()
  .flatMap((f) => loadCases(path.resolve('eval/cases-v2', f)).slice(0, 2));
for (const id of ['travel-engine-771-01', 'travel-engine-820', 'travel-engine-164', 'travel-holiday-talk-186-model']) {
  const c = all.find((c) => c.id === id);
  assert.ok(c, id);
  if (!fullSample.some((s) => s.id === c.id)) fullSample.push(c);
}
const sessionQuota = structuredClone(base);
sessionQuota.id = 'v2-session-quota';
sessionQuota.desc = '同一访客第 61 轮降级，下一条 case 恢复额度';
sessionQuota.turns = Array.from({ length: 61 }, (_, i) => ({
  say: `这是第${i + 1}次咨询。`,
  script: i < 60 ? [{ content: `已记下第${i + 1}条需求。` }] : [],
  expect: { orders: { count: 0 } },
}));
const badScript = structuredClone(base);
badScript.id = 'v2-pool-script-failure';
badScript.turns[0].script = [];
const badExpect = structuredClone(base);
badExpect.id = 'v2-pool-expect-failure';
badExpect.turns[0].expect.replyMatches = ['{{call:missing.payUrl}}'];
fullSample.push(sessionQuota, badScript, badExpect);
assert.equal(fullSample.length, 46);
// 默认覆盖建单、接管、重置、跨年节假日、价格护栏与额度；完整来源覆盖按需开启。
const sample =
  process.env.EVAL_V2_EQUIV_FULL === '1'
    ? fullSample
    : [
        ...[
          'travel-engine-164-order-smoke',
          'travel-engine-196-smoke',
          'travel-engine-771-01',
          'travel-engine-820',
          'travel-holiday-01',
          'travel-holiday-talk-186-model',
          'travel-price-59-01',
          'travel-price-59-02',
        ].map((id) => {
          const c = all.find((c) => c.id === id);
          assert.ok(c, id);
          return c;
        }),
        sessionQuota,
        badScript,
        badExpect,
      ];

for (const mode of ['file', 'pglite']) {
  await test(`${mode}：${sample.length} 条 case，2 worker 与串行隔离逐条等价（含失败信息）`, async () => {
    const previous = process.env.CONFIG_TEST_DB;
    process.env.CONFIG_TEST_DB = mode === 'pglite' ? 'pglite' : '';
    try {
      // 两组拥有独立进程 / 临时目录，隔离组内部仍逐条串行；可同时跑以减少门禁耗时。
      const [pooled, isolated] = await Promise.all([runCasesV2(sample, { workers: 2 }), runCasesV2(sample, { isolate: true })]);
      for (let i = 0; i < sample.length; i++) {
        assert.equal(pooled[i].pass, ![badScript.id, badExpect.id].includes(sample[i].id), pooled[i].failures.join('\n'));
        assert.deepEqual(comparable(pooled[i]), comparable(isolated[i]), sample[i].id);
      }
    } finally {
      if (previous === undefined) delete process.env.CONFIG_TEST_DB;
      else process.env.CONFIG_TEST_DB = previous;
    }
  });
  await test(`${mode}：同一 worker 建单 / 接管 / 重置 / 耗尽会话额度后仍从干净状态开始`, async () => {
    const previous = process.env.CONFIG_TEST_DB;
    process.env.CONFIG_TEST_DB = mode === 'pglite' ? 'pglite' : '';
    const worker = new V2Worker();
    try {
      const clean = all.find((c) => c.id === 'travel-engine-164-smoke')!;
      // 故意重复相同 id，防止只靠换 id 避开存储或会话预算污染。
      for (const c of [
        all.find((c) => c.id === 'travel-engine-164-order-smoke')!,
        all.find((c) => c.id === 'travel-engine-196-smoke')!,
        all.find((c) => c.id === 'travel-engine-771-01')!,
        sessionQuota,
        sessionQuota,
      ]) {
        assert.equal((await worker.run(c)).pass, true, c.id);
        const fresh = await worker.run(clean);
        assert.equal(fresh.pass, true, fresh.failures.join('\n'));
      }
    } finally {
      await worker.close();
      if (previous === undefined) delete process.env.CONFIG_TEST_DB;
      else process.env.CONFIG_TEST_DB = previous;
    }
  });
}
await test('同一 worker 每条 case 重新获得日额度，保留单 case 的日额度降级', async () => {
  const previous = process.env.DAILY_VISITOR_LLM_CALLS;
  process.env.DAILY_VISITOR_LLM_CALLS = '2';
  const c = structuredClone(sessionQuota);
  c.id = 'v2-daily-quota';
  c.turns = c.turns.slice(0, 3);
  c.turns[2].script = [];
  try {
    const pooled = await runCasesV2([c, c, c, c], { workers: 1 });
    const isolated = await runCaseV2(c);
    assert.equal(isolated.pass, true, isolated.failures.join('\n'));
    for (const r of pooled) assert.deepEqual(comparable(r), comparable(isolated));
  } finally {
    if (previous === undefined) delete process.env.DAILY_VISITOR_LLM_CALLS;
    else process.env.DAILY_VISITOR_LLM_CALLS = previous;
  }
});
await test('池内超时只终止受影响 worker，替补继续，异常路径不残留临时目录', async () => {
  const dirs = () =>
    fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith('wecom-eval-v2-'))
      .toSorted();
  const before = dirs();
  const broken = new V2Worker();
  const healthy = new V2Worker();
  try {
    assert.equal((await broken.run(base)).pass, true);
    assert.equal((await healthy.run(base)).pass, true);
    const [timed, other] = await Promise.all([broken.run(sessionQuota, 1), healthy.run(base)]);
    assert.equal(timed.pass, false);
    assert.match(timed.failures.join('\n'), /超时/);
    assert.equal(other.pass, true, other.failures.join('\n'));
    const failure = await broken.run(badScript);
    assert.equal(failure.pass, false);
    assert.equal((await broken.run(base)).pass, true);
    assert.equal((await healthy.run(base)).pass, true);
  } finally {
    await Promise.all([broken.close(), healthy.close()]);
  }
  assert.deepEqual(dirs(), before);
});
console.log(`v2 runner 自测：${passed}/${passed} 通过`);

if (previousTmp === undefined) delete process.env.TMPDIR;
else process.env.TMPDIR = previousTmp;
