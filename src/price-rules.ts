// 出口的价格规则 / 服务承诺守卫：回复里说到「儿童价」「比国庆便宜」「在您预算内」「名额紧张」「支持开专票」这类话，
// 对不上工具结果和写死的定价规则，就删掉那一句（服务承诺换成「由顾问确认」），其余照发。
//
// 为什么在代码层管：定价只有两条规则（出发月在线路最佳季内上浮 10%、4 人及以上 95 折），SOP 写得再清楚，
// 场景测试（2026-09-25，54 个场景 × 2 遍）里模型照样编：「12 月中前是平日价，圣诞到元旦是旺季价」
// 「小朋友按儿童价还能更划算」「比国庆便宜不少」（10 月全月同价）、报了每人 31,680 还说「在您 3 万预算内」、
// 「国庆名额紧张」（约 12 轮 / 8 个场景）；还替公司答应了开专票、资金第三方监管、对公账户、帮订机票、电话联系（本地 6 轮、线上 1 轮）。
// 客户按这些话做决定，成交后才发现对不上，比报错一个数还难收场。
//
// 只删那一句、不整条替换：同一条回复里通常还有真实报价和对别的问题的回答（见 price-guard dropSentences）。
// 判断全是确定性的：比价按线路 bestSeason 算两个日子各自上不上浮，预算按客户原话里的数和这次报价比。
import { dropSentences, namedRoutes, priceMentions, routeNames, sentenceUnits, spokenMoney } from './price-guard.js';
import type { TurnToolCall } from './price-guard.js';
// tools.ts 也 import 本文件（create_quote 的预算比较），是循环引用：两边都只在函数里用对方的导出，模块加载时不碰，所以安全
import { LOWLAND_MAX_ALTITUDE, loadRoutes, peakMonths } from './tools.js';
import { getOrder } from './store.js';
import type { Route, Session } from './types.js';

// ---------------- 客户说过的预算 ----------------

export interface BudgetCap {
  amount: number;
  /** person：每人；total：总共；unclear：没说是每人还是总共（「两个人预算3万」） */
  per: 'person' | 'total' | 'unclear';
  /** 说的是下限（「至少每人3万」「3万以上」）：不能拿来判「超预算」 */
  floor: boolean;
  said: string;
  /** 说预算的那句话里带着的人数（「两个人预算一共3万」）。会话里别处还没记下人数时，拿它把总预算折成每人 */
  heads?: number;
}

const BUDGET_TALK = /预算|budget|以内|之内|以下|不超过|控制在|封顶|顶多|最多/i;
const BUDGET_FLOOR_WORD = /至少|起码|最少|不低于|不少于|以上|往上|打底/;
const PER_PERSON_WORD = /每人|人均|每位|单人|一个人|一人|[/／]\s*人|per\s*person|\bpp\b|each/i;
const TOTAL_WORD = /一共|总共|总预算|合计|加起来|总价|总计|全家|全部/;
const HEADS_SAID =
  /(?<![\d一二两三四五六七八九十])(\d{1,2}|[一二两三四五六七八九十])\s*(?:个大人|个人|位|口人|大人|人)(?![均次])|(我们俩|咱们俩|咱俩|我俩|俩人|两口子|小两口)/;
const CN_COUNT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function headsIn(t: string): number | undefined {
  const m = HEADS_SAID.exec(t);
  if (!m) return undefined;
  if (m[2]) return 2;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : CN_COUNT[m[1]];
  return n > 0 ? n : undefined;
}

/**
 * 客户把预算放开了：「预算不是问题」「不设上限」「钱不是问题」「不差钱」。这句没带数时就是最新的说法，之前说的数不再是上限——
 * 此前没带数的话直接跳过、落回更早那句：客户说完「算了 预算不是问题 想住好一点的」，引擎照样按「一共3万」折成每人 15000 去查马代，
 * 工具还让模型转述超了「一共3万」多少。引擎（customerBudget / statedBudgetCap / 画像）与这里同一个口径
 */
// 都得挂在预算 / 钱上说：「时间不设限」「天数无所谓」不是在说预算
export const BUDGET_LIFTED =
  /(?:预算|钱|价格|价钱|费用)(?:上|方面|这块)?(?:都|也|倒|就|真|完全)?(?:不是问题|不成问题|无所谓|不重要|不限|不设(?:上)?限|没有?上限|不封顶|放开|好说|随便)|上不封顶|不差钱|不在乎(?:钱|价格|预算|多少钱)/;
/** 这句话把预算放开了、又没给新的数（「预算不是问题 每人5万以内都行」给了数，按那个数算） */
export function liftsBudget(t: string): boolean {
  return BUDGET_LIFTED.test(t) && !spokenMoney(t).amounts.some((n) => n >= 1000);
}

/**
 * 客户最近一次说的预算（改口以最新为准）。只看客户原话：画像里的 budget 是从原话摘出来的片段，
 * 「两个人预算一共3万左右」只记下「3万」，是每人还是总共就丢了。金额读法与价格护栏同一套（spokenMoney）
 */
export function budgetCap(session: Session): BudgetCap | undefined {
  const said = (session.messages ?? [])
    .filter((m) => m.role === 'customer')
    .map((m) => m.content)
    .reverse();
  for (const t of said) {
    if (liftsBudget(t)) return undefined;
    if (!BUDGET_TALK.test(t)) continue;
    const { amounts, rangeEnds } = spokenMoney(t);
    const money = amounts.filter((n) => n >= 1000);
    if (!money.length) continue;
    // 区间只有上端是上限（「每人一万到两万」）
    const amount = Math.max(...(rangeEnds.length ? rangeEnds : money));
    return {
      amount,
      per: PER_PERSON_WORD.test(t) ? 'person' : TOTAL_WORD.test(t) ? 'total' : 'unclear',
      floor: BUDGET_FLOOR_WORD.test(t),
      said: t.slice(0, 40),
      heads: headsIn(t),
    };
  }
  return undefined;
}

/**
 * create_quote 结果里附的预算比较：在不在客户说的预算内、超多少（每人或总价，跟客户说的口径一致）。
 * 此前工具不比，模型自己判断：报了每人 31,680 还说「在您 3 万预算内」。gap 由调用方记进 budgetGaps，价格护栏据此放行转述的差额
 */
export function budgetVerdict(
  session: Session,
  q: { perPerson: number; total: number; travelers: number },
): { fields: Record<string, unknown>; gap?: number } | undefined {
  const cap = budgetCap(session);
  if (!cap) return undefined;
  if (cap.floor) return undefined;
  if (cap.per === 'unclear' && q.travelers > 1) {
    return {
      fields: {
        budgetNote: `客户说的预算（「${cap.said}」）没讲清是每人还是总共：不要说在不在预算内、超了多少；要比就先问一句是每人还是总共。`,
      },
    };
  }
  const total = cap.per === 'total';
  const label = `${total ? '总共' : '每人'} ${cap.amount} 元`;
  const price = total ? q.total : q.perPerson;
  if (price <= cap.amount) {
    return { fields: { withinBudget: true, budget: label, budgetNote: `在客户说的预算（${label}）内，可以照实说「在您预算内」。` } };
  }
  const gap = price - cap.amount;
  return {
    gap,
    fields: {
      withinBudget: false,
      budget: label,
      [total ? 'overBudgetTotal' : 'overBudgetPerPerson']: gap,
      budgetNote:
        `比客户说的预算（${label}）高 ${gap} 元（${total ? '总价' : '每人'}）。照实说超了多少，只用这个差额，不要自己另算；` +
        '不要说「在您预算内」。客户嫌贵只有三条路：我们现有线路里确实更便宜的那条（search_routes 查）、' +
        '不在最佳季的日期（create_quote 实报）、转人工申请——不要答应缩短天数、换低一档酒店。',
    },
  };
}

