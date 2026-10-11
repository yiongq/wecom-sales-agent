// 05 第 9 步：同 id 的 SSE、提交事件、渠道、任务与共享目录 spill 不串租户。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TENANCY_STRICT = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1';
process.env.DEMO_PRUNE_HOURS = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-events-'));
process.env.VAR_DIR = path.join(dir, 'host');
const r = await import('./runtime.js');
const store = await import('../store.js');
const states = await import('./state.js');
const events = await import('../store/events.js');
const hub = await import('../console-api/events.js');
const simulator = await import('../adapters/simulator.js');
const a = r.createTenantRuntime({ id: 'a', slug: 'events-a', isHost: true });
const b = r.createTenantRuntime({ id: 'b', slug: 'events-b' });
r.registerRuntime(a);
r.registerRuntime(b);
// 渠道能力从明确租户的装载入口导入；模块导入与异步续体均在严格作用域中。
const web = await r.withTenantScope(a, () => import('../adapters/web.js'));
const jobs = await r.withTenantScope(a, () => import('../jobs/runner.js'));
const channels = await r.withTenantScope(a, () => import('../channels/registry.js'));
const config = await import('../config/source.js');
const testing = await import('../db/testing.js');
const db = await testing.openTestDb();
const fixture = new Map<string, Awaited<ReturnType<typeof testing.installPgSessionStore>>>();
const inScope = <T>(rt: typeof a, fn: () => T): T => r.withTenantScope(rt, fn);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const su = async <T>(sql: string, args: unknown[] = []): Promise<T[]> =>
  db.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<T>(sql, args)).rows;
  });
