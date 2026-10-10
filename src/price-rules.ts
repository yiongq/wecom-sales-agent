import './core/engine/sources.js';
// 04 R1：旧规则入口只接线和转发，预算、季节与服务规则在旅游包内。
import { legacyTravelRuntime } from './config/source.js';

export type { BudgetCap } from './packs/travel/price-rules.js';

export const { BUDGET_LIFTED, liftsBudget, budgetCap, budgetVerdict, dropUnbackedClaims, __priceRulesTest } =
  legacyTravelRuntime().priceRules;
