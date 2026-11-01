import type { UsageEvent } from '../../src/usage.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { Finding, PartRow } from './audit.js';
import { auditRun } from './audit.js';
import type { SalesTurnError } from './runtime.js';
import { judgeJourney } from './journey.js';
import { goalPack, type JourneySpec, type SimGoal } from './goals.js';
import { judge, type Evidence, type SimTurn, type Snapshot, type Verdict } from './judge.js';
import { computeMetrics, turnMetric, type Metrics, type TurnMetric } from './metrics.js';

export interface Charge {
  side: 'customer' | 'sales';
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cny: number;
}
export class Meter {
  readonly charges: Charge[] = [];
  private readonly aborter = new AbortController();
  constructor(
    readonly budget: number,
    initial: Charge[] = [],
  ) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget 必须是正数');
    this.restore(initial);
  }
  restore(charges: Charge[]): void {
    for (const charge of charges) this.add(charge);
  }
  get total(): number {
    return this.charges.reduce((sum, c) => sum + c.cny, 0);
  }
  get stopped(): boolean {
    return this.total >= this.budget;
  }
  get signal(): AbortSignal {
    return this.aborter.signal;
  }
  add(charge: Charge): void {
    if (!Number.isFinite(charge.cny) || charge.cny < 0) throw new Error('费用不是非负有限数');
    this.charges.push(charge);
    if (this.stopped) this.aborter.abort(new Error('budget_stop'));
  }
  totals(): { customer: number; sales: number; total: number } {
    return {
      customer: this.charges.filter((c) => c.side === 'customer').reduce((a, c) => a + c.cny, 0),
      sales: this.charges.filter((c) => c.side === 'sales').reduce((a, c) => a + c.cny, 0),
      total: this.total,
    };
  }
}
export type Tokens = Pick<UsageEvent, 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'reasoningTokens'>;
export interface CustomerResponse {
  raw: string;
  tokens: Tokens;
}
export interface SimDeps {
  customer(persona: string, history: { role: 'user' | 'assistant'; content: string }[], retry: boolean): Promise<CustomerResponse>;
  customerModel: string;
  /** 给了 --config-dir 时是它的绝对路径（旅游或其他包的导出目录都一样）：品牌由目录里的 brand.json 定，目标的 brand 字段不再拒绝。没给是 undefined。 */
  configDir?: string;
  price(model: string, tokens: Tokens): number;
  /** 通用单的种子要经包的 priceLine 异步建，所以可以返回 Promise；同步的假依赖照旧 */
  start(initial?: SimGoal['initial']): { id: string; initial: Snapshot } | Promise<{ id: string; initial: Snapshot }>;
  /** 运行时装载的包 id（08 R11）；给了就核对目标的 pack，假依赖不填就不核对 */
  pack?: string;
  /** attach（12 R13）：eval/fixtures/attachments/ 下的样本名；有它时这条消息是文件，say 不进引擎（渠道写占位），返回的 SimTurn.customer.say 是占位 */
  sales(id: string, customer: { say: string; done: boolean; attach?: string }): Promise<SimTurn>;
  end(id: string): Promise<void>;
  /** 16 R2：审批替身调真实 approveQuote / rejectQuote，返回写进客户历史的通知文字和决定之后的快照 */
  decide?(orderId: string, d: NonNullable<JourneySpec['approver']>): Promise<{ notice: string | null; state: Snapshot }>;
  /** 16 R4：审计用的产品库，直接读 data/packs/industrial 的 JSON，不经包。journey 目标才用 */
  catalog?: PartRow[];
}
export type RunStatus = 'passed' | 'failed' | 'customer_protocol' | 'customer_http' | 'customer_drift' | 'budget_stop';
export type FailBucket =
  | 'model_error'
  | 'runner_error'
  | 'rule_violation'
  | 'unneeded_handoff'
  | 'quote_missing'
  | 'wrong_lines'
  | 'wrong_total'
  | 'not_approved'
  | 'not_accepted'
  | 'not_rejected'
  | 'missed_handoff'
  | 'wrong_handoff'
  | 'unexpected_quote'
  | 'no_evidence';
