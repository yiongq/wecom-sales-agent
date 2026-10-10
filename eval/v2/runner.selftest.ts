import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaseV2, loadCases } from './run.js';
import { validateCase, type CaseV2 } from './schema.js';
import { normalize, resolveValues, resolvePattern } from './values.js';
import { startFakeModel } from './fake-model.js';

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
console.log(`v2 runner 自测：${passed}/${passed} 通过`);
