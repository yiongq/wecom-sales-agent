// 逐轮 trace 与护栏事件（02 spec「逐轮 trace、护栏事件与用量」）：只追加，在落库第 6 步的存档点里写。
// 后台读接口（第 13 步挂上）用的四个读法也在这里：每轮的步骤摘要、护栏改写对照、trace 原文、消息上的改写句数。
// 改写对照与改写句数给 J 页的都是相对模型原稿的净差（netGuardDiff）：逐事件的 removed / added 不能直接相加
import { and, asc, eq, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { guardEvents, turnTraces } from '../schema.js';
import type { GuardVerdict } from '../../core/pack-api.js';

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
  await tx
    .insert(turnTraces)
    .values(rows.map((r) => ({ tenantId, ...r, signals: r.signals ?? null, guardVerdicts: r.guardVerdicts ?? null })));
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
    })
    .from(turnTraces)
    .where(and(eq(turnTraces.id, turnId), eq(turnTraces.conversationId, conversationId)));
  return r ?? null;
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