export interface RunResult extends Evidence {
  goalId: string;
  repetition: number;
  status: RunStatus;
  endedBy: 'done' | 'maxTurns' | 'customer_protocol' | 'budget_stop' | 'runner_error' | 'handoff';
  verdicts: Verdict[];
  reasons: string[];
  customerAttempts: { raw: string; valid: boolean; turn: number; retry: boolean }[];
  charges: Charge[];
  /** 每轮的耗时、本轮工具、形状（与 turns 一一对应） */
  turnMetrics: TurnMetric[];
  /** 第一遍客户没按协议出话，这是整遍重跑后的结果 */
  rerun: boolean;
  // ---- 16：只加字段，现有目标不填 ----
  /** 失败桶（status 是 failed 时） */
  bucket?: FailBucket;
  /** 运行结束时的最新状态；判分、审计、转人工即停都读它，不读最后一轮的 SimTurn.state */
  finalState?: Snapshot;
  decided?: { orderId: string; decision: 'approve' | 'reject' }[];
  /** 写进客户历史的卡片文字 */
  notices?: string[];
  /** 被整遍重跑替换掉的一遍（费用已并进外层的 charges，汇总时不要再加一次） */
  replaced?: RunResult;
  /** 销售这一轮抛错时的 trace */
  failedTurn?: FinishedTurn;
  /** 本遍的审计命中（16 R4），含原稿计数 */
  findings?: Finding[];
  /** 所属运行的 runId，进 Finding.id */
  runId?: string;
  /** 这一遍后来被整遍重跑替换了，进 Finding.id */
  wasReplaced?: true;
  /** 最后一轮客户只表达结束、一句话没说（R3 customer_drift 第二种） */
  leftSilently?: true;
  /** 客户接口重试后仍失败时的状态码和错误码，只供分诊 */
  customerHttp?: string;
}
export interface Summary {
  id: string;
  passed: number;
  failed: number;
  customer_protocol: number;
  customer_http?: number;
  customer_drift?: number;
  budget_stop: number;
  unrun: number;
  /** pass^k 的分母：k 减去两遍都没按协议出话的运行；journey 再减 HTTP 失败和客户偏离 */
  denominator: number;
  /** customer_protocol 的运行占 k 超过 20%：客户脚本要改 */
  needsScriptFix: boolean;
  passK: boolean;
}
export interface SimReport {
  k: number;
  budget: number;
  runs: RunResult[];
  summary: Summary[];
  customer_protocol: number;
  customer_http?: number;
  customer_drift?: number;
  budget_stop: number;
  cost: ReturnType<Meter['totals']>;
  charges: Charge[];
  metrics: Metrics;
}
function customerMessage(raw: string): { say: string; done: boolean } | null {
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const o = p as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'say' && k !== 'done') || typeof o.say !== 'string' || typeof o.done !== 'boolean') return null;
    if (!o.done && !o.say.trim()) return null;
    return { say: o.say, done: o.done };
  } catch {
    return null;
  }
}

