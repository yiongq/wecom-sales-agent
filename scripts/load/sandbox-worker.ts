// 第 21 步压测子进程：实际角色 / 写队列 / 并发闸，模型只用进程内假上游。
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { initConfigFromEnv, configRuntime, closeConfig } from '../../src/config/source.js';
import { hostRuntime, tenantRuntimes, withTenantScope, type TenantRuntime } from '../../src/tenancy/runtime.js';
import { initSessionStore, drainStore, storeHealth, onCommitted, onSessionSaved } from '../../src/store.js';
import { handleMessage } from '../../src/engine.js';
import { observeRequests } from '../../src/core/llm/client.js';
import { SandboxProcess, sandboxApp } from '../../src/tenancy/sandbox/process.js';
import { sandboxWriteLimits } from '../../src/tenancy/sandbox/limits.js';
import { csrfFor } from '../../src/auth/session.js';
import { runShutdownHooks } from '../../src/shutdown.js';

// 即使协调进程被外部杀掉，每个角色子进程也会在 150 秒内自行退出。
const watchdog = setTimeout(() => process.exit(124), 150_000);
watchdog.unref();
const role = process.env.APP_ROLE;
const context = new AsyncLocalStorage<{ requestAt: number | null }>();
const waits: number[] = [];
const writes: number[] = [];
const pending = new Map<string, number>();
let maxRssMB = process.memoryUsage().rss / 1024 / 1024;
let maxLagMs = 0,
  modelCalls = 0;
