// function calling 工具集：定义（JSON Schema）+ 实现。
// routes.json 由数据模块产出，这里只在调用时用 fs 读取（不 import），
// 缺失时抛清晰错误；ROUTES_PATH 仅供测试指向 fixture，默认 data/routes.json。
import fs from 'node:fs';
import path from 'node:path';
import type { Hotel, Route, SalesSegment, SalesStage, Session } from './types.js';
import { SALES_SEGMENTS } from './types.js';
import { peakMonths } from './shared/season.js';
import { deepFreeze } from './shared/freeze.js';
import { mentionsPlace, OFF_CATALOG_GROUPS, type PlaceKind } from './shared/places.js';
import { configMode, currentCatalog } from './config/source.js';
import { indexReady, semanticRecall } from './retrieval.js';
import { budgetVerdict } from './price-rules.js';
import { createOrder, getOrder, saveSession, supersedeOrder } from './store.js';
import { todayIso } from './env.js';

// 工具定义是纯数据，搬到 tool-defs.ts：配置层要用它算 tools_hash、核对 SOP 点名的工具，又不能 import 本模块（本模块加载时就读 var/）
export { toolDefs, type ToolDef } from './tool-defs.js';

function routesPath(): string {
  return process.env.ROUTES_PATH ?? path.join(process.cwd(), 'data', 'routes.json');
}