async function executeRun(goal: SimGoal, repetition: number, meter: Meter, deps: SimDeps, runId?: string): Promise<RunResult> {
  const chargeStart = meter.charges.length;
  const { id, initial } = await deps.start(goal.initial);
  const run: RunResult = {
    goalId: goal.id,
    repetition,
    initial,
    turns: [],
    status: 'failed',
    endedBy: 'maxTurns',
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
    ...(runId === undefined ? {} : { runId }),
  };
  let latest = initial;
  if (goal.journey) {
    run.finalState = latest;
    run.decided = [];
    run.notices = [];
  }
  // 客户模型的视角：它自己说的是 assistant，销售的回复是 user
  const history: { role: 'user' | 'assistant'; content: string }[] = (goal.initial?.history ?? []).map((m) => ({
    role: m.role === 'customer' ? 'assistant' : 'user',
    content: m.content,
  }));
  try {
    turns: for (let turn = 1; turn <= (goal.maxTurns ?? 12); turn++) {
      let customer: ReturnType<typeof customerMessage> | { say: string; done: boolean; attach: string } = null;
      const scripted = goal.customerScript?.[turn - 1];
      if (scripted !== undefined)
        customer =
          typeof scripted === 'string' ? { say: scripted, done: false } : { say: scripted.say ?? '', done: false, attach: scripted.attach };
      else
        for (let attempt = 0; attempt < 2; attempt++) {
          if (meter.stopped) break;
          const response = await deps.customer(goal.persona, history, attempt === 1);
          meter.add({
            side: 'customer',
            model: deps.customerModel,
            ...response.tokens,
            cny: deps.price(deps.customerModel, response.tokens),
          });
          customer = customerMessage(response.raw);
          run.customerAttempts.push({ raw: response.raw, valid: customer !== null, turn, retry: attempt === 1 });
          if (customer || meter.stopped) break;
        }
      if (meter.stopped) break;
      if (!customer) {
        run.status = 'customer_protocol';
        run.endedBy = 'customer_protocol';
        run.reasons.push('customer_protocol');
        break;
      }
      // done=true 的非空 say 仍是最后一条客户消息；空 say 只表达结束，不调引擎。
      // 附件轮（12 R13）：有 say 就先发这句文字，再发文件，各是一轮；客户模型的历史里记引擎收到的占位
      const attach = 'attach' in customer ? customer.attach : undefined;
      const messages: { say: string; done: boolean; attach?: string }[] = attach
        ? [...(customer.say.trim() ? [{ say: customer.say, done: false }] : []), { say: '', done: customer.done, attach }]
        : customer.say.trim()
          ? [customer]
          : [];
      if (goal.journey && customer.done && !messages.length) run.leftSilently = true;
      for (const message of messages) {
        let result: SimTurn;
        try {
          result = await deps.sales(id, message);
        } catch (e) {
          if (goal.journey && e instanceof Error && 'failedTurn' in e) run.failedTurn = (e as SalesTurnError).failedTurn;
          throw e;
        }
        run.turns.push(result);
        run.turnMetrics.push(turnMetric(result));
        history.push({ role: 'assistant', content: result.customer.say });
        if (!result.silent) history.push({ role: 'user', content: result.reply });
        if (goal.journey) {
          latest = result.state;
          run.finalState = latest;
          if (latest.handedOver) {
            run.endedBy = 'handoff';
            break turns;
          }
          for (const order of latest.orders) {
            if (
              !goal.journey.approver ||
              !('v' in order) ||
              order.status !== 'pending_payment' ||
              order.approval?.state !== 'pending' ||
              run.decided!.some((d) => d.orderId === order.id)
            )
              continue;
            if (!deps.decide) throw new Error('decide_missing');
            const decision = await deps.decide(order.id, goal.journey.approver);
            run.decided!.push({ orderId: order.id, decision: goal.journey.approver.decision });
            latest = decision.state;
            run.finalState = latest;
            if (decision.notice !== null) {
              run.notices!.push(decision.notice);
              history.push({ role: 'user', content: decision.notice });
            }
            if (latest.handedOver) {
              run.endedBy = 'handoff';
              break turns;
            }
          }
        }
      }
      if (meter.stopped) break;
      if (customer.done) {
        run.endedBy = 'done';
        break;
      }
    }
  } catch (e) {
    run.endedBy = 'runner_error';
    if (goal.journey && e instanceof Error && e.message === 'customer_http') {
      run.status = 'customer_http';
      if ('detail' in e) run.customerHttp = String(e.detail);
    }
    // 错误消息可能含供应商地址或凭据，只保留稳定原因。
    run.reasons.push(e instanceof Error && e.message === 'accounting_usage_missing' ? 'accounting_usage_missing' : 'runner_error');
  } finally {
    await deps.end(id);
  }
  if (goal.journey) {
    if (meter.stopped) {
      run.status = 'budget_stop';
      run.endedBy = 'budget_stop';
    }
    run.findings = auditRun(run, goal, deps.catalog ?? []);
    Object.assign(run, judgeJourney(goal, run));
    run.charges = meter.charges.slice(chargeStart);
    return run;
  }
  run.verdicts = judge(goal, run);
  if (meter.stopped) {
    run.status = 'budget_stop';
    run.endedBy = 'budget_stop';
    run.reasons = ['budget_stop'];
  } else if (run.status !== 'customer_protocol') {
    run.reasons.push(...run.verdicts.filter((v) => !v.passed).map((v) => `${v.check}: ${v.detail}`));
    run.status = run.reasons.length ? 'failed' : 'passed';
  }
  run.charges = meter.charges.slice(chargeStart);
  return run;
}

