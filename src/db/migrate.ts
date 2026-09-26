// 以 agent_owner 跑迁移（spec「迁移纪律」）。compose 里的一次性 migrate 服务执行它，应用自己从不跑迁移。
//   DATABASE_OWNER_URL=postgres://agent_owner:…@db/agent node --import tsx src/db/migrate.ts
// 连接串只在命令行前临时给出，不写进 .env；不 import env.ts，免得读到开发机 .env 里的别的连接串。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { assertPgUrl, redactUrl, rowsOf, type Db } from './client.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/** 镜像里每条迁移的 hash（drizzle 记的是整份 SQL 文件的 sha256），按 journal 顺序 */
export function imageMigrationHashes(): string[] {
  return readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).map((m) => m.hash);
}

/** 库里已应用的迁移 hash。drizzle 的记录表不存在（从没迁移过）时抛错，由调用方当成 schema_behind */
export async function appliedMigrationHashes(db: Db): Promise<string[]> {
  return rowsOf<{ hash: string }>(await db.execute(sql`select hash from drizzle.__drizzle_migrations`)).map((r) => r.hash);
}

/** 表和函数的属主必须是 agent_owner：换成超级用户跑，建出来的对象归超级用户，FORCE RLS 与权限表就都不成立了 */
export async function runMigrations(url: string): Promise<void> {
  assertPgUrl(url);
  const client = new pg.Client({ connectionString: url });
  // 迁移中途断开时让出错落在当前查询上（下面按失败退出），而不是未处理的 error 事件
  client.on('error', () => {});
  await client.connect();
  try {
    const who = (await client.query<{ u: string }>('select current_user as u')).rows[0]?.u;
    if (who !== 'agent_owner') throw new Error(`迁移必须以 agent_owner 执行，当前是 ${who}`);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('[migrate] 缺少 DATABASE_OWNER_URL（agent_owner 的连接串）');
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log(`[migrate] 完成：${redactUrl(url)}`),
    (err: unknown) => {
      console.error(`[migrate] 失败（${redactUrl(url)}）：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
