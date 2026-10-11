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
// 回归：严格模式、尚无租户作用域时导入账本必须成功。
const ledger = await import('../quota/ledger.js');
const a = r.createTenantRuntime({ id: 'a', slug: 'events-a', isHost: true });
const b = r.createTenantRuntime({ id: 'b', slug: 'events-b', publicBase: 'https://events-b.example.invalid' });
r.registerRuntime(a);
r.registerRuntime(b);
const web = await import('../adapters/web.js');
const jobs = await import('../jobs/runner.js');
const channels = await import('../channels/registry.js');
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
const sent: { msgid: string; touser: string; open_kfid: string; text?: { content: string } }[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'fixture-token', expires_in: 7200 });
  if (url.includes('/kf/sync_msg')) return Response.json({ errcode: 0, next_cursor: 'fixture-cursor', has_more: 0, msg_list: [] });
  if (url.includes('/kf/send_msg')) {
    const body = JSON.parse(String(init!.body));
    sent.push(body);
    return Response.json({ errcode: 0, msgid: body.msgid });
  }
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
  // 恢复保护同时覆盖所有 standard：只截 A 不能解除 B 的保护。
  const markers = await import('../channels/markers.js');
  const cli = await import('../cli/channel-account.js');
  const sentinel = path.join(dir, markers.RESTORE_SENTINEL);
  fs.writeFileSync(sentinel, '{"backupAt":"2026-10-10T00:00:00Z"}\n');
  await su('update channel_accounts set status=$1 where tenant_id=$2 and kind=$3', ['exported', a.id, 'wecom_kf']);
  await assert.rejects(
    inScope(a, () => channels.initChannels({ ...fixture.get(a.id)!.deps, keyRing: ring })),
    /恢复哨兵/,
  );
  assert.equal(fs.existsSync(sentinel), true, '宿主 env 分支不能删除其他租户的哨兵');
  assert.equal(markers.hasRestoreSentinel(dir, b.id), true);
  inScope(a, channels.__channelsTest.reset);
  await su('update channel_accounts set status=$1 where tenant_id=$2 and kind=$3', ['active', a.id, 'wecom_kf']);
  await assert.rejects(
    inScope(b, () => channels.initChannels({ ...fixture.get(b.id)!.deps, keyRing: ring })),
    /恢复哨兵/,
  );
  const cutoff = async (rt: typeof a): Promise<void> => {
    assert.equal(
      await cli.runChannelAccount(['restore-cutoff', '--tenant', rt.slug, '--until', '2026-10-10T00:00:00Z', '--var', dir], {
        connect: async () => ({ db: db.db, close: async () => {}, lock: async () => testing.fakeLock() }),
      }),
      0,
    );
  };
  await cutoff(a);
  assert.equal(markers.hasRestoreSentinel(dir, a.id), false);
  assert.equal(markers.hasRestoreSentinel(dir, b.id), true);
  assert.equal(fs.existsSync(sentinel), true);
  await assert.rejects(
    inScope(b, () => channels.initChannels({ ...fixture.get(b.id)!.deps, keyRing: ring })),
    /恢复哨兵/,
  );
  await cutoff(b);
  assert.equal(markers.hasRestoreSentinel(dir, b.id), false);
  fs.writeFileSync(sentinel, '{"backupAt":"2026-10-10T01:00:00Z"}\n');
  assert.equal(markers.hasRestoreSentinel(dir, a.id), true, '新备份不认旧完成凭据');
  assert.equal(markers.hasRestoreSentinel(dir, b.id), true);
  await cutoff(a);
  await cutoff(b);
  // 与 boot 一样只从宿主调一次，同时装上已装载的另一 standard。
  await inScope(a, () => channels.initChannels({ ...fixture.get(a.id)!.deps, keyRing: ring }));
  const { accountByKey, accountForSession } = await import('../channels/accounts.js');
  for (const rt of [a, b]) {
    assert.equal(
      inScope(rt, () => channels.installedChannelAccounts().find((account) => account.key === 'same')?.name),
      rt.slug,
    );
    assert.equal(
      inScope(rt, () => accountByKey('main', 'wecom_kf')?.id),
      accountIds.get(rt.id),
      '后装载的租户不覆盖先装载租户的 key 查找',
    );
    assert.equal(
      inScope(rt, () => accountForSession(sameId)?.id),
      accountIds.get(rt.id),
      '相同会话前缀只匹配本租户账号',
    );
  }
  inScope(b, channels.__channelsTest.reset);
  assert.equal(
    inScope(b, () => accountByKey('main', 'wecom_kf')),
    undefined,
  );
  assert.equal(
    inScope(a, () => accountByKey('main', 'wecom_kf')?.id),
    accountIds.get(a.id),
    '重置 B 不清除 A 的 key 查找',
  );
  await inScope(b, () => channels.initChannels({ ...fixture.get(b.id)!.deps, keyRing: ring }));
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
  let mismatches = 0;
  const stopMismatch = events.onDomainEventMismatch(() => {
    mismatches++;
  });
  const oldError = console.error;
  const mismatchLogs: string[] = [];
  console.error = (...args) => {
    mismatchLogs.push(args.join(' '));
  };
  try {
    const before = seen.get(a.id)!.length;
    inScope(a, () =>
      events.deliverCommitted([
        { type: 'conversation.changed', id: sameId, tenantId: b.id },
        { type: 'conversation.changed', id: sameId, tenantId: a.id },
      ]),
    );
    assert.equal(seen.get(a.id)!.length, before + 1, '只跳过外租户事件，同批下一条照常发');
    let unsaved = 0;
    const stopUnsaved = inScope(a, () =>
      events.onHandoffUnsaved(() => {
        unsaved++;
      }),
    );
    const handoff = {
      type: 'handoff.started' as const,
      id: sameId,
      kind: 'request' as const,
      at: Date.now(),
      escalated: false,
      paidCustomer: false,
      assigned: false,
    };
    inScope(a, () =>
      events.deliverHandoffUnsaved([
        { ...handoff, tenantId: b.id },
        { ...handoff, tenantId: a.id },
      ]),
    );
    stopUnsaved();
    assert.equal(unsaved, 1);
  } finally {
    console.error = oldError;
    stopMismatch();
  }
  assert.equal(mismatches, 2);
  assert.equal(mismatchLogs.filter((l) => l.includes('domain_event_tenant_mismatch')).length, 2);

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
  // 坏事件在主事务提交后被丢弃：flush 等待者仍唤醒、afterCommit 仍发 change。
  const oldErrorAfterCommit = console.error;
  let afterCommitMismatches = 0;
  const offMismatch = events.onDomainEventMismatch(() => {
    afterCommitMismatches++;
  });
  console.error = () => {};
  try {
    const before = seen.get(b.id)!.length;
    await inScope(b, async () => {
      b.store.pgBackend!.emitAfterCommit(sameId, { type: 'conversation.changed', id: sameId, tenantId: a.id });
      b.store.pgBackend!.emitAfterCommit(sameId, { type: 'conversation.changed', id: sameId, tenantId: b.id });
      await Promise.race([
        store.flushSession(sameId),
        pause(1000).then(() => {
          throw new Error('flush 等待者未唤醒');
        }),
      ]);
    });
    assert.equal(seen.get(b.id)!.length, before + 1);
    assert.equal(afterCommitMismatches, 1);
    await pause(250);
    assert.equal(changes.get(b.id), 2);
  } finally {
    console.error = oldErrorAfterCommit;
    offMismatch();
  }
  channels.startChannels();
  const wecom = await import('../adapters/wecom.js');
  for (let i = 0; i < 100 && ![a, b].every((rt) => inScope(rt, wecom.__wecomTest.idle)); i++) await pause(10);
  for (const rt of [a, b])
    inScope(rt, () => {
      assert.ok(wecom.__wecomTest.inspect(accountIds.get(rt.id)!));
      assert.equal(wecom.__wecomTest.inspect(accountIds.get(rt === a ? b.id : a.id)!), null);
      assert.equal(wecom.__wecomTest.routeAccount(sameId), accountIds.get(rt.id));
    });
  // 同 key 的两个账号都已装载；准备的句柄仍不可跨租户消费。
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

  // B 实际走提交与发送链：默认 5 秒等待仍保持，1 秒内必须成功且 commit 已被唤醒。
  const sendId = 'wecom:wmReview';
  await inScope(b, async () => {
    const s = store.getOrCreateSession(sendId, 'wecom');
    s.messages.push({ role: 'customer', content: '测试请求', at: Date.now() });
    store.saveSession(s);
    await store.flushSession(sendId);
    const msg = { role: 'agent' as const, content: '测试回复 /pay/merge', at: Date.now() };
    assert.equal(
      await Promise.race([
        wecom.wecomAdapter.push(sendId, msg.content, { kind: 'human', message: msg }),
        pause(1000).then(() => {
          throw new Error('B 的 pending 提交未唤醒，仍在等 5 秒');
        }),
      ]),
      true,
    );
    assert.equal(ledger.__ledgerTest.rows(sendId)[0]!.commit, 'committed');
    // 人工/跟进先发，之后消息才追加；必须通过 B 的 save 钩子补上 message_seq。
    s.messages.push(msg);
    store.saveSession(s);
    await pause(0);
    await store.flushSession(sendId);
    const rows = await su<{ message_seq: number | null; status: string; tenant_id: string }>(
      'select message_seq, status, tenant_id from outbound_sends where conversation_id=$1',
      [sendId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant_id, b.id);
    assert.equal(rows[0]!.status, 'accepted');
    assert.equal(rows[0]!.message_seq, store.seqOf(msg));
    assert.notEqual(rows[0]!.message_seq, null);
  });
  assert.equal(sent.filter((body) => body.touser === 'wmReview').length, 1);
  assert.match(sent.find((body) => body.touser === 'wmReview')!.text!.content, /https:\/\/events-b\.example\.invalid\/pay\/merge/);
  let erased = false;
  ledger.__ledgerTest.setMarkHook(async (intent) => {
    if (intent.sessionId !== sendId) return;
    assert.equal(ledger.__ledgerTest.rows(sendId).find((row) => row.msgid === intent.msgid)!.commit, 'committed');
    await su('delete from outbound_sends where tenant_id=$1 and channel_msgid=$2', [b.id, intent.msgid]);
    erased = true;
  });
  const oldSendError = console.error;
  const sendErrors: string[] = [];
  console.error = (...args) => {
    sendErrors.push(args.join(' '));
  };
  try {
    await inScope(b, () => wecom.wecomAdapter.push(sendId, '清除后不应发送', { kind: 'human' }));
  } finally {
    ledger.__ledgerTest.setMarkHook(null);
    console.error = oldSendError;
  }
  assert.equal(erased, true);
  assert.equal(sent.filter((body) => body.touser === 'wmReview').length, 1);
  assert.ok(sendErrors.some((line) => line.includes('提交过又不在库里')));

  // 非宿主 env 分支要报未送达；prepare 的 quiet 查询仍不打日志。
  const envOnly = r.createTenantRuntime({ id: 'env-only', slug: 'env-only' });
  r.registerRuntime(envOnly);
  const envErrors: string[] = [];
  console.error = (...args) => {
    envErrors.push(args.join(' '));
  };
  try {
    assert.equal(
      inScope(envOnly, () => wecom.wecomAdapter.prepare!(sendId, 'test', { kind: 'human' })),
      null,
    );
    assert.equal(envErrors.length, 0);
    assert.equal(await inScope(envOnly, () => wecom.wecomAdapter.push(sendId, 'test')), false);
    assert.equal(envErrors.length, 1);
    assert.match(envErrors[0]!, /非宿主.*消息未送达/);
  } finally {
    console.error = oldSendError;
    states.dropTenantState(envOnly.id);
    r.unregisterRuntime(envOnly.id);
  }

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
