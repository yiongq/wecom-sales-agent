import { randomBytes } from 'node:crypto';
import { runtimeById } from '../../packs/registry.js';
import { packSources } from '../../config/source.js';
import type { LineOrder } from '../../core/order-view.js';
import type { Session } from '../../types.js';
import type { trialBaseline } from '../../db/repo/trial-reset.js';
import { TRIAL_SEED_MANIFEST, TRIAL_SEED_VERSION, type TrialResetCheckpoint } from '../../shared/product-surface.js';

export function planTrialReset(refs: string[]): TrialResetCheckpoint {
  const batch = randomBytes(8).toString('hex');
  return {
    version: 1,
    batch,
    phase: 'planned',
    seedVersion: TRIAL_SEED_VERSION,
    targetConversationRefs: refs,
    erasedConversationRefs: [],
    seedIds: TRIAL_SEED_MANIFEST.map((m) => ({
      key: m.key,
      sessionId: `trialseed-${batch}-${randomBytes(12).toString('hex')}`,
      orderId: m.order === 'none' ? null : `ord_seed_${batch}-${randomBytes(12).toString('hex')}`,
    })),
  };
}
export function buildTrialSeeds(
  p: TrialResetCheckpoint,
  at: number,
  baseline: Awaited<ReturnType<typeof trialBaseline>>,
  sharedUserId: string,
): { sessions: Session[]; orders: LineOrder[] } {
  // 离线种子只用发布快照的确定性价格；不能读调用进程宿主的 ERP 运行时。
  const runtime = runtimeById('industrial', {
    ...packSources(),
    erp: { active: () => false, mapped: () => false, fresh: () => undefined, availability: async () => new Map() },
  })!;
  const row = baseline.catalog[0]!;
  const part = runtime.catalog.part!.schema.parse(row.payload) as Record<string, unknown>;
  const version = Math.max(
    row.version,
    ...baseline.versions.filter((v) => v.code === row.code && v.kind === row.kind).map((v) => v.version),
  );
  const qty = Number(part.moq);
  const sessions: Session[] = [],
    orders: LineOrder[] = [];
  for (const [i, seed] of p.seedIds.entries()) {
    const m = TRIAL_SEED_MANIFEST[i]!;
    const session: Session = {
      id: seed.sessionId,
      channel: 'simulator',
      seed: true,
      profile: {},
      stage: m.order === 'approved' ? 'closing' : m.order === 'pending' ? 'quote' : m.key === 'handoff' ? 'handoff' : 'discovery',
      messages: [
        { role: 'customer', content: `合成询价：${m.scenario}`, at },
        { role: 'agent', content: `合成示例：${part.partNo}；请按实际需求补充规格和数量。`, at: at + 1 },
      ],
      orderIds: [],
      handedOver: m.key === 'handoff',
      createdAt: at,
      updatedAt: at + 1,
    };
    if (m.key === 'handoff') {
      session.handoff = { kind: 'request', reason: '合成询价转人工', at };
      session.assignee = { userId: sharedUserId, name: '共享顾问', at };
      session.messages[1] = {
        role: 'agent',
        author: 'human',
        authorId: sharedUserId,
        authorName: '共享顾问',
        content: '合成示例：已接手询价，正在核对规格。',
        at: at + 1,
      };
    }
    if (m.key === 'matching') session.packState = { rfqDraft: { at, lines: [{ match: 'ambiguous', qty }] } };
    if (seed.orderId) {
      const price = runtime.priceLine!(part, qty, { kind: 'part', session });
      if ('reject' in price) throw new Error('trial_seed_price_rejected');
      session.packState = { rfqDraft: { at, lines: [{ match: 'exact', code: row.code, version, qty }] } };
      session.orderIds.push(seed.orderId);
      const approved = m.order === 'approved';
      orders.push({
        v: 2,
        id: seed.orderId,
        sessionId: seed.sessionId,
        lines: [{ kind: 'part', code: row.code, version, title: String(part.partNo), qty, ...price, amountFen: price.unitPriceFen * qty }],
        totalFen: price.unitPriceFen * qty,
        status: 'pending_payment',
        createdAt: at,
        approval: {
          state: approved ? 'approved' : 'pending',
          requestedAt: at,
          ...(approved ? { decidedAt: at, decidedBy: { userId: null, name: '合成主管' } } : {}),
        },
        ...(approved ? { confirmedAt: at } : {}),
      });
    }
    runtime.sessionState!.schema.parse(session.packState ?? {});
    sessions.push(session);
  }
  return { sessions, orders };
}
