import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadGoals, selectByTag, type SimGoal } from './goals.js';
import { gateTable, Meter, simulate, simulateGate, summaryTable } from './runner.js';
import { engineRuntime, validatePrices, type PriceRow } from './runtime.js';
import { gitText, treeHashes } from './freeze.js';
import {
  appendLedger,
  appendRun,
  checkResume,
  holdoutPreflight,
  ledgerEnd,
  ledgerFile,
  ledgerStart,
  matchingStart,
  openJournal,
  readJournal,
  readLedger,
  resumeState,
} from './journal.js';
import type { Freeze, RunKind, RunMeta } from './report-types.js';

const RealDate = Date;
const now = (): string => new RealDate().toISOString();

/** 命令行是「--键 值」成对出现：键必须在 allowed 里，值不能缺或以 -- 开头，同一个键不能出现两次。 */
export function parsePairs(args: string[], allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || key in values) throw new Error(`参数错误: ${key}`);
    values[key] = args[i + 1];
  }
  return values;
}
export function parseBudget(values: Record<string, string>): number {
  if (!values['--budget']) throw new Error('必须显式提供 --budget <元>');
  const budget = Number(values['--budget']);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget 必须是正数');
  return budget;
}
export function parseRerun(value: string): number {
  const rerun = Number(value);
  if (!Number.isSafeInteger(rerun) || rerun < 0) throw new Error('--rerun 必须是非负整数');
  return rerun;
}

export interface RunArgs {
  goals: string;
  k: number;
  budget: number;
  model?: string;
  report: string;
  prices?: string;
  /** 07 R9：导出目录（旅游是 sop.md、routes.json、hotels.json；其他包是 sop.md、pack.json、catalog/<kind>.json，08 R11）；给了就读目录里的配置，没给读 data/ */
  configDir?: string;
  /** 07 R8：只跑 tags 含它的目标 */
  tag?: string;
  /** 07 R8：失败的目标最多再跑几遍；给了就按闸的判定（pass / flaky / fail / skipped_budget），k 恒为 1 */
  rerun?: number;
  journal?: string;
  ledger?: string;
  kind?: RunKind;
  prepare?: true;
  reason?: string;
}
export function parseArgs(args: string[]): RunArgs {
  const values = parsePairs(args, [
    '--goals',
    '--k',
    '--budget',
    '--model',
    '--report',
    '--prices',
    '--config-dir',
    '--tag',
    '--rerun',
    '--journal',
    '--ledger',
    '--kind',
    '--prepare',
    '--reason',
  ]);
  const budget = parseBudget(values);
  const k = Number(values['--k'] ?? 5);
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k 必须是正整数');
  const rerun = values['--rerun'] === undefined ? undefined : parseRerun(values['--rerun']);
  if (rerun !== undefined && '--k' in values && k !== 1) throw new Error('--rerun 只能与 --k 1 合用：重跑按闸的判定，不算 pass^k');
  const kind = values['--kind'];
  if (kind !== undefined && !['pilot', 'dev', 'main', 'customer_swap'].includes(kind)) throw new Error('--kind 无效');
  if (values['--prepare'] !== undefined && values['--prepare'] !== 'yes') throw new Error('--prepare 只能是 yes');
  if (!values['--journal'] && ['--ledger', '--kind', '--prepare', '--reason'].some((key) => key in values))
    throw new Error('新运行参数需要 --journal');
  if (values['--prepare'] && !values['--ledger']) throw new Error('--prepare 需要 --ledger');
  if (values['--journal'] && rerun !== undefined) throw new Error('--journal 不与 --rerun 合用');
  return {
    goals: values['--goals'] ?? 'eval/sim/goals',
    k: rerun === undefined ? k : 1,
    budget,
    model: values['--model'],
    report: values['--report'] ?? 'var/eval-sim/report.json',
    prices: values['--prices'],
    configDir: values['--config-dir'],
    tag: values['--tag'],
    rerun,
    ...(values['--journal'] ? { journal: values['--journal'] } : {}),
    ...(values['--ledger'] ? { ledger: values['--ledger'] } : {}),
    ...(kind ? { kind: kind as RunKind } : {}),
    ...(values['--prepare'] ? { prepare: true as const } : {}),
    ...(values['--reason'] ? { reason: values['--reason'] } : {}),
  };
}

