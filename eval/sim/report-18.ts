// 18 R2、R6：第 6 次报告的「疑似坏轮」附表和「18 前后对比」。入库的只有计数，疑似清单和裁定含对话摘录，留在 var/（16 D5）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JourneyReport, LedgerLine } from './report-types.js';
import type { RunResult } from './runner.js';
import { DETECTORS, type DetectorId } from './triage.js';

export interface TallyRun {
  /** 第几次 main，按账本开跑行排；中止的也占一个次数 */
  attempt: number;
  runId: string;
  turns: number;
  detectors: Record<DetectorId, { suspects: number; confirmed: number }>;
}
export interface TriageTally {
  runs: TallyRun[];
  aborted: { attempt: number; runId: string }[];
}
export interface Side18 {
  attempt: number;
  runId: string;
  turns: number;
  /** 金额护栏（money_provenance）删过句子的轮数 */
  moneyDropTurns: number;
  /** 模型在正文里写的商品金额次数（放块之前） */
  modelItemAmounts: number;
  /** 客户看到的正文里的商品金额次数（不算价格块） */
  bodyItemAmounts: number;
  priceWithheld: { suspects: number; confirmed: number };
  confirmedPer100: number;
  success: { rate: number; conservative: number; low: number; high: number };
  p90: number;
  salesPerRun: number;
}
export interface Appendix18 {
  tally: TriageTally;
  before: Side18;
  after: Side18;
  families: { family: string; before: { passed: number; total: number }; after: { passed: number; total: number } }[];
}

type Summary = Pick<JourneyReport, 'meta' | 'success' | 'latency' | 'cost' | 'scenes'>;

// 和 src/core/guards/reply-blocks.ts 的 bareItemAmounts 同一口径：只数商品金额，运费常数不算。
const ITEM_AMOUNT = /(?:单价|小计|合计|应付(?:金额)?|总价|金额)\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元)?/g;
// 工业包价格块的各行（src/packs/industrial/reply-blocks.ts 与 guards.ts 的 trimNote），只在本轮放了块时剔除。
const BLOCK_LINE =
  /^(?:试算[:：]$|试算档位价[:：]$|.+ × \d+(?:\.\d+)?[:：](?:试算)?单价\d|另有 \d+ 行需确认[:：]|暂时报不了价[:：]|另外 \d+ 行已算好|(?:试算)?合计\d+(?:\.\d+)?元$|您接受的这份报价合计\d|.+[:：]\d+(?:件起|–\d+件)\d+(?:\.\d+)?元)/u;

const count = (text: string): number => text.match(ITEM_AMOUNT)?.length ?? 0;

export function bodyOf(reply: string, hasBlock: boolean): string {
  return hasBlock
    ? reply
        .split('\n')
        .filter((line) => !BLOCK_LINE.test(line.trim()))
        .join('\n')
    : reply;
}

/** 只用 journal 就能算的数，不花模型费用。 */
export function journalCounts(runs: RunResult[]): Pick<Side18, 'turns' | 'moneyDropTurns' | 'modelItemAmounts' | 'bodyItemAmounts'> {
  let turns = 0;
  let moneyDropTurns = 0;
  let modelItemAmounts = 0;
  let bodyItemAmounts = 0;
  for (const run of runs)
    for (const turn of run.turns) {
      if (turn.silent) continue;
      turns++;
      const trace = turn.trace.turn;
      if (trace.guards.some((g) => g.guard === 'money_provenance' && g.action === 'drop_sentence')) moneyDropTurns++;
      const blocks = trace.blocks;
      modelItemAmounts += blocks ? blocks.bareItemAmounts : count(turn.reply);
      bodyItemAmounts += count(bodyOf(turn.reply, (blocks?.rendered.length ?? 0) > 0));
    }
  return { turns, moneyDropTurns, modelItemAmounts, bodyItemAmounts };
}

function side(summary: Summary, runs: RunResult[], tally: TriageTally): Side18 {
  const row = tally.runs.find((r) => r.runId === summary.meta.runId);
  if (!row) throw new Error(`附表缺少运行 ${summary.meta.runId}`);
  const confirmed = DETECTORS.reduce((n, d) => n + row.detectors[d].confirmed, 0);
  return {
    attempt: row.attempt,
    runId: row.runId,
    ...journalCounts(runs),
    priceWithheld: row.detectors.price_withheld,
    confirmedPer100: row.turns ? (confirmed / row.turns) * 100 : 0,
    success: { rate: summary.success.rate, conservative: summary.success.conservative, ...summary.success.byRuns },
    p90: summary.latency.p90,
    salesPerRun: summary.cost.salesPerRun,
  };
}

