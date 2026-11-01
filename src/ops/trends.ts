// 17 R5/R10：展示缓存不供摘要使用；采集证据由分钟入口持久化。
import { configRuntime } from '../config/source.js';
import { withTenant, type TenantCtx, type Tx } from '../db/client.js';
import { readDailyMetrics, readOpsTenant, type DailyMetricsRow, type DayWindow } from '../db/repo/ops-metrics.js';
import { readCoverage, type CoverageRow } from '../db/repo/ops-coverage.js';
import { todayIso } from '../env.js';
import { TREND_PARTIAL_REASONS, type DailyOpsPoint, type MetricsTrendsView, type TrendPartialReason } from '../shared/console-api.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';

export type { CoverageRow } from '../db/repo/ops-coverage.js';
export type CoverageReader = (tx: Tx, windows: readonly DayWindow[]) => Promise<CoverageRow[]>;
const deps = { coverage: readCoverage as CoverageReader, aggregate: readDailyMetrics };

export function dayWindow(day: string): DayWindow {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { day, from: new Date(y, m - 1, d), to: new Date(y, m - 1, d + 1) };
}
function offsetDay(now: number, offset: number): string {
  const date = new Date(now);
  return todayIso(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset));
}
function complete(w: DayWindow, coverage: CoverageRow | undefined, today: string): boolean {
  return (
    w.day !== today &&
    !!coverage &&
    !coverage.hasGap &&
    !coverage.hasDeletion &&
    coverage.firstSeenAt.getTime() <= w.from.getTime() + 120_000 &&
    coverage.lastSeenAt.getTime() >= w.to.getTime() - 120_000
  );
}

/** 完整日允许零；非完整日计数只保留正值。比率只看分母：有分母时 0 也是事实，不当缺失。 */
export function buildPoint(w: DayWindow, raw: DailyMetricsRow, coverage: CoverageRow | undefined, now: number): DailyOpsPoint {
  const today = todayIso(new Date(now));
  const full = complete(w, coverage, today);
  const count = (n: number) => (full || n > 0 ? n : null);
  const point: DailyOpsPoint = {
    day: w.day,
    coverage: 'unavailable',
    receptions: count(raw.receptions),
    turns: count(raw.turns),
    replySamples: count(raw.replySamples),
    replyP90Ms: raw.replySamples && raw.replyP90Ms !== null ? Math.round(raw.replyP90Ms) : null,
    handoffRate: raw.receptions ? raw.handoffSessions / raw.receptions : null,
    aiErrorRate: raw.turns ? raw.aiErrorTurns / raw.turns : null,
    costMilli: count(raw.costMilli),
    paidOrders: count(raw.paidOrders),
  };
  point.coverage = full
    ? 'complete'
    : w.day === today || Object.entries(point).some(([k, v]) => k !== 'day' && k !== 'coverage' && v !== null)
      ? 'partial'
      : 'unavailable';
  return point;
}

/** 摘要在自己的租户事务中调用：只查目标日，绕过展示缓存。 */
export async function readDailyPoint(tx: Tx, day: string, now: number): Promise<DailyOpsPoint> {
  const w = dayWindow(day);
  const rows = await deps.aggregate(tx, [w]);
  const coverage = await deps.coverage(tx, [w]);
  return buildPoint(
    w,
    rows[0]!,
    coverage.find((r) => r.day === day),
    now,
  );
}

const trends = new TenantLocal(
  () => ({ scope: '', views: new Map<string, { at: number; value: Promise<MetricsTrendsView> }>() }),
  (s) => s.views.clear(),
);
registerTenantState({ name: 'trends.views', ...trends.registration((s) => s.views.size) });
/** 删除后由 purgeOnce 调用；只作废当前租户，旧的在途计算不能重新填充缓存。 */
export function invalidateTrends(): void {
  trends.get().views.clear();
}

export async function readTrendsView(ctx: TenantCtx, requestedDays: 7 | 30, now: number): Promise<MetricsTrendsView> {
  const { db, tenantId } = configRuntime();
  if (ctx.tenantId !== tenantId) throw new Error('tenant_scope_mismatch');
  const rt = currentRuntime();
  const state = trends.get(rt);
  // 不缓存租户配置，保留期/状态/开通日改变当次请求即生效。
  const tenant = await withTenant(db, ctx, (tx) => readOpsTenant(tx, tenantId), { readOnly: true });
  if (rt.cancel.aborted || !trends.owns(rt, state)) throw new Error('tenant_closing');
  if (tenant.status === 'suspended') {
    state.views.clear();
    throw new Error('tenant_suspended');
  }
  const today = todayIso(new Date(now));
  const retained = Math.min(requestedDays, tenant.retention);
  const retainedFrom = offsetDay(now, 1 - retained);
  const createdDay = todayIso(tenant.createdAt);
  const fromDay = retainedFrom > createdDay ? retainedFrom : createdDay;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = JSON.stringify([tenantId, requestedDays, timezone, fromDay, today, tenant.retention, tenant.status]);
  const scope = JSON.stringify([tenantId, timezone, today, tenant.retention, tenant.status, createdDay]);
  if (scope !== state.scope) {
    state.views.clear();
    state.scope = scope;
  }
  const hit = state.views.get(key);
  if (hit && now >= hit.at && now - hit.at < 60_000) return hit.value;
  // 同一配置下分别保留 7/30 天两个键，不让切换窗口冲掉另一份在途查询。
  const value = withTenant(
    db,
    ctx,
    async (tx) => {
      const windows: DayWindow[] = [];
      for (let i = retained - 1; i >= 0; i--) {
        const day = offsetDay(now, -i);
        if (day >= fromDay) windows.push(dayWindow(day));
      }
      const rows = await deps.aggregate(tx, windows);
      const coverage = await deps.coverage(tx, windows);
      const reasons = new Set<TrendPartialReason>();
      if (requestedDays > retained) reasons.add('retention');
      if (createdDay > retainedFrom) reasons.add('collection_start');
      const points = windows.map((w) => {
        const c = coverage.find((r) => r.day === w.day);
        if (c?.hasDeletion) reasons.add('deletion');
        if (w.day === today) reasons.add('today');
        else if (!complete(w, c, today) && !c?.hasDeletion) reasons.add('unknown_history');
        return buildPoint(
          w,
          rows.find((r) => r.day === w.day)!,
          c,
          now,
        );
      });
      return {
        requestedDays,
        days: windows.length,
        timezone,
        fromDay,
        toDay: today,
        computedAt: new Date(now).toISOString(),
        partialReasons: TREND_PARTIAL_REASONS.filter((r) => reasons.has(r)),
        points,
      };
    },
    { readOnly: true, isolation: 'repeatable read' },
  );
  state.views.set(key, { at: now, value });
  value.catch(() => {
    if (state.views.get(key)?.value === value) state.views.delete(key);
  });
  return value;
}

/** 能力注入不保存租户数据；换接线后由调用者 invalidateTrends。 */
export const __trendsTest = {
  use(over: Partial<typeof deps>): void {
    Object.assign(deps, over);
  },
  reset(): void {
    Object.assign(deps, { coverage: readCoverage, aggregate: readDailyMetrics });
    trends.registration(() => 0).reset();
  },
};
