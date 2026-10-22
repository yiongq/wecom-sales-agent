// 06 R21：旅游包登记的全部对客固定文字（PackRuntime.fixedReplies）。
// 每条是 id、出处和样例；样例由真实代码现渲染（调用同一个函数、同一份常量），这里不抄一份文字，免得和代码各说各话。
// 按「原则」的三种情形各渲染一份：legacy（旧版、企微）、web（网页渠道、品牌模板）、template（模板模式、非网页）。
// 新增一条对客固定文字，先在这里登记（一致性检查只查登记过的，另有一道扫源码字面量的兜底，见 consistency.selftest）。
import {
  renderBrandTemplate,
  type BrandProfile,
  type FixedReply,
  type FixedReplyMode,
  type FixedReplyOrigin,
  type FixedReplySample,
  type Order,
  type Route,
  peakMonths,
  type PackSources,
  type SalesStage,
  type Session,
} from '../../core/pack-api.js';
import type { TravelParts } from './runtime.js';
import { shanhaiBrand } from './brand-fixture.js';
import { type ContactMode, paymentPendingReply } from './contact-words.js';
import { refundQuoteText, refundChooseText, refundTexts, refundNoticeText } from './refund-words.js';
import { defaultTravelPolicy } from './policy.js';
import { quoteRefund } from '../../core/pack-api.js';
import { closingLine } from './closing-words.js';
import { claimWordsTest } from './claim-words.js';
import { followupTemplates } from './followup.js';
import { identityAnswer, offTopicReply, welcomeBackText, welcomeText, webWelcome } from './legacy.js';
import { createdOrderText, existingOrderText, paidOrderText, STRANDED_LEAD } from './order-words.js';
import { insightPrompts } from './insight.js';
import { paidChitchatReply } from './reply-notes.js';
import { excludesRoundTripTransport, renderQuoteLine } from './quote-template.js';
import { travelQuickReplyDefaults } from './quick-reply-defaults.js';
import { travelTemplates } from './templates.js';

/** 一种渲染的上下文：品牌（null 是旧版）、渠道、联系方式的三种说法 */
export interface ModeCtx {
  mode: FixedReplyMode;
  channel: 'wecom' | 'web';
  brand: BrandProfile | null;
  contact: ContactMode;
}

export const MODE_CTX: readonly ModeCtx[] = Object.freeze([
  { mode: 'legacy', channel: 'wecom', brand: null, contact: { channel: 'wecom', templateMode: false } },
  { mode: 'web', channel: 'web', brand: shanhaiBrand, contact: { channel: 'web', templateMode: true } },
  { mode: 'template', channel: 'wecom', brand: shanhaiBrand, contact: { channel: 'wecom', templateMode: true } },
]);

export function fixtureSession(m: ModeCtx, over: Partial<Session> = {}): Session {
  return {
    id: `${m.channel}:consistency`,
    channel: m.channel,
    stage: 'discovery',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

export function fixtureOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord_sample1',
    sessionId: 'consistency',
    routeId: 'r-sample',
    routeTitle: '云南 丽江大理 6 日',
    travelers: 2,
    departDate: '2099-03-10',
    totalPrice: 33600,
    status: 'pending_payment',
    createdAt: 0,
    ...over,
  };
}

type World = (over: Partial<PackSources>) => TravelParts;

/** 样例要走真实代码，真实代码会打日志；渲染样例时静音，免得自测输出里全是「重发支付链接」 */
function quietly<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

/** 三种渲染都一样的文字 */
const same = (text: string): FixedReplySample[] => MODE_CTX.map((m) => ({ mode: m.mode, text }));
const each = (render: (m: ModeCtx) => string | Promise<string>): (() => Promise<FixedReplySample[]>) => {
  return async () => Promise.all(MODE_CTX.map(async (m) => ({ mode: m.mode, text: await render(m) })));
};
/** 品牌模板用模板渲染，旧版用旧文字 */
const brandOrLegacy = (m: ModeCtx, legacy: string, template: string): string => (m.brand ? renderBrandTemplate(template, m.brand) : legacy);

