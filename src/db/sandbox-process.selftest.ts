// 05 第 12 步：环境、进程锁、fail-stop、epoch fencing 与无文件停机。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { sql } from 'drizzle-orm';
import { openDb, withNewSandboxTenant, withSandboxEpoch } from './client.js';
import { createRealPgFixture, fakeLock, openTestDb } from './testing.js';
import { importConfig } from '../config/transfer.js';
import { acquireSandboxProcess, advanceSandboxEpoch, systemContext, withSandboxTenant } from './sandbox-process.js';
import { CHANNEL_KEY_ENV } from '../channels/secrets.js';
import { resolveRole, sandboxFlags, SANDBOX_WECOM_NAMES } from '../tenancy/sandbox/role.js';
import { DEMO_DEFAULTS } from '../profile.js';

const base = {
  APP_ROLE: 'sandbox',
  DEPLOY_PROFILE: 'demo',
  CONFIG_SOURCE: 'db',
  SESSION_STORE: 'db',
  SANDBOX_HOST: 'sandbox.example.invalid',
  SANDBOX_TEMPLATE_SLUG: 'template',
};
assert.equal(resolveRole({}), 'host');
assert.equal(resolveRole(base), 'sandbox');
assert.throws(() => resolveRole({ APP_ROLE: 'unknown' }), /app_role_invalid/);
for (const key of [
  'WECOM_FUTURE',
  CHANNEL_KEY_ENV,
  'NOTIFY_WEBHOOK_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'LLM_HEDGE_MODEL',
  'DEFAULT_TENANT_SLUG',
]) {
  for (const value of ['', 'fixture']) assert.throws(() => resolveRole({ ...base, [key]: value }), /sandbox_env_forbidden/);
}
for (const key of ['DEPLOY_PROFILE', 'CONFIG_SOURCE', 'SESSION_STORE', 'SANDBOX_HOST', 'SANDBOX_TEMPLATE_SLUG'])
  assert.throws(() => resolveRole({ ...base, [key]: '' }), /env_invalid/);
assert.throws(() => resolveRole({ ...base, DEPLOY_PROFILE: 'prod' }), /env_invalid/);
assert.throws(() => resolveRole({ ...base, SANDBOX_HOST: 'https://sandbox.example.invalid' }), /env_invalid/);
const credentials = Object.fromEntries(SANDBOX_WECOM_NAMES.map((key) => [key, 'fixture']));
assert.equal(resolveRole({ ...base, ...credentials }), 'sandbox');
for (const key of SANDBOX_WECOM_NAMES) {
  assert.throws(() => resolveRole({ ...base, [key]: 'fixture' }), /sandbox_wecom_partial/);
  assert.throws(() => resolveRole({ [key]: '' }), /sandbox_env_forbidden/);
  assert.throws(() => resolveRole({ ...base, ...credentials, [key]: undefined }), /sandbox_wecom_partial/);
}
const flags = sandboxFlags(DEMO_DEFAULTS);
for (const key of ['anon_readonly_admin', 'seed_freshen', 'legacy_admin_writes', 'web_channel'] as const) assert.equal(flags[key], false);
assert.equal(flags.reset_command, true);
assert.equal(flags.mock_pay, true);
assert.equal(flags.ai_disclosure, 'always');
console.log('sandbox-process: 环境拒绝、体验客服变量三种拒绝与强制开关通过');

const lite = await openTestDb();
try {
  await lite.pg.exec('SET ROLE agent_app');
  const epoch = await advanceSandboxEpoch(lite.db);
  await withSandboxEpoch(lite.db, epoch, async (tx) => {
    await tx.execute(sql`insert into sandbox_wecom_state (open_kfid, cursor) values ('kf-test', 'current')`);
  });
  await assert.rejects(
    () =>
      withSandboxEpoch(lite.db, '0', async (tx) => {
        await tx.execute(sql`update sandbox_wecom_state set cursor = 'stale'`);
      }),
    /sandbox_epoch_stale/,
  );
  assert.equal((await lite.pg.query<{ cursor: string }>('select cursor from sandbox_wecom_state')).rows[0]?.cursor, 'current');
} finally {
  await lite.close();
}
console.log('sandbox-process: PGlite 当前 epoch 提交、旧 epoch 回滚通过');

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error('sandbox-process: 等待超时');
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-process-'));
type Child = { child: ReturnType<typeof spawn>; ended: Promise<number | null>; output(): string };
const children: Child[] = [];
function run(env: NodeJS.ProcessEnv, script?: string): Child {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      key.startsWith('WECOM_') ||
      key.startsWith('SANDBOX_WECOM_') ||
      [
        CHANNEL_KEY_ENV,
        'NOTIFY_WEBHOOK_URL',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'LLM_HEDGE_MODEL',
        'DEFAULT_TENANT_SLUG',
        'SERVER_SELFTEST',
        'DATABASE_OWNER_URL',
        'DATABASE_PLATFORM_URL',
        'POSTGRES_PASSWORD',
      ].includes(key) ||
      /^AGENT_[A-Z0-9_]+_PASSWORD$/.test(key)
    )
      delete inherited[key];
  }
  const child = spawn(process.execPath, ['--import', 'tsx', ...(script ? ['--input-type=module', '--eval', script] : ['src/server.ts'])], {
    env: { ...inherited, ...base, TENANCY_STRICT: '0', LLM_MOCK: '1', VAR_DIR: directory, ALERT_WEBHOOK_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
  });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const result = { child, ended, output: () => output };
  children.push(result);
  return result;
}
async function exitCode(child: ReturnType<typeof run>, timeout = 15_000): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      child.ended,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('sandbox-process: 子进程未退出')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function health(port: number, host = base.SANDBOX_HOST) {
  return fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host }, signal: AbortSignal.timeout(1000) });
}

