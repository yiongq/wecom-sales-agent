// 17 第 2 步：持久化契约、旧清除签名与真实角色隔离；不依赖后续评分/摘要应用逻辑。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { openDb, pgErrorOf, rowsOf, withTenant, type Db, type Tx } from './client.js';
import { createRealPgFixture, openTestDb } from './testing.js';
import { eraseConversation, purgeOpsData, readPurgeCandidates } from './repo/retention.js';

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
type Role = 'agent_app' | 'agent_platform';
type AsRole = <T>(role: Role, run: (db: Db) => Promise<T>) => Promise<T>;
const tables = ['turn_reviews', 'ops_daily_reports', 'ops_latency_state', 'ops_metric_coverage'];
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
const dayMs = 86_400_000;
async function rejects(fn: () => Promise<unknown>, code = '42501') {
  await assert.rejects(fn, (e) => pgErrorOf(e).code === code);
}

async function suite(q: Query, as: AsRole, label: string) {
  const tenant = async (slug: string) =>
    (
      await q<{ id: string }>(
        `insert into tenants(slug,name,pack_id,retention_lead_days,retention_customer_days,retention_trace_days)
       values ($1,$1,'industrial',7,7,7) returning id`,
        [slug],
      )
    )[0]!.id;
  const a = await tenant('ops-data-a');
  const b = await tenant('ops-data-b');
  const tx = <T>(tenantId: string, run: (tx: Tx) => Promise<T>, role: Role = 'agent_app') =>
    as(role, (db) => withTenant(db, ctx(tenantId), run));
  const now = new Date((await q<{ at: Date }>("select date_trunc('milliseconds',now()) as at"))[0]!.at);
  const at = (days: number) => new Date(now.getTime() - days * dayMs);
  const day = (days: number) => at(days).toISOString().slice(0, 10);
  const reviewer = randomUUID(); // 无成员外键：已移除成员的评分仍须保留。
  async function conversation(t: string, id: string, seed = false) {
    await q(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
      values ($1,$2,'wecom','greeting',false,json_build_object('id',$2::text,'seed',$3::boolean,'seedBaselineSeq',0),$4,$4)`,
      [t, id, seed, at(8)],
    );
  }
  async function review(t: string, id: string, started = now) {
    const turn = randomUUID();
    await q(
      `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm,final_text)
      values ($1,$2,$3,$4,1,'replied',$5,'{}','[]','[]','合成回复')`,
      [t, turn, id, started, 'a'.repeat(64)],
    );
    await tx(t, (x) =>
      x.execute(sql`insert into turn_reviews(tenant_id,turn_id,rating,reviewer_user_id)
      values (${t},${turn},'good',${reviewer})`),
    );
    return turn;
  }
  async function coverage(t: string, d: number, instant: Date, offsetMinutes = 0) {
    const checkpoint = new Date(instant.getTime() + offsetMinutes * 60000);
    await tx(t, (x) =>
      x.execute(sql`insert into ops_metric_coverage(tenant_id,day,first_seen_at,last_seen_at)
      values (${t},${day(d)}::date,${checkpoint.toISOString()}::timestamptz,${checkpoint.toISOString()}::timestamptz)`),
    );
  }
  async function paidOrder(t: string, id: string, paid: Date) {
    await q(
      `insert into orders(tenant_id,id,session_id,route_id,total_price,created_at,status,data,paid_at)
      values ($1,$2,$3,'synthetic',1,now(),'paid',json_build_object('sessionId',$3::text,'id',$2::text),$4)`,
      [t, `order-${id}`, id, paid],
    );
  }
  const count = async (table: string, t: string) =>
    (await q<{ n: number }>(`select count(*)::int n from ${table} where tenant_id=$1`, [t]))[0]!.n;
  const exists = async (turn: string) => (await q('select 1 from turn_reviews where turn_id=$1', [turn])).length === 1;
  const deleted = async (t: string, d: number) =>
    (await q<{ has_deletion: boolean }>('select has_deletion from ops_metric_coverage where tenant_id=$1 and day=$2', [t, day(d)]))[0]!
      .has_deletion;
  const foreignSnapshot = async () => {
    const rows = [];
    for (const table of [...tables, 'turn_traces', 'conversations', 'orders'])
      rows.push(await q(`select * from ${table} where tenant_id=$1 order by to_jsonb(${table})::text`, [b]));
    return JSON.stringify(rows);
  };

  for (const t of [a, b]) {
    await conversation(t, 'keep');
    await review(t, 'keep');
    await tx(t, (x) =>
      x.execute(sql`insert into ops_daily_reports(tenant_id,day,status,snapshot) values (${t},${day(0)}::date,'sent','{}')`),
    );
    await tx(t, (x) => x.execute(sql`insert into ops_latency_state(tenant_id) values (${t})`));
    for (const d of [1, 2, 3, 4, 8]) await coverage(t, d, at(d), d === 2 ? 2 : d === 3 ? -2 : 0);
  }
  const flags = await q<{ relname: string; enabled: boolean; forced: boolean; owner: string }>(
    `select relname,relrowsecurity enabled,relforcerowsecurity forced,pg_get_userbyid(relowner) owner
     from pg_class where relnamespace='public'::regnamespace and relname=any($1)`,
    [tables],
  );
  assert.equal(flags.length, 4);
  assert.ok(flags.every((r) => r.enabled && r.forced && r.owner === 'agent_owner'));
  for (const table of tables) {
    for (const t of [a, b, a, b]) {
      const rows = await tx(t, (x) => x.execute(sql`select tenant_id from ${sql.identifier(table)}`));
      assert.ok(rowsOf<{ tenant_id: string }>(rows).length > 0);
      assert.ok(rowsOf<{ tenant_id: string }>(rows).every((r) => r.tenant_id === t));
    }
    for (const role of ['agent_app', 'agent_platform'] as const) {
      for (const verb of ['delete', 'truncate'])
        await rejects(() =>
          tx(
            a,
            (x) => x.execute(verb === 'delete' ? sql`delete from ${sql.identifier(table)}` : sql`truncate ${sql.identifier(table)}`),
            role,
          ),
        );
      const [grant] = await q<{ ok: boolean }>("select has_table_privilege($1,$2,'DELETE') ok", [role, table]);
      assert.equal(grant!.ok, false);
    }
    await rejects(() => tx(a, (x) => x.execute(sql`select * from ${sql.identifier(table)}`), 'agent_platform'));
  }
  for (const role of ['agent_app', 'agent_platform'] as const)
    await rejects(() => tx(a, (x) => x.execute(sql`select ops_coverage_mark_deleted(${a}::uuid,ARRAY[now()])`), role));
  await rejects(() => tx(a, (x) => purgeOpsData(x, now), 'agent_platform'));
  await rejects(() => as('agent_app', (db) => db.execute(sql`select purge_ops_data(${a}::uuid,now())`)));
  await rejects(() => tx(b, (x) => x.execute(sql`select purge_ops_data(${a}::uuid,now())`)));
  for (const bad of [null, new Date(now.getTime() + 6 * 60000).toISOString(), new Date(now.getTime() - 6 * 60000).toISOString()])
    await rejects(() => tx(a, (x) => x.execute(sql`select purge_ops_data(${a}::uuid,${bad}::timestamptz)`)), '22023');
  const [other] = await q<{ turn_id: string }>('select turn_id from turn_reviews where tenant_id=$1', [b]);
  await rejects(
    () =>
      tx(a, (x) =>
        x.execute(sql`insert into turn_reviews(tenant_id,turn_id,rating,reviewer_user_id)
    values (${a},${other!.turn_id},'good',${reviewer})`),
      ),
    '23503',
  );
  await rejects(() => tx(a, (x) => x.execute(sql`insert into ops_daily_reports(tenant_id,day) values (${b},${day(1)}::date)`)));
  for (const query of [
    sql`update turn_reviews set rating='bad',reason=null`,
    sql`update turn_reviews set rating='good',reason='other'`,
    sql`update turn_reviews set rating='bad',reason='free-text'`,
    sql`update turn_reviews set revision=0`,
    sql`update turn_reviews set rating='unknown'`,
  ])
    await rejects(() => tx(a, (x) => x.execute(query)), '23514');
  await tx(a, (x) => x.execute(sql`update turn_reviews set rating='bad',reason='missing',revision=2`));
  await rejects(() => tx(a, (x) => x.execute(sql`insert into ops_daily_reports(tenant_id,day) values (${a},${day(0)}::date)`)), '23505');
  const [report] = await q<{ report_id: string }>('select report_id from ops_daily_reports where tenant_id=$1', [b]);
  await rejects(
    () =>
      tx(a, (x) =>
        x.execute(sql`insert into ops_daily_reports(tenant_id,day,report_id) values (${a},${day(1)}::date,${report!.report_id})`),
      ),
    '23505',
  );
  for (const query of [
    sql`update ops_daily_reports set status='invalid'`,
    sql`update ops_daily_reports set attempts=-1`,
    sql`update ops_daily_reports set resend_count=-1`,
    sql`update ops_daily_reports set error_code='arbitrary'`,
  ])
    await rejects(() => tx(a, (x) => x.execute(query)), '23514');
  for (const column of ['bad_streak', 'good_streak', 'last_p90_ms', 'last_samples'])
    await rejects(() => tx(a, (x) => x.execute(sql`update ops_latency_state set ${sql.identifier(column)}=-1`)), '23514');
  await rejects(() => tx(a, (x) => x.execute(sql`update ops_metric_coverage set last_seen_at=first_seen_at-interval '1 second'`)), '23514');
  console.log(`${label}: 四表 FORCE RLS、两租户交错、CHECK/唯一键、跨租户复合外键、最小权限 PASS`);
  const before = await foreignSnapshot();

  // seed 会话的候选豁免不延长 trace；七天内边界保留，刚过期与八天前同时级联评分。
  await conversation(a, 'seed', true);
  const oldReal = await review(a, 'keep', at(8));
  const oldSeed = await review(a, 'seed', at(8));
  const expired = await review(a, 'seed', new Date(at(7).getTime() - 1000));
  const edge = await review(a, 'seed', new Date(at(7).getTime() + 1000));
  const candidates = await tx(a, (x) => readPurgeCandidates(x, at(7), null, 100));
  assert.ok(!candidates.some((c) => c.id === 'seed'));
  // 未改签名的旧镜像调用，返回仍是 trace+出站行数。
  const traceCount = rowsOf<{ n: number }>(
    await tx(a, (x) => x.execute(sql`select purge_expired_traces(${a}::uuid,${now.toISOString()}::timestamptz) n`)),
  )[0]!.n;
  assert.equal(traceCount, 3);
  assert.equal(await exists(oldReal), false);
  assert.equal(await exists(oldSeed), false);
  assert.equal(await exists(expired), false);
  assert.equal(await exists(edge), true);
  assert.equal(await count('conversations', a), 2);
  assert.equal(await deleted(a, 8), true);
  assert.equal(await deleted(a, 4), false);
  assert.equal(await deleted(b, 8), false);
  assert.equal(await foreignSnapshot(), before);
  console.log(`${label}: trace 到期、七天边界与种子会话豁免不延长评分、coverage 隔离 PASS`);

  await conversation(a, 'purge');
  const purgedTurn = await review(a, 'purge', at(2));
  await paidOrder(a, 'purge', at(3));
  const purge = () =>
    tx(a, (x) =>
      x.execute(
        sql`select purge_conversation(${a}::uuid,'purge',${now.toISOString()}::timestamptz,0,${at(8).toISOString()}::timestamptz) ok`,
      ),
    );
  assert.equal(rowsOf<{ ok: boolean }>(await purge())[0]!.ok, true);
  assert.equal(await exists(purgedTurn), false);
  assert.equal(await deleted(a, 2), true, 'trace 恰好在区间下端（含两分钟容差）也标记');
  assert.equal(await deleted(a, 3), true, 'paid_at 恰好在区间上端也标记');
  assert.equal(await deleted(a, 4), false);
  assert.equal(await foreignSnapshot(), before);
  const [detached] = await q<{ session_id: string | null }>("select session_id from orders where tenant_id=$1 and id='order-purge'", [a]);
  assert.equal(detached!.session_id, null);
  // 乐观并发校验未通过不能误标完整性。
  await conversation(a, 'decline');
  await review(a, 'decline', at(4));
  assert.equal(
    rowsOf<{ ok: boolean }>(
      await tx(a, (x) => x.execute(sql`select purge_conversation(${a}::uuid,'decline',now(),1,${at(8).toISOString()}::timestamptz) ok`)),
    )[0]!.ok,
    false,
  );
  assert.equal(await deleted(a, 4), false);
  console.log(`${label}: purge_conversation 旧签名、评分级联、trace/已付订单删除标记与拒绝清理无副作用 PASS`);

  await conversation(a, 'erase');
  const erasedTurn = await review(a, 'erase', at(1));
  await paidOrder(a, 'erase', at(4));
  const counts = await tx(a, (x) => eraseConversation(x, 'erase', '合成删除'), 'agent_platform');
  assert.equal(counts.reviews, 1);
  assert.equal(counts.traces, 1);
  assert.equal(await exists(erasedTurn), false);
  assert.equal(await deleted(a, 1), true);
  assert.equal(await deleted(a, 4), true);
  const [audit] = await q<{ diff: { reviews: number } }>("select diff from audit_log where tenant_id=$1 and action='platform.erase'", [a]);
  assert.equal(audit!.diff.reviews, 1);
  assert.equal(await foreignSnapshot(), before);
  // 直接用旧签名再调一次，新增 JSON 键不影响缺行调用。
  const legacyErase = rowsOf<{ counts: { reviews: number } }>(
    await tx(a, (x) => x.execute(sql`select erase_conversation(${a}::uuid,'missing','合成旧镜像') counts`), 'agent_platform'),
  )[0]!.counts;
  assert.equal(legacyErase.reviews, 0);
  console.log(`${label}: eraseConversation、旧签名、删除前评分计数/审计与订单时刻标记 PASS`);

  for (const days of [36, 35, 8, 7]) {
    await tx(a, (x) =>
      x.execute(sql`insert into ops_daily_reports(tenant_id,day,status,snapshot,computed_at)
      values (${a},${day(days)}::date,'sent','{}',now())`),
    );
    if (![8].includes(days)) await coverage(a, days, at(days));
  }
  await tx(a, (x) =>
    x.execute(sql`insert into jobs(tenant_id,kind,dedupe_key,run_at,status,finished_at,max_attempts,payload)
    values (${a},'ops_daily_digest','ops_daily_digest:test',now(),'done',now()-interval '31 days',10,'{}')`),
  );
  assert.equal(rowsOf<{ n: number }>(await tx(a, (x) => x.execute(sql`select purge_finished_jobs(${a}::uuid,now()) n`)))[0]!.n, 1);
  assert.equal(await count('ops_daily_reports', a), 5, '终态日账本独立于 job 留存');
  const n = await tx(a, (x) => purgeOpsData(x, now));
  assert.equal(n, 6, '报告删一行、快照清两行、coverage 删三行');
  const reports = await q<{ day: string; snapshot: unknown; status: string }>(
    'select day::text,snapshot,status from ops_daily_reports where tenant_id=$1 order by day',
    [a],
  );
  assert.deepEqual(
    reports.map((r) => r.day),
    [day(35), day(8), day(7), day(0)],
  );
  assert.deepEqual(
    reports.map((r) => r.snapshot),
    [null, null, {}, {}],
  );
  assert.ok(reports.every((r) => r.status === 'sent'));
  assert.equal(await count('ops_metric_coverage', a), 5, '保留今天之前七日内及边界日的完整性证据');
  assert.equal(await tx(a, (x) => purgeOpsData(x, now)), 0);
  assert.equal(await foreignSnapshot(), before);
  // 长保留租户：快照最多 35 天，coverage 最多 30 个自然日（边界保守多一天）。
  await q('update tenants set retention_trace_days=90 where id=$1', [a]);
  for (const d of [31, 30]) await coverage(a, d, at(d));
  await tx(a, (x) => purgeOpsData(x, now));
  assert.equal((await q('select 1 from ops_metric_coverage where tenant_id=$1 and day=$2', [a, day(31)])).length, 0);
  assert.equal((await q('select 1 from ops_metric_coverage where tenant_id=$1 and day=$2', [a, day(30)])).length, 1);
  console.log(`${label}: 日账本去重、job 删除后终态仍在、七天/三十天/三十五天清理与租户隔离 PASS`);

  const [sandbox] = await q<{ id: string }>(
    `insert into tenants(slug,name,pack_id,kind,expires_at,template_tenant_id)
    values ('sbx-ops-data','合成沙箱','industrial','sandbox',now()-interval '1 day',$1) returning id`,
    [a],
  );
  const s = sandbox!.id;
  await conversation(s, 'sandbox');
  const sandboxTurn = await review(s, 'sandbox');
  await tx(s, (x) => x.execute(sql`insert into ops_daily_reports(tenant_id,day) values (${s},current_date)`));
  await tx(s, (x) => x.execute(sql`insert into ops_latency_state(tenant_id) values (${s})`));
  await coverage(s, 0, now);
  const purged = rowsOf<{ counts: Record<string, number> }>(
    await tx(s, (x) => x.execute(sql`select sandbox_tenant_purge(${s}::uuid) counts`)),
  )[0]!.counts;
  for (const table of tables) {
    assert.equal(purged[table], 1, `${table} 必须在级联之前计数`);
    assert.equal(await count(table, s), 0);
  }
  assert.equal(await exists(sandboxTurn), false);
  assert.equal((await q('select 1 from tenants where id=$1', [s])).length, 0);
  assert.equal(await foreignSnapshot(), before);
  console.log(`${label}: sandbox_tenant_purge 旧签名、四表删除/剩余核对、评分先删与跨租户保护 PASS`);
}

const t = await openTestDb();
try {
  await t.migrate();
  await suite(
    async <T>(text: string, params: unknown[] = []) => (await t.pg.query<T>(text, params)).rows,
    async (role, run) => {
      await t.pg.exec(`SET ROLE ${role}`);
      try {
        return await run(t.db);
      } finally {
        await t.pg.exec('RESET ROLE');
      }
    },
    'PGlite',
  );
} finally {
  await t.close();
}
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL);
  const app = await openDb(fx.urls.app);
  const platform = await openDb(fx.urls.platform);
  try {
    await suite(fx.query, (role, run) => run(role === 'agent_app' ? app.db : platform.db), 'PG');
  } finally {
    await app.close();
    await platform.close();
    await fx.drop();
  }
} else if (process.env.CI === 'true') throw new Error('CI 必须提供 PG_TEST_URL');
else console.log('未设 PG_TEST_URL：真实角色验证待补跑');
console.log('OBSERVABILITY SELFTEST PASS（手动重置链路另见 trial-reset.selftest.ts）');
