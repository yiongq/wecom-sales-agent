# 16 · 数据格式

配套 [spec.md](./spec.md)，只展开它引用到的字段，不定行为，不记进度。和 spec 冲突时以 spec 为准。这些文件都在公开仓库里，不放定价、毛利和市场判断。

```ts
interface Trees {
  evalSim: string;
  fixtures: string;
  packData: string;
  src: string;
}
// docs/reports/industrial-sim/freeze.json
interface Freeze {
  commit: string;
  trees: Trees;
}
// journal：第一行 { type: 'head', meta: RunMeta }，之后每遍 { type: 'run', run: RunResult }
interface RunMeta {
  runId: string;
  head: string; // 实际运行的提交
  freezeCommit: string | null; // 留出集运行时取 freeze.json 的提交号
  trees: Trees;
  kind: 'pilot' | 'dev' | 'main' | 'customer_swap';
  startedAt: string; // 真实时钟
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
// docs/reports/industrial-sim/ledger.jsonl，公开格式
interface LedgerLine {
  event: 'start' | 'end';
  runId: string;
  kind: RunMeta['kind'];
  at: string; // 真实时钟
  commit: string; // --prepare 时的提交
  trees: Trees;
  salesModel: string;
  customerModel: string;
  k: number;
  budget: number;
  reason?: string;
  passed?: number; // 以下只在 end 行，都是裁定前
  failed?: number;
  excluded?: number;
  spentMilli?: number;
}
// docs/reports/industrial-sim/<日期>/review.json
interface ReviewFile {
  causes: { goalId: string; repetition: number; cause: 'product' | 'simulator' | 'judge' | 'interface'; note: string }[];
  verdicts: { findingId: string; verdict: 'confirmed' | 'false_positive'; reason: string; by: string }[];
  personaChecks: { goalId: string; repetition: number; errors: string[]; blocksTask: boolean }[];
  revisions: { what: string; before: string; after: string; reason: string; approvedBy: string }[];
  aborts: { runId: string; reason: string }[]; // 中止的运行及原因
}
// summary.json 就是 JourneyReport 序列化
interface JourneyReport {
  meta: RunMeta;
  status: 'formal' | 'unstable' | 'incomplete'; // 正式、仿真不稳、未跑完
  attempt: number; // 第几次 main
  scenes: { id: string; family: string; passed: number; total: number; excluded: number; voided: boolean }[];
  success: { rate: number; conservative: number; withoutModelFree: number; byRuns: Interval; byScenes: Interval; passK: number };
  funnel: { quoted: number; built: number; approved: number; accepted: number };
  buckets: Record<string, number>;
  rules: { rule: RuleId; level: 'code' | 'suspect'; draftHits: number; finalHits: number; confirmed: number; falsePositive: number }[];
  zeroUpper: { byRuns: number; byScenes: number } | null;
  handoffMatrix: { expectedYes: { yes: number; no: number }; expectedNo: { yes: number; no: number } };
  guards: { guard: string; turns: number }[];
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
```
