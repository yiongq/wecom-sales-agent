// 18 R3：只用一次性真实 PG，子进程隔离永久 stale 闸；企微用注入的 fetch。
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

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
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });

if (!process.env.PG_TEST_URL) {
  console.log('FAILOVER SKIP：需要一次性真实 PostgreSQL 的 PG_TEST_URL');
} else {
  process.env.CONFIG_SOURCE = 'file';
  process.env.TENANT_LOCK_WAIT = '';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-failover-'));
  process.env.VAR_DIR = path.join(root, 'parent');
  const { hostRuntime } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  enterTenantScopeForTest(hostRuntime());
  const { createRealPgFixture, fakeLock } = await import('./testing.js');
  const { openDb, holdTenantLocks, bumpProcessEpoch, fenceProcessEpoch, withTenant, rowsOf } = await import('./client.js');
  const { sql } = await import('drizzle-orm');
  const { importConfig } = await import('../config/transfer.js');
  const fx = await createRealPgFixture(process.env.PG_TEST_URL);
  const appDb = await openDb(fx.urls.app);
  const children: { process: ChildProcess; done: Promise<number | null>; events: Record<string, unknown>[]; output: () => string }[] = [];
  const port = async (): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        server.close(() => resolve(address.port));
      });
    });
  const acceptsConnection = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: p });
      const finish = (connected: boolean): void => {
        socket.destroy();
        resolve(connected);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(300, () => finish(false));
    });
  const connects = async (p: number): Promise<boolean> => {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(300) });
      return res.ok;
    } catch {
      return false;
    }
  };
  const { sealSecrets, CHANNEL_KEY_ENV } = await import('../channels/secrets.js');
  const key = randomBytes(32);
  const ring = { current: { id: 'r3', key }, all: new Map([['r3', key]]) };
  const accountId = randomUUID();
  const { ct, keyId } = sealSecrets(
    ring,
    { tenantId: fx.tenantId, accountId },
    {
      appSecret: randomBytes(16).toString('hex'),
      callbackToken: randomBytes(16).toString('hex'),
      callbackAesKey: randomBytes(32).toString('base64').slice(0, -1),
    },
  );
  const start = async (name: string, kind = 'boot', wait = true, sharedDir?: string) => {
    const p = await port();
    const dir = sharedDir ?? path.join(root, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'usage.json'), '{"sentinel":true}');
      fs.writeFileSync(path.join(dir, 'budget.json'), '{"sentinel":true}');
    }
    const url = new URL(fx.urls.app);
    url.searchParams.set('application_name', name);
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, '../adapters/wecom-failover.selftest.ts')], {
      env: {
        ...process.env,
        R3_CASE: kind,
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        TENANT_LOCK_WAIT: wait ? 'forever' : '',
        DATABASE_URL: url.toString(),
        R3_ADMIN_URL: fx.urls.super,
        DEFAULT_TENANT_SLUG: 'demo',
        PORT: String(p),
        VAR_DIR: dir,
        SERVER_SELFTEST: '',
        [CHANNEL_KEY_ENV]: `r3:${key.toString('base64')}`,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    const events: Record<string, unknown>[] = [];
    child.on('message', (event) => events.push(event as Record<string, unknown>));
    const timer = setTimeout(() => child.kill('SIGKILL'), 35_000);
    const done = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      }),
    );
    const result = { process: child, done, events, output: () => output, port: p, dir };
    children.push(result);
    return result;
  };
  try {
    const imported = await importConfig({
      db: appDb.db,
      tenantSlug: 'demo',
      dataDir: 'data',
      imageSop: fs.readFileSync('data/sop.md', 'utf8'),
      lock: async () => fakeLock(),
    });
    assert.equal(imported.code, 0, imported.message);
    await fx.query(
      `insert into channel_accounts (tenant_id,id,key,kind,name,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id)
      values ($1,$2,'r3','wecom_kf','r3','active','wecom:','fake-r3-corp','fake-r3-kf',$3,$4)`,
      [fx.tenantId, accountId, ct, keyId],
    );
    // 原生 bigint 与 FORCE RLS；B 既看不到也不能覆盖 A。
    const [other] = await fx.query<{ id: string }>(
      "insert into tenants (slug,name,pack_id) values ('r3-other','r3-other','travel') returning id",
    );
    const n = await bumpProcessEpoch(fx.tenantId, randomUUID(), appDb.db);
    assert.equal(n, 1n);
    await withTenant(appDb.db, ctx(other!.id), async (tx) => {
      const rows = await tx.execute(sql`select * from process_epochs`);
      assert.equal(rowsOf(rows).length, 0);
      const changed = await tx.execute(sql`update process_epochs set epoch=99 where tenant_id=${fx.tenantId}::uuid returning epoch`);
      assert.equal(rowsOf(changed).length, 0);
    });
    await assert.rejects(
      withTenant(appDb.db, ctx(other!.id), (tx) =>
        tx.execute(sql`insert into process_epochs values (${fx.tenantId}::uuid, 99, 'fake-holder', now())`),
      ),
    );
    // FOR SHARE 持续到写事务提交，接管不能插队。
    let release!: () => void;
    let fenced = false;
    let bumped = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = withTenant(appDb.db, ctx(fx.tenantId), async (tx) => {
      await fenceProcessEpoch(tx, n);
      fenced = true;
      await blocked;
    });
    await until(() => fenced);
    const next = bumpProcessEpoch(fx.tenantId, randomUUID(), appDb.db).then((epoch) => {
      bumped = true;
      return epoch;
    });
    await delay(80);
    assert.equal(bumped, false);
    release();
    await old;
    assert.equal(await next, n + 1n);
    console.log('FAILOVER PASS epoch 原子推进 / FOR SHARE 提交顺序 / 跨租户 RLS');
    const jobRepo = await import('./repo/jobs.js');
    await withTenant(appDb.db, ctx(fx.tenantId), async (tx) => {
      const id = await jobRepo.enqueueJob(tx, {
        kind: 'handoff_notify',
        dedupeKey: 'r3-unsent-cas',
        runAt: new Date(0),
        maxAttempts: 4,
        payload: { sessionId: 'wecom:wmJobs' },
      });
      await jobRepo.setJobStatus(tx, id!, 'pending', { attemptsDelta: 3 });
      const [old] = await jobRepo.claimDueJobs(tx, new Date(1000), 1, ['handoff_notify']);
      assert.equal((await jobRepo.recoverJobsAtStartup(tx)).otherFailed, 1);
      assert.equal(await jobRepo.requeueUnsentNotification(tx, old!), true, '晚到的未发送归还撤销启动归位的错误扣数');
      const [next] = await jobRepo.claimDueJobs(tx, new Date(2000), 1, ['handoff_notify']);
      assert.equal(next!.attempts, 3);
      assert.equal(await jobRepo.requeueUnsentNotification(tx, old!), false, '旧认领不能覆盖新主的认领');
      await jobRepo.setJobStatus(tx, id!, 'cancelled');
    });
    console.log('FAILOVER PASS 通知未发送归还 / 最后一次重试恢复 / 旧认领不能覆盖新主');
    // A 归还后 B 再认领并中断：归位必须保留 B 的令牌，A 的晚到归还不能撤销 B 的扣数。
    for (const [attempts, secondAt] of [
      [0, 2000],
      [0, 1000], // 同毫秒重新认领
      [3, 999], // 时钟回拨，且 B 的这一次已经用完重试
    ] as const) {
      await withTenant(appDb.db, ctx(fx.tenantId), async (tx) => {
        const id = await jobRepo.enqueueJob(tx, {
          kind: 'handoff_notify',
          dedupeKey: `r3-unsent-aba-${attempts}-${secondAt}`,
          runAt: new Date(0),
          maxAttempts: 4,
          payload: { sessionId: 'wecom:wmJobs' },
        });
        await jobRepo.setJobStatus(tx, id!, 'pending', { attemptsDelta: attempts });
        const [a] = await jobRepo.claimDueJobs(tx, new Date(1000), 1, ['handoff_notify']);
        assert.equal(await jobRepo.requeueUnsentNotification(tx, a!), true);
        const [b] = await jobRepo.claimDueJobs(tx, new Date(secondAt), 1, ['handoff_notify']);
        assert.ok(b!.claimedAt!.getTime() > a!.claimedAt!.getTime(), '每次通知认领的令牌必须不同');
        await jobRepo.recoverJobsAtStartup(tx);
        assert.equal(await jobRepo.requeueUnsentNotification(tx, a!), false, 'A 第二次归还不能撤销 B 的中断扣数');
        const [row] = rowsOf<{ status: string; attempts: number; claimed_at: Date }>(
          await tx.execute(sql`select status, attempts, claimed_at from jobs where id=${id}::uuid`),
        );
        assert.equal(row!.status, attempts === 3 ? 'failed' : 'pending');
        assert.equal(row!.attempts, attempts + 1, 'B 可能已发送的那次扣数必须保留');
        assert.equal(new Date(row!.claimed_at).getTime(), b!.claimedAt!.getTime());
        await jobRepo.setJobStatus(tx, id!, 'cancelled');
      });
    }
    await withTenant(appDb.db, ctx(fx.tenantId), async (tx) => {
      for (const kind of ['followup', 'retention_purge', 'ops_daily_digest'] as const) {
        const id = await jobRepo.enqueueJob(tx, {
          kind,
          dedupeKey: `r3-recovery-unchanged-${kind}`,
          runAt: new Date(0),
          maxAttempts: 4,
          payload: {},
        });
        await jobRepo.claimDueJobs(tx, new Date(1000), 1, [kind]);
        await jobRepo.recoverJobsAtStartup(tx);
        assert.deepEqual(rowsOf(await tx.execute(sql`select status, attempts, claimed_at from jobs where id=${id}::uuid`)), [
          { status: 'pending', attempts: kind === 'retention_purge' ? 1 : 0, claimed_at: null },
        ]);
        await jobRepo.setJobStatus(tx, id!, 'cancelled');
      }
    });
    console.log('FAILOVER PASS A/B 归还竞争 / 同毫秒与时钟回拨不复用令牌 / B 扣数保留 / 其他任务归位不变');

    // 等待全部锁时不留住部分锁；释放阻塞者后迅速取得整组。
    const blocker = await holdTenantLocks(fx.urls.app, [other!.id]);
    assert.ok(blocker);
    const all = holdTenantLocks(fx.urls.app, [fx.tenantId, other!.id], { waitForever: true });
    await delay(350);
    const partial = await holdTenantLocks(fx.urls.app, [fx.tenantId]);
    assert.ok(partial);
    await partial.release();
    const releaseAt = Date.now();
    await blocker.release();
    const allHeld = await all;
    assert.ok(allHeld);
    assert.ok(Date.now() - releaseAt < 1000);
    await allHeld.release();
    // 观察所有应用表的写语句；备用只能查询，不能偷偷更新配置、用量或 cursor。
    await fx.query(`create table r3_write_observer (app text);
      create function r3_observe_write() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
      begin insert into public.r3_write_observer values (current_setting('application_name')); return null; end $$;
      do $$ declare t record; begin
      for t in select tablename from pg_tables where schemaname='public' and tablename <> 'r3_write_observer' loop
        execute format('create trigger r3_write after insert or update or delete on public.%I for each statement execute function public.r3_observe_write()', t.tablename);
      end loop; end $$;`);
    const primary = await start('primary');
    await until(async () => primary.events.some((e) => e.event === 'booted') && (await connects(primary.port)));
    const before = (await fx.query<{ epoch: string }>('select epoch from process_epochs where tenant_id=$1', [fx.tenantId]))[0]!.epoch;
    const standby = await start('standby');
    await until(() => standby.events.some((e) => e.event === 'starting'));
    await delay(700);
    assert.equal(await acceptsConnection(standby.port), false);
    assert.doesNotMatch(standby.output(), /拿到.*租户锁/);
    assert.equal(
      standby.events.some((e) => ['var-before-lock', 'pull', 'booted'].includes(String(e.event))),
      false,
      standby.output(),
    );
    assert.equal(
      (await fx.query<{ epoch: string }>('select epoch from process_epochs where tenant_id=$1', [fx.tenantId]))[0]!.epoch,
      before,
    );
    assert.equal((await fx.query("select app from r3_write_observer where app='standby'")).length, 0);
    standby.process.kill('SIGTERM');
    assert.equal(await standby.done, 0, standby.output());
    assert.equal(
      standby.events.some((e) => e.event === 'shutdown-hook'),
      false,
    );
    assert.equal(fs.readFileSync(path.join(standby.dir, 'usage.json'), 'utf8'), '{"sentinel":true}');
    assert.equal(fs.readFileSync(path.join(standby.dir, 'budget.json'), 'utf8'), '{"sentinel":true}');
    const legacy = await start('legacy', 'boot', false);
    assert.equal(await legacy.done, 1, legacy.output());
    assert.match(legacy.output(), /lock_held/);
    assert.doesNotMatch(legacy.output(), /拿到.*租户锁/);
    const successor = await start('successor');
    await until(() => successor.events.some((e) => e.event === 'starting'));
    await delay(300);
    const killedAt = Date.now();
    primary.process.kill('SIGKILL');
    await primary.done;
    await until(
      async () =>
        (await fx.query<{ epoch: string }>('select epoch from process_epochs where tenant_id=$1', [fx.tenantId]))[0]!.epoch !== before,
      1000,
    );
    const acquiredMs = Date.now() - killedAt;
    await until(async () => await connects(successor.port));
    console.log(
      `FAILOVER PASS 等锁无副作用 / SIGTERM=0 / 旧模式 lock_held / kill -9 接管 ${acquiredMs}ms，服务恢复 ${Date.now() - killedAt}ms`,
    );
    // 断连接后 1 秒内停收、拒新连接；无别人接管时原 epoch 重取可恢复。
    const terminate = async () => {
      const rows = await fx.query<{ pid: number }>(
        "select distinct a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid where a.application_name='successor' and l.locktype='advisory'",
      );
      assert.equal(rows.length, 1);
      await fx.query('select pg_terminate_backend($1)', [rows[0]!.pid]);
    };
    await terminate();
    await until(async () => !(await acceptsConnection(successor.port)), 1000);
    const pulls = successor.events.filter((e) => e.event === 'pull').length;
    successor.process.send({ action: 'try-pull' });
    await until(() => successor.events.some((e) => e.event === 'pull-probed'));
    await delay(100);
    assert.equal(successor.events.filter((e) => e.event === 'pull').length, pulls);
    await until(async () => await connects(successor.port));
    await terminate();
    await until(async () => !(await acceptsConnection(successor.port)), 1000);
    const replacement = await holdTenantLocks(fx.urls.app, [fx.tenantId]);
    assert.ok(replacement);
    await bumpProcessEpoch(fx.tenantId, randomUUID(), appDb.db);
    await replacement.release();
    assert.equal(await successor.done, 1, successor.output());
    assert.equal(successor.output().match(/^\[config\] 已拿到全部租户锁（等待 \d+ ms）$/gm)?.length, 1, successor.output());
    assert.ok(successor.events.some((e) => e.event === 'shutdown-hook'));
    assert.equal(
      fs.readdirSync(successor.dir).some((name) => name.startsWith('store-spill-')),
      false,
    );
    assert.equal(successor.events.filter((e) => e.event === 'lease' && e.held === true).length, 1, '只有同 epoch 的一次重取恢复服务');
    console.log('FAILOVER PASS pg_terminate_backend 停拉取/关监听 / 同 epoch 恢复 / epoch 已变优雅退出不恢复');
    const taken = await start('taken');
    await until(async () => await connects(taken.port));
    taken.process.send({ action: 'dirty' });
    await until(() => taken.events.some((e) => e.event === 'dirty'));
    const [takenLock] = await fx.query<{ pid: number }>(
      "select distinct a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid where a.application_name='taken' and l.locktype='advisory'",
    );
    await fx.query('select pg_terminate_backend($1)', [takenLock!.pid]);
    await until(async () => !(await acceptsConnection(taken.port)), 1000);
    const otherHolder = await holdTenantLocks(fx.urls.app, [fx.tenantId]);
    assert.ok(otherHolder);
    try {
      await bumpProcessEpoch(fx.tenantId, randomUUID(), appDb.db);
      assert.equal(await taken.done, 1, taken.output());
      assert.ok(taken.events.some((e) => e.event === 'shutdown-hook'));
      assert.match(taken.output(), /丢弃 1 个未落库会话/);
      assert.deepEqual(
        taken.events.filter((e) => e.event === 'discard'),
        [{ event: 'discard', counts: [1, 1, 0] }],
      );
      const discardAlerts = taken.events.filter((e) => e.event === 'alert' && String(e.text).includes('process_epoch_stale'));
      assert.equal(discardAlerts.length, 1);
      assert.match(String(discardAlerts[0]!.text), /丢弃 1 个会话、1 条消息、0 条渠道写入/);
      assert.equal(
        fs.readdirSync(taken.dir).some((name) => name.startsWith('store-spill-')),
        false,
      );
    } finally {
      await otherHolder.release();
    }
    console.log('FAILOVER PASS held_by_other 优雅退出，不写 spill');
    const spillPrimary = await start('spill-primary', 'boot-spill');
    await until(() => spillPrimary.events.some((e) => e.event === 'booted'));
    const dirtySessions = 128;
    spillPrimary.process.send({ action: 'dirty', count: dirtySessions });
    await until(() => spillPrimary.events.some((e) => e.event === 'dirty'));
    const spillStandby = await start('spill-standby', 'boot', true, spillPrimary.dir);
    await until(() => spillStandby.events.some((e) => e.event === 'starting'));
    await delay(300);
    assert.equal(
      spillStandby.events.some((e) => e.event === 'booted'),
      false,
    );
    const stopAt = Date.now();
    spillPrimary.process.kill('SIGTERM');
    assert.equal(await spillPrimary.done, 143, spillPrimary.output());
    const stopMs = Date.now() - stopAt;
    assert.ok(stopMs < 10_000, `含最终同步 spill 的正常停机 ${stopMs}ms 必须小于 stop_grace_period 10 秒`);
    await until(() => spillStandby.events.some((e) => e.event === 'booted'));
    assert.deepEqual(
      spillPrimary.events.filter((e) => e.event === 'spill'),
      [{ event: 'spill', held: true }],
      '仍持锁时只写一次最终 spill，exit 不重复写',
    );
    assert.equal(spillStandby.events.find((e) => e.event === 'booted')!.replayed, dirtySessions, spillStandby.output());
    assert.equal(
      (await fx.query("select seq from messages where conversation_id='wecom:wmStale' and content='待丢弃的合成消息'")).length,
      1,
    );
    spillStandby.process.kill('SIGTERM');
    assert.equal(await spillStandby.done, 143, spillStandby.output());
    console.log(
      `FAILOVER PASS 正常停机 ${stopMs}ms < 10000ms，${dirtySessions} 个脏会话 / 持锁 spill / 共用 VAR_DIR 回放一次 / exit 不重复写`,
    );
    const spillFailure = await start('spill-failure', 'boot-spill-fail');
    await until(() => spillFailure.events.some((e) => e.event === 'booted'));
    spillFailure.process.send({ action: 'dirty' });
    await until(() => spillFailure.events.some((e) => e.event === 'dirty'));
    spillFailure.process.kill('SIGTERM');
    assert.equal(await spillFailure.done, 143, spillFailure.output());
    const failureAlerts = spillFailure.events.filter((e) => e.event === 'alert' && String(e.text).includes('spill_failed'));
    assert.equal(failureAlerts.length, 1, spillFailure.output());
    assert.match(String(failureAlerts[0]!.text), /1 个会话.*仍释放锁.*丢失/);
    assert.equal(
      fs.readdirSync(spillFailure.dir).some((name) => name.startsWith('store-spill-') && name.endsWith('.json')),
      false,
    );
    const afterFailure = await holdTenantLocks(fx.urls.app, [fx.tenantId]);
    assert.ok(afterFailure, 'spill 失败仍释放锁');
    await afterFailure.release();
    console.log('FAILOVER PASS spill 写失败发出一次运维告警 / 仍放锁 / exit 不重试');
    for (const kind of [
      'pause',
      'claim',
      'mark',
      'store',
      'welcome',
      'recovery',
      'retry',
      'token-retry',
      'r6',
      'r6-lost',
      'notify-pause',
      'notify-stale',
      'notify-retry',
      'reply-pause',
      'reply-stale',
      'token-pause',
      'token-initial-pause',
      'discard-alert',
      'deadline-before-send',
      'deadline-after-send',
      'poisoned-discard',
      'job-lease',
      'job-lease-recovered-first',
    ]) {
      const child = await start(kind, kind);
      assert.equal(await child.done, 0, `${kind}\n${child.output()}`);
      console.log(
        child
          .output()
          .split('\n')
          .find((line) => line.startsWith('FAILOVER PASS')),
      );
      if (kind.startsWith('job-lease')) {
        const resumed = await start(`${kind}-new`, 'job-recover');
        assert.equal(await resumed.done, 0, resumed.output());
        console.log(`FAILOVER PASS ${kind} 最后一次重试由新主恢复，执行中与排队通知各发一次`);
      }
    }
    assert.equal((await fx.query("select id from channel_accounts where cursor='r3-stale-cursor'")).length, 0);
    const claimed = await fx.query('select id from channel_inbox where msgid=$1', ['r3-claim']);
    assert.equal(claimed.length, 0);
    const badMessage = await fx.query("select seq from messages where content='不能落库'");
    assert.equal(badMessage.length, 0);
    console.log('FAILOVER PASS 入站与 cursor / sending / 会话消息全部回滚，旧进程不写 spill');
  } finally {
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
    await Promise.all(children.map((child) => child.done));
    await appDb.close();
    await fx.drop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
