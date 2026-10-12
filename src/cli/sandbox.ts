// R13：agent_app 运维入口，不装配置、会话或文件状态。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdTenantLocks, type Db, type ProcessTenantLock } from '../db/client.js';
import { endSandbox, listSandboxes, purgeSandbox } from '../db/sandbox-reaper.js';
import { dbFromEnv, main } from './common.js';
import { resetSandboxWecomFull } from '../db/repo/sandbox-wecom.js';

const USAGE = 'sandbox list | end <slug> | end --all | purge --all | wecom-reset-full';
export async function runSandbox(
  argv: string[],
  deps: {
    connect(): Promise<{ db: Db; close(): Promise<void> }>;
    lock(): Promise<ProcessTenantLock | null>;
  },
): Promise<number> {
  const [command, target] = argv;
  if (
    argv.length > 2 ||
    !(
      (command === 'list' && argv.length === 1) ||
      (command === 'wecom-reset-full' && argv.length === 1) ||
      (command === 'end' && target && !target.startsWith('-')) ||
      ((command === 'end' || command === 'purge') && target === '--all')
    )
  ) {
    console.error(`用法：${USAGE}`);
    return 1;
  }
  let lock: ProcessTenantLock | null = null;
  const controller = new AbortController();
  const lost = () => controller.abort(new Error('sandbox_lock_lost'));
  const signal = controller.signal;
  try {
    // purge 的第一步是进程锁：拿不到时不 expire、不查询或删除任何沙箱。
    if (command === 'purge') {
      lock = await deps.lock();
      if (!lock) {
        console.error('[sandbox] sandbox_already_running');
        return 3;
      }
      lock.onLost(lost);
    }
    signal.throwIfAborted();
    const conn = await deps.connect();
    let endedCount: number | undefined;
    try {
      if (command === 'wecom-reset-full') {
        await resetSandboxWecomFull(conn.db);
        console.log('[sandbox] 体验客服名额状态已复位，一分钟内生效');
        return 0;
      }
      signal.throwIfAborted();
      const all = await listSandboxes(conn.db);
      signal.throwIfAborted();
      const rows = command === 'end' && target !== '--all' ? all.filter((r) => r.slug === target) : all;
      if (command === 'end' && target !== '--all' && !rows.length) {
        console.error('[sandbox] sandbox_not_found');
        return 1;
      }
      if (command === 'list') {
        for (const r of rows) console.log(`${r.slug}\t${new Date(r.expiresAt).toISOString()}\t${r.expired ? 'expired' : 'serving'}`);
        return 0;
      }
      for (const row of rows) {
        signal.throwIfAborted();
        const tenantLock = lock ? await lock.acquireTenant(row.id) : null;
        if (lock && !tenantLock) {
          console.error('[sandbox] sandbox_tenant_lock_held');
          return 3;
        }
        try {
          tenantLock?.onLost(lost);
          signal.throwIfAborted();
          await endSandbox(conn.db, row.id, { signal });
          signal.throwIfAborted();
          if (command === 'purge') {
            const result = await purgeSandbox(conn.db, row.id, { signal });
            signal.throwIfAborted();
            console.log(
              `[sandbox] deleted ${row.slug.slice(-6)} lifetimeMs=${Math.max(0, Date.now() - new Date(row.createdAt).getTime())} turns=${result.turns} calls=${result.calls} costMilli=${result.costMilli} counts=${JSON.stringify(result.counts)}`,
            );
          }
        } finally {
          await tenantLock?.release();
        }
      }
      if (command === 'end' && target === '--all') endedCount = rows.length;
      return 0;
    } finally {
      await conn.close();
      if (endedCount !== undefined) console.log(`[sandbox] 已标记 ${endedCount} 个沙箱到期`);
    }
  } catch {
    console.error('[sandbox] sandbox_command_failed');
    return 1;
  } finally {
    await lock?.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(() =>
    runSandbox(process.argv.slice(2), {
      connect: () => dbFromEnv('DATABASE_URL'),
      lock: () => holdTenantLocks(process.env.DATABASE_URL ?? '', ['sandbox-process']),
    }),
  );
