// 价格出口校验：报价数字必须能追溯到产品库或本会话的工具结果，模型自己写的价格发不出去。
//
// 此前 URL/订单号有确定性护栏，价格却只有提示词约束（「严禁自己编造任何价格」）——
// 模型真写错一个数字就直接发给客户了。对高客单价产品这是最贵的一类错误：客户按错价
// 下单、成交后才发现，要么公司认亏要么当场翻脸。
import { isOriginMention, loadHotels, loadRoutes, mentionsPlace, offCatalogPlaces } from './tools.js';
import { getOrder } from './store.js';
import type { Route, Session } from './types.js';
import { ConfigNotReadyError } from './config/source.js';
import {
  amountHits as coreAmountHits,
  normalizeMoneyText,
  parseAmounts as coreParseAmounts,
  parseCnAmounts as coreParseCnAmounts,
  parseRangeEndpoints as coreParseRangeEndpoints,
  parseSpokenAmounts,
  spokenMoney as coreSpokenMoney,
  type MoneyParseOptions,
} from './core/parse/money.js';
import { clauses, sentences, sentenceUnits } from './core/parse/sentences.js';
export { sentenceUnits } from './core/parse/sentences.js';

/** 与 tools.ts parseTravelers 的上限对齐。此前只枚举到 20，25 人团的真实工具报价
 *  会被自己的护栏判成「编造」，且模型重算还是同一个数字，客户永远拿不到总价 */
const MAX_TRAVELERS = 50;

/**
 * 回复里出现这些词，说明这是在对客户「报出成交价」，而不是复述他的预算。
 * 此时金额必须来自产品库定价规则或本会话的工具结果——客户自己喊的数字不作数，
 * 否则客户只要说一句「别家 6800，你给我 6800 我立刻订」，模型顺着答
 * 「好的，就按 6800 给您锁定」就能过护栏，而客户点开支付页收的是真实价。
 * 「就按这条走」「就按这个方案来」另算，见 ROUTE_PICK。
 */
const CLOSING_PRICE = /就按|按这个价|按这个数|给您锁定|锁定名额|成交价|优惠价|这个价格给您|给您这个价|就这个价|帮您下单|为您下单/;
/**
 * 「就按这条走」「就按这个方案来」多半是在选线路、不是在报价：实测「两个方向您看哪个更合适：一是预算能往上提一点
 * 就按这条走；二是我帮您找……把价格拉回 1 万 5 以内」被当成成交语境，客户说过的预算跟着不作数，复述的 1 万 5 成了编价。
 * 但它同样能用来顺着客户砍的价成交（「好的，就按这条走，每人 6,800 元」），所以只在它所在的分句
 * （句号之外「；」也断开——上面那句的两个选项就是分号隔开的）里没有金额时才不算
 */
const ROUTE_PICK = /就按[这那](?:条|个方案|个行程|个路线)/;
const ROUTE_PICK_ALL = new RegExp(ROUTE_PICK.source, 'g');
/**
 * 「按这个数 / 按这个预算帮您找匹配的线路」：按客户的预算去查，不是在报成交价。A04 第 2 遍第 3 轮
 * 「或者告诉我每人预算能放宽到多少，我按这个数帮您找匹配的线路」被当成成交语境，工具给的超预算差额 20,160 跟着被当成编价删了。
 * 后面接着找 / 匹配 / 筛 / 推荐 / 挑 / 搜 / 查这类检索动作的不算。
 * 带「就」的「就按这个数」一律照旧算成交；「看」不算检索（「按这个数您看行不行」「给您看看名额」是在顺着客户的价成交）；
 * 查的是能不能下单、名额的也不算（「按这个数帮您查一下能不能下单」）。此前这三样都放过了，客户喊的「6800 一个人」
 * 被模型顺着答「那就按这个数您看行不行：每人 6,800 元」照发（第五轮复核）
 */
const BUDGET_LOOKUP =
  /(?<!就)按(?:这个|这|您说的|您给的|你说的|您的)?(?:数|预算|价位)(?:(?!下单|锁定|成交|定下|名额)[^，,。；;！？!?\n]){0,8}?(?:找|匹配|筛|推荐|挑|搜|查)(?![^，,。；;！？!?\n]{0,8}(?:下单|锁定|成交|名额|订|定下|付款))/g;
/** 婉拒砍价的说法。sop.md 要求「不许直接降价、可以讲价值或换更低档线路」，
 *  于是模型会写「这个价格给您安排不了」「我们没法按这个价走」——里面照样含客户
 *  报的数字和上面的成交措辞，但语义是**拒绝**，不是报成交价。不排除就会把
 *  SOP 教的标准话术整条替换成兜底，客户看到 AI 答非所问。 */
const PRICE_REFUSAL = /做不了|安排不了|没法|无法|不能按|做不到|没有.{0,6}(?:这样|这个)|达不到|恐怕|抱歉/;

/**
 * 酒店每晚价（search_hotels 返回的 nightlyFrom）同样是产品库价。此前没进白名单，模型照工具结果
 * 说「这家每晚 3,800 元起」，整条酒店推荐被换成「价格我得按系统核准的来」。
 * 但只在「每晚 / 一晚 / 房价」紧贴着这个数时认（「每晚 3,800」「3,800 元/晚」「3800元起一晚」）：
 * 酒店价落在 900~30,000 之间，放宽到整句等于把 6,800、12,000、3,000 这些数放过——
 * 「就按每人 6,800 元给您锁定，每晚都住松赞」「每人 12,000 元，含一晚林芝」里的「每晚 / 一晚」
 * 说的是住宿安排，管不到前面的团费。乘晚数、乘间数是模型自己算的总价，照样拦。
 */
const HOTEL_BEFORE = /(?:每晚|一晚|房价|间夜)[^\d¥￥，,。！!？?；;\n]{0,4}$/;
const HOTEL_AFTER = /^\s*(?:元|块)?\s*起?\s*(?:[/／]\s*(?:晚|间夜)|[一每]晚)/;

