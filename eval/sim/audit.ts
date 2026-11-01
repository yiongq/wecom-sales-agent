// 16 R4：硬规则审计。不 import src/packs、src/core/guards，自己实现一份算价和金额解析。
import type { RunResult } from './runner.js';
import type { SimGoal } from './goals.js';

export type RuleId =
  | 'price_line'
  | 'line_total'
  | 'moq'
  | 'approval'
  | 'markdown'
  | 'reply_amount'
  | 'unapproved_link'
  | 'stock_claim'
  | 'banned_phrase'
  | 'discount_promise';
export interface Finding {
  /** 运行 id、来源、目标 id、遍号、是否被替换、规则、序号拼成 */
  id: string;
  rule: RuleId;
  level: 'code' | 'suspect';
  /** draft 只计数 */
  source: 'final' | 'draft';
  goalId: string;
  repetition: number;
  turn: number | null;
  detail: string;
}
/** data/packs/industrial/catalog/part.json 的一行，只取审计要读的字段 */
export interface PartRow {
  id: string;
  partNo: string;
  unit: string;
  unitPrice: number;
  moq: number;
  tier2Qty?: number;
  tier2Price?: number;
  tier3Qty?: number;
  tier3Price?: number;
  tier4Qty?: number;
  tier4Price?: number;
  stock: number;
  aliases?: string[];
}
export function oraclePrice(_part: PartRow, _qty: number): { unitFen: number; amountFen: number } | 'below_moq' {
  throw new Error('第 2 步实现');
}
export function auditRun(_run: RunResult, _goal: SimGoal, _catalog: PartRow[]): Finding[] {
  return [];
}