// ---------------- 日子 → 月份 ----------------

const HOLIDAY_MONTHS: Record<string, number[]> = {
  国庆: [10],
  十一: [10],
  黄金周: [10],
  五一: [5],
  劳动节: [5],
  春节: [1, 2],
  过年: [1, 2],
  寒假: [1, 2],
  元旦: [1],
  暑假: [7, 8],
  圣诞: [12],
  中秋: [9, 10],
  清明: [4],
  端午: [5, 6],
};
// 「十一」只在不是数字的一部分时算国庆：「十一月」「十一个人」「十一点」都不是
const HOLIDAY =
  '国庆|黄金周|五一|劳动节|春节|过年|寒假|元旦|暑假|圣诞|中秋|清明|端午|(?<![\\d一二三四五六七八九十])十一(?![月个位人天日号点多万千百年岁])';
const MONTH = '(?<![\\d一二三四五六七八九十])(?:1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\\s*月(?:份)?';
const WHEN_RE = new RegExp(`${HOLIDAY}|${MONTH}`, 'g');
const CN_MONTH: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

function monthsOf(word: string): number[] {
  if (HOLIDAY_MONTHS[word]) return HOLIDAY_MONTHS[word];
  const raw = word.replace(/\s+/g, '').replace(/月(?:份)?$/, '');
  const n = /^\d+$/.test(raw) ? Number(raw) : CN_MONTH[raw];
  return n >= 1 && n <= 12 ? [n] : [];
}

/** 这段话里说到的日子（节日或几月），带位置 */
function whensIn(s: string): { months: number[]; at: number; end: number }[] {
  return [...s.matchAll(WHEN_RE)]
    .map((m) => ({ months: monthsOf(m[0]), at: m.index!, end: m.index! + m[0].length }))
    .filter((w) => w.months.length);
}

// ---------------- 规则词 ----------------

/** 我们根本没有的价格规则：儿童价、平日价、节假日价、月中价、早鸟……「没有儿童价」这种如实说明不算（见 NEGATED） */
const NO_SUCH_RULE = new RegExp(
  [
    '儿童(?:价|票价|半价|优惠|折扣)',
    '(?:小孩|孩子|小朋友|宝宝)(?:半价|免费|打折|优惠价?|价)',
    '(?:小孩|孩子|小朋友|儿童)的?(?:价格|费用|团费)[^。！？!?\\n，,]{0,4}(?:低|便宜|优惠|少|减)',
    // 「小朋友每人少 1,680 元」「孩子不占床每人可以减 2,000 元」：数恰好是报价的上浮差额，价格护栏认得它，这里按说法拦
    '(?:小孩|孩子|小朋友|儿童|宝宝)[^。！？!?\\n，,]{0,4}(?:少|减|便宜|优惠)\\s*[\\d一二两三四五六七八九]',
    '不占床(?:价|的话更便宜|更便宜|便宜)',
    '不占床[^。！？!?\\n，,]{0,8}(?:减|少|便宜|优惠)',
    '按(?:年龄|几岁|岁数)(?:收费|算价|计价)',
    '几岁按几岁收费',
    '平日价',
    '节假日价',
    '节日价',
    '假日价',
    '假期价',
    '周末价',
    '工作日价',
    '月中价',
    '早鸟',
  ].join('|'),
);
const NEGATED_BEFORE = /(?:没有|不区分|不分|不设|不存在|不单独|并没有|都按|同价|一样|也按|不搞|不做|无单独|无儿童)[^。！？!?\n]{0,8}$/;
// 「儿童价格跟大人一样」「小朋友价格和大人一样」说的正是没有儿童价（SOP 要模型这么说），不删
const NEGATED_AFTER =
  /^[^。！？!?\n]{0,4}(?:是没有|没有|不存在|不设)|^[^。！？!?\n]{0,8}?(?:(?:跟|和|与|同)大人)(?:的?价格?)?(?:一样|同价|相同|一个价)/;
/** 「3 岁以下小朋友免费入园」说的是景区门票，不是团费：同一句没提团费、报价才算门票这类事 */
const TICKET_TALK = /入园|门票|乐园|景区|景点|乘车|坐车|乘坐|索道|缆车|游船/;
const TOUR_PRICE = /团费|报价|线路价|这条线|总价|每人/;

/** 节假日加价：定价只看出发月落不落在线路最佳季，没有「节日上浮」这一条。出发月恰好在最佳季的（10 月的三亚）说成国庆上浮不算错价，留着 */
const HOLIDAY_SURCHARGE = new RegExp(
  `(${HOLIDAY})(?:档期|期间|出发|那几天|的时候)?的?(?:价格|价|费用|团费)?(?:会|要|都)?(?:上浮|加价|涨价|溢价|贵一些|贵一点|更贵|偏贵|贵不少)`,
);
/** 拿别的日子比价：「比国庆便宜」「比 11 月还便宜些」「比元旦出发省了 4740 元」 */
const DATE_COMPARE = new RegExp(
  `比\\s*(?:(${HOLIDAY}|${MONTH})|(旺季|最佳季|淡季|平时|平日))(?:出发|去|走|那会儿?|期间|档期|假期|的时候|那几天|那段|初|中|底|中旬|下旬|上旬)*` +
    '[^。！？!?\\n]{0,10}?(便宜|实惠|划算|省(?![心事力时])|贵)',
);
/** 拿节日给价格找理由：「价格便宜是因为避开了节日出行高峰」「过了春节旺季，地接价格回落」。
 *  「因为」只跟节日名连用：「因为您只有 5 天假期，推荐这条 5 日的线路，价格也合适」说的是请假天数 */
const HOLIDAY_REASON = new RegExp(
  `(?:避开|错开|躲开|过了|赶上|碰上|撞上)[^。！？!?\\n，,]{0,8}(?:${HOLIDAY}|节日|节假日|假期|出行高峰|高峰)|因为[^。！？!?\\n，,]{0,8}(?:${HOLIDAY}|节日|节假日)`,
);
// 说的是价钱高低，不是「报价」这个动作：「正好错开国庆高峰，我马上给您出准确报价」说的是人少，不是便宜
const PRICE_WORD = /价格|价钱|价位|性价比|团费|费用|便宜|划算|省(?![心事力时])|实惠|贵|回落|上浮|涨价/;
/** 编造的稀缺：名额 / 档期 / 房源紧张。我们看不到余位，「名额以付款为准」照说。
 *  「稀缺资源」不算：那是在讲独家资源的价值（SOP 教的拆价值），不是催客户 */
