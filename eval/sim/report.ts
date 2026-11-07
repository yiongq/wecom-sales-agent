// 16 R7：统计只读存档，裁定只把通过降为规则失败。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { RuleId } from './audit.js';
import { loadGoals, type SimGoal } from './goals.js';
import type { Freeze, Interval, JourneyReport, LedgerLine, ReviewFile, RunMeta } from './report-types.js';
import type { RunResult } from './runner.js';
import { renderCharts, renderReport, renderSample } from './report-render.js';
import { buildAppendix18, type TriageTally } from './report-18.js';

export const LIMITS = [
  '客户是模型演的。公开研究显示模型扮用户比真人更配合、更早说全信息，成功率和真人结果有系统偏差，多数情况偏高。它不等于线上转化率或解决率。',
  '场景是作者自己写的。留出集防的是对着题调，防不了作者的盲区；运行者也能看到中间结果，约束靠 owner 逐次授权和账本。',
  '产品库只有 40 条合成数据，真实商家的型号、单位和价格结构可能更乱。',
  '顾问批准是确定性替身，错单也批，不含真人判断和等待。',
  '没走企微：时延不含收发，也没经过分段、额度和回执；客户看到的是卡片文字，没打开报价单页。配置来自文件，线上来自数据库。',
  '零违规说的是没有漏到客户，不是模型没犯，原稿命中数见第 5 章；它也不等于不会违规，只给出本次的上界。审计和产品出自同一作者，独立的只是代码。',
  '结果绑定这一个模型版本和这一个时段；接口快慢会变，费用按当时标准单价算，不含已取消的对冲请求。换模型扮客户，成功率也会变，本次的差值见第 3 章。',
  '判分不看话术：语气差、表达绕的回复也可能算通过。',
  '根因是 AI 标注，疑似裁定是 AI 初裁加 AI 复核；误报 owner 全看，其余抽查，不是人工逐条审。',
  '不证明商业价值：转化率、节省人力都没测。',
] as const;

