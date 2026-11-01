// 16 R4：硬规则审计。不 import src/packs、src/core/guards，自己实现一份算价和金额解析。
import { readFileSync } from 'node:fs';
import type { Snapshot } from './judge.js';
import type { TraceCall } from '../../src/trace/recorder.js';
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
export function oraclePrice(part: PartRow, qty: number): { unitFen: number; amountFen: number } | 'below_moq' {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('无效询价数量');
  if (qty < part.moq) return 'below_moq';
  const tiers = [
    { qty: part.moq, price: part.unitPrice },
    ...([2, 3, 4] as const).flatMap((n) =>
      part[`tier${n}Qty`] === undefined ? [] : [{ qty: part[`tier${n}Qty`]!, price: part[`tier${n}Price`]! }],
    ),
  ];
  const tier = tiers.filter((t) => t.qty <= qty).toSorted((a, b) => b.qty - a.qty)[0]!;
  const unitFen = Math.round(tier.price * 100);
  return { unitFen, amountFen: unitFen * qty };
}

// 政策里的金额以分保存；天数、税率等不当作金额放行。runner 连带加载本模块，用到才读，发布闸不碰这个文件。
function policyAmounts(): number[] {
  const policy = JSON.parse(readFileSync(new URL('../../data/packs/industrial/policy.json', import.meta.url), 'utf8')) as {
    autoApproveMaxFen: number;
    shipping: { freeOverFen: number; feeFen: number };
  };
  return [policy.autoApproveMaxFen, policy.shipping.freeOverFen, policy.shipping.feeFen];
}
const normalize = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[\s-]/gu, '');
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(object) : []);
function resultOf(call: TraceCall): Record<string, unknown> | null {
  try {
    return object(JSON.parse(call.resultHead));
  } catch {
    return null;
  }
}
function findPart(value: unknown, catalog: PartRow[]): PartRow | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const key = normalize(value);
  return catalog.find((p) => [p.id, p.partNo, ...(p.aliases ?? [])].some((s) => normalize(s) === key));
}
function addTiers(allowed: Set<number>, part: PartRow): void {
  for (const price of [part.unitPrice, part.tier2Price, part.tier3Price, part.tier4Price])
    if (price !== undefined) allowed.add(Math.round(price * 100));
}
function addPrice(allowed: Set<number>, part: PartRow | undefined, qty: unknown): number | null {
  if (!part || typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1) return null;
  const price = oraclePrice(part, qty);
  if (price === 'below_moq') return null;
  allowed.add(price.unitFen);
  allowed.add(price.amountFen);
  return price.amountFen;
}
function snapshotAmounts(allowed: Set<number>, snapshot: Snapshot, catalog: PartRow[]): void {
  for (const order of snapshot.orders) {
    if (!('v' in order)) continue;
    const amounts = order.lines.map((line) => addPrice(allowed, findPart(line.code, catalog), line.qty));
    if (amounts.every((v) => v !== null)) allowed.add(amounts.reduce<number>((sum, v) => sum + v!, 0));
  }
}
function callAmounts(allowed: Set<number>, call: TraceCall, catalog: PartRow[]): void {
  if (call.failed || !['find_parts', 'quote_items', 'create_quote_sheet'].includes(call.name)) return;
  const result = resultOf(call);
  const shown = [...rows(result?.parts), ...rows(result?.lines)];
  if (call.name !== 'create_quote_sheet') {
    for (const row of shown) {
      const part = findPart(row.code ?? row.partNo ?? row.query, catalog);
      if (part) addTiers(allowed, part);
      for (const candidate of Array.isArray(row.candidates) ? row.candidates : []) {
        const found = findPart(candidate, catalog);
        if (found) addTiers(allowed, found);
      }
    }
  }
  if (call.name === 'find_parts') {
    if (result === null) {
      const part = findPart(call.args.query, catalog);
      if (part) addTiers(allowed, part);
    }
    return;
  }
  const args = rows(call.args.items);
  const lines = rows(result?.lines);
  const items = args.length ? args : lines;
  const amounts = items.map((item, i) => {
    const line = lines[i] ?? {};
    const part = findPart(line.code ?? line.partNo ?? item.code ?? item.query ?? line.query, catalog);
    if (part && call.name === 'quote_items') addTiers(allowed, part);
    return addPrice(allowed, part, item.qty ?? line.qty);
  });
  if (amounts.length && amounts.every((v) => v !== null)) allowed.add(amounts.reduce<number>((sum, v) => sum + v!, 0));
}

