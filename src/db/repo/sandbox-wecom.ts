// 05 R21：实例收件游标；提交前持有 epoch 共享锁，不建立租户事务。
import { sql } from 'drizzle-orm';
import { rowsOf, withSandboxEpoch, type Db } from '../client.js';

export async function readSandboxWecomState(db: Db, openKfid: string) {
  const [row] = rowsOf<{ cursor: string | null; fullSince: Date | string | null }>(
    await db.execute(sql`select cursor, full_since as "fullSince" from public.sandbox_wecom_state where open_kfid = ${openKfid}`),
  );
  return row ?? { cursor: null, fullSince: null };
}

export async function commitSandboxWecomCursor(db: Db, epoch: string, openKfid: string, cursor: string): Promise<void> {
  await withSandboxEpoch(db, epoch, async (tx) => {
    await tx.execute(sql`insert into public.sandbox_wecom_state(open_kfid, cursor) values (${openKfid}, ${cursor})
      on conflict(open_kfid) do update set cursor = excluded.cursor, updated_at = now()`);
  });
}