export interface ReportInput {
  runs: RunResult[];
  swapRuns: RunResult[];
  goals: SimGoal[];
  ledger: LedgerLine[];
  freeze: Freeze;
  review: ReviewFile;
  meta: RunMeta;
  /** 开发集最后一次的结果，单列，不合并 */
  dev?: { runs: RunResult[]; goals: SimGoal[]; k: number };
}
export interface Sample {
  goalId: string;
  repetition: number;
  bucket: string;
  persona?: true;
}
const CODE: RuleId[] = ['price_line', 'line_total', 'moq', 'approval', 'markdown'];
const EXIT: RuleId[] = ['reply_amount', 'unapproved_link', 'stock_claim', 'banned_phrase', 'discount_promise'];
const ratio = (x: number, n: number): number => (n ? x / n : 0);
const excluded = (r: RunResult): boolean => ['customer_protocol', 'customer_http', 'customer_drift'].includes(r.status);
const key = (r: { goalId: string; repetition: number }): string => JSON.stringify([r.goalId, r.repetition]);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function wilson(rate: number, n: number): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const z2 = 1.96 ** 2;
  const center = (rate + z2 / (2 * n)) / (1 + z2 / n);
  const half = (1.96 * Math.sqrt((rate * (1 - rate) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
export function zeroUpper(n: number): number {
  return n === 0 ? 1 : 1 - 0.05 ** (1 / n);
}

/** 同一遍的最后一个完整记录生效；续跑前的预算截断费用仍然保留。 */
function latest(runs: RunResult[]): RunResult[] {
  const byKey = new Map<string, RunResult>();
  for (const run of runs) {
    const old = byKey.get(key(run));
    byKey.set(key(run), old?.status === 'budget_stop' ? { ...run, charges: [...old.charges, ...run.charges] } : run);
  }
  return [...byKey.values()].toSorted((a, b) => cmp(a.goalId, b.goalId) || a.repetition - b.repetition);
}
function audited(runs: RunResult[]): RunResult[] {
  return runs.flatMap((r) => [r, ...(r.replaced ? audited([r.replaced]) : [])]);
}
function adjudicate(runs: RunResult[], review: ReviewFile): RunResult[] {
  const verdicts = new Map(review.verdicts.map((v) => [v.findingId, v.verdict]));
  return latest(runs).map((r) =>
    r.status === 'passed' && r.findings?.some((f) => f.level === 'suspect' && f.source === 'final' && verdicts.get(f.id) === 'confirmed')
      ? { ...r, status: 'failed', bucket: 'rule_violation' }
      : r,
  );
}
function statistics(runs: RunResult[], goals: SimGoal[], k: number) {
  const scenes = goals.map((g) => {
    const done = runs.filter((r) => r.goalId === g.id && r.status !== 'budget_stop');
    return {
      id: g.id,
      family: g.journey!.family,
      passed: done.filter((r) => r.status === 'passed').length,
      total: done.length,
      excluded: done.filter(excluded).length,
      voided: Boolean(g.journey!.voided),
    };
  });
  const active = new Set(scenes.filter((s) => !s.voided).map((s) => s.id));
  const done = runs.filter((r) => active.has(r.goalId) && r.status !== 'budget_stop');
  const valid = done.filter((r) => !excluded(r));
  const passed = valid.filter((r) => r.status === 'passed').length;
  const eligible = scenes.filter((s) => !s.voided && s.total > s.excluded);
  const allPassed = eligible.filter((s) => s.passed === s.total - s.excluded).length;
  const modelFree = new Set(goals.filter((g) => g.journey!.modelFree).map((g) => g.id));
  const without = valid.filter((r) => !modelFree.has(r.goalId));
  const success = {
    rate: ratio(passed, valid.length),
    conservative: ratio(passed, done.length),
    withoutModelFree: ratio(without.filter((r) => r.status === 'passed').length, without.length),
    byRuns: wilson(ratio(passed, valid.length), valid.length),
    byScenes: wilson(ratio(allPassed, eligible.length), eligible.length),
    passK: ratio(allPassed, eligible.length),
  };
  const incomplete =
    goals.some((g) => runs.filter((r) => r.goalId === g.id && r.status !== 'budget_stop').length < k) ||
    runs.some((r) => r.status === 'budget_stop');
  const unstable = ratio(done.filter(excluded).length, done.length) > 0.1 || scenes.some((s) => !s.voided && s.excluded > 2);
  return { scenes, done, success, incomplete, unstable };
}
function validateRuns(runs: RunResult[], goals: SimGoal[], k: number): void {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('k 必须是正整数');
  const ids = new Set(goals.map((g) => g.id));
  if (!goals.length || ids.size !== goals.length || goals.some((g) => !g.journey)) throw new Error('目标必须是不重复的 journey 场景');
  for (const r of runs) {
    if (!ids.has(r.goalId) || !Number.isSafeInteger(r.repetition) || r.repetition < 1 || r.repetition > k)
      throw new Error('journal 的目标或遍号不属于本次运行');
  }
}

export function buildReport(input: ReportInput): JourneyReport {
  if (LIMITS.length !== 10) throw new Error('第 7 章基础条目不完整');
  const { goals, ledger, review, meta } = input;
  validateRuns(input.runs, goals, meta.k);
  const raw = latest(input.runs);
  const runs = adjudicate(input.runs, review);
  const stats = statistics(runs, goals, meta.k);
  const verdicts = new Map(review.verdicts.map((v) => [v.findingId, v]));
  const allAudited = audited(raw);
  const findings = allAudited
    .flatMap((r) => r.findings ?? [])
    .map((f) => ({
      ...f,
      verdict: verdicts.get(f.id)?.verdict ?? null,
      reason: verdicts.get(f.id)?.reason ?? null,
    }));
  const rules: JourneyReport['rules'] = [...CODE, ...EXIT].map((rule) => {
    const hits = findings.filter((f) => f.rule === rule);
    return {
      rule,
      level: CODE.includes(rule) ? 'code' : 'suspect',
      draftHits: hits.filter((f) => f.source === 'draft').length,
      finalHits: hits.filter((f) => f.source === 'final').length,
      confirmed: hits.filter((f) => f.source === 'final' && f.verdict === 'confirmed').length,
      falsePositive: hits.filter((f) => f.source === 'final' && f.verdict === 'false_positive').length,
    };
  });
  const buckets: Record<string, number> = {};
  const funnel = { quoted: 0, built: 0, approved: 0, accepted: 0 };
  const handoffMatrix = { expectedYes: { yes: 0, no: 0 }, expectedNo: { yes: 0, no: 0 } };
  const byId = new Map(goals.map((g) => [g.id, g]));
  const guards = new Map<string, number>();
  const times: number[] = [];
  let deterministicTurns = 0;
  let rewrittenTurns = 0;
  for (const r of stats.done) {
    if (r.status !== 'passed') {
      const bucket = excluded(r) ? r.status : (r.bucket ?? 'runner_error');
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    const state = r.finalState ?? r.turns.at(-1)?.state ?? r.initial;
    if (r.turns.some((t) => t.trace.turn.calls.some((c) => c.name === 'quote_items'))) funnel.quoted++;
    // 已被替代或取消的单仍然算建过单。
    if (state.orders.length) funnel.built++;
    if (r.decided?.some((d) => d.decision === 'approve')) funnel.approved++;
    if (state.orders.some((o) => 'v' in o && o.approval?.acceptedAt !== undefined)) funnel.accepted++;
    const expected = byId.get(r.goalId)!.journey!.expect.end;
    handoffMatrix[expected === 'handoff' || expected === 'quote_rejected' ? 'expectedYes' : 'expectedNo'][
      state.handedOver ? 'yes' : 'no'
    ]++;
  }
  // 工作量和耗时覆盖实际发生的轮次，含替换、剔除和预算截断的段。
  for (const r of allAudited) {
    const traces = r.turns.map((t) => t.trace);
    if (r.failedTurn && !traces.some((t) => t.turn.turnId === r.failedTurn!.turn.turnId)) traces.push(r.failedTurn);
    for (const t of traces) {
      if (t.turn.guards.length) rewrittenTurns++;
      for (const guard of new Set(t.turn.guards.map((g) => g.guard))) guards.set(guard, (guards.get(guard) ?? 0) + 1);
      if (t.outcome === 'replied') times.push(t.durationMs);
      if (t.outcome === 'deterministic') deterministicTurns++;
    }
  }
  times.sort((a, b) => a - b);
  const percentile = (p: number): number => times[Math.ceil(p * times.length) - 1] ?? 0;
  const charges = raw.flatMap((r) => r.charges);
  const sales = charges.filter((c) => c.side === 'sales');
  const salesCost = sales.reduce((n, c) => n + c.cny, 0);
  const auditedRuns = allAudited.filter((r) => r.findings !== undefined);
  const swapEnd = ledger.findLast((l) => l.kind === 'customer_swap' && l.event === 'end');
  const swapStart = ledger.find((l) => l.kind === 'customer_swap' && l.event === 'start' && l.runId === swapEnd?.runId);
  let swap: JourneyReport['swap'] = null;
  if (input.swapRuns.length) {
    validateRuns(input.swapRuns, goals, swapStart?.k ?? meta.k);
    const swapped = latest(input.swapRuns);
    const s = statistics(swapped, goals, swapStart?.k ?? meta.k);
    swap = {
      customerModel: swapStart?.customerModel ?? '',
      rate: s.success.rate,
      byScenes: s.success.byScenes,
      suspects: audited(swapped)
        .flatMap((r) => r.findings ?? [])
        .filter((f) => f.level === 'suspect' && f.source === 'final').length,
      valid: !s.unstable && !s.incomplete,
    };
  }
  let dev: JourneyReport['dev'] = null;
  if (input.dev) {
    validateRuns(input.dev.runs, input.dev.goals, input.dev.k);
    const s = statistics(adjudicate(input.dev.runs, review), input.dev.goals, input.dev.k);
    dev = { rate: s.success.rate, runs: s.done.length };
  }
  const ends = new Set(ledger.filter((l) => l.event === 'end').map((l) => l.runId));
  const aborts = ledger
    .filter((l) => l.event === 'start' && !ends.has(l.runId))
    .map((l) => ({
      runId: l.runId,
      reason: review.aborts.find((a) => a.runId === l.runId)?.reason ?? l.reason ?? '未记录原因',
    }));
  return {
    meta: structuredClone(meta),
    status: stats.incomplete ? 'incomplete' : stats.unstable ? 'unstable' : 'formal',
    // 被杀的运行只有开跑行，也算一次（验收 9）。
    attempt: new Set(ledger.filter((l) => l.kind === 'main' && l.event === 'start').map((l) => l.runId)).size,
    scenes: stats.scenes,
    success: stats.success,
    funnel,
    buckets,
    rules,
    zeroUpper: rules.some((r) => r.level === 'suspect' && r.confirmed > 0)
      ? null
      : {
          byRuns: zeroUpper(auditedRuns.length),
          byScenes: zeroUpper(new Set(auditedRuns.map((r) => r.goalId)).size),
        },
    handoffMatrix,
    guards: [...guards].toSorted(([a], [b]) => cmp(a, b)).map(([guard, turns]) => ({ guard, turns })),
    rewrittenTurns,
    latency: {
      samples: times.length,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      max: times.at(-1) ?? 0,
      over8sShare: ratio(times.filter((n) => n > 8000).length, times.length),
      deterministicTurns,
    },
    cost: {
      salesPerRun: ratio(salesCost, raw.length),
      customerPerRun: ratio(
        charges.filter((c) => c.side === 'customer').reduce((n, c) => n + c.cny, 0),
        raw.length,
      ),
      salesPerAccepted: funnel.accepted ? salesCost / funnel.accepted : null,
      cacheHitRate: ratio(
        sales.reduce((n, c) => n + c.cachedTokens, 0),
        sales.reduce((n, c) => n + c.promptTokens, 0),
      ),
    },
    swap,
    dev,
    personaChecks: {
      sampled: review.personaChecks.length,
      withErrors: review.personaChecks.filter((p) => p.errors.length > 0).length,
      blocksTask: review.personaChecks.filter((p) => p.blocksTask).length,
    },
    causes: structuredClone(review.causes),
    findings,
    aborts,
    ledger: structuredClone(ledger),
    revisions: structuredClone(review.revisions),
  };
}

export function selectSamples(input: Pick<ReportInput, 'runs' | 'freeze' | 'review'>): Sample[] {
  const sorted = adjudicate(input.runs, input.review)
    .filter((r) => r.status !== 'budget_stop')
    .map((r) => ({
      run: r,
      hash: createHash('sha256')
        .update(input.freeze.commit + r.goalId + r.repetition)
        .digest('hex'),
    }))
    .toSorted((a, b) => cmp(a.hash, b.hash) || cmp(key(a.run), key(b.run)));
  const counts = new Map<string, number>();
  const selected: Sample[] = [];
  for (const { run } of sorted) {
    const bucket = run.status === 'failed' ? (run.bucket ?? 'runner_error') : run.status;
    const count = counts.get(bucket) ?? 0;
    if (count < (bucket === 'passed' ? 5 : 1)) selected.push({ goalId: run.goalId, repetition: run.repetition, bucket });
    counts.set(bucket, count + 1);
  }
  return [
    ...selected,
    ...sorted.slice(0, 20).map(({ run }) => ({
      goalId: run.goalId,
      repetition: run.repetition,
      bucket: run.status === 'failed' ? (run.bucket ?? 'runner_error') : run.status,
      persona: true as const,
    })),
  ];
}

export function checkFormal(input: ReportInput & { ledgerCommitted: boolean }): string[] {
  const reasons: string[] = [];
  const end = input.ledger.findLast((l) => l.kind === 'main' && l.event === 'end');
  if (input.meta.kind !== 'main' || end?.runId !== input.meta.runId) reasons.push('journal 不是账本里最后一次完整 main');
  if (!input.ledgerCommitted) reasons.push('主跑账本行没有全部提交');
  const verdicts = new Set(input.review.verdicts.map((v) => v.findingId));
  if (
    audited(latest(input.runs)).some((r) => r.findings?.some((f) => f.level === 'suspect' && f.source === 'final' && !verdicts.has(f.id)))
  )
    reasons.push('最终回复的疑似尚未全部裁定');
  const report = buildReport(input);
  if (report.status !== 'formal') reasons.push(report.status === 'incomplete' ? '未跑完，不能生成正式报告' : '仿真不稳，不能生成正式报告');
  return reasons;
}

export function readJournal(text: string): { meta: RunMeta; runs: RunResult[] } {
  const lines = text
    .split('\n')
    .slice(0, -1)
    .map((s) => JSON.parse(s));
  const head = lines.shift();
  if (head?.type !== 'head' || !head.meta) throw new Error('journal 缺少完整 head 行');
  if (lines.some((l) => l.type !== 'run' || !l.run)) throw new Error('journal 记录类型错误');
  return { meta: head.meta, runs: latest(lines.map((l) => l.run)) };
}

/** 独立于仓库词表；只报类别，绝不回显命中的内容。 */
export function scanPublic(text: string): void {
  const patterns: [string, RegExp][] = [
    ['本机路径', /\/(?:Users|home|root|Volumes|mnt|tmp|private\/tmp|private\/var\/folders|var\/folders)\/|[A-Za-z]:[\\/]/iu],
    [
      '密钥形态',
      /\b(?:sk|sess|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\b[a-f0-9]{32}\.[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|(?:api[_-]?key|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?[^\s"',}]{8,}/iu,
    ],
    ['服务地址', /https?:\/\/[^\s"'<>]+|(?:base[_-]?url|endpoint)\s*["']?\s*[:=]/iu],
  ];
  const decoded = text
    .replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//gu, '/')
    .replaceAll('http://www.w3.org/2000/svg', ''); // SVG 的命名空间，不是服务地址
  for (const [label, pattern] of patterns) if (pattern.test(decoded)) throw new Error(`公开边界扫描失败：${label}`);
}

const GOALS = ['eval/sim/goals/industrial/journey/holdout', 'eval/sim/goals/industrial/journey/dev'];

/** 主跑账本行是否都已提交（工作区里的主跑行和 HEAD 里的逐行相同） */
function ledgerInHead(file: string, ledger: LedgerLine[]): boolean {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10000 }).trim();
    const relative = path.relative(root, path.resolve(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const committed = execFileSync('git', ['show', `HEAD:${relative}`], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s) as LedgerLine);
    return isDeepStrictEqual(
      ledger.filter((l) => l.kind === 'main'),
      committed.filter((l) => l.kind === 'main'),
    );
  } catch {
    return false;
  }
}

/**
 * 正式报告：--main、--ledger、--freeze、--review 齐全，checkFormal 全过才写。
 * 草稿（--draft yes）：只给 --main 或 --dev 也能出，小样和开发集分诊用，不检查冻结与裁定，页面标「草稿」，写进 var/。
 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const values = new Map<string, string>();
  const allowed = [
    '--main',
    '--swap',
    '--dev',
    '--ledger',
    '--freeze',
    '--review',
    '--date',
    '--out',
    '--draft',
    '--goals',
    // 18 R2、R6：三个一起给才生成附表与前后对比
    '--triage',
    '--baseline',
    '--baseline-summary',
  ];
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    if (!allowed.includes(option) || !args[i + 1] || args[i + 1].startsWith('--') || values.has(option)) throw new Error('报告参数错误');
    values.set(option, args[i + 1]);
  }
  const draft = values.get('--draft') === 'yes';
  for (const required of draft ? ['--date', '--out'] : ['--main', '--ledger', '--freeze', '--review', '--date', '--out'])
    if (!values.get(required)) throw new Error(`必须提供 ${required}`);
  const date = values.get('--date')!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('--date 必须是有效日期');
  const journalOf = async (option: string) => {
    const file = values.get(option);
    return file ? readJournal(await fs.readFile(file, 'utf8')) : undefined;
  };
  const dev = await journalOf('--dev');
  const journal = (await journalOf('--main')) ?? (draft ? dev : undefined);
  const swap = await journalOf('--swap');
  if (!journal) throw new Error('必须提供 journal');
  if (!draft && journal.meta.kind !== 'main') throw new Error('--main 不是 main journal');
  if (dev && dev.meta.kind !== 'dev' && dev.meta.kind !== 'pilot') throw new Error('--dev 不是开发集 journal');
  if (swap && swap.meta.kind !== 'customer_swap') throw new Error('--swap 不是 customer_swap journal');
  const json = async <T>(option: string, fallback: T): Promise<T> => {
    const file = values.get(option);
    return file ? (JSON.parse(await fs.readFile(file, 'utf8')) as T) : fallback;
  };
  const ledgerFile = values.get('--ledger');
  const ledger: LedgerLine[] = ledgerFile
    ? (await fs.readFile(ledgerFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s) as LedgerLine)
    : [];
  const all = (await Promise.all((values.has('--goals') ? [values.get('--goals')!] : GOALS).map((dir) => loadGoals(dir)))).flat();
  const ran = (j: { runs: RunResult[] }): SimGoal[] => all.filter((g) => j.runs.some((r) => r.goalId === g.id));
  const review = await json<ReviewFile>('--review', { causes: [], verdicts: [], personaChecks: [], revisions: [], aborts: [] });
  const input: ReportInput = {
    ...journal,
    goals: draft ? ran(journal) : all.filter((g) => g.journey?.split === 'holdout'),
    ledger,
    freeze: await json<Freeze>('--freeze', { commit: journal.meta.head, trees: journal.meta.trees }),
    review,
    swapRuns: swap?.runs ?? [],
    ...(dev && dev !== journal ? { dev: { runs: dev.runs, goals: ran(dev), k: dev.meta.k } } : {}),
  };
  if (!draft) {
    const reasons = checkFormal({ ...input, ledgerCommitted: ledgerInHead(ledgerFile!, ledger) });
    if (reasons.length) throw new Error(reasons.join('；'));
    if (input.meta.freezeCommit !== input.freeze.commit || !isDeepStrictEqual(input.meta.trees, input.freeze.trees))
      throw new Error('冻结值不符');
  }
  const report = buildReport(input);
  const appendixOptions = ['--triage', '--baseline', '--baseline-summary'].filter((o) => values.has(o));
  if (appendixOptions.length === 3) {
    const baseline = await journalOf('--baseline');
    if (baseline!.meta.kind !== 'main') throw new Error('--baseline 不是 main journal');
    const baselineSummary = await json<JourneyReport>('--baseline-summary', undefined as never);
    if (baselineSummary.meta.runId !== baseline!.meta.runId) throw new Error('--baseline 与 --baseline-summary 不是同一次运行');
    report.appendix18 = buildAppendix18({
      tally: await json<TriageTally>('--triage', undefined as never),
      before: { summary: baselineSummary, runs: baseline!.runs },
      after: { summary: report, runs: input.runs },
    });
  } else if (appendixOptions.length) throw new Error('--triage、--baseline、--baseline-summary 要一起给');
  const selected = selectSamples(input);
  const sampleFile = (i: number): string => `samples/${String(i + 1).padStart(3, '0')}.md`;
  const artifacts = new Map<string, string>([
    ['report.md', renderReport(report, { draft, samples: selected.map((sample, i) => ({ ...sample, file: sampleFile(i) })) })],
    ['summary.json', JSON.stringify(report, null, 2) + '\n'],
    ['samples/index.json', JSON.stringify(selected, null, 2) + '\n'],
    ...Object.entries(renderCharts(report)),
  ]);
  const adjudicated = adjudicate(input.runs, input.review);
  selected.forEach((sample, i) => {
    artifacts.set(sampleFile(i), renderSample({ ...sample, run: adjudicated.find((r) => key(r) === key(sample))! }));
  });
  for (const content of artifacts.values()) scanPublic(content);
  const out = path.resolve(values.get('--out')!, date);
  // 不覆盖旧报告，避免留下上次抽样的残余文件；草稿反复重写。
  if (draft) await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  try {
    for (const [name, content] of artifacts) {
      await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true });
      await fs.writeFile(path.join(out, name), content);
    }
    // 草稿写在被忽略的 var/ 下，不进仓库，oxfmt 也不处理被忽略的目录。
    if (!draft) execFileSync('pnpm', ['exec', 'oxfmt', out], { timeout: 30000, stdio: 'pipe' });
    for (const name of artifacts.keys()) scanPublic(await fs.readFile(path.join(out, name), 'utf8'));
  } catch (error) {
    await fs.rm(out, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(
      e instanceof SyntaxError
        ? '报告输入 JSON 无效'
        : e instanceof Error && !('code' in e)
          ? e.message
          : '报告生成失败（文件或子进程错误）',
    );
    process.exitCode = 1;
  });
}
