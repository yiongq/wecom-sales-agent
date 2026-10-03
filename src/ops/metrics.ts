// 运行数字（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警 · 运行数字」、R24）：GET /api/console/metrics 的
// 窗口、换算与 60 秒缓存。SQL 在 src/db/repo/metrics.ts（四条，在 turn_traces、usage_daily 上现算）。
// 窗口是近 days 个自然日、含今天，起点是 days-1 天前那天的 0 点，「今天」与 usage_daily.day 同一个口径：服务器时区（TZ）。
// 窗口受 trace 保留期限制：实际天数 = min(请求的 days, 这个租户的 retention_trace_days)，trace 的三项与两项费用都按它算
// （usage_daily 不归保留期清理，不截的话费用会比比率多算几天），MetricsView.days 返回它。
// 后台接口，不在轮次里：对话的读路径不经这里（不变量 9）。
import { configRuntime } from '../config/source.js';
import { withTenant, type TenantCtx } from '../db/client.js';
import { readMetrics, readTraceRetentionDays } from '../db/repo/metrics.js';
import { todayIso } from '../env.js';
import type { MetricsView } from '../shared/console-api.js';

const TTL_MS = 60_000;

/** 近 days 个自然日（含今天）：起点 = days-1 天前那天服务器时区的 0 点；两个日期是服务器时区的 YYYY-MM-DD */
export function metricsWindow(now: number, days: number): { since: Date; sinceDay: string; today: string } {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  return { since, sinceDay: todayIso(since), today: todayIso(new Date(now)) };
}

async function compute(ctx: TenantCtx, days: number, now: number): Promise<MetricsView> {
  const m = await withTenant(configRuntime().db, ctx, (tx) => readMetrics(tx, metricsWindow(now, days)), { readOnly: true });
  return {
    days,
    turns: m.turns,
    replyP90Ms: m.replyP90Ms === null ? null : Math.round(m.replyP90Ms),
    handoffRate: m.handoffRate,
    aiErrorRate: m.aiErrorRate,
    costTodayYuan: m.costTodayMilliCny / 1000,
    costRangeYuan: m.costRangeMilliCny / 1000,
  };
}

type Cache<T> = Map<string, { at: number; value: Promise<T> }>;

/** 按键缓存 60 秒；在算的那一次也共用（并发的请求不各查一遍），算失败不留缓存；时钟往回走就重算 */
function cached<T>(cache: Cache<T>, key: string, now: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < TTL_MS) return hit.value;
  const value = fn();
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** 租户的 trace 保留期（按租户）与运行数字（按租户与实际天数：请求 60 与 90 截到同一个保留期时共用一份） */
const retention: Cache<number> = new Map();
const views: Cache<MetricsView> = new Map();

/** now 是调用方的时钟（后台接口的 clock）：窗口与缓存都按它算 */
export async function readMetricsView(ctx: TenantCtx, days: number, now: number): Promise<MetricsView> {
  const { db, tenantId } = configRuntime();
  if (ctx.tenantId !== tenantId) throw new Error('这个租户不是本进程装载的租户');
  const keep = await cached(retention, ctx.tenantId, now, () =>
    withTenant(db, ctx, (tx) => readTraceRetentionDays(tx, ctx.tenantId), { readOnly: true }),
  );
  const effective = Math.min(days, keep);
  return cached(views, `${ctx.tenantId}|${effective}`, now, () => compute(ctx, effective, now));
}

/** 仅供自测：清空缓存 */
export const __metricsTest = {
  reset(): void {
    retention.clear();
    views.clear();
  },
};
