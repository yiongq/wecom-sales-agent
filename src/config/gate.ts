// 07 R7–R10：长评测在事务外串行执行；父进程只捕获配置快照、读报告与落库。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { withTenant, lockTenantConfig, type TenantCtx } from '../db/client.js';
import { insertGate, readGate, updateGate, gatesSince, baselineFor, type GateRow } from '../db/repo/gate.js';
import { addUsage } from '../db/repo/usage.js';
import { todayIso } from '../env.js';
import { llmCfg } from '../core/llm/client.js';
import { currentRuntime, withTenantScope, type TenantRuntime } from '../tenancy/runtime.js';
import { initializeStandardBudget } from '../tenancy/budget.js';
import { registerTenantState } from '../tenancy/state.js';
import type { GateGoalResult, GateRunView, StartGateResult } from '../shared/console-api.js';
import { joinSop } from '../sop/sections.js';
import { configRuntime, assertConfigWritable } from './source.js';
import { gateDraftSnapshot, SopNotFoundError } from './sop.js';
import { sha256 } from './hashes.js';
import { GateError, GateSkippedError } from './gate-errors.js';
export { GateError, GateSkippedError } from './gate-errors.js';
export type { GateGoalResult, GateRunView } from '../shared/console-api.js';

function positive(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`无效的 ${name}`);
  return n;
}
function revision(): string {
  if (process.env.APP_REVISION) return process.env.APP_REVISION;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('闸需要 APP_REVISION 或 git 代码版本');
  }
}
/** 模型配置先解析再投影到通用 LLM_*，DeepSeek 的专用变量也不会额外放进子进程。 */
export function gateEnvironment(tmp: string): NodeJS.ProcessEnv {
  const cfg = llmCfg();
  const cheap = llmCfg(true);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(LLM_|ZHIPU_|EMBED_)/.test(k) || k === 'TZ') env[k] = v;
  return {
    ...env,
    LLM_PROVIDER: '',
    LLM_BASE_URL: cfg.baseUrl,
    LLM_API_KEY: cfg.apiKey,
    LLM_MODEL: cfg.model,
    LLM_MODEL_CHEAP: cheap.model,
    LLM_MAX_INFLIGHT: '1',
    TMPDIR: tmp,
    TSX_DISABLE_CACHE: '1',
  };
}
function mockModel(): boolean {
  const url = new URL(llmCfg().baseUrl);
  return process.env.LLM_MOCK === '1' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
async function targets() {
  const dir = path.resolve(__gateTest.goalsDir ?? 'eval/sim/goals/quality');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).toSorted();
  const selected: { id: string; text: string }[] = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    const raw = JSON.parse(text) as unknown;
    for (const goal of (Array.isArray(raw) ? raw : [raw]) as { id: string; tags?: string[] }[])
      if (goal.tags?.includes('regression')) selected.push({ id: goal.id, text: JSON.stringify(goal) });
  }
  if (!selected.length) throw new Error('没有 regression 目标');
  return { dir, ids: selected.map((g) => g.id), hash: sha256(JSON.stringify(selected)) };
}
interface Progress {
  owner: TenantRuntime;
  runId: string;
  value: { done: number; total: number } | null;
  child: ChildProcess | null;
  cancelled: boolean;
  costMilli: number;
  work: Promise<void> | null;
}
// 实例单槽只负责串行调度；持有租户数据的项另在 gate.progress 登记、删除时取消。
let slot: Promise<void> = Promise.resolve();
const progress = new Map<string, Progress>();
function cancel(id: string): void {
  const entry = progress.get(id);
  if (!entry) return;
  entry.cancelled = true;
  entry.child?.kill('SIGKILL');
}
export async function stopTenantGates(id: string): Promise<void> {
  const entry = progress.get(id);
  cancel(id);
  await entry?.work;
}
registerTenantState({
  name: 'gate.progress',
  keyCount: (id) => Number(progress.has(id)),
  drop: (id) => {
    cancel(id);
    progress.delete(id);
  },
  reset: () => {
    for (const id of progress.keys()) cancel(id);
    progress.clear();
  },
});

