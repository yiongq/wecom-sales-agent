// 18 R3 真实 PG 子进程：由 db/failover.selftest.ts 驱动，所有企微请求均为离线替身。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const mode = process.env.R3_CASE;
process.env.LLM_MOCK = '1';
process.env.DEPLOY_PROFILE = 'demo';
process.env.ADMIN_PASS = '';
for (const key of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[key] = '';

async function until(test: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await test())) {
    assert.ok(Date.now() < end, '等待自测条件超时');
    await delay(20);
  }
}
if (mode === 'boot') {
  const lease = await import('../tenancy/process-lease.js');
  // 覆盖实际 server 导入期、等锁与退出期的同步/异步文件访问。
  for (const target of [fs, fs.promises]) {
    for (const name of [
      'readFile',
      'writeFile',
      'readdir',
      'mkdir',
      'rename',
      'unlink',
      'stat',
      'access',
      'open',
      'readFileSync',
      'writeFileSync',
      'existsSync',
      'mkdirSync',
      'readdirSync',
      'renameSync',
      'statSync',
    ]) {
      const api = target as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = api[name];
      if (!original) continue;
      api[name] = (...args) => {
        if (lease.processLeaseWaiting() && args.some((a) => typeof a === 'string' && a.startsWith(process.env.VAR_DIR!))) {
          process.send?.({ event: 'var-before-lock', name });
          throw new Error('var_before_lock');
        }
        return Reflect.apply(original, target, args);
      };
    }
  }
  syncBuiltinESMExports();
  let pulls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/gettoken?')) return Response.json({ access_token: 'fake-r3-token', expires_in: 7200 });
    if (url.includes('/kf/sync_msg?')) {
      pulls++;
      process.send?.({ event: 'pull', pulls });
      return Response.json({ errcode: 0, has_more: 0, msg_list: [], next_cursor: 'r3-cursor' });
    }
    throw new Error('unexpected_wecom_request');
  };
  const { hostRuntime, withTenantScope } = await import('../tenancy/runtime.js');
  const config = await import('../config/source.js');
  withTenantScope(hostRuntime(), () => config.__configTest.setTimings({ reacquireMs: 2500 }));
  const { onShutdown } = await import('../shutdown.js');
  onShutdown(() => {
    process.send?.({ event: 'shutdown-hook' });
  });
  lease.onProcessLeaseChange(() => process.send?.({ event: 'lease', held: lease.processLeaseHeld(), stale: lease.processLeaseStale() }));
  process.send?.({ event: 'starting' });
  await import('../server.js');
  const wecom = await import('./wecom.js');
  const registry = await import('../channels/registry.js');
  const store = await import('../store.js');
  process.on('message', (message: { action?: string }) => {
    void withTenantScope(hostRuntime(), async () => {
      if (message.action === 'try-pull') {
        const account = registry.installedChannelAccounts().find((a) => a.kind === 'wecom_kf')!;
        await wecom.syncAccountFromCallback(account.id, 'fake-r3-trigger');
        process.send?.({ event: 'pull-probed' });
      } else if (message.action === 'dirty') {
        hostRuntime().store.pgBackend!.close();
        const session = store.getOrCreateSession('wecom:wmStale', 'wecom');
        session.messages.push({ role: 'customer', content: '待丢弃的合成消息', at: Date.now() });
        store.saveSession(session);
        process.send?.({ event: 'dirty' });
      }
    }).catch(() => process.send?.({ event: 'probe-failed' }));
  });
  process.send?.({ event: 'booted' });
} else if (mode) {
  process.env.SERVER_SELFTEST = '1';
  const tenancy = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = tenancy.hostRuntime();
  enterTenantScopeForTest(rt);
  const client = await import('../db/client.js');
  const config = await import('../config/source.js');
  const lease = await import('../tenancy/process-lease.js');
  const testing = await import('../db/testing.js');
  const store = await import('../store.js');
  let exits = 0;
  const originalFetch = globalThis.fetch;
  const admin = await client.openDb(process.env.R3_ADMIN_URL!);
  let sends = 0;
  let afterFirst: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/gettoken?')) return Response.json({ access_token: 'fake-r3-token', expires_in: 7200 });
    if (url.includes('/kf/sync_msg?')) return Response.json({ errcode: 0, has_more: 0, msg_list: [], next_cursor: 'r3-cursor' });
    if (url.includes('/kf/send_msg')) {
      sends++;
      if (afterFirst) {
        const action = afterFirst;
        afterFirst = undefined;
        await action();
        return Response.json({ errcode: mode === 'token-retry' ? 42001 : 45009 });
      }
      return Response.json({ errcode: 0 });
    }
    throw new Error('unexpected_wecom_request');
  };
  await config.initConfigFromEnv(process.env, () => {
    exits++;
  });
  const { tenantId } = config.configRuntime();
  const db = await testing.openGatedDb(process.env.DATABASE_URL!);
  const registry = await import('../channels/registry.js');
  const { keyRingFromEnv } = await import('../channels/secrets.js');
  const wecom = await import('./wecom.js');
  const ledger = await import('../quota/ledger.js');
  try {
    await store.initSessionStore({ db: db.db, tenantId, tenantSlug: 'demo', varDir: process.env.VAR_DIR! });
    await registry.initChannels({
      db: db.db,
      tenantId,
      tenantSlug: 'demo',
      varDir: process.env.VAR_DIR!,
      keyRing: keyRingFromEnv(process.env),
    });
    registry.startChannels();
    await until(() => wecom.__wecomTest.idle());
    sends = 0;
    const account = registry.installedChannelAccounts().find((a) => a.kind === 'wecom_kf')!;
    const sid = `wecom:wm${mode.replaceAll('-', '').slice(0, 10)}`;
    const session = store.getOrCreateSession(sid, 'wecom');
    session.messages.push({ role: 'customer', content: '合成入站', at: Date.now() });
    store.saveSession(session);
    await store.flushSession(sid);
    const takeover = async () => {
      const before = lease.processEpoch(tenantId)!;
      const next = await client.bumpProcessEpoch(tenantId, randomUUID(), admin.db);
      assert.equal(next, before + 1n);
    };
    if (mode === 'pause') {
      const engine = await import('../engine.js');
      const previous = session.messages.length;
      lease.loseProcessLease();
      let completed = false;
      const turn = engine.handleMessage(sid, '你好', 'wecom').then(() => {
        completed = true;
      });
      await delay(50);
      assert.equal(completed, false);
      assert.equal(session.messages.length, previous);
      lease.resumeProcessLease();
      await turn;
      assert.equal(completed, true);
      assert.ok(session.messages.length > previous);
    } else if (mode === 'claim') {
      const { AccountInbox } = await import('../channels/inbox.js');
      const inbox = new AccountInbox({ id: account.id, idPrefix: 'wecom:', tag: '[r3-test]' });
      await takeover();
      await assert.rejects(
        inbox.acceptPage(
          account.id,
          [
            {
              msgid: 'r3-claim',
              open_kfid: 'fake-r3-kf',
              origin: 3,
              msgtype: 'text',
              external_userid: 'wmClaim',
              send_time: Math.floor(Date.now() / 1000),
              text: { content: '合成入站' },
            },
          ],
          'r3-stale-cursor',
        ),
        /process_epoch_stale/,
      );
    } else if (mode === 'welcome') {
      await takeover();
      await assert.rejects(wecom.__wecomTest.welcome(account.id), /process_lock_lost/);
    } else if (mode === 'store') {
      await takeover();
      session.messages.push({ role: 'customer', content: '不能落库', at: Date.now() });
      store.saveSession(session);
      await assert.rejects(store.flushSession(sid));
      assert.equal(rt.store.pgBackend!.health().lastError, 'process_epoch_stale');
    } else {
      const [intent] = ledger.planOutbound(account, { sessionId: sid, hasSession: true }, 'notice', null, null, [
        { msgtype: 'text', text: { content: '合成回复' } },
      ]);
      await store.flushSession(sid);
      if (mode === 'mark') {
        await takeover();
        assert.equal(await store.markOutboundSendingInDb(intent!.msgid, 1000), 'stale');
      } else if (mode === 'recovery') {
        assert.equal(await ledger.markSending(intent!), 'marked');
        await takeover();
        assert.equal(await wecom.__wecomTest.resend(account.id, intent!, true), false);
      } else if (mode === 'retry' || mode === 'token-retry') {
        afterFirst = takeover;
        assert.equal(await wecom.__wecomTest.resend(account.id, intent!, false), false);
        assert.equal(sends, 1, '同段重试/刷新 token 后不再发');
      } else if (mode === 'r6' || mode === 'r6-lost') {
        db.faults.acquire = new Error('synthetic_db_unavailable');
        assert.equal(await store.markOutboundSendingInDb(intent!.msgid, 1000), 'db_unavailable');
        if (mode === 'r6-lost') lease.loseProcessLease();
        assert.equal(await wecom.__wecomTest.resend(account.id, intent!, false), mode === 'r6');
        assert.equal(sends, mode === 'r6' ? 1 : 0);
        db.faults.acquire = null;
      } else throw new Error('unknown_test_case');
    }
    if (!mode.startsWith('r6') && mode !== 'pause') {
      assert.equal(lease.processLeaseStale(), true);
      assert.equal(exits, 1, '过期只启动一次优雅退出');
      assert.equal(sends, mode.includes('retry') ? 1 : 0);
    }
    await store.drainStore(100);
    store.spillStoresSync();
    if (!mode.startsWith('r6') && mode !== 'pause')
      assert.equal(
        fs.readdirSync(process.env.VAR_DIR!).some((name) => name.startsWith('store-spill-')),
        false,
        '过期不写 spill',
      );
    console.log(`FAILOVER PASS ${mode}`);
  } finally {
    db.faults.acquire = null;
    registry.__channelsTest.reset();
    rt.store.pgBackend?.close();
    config.markConfigShuttingDown();
    await config.closeConfig();
    await db.close();
    await admin.close();
    globalThis.fetch = originalFetch;
  }
  process.exit(0);
} else {
  // 单独执行时也跑完整真实 PG 场景；父套件通过 R3_CASE 驱动本文件的子进程分支。
  await import('../db/failover.selftest.js');
}