const SCARCITY = new RegExp(
  [
    // 中间夹着面积、空间这类的说的是房间本身（「水屋房间面积有限，一家四口建议订两间」），不是余位
    '(?:名额|档期|房量|房源|房间|客房|机位|机票|位置|座位|车位|房车|游艇)(?:(?!面积|空间|大小|容纳|床)[^。！？!?\\n，,]){0,6}(?:紧张|紧俏|有限|抢手|不多了?|告急|快满|满了|吃紧|难订|难抢|(?:比较|很|有点|特别|非常|挺|都)紧(?!凑))',
    '(?:仅剩|只剩|最后)\\s*[\\d一二两三四五六七八九十几]+\\s*(?:个|间|席|组|套)?\\s*(?:名额|位置|房间?|席位|空位)',
    '(?:很|比较|特别|非常|超)抢手',
  ].join('|'),
);
/**
 * 「在您预算内」这类断言。「如果想控制在预算内」「帮您挑预算内的」是条件或打算，不算。
 * 「预算很宽裕 / 预算够 / 绰绰有余」「刚好卡在预算内」是同一个判断换了说法：A04 两遍都这么说（两位一共 3 万、巴厘岛两位 45,600），
 * 第 2 遍还接着答应「还能升房型或加天数」。「预算够不够」「预算不太够」不是在说够。
 * 「预算够 / 充足 / 宽裕的话」是条件，「预算还差一点才够」「预算只够一位」是如实说不够：此前这几句整句删，
 * 「预算够的话更推荐马代那条」这种正常的推荐跟着没了（见 BUDGET_COND_AFTER）
 */
const BUDGET_COND_AFTER = '(?![^。！？!?\\n，,]{0,2}(?:的话|时候?|的情况))';
const BUDGET_CLAIM = new RegExp(
  [
    '(?<![不没])(?:在|落在|控制在|都在|卡在)(?:您|你)?的?[^。！？!?\\n，,]{0,12}?预算(?:内|之内|以内|范围内|里)',
    '(?:符合|满足)(?:您|你)?的?[^。！？!?\\n，,]{0,8}预算',
    '没(?:有)?超(?:出|过)?(?:您|你)?的?[^。！？!?\\n，,]{0,8}预算',
    '不超(?:出|过)?(?:您|你)?的?[^。！？!?\\n，,]{0,8}预算',
    '预算[^。！？!?\\n，,]{0,8}?(?<![不没太差才只])(?:很|挺|比较|完全|也|都|还)?(?:宽裕|充裕|充足|足够|绰绰有余|有富余|有余|够用|够(?![不吗么呢？?]))' +
      BUDGET_COND_AFTER,
    '预算[^。！？!?\\n，,]{0,6}(?:完全|足够|都)?(?:能|可以)?(?:覆盖|cover)' + BUDGET_COND_AFTER,
  ].join('|'),
  'gi',
);
const BUDGET_CLAIM_INTENT =
  /(?:如果|要是|若|假如|想|要|能不能|能否|可以|怎么|是否|尽量|争取|帮您|给您|压|挑|找|容易)[^。！？!?\n，,]{0,6}$/;

// ---------------- 季节判断 ----------------
// A09 两遍、B01 第 2 遍把 11 月说成淡季 /「按标准价走」/「换到 11 月中以后错开」，而丽江大理（3-5、9-11 月）、九寨（4-11 月）的
// 最佳季都含 11 月：客户照着改了日期，报出来的价一分没少。季节只看线路 bestSeason，能核就核，对不上删掉那一小句。
/** 说某个月不上浮：淡季 / 不在最佳季 / 标准价 / 不上浮 / 错开旺季。「错峰」「错开」没带宾语时另看上下文（见 SEASON_CONTEXT） */
// 「不在贵州这条线的最佳季」（B09 第 2 遍，说得对）：「不在」和「最佳季」之间夹着线路名。此前只认「不在这条线的最佳季」，
// 这句反被 PEAK_WORD 当成「2 月是最佳季」删了。「不用上浮 / 无需加价」同理（A04 第 2 遍「改到 11 月出发…不用上浮」）
const OFF_PEAK_WORD = new RegExp(
  [
    '淡季',
    '非旺季',
    '非最佳(?:出行)?季',
    '不(?:在|是|属于)[^，,。；;！？!?\\n]{0,10}?最佳(?:出行)?季',
    '过了(?:最佳(?:出行)?季|旺季)',
    '标准价',
    '原价',
    '(?:不|无需|不用|不需要|不会|免)(?:再)?(?:上浮|加价)',
    '没有?上浮',
    '(?:错开|避开|躲开|错过)(?:了)?(?:旺季|最佳(?:出行)?季)',
  ].join('|'),
);
/** 只说价钱低（「价格会低一些」「11月以后就便宜了」）：同一小句没说季节词时，也算在说那个月不上浮 */
const OFF_PEAK_PRICE = /价格?(?:会|就|能)?(?:更)?(?:低|降|回落|便宜)(?![不没])|(?:以后|之后)(?:就|会)?(?:更)?(?:便宜|实惠|划算)/;
/** 没带宾语的「错峰 / 错开 / 避开」：前后说着最佳季、上浮时才是在讲季节价；「10月下旬错峰出行」说的是躲国庆人潮 */
const BARE_DODGE = /(?:错峰|错开|避开|躲开)(?!\s*(?:了)?(?:国庆|十一|春节|五一|元旦|节|假|人|高峰|旺季|最佳))/;
const SEASON_CONTEXT = /最佳(?:出行)?季|旺季|淡季|上浮|标准价/;
/**
 * 说某个月上浮：「X 月是最佳季」「X 月上浮 10%」。「非最佳季」「不在（贵州这条线的）最佳季」「没有上浮」「不用上浮」是反过来的，不算。
 * 否定词和「最佳季 / 上浮」之间可以隔几个字（线路名、「用」「需要」），但不跨小句
 */
const PEAK_WORD =
  /(?<!(?:不是|不在|不属于|非|过了|错开|避开|躲开|错过)[^，,。；;！？!?\n]{0,10})最佳(?:出行)?季|(?<!(?:不|没|无|免)[^，,。；;！？!?\n]{0,2})(?:上浮|加价)/;
/** 「出了 10 月（比如 11 月出发）就不在最佳季」：出了、过了的那个月是分界，不是在说它 */
const BOUNDARY_MONTH = /(?:出了|过了)\s*(?:\d{1,2}|十[一二]?|[一二三四五六七八九])\s*月(?:份)?/g;
/**
 * 「错开 10 月这个旺季出发」（A18 第 2 遍，贵州 10 月确在最佳季，说得对）：错开、避开的那个月是要躲的，不是在说它不上浮。
 * 此前把 10 月当成这个小句说的月份、「错开」当成在说不上浮，整句删了
 */