/** 这条回复里有没有「在报成交价」的句子（排除婉拒句） */
function hasClosingPrice(visible: string): boolean {
  return sentences(visible).some((s) => {
    if (PRICE_REFUSAL.test(s)) return false;
    // 此前还有一条：同一句里说着预算的，不带「就」的「按这个数」一律不算——「您预算 6800，行，按这个数给您安排：每人 6,800 元」
    // 就这么放过了。按预算去查的说法上面 BUDGET_LOOKUP 已经认得，那条去掉
    if (CLOSING_PRICE.test(s.replace(ROUTE_PICK_ALL, '、').replace(BUDGET_LOOKUP, '、'))) return true;
    return s.split(/[；;]/).some((c) => ROUTE_PICK.test(c) && (amountHits(c).length > 0 || parseWanAmounts(c).length > 0));
  });
}

/** 金额说的是人均还是总价——由紧邻的限定词决定，认不出来就两边都比 */
export type Scope = 'perPerson' | 'total' | 'any';
const PER_PERSON_HINT = /(?:人均|每人|单人|每位|一位)[^\d¥￥]{0,4}$/;
const TOTAL_HINT = /(?:总价|总共|一共|共计|合计|总计|总额)[^\d¥￥]{0,4}$/;
const PER_HEAD_AFTER = /^\s*(?:元|块钱?)?\s*(?:一位|一个人|一人|每人|每位|[/／]\s*(?:人|位))/;

interface WanAmount {
  value: number;
  tol: number;
  scope: Scope;
  travelers?: number;
  /** 在原文中的起止位置（止于约数词之后），判断酒店每晚价是否紧贴用 */
  at: number;
  end: number;
}

// 金额前面常常就写着人数（「两位一共 7.6 万」）。写了就按这个人数收窄总价白名单——
// 不收窄的话，2 人的总价会拿去跟 1-50 人的全部总价比，产品库里总能找到一个接近的
// 真实价位（实测 7.6 万命中的是「1 人 × 最贵线 × 旺季」的 75,680）。
const COUNT_BEFORE = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:位|人|个人|大人)[^\d¥￥]{0,6}$/;
const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseCount(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (CN_DIGIT[raw]) return CN_DIGIT[raw];
  const m = /^十([一二三四五六七八九])$/.exec(raw); // 十一 ~ 十九
  if (m) return 10 + CN_DIGIT[m[1]];
  const m2 = /^([二三四五六七八九])十([一二三四五六七八九])?$/.exec(raw); // 二十~九十九
  if (m2) return CN_DIGIT[m2[1]] * 10 + (m2[2] ? CN_DIGIT[m2[2]] : 0);
  return undefined;
}

// 旅游的识别下限和精度容差暂留旧入口，第 9 步随价格护栏移入包阈值。
const MONEY_OPTIONS: MoneyParseOptions = { minimumAmount: 1000, precisionTolerance: 0.5 };
const amountHits = (text: string) => coreAmountHits(text, MONEY_OPTIONS);
const parseAmounts = (text: string) => coreParseAmounts(text, MONEY_OPTIONS);
const parseCnAmounts = (text: string) => coreParseCnAmounts(text, MONEY_OPTIONS);
const parseRangeEndpoints = (text: string) => coreParseRangeEndpoints(text, MONEY_OPTIONS);

function parseWanAmounts(text: string): WanAmount[] {
  return parseSpokenAmounts(text, MONEY_OPTIONS).map((n) => {
    const before = text.slice(Math.max(0, n.at - 14), n.at);
    const scope: Scope =
      PER_PERSON_HINT.test(before) || PER_HEAD_AFTER.test(text.slice(n.end)) ? 'perPerson' : TOTAL_HINT.test(before) ? 'total' : 'any';
    const cm = COUNT_BEFORE.exec(before);
    return { value: n.value, tol: n.tol, scope, travelers: cm ? parseCount(cm[1]) : undefined, at: n.at, end: n.end };
  });
}

/** 客户金额的旧签名：核心解析补入旅游阈值，金额与区间端点仍返回数值。 */
export function spokenMoney(text: string): { amounts: number[]; rangeEnds: number[] } {
  return coreSpokenMoney(text, MONEY_OPTIONS);
}

/**
 * 客户自己说过的金额：当前这句 + 全部历史消息。
 * 此前「万」换算只对当前这句做，客户首轮说「预算每人3万」、几轮后模型复述
 * 「我给您控制在 30,000元 以内」会被判成编价，客户看到 AI 突然不认自己的预算。
 */
function customerAmounts(session: Session, customerText: string): number[] {
  const texts = [customerText, ...(session.messages ?? []).filter((m) => m.role === 'customer').map((m) => m.content)];
  // 不带单位的四到六位数也算（「便宜点，19999 卖不卖」）：spokenMoney 不认它，因为引擎拿同一套读预算，
  // 「2026 年去」不能被当成预算；这里只是白名单，多放一个客户自己说过的数代价很小
  return texts.flatMap((t) => [
    ...spokenMoney(t).amounts,
    ...(normalizeMoneyText(t).match(/(?<![\d.,])\d{4,6}(?![\d.,])/g) ?? []).map(Number),
  ]);
}

