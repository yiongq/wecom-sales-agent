// 产品库条目的类型（01 spec「模块与依赖方向」）：前后端共用，本目录只能 import zod 与 src/shared/**。
// types.ts 再导出这里的类型，原有的 import 不用改。

/** 客群五分类。高端定制旅行行业通行分法 */
export type SalesSegment = '家庭' | '亲子' | '蜜月' | '商务' | '银发';
export const SALES_SEGMENTS: SalesSegment[] = ['家庭', '亲子', '蜜月', '商务', '银发'];

/** data/routes.json 的条目结构 */
export interface Route {
  id: string;
  title: string;
  destination: string;
  days: number;
  priceFrom: number; // 每人起价，元
  hotelLevel: string; // 如「五星/奢华度假村」
  bestSeason: string;
  highlights: string[];
  tags: string[]; // 如「蜜月」「亲子」「海岛」
  /** 适配客群。高端定制旅行普遍按家庭/亲子/蜜月/商务/银发五类讲产品，这是独立于
   *  自由标签的一个维度：银发看的是海拔与节奏，商务看的是天数与场面，不能混在 tags 里。 */
  segments: SalesSegment[];
  /** 目的地别名：客户/模型常用、但标题和 destination 里都没有的叫法（海南→三亚、川西→四川）。
   *  search_routes 与引擎的目的地识别共用，只放这条线真正覆盖的地方，不做模糊扩写 */
  aliases?: string[];
  /** 全程到达的最高海拔（米），逐条按行程核过：行程里写了数的照写（「四千五百米观景台」），
   *  没写数的按该地公认海拔（那根拉山口 5190、斯芬克斯观景台 3571）。
   *  银发的适配标签管不到单日的索道和垭口——丽江大理线打着银发标签，第 2 天冰川大索道照样上 4500 米——
   *  给长辈挑「全程低海拔」的替代线路时只认这个数（见 tools.ts lowlandAlternatives） */
  maxAltitude?: number;
  /** 体力强度，逐条按 itinerary 核过：level 看最累的那一天（轻松 = 以车览、酒店、城市漫步为主；
   *  适中 = 有成段的景区步道、索道上高处、骑行骑马；较累 = 数小时徒步、野长城、长途越野连着几天）；
   *  hardest 照行程原文概括最累的那几段，行程没写的步行量就写「行程没写」。
   *  银发标签和海拔都管不到腿脚——北京线打着银发标签、最高才 1150 米，第 3 天却是三小时野长城（见 tools.ts intensityNote） */
  intensity?: { level: '轻松' | '适中' | '较累'; hardest: string };
  /** 逐日行程。定制旅行的核心交付物是行程书，不能让模型凭 highlights 现编 */
  itinerary?: { day: number; title: string; detail: string; hotel: string; meals: string }[];
  inclusions?: string[];
  exclusions?: string[];
  /** 境外线路。data/routes.json 每条都写了；foreign() 靠它区分境内外，境内外过滤与价格护栏认线路都用它 */
  overseas?: boolean;
}

/** data/hotels.json 的条目结构（独立酒店库，供酒店推荐） */
export interface Hotel {
  id: string;
  name: string;
  destination: string;
  stars: string; // 如「五星」「奢华」
  nightlyFrom: number; // 每晚起价，元
  roomType: string; // 主推房型，如「水上别墅」「海景套房」
  highlights: string[];
  tags: string[]; // 如「蜜月」「亲子」「一价全包」
}
