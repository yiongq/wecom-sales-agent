import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { hostRuntime } from '../../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-selftest-'));
process.env.VAR_DIR = dir;
process.env.LLM_PROVIDER = '';
process.env.LLM_API_KEY = 'fixture'; // gitleaks:allow
process.env.LLM_MODEL = 'glm-5.2';
process.env.LLM_VISION_MODEL = '';
process.env.LLM_MOCK = '0';
process.env.LLM_MAX_RETRY = '2';
process.env.LLM_MAX_INFLIGHT = '8';
process.env.LLM_VISION_MAX_INFLIGHT = '2';
process.env.LLM_HEDGE_MODEL = 'glm-5.2';
process.env.LLM_HEDGE_AFTER_MS = '1';

let requests = 0;
let mode: 'ok' | 'fenced' | 'bad-json' | 'schema' | 'bad-envelope' | 'length' | 'hold' | 'slow-body' | 'error' = 'ok';
let status = 500;
let lastBody: Record<string, any> = {};
const pending: (() => void)[] = [];
const completion = (content = '{"part":"A1","qty":2}', finishReason = 'stop') => ({
  choices: [{ message: { content }, finish_reason: finishReason }],
  usage: {
    prompt_tokens: 600,
    completion_tokens: 24,
    prompt_tokens_details: { cached_tokens: 12 },
    completion_tokens_details: { reasoning_tokens: 4 },
  },
});
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  lastBody = JSON.parse(Buffer.concat(chunks).toString());
  requests++;
  res.setHeader('content-type', 'application/json');
  const send = () => res.end(JSON.stringify(completion()));
  if (mode === 'hold' || mode === 'slow-body') {
    if (mode === 'slow-body') res.flushHeaders();
    pending.push(send);
  } else if (mode === 'error') {
    res.statusCode = status;
    res.end('{"error":{"code":"1210","message":"thinking required"}}');
  } else if (mode === 'bad-envelope') res.end('not JSON');
  else
    res.end(
      JSON.stringify(
        completion(
          mode === 'bad-json'
            ? 'not JSON'
            : mode === 'schema'
              ? '{"qty":"wrong"}'
              : mode === 'fenced'
                ? '```json\n{"part":"A1","qty":2}\n```'
                : undefined,
          mode === 'length' ? 'length' : undefined,
        ),
      ),
    );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const addr = server.address();
