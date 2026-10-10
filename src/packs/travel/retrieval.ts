// 旅游线路的 embedding 文本；原拼接顺序与字节保持不变。
import type { CatalogItem, Route } from '../../core/pack-api.js';

export function routeText(r: Route): string {
  return [r.title, r.destination, `${r.days}天`, r.hotelLevel, `适合${r.tags.join('、')}`, `最佳季节${r.bestSeason}`, ...r.highlights].join(
    '。',
  );
}

/** 当前语义索引只处理线路；目录入口供 PackRuntime.retrievalText 使用。 */
export function retrievalText(item: CatalogItem): string {
  return routeText(item.payload as Route);
}
