import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGoals } from './goals.js';
import { Meter, simulate, summaryTable } from './runner.js';
import { engineRuntime, validatePrices } from './runtime.js';

export function parseArgs(args: string[]): { goals: string; k: number; budget: number; model?: string; report: string; prices?: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--goals', '--k', '--budget', '--model', '--report', '--prices'].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      key in values
    )
      throw new Error(`参数错误: ${key}`);
    values[key] = args[i + 1];
  }
  if (!values['--budget']) throw new Error('必须显式提供 --budget <元>');
  const budget = Number(values['--budget']);
  const k = Number(values['--k'] ?? 5);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget 必须是正数');
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k 必须是正整数');
  return {
    goals: values['--goals'] ?? 'eval/sim/goals',
    k,
    budget,
    model: values['--model'],
    report: values['--report'] ?? 'var/eval-sim/report.json',
    prices: values['--prices'],
  };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  // 校验在生产模块导入及任何请求之前；没预算绝不运行。
  const opts = parseArgs(args);
  const goals = await loadGoals(opts.goals);
  const prices = opts.prices ? validatePrices(JSON.parse(await fs.readFile(opts.prices, 'utf8'))) : {};
  process.env.TZ = 'Asia/Shanghai';
  const meter = new Meter(opts.budget);
  const runtime = await engineRuntime(meter, opts.model, prices);
  try {
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
