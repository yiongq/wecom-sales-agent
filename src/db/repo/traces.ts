// 逐轮 trace 与护栏事件（02 spec「逐轮 trace、护栏事件与用量」）：只追加，在落库第 6 步的存档点里写。
// 后台读接口（第 13 步挂上）用的四个读法也在这里：每轮的步骤摘要、护栏改写对照、trace 原文、消息上的改写句数。
// 改写对照与改写句数给 J 页的都是相对模型原稿的净差（netGuardDiff）：逐事件的 removed / added 不能直接相加
import { and, asc, desc, eq, lt, ne, sql, type SQL } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { conversations, guardEvents, messages, turnTraces } from '../schema.js';
import type { GuardVerdict, ReplyShape } from '../../core/pack-api.js';

export interface TurnTraceRow {
  id: string;
  conversationId: string;
  startedAt: Date;
  durationMs: number;
  outcome: 'replied' | 'silent' | 'handoff' | 'deterministic' | 'reset' | 'budget' | 'error';
  sopVersion: number | null;
  prefixHash: string;
  /** { 'route:r-guizhou': 2 } */
  catalogVersions: Record<string, number>;
  stageBefore: string | null;
  stageAfter: string | null;
  draft: string | null;
  finalText: string | null;
  calls: unknown[];
  llm: unknown[];
  signals: unknown;
  guardVerdicts?: GuardVerdict[] | null;
  /** 06 R10：本轮回复的形状；未进入主回复流水线为 null */
  replyShape?: ReplyShape | null;
}

export interface GuardEventRow {
  turnId: string;
  /** 在这一轮里的序号 */
  ord: number;
  guard: string;
  action: 'drop_sentence' | 'replace' | 'patch' | 'append' | 'strip' | 'handoff';
  removed: string[];
  added: string[];
}

export async function insertTurnTraces(tx: Tx, rows: readonly TurnTraceRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.insert(turnTraces).values(
    rows.map((r) => ({
      tenantId,
      ...r,
      signals: r.signals ?? null,
      guardVerdicts: r.guardVerdicts ?? null,
      replyShape: r.replyShape ?? null,
    })),
  );
}

/** 要排在所属 trace 之后写（外键） */
export async function insertGuardEvents(tx: Tx, rows: readonly GuardEventRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.insert(guardEvents).values(rows.map((r) => ({ tenantId, ...r })));
}

// ---------------- 读（后台接口，第 13 步挂上；读路径之外，轮次里不调） ----------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一轮的工具步骤摘要（GET /conversations/:id/turns）：只有工具名与是不是引擎预取，不含参数、结果与耗时 */
export interface TurnStepsRow {
  turnId: string;
  startedAt: Date;
  outcome: TurnTraceRow['outcome'];
  steps: { name: string; prefetch: boolean }[];
}

/** 这个会话库里的每一轮（按开始时间），步骤在库里就摘好，不把参数与结果读出来 */
export async function readTurnSteps(tx: Tx, conversationId: string): Promise<TurnStepsRow[]> {
  const rows = await tx
    .select({
      turnId: turnTraces.id,
      startedAt: turnTraces.startedAt,
      outcome: turnTraces.outcome,
      steps: sql<{ name: string; prefetch: boolean }[]>`coalesce((
        select json_agg(json_build_object('name', c->>'name', 'prefetch', coalesce((c->>'prefetch')::boolean, false)) order by n)
          from json_array_elements(${turnTraces.calls}) with ordinality as x(c, n)), '[]'::json)`,
    })
    .from(turnTraces)
    .where(eq(turnTraces.conversationId, conversationId))
    .orderBy(asc(turnTraces.startedAt), asc(turnTraces.id));
  return rows;
}

/** 这一轮属于这个会话吗（turnId 不是 uuid 也算不属于，不发查询） */
async function turnOf(tx: Tx, conversationId: string, turnId: string): Promise<boolean> {
  if (!UUID_RE.test(turnId)) return false;
  const rows = await tx
    .select({ id: turnTraces.id })
    .from(turnTraces)
    .where(and(eq(turnTraces.id, turnId), eq(turnTraces.conversationId, conversationId)));
  return rows.length > 0;
}