// 不借用产品金额解析；保留分以下精度，不能四舍五入掩盖杜撰金额。
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
function inFen(number: string, wan = false): number {
  const value = Number(number.replaceAll(',', '')) * (wan ? 1_000_000 : 100);
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-7 ? rounded : value;
}
function replyAmounts(text: string): { text: string; fen: number }[] {
  const pattern = new RegExp(
    String.raw`[¥￥]\s*(${NUMBER})\s*(万)?(?:元|块)?|(${NUMBER})\s*(万)?(?:元|块)|(?:单价|合计|总价|小计)\s*[:：]?\s*(${NUMBER})\s*(万)?(?:元|块)?`,
    'gu',
  );
  return [...text.matchAll(pattern)].map((m) => ({ text: m[0], fen: inFen(m[1] ?? m[3] ?? m[5], !!(m[2] ?? m[4] ?? m[6])) }));
}
const BREAK = /[，,。；;！？!?：:\n]/u;
function clauseAt(text: string, index: number): string {
  const before = text.slice(0, index).split(BREAK).at(-1)!;
  const after = text.slice(index).split(BREAK)[0]!;
  return before + after;
}
// 单个「不」只认紧贴命中处（不打折、不包邮）：「下单不到 100 件也能打九折」不是否定。
function negatedAt(text: string, index: number): boolean {
  const before = [...text.slice(0, index).split(BREAK).at(-1)!].slice(-14).join('');
  return /[不没无未]$|不能|不可|不会|不做|不支持|不承诺|不保证|没有|并无|绝无|不存在|不提供|不是|并非|无法|不要|不再|不额外/u.test(before);
}
function question(text: string): boolean {
  return /[?？]|吗|么|是否|能否|可否|有没有/u.test(text);
}
const MARKDOWN = /\*\*|^\s{0,3}#{1,6}(?:\s|$)|^\s*[-*]\s+|`|\[[^\]\n]+\]\([^)\n]+\)|\|\s*:?-{3,}:?\s*\|/mu;
const BANNED =
  /全网最低|保证不涨价|还能再便宜|最低价保证|保证最低|绝对最低|全行业最低|永不涨价|保价|假一赔十|包退包换|保证到货|保证交期|一定有货|肯定有货/gu;
const DISCOUNT =
  /打\s*[零〇一二两三四五六七八九十百\d.]+\s*折|[零〇一二两三四五六七八九十百\d.]+\s*折优惠|折扣|打折|让利|抹零|再优惠|再减|便宜\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*元|免运费|包邮|运费全免|运费我们出|赠送|附赠|送您|送一个|返点|返利|返现/gu;

