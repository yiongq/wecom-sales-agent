// 16 R5、R6：解析、续跑和留出集预检只读传入的证据；时间由调用方给。
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SimGoal } from './goals.js';
import type { Charge, RunResult } from './runner.js';
import type { Freeze, LedgerLine, RunKind, RunMeta, Trees } from './report-types.js';

export interface Journal {
  meta: RunMeta;
  runs: RunResult[];
}
export const runKey = (goalId: string, repetition: number): string => JSON.stringify([goalId, repetition]);
function lines(bytes: Buffer): { records: unknown[]; length: number } {
  const length = bytes.lastIndexOf(10) + 1;
  try {
    return {
      records: bytes
        .subarray(0, length)
        .toString('utf8')
        .split('\n')
        .slice(0, -1)
        .map((s) => JSON.parse(s)),
      length,
    };
  } catch {
    throw new Error('jsonl_invalid');
  }
}
export function readJournal(bytes: Buffer): Journal & { length: number } {
  const { records, length } = lines(bytes);
  const [head, ...rest] = records as { type?: string; meta?: RunMeta; run?: RunResult }[];
  if (!head || head.type !== 'head' || !head.meta?.runId || !head.meta.startedAt) throw new Error('journal_head_invalid');
  if (rest.some((r) => r.type !== 'run' || !r.run?.goalId || !Number.isSafeInteger(r.run.repetition) || !Array.isArray(r.run.charges)))
    throw new Error('journal_run_invalid');
  function checkSnapshots(run: RunResult): void {
    for (const turn of run.turns ?? []) {
      const before = turn.sessionBefore;
      if (before !== undefined && (!before || !before.session || typeof before.session !== 'object' || !Array.isArray(before.orders)))
        throw new Error('journal_session_before_invalid');
    }
    if (run.replaced) checkSnapshots(run.replaced);
  }
  for (const r of rest) checkSnapshots(r.run!);
  return { meta: head.meta, runs: rest.map((r) => r.run!), length };
}
const resumeFields = [
  'head',
  'trees',
  'kind',
  'salesModel',
  'hedgeModel',
  'hedgeMs',
  'customerModel',
  'k',
  'budget',
  'promptHash',
  'policyHash',
] as const;
export function checkResume(saved: RunMeta, current: RunMeta): void {
  for (const key of resumeFields) if (!isDeepStrictEqual(saved[key], current[key])) throw new Error(`journal_mismatch:${key}`);
}
export function resumeState(journal: Journal): { completed: Set<string>; charges: Charge[]; runs: RunResult[] } {
  // budget_stop 也进账；同一遍随后完成时，报告只用最后一次有结论的结果。
  const done = new Map<string, RunResult>();
  for (const r of journal.runs) if (r.status !== 'budget_stop') done.set(runKey(r.goalId, r.repetition), r);
  return { completed: new Set(done.keys()), charges: journal.runs.flatMap((r) => r.charges), runs: [...done.values()] };
}
export async function openJournal(file: string, meta: RunMeta): Promise<Journal> {
  const bytes = await fs.readFile(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (bytes) {
    const saved = readJournal(bytes);
    checkResume(saved.meta, meta);
    if (saved.length !== bytes.length) await fs.truncate(file, saved.length);
    return { meta: saved.meta, runs: saved.runs };
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: 'head', meta }) + '\n', { flag: 'wx' });
  return { meta, runs: [] };
}
export async function appendRun(file: string, run: RunResult): Promise<void> {
  await fs.appendFile(file, JSON.stringify({ type: 'run', run }) + '\n');
}
export function readLedger(text: string): LedgerLine[] {
  const records = lines(Buffer.from(text)).records as LedgerLine[];
  if (records.some((r) => !r || !['start', 'end'].includes(r.event) || !r.runId || !r.at || !r.trees)) throw new Error('ledger_invalid');
  return records;
}
export async function ledgerFile(file: string): Promise<LedgerLine[]> {
  return readLedger(
    await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    }),
  );
}
export async function appendLedger(file: string, line: LedgerLine): Promise<void> {
  const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  if (text && !text.endsWith('\n')) throw new Error('ledger_partial_line');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(line) + '\n');
}
export function ledgerStart(meta: RunMeta, at: string, reason?: string): LedgerLine {
  return {
    event: 'start',
    runId: meta.runId,
    kind: meta.kind,
    at,
    commit: meta.head,
    trees: meta.trees,
    salesModel: meta.salesModel,
    customerModel: meta.customerModel,
    k: meta.k,
    budget: meta.budget,
    ...(reason ? { reason } : {}),
  };
}
export function ledgerEnd(start: LedgerLine, runs: RunResult[], charges: Charge[], at: string): LedgerLine {
  return {
    ...start,
    event: 'end',
    at,
    passed: runs.filter((r) => r.status === 'passed').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    excluded: runs.filter((r) => ['customer_protocol', 'customer_http', 'customer_drift'].includes(r.status)).length,
    spentMilli: Math.round(charges.reduce((s, c) => s + c.cny, 0) * 1000),
  };
}
export function matchingStart(
  ledger: LedgerLine[],
  meta: Pick<RunMeta, 'kind' | 'trees' | 'salesModel' | 'customerModel' | 'k' | 'budget'>,
): LedgerLine | undefined {
  return ledger.findLast(
    (s) =>
      s.event === 'start' &&
      !ledger.some((e) => e.event === 'end' && e.runId === s.runId) &&
      (['kind', 'trees', 'salesModel', 'customerModel', 'k', 'budget'] as const).every((k) => isDeepStrictEqual(s[k], meta[k])),
  );
}
export interface HoldoutOptions {
  kind?: RunKind;
  ledger?: string;
  configDir?: string;
  k: number;
  budget: number;
  model?: string;
  tag?: string;
  rerun?: number;
  reason?: string;
}
export function holdoutPreflight(input: {
  opts: HoldoutOptions;
  goals: SimGoal[];
  ledger: LedgerLine[];
  committedLedger: LedgerLine[];
  freeze: Freeze | null;
  status: string;
  trees: Trees;
  start?: LedgerLine;
  phase?: 'prepare' | 'run';
  root?: string;
}): void {
  const { opts, goals, ledger, committedLedger, freeze, status, trees, start } = input;
  const splits = new Set(goals.flatMap((g) => (g.journey ? [g.journey.split] : [])));
  if (!splits.has('holdout')) return;
  if (splits.has('dev') || goals.some((g) => !g.journey)) throw new Error('holdout_mixed_split');
  if (opts.kind !== 'main' && opts.kind !== 'customer_swap') throw new Error('holdout_kind_required');
  if (!opts.ledger) throw new Error('holdout_ledger_required');
  const relative = (file: string) =>
    path.posix.normalize(input.root && path.posix.isAbsolute(file) ? path.posix.relative(input.root, file) : file);
  const ledgerPath = relative(opts.ledger);
  if (
    status
      .split('\n')
      .filter(Boolean)
      .some((s) => {
        const name = s.slice(3);
        return name !== ledgerPath && name !== JSON.stringify(ledgerPath);
      })
  )
    throw new Error('holdout_dirty_worktree');
  if (!freeze || !isDeepStrictEqual(freeze.trees, trees)) throw new Error('holdout_tree_mismatch');
  if (relative(opts.configDir ?? '') !== 'data/packs/industrial') throw new Error('holdout_config_dir');
  if (opts.k !== 5) throw new Error('holdout_k');
  if (opts.tag !== undefined || opts.rerun !== undefined) throw new Error('holdout_filter');
  if (!start || start.event !== 'start' || start.kind !== opts.kind || !isDeepStrictEqual(start.trees, trees))
    throw new Error('holdout_start_required');
  if (start.budget !== opts.budget || !opts.model || opts.model !== start.customerModel || start.k !== opts.k)
    throw new Error('holdout_start_mismatch');
  if (input.phase !== 'prepare' && !ledger.some((s) => isDeepStrictEqual(s, start))) throw new Error('holdout_start_required');
  if (input.phase !== 'prepare' && !committedLedger.some((s) => isDeepStrictEqual(s, start))) throw new Error('holdout_start_uncommitted');
  const completeMain = ledger.filter(
    (s) =>
      s.event === 'start' &&
      s.kind === 'main' &&
      isDeepStrictEqual(s.trees, trees) &&
      ledger.some(
        (e) =>
          e.event === 'end' &&
          e.runId === s.runId &&
          e.kind === 'main' &&
          isDeepStrictEqual(e.trees, trees) &&
          e.customerModel === s.customerModel &&
          (e.passed ?? 0) + (e.failed ?? 0) + (e.excluded ?? 0) === goals.length * s.k,
      ),
  );
  if (opts.kind === 'customer_swap' && !completeMain.some((s) => s.customerModel !== opts.model))
    throw new Error('holdout_swap_requires_main');
  if (opts.kind === 'main' && completeMain.length) {
    if (!opts.reason?.trim()) throw new Error('holdout_reason_required');
    if (start.reason !== opts.reason) throw new Error('holdout_reason_unrecorded');
  }
}
