// 14 第 7 步：真实 CLI 子进程 → 数据库 → 生产轮询 → 引擎 → 后台用量接口。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-e2e-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SERVER_SELFTEST: '1',
  LLM_MOCK: '1',
  CUSTOMER_RATE_PER_MIN: '',
  CUSTOMER_RATE_PER_HOUR: '',
  FOLLOWUP_ENABLED: '',
  ALERT_WEBHOOK_URL: '',
  LLM_PROVIDER: '',
  LLM_API_KEY: 'synthetic',
  LLM_BASE_URL: 'https://erp.example.test/v1',
  EMBED_API_KEY: '',
});
const { hostRuntime } = await import('./runtime.js');
const { enterTenantScopeForTest } = await import('./testing.js');
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const testing = await import('../db/testing.js');
const { openDb, holdTenantLock } = await import('../db/client.js');
const config = await import('../config/source.js');
const { importConfig } = await import('../config/transfer.js');
const store = await import('../store.js');
const limits = await import('./limits.js');
const { handleMessage } = await import('../core/engine/index.js');
const { observeRequests } = await import('../core/llm/client.js');
const { flushUsageDaily } = await import('../trace/usage-daily.js');
const { runShutdownHooks } = await import('../shutdown.js');
const { createUser } = await import('../auth/accounts.js');
const { SESSION_COOKIE } = await import('../auth/session.js');
const { LIMIT_QUOTA_REPLY, LIMIT_SUSPENDED_REPLY, LIMIT_RATE_REPLY } = await import('./limit-replies.js');
const exec = promisify(execFile);
const realFetch = globalThis.fetch;