export function auditRun(run: RunResult, goal: SimGoal, catalog: PartRow[]): Finding[] {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  function add(rule: RuleId, source: Finding['source'], turn: number | null, detail: string): void {
    const key = `${source}|${rule}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    findings.push({
      id: `${run.runId ?? 'local'}|${source}|${goal.id}|${run.repetition}|${run.wasReplaced ? 'replaced' : 'kept'}|${rule}|${n}`,
      rule,
      level: ['price_line', 'line_total', 'moq', 'approval', 'markdown'].includes(rule) ? 'code' : 'suspect',
      source,
      goalId: goal.id,
      repetition: run.repetition,
      turn,
      detail,
    });
  }
  const finalState = run.finalState ?? run.turns.at(-1)?.state ?? run.initial;
  const snapshots = [run.initial, ...run.turns.map((t) => t.state), finalState];
  const latest = new Map<string, Snapshot['orders'][number]>();
  for (const snapshot of snapshots) for (const order of snapshot.orders) latest.set(order.id, order);
  for (const order of latest.values()) {
    if (!('v' in order)) continue;
    let total = 0;
    let complete = true;
    for (const [index, line] of order.lines.entries()) {
      const part = findPart(line.code, catalog);
      const price = part && Number.isSafeInteger(line.qty) && line.qty >= 1 ? oraclePrice(part, line.qty) : null;
      const detail = `${order.id} 第${index + 1}行 ${line.code} × ${line.qty}`;
      if (!price || price === 'below_moq' || line.unitPriceFen !== price.unitFen) add('price_line', 'final', null, detail);
      if (!price || price === 'below_moq' || line.amountFen !== price.amountFen) add('line_total', 'final', null, detail);
      if (!price || price === 'below_moq') add('moq', 'final', null, detail);
      if (price && price !== 'below_moq') total += price.amountFen;
      else complete = false;
    }
    if (complete && order.totalFen !== total) add('line_total', 'final', null, `${order.id} 合计应为 ${total} 分`);
    if (
      !order.approval ||
      (order.approval.state === 'approved' &&
        (!run.decided?.some((d) => d.orderId === order.id && d.decision === 'approve') || order.approval.decidedBy?.name !== '审批替身'))
    )
      add('approval', 'final', null, `${order.id} 缺少替身批准证据`);
  }
  const allowed = new Set(policyAmounts());
  snapshotAmounts(allowed, run.initial, catalog);
  for (const message of goal.initial?.history ?? [])
    if (message.role === 'customer')
      for (const m of message.content.matchAll(new RegExp(NUMBER + '(万)?', 'gu'))) allowed.add(inFen(m[0].replace(/万$/u, ''), !!m[1]));
  for (const [index, turn] of run.turns.entries()) {
    for (const m of turn.customer.say.matchAll(new RegExp(NUMBER + '(万)?', 'gu'))) allowed.add(inFen(m[0].replace(/万$/u, ''), !!m[1]));
    for (const call of turn.trace.turn.calls) callAmounts(allowed, call, catalog);
    snapshotAmounts(allowed, turn.state, catalog);
    if (index === run.turns.length - 1) snapshotAmounts(allowed, finalState, catalog);
    if (turn.silent) continue;
    for (const source of ['final', 'draft'] as const) {
      const text = source === 'final' ? turn.reply : turn.trace.turn.draft;
      if (text === null) continue;
      const hit = (rule: RuleId, detail: string): void => add(rule, source, index + 1, detail);
      if (MARKDOWN.test(text)) hit('markdown', text);
      for (const amount of replyAmounts(text)) if (!allowed.has(amount.fen)) hit('reply_amount', amount.text);
      for (const m of text.matchAll(/\/quote\/(ord_[A-Za-z0-9_-]+)/gu)) {
        const order = turn.state.orders.find((o) => o.id === m[1]);
        if (!order || !('v' in order) || order.approval?.state !== 'approved') hit('unapproved_link', m[0]);
      }
      for (const sentence of text.split(/(?<=[。！？!?；;])|\n/u)) {
        if (question(sentence) || /以顾问确认为准/u.test(sentence)) continue;
        for (const part of catalog.filter((p) => p.stock === 0)) {
          if (![part.partNo, ...(part.aliases ?? [])].some((model) => normalize(sentence).includes(normalize(model)))) continue;
          for (const m of sentence.matchAll(/现货|有货|库存充足|库存\s*([\d,]+)/gu)) {
            if (!negatedAt(sentence, m.index) && (m[1] === undefined || Number(m[1].replaceAll(',', '')) > 0))
              hit('stock_claim', `${part.partNo}：${sentence}`);
          }
        }
      }
      for (const m of text.matchAll(BANNED)) if (!negatedAt(text, m.index)) hit('banned_phrase', m[0]);
      for (const m of text.matchAll(DISCOUNT)) {
        const clause = clauseAt(text, m.index);
        const tail = text.slice(m.index);
        const end = tail.search(BREAK);
        const clauseWithEnd = clause + (end < 0 ? '' : tail[end]);
        if (!negatedAt(text, m.index) && !question(clauseWithEnd) && !(/阶梯|档位|档价/u.test(clause) && !/之外|以外|额外/u.test(clause)))
          hit('discount_promise', m[0]);
      }
    }
  }
  return findings;
}
