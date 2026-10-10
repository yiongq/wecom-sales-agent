import './core/engine/sources.js';
// 04 R1：旧价格入口只接线和转发，旅游金额出处裁决在包内。
import { legacyTravelRuntime } from './config/source.js';

export type { Scope, TurnToolCall, PriceHit } from './packs/travel/price-guard.js';
export { sentenceUnits } from './core/parse/sentences.js';

export const {
  spokenMoney,
  routeNames,
  namedRoutes,
  findUnbackedPrices,
  findUnbackedPriceHits,
  priceMentions,
  saidBefore,
  dropSentences,
  strandedAfterDrop,
  __priceGuardTest,
} = legacyTravelRuntime().priceGuard;
