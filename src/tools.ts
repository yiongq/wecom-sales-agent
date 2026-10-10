// 04 R1：旧工具入口仅接线与适配；旅游实现进包，执行注册与钩子进 core。
import { createToolRegistry } from './core/tools/registry.js';
import type { Session, ToolHints } from './core/pack-api.js';
import { createTravelTools } from './packs/travel/tools/index.js';
import { catalogItemAt, catalogVersionKey, configMode, currentCatalog } from './config/source.js';
import { indexReady, semanticRecall } from './retrieval.js';
import { budgetVerdict } from './price-rules.js';
import { createOrder, getOrder, queueJobs, saveSession, supersedeOrder } from './store.js';
import { todayIso } from './env.js';
import { paymentMode } from './payment/mode.js';
import { orderUnconfirmedNotifyOps } from './jobs/notify.js';
import { enterHandoff, HANDOFF_REASON } from './handoff/record.js';

export { toolDefs, type ToolDef } from './tool-defs.js';
export { enterHandoff };
export { peakMonths } from './shared/season.js';
export {
  HANDOFF_NOTE,
  LOWLAND_MAX_ALTITUDE,
  proposalVersionSuffix,
  type SearchRoutesArgs,
  type SearchCtx,
  type Quote,
} from './packs/travel/tools/catalog.js';
export type { ToolHints } from './core/pack-api.js';

const travelTools = createTravelTools({
  modelHandoffReason: HANDOFF_REASON.model,
  catalogItemAt,
  catalogVersionKey,
  configMode,
  currentCatalog,
  indexReady,
  semanticRecall,
  budgetVerdict: (...args) => budgetVerdict(...args),
  createOrder,
  getOrder,
  queueJobs,
  saveSession,
  supersedeOrder,
  todayIso,
  paymentMode,
  orderUnconfirmedNotifyOps,
  enterHandoff,
});
const registry = createToolRegistry(travelTools.tools);

export function loadRoutes(...args: Parameters<typeof travelTools.loadRoutes>): ReturnType<typeof travelTools.loadRoutes> {
  return travelTools.loadRoutes(...args);
}

export function loadHotels(...args: Parameters<typeof travelTools.loadHotels>): ReturnType<typeof travelTools.loadHotels> {
  return travelTools.loadHotels(...args);
}

export function routeVersion(...args: Parameters<typeof travelTools.routeVersion>): ReturnType<typeof travelTools.routeVersion> {
  return travelTools.routeVersion(...args);
}

export function routeForProposal(
  ...args: Parameters<typeof travelTools.routeForProposal>
): ReturnType<typeof travelTools.routeForProposal> {
  return travelTools.routeForProposal(...args);
}

export function searchHotels(...args: Parameters<typeof travelTools.searchHotels>): ReturnType<typeof travelTools.searchHotels> {
  return travelTools.searchHotels(...args);
}

export function catalogCovers(...args: Parameters<typeof travelTools.catalogCovers>): ReturnType<typeof travelTools.catalogCovers> {
  return travelTools.catalogCovers(...args);
}

export function mentionsPlace(...args: Parameters<typeof travelTools.mentionsPlace>): ReturnType<typeof travelTools.mentionsPlace> {
  return travelTools.mentionsPlace(...args);
}

export function offCatalogPlaces(
  ...args: Parameters<typeof travelTools.offCatalogPlaces>
): ReturnType<typeof travelTools.offCatalogPlaces> {
  return travelTools.offCatalogPlaces(...args);
}

export function isOriginMention(...args: Parameters<typeof travelTools.isOriginMention>): ReturnType<typeof travelTools.isOriginMention> {
  return travelTools.isOriginMention(...args);
}

export function visitedDestinations(
  ...args: Parameters<typeof travelTools.visitedDestinations>
): ReturnType<typeof travelTools.visitedDestinations> {
  return travelTools.visitedDestinations(...args);
}

export function searchRoutes(...args: Parameters<typeof travelTools.searchRoutes>): ReturnType<typeof travelTools.searchRoutes> {
  return travelTools.searchRoutes(...args);
}

export function createQuote(...args: Parameters<typeof travelTools.createQuote>): ReturnType<typeof travelTools.createQuote> {
  return travelTools.createQuote(...args);
}

export function quoteFor(...args: Parameters<typeof travelTools.quoteFor>): ReturnType<typeof travelTools.quoteFor> {
  return travelTools.quoteFor(...args);
}

export function rememberShownRoutes(
  ...args: Parameters<typeof travelTools.rememberShownRoutes>
): ReturnType<typeof travelTools.rememberShownRoutes> {
  return travelTools.rememberShownRoutes(...args);
}

export function rememberSeenRoutes(
  ...args: Parameters<typeof travelTools.rememberSeenRoutes>
): ReturnType<typeof travelTools.rememberSeenRoutes> {
  return travelTools.rememberSeenRoutes(...args);
}

export async function executeTool(name: string, args: Record<string, unknown>, session: Session, hints: ToolHints = {}): Promise<string> {
  return registry.execute(name, args, { session, hints });
}
