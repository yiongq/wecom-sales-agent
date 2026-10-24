// 旅游运行时：把既有工厂装成一个包，核心只消费 pack-api 契约。
import {
  dejargon as cleanJargon,
  stripMarkdown,
  trimDangling,
  stripAdvisorPrefix,
  type PackRuntime,
  type PackRuntimeTypes,
  type PackSources,
  type TurnToolCall,
  type Session,
  type ShapePolicy,
} from '../../core/pack-api.js';
import { createTravelTools } from './tools/index.js';
import { createTravelPriceGuard } from './price-guard.js';
import { createTravelPriceRules } from './price-rules.js';
import { createTravelTurnHooks } from './turn.js';
import { createTravelReplyHelpers } from './reply-helpers.js';
import { advanceStage, createTravelProfileExtractor } from './progress.js';
import { travelReplySteps } from './reply-steps.js';
import { travelFollowupSteps } from './followup-steps.js';
import { dejargonVocab } from './dejargon-vocab.js';
import { handoffVocab } from './handoff-vocab.js';
import { travelPriceThresholds, travelDateThresholds, travelSearchThresholds } from './thresholds.js';
import { runtimeStages } from './stages.js';
import { TRAVEL_SOP_SECTIONS, SOP_CONTRACT, knownFields } from './sop.js';
import { followupTemplates } from './followup.js';
import { insightPrompts } from './insight.js';
import { retrievalText } from './retrieval.js';
import { retrievalEmpty } from './retrieval-empty.js';
import { travelMock } from './mock.js';
import * as legacy from './legacy.js';
import { demoBrand } from './demo-brand.js';
import { travelTemplates } from './templates.js';
import { travelQuickReplyDefaults } from './quick-reply-defaults.js';
import { createTravelShapePolicy } from './shape-words.js';
import { createTravelConsistency } from './consistency.js';
import { refundQuoteText, refundChooseText, refundTexts, refundNoticeText } from './refund-words.js';
import { paidOrderText } from './order-words.js';
import { travelPolicy } from './policy.js';
import { policyViolations } from './policy-lint.js';
import { createTravelAfterSales } from './after-sales.js';
import { CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, REPRICE_FIELDS, type CatalogKindSpec } from '../../core/pack-api.js';

const thresholds = { ...travelPriceThresholds, dates: travelDateThresholds, search: travelSearchThresholds };
interface TravelRuntimeTypes extends PackRuntimeTypes {
  PackThresholds: typeof thresholds & { shape: ShapePolicy };
}

/** 把工厂串起来：tools → rules → guard → tools 只注入延后调用的能力，不在装载时读目录或预算。一致性检查用换了订单和收款方式的来源再串一份 */
function assemble(sources: PackSources) {
  const catalog = createTravelTools({ ...sources, budgetVerdict: (...args) => priceRules.budgetVerdict(...args) });
  const priceGuard = createTravelPriceGuard({ ...sources, ...catalog });
  const priceRules = createTravelPriceRules({ ...sources, ...catalog }, priceGuard);
  const turnHooks = createTravelTurnHooks({ ...sources, ...catalog, ...priceGuard, ...priceRules });
  function extractProfile(text: string, session: Session, calls: readonly TurnToolCall[] = []) {
    return createTravelProfileExtractor({
      loadRoutes: catalog.loadRoutes,
      toolCalls: () => calls,
      isMonthOnly: turnHooks.isMonthOnly,
      todayIso: sources.todayIso,
      liftsBudget: priceRules.liftsBudget,
      budgetLifted: priceRules.BUDGET_LIFTED,
    }).extractProfile(text, session);
  }
  const runtimeThresholds = {
    ...thresholds,
    shape: createTravelShapePolicy({
      PRICE_ASK: turnHooks.PRICE_ASK,
      ORDER_DEFERRED: turnHooks.ORDER_DEFERRED,
      QUOTE_ONLY: turnHooks.QUOTE_ONLY,
      ORDER_QUESTION: turnHooks.ORDER_QUESTION,
      PRICE_OK: turnHooks.PRICE_OK,
    }),
  };
  const helpers = createTravelReplyHelpers({
    ...sources,
    ...catalog,
    turnHooks,
    priceGuard,
    extractProfile: (session, calls, text) => ({ ...session.profile, ...extractProfile(text, session, calls) }),
  });
  const dejargon = (text: string, sessionId: string) => cleanJargon(text, sessionId, dejargonVocab);
  return { catalog, priceGuard, priceRules, turnHooks, extractProfile, runtimeThresholds, helpers, dejargon };
}

export type TravelParts = ReturnType<typeof assemble>;