try {
  for (const env of [
    { DEPLOY_PROFILE: 'prod' },
    { SANDBOX_HOST: '' },
    { SANDBOX_TEMPLATE_SLUG: '' },
    { DEFAULT_TENANT_SLUG: 'template' },
    { SANDBOX_WECOM_TOKEN: 'fixture' },
    { APP_ROLE: 'host', SANDBOX_WECOM_TOKEN: 'fixture' },
  ]) {
    const child = run(env);
    assert.equal(await exitCode(child), 1, '非法角色环境在连接数据库前退出');
    assert.match(child.output(), /env_invalid|sandbox_env_forbidden|sandbox_wecom_partial/);
    assert.doesNotMatch(child.output(), /已启动|装载沙箱/);
  }
  if (!process.env.PG_TEST_URL) {
    console.log('sandbox-process: 未设 PG_TEST_URL，真实 PG 抢锁 / fail-stop / fencing 两种先后跳过');
  } else {
    const fixture = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    const app = await openDb(fixture.urls.app);
    const next = await openDb(fixture.urls.app);
    let held: Awaited<ReturnType<typeof acquireSandboxProcess>> | null = null;
    try {
      const [standard] = await fixture.query<{ id: string }>(
        "insert into tenants (slug,name,pack_id) values ('other-standard','测试','travel') returning id",
      );
      await fixture.query(
        `insert into channel_accounts (tenant_id,key,kind,name,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id)
        values ($1,'kf-test','wecom_kf','测试','wecom:','corp-test','kf-conflict',$2,'test')`,
        [standard!.id, randomBytes(32)],
      );
      const conflict = run({ DATABASE_URL: fixture.urls.app, ...credentials, SANDBOX_WECOM_OPEN_KFID: 'kf-conflict' });
      assert.equal(await exitCode(conflict), 1);
      assert.match(conflict.output(), /sandbox_wecom_conflict/);
      assert.equal((await fixture.query<{ epoch: string }>('select epoch::text as epoch from sandbox_process_epoch'))[0]!.epoch, '0');
      const port = await freePort();
      const first = run({ DATABASE_URL: fixture.urls.app, PORT: String(port) });
      await until(() => first.output().includes('沙箱已启动'));
      const zero = await (await health(port, 'unknown.example.invalid')).json();
      assert.equal(zero.role, 'sandbox');
      assert.equal(zero.ok, true);
      assert.equal(zero.sandboxes, 0);
      assert.equal(zero.llmGate.maxInflight, 2);
      assert.deepEqual(zero.wecom, { configured: false, full: false, bound: 0, lastSyncOkAt: null, failing: false });
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/console/assets/missing.js`, {
            headers: { host: 'unknown.example.invalid', 'x-forwarded-host': base.SANDBOX_HOST },
            signal: AbortSignal.timeout(1000),
          })
        ).status,
        404,
      );
      first.child.kill('SIGTERM');
      assert.equal(await exitCode(first), 143);

      const created = await withNewSandboxTenant(
        app.db,
        {
          slug: 'sbx-process-test',
          templateTenantId: fixture.tenantId,
          brand: null,
          tokenHash: randomBytes(32),
          ip: null,
          userAgent: null,
        },
        async (_tx, row) => row,
      );
      const imported = await importConfig({
        db: app.db,
        tenantSlug: 'sbx-process-test',
        dataDir: 'data',
        imageSop: fs.readFileSync('data/sop.md', 'utf8'),
        lock: async () => fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      const snapshot = await fixture.query("select id, expires_at from tenants where kind = 'sandbox'");
      const live = run({ DATABASE_URL: fixture.urls.app, PORT: String(port) });
      await until(() => live.output().includes('沙箱已启动'));
      assert.equal((await (await health(port)).json()).sandboxes, 1);
      assert.match(live.output(), /anon_readonly_admin=off.*seed_freshen=off/);

      const began = Date.now();
      const second = run({ DATABASE_URL: fixture.urls.app, PORT: String(await freePort()) });
      assert.equal(await exitCode(second, 34_000), 1);
      assert.ok(Date.now() - began < 32_000, '竞争进程在 30 秒锁等待后退出');
      assert.match(second.output(), /sandbox_already_running/);
      assert.doesNotMatch(second.output(), /装载沙箱|沙箱已启动/);
      assert.deepEqual(await fixture.query("select id, expires_at from tenants where kind = 'sandbox'"), snapshot);
      const before = (await fixture.query<{ epoch: string }>('select epoch::text as epoch from sandbox_process_epoch'))[0]!.epoch;
      const locks = await fixture.query<{ pid: number; n: number }>(`
        select pid, count(*)::int as n from pg_locks where locktype='advisory' and granted group by pid`);
      assert.equal(locks.length, 1);
      assert.equal(locks[0]!.n, 2, '进程锁与一个租户锁共用一条连接');
      await fixture.query('select pg_terminate_backend($1)', [locks[0]!.pid]);
      assert.equal(await exitCode(live), 1);
      assert.match(live.output(), /sandbox_process_lock_lost/);
      assert.doesNotMatch(live.output(), /\[shutdown\]|重取/);
      const successor = run({ DATABASE_URL: fixture.urls.app, PORT: String(port) });
      await until(() => successor.output().includes('沙箱已启动'));
      const after = (await fixture.query<{ epoch: string }>('select epoch::text as epoch from sandbox_process_epoch'))[0]!.epoch;
      assert.equal(BigInt(after), BigInt(before) + 1n);
      successor.child.kill('SIGTERM');
      assert.equal(await exitCode(successor), 143);
      console.log('sandbox-process: 真实 PG 0/1 沙箱启动、第二进程拒绝、杀锁 fail-stop、接手 epoch 加一通过');

      held = await acquireSandboxProcess(fixture.urls.app, () => {});
      const oldEpoch = await advanceSandboxEpoch(app.db);
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const oldWrite = withSandboxTenant(app.db, systemContext(created.tenantId), oldEpoch, async (tx) => {
        entered = true;
        await gate;
        await tx.execute(sql`insert into sandbox_wecom_state (open_kfid, cursor) values ('kf-fence', 'old-committed')`);
      });
      await until(() => entered);
      await held.release();
      held = await acquireSandboxProcess(fixture.urls.app, () => {});
      let advanced = false;
      const update = advanceSandboxEpoch(next.db).then((epoch) => {
        advanced = true;
        return epoch;
      });
      try {
        await until(
          async () =>
            (
              await fixture.query<{ n: number }>(
                "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='transactionid'",
              )
            )[0]!.n > 0,
        );
        assert.equal(advanced, false, '旧 FOR SHARE 事务持锁时新 epoch 等待');
      } finally {
        release();
      }
      await oldWrite;
      const newEpoch = await update;
      assert.equal(
        (await fixture.query<{ cursor: string }>("select cursor from sandbox_wecom_state where open_kfid='kf-fence'"))[0]!.cursor,
        'old-committed',
      );
      await assert.rejects(
        () =>
          withSandboxTenant(app.db, systemContext(created.tenantId), oldEpoch, async (tx) => {
            await tx.execute(sql`update sandbox_wecom_state set cursor = 'stale' where open_kfid = 'kf-fence'`);
          }),
        /sandbox_epoch_stale/,
      );
      await withSandboxEpoch(next.db, newEpoch, async (tx) => {
        await tx.execute(sql`select 1`);
      });
      await held.release();
      held = null;
      console.log('sandbox-process: 真实 PG 旧事务先持 SHARE 可提交、新 epoch 先加时旧事务回滚，两种先后通过');

      // 持租户锁的第三方不会使活着的沙箱被标到期。
      const other = await import('./client.js').then(({ holdTenantLock }) => holdTenantLock(fixture.urls.app, created.tenantId));
      assert.ok(other);
      try {
        const skip = run({ DATABASE_URL: fixture.urls.app, PORT: String(port) });
        await until(() => skip.output().includes('沙箱已启动'));
        assert.equal((await (await health(port)).json()).sandboxes, 0);
        assert.match(skip.output(), /sandbox_tenant_lock_held/);
        assert.deepEqual(await fixture.query("select id, expires_at from tenants where kind = 'sandbox'"), snapshot);
        skip.child.kill('SIGTERM');
        await exitCode(skip);
      } finally {
        await other.release();
      }

      const shutdown = run(
        { DATABASE_URL: fixture.urls.app, PORT: String(port) },
        `
        const { app } = await import('./src/server.ts');
        const { tenantRuntimes, withTenantScope, currentRuntime, TenantScopeMissing, backgroundEntry } = await import('./src/tenancy/runtime.ts');
        const { getOrCreateSession, saveSession } = await import('./src/store.ts');
        try { currentRuntime(); throw new Error('strict_missing'); } catch (e) { if (!(e instanceof TenantScopeMissing)) throw e; }
        backgroundEntry(() => currentRuntime());
        const health = await app.request('http://' + process.env.SANDBOX_HOST + '/healthz', {headers:{host:process.env.SANDBOX_HOST}});
        const hasRequestId = health.headers.has('x-request-id');
        const summary = await health.json();
        if (summary.scopeMissing !== 1 || !hasRequestId) throw new Error('scope_observation_missing:' + health.status + ':' + summary.scopeMissing + ':' + hasRequestId);
        withTenantScope(tenantRuntimes()[0], () => {
          const rt = currentRuntime(); rt.store.pgBackend.close();
          const session = getOrCreateSession('sbx-0123456789abcdef01234567', 'simulator');
          session.messages.push({role:'user', content:'未落库', at:Date.now()}); saveSession(session);
        });
        process.emit('SIGTERM');
      `,
      );
      assert.equal(await exitCode(shutdown), 143, shutdown.output());
      assert.match(shutdown.output(), /停机丢弃未落库会话 1/);
      assert.match(shutdown.output(), /后台入口缺少租户作用域/);
      assert.deepEqual(fs.readdirSync(directory), [], '启动、正常停机与 fail-stop 均没有 var 文件');

      // 停止闸允许回滚，但拒绝新借连接及 drizzle 自动发送的 COMMIT。
      const guarded = run(
        { DATABASE_URL: fixture.urls.app },
        `
        const { openDb, withTenant } = await import('./src/db/client.ts');
        const { gatedFetch } = await import('./src/llm-gate.ts');
        const { createTenantRuntime, withTenantScope } = await import('./src/tenancy/runtime.ts');
        const stopped = e => { for (let x=e; x; x=x.cause) if (String(x).includes('sandbox_process_stopped')) return true; return false; };
        const { SandboxProcess, sandboxApp } = await import('./src/tenancy/sandbox/process.ts');
        let exited = 0;
        const sandbox = new SandboxProcess(process.env, code => { exited = code; });
        const http = sandboxApp(sandbox, process.env.SANDBOX_HOST);
        const opened = await openDb(process.env.DATABASE_URL);
        try {
          try { await opened.db.transaction(async tx => { await tx.execute('select 1'); sandbox.failStop(); }); throw new Error('commit_allowed'); }
          catch (e) { if (!stopped(e)) throw e; }
          try { await withTenant(opened.db, {tenantId:'${created.tenantId}',actor:{kind:'system',userId:null,name:null,ip:null}}, async()=>{}); throw new Error('acquire_allowed'); }
          catch (e) { if (!stopped(e)) throw e; }
          if (exited !== 1) throw new Error('fail_stop_exit_missing');
          for (const target of ['/healthz', '/api/console/me', '/unknown']) {
            if ((await http.request('http://unknown.example.invalid' + target)).status !== 503) throw new Error('fail_stop_http_allowed');
          }
          try { await opened.db.transaction(async () => {}); throw new Error('root_acquire_allowed'); }
          catch (e) { if (!stopped(e)) throw e; }
          let modelRequests = 0;
          globalThis.fetch = async () => { modelRequests++; return new Response('{}'); };
          const runtime = createTenantRuntime({id:'stopped-model',slug:'stopped-model',kind:'sandbox'});
          try { await withTenantScope(runtime, () => gatedFetch('http://model.example.invalid', {}, () => new AbortController().signal)); throw new Error('model_request_allowed'); }
          catch (e) { if (!stopped(e)) throw e; }
          if (modelRequests !== 0) throw new Error('stopped_model_request_sent');
          console.log('guarded-commit-ok');
        } finally { await opened.close(); }
      `,
      );
      assert.equal(await exitCode(guarded), 0, guarded.output());
      assert.match(guarded.output(), /guarded-commit-ok/);
      console.log(
        'sandbox-process: 严格模式、租户锁冲突不改到期、停机丢弃计数、var 无文件与停止后 HTTP 503 / 拒绝模型请求、借连接和 COMMIT 通过',
      );
    } finally {
      await held?.release();
      for (const child of children)
        if (child.child.exitCode === null && child.child.signalCode === null) {
          child.child.kill('SIGKILL');
          await child.ended;
        }
      await Promise.all([app.close(), next.close()]);
      await fixture.drop();
    }
  }
} finally {
  for (const child of children)
    if (child.child.exitCode === null && child.child.signalCode === null) {
      child.child.kill('SIGKILL');
      await child.ended;
    }
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('sandbox-process selftest: 全部通过');