/**
 * 一轮的护栏事件按 ord 串起来、相对模型原稿的净差：后面的事件删掉的、本轮前面某个事件补上的句子互相抵消（删了又补回的同样抵消）。
 * 逐事件的 removed / added 不能直接相加：同一句先被一道护栏改、再被下一道改时（去掉站外链接之后整句换成兜底），
 * 中间那句会被算成「删去」，句数也多算一遍。同一句出现几次按几次算；删去与补上各按第一次出现的顺序
 */
export function netGuardDiff(events: readonly { removed: readonly string[]; added: readonly string[] }[]): {
  removed: string[];
  added: string[];
} {
  const removed: string[] = [];
  const added: string[] = [];
  const take = (list: string[], s: string): boolean => {
    const i = list.indexOf(s);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  };
  for (const e of events) {
    for (const s of e.removed) if (!take(added, s)) removed.push(s);
    for (const s of e.added) if (!take(removed, s)) added.push(s);
  }
  return { removed, added };
}

/** 护栏改写对照：removed / added 是相对模型原稿的净差（J 页「删去 / 发出」对照读它），events 是逐事件的原样（按 ord） */
export interface TurnDiff {
  removed: string[];
  added: string[];
  events: GuardEventRow[];
}

/** 护栏改写对照（GET /conversations/:id/turns/:turnId/diff）：这一轮的护栏事件按 ord 排与它们的净差；这一轮不在这个会话名下时为 null */
export async function readTurnDiff(tx: Tx, conversationId: string, turnId: string): Promise<TurnDiff | null> {
  if (!(await turnOf(tx, conversationId, turnId))) return null;
  const events = await tx
    .select({
      turnId: guardEvents.turnId,
      ord: guardEvents.ord,
      guard: guardEvents.guard,
      action: guardEvents.action,
      removed: guardEvents.removed,
      added: guardEvents.added,
    })
    .from(guardEvents)
    .where(eq(guardEvents.turnId, turnId))
    .orderBy(asc(guardEvents.ord));
  return { ...netGuardDiff(events), events };
}

/** trace 原文（GET /conversations/:id/turns/:turnId，只给所有者、管理员）：整行；这一轮不在这个会话名下时为 null */
export async function readTurnTrace(tx: Tx, conversationId: string, turnId: string): Promise<TurnTraceRow | null> {
  if (!UUID_RE.test(turnId)) return null;
  const [r] = await tx
    .select({
      id: turnTraces.id,
      conversationId: turnTraces.conversationId,
      startedAt: turnTraces.startedAt,
      durationMs: turnTraces.durationMs,
      outcome: turnTraces.outcome,
      sopVersion: turnTraces.sopVersion,
      prefixHash: turnTraces.prefixHash,
      catalogVersions: turnTraces.catalogVersions,
      stageBefore: turnTraces.stageBefore,
      stageAfter: turnTraces.stageAfter,
      draft: turnTraces.draft,
      finalText: turnTraces.finalText,
      calls: turnTraces.calls,
      llm: turnTraces.llm,
      signals: turnTraces.signals,
      guardVerdicts: turnTraces.guardVerdicts,
      replyShape: turnTraces.replyShape,
    })
    .from(turnTraces)
    .where(and(eq(turnTraces.id, turnId), eq(turnTraces.conversationId, conversationId)));
  return r ?? null;
}

/**
 * 这一轮 AI 回复之前的那条客户消息（07 R24，trace 详情的 customerText）：这一轮的回复消息（messages.turn_id）里 seq 最小的那条之前、
 * 同一会话最近的一条客户消息。这一轮没有发出回复（沉默）时没有回复消息，为 null；turn_traces 不存客户原话，所以从 messages 取
 */
export async function readTurnCustomerMessage(
  tx: Tx,
  conversationId: string,
  turnId: string,
): Promise<{ seq: number; content: string } | null> {
  if (!UUID_RE.test(turnId)) return null;
  const [row] = rowsOf<{ seq: number; content: string }>(
    await tx.execute(sql`
      select m.seq::int as seq, m.content as content
        from ${messages} m
       where m.conversation_id = ${conversationId}
         and m.role = 'customer'
         and m.seq < (select min(a.seq) from ${messages} a where a.conversation_id = ${conversationId} and a.turn_id = ${turnId}::uuid)
       order by m.seq desc
       limit 1`),
  );
  return row ? { seq: Number(row.seq), content: row.content } : null;
}

