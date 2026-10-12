// R15 / 验收 7：真实 HTTP 尝试、真实 PG（各自独立库）、恢复、取消与宿主回归。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-budget-'));
const initialFetch = globalThis.fetch;
const initialDate = Date;
const initialNow = Date.now;
const initialWarn = console.warn;
process.env.VAR_DIR = dir;
process.env.TZ = 'Asia/Shanghai';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MAX_RETRY = '1';
process.env.LLM_MAX_INFLIGHT = '2';
process.env.ALERT_WEBHOOK_URL = '';
process.env.LLM_MOCK = '1';
process.env.VISITOR_SESSION_LLM_CALLS = '1';
process.env.SANDBOX_LLM_CALLS = '5';
process.env.SANDBOX_LLM_CNY = '1';
process.env.SANDBOX_POOL_DAILY_CNY = '1';
const r = await import('../runtime.js');
const b = await import('./budget.js');
const u = await import('../../usage.js');
const daily = await import('../../trace/usage-daily.js');
const { gatedFetch, BudgetExhausted, gateStatus } = await import('../../llm-gate.js');
const { openTestDb, testConfigDeps, fakeLock } = await import('../../db/testing.js');
const { realReaperFixture } = await import('../../db/testing-reaper.js');
const { importConfig } = await import('../../config/transfer.js');
const { withTenant } = await import('../../db/client.js');
const { systemContext, expireBrokenSandbox, sandboxPoolHealth } = await import('../../db/sandbox-process.js');
const { addUsage } = await import('../../db/repo/usage.js');
const { provisionSandbox, SandboxProvisionError } = await import('./provision.js');
const { loadSandboxRuntime } = await import('./load.js');
const { SandboxReaper } = await import('./reaper.js');
const { dropTenantState, tenantKeys } = await import('../state.js');
const { dropShutdownHooks } = await import('../../shutdown.js');
const { handleMessage } = await import('../../core/engine/index.js');
const insight = await import('../../core/insight.js');
const { completeText, chat } = await import('../../core/llm/client.js');
const retrieval = await import('../../core/retrieval.js');
const store = await import('../../store.js');
const { __alertTest } = await import('../../ops/alert.js');
const { __consoleTest } = await import('../../console-api/app.js');
const { todayIso } = await import('../../env.js');
const { purgeSandbox } = await import('../../db/sandbox-reaper.js');
const { SandboxProcess } = await import('./process.js');
const { __sandboxLimitsTest } = await import('./limits.js');

type Db = import('../../db/client.js').Db;
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const scope = r.withTenantScope;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
const requests: { model: string; max_tokens?: number; input?: string[] }[] = [];
let failNext = false;
let malformed = false;
const model = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
  requests.push(body);
  if (failNext) {
    failNext = false;
    res.writeHead(500).end('retry');
    return;
  }
  if (malformed) {
    malformed = false;
    res.end('invalid json');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { content: '请先告诉我您的出发时间。' } }],
      data: body.input?.map(() => ({ embedding: [1, 0] })),
      usage: { prompt_tokens: 1000, completion_tokens: body.input ? 0 : 100 },
    }),
  );
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const baseUrl = `http://127.0.0.1:${(model.address() as import('node:net').AddressInfo).port}`;
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = baseUrl;
process.env.LLM_API_KEY = 'selftest';
process.env.LLM_MODEL = 'glm-5.2';
process.env.LLM_MODEL_CHEAP = 'glm-5.2';
process.env.EMBED_BASE_URL = baseUrl;
process.env.EMBED_API_KEY = 'selftest';
const gateRequest = { method: 'POST', body: JSON.stringify({ model: 'glm-5.2', max_tokens: 100, messages: [] }) };