const sameId = 'wecom:wmSame';
const { sealSecrets } = await import('../channels/secrets.js');
const key = Buffer.alloc(32, 7);
const ring = { current: { id: 'fixture', key }, all: new Map([['fixture', key]]) };
const accountIds = new Map<string, string>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'fixture-token', expires_in: 7200 });
  if (url.includes('/kf/sync_msg')) return Response.json({ errcode: 0, next_cursor: 'fixture-cursor', has_more: 0, msg_list: [] });
  throw new Error('未预期的测试请求');
};
try {
  for (const rt of [a, b]) {
    await inScope(rt, () => testing.installSeededConfig(db, { slug: rt.slug }));
    const fx = await inScope(rt, () => testing.installPgSessionStore(db, { slug: rt.slug, varDir: dir }));
    fixture.set(rt.id, fx);
    await inScope(rt, () => store.initSessionStore(fx.deps));
    await su(
      `insert into channel_accounts (tenant_id, key, name, kind, status, settings) values ($1, 'same', $2, 'web', 'disabled', '{}')`,
      [rt.id, rt.slug],
    );
    const accountId = randomUUID();
    accountIds.set(rt.id, accountId);
    const sealed = sealSecrets(
      ring,
      { tenantId: rt.id, accountId },
      {
        appSecret: 'fixture-app-value',
        callbackToken: 'fixture-callback-value',
        callbackAesKey: 'fixture-aes-value',
      },
    );
    await su(
      `insert into channel_accounts (tenant_id, id, key, name, kind, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id, settings)
       values ($1, $2, 'main', $3, 'wecom_kf', 'active', 'wecom:', 'fixture-corp', $3, decode($4, 'hex'), $5, '{}')`,
      [rt.id, accountId, rt.slug, sealed.ct.toString('hex'), sealed.keyId],
    );
  }
  // 与 boot 一样只从宿主调一次，同时装上已装载的另一 standard。
  await inScope(a, () => channels.initChannels({ ...fixture.get(a.id)!.deps, keyRing: ring }));
  for (const rt of [a, b]) {
    assert.equal(
      inScope(rt, () => channels.installedChannelAccounts().find((account) => account.key === 'same')?.name),
      rt.slug,
    );
  }
  const compat = r.createTenantRuntime({ id: 'compat-file', slug: '', isHost: true });
  r.registerRuntime(compat);
  const { createFileBackend } = await import('../store/file-backend.js');
  inScope(compat, () => {
    const received: string[] = [];
    const stop = events.onCommitted((ev) => received.push(ev.tenantId));
    const backend = createFileBackend({
      runtime: compat,
      varDir: path.join(dir, 'compat'),
      sessions: new Map(),
      orders: new Map(),
      owns: () => true,
      ownsOrder: () => true,
      isReal: () => false,
      afterPersist() {},
    });
    backend.emitAfterCommit('same', { type: 'conversation.changed', id: 'same', tenantId: compat.id });
    r.identifyRuntime(compat, { id: 'compat-identified', slug: 'compat', isHost: true });
    backend.flushNow();
    assert.deepEqual(received, [compat.id]);
    stop();
    backend.reset();
    states.dropTenantState(compat.id);
  });
  r.unregisterRuntime(compat.id);

  assert.throws(() => events.onCommitted(() => {}), r.TenantScopeMissing);
  assert.throws(hub.tailId, r.TenantScopeMissing);
  assert.throws(() => simulator.subscribe('same', () => {}), r.TenantScopeMissing);
  assert.throws(channels.loadedChannels, r.TenantScopeMissing);

  const seen = new Map([
    [a.id, [] as string[]],
    [b.id, [] as string[]],
  ]);
  const sse = new Map([
    [a.id, [] as string[]],
    [b.id, [] as string[]],
  ]);
  const webSse = new Map([
    [a.id, [] as string[]],
    [b.id, [] as string[]],
  ]);
  const changes = new Map([
    [a.id, 0],
    [b.id, 0],
  ]);
  const off = new Map<string, (() => void)[]>();
  for (const rt of [a, b])
    inScope(rt, () => {
      hub.__eventsTest.setTiming({ countsDebounceMs: 5 });
      hub.ensureEventHub(
        () =>
          ({
            total: rt === a ? 1 : 2,
            byState: { ai: 0, queued: 0, human: 0, ended: 0 },
            aiByStage: {},
            updatedToday: 0,
          }) as unknown as import('../shared/console-api.js').ConversationCounts,
      );
      off.set(rt.id, [
        events.onCommitted((ev) => {
          assert.equal(ev.tenantId, rt.id);
          assert.equal(r.currentRuntime(), rt);
          seen.get(rt.id)!.push(ev.type);
        }),
        simulator.subscribe('same', (text) => sse.get(rt.id)!.push(text)),
        hub.addListener((ev) => {
          assert.equal(r.currentRuntime(), rt);
          if (ev.event === 'counts') assert.equal(JSON.parse(ev.data).total, rt === a ? 1 : 2);
        }),
      ]);
      const cancel = web.subscribeWeb('same', 'same-ip', (ev) => webSse.get(rt.id)!.push(ev.text));
      assert.notEqual(cancel, 'too_many');
      off.get(rt.id)!.push(cancel as () => void);
      store.storeEvents.on('change', () => changes.set(rt.id, changes.get(rt.id)! + 1));
    });
  const tailB = inScope(b, hub.tailId);
  inScope(a, () => events.deliverCommitted([{ type: 'conversation.changed', id: sameId }]));
  await inScope(a, () => simulator.simulatorAdapter.push('same', 'a'));
  await inScope(a, () => web.webAdapter.push('same', 'a'));
  await pause(15);
  assert.deepEqual(seen.get(b.id), []);
  assert.deepEqual(sse.get(a.id), ['a']);
  assert.deepEqual(sse.get(b.id), []);
  assert.deepEqual(webSse.get(b.id), []);
  assert.equal(inScope(b, hub.tailId), tailB);
  assert.equal(
    inScope(b, () => hub.replayAfter(inScope(a, hub.tailId))),
    null,
  );
  inScope(b, () => events.deliverCommitted([{ type: 'conversation.changed', id: sameId }]));
  await pause(15);
  assert.deepEqual(seen.get(b.id), ['conversation.changed']);
  assert.throws(
    () => inScope(a, () => events.deliverCommitted([{ type: 'conversation.changed', id: sameId, tenantId: b.id }])),
    /租户不匹配/,
  );

  for (const rt of [a, b])
    await inScope(rt, async () => {
      const s = store.getOrCreateSession(sameId, 'wecom');
      s.messages.push({ role: 'customer', content: rt.slug, at: Date.now() });
      store.saveSession(s);
      await store.flushSession(sameId);
    });
  await pause(250);
  assert.equal(changes.get(a.id), 1);
  assert.equal(changes.get(b.id), 1);
  channels.startChannels();
  const wecom = await import('../adapters/wecom.js');
  for (let i = 0; i < 100 && ![a, b].every((rt) => inScope(rt, wecom.__wecomTest.idle)); i++) await pause(10);
  for (const rt of [a, b])
    inScope(rt, () => {
      assert.ok(wecom.__wecomTest.inspect(accountIds.get(rt.id)!));
      assert.equal(wecom.__wecomTest.inspect(accountIds.get(rt === a ? b.id : a.id)!), null);
      assert.equal(wecom.__wecomTest.routeAccount(sameId), accountIds.get(rt.id));
    });
  // 账本的 accountByKey 表待第 8 步合并；此处使用最后装载的 B 验证句柄本身不可跨租户消费。
  const prepared = inScope(b, () => wecom.wecomAdapter.prepare!(sameId, b.slug, { kind: 'human' }));
  assert.ok(prepared);
  assert.equal(await inScope(a, () => wecom.wecomAdapter.push(sameId, 'cross', { kind: 'human', prepared })), false);
  inScope(a, () => wecom.wecomAdapter.release!(prepared, 'aborted'));
  await inScope(b, async () => {
    wecom.wecomAdapter.release!(prepared, 'aborted');
    await store.flushSession(sameId);
  });
  const outbound = await su<{ tenant_id: string; account_id: string; status: string }>(
    'select tenant_id, account_id, status from outbound_sends where conversation_id=$1',
    [sameId],
  );
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]!.tenant_id, b.id);
  assert.equal(outbound[0]!.account_id, accountIds.get(b.id));
  assert.equal(outbound[0]!.status, 'cancelled');

  // A 中创建的取消函数在 B 中调用，必须只摘 A。
  inScope(b, () => off.get(a.id)![1]!());
  await inScope(a, () => simulator.simulatorAdapter.push('same', 'ignored'));
  await inScope(b, () => simulator.simulatorAdapter.push('same', 'b'));
  assert.deepEqual(sse.get(a.id), ['a']);
  assert.deepEqual(sse.get(b.id), ['b']);

  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = jobs.__jobsTest.setHandler('handoff_notify', async () => {
    const owner = r.currentRuntime();
    if (owner === a) await gate;
    ran.push(owner.id);
    return { status: 'done' };
  });
  try {
    for (const rt of [a, b]) {
      inScope(rt, () => jobs.__jobsTest.start(async () => true));
      await inScope(rt, () =>
        store.withJobsTx(async (tx) => {
          const { enqueueJob } = await import('../db/repo/jobs.js');
          await enqueueJob(tx, { kind: 'handoff_notify', dedupeKey: 'same', runAt: new Date(0), payload: {}, maxAttempts: 1 });
        }),
      );
    }
    const runA = inScope(a, () => jobs.runJobsOnce());
    await inScope(b, () => jobs.runJobsOnce());
    assert.deepEqual(ran, [b.id]);
    release();
    await runA;
    assert.deepEqual(ran, [b.id, a.id]);
    const rows = await su<{ tenant_id: string; status: string }>("select tenant_id, status from jobs where dedupe_key='same'");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'done'));
  } finally {
    release();
    jobs.__jobsTest.setHandler('handoff_notify', previous);
  }

  const notices = await import('../notify/handoff.js');
  const handoff = {
    type: 'handoff.started' as const,
    id: sameId,
    kind: 'request' as const,
    at: Date.now(),
    escalated: false,
    paidCustomer: false,
    assigned: false,
  };
  for (const rt of [a, b])
    inScope(rt, () => {
      events.deliverHandoffUnsaved([handoff]);
      assert.equal(notices.__handoffNotifyTest.unsavedState(sameId, handoff.at), 'waiting');
    });
  inScope(a, () => events.deliverCommitted([handoff]));
  assert.equal(
    inScope(a, () => notices.__handoffNotifyTest.unsavedState(sameId, handoff.at)),
    null,
  );
  assert.equal(
    inScope(b, () => notices.__handoffNotifyTest.unsavedState(sameId, handoff.at)),
    'waiting',
  );

  // 两个后端同毫秒写同一目录，不覆盖；先回放 A 时 B 文件保持逐字节相同。
  const originalNow = Date.now;
  const originalDate = Date;
  try {
    Date.now = () => 1790913600000;
    globalThis.Date = new Proxy(originalDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [1790899200000]);
      },
    });
    for (const rt of [a, b])
      inScope(rt, () => {
        fixture.get(rt.id)!.faults.acquire = testing.fakeDbError('08006');
        const s = store.getOrCreateSession('wecom:wmSpill', 'wecom');
        s.messages.push({ role: 'customer', content: rt.slug, at: Date.now() });
        store.saveSession(s);
        rt.store.pgBackend!.spillSync();
      });
  } finally {
    Date.now = originalNow;
    globalThis.Date = originalDate;
  }
  const spills = fs.readdirSync(dir).filter((name) => /^store-spill-.+\.json$/.test(name));
  assert.equal(spills.length, 2);
  const foreign = spills.find((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).tenant === b.id)!;
  const foreignBytes = fs.readFileSync(path.join(dir, foreign));
  const unloaded = path.join(dir, 'store-spill-unloaded.json');
  const unloadedBytes = JSON.stringify({ tenant: 'unloaded-tenant', version: 2, sessions: 'future-format' });
  fs.writeFileSync(unloaded, unloadedBytes);
  const { openPgBackend } = await import('../store/pg-backend.js');
  for (const rt of [a, b]) {
    await inScope(rt, () => rt.store.pgBackend!.close());
    fixture.get(rt.id)!.faults.acquire = null;
    const backend = await inScope(rt, () =>
      openPgBackend({
        ...fixture.get(rt.id)!.deps,
        runtime: rt,
        sessions: new Map(),
        orders: new Map(),
        writable: () => true,
        onConflict: () => assert.fail('spill conflict'),
        afterCommit: () => {},
        ordersTaken: () => {},
        outboundCommitted: () => {},
      }),
    );
    try {
      assert.equal(backend.stats().replayed, 1);
      if (rt === a) assert.deepEqual(fs.readFileSync(path.join(dir, foreign)), foreignBytes);
    } finally {
      await backend.close();
    }
  }
  assert.equal(fs.readdirSync(dir).filter((name) => /^store-spill-.+\.json$/.test(name)).length, 1);
  assert.equal(fs.readFileSync(unloaded, 'utf8'), unloadedBytes);
  fs.unlinkSync(unloaded);
  for (const rt of [a, b]) {
    inScope(rt, () => {
      for (const stop of off.get(rt.id)!) stop();
    });
    const closed: string[] = [];
    inScope(rt, () => {
      simulator.subscribe(
        'drop',
        () => {},
        () => {
          assert.equal(r.currentRuntime(), rt);
          closed.push('simulator');
        },
      );
      const cancel = web.subscribeWeb(
        'drop',
        'drop-ip',
        () => {},
        () => {
          assert.equal(r.currentRuntime(), rt);
          closed.push('web');
        },
      );
      assert.notEqual(cancel, 'too_many');
    });
    states.dropTenantState(rt.id);
    assert.deepEqual(closed.sort(), ['simulator', 'web']);
    assert.ok(
      Object.entries(states.tenantKeys(rt.id))
        .filter(([name]) =>
          /^(simulator|wecom\.|web\.clients|console\.events|domain\.|store\.(incidentHooks|saveHooks|outboundCommitHooks|storeEvents|changeTimer)|channels\.registry|jobs\.|followup\.|notify\.)/.test(
            name,
          ),
        )
        .every(([, count]) => count === 0),
    );
  }
  inScope(a, () => simulator.subscribe('reset', () => {}));
  assert.equal(states.tenantKeys(a.id)['simulator.clients'], 1);
  states.resetTenantState();
  assert.equal(states.tenantKeys(a.id)['simulator.clients'], 0);
  assert.equal(states.tenantKeys(b.id)['notify.waiting'], 0);
  console.log('TENANT EVENTS SELFTEST PASS: 严格作用域 / SSE / 提交与去抖 / 渠道同 key / 独立任务道 / spill / 删除登记');
} finally {
  const wecom = await import('../adapters/wecom.js');
  for (const rt of [a, b]) inScope(rt, wecom.stopWecomAccounts);
  channels.__channelsTest.stopStatsRefresh();
  for (const rt of [a, b]) {
    await inScope(rt, () => rt.store.pgBackend?.close());
    await inScope(rt, config.closeConfig);
    states.dropTenantState(rt.id);
    r.unregisterRuntime(rt.id);
  }
  await db.close();
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