export function createTravelRuntime(sources: PackSources) {
  const { catalog, priceGuard, priceRules, turnHooks, extractProfile, runtimeThresholds, helpers, dejargon } = assemble(sources);
  // R21：样例要在假订单、另一种收款方式下渲染，所以每次按换过的来源再串一份
  const consistency = createTravelConsistency((over) => assemble({ ...sources, ...over }));
  const runtime: PackRuntime<TravelRuntimeTypes> = {
    id: 'travel',
    catalog: {
      route: {
        // 旧版 Route/Hotel 接口没有索引签名；schema 本身仍是同一个对象。
        schema: CATALOG_SCHEMAS.route as unknown as CatalogKindSpec['schema'],
        titleKey: 'title',
        lockedWhenActive: LOCKED_WHEN_ACTIVE.route,
        repriceFields: REPRICE_FIELDS.route,
        moneyFields: [{ path: 'priceFrom', decimals: 0 }],
        retrieval: true,
      },
      hotel: {
        schema: CATALOG_SCHEMAS.hotel as unknown as CatalogKindSpec['schema'],
        titleKey: 'name',
        lockedWhenActive: LOCKED_WHEN_ACTIVE.hotel,
        repriceFields: REPRICE_FIELDS.hotel,
        moneyFields: [{ path: 'nightlyFrom', decimals: 0 }],
        retrieval: false,
      },
    },
    catalogStartupCheck: (snapshot) => (snapshot.routes.length ? null : '没有 active 的线路'),
    policy: { ...travelPolicy, lint: policyViolations },
    defaultBrand: demoBrand,
    legacy: {
      ...legacy,
      quickReplies: travelQuickReplyDefaults,
      identityAnswer: helpers.IDENTITY_ANSWER,
      resetReply: '好的，我们重新开始～这次想去哪儿玩呢？😊',
      resetDisabledReply: '想换方向或改订单，直接告诉我新的需求就行～',
      handoffFallback: helpers.HANDED_OVER_FALLBACK,
    },
    templates: travelTemplates,
    sopSections: [...TRAVEL_SOP_SECTIONS],
    contractRules: (mode) => [
      ...SOP_CONTRACT.map((rule) =>
        mode !== 'legacy' && rule.id === 'advisor-on-wechat' && rule.kind === 'include' ? { ...rule, text: '顾问会联系您' } : rule,
      ),
      // 08 R10：模板模式下，代码所有的固定内容（锁定节与硬性要求）里不能出现旧品牌名（档案本身允许的品牌名除外）。
      // id 以 brand-fixed: 开头的 exclude 规则只查这部分，不查整段渲染结果，核心不再写死这个词。
      ...(mode === 'legacy'
        ? []
        : [{ id: 'brand-fixed:legacy-brand', kind: 'exclude' as const, text: '云途', from: '模板模式的固定要求不带旧品牌名' }]),
    ],
    knownFields,
    stages: runtimeStages,
    tools: catalog.tools,
    beforeTool: turnHooks.beforeTool,
    afterTool: turnHooks.afterTool,
    extractProfile,
    advanceStage,
    prefetch: turnHooks.prefetch,
    contextNote: turnHooks.contextNote,
    preModel: turnHooks.preModel,
    replyAnchors: { markdown: 'link_whitelist', dangling: 'adults', shape_check: 'closing', 'takeover_check:post': 'shape_check' },
    replySteps: travelReplySteps({
      helpers,
      turnHooks,
      priceGuard,
      priceRules,
      loadRoutes: catalog.loadRoutes,
      getOrder: sources.getOrder,
      paymentMode: sources.paymentMode,
      isConfigNotReadyError: sources.isConfigNotReadyError,
      dejargon,
      handoffReasons: sources.handoffReasons,
    }),
    followupSteps: travelFollowupSteps({
      helpers,
      turnHooks,
      priceGuard,
      priceRules,
      dejargon,
      stripMarkdown,
      trimDangling,
      stripAdvisorPrefix,
    }),
    engineHooks: {
      afterSales: createTravelAfterSales(sources, (input) =>
        helpers.handoffReply(input.session, input.text, 'refund', { brand: input.brand }),
      ),
      isComplaint: turnHooks.isComplaint,
      isHandoffIntent: turnHooks.isHandoffIntent,
      safetyNetKind: helpers.safetyNetKind,
      handoffReply: helpers.handoffReply,
      departNoteForHandoff: turnHooks.departNoteForHandoff,
      fallbackReply: helpers.fallbackReply,
      hintsFor: turnHooks.hintsFor,
      withNotes: turnHooks.withNotes,
      modelRequestedHandoff: (calls) => calls.some((c) => c.name === 'handoff_to_human'),
      retrievalEmpty,
      createOrderTool: 'create_order',
      resetSession(session) {
        session.lastQuote = undefined;
        session.quoteHistory = undefined;
        session.budgetGaps = undefined;
        session.lastShownRoutes = undefined;
        session.seenRouteIds = undefined;
        session.missedDestinations = undefined;
        session.reminders = undefined;
        session.recommendedRoutes = undefined;
        delete session.afterSale;
      },
      paidText: paidOrderText,
      refund: { quoteText: refundQuoteText, chooseText: refundChooseText, texts: refundTexts, noticeText: refundNoticeText },
    },
    vocab: { handoff: handoffVocab, dejargon: dejargonVocab },
    thresholds: runtimeThresholds,
    retrievalText,
    retrievalItems: () =>
      catalog.loadRoutes().map((route, ord) => ({
        kind: 'route',
        code: route.id,
        ord,
        status: 'active',
        rev: 1,
        payload: route,
        updatedByName: null,
        updatedAt: '',
      })),
    retrievalCacheFile: 'route-vectors.json',
    followupTemplates,
    insightPrompts,
    mock: travelMock,
    fixedReplies: consistency.fixedReplies,
    consistencyRules: consistency.rules,
  };
  return { runtime, catalog, priceGuard, priceRules, turnHooks, helpers, consistency };
}