async function detach(rt: import('../runtime.js').TenantRuntime): Promise<void> {
  await scope(rt, daily.flushUsageDaily);
  await rt.inflight.drain();
  await scope(rt, () => rt.store.pgBackend?.drain(2000));
  rt.state = 'closed';
  rt.store.pgBackend?.close();
  await rt.config.loaded?.lock.release();
  dropTenantState(rt.id);
  dropShutdownHooks(rt);
  r.unregisterRuntime(rt.id);
}
async function suite(db: Db, q: Query, acquire: (id: string) => Promise<import('../../db/client.js').TenantLock | null>) {
  __sandboxLimitsTest.resetProvisioned();
  r.configureTenancy({ role: 'sandbox', standardCount: 0 });
  process.env.SESSION_STORE = 'db';
  process.env.LLM_MOCK = '1';
  const [host] = await q<{ id: string }>("insert into tenants(slug,name,pack_id) values('budget-template','模板','travel') returning id");
  const hostRt = r.createTenantRuntime({ id: host!.id, slug: 'budget-template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: hostRt.slug, usePackRuntime: true });
  assert.equal((await scope(hostRt, () => importConfig({ ...deps, dataDir: 'data' }))).code, 0);
  const env = { ...process.env, SANDBOX_PER_HOUR: '100', SANDBOX_PER_IP_DAY: '100' };
  const options = {
    deps,
    env,
    templateSlug: hostRt.slug,
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: acquire,
    ip: null,
    userAgent: null,
  };
  const box = async () => {
    const created = await provisionSandbox(options);
    return { ...created, rt: r.runtimeOf(created.tenantId)! };
  };
  const a = await box();
  const other = await box();
  const failed = await box();
  const cancelled = await box();
  const embedCancelled = await box();
  const stopping = await box();
  const outdated = await box();
  const orderBox = await box();
  const handoffBox = await box();
  const traceBox = await box();
  const timeoutBox = await box();
  const blocked = await box();
  const restart = { id: a.rt.id, slug: a.slug, expiresAt: a.expiresAt };
  process.env.LLM_MOCK = '0';
  const begin = requests.length;
  failNext = true;
  const retry = await scope(a.rt, () => gatedFetch(baseUrl + '/chat/completions', gateRequest, () => AbortSignal.timeout(5000)));
  const retryData = await retry.res.json();
  scope(a.rt, () => {
    retry.settleUsage(retryData);
    retry.settleUsage(retryData);
  });
  check(() => assert.equal(retry.attempts, 2, '500 → 200 在尝试层计两次'));
  const retryCost = (u.sandboxCostOf('glm-5.2', Buffer.byteLength(gateRequest.body), 100, 0, true) + u.costOf('glm-5.2', 1000, 100)) * 1000;
  check(() => assert.ok(Math.abs(scope(a.rt, () => a.rt.budget.status().costMilli) - retryCost) < 1e-6, '500 记预占，200 只记实际费用'));
  check(() =>
    assert.equal(
      scope(a.rt, () => a.rt.budget.status().calls),
      2,
    ),
  );
  check(() =>
    assert.equal(
      scope(a.rt, () => daily.__usageDailyTest.pending().reduce((n, p) => n + p.calls, 0)),
      2,
      '失败及成功各记一次',
    ),
  );
  const subjects = scope(a.rt, () => ['one', 'two', 'three'].map((id) => store.getOrCreateSession(`sbx-${id}`, 'simulator')));
  await Promise.all([
    scope(a.rt, () => handleMessage(subjects[0]!.id, '你好', 'simulator')),
    scope(a.rt, () => handleMessage(subjects[1]!.id, '你好', 'simulator')),
    scope(a.rt, insight.getInsights),
    scope(a.rt, () => handleMessage(subjects[2]!.id, '你好', 'simulator')),
  ]);
  check(() => assert.equal(requests.length - begin, 5, '多会话与洞察并发只发五次尝试'));
  check(() =>
    assert.ok(
      requests.slice(begin + 2).every((req) => req.max_tokens === 4096),
      '沙箱缺省输出上限确实发送 max_tokens=4096',
    ),
  );
  check(() =>
    assert.equal(
      scope(a.rt, () => a.rt.budget.status().calls),
      5,
    ),
  );
  await scope(a.rt, () => handleMessage(subjects[0]!.id, '你好', 'simulator'));
  await scope(a.rt, () => a.rt.store.pgBackend!.drain(2000));
  const traces = await q<{ outcome: string }>('select outcome from turn_traces where tenant_id=$1', [a.rt.id]);
  check(() =>
    assert.ok(
      traces.some((t) => t.outcome === 'budget'),
      '拒绝的对话通过 forceMock 写 budget trace',
    ),
  );
  check(() => assert.equal(requests.length - begin, 5, '降级不多发模型请求'));

  for (const purpose of ['insight', 'suggestion', 'draft'] as const) {
    try {
      await scope(a.rt, () => completeText('system', 'user', { purpose }));
      assert.fail('预算耗尽应抛出');
    } catch (error) {
      check(() => assert.deepEqual(__consoleTest.mapError(error), { status: 429, body: { error: 'llm_budget_exhausted' } }));
    }
  }
  for (const fn of [() => insight.getSuggestion(subjects[0]!), () => insight.getDraftReply(subjects[0]!)])
    await assert.rejects(scope(a.rt, fn), BudgetExhausted);

  // 只剩一次尝试：模型先建单，下一次往返被预算拒绝，不能再整轮调用 mock 建单。
  for (let i = 0; i < 4; i++) {
    const res = await scope(orderBox.rt, () => gatedFetch(baseUrl + '/chat/completions', gateRequest, () => AbortSignal.timeout(5000)));
    const data = await res.res.json();
    scope(orderBox.rt, () => res.settleUsage(data));
  }
  let orderWrites = 0;
  orderBox.rt.pack = {
    ...orderBox.rt.pack,
    runtime: {
      ...orderBox.rt.pack.runtime,
      preModel: undefined,
      prefetch: undefined,
      tools: orderBox.rt.pack.runtime.tools.map((tool) => ({
        ...tool,
        execute: async (args, ctx) => {
          if (tool.def.function.name === 'create_order') orderWrites++;
          return tool.execute(args, ctx);
        },
      })),
    },
  };
  const orderSession = scope(orderBox.rt, () => store.getOrCreateSession('sbx-write-once', 'simulator'));
  const route = scope(orderBox.rt, () => orderBox.rt.pack.runtime.retrievalItems()[0]!.code);
  const fetchBeforeWrite = globalThis.fetch;
  let orderRequests = 0;
  globalThis.fetch = async () => {
    orderRequests++;
    return Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'write-once',
                type: 'function',
                function: { name: 'create_order', arguments: JSON.stringify({ routeId: route, travelers: 2, departDate: '2026-11-01' }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    });
  };
  try {
    await scope(orderBox.rt, () => handleMessage(orderSession.id, '就订这个，2个人，2026-11-01出发', 'simulator'));
    check(() => assert.equal(orderWrites, 1, '写型工具已执行后预算不足不重跑 mock'));
    check(() => assert.equal(orderSession.orderIds.length, 1, '预算收尾保留唯一已创建订单'));
    check(() => assert.equal(orderRequests, 1, '第二次往返预占失败不发送'));
    await scope(orderBox.rt, () => orderBox.rt.store.pgBackend!.drain(2000));
    const [trace] = await q<{ outcome: string; llm: { promptTokens: number; completionTokens: number }[] }>(
      'select outcome,llm from turn_traces where tenant_id=$1 and conversation_id=$2',
      [orderBox.rt.id, orderSession.id],
    );
    check(() => assert.equal(trace!.outcome, 'budget', '写型工具后预算收尾仍记录 budget'));
    check(() => assert.equal(trace!.llm[0]!.promptTokens, 123, '单次成功模型的 trace token 不为零'));
  } finally {
    globalThis.fetch = fetchBeforeWrite;
  }

  for (let i = 0; i < 4; i++) {
    const res = await scope(handoffBox.rt, () => gatedFetch(baseUrl + '/chat/completions', gateRequest, () => AbortSignal.timeout(5000)));
    const data = await res.res.json();
    scope(handoffBox.rt, () => res.settleUsage(data));
  }
  let handoffWrites = 0;
  handoffBox.rt.pack = {
    ...handoffBox.rt.pack,
    runtime: {
      ...handoffBox.rt.pack.runtime,
      preModel: undefined,
      prefetch: undefined,
      // 本例绕过入口的确定性转人工，专门验证模型工具后的预算收尾。
      engineHooks: { ...handoffBox.rt.pack.runtime.engineHooks, isHandoffIntent: () => false },
      tools: handoffBox.rt.pack.runtime.tools.map((tool) => ({
        ...tool,
        execute: async (args, ctx) => {
          if (tool.def.function.name === 'handoff_to_human') handoffWrites++;
          return tool.execute(args, ctx);
        },
      })),
    },
  };
  const handing = scope(handoffBox.rt, () => store.getOrCreateSession('sbx-handoff-once', 'simulator'));
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'handoff',
                type: 'function',
                function: { name: 'handoff_to_human', arguments: '{"reason":"客户主动要求人工"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    });
  try {
    await scope(handoffBox.rt, () => handleMessage(handing.id, '我要转人工', 'simulator'));
    check(() => assert.equal(handoffWrites, 1, '转人工后预算不足不重跑 mock'));
    check(() =>
      assert.equal(
        handing.messages.filter((m) => m.role === 'system' && m.content.startsWith('AI 已转人工')).length,
        1,
        '转人工只留一条执行记录',
      ),
    );
    // spec Revisions（第 20 步）：转人工的那一轮照常记 handoff，不被预算收尾盖掉
    await scope(handoffBox.rt, () => handoffBox.rt.store.pgBackend!.drain(2000));
    const [handoffTrace] = await q<{ outcome: string }>('select outcome from turn_traces where tenant_id=$1 and conversation_id=$2', [
      handoffBox.rt.id,
      handing.id,
    ]);
    check(() => assert.equal(handoffTrace?.outcome, 'handoff', '转人工后预算收尾仍记录 handoff'));
  } finally {
    globalThis.fetch = fetchBeforeWrite;
  }

  // 两次成功往返的 token 必须归各自调用，缓存和推理 token 也不能错位。
  traceBox.rt.pack = { ...traceBox.rt.pack, runtime: { ...traceBox.rt.pack.runtime, preModel: undefined, prefetch: undefined } };
  const tracing = scope(traceBox.rt, () => store.getOrCreateSession('sbx-trace-tokens', 'simulator'));
  let traceRequests = 0;
  globalThis.fetch = async () => {
    const n = ++traceRequests;
    return Response.json({
      choices: [
        {
          message:
            n === 1
              ? {
                  content: null,
                  tool_calls: [{ id: 'read', type: 'function', function: { name: 'search_routes', arguments: '{"destination":"三亚"}' } }],
                }
              : { content: '请先告诉我您的出发时间。' },
        },
      ],
      usage: {
        prompt_tokens: n * 111,
        completion_tokens: n * 11,
        prompt_tokens_details: { cached_tokens: n * 7 },
        completion_tokens_details: { reasoning_tokens: n * 3 },
      },
    });
  };
  try {
    await scope(traceBox.rt, () => handleMessage(tracing.id, '你好', 'simulator'));
    await scope(traceBox.rt, () => traceBox.rt.store.pgBackend!.drain(2000));
    const [trace] = await q<{ llm: Record<string, number>[] }>('select llm from turn_traces where tenant_id=$1 and conversation_id=$2', [
      traceBox.rt.id,
      tracing.id,
    ]);
    check(() =>
      assert.deepEqual(
        trace!.llm.map(({ promptTokens, completionTokens, cachedTokens, reasoningTokens }) => ({
          promptTokens,
          completionTokens,
          cachedTokens,
          reasoningTokens,
        })),
        [1, 2].map((n) => ({
          promptTokens: n * 111,
          completionTokens: n * 11,
          cachedTokens: n * 7,
          reasoningTokens: n * 3,
        })),
        '两次往返的 trace token 各归各位',
      ),
    );
  } finally {
    globalThis.fetch = fetchBeforeWrite;
  }

  const timedOut = new AbortController();
  let timeoutRequests = 0;
  globalThis.fetch = async (_url, init) => {
    timeoutRequests++;
    setTimeout(() => timedOut.abort(new DOMException('selftest', 'TimeoutError')), 20);
    return new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
    );
  };
  try {
    await assert.rejects(
      scope(timeoutBox.rt, () => gatedFetch(baseUrl + '/chat/completions', gateRequest, () => timedOut.signal)),
      { name: 'TimeoutError' },
    );
    check(() => assert.equal(timeoutRequests, 1, '单次超时没有再发已中止的重试'));
    check(() =>
      assert.ok(
        Math.abs(
          scope(timeoutBox.rt, () => timeoutBox.rt.budget.status().costMilli) -
            u.sandboxCostOf('glm-5.2', Buffer.byteLength(gateRequest.body), 100, 0, true) * 1000,
        ) < 1e-6,
        '单次请求超时按预占值记账',
      ),
    );
    check(() => assert.equal(scope(timeoutBox.rt, daily.__usageDailyTest.pending)[0]!.calls, 1, '超时进入 usage_daily 一次'));
  } finally {
    globalThis.fetch = fetchBeforeWrite;
  }

  // 首次索引仅占池；后续重建因单沙箱次数耗尽被挡，旧索引继续服务。
  const indexBase = b.sandboxBudgetPoolStatus().costMilli;
  await scope(other.rt, retrieval.buildIndex);
  check(() => assert.ok(scope(other.rt, retrieval.indexReady)));
  check(() =>
    assert.equal(
      scope(other.rt, () => other.rt.budget.status().calls),
      0,
      '首次共享索引不占租户',
    ),
  );
  check(() => assert.ok(b.sandboxBudgetPoolStatus().costMilli > indexBase));
  await b.flushSandboxIndexUsage();
  const poolRows = await q<{ calls: number }>('select calls::int as calls from sandbox_pool_daily where day=$1', [
    b.sandboxBudgetPoolStatus().day,
  ]);
  check(() => assert.equal(poolRows[0]!.calls, 1, '首次索引费用直接持久化进池'));
  await scope(a.rt, retrieval.buildIndex); // 相同目录复用共享索引，无收费请求。
  const indexIds = scope(a.rt, retrieval.__retrievalTest.indexIds);
  const beforeRebuild = requests.length;
  const originalText = other.rt.pack.runtime.retrievalText;
  other.rt.pack = { ...other.rt.pack, runtime: { ...other.rt.pack.runtime, retrievalText: (item) => originalText(item) + ' changed' } };
  for (let i = 0; i < 5; i++) scope(other.rt, () => other.rt.budget.reserve('chat', 0)?.settle(0));
  scope(other.rt, retrieval.invalidateIndex);
  await scope(other.rt, retrieval.buildIndex);
  check(() => assert.ok(scope(other.rt, retrieval.indexReady), '预算拒绝重建后保留旧索引'));
  check(() => assert.equal(requests.length, beforeRebuild, '预算耗尽没有新的 embedding 请求'));
  check(() => assert.ok(indexIds.length > 0));

  // 无法解析的成功 HTTP 响应同样按预占记（而非零 token、零成本）。
  const unknown = await scope(failed.rt, () =>
    gatedFetch(
      baseUrl + '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({ model: 'unknown-budget-test', max_tokens: 1000 }),
      },
      () => AbortSignal.timeout(5000),
      { purpose: 'insight', estimateMilli: 0 },
    ),
  );
  const unknownData = await unknown.res.json();
  scope(failed.rt, () => unknown.settleUsage(unknownData));
  check(() => assert.ok(scope(failed.rt, () => failed.rt.budget.status().costMilli) > 0, '未知价格也收费，调用方不能用零预占绕过'));
  const deniedAt = requests.length;
  await assert.rejects(
    scope(failed.rt, () =>
      gatedFetch(
        baseUrl + '/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify({ model: 'glm-5.2', max_tokens: 100, messages: [{ content: 'x'.repeat(200_000) }] }),
        },
        () => AbortSignal.timeout(5000),
        { estimateMilli: 0 },
      ),
    ),
    BudgetExhausted,
  );
  check(() => assert.equal(requests.length, deniedAt, '金额预占不足时一条 HTTP 尝试也不发'));
  const failedBefore = scope(failed.rt, () => failed.rt.budget.status());
  malformed = true;
  await scope(failed.rt, () => completeText('system', 'user', { purpose: 'draft' }));
  check(() =>
    assert.equal(
      scope(failed.rt, () => failed.rt.budget.status().calls),
      failedBefore.calls + 1,
    ),
  );
  check(() => assert.ok(scope(failed.rt, () => failed.rt.budget.status().costMilli) > failedBefore.costMilli));

  // 删除发生在响应正文读取期间：取消在其他 ALS 作用域触发也必须记在原租户。
  const realFetch = globalThis.fetch;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let headers!: () => void;
  const gotHeaders = new Promise<void>((resolve) => {
    headers = resolve;
  });
  globalThis.fetch = async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
    const read = response.json.bind(response);
    response.json = () => {
      headers();
      return read();
    };
    return response;
  };
  const inBody = scope(cancelled.rt, () => completeText('system', 'user', { purpose: 'draft' }));
  await gotHeaders;
  cancelled.rt.state = 'closing';
  r.withoutTenantScope(() => r.cancelTenantRuntime(cancelled.rt));
  body.enqueue(new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 100 } })));
  body.close();
  await inBody;
  globalThis.fetch = realFetch;
  const cancelledPending = scope(cancelled.rt, daily.__usageDailyTest.pending);
  check(() =>
    assert.equal(
      cancelledPending.reduce((n, p) => n + p.calls, 0),
      1,
      '取消正文只记一次预占',
    ),
  );
  check(() => assert.ok(cancelledPending[0]!.milli > u.costOf('glm-5.2', 1000, 100) * 1000));
  await scope(cancelled.rt, daily.flushUsageDaily);
  const spent = scope(cancelled.rt, () => cancelled.rt.budget.status().costMilli);
  await expireBrokenSandbox(db, cancelled.rt.id);
  const reaper = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 120 * 60_000, barrierMs: 5 });
  const poolBefore = await q<{ cost: number }>('select coalesce(sum(cost_milli),0)::int as cost from sandbox_pool_daily');
  await reaper.tick();
  const poolAfter = await q<{ cost: number }>('select coalesce(sum(cost_milli),0)::int as cost from sandbox_pool_daily');
  check(() => assert.equal(poolAfter[0]!.cost - poolBefore[0]!.cost, Math.floor(spent + 1e-6), '⑤ 合并取消费用'));
  check(() => assert.ok(Object.values(tenantKeys(cancelled.rt.id)).every((n) => n === 0)));

  // embedding 删除取消（此时已不是进程首次索引），按预占记入该租户 usage_daily。
  let received!: () => void;
  const receivedRequest = new Promise<void>((resolve) => {
    received = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    received();
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
    );
  };
  const embedText = embedCancelled.rt.pack.runtime.retrievalText;
  embedCancelled.rt.pack = {
    ...embedCancelled.rt.pack,
    runtime: { ...embedCancelled.rt.pack.runtime, retrievalText: (item) => embedText(item) + ' cancelled' },
  };
  const embedding = scope(embedCancelled.rt, retrieval.buildIndex);
  await receivedRequest;
  embedCancelled.rt.state = 'closing';
  r.cancelTenantRuntime(embedCancelled.rt);
  await embedding;
  globalThis.fetch = realFetch;
  check(() => assert.equal(scope(embedCancelled.rt, daily.__usageDailyTest.pending).filter((p) => p.purpose === 'embedding')[0]!.calls, 1));
  check(() => assert.ok(scope(embedCancelled.rt, () => embedCancelled.rt.budget.status().costMilli) > 0));

  // normal closing 不触发取消；在途完成只记实际用量一次。
  let finished!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finished = resolve;
  });
  globalThis.fetch = async () => {
    finished();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ choices: [{ message: { content: '完成' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  };
  const normal = scope(stopping.rt, () => completeText('system', 'user', { purpose: 'suggestion' }));
  await finishing;
  stopping.rt.state = 'closing';
  assert.equal(await normal, '完成');
  globalThis.fetch = realFetch;
  check(() =>
    assert.ok(Math.abs(scope(stopping.rt, () => stopping.rt.budget.status().costMilli) - u.costOf('glm-5.2', 1000, 100) * 1000) < 1e-6),
  );
  check(() => assert.equal(scope(stopping.rt, daily.__usageDailyTest.pending)[0]!.calls, 1));

  // 删除第 ② 步长期挂住：自己的用量留给 ③，不能把其他沙箱拖停。
  await scope(blocked.rt, () => completeText('system', 'user', { purpose: 'draft' }));
  let releaseBarrier!: () => void;
  const barrier = blocked.rt.inflight.track(
    new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    }),
  );
  await expireBrokenSandbox(db, blocked.rt.id);
  await reaper.tick();
  check(() => assert.ok(blocked.rt.state === 'closing' && blocked.rt.cancel.aborted, '删除停在 ②，取消用量仍在内存'));
  for (const rt of r.tenantRuntimes()) if (rt !== blocked.rt) await scope(rt, daily.flushUsageDaily);
  const beforeBarrierCalls = requests.length;
  const beforeBarrierNow = Date.now;
  const barrierTime = Date.now();
  try {
    Date.now = () => barrierTime + 60_001;
    await scope(timeoutBox.rt, () => completeText('system', 'user', { purpose: 'draft' }));
    check(() => assert.equal(requests.length, beforeBarrierCalls + 1, '一个沙箱卡在 ② 超过 60 秒，其他沙箱照常调用'));
    check(() => assert.equal(scope(blocked.rt, daily.__usageDailyTest.pending)[0]!.calls, 1, '删除用量未被定时器提前刷掉'));
  } finally {
    Date.now = beforeBarrierNow;
    releaseBarrier();
    await barrier;
  }
  await reaper.tick();
  check(() => assert.equal(r.runtimeOf(blocked.rt.id), undefined, '屏障恢复后 ③ 刷写并正常删除'));

  // 全池 60 秒闸覆盖正在写的批次，恢复后已有沙箱可再次调用。
  for (const rt of r.tenantRuntimes()) await scope(rt, daily.flushUsageDaily);
  let writeFailed = true;
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeEntered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  const writeBlocked = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  await scope(failed.rt, () =>
    daily.startUsageDaily(async (deltas) => {
      if (writeFailed) throw new Error('selftest_write_failure');
      enteredWrite();
      await writeBlocked;
      await withTenant(db, systemContext(failed.rt.id), (tx) => addUsage(tx, deltas));
    }, 30_000),
  );
  await scope(failed.rt, () => completeText('system', 'user', { purpose: 'insight' }));
  await scope(failed.rt, daily.flushUsageDaily);
  const oldNow = Date.now;
  const clock = oldNow();
  Date.now = () => clock + 60_001;
  const beforeLag = requests.length;
  await assert.rejects(
    scope(outdated.rt, () => completeText('system', 'user', { purpose: 'draft' })),
    BudgetExhausted,
  );
  await assert.rejects(
    scope(failed.rt, () => completeText('system', 'user', { purpose: 'draft' })),
    BudgetExhausted,
  );
  check(() => assert.equal(requests.length, beforeLag, '积压使所有沙箱停调'));
  writeFailed = false;
  const writing = scope(failed.rt, daily.flushUsageDaily);
  await writeEntered;
  await assert.rejects(
    scope(outdated.rt, () => completeText('system', 'user', { purpose: 'draft' })),
    BudgetExhausted,
  );
  check(() => assert.equal(requests.length, beforeLag, '批次被取走但还没提交，仍然全池停调'));
  releaseWrite();
  await writing;
  await scope(outdated.rt, () => completeText('system', 'user', { purpose: 'draft' }));
  Date.now = oldNow;
  check(() => assert.equal(requests.length, beforeLag + 1, '刷写恢复后恢复调用'));

  // 已到期但尚未 purge 的花费也恢复进池；删除运行时不减池数。
  await expireBrokenSandbox(db, outdated.rt.id);
  for (const rt of r.tenantRuntimes()) await scope(rt, daily.flushUsageDaily);
  await b.flushSandboxIndexUsage();
  const day = b.sandboxBudgetPoolStatus().day;
  const [durable] = await q<{ cost: number }>(
    `select
    (select coalesce(sum(cost_milli),0) from sandbox_pool_daily where day=$1) +
    (select coalesce(sum(u.cost_milli_cny),0) from usage_daily u join tenants t on t.id=u.tenant_id where t.kind='sandbox' and u.day=$1) as cost`,
    [day],
  );
  for (const rt of r.tenantRuntimes()) await detach(rt);
  await b.closeSandboxBudgetPool();
  await b.initializeSandboxPool(db, env);
  check(() => assert.equal(b.sandboxBudgetPoolStatus().costMilli, Number(durable!.cost), '池恢复包含已到期未删沙箱'));
  const expiredUsage = await q<{ cost: number }>('select sum(cost_milli_cny)::int as cost from usage_daily where tenant_id=$1', [
    outdated.rt.id,
  ]);
  check(() => assert.ok(expiredUsage[0]!.cost > 0));
  process.env.LLM_MOCK = '1';
  const restored = (await loadSandboxRuntime(deps, restart, options.host, acquire))!;
  check(() =>
    assert.equal(
      scope(restored, () => restored.budget.status().calls),
      5,
      '重启后生命周期次数接着算',
    ),
  );
  process.env.LLM_MOCK = '0';
  await assert.rejects(
    scope(restored, () => completeText('system', 'user', { purpose: 'draft' })),
    BudgetExhausted,
  );

  // 把池剩余额度同步预占；其他已有沙箱和开通也必须被挡，告警当天只一次。
  const live = await box();
  await scope(live.rt, retrieval.buildIndex);
  const prior = b.sandboxBudgetPoolStatus().costMilli;
  const remaining = b.sandboxBudgetPoolStatus().capMilli - prior;
  let poolAlerts = 0;
  const warnBefore = console.warn;
  console.warn = (...args) => {
    if (args.join(' ').includes('沙箱池')) poolAlerts++;
    warnBefore(...args);
  };
  const reservedPool = scope(live.rt, () => b.reserveSandboxIndex(remaining * 0.6));
  assert.ok(reservedPool);
  check(() =>
    assert.equal(
      scope(restored, () => b.reserveSandboxIndex(remaining * 0.6)),
      null,
      '跨沙箱不能并发超占池金额',
    ),
  );
  scope(live.rt, () => reservedPool.settle(0));
  scope(live.rt, () => {
    const reservation = b.reserveSandboxIndex(b.sandboxBudgetPoolStatus().capMilli - prior);
    assert.ok(reservation);
    reservation.settle(null);
  });
  const exhaustedAt = requests.length;
  await assert.rejects(
    scope(live.rt, () => completeText('system', 'user', { purpose: 'draft' })),
    BudgetExhausted,
  );
  await assert.rejects(provisionSandbox(options), (error: unknown) => error instanceof SandboxProvisionError && error.status === 503);
  await assert.rejects(provisionSandbox(options), (error: unknown) => error instanceof SandboxProvisionError && error.status === 503);
  await new Promise((resolve) => setTimeout(resolve, 10));
  check(() => assert.equal(requests.length, exhaustedAt));
  check(() => assert.ok(__alertTest.isActive('sandbox_pool'), '池用完发送实例告警'));
  console.warn = warnBefore;
  check(() => assert.equal(poolAlerts, 1, '重复拒绝在同一天只告警一次'));
  check(() => assert.ok(b.sandboxBudgetPoolStatus().costMilli >= prior));
  check(() =>
    assert.equal(
      scope(hostRt, () => u.usageToday().totalCalls),
      0,
      '作战室不含沙箱花费',
    ),
  );
  for (const rt of r.tenantRuntimes()) await detach(rt);
  await b.closeSandboxBudgetPool();
  reaper.stop();
  __alertTest.reset();
  check(() => assert.equal(gateStatus().inflight, 0));
}

