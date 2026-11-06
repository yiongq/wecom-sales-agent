// 18 R2：离线疑似坏轮检测。只读证据；不加载产品包、护栏或运行时配置。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { oraclePrice, type PartRow } from './audit.js';
import { readJournal, type Journal } from './journal.js';
import type { Snapshot } from './judge.js';
import type { RunResult } from './runner.js';
import type { TraceCall } from '../../src/trace/recorder.js';

export const DETECTORS = [
  'price_withheld',
  'correct_deleted',
  'ask_after_accept',
  'amount_not_order',
  'internal_leak',
  'choice_overridden',
  'dangling',
  'duplicate_text',
] as const;
export type DetectorId = (typeof DETECTORS)[number];
export interface TriageCandidate {
  id: string;
  detector: DetectorId;
  runId: string;
  goalId: string;
  repetition: number;
  turn: number;
  evidence: string[];
}
export interface TriageVerdict {
  id: string;
  verdict: 'confirmed' | 'false_positive';
  note: string;
}
export type TriagePart = PartRow & { leadDays?: number };
export interface TriageSummary {
  runId: string;
  status: 'recorded' | 'aborted';
  turns: number;
  detectors: Record<DetectorId, { suspects: number; per100Turns: number }>;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(object) : []);
const normalize = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[\s-]/gu, '');
const sentences = (s: string): string[] =>
  s
    .split(/(?<=[。！？!?；;])|\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
const excerpt = (s: string): string => [...s].slice(0, 200).join('');
function result(call: TraceCall): Record<string, unknown> {
  if (call.failed) return {};
  try {
    return object(JSON.parse(call.resultHead));
  } catch {
    // trace 超过 4096 字节时可能截在 JSON 中间；不猜测缺失的结果。
    return {};
  }
}
function partOf(value: unknown, catalog: TriagePart[]): TriagePart | undefined {
  return typeof value === 'string'
    ? catalog.find((p) => [p.id, p.partNo, ...(p.aliases ?? [])].some((s) => normalize(s) === normalize(value)))
    : undefined;
}
function mentioned(text: string, catalog: TriagePart[]): TriagePart[] {
  // 保留词间空格，避免把「TEST-A 20件」粘成另一个型号 TEST-A20。
  const key = text.normalize('NFKC').toUpperCase().replaceAll('-', '');
  return catalog.filter((p) =>
    [p.partNo, ...(p.aliases ?? [])].some((s) => {
      const pattern = [...normalize(s)].map((c) => c.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s*');
      return new RegExp(`(?:^|[^A-Z0-9])${pattern}(?![A-Z0-9])`, 'u').test(key);
    }),
  );
}
const quantities = (text: string): number[] => [
  ...new Set(
    [...text.matchAll(/(\d+)\s*(?:件|个|只|套|台|支|根|条|盒|米|pcs)/giu)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  ),
];
type PriceLine = { part: TriagePart; qty: number };
function priced(line: PriceLine): { unitFen: number; amountFen: number } | null {
  if (!Number.isSafeInteger(line.qty) || line.qty < 1) return null;
  const price = oraclePrice(line.part, line.qty);
  return price === 'below_moq' ? null : price;
}
function quoteLines(call: TraceCall, catalog: TriagePart[]): PriceLine[] {
  return rows(result(call).lines)
    .flatMap((row) => {
      const part = partOf(row.code ?? row.partNo ?? row.query, catalog);
      return row.match === 'exact' &&
        typeof row.unitPrice === 'number' &&
        typeof row.amount === 'number' &&
        part &&
        typeof row.qty === 'number'
        ? [{ part, qty: row.qty }]
        : [];
    })
    .filter((line) => priced(line) !== null);
}
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
interface Amount {
  text: string;
  fen: number;
  index: number;
  policy: boolean;
}
function amounts(text: string): Amount[] {
  const pattern = new RegExp(
    String.raw`[¥￥]\s*(${NUMBER})\s*(万)?(?:元|块)?|(${NUMBER})\s*(万)?(?:元|块)|(?:单价|小计|合计(?:金额)?|总价|总额|货款|应付(?:金额)?)\s*[:：]?\s*(${NUMBER})(?![\d.,])\s*(万)?(?:元|块)?(?!\s*(?:件|个|只|套|台|支|根|条|盒|米|pcs))`,
    'gu',
  );
  return [...text.matchAll(pattern)].map((m) => {
    const before = text
      .slice(0, m.index)
      .split(/[，,。；;\n（）()]/u)
      .at(-1)!;
    const after = text.slice(m.index + m[0].length).split(/[，,。；;\n]/u)[0]!;
    return {
      text: m[0],
      index: m.index,
      fen: Number((m[1] ?? m[3] ?? m[5]).replaceAll(',', '')) * ((m[2] ?? m[4] ?? m[6]) ? 1_000_000 : 100),
      policy:
        (/运费|包邮|免邮|满额|审批上限/u.test(before) || (/满\s*$/u.test(before) && /包邮|免邮|免运费/u.test(after))) &&
        !/单价|小计|合计|总价|货款|应付/u.test(before),
    };
  });
}
const sameMoney = (a: number, b: number): boolean => Math.abs(a - b) < 1e-7;
function goodsAmounts(text: string): Amount[] {
  return amounts(text).filter((a) => !a.policy);
}
function newlyAccepted(before: Snapshot, after: Snapshot): Snapshot['orders'] {
  return after.orders.filter(
    (o) =>
      'v' in o &&
      o.approval?.acceptedAt !== undefined &&
      !before.orders.some((p) => p.id === o.id && 'v' in p && p.approval?.acceptedAt === o.approval?.acceptedAt),
  );
}
function asksAgain(reply: string): boolean {
  return sentences(reply).some(
    (s) =>
      /(?:报价|订单|下单).{0,16}(?:还需要|请|需要您|待您).{0,8}确认|(?:请|麻烦|需要您).{0,5}(?:再|重新)?确认.{0,10}(?:报价|订单|采购|下单)|请(?:您)?(?:再|重新)?确认(?:一下)?[。！？!?]|请回复.{0,12}接受|(?:您可以|请|麻烦您?).{0,6}回复确认|确认下单请回复|您再.{0,20}确认|请在.{0,14}完成确认/u.test(
        s,
      ) && !/无需|不用|不必/u.test(s),
  );
}
function lostInventory(removed: string, reply: string, parts: TriagePart[]): boolean {
  if (!parts.length) return false;
  const days = [...removed.matchAll(/(\d+)\s*天/gu)].map((m) => Number(m[1]));
  const stock = [...removed.matchAll(/(?:现货|库存)\s*(\d+)\s*件/gu)].map((m) => Number(m[1]));
  // 不能凭「有效期 7 天」推断删了交期；所有明确的库存/交期事实都须与库一致。
  if (!/交期|到货|补货|其余|现货|库存/u.test(removed)) return false;
  if (days.some((d) => !parts.some((p) => p.leadDays === d)) || stock.some((n) => !parts.some((p) => p.stock === n))) return false;
  const noStock = /无现货|没现货|没有现货|无货/u.test(removed);
  const hasStock = /有现货|有货|现货\s*(?:[，。；;：:]|可发|\d|$)/u.test(removed) && !noStock;
  if (hasStock && !parts.every((p) => p.stock > 0)) return false;
  if (noStock && !parts.every((p) => p.stock === 0)) return false;
  return (
    days.some((d) => !new RegExp(`${d}\\s*天`, 'u').test(reply)) ||
    stock.some((n) => !new RegExp(`(?:现货|库存)\\s*${n}\\s*件`, 'u').test(reply)) ||
    (hasStock && !/现货|有货/u.test(reply)) ||
    (noStock && !/无现货|没现货|没有现货|无货/u.test(reply))
  );
}

/** 一遍一轮最多一条同类疑似；不把原稿当最终回复。旧 journal 没有 flags 时视为未写。 */
export function triageRun(run: RunResult, catalog: TriagePart[], runId = run.runId ?? 'local'): TriageCandidate[] {
  const candidates: TriageCandidate[] = [];
  const known = new Map<string, PriceLine>();
  const customerModels = new Set<string>();
  const customerQty = new Set<string>();
  const oldChoices = new Set<string>();
  let selected: TriagePart[] = [];
  let before = run.initial;
  for (const [index, turn] of run.turns.entries()) {
    const customerParts = mentioned(turn.customer.say, catalog);
    for (const part of customerParts) customerModels.add(part.id);
    const oldSelected = selected;
    // 明确给出单一型号（含改型）即可作为选择证据；问题里列多个候选时不覆盖单一选择。
    if (customerParts.length === 1) {
      for (const part of oldSelected) if (part.id !== customerParts[0]!.id) oldChoices.add(part.id);
      selected = customerParts;
    }
    const calls = turn.trace.turn.calls;
    for (const call of calls) {
      if (call.name === 'quote_items') for (const line of quoteLines(call, catalog)) known.set(line.part.id, line);
    }
    for (const order of turn.state.orders)
      if ('v' in order && order.status !== 'superseded')
        for (const line of order.lines) {
          const part = partOf(line.code, catalog);
          if (part && priced({ part, qty: line.qty })) known.set(part.id, { part, qty: line.qty });
        }
    const qty = quantities(turn.customer.say);
    if (qty.length) for (const part of customerParts.length ? customerParts : selected) customerQty.add(part.id);
    if (selected.length === 1 && qty.length === 1 && priced({ part: selected[0]!, qty: qty[0]! }))
      known.set(selected[0]!.id, { part: selected[0]!, qty: qty[0]! });
    const wasHandedOver = before.handedOver;
    const accepted = newlyAccepted(before, turn.state);
    before = turn.state;
    if (turn.silent) continue;
    const hits = new Map<DetectorId, string[]>();
    const hit = (detector: DetectorId, evidence: string): void => {
      const list = hits.get(detector) ?? [];
      if (list.length < 4) list.push(excerpt(evidence));
      hits.set(detector, list);
    };
    const reply = turn.reply;
    const flags = object(object(turn.trace.turn).flags);
    const handoff =
      turn.trace.outcome === 'handoff' ||
      (!wasHandedOver && turn.state.handedOver) ||
      calls.some((c) => c.name === 'handoff_to_human' && !c.failed && result(c).ok === true);
    const quote = calls.filter((c) => c.name === 'quote_items').at(-1);
    const expected = quote
      ? quoteLines(quote, catalog)
      : calls
          .filter((c) => c.name === 'find_parts' && result(c).match === 'exact' && /价|试算|多少钱|档位/u.test(turn.customer.say))
          .flatMap((c) =>
            rows(result(c).parts).flatMap((row) => {
              const part = partOf(row.code ?? row.partNo, catalog);
              const line = part && known.get(part.id);
              return line ? [line] : [];
            }),
          );
    if (
      !handoff &&
      !flags.blocksSuppressed &&
      expected.length &&
      expected.some((l) => customerModels.has(l.part.id) && customerQty.has(l.part.id))
    ) {
      const total = expected.reduce((sum, line) => sum + priced(line)!.amountFen, 0);
      const finalAmounts = goodsAmounts(reply);
      // 独立识别 rfq_trim 的说明：只覆盖原试算第 10 行之后的尾行，前 10 行仍须给价。
      const quoteRows = quote ? rows(result(quote).lines) : [];
      const trimNote = /另外\s*([1-9]\d*)\s*行已算好[，,]\s*需要的话我出一份正式报价单/u.exec(reply);
      const trimFallback = /询价明细较多[，,]\s*需要的话我出一份正式报价单/u.test(reply);
      const trimmedCount = Math.min(Math.max(0, quoteRows.length - 10), trimFallback ? quoteRows.length : Number(trimNote?.[1] ?? 0));
      for (const line of expected) {
        if (!customerModels.has(line.part.id) || !customerQty.has(line.part.id)) continue;
        const originalIndex = quoteRows.findIndex(
          (row) => partOf(row.code ?? row.partNo ?? row.query, catalog)?.id === line.part.id && row.qty === line.qty,
        );
        if (trimmedCount && originalIndex >= quoteRows.length - trimmedCount) continue;
        const price = priced(line)!;
        const related = sentences(reply).filter((s) => mentioned(s, catalog).some((p) => p.id === line.part.id));
        // 单行回复可把型号和金额分行；多行只有明确合计可以覆盖所有型号。
        const replyParts = mentioned(reply, catalog);
        const singleContext = expected.length === 1 && replyParts.every((p) => p.id === line.part.id);
        const shown = (singleContext ? finalAmounts : related.flatMap(goodsAmounts)).some(
          (a) => sameMoney(a.fen, price.unitFen) || sameMoney(a.fen, price.amountFen),
        );
        const shownTotal =
          (expected.length > 1 || singleContext) &&
          finalAmounts.some(
            (a) => /合计|总价|总额/u.test(reply.slice(Math.max(0, a.index - 8), a.index) + a.text) && sameMoney(a.fen, total),
          );
        if (!shown && !shownTotal) hit('price_withheld', `${line.part.partNo} × ${line.qty}：最终回复无对应商品金额；${reply}`);
      }
    }
    for (const guard of turn.trace.turn.guards)
      for (const removed of guard.removed) {
        // 格式清洗、同句追加、替换后仍保留的内容不算删对。
        const content = normalize(removed).replace(/[\p{P}\p{S}]/gu, '');
        if (
          content &&
          normalize(reply)
            .replace(/[\p{P}\p{S}]/gu, '')
            .includes(content)
        )
          continue;
        const explicit = mentioned(removed, catalog);
        const parts = explicit.length ? explicit : selected.length ? selected : [...known.values()].map((l) => l.part);
        const allowed = new Set<number>();
        const totals: number[] = [];
        const sentenceQty = quantities(removed);
        for (const part of parts) {
          const qs = new Set(sentenceQty.length ? sentenceQty : [known.get(part.id)?.qty]);
          for (const q of qs)
            if (q !== undefined) {
              const price = priced({ part, qty: q });
              if (price) {
                allowed.add(price.unitFen);
                allowed.add(price.amountFen);
              }
            }
          const current = known.get(part.id);
          if (current) totals.push(priced(current)!.amountFen);
        }
        if (totals.length) allowed.add(totals.reduce((a, b) => a + b, 0));
        // 跨档比较的价差仍由独立 oracle 算；不接受任意两个金额的差。
        if (/省|便宜|少|差额/u.test(removed) && parts.length === 1) {
          const part = parts[0]!;
          const qs = [...new Set([...qty, ...sentenceQty, known.get(part.id)?.qty])].filter((q): q is number => q !== undefined);
          const prices = qs.flatMap((q) => {
            const p = priced({ part, qty: q });
            return p ? [p.amountFen] : [];
          });
          for (const a of prices) for (const b of prices) allowed.add(Math.abs(a - b));
        }
        const money = goodsAmounts(removed);
        const correct = money.length > 0 && money.every((a) => [...allowed].some((v) => sameMoney(v, a.fen)));
        const lostMoney = correct && money.some((a) => !goodsAmounts(reply).some((b) => sameMoney(a.fen, b.fen)));
        if (lostMoney || ((!money.length || correct) && lostInventory(removed, reply, parts)))
          hit('correct_deleted', `${guard.guard}：${removed}`);
      }
    if (accepted.length && asksAgain(reply)) hit('ask_after_accept', `本轮首次记录 acceptedAt；${reply}`);
    for (const order of accepted)
      if ('v' in order)
        for (const amount of goodsAmounts(reply)) {
          // 单价/逐行小计不是要求支付的订单合计。
          const prefix =
            reply
              .slice(0, amount.index)
              .split(/[，,。；;\n]/u)
              .at(-1)! + amount.text;
          if (/^\s*[/／]\s*(?:件|个|只|套|台|米)/u.test(reply.slice(amount.index + amount.text.length))) continue;
          if (/单价|小计|每件|元\s*[/／]/u.test(prefix) && !/合计|总价|总额|货款|应付/u.test(prefix)) continue;
          if (!sameMoney(amount.fen, order.totalFen))
            hit('amount_not_order', `接受 ${order.id} 应付 ${order.totalFen} 分；回复 ${amount.text}`);
        }
    if (
      /\{\s*(?:["'][^"'\n]+["']|\w+)\s*:|\{\s*\}|\[\s*(?:\{|\]|(?:"[^"\n]*"|true|false|null|\d+(?:\.\d+)?)\s*[,\]])|询价摘要|\b(?:code|match|lines|state|version)\s*[:=]|\b(?:find_parts|quote_items|create_quote_sheet|handoff_to_human|acceptedAt|acceptingOrderId|unitPriceFen|amountFen|totalFen|unitPrice|partNo|leadDays|minQty|qty|packState|moneyLedger|resultHead|blocksSuppressed)\b/u.test(
        reply,
      )
    )
      hit('internal_leak', reply);
    const replaced = turn.trace.turn.guards.some((g) => g.action === 'replace');
    if (
      selected.length &&
      ((replaced && /查到多个候选|多个候选.{0,12}选择/u.test(reply)) ||
        (selected.length === 1 &&
          oldChoices.size > 0 &&
          /按|改回|还是|建议|起草|采购/u.test(reply) &&
          !/作废|取消|不再/u.test(reply) &&
          mentioned(reply, catalog).some((p) => oldChoices.has(p.id)) &&
          !mentioned(reply, catalog).some((p) => p.id === selected[0]!.id)))
    )
      hit('choice_overridden', `已选 ${selected.map((p) => p.partNo).join('、')}；${reply}`);
    if (
      /[：:]\s*$/u.test(reply) ||
      /(?:^|\n)\s*(?:[一二三四五六七八九十]+、|\d+[.、)）]|[·•-])\s*$/u.test(reply) ||
      /(?:^|\n)\s*(?:下一步(?:安排)?|试算结果|报价明细|价格明细|合计如下|付款(?:安排|方式|条款)|库存(?:情况|提示)|交期(?:说明|提示)|报价(?:说明|内容)|订单要点|数量档位|档位价格)\s*[：:]?\s*$/u.test(
        reply,
      ) ||
      /^\s*(?:不过|另外)/u.test(reply)
    )
      hit('dangling', reply);
    const seen = new Set<string>();
    for (const sentence of sentences(reply)) {
      const key = sentence.replace(/[\s\p{P}\p{S}]/gu, '');
      if (key.length < 6 || !/顾问|确认|审核|核实|稍等|稍候|联系|转交|转给|无法|不能|不支持|请提供|请问|需要/u.test(key)) continue;
      if (seen.has(key)) hit('duplicate_text', sentence);
      seen.add(key);
    }
    for (const detector of DETECTORS)
      if (hits.has(detector))
        candidates.push({
          id: createHash('sha256')
            .update(`${runId}${run.goalId}${run.repetition}${index + 1}${detector}`)
            .digest('hex')
            .slice(0, 12),
          detector,
          runId,
          goalId: run.goalId,
          repetition: run.repetition,
          turn: index + 1,
          evidence: hits.get(detector)!,
        });
  }
  return candidates;
}

/** replaced 也属于 journal 证据；按 spec 的五元 id 去重，证据合并，分母仍计所有非 silent 轮。 */
export function triageJournal(journal: Journal, catalog: TriagePart[]): { candidates: TriageCandidate[]; summary: TriageSummary } {
  const candidates = new Map<string, TriageCandidate>();
  let turns = 0;
  function visit(run: RunResult): void {
    if (run.replaced) visit(run.replaced);
    turns += run.turns.filter((t) => !t.silent).length;
    for (const candidate of triageRun(run, catalog, journal.meta.runId)) {
      const previous = candidates.get(candidate.id);
      if (previous) previous.evidence = [...new Set([...previous.evidence, ...candidate.evidence])];
      else candidates.set(candidate.id, candidate);
    }
  }
  for (const run of journal.runs) visit(run);
  const found = [...candidates.values()];
  const detectors = Object.fromEntries(
    DETECTORS.map((detector) => {
      const suspects = found.filter((c) => c.detector === detector).length;
      return [detector, { suspects, per100Turns: turns ? (suspects * 100) / turns : 0 }];
    }),
  ) as TriageSummary['detectors'];
  return {
    candidates: found,
    summary: { runId: journal.meta.runId, status: journal.runs.length ? 'recorded' : 'aborted', turns, detectors },
  };
}

export async function main(args: string[]): Promise<void> {
  const files: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--journal') {
      const start = files.length;
      while (args[i + 1] && !args[i + 1]!.startsWith('--')) files.push(args[++i]!);
      if (files.length === start) throw new Error('--journal 需要文件');
    } else if (args[i] === '--out' && args[i + 1] && !args[i + 1]!.startsWith('--')) out = args[++i];
    else throw new Error('用法：--journal <文件>... --out <candidates.json>');
  }
  if (!files.length || !out) throw new Error('用法：--journal <文件>... --out <candidates.json>');
  const catalog = JSON.parse(
    await fs.readFile(new URL('../../data/packs/industrial/catalog/part.json', import.meta.url), 'utf8'),
  ) as TriagePart[];
  const candidates = new Map<string, TriageCandidate>();
  const summaries: (TriageSummary & { journal: string })[] = [];
  for (const file of new Set(files)) {
    const triage = triageJournal(readJournal(await fs.readFile(file)), catalog);
    for (const candidate of triage.candidates) candidates.set(candidate.id, candidate);
    summaries.push({ journal: file, ...triage.summary });
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify([...candidates.values()], null, 2) + '\n');
  console.log(JSON.stringify(summaries, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('triage 失败：请检查参数、journal 与输出文件');
    process.exitCode = 1;
  });
}