const DODGED_MONTH = new RegExp(`(?:错开|避开|躲开|错过|绕开)(?:了)?\\s*(?:${MONTH}|${HOLIDAY})`, 'g');
/** 节日名：「元旦后错峰」「国庆前错开」的错峰说的是躲节日人潮（C13 第 1 遍），不是季节价 */
const HOLIDAY_RE = new RegExp(HOLIDAY);
/**
 * 小句在说换到另一个日子、或挂着条件：「换到淡季价格会低一些」「如果能避开旺季」「想省点的话可以避开最佳季出发」
 * 「换个不在最佳季的日子」。自己没说月份时，说的就不是前面那个月——此前照样借前面的「10 月」来核，
 * 「10 月是最佳季，上浮 10%，换到淡季价格会低一些」整句删，客户问「为什么这么贵」没了答案（第三轮复核 G1/S4）；
 * 删的是后半句时，剩下「10 月是最佳季所以上浮了 10%，每人 16,800 元」读着成了 10 月的价（G4）。
 * 这种小句之后也不再往下借（「如果能避开旺季，价格就能回到标准价」的后半句说的仍是那个别的日子）。
 * 泛泛讲规则的（「淡季的话就是标准价」「其他月份是标准价」）同样不借。光一个「的话」不算：「11 月出发，两位的话就是标准价」说的还是 11 月
 */
const SEASON_SWITCH = new RegExp(
  [
    '换',
    '改(?:到|成|在|期)',
    '挪',
    '推迟',
    '推到',
    '延后',
    '提前',
    '避开',
    '错开',
    '躲开',
    '如果',
    '要是',
    '假如',
    '若是',
    '倘若',
    '想省',
    '其他',
    '别的',
    '(?:淡季|旺季|最佳(?:出行)?季)(?:的话|的时候|的日子)',
    '不在最佳(?:出行)?季的(?:日子|时候|月份|日期)',
  ].join('|'),
);

// ---------------- 做不到的加减 ----------------
// 线路的天数和住宿是固定的（sop.md 能力边界）。A04 第 2 遍「还能升房型或加天数」、此前「缩短天数、降一档酒店」都是替公司答应了做不到的事
const CANT_CHANGE = new RegExp(
  '(?:还能|还可以|可以|能|也能|都能|帮您|给您|为您|再)[^。！？!?\\n，,]{0,4}' +
    '(?:升(?:级)?(?:一档)?(?:房型|房间|酒店|套房)|升级(?:到|成)|加(?:几|一|两|个)?天|多(?:玩|住)(?:几|一|两)?天|延长(?:几|一|两)?天?|' +
    '(?:缩短|压缩|减少?)(?:行程|天数|几天|一天|一两天)|(?:降|换低|换便宜)(?:一)?档|(?:出|做)(?:个)?(?:轻量|精简|简化)版)',
);
/** 如实说做不到的不删：「天数和酒店都是固定的，没法加天数」 */
const CANT_CHANGE_OK = /不能|不可以|没法|无法|改不了|换不了|加不了|减不了|做不到|固定|不支持|不行|没有这个/;

// ---------------- 高反担保 ----------------
// B03 第 2 遍：客户说「高反挺吓人的 换云南吧」，模型没查就回「线路大多在 2000 多米，基本不用担心高反」——丽江大理那条冰川大索道 4500 米。
// 担保只在说到的线路全程都在 2500 米以下时留着（maxAltitude 逐条核过，见 tools.ts LOWLAND_MAX_ALTITUDE）
const ALTITUDE_ASSURANCE = new RegExp(
  [
    '(?:不用|不必|无需|没必要|别)(?:太)?(?:担心|怕|顾虑|紧张)[^。！？!?\\n，,]{0,4}(?:高反|高原反应|海拔|缺氧)',
    '(?<!会)(?:不会|基本不会)(?:有)?(?:什么)?(?:明显的?)?(?:高反|高原反应)',
    '(?<!有)(?:没有|没什么|基本没有?|几乎没有?)(?:什么)?(?:明显的?)?(?:高反|高原反应|高原段)',
    '(?:高反|高原反应)[^。！？!?\\n，,]{0,6}(?:不用担心|没问题|不存在|很小|不大|基本没有|不明显|可以忽略)',
    // 得是在说某条线（「全程海拔温和」「这条海拔不高」）；「帮您找找海拔友好的方向」是在提议，不是担保
    '(?:全程|整体|整条线?|这条线?|行程|线路)[^。！？!?\\n，,]{0,4}海拔(?:都)?(?:很|比较|相对)?(?:温和|友好|不高)',
  ].join('|'),
);

// ---------------- 做不到的服务：换成「由顾问确认」 ----------------
// 我们这边能确认的只有：签电子合同、付款只走官方支付链接。开票、资金托管、付款流程、机票代订、档期余位都得顾问确认
const DEFER_SKIP = /顾问|确认|是否|能不能|可不可以|[吗么？?]/;
/**
 * 问资金安全时如实往顾问那儿引的（「资金托管这类制度细节，我不替公司打包票，由顾问跟您确认」「以合同为准」）不是替公司答应，
 * 是照 SOP 说的，不换。此前资金那条的 skip 里没有这些说法，B04 两遍、回归 guard-13 都把这句换成「付款只走我们发给您的官方支付链接。」，
 * 跟前面分点里的同一句重复，「由顾问确认」的答复也没了。只认往顾问那儿引、说确认不了的说法：光带个「顾问」
 * （「资金有第三方监管，顾问会联系您」）仍是在担保。「下单后顾问核对了再付款」「先把材料发您确认，没问题再付款」是编的付款流程，
 * 带着「再付款」的照换
 */
const FUND_DEFER =
  /(?:由|让|请|找|跟|问)顾问|顾问[^。！？!?\n]{0,6}(?:确认|核实|答复|说明|解答)|(?:确认|核实|保证)不了|(?:没法|无法|不能|不好)(?:确认|核实|保证)|以[^。！？!?\n]{0,12}为准/;
const PAY_AFTER_CHECK = /(?:再|后)(?:付|交|打)(?:款|钱)/;
/** 资金托管、对公账户、编的付款流程（「下单后顾问核对了再付款」） */
const FUND_CLAIM =
  /(?:资金|款项|钱款|付款|费用)[^。！？!?\n，,]{0,6}(?:第三方)?(?:监管|托管|存管|担保)|第三方(?:监管|托管|担保|存管)|对公(?:账户|转账|打款|汇款)|(?:先|下单后)[^。！？!?\n]{0,12}(?:确认|核对)[^。！？!?\n]{0,8}(?:再|后)(?:付|交|打)(?:款|钱)/g;
/** 资金说法后面跟着「这类 / 这块 / 细节 / 的具体安排」：把它当话题在说，不是在断言有这回事 */
const FUND_TOPIC = /^(?:的)?(?:这类|这些|这块|这方面|这个|方面|的?(?:具体|制度)?(?:细节|安排|问题|情况|规定|制度|事))/;
/**
 * 资金说法是往顾问那儿引的：每一处要么跟「由顾问确认 / 确认不了 / 以合同为准」在同一个小句（「资金监管这块我确认不了」
 * 「资金托管的具体安排以合同约定为准」），要么本身是个话题、同一句别处往顾问引（B04「至于资金托管这类制度细节，我不替公司打包票，
 * 由顾问跟您确认」）。此前只要整句带着往顾问引的话就放过，「您的款项全程第三方监管，有疑问随时找顾问」
 * 「资金由银行第三方托管，顾问会给您详细说明」这种替公司做的担保，顺带一句顾问、合同就原样发了出去（第五轮复核）
 */
