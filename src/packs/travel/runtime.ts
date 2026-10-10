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
import { hardRequirements } from './legacy.js';

const thresholds = { ...travelPriceThresholds, dates: travelDateThresholds, search: travelSearchThresholds };
interface TravelRuntimeTypes extends PackRuntimeTypes {
  PackThresholds: typeof thresholds;
}

export function createTravelRuntime(sources: PackSources) {
  // tools → rules → guard → tools：只注入延后调用的能力，不在装载时读目录或预算。
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
  const helpers = createTravelReplyHelpers({
    ...sources,
    ...catalog,
    turnHooks,
    priceGuard,
    extractProfile: (session, calls, text) => ({ ...session.profile, ...extractProfile(text, session, calls) }),
  });
  const dejargon = (text: string, sessionId: string) => cleanJargon(text, sessionId, dejargonVocab);
  const runtime: PackRuntime<TravelRuntimeTypes> = {
    id: 'travel',
    defaultBrand: {
      brandName: '云途定制旅行',
      advisorTitle: '旅行顾问',
      aiTitle: 'AI 旅行顾问',
      scopeNoun: '旅行',
      identityLine: helpers.IDENTITY_ANSWER.replace(/～$/, ''),
    },
    legacy: {
      hardRequirements,
      identityAnswer: helpers.IDENTITY_ANSWER,
      resetReply: '好的，我们重新开始～这次想去哪儿玩呢？😊',
      resetDisabledReply: '想换方向或改订单，直接告诉我新的需求就行～',
      handoffFallback: helpers.HANDED_OVER_FALLBACK,
    },
    templates: undefined,
    sopSections: [...TRAVEL_SOP_SECTIONS],
    contractRules: () => [...SOP_CONTRACT],
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
    replyAnchors: { markdown: 'link_whitelist', dangling: 'adults', 'takeover_check:post': 'proposal_suffix' },
    replySteps: travelReplySteps({
      helpers,
      turnHooks,
      priceGuard,
      priceRules,
      getOrder: sources.getOrder,
      paymentMode: sources.paymentMode,
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
      },
      paidText: (order) =>
        `已收到您的支付，太开心啦 🎉\n《${order.routeTitle}》${order.travelers} 位出行、` +
        `${order.departDate} 出发已确认预订。\n专属旅行顾问稍后会与您对接行程细节和出行准备，` +
        `有任何想法随时跟我说～`,
    },
    vocab: { handoff: handoffVocab, dejargon: dejargonVocab },
    thresholds,
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
  };
  return { runtime, catalog, priceGuard, priceRules, turnHooks, helpers };
}
