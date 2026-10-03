// handoff_notify 任务（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」「通知」）：转人工提交后立即排一个，
// 10 分钟后若仍没人接手再排一个（这一个在转人工时就排好，到点时由执行体判断还有没有人接手）；至多重试 3 次。
// 本步（第 10 步）只排程：执行体（企微群机器人、判断是否已接手、窗口剩不到 4 小时的那一个）在第 14 步，这里到点只记一行日志、标 done。
// 不 import handoff/record.ts（它调这里排程）。
import type { JobRow } from '../db/repo/jobs.js';
import { shortIdOf } from '../shared/conversation.js';
import type { JobOp } from '../store.js';
import type { JobOutcome } from './runner.js';

/** 首次加至多重试 3 次 */
export const HANDOFF_NOTIFY_MAX_ATTEMPTS = 4;
/** 转人工之后多久仍没人接手就再通知一次 */
export const HANDOFF_UNCLAIMED_MS = 10 * 60_000;

export type HandoffNotifyReason = 'started' | 'unclaimed';

/**
 * 进入（或升级）转人工时排的通知任务，随这个会话的下一次落库提交（enterHandoff 与转人工的改动在同一段同步代码里）。
 * 键里带转人工的时刻：交还之后再转人工是另一次通知。升级（emergency）只排立即的那一个，10 分钟的那个首次进入时已排
 */
export function handoffNotifyOps(sessionId: string, at: number, opts: { escalated: boolean }): JobOp[] {
  const op = (reason: HandoffNotifyReason, runAt: number): JobOp => ({
    op: 'enqueue',
    kind: 'handoff_notify',
    dedupeKey: `handoff_notify:${sessionId}:${at}:${reason}`,
    runAt,
    // 与会话有关的任务 payload 必带 sessionId（清除与行权删除据它一并删掉，验收 27）
    payload: { sessionId, reason, handoffAt: at, escalated: opts.escalated },
    maxAttempts: HANDOFF_NOTIFY_MAX_ATTEMPTS,
  });
  return opts.escalated ? [op('started', at)] : [op('started', at), op('unclaimed', at + HANDOFF_UNCLAIMED_MS)];
}

/** 第 14 步之前的执行体：记一行、标 done（不留 pending：留着会每 5 秒被认领一次） */
export function runHandoffNotifyJob(job: JobRow): Promise<JobOutcome> {
  const p = (job.payload ?? {}) as { sessionId?: unknown; reason?: unknown };
  const sid = typeof p.sessionId === 'string' ? shortIdOf(p.sessionId) || '?' : '?';
  console.log(`[jobs] handoff_notify（${String(p.reason)}，会话 ${sid}）到点：外部通知在第 14 步接上，本步只标 done`);
  return Promise.resolve({ status: 'done' });
}
