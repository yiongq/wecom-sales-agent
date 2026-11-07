// 18 R2：只从确认过的合成证据生成回归，不加载产品包或护栏。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJournal, type Journal } from './journal.js';
import { DETECTORS, triageRun, type DetectorId, type TriagePart, type TriageVerdict } from './triage.js';
import { oraclePrice } from './audit.js';
import type { SimTurn } from './judge.js';
import type { RunResult } from './runner.js';
import { validateCase, type CaseV2, type ScriptStep } from '../v2/schema.js';

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const money = (fen: number): string => {
  const [whole, decimals] = (fen / 100).toFixed(2).split('.');
  return `(?<![\\d.])${whole}${decimals === '00' ? '(?:\\.0{1,2})?' : `\\.${decimals}`}(?![\\d.])`;
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function output(call: SimTurn['trace']['turn']['calls'][number]): Record<string, unknown> {
  if (call.failed || call.resultBytes > 4096) throw new Error('工具结果失败或截断，不能据此生成断言');
  try {
    return object(JSON.parse(call.resultHead));
  } catch {
    throw new Error('工具结果不是完整 JSON，不能生成断言');
  }
}

function assertions(detector: DetectorId, turn: SimTurn, catalog: TriagePart[], evidence: string[]): CaseV2['turns'][number]['expect'] {
  const cannot = (reason: string): never => {
    throw new Error(`${detector} 无法生成断言：${reason}`);
  };
  switch (detector) {
    case 'price_withheld': {
      const quote = turn.trace.turn.calls.filter((c) => c.name === 'quote_items').at(-1);
      const lines = quote ? output(quote).lines : undefined;
      const prices = Array.isArray(lines)
        ? lines.flatMap((row) => {
            const r = object(row);
            const part = catalog.find((p) => [p.id, p.partNo, ...(p.aliases ?? [])].includes(String(r.code ?? r.partNo ?? r.query)));
            if (
              r.match !== 'exact' ||
              !part ||
              typeof r.qty !== 'number' ||
              !evidence.some((e) => e.startsWith(`${part.partNo} × ${r.qty}：`))
            )
              return [];
            const price = oraclePrice(part, r.qty);
            return price === 'below_moq' ? [] : [{ partNo: part.partNo, fen: price.unitFen }];
          })
        : evidence.flatMap((e) => {
            // find_parts 路径的数量可来自此前客户轮；用独立检测器记录的型号、数量，重新按价目表算档位。
            const match = /^(.+) × ([1-9]\d*)：/u.exec(e);
            const part = catalog.find((p) => p.partNo === match?.[1]);
            if (!match || !part) return [];
            const price = oraclePrice(part, Number(match[2]));
            return price === 'below_moq' ? [] : [{ partNo: part.partNo, fen: price.unitFen }];
          });
      if (!prices.length) return cannot('缺少命中行的完整型号、数量或独立价目表');
      return {
        replyMatches: prices.map(({ partNo, fen }) => {
          const amount = `(?:单价\\s*[:：]?\\s*${money(fen)}|${money(fen)}\\s*元)`;
          return `(?:${escape(partNo)}[^\\n]*${amount}|${amount}[^\\n]*${escape(partNo)})`;
        }),
      };
    }
    case 'correct_deleted': {
      const removed = turn.trace.turn.guards.flatMap((g) =>
        g.removed.filter((s) => evidence.some((e) => e.startsWith(`${g.guard}：${s}`.slice(0, 200)))),
      );
      if (!removed.length) return cannot('缺少被确认删除的完整句子');
      return { replyMatches: removed.map(escape) };
    }
    case 'ask_after_accept':
      return {
        replyExcludes: [
          '(?:请|麻烦|需要您).{0,8}(?:再|重新)?确认.{0,12}(?:报价|订单|下单)|(?:报价|订单|下单).{0,16}(?:还需要|请|需要您|待您).{0,8}确认|请回复.{0,12}接受|请(?:您)?(?:再|重新)?确认(?:一下)?[。！？!?]|(?:您可以|请|麻烦您?).{0,6}回复确认|确认下单请回复|您再.{0,20}确认|请在.{0,14}完成确认',
        ],
      };
    case 'amount_not_order': {
      const accepted = turn.state.orders.filter(
        (o) =>
          'v' in o &&
          o.approval?.acceptedAt !== undefined &&
          !turn.sessionBefore!.orders.some((b) => b.id === o.id && 'v' in b && b.approval?.acceptedAt === o.approval?.acceptedAt),
      );
      if (accepted.length !== 1 || !('v' in accepted[0]!)) return cannot('无法唯一确定本轮接受的订单');
      const total = money(accepted[0]!.totalFen);
      return {
        replyMatches: [`(?:应付(?:金额)?|合计|总价|货款)\\s*[:：]?\\s*${total}`],
        replyExcludes: [`(?:应付(?:金额)?|合计|总价|货款)\\s*[:：]?\\s*(?!${total})\\d+(?:\\.\\d+)?`],
      };
    }
    case 'internal_leak':
      return {
        replyExcludes: [
          '\\{',
          '\\[\\s*(?:\\{|\\]|["\\d])',
          '询价摘要|\\b(?:code|match|lines|state|version)\\s*[:=]',
          '\\b(?:find_parts|quote_items|create_quote_sheet|handoff_to_human|acceptedAt|acceptingOrderId|unitPriceFen|amountFen|totalFen|unitPrice|partNo|leadDays|minQty|qty|packState|moneyLedger|resultHead|blocksSuppressed)\\b',
        ],
      };
    case 'choice_overridden': {
      // 「已选」来自检测器沿客户输入维护的选择，不能从错误回复反推。
      const selection = /^已选 ([^；]+)；/u.exec(evidence[0] ?? '')?.[1];
      const selected = selection?.split('、').map((name) => catalog.find((p) => p.partNo === name));
      if (!selected?.length || selected.some((p) => !p)) return cannot('缺少完整、可核对的客户已选型号');
      return {
        replyMatches: selected.map((p) => escape(p!.partNo)),
        replyExcludes: ['查到多个候选|多个候选.{0,12}选择'],
      };
    }
    case 'dangling':
      return {
        replyExcludes: [
          '[：:]\\s*$',
          '(?:^|\\n)\\s*(?:[一二三四五六七八九十]+、|\\d+[.、)）]|[·•-])\\s*$',
          '(?:^|\\n)\\s*(?:下一步(?:安排)?|试算结果|报价明细|价格明细|合计如下|付款(?:安排|方式|条款)|库存(?:情况|提示)|交期(?:说明|提示)|报价(?:说明|内容)|订单要点|数量档位|档位价格)\\s*[：:]?\\s*$',
          '^\\s*(?:不过|另外)',
        ],
      };
    case 'duplicate_text': {
      if (!evidence.length || evidence.some((s) => [...s].length >= 200)) return cannot('重复句证据缺失或截断');
      return {
        replyExcludes: evidence.map((s) => {
          const sentence = [...s.replace(/[\s\p{P}\p{S}]/gu, '')].map(escape).join('[\\s，,。.!！?？；;、：:]*');
          return `${sentence}[\\s\\S]*${sentence}`;
        }),
      };
    }
  }
}

/** 只重放实际记录的模型请求；无法恢复的复用参数明确拒绝，避免猜测工具脚本。 */
function modelScript(turn: SimTurn): ScriptStep[] {
  const trace = turn.trace.turn;
  const calls = trace.calls.filter((c) => !c.prefetch);
  const script: ScriptStep[] = [];
  let cursor = 0;
  for (const request of trace.llm.filter((l) => l.purpose !== 'vision')) {
    if (request.error) throw new Error('模型请求失败，无法生成确定性的回放脚本');
    if (request.tools.length) {
      const reused = [...request.reused];
      const toolCalls = request.tools.map((name) => {
        const reuseIndex = reused.indexOf(name);
        if (reuseIndex >= 0) {
          if (request.tools.filter((n) => n === name).length !== 1)
            throw new Error('同一请求多次调用并复用同名工具，trace 无法恢复参数顺序');
          reused.splice(reuseIndex, 1);
          const previous = trace.calls.filter((c) => c.name === name && (c.prefetch || calls.indexOf(c) < cursor));
          const variants = new Map(previous.map((c) => [JSON.stringify(c.args), c.args]));
          if (variants.size !== 1) throw new Error('trace 未保存复用工具的参数，无法无歧义地生成模型脚本');
          return { name, args: [...variants.values()][0]! };
        }
        const call = calls[cursor++];
        if (!call || call.name !== name) throw new Error('模型工具序列与 trace 不符，无法生成脚本');
        return { name, args: call.args };
      });
      script.push({ toolCalls });
    } else {
      if (trace.draft === null || script.some((s) => s.content !== undefined))
        throw new Error('缺少模型原稿或有多次纯文本请求，无法生成脚本');
      script.push({ content: trace.draft });
    }
  }
  if (trace.draft !== null && !script.some((s) => s.content !== undefined)) throw new Error('trace 缺少最终模型请求，无法生成脚本');
  if (cursor !== calls.length) throw new Error('trace 缺少模型调用分组，无法生成脚本');
  return script;
}

export function promote(journal: Journal, review: TriageVerdict[], id: string, caseId: string, catalog: TriagePart[]): CaseV2 {
  if (
    review.some((v) => !v || typeof v.id !== 'string' || !['confirmed', 'false_positive'].includes(v.verdict) || typeof v.note !== 'string')
  )
    throw new Error('review 必须包含合法的 id、verdict 与 note');
  const verdicts = review.filter((v) => v.id === id);
  if (verdicts.length !== 1 || verdicts[0]!.verdict !== 'confirmed' || !verdicts[0]!.note?.trim())
    throw new Error('候选未确认：review 必须包含唯一的 confirmed 裁定和理由');
  const matches: { run: RunResult; turn: SimTurn; detector: DetectorId; evidence: string[] }[] = [];
  function visit(run: RunResult): void {
    if (run.replaced) visit(run.replaced);
    for (const [i, turn] of run.turns.entries()) {
      for (const detector of DETECTORS) {
        const key = createHash('sha256')
          .update(`${journal.meta.runId}${run.goalId}${run.repetition}${i + 1}${detector}`)
          .digest('hex')
          .slice(0, 12);
        if (key !== id) continue;
        const candidate = triageRun(run, catalog, journal.meta.runId).find((c) => c.id === id);
        if (candidate) matches.push({ run, turn, detector, evidence: candidate.evidence });
      }
    }
  }
  for (const run of journal.runs) visit(run);
  if (matches.length !== 1) throw new Error('找不到唯一候选：id 不存在、检测未命中或 replaced 证据有歧义');
  const { turn, detector, evidence } = matches[0]!;
  if (!turn.sessionBefore) throw new Error('旧 journal 只能手写用例：缺少 sessionBefore');
  const before = turn.sessionBefore;
  const allIds = new Set(journal.runs.flatMap((r) => [...r.initial.orders, ...r.turns.flatMap((t) => t.state.orders)].map((o) => o.id)));
  const referencedOrders = [
    ...before.orders,
    ...turn.state.orders.filter((o) => !before.orders.some((b) => b.id === o.id)).toSorted((a, b) => a.createdAt - b.createdAt),
  ];
  const refs = new Map(referencedOrders.map((o, i) => [o.id, `{{order:${i}.id}}`]));
  function replace(value: unknown): unknown {
    if (typeof value === 'string') {
      let replaced = value;
      for (const old of [...allIds].toSorted((a, b) => b.length - a.length)) {
        if (!replaced.includes(old)) continue;
        const ref = refs.get(old);
        if (!ref) throw new Error('用例引用缺失的订单，无法用序号恢复，请手写用例');
        replaced = replaced.replaceAll(old, ref);
      }
      return replaced;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    return value;
  }
  for (const o of before.orders) allIds.add(o.id);
  const orders = before.orders.map((o) => {
    if (!('v' in o)) throw new Error('promote 只支持工业通用订单');
    if (o.approval && (!['pending', 'approved'].includes(o.approval.state) || o.approval.acceptedAt !== undefined))
      throw new Error('轮前订单含 v2 夹具无法表达的审批状态或已接受状态，请手写用例');
    return {
      status: o.status,
      lines: o.lines.map(({ kind, code, qty }) => ({ kind, code, qty })),
      ...(o.approval
        ? {
            approval: {
              state: o.approval.state,
              ...(o.approval.decidedAt === undefined ? {} : { decidedAt: new Date(o.approval.decidedAt).toISOString() }),
            },
          }
        : {}),
    };
  });
  const { id: _sid, channel: _channel, ...session } = before.session;
  const expect = assertions(detector, turn, catalog, evidence);
  if (
    !expect.replyMatches?.some((pattern) => !new RegExp(pattern, 'm').test(turn.reply)) &&
    !expect.replyExcludes?.some((pattern) => new RegExp(pattern, 'm').test(turn.reply))
  )
    throw new Error(`${detector} 无法生成断言：当前证据未被规则覆盖，请手写用例`);
  const generated = {
    version: 2,
    id: caseId,
    desc: `仿真回归：${detector}（候选 ${id}）`,
    tags: ['q18', 'industrial', detector],
    pack: 'industrial',
    fixtures: {
      now: new Date(turn.trace.turn.startedAt).toISOString(),
      session: replace({ ...session, moneyLedger: session.moneyLedger ?? [] }),
      orders,
    },
    turns: [{ say: turn.customer.say, script: replace(modelScript(turn)), expect: replace(expect) }],
  };
  return validateCase(generated);
}

export async function main(args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!['--journal', '--review', '--id', '--out'].includes(key) || flags.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--'))
      throw new Error('用法：--journal <文件> --review <triage-review.json> --id <候选 id> --out eval/cases-v2/q18-<名字>.json');
    flags.set(key, args[i + 1]!);
  }
  if (flags.size !== 4) throw new Error('必须给出 --journal、--review、--id、--out');
  const out = flags.get('--out')!;
  if (!/^q18-[\p{L}\p{N}_-]+\.json$/u.test(path.basename(out))) throw new Error('输出文件名必须是 q18-<名字>.json');
  const review: unknown = JSON.parse(await fs.readFile(flags.get('--review')!, 'utf8'));
  if (!Array.isArray(review)) throw new Error('review 必须是 TriageVerdict 数组');
  const catalog = JSON.parse(
    await fs.readFile(new URL('../../data/packs/industrial/catalog/part.json', import.meta.url), 'utf8'),
  ) as TriagePart[];
  const c = promote(
    readJournal(await fs.readFile(flags.get('--journal')!)),
    review,
    flags.get('--id')!,
    path.basename(out, '.json'),
    catalog,
  );
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(c, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`promote 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
