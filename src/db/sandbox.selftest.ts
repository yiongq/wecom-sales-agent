// 05 第 3 步：PGlite 验证事务与函数行为；RLS、授权结论只取真实 PG，CI 必跑。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { currentTenantCtx, openDb, rowsOf, withNewSandboxTenant, withTenant, type Db } from './client.js';
import { createRealPgFixture, openTestDb } from './testing.js';

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
type AsApp = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
let passed = 0;
function check(value: unknown, name: string): void {
  assert.ok(value, name);
  passed++;
}
async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    for (let x = e; x && typeof x === 'object'; x = (x as { cause?: unknown }).cause) {
      if ((x as { code?: string }).code === code) return true;
    }
    return false;
  });
  passed++;
}
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
const tables = ['sandbox_pool_daily', 'sandbox_wechat', 'sandbox_wecom_state', 'sandbox_process_epoch'];
const functions = [
  'sandbox_tenant_create(text,uuid,json,bytea,inet,text)',
  'sandbox_session_resolve(bytea)',
  'sandbox_tenant_expire(uuid)',
  'sandbox_tenant_purge(uuid)',
  'sandbox_privacy_seed(uuid,text)',
];

async function suite(q: Query, app: AsApp, real: boolean): Promise<void> {
  const [template] = await q<{ id: string }>(
    "insert into tenants (slug,name,pack_id) values ('template-test','模板','travel') returning id",
  );
  const templateId = template!.id;
  await q(`update tenants set brand='{"pending":"template-brand"}' where id=$1`, [templateId]);
  for (const invalid of [
    "kind='unknown'",
    'expires_at=now()',
    "public_host='Mixed.example'",
    "public_host='example.invalid:443'",
    "public_host='example.invalid.'",
    'llm_daily_alert_milli=-1',
    "kind='sandbox',expires_at=now(),template_tenant_id=null",
  ]) {
    await rejects(() => q(`update tenants set ${invalid} where id=$1`, [templateId]), '23514');
  }
  await q("update tenants set public_host='example.invalid',llm_daily_alert_milli=0 where id=$1", [templateId]);
  await rejects(
    () => q("insert into tenants (slug,name,pack_id,public_host) values ('duplicate-host','测试','travel','example.invalid')"),
    '23505',
  );
  const execute = (query: import('drizzle-orm').SQL) => app((db) => db.execute(query));
  const input = (slug: string) => ({
    slug,
    templateTenantId: templateId,
    brand: null,
    tokenHash: randomBytes(32),
    ip: null,
    userAgent: null,
  });
  const creation = input('sbx-create-test');
  const create = (arg = creation) =>
    app((db) =>
      withNewSandboxTenant(db, arg, async (tx, created) => {
        check(
          currentTenantCtx().tenantId === created.tenantId && currentTenantCtx().actor.userId === created.userId,
          '开通回调有新租户上下文',
        );
        const [guc] = rowsOf<{ id: string }>(await tx.execute(sql`select current_setting('app.tenant_id') as id`));
        check(guc?.id === created.tenantId, '开通回调 GUC 是新租户');
        await tx.execute(
          sql`insert into sandbox_wechat (tenant_id,link_token) values (${created.tenantId}, ${randomBytes(32).toString('hex')})`,
        );
        await tx.execute(sql`insert into audit_log (tenant_id,actor_kind,action) values (${created.tenantId}, 'system', 'sandbox.create')`);
        return created;
      }),
    );
  const created = await create();
  const [brand] = await q<{ brand: unknown; pack_id: string }>('select brand,pack_id from tenants where id=$1', [created.tenantId]);
  check(brand?.brand === null && brand.pack_id === 'travel', '品牌取传入快照，pack_id 取模板，不读模板待生效品牌');
  await rejects(() => q("update tenants set public_host='sandbox.invalid' where id=$1", [created.tenantId]), '23514');
  await rejects(() => q('update tenants set llm_daily_alert_milli=0 where id=$1', [created.tenantId]), '23514');
  await rejects(() => q('update sandbox_wechat set external_userid=$2 where tenant_id=$1', [created.tenantId, 'wmTest']), '23514');
  await rejects(() => q('update sandbox_wechat set code_hash=$2 where tenant_id=$1', [created.tenantId, randomBytes(32)]), '23514');
  await rejects(() => q('insert into sandbox_process_epoch (id,epoch) values (2,0)'), '23514');
  for (const field of ['provisioned', 'purged', 'calls', 'cost_milli']) {
    await rejects(() => q(`insert into sandbox_pool_daily (day,${field}) values ('2000-01-01',-1)`), '23514');
  }
  await assert.rejects(
    () => app((db) => withTenant(db, ctx(templateId), () => withNewSandboxTenant(db, input('sbx-nested'), async () => null))),
    /不能嵌套/,
  );
  passed++;
  const [lifetime] = await q<{ ok: boolean }>(
    `select s.expires_at = t.expires_at and s.expires_at = s.created_at + interval '24 hours' as ok
    from auth_sessions s join tenants t on t.id=s.tenant_id where t.id=$1`,
    [created.tenantId],
  );
  check(lifetime?.ok, '登录会话与沙箱同为 24 小时绝对寿命');
  const [synthetic] = await q<{ ok: boolean }>(
    `select email = 'sbx-create-test@sandbox.invalid' and display_name = '体验访客'
    and password_hash = 'sandbox-disabled' as ok from users where id=$1`,
    [created.userId],
  );
  check(synthetic?.ok, '合成用户身份与禁用口令');
  const [guc] = rowsOf<{ id: string | null }>(await execute(sql`select current_setting('app.tenant_id', true) as id`));
  check(!guc?.id, '开通提交之后不泄漏 GUC');
  const resolve = (token = creation.tokenHash) =>
    execute(sql`select * from sandbox_session_resolve(${token})`).then(
      (r) =>
        rowsOf<{
          o_status: string;
          o_tenant: string | null;
          o_user: string | null;
          o_role: string | null;
          o_display_name: string | null;
          o_expires_at: Date | null;
        }>(r)[0]!,
    );
  // 不套标准登录的 12 小时空闲期限。
  await q("update auth_sessions set last_seen_at=now()-interval '13 hours' where tenant_id=$1", [created.tenantId]);
  const ok = await resolve();
  check(
    ok.o_status === 'ok' &&
      ok.o_tenant === created.tenantId &&
      ok.o_user === created.userId &&
      ok.o_role === 'owner' &&
      ok.o_display_name === '体验访客',
    'resolve ok，13 小时空闲仍有效',
  );
  const [seen] = await q<{ ok: boolean }>("select last_seen_at > now()-interval '1 minute' as ok from auth_sessions where tenant_id=$1", [
    created.tenantId,
  ]);
  check(seen?.ok, 'resolve 刷新 last_seen_at');
  check((await resolve(randomBytes(32))).o_status === 'invalid', 'resolve 未知 token invalid');
  await q('update users set disabled_at=now() where id=$1', [created.userId]);
  const disabled = await resolve();
  check(disabled.o_status === 'invalid' && !disabled.o_tenant && !disabled.o_user, '停用用户不带身份');
  await q('update users set disabled_at=null where id=$1', [created.userId]);
  await q('delete from memberships where tenant_id=$1', [created.tenantId]);
  check((await resolve()).o_status === 'invalid', '移除成员后失效');
  await q("insert into memberships (tenant_id,user_id,role) values ($1,$2,'owner')", [created.tenantId, created.userId]);
  await rejects(
    () => app((db) => withTenant(db, ctx(templateId), (tx) => tx.execute(sql`select sandbox_tenant_purge(${templateId})`))),
    '22023',
  );
  await rejects(() => execute(sql`select sandbox_tenant_expire(${templateId})`), '22023');
  await rejects(() => execute(sql`select public.sandbox_privacy_seed(${templateId}::uuid, '测试')`), '22023');
  await rejects(() => execute(sql`select public.sandbox_privacy_seed(${randomUUID()}::uuid, '测试')`), '22023');
  await rejects(
    () =>
      app((db) =>
        withTenant(db, ctx(templateId), (tx) => tx.execute(sql`select public.sandbox_privacy_seed(${created.tenantId}::uuid, '测试')`)),
      ),
    '42501',
  );
  await q('set role agent_platform');
  try {
    await rejects(() => q('select public.sandbox_privacy_seed($1::uuid, $2)', [created.tenantId, '测试']), '42501');
  } finally {
    await q('reset role');
  }
  const standardToken = randomBytes(32);
  await q(
    `insert into auth_sessions (token_hash,tenant_id,user_id,created_at,last_seen_at,expires_at)
    values ($1,$2,$3,now(),now(),now()+interval '24 hours')`,
    [standardToken, templateId, created.userId],
  );
  await rejects(() => execute(sql`select * from sandbox_session_resolve(${standardToken})`), '22023');
  await q('delete from auth_sessions where token_hash=$1', [standardToken]);
  await rejects(() => create({ ...input('sbx-bad-template'), templateTenantId: created.tenantId }), '22023');
  await q("update tenants set status='suspended' where id=$1", [templateId]);
  await rejects(() => create(input('sbx-suspended-template')), '22023');
  await q("update tenants set status='active' where id=$1", [templateId]);
  await rejects(() => create(input('wrong-prefix')), '22023');
  await rejects(
    () => app((db) => withTenant(db, ctx(created.tenantId), (tx) => tx.execute(sql`select sandbox_tenant_purge(${created.tenantId})`))),
    '22023',
  );
  await rejects(() => execute(sql`select sandbox_tenant_purge(${created.tenantId})`), '42501');
  await rejects(
    () => app((db) => withTenant(db, ctx(templateId), (tx) => tx.execute(sql`select sandbox_tenant_expire(${created.tenantId})`))),
    '42501',
  );
  await rejects(
    () =>
      app((db) =>
        withTenant(db, ctx(created.tenantId), (tx) =>
          tx.execute(sql`
    insert into channel_accounts (tenant_id,key,kind,name) values (${created.tenantId}, 'test', 'web', '测试')`),
        ),
      ),
    '23514',
  );
  await app((db) =>
    withTenant(db, ctx(templateId), (tx) =>
      tx.execute(sql`
    insert into channel_accounts (tenant_id,key,kind,name) values (${templateId}, 'test', 'web', '测试')`),
    ),
  );
  const rollback = input('sbx-rollback-test');
  await assert.rejects(
    () =>
      app((db) =>
        withNewSandboxTenant(db, rollback, async (tx) => {
          await tx.execute(sql`insert into sandbox_wechat (tenant_id,link_token) values (${currentTenantCtx().tenantId}, 'rollback-link')`);
          throw new Error('rollback');
        }),
      ),
    /rollback/,
  );
  check(
    (await q('select id from tenants where slug=$1', [rollback.slug])).length === 0 &&
      (await q('select id from users where email=$1', [rollback.slug + '@sandbox.invalid'])).length === 0,
    '复制失败，开通身份与数据一起回滚',
  );
  await q(
    `insert into usage_daily (tenant_id,day,model,purpose,calls,cost_milli_cny) values
    ($1,'2026-10-10','mock','chat',2,5),($1,'2026-10-10','mock','draft',3,7),($1,'2026-10-11','mock','chat',1,4)`,
    [created.tenantId],
  );
  await q("insert into quick_replies (tenant_id,title,body,ord) values ($1,'测试','测试',0)", [created.tenantId]);
  // 填入有级联、只追加、付过款与配置外键的数据，验证整租户删除不套保留期规则。
  await q(
    `insert into conversations (tenant_id,id,channel,stage,handed_over,last_seq,state,created_at,updated_at)
    values ($1,'sbx-test','simulator','new',false,1,'{"id":"sbx-test"}',now(),now())`,
    [created.tenantId],
  );
  await q(
    `insert into messages (tenant_id,conversation_id,seq,role,content,at)
    values ($1,'sbx-test',1,'customer','测试',now())`,
    [created.tenantId],
  );
  await q(
    `insert into orders (tenant_id,id,session_id,route_id,status,total_price,created_at,paid_at,data)
    values ($1,'order-test','sbx-test','route-test','paid',1,now(),now(),'{"id":"order-test"}')`,
    [created.tenantId],
  );
  // 12 R4：原件、识别结果随沙箱回收删除，并计入逐表核对。
  await q(
    `insert into attachments (tenant_id,id,conversation_id,channel,source_key,cls,mime,size,sha256,bytes,result)
     values ($1,'att_000000000000000000000001','sbx-test','web','fixture','image','image/png',1,'synthetic',decode('01','hex'),'{}')`,
    [created.tenantId],
  );
  const turnId = randomUUID();
  await q(
    `insert into turn_traces (tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm)
    values ($1,$2,'sbx-test',now(),1,'replied',$3,'{}','[]','{}')`,
    [created.tenantId, turnId, '0'.repeat(64)],
  );
  await q(
    `insert into guard_events (tenant_id,turn_id,ord,guard,action,removed,added)
    values ($1,$2,0,'price','patch','[]','[]')`,
    [created.tenantId, turnId],
  );
  await q(
    `insert into consents (tenant_id,conversation_id,category,decision,notice_version,at)
    values ($1,'sbx-test','health','asked',1,now())`,
    [created.tenantId],
  );
  await q(
    `insert into outbound_sends (tenant_id,conversation_id,channel_msgid,kind,sent_at,status)
    values ($1,'sbx-test','send-test','ai',now(),'accepted')`,
    [created.tenantId],
  );
  await q(
    `insert into jobs (tenant_id,kind,dedupe_key,run_at,max_attempts,payload)
    values ($1,'retention_purge','test',now(),1,'{}')`,
    [created.tenantId],
  );
  await q(
    `insert into catalog_items (tenant_id,kind,code,ord,payload)
    values ($1,'route','route-test',0,'{"id":"route-test"}')`,
    [created.tenantId],
  );
  await q(
    `insert into catalog_item_versions (tenant_id,kind,code,version,payload,source)
    values ($1,'route','route-test',1,'{"id":"route-test"}','backfill')`,
    [created.tenantId],
  );
  await q(
    `insert into sop_versions (tenant_id,status,source,pack_id,sections)
    values ($1,'draft','console','travel','[]')`,
    [created.tenantId],
  );
  // 07 R7/R10：闸表也在删除清单里；造一行证明先删闸、再删它引用的 SOP。
  await q(
    `insert into sop_gate_runs (tenant_id,draft_id,draft_rev,status,mock,prompt_hash,policy_hash,draft_key,baseline_key)
    select tenant_id,id,rev,'done',true,'synthetic','synthetic','synthetic','synthetic'
    from sop_versions where tenant_id=$1 and status='draft'`,
    [created.tenantId],
  );
  // 07 R13：块与向量（kb_vectors 只在装了 vector 扩展的真实 PG 上有）；删除要两张表都清空，且各自数得出行数
  await q(`insert into kb_chunks (tenant_id,source,ref,body,body_hash) values ($1,'route','route-test','正文',$2)`, [
    created.tenantId,
    'a'.repeat(64),
  ]);
  const kbVectorsHere = (await q<{ ok: boolean }>("select to_regclass('public.kb_vectors') is not null as ok"))[0]?.ok === true;
  if (kbVectorsHere) {
    await q(
      `insert into kb_vectors (tenant_id,chunk_id,model,body_hash,embedding)
      select tenant_id,id,'embedding-3',body_hash,$2::halfvec from kb_chunks where tenant_id=$1`,
      [created.tenantId, `[${Array.from({ length: 2048 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`],
    );
  }
  check(kbVectorsHere === real, 'kb_vectors：真实 PG（装了 vector 扩展）上有，PGlite 上没有');
  await q(`insert into privacy_notices (tenant_id,version,body) values ($1,7,'已有版本')`, [created.tenantId]);
  await rejects(() => execute(sql`select public.sandbox_privacy_seed(${created.tenantId}::uuid, '测试')`), '23514');
  await q('delete from privacy_notices where tenant_id=$1', [created.tenantId]);
  await app((db) =>
    withTenant(db, ctx(created.tenantId), (tx) => tx.execute(sql`select public.sandbox_privacy_seed(${created.tenantId}::uuid, '测试')`)),
  );
  const [notice] = await q<{ version: number; body: string; published_by_name: string | null; fresh: boolean }>(
    "select version,body,published_by_name,published_at > now()-interval '1 minute' as fresh from privacy_notices where tenant_id=$1",
    [created.tenantId],
  );
  check(
    notice?.version === 1 && notice.body === '测试' && notice.published_by_name === null && notice.fresh,
    '初始化版本 1、内容原样、无宿主姓名、时刻取 now()',
  );
  await rejects(() => execute(sql`select public.sandbox_privacy_seed(${created.tenantId}::uuid, '替换')`), '23514');
  const [privacyGuc] = rowsOf<{ id: string | null }>(await execute(sql`select current_setting('app.tenant_id', true) as id`));
  check(!privacyGuc?.id, '隐私说明函数不泄漏 GUC');
  const [privacyGrant] = await q<{ ok: boolean }>("select has_table_privilege('agent_app','privacy_notices','INSERT') as ok");
  check(!privacyGrant?.ok, 'agent_app 对隐私说明表仍无 INSERT 权限');
  await execute(sql`select sandbox_tenant_expire(${created.tenantId})`);
  const expired = await resolve();
  check(
    expired.o_status === 'expired' && !expired.o_tenant && !expired.o_user && !expired.o_role && !expired.o_expires_at,
    'resolve expired 不带身份',
  );
  const catalogue = (
    await q<{ table_name: string }>(`select table_name from information_schema.columns
    where table_schema='public' and column_name='tenant_id' order by table_name`)
  ).map((r) => r.table_name);
  const [body] = await q<{ body: string }>("select prosrc as body from pg_proc where oid='sandbox_tenant_purge(uuid)'::regprocedure");
  const deleted = [...body!.body.matchAll(/DELETE FROM public\.(\w+) WHERE tenant_id = p_tenant/g)].map((m) => m[1]!).sort();
  // 07 R13：kb_vectors 只在装了 vector 扩展的库里有，用 to_regclass 判断后动态执行；其余表仍是静态清单
  const dynamic = [...body!.body.matchAll(/EXECUTE 'DELETE FROM public\.(\w+) WHERE tenant_id = \$1'/g)].map((m) => m[1]!).sort();
  check(
    JSON.stringify(dynamic) === JSON.stringify(['kb_vectors']) && body!.body.includes("to_regclass('public.kb_vectors') IS NOT NULL"),
    'purge 动态删除清单只有 kb_vectors，且先用 to_regclass 判断表在不在',
  );
  check(
    JSON.stringify([...deleted, ...dynamic.filter((x) => catalogue.includes(x))].sort()) === JSON.stringify(catalogue),
    'purge 删除清单（静态加库里实有的动态表）与系统目录里每一张带 tenant_id 的表一致',
  );
  const purge = () =>
    app((db) => withTenant(db, ctx(created.tenantId), (tx) => tx.execute(sql`select sandbox_tenant_purge(${created.tenantId}) as counts`)));
  // 删除被静默拦下：复数发现余行，前面删掉的审计、会话与池计数必须一起回滚。
  await q(`create function public.test_keep_reply() returns trigger language plpgsql as $$ begin return null; end $$`);
  await q('create trigger test_keep_reply before delete on quick_replies for each row execute function public.test_keep_reply()');
  await rejects(purge, '23514');
  check(
    (await q('select id from tenants where id=$1', [created.tenantId])).length === 1 &&
      (await q('select * from sandbox_wechat where tenant_id=$1', [created.tenantId])).length === 1,
    '有余行报错，已删除的行回滚',
  );
  await q('drop trigger test_keep_reply on quick_replies');
  await q('drop function public.test_keep_reply()');
  const [counts] = rowsOf<{ counts: Record<string, number> }>(await purge());
  check(
    catalogue.every((t) => typeof counts?.counts[t] === 'number') &&
      counts?.counts.users === 1 &&
      counts.counts.tenants === 1 &&
      counts.counts.usage_daily === 3 &&
      counts.counts.sandbox_wechat === 1 &&
      counts.counts.attachments === 1,
    'purge 返回每表删除数',
  );
  check(
    catalogue.filter((t) => !['channel_accounts', 'channel_inbox'].includes(t)).every((t) => (counts?.counts[t] ?? 0) > 0),
    '全部可写租户表返回正删除数，级联子表没有漏数',
  );
  for (const table of catalogue) {
    check((await q(`select 1 from public.${table} where tenant_id=$1`, [created.tenantId])).length === 0, `purge 后 ${table} 为 0 行`);
  }
  check(
    (await q('select id from users where id=$1', [created.userId])).length === 0 &&
      (await q('select id from tenants where id=$1', [created.tenantId])).length === 0,
    '合成用户与租户删完',
  );
  check((await resolve()).o_status === 'invalid', 'purge 后 resolve invalid');
  const pool = await q<{ day: string; calls: string | number; cost_milli: string | number }>(
    'select day::text,calls,cost_milli from sandbox_pool_daily order by day',
  );
  check(
    pool.some((r) => r.day === '2026-10-10' && Number(r.calls) === 5 && Number(r.cost_milli) === 12) &&
      pool.some((r) => r.day === '2026-10-11' && Number(r.calls) === 1 && Number(r.cost_milli) === 4),
    '用量按天并入池，失败未重复累计',
  );
  check((await q('select id from tenants where id=$1', [templateId])).length === 1, 'standard 模板仍在');

  // 两种驱动都冒烟；授权与 RLS 的验收结论只取真实 PG 的登录角色。
  {
    for (const role of ['agent_owner', 'agent_app', 'agent_platform']) {
      for (const table of tables) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const [grant] = await q<{ ok: boolean }>('select has_table_privilege($1,$2,$3) as ok', [role, table, privilege]);
          const expected =
            role === 'agent_owner' ||
            (role === 'agent_app' &&
              ['SELECT', 'INSERT', 'UPDATE'].includes(privilege) &&
              !(table === 'sandbox_process_epoch' && privilege === 'INSERT'));
          check(grant?.ok === expected, `${role} ${table} ${privilege}`);
        }
      }
      for (const fn of functions) {
        const [grant] = await q<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') as ok", [role, fn]);
        check(grant?.ok === (role !== 'agent_platform'), `${role} ${fn} EXECUTE`);
      }
      const cols = await q<{ column_name: string; ok: boolean }>(
        `select column_name,
        has_column_privilege($1,'tenants',column_name,'UPDATE') as ok from information_schema.columns
        where table_schema='public' and table_name='tenants'`,
        [role],
      );
      for (const c of cols) {
        check(
          c.ok ===
            (role === 'agent_owner' ||
              (role === 'agent_platform' &&
                [
                  'brand',
                  'retention_lead_days',
                  'retention_customer_days',
                  'retention_trace_days',
                  'public_host',
                  'llm_daily_alert_milli',
                ].includes(c.column_name))),
          `${role} tenants.${c.column_name} UPDATE`,
        );
      }
    }
    const other = await create(input('sbx-rls-test'));
    check(rowsOf(await execute(sql`select * from sandbox_wechat`)).length === 0, '空 GUC 看不到 sandbox_wechat');
    check(
      rowsOf(await app((db) => withTenant(db, ctx(templateId), (tx) => tx.execute(sql`select * from sandbox_wechat`)))).length === 0,
      '别的租户读不到沙箱绑定',
    );
    await rejects(() => execute(sql`insert into sandbox_process_epoch (id,epoch) values (1,2)`), '42501');
    await rejects(() => execute(sql`delete from sandbox_process_epoch`), '42501');
    await execute(sql`update sandbox_process_epoch set epoch=epoch+1 where id=1`);
    check(Number((await q<{ epoch: string }>('select epoch from sandbox_process_epoch'))[0]?.epoch) === 1, 'epoch 单行可 UPDATE');
    await rejects(() => execute(sql`insert into sandbox_wechat (tenant_id,link_token) values (${templateId}, 'no-context')`), '42501');
    await app((db) =>
      withTenant(db, ctx(other.tenantId), async (tx) => {
        await tx.execute(sql`select id from sandbox_process_epoch for share`);
        await tx.execute(sql`update sandbox_wechat set external_userid='wmTest', bound_at=now() where tenant_id=${other.tenantId}`);
      }),
    );
  }
  const defs = await q<{
    proname: string;
    owner: string;
    prosecdef: boolean;
    proconfig: string[];
    args: string;
    body: string;
    public_exec: boolean;
  }>(
    `select proname,
    pg_get_userbyid(proowner) as owner, prosecdef, proconfig, pg_get_function_arguments(oid) as args, prosrc as body,
    exists(select 1 from aclexplode(proacl) where grantee=0 and privilege_type='EXECUTE') as public_exec
    from pg_proc where proname = any($1)`,
    [functions.map((f) => f.split('(')[0])],
  );
  check(
    defs.length === functions.length &&
      defs.every(
        (d) =>
          d.owner === 'agent_owner' &&
          d.prosecdef &&
          d.proconfig.includes('search_path=pg_catalog, public, pg_temp') &&
          !d.public_exec &&
          !/timestamp|p_now/i.test(d.args) &&
          !/clock_timestamp|statement_timestamp|current_timestamp/i.test(d.body),
      ),
    '五函数属主、DEFINER、search_path、无 PUBLIC 执行权、无传入时间',
  );
  console.log(`${real ? '真实 PG' : 'PGlite 冒烟'}：函数行为、授权矩阵与 RLS 检查完成`);
  check(
    !fs.readFileSync('drizzle/0008_tenancy_sandbox.sql', 'utf8').match(/clock_timestamp|statement_timestamp|current_timestamp/i),
    '迁移时刻只取 now()',
  );
}

const t = await openTestDb();
try {
  await t.migrate();
  await suite(
    async <T>(text: string, params: unknown[] = []) => (await t.pg.query<T>(text, params)).rows,
    async (fn) => {
      await t.pg.exec('set role agent_app');
      try {
        return await fn(t.db);
      } finally {
        await t.pg.exec('reset role');
      }
    },
    false,
  );
} finally {
  await t.close();
}
if (process.env.PG_TEST_URL) {
  const fixture = await createRealPgFixture(process.env.PG_TEST_URL);
  let connection: Awaited<ReturnType<typeof openDb>> | undefined;
  try {
    connection = await openDb(fixture.urls.app);
    await suite(fixture.query, (fn) => fn(connection!.db), true);
  } finally {
    await connection?.close();
    await fixture.drop();
  }
} else if (process.env.CI === 'true') {
  throw new Error('CI 必须设 PG_TEST_URL：05 RLS 与授权不能跳过');
} else {
  console.log('SANDBOX DB SELFTEST：未设 PG_TEST_URL，真实 PG 的授权与 RLS 待补跑');
}
console.log(`SANDBOX DB SELFTEST PASS: ${passed} 项断言`);
