// 数据库连接、租户上下文与租户锁（docs/architecture/01-pg-config-console/spec.md「数据库 · withTenant」）。
// 全仓只有 src/db/** 能 import pg / drizzle-orm / PGlite；租户 GUC 的名字也只出现在本文件和迁移 SQL 里（lint 守着）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { Logger } from 'drizzle-orm/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

export type Schema = typeof schema;
/** 两个驱动共同的基类：node-postgres 与 PGlite 都满足 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
// PgTransaction 的第三个类型参数默认是空 schema（PgDatabase 的默认才是推导出来的），要显式给
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface TenantCtx {
  tenantId: string;
  actor: { kind: 'user' | 'system' | 'platform'; userId: string | null; name: string | null; ip: string | null };
}

// ---------------- 查询计数 ----------------

let queries = 0;
/** 两个驱动共用的 drizzle logger，只计数不打印 */
export const countingLogger: Logger = {
  logQuery() {
    queries++;
  },
};
/** 进程启动以来经 drizzle 发出的查询条数，供测试用（「每轮不查库」） */
export function queryCount(): number {
  return queries;
}

// ---------------- 连接 ----------------

/** withTenant 借一条连接、用完归还；destroy 为 true 时这条连接不再复用 */
export interface DbConn {
  db: Db;
  release(destroy: boolean): Promise<void>;
}
interface Driver {
  acquire(): Promise<DbConn>;
}
const drivers = new WeakMap<Db, Driver>();

/** 只给本目录用：openDb 与 testing.ts 的 openTestDb 登记各自怎么借连接 */
export function registerDriver(db: Db, driver: Driver): void {
  drivers.set(db, driver);
}

export function assertPgUrl(url: string): void {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('数据库连接串只接受 postgres:// 或 postgresql://');
}

/** 连接串脱敏：去掉口令，只留用户、主机和库名，供日志与报错用 */
export function redactUrl(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:/@]*):[^@]*@/, '$1:***@');
}

/** 只接受 postgres:// 与 postgresql://；PGlite 只经 testing.ts 进来。打开时先连一次，连不上当场抛 */
export async function openDb(url: string, opts: { max?: number } = {}): Promise<{ db: Db; close(): Promise<void> }> {
  assertPgUrl(url);
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 });
  // 空闲连接断开时 Pool 会发 error 事件，没人监听会让进程崩掉；下次借连接时 Pool 自己会新建
  pool.on('error', (err) => console.warn(`[db] 空闲连接出错（${redactUrl(url)}）：${err.message}`));
  // 借出去的连接 Pool 不再替它监听：withTenant 进行中库重启、连接被踢、事务空闲超时，连接照样发 error 事件，
  // 没人监听就是整个进程崩掉。挂一个常驻监听，让出错只落在正在跑的那条查询上（它会 reject），归还时 Pool 丢弃这条连接
  pool.on('connect', (client) => {
    client.on('error', (err) => console.warn(`[db] 连接出错（${redactUrl(url)}）：${err.message}`));
  });
  const probe = await pool.connect().catch(async (err: unknown) => {
    await pool.end().catch(() => {});
    throw err;
  });
  probe.release();
  const db: Db = drizzle(pool, { schema, logger: countingLogger });
  // 每条池内连接各自一个 drizzle 实例：drizzle 拿到的不是 Pool 时不会自己 release，归还与销毁由 withTenant 决定
  const perClient = new WeakMap<pg.PoolClient, Db>();
  registerDriver(db, {
    async acquire() {
      const client = await pool.connect();
      let conn = perClient.get(client);
      if (!conn) {
        conn = drizzle(client, { schema, logger: countingLogger });
        perClient.set(client, conn);
      }
      return {
        db: conn,
        release: async (destroy) => client.release(destroy),
      };
    },
  });
  return { db, close: () => pool.end() };
}

/** 两个驱动的 execute 结果都带 rows */
export function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error('execute 的结果里没有 rows');
  return rows as T[];
}

// ---------------- 租户上下文 ----------------

const tenantStore = new AsyncLocalStorage<TenantCtx>();

/**
 * 租户数据的唯一入口：BEGIN → 断言会话级的租户 GUC 为空（不为空说明有人在会话级 SET 过，销毁这条连接并抛错）
 * → 事务内 set_config → fn → COMMIT；fn 抛错就 ROLLBACK。ctx 经 AsyncLocalStorage 传给 fn 里调用的仓储与审计函数。
 * 在 withTenant 里再嵌套 withTenant 会抛错，不管租户是否相同。
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantCtx,
  fn: (tx: Tx) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read'; readOnly?: boolean } = {},
): Promise<T> {
  if (tenantStore.getStore()) throw new Error('withTenant 不能嵌套');
  const driver = drivers.get(db);
  if (!driver) throw new Error('这个 Db 不是经 openDb / openTestDb 打开的');
  const config =
    opts.isolation || opts.readOnly
      ? { isolationLevel: opts.isolation, accessMode: opts.readOnly ? ('read only' as const) : undefined }
      : undefined;
  const conn = await driver.acquire();
  let leaked = false;
  try {
    return await conn.db.transaction(async (tx) => {
      // 事务里还没设过，读到的就是会话级的值。事务级 set_config 在提交后会留下一个空串，所以空串也算「空」
      const [row] = rowsOf<{ v: string | null }>(await tx.execute(sql`select current_setting('app.tenant_id', true) as v`));
      if (row?.v) {
        leaked = true;
        throw new Error('这条连接上有会话级的 app.tenant_id（有人在事务外 SET 过），已销毁这条连接');
      }
      await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      return tenantStore.run(ctx, () => fn(tx));
    }, config);
  } finally {
    await conn.release(leaked);
  }
}

/** 单连接驱动（PGlite）没法销毁连接，只能清掉会话级的租户设置，相当于换了一条干净连接 */
export async function resetSessionTenant(db: Db): Promise<void> {
  await db.execute(sql`reset app.tenant_id`);
}