/** 「存为回归用例」要的材料（07 R24）：这一轮的 trace、会话行的 ref、这一轮的客户原话和它之前的最近几条消息（升序，不含 system） */
export interface TurnExportSource {
  trace: TurnTraceRow;
  /** 会话行的 ref（不含客户标识）：审计的 target */
  ref: string;
  customer: { seq: number; content: string } | null;
  history: { role: 'customer' | 'agent'; content: string }[];
}

/** 这一轮不在这个会话名下（或会话行不在）时为 null */
export async function readTurnExportSource(
  tx: Tx,
  conversationId: string,
  turnId: string,
  historyLimit: number,
): Promise<TurnExportSource | null> {
  const trace = await readTurnTrace(tx, conversationId, turnId);
  if (!trace) return null;
  const [conv] = await tx.select({ ref: conversations.ref }).from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return null;
  const customer = await readTurnCustomerMessage(tx, conversationId, turnId);
  // 客户那条之前最近的 historyLimit 条客户与回复消息（system 不算，不占名额）
  const before = customer
    ? await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), lt(messages.seq, customer.seq), ne(messages.role, 'system')))
        .orderBy(desc(messages.seq))
        .limit(historyLimit)
    : [];
  const history = before.toReversed().flatMap((m) => (m.role === 'system' ? [] : [{ role: m.role, content: m.content }]));
  return { trace, ref: conv.ref, customer, history };
}

// ---------------- AI 记录列表（07 R24） ----------------

export interface TraceListFilter {
  /** 含 */
  since?: string;
  /** 不含 */
  until?: string;
  outcome?: TurnTraceRow['outcome'];
  /** 主回复步骤的 id：guard_verdicts 里这一步的 action 不是 pass */
  guard?: string;
  /** 这一轮触发的转人工原因：会话 handoffLog 里 turnId 对得上的记录里有这一类 */
  handoffKind?: string;
  overLimit?: boolean;
  /** 上一页的 next：`<开始时刻 UTC 微秒>_<轮次 id>` */
  before?: string;
  limit: number;
}

export interface TraceListRow {
  turnId: string;
  conversationId: string;
  channel: string;
  startedAt: Date;
  durationMs: number;
  outcome: TurnTraceRow['outcome'];
  guards: string[];
  handoffKind: string | null;
  overLimit: boolean;
}

/** guard_verdicts 当数组读（NULL、JSON null、不是数组的坏数据都当空）；handoffLog 同 */
const arrayOf = (col: SQL): SQL => sql`(case when json_typeof(${col}) = 'array' then ${col} else '[]'::json end)`;

/**
 * 跨会话的 AI 记录：按开始时间倒序（同一时刻按轮次 id 倒序），游标翻页。筛选全在 SQL 里做，带租户作用域（turn_traces、conversations
 * 都是 FORCE RLS，只看得到本租户的行）。会话的 state 是 json 列，转人工原因只取 handoffLog 里 turnId 对得上的那几条，不把整份 state 搬出来：
 * 带 handoffKind 筛选时先在候选里筛，没带时只给这一页的行去查。多取一行判断还有没有下一页
 */
