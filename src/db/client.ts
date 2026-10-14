import { assertSandboxRunning } from '../tenancy/sandbox/lifecycle.js';
import { runtimeOf, scopedRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { todayIso } from '../env.js';
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
  /** 丢锁时立即断开当前连接，让 PostgreSQL 回滚正在执行的事务。 */
  abort?(): void;
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

/**
 * 连接串脱敏：去掉口令，只留用户、主机和库名，供日志与报错用。按 node-postgres 的解析方式抹：它用 URL 规则，
 * 主机前的部分在最后一个 @ 处切开（口令里没转义的 @ 照样连得上），查询参数里的 password 同样认。
 * URL 解析不了（口令里有裸的 / ? # 之类），或解析出来没有用户信息、后面却还有 @（口令像「2024#x」时会被当成端口），
 * 宁可多抹：从第一个冒号一直抹到整串最后一个 @
 */
export function redactUrl(url: string): string {
  const u = URL.canParse(url) ? new URL(url) : null;
  if (!u || (!u.username && !u.password && url.includes('@'))) {
    return url.replace(/^(postgres(?:ql)?:\/\/[^:/?#]*):.*@/s, '$1:***@').replace(/([?&]password=)[^&#]*/gi, '$1***');
  }
  if (u.password) u.password = '***';
  for (const k of new Set(u.searchParams.keys())) if (k.toLowerCase() === 'password') u.searchParams.set(k, '***');
  return u.href;
}

/** 只接受 postgres:// 与 postgresql://；PGlite 只经 testing.ts 进来。打开时先连一次，连不上当场抛 */
export async function openDb(url: string, opts: { max?: number } = {}): Promise<{ db: Db; close(): Promise<void> }> {
  assertPgUrl(url);
  assertSandboxRunning();
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 });
  // 根 Db 的 execute / transaction 也不得在置停后借连接（不仅是 withTenant）。
  if (process.env.APP_ROLE === 'sandbox') {
    const connect = pool.connect.bind(pool);
    pool.connect = ((...args: unknown[]) => {
      assertSandboxRunning();
      return Reflect.apply(connect, pool, args);
    }) as typeof pool.connect;
  }

  // EventEmitter 不捕获注册时 ALS；实例日志回调执行时 exit，租户锁通知由订阅者显式进入所属 rt。
  // 空闲连接断开时 Pool 会发 error 事件，没人监听会让进程崩掉；下次借连接时 Pool 自己会新建
  withoutTenantScope(() =>
    pool.on('error', (err) => withoutTenantScope(() => console.warn(`[db] 空闲连接出错（${redactUrl(url)}）：${err.message}`))),
  );
  // 借出去的连接 Pool 不再替它监听：withTenant 进行中库重启、连接被踢、事务空闲超时，连接照样发 error 事件，
  // 没人监听就是整个进程崩掉。挂一个常驻监听，让出错只落在正在跑的那条查询上（它会 reject），归还时 Pool 丢弃这条连接
  withoutTenantScope(() =>
    pool.on('connect', (client) => {
      // 在实际 SQL 发送边界拦截，覆盖 drizzle 自动发出的 COMMIT；ROLLBACK 仍允许收尾。
      const query = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === 'string' ? first : (first as { text?: string })?.text;
        if (!/^rollback\b/i.test(text ?? '')) assertSandboxRunning();
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
      withoutTenantScope(() =>
        client.on('error', (err) => withoutTenantScope(() => console.warn(`[db] 连接出错（${redactUrl(url)}）：${err.message}`))),
      );
    }),
  );
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
      assertSandboxRunning();
      const client = await pool.connect();
      try {
        assertSandboxRunning();
      } catch (error) {
        client.release(true);
        throw error;
      }
      let conn = perClient.get(client);
      if (!conn) {
        conn = drizzle(client, { schema, logger: countingLogger });
        perClient.set(client, conn);
      }
      let released = false;
      const release = (destroy: boolean): void => {
        if (released) return;
        released = true;
        client.release(destroy);
      };
      return {
        db: conn,
        release: async (destroy) => release(destroy),
        abort: () => release(true),
      };
    },
  });
  return { db, close: () => pool.end() };
}

