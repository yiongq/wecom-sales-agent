// 运行数字（02 spec「可观测性与告警 · 运行数字」，R24）：在 turn_traces、usage_daily 上现算的四条 SQL。
// 窗口的起点与「今天」由调用方按服务器时区算好传进来；结果的缓存在调用方
import { eq, sql } from 'drizzle-orm';
import { rowsOf, type Tx } from '../client.js';
import { tenants, turnTraces, usageDaily } from '../schema.js';

/** 这个租户的 trace 保留期（天，7–3650）：运行数字的窗口不超过它（tenants 不带 RLS，agent_app 可读） */
export async function readTraceRetentionDays(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx.select({ days: tenants.retentionTraceDays }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new Error('租户行不存在');
  return row.days;
}

export interface MetricsRow {
  /** 窗口内的轮次数 */
  turns: number;
  /** outcome='replied' 的轮次 duration_ms 的 90 分位；没有这样的轮次为 null */
  replyP90Ms: number | null;
  /** 有 outcome='handoff' 轮次的会话 / 有轮次的会话；没有轮次为 null */
  handoffRate: number | null;
  /** 有模型调用出错（llm 里某一项的 error 非空）或 outcome='error' 的轮次 / 全部轮次；没有轮次为 null */
  aiErrorRate: number | null;
  /** usage_daily 里今天的 cost_milli_cny 之和 */
  costTodayMilliCny: number;
  /** 窗口内（sinceDay 到 today）之和 */
  costRangeMilliCny: number;
}

/** 数值一律转成 float8 再读：int8 与 numeric 在两个驱动里都可能读成字符串 */
export async function readMetrics(tx: Tx, q: { since: Date; sinceDay: string; today: string }): Promise<MetricsRow> {
  const since = q.since.toISOString();
  const [reply] = rowsOf<{ turns: number; p90: number | null }>(
    await tx.execute(sql`
      select count(*)::int as turns,
             (percentile_cont(0.9) within group (order by ${turnTraces.durationMs}) filter (where ${turnTraces.outcome} = 'replied'))::float8 as p90
        from ${turnTraces}
       where ${turnTraces.startedAt} >= ${since}::timestamptz`),
  );
  const [handoff] = rowsOf<{ rate: number | null }>(
    await tx.execute(sql`
      select (count(distinct ${turnTraces.conversationId}) filter (where ${turnTraces.outcome} = 'handoff'))::float8
             / nullif(count(distinct ${turnTraces.conversationId}), 0) as rate
        from ${turnTraces}
       where ${turnTraces.startedAt} >= ${since}::timestamptz`),
  );
  const [errors] = rowsOf<{ rate: number | null }>(
    await tx.execute(sql`
      select (count(*) filter (
                where ${turnTraces.outcome} = 'error'
                   or exists (select 1 from json_array_elements(${turnTraces.llm}) as e where e->>'error' is not null)))::float8
             / nullif(count(*), 0) as rate
        from ${turnTraces}
       where ${turnTraces.startedAt} >= ${since}::timestamptz`),
  );
  const [cost] = rowsOf<{ today: number; range: number }>(
    await tx.execute(sql`
      select coalesce(sum(${usageDaily.costMilliCny}) filter (where ${usageDaily.day} = ${q.today}::date), 0)::float8 as today,
             coalesce(sum(${usageDaily.costMilliCny}), 0)::float8 as range
        from ${usageDaily}
       where ${usageDaily.day} between ${q.sinceDay}::date and ${q.today}::date`),
  );
  return {
    turns: reply?.turns ?? 0,
    replyP90Ms: reply?.p90 ?? null,
    handoffRate: handoff?.rate ?? null,
    aiErrorRate: errors?.rate ?? null,
    costTodayMilliCny: cost?.today ?? 0,
    costRangeMilliCny: cost?.range ?? 0,
  };
}