export async function listTraces(tx: Tx, f: TraceListFilter): Promise<{ rows: TraceListRow[]; next: string | null }> {
  const conds: SQL[] = [sql`true`];
  if (f.since !== undefined) conds.push(sql`t.started_at >= ${f.since}::timestamptz`);
  if (f.until !== undefined) conds.push(sql`t.started_at < ${f.until}::timestamptz`);
  if (f.outcome !== undefined) conds.push(sql`t.outcome = ${f.outcome}`);
  if (f.overLimit) conds.push(sql`(t.reply_shape->>'overLimit') = 'true'`);
  if (f.guard !== undefined) {
    conds.push(sql`exists (
      select 1 from json_array_elements(${arrayOf(sql`t.guard_verdicts`)}) as v
       where v->>'id' = ${f.guard} and v->>'action' is distinct from 'pass')`);
  }
  if (f.handoffKind !== undefined) {
    // 会话的 state 是 json 列，每次取键都要重新解析整份：handoffLog 只取一次（lateral），再展开
    conds.push(sql`exists (
      select 1
        from ${conversations} hc
       cross join lateral (select hc.state->'handoffLog' as hl) h
       cross join lateral json_array_elements(${arrayOf(sql`h.hl`)}) as e
       where hc.tenant_id = t.tenant_id and hc.id = t.conversation_id and e->>'turnId' = t.id::text and e->>'kind' = ${f.handoffKind})`);
  }
  if (f.before !== undefined) {
    const at = f.before.indexOf('_');
    conds.push(sql`(t.started_at, t.id) < (${f.before.slice(0, at)}::timestamptz, ${f.before.slice(at + 1)}::uuid)`);
  }
  const raw = rowsOf<{
    id: string;
    conversation_id: string;
    channel: string;
    started_ms: number;
    cursor_ts: string;
    duration_ms: number;
    outcome: TurnTraceRow['outcome'];
    guards: unknown;
    over_limit: boolean;
    handoff_kind: string | null;
  }>(
    await tx.execute(sql`
      with page as (
        select t.tenant_id, t.id, t.conversation_id, t.started_at, t.duration_ms, t.outcome, t.guard_verdicts, t.reply_shape
          from ${turnTraces} t
         where ${sql.join(conds, sql` and `)}
         order by t.started_at desc, t.id desc
         limit ${f.limit + 1}
      )
      select p.id::text as id,
             p.conversation_id as conversation_id,
             c.channel as channel,
             (extract(epoch from p.started_at) * 1000)::float8 as started_ms,
             to_char(p.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts,
             p.duration_ms::int as duration_ms,
             p.outcome as outcome,
             coalesce((select json_agg(v->>'id' order by n)
                         from json_array_elements(${arrayOf(sql`p.guard_verdicts`)}) with ordinality as x(v, n)
                        where v->>'action' is distinct from 'pass'), '[]'::json) as guards,
             coalesce((p.reply_shape->>'overLimit') = 'true', false) as over_limit,
             (select e->>'kind'
                from json_array_elements(${arrayOf(sql`c.state->'handoffLog'`)}) with ordinality as y(e, n)
               where e->>'turnId' = p.id::text
               order by n desc
               limit 1) as handoff_kind
        from page p
        join ${conversations} c on c.tenant_id = p.tenant_id and c.id = p.conversation_id
       order by p.started_at desc, p.id desc`),
  );
  const parseGuards = (v: unknown): string[] => {
    const list: unknown = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(list) ? list.map(String) : [];
  };
  const shown = raw.slice(0, f.limit);
  const last = shown.at(-1);
  return {
    rows: shown.map((r) => ({
      turnId: r.id,
      conversationId: r.conversation_id,
      channel: r.channel,
      startedAt: new Date(Math.round(Number(r.started_ms))),
      durationMs: Number(r.duration_ms),
      outcome: r.outcome,
      guards: parseGuards(r.guards),
      handoffKind: r.handoff_kind,
      overLimit: r.over_limit === true,
    })),
    next: raw.length > f.limit && last ? `${last.cursor_ts}_${last.id}` : null,
  };
}

/**
 * J 页消息上的「AI原稿里删了N句」（MessageView.guarded）：这些轮次相对模型原稿的净差（netGuardDiff）里删去与补上的句数，
 * 不是逐事件的句数之和。没有护栏事件、或净差为空（删了又补回）的轮次不在结果里
 */
export async function readGuardTotals(tx: Tx, turnIds: readonly string[]): Promise<Map<string, { removed: number; added: number }>> {
  const ids = turnIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, { removed: number; added: number }>();
  if (!ids.length) return out;
  const rows = await tx
    .select({ turnId: guardEvents.turnId, removed: guardEvents.removed, added: guardEvents.added })
    .from(guardEvents)
    .where(sql`${guardEvents.turnId} = any(${sql.param([...ids])}::uuid[])`)
    .orderBy(asc(guardEvents.turnId), asc(guardEvents.ord));
  const byTurn = new Map<string, { removed: string[]; added: string[] }[]>();
  for (const r of rows) {
    const list = byTurn.get(r.turnId);
    if (list) list.push(r);
    else byTurn.set(r.turnId, [r]);
  }
  for (const [turnId, events] of byTurn) {
    const net = netGuardDiff(events);
    if (net.removed.length || net.added.length) out.set(turnId, { removed: net.removed.length, added: net.added.length });
  }
  return out;
}
