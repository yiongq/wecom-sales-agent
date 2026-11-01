import { randomBytes } from 'node:crypto';
import { runtimeById } from '../../packs/registry.js';
import { packSources } from '../../config/source.js';
import type { LineOrder } from '../../core/order-view.js';
import type { Session } from '../../types.js';
import type { trialBaseline } from '../../db/repo/trial-reset.js';
import { TRIAL_SEED_MANIFEST, TRIAL_SEED_VERSION, type TrialResetCheckpoint } from '../../shared/product-surface.js';

type SeedKey = (typeof TRIAL_SEED_MANIFEST)[number]['key'];
/** 试用者第一眼看到的对话，要像真实询价。全部虚构，不写金额和库存，这些以报价单为准。 */
function seedScript(key: SeedKey, partNo: string, qty: number): ['customer' | 'agent', string][] {
  switch (key) {
    case 'inquiry':
      return [
        ['customer', '你好，想问下深沟球轴承，有现货吗？'],
        ['agent', '您好，我是询价助手。麻烦告诉我具体型号和数量，我帮您查一下。'],
        ['customer', '型号我去车间确认下，大概要二十来个'],
        ['agent', '好的，确认后发我型号就行，拍铭牌照片也可以。'],
      ];
    case 'matching':
      return [
        ['customer', `${partNo} 有没有能替代的？原来的品牌交期太长`],
        ['agent', `我先按 ${partNo} 的规格帮您匹配，请问您更看重交期还是原厂品牌？`],
        ['customer', '交期优先，规格一样就行'],
        ['agent', '明白，我把规格一致的候选型号整理给您确认。'],
      ];
    case 'quote-pending':
      return [
        ['customer', `${partNo} 要 ${qty} 件，含税多少钱？几天能发？`],
        ['agent', `已按 ${partNo}、${qty} 件试算好，顾问确认后把正式报价单发给您。`],
      ];
    case 'quote-approved':
      return [
        ['customer', `麻烦报一下 ${partNo}，${qty} 件`],
        ['agent', '报价单已确认，您可以点开链接查看明细。'],
        ['customer', '收到，我发给采购看下'],
        ['agent', '好的，有问题随时找我。'],
      ];
    case 'handoff':
      return [
        ['customer', `${partNo} 这个月要得比较多，账期能不能谈？`],
        ['agent', '账期需要顾问和您确认，我这就帮您转接。'],
        ['agent', '您好，我是您的顾问。账期这块我来对接，方便说下大概的月用量吗？'],
      ];
  }
}

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
    const script = seedScript(m.key, String(part.partNo), qty);
    const session: Session = {
      id: seed.sessionId,
      channel: 'simulator',
      seed: true,
      seedBaselineSeq: script.length,
      profile: {},
      stage: m.order === 'approved' ? 'closing' : m.order === 'pending' ? 'quote' : m.key === 'handoff' ? 'handoff' : 'discovery',
      messages: script.map(([role, content], n) => ({ role, content, at: at + n })),
      orderIds: [],
      handedOver: m.key === 'handoff',
      createdAt: at,
      updatedAt: at + script.length - 1,
    };
    if (m.key === 'handoff') {
      session.handoff = { kind: 'request', reason: '客户要谈账期，转顾问接手', at };
      session.assignee = { userId: sharedUserId, name: '共享顾问', at };
      const last = session.messages.length - 1;
      session.messages[last] = {
        ...session.messages[last]!,
        author: 'human',
        authorId: sharedUserId,
        authorName: '共享顾问',
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
