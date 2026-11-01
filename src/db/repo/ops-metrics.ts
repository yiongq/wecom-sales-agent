// 17 R5：摘要与趋势共用；窗口由部署时区的本地零点产生，SQL 不推算日期。
import { eq, sql } from 'drizzle-orm';
import { rowsOf, type Tx } from '../client.js';
import { tenants } from '../schema.js';
import { SEED_ORDER_PREFIX, SEED_SESSION_PREFIX, VISITOR_SESSION_PREFIX } from '../../shared/origin.js';

export interface DayWindow {
  day: string;
  from: Date;
  to: Date;
}
export interface DailyMetricsRow {
  day: string;
  receptions: number;
  turns: number;
  replySamples: number;
  replyP90Ms: number | null;
  handoffSessions: number;
  aiErrorTurns: number;
  costMilli: number;
  paidOrders: number;
}

export async function readOpsTenant(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({
      retention: tenants.retentionTraceDays,
      status: tenants.status,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new Error('tenant_missing');
  return row;
}

// 日指标与五分钟窗口必须复用这一整段有效回复及来源谓词。
function customerTurns() {
  return sql`select t.*, w.day,
    (t.outcome = 'replied' and t.duration_ms >= 0 and exists (
      select 1 from messages m where m.tenant_id = t.tenant_id
        and m.conversation_id = t.conversation_id and m.turn_id = t.id
        and m.role = 'agent' and (m.author is null or m.author = 'ai')
    )) as valid_reply
    from windows w
    join turn_traces t on t.started_at >= w."from" and t.started_at < w."to"
    join conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
    join tenants tenant on tenant.id = t.tenant_id and tenant.kind = 'standard'
    where coalesce(c.state->>'seed', 'false') <> 'true'
      and starts_with(c.id, ${SEED_SESSION_PREFIX}) = false
      and starts_with(c.id, ${VISITOR_SESSION_PREFIX}) = false`;
}
export interface ReplyWindow {
  samples: number;
  p90Ms: number | null;
  traceId: string | null;
}
export async function readReplyWindow(tx: Tx, end: number): Promise<ReplyWindow> {
  return rowsOf<ReplyWindow>(
    await tx.execute(sql`
    with windows as (select '' as day, ${new Date(end - 300_000).toISOString()}::timestamptz as "from",
      ${new Date(end).toISOString()}::timestamptz as "to"), customer_turns as (${customerTurns()})
    select count(*)::int as samples,
      (percentile_cont(0.9) within group (order by duration_ms))::float8 as "p90Ms",
      (select id from customer_turns where valid_reply order by duration_ms desc, id limit 1) as "traceId"
    from customer_turns where valid_reply
  `),
  )[0]!;
}

/** 使用共享前缀的精确 startsWith 语义：不用 LIKE，避免前缀中的下划线被当作通配符。 */
export async function readDailyMetrics(tx: Tx, windows: readonly DayWindow[]): Promise<DailyMetricsRow[]> {
  if (!windows.length) return [];
  return rowsOf<DailyMetricsRow>(
    await tx.execute(sql`
    with windows as (
      select * from jsonb_to_recordset(${JSON.stringify(
        windows.map((w) => ({
          day: w.day,
          from: w.from.toISOString(),
          to: w.to.toISOString(),
        })),
      )}::jsonb) as w(day text, "from" timestamptz, "to" timestamptz)
    ), customer_turns as (
      ${customerTurns()}
    )
    select w.day,
      (select count(distinct t.conversation_id)::int from customer_turns t where t.day=w.day) as receptions,
      (select count(*)::int from customer_turns t where t.day=w.day) as turns,
      (select count(*)::int from customer_turns t where t.day=w.day and valid_reply) as "replySamples",
      (select (percentile_cont(0.9) within group (order by t.duration_ms))::float8
        from customer_turns t where t.day=w.day and valid_reply) as "replyP90Ms",
      (select count(distinct t.conversation_id)::int from customer_turns t
        where t.day=w.day and t.outcome='handoff') as "handoffSessions",
      (select count(*)::int from customer_turns t where t.day=w.day and (t.outcome='error' or exists (
        select 1 from json_array_elements(t.llm) e where e->>'error' is not null
      ))) as "aiErrorTurns",
      (select coalesce(sum(u.cost_milli_cny),0)::float8 from usage_daily u
        where u.day=w.day::date) as "costMilli",
      (select count(*)::int from orders o
        join tenants tenant on tenant.id=o.tenant_id and tenant.kind='standard'
        left join conversations c on c.tenant_id=o.tenant_id and c.id=o.session_id
        where o.paid_at >= w."from" and o.paid_at < w."to"
          and o.status in ('paid','refund_pending','refunded') and o.voided_at is null
          and starts_with(o.id, ${SEED_ORDER_PREFIX}) = false
          and coalesce(c.state->>'seed','false') <> 'true'
          and starts_with(coalesce(o.session_id, o.data->>'sessionId', ''), ${SEED_SESSION_PREFIX}) = false
          and starts_with(coalesce(o.session_id, o.data->>'sessionId', ''), ${VISITOR_SESSION_PREFIX}) = false
      ) as "paidOrders"
    from windows w order by w.day
  `),
  );
}