// ---------------- 本会话出现过的线路 ----------------
//
// 产品库的价只在那条线本会话出现过时才放行。此前整库 20 条线的价全在白名单里，护栏只判「这个数有没有出处」：
// 实测模型一个工具都没调，编了一条「南极深度体验线的替代方向……人均起价 68800 起」——68800 恰好是西藏松赞线的价，
// 照样发给了客户。客户看到的是一条不存在的线路配一个真实价格，比明摆着的错价更难察觉。
// 「出现过」按下面几处认，都是客户在这段对话里真能看到、或模型手里真有的线路：
//   · 本轮的工具结果（search_routes / get_route_detail / create_quote / generate_proposal / create_order，含引擎预取）；
//   · 会话状态里记着的：工具交给过模型的全部线路（seenRouteIds）、最近查到的线路、最近报价、已有订单；
//   · 之前的回复里写过价的线路（顾问接管时手写的介绍、seenRouteIds 上线前的老会话）；
//   · 对话里（含这条回复）点了名的：线路标题里的专有名词（松赞、珠峰大本营、兵马俑…），
//     或只对应一条线的目的地（西安、贵州、瑞士…）。「西藏」「日本」这种对应好几条线的不算点名。
//     客户说成出发地的不算（「我在北京，想去南极」没点北京那条线）；回复里跟库外目的地同一分句的也不算——
//     「对标松赞品质的南极线」「埃及金字塔线跟西安兵马俑一样」是拿真线路给编出来的线作比，不是在推那条线。

/** 本轮一次工具调用：参数和返回原文（引擎的 ToolCall 就是这个形状） */
export interface TurnToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

/** 标题里不指向某条线的修饰词：切出来的名字去掉它们（「松赞全线」→「松赞」，「洱海古城」→「洱海」） */
const TITLE_FILLER =
  '全线|环线|秘境|深度|之旅|亲子|蜜月|度假|奢华|全景|双岛|浮潜|一价全包|海岛|美学|雨林|越野|摄影|纵贯|南北疆|双乐园|乐园|古城|极光|玻璃屋';
const FILLER_EDGE = new RegExp(`^(?:${TITLE_FILLER})+|(?:${TITLE_FILLER})+$`, 'g');
/**
 * 标题按「·」、天数、中英文之间的空格切开；「雪山」也切（「梅里雪山松赞环线」要切出「松赞」）。
 * 「冰川」「雪山」「极光」这类景观词不能单独算点名：编出来的「南极冰川雪原线」里全是它们
 */
const TITLE_SPLIT = /[·・、,，/（）()]|\d+\s*[日天]|(?<=[一-鿿])\s+|\s+(?=[一-鿿])|雪山/;

/** 每条线能被「点名」的叫法。标题里的专有名词 + 只对应这一条线的目的地 / 别名 */
export function routeNames(routes: Route[]): Map<string, string[]> {
  const places = new Map<string, string[]>();
  for (const r of routes) {
    for (const p of [r.destination, ...(r.aliases ?? [])]) {
      if (p) places.set(p, [...(places.get(p) ?? []), r.id]);
    }
  }
  const out = new Map<string, string[]>();
  for (const r of routes) {
    const own = [r.destination, ...(r.aliases ?? [])].filter(Boolean);
    const names = new Set<string>();
    for (let piece of r.title.split(TITLE_SPLIT)) {
      piece = piece.trim();
      // 「新疆伊犁」「日本京都东京」「瑞士冰川快车」：开头的目的地不算这条线自己的名字
      for (const p of own) if (piece.startsWith(p) && piece.length > p.length) piece = piece.slice(p.length);
      piece = piece.replace(FILLER_EDGE, '').replace(/\s+/g, '');
      if (piece.length >= 2 && !places.has(piece)) names.add(piece);
    }
    for (const p of own) if (places.get(p)?.length === 1) names.add(p);
    out.set(r.id, [...names]);
  }
  return out;
}

/** 这段文字点了名的线路。skip：这个叫法在原文里不算点名（客户说的出发地）。地名按整词认（tools.ts mentionsPlace） */
export function namedRoutes(text: string, names: Map<string, string[]>, skip?: (name: string) => boolean): string[] {
  const t = text.replace(/\s+/g, '');
  return [...names].filter(([, ns]) => ns.some((n) => mentionsPlace(t, n) && !skip?.(n))).map(([id]) => id);
}

/** 本轮 search_routes 落空（destinationMiss）的目的地：库外地名表里没收的地方（「南美洲」「马丘比丘」）也认得出 */
function missTargets(turnCalls: TurnToolCall[]): string[] {
  return turnCalls
    .filter((c) => c.name === 'search_routes' && typeof c.args?.destination === 'string' && /destinationMiss/.test(c.result ?? ''))
    .flatMap((c) => String(c.args.destination).split(/[、,，/\s]+/))
    .filter((d) => d.length >= 2);
}

/** 这个分句在说我们没有的目的地 */
function talksOffCatalog(s: string, misses: string[]): boolean {
  return offCatalogPlaces(s).length > 0 || misses.some((d) => s.includes(d));
}

/** 这段文字写到了哪些线路的价（基准价 / 旺季价；阿拉伯数字或精确到千位的口语万） */
function pricedRoutes(text: string, routes: Route[]): string[] {
  const t = normalizeMoneyText(text);
  const nums = [
    ...(t.match(/(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d{4,6})(?!\d)/g) ?? []).map((x) => ({ value: Number(x.replace(/,/g, '')), tol: 0 })),
    ...parseWanAmounts(t).filter((w) => w.tol < TIER_TOL),
  ];
  return routes
    .filter((r) => [r.priceFrom, Math.round(r.priceFrom * 1.1)].some((p) => nums.some((n) => Math.abs(n.value - p) <= n.tol)))
    .map((r) => r.id);
}