function fundDeferred(s: string): boolean {
  if (!FUND_DEFER.test(s) || PAY_AFTER_CHECK.test(s)) return false;
  return [...s.matchAll(FUND_CLAIM)].every((m) => {
    const at = m.index!;
    const end = at + m[0].length;
    const from = Math.max(...['，', ',', '；', ';', '：', ':'].map((d) => s.lastIndexOf(d, at - 1))) + 1;
    const to = s.slice(end).search(/[，,；;：:。！？!?\n]/);
    const clause = s.slice(from, to < 0 ? s.length : end + to);
    return FUND_DEFER.test(clause) || FUND_TOPIC.test(s.slice(end));
  });
}
/** 同一条回复别处已经说了「付款只走官方支付链接」：资金那条只删不补，不然这句在客户眼前出现两遍 */
const PAY_LINK_SAID = /官方[^。！？!?\n]{0,8}支付链接|只走[^。！？!?\n]{0,12}支付链接/;
const SERVICE_CLAIMS: { re: RegExp; skip: RegExp | ((s: string) => boolean); replace: string; already?: RegExp }[] = [
  // 只管专票（增值税专用发票 / 公司抬头）：实测答应的是「支持开公司抬头的增值税专用发票」。
  // 「合同发票齐全」这类泛泛的说法交给 SOP，硬换成一句专票的话反倒答非所问
  {
    re: /(?:可以|能|支持|都能|没问题|都是|齐全|合规)[^。！？!?\n]{0,10}(?:专票|专用发票|增值税发票|抬头的?发票)|(?:专票|专用发票|增值税发票)[^。！？!?\n]{0,8}(?:可以开|能开|没问题|都能开|支持|齐全|合规|都有|照开)/,
    skip: DEFER_SKIP,
    replace: '发票（含专票）怎么开，由顾问跟您确认。',
  },
  {
    re: new RegExp(FUND_CLAIM.source),
    // 「您可以先看方案书确认行程，满意后再付款」是客户自己看方案书，照实；「下单后顾问核对了再付款」才是编的流程
    skip: (s) =>
      /(?:不用|无需|不需要|不走|没有|不是|不要)[^。！？!?\n，,]{0,4}(?:对公|第三方)|先看(?:看|一下)?(?:方案|行程)/.test(s) ||
      fundDeferred(s),
    replace: '付款只走我们发给您的官方支付链接。',
    already: PAY_LINK_SAID,
  },
  {
    re: /(?:帮您|给您|为您|帮你)[^。！？!?\n，,]{0,6}(?:订|代订|预订|询价|比价|匹配|出票)[^。！？!?\n，,]{0,4}(?:机票|航班)|(?:机票|航班)[^。！？!?\n]{0,10}(?:帮您|给您|为您|帮你)[^。！？!?\n，,]{0,6}(?:订|代订|预订|询价|比价|匹配|核算|出票)|(?<![不没未])含机票的[^。！？!?\n，,]{0,6}(?:报价|价格|总价|方案)|(?:机票|航班)[^。！？!?\n，,]{0,6}(?:一起|一并)(?:订|算|报|核算)/,
    // 「以上是不含机票的价格，往返机票需要您自理」是照 exclusions 如实说，不是答应代订
    skip: /顾问|自理|自订|自行/,
    replace: '机票代订的事由顾问跟您确认。',
  },
  {
    re: /档期(?:完全)?(?:没问题|没有问题|充足|都有|还有|够|OK|ok|可以的)|(?:还有|有)(?:余位|空位|空房)(?![吗么])|名额(?:充足|还有|够用?|没问题)(?![吗么])/,
    // 条件句（「档期没问题的话，我这边就给您下单」）是在推进下单，不是替公司担保有档期
    skip: /[吗么？?]|如果|要是|假如|的话|若/,
    replace: '具体档期和余位由顾问跟您确认。',
  },
];
/** 企微拿不到客户手机号：顾问只能在微信上联系，「电话联系您」是一句兑现不了的话 */
const PHONE_PROMISE: [RegExp, string][] = [
  [/(?:通过|用)?(?:电话(?:或|和|、)微信|微信(?:或|和|、)电话)/g, '在微信上'],
  [/(?:打)?电话(?:联系|联络|沟通|回访|回复)(?:您|你)|给(?:您|你)(?:打|回)(?:个)?电话|致电(?:您|你)/g, '在微信上联系您'],
];

// ---------------- 核对 ----------------

/** 比价、节日加价说的是哪条线：最近报价的那条；没报过价时，本会话只查到过一条线就是它 */
function routeInFocus(session: Session, calls: TurnToolCall[], routes: Route[]): Route | undefined {
  const id = session.lastQuote?.routeId ?? session.quoteHistory?.at(-1)?.routeId;
  if (id) return routes.find((r) => r.id === id);
  const ids = new Set<string>([
    ...(session.lastShownRoutes ?? []).map((r) => r.id),
    ...calls.map((c) => c.args?.routeId).filter((x): x is string => typeof x === 'string'),
  ]);
  return ids.size === 1 ? routes.find((r) => ids.has(r.id)) : undefined;
}

/**
 * 这段对话在说几位出行：最近报价 → 报价历史 → 最近一张订单 → 引擎按客户原话认的人数（hint）→ 画像 → 客户说预算那句里的人数。
 * 下过单之后 lastQuote 就清了，只看它会当成 1 位。后两样是 A04 补的：还没报价时这里认不出人数，
 * 「两位一共 3 万」没法折成每人，「在 3 万预算内完全可行」就按「人数不知道、宽松放过」发了出去
 */
function travelersInPlay(session: Session, hint?: number): number | undefined {
  const fromProfile = Number(/^(\d+)人$/.exec(session.profile?.travelers ?? '')?.[1]);
  const orders = (session.orderIds ?? []).map((id) => getOrder(id)).filter((o) => !!o);
  return [
    session.lastQuote?.travelers,
    session.quoteHistory?.at(-1)?.travelers,
    orders.at(-1)?.travelers,
    hint,
    fromProfile,
    budgetCap(session)?.heads,
  ].find((n): n is number => Number.isInteger(n) && (n as number) > 0);
}

/** 报价上的出发月（最近报价 / 报价历史最后一次） */
function quotedMonth(session: Session): number | undefined {
  const d = session.lastQuote?.departDate ?? session.quoteHistory?.at(-1)?.departDate;
  const m = d ? Number(/^\d{4}-(\d{2})-/.exec(d)?.[1]) : NaN;
  return Number.isFinite(m) ? m : undefined;
}