export function buildAppendix18(input: {
  tally: TriageTally;
  before: { summary: Summary; runs: RunResult[] };
  after: { summary: Summary; runs: RunResult[] };
}): Appendix18 {
  const families = [...new Set([...input.before.summary.scenes, ...input.after.summary.scenes].map((s) => s.family))].toSorted();
  const sum = (summary: Summary, family: string) =>
    summary.scenes
      .filter((s) => s.family === family)
      .reduce((acc, s) => ({ passed: acc.passed + s.passed, total: acc.total + s.total - s.excluded }), { passed: 0, total: 0 });
  return {
    tally: input.tally,
    before: side(input.before.summary, input.before.runs, input.tally),
    after: side(input.after.summary, input.after.runs, input.tally),
    families: families.map((family) => ({ family, before: sum(input.before.summary, family), after: sum(input.after.summary, family) })),
  };
}

/**
 * 附表计数：疑似来自 triage.ts 对每份 journal 的回溯，确认来自 triage-review.json。
 * 每条疑似必须恰好有一条裁定；账本里的 main 按开跑顺序编号，中止的列出不计。
 */
export function tallyTriage(input: {
  ledger: LedgerLine[];
  summaries: { runId: string; turns: number; status: string }[];
  candidates: { id: string; detector: DetectorId; runId: string }[];
  verdicts: { id: string; verdict: 'confirmed' | 'false_positive' }[];
}): TriageTally {
  const starts = input.ledger.filter((l) => l.kind === 'main' && l.event === 'start');
  const ended = new Set(input.ledger.filter((l) => l.kind === 'main' && l.event === 'end').map((l) => l.runId));
  const verdicts = new Map<string, 'confirmed' | 'false_positive'>();
  for (const v of input.verdicts) {
    if (verdicts.has(v.id)) throw new Error(`裁定重复：${v.id}`);
    verdicts.set(v.id, v.verdict);
  }
  const runs: TallyRun[] = [];
  const aborted: TriageTally['aborted'] = [];
  starts.forEach((start, i) => {
    const attempt = i + 1;
    if (!ended.has(start.runId)) return void aborted.push({ attempt, runId: start.runId });
    const summary = input.summaries.find((s) => s.runId === start.runId);
    if (!summary) return;
    const detectors = Object.fromEntries(DETECTORS.map((d) => [d, { suspects: 0, confirmed: 0 }])) as TallyRun['detectors'];
    for (const c of input.candidates.filter((c) => c.runId === start.runId)) {
      const verdict = verdicts.get(c.id);
      if (!verdict) throw new Error(`疑似没有裁定：${c.id}`);
      detectors[c.detector].suspects++;
      if (verdict === 'confirmed') detectors[c.detector].confirmed++;
    }
    runs.push({ attempt, runId: start.runId, turns: summary.turns, detectors });
  });
  const known = new Set(input.candidates.map((c) => c.id));
  const stray = input.verdicts.find((v) => !known.has(v.id));
  if (stray) throw new Error(`裁定没有对应的疑似：${stray.id}`);
  return { runs, aborted };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const yuan = (x: number): string => `¥${x.toFixed(4)}`;
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`;
function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderTriage(appendix: Appendix18): string {
  const { runs, aborted } = appendix.tally;
  const head = ['检测器', ...runs.map((r) => `第 ${r.attempt} 次 疑似/确认`)];
  const rows = DETECTORS.map((d) => [`\`${d}\``, ...runs.map((r) => `${r.detectors[d].suspects} / ${r.detectors[d].confirmed}`)]);
  const total = (r: TallyRun, key: 'suspects' | 'confirmed') => DETECTORS.reduce((n, d) => n + r.detectors[d][key], 0);
  rows.push(['合计', ...runs.map((r) => `${total(r, 'suspects')} / ${total(r, 'confirmed')}`)]);
  rows.push(['误报率', ...runs.map((r) => (total(r, 'suspects') ? pct(1 - total(r, 'confirmed') / total(r, 'suspects')) : '-'))]);
  rows.push(['每百轮确认', ...runs.map((r) => (r.turns ? ((total(r, 'confirmed') / r.turns) * 100).toFixed(1) : '-'))]);
  rows.push(['轮数', ...runs.map((r) => String(r.turns))]);
  return [
    '检测器从 journal 里找判分和审计看不到的坏轮，旧的几次由检测器回溯 journal 得到，不花模型费用。每条疑似由跑仿真的 agent 按同一份口径初裁，协调者复核口径分歧；疑似清单和裁定含对话摘录，留在本机，这里只有计数。表里只数检测器标出的条目，读对话另外找到的坏轮写在第 8 章「看过留出集之后的改动」。',
    '',
    table(head, rows),
    '',
    ...aborted.map((a) => `第 ${a.attempt} 次（${a.runId.slice(0, 8)}）开跑后中止，0 段跑完，列出不计。`),
  ].join('\n');
}

