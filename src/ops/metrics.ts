// 运行数字（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警 · 运行数字」、R24）：GET /api/console/metrics 的
// 窗口、换算与 60 秒缓存。SQL 在 src/db/repo/metrics.ts（四条，在 turn_traces、usage_daily 上现算）。
// 窗口是近 days 个自然日、含今天，起点是 days-1 天前那天的 0 点，「今天」与 usage_daily.day 同一个口径：服务器时区（TZ）。
// 后台接口，不在轮次里：对话的读路径不经这里（不变量 9）。
import { configRuntime } from '../config/source.js';
import { withTenant, type TenantCtx } from '../db/client.js';
import { readMetrics } from '../db/repo/metrics.js';
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
  const { db, tenantId } = configRuntime();
  if (ctx.tenantId !== tenantId) throw new Error('这个租户不是本进程装载的租户');
  const m = await withTenant(db, ctx, (tx) => readMetrics(tx, metricsWindow(now, days)), { readOnly: true });
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

/** 按（租户、days）缓存 60 秒；在算的那一次也共用（并发的请求不各查一遍），算失败不留缓存 */
const cache = new Map<string, { at: number; value: Promise<MetricsView> }>();

/** now 是调用方的时钟（后台接口的 clock）：窗口与缓存都按它算 */
export function readMetricsView(ctx: TenantCtx, days: number, now: number): Promise<MetricsView> {
  const key = `${ctx.tenantId}|${days}`;
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < TTL_MS) return hit.value;
  const value = compute(ctx, days, now);
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** 仅供自测：清空缓存 */
export const __metricsTest = {
  reset(): void {
    cache.clear();
  },
};