/** 库的 server_encoding（initConfig 第 1 步要求 UTF8）。连不上时抛连接错误 */
export async function serverEncoding(db: Db): Promise<string> {
  const [row] = rowsOf<{ server_encoding: string }>(await db.execute(sql`show server_encoding`));
  return row?.server_encoding ?? '';
}

/** 唯一约束冲突（23505）：两个驱动的错误都带 code，经 drizzle 的包在 cause 里。可选地只认某个约束 */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  for (let x: unknown = e; x && typeof x === 'object'; x = (x as { cause?: unknown }).cause) {
    const err = x as { code?: unknown; constraint?: unknown };
    if (err.code === '23505') return constraint === undefined || err.constraint === constraint;
  }
  return false;
}

/**
 * 驱动错误的错误码与约束名：SQLSTATE（如 23514）或网络层的 errno 码（如 ECONNREFUSED），沿 cause 链找第一个带 code 的；
 * 两个驱动的错误都带 code / constraint，经 drizzle 的包在 cause 里。没有就是 null（node-postgres 的「连接意外中断」不带 code）
 */
export function pgErrorOf(e: unknown): { code: string | null; constraint: string | null } {
  for (let x: unknown = e; x && typeof x === 'object'; x = (x as { cause?: unknown }).cause) {
    const err = x as { code?: unknown; constraint?: unknown };
    if (typeof err.code === 'string' && err.code) {
      return { code: err.code, constraint: typeof err.constraint === 'string' && err.constraint ? err.constraint : null };
    }
  }
  return { code: null, constraint: null };
}

/**
 * 在事务里开一个存档点跑 fn（02 spec「identity map 与写入」第 6 步的 SAVEPOINT telemetry）：fn 成功就释放存档点；
 * fn 抛错就回到存档点、返回 { ok: false, error }，事务照常往下走。回到存档点本身失败（连接断了、事务已经坏了）才抛。
 * name 只能是小写字母与下划线
 */
export async function trySavepoint(tx: Tx, name: string, fn: () => Promise<void>): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!/^[a-z_]{1,32}$/.test(name)) throw new Error(`存档点名不合法：${name}`);
  const sp = sql.identifier(name);
  await tx.execute(sql`savepoint ${sp}`);
  try {
    await fn();
  } catch (error) {
    await tx.execute(sql`rollback to savepoint ${sp}`);
    return { ok: false, error };
  }
  await tx.execute(sql`release savepoint ${sp}`);
  return { ok: true };
}

/** 两个驱动的 execute 结果都带 rows */
export function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error('execute 的结果里没有 rows');
  return rows as T[];
}

// ---------------- 租户上下文 ----------------

/** 05 R2：实例 epoch 的共享行锁持有到事务提交，bigint 不转成不精确的 JS number。 */
export async function fenceSandboxEpoch(tx: Tx, epoch: string): Promise<void> {
  assertSandboxRunning();
  const [row] = rowsOf<{ epoch: string | number }>(
    await tx.execute(sql`select epoch from public.sandbox_process_epoch where id = 1 for share`),
  );
  if (!row || String(row.epoch) !== epoch) throw new Error('sandbox_epoch_stale');
}

/** 供实例级 cursor / 名额状态以及开通前置写使用，同样经过停止闸与事务收尾检查。 */
export function withSandboxEpoch<T>(db: Db, epoch: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tenantTransaction(db, async (tx) => {
    await fenceSandboxEpoch(tx, epoch);
    return fn(tx);
  });
}

const tenantStore = new AsyncLocalStorage<TenantCtx>();

export interface WithTenantOpts {
  /** 只用于沙箱开通、删除的日计数；保持与进程 todayIso 同源。 */
  sandboxDay?: string;
  /** 运维锁丢失时中断事务。 */
  signal?: AbortSignal;
  /** R12 自己的 expire / usage flush / purge，不属于新业务事务。 */
  sandboxMaintenance?: boolean;
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
  /**
   * 只给预载、导入、导出、清理用（02 spec「数据库」）：事务开头把语句超时放宽到 60 秒、事务空闲超时放宽到 120 秒。
   * agent_app 登录时带的 5 秒与 10 秒（roles.sql）在这几处会先于停机信号断开连接
   */
  longRunning?: boolean;
}