/** 工具返回里的线路 id：search_routes 是摘要数组，get_route_detail 是整条线路 */
function idsInResult(result: string | undefined): string[] {
  if (!result) return [];
  try {
    const parsed: unknown = JSON.parse(result);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** 本会话出现过的线路 id（规则见上） */
function routesInPlay(
  session: Session,
  visible: string,
  customerText: string,
  turnCalls: TurnToolCall[],
  routes: Route[],
  names: Map<string, string[]>,
  misses: string[],
): Set<string> {
  const seen = new Set<string>(session.seenRouteIds ?? []);
  for (const c of turnCalls) {
    if (typeof c.args?.routeId === 'string') seen.add(c.args.routeId);
    for (const id of idsInResult(c.result)) seen.add(id);
  }
  for (const r of session.lastShownRoutes ?? []) seen.add(r.id);
  if (session.lastQuote?.routeId) seen.add(session.lastQuote.routeId);
  for (const q of session.quoteHistory ?? []) seen.add(q.routeId);
  for (const id of session.orderIds ?? []) {
    const o = getOrder(id);
    if (o) seen.add(o.routeId);
  }
  const msgs = session.messages ?? [];
  for (const t of [customerText, ...msgs.filter((m) => m.role === 'customer').map((m) => m.content)]) {
    for (const id of namedRoutes(t, names, (n) => isOriginMention(t, n))) seen.add(id);
  }
  const agentSaid = msgs.filter((m) => m.role === 'agent').map((m) => m.content);
  for (const t of [visible, ...agentSaid]) {
    for (const { s } of clauses(t)) {
      if (talksOffCatalog(s, misses)) continue;
      for (const id of namedRoutes(s, names)) seen.add(id);
    }
  }
  // 之前的回复写过价的线路：模型看得到历史，照着复述是在转述、不是在编。这条回复本身不算——它就是要核的对象
  for (const t of agentSaid) {
    for (const { s } of clauses(t)) if (!talksOffCatalog(s, misses)) for (const id of pricedRoutes(s, routes)) seen.add(id);
  }
  return seen;
}

/**
 * 档位话术：只精确到「万」这一位的说法（「人均 5 万左右这个档」「四万多」「一万多」），容差 ±5000。
 * 这是 SOP 教的说价位的话，说的是一个价位段、不是哪条线的价，仍按整库比对；
 * 精确到千位以下的数（68800、3.8 万、三万八）就是某条线的价，只按本会话出现过的线路比对
 */
const TIER_TOL = 5000;

// ---------------- 报价之差 ----------------
//
// 改期、改人数之后，模型会拿两次真实报价作比：「比元旦出发省了 4,740 元」「每人省 1,580」「一家三口能省将近 4700」。
// 这些数是工具算出来的两个价相减，客户拿不到它的出处，价格护栏此前也认不出——场景测试里拦下的 5 次全是这种误拦。
// 差额只从工具真算过的金额里来（报价历史、最近报价、订单），客户说的数不参与，所以报成交价时照样放行。

/** 本会话工具真算过的报价：报价历史 + 最近一次报价 + 订单（订单只有总价，单价按总价 ÷ 人数） */
function quotesOf(session: Session): { routeId: string; travelers: number; perPerson: number; total: number }[] {
  const out = [...(session.quoteHistory ?? [])];
  const q = session.lastQuote;
  if (q?.perPerson && q.total) out.push({ routeId: q.routeId, travelers: q.travelers, perPerson: q.perPerson, total: q.total });
  for (const id of session.orderIds ?? []) {
    const o = getOrder(id);
    if (o)
      out.push({
        routeId: o.routeId,
        travelers: o.travelers,
        perPerson: Math.round(o.totalPrice / Math.max(1, o.travelers)),
        total: o.totalPrice,
      });
  }
  return out;
}

/**
 * 同一线路报价两两之差（每人价之差、总价之差）。除了真报过的几次互相比，每次报价还跟它自己「不上浮 / 上浮」
 * 「不打折 / 95 折」的另一种算法比——「旺季每人多 1,580」「4 位享 95 折每人省 869」说的就是这个。
 * approx 是差额的口语约数（整百、整千）：「将近 4700」「省了近 5000」，只从真报过的两次报价之差来——
 * 一次报价跟自己另一种算法的差再取整，整百整千的数铺得太开（1,680 → 1600、1700、2000），编的「升级加 2,000」全能对上。
 * 差额不进通用白名单，只在比价的说法里认（见 diffBacked）
 */
function quoteDiffs(session: Session, routes: Route[]): { exact: number[]; approx: number[] } {
  const exact = new Set<number>();
  const pairs = new Set<number>();
  const quotes = quotesOf(session);
  const diff = (a: { perPerson: number; total: number }, b: { perPerson: number; total: number }, into = exact) => {
    for (const d of [Math.abs(a.perPerson - b.perPerson), Math.abs(a.total - b.total)])
      if (d > 0) {
        exact.add(d);
        into.add(d);
      }
  };
  quotes.forEach((a, i) =>
    quotes.slice(i + 1).forEach((b) => {
      if (a.routeId === b.routeId) diff(a, b, pairs);
    }),
  );
  for (const q of quotes) {
    const r = routes.find((x) => x.id === q.routeId);
    if (!r) continue;
    // 规则照 tools.createQuote：先上浮 10%，再按 4 人及以上 95 折
    for (const base of [r.priceFrom, Math.round(r.priceFrom * 1.1)]) {
      for (const off of q.travelers >= 4 ? [false, true] : [false]) {
        const pp = off ? Math.round(base * 0.95) : base;
        diff(q, { perPerson: pp, total: pp * q.travelers });
      }
    }
  }
  const approx = new Set<number>();
  for (const d of pairs) {
    for (const v of [Math.round(d / 100) * 100, Math.floor(d / 100) * 100, Math.ceil(d / 100) * 100, Math.round(d / 1000) * 1000]) {
      if (v >= 1000 && v !== d) approx.add(v);
    }
  }
  return { exact: [...exact], approx: [...approx] };
}

interface Allowed {
  perPerson: Set<number>;
  total: Set<number>;
  /** 按出行人数分桶的总价：话里写了人数时只比对对应那一桶 */
  totalByCount: Map<number, Set<number>>;
  /** 工具真算出来的报价/订单金额，以及客户自己说的数——与人数无关，永远放行 */
  authoritative: Set<number>;
  /** 酒店每晚价：只在「每晚 / 元/晚」紧贴这个数时放行（见 HOTEL_BEFORE） */
  hotelNightly: Set<number>;
  /** 客户说的万以上的数按千位截断 / 四舍五入的读法：只给回复里口语的「万」（一万九、3.8 万）用 */
  customerApprox: Set<number>;
}

/**
 * 本会话允许出现的金额白名单，分「人均」与「总价」两套。
 *
 * 分开是必需的：混成一套之后，人均价会去跟几千个总价比对，20 条线 × 50 人的总价
 * 把数轴铺得到处都是，任何编出来的人均价都能在里面找到一个「接近」的数。
 *
 * 生成规则严格照 tools.createQuote，不枚举不可能出现的组合——尤其 95 折只在 4 人及以上，
 * 此前对 1-3 人也算了一遍折后价，凭空多出一批根本报不出来的金额。
 */
function allowedAmounts(session: Session, customerText: string, includeCustomerSaid: boolean, routes: { priceFrom: number }[]): Allowed {
  const perPerson = new Set<number>();
  const total = new Set<number>();
  const totalByCount = new Map<number, Set<number>>();
  const authoritative = new Set<number>();
  const hotelNightly = new Set<number>();
  const customerApprox = new Set<number>();
  const add = (set: Set<number>, n: number) => {
    if (Number.isFinite(n) && n > 0) set.add(Math.round(n));
  };

  for (const r of routes) {
    // 旺季 +10% 是唯一会改人均价的规则（见 createQuote），基准价与旺季价各算一套
    for (const base of [r.priceFrom, Math.round(r.priceFrom * 1.1)]) {
      const discounted = Math.round(base * 0.95);
      add(perPerson, base);
      add(perPerson, discounted); // 4 人及以上
      for (let t = 1; t <= MAX_TRAVELERS; t++) {
        const sum = (t >= 4 ? discounted : base) * t;
        add(total, sum);
        let bucket = totalByCount.get(t);
        if (!bucket) totalByCount.set(t, (bucket = new Set<number>()));
        add(bucket, sum);
      }
    }
  }
  let hotels: { nightlyFrom: number }[] = [];
  try {
    hotels = loadHotels();
  } catch (e) {
    if (e instanceof ConfigNotReadyError) throw e; // 只吞文件解析错误；配置源没装载好是启动顺序出了错，不能当成空表
  }
  for (const h of hotels) add(hotelNightly, h.nightlyFrom);
  const q = session.lastQuote;
  if (q?.perPerson) {
    add(perPerson, q.perPerson);
    add(authoritative, q.perPerson);
  }
  if (q?.total) {
    add(total, q.total);
    add(authoritative, q.total);
  }
  for (const id of session.orderIds ?? []) {
    const o = getOrder(id);
    if (o) {
      add(total, o.totalPrice);
      add(authoritative, o.totalPrice);
      const unit = Math.round(o.totalPrice / Math.max(1, o.travelers));
      add(perPerson, unit);
      add(authoritative, unit);
    }
  }
  if (includeCustomerSaid) {
    // 客户说的数字不知道是人均还是总价，两边都放
    for (const n of customerAmounts(session, customerText)) {
      add(perPerson, n);
      add(total, n);
      add(authoritative, n);
      // 万以上的数模型复述时常按千位截断或四舍五入成口语（客户「19999 卖不卖」→「两位如果预算定在一万九」），
      // 这两个读法单独记，只给口语的「万」用：阿拉伯数字写出来的精确金额仍得跟客户的数一模一样——
      // 否则客户说「携程上 12999」，模型回「我们这条每人 13,000 元左右」就成了客户说过的数
      if (n >= 10000) for (const v of [Math.floor(n / 1000) * 1000, Math.round(n / 1000) * 1000]) add(customerApprox, v);
    }
    // search_routes 替模型算好的超预算差额（每人）。差额是拿客户预算减出来的，客户能借此
    // 「定」出任意数（报个预算让差额恰好等于他想要的价），所以和客户的数同等对待：
    // 报成交价的语境下不放行
    for (const g of session.budgetGaps ?? []) {
      add(perPerson, g);
      add(authoritative, g);
    }
  }
  return { perPerson, total, totalByCount, authoritative, hotelNightly, customerApprox };
}

function setsFor(ok: Allowed, w: WanAmount): Set<number>[] {
  if (w.scope === 'perPerson') return [ok.perPerson];
  // 话里写了人数就只认那一桶的总价（外加工具真算过的金额）
  const totals = w.travelers ? [ok.totalByCount.get(w.travelers) ?? new Set<number>(), ok.authoritative] : [ok.total];
  return w.scope === 'total' ? totals : [ok.perPerson, ...totals];
}

/**
 * 校验回复中的金额。返回未能追溯来源的金额列表（空数组=通过）。
 * turnCalls 是本轮的工具调用（含引擎预取），产品库的价只按其中和会话里出现过的线路放行（见 routesInPlay）。
 * PRICE_GUARD=0 可关闭（仅在排查误杀时使用）。
 *
 * 说我们没有的目的地的分句（「南极深度体验线的替代方向……人均起价 68800 起」）更严：里面的精确金额只认
 * 同一分句点了名、且本会话出现过的线路。「想去南极」有了引擎预取之后，松赞线就在本轮召回的结果里，
 * 只按「出现过」核，这句原样编造照样能过。实测正常的替代推荐是把线路名和价写在一起（「最接近的是北欧芬兰极光玻璃屋
 * 8 日，人均 46,800 起」），或者库外目的地单独一句说没有、线路另起一行，都不受影响。
 *
 * 已知边界：本会话出现过的几条线之间张冠李戴（把 A 线的价安到 B 线上）认不出来——同一分句里既点了真线路、
 * 又说库外目的地的（「冰岛极光 9 日人均 62,800 起，瑞士那条也是 62,800」）同样认不出；
 * 档位话术（「人均 5 万左右」）仍按整库比对，编造的线路配一个整万的档位说法挡不住。
 */
export function findUnbackedPrices(visible: string, session: Session, customerText: string, turnCalls: TurnToolCall[] = []): number[] {
  return findUnbackedPriceHits(visible, session, customerText, turnCalls).map((h) => h.value);
}

/** 一处追溯不到出处的金额：value 同 findUnbackedPrices，at / end 是它在回复原文里的位置（引擎据此只删它所在的那一句） */
export interface PriceHit {
  value: number;
  at: number;
  end: number;
}

/** 同 findUnbackedPrices，带上每个金额在原文里的位置。normalizeMoneyText 逐字替换、位置不变，所以原文位置可以直接用 */
export function findUnbackedPriceHits(visible: string, session: Session, customerText: string, turnCalls: TurnToolCall[] = []): PriceHit[] {
  if (process.env.PRICE_GUARD === '0') return [];
  const text = normalizeMoneyText(visible);
  // 在报成交价：客户自己喊过的数字不能当白名单，否则等于让客户自己定价
  const closing = hasClosingPrice(text);
  let routes: Route[] = [];
  try {
    routes = loadRoutes();
  } catch (e) {
    // 数据文件坏了另有告警，这里不阻断对话；配置源没装载好是启动顺序出了错，照常抛
    if (e instanceof ConfigNotReadyError) throw e;
  }
  const misses = missTargets(turnCalls);
  const names = routeNames(routes);
  const seen = routesInPlay(session, visible, customerText, turnCalls, routes, names, misses);
  const diffs = quoteDiffs(session, routes);
  // 几套白名单只差产品库价取自哪些线路：整库的只给档位话术用，其余金额按本会话出现过的线路核，
  // 说库外目的地的分句再收窄到同一分句点了名的线路
  const tier = allowedAmounts(session, customerText, !closing, routes);
  const inPlay = allowedAmounts(
    session,
    customerText,
    !closing,
    routes.filter((r) => seen.has(r.id)),
  );
  const offCatalog = new Map<number, Allowed>();
  const spans = clauses(text);
  const pick = (tol: number, at: number): Allowed => {
    if (tol >= TIER_TOL) return tier;
    const i = spans.findIndex((c) => at >= c.start && at < c.end);
    if (i < 0 || !talksOffCatalog(spans[i].s, misses)) return inPlay;
    let ok = offCatalog.get(i);
    if (!ok) {
      const here = new Set(namedRoutes(spans[i].s, names));
      ok = allowedAmounts(
        session,
        customerText,
        !closing,
        routes.filter((r) => seen.has(r.id) && here.has(r.id)),
      );
      offCatalog.set(i, ok);
    }
    return ok;
  };
  const bad: PriceHit[] = [];
  const near = (set: Set<number>, v: number, tol: number): boolean => {
    if (!tol) return set.has(v);
    for (const a of set) if (Math.abs(v - a) <= tol) return true;
    return false;
  };
  // 酒店每晚价只在「每晚 / 元/晚」紧贴这个数时认；说的是每人价、或这条回复在报成交价时不认——
  // 客户喊「6800 给我锁定」，模型答「就按每晚 6,800 给您锁定」照样是拿客户的数当成交价
  const hotelOk = (v: number, tol: number, at: number, end: number, perPerson: boolean): boolean =>
    !closing &&
    !perPerson &&
    (HOTEL_BEFORE.test(text.slice(Math.max(0, at - 12), at)) || HOTEL_AFTER.test(text.slice(end))) &&
    near(inPlay.hotelNightly, v, tol);
  // 报价之差不知道说的是每人还是总价（「每人省 1,580」「一家三口省 4,740」），只在比价的小句里认：
  // 同一小句得有「省 / 便宜 / 多 / 贵 / 差 / 比」这类比较词，而且说的不是加钱买的东西（升级、单房差、定金…）；
  // 约数（整百整千）还得带着「将近 / 大概 / 左右」。此前差额和约数直接并进人均、总价白名单，不看上下文，
  // 「每人再加 2,000 元就能升级海景房」「单房差 3,400 元」「总价 3,000 元的定金」全被放行
  const diffBacked = (v: number, tol: number, at: number, end: number): boolean => {
    const from = Math.max(...['，', ',', '。', '！', '？', '\n', '；', ';'].map((c) => text.lastIndexOf(c, at - 1))) + 1;
    const stops = ['，', ',', '。', '！', '？', '\n', '；', ';'].map((c) => text.indexOf(c, end)).filter((i) => i >= 0);
    const clause = text.slice(from, stops.length ? Math.min(...stops) : text.length);
    if (!DIFF_CUE.test(clause) || ADD_ON.test(clause)) return false;
    if (near(new Set(diffs.exact), v, tol)) return true;
    const approxSaid = APPROX_BEFORE.test(text.slice(Math.max(0, at - 6), at)) || APPROX_AFTER.test(text.slice(end, end + 6)) || tol > 0;
    return approxSaid && near(new Set(diffs.approx), v, tol);
  };
  for (const h of amountHits(text)) {
    const perPerson = PER_PERSON_HINT.test(text.slice(Math.max(0, h.at - 14), h.at));
    const ok = pick(h.tol, h.at);
    const backed =
      near(ok.perPerson, h.value, h.tol) ||
      near(ok.total, h.value, h.tol) ||
      hotelOk(h.value, h.tol, h.at, h.end, perPerson) ||
      diffBacked(h.value, h.tol, h.at, h.end);
    if (!backed) bad.push({ value: h.raw, at: h.at, end: h.end });
  }
  for (const w of parseWanAmounts(text)) {
    const ok = pick(w.tol, w.at);
    const backed =
      setsFor(ok, w).some((set) => near(set, w.value, w.tol)) ||
      near(ok.customerApprox, w.value, w.tol) ||
      hotelOk(w.value, w.tol, w.at, w.end, w.scope === 'perPerson') ||
      diffBacked(w.value, w.tol, w.at, w.end);
    if (!backed) bad.push({ value: w.value, at: w.at, end: w.end });
  }
  return bad;
}

/** 比价的说法（报价之差只在这种小句里认，见 diffBacked） */
const DIFF_CUE = /省(?![心事力时])|便宜|实惠|划算|多(?!加)|贵|差|比|少(?!量)|上浮|涨|高出|低/;
/** 加钱买的东西：这些说法里的数是一笔新费用，不是两次报价之差 */
const ADD_ON = /升级|单房差|定金|订金|押金|加购|自费|另付|不占床|附加|签证|机票|小费|加钱|补差/;
const APPROX_BEFORE = /(?:约|近|将近|接近|大概|大约|差不多|快)\s*$/;
const APPROX_AFTER = /^\s*(?:元|块)?\s*(?:左右|上下|出头)/;

/** 回复里的金额（带位置、是人均还是总价）。出口的规则词守卫拿它核「在您预算内」这类说法指的是哪个价 */
export function priceMentions(visible: string): { value: number; tol: number; at: number; end: number; scope: Scope }[] {
  const text = normalizeMoneyText(visible);
  const scopeAt = (at: number): Scope => {
    const before = text.slice(Math.max(0, at - 14), at);
    return PER_PERSON_HINT.test(before) ? 'perPerson' : TOTAL_HINT.test(before) ? 'total' : 'any';
  };
  return [
    ...amountHits(text).map((h) => ({ value: h.value, tol: h.tol, at: h.at, end: h.end, scope: scopeAt(h.at) })),
    ...parseWanAmounts(text).map((w) => ({ value: w.value, tol: w.tol, at: w.at, end: w.end, scope: w.scope })),
  ].toSorted((a, b) => a.at - b.at);
}

/**
 * 之前发给客户的回复里说过这个数没有。价格护栏命中后，只有错价真的发出去过，才对客户说「刚才的价格说得不准」——
 * 这次的错价被拦下、根本没发出去，客户看到的上一条明明是对的，道歉反倒让人以为之前报错了
 */
export function saidBefore(session: Session, values: number[]): boolean {
  return (session.messages ?? [])
    .filter((m) => m.role === 'agent')
    .some((m) => priceMentions(m.content).some((p) => values.some((v) => Math.abs(p.value - v) <= p.tol)));
}

// ---------------- 按句删 ----------------
//
// 出口护栏命中后只删有问题的那几句，其余照发。此前价格护栏一命中就整条换成兜底话术：客户问「马代和巴厘岛哪个好」，
// 收到「告诉我线路和出行人数」；改期后的报价里编了一句差额，连同新日期、新报价一起没了。

const BULLET_HEAD = /^\s*(?:[·•・\-*]|\d{1,2}\s*[.、)）]|[①-⑩])/;

/**
 * 删掉 cuts 碰到的句子。cut 带 replace 时，第一处被删的句子换成这句话（保留原句开头的分点符和结尾的换行）；
 * 同一句话只换一次，其余照删。
 * 引出语一并处理：「报价如下：」「我们有一条替代线路：」底下那一段（一串分点，或紧跟的一段）整段删光了，
 * 引出语自己也删——否则客户看到的是一句「我们有一条南极概念的替代线路：」后面什么都没有。
 */
export function dropSentences(text: string, cuts: { at: number; end: number; replace?: string }[]): { text: string; dropped: string[] } {
  const units = sentenceUnits(text);
  const body = (i: number) => text.slice(units[i].start, units[i].end);
  const blank = (i: number) => !body(i).trim();
  const kill = new Map<number, string | undefined>();
  units.forEach((u, i) => {
    const hit = cuts.filter((c) => c.at < u.end && c.end > u.start);
    if (hit.length) kill.set(i, hit.find((c) => c.replace)?.replace);
  });
  if (!kill.size) return { text, dropped: [] };
  // 行首的句子才可能是引出语底下的内容：先按行把句子归组
  const lineOf: number[] = [];
  let line = 0;
  units.forEach((u, i) => {
    lineOf[i] = line;
    if (text[u.end - 1] === '\n') line += 1;
  });
  const lineUnits = (l: number) => units.map((_, i) => i).filter((i) => lineOf[i] === l);
  const lineBlank = (l: number) => lineUnits(l).every(blank);
  const lineBullet = (l: number) => BULLET_HEAD.test(lineUnits(l).map(body).join(''));
  for (let i = 0; i < units.length; i++) {
    if (kill.has(i) || !/[：:]\s*$/.test(body(i))) continue;
    // 引出语所在行之后：跳过空行，接着的若是分点就取整串分点（中间可夹空行），否则取紧跟的一段（到空行为止）
    let l = lineOf[i] + 1;
    while (l <= line && lineBlank(l)) l += 1;
    if (l > line || !lineUnits(l).length) continue;
    const block: number[] = [];
    if (lineBullet(l)) {
      for (; l <= line && (lineBlank(l) || lineBullet(l)); l += 1) block.push(...lineUnits(l).filter((j) => !blank(j)));
    } else {
      for (; l <= line && !lineBlank(l); l += 1) block.push(...lineUnits(l).filter((j) => !blank(j)));
    }
    if (block.length && block.every((j) => kill.has(j) && kill.get(j) === undefined)) kill.set(i, undefined);
  }
  // 删掉的是一整行分点（只删不换）：它底下缩进更深的续行（亮点、说明）一并删，直到下一个分点或空行。
  // 此前只删了「· 贵州 荔波小七孔 6 日（人均 13,800 起）」这一行，底下的「苗寨长桌宴、非遗蜡染体验」挂到了上一条线下面
  const indent = (l: number) => /^[ \t　]*/.exec(lineUnits(l).map(body).join(''))?.[0].length ?? 0;
  for (let l = 0; l <= line; l++) {
    const us = lineUnits(l);
    if (!us.length || !lineBullet(l) || !us.every((j) => blank(j) || (kill.has(j) && kill.get(j) === undefined))) continue;
    for (let k = l + 1; k <= line && !lineBlank(k) && !lineBullet(k) && indent(k) > indent(l); k++) {
      for (const j of lineUnits(k)) kill.set(j, undefined);
    }
  }
  const used = new Set<string>();
  let out = '';
  const dropped: string[] = [];
  let afterCut = false;
  units.forEach((u, i) => {
    let s = body(i);
    // 紧跟在删掉那句后面、以「所以 / 因此」开头的句子：去掉这个连接词，不然接不上前文（「所以如果预算有限…」）
    if (!kill.has(i) && afterCut) s = s.replace(/^(\s*)(?:所以说?|因此|因为这样|这样一来)[，,]?\s*/, '$1');
    if (s.trim()) afterCut = kill.has(i) && kill.get(i) === undefined;
    if (!kill.has(i)) {
      out += s;
      return;
    }
    dropped.push(s.trim());
    const rep = kill.get(i);
    if (rep && !used.has(rep)) {
      used.add(rep);
      const head = /^\s*(?:[·•・\-*]\s*|\d{1,2}\s*[.、)）]\s*|[①-⑩]\s*)?/.exec(s)?.[0] ?? '';
      out += head + rep + (s.endsWith('\n') ? '\n' : '');
    } else if (s.endsWith('\n') && out && !out.endsWith('\n')) {
      // 删的是行尾那句、同一行前面的句子留着：换行照留，下一行不能接到这一行后面
      out += '\n';
    }
  });
  const tidy = out
    .split('\n')
    .filter((l) => !/^\s*(?:[·•・\-*]|\d{1,2}\s*[.、)）]|[①-⑩])?\s*$/.test(l) || !l.trim())
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: tidy, dropped };
}

