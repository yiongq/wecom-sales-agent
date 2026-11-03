// 16 的数据格式，字段定义见 docs/architecture/16-industrial-sim/contracts.md。
import type { Finding, RuleId } from './audit.js';

export interface Trees {
  evalSim: string;
  fixtures: string;
  packData: string;
  src: string;
}
/** docs/reports/industrial-sim/freeze.json */
export interface Freeze {
  commit: string;
  trees: Trees;
}
export type RunKind = 'pilot' | 'dev' | 'main' | 'customer_swap';
/** journal 第一行 { type: 'head', meta: RunMeta }，之后每遍 { type: 'run', run: RunResult } */
export interface RunMeta {
  runId: string;
  /** 实际运行的提交 */
  head: string;
  /** 留出集运行时取 freeze.json 的提交号 */
  freezeCommit: string | null;
  trees: Trees;
  kind: RunKind;
  /** 真实时钟 */
  startedAt: string;
  salesModel: string;
  hedgeModel: string | null;
  hedgeMs: number | null;
  customerModel: string;
  k: number;
  budget: number;
  promptHash: string;
  policyHash: string;
  pricesCheckedAt: string;
}
/** docs/reports/industrial-sim/ledger.jsonl，公开格式 */
export interface LedgerLine {
  event: 'start' | 'end';
  runId: string;
  kind: RunKind;
  /** 真实时钟 */
  at: string;
  /** --prepare 时的提交 */
  commit: string;
  trees: Trees;
  salesModel: string;
  customerModel: string;
  k: number;
  budget: number;
  reason?: string;
  // 以下只在 end 行，都是裁定前
  passed?: number;
  failed?: number;
  excluded?: number;
  spentMilli?: number;
}
/** docs/reports/industrial-sim/<日期>/review.json */
export interface ReviewFile {
  causes: { goalId: string; repetition: number; cause: 'product' | 'simulator' | 'judge' | 'interface'; note: string }[];
  verdicts: { findingId: string; verdict: 'confirmed' | 'false_positive'; reason: string; by: string }[];
  personaChecks: { goalId: string; repetition: number; errors: string[]; blocksTask: boolean }[];
  revisions: { what: string; before: string; after: string; reason: string; approvedBy: string }[];
  /** 中止的运行及原因 */
  aborts: { runId: string; reason: string }[];
}
export interface Interval {
  low: number;
  high: number;
}
/** summary.json 就是 JourneyReport 序列化 */
export interface JourneyReport {
  meta: RunMeta;
  /** 正式、仿真不稳、未跑完 */
  status: 'formal' | 'unstable' | 'incomplete';
  /** 第几次 main */
  attempt: number;
  scenes: { id: string; family: string; passed: number; total: number; excluded: number; voided: boolean }[];
  success: { rate: number; conservative: number; withoutModelFree: number; byRuns: Interval; byScenes: Interval; passK: number };
  funnel: { quoted: number; built: number; approved: number; accepted: number };
  buckets: Record<string, number>;
  rules: { rule: RuleId; level: 'code' | 'suspect'; draftHits: number; finalHits: number; confirmed: number; falsePositive: number }[];
  zeroUpper: { byRuns: number; byScenes: number } | null;
  handoffMatrix: { expectedYes: { yes: number; no: number }; expectedNo: { yes: number; no: number } };
  guards: { guard: string; turns: number }[];
  /** 代码改写过的轮数（一轮多个护栏算一次） */
  rewrittenTurns: number;
  latency: { samples: number; p50: number; p90: number; p95: number; max: number; over8sShare: number; deterministicTurns: number };
  cost: { salesPerRun: number; customerPerRun: number; salesPerAccepted: number | null; cacheHitRate: number };
  swap: { customerModel: string; rate: number; byScenes: Interval; suspects: number; valid: boolean } | null;
  dev: { rate: number; runs: number } | null;
  personaChecks: { sampled: number; withErrors: number; blocksTask: number };
  causes: ReviewFile['causes'];
  findings: (Finding & { verdict: 'confirmed' | 'false_positive' | null; reason: string | null })[];
  aborts: ReviewFile['aborts'];
  ledger: LedgerLine[];
  revisions: ReviewFile['revisions'];
}
