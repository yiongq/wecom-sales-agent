import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { opsFixture, receiver, runOpsChild } from './digest.selftest.js';
import { checkLatency, eligibleWindowEnd } from './latency.js';
import { readLatency } from '../db/repo/ops-latency.js';
import { withTenantScope } from '../tenancy/runtime.js';
import { __alertTest } from './alert.js';
import { SEED_SESSION_PREFIX, VISITOR_SESSION_PREFIX } from '../shared/origin.js';

async function suite(real: boolean) {
  const fx = await opsFixture(real);
  const net = await receiver();
  const base = Date.parse('2026-11-01T00:00:00Z');
  let clock = base;
  process.env.OPS_LATENCY_TENANTS = 'demo,ops-other';
  process.env.ALERT_WEBHOOK_URL = net.url;
  __alertTest.setClock(() => clock);
  const row = (rt = fx.host) => fx.tx(readLatency, rt);
  const check = async (end: number, rt = fx.host) => {
    clock = end + 60_000;
    await withTenantScope(rt, () => checkLatency(clock));
    await __alertTest.settle();
  };
  const restartCheck = async (end: number) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SELF], {
      env: { ...process.env, OPS_LATENCY_TEST: 'restart', OPS_TEST_APP: fx.urls!.app, OPS_TEST_TIME: String(end + 60_000) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (b) => {
      errors += b.toString();
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [code] = await once(child, 'exit');
    clearTimeout(killer);
    assert.equal(code, 0, errors);
  };
  const samples = async (
    end: number,
    duration: number,
    n = 20,
    rt = fx.host,
    conv = 'latency-customer',
    outcome = 'replied',
    author: string | null = null,
  ) => {
    await fx.query(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
      values($1,$2,'wecom','new',false,$3,now(),now()) on conflict do nothing`,
      [rt.id, conv, JSON.stringify({ id: conv, ...(conv === 'seed-state' ? { seed: true } : {}) })],
    );
    await fx.query(
      `with inserted as (
      insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
      select $1,gen_random_uuid(),$2,$3::timestamptz,$4,$5,$6,'{}','[]','[]' from generate_series(1,$7::int)
      returning id,tenant_id,conversation_id,started_at
    ) insert into messages(tenant_id,conversation_id,seq,role,author,content,at,turn_id)
      select tenant_id,conversation_id,(row_number() over())::int + coalesce((select max(seq) from messages where tenant_id=$1 and conversation_id=$2),0),
      'agent',$8,'合成回复',started_at,id from inserted`,
      [rt.id, conv, new Date(end - 60_000), duration, outcome, 'a'.repeat(64), n, author],
    );
    await fx.query(
      'update conversations set last_seq=(select max(seq) from messages where tenant_id=$1 and conversation_id=$2) where tenant_id=$1 and id=$2',
      [rt.id, conv],
    );
  };
  const reset = async () => {
    await fx.query('delete from ops_latency_state');
    await fx.query('delete from messages');
    await fx.query('delete from turn_traces');
    net.messages.length = 0;
    __alertTest.reset();
  };
  try {
    assert.equal(eligibleWindowEnd(base + 59_999), base - 300_000);
    assert.equal(eligibleWindowEnd(base + 60_000), base);
    await samples(base, 8001, 19);
    await check(base);
    assert.equal((await row())!.badStreak, 0);
    for (let i = 1; i <= 3; i++) {
      await samples(base + i * 300_000, 8001);
      await check(base + i * 300_000);
      assert.equal((await row())!.badStreak, i);
      assert.equal((await row())!.active, i === 3, `第 ${i} 个慢窗`);
      assert.equal(net.messages.length, i === 3 ? 1 : 0, '前两个慢窗不告警，第三个才告警');
    }
    await check(base + 900_000);
    assert.equal(net.messages.length, 1, '同窗重复无效');
    // 进程内告警表清空，持久 active 的两好窗仍能发恢复。
    __alertTest.reset();
    if (real) {
      await restartCheck(base + 900_000);
      assert.equal(net.messages.length, 1, '新进程不重复已评窗口');
    }
    for (let i = 4; i <= 5; i++) {
      await samples(base + i * 300_000, 6000);
      if (real) await restartCheck(base + i * 300_000);
      else await check(base + i * 300_000);
    }
    assert.equal((await row())!.active, false);
    assert.equal(net.messages.length, 2);
    assert.match(net.messages[1]!, /已恢复/);
    await reset();
    for (let i = 0; i < 4; i++) {
      await samples(base + i * 300_000, 8000);
      await check(base + i * 300_000);
    }
    assert.equal(net.messages.length, 0, '8000 不触发');
    assert.equal((await row())!.badStreak, 0);
    await reset();
    for (let i = 0; i < 3; i++) {
      await samples(base + i * 300_000, 8001);
      await check(base + i * 300_000);
    }
    for (const [i, ms, n] of [
      [3, 6000, 20],
      [4, 6001, 20],
      [5, 6000, 20],
      [6, 6000, 19],
    ]) {
      await samples(base + i! * 300_000, ms!, n!);
      await check(base + i! * 300_000);
    }
    assert.equal((await row())!.active, true, '低样本不中止 active，更不能报恢复');
    assert.equal((await row())!.goodStreak, 0);
    assert.equal(net.messages.length, 1);
    await samples(base + 7 * 300_000, 6000);
    await check(base + 7 * 300_000);
    // 故意跳一个完整窗口，随后好窗不能与旧好窗连起来。
    await samples(base + 9 * 300_000, 6000);
    await check(base + 9 * 300_000);
    assert.equal((await row())!.active, true);
    assert.equal((await row())!.goodStreak, 1);
    // 数据库视图失败发生在真实 SQL 上，非注入空样本。
    await fx.query('alter table turn_traces rename to latency_query_failure');
    try {
      await check(base + 10 * 300_000);
    } finally {
      await fx.query('alter table latency_query_failure rename to turn_traces');
    }
    assert.equal((await row())!.active, true);
    assert.equal((await row())!.goodStreak, 0);
    assert.equal(net.messages.length, 1);
    await samples(base + 11 * 300_000, 8001);
    await check(base + 11 * 300_000);
    assert.equal(net.messages.length, 2, '持续慢超过 30 分钟提醒一次');
    await samples(base + 12 * 300_000, 8001);
    await check(base + 12 * 300_000);
    assert.equal(net.messages.length, 2);
    await fx.query("update tenants set status='suspended' where id=$1", [fx.host.id]);
    await check(base + 13 * 300_000);
    assert.equal((await row())!.paused, true);
    assert.equal((await row())!.active, true);
    await fx.query("update tenants set status='active' where id=$1", [fx.host.id]);
    await samples(base + 14 * 300_000, 6000);
    await check(base + 14 * 300_000);
    assert.equal((await row())!.active, true);
    assert.equal((await row())!.goodStreak, 1);
    await check(base + 14 * 300_000, fx.other);
    assert.equal((await row(fx.other))!.active, false, '跨租户隔离');
    await reset();
    // 生产写路径本已拒绝种子/访客；合成旧数据用于验证 SQL 自己也排除。
    await fx.query('alter table conversations drop constraint conversations_id_check');
    // 非 replied、人工、种子、访客都不满足样本数。
    await samples(base, 9000, 20, fx.host, 'latency-customer', 'handoff');
    await samples(base, 9000, 20, fx.host, 'human-customer', 'replied', 'human');
    for (const conv of [`${SEED_SESSION_PREFIX}latency`, `${VISITOR_SESSION_PREFIX}latency`, 'seed-state'])
      await samples(base, 9000, 20, fx.host, conv);
    await check(base);
    assert.equal((await row())!.lastSamples, 0);
    assert.equal(net.messages.length, 0);
    console.log(`${real ? 'PG' : 'PGlite'} LATENCY PASS：19/20、8000/8001、6000/6001、缺窗/失败/低样本、暂停、恢复、30 分钟、隔离、来源`);
  } finally {
    __alertTest.setClock(null);
    await net.close();
    await fx.close();
  }
}
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.env.OPS_LATENCY_TEST === 'restart') await runOpsChild('latency');
  else if (process.env.OPS_LATENCY_TEST) await suite(process.env.OPS_LATENCY_TEST === 'pg');
  else
    for (const mode of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
        env: { ...process.env, OPS_LATENCY_TEST: mode },
        encoding: 'utf8',
        timeout: 120_000,
      });
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      assert.equal(result.status, 0, result.error?.message);
    }
}