// 模型请求准备到 fetch 的时间包含并发闸等待，略多于纯排队（保守口径）。
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, 'http://model.example.invalid', '压测禁止外网');
  const at = context.getStore()?.requestAt;
  if (at != null) waits.push(performance.now() - at);
  modelCalls++;
  await pause(200, undefined, { signal: init?.signal ?? undefined });
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '您好，欢迎咨询。请问您想去哪里旅行？' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
const service = role === 'sandbox' ? new SandboxProcess(process.env) : null;
let app: ReturnType<typeof sandboxApp> | null = null;
const tokens: string[] = [];
const provisionMs: number[] = [];
const send = (value: unknown) => process.send?.(value);
async function request(token: string | undefined, url: string, body?: unknown) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return app!.request(url, {
    method: payload ? 'POST' : 'GET',
    body: payload,
    headers: {
      host: 'sandbox.example.invalid',
      ...(token ? { cookie: `__Host-sbx=${token}`, ...(payload ? { 'x-csrf': csrfFor(token) } : {}) } : {}),
      ...(payload
        ? { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'content-length': String(Buffer.byteLength(payload)) }
        : {}),
    },
  });
}
async function start() {
  if (service) {
    await service.start();
    const { Hono } = await import('hono');
    const { consoleApi } = await import('../../src/console-api/app.js');
    const routes = new Hono().route('/', consoleApi);
    app = sandboxApp(service, 'sandbox.example.invalid', routes);
    const idleRssMB = process.memoryUsage().rss / 1024 / 1024;
    for (let i = 0; i < 20; i++) {
      const at = performance.now();
      const opened = await request(undefined, '/api/sandbox', {});
      assert.equal(opened.status, 201);
      const token = /__Host-sbx=([^;]+)/.exec(opened.headers.get('set-cookie')!)![1]!;
      tokens.push(token);
      assert.equal((await request(token, '/api/console/me')).status, 200);
      provisionMs.push(performance.now() - at);
    }
    assert.equal(tenantRuntimes().length, 20);
    send({ type: 'ready', idleRssMB, loadedRssMB: process.memoryUsage().rss / 1024 / 1024, provisionMs });
  } else {
    await initConfigFromEnv(process.env, () => {
      throw new Error('host_startup_failed');
    });
    await withTenantScope(hostRuntime(), () => {
      const cfg = configRuntime();
      return initSessionStore({ db: cfg.db, tenantId: cfg.tenantId, tenantSlug: hostRuntime().slug, varDir: process.env.VAR_DIR! });
    });
    send({ type: 'ready' });
  }
}
async function run(startAt: number) {
  const runtimes = service ? tenantRuntimes() : [hostRuntime()];
  const off: (() => void)[] = [];
  for (const rt of runtimes)
    withTenantScope(rt, () => {
      observeRequests(() => {
        const c = context.getStore();
        if (c) c.requestAt = performance.now();
      });
      off.push(
        onSessionSaved((s) => {
          if (!pending.has(`${rt.id}:${s.id}`)) pending.set(`${rt.id}:${s.id}`, performance.now());
        }),
      );
      off.push(
        onCommitted((event) => {
          if (event.type !== 'conversation.changed') return;
          const key = `${rt.id}:${event.id}`;
          const at = pending.get(key);
          if (at !== undefined) {
            writes.push(performance.now() - at);
            pending.delete(key);
          }
        }),
      );
    });
  const sampler = setInterval(() => {
    maxRssMB = Math.max(maxRssMB, process.memoryUsage().rss / 1024 / 1024);
    for (const rt of runtimes)
      maxLagMs = Math.max(
        maxLagMs,
        withTenantScope(rt, () => storeHealth().lagMs),
      );
  }, 10);
  let acceptedWrites = 0,
    limitedWrites = 0;
  async function turn(rt: TenantRuntime, id: string) {
    await context.run({ requestAt: null }, () => withTenantScope(rt, () => handleMessage(id, '您好，介绍一下你们', 'simulator')));
  }
  try {
    await pause(Math.max(0, startAt - Date.now()));
    if (service) {
      const chatting = Promise.all(
        runtimes.map(async (rt) => {
          const id = `sbx-${randomBytes(12).toString('hex')}`;
          for (let i = 0; i < 5; i++) await turn(rt, id);
        }),
      );
      const writing = (async () => {
        const count = sandboxWriteLimits().requestsPerMinute;
        // 一个沙箱按缺省 30 次/分钟连续写，每 2 秒一次；占满一分钟后再探测一次 429。
        for (let i = 0; i < count; i++) {
          await pause(Math.max(0, startAt + i * (60_000 / count) - Date.now()));
          const res = await request(tokens[0]!, '/api/console/quick-replies', { title: `压测 ${i}`, body: '压测固定正文' });
          assert.equal(res.status, 200, await res.text());
          acceptedWrites++;
        }
        const limited = await request(tokens[0]!, '/api/console/quick-replies', { title: '超限探测', body: '不会落库' });
        assert.equal(limited.status, 429);
        limitedWrites++;
      })();
      await Promise.all([chatting, writing]);
    } else {
      // 同一基线：8 个会话并发，每个 5 轮；每轮开始相隔 12 秒，覆盖整个写压测窗口。
      for (let round = 0; round < 5; round++) {
        await pause(Math.max(0, startAt + round * 12_000 - Date.now()));
        await Promise.all(Array.from({ length: 8 }, (_, i) => turn(runtimes[0]!, `wecom:wmLoad${i}`)));
      }
    }
    await pause(Math.max(0, startAt + 60_000 - Date.now()));
    for (const rt of runtimes) assert.deepEqual((await withTenantScope(rt, () => drainStore(5000))).undrained, []);
    assert.equal(pending.size, 0, '全部会话写入已提交');
    assert.equal(modelCalls, service ? 100 : 40, '每轮均经过假模型并发闸，没有预算降级');
    send({
      type: 'result',
      waits,
      writes,
      maxLagMs,
      modelCalls,
      acceptedWrites,
      limitedWrites,
      rssMB: maxRssMB,
    });
  } finally {
    clearInterval(sampler);
    for (const stop of off) stop();
  }
}
let active = false;
process.on('message', (message: { type: string; startAt: number }) => {
  if (message.type !== 'run' || active) return;
  active = true;
  void (
    process.env.LOAD_PROVISION_ONLY === '1'
      ? Promise.resolve().then(async () => {
          if (service) {
            const probe = await request(tokens[0]!, '/api/console/quick-replies', { title: '开通检查', body: '固定正文' });
            assert.equal(probe.status, 200, await probe.text());
          }
          send({
            type: 'result',
            waits: [],
            writes: [],
            maxLagMs: 0,
            modelCalls: 0,
            acceptedWrites: 0,
            limitedWrites: 0,
            rssMB: process.memoryUsage().rss / 1024 / 1024,
          });
        })
      : run(message.startAt)
  )
    .then(async () => {
      assert.equal(await runShutdownHooks(10_000), true);
      await service?.close();
      if (!service) await withTenantScope(hostRuntime(), closeConfig);
      clearTimeout(watchdog);
      process.disconnect();
    })
    .catch((error) => {
      console.error(error);
      void (async () => {
        await runShutdownHooks(10_000).catch(() => {});
        await service?.close().catch(() => {});
        if (!service) await withTenantScope(hostRuntime(), closeConfig).catch(() => {});
        process.exitCode = 1;
        clearTimeout(watchdog);
        process.disconnect();
      })();
    });
});
await start();