/**
 * 租户数据的唯一入口：BEGIN →（longRunning 时放宽两个超时）→ 断言会话级的租户 GUC 为空（不为空说明有人在会话级 SET 过，
 * 销毁这条连接并抛错）→ 事务内 set_config → fn → COMMIT；fn 抛错就 ROLLBACK。ctx 经 AsyncLocalStorage 传给 fn 里调用的
 * 仓储与审计函数。在 withTenant 里再嵌套 withTenant 会抛错，不管租户是否相同。
 */
export async function withTenant<T>(db: Db, ctx: TenantCtx, fn: (tx: Tx) => Promise<T>, opts: WithTenantOpts = {}): Promise<T> {
  const scoped = scopedRuntime();
  const rt = scoped?.id === ctx.tenantId ? scoped : runtimeOf(ctx.tenantId);
  // 从借连接之前登记，直到 COMMIT / ROLLBACK 和归还连接完成；abort 不摘登记。
  const work = () =>
    tenantTransaction(
      db,
      async (tx) => {
        if (opts.sandboxDay !== undefined) await tx.execute(sql`select set_config('app.sandbox_day', ${opts.sandboxDay}, true)`);
        await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
        return tenantStore.run(ctx, () => fn(tx));
      },
      opts,
    );
  return rt?.kind === 'sandbox' ? rt.inflight.track(work, opts.sandboxMaintenance) : work();
}

/** R15：池与所有未删沙箱的用量在同一只读快照里读取；租户 GUC 仍只由本模块管理。 */
export function readSandboxPoolBudget(db: Db, day: string): Promise<{ calls: number; costMilli: number }> {
  return tenantTransaction(
    db,
    async (tx) => {
      const tenants = rowsOf<{ id: string }>(await tx.execute(sql`select id from public.tenants where kind = 'sandbox'`));
      const [pool] = rowsOf<{ calls: number; costMilli: number }>(
        await tx.execute(sql`
      select coalesce(sum(calls),0)::float8 as calls, coalesce(sum(cost_milli),0)::float8 as "costMilli"
      from public.sandbox_pool_daily where day = ${day}::date`),
      );
      for (const tenant of tenants) {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
        const [row] = rowsOf<{ calls: number; costMilli: number }>(
          await tx.execute(sql`
        select coalesce(sum(calls),0)::float8 as calls, coalesce(sum(cost_milli_cny),0)::float8 as "costMilli"
        from public.usage_daily where day = ${day}::date`),
        );
        pool!.calls += row!.calls;
        pool!.costMilli += row!.costMilli;
      }
      return pool!;
    },
    { readOnly: true, isolation: 'repeatable read' },
  );
}

/** 开通与复制共用一个事务；创建函数返回后才建立新租户的 GUC 与异步上下文（05 R9）。 */
export interface NewSandboxTenantInput {
  slug: string;
  templateTenantId: string;
  brand: import('../core/pack-api.js').BrandProfile | null;
  tokenHash: Buffer;
  ip: string | null;
  userAgent: string | null;
}
export interface NewSandboxTenant {
  tenantId: string;
  userId: string;
  expiresAt: Date;
}
export async function withNewSandboxTenant<T>(
  db: Db,
  input: NewSandboxTenantInput,
  fn: (tx: Tx, created: NewSandboxTenant) => Promise<T>,
  opts: { epoch?: string; beforeCreate?: (tx: Tx, day: string) => Promise<void> } = {},
): Promise<T> {
  if (process.env.APP_ROLE === 'sandbox' && opts.epoch === undefined) throw new Error('sandbox_epoch_required');
  return tenantTransaction(db, async (tx) => {
    if (opts.epoch !== undefined) await fenceSandboxEpoch(tx, opts.epoch);
    // 在取得连接、推进屏障之后捕获日期，准入计数和函数写入使用同一个日期。
    const day = todayIso();
    await tx.execute(sql`select set_config('app.sandbox_day', ${day}, true)`);
    await opts.beforeCreate?.(tx, day);
    const [row] = rowsOf<{ o_tenant: string; o_user: string; o_expires_at: Date | string }>(
      await tx.execute(sql`
      select * from public.sandbox_tenant_create(${input.slug}, ${input.templateTenantId}::uuid,
        ${JSON.stringify(input.brand)}::json, ${input.tokenHash}, ${input.ip}::inet, ${input.userAgent})`),
    );
    if (!row) throw new Error('sandbox_tenant_create 未返回租户');
    const created = { tenantId: row.o_tenant, userId: row.o_user, expiresAt: new Date(row.o_expires_at) };
    const ctx: TenantCtx = {
      tenantId: created.tenantId,
      actor: { kind: 'user', userId: created.userId, name: '体验访客', ip: input.ip },
    };
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    return tenantStore.run(ctx, () => fn(tx, created));
  });
}

