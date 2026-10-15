import { isDeepStrictEqual } from 'node:util';
import type { Order, Session } from '../../src/types.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { Predicate, SimGoal } from './goals.js';
import { countLines } from './shape-count.js';

export interface Snapshot {
  orders: Order[];
  handedOver: boolean;
  handoff: Session['handoff'] | null;
  stage: Session['stage'];
}
export interface SimTurn {
  customer: { say: string; done: boolean };
  reply: string;
  silent: boolean;
  trace: FinishedTurn;
  state: Snapshot;
}
export interface Evidence {
  initial: Snapshot;
  turns: SimTurn[];
}
export interface Verdict {
  check: string;
  passed: boolean;
  detail: string;
}

/** 本轮有这些工具的结果（含预取）就算推荐 / 报价类，上限更宽；其余算普通类。 */
export const RICH_TOOLS: ReadonlySet<string> = new Set([
  'search_routes',
  'get_route_detail',
  'create_quote',
  'generate_proposal',
  'create_order',
]);
export const isRichTurn = (t: SimTurn): boolean => t.trace.turn.calls.some((c) => RICH_TOOLS.has(c.name));

// 否定词必须出现在命中处之前、同一分句里，且相隔不超过 12 个字；顿号不切分句，「没有儿童价、早鸟价」两项都算被否定。
const NEGATION = /(?:没有|并无|绝无|不存在|不设|不收|不会有|不提供|不涉及|不另|不再|不额外|不是|并非|不需要|无需|不用|没|无|未)/u;
const CLAUSE_BREAK = /[，。；;！？!?：:\n,.]/u;
export function negatedAt(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const clause = before.slice(Math.max(0, ...[...before.matchAll(new RegExp(CLAUSE_BREAK, 'gu'))].map((m) => m.index + m[0].length)));
  const window = [...clause].slice(-14).join('');
  return NEGATION.test(window);
}
function hits(pattern: string, reply: string, negationAware: boolean): boolean {
  for (const m of reply.matchAll(new RegExp(pattern, 'gu'))) {
    if (!negationAware || !negatedAt(reply, m.index)) return true;
    if (m[0] === '') break;
  }
  return false;
}

export function shapeShare(turns: SimTurn[], richMax: number, plainMax: number): { within: number; total: number } {
  const replies = turns.filter((t) => !t.silent);
  return {
    total: replies.length,
    within: replies.filter((t) => countLines(t.reply) <= (isRichTurn(t) ? richMax : plainMax)).length,
  };
}

function sentences(reply: string): string[] {
  return reply
    .split(/(?<=[。！？!?])|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function finalState(e: Evidence): Snapshot {
  return e.turns.at(-1)?.state ?? e.initial;
}
function testPredicate(p: Predicate, e: Evidence): boolean {
  switch (p.kind) {
    case 'order': {
      const orders = finalState(e).orders;
      return (
        orders.length === p.count &&
        orders.every((o) =>
          Object.entries(p.fields ?? {}).every(([k, v]) => Object.hasOwn(o, k) && isDeepStrictEqual(o[k as keyof Order], v)),
        )
      );
    }
    case 'no_order_before': {
      if (e.initial.orders.length) return false;
      for (const t of e.turns) {
        if (new RegExp(p.turnMatches, 'u').test(t.customer.say)) return true;
        if (t.state.orders.length) return false;
      }
      return true;
    }
    case 'handoff':
      return finalState(e).handedOver === p.expected;
    case 'tool_called': {
      const n = e.turns.flatMap((t) => t.trace.turn.calls).filter((c) => c.name === p.name).length;
      return n >= (p.min ?? 1) && n <= (p.max ?? Infinity);
    }
    case 'reply_matches':
    case 'reply_excludes': {
      // 静默轮次没有发出回复；空集合不产生「全部通过」的虚假证据。
      let turns = e.turns;
      if (p.kind === 'reply_excludes' && p.after) {
        const first = turns.findIndex((t) => t.trace.turn.calls.some((c) => c.name === p.after!.tool));
        // 工具一次没调用：「它之后的回复里没有 X」成立得空洞，通过；目标要求必须调用的话另用 tool_called 守
        if (first < 0) return true;
        turns = turns.slice(first);
      }
      const replies = turns.filter((t) => !t.silent).map((t) => t.reply);
      const selected = p.scope === 'last' ? replies.slice(-1) : replies;
      const negationAware = p.kind === 'reply_excludes' && p.negationAware === true;
      const matches = selected.map((r) => hits(p.pattern, r, negationAware) === (p.kind === 'reply_matches'));
      return matches.length > 0 && (p.scope === 'any' ? matches.some(Boolean) : matches.every(Boolean));
    }
    case 'shape': {
      const { within, total } = shapeShare(e.turns, p.richMax, p.plainMax);
      return total > 0 && within / total >= p.minShare;
    }
    case 'no_repeat': {
      const re = new RegExp(p.pattern, 'u');
      const unless = p.unlessCustomer ? new RegExp(p.unlessCustomer, 'u') : null;
      const replies = e.turns.filter((t) => !t.silent);
      if (!replies.length) return false;
      // 之前已经出现过这一类句子，这一轮又有；客户这一轮再问的除外
      let seen = false;
      for (const t of replies) {
        const has = sentences(t.reply).some((s) => re.test(s));
        if (has && seen && !(unless && unless.test(t.customer.say))) return false;
        seen ||= has;
      }
      return true;
    }
  }
}
export function judge(goal: SimGoal, evidence: Evidence): Verdict[] {
  const verdicts = goal.predicates.map((p, i) => ({
    check: `predicate[${i}]:${p.kind}`,
    passed: testPredicate(p, evidence),
    detail: JSON.stringify(p),
  }));
  for (const phrase of goal.forbidden) {
    const hit = evidence.turns.findIndex((t) => !t.silent && t.reply.includes(phrase));
    verdicts.push({ check: 'forbidden', passed: hit < 0, detail: hit < 0 ? phrase : `${phrase} @ turn ${hit + 1}` });
  }
  const denied = evidence.turns.flatMap((t, i) =>
    t.trace.turn.calls.filter((c) => !goal.allowedTools.includes(c.name)).map((c) => `${c.name} @ turn ${i + 1}`),
  );
  verdicts.push({ check: 'allowedTools', passed: !denied.length, detail: denied.join(', ') });
  return verdicts;
}
