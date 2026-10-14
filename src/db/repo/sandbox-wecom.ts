// 05 R21：实例收件游标；提交前持有 epoch 共享锁，不建立租户事务。
import { sql } from 'drizzle-orm';
import { rowsOf, withSandboxEpoch, type Db } from '../client.js';

export async function readSandboxWecomState(db: Db, openKfid: string) {
  const [row] = rowsOf<{ cursor: string | null; fullSince: Date | string | null; fullRevision: string }>(
    await db.execute(
      sql`select cursor, full_since as "fullSince", full_revision::text as "fullRevision" from public.sandbox_wecom_state where open_kfid = ${openKfid}`,
    ),
  );
  return row ?? { cursor: null, fullSince: null, fullRevision: '0' };
}

export async function commitSandboxWecomCursor(db: Db, epoch: string, openKfid: string, cursor: string): Promise<void> {
  await withSandboxEpoch(db, epoch, async (tx) => {
    await tx.execute(sql`insert into public.sandbox_wecom_state(open_kfid, cursor) values (${openKfid}, ${cursor})
      on conflict(open_kfid) do update set cursor = excluded.cursor, updated_at = now()`);
  });
}

export async function markSandboxWecomFull(db: Db, epoch: string, openKfid: string): Promise<void> {
  await withSandboxEpoch(db, epoch, async (tx) => {
    await tx.execute(sql`insert into public.sandbox_wecom_state(open_kfid, full_since, full_revision) values (${openKfid}, now(), 1)
      on conflict(open_kfid) do update set full_since = coalesce(sandbox_wecom_state.full_since, excluded.full_since), full_revision = sandbox_wecom_state.full_revision + 1, updated_at = now()`);
  });
}
/** R13 的运维复位不取进程锁；仍用当前 epoch 的共享锁与接手重建串行。 */
export async function resetSandboxWecomFull(db: Db): Promise<void> {
  const [row] = rowsOf<{ epoch: string | number }>(await db.execute(sql`select epoch from public.sandbox_process_epoch where id = 1`));
  if (!row) throw new Error('sandbox_epoch_missing');
  await withSandboxEpoch(db, String(row.epoch), async (tx) => {
    await tx.execute(sql`update public.sandbox_wecom_state set full_since = null, full_revision = full_revision + 1, updated_at = now()`);
  });
}