/** 07 R9：没给 --config-dir 时品牌只能是 legacy fixture；给了就由目录里有没有 brand.json 决定。 */
function checkBrands(goals: SimGoal[], deps: SimDeps): void {
  if (deps.configDir !== undefined) return;
  for (const goal of goals) {
    if (goal.brand !== undefined && goal.brand !== 'legacy') throw new Error(`${goal.id}: brand: 目前只能使用 legacy fixture`);
  }
}

/** 08 R11：运行时只装载一个包，目标的 pack（缺省 travel）必须是它；拒绝得早，不让旅游目标在别的包上白跑。 */
function checkPacks(goals: SimGoal[], deps: SimDeps): void {
  if (deps.pack === undefined) return;
  for (const goal of goals) {
    if (goalPack(goal) !== deps.pack) throw new Error(`${goal.id}: pack: 目标是「${goalPack(goal)}」的，运行时装载的是「${deps.pack}」`);
  }
}

/** 一遍：客户模型没按协议出话，整遍重跑一次，两次的费用并进同一遍。 */
async function runOnce(goal: SimGoal, repetition: number, meter: Meter, deps: SimDeps, runId?: string): Promise<RunResult> {
  const chargeStart = meter.charges.length;
  let run = await executeRun(goal, repetition, meter, deps, runId);
  // 客户模型没按协议出话：整遍重跑一次，仍失败的不计入 pass^k 的分母，单列
  if (run.status === 'customer_protocol' && !meter.stopped) {
    const replaced = run;
    if (goal.journey) {
      replaced.wasReplaced = true;
      replaced.findings = auditRun(replaced, goal, deps.catalog ?? []);
    }
    run = await executeRun(goal, repetition, meter, deps, runId);
    if (goal.journey) run.replaced = replaced;
    run.rerun = true;
    run.charges = meter.charges.slice(chargeStart);
  }
  return run;
}

export interface SimOptions {
  runId?: string;
  onRun?(run: RunResult): Promise<void> | void;
  resume?: { completed: Set<string>; charges: Charge[]; runs?: RunResult[] };
}
export async function simulate(goals: SimGoal[], k: number, meter: Meter, deps: SimDeps, options: SimOptions = {}): Promise<SimReport> {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k 必须是正整数');
  const runs: RunResult[] = [...(options.resume?.runs ?? [])];
  if (options.resume) meter.restore(options.resume.charges);
  checkBrands(goals, deps);
  checkPacks(goals, deps);
  outer: for (const goal of goals)
    for (let repetition = 1; repetition <= k; repetition++) {
      if (options.resume?.completed.has(JSON.stringify([goal.id, repetition]))) continue;
      if (meter.stopped) break outer;
      const run = await runOnce(goal, repetition, meter, deps, options.runId);
      runs.push(run);
      await options.onRun?.(run);
      if (meter.stopped) break outer;
    }
  const summary = goals.map((g) => {
    const group = runs.filter((r) => r.goalId === g.id);
    const n = (s: RunStatus): number => group.filter((r) => r.status === s).length;
    const denominator = k - n('customer_protocol') - (g.journey ? n('customer_http') + n('customer_drift') : 0);
    return {
      id: g.id,
      passed: n('passed'),
      failed: n('failed'),
      customer_protocol: n('customer_protocol'),
      ...(g.journey ? { customer_http: n('customer_http'), customer_drift: n('customer_drift') } : {}),
      budget_stop: n('budget_stop'),
      unrun: k - group.length,
      denominator,
      needsScriptFix: n('customer_protocol') / k > 0.2,
      passK: denominator > 0 && n('passed') === denominator,
    };
  });
  return {
    k,
    budget: meter.budget,
    runs,
    summary,
    customer_protocol: runs.filter((r) => r.status === 'customer_protocol').length,
    ...(goals.some((g) => g.journey)
      ? {
          customer_http: runs.filter((r) => r.status === 'customer_http').length,
          customer_drift: runs.filter((r) => r.status === 'customer_drift').length,
        }
      : {}),
    budget_stop: runs.filter((r) => r.status === 'budget_stop').length,
    cost: meter.totals(),
    charges: meter.charges,
    metrics: computeMetrics(goals, runs, summary, meter.total),
  };
}

