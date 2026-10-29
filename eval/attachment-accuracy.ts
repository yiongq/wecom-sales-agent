// 12 R13：图片识别准确率与时延。真实模型，只在协调者手动运行时才发请求（第 13 步，owner 授权并给预算）；不进 pnpm test。
//
// 用法：
//   node --import tsx eval/attachment-accuracy.ts --budget <元> [--runs 3] [--files list-screenshot.png,nameplate.jpg] [--report <文件>] [--prices <单价 JSON>]
//   --budget  必填。自己累计费用（每次视觉调用的用量按单价折成元），到上限就停，没跑完的样本在报告里标出
//   --runs    每张图跑几次，缺省 3
//   --files   只测这几张；缺省是 truth.json 里全部带行真值的图片样本
//   --report  报告文件（JSON），缺省 var/eval-attachments/report.json
//   --prices  模型单价覆盖，格式同 eval/sim/run.ts 的 --prices
// 环境：同 eval/sim/run.ts（LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 等；视觉模型取 LLM_VISION_MODEL，缺省 glm-5.3-flashx）。
//
// 做法：每次经引擎收一张图（与渠道同一个入口：prepareAttachment → handleMessage → 工业包的 intake.receive → 真实视觉请求），
// 读代码渲染的识别清单，按 truth.json 逐行对真值。清单里的型号是清洗后的串，真值的型号本来就在清洗后不变（自测里核对）。
// 逐行对齐用编辑距离：型号相同算「对」，型号不同但位置对得上算「型号错」，对不上的真值行算「漏行」，多出来的预测行算「多行」；
// 数量只在对得上的行上比（null 与 null 相等），漏行的数量算错。时延取整轮耗时（下载之外的全部：判类、去元数据、视觉请求、渲染）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTruth, type TruthLine } from './sim/attachment-fixtures.js';
import { parseBudget, parsePairs } from './sim/run.js';
import { Meter, type SimDeps } from './sim/runner.js';
import { engineRuntime, validatePrices } from './sim/runtime.js';

export interface RowScore {
  /** 真值行数 */
  rows: number;
  /** 型号对 / 型号错（位置对得上但型号不同） / 漏行 / 多行 */
  partRight: number;
  partWrong: number;
  missed: number;
  extra: number;
  /** 对得上的行里数量也对的行数（漏行不算） */
  qtyRight: number;
  /** 型号和数量都对 */
  rowRight: number;
}

/** 代码渲染的识别清单里的一行：「3. 6206-2RS，50件，…」或「1. 6208-2RS，数量没认出，…」；不是清单（固定句、转顾问）返回 null。 */
export function parseListReply(reply: string): TruthLine[] | null {
  if (!/^从您发来的询价单里认出 \d+ 行，请核对：/u.test(reply)) return null;
  const lines: TruthLine[] = [];
  for (const raw of reply.split('\n')) {
    const match = /^\d+\. (.+?)，(?:(\d+)件|数量没认出)，/u.exec(raw);
    if (match) lines.push({ partNo: match[1]!, qty: match[2] === undefined ? null : Number(match[2]) });
  }
  return lines;
}

export function scoreRows(truth: readonly TruthLine[], predicted: readonly TruthLine[]): RowScore {
  const n = truth.length;
  const m = predicted.length;
  const cost = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = 1; i <= n; i++) cost[i]![0] = i;
  for (let j = 1; j <= m; j++) cost[0]![j] = j;
  const same = (i: number, j: number) => truth[i - 1]!.partNo === predicted[j - 1]!.partNo;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + (same(i, j) ? 0 : 1), cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
  const score: RowScore = { rows: n, partRight: 0, partWrong: 0, missed: 0, extra: 0, qtyRight: 0, rowRight: 0 };
  // 回溯；平手时先走对角线（型号错比「漏一行又多一行」便宜，也更接近事实）
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + (same(i, j) ? 0 : 1)) {
      const qtyRight = truth[i - 1]!.qty === predicted[j - 1]!.qty;
      if (same(i, j)) score.partRight++;
      else score.partWrong++;
      if (qtyRight) score.qtyRight++;
      if (qtyRight && same(i, j)) score.rowRight++;
      i--;
      j--;
    } else if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      score.missed++;
      i--;
    } else {
      score.extra++;
      j--;
    }
  }
  return score;
}

export interface RunRecord {
  file: string;
  run: number;
  /** 引擎回的是识别清单；false 是固定句或转顾问（视觉失败、读成图纸等），所有真值行记漏行 */
  list: boolean;
  latencyMs: number;
  /** 这一次的费用（元） */
  cny: number;
  score: RowScore;
}
export interface Summary {
  runs: number;
  notList: number;
  totals: RowScore;
  latency: { p50: number | null; p90: number | null; max: number | null };
  cny: number;
}
const percentile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null;

