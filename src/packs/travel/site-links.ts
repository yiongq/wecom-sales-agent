import type { SiteLinkDef } from '../../core/pack-api.js';
import type { TravelParts } from './runtime.js';

/** 方案版本读取仍在旅游包，核心只消费卡片文字。 */
export function travelSiteLinks(catalog: TravelParts['catalog']): readonly SiteLinkDef[] {
  return [
    {
      linkKind: 'proposal',
      pattern: /^\/proposal\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/,
      resources: [{ pattern: /^\/api\/proposal\/[A-Za-z0-9_-]+$/, methods: ['GET', 'HEAD'] }],
      allowed(_session, path) {
        const m = /^\/proposal\/([A-Za-z0-9_-]+)\/(\d+)(?:\/([\d-]+))?(?:\?v=(\d+))?$/.exec(path);
        return !!m && !!catalog.routeForProposal(m[1]!, m[4]);
      },
      card(path) {
        const m = /^\/proposal\/([A-Za-z0-9_-]+)\/(\d+)(?:\/([\d-]+))?(?:\?v=(\d+))?$/.exec(path);
        if (!m) return null;
        const route = catalog.routeForProposal(m[1]!, m[4]);
        if (!route) return null;
        return {
          title: `${route.title} · 行程方案书`,
          desc: `${route.days} 天 · ${Number(m[2])} 位出行 · ${route.hotelLevel}｜含逐日行程与费用说明`,
        };
      },
    },
  ];
}
