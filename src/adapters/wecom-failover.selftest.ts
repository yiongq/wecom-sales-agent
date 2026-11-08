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
if (mode === 'boot' || mode === 'boot-spill' || mode === 'boot-spill-fail') {
  process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
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
        if (mode === 'boot-spill-fail' && name === 'renameSync' && String(args[1]).includes('store-spill-'))
          throw Object.assign(new Error('synthetic_spill_failure'), { code: 'EACCES' });
        const result = Reflect.apply(original, target, args);
        if (name === 'renameSync' && String(args[1]).includes('store-spill-') && String(args[1]).endsWith('.json'))
          process.send?.({ event: 'spill', held: lease.processLeaseHeld() });
        return result;
      };
    }
  }
  syncBuiltinESMExports();
  let pulls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://alerts.example.test/hook') {
      process.send?.({ event: 'alert', text: JSON.parse(String(init?.body)).text.content });
      return Response.json({ errcode: 0 });
    }
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
  if (mode.startsWith('boot-spill')) onShutdown(() => delay(600), { phase: 'late' });
  lease.onProcessLeaseChange(() => process.send?.({ event: 'lease', held: lease.processLeaseHeld(), stale: lease.processLeaseStale() }));
  process.send?.({ event: 'starting' });
  await import('../server.js');
  const wecom = await import('./wecom.js');
  const registry = await import('../channels/registry.js');
  const store = await import('../store.js');
  withTenantScope(hostRuntime(), () =>
    store.onStoreIncident((incident) => {
      if (incident.kind === 'process_epoch_stale') {
        const stats = hostRuntime().store.pgBackend!.stats();
        process.send?.({
          event: 'discard',
          counts: [stats.staleDiscardedSessions, stats.staleDiscardedMessages, stats.staleDiscardedChannelWrites],
        });
      }
    }),
  );
  process.on('message', (message: { action?: string; count?: number }) => {
    void withTenantScope(hostRuntime(), async () => {
      if (message.action === 'try-pull') {
        const account = registry.installedChannelAccounts().find((a) => a.kind === 'wecom_kf')!;
        await wecom.syncAccountFromCallback(account.id, 'fake-r3-trigger');
        process.send?.({ event: 'pull-probed' });
      } else if (message.action === 'dirty') {
        hostRuntime().store.pgBackend!.close();
        for (let i = 0; i < (message.count ?? 1); i++) {
          const session = store.getOrCreateSession(i === 0 ? 'wecom:wmStale' : `wecom:wmSpill${i}`, 'wecom');
          session.messages.push({ role: 'customer', content: '待丢弃的合成消息', at: Date.now() });
          if (message.count)
            for (let j = 0; j < 9; j++) session.messages.push({ role: 'customer', content: '合成停机负载'.repeat(256), at: Date.now() });
          store.saveSession(session);
        }
        process.send?.({ event: 'dirty' });
      }
    }).catch(() => process.send?.({ event: 'probe-failed' }));
  });
  process.send?.({ event: 'booted', replayed: hostRuntime().store.pgBackend?.stats().replayed ?? 0 });
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
  const query = await testing.connectSuperQuery(process.env.R3_ADMIN_URL!);
  let sends = 0;
  const sentMsgids: string[] = [];
  const alerts: string[] = [];
  let notifications = 0;
  const notificationTexts: string[] = [];
  let failNotification: (() => Promise<void>) | undefined;
  let afterFirst: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://notify.example.test/hook') {
      notifications++;
      notificationTexts.push(JSON.parse(String(init?.body)).text.content);
      if (failNotification) {
        const action = failNotification;
        failNotification = undefined;
        await action();
        return Response.json({ errcode: 45009 });
      }
      return Response.json({ errcode: 0 });
    }
    if (url === 'https://alerts.example.test/hook') {
      alerts.push((JSON.parse(String(init?.body)) as { text: { content: string } }).text.content);
      return Response.json({ errcode: 0 });
    }
    if (url.includes('/gettoken?'))
      return Response.json({ access_token: 'fake-r3-token', expires_in: mode === 'token-initial-pause' ? 0 : 7200 });
    if (url.includes('/kf/sync_msg?')) return Response.json({ errcode: 0, has_more: 0, msg_list: [], next_cursor: 'r3-cursor' });
    if (url.includes('/kf/send_msg')) {
      sends++;
      sentMsgids.push((JSON.parse(String(init?.body)) as { msgid: string }).msgid);
      if (afterFirst) {
        const action = afterFirst;
        afterFirst = undefined;
        await action();
        return Response.json({ errcode: mode.startsWith('token-') ? 42001 : 45009 });
      }
      return Response.json({ errcode: 0 });
    }
    throw new Error('unexpected_wecom_request');
  };
  await config.initConfigFromEnv(process.env, () => {
    exits++;
  });
  config.__configTest.setTimings({ reacquireMs: 30_000 });
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
    sentMsgids.length = 0;
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
    const lose = async () => {
      const name = new URL(process.env.DATABASE_URL!).searchParams.get('application_name')!;
      await query.query(
        `select pg_terminate_backend(a.pid) from pg_stat_activity a
        where a.application_name=$1 and exists (select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory')`,
        [name],
      );
      await until(() => !lease.processLeaseHeld());
    };
    const regain = async () => rt.config.loaded!.lock.reacquire();
    if (mode.startsWith('job-')) {
      process.env.NOTIFY_WEBHOOK_URL = 'https://notify.example.test/hook';
      const jobs = await import('../jobs/runner.js');
      const repo = await import('../db/repo/jobs.js');
      const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
      jobs.__jobsTest.start(async () => true);
      if (mode === 'job-recover') {
        const pending = await query.query<{ id: string }>(
          "select id from jobs where kind='handoff_notify' and last_error='process_lease_interrupted' and status='pending'",
        );
        assert.equal(pending.length, 2);
        await jobs.runJobsOnce();
        assert.equal(notifications, 2, '新进程启动归位后两条通知各发一次');
        assert.equal(new Set(notificationTexts).size, 2);
        for (const { id } of pending)
          assert.deepEqual(await query.query('select status,attempts from jobs where id=$1', [id]), [{ status: 'done', attempts: 3 }]);
      } else {
        const id = await store.withJobsTx((tx) =>
          repo.enqueueJob(tx, {
            kind: 'handoff_notify',
            dedupeKey: mode,
            runAt: new Date(0),
            maxAttempts: 4,
            payload: { sessionId: sid, reason: 'intake_unmatched', intakeId: 'int_012345abcdef', lines: [1] },
          }),
        );
        const queued = await store.withJobsTx((tx) =>
          repo.enqueueJob(tx, {
            kind: 'handoff_notify',
            dedupeKey: `${mode}-queued`,
            runAt: new Date(1),
            maxAttempts: 4,
            payload: { sessionId: sid, reason: 'intake_unmatched', intakeId: 'int_012345abcdef', lines: [2] },
          }),
        );
        for (const jobId of [id, queued]) await query.query('update jobs set attempts=3 where id=$1', [jobId]);
        let interrupted = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = jobs.__jobsTest.setHandler('handoff_notify', async (job, now, context) => {
          if (job.id !== id) return original(job, now, context);
          await lose();
          try {
            return await original(job, now, context);
          } catch (error) {
            interrupted = true;
            await gate;
            throw error;
          }
        });
        const running = jobs.runJobsOnce();
        await until(() => !lease.processLeaseHeld());
        await until(() => interrupted);
        assert.equal(notifications, 0);
        assert.deepEqual(
          await query.query('select status,attempts from jobs where id=$1', [id]),
          [{ status: 'pending', attempts: 3 }],
          '发现失锁时即持久归还，不能带 running 等到停机/新主启动才处理',
        );
        if (mode === 'job-lease-recovered-first') {
          await takeover();
          assert.equal(await regain(), 'held_by_other');
          await until(() => interrupted);
          await client.withTenant(admin.db, ctx, repo.recoverJobsAtStartup);
          assert.deepEqual(await query.query('select status,attempts from jobs where id=$1', [id]), [{ status: 'pending', attempts: 3 }]);
        } else lease.stopProcessLeaseWaits();
        await until(() => interrupted);
        release();
        await running;
        await jobs.__jobsTest.stop();
        assert.equal(notifications, 0);
        for (const jobId of [id, queued])
          assert.deepEqual(await query.query('select status,attempts,last_error from jobs where id=$1', [jobId]), [
            { status: 'pending', attempts: 3, last_error: 'process_lease_interrupted' },
          ]);
        await client.withTenant(admin.db, ctx, repo.recoverJobsAtStartup);
        for (const jobId of [id, queued])
          assert.deepEqual(await query.query('select status,attempts from jobs where id=$1', [jobId]), [
            { status: 'pending', attempts: 3 },
          ]);
        jobs.__jobsTest.setHandler('handoff_notify', original);
      }
    } else if (mode === 'poisoned-discard') {
      process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
      const ops = await import('../ops/alert.js');
      ops.startAlerts();
      ops.__alertTest.stopTimer();
      await ops.__alertTest.settle();
      alerts.length = 0;
      const poisonedId = `wecom:${'q'.repeat(195)}`;
      const poisoned = store.getOrCreateSession(poisonedId, 'wecom');
      poisoned.messages.push({ role: 'customer', content: '合成 poisoned 消息', at: Date.now() });
      store.saveSession(poisoned);
      await until(() => rt.store.pgBackend!.isPoisoned(poisonedId));
      let blocked = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.defineProperty(db.faults, 'gate', {
        configurable: true,
        get() {
          blocked = true;
          return gate;
        },
      });
      const [intent] = ledger.planOutbound(account, { sessionId: poisonedId, hasSession: true }, 'notice', null, null, [
        { msgtype: 'text', text: { content: '合成 poisoned 回复' } },
      ]);
      ledger.settleIntent(intent!, 'accepted', { attempts: 1 });
      store.queueInboxState(poisonedId, { inboxId: randomUUID(), state: 'done' });
      await until(() => blocked);
      await takeover();
      Object.defineProperty(db.faults, 'gate', { configurable: true, writable: true, value: null });
      release();
      await until(() => store.__storeTest.pgStats()!.staleDiscardedChannelWrites > 0);
      await ops.__alertTest.settle();
      const stats = store.__storeTest.pgStats()!;
      assert.deepEqual([stats.staleDiscardedSessions, stats.staleDiscardedMessages, stats.staleDiscardedChannelWrites], [1, 1, 3]);
      assert.equal(alerts.filter((text) => text.includes('process_epoch_stale')).length, 1);
      assert.match(
        alerts.find((text) => text.includes('process_epoch_stale'))!,
        /丢弃 1 个会话、1 条消息、3 条渠道写入/,
      );
      await store.drainStore(30);
      store.spillStoresSync();
      assert.deepEqual(store.__storeTest.pgStats(), stats);
    } else if (mode.startsWith('notify-')) {
      process.env.NOTIFY_WEBHOOK_URL = 'https://notify.example.test/hook';
      process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
      const { webhookNotifier } = await import('../notify/notifier.js');
      const ops = await import('../ops/alert.js');
      if (mode === 'notify-retry') {
        const handoff = await import('../notify/handoff.js');
        const events = await import('../store/events.js');
        handoff.installUnsavedNotices();
        handoff.__handoffNotifyTest.setTiming({ retryMs: [1, 1] });
        failNotification = lose;
        const at = Date.now();
        events.deliverHandoffUnsaved([
          { type: 'handoff.started', id: sid, kind: 'emergency', at, escalated: false, paidCustomer: false, assigned: false },
        ]);
        await until(() => notifications === 1 && !lease.processLeaseHeld());
        await delay(50);
        assert.equal(notifications, 1, '退避醒来后仍未持锁，不得开始下一次请求');
        assert.equal(handoff.__handoffNotifyTest.unsavedState(sid, at), 'sending');
        assert.equal(await regain(), 'ok');
        await until(() => handoff.__handoffNotifyTest.unsavedState(sid, at) === 'sent');
        assert.equal(notifications, 2);
      } else {
        await lose();
        let completed = false;
        const sending = webhookNotifier(process.env.NOTIFY_WEBHOOK_URL)
          .send({ shortId: 'ABCD', kind: 'request', paidCustomer: false, at: Date.now(), link: '/console', unsaved: false, label: '客户' })
          .then(
            () => {
              completed = true;
              return null;
            },
            (error: unknown) => error,
          );
        ops.alert('tenant_lock', '测试期间的失锁运维告警', { instance: true });
        await ops.__alertTest.settle();
        assert.equal(alerts.length, 1, '运维告警不受业务发送栅栏影响');
        await delay(40);
        assert.equal(notifications, 0);
        assert.equal(completed, false);
        if (mode === 'notify-stale') {
          await takeover();
          assert.equal(await regain(), 'held_by_other');
          assert.ok(lease.isProcessLeaseError(await sending));
          assert.equal(notifications, 0);
        } else {
          assert.equal(await regain(), 'ok');
          assert.equal(await sending, null);
          assert.equal(notifications, 1);
        }
      }
    } else if (mode === 'discard-alert') {
      process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
      const ops = await import('../ops/alert.js');
      ops.startAlerts();
      ops.__alertTest.stopTimer();
      await ops.__alertTest.settle();
      alerts.length = 0;
      rt.store.pgBackend!.close();
      session.messages.push(...[1, 2].map((n) => ({ role: 'customer' as const, content: `待丢弃 ${n}`, at: Date.now() })));
      store.saveSession(session);
      const second = store.getOrCreateSession('wecom:wmDiscardB', 'wecom');
      second.messages.push({ role: 'customer', content: '待丢弃 3', at: Date.now() });
      store.saveSession(second);
      const intents = ledger.planOutbound(
        account,
        { sessionId: sid, hasSession: true },
        'notice',
        null,
        null,
        [1, 2].map((n) => ({ msgtype: 'text' as const, text: { content: `合成段 ${n}` } })),
      );
      ledger.settleIntent(intents[0]!, 'accepted', { attempts: 1 });
      await takeover();
      await assert.rejects(config.waitForProcessEpochBeforeSend(), /process_epoch_stale/);
      await store.drainStore(50);
      store.spillStoresSync();
      await ops.__alertTest.settle();
      const stats = store.__storeTest.pgStats()!;
      assert.deepEqual([stats.staleDiscardedSessions, stats.staleDiscardedMessages, stats.staleDiscardedChannelWrites], [2, 3, 3]);
      assert.equal(alerts.filter((text) => text.includes('process_epoch_stale')).length, 1);
      assert.match(
        alerts.find((text) => text.includes('process_epoch_stale'))!,
        /丢弃 2 个会话、3 条消息、3 条渠道写入/,
      );
      await store.drainStore(50);
      store.spillStoresSync();
      assert.deepEqual(store.__storeTest.pgStats(), stats, '重复 drain/exit 不重复计数');
    } else if (mode === 'reply-pause' || mode === 'reply-stale') {
      const llm = await import('../llm.js');
      const { AccountInbox } = await import('../channels/inbox.js');
      const inbox = new AccountInbox({ id: account.id, idPrefix: 'wecom:', tag: '[r3-test]' });
      const count = mode === 'reply-pause' ? 2 : 1;
      await inbox.acceptPage(
        account.id,
        Array.from({ length: count }, (_, i) => ({
          msgid: `${mode}-${i}`,
          open_kfid: 'fake-r3-kf',
          origin: 3,
          msgtype: 'text',
          external_userid: sid.slice('wecom:'.length),
          send_time: Math.floor(Date.now() / 1000) + 1,
          text: { content: i === 0 ? '你好' : '想去云南旅游' },
        })),
        `cursor-${mode}`,
      );
      let generating = 0;
      let disconnected: Promise<void> | undefined;
      llm.observeRequests(() => {
        generating++;
        if (generating === 1) {
          lease.loseProcessLease();
          disconnected = lose();
        }
      });
      await wecom.__wecomTest.dispatchOpen(account.id);
      await until(() => generating > 0);
      await disconnected;
      await until(
        async () => (await query.query("select id from outbound_sends where conversation_id=$1 and status='pending'", [sid])).length > 0,
      );
      assert.equal(sends, 0);
      assert.equal(generating, 1, '后一句留在同一个会话队列中');
      if (mode === 'reply-stale') {
        await takeover();
        assert.equal(await regain(), 'held_by_other');
        await until(() => wecom.__wecomTest.idle());
        assert.equal(sends, 0);
        const rows = await query.query<{ state: string }>('select state from channel_inbox where conversation_id=$1', [sid]);
        assert.equal(rows[0]!.state, 'replied', '留给新主恢复，不能记 done/rejected');
      } else {
        assert.equal(await regain(), 'ok');
        await until(() => wecom.__wecomTest.idle());
        await store.flushSession(sid);
        const rows = await query.query<{ channel_msgid: string; state: string; status: string }>(
          `
          select o.channel_msgid, o.status, i.state from outbound_sends o join channel_inbox i on o.inbox_id=i.id and o.tenant_id=i.tenant_id
          where o.conversation_id=$1 order by i.ord,o.segment`,
          [sid],
        );
        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.state === 'done' && row.status === 'accepted'));
        assert.deepEqual(
          sentMsgids,
          rows.map((row) => row.channel_msgid),
          '每条回复只发一次，顺序不变',
        );
      }
      llm.observeRequests(null);
    } else if (mode === 'pause') {
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
      await assert.rejects(wecom.__wecomTest.welcome(account.id), /process_epoch_stale|process_lock_lost/);
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
      if (mode === 'deadline-before-send') {
        const epochDb = await testing.openGatedDb(process.env.DATABASE_URL!);
        const previousDb = config.configRuntime().deps.db;
        let release!: () => void;
        epochDb.faults.gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        config.configRuntime().deps.db = epochDb.db;
        try {
          const pending = wecom.__wecomTest.resend(account.id, intent!, false);
          await until(
            async () =>
              (await query.query<{ status: string }>('select status from outbound_sends where channel_msgid=$1', [intent!.msgid]))[0]
                ?.status === 'sending',
          );
          wecom.__wecomTest.closeSends(account.id, 0);
          epochDb.faults.gate = null;
          release();
          assert.equal(await pending, false);
          assert.equal(sends, 0);
          assert.deepEqual(await query.query('select status,attempts from outbound_sends where channel_msgid=$1', [intent!.msgid]), [
            { status: 'pending', attempts: 0 },
          ]);
          assert.equal(ledger.__ledgerTest.rows(sid).find((row) => row.msgid === intent!.msgid)!.status, 'pending');
          wecom.__wecomTest.closeSends(account.id, null);
          assert.equal(await wecom.__wecomTest.resend(account.id, intent!, false), true);
          assert.equal(sends, 1, '未发送的回复恢复后只发一次');
        } finally {
          release();
          config.configRuntime().deps.db = previousDb;
          await epochDb.close();
        }
      } else if (mode === 'deadline-after-send') {
        afterFirst = async () => {
          wecom.__wecomTest.closeSends(account.id, 0);
        };
        assert.equal(await wecom.__wecomTest.resend(account.id, intent!, false), false);
        assert.equal(sends, 1);
        const row = ledger.__ledgerTest.rows(sid).find((row) => row.msgid === intent!.msgid)!;
        assert.equal(row.status, 'rejected');
      } else if (mode === 'token-pause' || mode === 'token-initial-pause') {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const originalDb = config.configRuntime().deps.db;
        const blockToken = async () => {
          config.configRuntime().deps.db = db.db;
          db.faults.gate = gate;
        };
        if (mode === 'token-pause') afterFirst = blockToken;
        else await blockToken();
        let completed = false;
        const pending = wecom.__wecomTest.resend(account.id, intent!, false).then((ok) => {
          completed = true;
          return ok;
        });
        if (mode === 'token-pause') await until(() => sends === 1);
        await delay(30);
        await lose();
        db.faults.gate = null;
        release();
        await delay(40);
        assert.equal(completed, false);
        assert.equal(
          ledger.__ledgerTest.rows(sid).find((row) => row.msgid === intent!.msgid)!.status,
          mode === 'token-pause' ? 'sending' : 'pending',
        );
        assert.equal(await regain(), 'ok');
        assert.equal(await pending, true);
        assert.equal(sends, mode === 'token-pause' ? 2 : 1);
        assert.equal(ledger.__ledgerTest.rows(sid).find((row) => row.msgid === intent!.msgid)!.status, 'accepted');
        config.configRuntime().deps.db = originalDb;
      } else if (mode === 'mark') {
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
        const sending = wecom.__wecomTest.resend(account.id, intent!, false);
        if (mode === 'r6-lost') {
          await delay(40);
          assert.equal(sends, 0);
          lease.resumeProcessLease();
        }
        assert.equal(await sending, true);
        assert.equal(sends, 1);
        db.faults.acquire = null;
      } else throw new Error('unknown_test_case');
    }
    const expectedStale = [
      'claim',
      'mark',
      'store',
      'welcome',
      'recovery',
      'retry',
      'token-retry',
      'notify-stale',
      'reply-stale',
      'discard-alert',
      'poisoned-discard',
      'job-lease-recovered-first',
    ].includes(mode);
    if (expectedStale) {
      assert.equal(lease.processLeaseStale(), true);
      assert.equal(exits, 1, '过期只启动一次优雅退出');
      assert.equal(sends, mode.includes('retry') ? 1 : 0);
    }
    await store.drainStore(100);
    store.spillStoresSync();
    if (expectedStale)
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
    await query.close();
    await admin.close();
    globalThis.fetch = originalFetch;
  }
  process.exit(0);
} else {
  // 单独执行时也跑完整真实 PG 场景；父套件通过 R3_CASE 驱动本文件的子进程分支。
  await import('../db/failover.selftest.js');
}