// 返回的对象递归冻结（01 spec「快照」）：类型仍是 Route[]，写入在运行时抛 TypeError，调用方要排序、改字段先拷贝。
// DB 模式直接返回配置源快照里的数组本身，不拷贝、不查库；文件模式每次重新读文件
export function loadRoutes(): Route[] {
  if (configMode() === 'db') return currentCatalog().routes as Route[];
  const p = routesPath();
  if (!fs.existsSync(p)) {
    throw new Error(`线路数据缺失: ${p} 不存在（应由 data/routes.json 提供，见 SPEC 模块 1）`);
  }
  try {
    return deepFreeze(JSON.parse(fs.readFileSync(p, 'utf8')) as Route[]);
  } catch (e) {
    // 手工编辑线路数据改坏 JSON 是高概率事故，报错必须能直接定位到文件
    throw new Error(`线路数据 ${p} 解析失败（JSON 语法错误，请检查最近的手工修改）: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}

function hotelsPath(): string {
  return process.env.HOTELS_PATH ?? path.join(process.cwd(), 'data', 'hotels.json');
}

export function loadHotels(): Hotel[] {
  if (configMode() === 'db') return currentCatalog().hotels as Hotel[];
  const p = hotelsPath();
  if (!fs.existsSync(p)) return deepFreeze([] as Hotel[]); // 酒店库可选：缺失时 search_hotels 返回空，不影响主流程；空数组同样冻结
  try {
    return deepFreeze(JSON.parse(fs.readFileSync(p, 'utf8')) as Hotel[]);
  } catch (e) {
    throw new Error(`酒店数据 ${p} 解析失败（JSON 语法错误，请检查最近的手工修改）: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}

export function searchHotels(args: { destination?: string; tags?: string[]; maxNightlyPrice?: number }): Hotel[] {
  let list = loadHotels();
  if (args.destination) {
    const q = args.destination;
    list = list.filter((h) => h.destination.includes(q) || q.includes(h.destination) || h.name.includes(q));
  }
  if (args.tags?.length) {
    list = list.filter((h) => args.tags!.some((t) => h.tags.some((ht) => ht.includes(t))));
  }
  if (args.maxNightlyPrice) {
    list = list.filter((h) => h.nightlyFrom <= args.maxNightlyPrice!);
  }
  return list.toSorted((a, b) => a.nightlyFrom - b.nightlyFrom).slice(0, 3);
}

/** 线路摘要（给 LLM 的搜索结果，避免整条塞爆上下文） */
function summarize(r: Route) {
  return {
    id: r.id,
    title: r.title,
    destination: r.destination,
    days: r.days,
    priceFrom: r.priceFrom,
    hotelLevel: r.hotelLevel,
    bestSeason: r.bestSeason,
    tags: r.tags,
    segments: r.segments,
    // 每条都带：海拔提醒（altitudeNote）只在认出长辈、高反时才附，其余时候模型被问到「高不高」手里也得有个数，
    // 不然就凭印象说「九寨沟两三千米」，漏掉黄龙索道那一段 3500
    maxAltitude: r.maxAltitude,
    highlights: r.highlights.slice(0, 3),
  };
}

/**
 * 预算滤空后放宽的倍数。1.5 是「值得开口谈」与「离谱」之间的分界：
 * 客户说两万、给他看 26,800（+34%）是一次正常的降档/加预算对话；
 * 给他看 68,800（+244%）只会让人觉得没在听。放宽后仍为空时不再兜底，
 * 直接按价格升序把最便宜的几条交给模型去如实解释。
 */
const BUDGET_RELAX = 1.5;

/**
 * 目的地关键词是否指向这条线。destination / 标题 / 标签 / 别名四处都要看：
 * 只看前两处时，搜「九寨沟」查不到库里唯一的九寨线（标题写的是「九寨黄龙」，
 * 「九寨沟」只在标签里），搜「海南」也查不到三亚——模型按 SOP 把客户原话当目的地
 * 传进来，拿到空结果就会告诉客户「暂时没有」，而库里明明有货。
 *
 * 别名按整词认：关键词就是这个别名，或把整个别名包在里面（「马代蜜月」）。此前双向子串匹配，
 * 「印度」是「印度尼西亚」的一截，search_routes(印度) 返回巴厘岛且不标 destinationMiss——
 * 模型 4/4 自己兜住了，但价格护栏会把巴厘岛的价当作「印度线」放行。
 * 空白先去掉再认（模型会传「丽江 大理」，此前判成库外，工具让模型对客户说「没有丽江 大理线路」）；
 * 去掉还对不上、又是几处拼在一起的（「大理 丽江」「四川、云南」），任一处对得上就算。
 * 目的地、别名、关键词是另一个更长地名的一截时按地名表的边界认（mentionsPlace）：后台建一条「北海」线之后，
 * 此前 k.includes(destination) 让 search_routes(北海道) 把它当成北海道线返回、不标 destinationMiss
 */
function matchesDestination(r: Route, q: string): boolean {
  const hit = (k: string): boolean =>
    !!k &&
    (mentionsPlace(r.destination, k) ||
      mentionsPlace(k, r.destination) ||
      mentionsPlace(r.title.replace(/\s+/g, ''), k) ||
      r.tags.some((t) => mentionsPlace(t, k)) ||
      (r.aliases ?? []).some((a) => a === k || mentionsPlace(k, a)));
  if (hit(q.replace(/\s+/g, ''))) return true;
  const parts = q.split(/[\s、，,/／;；]+/).filter(Boolean);
  return parts.length > 1 && parts.some(hit);
}

export interface SearchRoutesArgs {
  query?: string;
  destination?: string;
  tags?: string[];
  segment?: SalesSegment;
  maxBudgetPerPerson?: number;
  days?: number;
}

/**
 * 「全程低海拔」的上限（米）。高原反应一般从 2500 米上下开始出现，给长辈挑替代线路按这条线卡，
 * 比银发标签严：丽江大理（冰川大索道 4500 米）、九寨黄龙（黄龙索道 3500 米）都打着银发标签，
 * 刚以海拔为由劝退西藏，转头把它们当「海拔友好」推出去就是自相矛盾（实测说过香格里拉「海拔温和」，那条要翻 4200 米垭口）。
 */
export const LOWLAND_MAX_ALTITUDE = 2500;

/** 国内几大片区。替代线路先挑同一片区的：想去西藏的客户，贵州的山地和少数民族人文比北京更接近他本来想看的 */
const REGION: Record<string, string> = {
  四川: '西南',
  西藏: '西南',
  云南: '西南',
  贵州: '西南',
  新疆: '西北',
  西安: '西北',
  北京: '华北',
  三亚: '华南',
};

/**
 * 银发客户点名的目的地没有适配的线路时，给 1~2 条带长辈走得了的国内替代线路。
 * 此前结果里只有被劝退的那几条（实测「带我爸妈去西藏」3/3 只劝退、不给具体替代），模型只能空口说
 * 「换个海拔友好的地方」，替代目的地靠它自己举——举出来的香格里拉要上 4200 米。
 * 候选只认 maxAltitude（逐条按行程核过），不认银发标签；排序依次看：同一片区、主题标签重合、最佳季节重合、价位接近。
 */
function lowlandAlternatives(all: Route[], mismatched: Route[], max = 2): Route[] {
  if (!mismatched.length) return [];
  const shown = new Set(mismatched.map((r) => r.id));
  const regions = new Set(mismatched.map((r) => REGION[r.destination]).filter(Boolean));
  // 「国内」和目的地名这类标签人人都有，算进重合只会让排序失真
  const themes = new Set(mismatched.flatMap((r) => r.tags).filter((t) => t !== '国内' && !(t in REGION)));
  const months = new Set(mismatched.flatMap((r) => [...peakMonths(r.bestSeason)]));
  const refPrice = Math.min(...mismatched.map((r) => r.priceFrom));
  const score = (r: Route): number[] => [
    Number(regions.has(REGION[r.destination])),
    r.tags.filter((t) => themes.has(t)).length,
    [...peakMonths(r.bestSeason)].filter((m) => months.has(m)).length,
  ];
  return all
    .filter(
      (r) =>
        !shown.has(r.id) &&
        r.segments?.includes('银发') &&
        !foreign(r) &&
        typeof r.maxAltitude === 'number' &&
        r.maxAltitude < LOWLAND_MAX_ALTITUDE,
    )
    .map((r) => ({ r, s: score(r) }))
    .toSorted(
      (a, b) => a.s.reduce((d, v, i) => d || b.s[i] - v, 0) || Math.abs(a.r.priceFrom - refPrice) - Math.abs(b.r.priceFrom - refPrice),
    )
    .slice(0, max)
    .map(({ r }) => r);
}

// 「出国 / 境外」说的是范围不是地名：没有哪条线叫「境外」，按关键词必然落空，落空就走 destinationMiss，
// 让模型对客户说「我们暂时没有境外的现成线路」——日本、马尔代夫明明都在。按「国内」标签反选
const ABROAD = /^(?:国外|境外|海外|出境|出国|国际)(?:游|线|线路|旅游)?$/;
// 不只整句就是「境外」：模型常只传 query「境外线路 异域风情」，此前语义召回出来全是国内线，
// 回复成「境外目前只有巴厘岛这一条」（实际 8 条）。所以 query / destination 里带着这些词也按非国内取。
// 否定和对举的不算：「也不想出国办签证」「国外太远」「国内国外都行」
// 说的是人不是去处的也不算：「接待国外客户」「带国外朋友看长城」「海外华人寻根」——此前按子串认，结果里只剩境外线，北京长城线没了
const ABROAD_WORD =
  /(?:国外|境外|海外|出境|出国)(?![^，。,！？!?\s]{0,2}(?:客户|朋友|友人|华人|华侨|同事|同学|亲戚|游客|嘉宾|来华|来的))(?!的?人)/;
const NOT_ABROAD =
  /(?:不|别|没|甭)[^，。,！？!?\s]{0,3}(?:国外|境外|海外|出境|出国)|(?:国外|境外|海外|出境|出国)[^，。,！？!?]{0,6}(?:麻烦|太远|不考虑|不去|算了|不想|不要|不方便|就不)|国内/;
function abroadOnly(s: string | undefined): boolean {
  return !!s && (ABROAD.test(s.trim()) || (ABROAD_WORD.test(s) && !NOT_ABROAD.test(s)));
}
/**
 * 境外线路。按 routes.json 的 overseas 字段认（逐条按目的地核过：国内 8 个目的地、境外 5 个）：「国内」标签和
 * 「蜜月」「海岛」混在同一个自由标签列表里，改标签时顺手删掉一个，这条国内线就被当成境外推给「出国」的客户。
 * types.ts 的 Route 没列这个字段，读的时候在这里补上；老数据没有这个字段时退回看「国内」标签
 */
const foreign = (r: Route): boolean => (r as Route & { overseas?: boolean }).overseas ?? !r.tags.includes('国内');

/** 境外线路所在的大区，只给「东南亚」「欧洲」这类叫法反查用（国内的见 REGION） */
const REGION_ABROAD: Record<string, string> = {
  巴厘岛: '东南亚',
  马尔代夫: '南亚',
  日本: '东亚',
  北欧极光: '欧洲',
  瑞士: '欧洲',
};

/**
 * 大区叫法（「西北」「西南」「东南亚」）同理：说的是一片地方，按关键词对不上任何一条线，却不等于我们没有。
 * 此前「西北」落空后语义召回出新疆、西安，再被标成「我们暂时没有西北的现成线路」——自己的主力线被说成没有。
 * 按片区反查；不是大区叫法返回 null，照常按目的地关键词匹配。
 * 片区表只列了种子数据的目的地：后台新建的线路按关键词对得上这个大区叫法的（目的地就叫「西北」「欧洲」，
 * 或标题写着「西北 甘青大环线」）也算，此前它们在大区搜索里整条消失，连语义召回也被这里滤掉
 */
function regionMatcher(q: string): ((r: Route) => boolean) | null {
  const w = q.trim().replace(/(?:地区|片区|一带|那边|方向)$/, '');
  if (Object.values(REGION).includes(w)) return (r) => REGION[r.destination] === w || matchesDestination(r, w);
  if (Object.values(REGION_ABROAD).includes(w)) return (r) => REGION_ABROAD[r.destination] === w || matchesDestination(r, w);
  return null;
}

/**
 * 目的地关键词能不能按 search_routes 的口径对上我们的现成线路：目的地 / 标题 / 标签 / 别名，
 * 或「境外」「西北」「东南亚」这类范围叫法。引擎判断「客户点的是不是我们没有的地方」用的也是这一个口径——
 * 两边不一致的话，引擎当成库外去预取，工具却按库内返回线路，destinationMiss 就对不上了。
 */
export function catalogCovers(q: string, routes: Route[] = loadRoutes()): boolean {
  if (abroadOnly(q) || regionMatcher(q)) return true;
  return routes.some((r) => matchesDestination(r, q));
}

// 客户常点名、我们却没有现成线路的目的地表（OFF_CATALOG_GROUPS）在 src/shared/places.ts：后台新建、上架线路时配置层也要查它
const OFF_CATALOG_PLACES = OFF_CATALOG_GROUPS.flatMap((g) => g.places);
// 长的排前面：「青海湖」要整个认出来，不能先被「青海」截走
const OFF_CATALOG_RE = new RegExp(OFF_CATALOG_PLACES.toSorted((a, b) => b.length - a.length).join('|'), 'g');
/** 每个地名整词认回它那一组（地名里带着边界写法，按整词重新匹配一遍） */
const PLACE_GROUP: { re: RegExp; kind?: PlaceKind; abroad: boolean }[] = OFF_CATALOG_GROUPS.flatMap((g) =>
  g.places.map((p) => ({ re: new RegExp(`^(?:${p})$`), kind: g.kind, abroad: g.abroad })),
);

/**
 * 每种类型对应的现成线路。只按逐条核过的字段认（海岛、极光标签，境外大区，最高海拔，目的地），不按描述猜：
 * 「极地冰雪」认芬兰极光玻璃屋；「高原」只认国内那几条要上 2500 米以上的；「山水」认贵州的山地线
 */
const KIND_ROUTES: Record<PlaceKind, (r: Route) => boolean> = {
  海岛: (r) => r.tags.includes('海岛'),
  极地冰雪: (r) => r.tags.includes('极光') || r.tags.includes('冬季'),
  欧洲: (r) => REGION_ABROAD[r.destination] === '欧洲',
  东南亚: (r) => REGION_ABROAD[r.destination] === '东南亚',
  日韩: (r) => REGION_ABROAD[r.destination] === '东亚',
  藏地: (r) => r.destination === '西藏',
  高原: (r) => !foreign(r) && (r.maxAltitude ?? 0) >= LOWLAND_MAX_ALTITUDE,
  草原戈壁: (r) => r.destination === '新疆',
  山水: (r) => r.destination === '贵州',
  古城: (r) => r.tags.some((t) => /古城|历史人文/.test(t)),
  云南: (r) => r.destination === '云南',
};

/**
 * 目的地我们没有时，和它同类型的现成线路（「普吉岛、斐济」→ 海岛线）。同是境外 / 国内的排前面（想去普吉的先看巴厘岛、马代，
 * 想去涠洲岛的先看三亚），再按语义召回的顺序（recallOrder，没有就按数据顺序）。认不出类型返回空数组
 */
function sameKindRoutes(q: string, all: Route[], recallOrder: Map<string, number> | null): Route[] {
  const places = [...q.matchAll(OFF_CATALOG_RE)]
    .map((m) => PLACE_GROUP.find((p) => p.re.test(m[0])))
    .filter((p): p is (typeof PLACE_GROUP)[number] & { kind: PlaceKind } => !!p?.kind);
  if (!places.length) return [];
  const abroad = places.some((p) => p.abroad);
  const hits = all.filter((r) => places.some((p) => KIND_ROUTES[p.kind](r)));
  // 国内的地名（哈尔滨、雪乡、长白山）同类型只有境外线（芬兰极光 46,800）：有语义召回时不拿它往前顶，交给召回和预算排序。
  // 此前它永远排第一，工具又让模型「只推荐排第一的这条」：每人预算 8000 想去长白山，首推的是一条出国的 46,800（第三轮复核）。
  // 召回不可用时照样拿它兜底，总比空列表强
  if (!abroad && recallOrder && !hits.some((r) => !foreign(r))) return [];
  const pos = (r: Route): number => recallOrder?.get(r.id) ?? 99;
  return hits
    .map((r, i) => ({ r, i }))
    .toSorted((a, b) => Number(foreign(b.r) === abroad) - Number(foreign(a.r) === abroad) || pos(a.r) - pos(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * 地名后面紧跟的是一样东西、不是去那儿玩：「法国菜」「泰国香米」「美国签证」「迪拜转机」「巴黎世家」「罗马仕充电宝」「黄山毛峰」；
 * 前面是「叫」的是人名（「我叫张泰山」）。此前这些照样当库外目的地预取：客户说「美国签证办不下来，想换个地方玩」，
 * 模型拿到的工具结果让它「照实说没有现成的美国线路」，画像的目的地也记成了美国——客户刚说完不去美国。
 */
const NOT_DESTINATION_AFTER =
  /^(?:菜|料理|烤肉|香米|米粉|米线|拉面|咖啡|红酒|奶粉|化妆品|世家|仕|代购|签证|护照|绿卡|国籍|户口|保险|留学|时间|转机|中转|转飞|经停|过境|毛峰|茶叶|队|电影|口音)/;
const NOT_DESTINATION_BEFORE = /叫\s*[一-鿿]?$/;

/** 原话里点到的、我们没有现成线路的目的地（按原文顺序，同一地名只记第一次） */
export function offCatalogPlaces(text: string): { kw: string; at: number }[] {
  const routes = loadRoutes();
  const out: { kw: string; at: number }[] = [];
  for (const m of text.matchAll(OFF_CATALOG_RE)) {
    const at = m.index ?? 0;
    if (out.some((p) => p.kw === m[0]) || catalogCovers(m[0], routes)) continue;
    if (NOT_DESTINATION_AFTER.test(text.slice(at + m[0].length)) || NOT_DESTINATION_BEFORE.test(text.slice(0, at))) continue;
    out.push({ kw: m[0], at });
  }
  return out;
}

/**
 * 这个地名在原话里是出发地 / 常住地（「我在北京，想去三亚」「四川人，想去新疆」「从上海出发」），不是想去的地方。
 * 引擎预取（engine.ts planPrefetch）和价格护栏认「客户点了哪条线」（price-guard routesInPlay）共用这一个口径：
 * 客户说「我在北京，想去南极」，北京那条线不能因此算作客户点过名
 */
export function isOriginMention(text: string, kw: string): boolean {
  const k = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:从|在|住|来自)\\s*${k}|${k}\\s*(?:出发|过去|过来|飞|本地|人(?![多少挤]))`).test(text);
}

// 「马代去过了」「去年去过云南」「上次去的日本」：客户去过的地方。B08 实测客户说完「马代去过了」，
// 首推的仍是两条马代线。「没去过 / 还没去过」正相反，是想去
const BEEN_THERE = /去过|玩过|到过|来过|(?:上次|上回|去年|前年|刚从)[^，。,！？!?；;\s]{0,2}(?:去|到|在)/;
const NOT_BEEN = /(?:没|未|从没|从来没|还没)有?\s*(?:去|玩|到|来)过/;
/** 去过的不是客户本人（「朋友去过西藏 说很美 我想去」），或是在问（「你们去过马代吗」「三亚玩过吗 你们」） */
const OTHERS_BEEN = /朋友|同事|同学|闺蜜|别人|邻居|网友|人家|有人|你们|你|他|她/;
const ASKS_BEEN = /吗|么|没有?$|呢/;

/**
 * 客户原话里说去过的、我们有线路的目的地（destination 名）。按小句认：微信里常用空格断句，空格也算；
 * 「去过了」这一截里没有地名时，看紧挨着的前一截（「马代 去过了」）
 */
export function visitedDestinations(texts: string[], routes: Route[] = loadRoutes()): string[] {
  const placesIn = (s: string): string[] =>
    routes.filter((r) => mentionsPlace(s, r.destination) || (r.aliases ?? []).some((a) => mentionsPlace(s, a))).map((r) => r.destination);
  const out = new Set<string>();
  for (const t of texts) {
    const bits = t.split(/[，,。！!？?；;\n\s]+/).filter(Boolean);
    bits.forEach((b, i) => {
      const been = BEEN_THERE.exec(b);
      if (!been || NOT_BEEN.test(b) || OTHERS_BEEN.test(b.slice(0, been.index)) || ASKS_BEEN.test(b.slice(been.index))) return;
      // 「你们」在后一截（「三亚玩过吗 你们」）同样是在问
      if (/^(?:你们|你)$/.test(bits[i + 1] ?? '')) return;
      const here = placesIn(b);
      for (const d of here.length ? here : i > 0 ? placesIn(bits[i - 1]) : []) out.add(d);
    });
  }
  return [...out];
}

/**
 * 体力强度提示：客户带着长辈时附在线路上（search_routes 每条、get_route_detail）。
 * 银发标签和海拔都管不到腿脚：北京线打着银发标签、最高才 1150 米，第 3 天却是约三小时未修缮的箭扣野长城——
 * 实测模型 3 次对长辈说「全程平原 / 全程平地为主 / 老人走得动」。强度按行程逐条核过写在 routes.json（intensity），
 * 轻松的不提，免得每条都来一段、客户听着像在劝退
 */
function intensityNote(r: Route): string | undefined {
  const it = r.intensity;
  if (!it || it.level === '轻松') return undefined;
  return (
    `这条带长辈要照实讲体力强度（${it.level}）：${it.hardest}。推荐或回答时把这一段讲清楚，问长辈腿脚怎么样；` +
    '不要说「全程平地」「不用爬山」「老人走得动」「完全没问题」，行程里没写的步行量、有没有扶梯电梯，说「我让顾问确认」。'
  );
}

/**
 * 海拔提醒，三种口吻：带长辈、线路也打着银发标签的（能推，但那一段讲在前面）；带长辈、线路不在长辈适配范围的；
 * 只是客户自己怕高反的。此前只在模型传 segment=银发 时才附：客户说「婆婆72岁…也怕高反」，
 * 模型传的是 segment=家庭，回复只说「九寨沟海拔约 2000-3100 米」，漏了黄龙索道那一段 3500
 */
function altitudeNoteFor(r: Route, elder: boolean): string {
  // 供氧只在线路数据里写了的时候才提：瑞士（3571 米）、伊犁（3500 米）两条整条数据里没有一个「氧」字，
  // 此前提醒一律叫模型讲「随行备氧安排」，等于替我们编了一项服务
  const oxygen = JSON.stringify(r).includes('氧');
  const noOxygen = '行程里没写供氧安排，不要说有；客户问起就说「这个我让顾问确认」。';
  if (elder && r.segments?.includes('银发')) {
    return (
      `这条能带长辈，但行程里有一段要上到约 ${r.maxAltitude} 米（见 highlights）。推荐时照实提一句这一段的海拔${oxygen ? '和行程里写的供氧安排' : ''}，` +
      '顺带问长辈多大年纪、身体怎么样；不要说成全程海拔温和、没有高原段。' +
      (oxygen ? '' : noOxygen)
    );
  }
  if (elder) {
    return (
      `这条最高要到约 ${r.maxAltitude} 米，不在带长辈的适配范围内，高原反应对长辈是真实风险。` +
      '推荐前照实讲这一段的海拔，问长辈多大年纪、身体怎么样；不要说成海拔温和、没有高原段。' +
      (oxygen ? '' : noOxygen)
    );
  }
  return (
    `客户担心高反：这条行程里有一段要上到约 ${r.maxAltitude} 米（见 highlights）。照实讲这一段的海拔${oxygen ? '和行程里写的供氧安排' : ''}，` +
    '不要说成全程海拔温和、没有高原段、不会高反。' +
    (oxygen ? '' : noOxygen)
  );
}

/** 行程细节的答法，附在 get_route_detail 的结果上（模型被问细节时照抄进回复的风险低，措辞仍只用对客户说得出口的） */
const DETAIL_NOTE =
  '客户问行程细节（几点、住哪、含不含、保险、走路爬山、海拔、第几天）时，只按这里的逐日行程（itinerary）、' +
  '费用包含（inclusions）/ 不含（exclusions）、住宿（hotels）和最高海拔（maxAltitude）的原文回答。' +
  '这里没写的（具体几点起飞、有没有扶梯电梯、每天走多少步）就说「行程里没写，我让顾问确认」，不要猜；' +
  '不要替客户担保「完全没问题」「全程平地」「不用爬山」。已经含在 inclusions 里的（比如保险、某段机票）照实说含，别建议客户另买；' +
  '行程里没去的景点不要提。';

/** get_route_detail 的结果：整条线路原文，加上住宿清单和答细节的口径；带长辈、怕高反时附强度和海拔提醒 */
function routeDetail(r: Route, ctx: { elder?: boolean; altitudeWorry?: boolean }): Record<string, unknown> {
  const hotels = [...new Set((r.itinerary ?? []).map((d) => d.hotel).filter((h) => h && !h.startsWith('—')))];
  const out: Record<string, unknown> = { ...r, hotels, detailNote: DETAIL_NOTE };
  const tough = ctx.elder ? intensityNote(r) : undefined;
  if (tough) out.intensityNote = tough;
  if ((ctx.elder || ctx.altitudeWorry) && typeof r.maxAltitude === 'number' && r.maxAltitude >= LOWLAND_MAX_ALTITUDE) {
    out.altitudeNote = altitudeNoteFor(r, !!ctx.elder);
  }
  return out;
}

export interface SearchCtx {
  customerText?: string;
  /** 客户说去过的目的地（destination 名，见 visitedDestinations）：排到后面，库外兜底时不拿它当「最接近的」 */
  visited?: string[];
  /** 客户提过同行的长辈（引擎按原话认的，见 engine.ts toolHints）：附海拔、体力强度提醒 */
  elder?: boolean;
  /** 客户提过高反、海拔：附海拔提醒 */
  altitudeWorry?: boolean;
}

/**
 * 召回 + 硬过滤 + 排序。
 * 有 query 且语义索引就绪时走「语义召回 → 硬条件过滤 → 按相似度排序」；
 * 否则退回关键词匹配 + 按价格升序（原行为，保证 embedding 不可用时功能不降级）。
 * ctx.customerText 是客户这轮的原话：目的地我们没有、模型又没传 query 时，拿它补做语义召回（见下）。
 */
export async function searchRoutes(args: SearchRoutesArgs, ctx: SearchCtx = {}): Promise<ReturnType<typeof summarize>[]> {
  const all = loadRoutes();
  let list = all;
  let order: Map<string, number> | null = null;
  const byId = new Map(all.map((r) => [r.id, r]));
  const recall = async (q: string): Promise<{ order: Map<string, number>; list: Route[] } | null> => {
    const hits = await semanticRecall(q, 8);
    if (!hits?.length) return null;
    return {
      order: new Map(hits.map((h, i) => [h.id, i])),
      list: hits.map((h) => byId.get(h.id)).filter((r): r is Route => !!r),
    };
  };

  if (args.query?.trim() && indexReady()) {
    const got = await recall(args.query);
    if (got) ({ order, list } = got);
  }

  // 「境外」「出国」放在 tags 里说的也是范围，不是标签（B10：模型传 tags=["境外"]）。此前当硬标签过滤——没有一条线打这个标签，
  // 滤空后原样留着全库，按价格排出来的是西安、贵州、三亚，模型据此对客户说「其他境外方向暂时没有现成线路」。
  // 和 query 里的同一个词一样按「非国内」取
  const scopeTags = (args.tags ?? []).filter((t) => abroadOnly(t));
  const wantsAbroad = scopeTags.length > 0 || abroadOnly(args.query);
  /** 目的地我们没有时，和它同类型的现成线路（见 sameKindRoutes）：排序时排在语义召回补上的那几条前面 */
  let sameKind = new Set<string>();
  let destinationMiss = false;
  if (args.destination) {
    const q = args.destination;
    const match = abroadOnly(q) ? foreign : (regionMatcher(q) ?? ((r: Route) => matchesDestination(r, q)));
    // 语义召回已按需求排过序，目的地在这里只当过滤条件；召回结果里没有该目的地时
    // 退回全量再按关键词过滤，避免语义召回把明确点名的目的地漏掉
    const hit = list.filter(match);
    const fromAll = hit.length ? hit : all.filter(match);
    if (fromAll.length) list = fromAll;
    else {
      // 我们确实没有这个目的地。模型传不传 query 是随机的，结果却天差地别：此前没传 query 就返回空列表，
      // 模型两手空空，实测「想去南极」2/3 直接转了人工，AI 从此不再应答，演示第一句就断；
      // 传了 query 的那 1/3 推荐了最接近的芬兰极光——这才是要的口径（sop.md 转人工条件）。
      // 所以没传 query 时拿目的地和客户原话补做一次语义召回，两种传法走同一条路、结果形态一致。
      if (!order && !args.query?.trim() && indexReady()) {
        const got = await recall([q, ctx.customerText?.slice(0, 200)].filter(Boolean).join('。'));
        if (got) ({ order, list } = got);
      }
      // 同类型的现成线路排最前（普吉、斐济 → 巴厘岛、马代、三亚），语义召回的补在后面。召回不可用时同类型的照样给得出
      const same = sameKindRoutes(q, all, order);
      if (same.length) {
        list = [...same, ...(order ? list.filter((r) => !same.includes(r)) : [])];
        order = new Map(list.map((r, i) => [r.id, i]));
        sameKind = new Set(same.map((r) => r.id));
      }
      // 有结果：留着并标明「不是该目的地」。认不出类型、召回又不可用（索引没建起来）时只能返回空列表
      if (order) destinationMiss = true;
      else list = [];
    }
  } else if (wantsAbroad) {
    // 「境外 / 出国」（见 ABROAD_WORD）：召回到的境外线排前面，没召回到的境外线也补上——
    // 只留召回里的那一两条，模型照样会说「境外只有这一条」。
    // query 里的是按词认的，召回里的国内线留在后面、不删（ABROAD_WORD 认错时不至于把国内线全丢了）；tags 里的是模型明说的范围，只要境外
    const hit = list.filter(foreign);
    const domestic = scopeTags.length ? [] : list.filter((r) => !foreign(r));
    list = [...hit, ...all.filter((r) => foreign(r) && !hit.includes(r)), ...domestic];
    // 没有语义召回（只传了 tags）时不给顺序，按价格升序排：没有「最贴需求」可言，先看最便宜的几条
    if (order || args.query?.trim()) order = new Map(list.map((r, i) => [r.id, i]));
  }
  // 客户说去过的地方排到后面（见下面的排序）：库外兜底只推排第一的那条，推的是客户刚说去过的就等于没听。
  // 不删——客户问起「马代那几条呢」还得有得答（此前库外兜底直接滤掉，同类型的海岛线就少了一半）。
  // 客户点名要去的那个目的地不算——「马代去过了，还想再去换个岛」
  const visited = new Set(ctx.visited ?? []);
  const named = args.destination && !destinationMiss ? args.destination : '';
  const beenThere = (r: Route): boolean => visited.has(r.destination) && !(named && matchesDestination(r, named));
  // 标签里的客群词（蜜月 / 亲子…）只当排序偏好，不做过滤：此前 r-maldives-lite 的标签里漏了「蜜月」（segments 里有），
  // 「马代 + 蜜月」把 28,800 那条最便宜的滤掉，模型第 2 遍把 35,800 说成「最实惠」。客群本来就有 segment 管，
  // 偏好按 标签 ∪ segments 算。其余标签（海岛、一价全包…）照旧过滤，但滤空了也只当偏好——
  // 目的地我们没有时手里是按需求排好的语义结果，模型顺手传的「极地」「探险」会把最接近的那几条全滤掉；
  // 「贵州 + 苗寨」此前滤成空列表，模型只能再查一遍
  const segTags = (args.tags ?? []).filter((t) => (SALES_SEGMENTS as string[]).includes(t));
  const hardTags = (args.tags ?? []).filter((t) => !segTags.includes(t) && !scopeTags.includes(t));
  const hasHardTag = (r: Route): boolean => hardTags.some((t) => r.tags.some((rt) => rt.includes(t)));
  let tagFiltered = false;
  if (hardTags.length) {
    const tagged = list.filter(hasHardTag);
    if (tagged.length) [list, tagFiltered] = [tagged, true];
  }
  const tagScore = (r: Route): number =>
    (args.tags ?? []).filter((t) => r.tags.some((rt) => rt.includes(t)) || (r.segments as string[] | undefined)?.includes(t)).length;
  // 客群处理，分两档——这个区别很重要，第一版没分导致线上评测直接挂了：
  //
  // 「银发」是**安全约束**：4000 米高原对老人是真实健康风险，宁可不推也不能推错，
  //   所以硬过滤。客户点名了高海拔目的地时保留线路但打 segmentMismatch，
  //   让模型如实说明（「这条要上珠峰大本营 5200 米，带爸妈我不敢硬推」）——
  //   不藏产品，但把风险讲在前面。
  //
  // 其余四类是**偏好**：蜜月客户去珠峰线一点问题没有，硬过滤只会把唯一符合预算的
  //   线路删掉，让 AI 报不出价也成不了单（实测就是这么挂的）。所以只做排序加权，
  //   匹配的排前面，不匹配的仍然可选。
  let segmentMismatch = false;
  const silver = (r: Route): boolean => !!r.segments?.includes('银发');
  const lowland = (r: Route): boolean => typeof r.maxAltitude === 'number' && r.maxAltitude < LOWLAND_MAX_ALTITUDE;
  if (args.segment === '银发') {
    const hit = list.filter(silver);
    if (hit.length) list = hit;
    // 目的地我们本来就没有（destinationMiss）时，手里的是语义结果、不是客户点名的线路，没什么可「如实劝退」的
    else if (args.destination && !destinationMiss) segmentMismatch = true;
    else list = all.filter(silver);
    // 目的地我们没有时只推荐排第一的那条，那条必须是长辈全程走得了的低海拔线。银发标签管不到单日的索道：
    // 此前「带爸妈去冰岛」排第一的是九寨黄龙（索道上 3500 米），而且没有任何海拔提示
    if (destinationMiss) {
      const low = list.filter(lowland);
      list = low.length ? low : all.filter((r) => silver(r) && lowland(r));
    }
  }
  // 非银发客群只作为排序偏好，并入下面的最终排序（单独排会被最终排序冲掉）
  const preferSeg = args.segment && args.segment !== '银发' ? args.segment : null;
  // 预算是**软约束**，不能像银发那样硬过滤。硬过滤在「符合条件的线路全都超预算」时
  // 返回空列表，模型没料可用，实测会退回复述自己上一轮的话——对客户说出「西藏线只有
  // 一条、人均 6 万以上」，而库里明明躺着 26,800 的那条（只超 34%）。
  // 手里有货却告诉客户「没有适合你的」，是销售最坏的失败模式：线索当场就死，
  // 而且客户不会回来核对。所以滤空了就放宽重来，并给结果打上 overBudget 标记，
  // 让模型照实讲超了多少——不藏产品，把差价摆在明面上谈（嫌贵时只给 SOP 里那三条路，见下面 overBudget 的文案）。
  // 天数同样是软约束，道理和预算一样：「云南玩 3 天」此前被 ±2 天硬过滤滤成空列表，模型拿到 []
  // 就说「云南暂时没有合适的线路」，而库里 6 天的丽江大理线明明在。所以 ±2 天内有就用；
  // 没有就退回天数最接近的那几条，打上 daysMiss 让模型照实说「最短的是 6 天」——
  // 行程天数是固定的（sop.md 能力边界），客户坚持要按天数定制才转人工，而不是一句「没有」挡回去。
  //
  // ±2 天的过滤必须排在预算之前。预算的「预算内 / 放宽 / 最便宜兜底」三档得在天数收窄之后的候选集上判定：
  // 此前天数排在后面，「四川 9 天、每人 3 万」先被预算收窄成预算内那条 6 天线，再被天数滤空——
  // 放宽逻辑已经跳过，库里那条 8 天、只超 43% 的线就这么没了，模型又回到「没有合适的线路」。
  // 但 ±2 天内一条都没有时，「只留天数最接近的」要排在预算**之后**：先收窄的话，「新疆 15 天、每人 2 万」
  // 只剩 10 天那条 52,800（超 164%），预算内、只差 1 天的 9 天 19,800 被丢掉——比 BUDGET_RELAX 的上限
  // 还离谱，正是「只会让人觉得没在听」。所以天数兜底只记下候选全集，等预算筛完再挑天数最接近的。
  const want = Number(args.days);
  let daysPool: Route[] | null = null; // 天数兜底时的候选全集，判「最短 / 最长」用
  // 模型偶尔传「5-7」这种字符串，Number 出来是 NaN——此前 NaN 让每条线都「不在 ±2 天内」，返回空列表
  if (args.days && Number.isFinite(want) && list.length) {
    const within = list.filter((r) => Math.abs(r.days - want) <= 2);
    if (within.length) list = within;
    else daysPool = list;
  }
  let overBudget = false;
  // 客群偏好（标签里的蜜月 / 亲子…，或非银发的 segment）
  const wantsSeg = (r: Route): boolean =>
    segTags.some((t) => r.tags.some((rt) => rt.includes(t)) || (r.segments as string[] | undefined)?.includes(t)) ||
    (!!args.segment && args.segment !== '银发' && !!r.segments?.includes(args.segment));
  const segAsked = segTags.length > 0 || (!!args.segment && args.segment !== '银发');
  if (args.maxBudgetPerPerson) {
    const cap = args.maxBudgetPerPerson;
    const within = list.filter((r) => r.priceFrom <= cap);
    if (within.length) {
      // 预算内一条对口的客群线都没有时，补一条放宽预算内最便宜的对口线（带超预算差额）：客群只参与排序以后，
      // 「蜜月 + 每人 1.6 万」预算内只剩西安、贵州、三亚，蜜月线整批被挤掉，稍超一点的丽江大理蜜月首选没了
      const fit =
        segAsked && !within.some(wantsSeg)
          ? list
              .filter((r) => wantsSeg(r) && r.priceFrom > cap && r.priceFrom <= cap * BUDGET_RELAX)
              .toSorted((a, b) => a.priceFrom - b.priceFrom)[0]
          : undefined;
      list = fit ? [...within, fit] : within;
    } else {
      overBudget = true;
      const relaxed = list.filter((r) => r.priceFrom <= cap * BUDGET_RELAX);
      // 放宽后仍为空就保留原列表：下面会按价格升序取前 3，
      // 客户至少能看到最接近他预算的几条，而不是一句「没有」。
      if (relaxed.length) list = relaxed;
    }
  }
  if (daysPool) {
    const gap = Math.min(...list.map((r) => Math.abs(r.days - want)));
    list = list.filter((r) => Math.abs(r.days - want) === gap);
  }

  // 超预算时一律按价格升序：语义召回的顺序是「最贴需求」，但客户已经明说了预算，
  // 此刻最该先看到的是「最接近他出得起的价」那几条，而不是最贴描述的那几条。
  const rank = (r: Route): number => (order && !overBudget ? (order.get(r.id) ?? 99) : r.priceFrom);
  const sorted = list.toSorted((a, b) => {
    // 客户说去过的排最后（见上面 beenThere）
    const been = Number(beenThere(a)) - Number(beenThere(b));
    if (been) return been;
    // 目的地我们没有时，同类型的排在语义召回补上的前面：客群偏好（蜜月）不能把海岛线挤到云南后面
    const kind = Number(sameKind.has(b.id)) - Number(sameKind.has(a.id));
    if (kind) return kind;
    if (preferSeg) {
      // 匹配客群的排前面，但不排除不匹配的——蜜月客户去珠峰线没问题，
      // 硬删只会把唯一符合预算的线路弄丢
      const d = Number(b.segments?.includes(preferSeg) ?? false) - Number(a.segments?.includes(preferSeg) ?? false);
      if (d) return d;
    }
    return tagScore(b) - tagScore(a) || rank(a) - rank(b);
  });
  // 带预算、没点目的地时，候选只是语义召回的前 8 条：A18「人均一万二以内 国庆想出去玩」召回里没有西安 12,800，
  // 模型两遍都说「最接近的一档在人均 15800」。要给的三条都超预算时，从全库补一条离预算最近、又比这三条都便宜的。
  // 只补一条、不重排，放在给出的三条里的最后一位：客户描述的需求（海岛、雪山）仍由召回排前面的那两条代表——
  // 此前放在第一位，模型一般先推第一条，想看海岛的客户先听到兵马俑。query 里点了主题（海岛、雪山…）时，补的这条也得是这个主题。
  // 补的这条同样要过上面的硬条件（银发、标签、天数、境外），客户说去过的不补
  if (args.maxBudgetPerPerson && !args.destination && order && !daysPool && sorted.length) {
    const cap = Number(args.maxBudgetPerPerson);
    const top = sorted.slice(0, 3);
    const themes = [...new Set(all.flatMap((r) => r.tags))].filter((t) => t !== '国内' && t.length >= 2 && !!args.query?.includes(t));
    const hardOk = (r: Route): boolean =>
      (args.segment !== '银发' || silver(r)) &&
      (!tagFiltered || hasHardTag(r)) &&
      (!(args.days && Number.isFinite(want)) || Math.abs(r.days - want) <= 2) &&
      (!wantsAbroad || foreign(r)) &&
      !beenThere(r) &&
      (!themes.length || r.tags.some((t) => themes.includes(t)));
    if (top.every((r) => r.priceFrom > cap)) {
      const floor = Math.min(...top.map((r) => r.priceFrom));
      const near = all
        .filter((r) => !top.includes(r) && r.priceFrom < floor && r.priceFrom <= cap * BUDGET_RELAX && hardOk(r))
        .toSorted((a, b) => Math.abs(a.priceFrom - cap) - Math.abs(b.priceFrom - cap))[0];
      if (near) sorted.splice(Math.min(2, sorted.length), 0, near);
    }
  }
  const out = sorted.slice(0, 3).map(summarize);
  // 下面几段提示是写给模型看的，但模型会原样照抄进回复（盲评里两个模型都频繁说「库里没有…」
  // 「库里还有一条…」），所以措辞只用对客户也说得出口的（「我们现有的线路」「现成线路」），不写「库里」
  if (args.maxBudgetPerPerson) {
    const cap = Number(args.maxBudgetPerPerson);
    for (const r of out) {
      // 从全库补进来的那条可能就在预算内（见上），它不带超预算标记；预算内补进来的客群线（见上）超了，一样带
      if (r.priceFrom <= cap) continue;
      // 差额和比例都由工具算好交给模型原样转述，并记进会话（见 executeTool）供价格护栏放行。
      // 让模型自己减——哪怕减对了——护栏也认不出这个数，整条推荐会被换成兜底话术。
      const gap = r.priceFrom - cap;
      const over = Math.round((gap / cap) * 100);
      const row = r as Record<string, unknown>;
      row.gapPerPerson = gap;
      row.overBudget =
        `这条每人 ${r.priceFrom} 元，比客户说的每人 ${cap} 元高约 ${over}%（每人多 ${gap} 元）。` +
        '**不要说「没有合适的线路」**——我们现有的线路就是这些。照实讲超了多少，只用这里给的每人价、百分比和每人差额，' +
        '不要自己另算（乘人数、换算总差价都算编造价格）；再讲这个差价买到了什么，' +
        // 此前这里让模型问「要换更短的天数 / 更低的酒店档次」——线路的天数和住宿是固定的，这两样都做不到，
        // 模型照着许诺「缩短天数、降一档酒店、有更短的线路」（场景测试 7 个场景约 12 轮）。只给真做得到的三条路
        '问客户是愿意加预算，还是看看别的办法：我们现有线路里确实更便宜的那条（search_routes 查到的才算）、' +
        '不在最佳季的出发日期（用 create_quote 实报），或转人工申请。不要答应缩短天数、换低一档酒店。';
    }
  }
  if (daysPool) {
    const where = args.destination ? `「${args.destination}」` : '';
    const minDays = Math.min(...daysPool.map((r) => r.days));
    const maxDays = Math.max(...daysPool.map((r) => r.days));
    for (const r of out) {
      // 「最短 / 最长」按候选全集判定、逐行生成：预算筛过之后留下的未必是库里最短 / 最长的那条，
      // 比如「新疆 15 天、每人 2 万」留下的是 9 天那条，而库里最长的是 10 天——说成「最长的是 9 天」就是瞎说
      const edge = r.days === minDays && minDays > want ? '最短的是' : r.days === maxDays && maxDays < want ? '最长的是' : '这条是';
      (r as Record<string, unknown>).daysMiss =
        `客户想玩 ${want} 天，我们${where}的现成线路里没有 ${Math.max(1, want - 2)}~${want + 2} 天的，${edge} ${r.days} 天。` +
        `照实说「${edge} ${r.days} 天」，不要说成 ${want} 天，也不要答应压缩或拉长成 ${want} 天——` +
        '行程天数是固定的；客户坚持要按他的天数定制，就转人工。';
    }
  }
  if (destinationMiss) {
    const want = args.destination;
    for (const r of out) {
      (r as Record<string, unknown>).destinationMiss =
        `我们暂时没有「${want}」的现成线路，这条（${r.destination}）是按客户需求最接近的，越靠前越接近。` +
        `照实说没有现成的${want}线路，只推荐排第一的这条：讲 1~2 个亮点、报人均起价，再问出行时间和几位出行（客户说过的别再问）。` +
        `不要把它说成${want}的线路，也不要答应能去${want}；客户明确坚持只要${want}、别的不考虑，才转人工。`;
    }
  }
  for (const row of out) {
    const r = byId.get(row.id);
    if (r && beenThere(r)) (row as Record<string, unknown>).visited = `客户说过${r.destination}去过了，别首推这条；客户问起再介绍。`;
  }
  // 问的是「境外都有啥」：结果只列得下三条，模型照着说「境外就这三条」（B10 第 2 遍说成「其他境外方向暂时没有」）。
  // 把境外目的地的全貌附在第一条上，只附一次
  if (wantsAbroad && !args.destination && out.length) {
    const abroadAll = all.filter(foreign);
    (out[0] as Record<string, unknown>).abroadNote =
      `我们的境外现成线路一共 ${abroadAll.length} 条，目的地有：${[...new Set(abroadAll.map((r) => r.destination))].join('、')}。` +
      '这里只列了其中几条，客户问境外有哪些时照这份目的地清单说，不要说成境外只有这几条、或别的境外方向没有线路。';
  }
  // 长辈不只看模型传没传 segment=银发：客户说了「婆婆72岁」、模型传的却是「家庭」时同样要提醒（见 altitudeNoteFor）
  const elder = args.segment === '银发' || !!ctx.elder;
  if ((elder || ctx.altitudeWorry) && !segmentMismatch) {
    for (const row of out) {
      const r = byId.get(row.id);
      if (!r || lowland(r) || r.maxAltitude === undefined) continue;
      // 打着银发标签、单日却要上三四千米的线（丽江大理的冰川大索道 4500 米、九寨黄龙的索道 3500 米）：
      // 能推，但海拔那一段得照实讲在前面。那一段写在哪条亮点里不一定，摘要只带前 3 条，全给模型
      const rec = row as Record<string, unknown>;
      rec.highlights = r.highlights;
      rec.altitudeNote = altitudeNoteFor(r, elder);
    }
  }
  if (segmentMismatch) {
    const mismatched = out.map((s) => byId.get(s.id)).filter((r): r is Route => !!r);
    // 只有海拔不合适时才给低海拔替代。节奏不合适的多是境外线（北欧极光、马尔代夫），
    // 替代候选却只有国内低海拔线：此前「带爸妈看极光」被推了三亚海滩，理由是「没有高原段」，风马牛不相及
    const alts = lowlandAlternatives(
      all,
      mismatched.filter((r) => (r.maxAltitude ?? 0) >= LOWLAND_MAX_ALTITUDE),
    );
    const ask = '问长辈多大年纪、身体怎么样，不要问「要不要看看」这类是非问句。';
    const offer = alts.length
      ? '② 直接摆出结果里带 alternative 的第一条线路，讲 1 个亮点和人均起价；③ 问长辈多大年纪、身体怎么样。' +
        '替代线路只能用带 alternative 的这几条，别的目的地一个都不要自己举（我们不少线路单日要坐索道、翻垭口上三四千米，' +
        '说它们海拔温和就是说错）；不要问「要不要看看」这类是非问句。'
      : `② ${ask}`;
    for (const row of out) {
      const r = byId.get(row.id);
      if (!r) continue;
      const alt = r.maxAltitude ?? 0;
      const rec = row as Record<string, unknown>;
      if (alt >= LOWLAND_MAX_ALTITUDE) {
        // 供氧、缓降这类安排多在第 4 条亮点（藏线都是），摘要只带前 3 条时模型看不到，
        // 实测就对客户说自家两条藏线「都没有针对长辈做高海拔减压设计」——替产品说了假话
        rec.highlights = r.highlights;
        rec.segmentMismatch =
          `这条最高要到约 ${alt} 米，带长辈有高原反应的真实风险，不在「${args.segment}」适配范围内。回复按这个顺序：` +
          '① 一句话照实讲清风险，海拔按这里和 highlights 说；highlights 里的供氧、缓降这些安排是真的，不要说成没有减压安排，' +
          `只是对长辈仍有风险；${offer}`;
      } else {
        rec.segmentMismatch =
          `这条线不在「${args.segment}」适配范围内（适配：${r.segments.join('/')}）。回复按这个顺序：` +
          `① 按 highlights 里的行程节奏照实说为什么不太适合带长辈，不要编；② ${ask}`;
      }
    }
    for (const r of alts) {
      out.push({
        ...summarize(r),
        highlights: r.highlights.slice(0, 1),
        alternative: `给长辈的替代线路：全程最高约 ${r.maxAltitude} 米，没有高原段。推荐时报人均 ${r.priceFrom} 起，正式报价等人数定了再出。`,
      } as ReturnType<typeof summarize>);
    }
  }
  // 体力强度放在最后：给长辈的低海拔替代线（北京那条就在里面）同样要带。已经按海拔劝退的不再加一段
  if (elder) {
    for (const row of out) {
      const rec = row as Record<string, unknown>;
      const r = byId.get(row.id);
      const note = r && !rec.segmentMismatch ? intensityNote(r) : undefined;
      if (note) rec.intensityNote = note;
    }
  }
  return out;
}

export { peakMonths } from './shared/season.js';

export interface Quote {
  routeTitle: string;
  perPerson: number;
  travelers: number;
  total: number;
  note: string;
}

/** 报价规则写死：旺季（出发月命中 bestSeason）每人 +10%；4 人及以上总价 95 折 */
export function createQuote(args: { routeId: string; travelers: number; departDate?: string }): Quote {
  const route = loadRoutes().find((r) => r.id === args.routeId);
  if (!route) throw new Error(`线路不存在: ${args.routeId}`);
  const travelers = Math.max(1, Math.floor(args.travelers));
  let perPerson = route.priceFrom;
  const notes: string[] = [];
  const month = args.departDate ? Number(args.departDate.match(/-(\d{1,2})-/)?.[1] ?? NaN) : NaN;
  const peak = peakMonths(route.bestSeason);
  if (!Number.isNaN(month) && peak.has(month)) {
    perPerson = Math.round(perPerson * 1.1);
    notes.push(`${month}月为最佳出行季，价格上浮 10%`);
  } else if (!Number.isNaN(month)) {
    // 不在最佳季也要写明：此前只写「当前为标准价」，模型自己给便宜找理由——「12 月中前是平日价」
    // 「避开了节日高峰」「过了春节旺季，地接价回落」，全是没有的规则。这句也显示在方案书的报价卡上
    notes.push(peak.size ? `${month}月不在最佳季，不上浮` : '这条线全年同价，不上浮');
  }
  if (travelers >= 4) {
    perPerson = Math.round(perPerson * 0.95);
    notes.push('4 人及以上享 95 折');
  }
  return {
    routeTitle: route.title,
    perPerson,
    travelers,
    total: perPerson * travelers,
    note: notes.length ? notes.join('；') : '当前为标准价',
  };
}

// ---------- 参数硬校验 ----------
// JSON Schema 的 required 只是给模型的提示，不构成运行时保障：模型可能传 "两"、
// 「明天」或畸形 JSON（llm 层解析失败时按空参执行）。这里把关，错了返回 error
// JSON 让模型看到原因后重试，绝不带着 NaN/假日期建单。

function toolError(msg: string): string {
  return JSON.stringify({ error: msg });
}

/** 报价上下文（含金额）。价格护栏靠它认出「这个数字是工具算的，不是模型编的」 */
function rememberQuote(routeId: string, q: Quote, departDate?: string): Session['lastQuote'] {
  return {
    routeId,
    routeTitle: q.routeTitle,
    travelers: q.travelers,
    perPerson: q.perPerson,
    total: q.total,
    departDate,
  };
}

/** 把刚记下的 lastQuote 追加进报价历史（见 Session.quoteHistory；价格护栏拿它算两次报价之差），封顶 12 条 */
function rememberQuoteHistory(session: Session): void {
  const q = session.lastQuote;
  if (!q?.perPerson || !q.total) return;
  const entry = { routeId: q.routeId, travelers: q.travelers, perPerson: q.perPerson, total: q.total, departDate: q.departDate };
  session.quoteHistory = [...(session.quoteHistory ?? []), entry].slice(-12);
}

/** 解析出行人数：接受数字或纯数字字符串，其余（"两"、"2位"…）判非法 */
function parseTravelers(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
}

/** 是否为真实存在的 YYYY-MM-DD 日历日期（拒绝「明天」、2月31日这类） */
function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** 出发日期必须落在「今天 ~ 三年内」：模型常把「10月2号」解析成训练年代的过去年份，
 *  另一头也要封顶，否则 2099 年出发也能照常报价出单 */
function pastDateError(s: string): string | null {
  if (s < todayIso()) {
    return `departDate=${s} 是过去的日期（今天是 ${todayIso()}）。客户说的月日请按未来最近的日期理解，改正后重试`;
  }
  const maxDate = `${new Date().getFullYear() + 3}-12-31`;
  if (s > maxDate) {
    return `departDate=${s} 超出可预订范围（最远 ${maxDate}）。请与客户确认真实出行年份`;
  }
  return null;
}

/**
 * handoff_to_human 回给模型的话。转人工后引擎让 AI 彻底沉默（engine.ts handleMessageInner），模型却不知道：
 * 实测转完还写「想听听别的线路随时告诉我，我可以马上帮您查～」，客户真回一句就没人应了。
 */
export const HANDOFF_NOTE =
  '已转人工：这是你给这位客户的最后一条回复，之后由资深顾问接手，你不会再回复他。' +
  '这条只安抚一句、说明顾问会尽快联系，不要再推荐线路或报价，也不要说「随时告诉我 / 随时找我 / 我马上帮您查」这类之后兑现不了的话。' +
  // 实测 2/6：「帮您落实明年 2 月两位的冰岛行程」「为您定制冰岛两人极光之旅」——能不能做要顾问评估，AI 先替公司答应了
  '客户要的地方我们没有现成线路时，只说顾问会联系评估，不要替顾问承诺能去、能安排或能定制原目的地（不说「帮您落实冰岛行程」「为您定制冰岛之旅」）。';

/**
 * 进入转人工。引擎的各条转人工路径（明确诉求安全网、改行程护栏）和 handoff_to_human 工具
 * 都必须走这里：此前只有后台「接管」会记 stageBeforeHandoff，引擎触发的转人工（包括正则
 * 误伤）一律不记，顾问点「交还 AI」时只能反推阶段，recommend 的客户被打回 discovery。
 * 已在转人工中就不覆盖——否则记下的会是 handoff 本身，原阶段永久丢失（与 server.ts 的接管同一规则）。
 */
export function enterHandoff(session: Session, prevStage: SalesStage = session.stage): void {
  if (session.stage !== 'handoff' && prevStage !== 'handoff') session.stageBeforeHandoff = prevStage;
  session.handedOver = true;
  session.stage = 'handoff';
}

/**
 * 记下这次查到的线路，供下一轮会话状态带给模型（见 Session.lastShownRoutes）。
 * 新查到的排前面、与旧的去重，封顶 5 条；查空了不清——客户看过的线路还在对话里。
 */
export function rememberShownRoutes(session: Session, routes: { id: string; title: string; priceFrom: number }[]): void {
  if (!routes.length) return;
  const fresh = routes.map(({ id, title, priceFrom }) => ({ id, title, priceFrom }));
  const older = (session.lastShownRoutes ?? []).filter((r) => !fresh.some((f) => f.id === r.id));
  session.lastShownRoutes = [...fresh, ...older].slice(0, 5);
  rememberSeenRoutes(
    session,
    fresh.map((r) => r.id),
  );
}

/** 记下工具交给过模型的线路，不封顶（见 Session.seenRouteIds；价格护栏据此认「本会话出现过的线路」） */
export function rememberSeenRoutes(session: Session, ids: string[]): void {
  const seen = new Set(session.seenRouteIds ?? []);
  for (const id of ids) if (id) seen.add(id);
  session.seenRouteIds = [...seen];
}

/**
 * 引擎按客户原话认出来、工具这边认不全的情况（客群的说法有几十种，识别口径在 engine.ts SEGMENT_RULES，
 * 不在这里再抄一份）。只影响附给模型的提醒，不改查询结果
 */
export interface ToolHints {
  /** 客户提过同行的长辈（爸妈、婆婆、72 岁…），不含「爸妈在家带娃」这种不同行的 */
  elder?: boolean;
  /** 客户提过高反、海拔 */
  altitudeWorry?: boolean;
}

/**
 * 统一工具执行入口：engine/llm 只走这里。
 * 返回 JSON 字符串（作为 tool 消息回填给 LLM）；副作用直接写在传入的 session 上。
 */
export async function executeTool(name: string, args: Record<string, unknown>, session: Session, hints: ToolHints = {}): Promise<string> {
  const elder = !!hints.elder || session.profile.segment === '银发';
  switch (name) {
    case 'search_routes': {
      // 客群从画像自动补齐。只把 segment 写进工具描述是不够的——模型常常漏传，
      // 一漏传硬约束就形同虚设：画像明明认出是银发，照样能查到 5200 米的珠峰线。
      // 引擎已用确定性正则把客群沉淀到 profile，这里兜底注入，模型显式传的优先。
      const a = args as SearchRoutesArgs;
      if (!a.segment && session.profile.segment) a.segment = session.profile.segment;
      // 引擎在调工具前已把客户这句话记进会话，最后一条客户消息就是这轮的原话
      const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
      const found = await searchRoutes(a, {
        customerText: said.at(-1),
        visited: visitedDestinations(said),
        elder,
        altitudeWorry: hints.altitudeWorry,
      });
      // 工具替模型算好的超预算差额记进会话：价格护栏据此认出「比您预算多 6,800 元」
      // 是工具给的数。只留最近几次搜索的，旧的差额早已不在对话焦点里
      const gaps = found.map((r) => (r as Record<string, unknown>).gapPerPerson).filter((g): g is number => typeof g === 'number' && g > 0);
      // 预算上限本身也记下：客户说的是总预算时，引擎按人数折成了每人数（见 engine.ts groundToolArgs），
      // 超预算提示里写的就是这个折算数——模型照着说「折合每人 15,000」，价格护栏不能当它是编的
      if (typeof a.maxBudgetPerPerson === 'number' && a.maxBudgetPerPerson > 0) gaps.push(a.maxBudgetPerPerson);
      if (gaps.length) session.budgetGaps = [...new Set([...(session.budgetGaps ?? []), ...gaps])].slice(-9);
      rememberShownRoutes(session, found);
      return JSON.stringify(found);
    }
    case 'get_route_detail': {
      const route = loadRoutes().find((r) => r.id === args.routeId);
      if (!route) return JSON.stringify({ error: `线路不存在: ${String(args.routeId)}` });
      rememberSeenRoutes(session, [route.id]);
      return JSON.stringify(routeDetail(route, { elder, altitudeWorry: hints.altitudeWorry }));
    }
    case 'search_hotels':
      return JSON.stringify(searchHotels(args as Parameters<typeof searchHotels>[0]));
    case 'create_quote': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (args.departDate !== undefined) {
        if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
      // 记住报价上下文，供成单安全网兜底下单；金额同时是价格护栏的白名单来源
      session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
      rememberQuoteHistory(session);
      rememberSeenRoutes(session, [args.routeId]);
      // 客户说过预算就替模型比好：在不在预算内、超多少。此前模型自己判断，报了每人 31,680 还说「在您 3 万预算内」。
      // 差额记进 budgetGaps，模型转述「比您预算多 1,680 元」时价格护栏才认得出
      const budget = budgetVerdict(session, q);
      if (budget?.gap) session.budgetGaps = [...new Set([...(session.budgetGaps ?? []), budget.gap])].slice(-9);
      saveSession(session);
      // 日期可能是引擎按客户原话补上的（见 engine.ts groundToolArgs），带回去模型才知道这是按哪天算的价
      return JSON.stringify({ ...q, ...(args.departDate ? { departDate: args.departDate } : {}), ...budget?.fields });
    }
    case 'generate_proposal': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (args.departDate !== undefined) {
        if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      const route = loadRoutes().find((r) => r.id === args.routeId);
      if (!route) return toolError(`线路不存在: ${String(args.routeId)}`);
      if (!route.itinerary?.length) return toolError(`线路 ${route.id} 暂无逐日行程数据，无法出方案书`);
      const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
      session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
      rememberQuoteHistory(session);
      rememberSeenRoutes(session, [route.id]);
      saveSession(session);
      // 无状态链接：参数编进 URL，页面按同一套规则重算，不引入新的持久化与清理负担
      const url = `/proposal/${route.id}/${travelers}` + (args.departDate ? `/${String(args.departDate)}` : '');
      return JSON.stringify({
        proposalUrl: url,
        routeTitle: route.title,
        days: route.days,
        perPerson: q.perPerson,
        total: q.total,
        note: q.note,
        dayCount: route.itinerary.length,
      });
    }
    case 'create_order': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (!isValidIsoDate(args.departDate)) {
        return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期；客户没给具体日期时先问清，不要自行猜测');
      }
      {
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      // 幂等防护：同参数的待支付订单已存在时直接复用（企微消息重放、客户复述
      // 「就订」都会再触发一次 create_order，不能每次都真建一单）
      const dup = session.orderIds
        .map((id) => getOrder(id))
        .find(
          (o) =>
            o &&
            o.status === 'pending_payment' &&
            o.routeId === args.routeId &&
            o.travelers === travelers &&
            o.departDate === args.departDate,
        );
      // 结果带上订单的出发日期：引擎可能按客户明说的那天改过模型传的日期，模型要照这个写给客户。
      // 复用要说清是复用：此前字段和新建时一模一样，客户说「闺蜜那份也订上」，模型拿到的是客户自己那张单，
      // 却回「闺蜜那份也订好啦」——把本人的订单当成别人的发了出去（C06），或是「这次已经下好了」（C03）
      if (dup) {
        return JSON.stringify({
          orderId: dup.id,
          payUrl: '/pay/' + dup.id,
          total: dup.totalPrice,
          departDate: dup.departDate,
          reused: true,
          note:
            `这是本会话已有的那张订单（${dup.travelers} 位 / ${dup.departDate} 出发），不是新建的。` +
            '不要说成刚下了一单，更不要说成是给别人的订单；客户要给别人另订一份，这张单替代不了，先问清是合并成一单还是请顾问单独下。',
        });
      }
      const quote = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate });
      const order = createOrder({
        sessionId: session.id,
        routeId: args.routeId,
        routeTitle: quote.routeTitle,
        travelers: quote.travelers,
        departDate: args.departDate,
        totalPrice: quote.total,
      });
      // 改单：同一条线换了人数或日期重新下单，旧的待付款单作废。此前 8/8 次改单都留着两张待付款，
      // 模型却对客户说「之前的作废了 / 不用管」，旧链接照样能付。已付款的单绝不动（supersedeOrder 只认待付款）
      const superseded: string[] = [];
      for (const id of session.orderIds) {
        const o = getOrder(id);
        if (o && o.routeId === order.routeId && supersedeOrder(id, order.id)) superseded.push(id);
      }
      session.orderIds.push(order.id);
      rememberSeenRoutes(session, [args.routeId]);
      session.lastQuote = undefined; // 已成单即清除，防安全网对同一报价重复建单
      saveSession(session);
      // payUrl 为相对路径，渠道层负责拼 PUBLIC_BASE_URL。note 是这张单的定价说明（旺季 / 95 折），差价要讲原因时用它
      return JSON.stringify({
        orderId: order.id,
        payUrl: '/pay/' + order.id,
        total: order.totalPrice,
        departDate: order.departDate,
        note: quote.note,
        ...(superseded.length
          ? {
              supersededOrderId: superseded[superseded.length - 1],
              supersededNote:
                '客户之前那张同线路的待付款订单已作废，旧支付链接已失效。照实告诉客户「之前那张单已作废、旧链接失效，按这张新的付款」，只发这次的新链接。',
            }
          : {}),
      });
    }
    case 'handoff_to_human': {
      enterHandoff(session);
      const reason = String(args.reason ?? '')
        .trim()
        .slice(0, 200);
      // 原因此前只回给了模型，接手的顾问在后台看不到客户要什么（「想去南极，10 月两位」），得从头翻聊天记录。
      // system 消息只在后台显示，不发给客户、也不进模型历史
      if (reason) session.messages.push({ role: 'system', content: `AI 已转人工：${reason}`, at: Date.now() });
      saveSession(session);
      return JSON.stringify({ ok: true, reason, note: HANDOFF_NOTE });
    }
    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}
