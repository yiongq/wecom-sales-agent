// 任务表（02 spec「任务表与跟进」）：入队（同一 dedupe_key 至多一个没结束的）、认领（FOR UPDATE SKIP LOCKED）、改状态。
// 删除只经 purge_finished_jobs，以及清除、删除一个会话时的 purge_conversation、erase_conversation
import { and, eq, inArray, sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { jobs } from '../schema.js';

export type JobKind = 'followup' | 'handoff_notify' | 'retention_purge';
export type JobStatus = 'pending' | 'running' | 'sending' | 'done' | 'failed' | 'cancelled' | 'abandoned';

export interface JobRow {
  id: string;
  kind: JobKind;
  dedupeKey: string;
  runAt: Date;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
  lastError: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

/** 结束的四种状态：改成它们时记 finished_at */
const FINISHED: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'abandoned'];

/**
 * 入队。同一 dedupeKey 已有 pending、running 或 sending 的任务时什么都不做，返回 null；否则返回新任务的 id。
 * 约定：与某个会话有关的任务（跟进、转人工通知），payload 必带 `sessionId`（会话 id）。清除与删除函数按
 * `payload->>'sessionId'` 删掉它的任务（任何状态），不带就会把 dedupe_key 里的 external_userid 留在库里（验收 27）
 */
export async function enqueueJob(
  tx: Tx,
  spec: { kind: JobKind; dedupeKey: string; runAt: Date; payload: unknown; maxAttempts: number },
): Promise<string | null> {
  const { tenantId } = currentTenantCtx();
  const [row] = await tx
    .insert(jobs)
    .values({ tenantId, ...spec })
    // 冲突目标是部分唯一索引 jobs_open_uq：谓词要与索引的写法一致，Postgres 才认得出它
    .onConflictDoNothing({
      target: [jobs.tenantId, jobs.dedupeKey],
      where: sql`${jobs.status} IN ('pending', 'running', 'sending')`,
    })
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

interface RawJob {
  id: string;
  kind: JobKind;
  dedupe_key: string;
  run_at: string | Date;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  payload: unknown;
  last_error: string | null;
  created_at: string | Date;
  claimed_at: string | Date | null;
  finished_at: string | Date | null;
}
const toDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

/**
 * 认领一批到点的任务：status='pending' AND run_at <= now ORDER BY run_at LIMIT n FOR UPDATE SKIP LOCKED，改成 running、
 * 记 claimed_at。now 由调用方给（与 runAt 同一个时钟）。kinds 给了就只认领这几类（认领分道，02 plan 第 14 步）。
 * 调用方随即提交，再执行任务
 */
export async function claimDueJobs(tx: Tx, now: Date, limit: number, kinds?: readonly JobKind[]): Promise<JobRow[]> {
  const at = now.toISOString();
  const onlyKinds = kinds
    ? sql` and kind in (${sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;
  const rows = rowsOf<RawJob>(
    await tx.execute(sql`
      update ${jobs} set status = 'running', claimed_at = ${at}::timestamptz
       where (tenant_id, id) in (
         select tenant_id, id from ${jobs}
          where status = 'pending' and run_at <= ${at}::timestamptz${onlyKinds}
          order by run_at
          limit ${limit}
          for update skip locked)
      returning id, kind, dedupe_key, run_at, status, attempts, max_attempts, payload, last_error, created_at, claimed_at, finished_at`),
  );
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      dedupeKey: r.dedupe_key,
      runAt: toDate(r.run_at),
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      payload: r.payload,
      lastError: r.last_error,
      createdAt: toDate(r.created_at),
      claimedAt: r.claimed_at === null ? null : toDate(r.claimed_at),
      finishedAt: r.finished_at === null ? null : toDate(r.finished_at),
    }))
    .toSorted((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

/**
 * 改一个任务的状态。from 给出时只在当前状态是其中之一时才改（比如只有 running 才能改成 sending）；claimedAt 给出时还要
 * claimed_at 等于它（认领令牌：认领时写下的那个时刻。别的认领者归位、重新认领过这一行，它就不再是本次认领的，改不中）。
 * 改成结束的四种状态时记 finished_at。返回是否改到了
 */
export async function setJobStatus(
  tx: Tx,
  id: string,
  status: JobStatus,
  opts: { from?: readonly JobStatus[]; claimedAt?: Date; lastError?: string | null; attemptsDelta?: number; runAt?: Date } = {},
): Promise<boolean> {
  const out = await tx
    .update(jobs)
    .set({
      status,
      ...(FINISHED.includes(status) ? { finishedAt: sql`now()` } : {}),
      ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
      ...(opts.attemptsDelta ? { attempts: sql`${jobs.attempts} + ${opts.attemptsDelta}` } : {}),
      ...(opts.runAt ? { runAt: opts.runAt } : {}),
    })
    .where(
      and(
        eq(jobs.id, id),
        opts.from ? inArray(jobs.status, [...opts.from]) : undefined,
        opts.claimedAt ? eq(jobs.claimedAt, opts.claimedAt) : undefined,
      ),
    )
    .returning({ id: jobs.id });
  return out.length === 1;
}

/** 启动时各类没结束的任务的去向（spec「任务表与跟进 · 重启与停机」），各类的条数 */
export interface JobRecovery {
  /** running 的跟进改回 pending：还没记账，什么都没发 */
  followupRequeued: number;
  /** sending 的跟进记 abandoned、不重发：记过账，可能已经发了 */
  followupAbandoned: number;
  /** 其余种类的 running 改回 pending、attempts 加 1 */
  otherRequeued: number;
  /** 其余种类的 running 加 1 之后达到 max_attempts，记 failed */
  otherFailed: number;
}

/**
 * 启动时（认领开始之前、本进程持有租户锁）把上一个进程留下的 running 与 sending 归位。一个事务里四条 UPDATE：
 * 跟进的 running → pending；跟进的 sending → abandoned（last_error 'restart_in_sending'）；其余种类的 running → attempts + 1，
 * 到 max_attempts 记 failed（last_error 'interrupted'），否则 pending
 */
export async function recoverJobsAtStartup(tx: Tx): Promise<JobRecovery> {
  const n = async (q: ReturnType<typeof sql>): Promise<number> => rowsOf<{ id: string }>(await tx.execute(q)).length;
  const followupRequeued = await n(sql`
    update ${jobs} set status = 'pending', claimed_at = null
     where kind = 'followup' and status = 'running' returning id`);
  const followupAbandoned = await n(sql`
    update ${jobs} set status = 'abandoned', finished_at = now(), last_error = 'restart_in_sending'
     where kind = 'followup' and status = 'sending' returning id`);
  const otherFailed = await n(sql`
    update ${jobs} set status = 'failed', attempts = attempts + 1, finished_at = now(), last_error = 'interrupted'
     where kind <> 'followup' and status = 'running' and attempts + 1 >= max_attempts returning id`);
  const otherRequeued = await n(sql`
    update ${jobs} set status = 'pending', attempts = attempts + 1, claimed_at = null, last_error = 'interrupted'
     where kind <> 'followup' and status = 'running' returning id`);
  return { followupRequeued, followupAbandoned, otherRequeued, otherFailed };
}

/** 取消这个 dedupeKey 还没开始执行的任务（客户回话、重置）；返回取消的条数 */
export async function cancelPendingJobs(tx: Tx, dedupeKey: string): Promise<number> {
  const out = await tx
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: sql`now()` })
    .where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, 'pending')))
    .returning({ id: jobs.id });
  return out.length;
}

/**
 * 取消这个会话某一种还没开始执行的任务（重置时取消待执行的 handoff_notify，02 spec「消息只追加」重置那一行）：按 payload 的
 * sessionId 认会话，不按键拼（升级会覆盖转人工记录，键里的时刻拼不全）。返回取消的条数
 */
export async function cancelPendingJobsOfSession(tx: Tx, kind: JobKind, sessionId: string): Promise<number> {
  const out = await tx
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: sql`now()` })
    .where(and(eq(jobs.kind, kind), eq(jobs.status, 'pending'), sql`${jobs.payload}->>'sessionId' = ${sessionId}`))
    .returning({ id: jobs.id });
  return out.length;
}