async function midnightSuite(db: Db, q: Query, acquire: (id: string) => Promise<import('../../db/client.js').TenantLock | null>) {
  __sandboxLimitsTest.resetProvisioned();
  // 只清理本套件自己建的独立库，保留标准模板；不触碰共享测试集群中的其他库。
  const owned = await q<{ id: string }>("select id from tenants where kind='sandbox'");
  for (const { id } of owned) {
    await expireBrokenSandbox(db, id);
    await purgeSandbox(db, id);
  }
  await q('delete from sandbox_pool_daily');
  process.env.LLM_MOCK = '1';
  let clock = Date.parse('2026-10-12T15:59:00Z');
  globalThis.Date = new Proxy(initialDate, {
    construct(target, args, ctor) {
      return Reflect.construct(target, args.length ? args : [clock], ctor);
    },
    get(target, key, receiver) {
      return key === 'now' ? () => clock : Reflect.get(target, key, receiver);
    },
  });
  const warnBefore = console.warn;
  const messages: string[] = [];
  console.warn = (...args) => {
    if (args.join(' ').includes('沙箱池') || args.join(' ').includes('沙箱开通被全局限额')) messages.push(args.join(' '));
    warnBefore(...args);
  };
  const env = { ...process.env, SANDBOX_POOL_DAILY_CNY: '0.2', SANDBOX_PER_HOUR: '100', SANDBOX_PER_IP_DAY: '1' };
  const deps = testConfigDeps({ db }, { tenantSlug: 'budget-template', usePackRuntime: true });
  const options = {
    deps,
    env,
    templateSlug: 'budget-template',
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: acquire,
    ip: '127.0.0.9',
    userAgent: null,
  };
  const beforeFetch = globalThis.fetch;
  try {
    await b.initializeSandboxPool(db, env);
    const first = await provisionSandbox(options);
    const rt = r.runtimeOf(first.tenantId)!;
    const firstDay = todayIso();
    check(() => assert.equal(firstDay, '2026-10-12', '15:59Z 对应本地午夜前一天'));
    const dayBefore = await sandboxPoolHealth(db, firstDay);
    check(() => assert.equal(dayBefore.provisioned, 1, '开通函数写入本地日，不写 UTC 日'));
    const request = {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-5.2', max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(10_000) }] }),
    };
    let sent = 0;
    globalThis.fetch = async () => {
      sent++;
      return Response.json({ usage: { prompt_tokens: 10_000, completion_tokens: 4096 } });
    };
    const res = await scope(rt, () => gatedFetch(baseUrl + '/chat/completions', request, () => AbortSignal.timeout(5000)));
    const data = await res.res.json();
    scope(rt, () => res.settleUsage(data));
    await assert.rejects(
      scope(rt, () => gatedFetch(baseUrl + '/chat/completions', request, () => AbortSignal.timeout(5000))),
      BudgetExhausted,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    check(() => assert.equal(sent, 1, '同一本地日内池不能超占'));
    check(() => assert.ok(b.sandboxBudgetPoolStatus().costMilli <= 200));
    check(() =>
      assert.ok(
        messages[0]?.includes('剩余不足一次调用的预占') && !messages[0]?.includes('已用完'),
        '装不下本次预占的告警如实描述剩余不足',
      ),
    );
    await assert.rejects(
      provisionSandbox({ ...options, ip: '127.0.0.8' }),
      (e: unknown) => e instanceof SandboxProvisionError && e.status === 503,
    );
    check(() => assert.ok(b.sandboxBudgetPoolStatus().costMilli < 200, '剩余尚未归零但低于最小预占时拒绝开通'));
    await scope(rt, daily.flushUsageDaily);
    const health = new SandboxProcess(env);
    Reflect.set(health, 'deps', deps);
    const firstHealth = await health.health();
    check(() =>
      assert.ok(
        firstHealth.pool.day === firstDay && firstHealth.pool.provisioned === 1 && firstHealth.pool.costMilli > 0,
        'healthz 三个池字段使用同一本地日',
      ),
    );
    const alertsBeforeRestart = messages.length;
    await b.closeSandboxBudgetPool();
    await b.initializeSandboxPool(db, env);
    check(() => assert.equal(b.sandboxPoolAvailable(), false));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    check(() => assert.equal(messages.length, alertsBeforeRestart, '重启恢复不足的池时不重发当天告警'));

    clock = Date.parse('2026-10-12T16:01:00Z');
    check(() => assert.equal(todayIso(), '2026-10-13', '16:01Z 已是本地第二天'));
    check(() => assert.equal(b.sandboxBudgetPoolStatus().costMilli, 0, 'rollDay 不把午夜前花费带入第二天'));
    const nextHealth = await health.health();
    check(() =>
      assert.deepEqual(
        nextHealth.pool,
        { day: '2026-10-13', provisioned: 0, costMilli: 0, capMilli: 200 },
        '本地第二天 healthz 的开通数和成本从零开始',
      ),
    );
    await provisionSandbox(options);
    const secondCounts = await sandboxPoolHealth(db);
    check(() => assert.equal(secondCounts.provisioned, 1, '本地换日后同 IP 可以重新开通'));

    const alertsBeforeLimits = messages.length;
    await assert.rejects(provisionSandbox(options), (e: unknown) => e instanceof SandboxProvisionError && e.status === 429);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    check(() => assert.equal(messages.length, alertsBeforeLimits, '单 IP 上限不占全局告警名额'));
    for (const [name, override] of [
      ['同时数', { SANDBOX_MAX_LIVE: '1' }],
      ['每小时', { SANDBOX_PER_HOUR: '1' }],
      ['每天', { SANDBOX_PER_DAY: '1' }],
    ] as const) {
      await assert.rejects(
        provisionSandbox({ ...options, ip: '127.0.0.8', env: { ...env, ...override } }),
        (e: unknown) => e instanceof SandboxProvisionError && e.status === 429,
        `${name} 全局上限返回 429`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    check(() => assert.equal(messages.length, alertsBeforeLimits + 1, '三种全局开通上限共用 sandbox_pool 每天一次告警'));
    check(() => assert.ok(messages.at(-1)!.includes('开通被全局限额拒绝')));

    // 从准入到取得创建连接之间跨午夜，事务重新捕获日期；DB 和 IP 计数不能各记一天。
    clock = Date.parse('2026-10-13T15:59:00Z');
    await provisionSandbox({
      ...options,
      ip: '127.0.0.7',
      admit: async () => {
        clock = Date.parse('2026-10-13T16:01:00Z');
      },
    });
    const thirdCounts = await sandboxPoolHealth(db, '2026-10-14');
    check(() => assert.equal(thirdCounts.provisioned, 1, '跨午夜开通的准入和函数写入同用事务日'));
    const previousCounts = await sandboxPoolHealth(db, '2026-10-13');
    check(() => assert.equal(previousCounts.provisioned, 1, '跨午夜开通没有误写准入前一天'));
    await assert.rejects(
      provisionSandbox({ ...options, ip: '127.0.0.7' }),
      (e: unknown) => e instanceof SandboxProvisionError && e.status === 429,
    );
    const afterIpCounts = await sandboxPoolHealth(db);
    check(() => assert.equal(afterIpCounts.provisioned, 1, '跨午夜提交后 IP 计数没有漏记'));
  } finally {
    globalThis.fetch = beforeFetch;
    globalThis.Date = initialDate;
    console.warn = warnBefore;
    for (const rt of r.tenantRuntimes()) await detach(rt);
    await b.closeSandboxBudgetPool();
    __alertTest.reset();
  }
}

try {
  const pg = await openTestDb();
  try {
    await pg.pg.exec('SET ROLE agent_app');
    await suite(
      pg.db,
      async <T>(sql: string, params: unknown[] = []) =>
        (
          await pg.pg.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE NONE');
            return tx.query<T>(sql, params);
          })
        ).rows,
      async () => fakeLock(),
    );
    await midnightSuite(
      pg.db,
      async <T>(sql: string, params: unknown[] = []) =>
        (
          await pg.pg.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE NONE');
            return tx.query<T>(sql, params);
          })
        ).rows,
      async () => fakeLock(),
    );
  } finally {
    await b.closeSandboxBudgetPool();
    await pg.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await realReaperFixture(process.env.PG_TEST_URL);
    try {
      await suite(pg.app.db, pg.query, (id) => pg.held.acquireTenant(id));
      await midnightSuite(pg.app.db, pg.query, (id) => pg.held.acquireTenant(id));
    } finally {
      await b.closeSandboxBudgetPool();
      await pg.close();
    }
  }
  // 共享 price / gate / mock 的宿主回归：未知价格仍为 0、失败尝试不进宿主用量、payload 不加输出上限。
  const host = r.createTenantRuntime({ id: 'host-budget', slug: 'host-budget', isHost: true });
  r.registerRuntime(host);
  r.configureTenancy({ role: 'host', standardCount: 1 });
  check(() => assert.equal(u.costOf('unknown-budget-test', 1000, 100), 0));
  check(() => assert.ok(u.sandboxCostOf('unknown-budget-test', 1000, 100, 0, true) >= u.costOf('deepseek-v4-pro', 1000, 100)));
  process.env.LLM_MOCK = '0';
  const n = requests.length;
  failNext = true;
  assert.ok(await scope(host, () => completeText('system', 'user', { purpose: 'draft' })));
  check(() =>
    assert.equal(
      scope(host, () => u.usageToday().totalCalls),
      1,
    ),
  );
  check(() => assert.equal(requests.length - n, 2));
  check(() => assert.equal(requests.at(-1)!.max_tokens, undefined, '宿主 payload 字节口径不变'));
  const beforeMock = requests.length;
  const options = { system: 'system', messages: [], tools: [], executeTool: async () => '', forceMock: true };
  const mockRuntime = { mock: { chat: async () => '原来的 mock' }, getToolSpec: () => undefined };
  const mocked = await scope(host, () => chat(options, mockRuntime));
  check(() => assert.equal(mocked, '原来的 mock'));
  check(() => assert.equal(requests.length, beforeMock));
  const visitor = await import('../../budget.js');
  scope(host, () => {
    check(() => assert.equal(visitor.tryReserveVisitorLLM('sim-budget'), true));
    check(() => assert.equal(visitor.tryReserveVisitorLLM('sim-budget'), false));
  });
  dropTenantState(host.id);
  console.log(`SANDBOX BUDGET SELFTEST PASS: ${checks} checks`);
} finally {
  globalThis.fetch = initialFetch;
  globalThis.Date = initialDate;
  Date.now = initialNow;
  console.warn = initialWarn;
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await b.closeSandboxBudgetPool();
  fs.rmSync(dir, { recursive: true, force: true });
}
