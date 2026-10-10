// 04 R1：旧规则入口只接线和转发，预算、季节与服务规则在旅游包内。
import { dropSentences, namedRoutes, priceMentions, routeNames, spokenMoney } from './price-guard.js';
import { loadRoutes, mentionsPlace } from './tools.js';
import { getOrder } from './store.js';
import { ConfigNotReadyError } from './config/source.js';
import { paymentMode } from './payment/mode.js';
import { createTravelPriceRules } from './packs/travel/price-rules.js';

export type { BudgetCap } from './packs/travel/price-rules.js';

export const { BUDGET_LIFTED, liftsBudget, budgetCap, budgetVerdict, dropUnbackedClaims, __priceRulesTest } = createTravelPriceRules(
  {
    loadRoutes,
    mentionsPlace,
    getOrder,
    paymentMode,
    isConfigNotReadyError: (error) => error instanceof ConfigNotReadyError,
  },
  {
    // tools → rules → guard → tools 的旧循环：加载时只装转发函数，调用时再读取护栏出口。
    dropSentences: (...args) => dropSentences(...args),
    namedRoutes: (...args) => namedRoutes(...args),
    priceMentions: (...args) => priceMentions(...args),
    routeNames: (...args) => routeNames(...args),
    spokenMoney: (...args) => spokenMoney(...args),
  },
);
