// PGlite 测试库：进程内的 Postgres，不需要 Docker。只给 *.selftest.ts 与 eval/run.ts 用（lint 守着）。
// 与生产一致的地方：三个角色都在，库的属主是 agent_owner，迁移以 agent_owner 执行，所以表和函数的属主、
// 默认权限、授权都和真实库相同。不一致的地方：PGlite 以超级用户连接，默认绕过 RLS；RLS 与授权的结论
// 以真实 Postgres 上的套件为准（spec R13），这里要看 agent_app 视角时自己 SET ROLE。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { initConfig, type ConfigDeps } from '../config/source.js';
import { imageCode, importConfig } from '../config/transfer.js';
import { assertPgUrl, countingLogger, registerDriver, resetSessionTenant, type Db, type TenantLock } from './client.js';
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

/**
 * 打开一个 PGlite 测试库。默认在内存里；给 dataDir 就落在这个目录，进程退出（含被杀）后再打开还在——
 * 会话存储的「重启」自测靠它在前后两个子进程之间交接同一个库（同一时刻只能有一个进程打开它）
 */
export async function openTestDb(opts: { dataDir?: string } = {}): Promise<TestDb> {
  const fresh = !opts.dataDir || !fs.existsSync(path.join(opts.dataDir, 'PG_VERSION'));
  const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  const dbName = (await pg.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
  // 口令无所谓：PGlite 不走网络认证。属性与 deploy/db-init 里的角色一致；再打开的库里角色已经在了
  if (fresh) {
    await pg.exec(`
      CREATE ROLE agent_owner    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
      CREATE ROLE agent_app      LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      ALTER DATABASE "${dbName}" OWNER TO agent_owner;
    `);
  }
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

// ---------------- 装成会话存储（02 plan 第 5 步） ----------------

/** 落库经的那条「连接」上的故障注入（只对 installPgSessionStore 给出的 db 生效） */
export interface StoreFaults {
  /** 设了就让借连接抛它：模拟连不上、PG 不可写 */
  acquire: Error | null;
  /** 设了就先等它再借连接：模拟落库变慢、暂停（不占着 PGlite 的连接） */
  gate: Promise<void> | null;
  /** 设了就让下一次归还连接抛它（只一次）：事务已经提交，调用方却收到错误——模拟 COMMIT 之后回包丢失 */
  releaseOnce: Error | null;
}

export interface PgStoreFixture {
  /** initSessionStore 的依赖。db 是同一个 PGlite 上另开的 drizzle 实例：会话存储的读写都经它，故障与计数只管它 */
  deps: { db: Db; tenantId: string; varDir: string };
  faults: StoreFaults;
  /** 经这个 db 发出的查询条数（不进 queryCount() 的全局计数）与借连接次数 */
  stats: { queries: number; acquires: number };
}

/** 带 SQLSTATE 的假驱动错误（连接类用 08006，数据类用 23514 之类） */
export function fakeDbError(code: string, message = `模拟的驱动错误 ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * PGlite 上的 db 存储（只给自测与 eval/run.ts）：建好租户（已有就复用）、这条连接切成 agent_app，返回 SessionStoreDeps。
 * src/db/ 不 import store：由调用方 `await initSessionStore(fixture.deps)` 才算装上
 */
export async function installPgSessionStore(t: TestDb, opts: { slug?: string; varDir: string }): Promise<PgStoreFixture> {
  const slug = opts.slug ?? 'demo';
  await t.pg.exec('RESET ROLE'); // 建租户是平台的事，以超级用户做
  await t.pg.query(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') on conflict (slug) do nothing`, [slug]);
  const tenantId = (await t.pg.query<{ id: string }>('select id from tenants where slug = $1', [slug])).rows[0]!.id;
  await t.pg.exec('SET ROLE agent_app');
  const stats = { queries: 0, acquires: 0 };
  const faults: StoreFaults = { acquire: null, gate: null, releaseOnce: null };
  const db: Db = drizzle(t.pg, {
    schema,
    logger: {
      logQuery() {
        stats.queries++;
      },
    },
  });
  registerDriver(db, {
    acquire: async () => {
      stats.acquires++;
      if (faults.gate) await faults.gate;
      if (faults.acquire) throw faults.acquire;
      return {
        db,
        release: async (destroy) => {
          if (destroy) await resetSessionTenant(db);
          const err = faults.releaseOnce;
          faults.releaseOnce = null;
          if (err) throw err;
        },
      };
    },
  });
  return { deps: { db, tenantId, varDir: opts.varDir }, faults, stats };
}

/**
 * 真实 Postgres 上「COMMIT 之后回包丢掉」的连接（02 验收 8）：dropCommitReply 大于 0 时，下一条 COMMIT 照常发到库里执行，
 * 之后这条连接上的一切都当作断线（抛不带 code 的「连接意外中断」，与 node-postgres 一样），归还时销毁
 */
export async function openFlakyDb(url: string): Promise<{ db: Db; close(): Promise<void>; faults: { dropCommitReply: number } }> {
  assertPgUrl(url);
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  pool.on('error', () => {});
  pool.on('connect', (c) => c.on('error', () => {}));
  const faults = { dropCommitReply: 0 };
  const db: Db = drizzleNodePg(pool, { schema, logger: countingLogger });
  const lost = (): Error => new Error('Connection terminated unexpectedly');
  registerDriver(db, {
    async acquire() {
      const client = await pool.connect();
      let dropped = false;
      // drizzle 拿到的不是 Pool 时只调 query：包一层，COMMIT 之后让回包「丢掉」
      const conn = {
        async query(config: { text?: string } | string, values?: unknown[]) {
          if (dropped) throw lost();
          const text = typeof config === 'string' ? config : config.text;
          if (faults.dropCommitReply > 0 && text?.trim().toLowerCase() === 'commit') {
            faults.dropCommitReply--;
            await client.query(config as never, values as never);
            dropped = true;
            throw lost();
          }
          return client.query(config as never, values as never);
        },
      };
      return {
        db: drizzleNodePg(conn as never, { schema, logger: countingLogger }),
        release: async (destroy) => client.release(destroy || dropped),
      };
    },
  });
  return { db, close: () => pool.end(), faults };
}
