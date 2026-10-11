// R12 自测独立 PG 夹具：不更改共享集群角色口令。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { MIGRATIONS_DIR } from './migrate.js';
import { openDb, holdTenantLocks, type ProcessTenantLock } from './client.js';
// 独立库、沿用已有角色，不改共享集群角色口令。连接以 startup role 降为 agent_app。
export async function realReaperFixture(url: string) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `agent_reaper_${randomBytes(5).toString('hex')}`;
  let created = false;
  let owner: pg.Client | undefined;
  let queryConn: pg.Client | undefined;
  let app: Awaited<ReturnType<typeof openDb>> | undefined;
  let held: ProcessTenantLock | null = null;
  const close = async (): Promise<void> => {
    await held?.release().catch(() => {});
    await app?.close().catch(() => {});
    await queryConn?.end().catch(() => {});
    await owner?.end().catch(() => {});
    try {
      if (created) await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  };
  try {
    for (const role of ['agent_owner', 'agent_app', 'agent_platform']) {
      const found = await admin.query('select 1 from pg_roles where rolname=$1', [role]);
      if (!found.rowCount) {
        try {
          await admin.query(`create role ${role} login nosuperuser nobypassrls nocreaterole nocreatedb`);
        } catch (error) {
          if ((error as { code?: string }).code !== '42710') throw error;
        }
      }
    }
    await admin.query(`create database "${name}" owner agent_owner`);
    created = true;
    const u = new URL(url);
    u.pathname = `/${name}`;
    const superUrl = u.toString();
    owner = new pg.Client({ connectionString: superUrl });
    await owner.connect();
    try {
      await owner.query('set role agent_owner');
      await migrate(drizzle(owner), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await owner.end();
      owner = undefined;
    }
    queryConn = new pg.Client({ connectionString: superUrl });
    await queryConn.connect();
    const appUrl = new URL(superUrl);
    appUrl.searchParams.set('options', '-c role=agent_app -c statement_timeout=65000 -c idle_in_transaction_session_timeout=90000');
    app = await openDb(appUrl.toString());
    held = await holdTenantLocks(appUrl.toString(), ['sandbox-process']);
    assert.ok(held);
    return {
      app,
      held,
      superUrl,
      appUrl: appUrl.toString(),
      query: async <T>(text: string, params: unknown[] = []) => (await queryConn!.query(text, params)).rows as T[],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
