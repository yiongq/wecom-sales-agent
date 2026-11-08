// 仅接受协调者给的一次性 PG_TEST_URL；只删除本次创建的库和角色，不轮换集群已有角色的密码。
// 连接与迁移经现有 db 层；不在 scripts/ 引入数据库驱动。
import { randomBytes } from 'node:crypto';
import { openDb, rowsOf } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// 只给演练自己的 DDL / 观察查询使用，不接收用户 SQL；动态值均编码成 SQL 字面量。
const literal = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('drill_sql_parameter_invalid');
};
export async function processDatabase(url: string) {
  const suffix = randomBytes(8).toString('hex');
  const name = `failover_${suffix}`;
  const login = `${name}_app`;
  const password = randomBytes(24).toString('hex');
  const createdRoles: string[] = [];
  let createdDatabase = false;
  let db: Awaited<ReturnType<typeof openDb>> | undefined;
  const maintenanceUrl = new URL(url);
  maintenanceUrl.searchParams.set('connect_timeout', '5');
  maintenanceUrl.searchParams.set('options', '-c statement_timeout=10000');
  const admin = await openDb(maintenanceUrl.toString(), { max: 1 });
  async function drop() {
    await db?.close();
    try {
      if (createdDatabase) await admin.db.execute(`drop database "${name}" with (force)`);
      for (const role of createdRoles.toReversed()) await admin.db.execute(`drop role "${role}"`);
    } finally {
      await admin.close();
    }
  }
  try {
    const me = rowsOf<{ rolsuper: boolean }>(await admin.db.execute('select rolsuper from pg_roles where rolname=current_user'))[0];
    if (!me?.rolsuper) throw new Error('drill_requires_disposable_superuser');
    for (const role of ['agent_owner', 'agent_app', 'agent_platform']) {
      const existing = rowsOf<{ rolsuper: boolean; rolbypassrls: boolean }>(
        await admin.db.execute(`select rolsuper, rolbypassrls from pg_roles where rolname=${literal(role)}`),
      )[0];
      if (existing?.rolsuper || existing?.rolbypassrls) throw new Error('drill_existing_role_unsafe');
      if (!existing) {
        await admin.db.execute(`create role ${role} nologin nosuperuser nobypassrls nocreatedb nocreaterole`);
        createdRoles.push(role);
      }
    }
    await admin.db.execute(
      `create role "${login}" login nosuperuser nobypassrls nocreatedb nocreaterole password ${literal(password)} in role agent_app`,
    );
    createdRoles.push(login);
    await admin.db.execute(`create database "${name}" owner agent_owner template template0`);
    createdDatabase = true;
    await admin.db.execute(`revoke connect, temporary on database "${name}" from public`);
    await admin.db.execute(`grant connect on database "${name}" to agent_owner, agent_app, agent_platform`);
    const databaseUrl = new URL(maintenanceUrl);
    databaseUrl.pathname = `/${name}`;
    db = await openDb(databaseUrl.toString(), { max: 1 });
    await db.db.execute('create extension if not exists vector with schema public');
    const ownerUrl = new URL(databaseUrl);
    ownerUrl.searchParams.set('options', '-c role=agent_owner -c statement_timeout=90000');
    await runMigrations(ownerUrl.toString());
    await db.db.execute("insert into tenants (slug,name,pack_id) values ('drill','合成演练','travel')");
    databaseUrl.username = login;
    databaseUrl.password = password;
    databaseUrl.searchParams.set('options', '-c role=agent_app -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000');
    return {
      name,
      appUrl: databaseUrl.toString(),
      query: async <R>(sql: string, values: unknown[] = []): Promise<R[]> =>
        rowsOf<R>(await db!.db.execute(sql.replace(/\$(\d+)\b/g, (_match, index: string) => literal(values[Number(index) - 1])))),
      drop,
    };
  } catch {
    try {
      await drop();
    } catch {
      throw new Error(`drill_database_setup_failed_cleanup_failed:${name}`);
    }
    throw new Error('drill_database_setup_failed');
  }
}