export function gateVerdict(draft: GateGoalResult[], baseline: GateGoalResult[]) {
  const before = new Map(baseline.map((g) => [g.id, g]));
  const blocking = draft
    .filter((g) => g.tags.includes('regression') && g.result === 'fail' && before.get(g.id)?.result !== 'fail')
    .map((g) => g.id);
  const incomplete = [draft, baseline].some((side) => side.filter((g) => g.result === 'skipped_budget').length * 2 >= side.length);
  return {
    blocking,
    status: incomplete ? ('error' as const) : ('done' as const),
    verdict: incomplete ? null : blocking.length ? ('fail' as const) : ('pass' as const),
  };
}

const goalSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  attempts: z.array(
    z.object({
      pass: z.boolean(),
      failures: z.array(z.string()),
      turns: z.number().int().nonnegative(),
      costMilli: z.number().int().nonnegative(),
    }),
  ),
  result: z.enum(['pass', 'flaky', 'fail', 'skipped_budget']),
});
const usageSchema = z.object({
  model: z.string(),
  calls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costMilli: z.number().int().nonnegative(),
});
const summarySchema = z.object({
  type: z.literal('summary'),
  results: z.array(goalSchema),
  usage: z.array(usageSchema),
  costMilli: z.number().int().nonnegative(),
  budgetStopped: z.boolean(),
  metadata: z.object({ promptHash: z.string(), policyHash: z.string(), salesModel: z.string(), customerModel: z.string() }),
});
type Summary = z.infer<typeof summarySchema>;