/** 在 withTenant 之外调用即抛 */
export function currentTenantCtx(): TenantCtx {
  const ctx = tenantStore.getStore();
  if (!ctx) throw new Error('不在 withTenant 里：没有租户上下文');
  return ctx;
}

/** 配置写锁：同一租户的 SOP 与产品库写入串行。每个配置写函数的第一条语句 */
export async function lockTenantConfig(tx: Tx): Promise<void> {
  const { tenantId } = currentTenantCtx();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cfg:${tenantId}`}, 0))`);
}

// ---------------- 租户锁 ----------------

export interface TenantLock {
  /** 锁连接断开时回调；release 之后不再回调 */
  onLost(cb: () => void): void;
  /** 重连并重取：'ok' 恢复持锁；'held_by_other' 连上了但锁在别人手里；'unreachable' 还连不上 */
  reacquire(): Promise<'ok' | 'held_by_other' | 'unreachable'>;
  release(): Promise<void>;
}

/**
 * 在一条专用连接上执行 pg_try_advisory_lock；拿不到返回 null（锁在别人手里）。
 * 连接开 TCP keepalive（默认 10 秒）：对端消失时尽快收到 error 事件，而不是等到下一次查询。
 */
export async function holdTenantLock(url: string, tenantId: string, opts: { keepAliveMs?: number } = {}): Promise<TenantLock | null> {
  assertPgUrl(url);
  const key = `wecom-sales-agent:${tenantId}`;
  const connect = async (): Promise<pg.Client> => {
    // 连接超时要比 5 秒一次的重取间隔短，免得一次重取拖过下一次
    const c = new pg.Client({
      connectionString: url,
      keepAlive: true,
      keepAliveInitialDelayMillis: opts.keepAliveMs ?? 10_000,
      connectionTimeoutMillis: 4_000,
    });
    // 连接失败或之后断开都会发 error；先挂上监听，免得未处理的 error 事件让进程崩掉
    c.on('error', () => {});
    await c.connect();
    return c;
  };
  const tryLock = async (c: pg.Client): Promise<boolean> =>
    (await c.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [key])).rows[0]?.ok === true;
  const drop = (c: pg.Client): void => {
    c.removeAllListeners('end');
    void c.end().catch(() => {});
  };

  let client = await connect();
  // 查询本身出错（连接刚建好就断了）是连不上，不是锁在别人手里：照原样抛给调用方
  const got = await tryLock(client).catch((err: unknown) => {
    drop(client);
    throw err;
  });
  if (!got) {
    drop(client);
    return null;
  }
  const lostCallbacks: (() => void)[] = [];
  let released = false;
  let lost = false;
  let pending: Promise<'ok' | 'held_by_other' | 'unreachable'> | null = null;
  const watch = (c: pg.Client): void => {
    let fired = false;
    const onLost = (): void => {
      if (fired || released || c !== client) return;
      fired = true;
      lost = true;
      for (const cb of lostCallbacks) cb();
    };
    c.on('error', onLost);
    c.on('end', onLost);
  };
  watch(client);

  const attempt = async (): Promise<'ok' | 'held_by_other' | 'unreachable'> => {
    let next: pg.Client;
    try {
      next = await connect();
    } catch {
      return 'unreachable';
    }
    let ok: boolean;
    try {
      ok = await tryLock(next);
    } catch {
      drop(next);
      return 'unreachable';
    }
    // 重连期间已经 release：刚拿到的锁随连接关闭一起放掉
    if (released || !ok) {
      drop(next);
      return released ? 'unreachable' : 'held_by_other';
    }
    const old = client;
    client = next;
    lost = false;
    watch(next);
    drop(old);
    return 'ok';
  };

  return {
    onLost(cb) {
      lostCallbacks.push(cb);
    },
    reacquire() {
      if (released) return Promise.reject(new Error('租户锁已释放'));
      // 锁连接还好好的：什么都不用做。新开一条会话去 try_lock 会拿到 false，把自己误判成「锁在别人手里」
      if (!lost) return Promise.resolve('ok');
      // 单飞：重取进行中再被调用，等同一个结果，不会两条连接互相把对方判成「别人持锁」
      pending ??= attempt().finally(() => {
        pending = null;
      });
      return pending;
    },
    async release() {
      if (released) return;
      released = true;
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {});
      drop(client);
    },
  };
}