const SRC = 'src/packs/travel';

const reply = (step: string | null): FixedReplyOrigin => ({ pipeline: 'reply', step });
const outside = (why: string): FixedReplyOrigin => ({ outside: why });

/**
 * 每条固定文字由哪个步骤产出（id 精确匹配或前缀匹配，先到先得）。步骤 id 在真实管线里（consistency.selftest 核），
 * fixed-vs-guards 只让它穿过那个步骤之后的纯文字护栏。新登记的文字没写在这里，reg 会直接抛错。
 */
const ORIGINS: readonly (readonly [string, FixedReplyOrigin])[] = Object.freeze([
  ['identity.answer', reply('identity')],
  ['identity.off-topic', reply('injection')],
  ['welcome.', outside('欢迎语由渠道在进入会话时直发，不是回复管线的产物')],
  ['quick-reply.', outside('快捷回复由顾问挑选后人工发出，不经出口护栏')],
  ['handoff.custom-itinerary', reply('custom_promise-b')],
  ['handoff.fallback', reply('injection')],
  ['handoff.', reply('turn_failure')],
  ['fallback.', reply('pre_clean')],
  ['price.rewrite.', reply('price')],
  ['quote.line.', reply('price')],
  ['stranded.', reply('stranded')],
  ['recommend.deterministic', reply('encyclopedia')],
  ['ask.', reply('repair_links:fill')],
  ['order.other-order-ask', reply('other_order')],
  ['order.net.', reply('order_net')],
  ['order.resend.', outside('客户要重发链接时模型前的确定性回复（core/engine 的 preModel 路径），不经出口护栏')],
  ['refund.', outside('售后确定性回复与后台退款通知，在模型回复管线之外')],
  ['payment.paid', outside('到账通知由支付回调直发（core/engine 的 paidText 路径），在回复管线之外')],
  ['payment.pending-reply', reply('claim_words')],
  ['payment.chitchat.', outside('付款后寒暄由模型前的确定性回复直发（preModel 路径），不经出口护栏')],
  ['closing.line', reply('closing')],
  ['replace.claim.', reply('claim_words')],
  ['replace.guard.', reply('unbacked_claims')],
  ['followup.', { pipeline: 'followup', step: null }],
  ['insight.draft.', outside('顾问草稿，由顾问编辑后发出，不经出口护栏')],
]);

/** 登记表里声明过的产出步骤；没声明返回 undefined（自测要求每条都有） */
export function declaredOrigin(id: string): FixedReplyOrigin | undefined {
  return ORIGINS.find(([key]) => (key.endsWith('.') ? id.startsWith(key) : id === key))?.[1];
}

/**
 * 会置 flags.fixedReply 的回复步骤（整段由代码生成，shape_check 不裁、rich 类用 generatedListMaxLines）。
 * 自测对着真实步骤表核这份清单（步骤的 writes 含 fixedReply），免得它和出口各说各话。
 */
export const FIXED_REPLY_STEPS: readonly string[] = Object.freeze(['order_net', 'injection', 'encyclopedia', 'stranded']);

const reg = (
  id: string,
  source: string,
  kind: FixedReply['kind'],
  samples: FixedReply['samples'],
  extra: { afterHandoff?: boolean } = {},
): FixedReply => ({
  id,
  source: `${SRC}/${source}`,
  kind,
  samples, // 没声明的按最严的算（管线开头产出，穿过每道护栏），并由自测点名
  producedBy: declaredOrigin(id) ?? { pipeline: 'reply', step: null },
  ...extra,
  ...(kind === 'rich' && isFixedReplyStep(declaredOrigin(id)) ? { generatedList: true } : {}),
});

function isFixedReplyStep(origin: FixedReplyOrigin | undefined): boolean {
  return !!origin && 'pipeline' in origin && origin.pipeline === 'reply' && !!origin.step && FIXED_REPLY_STEPS.includes(origin.step);
}

