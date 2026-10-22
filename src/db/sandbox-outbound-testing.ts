// 第 17 步共享一次性 PG 的自测夹具：独立库、借用现有角色，不改集群级角色或口令。
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { MIGRATIONS_DIR } from './migrate.js';
import { installVectorExtension } from './testing-extensions.js';
import { openDb } from './client.js';
import { withoutTenantScope } from '../tenancy/runtime.js';

export async function openOutboundTestPg(url: string) {
  const admin = new pg.Client({ connectionString: url });
  withoutTenantScope(() => admin.on('error', () => {}));
  await admin.connect();
  const name = `agent_sbxout_${randomBytes(6).toString('hex')}`;
  const databaseUrl = new URL(url);
  databaseUrl.pathname = `/${name}`;
  let migration: pg.Client | undefined;
  let queryClient: pg.Client | undefined;
  let app: Awaited<ReturnType<typeof openDb>> | undefined;
  const close = async () => {
    await app?.close();
    await migration?.end();
    await queryClient?.end();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  };
  try {
    await admin.query(`create database "${name}" owner agent_owner`);
    migration = new pg.Client({ connectionString: databaseUrl.href });
    withoutTenantScope(() => migration!.on('error', () => {}));
    await migration.connect();
    // 07 R12：vector 扩展由超级用户在应用库里建，agent_owner 建不了；迁移 0016 要求它已经在
    await installVectorExtension((text) => migration!.query(text));
    await migration.query('SET ROLE agent_owner');
    await migrate(drizzle(migration), { migrationsFolder: MIGRATIONS_DIR });
    await migration.end();
    migration = undefined;
    queryClient = new pg.Client({ connectionString: databaseUrl.href });
    withoutTenantScope(() => queryClient!.on('error', () => {}));
    await queryClient.connect();
    // 各条池连接从建立时就是 agent_app；不使用共享角色的登录口令。
    databaseUrl.searchParams.set('options', '-c role=agent_app');
    app = await openDb(databaseUrl.href);
    return {
      db: app.db,
      appUrl: databaseUrl.href,
      query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
        (await queryClient!.query(text, params)).rows as T[],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
