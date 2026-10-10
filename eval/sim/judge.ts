import { isDeepStrictEqual } from 'node:util';
import type { Order, Session } from '../../src/types.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { Predicate, SimGoal } from './goals.js';

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
      const replies = e.turns.filter((t) => !t.silent).map((t) => t.reply);
      const selected = p.scope === 'last' ? replies.slice(-1) : replies;
      const matches = selected.map((r) => new RegExp(p.pattern, 'u').test(r) === (p.kind === 'reply_matches'));
      return matches.length > 0 && (p.scope === 'any' ? matches.some(Boolean) : matches.every(Boolean));
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