/** 两种租户事务都检查会话级泄漏并归还连接；异常时由驱动回滚。 */
async function tenantTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: WithTenantOpts = {}): Promise<T> {
  if (tenantStore.getStore()) throw new Error('withTenant 不能嵌套');
  const driver = drivers.get(db);
  if (!driver) throw new Error('这个 Db 不是经 openDb / openTestDb 打开的');
  const config =
    opts.isolation || opts.readOnly
      ? { isolationLevel: opts.isolation, accessMode: opts.readOnly ? ('read only' as const) : undefined }
      : undefined;
  assertSandboxRunning();
  opts.signal?.throwIfAborted();
  const conn = await driver.acquire();
  let leaked = false;
  const abort = () => conn.abort?.();
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    opts.signal?.throwIfAborted();
    assertSandboxRunning();
    return await conn.db.transaction(async (tx) => {
      // SET LOCAL 只管本事务，提交或回滚后回到角色的默认值，连接归还时不留痕
      if (opts.longRunning) {
        await tx.execute(sql`set local statement_timeout = '60s'`);
        await tx.execute(sql`set local idle_in_transaction_session_timeout = '120s'`);
      }
      // 事务里还没设过，读到的就是会话级的值。事务级 set_config 在提交后会留下一个空串，所以空串也算「空」
      const [row] = rowsOf<{ v: string | null }>(await tx.execute(sql`select current_setting('app.tenant_id', true) as v`));
      if (row?.v) {
        leaked = true;
        throw new Error('这条连接上有会话级的 app.tenant_id（有人在事务外 SET 过），已销毁这条连接');
      }
      const result = await fn(tx);
      opts.signal?.throwIfAborted();
      assertSandboxRunning();
      return result;
    }, config);
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    await conn.release(leaked || opts.signal?.aborted === true);
  }
}

/** 单连接驱动（PGlite）没法销毁连接，只能清掉会话级的租户设置，相当于换了一条干净连接 */
export async function resetSessionTenant(db: Db): Promise<void> {
  await db.execute(sql`reset app.tenant_id`);
}

/** 当前异步上下文是否在某个 withTenant 的回调里（读同一个 AsyncLocalStorage）。chat() 入口用它断言不在落库事务里 */
export function inTenantTx(): boolean {
  return tenantStore.getStore() !== undefined;
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
  /** 锁连接断开时回调；订阅时已经断开就当场回调一次；release 之后不再回调 */
  onLost(cb: () => void): void;
  /** 重连并重取：'ok' 恢复持锁；'held_by_other' 连上了但锁在别人手里；'unreachable' 还连不上 */
  reacquire(): Promise<'ok' | 'held_by_other' | 'unreachable'>;
  release(): Promise<void>;
}

export interface ProcessTenantLock extends TenantLock {
  /** 沙箱装载 / 开通后在同一条进程锁连接上取租户锁。 */
  acquireTenant(tenantId: string): Promise<TenantLock | null>;
}

/**
 * 在一条专用连接上执行 pg_try_advisory_lock；拿不到返回 null（锁在别人手里）。
 * 连接开 TCP keepalive（默认 10 秒）：对端消失时尽快收到 error 事件，而不是等到下一次查询。
 */
export async function holdTenantLock(url: string, tenantId: string, opts: { keepAliveMs?: number } = {}): Promise<TenantLock | null> {
  assertPgUrl(url);
  return holdTenantLocks(url, [tenantId], opts);
}

