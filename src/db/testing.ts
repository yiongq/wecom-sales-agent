// PGlite 测试库：进程内的 Postgres，不需要 Docker。只给 *.selftest.ts 与 eval/run.ts 用（lint 守着）。
// 与生产一致的地方：三个角色都在，库的属主是 agent_owner，迁移以 agent_owner 执行，所以表和函数的属主、
// 默认权限、授权都和真实库相同。不一致的地方：PGlite 以超级用户连接，默认绕过 RLS；RLS 与授权的结论
// 以真实 Postgres 上的套件为准（spec R13），这里要看 agent_app 视角时自己 SET ROLE。
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { countingLogger, registerDriver, resetSessionTenant, type Db } from './client.js';
import { MIGRATIONS_DIR } from './migrate.js';
import * as schema from './schema.js';

export interface TestDb {
  db: Db;
  /** 底层 PGlite，供自测直接发 SQL、SET ROLE */
  pg: PGlite;
  /** 以 agent_owner 跑一遍迁移；openTestDb 已跑过，再跑应当什么都不做 */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  const dbName = (await pg.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
  // 口令无所谓：PGlite 不走网络认证。属性与 deploy/db-init 里的角色一致
  await pg.exec(`
    CREATE ROLE agent_owner    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE agent_app      LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    ALTER DATABASE "${dbName}" OWNER TO agent_owner;
  `);
  const pglite = drizzle(pg, { schema, logger: countingLogger });
  const db: Db = pglite;
  // 单连接：借出的永远是同一个，「销毁」退化为清掉会话级的租户设置
  registerDriver(db, {
    acquire: async () => ({
      db,
      release: async (destroy) => {
        if (destroy) await resetSessionTenant(db);
      },
    }),
  });
  const runMigrations = async (): Promise<void> => {
    await pg.exec('SET ROLE agent_owner');
    try {
      await migrate(pglite, { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await pg.exec('RESET ROLE');
    }
  };
  await runMigrations();
  return { db, pg, migrate: runMigrations, close: () => pg.close() };
}
