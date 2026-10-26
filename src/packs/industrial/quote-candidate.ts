// R7 的容量联验与 R11 共用：只消费必留摘要与可读报价，不读 partsInPlay。
import { getAnyOrder, quoteState, type LineOrder, type Session } from '../../core/pack-api.js';
import { readState, type RfqDraft } from './state.js';
export type QuoteCandidate =
  | { kind: 'draft'; at: number; draft: RfqDraft }
  | { kind: 'quote'; at: number; order: LineOrder; state: 'pending' | 'approved' | 'expired' };
export function latestQuoteCandidate(session: Session, now: number): QuoteCandidate | null {
  const draft = readState(session).rfqDraft;
  const candidates: QuoteCandidate[] = draft ? [{ kind: 'draft', at: draft.at, draft }] : [];
  for (const id of session.orderIds) {
    const order = getAnyOrder(id);
    if (!order || !('v' in order) || order.sessionId !== session.id || !order.approval) continue;
    const state = quoteState(order, now);
    if (state !== 'pending' && state !== 'approved' && state !== 'expired') continue;
    const at = state === 'pending' ? order.approval.requestedAt : order.approval.decidedAt;
    if (at === undefined || !Number.isSafeInteger(at) || at < 0) continue;
    candidates.push({ kind: 'quote', at, order, state });
  }
  return (
    candidates.toSorted((a, b) => {
      if (a.at !== b.at) return b.at - a.at;
      if (a.kind !== b.kind) return a.kind === 'draft' ? -1 : 1;
      if (a.kind !== 'quote' || b.kind !== 'quote') return 0;
      return b.order.createdAt - a.order.createdAt || (a.order.id > b.order.id ? -1 : a.order.id < b.order.id ? 1 : 0);
    })[0] ?? null
  );
}