export function createTravelFixedReplies(world: World): readonly FixedReply[] {
  const out: FixedReply[] = [];
  const add = (...items: FixedReply[]): void => {
    out.push(...items);
  };
  /** 一种订单与收款方式下的世界 */
  const worldWith = (orders: Order[], pay: 'online' | 'advisor'): TravelParts => {
    const byId = new Map(orders.map((o) => [o.id, o]));
    return world({ getOrder: (id) => byId.get(id), paymentMode: () => pay });
  };

  const refundOrder = fixtureOrder({ id: 'ord_a1b2c3', status: 'paid', paidAt: 0 });
  const quote = quoteRefund(refundOrder, defaultTravelPolicy.refund, 'fixture', '2099-01-14');
  if ('ineligible' in quote) throw new Error('退款固定文字样例不能报价');
  const refundCtx = (m: ModeCtx) => ({ policy: defaultTravelPolicy, brand: m.brand, channel: m.channel });
  add(
    reg(
      'refund.quote',
      'refund-words.ts',
      'rich',
      each((m) => refundQuoteText(refundOrder, quote, refundCtx(m))),
    ),
    reg(
      'refund.choose',
      'refund-words.ts',
      'rich',
      each(() => refundChooseText([refundOrder, fixtureOrder({ id: 'ord_d4e5f6' })])),
    ),
  );
  for (const key of ['done', 'submitted', 'duplicate', 'busy', 'delayed'] as const) {
    add(
      reg(
        `refund.${key}`,
        'refund-words.ts',
        'plain',
        each((m) => refundTexts(quote, refundCtx(m))[key]),
      ),
    );
  }
  add(
    reg(
      'refund.submitted-auto',
      'refund-words.ts',
      'plain',
      each((m) => refundTexts({ ...quote, amount: 10000 }, refundCtx(m)).submitted),
    ),
  );
  for (const settlement of ['mock', 'advisor'] as const) {
    const order: Order = {
      ...refundOrder,
      refund: {
        id: 'rf_000000000001',
        requestedAt: 0,
        daysBefore: quote.daysBefore,
        tierId: quote.tier.id,
        percent: quote.tier.percent,
        amount: quote.amount,
        policyHash: quote.policyHash,
        approval: 'approved',
        settlement,
      },
    };
    for (const kind of ['settled', 'rejected'] as const) {
      add(
        reg(
          `refund.notice.${settlement}.${kind}`,
          'refund-words.ts',
          'plain',
          each((m) => refundNoticeText(order, kind, refundCtx(m))),
        ),
      );
    }
  }

  // ---------------- 身份、欢迎、快捷回复（legacy.ts / templates.ts） ----------------
  add(
    reg(
      'identity.answer',
      'legacy.ts',
      'plain',
      each((m) => brandOrLegacy(m, identityAnswer, travelTemplates.identityAnswer)),
    ),
    reg(
      'identity.off-topic',
      'legacy.ts',
      'plain',
      each((m) => brandOrLegacy(m, offTopicReply, travelTemplates.offTopicReply)),
    ),
    reg(
      'welcome.first',
      'legacy.ts',
      'plain',
      each((m) => brandOrLegacy(m, welcomeText, travelTemplates.welcomeText)),
    ),
    reg(
      'welcome.back',
      'legacy.ts',
      'plain',
      each((m) => brandOrLegacy(m, welcomeBackText, travelTemplates.welcomeBackText)),
    ),
    reg(
      'welcome.web',
      'legacy.ts',
      'plain',
      each((m) => brandOrLegacy(m, webWelcome, travelTemplates.webWelcome)),
    ),
  );
  travelQuickReplyDefaults.forEach((q, i) => {
    add(
      reg(
        `quick-reply.${i}`,
        'quick-reply-defaults.ts',
        'plain',
        each((m) => (m.brand ? renderBrandTemplate(travelTemplates.quickReplies[i]!.body, m.brand) : q.body)),
      ),
    );
  });

  // ---------------- 转人工话术（reply-helpers.ts handoffReply、itinerary.ts、HANDED_OVER_FALLBACK） ----------------
  const handoffCases: {
    id: string;
    kind: 'complaint' | 'refund' | 'request';
    opts?: { identity?: boolean; identityOnly?: boolean };
    order?: 'pending' | 'paid';
    pay?: 'online' | 'advisor';
  }[] = [
    { id: 'handoff.request', kind: 'request' },
    { id: 'handoff.request.identity', kind: 'request', opts: { identity: true } },
    { id: 'handoff.request.identity-only', kind: 'request', opts: { identity: true, identityOnly: true } },
    { id: 'handoff.refund', kind: 'refund' },
    { id: 'handoff.refund.identity', kind: 'refund', opts: { identity: true } },
    { id: 'handoff.complaint', kind: 'complaint' },
    { id: 'handoff.request.order-pending', kind: 'request', order: 'pending', pay: 'online' },
    { id: 'handoff.request.order-pending-advisor', kind: 'request', order: 'pending', pay: 'advisor' },
    { id: 'handoff.request.order-paid', kind: 'request', order: 'paid' },
    { id: 'handoff.refund.order', kind: 'refund', order: 'pending', pay: 'online' },
    { id: 'handoff.complaint.order', kind: 'complaint', order: 'pending', pay: 'online' },
  ];
  for (const c of handoffCases) {
    add(
      reg(
        c.id,
        'reply-helpers.ts',
        'plain',
        each((m) => {
          const order = c.order ? fixtureOrder({ status: c.order === 'paid' ? 'paid' : 'pending_payment' }) : undefined;
          const w = worldWith(order ? [order] : [], c.pay ?? 'online');
          const session = fixtureSession(m, order ? { orderIds: [order.id] } : {});
          return w.helpers.handoffReply(session, '转人工', c.kind, { brand: m.brand, ...c.opts });
        }),
        { afterHandoff: true },
      ),
    );
  }
  add(
    reg('handoff.fallback', 'reply-helpers.ts', 'plain', () => same(world({}).helpers.HANDED_OVER_FALLBACK), { afterHandoff: true }),
    reg('handoff.custom-itinerary', 'itinerary.ts', 'plain', () => same(world({}).turnHooks.customHandoffReply('能改成5天吗')), {
      afterHandoff: true,
    }),
    reg(
      'handoff.custom-itinerary.no-days',
      'itinerary.ts',
      'plain',
      () => same(world({}).turnHooks.customHandoffReply('能不能重新安排一下行程')),
      { afterHandoff: true },
    ),
  );

  // ---------------- 兜底话术（reply-helpers.ts fallbackReply、价格护栏、残句兜底） ----------------
  for (const stage of ['quote', 'objection', 'closing', 'recommend', 'discovery'] as SalesStage[]) {
    add(reg(`fallback.${stage}`, 'reply-helpers.ts', 'plain', () => same(world({}).helpers.fallbackReply(stage))));
  }
  const priceCtx = (m: ModeCtx, w: TravelParts, over: Partial<Session> = {}) => {
    const session = fixtureSession(m, over);
    return { w, session, ctx: { session, text: '多少钱', calls: [], customHandoff: false, templateMode: m.contact.templateMode } };
  };
  const sampleHit = { value: 99999, at: 0, end: 6 };
  add(
    reg(
      'price.rewrite.no-quote',
      'reply-helpers.ts',
      'plain',
      each((m) => {
        const { w, ctx } = priceCtx(m, world({}));
        return w.helpers.rewriteUnbackedPrices('每人 ¥99999 元。', [sampleHit], ctx);
      }),
    ),
    reg(
      'price.rewrite.said-wrong',
      'reply-helpers.ts',
      'plain',
      each((m) => {
        const { w, ctx } = priceCtx(m, world({}), {
          messages: [{ role: 'agent', content: '每人 ¥99999 元。', at: 1 }],
        });
        return w.helpers.rewriteUnbackedPrices('每人 ¥99999 元。', [sampleHit], ctx);
      }),
    ),
    reg(
      'price.rewrite.handed-over',
      'reply-helpers.ts',
      'plain',
      each((m) => {
        const { w, ctx } = priceCtx(m, world({}), { handedOver: true });
        return w.helpers.rewriteUnbackedPrices('每人 ¥99999 元。', [sampleHit], ctx);
      }),
      { afterHandoff: true },
    ),
  );

  // ---------------- 报价（quote-template.ts 与残句兜底 strandedReply） ----------------
  // 报价句用产品库里的一条真实线路、真实算价（定价说明由 quoteFor 给），免得样例和出口词表的季节核对各说各话
  const yuan = (n: number): string => '¥' + n.toLocaleString('zh-CN');
  const nextYear = (): number => new Date().getFullYear() + 1;
  const quoteSample = (when: 'exact' | 'holiday' | 'month' | 'none'): string => {
    const w = world({});
    const route: Route = w.catalog.loadRoutes().find((r) => excludesRoundTripTransport(r.exclusions)) ?? w.catalog.loadRoutes()[0]!;
    const peak = peakMonths(route.bestSeason);
    const onPeak = [...peak][0] ?? 10;
    const offPeak = Array.from({ length: 12 }, (_, i) => i + 1).find((m) => !peak.has(m)) ?? 1;
    const pad = (m: number): string => String(m).padStart(2, '0');
    const at =
      when === 'exact'
        ? `${nextYear()}-${pad(onPeak)}-12`
        : when === 'holiday'
          ? `${nextYear()}-10-03`
          : when === 'month'
            ? `${nextYear()}-${pad(offPeak)}-15`
            : undefined;
    const q = w.catalog.quoteFor(route, { travelers: 2, departDate: at });
    const label = { exact: `${onPeak} 月 12 日出发`, holiday: '国庆出发', month: `${offPeak} 月出发`, none: undefined }[when];
    return renderQuoteLine({
      title: route.title,
      travelers: 2,
      perPerson: q.perPerson,
      total: q.total,
      note: q.note,
      when: label,
      excludesTransport: excludesRoundTripTransport(route.exclusions),
      yuan,
    });
  };
  add(
    reg('quote.line.exact-date', 'quote-template.ts', 'rich', () => same(quoteSample('exact'))),
    reg('quote.line.holiday', 'quote-template.ts', 'rich', () => same(quoteSample('holiday'))),
    reg('quote.line.month', 'quote-template.ts', 'rich', () => same(quoteSample('month'))),
    reg('quote.line.no-date', 'quote-template.ts', 'rich', () => same(quoteSample('none'))),
  );

  /** 残句兜底要用真实产品库里的一条线、真实算价 */
  const strandedCase = (id: string, build: (m: ModeCtx, w: TravelParts) => Promise<string>): FixedReply =>
    reg(
      id,
      'reply-helpers.ts',
      'rich',
      each((m) => build(m, world({}))),
    );
  const runTool =
    (w: TravelParts) =>
    async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name === 'create_quote') {
        const q = w.catalog.createQuote(args as { routeId: string; travelers: number; departDate?: string });
        return JSON.stringify(q);
      }
      if (name === 'search_routes') return JSON.stringify(await w.catalog.searchRoutes(args as { destination: string }));
      return '{}';
    };
  const sayCustomer = (text: string, at = 1): Session['messages'][number] => ({ role: 'customer', content: text, at });
  add(
    strandedCase('stranded.quoted', async (m, w) => {
      const route = w.catalog.loadRoutes()[0]!;
      const args = { routeId: route.id, travelers: 2, departDate: `${nextYear()}-03-10` };
      const quote = w.catalog.createQuote(args);
      const session = fixtureSession(m, {
        messages: [sayCustomer(`${route.destination}两个人，3月10号出发，多少钱`)],
        lastQuote: {
          routeId: route.id,
          routeTitle: route.title,
          travelers: 2,
          perPerson: quote.perPerson,
          total: quote.total,
          departDate: args.departDate,
        },
      });
      return w.helpers.strandedReply({
        session,
        text: '多少钱',
        calls: [{ name: 'create_quote', args, result: JSON.stringify(quote) }],
        runTool: runTool(w),
      });
    }),
    strandedCase('stranded.quoted-no-date', async (m, w) => {
      const route = w.catalog.loadRoutes()[0]!;
      const args = { routeId: route.id, travelers: 2 };
      const quote = w.catalog.createQuote(args);
      const session = fixtureSession(m, { messages: [sayCustomer(`${route.destination}两个人多少钱`)] });
      return w.helpers.strandedReply({
        session,
        text: '多少钱',
        calls: [{ name: 'create_quote', args, result: JSON.stringify(quote) }],
        runTool: runTool(w),
      });
    }),
    strandedCase('stranded.routes.high-altitude', async (m, w) => {
      const high = w.catalog.loadRoutes().find((r) => typeof r.maxAltitude === 'number' && r.maxAltitude >= 2500)!;
      const said = `带爸妈去${high.destination}`;
      const session = fixtureSession(m, { messages: [sayCustomer(said)] });
      return w.helpers.strandedReply({ session, text: said, calls: [], runTool: runTool(w) });
    }),
    strandedCase('stranded.routes', async (m, w) => {
      const route = w.catalog.loadRoutes()[0]!;
      const session = fixtureSession(m, { messages: [sayCustomer(`想去${route.destination}`)] });
      return w.helpers.strandedReply({ session, text: `想去${route.destination}`, calls: [], runTool: runTool(w) });
    }),
    // 残句兜底里本轮已下单的分支：online 与 advisor 两种收款方式（advisor 的联系方式按渲染模式走）
    ...(['online', 'advisor'] as const).map((pay) =>
      reg(
        `stranded.order.${pay}`,
        'reply-helpers.ts',
        'rich',
        each((m) => {
          const w = worldWith([], pay);
          const session = fixtureSession(m, { messages: [sayCustomer('就订这个')] });
          const result = JSON.stringify({ orderId: 'ord_sample1', payUrl: '/pay/ord_sample1', total: 33600 });
          return w.helpers.strandedReply({
            session,
            text: '就订这个',
            calls: [{ name: 'create_order', args: {}, result }],
            runTool: runTool(w),
            templateMode: m.contact.templateMode,
          });
        }),
      ),
    ),
    reg('stranded.lead', 'order-words.ts', 'plain', () => same(STRANDED_LEAD)),
    reg(
      'stranded.ask',
      'reply-helpers.ts',
      'plain',
      each(async (m) => {
        const w = world({});
        const session = fixtureSession(m, { messages: [sayCustomer('你好')] });
        return w.helpers.strandedReply({ session, text: '你好', calls: [], runTool: runTool(w) });
      }),
    ),
    reg(
      'recommend.deterministic',
      'turn.ts',
      'rich',
      each(async (m) => {
        const w = world({});
        const route = w.catalog.loadRoutes()[0]!;
        return (await w.turnHooks.deterministicRecommend(route.destination, fixtureSession(m)))!;
      }),
    ),
  );

  // ---------------- 追问、重发、订单（reply-helpers.ts、turn.ts、order-words.ts） ----------------
  add(
    reg('ask.to-order.no-quote', 'reply-helpers.ts', 'plain', () =>
      same(world({}).helpers.askToOrder(fixtureSession(MODE_CTX[0]!), '就订这个')),
    ),
    reg(
      'ask.to-order.quoted',
      'reply-helpers.ts',
      'plain',
      each((m) => {
        const w = world({});
        const session = fixtureSession(m, {
          lastQuote: { routeId: 'r-sample', routeTitle: '云南 丽江大理 6 日', travelers: 2, perPerson: 16800, total: 33600 },
        });
        return w.helpers.askToOrder(session, '就订这个');
      }),
    ),
    reg('ask.proposal.route', 'reply-helpers.ts', 'plain', () => {
      const w = world({});
      const route = w.catalog.loadRoutes()[0]!;
      return same(w.helpers.askForProposal({ route }, fixtureSession(MODE_CTX[0]!)));
    }),
    reg('ask.proposal.choices', 'reply-helpers.ts', 'plain', () => {
      const w = world({});
      const choices = w.catalog.loadRoutes().slice(0, 2);
      return same(w.helpers.askForProposal({ choices }, fixtureSession(MODE_CTX[0]!)));
    }),
    reg('ask.proposal.none', 'reply-helpers.ts', 'plain', () => same(world({}).helpers.askForProposal({}, fixtureSession(MODE_CTX[0]!)))),
    reg('order.other-order-ask', 'turn.ts', 'plain', () => same(world({}).turnHooks.askOtherOrder(fixtureOrder(), '她们也是两个人'))),
  );
  const orderTexts = (pay: 'online' | 'advisor') => ({
    existing: each((m) =>
      existingOrderText(
        { title: '云南 丽江大理 6 日', travelers: 2, date: '3月10号', total: '¥33,600' },
        { advisor: pay === 'advisor', web: m.channel === 'web', templateMode: m.contact.templateMode, id: 'ord_sample1' },
      ),
    ),
    created: each((m) =>
      createdOrderText(
        { title: '云南 丽江大理 6 日', travelers: 2, date: '3月10号', total: '¥36,960' },
        {
          diff: { before: '¥33,600', date: '3月10号', note: '3月为最佳出行季，价格上浮 10%' },
          replaced: { travelers: 3, date: '3月12号' },
          advisor: pay === 'advisor',
          web: m.channel === 'web',
          templateMode: m.contact.templateMode,
          payUrl: '/pay/ord_sample2',
        },
      ),
    ),
    plain: each((m) =>
      createdOrderText(
        { title: '云南 丽江大理 6 日', travelers: 2, date: '3月10号', total: '¥33,600' },
        { advisor: pay === 'advisor', web: m.channel === 'web', templateMode: m.contact.templateMode, payUrl: '/pay/ord_sample2' },
      ),
    ),
  });
  for (const pay of ['online', 'advisor'] as const) {
    const t = orderTexts(pay);
    add(
      reg(`order.net.existing.${pay}`, 'order-words.ts', 'rich', t.existing),
      reg(`order.net.created.${pay}`, 'order-words.ts', 'rich', t.plain),
      reg(`order.net.created-changed.${pay}`, 'order-words.ts', 'rich', t.created),
    );
  }
  // 重发支付链接（turn.ts preModel）：online、advisor 未确认、advisor 已确认
  const resend = (id: string, pay: 'online' | 'advisor', confirmed: boolean): FixedReply =>
    reg(
      id,
      'turn.ts',
      'plain',
      each((m) => {
        const order = fixtureOrder(confirmed ? { confirmedAt: 1 } : {});
        const w = worldWith([order], pay);
        const session = fixtureSession(m, { orderIds: [order.id] });
        const reply = quietly(() => w.turnHooks.preModel!({ session, text: '链接打不开，再发一下支付链接', brand: m.brand } as never));
        if (!reply) throw new Error(`${id}：preModel 没有重发支付链接`);
        return reply.text;
      }),
    );
  add(
    resend('order.resend.online', 'online', false),
    resend('order.resend.advisor', 'advisor', false),
    resend('order.resend.advisor-confirmed', 'advisor', true),
  );

  // ---------------- 付款通知与付款后寒暄（order-words.ts、contact-words.ts、reply-notes.ts） ----------------
  add(
    reg('payment.paid', 'order-words.ts', 'plain', () => same(paidOrderText(fixtureOrder({ status: 'paid' })))),
    reg(
      'payment.pending-reply',
      'contact-words.ts',
      'plain',
      each((m) => paymentPendingReply(m.contact)),
    ),
  );
  for (const paidNext of [false, true]) {
    for (const turn of [1, 2, 3]) {
      add(
        reg(
          `payment.chitchat.${paidNext ? 'after-paid-next' : 'first'}.${turn}`,
          'reply-notes.ts',
          'plain',
          each((m) => {
            const messages = Array.from({ length: turn }, (_, k) => sayCustomer(`第${k + 1}句`, k));
            const session = fixtureSession(m, { messages, ...(paidNext ? { reminders: { paidNext: 1 } } : {}) });
            return paidChitchatReply(session, m.contact);
          }),
        ),
      );
    }
  }

  // ---------------- 结尾句（closing-words.ts） ----------------
  add(
    reg(
      'closing.line',
      'closing-words.ts',
      'plain',
      each((m) => closingLine(m.contact)),
    ),
  );

  // ---------------- 替换句：护栏换上去的话（claim-words.ts、price-rules.ts） ----------------
  const cw = claimWordsTest();
  add(
    reg('replace.claim.policy', 'claim-words.ts', 'plain', () => same(cw.POLICY_REPLY)),
    reg('replace.claim.visa', 'claim-words.ts', 'plain', () => same(cw.VISA_REPLY)),
    // 07 R4：保险、费用两句口径。第 10 步先作为条款原句进 contextNote；第 11 步的 policy_claims 才拿它换回复，出处到时再改指那一步
    reg('replace.claim.insurance', 'claim-words.ts', 'plain', () => same(cw.INSURANCE_REPLY)),
    reg('replace.claim.fees', 'claim-words.ts', 'plain', () => same(cw.FEES_REPLY)),
    reg('replace.claim.invoice', 'claim-words.ts', 'plain', () => same(cw.INVOICE_REPLY)),
    reg('replace.claim.hotel', 'claim-words.ts', 'plain', () => same(cw.HOTEL_REPLY)),
    reg('replace.claim.media', 'claim-words.ts', 'plain', () => same(cw.MEDIA_REPLY)),
    reg('replace.claim.old-order', 'claim-words.ts', 'plain', () => same(cw.OLD_ORDER_REPLY)),
  );
  // price-rules.ts 的换句住在闭包里，用能触发它的原话让真实护栏吐出来；触发不了就是登记错了，自测会失败
  const viaGuard = (id: string, trigger: string, pay: 'online' | 'advisor' = 'online'): FixedReply =>
    reg(
      id,
      'price-rules.ts',
      'plain',
      each((m) => {
        const w = worldWith([], pay);
        const res = w.priceRules.dropUnbackedClaims(trigger, fixtureSession(m), [], { templateMode: m.contact.templateMode });
        if (res.text === trigger) throw new Error(`${id}：「${trigger}」没有触发换句，登记的触发语要改`);
        return res.text;
      }),
    );
  add(
    viaGuard('replace.guard.invoice', '可以的，我们支持开公司抬头的增值税专用发票。'),
    viaGuard('replace.guard.fund.online', '下单走我们官方支付链接，资金有第三方监管，付款是对公账户。'),
    viaGuard('replace.guard.fund.advisor', '下单走我们官方支付链接，资金有第三方监管，付款是对公账户。', 'advisor'),
    viaGuard('replace.guard.air-ticket', '机票我可以帮您询价一起订。'),
    viaGuard('replace.guard.capacity', '10月30日出发档期没问题。'),
    viaGuard('replace.guard.phone', '好的，已经为您转接资深顾问啦，他会尽快电话联系您～'),
  );

  // ---------------- 主动跟进与顾问草稿兜底（followup.ts、insight.ts） ----------------
  for (const [stage, text] of Object.entries(followupTemplates.byStage)) {
    add(reg(`followup.${stage}`, 'followup.ts', 'plain', () => same(text)));
  }
  add(reg('followup.default', 'followup.ts', 'plain', () => same(followupTemplates.fallback)));
  for (const [stage, text] of Object.entries(insightPrompts.draftFallback)) {
    add(reg(`insight.draft.${stage}`, 'insight.ts', 'plain', () => same(text), { afterHandoff: stage === 'handoff' }));
  }
  return out;
}
