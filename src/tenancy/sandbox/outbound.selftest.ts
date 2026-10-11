// 05 第 17 步 / R11：持久化与工作台正常，沙箱的任务、群通知和宿主渠道零外发。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb, testConfigDeps, fakeLock, installPgSessionStore, fakeDbError, openGatedDb } from '../../db/testing.js';
import { openOutboundTestPg } from '../../db/sandbox-outbound-testing.js';
import type { Db } from '../../db/client.js';
import { importConfig } from '../../config/transfer.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import { closeConfig } from '../../config/source.js';
import { configureTenancy, createTenantRuntime, runtimeOf, tenantRuntimes, withTenantScope, unregisterRuntime } from '../runtime.js';
import { dropTenantState } from '../state.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { provisionSandbox } from './provision.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-outbound-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app } = await import('../../server.js');
const store = await import('../../store.js');
const takeover = await import('../../handoff/takeover.js');
const { enterHandoff } = await import('../../handoff/record.js');
const { executeTool } = await import('../../tools.js');
const simulator = await import('../../adapters/simulator.js');
const web = await import('../../adapters/web.js');
const wecom = await import('../../adapters/wecom.js');
const accounts = await import('../../channels/accounts.js');
const { alert, __alertTest } = await import('../../ops/alert.js');
const notify = await import('../../notify/handoff.js');
const events = await import('../../store/events.js');
const hub = await import('../../console-api/events.js');
const { conversationCounts } = await import('../../console-api/workbench.js');
const { sendWindow } = await import('../../quota/ledger.js');
const { __profileTest } = await import('../../profile.js');
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

async function cleanup(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    rt.store.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
}

