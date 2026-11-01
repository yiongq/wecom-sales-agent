// 15 R6：真实权限角色 + FORCE RLS + SECURITY DEFINER 投影，不挂占位 HTTP handler。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { openTestDb, createRealPgFixture } from './testing.js';
import { openDb, withTenant, rowsOf, type Db, type Tx } from './client.js';
import { authSessionCreate } from './repo/auth.js';
import { runMigrations } from './migrate.js';

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
interface Projection {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  disabled: boolean;
}
const actor = { kind: 'system' as const, userId: null, name: null, ip: null };
async function suite(db: Db, query: Query, label: string): Promise<void> {
  const a = randomUUID();
  const b = randomUUID();
  await query("insert into tenants(id,slug,name,pack_id) values ($1,$3,'合成甲','industrial'),($2,$4,'合成乙','industrial')", [
    a,
    b,
    `members-a-${label}`,
    `members-b-${label}`,
  ]);
  const users = new Map<string, { id: string; token: Buffer }>();
  for (const role of ['owner', 'admin', 'supervisor', 'agent', 'viewer']) {
    const id = randomUUID();
    const token = randomBytes(32);
    users.set(role, { id, token });
    await query("insert into users(id,email,display_name,password_hash) values ($1,$2,$3,'synthetic-non-login-hash')", [
      id,
      `${role}@erp.example.test`,
      role,
    ]);
    await query('insert into memberships(tenant_id,user_id,role) values ($1,$2,$3)', [a, id, role]);
    await authSessionCreate(db, { tenantId: a, tokenHash: token, userId: id, now: new Date(), ip: null, userAgent: null });
  }
  const project = (tx: Tx, tenant: string, hash: string) =>
    tx.execute(sql`select * from public.console_members_read(${tenant}::uuid,${hash})`).then(rowsOf<Projection>);
  const read = (role: string, tenant = a) =>
    withTenant(db, { tenantId: tenant, actor }, (tx) => project(tx, tenant, users.get(role)!.token.toString('hex')), { readOnly: true });
  for (const role of ['owner', 'admin']) {
    const rows = await read(role);
    assert.equal(rows.length, 5);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['disabled', 'display_name', 'email', 'role', 'user_id']);
  }
  for (const role of ['supervisor', 'agent', 'viewer']) assert.deepEqual(await read(role), []);
  assert.deepEqual(await read('owner', b), [], 'other tenant cannot reuse token');
  await assert.rejects(withTenant(db, { tenantId: a, actor }, (tx) => project(tx, b, users.get('owner')!.token.toString('hex'))));
  const canTemp = (await query<{ ok: boolean }>("select has_database_privilege('agent_app',current_database(),'TEMP') ok"))[0]!.ok;
  if (!canTemp)
    await assert.rejects(
      withTenant(db, { tenantId: a, actor }, (tx) => tx.execute(sql`create temporary table users(id uuid) on commit drop`)),
    );
  await withTenant(db, { tenantId: a, actor }, async (tx) => {
    assert.deepEqual(await project(tx, a, 'not-a-hash'), []);
    if (canTemp) await tx.execute(sql`create temporary table users(id uuid) on commit drop`);
    assert.equal((await project(tx, a, users.get('owner')!.token.toString('hex'))).length, 5, 'temp schema cannot shadow public tables');
    assert.equal(rowsOf<{ id: string }>(await tx.execute(sql`select current_setting('app.tenant_id') as id`))[0]!.id, a);
  });
  for (const statement of [
    sql`select * from public.users`,
    sql`select * from public.memberships`,
    sql`select * from public.auth_sessions`,
  ]) {
    await assert.rejects(withTenant(db, { tenantId: a, actor }, (tx) => tx.execute(statement)));
  }
  await query("update memberships set role='agent' where tenant_id=$1 and user_id=$2", [a, users.get('owner')!.id]);
  assert.deepEqual(await read('owner'), [], 'role downgrade immediate');
  await query("update memberships set role='owner' where tenant_id=$1 and user_id=$2", [a, users.get('owner')!.id]);
  const admin = users.get('admin')!;
  for (const column of ['expires_at', 'last_seen_at']) {
    await query(`update auth_sessions set ${column}=now()-interval '13 hours' where token_hash=$1`, [admin.token]);
    assert.deepEqual(await read('admin'), [], column);
    await query("update auth_sessions set expires_at=now()+interval '24 hours',last_seen_at=now() where token_hash=$1", [admin.token]);
  }
  await query('update users set disabled_at=now() where id=$1', [admin.id]);
  assert.deepEqual(await read('admin'), []);
  assert.equal((await read('owner')).find((r) => r.user_id === admin.id)?.disabled, true, 'disabled member is still projected');
  await query('update users set disabled_at=null where id=$1', [admin.id]);
  await query('delete from memberships where tenant_id=$1 and user_id=$2', [a, admin.id]);
  assert.deepEqual(await read('admin'), [], 'removed membership');
  await query("update tenants set status='suspended' where id=$1", [a]);
  assert.deepEqual(await read('owner'), []);
  await query("update tenants set status='active' where id=$1", [a]);
  assert.equal((await read('owner')).length, 4);
  await query("update tenants set kind='sandbox',expires_at=now()+interval '1 day',template_tenant_id=$2 where id=$1", [a, b]);
  assert.deepEqual(await read('owner'), [], 'sandbox refused even with owner session');
  await query("update tenants set kind='standard',expires_at=null,template_tenant_id=null where id=$1", [a]);

  await query('delete from auth_sessions where token_hash=$1', [users.get('owner')!.token]);
  assert.deepEqual(await read('owner'), [], 'revoked token');
  const grants = (
    await query<{ app: boolean; platform: boolean; public_execute: boolean; force: boolean; owner: string; path: string[] }>(`select
    has_function_privilege('agent_app','public.console_members_read(uuid,text)','EXECUTE') app,
    has_function_privilege('agent_platform','public.console_members_read(uuid,text)','EXECUTE') platform,
    exists(select 1 from aclexplode(p.proacl) where grantee=0 and privilege_type='EXECUTE') public_execute,
    (select relforcerowsecurity from pg_class where oid='public.memberships'::regclass) force,
    pg_get_userbyid(p.proowner) owner,p.proconfig path from pg_proc p where p.oid='public.console_members_read(uuid,text)'::regprocedure`)
  )[0]!;
  assert.deepEqual(grants, {
    app: true,
    platform: false,
    public_execute: false,
    force: true,
    owner: 'agent_owner',
    path: ['search_path=pg_catalog, public, pg_temp'],
  });
  console.log(
    `MEMBERS ${label} PASS: owner/admin; 3 denied roles; tenant/token/expiry/disable/downgrade/removal/revoke; temp schema; RLS and least privilege`,
  );
}
const t = await openTestDb();
try {
  await t.pg.exec('SET ROLE agent_app');
  await suite(
    t.db,
    <T>(text: string, params?: unknown[]) =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(text, params)).rows;
      }),
    'pglite',
  );
} finally {
  await t.close();
}
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL);
  const app = await openDb(fx.urls.app);
  try {
    await runMigrations(fx.urls.owner);
    await suite(app.db, fx.query, 'pg');
  } finally {
    await app.close();
    await fx.drop();
  }
} else if (process.env.CI === 'true') throw new Error('members permission suite requires PG_TEST_URL');
else console.log('MEMBERS: real PG not run (PG_TEST_URL missing)');