/** 05 R2：宿主进程一条专用连接，启动时一次取得全部装载租户的锁。 */
export async function holdTenantLocks(
  url: string,
  tenantIds: readonly string[],
  opts: { keepAliveMs?: number; waitMs?: number } = {},
): Promise<ProcessTenantLock | null> {
  assertPgUrl(url);
  const started = Date.now();
  const keys = tenantIds.map((id) => `wecom-sales-agent:${id}`);
  const connect = async (): Promise<pg.Client> => {
    // 连接超时要比 5 秒一次的重取间隔短，免得一次重取拖过下一次
    const c = new pg.Client({
      connectionString: url,
      keepAlive: true,
      keepAliveInitialDelayMillis: opts.keepAliveMs ?? 10_000,
      connectionTimeoutMillis: 4_000,
    });
    // 连接失败或之后断开都会发 error；先挂上监听，免得未处理的 error 事件让进程崩掉
    withoutTenantScope(() => c.on('error', () => {}));
    await c.connect();
    return c;
  };
  const tryLock = async (c: pg.Client): Promise<boolean> => {
    for (const key of keys)
      if ((await c.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [key])).rows[0]?.ok !== true)
        return false;
    return true;
  };
  const drop = (c: pg.Client): void => {
    c.removeAllListeners('end');
    void c.end().catch(() => {});
  };

  let client = await connect();
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
      const callbacks = lostCallbacks.slice();
      for (const cb of callbacks) cb();
    };
    withoutTenantScope(() => {
      c.on('error', onLost);
      c.on('end', onLost);
    });
  };
  watch(client);

  // 查询本身出错（连接刚建好就断了）是连不上，不是锁在别人手里：照原样抛给调用方
  const waitMs = Math.min(opts.waitMs ?? 0, 30_000);
  let waitTimer: NodeJS.Timeout | undefined;
  const attemptInitial = async (): Promise<boolean> => {
    do {
      if (await tryLock(client)) return true;
      const remaining = started + waitMs - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => withoutTenantScope(() => setTimeout(resolve, Math.min(100, remaining))));
    } while (Date.now() < started + waitMs);
    return false;
  };
  const got = await (
    waitMs > 0
      ? Promise.race([
          attemptInitial(),
          new Promise<boolean>((resolve) => {
            waitTimer = withoutTenantScope(() =>
              setTimeout(
                () => {
                  drop(client); // 也终止迟迟不返回的锁查询，30 秒是整次取得锁的上限。
                  resolve(false);
                },
                Math.max(0, started + waitMs - Date.now()),
              ),
            );
          }),
        ])
      : attemptInitial()
  )
    .catch((err: unknown) => {
      drop(client);
      throw err;
    })
    .finally(() => clearTimeout(waitTimer));

  if (!got) {
    drop(client);
    return null;
  }

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
    async acquireTenant(tenantId) {
      assertSandboxRunning();
      if (lost || released) throw new Error('sandbox_process_stopped');
      const key = `wecom-sales-agent:${tenantId}`;
      if (keys.includes(key)) throw new Error('tenant_lock_duplicate');
      const result = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [key]);
      if (!result.rows[0]?.ok) return null;
      keys.push(key);
      let tenantReleased = false;
      const callbacks: (() => void)[] = [];
      return {
        onLost: (cb) => {
          if (tenantReleased) return;
          const notify = (): void => {
            if (!tenantReleased) cb();
          };
          callbacks.push(notify);
          lostCallbacks.push(notify);
          if (lost && !released) cb();
        },
        reacquire: async () => {
          throw new Error('sandbox_lock_reacquire_forbidden');
        },
        release: async () => {
          if (tenantReleased) return;
          tenantReleased = true;
          for (const callback of callbacks) {
            const index = lostCallbacks.indexOf(callback);
            if (index >= 0) lostCallbacks.splice(index, 1);
          }
          callbacks.length = 0;
          keys.splice(keys.indexOf(key), 1);
          if (!lost && !released) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        },
      };
    },
    onLost(cb) {
      lostCallbacks.push(cb);
      // 断开事件只发一次：订阅时已经断了（还没重取回来）就当场补一次，晚订阅的不会永远以为持着锁
      if (lost && !released) cb();
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
      for (const key of keys) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {});
      drop(client);
    },
  };
}