/**
 * 「比 X 便宜 / 贵」对不对：按这条线的最佳季算 X 和这句话说的日子（没说就按报价的出发月）各自上不上浮。
 * X 是「旺季 / 淡季 / 平时」这种说法、这句话又没说具体日子时，就是在讲规则本身（「淡季出发比旺季便宜」），照规则判
 */
function compareHolds(m: RegExpExecArray, s: string, session: Session, route: Route | undefined): boolean {
  const cheaper = m[3] !== '贵';
  const x = m[1] ?? m[2];
  const xAt = m.index + m[0].indexOf(x);
  const said = whensIn(s)
    .filter((w) => w.end <= xAt || w.at >= xAt + x.length)
    .flatMap((w) => w.months);
  if (m[2] && !said.length) return cheaper === /旺季|最佳季/.test(m[2]);
  if (!route) return false;
  const peak = peakMonths(route.bestSeason);
  const inPeak = (ms: number[]) => ms.some((v) => peak.has(v));
  const xPeak = m[2] ? /旺季|最佳季/.test(m[2]) : inPeak(monthsOf(m[1]));
  const month = quotedMonth(session);
  const subjects = said.length ? said : month ? [month] : [];
  if (!subjects.length) return cheaper ? xPeak : !xPeak;
  return cheaper ? xPeak && !inPeak(subjects) : !xPeak && subjects.every((v) => peak.has(v));
}

/** 「在您预算内」对不对：同一句里说到的价（不算预算本身那个数）→ 本轮刚报的价 → 回复里离它最近的前一个价 → 最近报价 */
function budgetClaimHolds(
  visible: string,
  u: { start: number; end: number },
  claims: { at: number; end: number }[],
  session: Session,
  calls: TurnToolCall[],
  hint?: number,
): boolean {
  const cap = budgetCap(session);
  if (!cap) return false; // 客户没说过预算
  if (cap.floor) return true;
  const q = session.lastQuote;
  const travelers = travelersInPlay(session, hint);
  // 人数不知道时，每人预算没法折成总价（反之亦然）：那种口径的数不拿来判，宽松一点，只核能直接比的
  const capPP = cap.per === 'total' ? (travelers ? cap.amount / travelers : Infinity) : cap.amount;
  const capTotal = cap.per === 'total' ? cap.amount : travelers ? cap.amount * travelers : Infinity;
  const outside = priceMentions(visible).filter((p) => !claims.some((c) => p.at < c.end && p.end > c.at));
  const inSentence = outside.filter((p) => p.at >= u.start && p.end <= u.end);
  const fits = (p: { value: number; tol: number; scope: string }) => {
    const v = p.value - p.tol; // 约数取下限：「三万多」按三万比，宽松一点
    if (p.scope === 'total') return v <= capTotal;
    if (p.scope === 'perPerson') return v <= capPP;
    // 没写是人均还是总价：按每人比；恰好是这次报价的总价才按总价比（「63,360 元，在您预算内」）
    const isTotal = !!q?.total && Math.abs(p.value - q.total) <= p.tol;
    return isTotal ? v <= capTotal : v <= capPP;
  };
  if (inSentence.length) return inSentence.every(fits);
  const quotedNow = calls.some((c) => c.name === 'create_quote' || c.name === 'generate_proposal');
  if (quotedNow && q?.perPerson) return q.perPerson <= capPP;
  const before = outside.filter((p) => p.end <= u.start).at(-1);
  if (before) return fits(before);
  return q?.perPerson ? q.perPerson <= capPP : false;
}

/**
 * 删掉对不上的价格规则 / 预算判断 / 稀缺话术，服务承诺换成「由顾问确认」，「电话联系您」改成「在微信上联系您」。
 * 返回改过的正文和删掉的句子（给日志）。PRICE_GUARD=0 时同价格护栏一起关掉
 */
export function dropUnbackedClaims(
  visible: string,
  session: Session,
  calls: TurnToolCall[] = [],
  hints: { travelers?: number } = {},
): { text: string; dropped: string[] } {
  if (process.env.PRICE_GUARD === '0') return { text: visible, dropped: [] };
  let text = visible;
  for (const [re, to] of PHONE_PROMISE) text = text.replace(re, to);
  let routes: Route[] = [];
  try {
    routes = loadRoutes();
  } catch {
    /* 数据文件坏了另有告警，这里不阻断对话 */
  }
  return dropClaimsIn(text, { session, calls, routes, route: routeInFocus(session, calls, routes), travelers: hints.travelers });
}

/** 核对要用的上下文：会话、本轮工具调用、线路库、说的是哪条线（见 routeInFocus）、引擎按客户原话认的人数 */
interface ClaimCtx {
  session: Session;
  calls: TurnToolCall[];
  routes: Route[];
  route: Route | undefined;
  travelers?: number;
}

/** 这句话点了名的线路：目的地、别名，或标题里目的地以外的那段名字（「丽江大理」「九寨黄龙」「中央格兰德」） */
function routesNamedIn(s: string, routes: Route[]): Route[] {
  const t = s.replace(/\s+/g, '');
  return routes.filter(
    (r) =>
      [r.destination, ...(r.aliases ?? [])].some((p) => !!p && t.includes(p)) ||
      r.title
        .split(/[\s·・]+|\d+\s*[日天]/)
        .map((x) => x.replace(r.destination, ''))
        .some((x) => x.length >= 3 && t.includes(x)),
  );
}

/** 小句里说到的月份：节日、几月，以及「4-10 月」这种区间（区间按 bestSeason 同一套读法展开） */
function monthsIn(c: string): number[] {
  const t = c.replace(BOUNDARY_MONTH, '').replace(DODGED_MONTH, '');
  return [...new Set([...whensIn(t).flatMap((w) => w.months), ...peakMonths(t)])];
}

/**
 * 这句话里的季节判断对不对。按小句认：说不上浮的（淡季、不在最佳季、标准价、错开旺季、那时候价低），月份都得不在线路最佳季；
 * 说上浮的（最佳季、上浮），月份都得在。一个小句两样都说的不核（分不清哪个月对哪样）。
 * 小句里没说月份就用同一句里前面说过的（「挪到 11 月底或 12 月初，就按标准价走」）；
 * 这个小句在说换到别的日子、挂着条件时不借，也不再往后借（见 SEASON_SWITCH）。
 * 说的是哪条线：这句点了名的 → 同一行、上一句点了名的（「马尔代夫：……。11月-次年4月是最佳季」）→ 最近报价的那条
 * 连同这条回复里点了名的具体线路、这一轮报过价 / 查过详情的线（归属说不准）；对得上其中一条就算；都没有就不核——没有数据可比。
 * 点名见 seasonRoutesNamedIn。「错开 X 月」「元旦后错峰」里的月份、节日是要躲的，不算这个小句说的月份（见 DODGED_MONTH / HOLIDAY_RE）。
 * 返回对不上的那个小句（句内位置），都对得上返回 undefined
 */
