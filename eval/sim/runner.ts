import type { UsageEvent } from '../../src/usage.js';
import type { SimGoal } from './goals.js';
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
  constructor(readonly budget: number) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget 必须是正数');
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
  price(model: string, tokens: Tokens): number;
  start(initial?: SimGoal['initial']): { id: string; initial: Snapshot };
  sales(id: string, customer: { say: string; done: boolean }): Promise<SimTurn>;
  end(id: string): Promise<void>;
}
export type RunStatus = 'passed' | 'failed' | 'customer_protocol' | 'budget_stop';
export interface RunResult extends Evidence {
  goalId: string;
  repetition: number;
  status: RunStatus;
  endedBy: 'done' | 'maxTurns' | 'customer_protocol' | 'budget_stop' | 'runner_error';
  verdicts: Verdict[];
  reasons: string[];
  customerAttempts: { raw: string; valid: boolean; turn: number; retry: boolean }[];
  charges: Charge[];
  /** 每轮的耗时、本轮工具、形状（与 turns 一一对应） */
  turnMetrics: TurnMetric[];
  /** 第一遍客户没按协议出话，这是整遍重跑后的结果 */
  rerun: boolean;
}
export interface Summary {
  id: string;
  passed: number;
  failed: number;
  customer_protocol: number;
  budget_stop: number;
  unrun: number;
  /** pass^k 的分母：k 减去两遍都没按协议出话的运行 */
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

async function executeRun(goal: SimGoal, repetition: number, meter: Meter, deps: SimDeps): Promise<RunResult> {
  const chargeStart = meter.charges.length;
  const { id, initial } = deps.start(goal.initial);
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
  };
  // 客户模型的视角：它自己说的是 assistant，销售的回复是 user
  const history: { role: 'user' | 'assistant'; content: string }[] = (goal.initial?.history ?? []).map((m) => ({
    role: m.role === 'customer' ? 'assistant' : 'user',
    content: m.content,
  }));
  try {
    for (let turn = 1; turn <= (goal.maxTurns ?? 12); turn++) {
      let customer: ReturnType<typeof customerMessage> = null;
      const scripted = goal.customerScript?.[turn - 1];
      if (scripted !== undefined) customer = { say: scripted, done: false };
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
      if (customer.say.trim()) {
        const result = await deps.sales(id, customer);
        run.turns.push(result);
        run.turnMetrics.push(turnMetric(result));
        history.push({ role: 'assistant', content: customer.say });
        if (!result.silent) history.push({ role: 'user', content: result.reply });
      }
      if (meter.stopped) break;
      if (customer.done) {
        run.endedBy = 'done';
        break;
      }
    }
  } catch (e) {
    run.endedBy = 'runner_error';
    // 错误消息可能含供应商地址或凭据，只保留稳定原因。
    run.reasons.push(e instanceof Error && e.message === 'accounting_usage_missing' ? 'accounting_usage_missing' : 'runner_error');
  } finally {
    await deps.end(id);
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

export async function simulate(goals: SimGoal[], k: number, meter: Meter, deps: SimDeps): Promise<SimReport> {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k 必须是正整数');
  const runs: RunResult[] = [];
  for (const goal of goals) {
    if (goal.brand !== undefined && goal.brand !== 'legacy') throw new Error(`${goal.id}: brand: 目前只能使用 legacy fixture`);
  }
  outer: for (const goal of goals)
    for (let repetition = 1; repetition <= k; repetition++) {
      if (meter.stopped) break outer;
      const chargeStart = meter.charges.length;
      let run = await executeRun(goal, repetition, meter, deps);
      // 客户模型没按协议出话：整遍重跑一次，仍失败的不计入 pass^k 的分母，单列
      if (run.status === 'customer_protocol' && !meter.stopped) {
        run = await executeRun(goal, repetition, meter, deps);
        run.rerun = true;
        run.charges = meter.charges.slice(chargeStart);
      }
      runs.push(run);
      if (meter.stopped) break outer;
    }
  const summary = goals.map((g) => {
    const group = runs.filter((r) => r.goalId === g.id);
    const n = (s: RunStatus): number => group.filter((r) => r.status === s).length;
    const denominator = k - n('customer_protocol');
    return {
      id: g.id,
      passed: n('passed'),
      failed: n('failed'),
      customer_protocol: n('customer_protocol'),
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
    budget_stop: runs.filter((r) => r.status === 'budget_stop').length,
    cost: meter.totals(),
    charges: meter.charges,
    metrics: computeMetrics(goals, runs, summary, meter.total),
  };
}

const pct = (v: number | null): string => (v === null ? '无数据' : `${(v * 100).toFixed(1)}%`);

export function summaryTable(report: SimReport): string {
  const m = report.metrics;
  return [
    `目标 | 通过/分母 | 引擎/运行失败 | customer_protocol | 预算停止 | 未运行 | pass^${report.k}`,
    ...report.summary.map(
      (s) =>
        `${s.id} | ${s.passed}/${s.denominator} | ${s.failed} | ${s.customer_protocol} | ${s.budget_stop} | ${s.unrun} | ${s.passK ? 'PASS' : '未通过'}${s.needsScriptFix ? ' （客户脚本要改）' : ''}`,
    ),
    `pass^${report.k}: ${m.passK.passed}/${m.passK.goals} 个目标; safety k/k: ${m.safety.allKofK}/${m.safety.goals}`,
    `shape 达标: ${m.shape.within}/${m.shape.total} (${pct(m.shape.share)})`,
    `报价轮 ${m.quote.turns} 个: 微调 ${m.quote.fineTune} 次; 「这是起价」 ${m.quote.fromPrice} 次; 只剩「起价」的项目符号行 ${m.quote.fromOnlyBullets} 处`,
    `耗时: 超 8 秒 ${m.latency.over8s}/${m.latency.turns} (${pct(m.latency.over8sShare)}); 整轮 p90 ${m.latency.p90Ms ?? '无数据'} ms; 重写触发率 ${pct(m.rewrite.rate)}`,
    `客户 ¥${report.cost.customer.toFixed(6)} + 销售 ¥${report.cost.sales.toFixed(6)} = ¥${report.cost.total.toFixed(6)}`,
    `customer_protocol=${report.customer_protocol}; budget_stop=${report.budget_stop}`,
  ].join('\n');
}