export function summarize(records: readonly RunRecord[]): Summary {
  const totals: RowScore = { rows: 0, partRight: 0, partWrong: 0, missed: 0, extra: 0, qtyRight: 0, rowRight: 0 };
  for (const record of records) for (const key of Object.keys(totals) as (keyof RowScore)[]) totals[key] += record.score[key];
  const latencies = records.map((r) => r.latencyMs).toSorted((a, b) => a - b);
  return {
    runs: records.length,
    notList: records.filter((r) => !r.list).length,
    totals,
    latency: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: latencies.at(-1) ?? null },
    cny: records.reduce((sum, r) => sum + r.cny, 0),
  };
}

export interface Measurement {
  records: RunRecord[];
  /** 费用到了上限，后面的样本没跑 */
  budgetStopped: boolean;
  skipped: { file: string; run: number }[];
}
/** 逐个样本、逐次地经引擎收图并对真值；每次开始前先看预算，到了就停。deps 与 meter 由调用方给（真实运行用 engineRuntime 的，自测用假的）。 */
export async function measure(
  deps: Pick<SimDeps, 'start' | 'sales' | 'end'>,
  meter: Meter,
  files: readonly string[],
  runs: number,
  truth = readTruth(),
): Promise<Measurement> {
  const records: RunRecord[] = [];
  const skipped: Measurement['skipped'] = [];
  for (const file of files)
    for (let run = 1; run <= runs; run++) {
      if (meter.stopped) {
        skipped.push({ file, run });
        continue;
      }
      const before = meter.total;
      const { id } = await deps.start();
      try {
        const turn = await deps.sales(id, { say: '', done: true, attach: file });
        const predicted = parseListReply(turn.reply);
        records.push({
          file,
          run,
          list: predicted !== null,
          latencyMs: turn.trace.durationMs,
          cny: meter.total - before,
          score: scoreRows(truth[file]!.lines!, predicted ?? []),
        });
      } finally {
        await deps.end(id);
      }
    }
  return { records, budgetStopped: skipped.length > 0, skipped };
}

export interface AccuracyArgs {
  budget: number;
  runs: number;
  files: string[];
  report: string;
  prices?: string;
}
export function parseArgs(args: string[], truth = readTruth()): AccuracyArgs {
  const values = parsePairs(args, ['--budget', '--runs', '--files', '--report', '--prices']);
  const budget = parseBudget(values);
  const runs = Number(values['--runs'] ?? 3);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs 必须是 1 到 10 的整数');
  const images = Object.keys(truth).filter((file) => truth[file]!.class === 'image' && truth[file]!.lines);
  const files = values['--files'] === undefined ? images : values['--files'].split(',');
  if (!files.length || files.some((file) => !images.includes(file)))
    throw new Error(`--files 只能是带行真值的图片样本：${images.join('、')}`);
  return { budget, runs, files, report: values['--report'] ?? 'var/eval-attachments/report.json', prices: values['--prices'] };
}

const pct = (n: number, total: number): string => (total ? `${((n / total) * 100).toFixed(1)}%` : '无数据');
export function table(records: readonly RunRecord[]): string {
  const files = [...new Set(records.map((r) => r.file))];
  const row = (label: string, s: Summary): string =>
    `${label} | ${s.runs} | ${s.totals.partRight}/${s.totals.rows}（${pct(s.totals.partRight, s.totals.rows)}） | ${s.totals.qtyRight}/${s.totals.rows}（${pct(s.totals.qtyRight, s.totals.rows)}） | ` +
    `${s.totals.rowRight}/${s.totals.rows} | ${s.totals.partWrong} | ${s.totals.missed} | ${s.totals.extra} | ${s.notList} | ${s.latency.p50 ?? '-'} / ${s.latency.max ?? '-'}`;
  return [
    '样本 | 次数 | 型号对 | 数量对 | 整行对 | 型号错 | 漏行 | 多行 | 非清单 | 时延 p50 / 最大（毫秒）',
    ...files.map((file) => row(file, summarize(records.filter((r) => r.file === file)))),
    row('合计', summarize(records)),
  ].join('\n');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  // 校验在生产模块导入及任何请求之前；没预算绝不运行。
  const opts = parseArgs(args);
  const prices = opts.prices ? validatePrices(JSON.parse(await fs.readFile(opts.prices, 'utf8'))) : {};
  process.env.TZ = 'Asia/Shanghai';
  const meter = new Meter(opts.budget);
  const runtime = await engineRuntime(meter, undefined, prices, { configDir: 'data/packs/industrial', vision: true });
  try {
    const result = await measure(runtime.deps, meter, opts.files, opts.runs);
    const summary = summarize(result.records);
    const report = {
      ...result,
      summary,
      files: opts.files,
      runsPerFile: opts.runs,
      budgetCny: opts.budget,
      costCny: meter.total,
      metadata: runtime.metadata,
    };
    await fs.mkdir(path.dirname(opts.report), { recursive: true });
    await fs.writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
    console.log(table(result.records));
    console.log(
      `费用 ¥${meter.total.toFixed(6)}（上限 ¥${opts.budget}）${result.budgetStopped ? `；预算用完，${result.skipped.length} 次没跑` : ''}`,
    );
    console.log(`报告: ${opts.report}`);
    if (result.budgetStopped) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : '识别准确率评测运行失败');
    process.exitCode = 1;
  });
}