async function journalMain(opts: RunArgs, goals: SimGoal[], prices: Record<string, PriceRow>): Promise<void> {
  const ledgerPath = opts.ledger ?? 'docs/reports/industrial-sim/ledger.jsonl';
  if (new Set([opts.journal!, ledgerPath, opts.report].map((f) => path.resolve(f))).size !== 3) throw new Error('运行输出文件不能重合');
  const savedEnv = { ...process.env };
  // usage.ts 等模块装载时就读 VAR_DIR：读模型配置之前先指到临时目录，引擎沿用同一个。
  const varDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sim-'));
  process.env.VAR_DIR = varDir;
  process.env.CONFIG_SOURCE = 'file';
  process.env.TZ = 'Asia/Shanghai';
  for (const key of Object.keys(process.env))
    if (/^(?:DATABASE_|POSTGRES_|PG(?:HOST|PORT|USER|PASSWORD|DATABASE|_TEST_URL)$)/u.test(key)) delete process.env[key];
  try {
    // 这里只读模型配置；prepare 不装载 engine，也不创建 engineRuntime。
    const { llmCfg, llmStats } = await import('../../src/llm.js');
    const salesModel = llmCfg().model;
    const customerModel = opts.model ?? salesModel;
    const head = await gitText(['rev-parse', 'HEAD']);
    const trees = await treeHashes();
    const ledger = await ledgerFile(ledgerPath);
    const holdout = goals.some((g) => g.journey?.split === 'holdout');
    const freeze: Freeze | null = holdout
      ? await fs
          .readFile('docs/reports/industrial-sim/freeze.json', 'utf8')
          .then((s) => JSON.parse(s) as Freeze)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
      : null;
    const wanted: RunMeta = {
      runId: randomUUID(),
      head,
      trees,
      kind: opts.kind ?? 'dev',
      freezeCommit: freeze?.commit ?? null,
      startedAt: now(),
      salesModel,
      customerModel,
      hedgeModel: llmStats().hedgeModel,
      hedgeMs: llmStats().hedgeModel ? llmStats().hedgeMs : null,
      k: opts.k,
      budget: opts.budget,
      promptHash: '',
      policyHash: '',
      pricesCheckedAt: '2026-11-01',
    };
    const existing = !opts.prepare
      ? await fs
          .readFile(opts.journal!)
          .then(readJournal)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
      : null;
    if (opts.prepare && (await fs.stat(opts.journal!).catch(() => null))) throw new Error('prepare_journal_exists');
    if (existing) checkResume(existing.meta, { ...wanted, promptHash: existing.meta.promptHash, policyHash: existing.meta.policyHash });
    let start = existing ? ledger.find((s) => s.event === 'start' && s.runId === existing.meta.runId) : matchingStart(ledger, wanted);
    if (opts.prepare) start = ledgerStart(wanted, now(), opts.reason);
    let committed = '';
    if (holdout) committed = await gitText(['show', `HEAD:${path.relative(process.cwd(), path.resolve(ledgerPath))}`]).catch(() => '');
    holdoutPreflight({
      opts,
      goals,
      ledger,
      committedLedger: readLedger(committed + (committed && !committed.endsWith('\n') ? '\n' : '')),
      freeze,
      status: holdout ? await gitText(['status', '--porcelain', '--untracked-files=all']) : '',
      trees,
      start,
      root: process.cwd(),
      phase: opts.prepare ? 'prepare' : 'run',
    });
    if (opts.prepare) {
      await appendLedger(ledgerPath, start!);
      console.log('开跑行已写入；下一步提交并推送账本，再用相同参数去掉 --prepare yes 正式运行。');
      return;
    }
    if (existing && !start) throw new Error('journal_ledger_start_missing');
    if (!start) {
      start = ledgerStart(wanted, now(), opts.reason);
      await appendLedger(ledgerPath, start);
    }
    wanted.runId = start.runId;
    const restored = existing ? resumeState(existing) : { completed: new Set<string>(), charges: [], runs: [] };
    // 引擎装载之前先恢复费用，避免预算已经用尽时仍发启动请求。
    const meter = new Meter(opts.budget, restored.charges);
    const runtime = await engineRuntime(meter, opts.model, prices, { configDir: opts.configDir, strictNet: true, varDir });
    try {
      wanted.promptHash = String(runtime.metadata.promptHash);
      wanted.policyHash = String(runtime.metadata.policyHash);
      const journal = await openJournal(opts.journal!, wanted);
      const report = {
        ...(await simulate(goals, opts.k, meter, runtime.deps, {
          runId: journal.meta.runId,
          resume: { ...restored, charges: [] },
          onRun: (run) => appendRun(opts.journal!, run),
        })),
        metadata: runtime.metadata,
      };
      if (!ledger.some((s) => s.event === 'end' && s.runId === start!.runId))
        await appendLedger(ledgerPath, ledgerEnd(start, report.runs, meter.charges, now()));
      await fs.mkdir(path.dirname(opts.report), { recursive: true });
      await fs.writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
      console.log(summaryTable(report));
      console.log(`报告: ${opts.report}`);
      if (report.summary.some((s) => !s.passK)) process.exitCode = 1;
    } finally {
      await runtime.close();
    }
  } finally {
    await fs.rm(varDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  // 校验在生产模块导入及任何请求之前；没预算绝不运行。
  const opts = parseArgs(args);
  let goals = await loadGoals(opts.goals);
  if (opts.tag !== undefined) goals = selectByTag(goals, opts.tag);
  if (goals.some((g) => g.journey?.split === 'holdout') && !opts.journal) throw new Error('holdout_journal_required');
  const prices = opts.prices ? validatePrices(JSON.parse(await fs.readFile(opts.prices, 'utf8'))) : {};
  if (opts.journal) return journalMain(opts, goals, prices);
  process.env.TZ = 'Asia/Shanghai';
  const meter = new Meter(opts.budget);
  const runtime = await engineRuntime(meter, opts.model, prices, { configDir: opts.configDir });
  try {
    if (opts.rerun !== undefined) {
      const report = { ...(await simulateGate(goals, opts.rerun, meter, runtime.deps)), metadata: runtime.metadata };
      await fs.mkdir(path.dirname(opts.report), { recursive: true });
      await fs.writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
      console.log(gateTable(report));
      console.log(`报告: ${opts.report}`);
      if (report.results.some((r) => r.result === 'fail' || r.result === 'skipped_budget')) process.exitCode = 1;
      return;
    }
    const report = { ...(await simulate(goals, opts.k, meter, runtime.deps)), metadata: runtime.metadata };
    await fs.mkdir(path.dirname(opts.report), { recursive: true });
    await fs.writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
    console.log(summaryTable(report));
    console.log(`报告: ${opts.report}`);
    if (report.summary.some((s) => !s.passK)) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : '模拟评测运行失败；未完成基线');
    process.exitCode = 1;
  });
}
