// 14 R8：同一套行为覆盖 PGlite 与真实 PG 子进程；验收 9 只验证命令写库与运行时轮询。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../db/client.js';
import { createRealPgFixture, openTestDb, testConfigDeps, fakeLock } from '../db/testing.js';
import { runTenantBudget } from './tenant-budget.js';
import { AUDIT_ACTIONS } from '../shared/ui-labels.js';

fs.mkdirSync('var', { recursive: true });
const directory = fs.mkdtempSync(path.resolve('var/tenant-budget-'));
process.env.VAR_DIR = directory;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
type Run = (args: string[], app?: boolean) => Promise<{ code: number; output: string }>;
const exec = promisify(execFile);

async function suite(query: Query, run: Run, label: string): Promise<void> {
  const [tenant] = await query<{ id: string }>(
    "insert into tenants(slug,name,pack_id) values ('budget-a','合成租户','travel') returning id",
  );
  await query("insert into tenants(slug,name,pack_id) values ('budget-b','合成租户','travel')");
  await query(
    "insert into tenants(slug,name,pack_id,kind,template_tenant_id,expires_at) values ('sbx-budget','合成沙箱','travel','sandbox',$1,now()+interval '1 day')",
    [tenant.id],
  );
  const date = new Date();
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  await query(
    `insert into usage_daily(tenant_id,day,model,purpose,calls) values
     ($1,$2::date,'-','reply',3),($1,$2::date,'synthetic','chat',99),
     ($1,$2::date-interval '1 day','-','reply',777),
     ($1,$2::date+interval '1 month','-','reply',888)`,
    [tenant.id, `${month}-01`],
  );
  const call = async (args: string[], code = 0, slug = 'budget-a', app = false) => {
    const r = await run([...args, '--tenant', slug], app);
    assert.equal(r.code, code, r.output);
    return r.output.trim();
  };
  const state = async () =>
    (await query('select status,monthly_reply_quota,llm_daily_cap_milli,llm_daily_alert_milli from tenants where id=$1', [tenant.id]))[0];
  const audit = () =>
    query<{ action: string; diff: unknown; actor_kind: string; actor_name: string; target_type: string; target_id: string }>(
      'select action,diff,actor_kind,actor_name,target_type,target_id from audit_log where tenant_id=$1 order by id',
      [tenant.id],
    );
  assert.deepEqual(JSON.parse(await call(['show'])), { status: 'active', monthlyQuota: null, dailyCapMilli: null, monthlyUsed: 3 });
  assert.equal((await audit()).length, 0, 'show 不写审计');
  for (const [command, flag, field, action] of [
    ['quota', '--replies', 'monthly_reply_quota', 'tenant.quota_update'],
    ['cap', '--milli', 'llm_daily_cap_milli', 'tenant.cap_update'],
  ]) {
    for (const raw of ['', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 1', '9007199254740992']) await call([command, flag, raw], 1);
    await call([command], 1);
    await call([command, flag, '1', '--clear'], 1);
    for (const n of ['0', '123']) assert.match(await call([command, flag, n]), /30 秒内生效/);
    const shown = JSON.parse(await call(['show']));
    assert.equal(shown[command === 'quota' ? 'monthlyQuota' : 'dailyCapMilli'], 123);
    await call([command, '--clear']);
    assert.equal((await state())![field], null);
    const rows = (await audit()).filter((r) => r.action === action);
    assert.equal(rows.length, 3);
    for (const row of rows)
      assert.deepEqual(row, {
        action,
        diff: { fields: [field] },
        actor_kind: 'platform',
        actor_name: 'tenant-budget',
        target_type: 'tenant',
        target_id: tenant.id,
      });
    assert.equal(AUDIT_ACTIONS[action]?.group, 'platform');
  }
  await call(['cap', '--milli', String(Number.MAX_SAFE_INTEGER)]);
  assert.equal(Number((await state())!.llm_daily_cap_milli), Number.MAX_SAFE_INTEGER);
  await call(['cap', '--clear']);
  for (const status of ['suspended', 'trial', 'active']) {
    assert.match(await call(['status', '--set', status]), /30 秒内生效/);
    assert.equal(JSON.parse(await call(['show'])).status, status);
  }
  const statusRows = (await audit()).filter((r) => r.action === 'tenant.status_update');
  assert.equal(statusRows.length, 3);
  for (const row of statusRows) assert.deepEqual(row.diff, { fields: ['status'] });
  assert.equal(AUDIT_ACTIONS['tenant.status_update']?.group, 'platform');
  for (const args of [
    ['status'],
    ['status', '--set', 'deleted'],
    ['show', '--clear'],
    ['cap', '--replies', '1'],
    ['quota', '--milli', '1'],
  ])
    await call(args, 1);
  assert.equal(await call(['set', '--milli', '0']), '[tenant-budget] 已更新，下次启动生效');
  assert.equal(Number((await state())!.llm_daily_alert_milli), 0);
  assert.equal(await call(['clear']), '[tenant-budget] 已更新，下次启动生效');
  const before = await state();
  const logs = await audit();
  for (const args of [
    ['show'],
    ['quota', '--replies', '0'],
    ['quota', '--clear'],
    ['cap', '--milli', '0'],
    ['cap', '--clear'],
    ['status', '--set', 'active'],
    ['set', '--milli', '0'],
    ['clear'],
  ]) {
    await call(args, 1, 'sbx-budget');
    await call(args, 1, 'missing');
  }
  for (const args of [
    ['quota', '--replies', '1'],
    ['cap', '--milli', '1'],
    ['status', '--set', 'suspended'],
  ])
    await call(args, 1, 'budget-a', true);
  await query('revoke insert on audit_log from agent_platform');
  try {
    for (const args of [
      ['quota', '--replies', '5'],
      ['cap', '--milli', '6'],
      ['status', '--set', 'suspended'],
    ])
      await call(args, 1);
  } finally {
    await query('grant insert on audit_log to agent_platform');
  }
  assert.deepEqual(await state(), before, '审计失败须原子回滚三个字段');
  assert.deepEqual(await audit(), logs);
  assert.equal((await query('select * from audit_log where tenant_id <> $1', [tenant.id])).length, 0);
  assert.equal((await query("select monthly_reply_quota from tenants where slug='budget-b'"))[0]!.monthly_reply_quota, null);
  console.log(`TENANT BUDGET ${label} PASS: 六个子命令、NULL/0/安全整数、字段名审计、回滚、沙箱/权限拒绝、租户隔离`);
}

try {
  const t = await openTestDb();
  try {
    const query: Query = async <T>(sql: string, params?: unknown[]) => {
      await t.pg.exec('RESET ROLE');
      return (await t.pg.query<T>(sql, params)).rows;
    };
    await suite(
      query,
      async (args, app) => {
        const lines: string[] = [];
        const log = console.log,
          error = console.error;
        console.log = console.error = (...items) => {
          lines.push(items.join(' '));
        };
        try {
          const code = await runTenantBudget(args, {
            connect: async () => {
              await t.pg.exec(`SET ROLE ${app ? 'agent_app' : 'agent_platform'}`);
              return {
                db: t.db,
                close: async () => {
                  await t.pg.exec('RESET ROLE');
                },
              };
            },
          });
          return { code, output: lines.join('\n') };
        } finally {
          console.log = log;
          console.error = error;
        }
      },
      'PGlite',
    );
  } finally {
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL);
    const run: Run = async (args, app) => {
      try {
        const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/tenant-budget.ts', ...args], {
          env: { ...process.env, DATABASE_PLATFORM_URL: app ? fx.urls.app : fx.urls.platform },
          timeout: 15_000,
        });
        return { code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        assert.equal(typeof e.code, 'number', '子进程必须正常退出，不得超时');
        return { code: e.code, output: e.stdout + e.stderr };
      }
    };
    let app: Awaited<ReturnType<typeof openDb>> | undefined;
    try {
      await suite(fx.query, run, '真实 PG 子进程');
      await run(['quota', '--tenant', 'budget-a', '--replies', '0']);
      app = await openDb(fx.urls.app);
      await pollingAcceptance(app.db, run);
    } finally {
      await app?.close();
      await fx.drop();
    }
  } else console.log('TENANT BUDGET：未设 PG_TEST_URL，子进程与验收 9 待补跑');
  console.log('TENANT BUDGET SELFTEST PASS');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

async function pollingAcceptance(db: Db, run: Run): Promise<void> {
  const r = await import('../tenancy/runtime.js');
  const limits = await import('../tenancy/limits.js');
  const store = await import('../store.js');
  const { importConfig } = await import('../config/transfer.js');
  const { initConfig } = await import('../config/source.js');
  const { dropTenantState } = await import('../tenancy/state.js');
  const { runShutdownHooks } = await import('../shutdown.js');
  const rt = r.createTenantRuntime({ id: 'budget-a', slug: 'budget-a' });
  r.registerRuntime(rt);
  try {
    await r.withTenantScope(rt, async () => {
      const deps = testConfigDeps({ db }, { tenantSlug: rt.slug });
      const imported = await importConfig({
        db,
        tenantSlug: rt.slug,
        dataDir: 'data',
        imageSop: deps.imageSop,
        lock: async () => fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await initConfig(deps);
      await store.initSessionStore({ db, tenantId: rt.id, tenantSlug: rt.slug, varDir: directory });
      assert.equal(limits.limitVerdict(), 'quota');
      const result = await run(['quota', '--tenant', rt.slug, '--replies', '10']);
      assert.equal(result.code, 0, result.output);
      const at = Date.now();
      assert.equal(limits.limitVerdict(), 'quota', '写库后不自行刷新，等待生产定时器');
      while (limits.limitVerdict() === 'quota' && Date.now() - at < 31_000) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(limits.limitVerdict(), 'ok');
      assert.equal(limits.getTenantLimits()!.monthlyQuota, 10);
      assert.ok(Date.now() - at <= 30_000, '30 秒内由真实轮询生效');
      console.log('14 验收 9 本机 PASS: CLI quota 写库后，生产 30 秒定时器读到 10，quota → ok；全程无重启');
    });
  } finally {
    limits.stopTenantLimits();
    await rt.store.pgBackend?.close();
    rt.state = 'closed';
    dropTenantState(rt.id);
    r.unregisterRuntime(rt.id);
    await runShutdownHooks();
  }
}
