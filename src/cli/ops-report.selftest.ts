import '../selftest-env.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { opsFixture } from '../ops/digest.selftest.js';
import { runOpsReport } from './ops-report.js';
import { openDb } from '../db/client.js';
import { AUDIT_ACTIONS } from '../shared/ui-labels.js';

async function suite(real: boolean) {
  process.env.TZ = 'Asia/Shanghai';
  const fx = await opsFixture(real);
  const platform = real ? await openDb(fx.urls!.platform) : null;
  const now = Date.parse('2026-11-01T12:00:00+08:00');
  let connects = 0;
  const run = (argv: string[], app = false) =>
    runOpsReport(argv, {
      now,
      connect: async () => {
        connects++;
        return { db: app ? fx.db : (platform?.db ?? fx.db), close: async () => {} };
      },
    });
  const call = (cmd: string, extra: string[] = [], app = false) => run([cmd, '--tenant', 'demo', ...extra], app);
  const retry = ['--day', '2026-10-31', '--ack-duplicate-risk'];
  const row = async () => (await fx.query('select * from ops_daily_reports where tenant_id=$1', [fx.host.id]))[0]!;
  try {
    for (const args of [
      [],
      ['retry'],
      ['retry', '--tenant', 'demo', '--day', '2026-10-31'],
      ['retry', '--tenant', 'demo', '--day', '2026-10-30', '--ack-duplicate-risk'],
      ['retry', '--tenant', 'demo', '--day', '2026-02-30', '--ack-duplicate-risk'],
    ])
      assert.equal(await run(args), 1);
    assert.equal(connects, 0, '先校验确认与日期，不连接数据库');
    await fx.query("insert into ops_daily_reports(tenant_id,day,status,attempts) values($1,'2026-10-31','unknown',2)", [fx.host.id]);
    const id = (await row()).report_id;
    if (!real) await fx.setRole('agent_platform');
    // PGlite 的测试根连接为超级用户；真实 PG 才证明平台/应用的 SQL 权限差异。
    assert.equal(await call('retry', retry), 0);
    assert.equal((await row()).report_id, id);
    assert.equal((await row()).status, 'pending');
    assert.equal((await row()).attempts, 0);
    assert.equal((await row()).resend_count, 1);
    assert.equal(await call('retry', retry), 1, 'pending 不可重发');
    await fx.query("update ops_daily_reports set status='failed' where tenant_id=$1", [fx.host.id]);
    assert.equal(await call('retry', retry), 0, 'failed 可受控重发');
    assert.equal((await row()).resend_count, 2);
    await fx.query("update ops_daily_reports set status='sending',claim_token=gen_random_uuid() where tenant_id=$1", [fx.host.id]);
    assert.equal(await call('prepare-rollback'), 0);
    assert.equal((await row()).status, 'unknown');
    const jobs = await fx.query("select status from jobs where tenant_id=$1 and kind='ops_daily_digest'", [fx.host.id]);
    assert.ok(jobs.length > 0 && jobs.every((r) => r.status === 'cancelled'));
    const audits = await fx.query("select action,diff,actor_kind from audit_log where action like 'ops_report.%' order by id");
    assert.deepEqual(
      audits.map((r) => r.action),
      ['ops_report.retry', 'ops_report.retry', 'ops_report.prepare_rollback'],
    );
    for (const r of audits) {
      assert.equal(r.actor_kind, 'platform');
      assert.ok(!JSON.stringify(r.diff).includes('snapshot'));
      assert.equal(AUDIT_ACTIONS[String(r.action)]?.group, 'platform');
    }
    if (real) {
      assert.equal(await call('retry', retry, true), 1, 'agent_app 无 EXECUTE 权限');
      assert.equal(await call('prepare-rollback', [], true), 1);
      assert.equal((await row()).status, 'unknown');
    }
    console.log(
      `${real ? 'PG' : 'PGlite'} OPS CLI PASS：确认、部署时区昨日、unknown/failed、身份不变、次数、无正文审计、回滚${real ? '、SQL 最小权限' : ''}`,
    );
  } finally {
    await fx.setRole('agent_app');
    await platform?.close();
    await fx.close();
  }
}
const SELF = fileURLToPath(import.meta.url);
if (process.env.OPS_REPORT_TEST) await suite(process.env.OPS_REPORT_TEST === 'pg');
else
  for (const mode of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
      env: { ...process.env, OPS_REPORT_TEST: mode },
      encoding: 'utf8',
      timeout: 120_000,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, result.error?.message);
  }