async function suite(superUrl: string): Promise<void> {
  const fx = await testing.createRealPgFixture(superUrl, { slug: 'limits-e2e' });
  const app = await openDb(fx.urls.app);
  const platform = await openDb(fx.urls.platform);
  try {
    const deps = testing.testConfigDeps({ db: app.db }, { tenantSlug: 'limits-e2e', lock: (id) => holdTenantLock(fx.urls.app, id) });
    const imported = await importConfig({
      db: app.db,
      tenantSlug: deps.tenantSlug,
      dataDir: 'data',
      imageSop: deps.imageSop,
      lock: deps.lock,
    });
    assert.equal(imported.code, 0, imported.message);
    await config.initConfig(deps);
    await store.initSessionStore({ db: app.db, tenantId: rt.id, tenantSlug: rt.slug, varDir: dir });
    limits.stopTenantLimits(); // 本套件显式推进既有轮询入口，避免自动时钟与 CLI 子进程竞态。
    const user = await createUser(platform.db, {
      tenantSlug: rt.slug,
      email: 'owner@erp.example.test',
      name: '合成管理员',
      role: 'owner',
      password: async () => 'synthetic-owner-password',
    });
    assert.equal(user.code, 0, user.message);
    const { consoleApi } = await import('../console-api/app.js');
    const login = await consoleApi.request('/api/console/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@erp.example.test', password: 'synthetic-owner-password' }),
    });
    assert.equal(login.status, 200);
    let token = login.headers.get('set-cookie')?.match(/^[^=]+=([^;]+)/)?.[1];
    assert.ok(token);
    let modelCalls = 0;
    observeRequests(() => {
      modelCalls++;
    });
    const cli = async (...args: string[]) => {
      const before = limits.getTenantLimits();
      const result = await exec(
        process.execPath,
        ['--import', 'tsx', 'src/cli/tenant-budget.ts', args[0]!, '--tenant', rt.slug, ...args.slice(1)],
        {
          env: { ...process.env, DATABASE_PLATFORM_URL: fx.urls.platform },
          timeout: 15_000,
        },
      );
      assert.ok(result.stdout.includes('30 秒内生效'));
      assert.deepEqual(limits.getTenantLimits(), before, 'CLI 写库后运行时仍是旧快照，不能旁路生产轮询');
      await limits.__limitsTest.poll(); // 与 30 秒计时器相同的生产读取体，不替换 reader 或 verdict。
      limits.stopTenantLimits();
    };
    const turn = (sid: string) => handleMessage(`wecom:${sid}`, '你好', 'wecom');
    const usage = async (expected: number, quota: number | null, cap: number | null = null) => {
      await flushUsageDaily();
      const response = await consoleApi.request('/api/console/usage', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.deepEqual(view.replies, { used: expected, quota });
      assert.equal(view.daily.capMilli, cap);
      const count = (
        await fx.query<{ n: number }>(
          `select coalesce(sum(calls),0)::int as n from usage_daily where tenant_id=$1 and purpose='reply' and to_char(day,'YYYY-MM')=$2`,
          [rt.id, view.month],
        )
      )[0]!.n;
      assert.equal(count, expected, 'API 与真实持久化计数一致');
      const persistedReplies = (
        await fx.query<{ content: string }>("select content from messages where tenant_id=$1 and role='agent'", [rt.id])
      ).filter((m) => ![LIMIT_QUOTA_REPLY, LIMIT_SUSPENDED_REPLY, LIMIT_RATE_REPLY].includes(m.content));
      assert.equal(persistedReplies.length, expected, '计数与实际落库回复数一致');
    };
    try {
      await cli('quota', '--replies', '2');
      assert.equal(limits.getTenantLimits()!.monthlyQuota, 2);
      for (let n = 0; n < 2; n++) {
        assert.ok((await turn('quota')).text);
        await store.flushSession('wecom:quota');
      }
      assert.equal(modelCalls, 2);
      assert.equal((await turn('quota')).text, LIMIT_QUOTA_REPLY);
      assert.equal(store.getSession('wecom:quota')!.handoff?.kind, 'failure');
      assert.equal(store.getSession('wecom:quota')!.handoff?.reason, '本月 AI 额度已用完');
      assert.equal(modelCalls, 2);
      await store.flushSession('wecom:quota');
      await usage(2, 2);
      await cli('quota', '--clear');
      assert.equal(limits.getTenantLimits()!.monthlyQuota, null);
      assert.equal((await turn('quota')).silent, true, '清额度不自动交还已转人工会话');
      assert.ok((await turn('quota-cleared')).text);
      assert.equal(modelCalls, 3);
      await store.flushSession('wecom:quota-cleared');
      await usage(3, null);
      console.log('14 验收 2、9：真实 CLI quota=2 → 2 次回复 → 第 3 条转人工；clear 后新会话恢复，usage.replies.used=3');

      await cli('status', '--set', 'suspended');
      assert.equal(limits.limitVerdict(), 'suspended');
      assert.equal((await turn('paused')).text, LIMIT_SUSPENDED_REPLY);
      assert.equal((await turn('paused')).silent, true);
      assert.equal(store.getSession('wecom:paused')!.handedOver, false);
      assert.equal(modelCalls, 3);
      await store.flushSession('wecom:paused');
      await cli('status', '--set', 'active');
      assert.equal(limits.limitVerdict(), 'ok');
      // 停用会使后台会话失效；真实登录重新取得 cookie。
      const relogin = await consoleApi.request('/api/console/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@erp.example.test', password: 'synthetic-owner-password' }),
      });
      assert.equal(relogin.status, 200);
      token = relogin.headers.get('set-cookie')?.match(/^[^=]+=([^;]+)/)?.[1];
      assert.ok(token);
      assert.ok((await turn('paused')).text);
      assert.equal(modelCalls, 4);
      await store.flushSession('wecom:paused');
      await usage(4, null);
      console.log('14 验收 7、9：真实 CLI suspended → 一次固定句 → active 同会话恢复 AI，固定句不计数，usage.replies.used=4');

      await cli('cap', '--milli', '0');
      assert.equal(limits.getTenantLimits()!.dailyCapMilli, 0);
      let network = 0;
      globalThis.fetch = async () => {
        network++;
        throw new Error('日上限为 0 不应发出模型请求');
      };
      process.env.LLM_MOCK = '0';
      try {
        assert.equal((await turn('cap')).text, LIMIT_QUOTA_REPLY);
      } finally {
        process.env.LLM_MOCK = '1';
        globalThis.fetch = realFetch;
      }
      assert.equal(network, 0);
      assert.equal(store.getSession('wecom:cap')!.handoff?.kind, 'failure');
      assert.equal(store.getSession('wecom:cap')!.handoff?.reason, '今日 AI 用量已到上限');
      await store.flushSession('wecom:cap');
      await usage(4, null, 0);
      await cli('cap', '--clear');
      assert.ok((await turn('cap-cleared')).text);
      await store.flushSession('wecom:cap-cleared');
      await usage(5, null);
      console.log('14 验收 5、9：真实 CLI cap=0 → chat 日上限转人工、零网络请求；clear 后恢复，usage.replies.used=5');
      assert.equal(
        (
          await fx.query<{ n: number }>(
            "select count(*)::int as n from audit_log where tenant_id=$1 and action in ('tenant.quota_update','tenant.status_update','tenant.cap_update')",
            [rt.id],
          )
        )[0]!.n,
        6,
      );
      console.log('LIMITS E2E SELFTEST PASS: CLI 子进程、真实轮询、引擎、登录授权与用量聚合贯穿（真实 PG）');
    } finally {
      observeRequests(null);
    }
  } finally {
    await runShutdownHooks();
    await rt.store.pgBackend?.close();
    await config.closeConfig();
    await platform.close();
    await app.close();
    await fx.drop();
  }
}
try {
  if (process.env.PG_TEST_URL) await suite(process.env.PG_TEST_URL);
  else if (process.env.CI === 'true') throw new Error('14 验收贯穿用例必须设 PG_TEST_URL');
  else console.log('LIMITS E2E：未设 PG_TEST_URL，真实 CLI 贯穿待补跑');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
