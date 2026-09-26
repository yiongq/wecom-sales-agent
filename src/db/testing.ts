// PGlite 测试库：进程内的 Postgres，不需要 Docker。只给 *.selftest.ts 与 eval/run.ts 用（lint 守着）。
// 与生产一致的地方：三个角色都在，库的属主是 agent_owner，迁移以 agent_owner 执行，所以表和函数的属主、
// 默认权限、授权都和真实库相同。不一致的地方：PGlite 以超级用户连接，默认绕过 RLS；RLS 与授权的结论
// 以真实 Postgres 上的套件为准（spec R13），这里要看 agent_app 视角时自己 SET ROLE。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { initConfig, type ConfigDeps } from '../config/source.js';
import { imageCode, importConfig } from '../config/transfer.js';
import { countingLogger, registerDriver, resetSessionTenant, type Db, type TenantLock } from './client.js';
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

// ---------------- 装成配置源 ----------------

/** 可控的假租户锁：lose() 模拟锁连接断开，next 决定下一次 reacquire 的结果 */
export interface FakeLock extends TenantLock {
  lose(): void;
  next: 'ok' | 'held_by_other' | 'unreachable';
  released: boolean;
  reacquired: number;
}
export function fakeLock(): FakeLock {
  const lost: (() => void)[] = [];
  const lock: FakeLock = {
    next: 'ok',
    released: false,
    reacquired: 0,
    onLost: (cb) => void lost.push(cb),
    lose: () => {
      for (const cb of lost) cb();
    },
    reacquire: async () => {
      lock.reacquired++;
      return lock.next;
    },
    release: async () => {
      lock.released = true;
    },
  };
  return lock;
}

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

/** 生产依赖的测试版：库是 PGlite，锁是假的，其余与生产相同。逐项可以替换 */
export function testConfigDeps(t: Pick<TestDb, 'db'>, over: Partial<ConfigDeps> = {}): ConfigDeps {
  const code = imageCode();
  return {
    db: t.db,
    tenantSlug: 'demo',
    lock: async () => fakeLock(),
    imageSop: fs.readFileSync(path.join(DATA_DIR, 'sop.md'), 'utf8'),
    ...code,
    gracefulExit: () => {},
    imageDataDir: DATA_DIR,
    ...over,
  };
}

/**
 * 建租户、以 agent_app 身份把 data/（或 dataDir）导入，再装成配置源。之后这条 PGlite 连接一直是 agent_app：
 * 运行时的读写都受 RLS 约束，与生产相同。要以超级用户动库时自己 RESET ROLE
 */
export async function installSeededConfig(
  t: TestDb,
  opts: { slug?: string; dataDir?: string; deps?: Partial<ConfigDeps> } = {},
): Promise<ConfigDeps> {
  const slug = opts.slug ?? 'demo';
  await t.pg.exec('RESET ROLE'); // 建租户是平台的事，以超级用户做
  await t.pg.query(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') on conflict (slug) do nothing`, [slug]);
  await t.pg.exec('SET ROLE agent_app');
  const deps = testConfigDeps(t, { tenantSlug: slug, ...opts.deps });
  const r = await importConfig({
    db: t.db,
    tenantSlug: slug,
    dataDir: opts.dataDir ?? DATA_DIR,
    imageSop: deps.imageSop,
    lock: async () => fakeLock(),
  });
  if (r.code !== 0) throw new Error(`导入失败（${r.code}）：${r.message}`);
  await initConfig(deps);
  return deps;
}
