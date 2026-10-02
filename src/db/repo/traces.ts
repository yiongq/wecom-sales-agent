// 逐轮 trace 与护栏事件（02 spec「逐轮 trace、护栏事件与用量」）：只追加，在落库第 6 步的存档点里写
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