// ---- 发布闸的判定（07 R8）：每个目标先跑 1 遍，不过再重跑，最多再 rerun 遍 ----
export type GateResult = 'pass' | 'flaky' | 'fail' | 'skipped_budget';
export interface GateAttempt {
  pass: boolean;
  /** 没过的原因（检查名: 详情），每条截到 GATE_FAILURE_MAX 个字符；过了是空数组 */
  failures: string[];
  turns: number;
  /** 这一遍的费用，千分之一元，取整 */
  costMilli: number;
}
export interface GateGoalResult {
  id: string;
  tags: string[];
  attempts: GateAttempt[];
  result: GateResult;
}
export const GATE_FAILURE_MAX = 240;
const milli = (cny: number): number => Math.round(cny * 1000);
const clip = (text: string): string => (text.length > GATE_FAILURE_MAX ? `${text.slice(0, GATE_FAILURE_MAX - 1)}…` : text);

function attemptOf(run: RunResult): GateAttempt {
  const pass = run.status === 'passed';
  return {
    pass,
    failures: pass ? [] : run.reasons.map(clip),
    turns: run.turns.length,
    costMilli: milli(run.charges.reduce((sum, c) => sum + c.cny, 0)),
  };
}

/**
 * 第 1 遍过是 pass；重跑里有一遍过是 flaky；1 + rerun 遍都不过是 fail；
 * 预算用完没跑到、或跑到一半被预算截断而还没有一遍通过的，是 skipped_budget（没有结论，不算 fail）。
 * 客户模型两次都没按协议出话的一遍（06 R2 不计入分母）不算销售侧失败：failures 里照实留 customer_protocol、pass 为 false，
 * 但没有一遍真正通过、又至少有一遍只是协议失败的目标记 flaky（列出来、不拦发布）；fail 只给「每一遍都是真正的失败」。
 */
export async function runGateGoal(
  goal: SimGoal,
  rerun: number,
  meter: Meter,
  deps: SimDeps,
): Promise<{ result: GateGoalResult; runs: RunResult[] }> {
  const runs: RunResult[] = [];
  for (let n = 1; n <= rerun + 1 && !meter.stopped; n++) {
    const run = await runOnce(goal, n, meter, deps);
    runs.push(run);
    if (run.status === 'passed' || run.status === 'budget_stop') break;
  }
  const attempts = runs.map(attemptOf);
  const firstPass = attempts.findIndex((a) => a.pass);
  const result: GateResult =
    firstPass === 0
      ? 'pass'
      : firstPass > 0
        ? 'flaky'
        : runs.length !== rerun + 1 || runs.some((r) => r.status === 'budget_stop')
          ? 'skipped_budget'
          : runs.some((r) => r.status === 'customer_protocol')
            ? 'flaky'
            : 'fail';
  return { result: { id: goal.id, tags: goal.tags ?? [], attempts, result }, runs };
}

export interface GateProgress {
  /** 已有结论的目标数（含因预算没跑到的） */
  done: number;
  total: number;
  /** 到现在为止花的钱，千分之一元（含不属于任何一遍的零星调用） */
  spentMilli: number;
}
export interface GateReport {
  rerun: number;
  budget: number;
  results: GateGoalResult[];
  runs: RunResult[];
  /** 有目标因预算没跑完（skipped_budget） */
  budgetStopped: boolean;
  cost: ReturnType<Meter['totals']>;
  charges: Charge[];
}
export async function simulateGate(
  goals: SimGoal[],
  rerun: number,
  meter: Meter,
  deps: SimDeps,
  onGoal?: (result: GateGoalResult, progress: GateProgress) => Promise<void> | void,
): Promise<GateReport> {
  if (!Number.isSafeInteger(rerun) || rerun < 0) throw new Error('--rerun 必须是非负整数');
  checkBrands(goals, deps);
  checkPacks(goals, deps);
  const results: GateGoalResult[] = [];
  const runs: RunResult[] = [];
  for (const goal of goals) {
    // 预算到点之后 runGateGoal 不再开始新的一遍，照样逐个记一行 skipped_budget，父进程的进度才走得满
    const one = await runGateGoal(goal, rerun, meter, deps);
    results.push(one.result);
    runs.push(...one.runs);
    await onGoal?.(one.result, { done: results.length, total: goals.length, spentMilli: milli(meter.total) });
  }
  return {
    rerun,
    budget: meter.budget,
    results,
    runs,
    budgetStopped: results.some((r) => r.result === 'skipped_budget'),
    cost: meter.totals(),
    charges: meter.charges,
  };
}

