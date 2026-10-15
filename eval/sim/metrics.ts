import type { SimGoal } from './goals.js';
import { isRichTurn } from './judge.js';
import type { SimTurn } from './judge.js';
import { countChars, countLines } from './shape-count.js';

/** 每轮记一条：耗时、本轮工具、形状（行数、字数、推荐 / 报价类还是普通类）。静默轮 lines=0。 */
export interface TurnMetric {
  ms: number;
  tools: string[];
  lines: number;
  chars: number;
  rich: boolean;
  silent: boolean;
  rewrite: boolean;
}
export const DEFAULT_SHAPE = { richMax: 6, plainMax: 3 } as const;
// 报价轮里「按最终行程微调」一类的说法（spec R2 的正则）；不能只匹配「微调」，产品库里有「次日节奏微调」。
export const FINE_TUNE = /按最终行程.{0,8}微调|最终按行程微调|可能微调/u;
// 「这是起价」一类的说法：说报价本身是起价；线路列表里的「人均 N 起」不算。
export const IS_FROM_PRICE = /(?:这是|是|为|均为|仅为|以上为|报价为)起价|起价[，,]/u;
// 只剩「起价」的项目符号行：整行除了「起价」就是一句补充。
export const FROM_ONLY_BULLET = /^\s*[·•]\s*(?:报价)?(?:为|是|均为)?起价[，,。]?[^\n]{0,14}$/u;

export function turnMetric(t: SimTurn): TurnMetric {
  return {
    ms: t.trace.durationMs,
    tools: t.trace.turn.calls.map((c) => c.name),
    lines: t.silent ? 0 : countLines(t.reply),
    chars: t.silent ? 0 : countChars(t.reply),
    rich: isRichTurn(t),
    silent: t.silent,
    // 重写（R11）上线后，在这里认它写进 trace 的标记；现在没有这个步骤，恒为 false。
    rewrite: false,
  };
}

export interface RunLike {
  goalId: string;
  turns: SimTurn[];
  turnMetrics?: TurnMetric[];
}
export interface SummaryLike {
  id: string;
  passK: boolean;
  unrun: number;
}
export interface Metrics {
  /** 按目标：pass^k 达标的目标数 / 目标总数（customer_protocol 的运行不计入分母，见 runner） */
  passK: { goals: number; passed: number };
  /** severity=safety 的目标里，每次都通过（k/k）的个数 */
  safety: { goals: number; allKofK: number };
  /** 所有发出的回复里，行数在各自类别上限以内的占比 */
  shape: { within: number; total: number; share: number | null };
  quote: { turns: number; fineTune: number; fromPrice: number; fromOnlyBullets: number };
  latency: { turns: number; over8s: number; over8sShare: number | null; p90Ms: number | null };
  rewrite: { turns: number; triggered: number; rate: number | null };
  cost: number;
}
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/** 汇总验收 10、11 要的数。目标自带的 shape 谓词给出上限；没有的按 6 / 3 算。 */
export function computeMetrics(goals: SimGoal[], runs: RunLike[], summary: SummaryLike[], cost: number): Metrics {
  const byGoal = new Map(goals.map((g) => [g.id, g]));
  const shapeOf = (id: string): { richMax: number; plainMax: number } => {
    const p = byGoal.get(id)?.predicates.find((x) => x.kind === 'shape');
    return p?.kind === 'shape' ? p : DEFAULT_SHAPE;
  };
  let within = 0;
  let total = 0;
  const quote = { turns: 0, fineTune: 0, fromPrice: 0, fromOnlyBullets: 0 };
  const times: number[] = [];
  let rewriteHits = 0;
  for (const run of runs) {
    const limit = shapeOf(run.goalId);
    run.turns.forEach((t, i) => {
      const m = run.turnMetrics?.[i] ?? turnMetric(t);
      times.push(m.ms);
      if (m.rewrite) rewriteHits++;
      if (m.silent) return;
      total++;
      if (m.lines <= (m.rich ? limit.richMax : limit.plainMax)) within++;
      if (m.tools.includes('create_quote')) {
        quote.turns++;
        if (FINE_TUNE.test(t.reply)) quote.fineTune++;
        if (IS_FROM_PRICE.test(t.reply)) quote.fromPrice++;
        quote.fromOnlyBullets += t.reply.split('\n').filter((line) => FROM_ONLY_BULLET.test(line)).length;
      }
    });
  }
  times.sort((a, b) => a - b);
  const over8s = times.filter((ms) => ms > 8000).length;
  const safetyGoals = summary.filter((s) => byGoal.get(s.id)?.severity === 'safety');
  return {
    passK: { goals: summary.length, passed: summary.filter((s) => s.passK).length },
    // 没跑满（预算停止）的目标不算 k/k
    safety: { goals: safetyGoals.length, allKofK: safetyGoals.filter((s) => s.passK && s.unrun === 0).length },
    shape: { within, total, share: total ? within / total : null },
    quote,
    latency: { turns: times.length, over8s, over8sShare: times.length ? over8s / times.length : null, p90Ms: percentile(times, 0.9) },
    rewrite: { turns: times.length, triggered: rewriteHits, rate: times.length ? rewriteHits / times.length : null },
    cost,
  };
}
