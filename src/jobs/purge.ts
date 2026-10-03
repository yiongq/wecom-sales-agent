// retention_purge 任务（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」、R20）：每天 3:30（服务器本地时间）一个，
// dedupe_key 是 retention_purge:<日期>。排程：startJobs 之后第一批认领之前排下一个 3:30 的，之后每小时补排一次（已有就什么都不做），
// 执行完同一个事务里排下一天的。本步（第 10 步）只排程：清理本身（候选会话、purge_conversation、purge_expired_traces、
// purge_finished_jobs、system.purge 审计）在第 16 步，这里到点只记一行日志、标 done。
import type { JobRow } from '../db/repo/jobs.js';
import type { JobOutcome, JobSpec } from './runner.js';

export const RETENTION_PURGE_HOUR = 3;
export const RETENTION_PURGE_MINUTE = 30;
const RETENTION_PURGE_MAX_ATTEMPTS = 3;

/** 本地日期 YYYY-MM-DD */
function localDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** now 之后（含正好这一刻）最近的一个 3:30 */
export function nextPurgeAt(now: number): number {
  const d = new Date(now);
  d.setHours(RETENTION_PURGE_HOUR, RETENTION_PURGE_MINUTE, 0, 0);
  if (d.getTime() < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 下一个要排的 retention_purge（不属于某个会话，payload 不带 sessionId，单独一个事务排） */
export function retentionPurgeSpec(now: number): JobSpec {
  const runAt = nextPurgeAt(now);
  return {
    kind: 'retention_purge',
    dedupeKey: `retention_purge:${localDate(runAt)}`,
    runAt,
    payload: { day: localDate(runAt) },
    maxAttempts: RETENTION_PURGE_MAX_ATTEMPTS,
  };
}

/** 第 16 步之前的执行体：记一行、标 done，同一个事务里排下一天的 */
export function runRetentionPurgeJob(job: JobRow, now: number): Promise<JobOutcome> {
  console.log(`[jobs] ${job.dedupeKey} 到点：保留期清理在第 16 步接上，本步只标 done、排下一天的`);
  return Promise.resolve({ status: 'done', enqueueNext: [retentionPurgeSpec(Math.max(now, job.runAt.getTime()) + 1)] });
}
