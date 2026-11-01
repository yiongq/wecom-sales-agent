import { randomUUID } from 'node:crypto';
import { configRuntime } from '../config/source.js';
import { withTenant } from '../db/client.js';
import { readOpsTenant } from '../db/repo/ops-metrics.js';
import {
  changeReport,
  ensureReport,
  expireReports,
  freezeReport,
  opsTimeout,
  readReport,
  reportHasDeletion,
  type ReportError,
} from '../db/repo/ops-reports.js';
import { todayIso } from '../env.js';
import type { JobOutcome } from '../jobs/runner.js';
import type { JobRow } from '../db/repo/jobs.js';
import type { DailyOpsPoint } from '../shared/console-api.js';
import { withJobsTx } from '../store.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { sharedTrial } from '../tenancy/trial/notice.js';
import { sendOnce } from './alert.js';
import { opsEnabled } from './ops-config.js';
import { dayWindow, readDailyPoint } from './trends.js';

const scheduled = new TenantLocal(() => ({ day: '', checkedAt: 0 }));
registerTenantState({ name: 'ops.digest.schedule', ...scheduled.registration((s) => Number(!!s.day)) });
export function yesterday(now: number): string {
  const d = new Date(now);
  return todayIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}
function deadline(day: string): number {
  const d = dayWindow(day).to;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
function event(errorCode: ReportError): void {
  console.error(JSON.stringify({ event: 'ops_report.failed', error_code: errorCode }));
}
/** 每拍只做内存判断；到点及每小时确认一次，失败下一拍可重试。 */
export async function ensureDigest(now: number): Promise<void> {
  if (!opsEnabled('digest')) return;
  const day = yesterday(now);
  const state = scheduled.get();
  if (new Date(now).getHours() < 9 || (state.day === day && now - state.checkedAt < 3_600_000)) return;
  const expired = await withJobsTx(async (tx) => {
    const count = await expireReports(tx, day);
    if ((await readOpsTenant(tx, currentRuntime().id)).status !== 'suspended') await ensureReport(tx, day, now);
    return count;
  });
  if (expired) console.error(JSON.stringify({ event: 'ops_report.failed', error_code: 'deadline', count: expired }));
  state.day = day;
  state.checkedAt = now;
}

/** 固定字段白名单，不接收 slug、显示名或任何原文。 */
export function renderDigest(p: DailyOpsPoint, meta: { instance: string; tenantId: string; reportId: string; trial: boolean }): string {
  const value = (n: number | null, suffix = '') => (n === null ? '数据不足' : `${n}${suffix}`);
  const percent = (n: number | null) => (n === null ? '数据不足' : `${(n * 100).toFixed(1)}%`);
  const label = meta.instance.replace(/[^\p{L}\p{N}_. -]/gu, '').slice(0, 40);
  return [
    `[${label || 'wecom-sales-agent'}] P3 每日摘要 ${p.day}`,
    `T-${meta.tenantId.slice(0, 6)}${meta.trial ? ' 共享试用' : ''} 报告 ${meta.reportId.slice(0, 8)}`,
    `接待 ${value(p.receptions)}；轮次 ${value(p.turns)}`,
    `转人工率 ${percent(p.handoffRate)}；AI 错误率 ${percent(p.aiErrorRate)}`,
    `引擎回复 p90 ${value(p.replyP90Ms, 'ms')}，样本 ${value(p.replySamples)}`,
    `租户全部模型费用（含测试）${p.costMilli === null ? '数据不足' : `${(p.costMilli / 1000).toFixed(3)}元`}`,
    `已付订单数（含后续退款）${value(p.paidOrders)}`,
    ...(p.coverage !== 'complete' ? ['留存范围内统计，数据可能不全'] : []),
  ].join('\n');
}

export async function runDigest(job: JobRow, now: number): Promise<JobOutcome> {
  const startedAt = Date.now();
  const currentTime = () => now + Math.max(0, Date.now() - startedAt);
  const day = (job.payload as { day?: unknown } | null)?.day;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { status: 'failed', lastError: 'bad_day' };
  const pending = (errorCode: ReportError): JobOutcome => ({ status: 'pending', runAt: now + 60_000, lastError: errorCode });
  const finish = async (errorCode: ReportError, status: 'failed' | 'skipped') => {
    if (await withJobsTx((tx) => changeReport(tx, day, 'pending', { status, errorCode, nextAttemptAt: null }))) {
      if (status === 'failed') event(errorCode);
    }
    return { status: 'done' } as const;
  };
  let report = await withJobsTx((tx) => readReport(tx, day));
  if (!report) return { status: 'done' };
  if (report.status === 'sending') {
    const sendingToken = report.claimToken!;
    if (await withJobsTx((tx) => changeReport(tx, day, 'sending', { status: 'unknown', errorCode: 'commit_failed' }, sendingToken)))
      event('commit_failed');
    return { status: 'done' };
  }
  if (report.status !== 'pending') return { status: 'done' };
  if (now >= deadline(day)) return finish('deadline', 'failed');
  if (!opsEnabled('digest')) return finish('disabled', 'skipped');
  if ((await withJobsTx((tx) => readOpsTenant(tx, currentRuntime().id))).status === 'suspended') return finish('suspended', 'skipped');
  if (report.nextAttemptAt && report.nextAttemptAt.getTime() > now) return { status: 'pending', runAt: report.nextAttemptAt.getTime() };
  let deletionAtCompute = false;
  try {
    deletionAtCompute = await withJobsTx((tx) => reportHasDeletion(tx, day));
    if (!report.snapshot || deletionAtCompute) {
      const { db, tenantId } = configRuntime();
      const snapshot = await withTenant(
        db,
        {
          tenantId,
          actor: { kind: 'system', userId: null, name: null, ip: null },
        },
        async (tx) => {
          await opsTimeout(tx);
          deletionAtCompute = await reportHasDeletion(tx, day);
          return readDailyPoint(tx, day, now);
        },
        { readOnly: true, isolation: 'repeatable read' },
      );
      await withJobsTx((tx) => freezeReport(tx, day, snapshot, now));
    }
  } catch {
    await withJobsTx((tx) => changeReport(tx, day, 'pending', { errorCode: 'sql_error', nextAttemptAt: new Date(now + 60_000) }));
    return pending('sql_error');
  }
  const token = randomUUID();
  // 冻结之后再检查状态；sending 的提交成功是唯一允许网络请求的凭据。
  let expiredWhileComputing = false;
  const claimed = await withJobsTx(async (tx) => {
    report = await readReport(tx, day, true);
    if (report?.status !== 'pending') return false;
    if (currentTime() >= deadline(day)) {
      expiredWhileComputing = await changeReport(tx, day, 'pending', { status: 'failed', errorCode: 'deadline' });
      return false;
    }
    const suspended = (await readOpsTenant(tx, currentRuntime().id)).status === 'suspended';
    if (suspended || !opsEnabled('digest')) {
      await changeReport(tx, day, 'pending', { status: 'skipped', errorCode: suspended ? 'suspended' : 'disabled' });
      return false;
    }
    // 删除若发生在计算之后，此次不发送，下一次重算。
    if ((await reportHasDeletion(tx, day, true)) !== deletionAtCompute) {
      await changeReport(tx, day, 'pending', { snapshot: null, computedAt: null });
      return false;
    }
    return changeReport(tx, day, 'pending', { status: 'sending', claimToken: token });
  });
  if (!claimed) {
    if (expiredWhileComputing) event('deadline');
    const current = await withJobsTx((tx) => readReport(tx, day));
    return current?.status === 'pending' ? pending('sql_error') : { status: 'done' };
  }
  const out = await sendOnce(
    renderDigest(report!.snapshot as DailyOpsPoint, {
      instance: process.env.INSTANCE_LABEL ?? '',
      tenantId: currentRuntime().id,
      reportId: report!.reportId,
      trial: sharedTrial(currentRuntime()),
    }),
    now,
  );
  try {
    if (out.status === 'accepted' || out.status === 'unknown') {
      const changed = await withJobsTx((tx) =>
        changeReport(
          tx,
          day,
          'sending',
          {
            status: out.status === 'accepted' ? 'sent' : 'unknown',
            sentAt: out.status === 'accepted' ? new Date(now) : null,
            errorCode: out.status === 'unknown' ? out.errorCode : null,
            claimToken: null,
            nextAttemptAt: null,
          },
          token,
        ),
      );
      if (changed && out.status === 'unknown') event(out.errorCode);
      return { status: 'done' };
    }
    const attempts = report!.attempts + Number(out.status === 'rejected');
    const failed = attempts >= 3;
    const retryAt = now + (out.status === 'rejected' && attempts === 2 ? 300_000 : 60_000);
    const changed = await withJobsTx((tx) =>
      changeReport(
        tx,
        day,
        'sending',
        {
          status: failed ? 'failed' : 'pending',
          attempts,
          claimToken: null,
          errorCode: out.errorCode,
          nextAttemptAt: failed ? null : new Date(retryAt),
        },
        token,
      ),
    );
    if (changed && failed) event('rejected');
    return failed || !changed ? { status: 'done' } : { status: 'pending', runAt: retryAt };
  } catch {
    // 不补写或重发：保留 sending，下次启动归 unknown。
    event('commit_failed');
    return { status: 'done' };
  }
}