export function renderCompare18(appendix: Appendix18): string {
  const { before: b, after: a } = appendix;
  const rows: (string | number)[][] = [
    ['金额护栏删句轮数', `${b.moneyDropTurns} / ${b.turns}`, `${a.moneyDropTurns} / ${a.turns}`],
    ['模型在正文写的商品金额（次）', b.modelItemAmounts, a.modelItemAmounts],
    ['客户看到的正文里的商品金额（次，不算价格块）', b.bodyItemAmounts, a.bodyItemAmounts],
    [
      '`price_withheld` 疑似 / 确认',
      `${b.priceWithheld.suspects} / ${b.priceWithheld.confirmed}`,
      `${a.priceWithheld.suspects} / ${a.priceWithheld.confirmed}`,
    ],
    ['检测器确认坏轮（每百轮）', b.confirmedPer100.toFixed(1), a.confirmedPer100.toFixed(1)],
    [
      '成功率（保守）',
      `${pct(b.success.rate)}（${pct(b.success.conservative)}）`,
      `${pct(a.success.rate)}（${pct(a.success.conservative)}）`,
    ],
    ['按段区间', `${pct(b.success.low)}–${pct(b.success.high)}`, `${pct(a.success.low)}–${pct(a.success.high)}`],
    ['回复 p90', sec(b.p90), sec(a.p90)],
    ['销售侧单段费用', yuan(b.salesPerRun), yuan(a.salesPerRun)],
  ];
  return [
    `第 ${b.attempt} 次（${b.runId.slice(0, 8)}）是 18 之前最后一次完整主跑，第 ${a.attempt} 次（${a.runId.slice(0, 8)}）带上了价格块和混合检索。两次之间还合入了其他产品修复，见第 8 章「看过留出集之后的改动」，差值不全归 18。\`price_withheld\` 和确认坏轮只数检测器标出的条目，检测器漏掉、读对话找到的也写在第 8 章。`,
    '',
    table(['', `第 ${b.attempt} 次`, `第 ${a.attempt} 次`], rows),
    '',
    '按场景族的通过数（剔除段不进分母）：',
    '',
    table(
      ['场景族', `第 ${b.attempt} 次`, `第 ${a.attempt} 次`],
      appendix.families.map((f) => [f.family, `${f.before.passed}/${f.before.total}`, `${f.after.passed}/${f.after.total}`]),
    ),
  ].join('\n');
}

/** 命令行：汇总附表计数。node --import tsx eval/sim/report-18.ts --ledger <账本> --summary <triage 输出>... --candidates <文件>... --review <文件>... --out <文件> */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const lists = new Map<string, string[]>();
  let key: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      key = arg;
      if (!['--ledger', '--summary', '--candidates', '--review', '--out'].includes(key) || lists.has(key)) throw new Error('参数错误');
      lists.set(key, []);
    } else if (key) lists.get(key)!.push(arg);
    else throw new Error('参数错误');
  }
  const one = (k: string): string => {
    const v = lists.get(k);
    if (!v || v.length !== 1) throw new Error(`${k} 需要一个文件`);
    return v[0]!;
  };
  const many = async <T>(k: string): Promise<T[]> => {
    const files = lists.get(k);
    if (!files?.length) throw new Error(`${k} 需要文件`);
    return (await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8')) as T[]))).flat();
  };
  const ledger = (await fs.readFile(one('--ledger'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as LedgerLine);
  const tally = tallyTriage({
    ledger,
    summaries: await many('--summary'),
    candidates: await many('--candidates'),
    verdicts: await many('--review'),
  });
  const out = one('--out');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(tally, null, 2) + '\n');
  console.log(JSON.stringify(tally.runs.map((r) => ({ attempt: r.attempt, turns: r.turns }))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : '附表汇总失败');
    process.exitCode = 1;
  });
}
