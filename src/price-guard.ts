// 04 R1：旧价格入口只接线和转发，旅游金额出处裁决在包内。
import { isOriginMention, loadHotels, loadRoutes, mentionsPlace, offCatalogPlaces } from './tools.js';
import { getOrder } from './store.js';
import { ConfigNotReadyError } from './config/source.js';
import { createTravelPriceGuard } from './packs/travel/price-guard.js';

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
} = createTravelPriceGuard({
  isOriginMention,
  loadHotels,
  loadRoutes,
  mentionsPlace,
  offCatalogPlaces,
  getOrder,
  isConfigNotReadyError: (error) => error instanceof ConfigNotReadyError,
});
