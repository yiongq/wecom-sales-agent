import '../selftest-env.js';
// 17 自测共用真实配置、存储、作用域；不替代 runner、账本或网络。
import fs from 'node:fs';
import path from 'node:path';
import { openDb, withTenant, type Db, type Tx } from '../db/client.js';
import { createRealPgFixture, openTestDb, testConfigDeps, fakeLock } from '../db/testing.js';
import { initConfig, closeConfig } from '../config/source.js';
import { importConfig } from '../config/transfer.js';
import { initSessionStore, runShutdownHooks } from '../store.js';
import {
  hostRuntime,
  withTenantScope,
  withoutTenantScope,
  registerRuntime,
  createTenantRuntime,
  unregisterRuntime,
} from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

export async function opsFixture(real = false) {
  fs.mkdirSync('var', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('var/ops-test-'));
  process.env.VAR_DIR = directory;
  process.env.SERVER_SELFTEST = '1';
  process.env.ALERT_WEBHOOK_URL = '';
  process.env.OPS_DIGEST_TENANTS = '';
  process.env.OPS_LATENCY_TENANTS = '';
  const host = hostRuntime();
  enterTenantScopeForTest(host);
  let db: Db;
  let query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  let close: () => Promise<void>;
  let setRole = async (_role: 'agent_app' | 'agent_platform') => {};
  let urls: { app: string; super: string; platform: string } | undefined;
  if (real) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL!);
    urls = fx.urls;
    const app = await openDb(fx.urls.app);
    db = app.db;
    query = (text, params) => fx.query(text, params);
    close = async () => {
      await app.close();
      await fx.drop();
    };
  } else {
    const fx = await openTestDb();
    db = fx.db;
    setRole = async (role) => {
      await fx.pg.exec(`set role ${role}`);
    };
    await fx.pg.exec("insert into tenants(slug,name,pack_id) values('demo','合成','travel')");
    query = (text, params = []) =>
      fx.pg.transaction(async (tx) => {
        await tx.exec('set local role none');
        return (await tx.query<Record<string, unknown>>(text, params)).rows;
      });
    close = () => fx.close();
  }
  const id = String((await query("insert into tenants(slug,name,pack_id) values('ops-other','合成','travel') returning id"))[0]!.id);
  const other = createTenantRuntime({ id, slug: 'ops-other' });
  registerRuntime(other);
  await setRole('agent_app');
  const owners = [host, other];
  for (const rt of owners)
    await withTenantScope(rt, async () => {
      const slug = rt === host ? 'demo' : rt.slug;
      const deps = testConfigDeps({ db }, { tenantSlug: slug });
      const imported = await importConfig({
        db,
        tenantSlug: slug,
        dataDir: path.resolve('data'),
        imageSop: deps.imageSop,
        lock: async () => fakeLock(),
      });
      if (imported.code) throw new Error(imported.message);
      await initConfig(deps);
      fs.mkdirSync(path.join(directory, rt.slug), { recursive: true });
      await initSessionStore({ db, tenantId: rt.id, tenantSlug: rt.slug, varDir: path.join(directory, rt.slug) });
    });
  const tx = <T>(fn: (tx: Tx) => Promise<T>, rt = host) =>
    withTenantScope(rt, () =>
      withTenant(
        db,
        {
          tenantId: rt.id,
          actor: { kind: 'system', userId: null, name: null, ip: null },
        },
        fn,
      ),
    );
  return {
    db,
    query,
    host,
    other,
    tx,
    urls,
    setRole,
    async close() {
      await withoutTenantScope(() => runShutdownHooks());
      for (const rt of owners)
        await withTenantScope(rt, async () => {
          await rt.store.pgBackend?.close();
          await closeConfig();
        });
      unregisterRuntime(other.id);
      await close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ensureReport, readReport } from '../db/repo/ops-reports.js';
import { __jobsTest, runJobsOnce } from '../jobs/runner.js';
import { __alertTest, alert, sendOnce } from './alert.js';
import { readDailyPoint } from './trends.js';
import { renderDigest } from './digest.js';

export async function receiver() {
  const messages: string[] = [];
  let response = { status: 200, body: '{"errcode":0}', hang: false, disconnect: false };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    messages.push(JSON.parse(Buffer.concat(chunks).toString()).text.content);
    if (response.disconnect) {
      req.socket.destroy();
      return;
    }
    if (response.hang) return;
    res.writeHead(response.status);
    res.end(response.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    messages,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    set(patch: Partial<typeof response>) {
      response = { status: 200, body: '{"errcode":0}', hang: false, disconnect: false, ...patch };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('selftest_wait_timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const SELF = fileURLToPath(import.meta.url);
async function digestSuite(real: boolean) {
  process.env.TZ = 'Asia/Shanghai';
  const fx = await opsFixture(real);
  const net = await receiver();
  const t = new Date('2026-11-01T09:00:00+08:00').getTime();
  const day = '2026-10-31';
  const run = (now: number, rt = fx.host) => withTenantScope(rt, () => runJobsOnce(now));
  const report = (rt = fx.host) => fx.tx((tx) => readReport(tx, day), rt);
  const clear = async () => {
    await fx.query("delete from jobs where kind='ops_daily_digest'");
    await fx.query('delete from ops_daily_reports');
    __alertTest.reset();
    net.messages.length = 0;
    net.set({});
  };
  const schedule = async () => fx.tx((tx) => ensureReport(tx, day, t));
  try {
    process.env.ALERT_WEBHOOK_URL = net.url;
    process.env.OPS_DIGEST_TENANTS = 'demo,ops-other';
    await fx.query(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
      values($1,'digest-customer','wecom','new',false,'{"id":"digest-customer"}',now(),now())`,
      [fx.host.id],
    );
    await fx.query(
      `with turn as (
      insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
      values($1,gen_random_uuid(),'digest-customer','2026-10-31T12:00:00+08',1234,'replied',$2,'{}','[]','[]') returning id
    ) insert into messages(tenant_id,conversation_id,seq,role,content,at,turn_id)
      select $1,'digest-customer',1,'agent','合成回复',now(),id from turn`,
      [fx.host.id, 'a'.repeat(64)],
    );
    await fx.query(
      `insert into ops_metric_coverage(tenant_id,day,first_seen_at,last_seen_at)
      values($1,'2026-10-31','2026-10-31T00:00:00+08','2026-10-31T23:59:00+08')`,
      [fx.host.id],
    );
    await run(t - 60_000);
    assert.equal(net.messages.length, 0, '08:59 不排');
    await run(t);
    assert.equal((await report())!.status, 'sent');
    assert.equal(net.messages.length, 1, '09:00 一条');
    assert.deepEqual((await report())!.snapshot, await fx.tx((tx) => readDailyPoint(tx, day, t)), '摘要与同日日指标一致');
    assert.equal(((await report())!.snapshot as { turns: number }).turns, 1);
    const identity = (await report())!.reportId;
    await Promise.all([run(t + 1), run(t + 1)]);
    __jobsTest.reset();
    await run(t + 2);
    await fx.query("delete from jobs where kind='ops_daily_digest' and status='done'");
    await schedule();
    assert.equal(Number((await fx.query("select count(*) as n from jobs where kind='ops_daily_digest'"))[0]!.n), 0, '终态不再建 job');
    await run(t + 3);
    assert.equal((await report())!.reportId, identity);
    assert.equal(net.messages.length, 1, '终态账本即使 job 清理仍不重发');
    await fx.query("update tenants set status='suspended' where id=$1", [fx.host.id]);
    await run(t + 6 * 3_600_000, fx.other);
    assert.equal(net.messages.length, 2, `宿主停用不影响另一租户 ${JSON.stringify(await report(fx.other))}`);
    assert.ok(net.messages.some((s) => s.includes(`T-${fx.other.id.slice(0, 6)}`)));
    for (const text of net.messages) {
      assert.ok(!text.includes('demo') && !text.includes('ops-other') && !text.includes('合成'));
      if (text.includes(`T-${fx.other.id.slice(0, 6)}`)) assert.match(text, /留存范围内统计，数据可能不全/);
    }
    await clear();
    await schedule();
    await run(t + 5);
    assert.equal((await report())!.status, 'skipped');
    assert.equal(net.messages.length, 0);
    await fx.query("update tenants set status='active' where id=$1", [fx.host.id]);
    await clear();
    await schedule();
    net.set({ body: '{"errcode":42}' });
    await run(t);
    const frozen = (await report())!.snapshot;
    await run(t + 59_999);
    assert.equal(net.messages.length, 1);
    await run(t + 60_000);
    assert.deepEqual((await report())!.snapshot, frozen);
    await run(t + 360_000);
    await run(t + 960_000);
    assert.equal(net.messages.length, 3, '明确拒绝最多三次');
    assert.equal((await report())!.attempts, 3);
    assert.equal((await report())!.status, 'failed');
    // 快照后删除使尚未投递的报告重新计算。
    await clear();
    await schedule();
    net.set({ body: '{"errcode":42}' });
    await run(t);
    assert.equal(((await report())!.snapshot as { turns: number }).turns, 1);
    await fx.query('delete from messages where tenant_id=$1', [fx.host.id]);
    await fx.query('delete from turn_traces where tenant_id=$1', [fx.host.id]);
    await fx.query('update ops_metric_coverage set has_deletion=true where tenant_id=$1', [fx.host.id]);
    net.set({});
    await run(t + 60_000);
    assert.equal(((await report())!.snapshot as { turns: number | null }).turns, null);
    assert.match(net.messages[1]!, /留存范围内统计，数据可能不全/);
    for (const patch of [
      { status: 500 },
      { status: 302 },
      { body: 'not json' },
      { body: 'x'.repeat(8193) },
      { disconnect: true },
      { hang: true },
    ]) {
      await clear();
      await schedule();
      net.set(patch);
      await run(t);
      assert.equal((await report())!.status, 'unknown', JSON.stringify(patch).slice(0, 50));
      await schedule();
      await run(t + 600_000);
      assert.equal(net.messages.length, 1, 'unknown 不重试');
    }
    await clear();
    await schedule();
    net.set({ status: 400 });
    await run(t);
    assert.equal((await report())!.status, 'pending');
    assert.equal((await report())!.attempts, 1);
    await clear();
    await schedule();
    process.env.ALERT_WEBHOOK_URL = '';
    await run(t);
    assert.equal((await report())!.status, 'pending');
    assert.equal((await report())!.attempts, 0);
    process.env.ALERT_WEBHOOK_URL = net.url;
    await run(new Date('2026-11-02T00:00:00+08:00').getTime());
    assert.equal((await report())!.errorCode, 'deadline');
    assert.equal(net.messages.length, 0);
    await clear();
    await schedule();
    process.env.OPS_DIGEST_TENANTS = 'ops-other';
    await run(t);
    assert.equal((await report())!.errorCode, 'disabled');
    assert.equal(net.messages.length, 0);
    process.env.OPS_DIGEST_TENANTS = 'demo,ops-other';
    await clear();
    await schedule();
    await fx.query('alter table turn_traces rename to digest_query_failure');
    try {
      await run(t);
    } finally {
      await fx.query('alter table digest_query_failure rename to turn_traces');
    }
    assert.equal((await report())!.status, 'pending');
    assert.equal((await report())!.errorCode, 'sql_error');
    assert.equal((await report())!.attempts, 0);
    assert.equal(net.messages.length, 0);
    await run(t + 60_000);
    assert.equal((await report())!.status, 'sent');
    net.messages.length = 0;
    // 六条摘要之后，故障告警仍可使用剩余四个名额。
    __alertTest.reset();
    net.set({});
    for (let i = 0; i < 6; i++) assert.equal((await sendOnce('合成摘要', t)).status, 'accepted');
    assert.equal((await sendOnce('合成摘要', t)).status, 'not_attempted');
    __alertTest.setClock(() => t);
    alert('store', '合成故障', { escalate: true });
    await __alertTest.settle();
    assert.equal(net.messages.length, 7);
    __alertTest.setClock(null);
    if (real) {
      await clear();
      await schedule();
      const claims = await Promise.all([
        fx.tx((tx) => import('../db/repo/jobs.js').then((m) => m.claimDueJobs(tx, new Date(t), 10, ['ops_daily_digest']))),
        fx.tx((tx) => import('../db/repo/jobs.js').then((m) => m.claimDueJobs(tx, new Date(t), 10, ['ops_daily_digest']))),
      ]);
      assert.equal(claims.flat().length, 1, '两个实际认领者只拿到一个任务');
      await crashSuite(fx, net, t, day);
    }
    console.log(`${real ? 'PG' : 'PGlite'} DIGEST PASS：调度、隔离、终态去重、真实传输、快照、拒绝/未知、deadline、优先预算`);
  } finally {
    __alertTest.setClock(null);
    await net.close();
    await fx.close();
  }
}
async function crashSuite(fx: Awaited<ReturnType<typeof opsFixture>>, net: Awaited<ReturnType<typeof receiver>>, t: number, day: string) {
  for (const phase of ['before', 'sending', 'accepted']) {
    await fx.query("delete from jobs where kind='ops_daily_digest'");
    await fx.query('delete from ops_daily_reports');
    await fx.tx((tx) => ensureReport(tx, day, t));
    net.set(phase === 'sending' ? { hang: true } : {});
    net.messages.length = 0;
    if (phase !== 'sending') {
      await fx.query(`create function ops_crash_probe() returns trigger language plpgsql as $$ begin
        if NEW.status='${phase === 'before' ? 'sending' : 'sent'}' then perform pg_sleep(30); end if; return NEW; end $$`);
      await fx.query('create trigger ops_crash_probe before update on ops_daily_reports for each row execute function ops_crash_probe()');
    }
    const child = spawn(process.execPath, ['--import', 'tsx', SELF], {
      env: { ...process.env, OPS_DIGEST_TEST: 'crash', OPS_TEST_APP: fx.urls!.app, OPS_TEST_TIME: String(t), ALERT_WEBHOOK_URL: net.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (b) => {
      output += b.toString();
    });
    try {
      if (phase === 'sending') await waitUntil(() => net.messages.length > 0);
      else
        await waitUntil(async () => {
          if (child.exitCode !== null) throw new Error(`crash child exited: ${output}`);
          const rows = await fx.query("select 1 from pg_stat_activity where datname=current_database() and wait_event='PgSleep'");
          return rows.length > 0 && (phase !== 'accepted' || net.messages.length > 0);
        });
    } finally {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    if (phase !== 'sending') {
      await fx.query('drop trigger ops_crash_probe on ops_daily_reports');
      await fx.query('drop function ops_crash_probe()');
    }
    assert.equal((await fx.tx((tx) => readReport(tx, day)))!.status, phase === 'before' ? 'pending' : 'sending');
    // 真正另起进程启动归位，不使用测试门面伪造重启。
    net.set({});
    const restarted = spawn(process.execPath, ['--import', 'tsx', SELF], {
      env: { ...process.env, OPS_DIGEST_TEST: 'crash', OPS_TEST_APP: fx.urls!.app, OPS_TEST_TIME: String(t), ALERT_WEBHOOK_URL: net.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    restarted.stderr.on('data', (b) => {
      errors += b.toString();
    });
    const killer = setTimeout(() => restarted.kill('SIGKILL'), 15_000);
    const [code] = await once(restarted, 'exit');
    clearTimeout(killer);
    assert.equal(code, 0, errors);
    const after = await fx.tx((tx) => readReport(tx, day));
    assert.equal(after!.status, phase === 'before' ? 'sent' : 'unknown');
    assert.equal(net.messages.length, 1, '中止与重启全过程只一个实际请求');
  }
  console.log('PG CRASH PASS：发送前、sending 提交后、接收成功但提交前 SIGKILL；真实新进程恢复');
}
export async function runOpsChild(mode: 'digest' | 'latency' = 'digest') {
  const db = await openDb(process.env.OPS_TEST_APP!);
  const host = hostRuntime();
  enterTenantScopeForTest(host);
  fs.mkdirSync('var', { recursive: true });
  const directory = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'ops-crash-'));
  try {
    await initConfig(testConfigDeps({ db: db.db }));
    await initSessionStore({ db: db.db, tenantId: host.id, tenantSlug: 'demo', varDir: directory });
    process.env.OPS_DIGEST_TENANTS = 'demo';
    if (mode === 'digest') await runJobsOnce(Number(process.env.OPS_TEST_TIME));
    else {
      process.env.OPS_LATENCY_TENANTS = 'demo';
      await (await import('./latency.js')).checkLatency(Number(process.env.OPS_TEST_TIME));
      await __alertTest.settle();
    }
    await host.store.pgBackend?.close();
    await closeConfig();
  } finally {
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.env.OPS_DIGEST_TEST === 'crash') await runOpsChild();
  else if (process.env.OPS_DIGEST_TEST) await digestSuite(process.env.OPS_DIGEST_TEST === 'pg');
  else {
    for (const mode of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
        env: { ...process.env, OPS_DIGEST_TEST: mode },
        encoding: 'utf8',
        timeout: 180_000,
      });
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      assert.equal(result.status, 0, result.error?.message);
    }
    assert.match(
      renderDigest(
        {
          day: '2026-10-31',
          coverage: 'unavailable',
          receptions: null,
          turns: null,
          replySamples: null,
          replyP90Ms: null,
          handoffRate: null,
          aiErrorRate: null,
          costMilli: null,
          paidOrders: null,
        },
        { instance: 'test', tenantId: '123456', reportId: '87654321', trial: true },
      ),
      /共享试用/,
    );
  }
}