async function exportSide(
  dir: string,
  sop: string,
  catalog: { routes: readonly unknown[]; hotels: readonly unknown[] },
  policy: unknown,
  brand: unknown,
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'sop.md'), sop);
  for (const [file, value] of [
    ['routes', catalog.routes],
    ['hotels', catalog.hotels],
    ['policy', policy],
    ...(brand ? [['brand', brand]] : []),
  ] as const)
    await fs.writeFile(path.join(dir, `${file}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function runSide(
  entry: Progress,
  root: string,
  side: 'draft' | 'published',
  budget: number,
  expected: { promptHash: string; policyHash: string },
  ids: string[],
  timeoutMs: number,
  goalsDir: string,
): Promise<Summary> {
  const report = path.join(root, `${side}.jsonl`);
  const env = gateEnvironment(path.join(root, 'tmp'));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'eval/sim/gate.ts',
      '--config-dir',
      path.join(root, side),
      '--goals',
      goalsDir,
      '--tag',
      'regression',
      '--rerun',
      '2',
      '--budget',
      String(budget),
      '--report',
      report,
    ],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  entry.child = child;
  const priorCost = entry.costMilli;
  let timedOut = false;
  let invalid = false;
  let offset = 0;
  let summary: Summary | undefined;
  let reading: Promise<void> = Promise.resolve();
  const consume = () => {
    reading = reading
      .then(async () => {
        const text = await fs.readFile(report, 'utf8').catch(() => '');
        const end = text.lastIndexOf('\n') + 1;
        for (const line of text.slice(offset, end).split('\n').filter(Boolean)) {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.type === 'start') {
            if (JSON.stringify(value.goalIds) !== JSON.stringify(ids)) throw new Error('report_invalid');
            entry.value = { done: 0, total: ids.length };
          } else if (value.type === 'goal') {
            goalSchema.parse(value);
            const done = z.number().int().min(0).max(ids.length).parse(value.done);
            if (value.total !== ids.length) throw new Error('report_invalid');
            entry.value = { done, total: ids.length };
            entry.costMilli = priorCost + z.number().int().nonnegative().parse(value.spentMilli);
          } else if (value.type === 'summary') summary = summarySchema.parse(value);
          else if (value.type !== 'error') throw new Error('report_invalid');
        }
        offset = end;
      })
      .catch(() => {
        invalid = true;
        child.kill('SIGKILL');
      });
    return reading;
  };
  const poll = setInterval(() => {
    void consume();
  }, 100);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('child_spawn')));
      child.once('close', resolve);
    });
    await consume();
    if (entry.cancelled) throw new Error('cancelled');
    if (timedOut) throw new Error('timeout');
    if (invalid) throw new Error('report_invalid');
    if ((code !== 0 && code !== 3) || !summary) throw new Error('child_exit');
    if (
      summary.metadata.promptHash !== expected.promptHash ||
      summary.metadata.policyHash !== expected.policyHash ||
      summary.metadata.salesModel !== env.LLM_MODEL ||
      summary.metadata.customerModel !== env.LLM_MODEL ||
      JSON.stringify(summary.results.map((g) => g.id)) !== JSON.stringify(ids) ||
      summary.results.some((g) => !g.tags.includes('regression')) ||
      summary.budgetStopped !== (code === 3)
    )
      throw new Error('report_invalid');
    return summary;
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    entry.child = null;
  }
}

export async function startGate(ctx: TenantCtx, input: { rev: number }): Promise<StartGateResult> {
  const owner = currentRuntime();
  if (owner.kind === 'sandbox') throw new GateSkippedError('沙箱发布不需要回归');
  assertConfigWritable();
  const runtime = configRuntime();
  if (runtime.tenantId !== ctx.tenantId) throw new Error('闸租户作用域不符');
  const goals = await targets();
  const budget = positive('SOP_GATE_BUDGET_CNY', 2);
  const daily = positive('SOP_GATE_DAILY_RUNS', 3);
  const timeoutMs = positive('SOP_GATE_TIMEOUT_MS', 1800000);
  const code = revision();
  const model = llmCfg().model;
  const mock = mockModel();
  const { row, snapshot, cached } = await withTenant(runtime.db, ctx, async (tx) => {
    await lockTenantConfig(tx);
    const snapshot = await gateDraftSnapshot(tx, ctx, input.rev);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const runs = await gatesSince(tx, today);
    // 活动行可能在午夜前建立，按草稿无关地查全部活动行。
    const active = await tx.query.sopGateRuns.findFirst({ where: (t, { inArray }) => inArray(t.status, ['queued', 'running']) });
    if (active) throw new GateError('gate_active', active.id);
    if (runs.length >= daily) throw new GateError('gate_quota');
    const catalog = sha256(JSON.stringify([snapshot.catalog.routes, snapshot.catalog.hotels]));
    const key = (prompt: string, policy: string) => sha256(JSON.stringify([prompt, policy, catalog, goals.hash, code, model, model]));
    const baselineKey = key(snapshot.pub.promptHash!, snapshot.publishedPolicy.policyHash);
    const cached = await baselineFor(tx, baselineKey, mock);
    const row = await insertGate(tx, {
      draftId: snapshot.draft.id,
      draftRev: snapshot.draft.rev,
      status: 'queued',
      mock,
      promptHash: snapshot.ev.hashes.promptHash,
      policyHash: snapshot.policy.policyHash,
      draftKey: key(snapshot.ev.hashes.promptHash, snapshot.policy.policyHash),
      baselineKey,
      createdAt: new Date(),
      createdBy: ctx.actor.userId,
      createdByName: ctx.actor.name,
    });
    return { row, snapshot, cached };
  });
  const entry: Progress = { owner, runId: row.id, value: null, child: null, cancelled: false, costMilli: 0, work: null };
  progress.set(owner.id, entry);
  const abort = () => cancel(owner.id);
  owner.cancel.addEventListener('abort', abort, { once: true });
  const root = path.resolve(process.env.VAR_DIR ?? 'var', 'gate', row.id);
  const task = slot.then(() =>
    withTenantScope(owner, async () => {
      const usage: Summary['usage'] = [];
      let draft: GateGoalResult[] = [];
      let baseline: GateGoalResult[] | null = cached?.results
        ? cached.draftKey === row.baselineKey
          ? cached.results.draft
          : cached.results.baseline
        : null;
      const baselineReused = baseline !== null;
      let status: GateRunView['status'] = 'error';
      let verdict: GateRunView['verdict'] = null;
      let blocking: string[] = [];
      let error: string | null = null;
      let costMilli = 0;
      try {
        if (entry.cancelled || owner.cancel.aborted) throw new Error('cancelled');
        await initializeStandardBudget(owner);
        await withTenant(runtime.db, ctx, (tx) => updateGate(tx, row.id, { status: 'running' }));
        await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
        await exportSide(path.join(root, 'draft'), joinSop(snapshot.ev.merged), snapshot.catalog, snapshot.policy.policy, snapshot.brand);
        await exportSide(
          path.join(root, 'published'),
          joinSop(snapshot.pub.sections),
          snapshot.catalog,
          snapshot.publishedPolicy.policy,
          snapshot.brand,
        );
        const deadline = Date.now() + timeoutMs;
        const run = async (side: 'draft' | 'published', hashes: { promptHash: string; policyHash: string }) => {
          if (entry.cancelled) throw new Error('cancelled');
          const remaining = budget - costMilli / 1000;
          if (remaining <= 0) throw new Error('budget_stop');
          const time = deadline - Date.now();
          if (time <= 0) throw new Error('timeout');
          const summary = await runSide(entry, root, side, remaining, hashes, goals.ids, time, goals.dir);
          usage.push(...summary.usage);
          costMilli += summary.costMilli;
          entry.costMilli = costMilli;
          return summary.results;
        };
        if (!baseline)
          baseline = await run('published', { promptHash: snapshot.pub.promptHash!, policyHash: snapshot.publishedPolicy.policyHash });
        draft = await run('draft', { promptHash: row.promptHash, policyHash: row.policyHash });
        ({ status, verdict, blocking } = gateVerdict(draft, baseline));
        if (status === 'error') error = 'budget_stop';
      } catch (e) {
        // 不把供应商错误、地址或密钥写进业务表；只存稳定原因。
        const reason = e instanceof Error ? e.message : '';
        error = ['timeout', 'budget_stop', 'cancelled', 'report_invalid', 'child_spawn', 'child_exit'].includes(reason)
          ? reason
          : 'gate_error';
      } finally {
        try {
          // 结果与用量一次提交，免得结果已完成而用量漏记；缓存复用的一边不重复收费。
          await withTenant(runtime.db, ctx, async (tx) => {
            await addUsage(
              tx,
              usage.map((u) => ({ ...u, day: todayIso(), purpose: 'gate' as const, costMilliCny: u.costMilli })),
            );
            await updateGate(tx, row.id, {
              status,
              verdict,
              costMilli,
              error,
              finishedAt: new Date(),
              results: { draft, baseline, baselineReused, blocking },
            });
          });
          for (const u of usage) for (let i = 0; i < u.calls; i++) owner.budget.reserve('gate', 0)?.settle(i === 0 ? u.costMilli : 0);
        } finally {
          // 保留 JSONL 报告供诊断；成功、失败或杀进程都删除配置副本及子进程临时状态。
          try {
            await Promise.all(['tmp', 'draft', 'published'].map((dir) => fs.rm(path.join(root, dir), { recursive: true, force: true })));
          } finally {
            owner.cancel.removeEventListener('abort', abort);
            if (progress.get(owner.id) === entry) progress.delete(owner.id);
          }
        }
      }
    }),
  );
  // 单槽链在失败后仍继续；在途登记使停机先等待落库与目录清理，再释放租户锁。
  slot = task.catch(() => {
    console.error('[gate] gate_persist_failed');
  });
  entry.work = slot;
  owner.inflight.track(slot, true).catch(() => {});
  return { runId: row.id };
}

export async function getGateRun(ctx: TenantCtx, id: string): Promise<GateRunView> {
  if (!z.uuid().safeParse(id).success) throw new SopNotFoundError('没有这次回归');
  const runtime = configRuntime();
  if (runtime.tenantId !== ctx.tenantId) throw new Error('闸租户作用域不符');
  const row: GateRow | null = await withTenant(runtime.db, ctx, (tx) => readGate(tx, id), { readOnly: true });
  if (!row) throw new SopNotFoundError('没有这次回归');
  const live = progress.get(ctx.tenantId);
  return {
    id: row.id,
    status: row.status,
    verdict: row.verdict,
    mock: row.mock,
    progress: row.status === 'running' && live?.runId === id ? live.value : null,
    draft: row.results?.draft ?? [],
    baseline: row.results?.baseline ?? null,
    baselineReused: row.results?.baselineReused ?? false,
    blocking: row.results?.blocking ?? [],
    costMilli: row.status === 'running' && live?.runId === id ? live.costMilli : row.costMilli,
    error: row.error,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** 自测只替换合成目标目录，仍跑相同的导出、子进程、报告和事务路径。 */
export const __gateTest: { goalsDir?: string } = {};