async function suite(
  db: Db,
  query: Query,
  faultsFor: (rt: ReturnType<typeof createTenantRuntime>) => Promise<{ acquire: Error | null }>,
): Promise<void> {
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [row] = await query<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('template','模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: row!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: 'template', dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  assert.equal(imported.code, 0, imported.message);
  const opened = await provisionSandbox({
    deps,
    templateSlug: 'template',
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: async () => fakeLock(),
    ip: null,
    userAgent: null,
  });
  const rt = runtimeOf(opened.tenantId)!;
  const faults = await faultsFor(rt);
  const actor = { userId: opened.userId, name: '体验访客', role: 'owner' as const };
  const requests: { url: string; body: string }[] = [];
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const envNames = ['NOTIFY_WEBHOOK_URL', 'ALERT_WEBHOOK_URL', 'WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID'];
  const oldEnv = envNames.map((name) => process.env[name]);
  // 故意配置替身，证明拦截发生在代码边界，而不只依赖沙箱启动时禁止配置。
  process.env.NOTIFY_WEBHOOK_URL = 'https://notify.example.invalid/record';
  process.env.ALERT_WEBHOOK_URL = 'https://alert.example.invalid/record';
  process.env.WECOM_CORP_ID = 'fixture-corp';
  process.env.WECOM_APP_SECRET = randomUUID();
  process.env.WECOM_KF_OPEN_KFID = 'fixture-kf';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? '') });
    if (url === process.env.ALERT_WEBHOOK_URL) return Response.json({ errcode: 0 });
    throw new Error('sandbox_unexpected_outbound');
  };
  console.warn = (...args) => {
    logs.push(args.join(' '));
  };
  __alertTest.reset();
  try {
    await withTenantScope(rt, async () => {
      const oldest = store.listSessions().toSorted((a, b) => a.createdAt - b.createdAt)[0]!;
      assert.equal(oldest.channel, 'simulator');
      const pushes: string[] = [];
      const off = simulator.subscribe(oldest.id, (text) => pushes.push(text));
      try {
        const result = await takeover.reply(oldest.id, actor, '最早种子也能回复', randomUUID());
        assert.equal(result.sent, true);
        assert.equal(result.persisted, true);
        assert.ok(pushes.includes('【顾问】最早种子也能回复'));
      } finally {
        off();
      }
      const result = await takeover.reply(oldest.id, actor, '没有 SSE 连接仍可保存', randomUUID());
      assert.equal(result.sent, true);
      assert.ok(oldest.messages.some((m) => m.content === '没有 SSE 连接仍可保存'));
      assert.ok(!oldest.messages.some((m) => m.content === takeover.REPLY_FAILED_NOTE));
      // 种子夹具目前都在当天：另造超过 48 小时的模拟器会话验证窗口不限制回复。
      const aged = store.getOrCreateSession(`sbx-${randomUUID().replaceAll('-', '')}`, 'simulator');
      aged.messages.push({ role: 'customer', content: '之前的咨询', at: Date.now() - 72 * 3_600_000 });
      store.saveSession(aged);
      await store.flushSession(aged.id, { timeoutMs: 5000 });
      assert.ok(sendWindow(aged.id, Date.now()).closesAt! < Date.now());
      assert.equal((await takeover.reply(aged.id, actor, '窗口过期的模拟器仍可回复', randomUUID())).sent, true);

      // advisor 建单走真实工具生产者，不能为了阻止任务而拒绝会话/订单事务。
      __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
      try {
        const session = store.listSessions().find((s) => s.orderIds.length === 0 && !s.handedOver)!;
        const date = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
        const result = JSON.parse(await executeTool('create_order', { routeId: 'r-xian', travelers: 2, departDate: date }, session));
        assert.ok(result.orderId);
        assert.ok(result.payNote);
        await store.flushSession(session.id, { timeoutMs: 5000 });
      } finally {
        __profileTest.reset();
      }

      // 成功提交的转人工仍进本沙箱的铃铛。
      hub.ensureEventHub(() => conversationCounts(Date.now()));
      const session = store.listSessions().find((s) => !s.handedOver)!;
      enterHandoff(session, { kind: 'request', reason: '请顾问处理', at: Date.now() });
      store.saveSession(session);
      await store.flushSession(session.id, { timeoutMs: 5000 });
      assert.ok(rt.events.ring.some((e) => e.event === 'handoff' && JSON.parse(e.data).id === session.id));

      // 故障发生在真实写队列：非紧急/紧急通知都不出站，恢复后成功提交且没有 poisoned。
      notify.installUnsavedNotices();
      let unsaved = 0;
      const offUnsaved = store.onHandoffUnsaved(() => {
        unsaved++;
      });
      const failing = store.listSessions().find((s) => !s.handedOver)!;
      faults.acquire = fakeDbError('08006');
      try {
        enterHandoff(failing, { kind: 'emergency', reason: '需要顾问立即处理', at: Date.now() });
        store.saveSession(failing);
        await assert.rejects(store.flushSession(failing.id, { timeoutMs: 150 }));
        assert.equal(unsaved, 0);
        assert.equal(notify.__handoffNotifyTest.unsavedState(failing.id, failing.handoff!.at), null);
        assert.ok(store.storeHealth().dirty > 0);
        events.deliverHandoffUnsaved([
          {
            type: 'handoff.started',
            tenantId: rt.id,
            id: failing.id,
            kind: 'request',
            at: Date.now(),
            escalated: false,
            paidCustomer: false,
            assigned: false,
          },
        ]);
        assert.equal(unsaved, 0);
      } finally {
        faults.acquire = null;
        offUnsaved();
      }
      await store.flushSession(failing.id, { timeoutMs: 5000 });
      assert.deepEqual(store.storeHealth().poisoned, []);

      // 不只任务 enqueue：cancel/update 也丢弃；真实企微形状的会话同样受租户边界保护。
      const wechat = store.getOrCreateSession('wecom:wmSbxGuard', 'wecom');
      store.queueJobs(wechat.id, [
        { op: 'enqueue', kind: 'followup', dedupeKey: 'sandbox-followup', runAt: Date.now(), payload: {}, maxAttempts: 1 },
        { op: 'cancel', dedupeKey: 'sandbox-followup' },
      ]);
      store.saveSession(wechat);
      await store.flushSession(wechat.id, { timeoutMs: 5000 });
      for (const source of ['env', 'db'] as const) {
        accounts.installAccounts(
          source === 'env'
            ? []
            : [
                {
                  id: randomUUID(),
                  tenantId: rt.id,
                  key: 'main',
                  name: '夹具账号',
                  kind: 'wecom_kf',
                  status: 'active',
                  source,
                  wecom: { corpId: 'fixture-corp', openKfId: 'fixture-kf', idPrefix: 'wecom:', recordOnlyUntil: null, settings: {} },
                  web: null,
                  inactiveReason: null,
                },
              ],
        );
        assert.equal(wecom.__wecomTest.routeAccount(wechat.id), null);
        assert.equal(wecom.wecomAdapter.prepare!(wechat.id, '不能经宿主发送', { kind: 'notice' }), null);
        assert.equal(await wecom.wecomAdapter.push(wechat.id, '不能经宿主发送'), false);
        assert.equal(
          await wecom.wecomAdapter.push(wechat.id, '不能经句柄绕过', {
            kind: 'notice',
            prepared: { sessionId: wechat.id, kind: 'notice' },
          }),
          false,
        );
      }
      accounts.installAccounts([]);
      // 经过 server 的实际人工/付款共同发送接线，web 即使有订阅者也不能收到沙箱消息。
      const badWeb = store.getOrCreateSession(`sbx-${'f'.repeat(24)}`, 'web');
      let webPushes = 0;
      const offWeb = web.subscribeWeb(badWeb.id, 'fixture-ip', () => {
        webPushes++;
      });
      assert.equal(typeof offWeb, 'function');
      if (typeof offWeb !== 'function') throw new Error('web_subscription_failed');
      try {
        for (const id of [badWeb.id, wechat.id])
          assert.equal(await takeover.pushToChannel(id, '禁止宿主适配器', { kind: 'notice' }), false);
        assert.equal(webPushes, 0);
      } finally {
        offWeb();
      }
      alert('store', '沙箱局部落库失败');
      alert('store', '沙箱局部落库失败', { resolved: true });
      alert('channel', '进程级告警', { instance: true });
      await __alertTest.settle();
      assert.ok(logs.some((s) => s.includes('沙箱租户告警只记在日志里')));
      assert.deepEqual(
        requests.map((r) => r.url),
        [process.env.ALERT_WEBHOOK_URL],
      );
      assert.ok(requests[0]!.body.includes('进程级告警'));
      const callback = await app.request('/wecom/callback', { headers: { host: 'sandbox.example.invalid' } });
      assert.equal(callback.status, 404);
    });
    for (const table of ['jobs', 'channel_accounts']) {
      const [count] = await query<{ n: number }>(`select count(*)::int as n from ${table} where tenant_id=$1`, [rt.id]);
      assert.equal(count!.n, 0, table);
    }
    const [messages] = await query<{ n: number }>('select count(*)::int as n from messages where tenant_id=$1', [rt.id]);
    assert.ok(messages!.n > 0);
    await assert.rejects(
      query("insert into channel_accounts(tenant_id,key,name,kind,status,settings) values($1,'blocked','禁止账号','web','active','{}')", [
        rt.id,
      ]),
      /沙箱租户不可建渠道账号/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    envNames.forEach((name, i) => {
      if (oldEnv[i] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[i];
    });
    __profileTest.reset();
    await __alertTest.settle();
  }
}

try {
  await cleanup();
  const lite = await openTestDb();
  try {
    await lite.pg.exec('SET ROLE agent_app');
    const query: Query = async (text, params = []) =>
      lite.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query(text, params)).rows as never;
      });
    await suite(lite.db, query, async (rt) => {
      rt.store.pgBackend!.close();
      rt.store.pgBackend = null;
      rt.store.sessions.clear();
      rt.store.orders.clear();
      const f = await installPgSessionStore(lite, { slug: rt.slug, varDir: '' });
      await withTenantScope(rt, () => store.initSessionStore(f.deps));
      return f.faults;
    });
    console.log('SELFTEST PASS: 沙箱出站挡板 PGlite');
  } finally {
    await cleanup();
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await openOutboundTestPg(process.env.PG_TEST_URL);
    const gated = await openGatedDb(pg.appUrl);
    try {
      await suite(pg.db, pg.query, async (rt) => {
        rt.store.pgBackend!.close();
        rt.store.pgBackend = null;
        rt.store.sessions.clear();
        rt.store.orders.clear();
        await withTenantScope(rt, () => store.initSessionStore({ db: gated.db, tenantId: rt.id, tenantSlug: rt.slug, varDir: '' }));
        return gated.faults;
      });
      console.log('SELFTEST PASS: 沙箱出站挡板真实 PG（独立库，未改共享角色）');
    } finally {
      await cleanup();
      await gated.close();
      await pg.close();
    }
  } else console.log('SKIP: 真实 PG 需要 PG_TEST_URL');
} finally {
  await cleanup();
  fs.rmSync(temp, { recursive: true, force: true });
}