function wrongSeasonClaim(s: string, near: string[], text: string, ctx: ClaimCtx): { at: number; end: number } | undefined {
  const names = routeNames(ctx.routes);
  let candidates = seasonRoutesNamedIn(s, ctx, names);
  for (const t of near) if (!candidates.length) candidates = seasonRoutesNamedIn(t, ctx, names);
  // 这句和前后都没点名：多半说的是最近报价那条，可这条回复里还点了别的具体线路、这一轮还给别的线报过价时，归属就说不准——
  // 对得上其中任何一条都不删。误删说对了的话留下的是残句（A04 第 2 遍删完只剩「只有两个变量能动：」加 1 个分点），
  // 代价比放过一句说错的季节大；跟在场的每一条都对不上的，不管说的是哪条都是错的，照删。
  // 「在场」只认具体点了名的线：同目的地的兄弟线（「四川」带出的稻城亚丁）、search_routes 整批召回的线都不算——
  // 此前算上了，九寨线（4-11 月）报价后说「11 月是淡季」，对得上稻城亚丁（5-10 月）或召回里的贵州（4-10 月）就放行（第五轮复核）
  if (!candidates.length && ctx.route) {
    const inText = new Set(namedRoutes(text, names));
    candidates = [...new Set([ctx.route, ...ctx.routes.filter((r) => inText.has(r.id)), ...routesOfTurn(ctx)])];
  }
  if (!candidates.length) return undefined;
  let said: number[] = [];
  for (const c of clauseSpans(s)) {
    const cs = s.slice(c.at, c.end);
    const here = monthsIn(cs);
    if (here.length) said = here;
    else if (SEASON_SWITCH.test(cs)) said = [];
    if (!said.length) continue;
    const offWord = OFF_PEAK_WORD.test(cs);
    const onWord = PEAK_WORD.test(cs);
    let off: boolean;
    if (offWord !== onWord) off = offWord;
    else if (offWord) continue;
    // 只说价钱低、带着「比」的是在比两样东西（比国庆、比马代），比日子的由 DATE_COMPARE 核；「比如」不算。
    // 没带宾语的「错峰」小句里说着节日（「元旦后错峰」）：躲的是节日人潮，不是在说那个月不上浮
    else if (
      (OFF_PEAK_PRICE.test(cs) && !/比(?!如|方)/.test(cs)) ||
      (BARE_DODGE.test(cs) && !HOLIDAY_RE.test(cs) && near.concat(s).some((t) => SEASON_CONTEXT.test(t)))
    )
      off = true;
    else continue;
    const months = said;
    if (
      !candidates.some((r) => {
        const peak = peakMonths(r.bestSeason);
        return months.every((m) => peak.has(m) === !off);
      })
    )
      return c;
  }
  return undefined;
}