/** 按模型汇总的用量（父进程据此写 usage_daily 的 gate 行）。 */
export interface ModelUsage {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costMilli: number;
}
export function usageByModel(charges: Charge[]): ModelUsage[] {
  const rows = new Map<string, Omit<ModelUsage, 'costMilli'> & { cny: number }>();
  for (const c of charges) {
    const row = rows.get(c.model) ?? {
      model: c.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      cny: 0,
    };
    row.calls++;
    row.promptTokens += c.promptTokens;
    row.completionTokens += c.completionTokens;
    row.cachedTokens += c.cachedTokens;
    row.reasoningTokens += c.reasoningTokens;
    row.cny += c.cny;
    rows.set(c.model, row);
  }
  return [...rows.values()]
    .toSorted((a, b) => a.model.localeCompare(b.model))
    .map(({ cny, ...row }) => ({ ...row, costMilli: milli(cny) }));
}

export function gateTable(report: GateReport): string {
  const mark: Record<GateResult, string> = { pass: '通过', flaky: '不稳', fail: '失败', skipped_budget: '没跑完（预算）' };
  return [
    '目标 | 结果 | 遍数 | 没过的原因（最后一遍）',
    ...report.results.map((r) => `${r.id} | ${mark[r.result]} | ${r.attempts.length} | ${r.attempts.at(-1)?.failures.join('；') || '-'}`),
    `通过 ${report.results.filter((r) => r.result === 'pass').length} / 不稳 ${report.results.filter((r) => r.result === 'flaky').length} / 失败 ${report.results.filter((r) => r.result === 'fail').length} / 没跑完 ${report.results.filter((r) => r.result === 'skipped_budget').length}`,
    `客户 ¥${report.cost.customer.toFixed(6)} + 销售 ¥${report.cost.sales.toFixed(6)} = ¥${report.cost.total.toFixed(6)}（上限 ¥${report.budget}）`,
  ].join('\n');
}

const pct = (v: number | null): string => (v === null ? '无数据' : `${(v * 100).toFixed(1)}%`);

export function summaryTable(report: SimReport): string {
  const m = report.metrics;
  const journey = report.customer_http !== undefined;
  return [
    `目标 | 通过/分母 | 引擎/运行失败 | customer_protocol${journey ? ' | customer_http | customer_drift' : ''} | 预算停止 | 未运行 | pass^${report.k}`,
    ...report.summary.map(
      (s) =>
        `${s.id} | ${s.passed}/${s.denominator} | ${s.failed} | ${s.customer_protocol}${journey ? ` | ${s.customer_http ?? 0} | ${s.customer_drift ?? 0}` : ''} | ${s.budget_stop} | ${s.unrun} | ${s.passK ? 'PASS' : '未通过'}${s.needsScriptFix ? ' （客户脚本要改）' : ''}`,
    ),
    `pass^${report.k}: ${m.passK.passed}/${m.passK.goals} 个目标; safety k/k: ${m.safety.allKofK}/${m.safety.goals}`,
    `shape 达标: ${m.shape.within}/${m.shape.total} (${pct(m.shape.share)})`,
    `报价轮 ${m.quote.turns} 个: 微调 ${m.quote.fineTune} 次; 「这是起价」 ${m.quote.fromPrice} 次; 只剩「起价」的项目符号行 ${m.quote.fromOnlyBullets} 处`,
    `耗时: 超 8 秒 ${m.latency.over8s}/${m.latency.turns} (${pct(m.latency.over8sShare)}); 整轮 p90 ${m.latency.p90Ms ?? '无数据'} ms; 重写触发率 ${pct(m.rewrite.rate)}`,
    `客户 ¥${report.cost.customer.toFixed(6)} + 销售 ¥${report.cost.sales.toFixed(6)} = ¥${report.cost.total.toFixed(6)}`,
    `customer_protocol=${report.customer_protocol}${journey ? `; customer_http=${report.customer_http}; customer_drift=${report.customer_drift}` : ''}; budget_stop=${report.budget_stop}`,
  ].join('\n');
}
