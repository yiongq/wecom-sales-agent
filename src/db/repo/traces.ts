// 逐轮 trace 与护栏事件（02 spec「逐轮 trace、护栏事件与用量」）：只追加，在落库第 6 步的存档点里写。
// 后台读接口（第 13 步挂上）用的四个读法也在这里：每轮的步骤摘要、护栏改写对照、trace 原文、消息上的改写句数
import { and, asc, eq, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { guardEvents, turnTraces } from '../schema.js';

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
  await tx.insert(turnTraces).values(rows.map((r) => ({ tenantId, ...r, signals: r.signals ?? null })));
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

/** 护栏改写对照（GET /conversations/:id/turns/:turnId/diff）：这一轮的护栏事件按 ord 排；这一轮不在这个会话名下时为 null */
export async function readTurnDiff(tx: Tx, conversationId: string, turnId: string): Promise<GuardEventRow[] | null> {
  if (!(await turnOf(tx, conversationId, turnId))) return null;
  return tx
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
    })
    .from(turnTraces)
    .where(and(eq(turnTraces.id, turnId), eq(turnTraces.conversationId, conversationId)));
  return r ?? null;
}

/** J 页消息上的「AI原稿里删了N句」（MessageView.guarded）：这些轮次的护栏事件里删去与补上的句数之和；没有护栏事件的轮次不在结果里 */
export async function readGuardTotals(tx: Tx, turnIds: readonly string[]): Promise<Map<string, { removed: number; added: number }>> {
  const ids = turnIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, { removed: number; added: number }>();
  if (!ids.length) return out;
  const rows = await tx
    .select({
      turnId: guardEvents.turnId,
      removed: sql<number>`sum(json_array_length(${guardEvents.removed}))::int`,
      added: sql<number>`sum(json_array_length(${guardEvents.added}))::int`,
    })
    .from(guardEvents)
    .where(sql`${guardEvents.turnId} = any(${sql.param([...ids])}::uuid[])`)
    .groupBy(guardEvents.turnId);
  for (const r of rows) out.set(r.turnId, { removed: Number(r.removed), added: Number(r.added) });
  return out;
}
