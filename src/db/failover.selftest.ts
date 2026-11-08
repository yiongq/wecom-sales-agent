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
  const start = async (name: string, kind = 'boot', wait = true) => {
    const p = await port();
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'usage.json'), '{"sentinel":true}');
    fs.writeFileSync(path.join(dir, 'budget.json'), '{"sentinel":true}');
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
      assert.equal(
        fs.readdirSync(taken.dir).some((name) => name.startsWith('store-spill-')),
        false,
      );
    } finally {
      await otherHolder.release();
    }
    console.log('FAILOVER PASS held_by_other 优雅退出，不写 spill');
    for (const kind of ['pause', 'claim', 'mark', 'store', 'welcome', 'recovery', 'retry', 'token-retry', 'r6', 'r6-lost']) {
      const child = await start(kind, kind);
      assert.equal(await child.done, 0, `${kind}\n${child.output()}`);
      console.log(
        child
          .output()
          .split('\n')
          .find((line) => line.startsWith('FAILOVER PASS')),
      );
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