/** 工具结果里的线路 id（search_routes 是摘要数组，其余是单个对象） */
function idsInResult(result: string | undefined): string[] {
  try {
    const parsed: unknown = result ? JSON.parse(result) : [];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * 这一轮点了名去办的线路：报价、查详情、出方案、下单参数里的 routeId。search_routes 的结果不算——
 * 那是按目的地 / 语义整批召回的（「九寨沟」召回里带着贵州），不代表回复在说那条线
 */
function routesOfTurn(ctx: ClaimCtx): Route[] {
  const ids = new Set(ctx.calls.map((c) => c.args?.routeId).filter((x): x is string => typeof x === 'string'));
  return ctx.routes.filter((r) => ids.has(r.id));
}

/**
 * 季节判断点了名的线路。先认能落到具体一条线的名字（标题里的「九寨黄龙」「稻城亚丁」、只属于一条线的「九寨沟」「贵州」，
 * 见 price-guard routeNames）；只说了几条线共用的目的地（「四川」「云南」「马代」）才按目的地认，这时最近报价的那条正好在里面，
 * 说的就是它。此前一律按目的地认：九寨线的报价回复带着全名「四川 成都熊猫·九寨黄龙 6 日亲子」，「四川」把稻城亚丁
 * （5-10 月）也拉了进来，「11 月是淡季」对得上它就放行了——客户照着改到 11 月，价格一分没少（B01，第五轮复核）
 */
function seasonRoutesNamedIn(t: string, ctx: ClaimCtx, names: Map<string, string[]>): Route[] {
  const ids = new Set(namedRoutes(t, names));
  if (ids.size) return ctx.routes.filter((r) => ids.has(r.id));
  const byPlace = routesNamedIn(t, ctx.routes);
  return ctx.route && byPlace.length > 1 && byPlace.includes(ctx.route) ? [ctx.route] : byPlace;
}

/**
 * 高反担保有没有数据撑着：说到的线路全程都在 2500 米以下。说的是哪几条：这句点了名的 → 上一句、同一行点了名的 →
 * 整条回复点了名的 → 本轮工具给的 → 最近报价 / 只查到过的那一条。一条都认不出就是没数据，不算撑着
 */
function assuranceBacked(s: string, near: string[], text: string, ctx: ClaimCtx): boolean {
  let routes = routesNamedIn(s, ctx.routes);
  // 分点里常把线路名写在上一行（「· 贵州荔波小七孔 6 日」「· 全程最高约 1200 米，没有高原段」）
  for (const t of [...near, text]) if (!routes.length) routes = routesNamedIn(t, ctx.routes);
  if (!routes.length) {
    const ids = new Set(
      ctx.calls.flatMap((c) => [c.args?.routeId, ...idsInResult(c.result)]).filter((x): x is string => typeof x === 'string'),
    );
    routes = ctx.routes.filter((r) => ids.has(r.id));
  }
  if (!routes.length && ctx.route) routes = [ctx.route];
  return routes.length > 0 && routes.every((r) => typeof r.maxAltitude === 'number' && r.maxAltitude < LOWLAND_MAX_ALTITUDE);
}

/**
 * 句子里按逗号、分号切开的小句（位置相对句子，不含分隔符和句末标点）。
 * 千分位的逗号不断（「16,800」）：此前照断，删一个以「标准价 16,800 元」收尾的小句只删到「16」，客户收到「每人 18,480 元,800 元」
 */
function clauseSpans(s: string): { at: number; end: number }[] {
  const body = s.replace(/[。！!？?～~\n」”’）)\s]+$/, '').length;
  const out: { at: number; end: number }[] = [];
  let at = 0;
  for (let i = 0; i <= body; i++) {
    const thousands = s[i] === ',' && /\d/.test(s[i - 1] ?? '') && /^\d{3}(?!\d)/.test(s.slice(i + 1));
    // 破折号也断小句（「每人 22800 起——预算还能升级房型」）：此前不断，删后半句时连着前面的价一起删了
    if (i === body || ('，,；;'.includes(s[i]) && !thousands) || s[i] === '—') {
      out.push({ at, end: i });
      while (s[i] === '—' && s[i + 1] === '—') i += 1;
      at = i + 1;
    }
  }
  return out;
}

function dropClaimsIn(text: string, ctx: ClaimCtx): { text: string; dropped: string[] } {
  const { session, calls, route } = ctx;
  const cuts: { at: number; end: number; replace?: string }[] = [];
  const clauseCuts: { at: number; end: number }[] = [];
  const replaced = new Set<string>();
  let prev = '';
  for (const u of sentenceUnits(text)) {
    const s = text.slice(u.start, u.end);
    // 上一句、这句所在的那一行：线路名常写在前面（「马尔代夫：……。11月-次年4月是最佳季」「· 贵州 6 日\n· 没有高原段」）
    const line = text.slice(text.lastIndexOf('\n', u.start - 1) + 1, (text.indexOf('\n', u.start) + 1 || text.length + 1) - 1);
    const near = [prev, line];
    if (s.trim()) prev = s;
    const cut = (replace?: string) => cuts.push({ at: u.start, end: u.end, replace });
    /**
     * 删掉 from..to（句内位置）所在的那几个小句。报价常和这类话写在同一句（「每人 29,480 元，2 位总价 58,960 元，基本在您预算内。」），
     * 此前整句删，客户问了价却一个数都没收到。所以：这几个小句里没有金额、句子别处有金额时，只删这几个小句；否则整句删
     */
    // ignore：断言本身带着的数（「在 3 万预算内」的 3 万是客户的预算，不是价），不算这几个小句里有金额——
    // 此前照算，A04「每人 22800 起，两位的话在 3 万预算内完全可行」整句删，真实的 22,800 跟着没了
    const cutClauses = (from: number, to = from, ignore: { at: number; end: number }[] = []) => {
      const spans = clauseSpans(s);
      const i = spans.findIndex((c) => from < c.end || c === spans.at(-1));
      const j = Math.max(
        i,
        spans.findIndex((c) => to < c.end || c === spans.at(-1)),
      );
      const [a, b] = [spans[i].at, spans[j].end];
      const prices = priceMentions(s).filter((p) => !ignore.some((g) => p.at < g.end && p.end > g.at));
      const outside = prices.some((p) => p.end <= a || p.at >= b);
      const inside = ignore.length ? prices.some((p) => p.at >= a && p.end <= b) : priceMentions(s.slice(a, b)).length > 0;
      // 有个价跨在要删的这段边上（切小句切到了数中间）：只删一半就是一个坏掉的数，整句删
      const straddle = priceMentions(s).some((p) => p.at < b && p.end > a && (p.at < a || p.end > b));
      if (inside || straddle || !outside || (i === 0 && j === spans.length - 1)) {
        cut();
        return;
      }
      // 连着分隔符删：前面有小句就删它前面的逗号 / 破折号，否则删后面的
      clauseCuts.push(i > 0 ? { at: u.start + spans[i - 1].end, end: u.start + b } : { at: u.start + a, end: u.start + spans[j + 1].at });
    };
    const rule = NO_SUCH_RULE.exec(s);
    if (
      rule &&
      !NEGATED_BEFORE.test(s.slice(0, rule.index)) &&
      !NEGATED_AFTER.test(s.slice(rule.index + rule[0].length)) &&
      !(rule[0].endsWith('免费') && TICKET_TALK.test(s) && !TOUR_PRICE.test(s))
    ) {
      cutClauses(rule.index);
      continue;
    }
    const scarce = SCARCITY.exec(s);
    if (scarce) {
      cutClauses(scarce.index);
      continue;
    }
    // 节日当理由：价格词得在同一个小句或紧跟的下一个小句里（「过了春节旺季，地接价格都回落了」）；
    // 隔着别的话的不算（「错开国庆高峰，人少景美，性价比很高」说的是人少）
    const reason = HOLIDAY_REASON.exec(s);
    if (reason) {
      const spans = clauseSpans(s);
      const k = Math.max(
        0,
        spans.findIndex((c) => reason.index < c.end),
      );
      const priced = [k, k + 1].filter((x) => spans[x] && PRICE_WORD.test(s.slice(spans[x].at, spans[x].end)));
      if (priced.length) {
        cutClauses(reason.index, spans[priced.at(-1)!].at);
        continue;
      }
    }
    const hs = HOLIDAY_SURCHARGE.exec(s);
    if (hs && !(route && monthsOf(hs[1]).some((x) => peakMonths(route.bestSeason).has(x)))) {
      cutClauses(hs.index);
      continue;
    }
    const cmp = DATE_COMPARE.exec(s);
    if (cmp && !compareHolds(cmp, s, session, route)) {
      cutClauses(cmp.index);
      continue;
    }
    // 比日子的已由 compareHolds 核过（「比国庆便宜」里的国庆是拿来比的，不是在说国庆不上浮）
    const season = cmp ? undefined : wrongSeasonClaim(s, near, text, ctx);
    if (season) {
      cutClauses(season.at, Math.max(season.at, season.end - 1));
      continue;
    }
    const claims = [...s.matchAll(BUDGET_CLAIM)]
      .filter((m) => !BUDGET_CLAIM_INTENT.test(s.slice(0, m.index)))
      .map((m) => ({ at: u.start + m.index!, end: u.start + m.index! + m[0].length }));
    if (claims.length && !budgetClaimHolds(text, u, claims, session, calls, ctx.travelers)) {
      cutClauses(
        claims[0].at - u.start,
        claims.at(-1)!.at - u.start,
        claims.map((c) => ({ at: c.at - u.start, end: c.end - u.start })),
      );
      continue;
    }
    const change = CANT_CHANGE.exec(s);
    if (change && !CANT_CHANGE_OK.test(s)) {
      cutClauses(change.index);
      continue;
    }
    const safe = ALTITUDE_ASSURANCE.exec(s);
    if (safe && !assuranceBacked(s, near, text, ctx)) {
      cutClauses(safe.index);
      continue;
    }
    const svc = SERVICE_CLAIMS.find((c) => c.re.test(s) && !(typeof c.skip === 'function' ? c.skip(s) : c.skip.test(s)));
    if (svc) {
      // 换上去的话回复里已经有了（别处说过，或前面一句刚换过）：只删不补
      const rest = text.slice(0, u.start) + text.slice(u.end);
      const dup = replaced.has(svc.replace) || !!svc.already?.test(rest);
      replaced.add(svc.replace);
      cut(dup ? undefined : svc.replace);
    }
  }
  if (clauseCuts.length) {
    // 先删这些小句，再对删过的正文从头核一遍（同一句里可能还有别的问题）；每轮都在变短，一定收得住
    let t = text;
    for (const c of [...clauseCuts].sort((x, y) => y.at - x.at)) t = t.slice(0, c.at) + t.slice(c.end);
    const again = dropClaimsIn(t, ctx);
    return {
      text: again.text,
      dropped: [
        ...clauseCuts.map((c) =>
          text
            .slice(c.at, c.end)
            .replace(/^[，,；;—]+|[，,；;—]+$/g, '')
            .trim(),
        ),
        ...again.dropped,
      ],
    };
  }
  if (!cuts.length) return { text, dropped: [] };
  return dropSentences(text, cuts);
}

/** 仅供自测使用的内部函数出口 */
export const __priceRulesTest = {
  whensIn,
  NO_SUCH_RULE,
  SCARCITY,
  DATE_COMPARE,
  BUDGET_CLAIM,
  OFF_PEAK_WORD,
  PEAK_WORD,
  CANT_CHANGE,
  ALTITUDE_ASSURANCE,
};
