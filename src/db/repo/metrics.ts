// 运行数字（02 spec「可观测性与告警 · 运行数字」，R24）：在 turn_traces、usage_daily 上现算的四条 SQL。
// 窗口的起点与「今天」由调用方按服务器时区算好传进来；结果的缓存在调用方
import { eq, sql } from 'drizzle-orm';
import { rowsOf, type Tx } from '../client.js';
import { conversations, tenants, turnTraces, usageDaily } from '../schema.js';

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

/** 一个会话在窗口内的转人工情况（07 R23）：来源由调用方按 originOf 判（判定只在 src/shared/origin.ts），这里只给判它要的 */
export interface HandoffRow {
  /** 会话 id（库里只有真实会话与沙箱会话，没有 sim-、wecom:cust_） */
  id: string;
  /** state.seed === true（沙箱开通时给种子会话打的标，第 7 步） */
  seed: boolean;
  /** 窗口内有轮次（转人工率的分母） */
  active: boolean;
  /** state.handoffLog 里 at 在窗口内的各条的类型，按记录顺序 */
  kinds: string[];
}

/**
 * 窗口内有轮次、或窗口内更新过（顾问主动接手不经轮次，但会话落库会推进 updated_at）的会话，各带窗口内的转人工记录。
 * 一行一个会话，handoffLog 只在 SQL 里按窗口筛一遍、只带类型，免得把整份 state 搬出来；handoffLog 不是数组（旧数据、坏数据）当没有
 */
export async function readHandoffRows(tx: Tx, q: { since: Date }): Promise<HandoffRow[]> {
  const since = q.since.toISOString();
  const sinceMs = q.since.getTime();
  const rows = rowsOf<{ id: string; seed: boolean; active: boolean; kinds: unknown }>(
    await tx.execute(sql`
      with active as (
        select distinct ${turnTraces.conversationId} as id
          from ${turnTraces}
         where ${turnTraces.startedAt} >= ${since}::timestamptz
      )
      select ${conversations.id} as id,
             coalesce((${conversations.state}->>'seed') = 'true', false) as seed,
             (${conversations.id} in (select id from active)) as active,
             coalesce(
               (select json_agg(e->>'kind')
                  from json_array_elements(
                         case when json_typeof(${conversations.state}->'handoffLog') = 'array'
                              then ${conversations.state}->'handoffLog' else '[]'::json end) as e
                 where (e->>'at')::float8 >= ${sinceMs}::float8),
               '[]'::json) as kinds
        from ${conversations}
       where ${conversations.id} in (select id from active)
          or ${conversations.updatedAt} >= ${since}::timestamptz`),
  );
  return rows.map((r) => ({
    id: r.id,
    seed: r.seed === true,
    active: r.active === true,
    kinds: Array.isArray(r.kinds) ? r.kinds.map(String) : [],
  }));
}