// ---------------- 删完还像不像一条回复 ----------------
//
// 按句删之后剩下的不一定接得上：A04 删掉了线路名和价，只剩一句没有指代的「这条的亮点」；B02 说「按 4 人重新报价」却一个价都没有；
// B03 删掉编的两条线后只剩一句问话（「想看雪山古城，还是想躺酒店泡泳池？」）。这种残句发出去，客户不知道在说哪条、价是多少。

/** 还指着前面那条线：「这条的亮点」「上面这两条」「它的酒店」 */
const ROUTE_BACKREF =
  /这条|这一条|这款|这两条|这几条|这个线路|这个行程|上面(?:这|那)?(?:条|几条|两条|款)|以上(?:这|几|两)?条|它(?:的|是|有|在|住|含)/;
/** 宣称在报价：「按 4 人重新报价」「报价如下」 */
const QUOTE_CLAIM =
  /重新报价|重新报|报价如下|报价来了|报价给您|给您报(?:个)?价|价格如下|按\s*[\d一二两三四五六七八九十]+\s*(?:人|位)(?:重新)?(?:报|算)/;

/**
 * 出口护栏按句删过之后（before → after），剩下的是不是残句：原来有价、删完一个价都不剩，而且剩下的
 * ① 还在指着删掉的那条线，② 宣称在报价，或 ③ 除了问句几乎什么都没有（「好的～」）。
 * ③ 的门槛放得很低：「南极没有现成线路。您几位出行？」只剩一句实话加一句问话，是完整的回复，不能当残句换掉。
 * ① 只在删掉的那部分点过的线路、剩下的没再点时才算：「这条线住的是古城精品客栈」本来就指着前文（原文没点名，只删了价），
 * 「推荐北欧极光 8 日。它的玻璃屋…」线路名还在——此前只要剩下「这条 / 它」就整条换成兜底，模型答的内容白白丢了。
 * 原来就没有价的回复不管——那种删的是规则词，不是推荐和报价
 */
