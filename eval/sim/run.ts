import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGoals, selectByTag } from './goals.js';
import { gateTable, Meter, simulate, simulateGate, summaryTable } from './runner.js';
import { engineRuntime, validatePrices } from './runtime.js';

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
  /** 07 R9：导出目录；给了就读目录里的配置，没给读 data/ */
  configDir?: string;
  /** 07 R8：只跑 tags 含它的目标 */
  tag?: string;
  /** 07 R8：失败的目标最多再跑几遍；给了就按闸的判定（pass / flaky / fail / skipped_budget），k 恒为 1 */
  rerun?: number;
}
export function parseArgs(args: string[]): RunArgs {
  const values = parsePairs(args, ['--goals', '--k', '--budget', '--model', '--report', '--prices', '--config-dir', '--tag', '--rerun']);
  const budget = parseBudget(values);
  const k = Number(values['--k'] ?? 5);
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k 必须是正整数');
  const rerun = values['--rerun'] === undefined ? undefined : parseRerun(values['--rerun']);
  if (rerun !== undefined && '--k' in values && k !== 1) throw new Error('--rerun 只能与 --k 1 合用：重跑按闸的判定，不算 pass^k');
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
  };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  // 校验在生产模块导入及任何请求之前；没预算绝不运行。
  const opts = parseArgs(args);
  let goals = await loadGoals(opts.goals);
  if (opts.tag !== undefined) goals = selectByTag(goals, opts.tag);
  const prices = opts.prices ? validatePrices(JSON.parse(await fs.readFile(opts.prices, 'utf8'))) : {};
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