assert.ok(addr && typeof addr !== 'string');
// 本机路径包含 bigmodel，让思考参数走与真实智谱相同的分支。
process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}/bigmodel`;
const { vision } = await import('./vision.js');
const { onUsage, costOf } = await import('../../usage.js');
const { onLlmCall, observeRequests, thinkingParams, llmStats } = await import('./client.js');
const { gateStatus, gatedFetch } = await import('../../llm-gate.js');
const { withTurnScope, startTurn, endTurn, onTurnEnd } = await import('../../trace/recorder.js');
const events: import('../../usage.js').UsageEvent[] = [];
const calls: import('./client.js').CallTrace[] = [];
const unsubscribe = onUsage((event) => events.push(event));
const untrace = onLlmCall((call) => calls.push(call));
let prefixes = 0;
observeRequests(() => prefixes++);
const schema = z.object({ part: z.string(), qty: z.number().int().positive() });
let sequence = 0;
const request = () => ({
  bytes: Uint8Array.from([1, 2, 3]),
  mime: 'image/png' as const,
  prompt: '只读取型号与数量',
  schema,
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  sessionId: `vision-test-${sequence++}`,
});
const fail = { ok: false, reason: 'failed' };
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, '等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const statsBefore = llmStats();
const timeout = AbortSignal.timeout;
const budget = hostRuntime().budget;
const reserve = budget.reserve.bind(budget);
const estimates: { purpose: string; estimate: number }[] = [];
budget.reserve = (purpose, estimate) => {
  estimates.push({ purpose, estimate });
  return reserve(purpose, estimate);
};
try {
  // 成功、data URL、参数复用、预占和恰好一条 vision 记账。
  assert.deepEqual(await vision(request()), { ok: true, value: { part: 'A1', qty: 2 } });
  assert.equal(requests, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.purpose, 'vision');
  assert.equal(events[0]?.promptTokens, 600);
  assert.equal(events[0]?.reasoningTokens, 4);
  assert.equal(lastBody.model, 'glm-5.3-flashx');
  assert.deepEqual(lastBody.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: request().prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ],
    },
  ]);
  assert.equal(lastBody.max_tokens, 100);
  assert.equal(lastBody.temperature, 0.1);
  assert.deepEqual(lastBody.response_format, { type: 'json_object' });
  assert.deepEqual(lastBody.thinking, thinkingParams(process.env.LLM_BASE_URL, 'glm-5.3-flashx').thinking);
  assert.equal(lastBody.reasoning_effort, 'low');
  assert.deepEqual(estimates[0], { purpose: 'vision', estimate: costOf('glm-5.3-flashx', request().prompt.length + 4000, 100) * 1000 });
  const estimate = estimates.at(-1);
  assert.equal((await vision({ ...request(), bytes: new Uint8Array(1024 * 1024) })).ok, true);
  assert.deepEqual(estimates.at(-1), estimate, '图字节变大不改变预占');
  // 第 13 步实测：模型常把 JSON 包在 ```json 代码块里；带 response_format 之外仍容忍这层包装。
  mode = 'fenced';
  assert.deepEqual(await vision(request()), { ok: true, value: { part: 'A1', qty: 2 } });
  mode = 'ok';
  console.log('vision: success / data URL / model params (json_object) / fenced JSON / one usage / token estimate');

  // HTTP、正文与 schema 失败均不抛，且每次只发一个请求。
  for (const next of ['bad-json', 'bad-envelope', 'schema', 'length'] as const) {
    mode = next;
    const before: number = requests;
    const usageBefore: number = events.length;
    assert.deepEqual(await vision(request()), fail);
    assert.equal(requests - before, 1, next);
    assert.equal(events.length - usageBefore, 1, next);
    assert.equal(calls.at(-1)?.error, 'bad_response');
  }
  mode = 'error';
  for (status of [429, 500, 400]) {
    const before: number = requests;
    assert.deepEqual(await vision(request()), fail);
    assert.equal(requests - before, 1, `HTTP ${status} 不重试、不自愈`);
  }
  console.log('vision: bad JSON / schema / truncation / HTTP / no retries or healing');

  // 独立并发池：响应头到了也占视觉名额，第三张排队；主对话仍可同时发八个。
  mode = 'slow-body';
  const before: number = requests;
  const jobs = [vision(request()), vision(request()), vision(request())];
  await until(() => requests === before + 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, before + 2);
  assert.deepEqual(gateStatus(), { inflight: 0, waiting: 0, maxInflight: 8 });
  mode = 'hold';
  const main = Array.from({ length: 9 }, () =>
    gatedFetch(process.env.LLM_BASE_URL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-5.2' }) }, () =>
      AbortSignal.timeout(5000),
    ),
  );
  await until(() => requests === before + 10);
  assert.deepEqual(gateStatus(), { inflight: 8, waiting: 1, maxInflight: 8 });
  pending.shift()!();
  await until(() => requests === before + 11);
  assert.deepEqual(gateStatus(), { inflight: 8, waiting: 1, maxInflight: 8 });
  while (pending.length) pending.shift()!();
  await until(() => requests === before + 12);
  while (pending.length) pending.shift()!();
  assert.ok((await Promise.all(jobs)).every((result) => result.ok));
  for (const response of await Promise.all(main)) {
    const body = await response.res.json();
    response.settleUsage(body);
  }
  assert.deepEqual(gateStatus(), { inflight: 0, waiting: 0, maxInflight: 8 });
  console.log('vision: third queues / body holds slot / independent main concurrency 8');

  // 固定时限换成短时钟，验证生产代码确实要求 30s 单次、40s 总时限。
  const durations: number[] = [];
  AbortSignal.timeout = (ms) => {
    durations.push(ms);
    return timeout(ms === 30_000 ? 35 : ms === 40_000 ? 90 : ms);
  };
  mode = 'slow-body';
  let n = requests;
  assert.deepEqual(await vision(request()), fail);
  assert.equal(requests - n, 1);
  assert.equal(calls.at(-1)?.error, 'timeout');
  assert.ok(durations.includes(30_000) && durations.includes(40_000));
  pending.splice(0).forEach((send) => send());
  AbortSignal.timeout = timeout;
  mode = 'hold';
  const controller = new AbortController();
  n = requests;
  const aborted = vision({ ...request(), signal: controller.signal });
  await until(() => requests === n + 1);
  controller.abort();
  assert.deepEqual(await aborted, fail);
  assert.equal(requests - n, 1);
  pending.splice(0).forEach((send) => send());
  n = requests;
  assert.deepEqual(await vision({ ...request(), signal: controller.signal }), fail);
  assert.equal(requests, n, '已取消不发请求');
  console.log('vision: request timeout / body timeout / abort');

  // 可配置并发为 1；排队的总时限到达后摘队，不会迟到发网络请求。
  process.env.LLM_VISION_MAX_INFLIGHT = '1';
  const blocker = new AbortController();
  const held = vision({ ...request(), signal: blocker.signal });
  await until(() => requests === n + 1);
  AbortSignal.timeout = (ms) => timeout(ms === 40_000 ? 30 : ms === 30_000 ? 500 : ms);
  assert.deepEqual(await vision(request()), fail);
  AbortSignal.timeout = timeout;
  assert.equal(requests, n + 1, '排队超总时限，不发请求');
  blocker.abort();
  assert.deepEqual(await held, fail);
  pending.splice(0).forEach((send) => send());
  mode = 'ok';
  assert.equal((await vision(request())).ok, true, '取消排队后名额可继续使用');
  process.env.LLM_VISION_MAX_INFLIGHT = '2';
  n = requests;
  console.log('vision: configurable pool / queued total deadline / no late request');

  // mock 既可固定 JSON，也可脚本；校验与取消仍生效，任何路径都不联网。
  process.env.LLM_MOCK = '1';
  assert.deepEqual(await vision({ ...request(), mock: { part: 'mock', qty: 3 } }), { ok: true, value: { part: 'mock', qty: 3 } });
  assert.deepEqual(await vision({ ...request(), mock: async () => '{"part":"script","qty":4}' }), {
    ok: true,
    value: { part: 'script', qty: 4 },
  });
  assert.deepEqual(await vision({ ...request(), mock: '{broken' }), fail);
  assert.deepEqual(await vision({ ...request(), mock: { qty: 'bad' } }), fail);
  AbortSignal.timeout = (ms) => timeout(ms === 40_000 ? 25 : ms);
  assert.deepEqual(await vision({ ...request(), mock: () => new Promise(() => {}) }), fail);
  AbortSignal.timeout = timeout;
  assert.equal(requests, n);
  console.log('vision: mock fixed / script / bad JSON / schema / deadline / no network');

  // 模型调用进入当前 trace，网页路由会据 llm.length 保留 dailyTurns；视觉不通知前缀观察器。
  let turn: import('../../trace/recorder.js').FinishedTurn | undefined;
  const off = onTurnEnd((value) => {
    turn = value;
  });
  await withTurnScope(async () => {
    startTurn('vision-test');
    await vision({ ...request(), mock: { part: 'trace', qty: 1 } });
    endTurn('deterministic', '识别完成', 'greeting', 'greeting');
  });
  off();
  assert.equal(turn?.turn.llm.length, 1);
  assert.equal(turn?.turn.llm[0]?.purpose, 'vision');
  process.env.LLM_MOCK = '0';
  await withTurnScope(async () => {
    startTurn('vision-tokens');
    const offTokens = onTurnEnd((value) => {
      turn = value;
    });
    assert.equal((await vision(request())).ok, true);
    endTurn('deterministic', '完成', 'greeting', 'greeting');
    offTokens();
  });
  assert.equal(turn?.turn.llm[0]?.promptTokens, 600);
  assert.equal(turn?.turn.llm[0]?.completionTokens, 24);
  assert.equal(turn?.turn.llm[0]?.reasoningTokens, 4);
  const beforeLimit = requests;
  const beforeUsage = events.length;
  const beforeCalls = calls.length;
  process.env.VISION_DAILY_PER_TENANT = '0';
  assert.deepEqual(await vision(request()), { ok: false, reason: 'limit' });
  assert.equal(requests, beforeLimit);
  assert.equal(events.length, beforeUsage);
  assert.equal(calls.length, beforeCalls);
  delete process.env.VISION_DAILY_PER_TENANT;
  assert.equal(prefixes, 0);
  const statsAfter = llmStats();
  for (const key of ['hedgeFired', 'hedgeWon', 'thinkingSelfHeal'] as const) assert.equal(statsAfter[key], statsBefore[key]);
  console.log('vision: turn trace / untouched prefix / no hedge');
} finally {
  AbortSignal.timeout = timeout;
  budget.reserve = reserve;
  unsubscribe();
  untrace();
  observeRequests(null);
  pending.splice(0).forEach((send) => send());
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
