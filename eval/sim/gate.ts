// 发布闸的评测入口（07 R8、R9）。服务端（第 13 步）把它当子进程起：
//   node --import tsx eval/sim/gate.ts --config-dir <导出目录> --tag regression --rerun 2 --budget <元> --report <文件>
// 可选：--goals <目标目录，缺省 eval/sim/goals/quality>、--model <客户模型>、--prices <单价 JSON>。--rerun 缺省 2。
// 只输出机器读的报告（--report 文件，JSON Lines，一行一个 JSON，以 \n 结尾；读的人只认以 \n 结尾的完整行）；
// 不打印人读的表，不连数据库，不读 DATABASE_URL 一类变量，模型只走 LLM_* / SIM_CUSTOMER_* / EMBED_* / TZ（环境由父进程限定）。
//
// 报告每行的 type：
//   start    开跑：{ type, total, goalIds, tag, rerun, budgetMilli }
//   goal     每跑完（或因预算没跑到）一个目标追加一行：{ type, id, tags, attempts[{ pass, failures, turns, costMilli }], result, done, total, spentMilli }
//            result 是 pass / flaky / fail / skipped_budget（GateGoalResult），done / total 是进度，spentMilli 是到此为止的总花费
//   summary  最后一行：{ type, budgetStopped, costMilli, budgetMilli, rerun, tag, counts, results[GateGoalResult], usage[按模型], metadata }
//   error    运行出错时尽量追加的最后一行：{ type, message }
// 金额一律是千分之一元的整数（同 usage_daily.cost_milli_cny）。
//
// 每个目标先跑 1 遍，没过再重跑，最多再 --rerun 遍。goal 行的 result：
//   pass            第 1 遍过
//   flaky           重跑里有一遍过；或没有一遍真正通过、但至少有一遍只是客户模型没按协议出话（failures 里是 customer_protocol，
//                   pass 为 false）——那不是销售侧的错，06 R2 同样不把它计入分母，所以只列出来、不拦发布
//   fail            1 + rerun 遍每一遍都是真正的失败（谓词、禁用短语、越权工具、运行出错）
//   skipped_budget  预算用完没跑到，或被预算截断而还没有一遍通过（没有结论，不算 fail）
//
// 退出码：
//   0  跑完：每个目标都有结论，最后一行是 summary；目标有没有失败不影响退出码，由父进程按基线判定
//   1  运行出错：模型配置缺失、导出目录里的 policy.json / brand.json 等不合格、报告写不了……（没有 summary）
//   2  参数错：命令行不合法、--config-dir 不是带 sop.md / routes.json / hotels.json 的目录、--prices 不合格、没有目标带这个标签（不写报告）
//   3  预算停止：花费到了 --budget，有目标没跑完（summary 里 budgetStopped=true，那些目标是 skipped_budget）
// 被 SIGTERM / SIGINT 终止（闸超时）时没有 summary：引擎模块自己接了这两个信号（src/shutdown.ts），收尾后以 143 / 130 退出，
// 评测的临时目录在 exit 钩子里清掉（runtime.ts）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGoals, selectByTag } from './goals.js';
import { parseBudget, parsePairs, parseRerun } from './run.js';
import { Meter, simulateGate, usageByModel, type GateResult } from './runner.js';
import { engineRuntime, resolveConfigDir, validatePrices } from './runtime.js';

export const GATE_EXIT = { done: 0, error: 1, usage: 2, budget: 3 } as const;
export const GATE_DEFAULT_RERUN = 2;
export const GATE_DEFAULT_GOALS = 'eval/sim/goals/quality';

export interface GateArgs {
  configDir: string;
  tag: string;
  rerun: number;
  budget: number;
  report: string;
  goals: string;
  model?: string;
  prices?: string;
}
export function parseGateArgs(args: string[]): GateArgs {
  const values = parsePairs(args, ['--config-dir', '--tag', '--rerun', '--budget', '--report', '--goals', '--model', '--prices']);
  for (const required of ['--config-dir', '--tag', '--report']) if (!values[required]) throw new Error(`必须提供 ${required}`);
  return {
    configDir: values['--config-dir'],
    tag: values['--tag'],
    rerun: values['--rerun'] === undefined ? GATE_DEFAULT_RERUN : parseRerun(values['--rerun']),
    budget: parseBudget(values),
    report: values['--report'],
    goals: values['--goals'] ?? GATE_DEFAULT_GOALS,
    model: values['--model'],
    prices: values['--prices'],
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240);

/** 跑一次闸，返回退出码。进程级的东西只动 process.env（TZ 与引擎运行时的那几项），返回前恢复成进来时的样子。 */
export async function runGate(args: string[]): Promise<number> {
  let opts: GateArgs;
  let prices: ReturnType<typeof validatePrices> = {};
  try {
    opts = parseGateArgs(args);
    await resolveConfigDir(opts.configDir);
    if (opts.prices) prices = validatePrices(JSON.parse(await fs.readFile(opts.prices, 'utf8')));
  } catch (e) {
    console.error(message(e));
    return GATE_EXIT.usage;
  }
  let goals: Awaited<ReturnType<typeof loadGoals>>;
  try {
    goals = await loadGoals(opts.goals);
  } catch (e) {
    console.error(message(e));
    return GATE_EXIT.error;
  }
  try {
    goals = selectByTag(goals, opts.tag);
  } catch (e) {
    console.error(message(e));
    return GATE_EXIT.usage;
  }
  const savedEnv = { ...process.env };
  const append = (line: Record<string, unknown>): Promise<void> => fs.appendFile(opts.report, `${JSON.stringify(line)}\n`);
  try {
    await fs.mkdir(path.dirname(path.resolve(opts.report)), { recursive: true });
    await fs.writeFile(
      opts.report,
      `${JSON.stringify({
        type: 'start',
        total: goals.length,
        goalIds: goals.map((g) => g.id),
        tag: opts.tag,
        rerun: opts.rerun,
        budgetMilli: Math.round(opts.budget * 1000),
      })}\n`,
    );
    process.env.TZ = 'Asia/Shanghai';
    const meter = new Meter(opts.budget);
    const runtime = await engineRuntime(meter, opts.model, prices, { configDir: opts.configDir });
    let budgetStopped = false;
    try {
      const report = await simulateGate(goals, opts.rerun, meter, runtime.deps, (result, progress) =>
        append({ type: 'goal', ...result, ...progress }),
      );
      budgetStopped = report.budgetStopped;
      const count = (r: GateResult): number => report.results.filter((x) => x.result === r).length;
      await append({
        type: 'summary',
        budgetStopped,
        costMilli: Math.round(report.cost.total * 1000),
        budgetMilli: Math.round(opts.budget * 1000),
        rerun: opts.rerun,
        tag: opts.tag,
        counts: { pass: count('pass'), flaky: count('flaky'), fail: count('fail'), skipped_budget: count('skipped_budget') },
        results: report.results,
        usage: usageByModel(report.charges),
        metadata: runtime.metadata,
      });
    } finally {
      await runtime.close();
    }
    return budgetStopped ? GATE_EXIT.budget : GATE_EXIT.done;
  } catch (e) {
    console.error(message(e));
    // 出错的路上尽量留一行说明；写不进去就算了，退出码已经说明了结果
    await append({ type: 'error', message: message(e) }).catch(() => undefined);
    return GATE_EXIT.error;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGate(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(message(e));
      process.exit(GATE_EXIT.error);
    },
  );
}
