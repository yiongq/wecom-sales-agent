// 「客户停在哪一步」的阶段条（设计系统 §6.7）：总览（A 页）与会话列表（I 页）共用同一份行。
// 单放一个文件、只依赖行业包的类型：两页各自懒加载，共用的只有这一小块
import type { IndustryPack } from '../../../src/shared/pack.js';

export interface StageRow {
  /** 行业包的阶段 key；null 是包里没有的阶段合在一起的「其他」，不能点 */
  key: string | null;
  label: string;
  count: number;
  /** 分支阶段（如异议）缩进 8 */
  branch: boolean;
  /** 条长：占最大值的比例，0–1 */
  ratio: number;
}

/**
 * AI 接待中的会话按当前阶段计数（counts 的 aiByStage），阶段名和顺序来自行业包，不含终态；分支阶段排在它的主阶段后面。
 * 包里没有的阶段（换过包、老数据）合成一行「其他」，各行之和仍等于 AI 接待中的数（验收 6 的「阶段条合计 10」）
 */
export function stageRows(pack: IndustryPack, aiByStage: Readonly<Record<string, number>>): StageRow[] {
  const live = pack.stages.filter((s) => !s.terminal);
  const mains = live.filter((s) => !s.branchOf || !live.some((m) => m.key === s.branchOf && !m.branchOf));
  const ordered = mains.flatMap((m) => [m, ...live.filter((s) => s.branchOf === m.key && s !== m && !mains.includes(s))]);
  const countOf = (k: string): number => (Object.hasOwn(aiByStage, k) ? (aiByStage[k] ?? 0) : 0);
  const rows = ordered.map((s) => ({ key: s.key as string | null, label: s.label, count: countOf(s.key), branch: !mains.includes(s) }));
  const known = new Set(ordered.map((s) => s.key));
  const other = Object.entries(aiByStage).reduce((n, [k, v]) => (known.has(k) ? n : n + v), 0);
  if (other > 0) rows.push({ key: null, label: '其他', count: other, branch: false });
  const max = Math.max(0, ...rows.map((r) => r.count));
  return rows.map((r) => ({ ...r, ratio: max ? r.count / max : 0 }));
}
