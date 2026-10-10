// R1：永久兼容门面，只转发核心入口与适配旧版旅游测试能力。
export {
  handleMessage,
  historyWindow,
  inboundText,
  trimSessionMessages,
  replyMessageOf,
  onToolCall,
  sopFileText,
  promptPrefix,
  notifyPaid,
  guardOutbound,
  __triggerTest,
} from './core/engine/index.js';
export type { HandleOpts, ToolCallMeta } from './core/engine/index.js';
import { buildSystemPrompt } from './core/engine/index.js';
import { legacyTravelRuntime } from './config/source.js';
import { dejargon as coreDejargon } from './core/guards/dejargon.js';
import { saysDay } from './core/parse/dates.js';
import { trimDangling, IDENTITY_QUESTION } from './core/guards/text.js';
import { CUSTOM_PROMISE } from './packs/travel/itinerary.js';
import { BUDGET_RE, detectSegment, isBudgetTalk, isObjection } from './packs/travel/progress.js';

const { runtime, turnHooks, helpers: replyHelpers } = legacyTravelRuntime();
const dejargon = (text: string, sessionId: string) => coreDejargon(text, sessionId, runtime.vocab.dejargon);
const {
  PURCHASE_INTENT,
  OTHER_ORDER,
  RESEND_ASK,
  BUDGET_FLOOR,
  haggling,
  requestedDays,
  isHandoffIntent,
  statedPastDate,
  spokenDepartDate,
  latestDepart,
  resolveDepartDate,
  monthSaid,
  departNoteForHandoff,
  planPrefetch,
  perPersonBudget,
  planDetailPrefetch,
  quoteTimingNote,
  routeInFocus,
  routesIn,
  toolHints,
} = turnHooks;
const {
  keptBesideCustomPromise,
  PROPOSAL_PROMISE,
  LINK_PROMISE,
  markLinkHoles,
  promiseInsertAt,
  restoreProposalSuffixes,
  dropProposalOffers,
  claimsTransfer,
} = replyHelpers;

/** 仅供自测：订单与转人工这组判定 */
export const __orderTest = { haggling, OTHER_ORDER, RESEND_ASK, claimsTransfer, saysDay, trimDangling, monthSaid };

/** 仅供自测使用的内部函数出口 */
export const __engineTest = {
  dejargon,
  restoreProposalSuffixes,
  CUSTOM_PROMISE,
  LINK_PROMISE,
  PROPOSAL_PROMISE,
  promiseInsertAt,
  markLinkHoles,
  requestedDays,
  isObjection,
  PURCHASE_INTENT,
  IDENTITY_QUESTION,
  detectSegment,
  isHandoffIntent,
  keptBesideCustomPromise,
  statedPastDate,
  BUDGET_RE,
  planPrefetch,
  perPersonBudget,
  buildSystemPrompt,
  spokenDepartDate,
  isBudgetTalk,
  BUDGET_FLOOR,
  departNoteForHandoff,
  planDetailPrefetch,
  quoteTimingNote,
  routeInFocus,
  routesIn,
  toolHints,
  dropProposalOffers,
  resolveDepartDate,
  latestDepart,
};