export function strandedAfterDrop(before: string, after: string): boolean {
  if (before === after || !priceMentions(before).length || priceMentions(after).length) return false;
  if (QUOTE_CLAIM.test(after)) return true;
  if (ROUTE_BACKREF.test(after)) {
    let routes: Route[] = [];
    try {
      routes = loadRoutes();
    } catch (e) {
      if (e instanceof ConfigNotReadyError) throw e; // 数据文件坏了另有告警；配置源没装载好照常抛
    }
    const names = routeNames(routes);
    // 点名分两层：具体哪条（「中央格兰德」「北欧极光」）和哪个目的地（「马代」三条线共用）。
    // 删掉的是「中央格兰德…人均 28,800」、剩下「马尔代夫度蜜月很合适～这条的亮点」：目的地还在，「这条」指的那条没了（A04）
    const dests = (x: string): string[] => {
      const t = x.replace(/\s+/g, '');
      return routes.filter((r) => [r.destination, ...(r.aliases ?? [])].some((p) => !!p && mentionsPlace(t, p))).map((r) => r.destination);
    };
    const lost = (a: string[], b: string[]): boolean => a.some((x) => !b.includes(x));
    if (lost(namedRoutes(before, names), namedRoutes(after, names)) || lost(dests(before), dests(after))) return true;
  }
  const statements = sentenceUnits(after)
    .map((u) => after.slice(u.start, u.end))
    .filter((s) => !/[？?]\s*$/.test(s.trim()));
  return statements.join('').replace(/[^\p{L}\p{N}]/gu, '').length < 6;
}

/** 仅供自测使用的内部函数出口 */
export const __priceGuardTest = {
  parseAmounts,
  parseWanAmounts,
  parseCnAmounts,
  parseRangeEndpoints,
  CLOSING_PRICE,
  hasClosingPrice,
  routeNames,
  namedRoutes,
};
