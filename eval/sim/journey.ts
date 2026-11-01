// 16 R3：只比业务终态；话术只用于客户偏离与 no_quote 正面证据。
import type { LineOrder } from '../../src/core/order-view.js';
import type { SimGoal } from './goals.js';
import type { FailBucket, RunResult, RunStatus } from './runner.js';

export interface JourneyVerdict {
  status: RunStatus;
  bucket?: FailBucket;
  reasons: string[];
}
const valid = (o: LineOrder): boolean => o.status === 'pending_payment' && o.approval?.state === 'approved' && !o.supersededBy;
const byApprover = (o: LineOrder): boolean => o.approval?.decidedBy?.name === '审批替身';

export function judgeJourney(goal: SimGoal, run: RunResult): JourneyVerdict {
  if (!goal.journey) throw new Error('journey 缺失');
  const excluded = (status: RunStatus): JourneyVerdict => ({ status, reasons: [status] });
  const failed = (bucket: FailBucket): JourneyVerdict => ({ status: 'failed', bucket, reasons: [bucket] });
  if (run.status === 'budget_stop') return excluded('budget_stop');
  if (run.status === 'customer_protocol' || run.status === 'customer_http') return excluded(run.status);
  if (run.failedTurn && (run.failedTurn.outcome === 'error' || run.failedTurn.turn.llm.some((c) => !!c.error)))
    return failed('model_error');
  if (run.endedBy === 'runner_error') return failed('runner_error');
  if (run.findings?.some((f) => f.level === 'code' && f.source === 'final')) return failed('rule_violation');

  if (!run.finalState) throw new Error('finalState 缺失');
  const state = run.finalState;
  const orders = state.orders.filter((o): o is LineOrder => 'v' in o && o.v === 2);
  const active = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'superseded');
  const latest = active.toSorted((a, b) => b.createdAt - a.createdAt)[0];
  const expected = goal.journey.expect;
  let bucket: FailBucket | undefined;
  switch (expected.end) {
    case 'quote_accepted': {
      // 多重集比较：行顺序不影响结果，重复行仍计数。
      const lines = (xs: { code: string; qty: number }[]) => xs.map((l) => JSON.stringify([l.code, l.qty])).toSorted();
      // R3：通过只看单和确认；转了人工但单、批准、确认都对的算通过（顾问接手付款是正常结局）。
      let miss: FailBucket | undefined;
      if (!latest) miss = 'quote_missing';
      else if (JSON.stringify(lines(latest.lines)) !== JSON.stringify(lines(expected.lines))) miss = 'wrong_lines';
      else if (latest.totalFen !== expected.totalFen) miss = 'wrong_total';
      else if (!valid(latest) || !byApprover(latest) || orders.filter(valid).length !== 1) miss = 'not_approved';
      else if (latest.approval?.acceptedAt == null) miss = 'not_accepted';
      bucket = miss && state.handedOver ? 'unneeded_handoff' : miss;
      break;
    }
    case 'quote_rejected':
      if (!orders.length) bucket = 'quote_missing';
      else if (!state.handedOver || !orders.some((o) => o.status === 'cancelled' && o.approval?.state === 'rejected' && byApprover(o)))
        bucket = 'not_rejected';
      break;
    case 'handoff':
      if (!state.handedOver) bucket = 'missed_handoff';
      else if (!state.handoff || !expected.kinds.includes(state.handoff.kind)) bucket = 'wrong_handoff';
      else if (orders.some((o) => (o.status === 'pending_payment' && o.approval?.state === 'pending') || valid(o)))
        bucket = 'unexpected_quote';
      break;
    case 'no_quote': {
      const evidence = expected.evidence;
      if (state.handedOver) bucket = 'unneeded_handoff';
      else if (state.orders.length) bucket = 'unexpected_quote';
      else if (
        (evidence.tool && !run.turns.some((t) => t.trace.turn.calls.some((c) => !c.prefetch && c.name === evidence.tool))) ||
        (evidence.reply && !run.turns.some((t) => !t.silent && new RegExp(evidence.reply!, 'iu').test(t.reply)))
      )
        bucket = 'no_evidence';
      break;
    }
  }
  if (!bucket) return { status: 'passed', reasons: [] };

  if (run.endedBy === 'done' || run.endedBy === 'maxTurns') {
    const missing = goal.journey.facts.some(
      ({ fact, asked }) =>
        run.turns.some((t) => !t.silent && new RegExp(asked, 'iu').test(t.reply)) &&
        !run.turns.some((t) => new RegExp(fact, 'iu').test(t.customer.say)),
    );
    const lastOrders = run.turns.at(-1)?.state.orders ?? [];
    const leftAfterApproval =
      run.endedBy === 'done' &&
      run.leftSilently &&
      orders.some(
        (o) => valid(o) && lastOrders.some((before) => before.id === o.id && 'v' in before && before.approval?.state === 'pending'),
      );
    if (missing || leftAfterApproval) return excluded('customer_drift');
  }
  return failed(bucket);
}
