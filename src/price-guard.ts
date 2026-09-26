// 价格出口校验：报价数字必须能追溯到产品库或本会话的工具结果，模型自己写的价格发不出去。
//
// 此前 URL/订单号有确定性护栏，价格却只有提示词约束（「严禁自己编造任何价格」）——
// 模型真写错一个数字就直接发给客户了。对高客单价产品这是最贵的一类错误：客户按错价
// 下单、成交后才发现，要么公司认亏要么当场翻脸。
import { isOriginMention, loadHotels, loadRoutes, offCatalogPlaces } from './tools.js';
import { getOrder } from './store.js';
import type { Route, Session } from './types.js';
import { ConfigNotReadyError } from './config/source.js';

/**
 * 精确金额：¥12,345 / 12,345元 / 12345 块，且 ≥1000。「3万8000元」里的 8000 是 38,000 的尾巴，不单独算。
 * 「块」和「2000多块」此前不认：「每人贵2000多块」「人均 33,333 块」整句绕过，而「两千多块」会被拦——
 * 同一个编的数，换成阿拉伯数字就发出去了。「多 / 余 / 来」按约数算（2000多 = 2000~3000）。
 */
const AMOUNT_RE = /(?:¥|￥)\s*([\d][\d,]{2,})|(?<![万千.\d])([\d][\d,]{2,})\s*(多|余|来)?\s*(?:元|块)/g;
/** 不带单位的阿拉伯数字：只在紧跟「人均 / 每人 / 总价」这类词时才当金额（见 TIGHT_HINT） */
const BARE_NUM_RE = /(?<![\d,.万千¥￥])(\d[\d,]*\d)(?![\d.])/g;

/**
 * 全角数字、大写数字、k 统一成护栏认得的写法：「人均３８０００元」「人均叁万捌仟元」「人均38k」此前整句绕过，
 * 客户说「预算15k」「预算１万５」也读不出来，模型复述反被当成编价。
 * 不用 NFKC：它会把全角逗号「，」也变成半角，「¥12,800，2 位共…」就被读成 12,800,2。
 * 大写数字至少两个连着才换：「大陆」「收拾」里单个的陆 / 拾不是数，换成「大六两万八」反而把后面的价读成区间丢掉。
 * k 只认两位以上或带小数（38k / 1.5k）：「4K 巨幕」是画质不是 4,000。
 * 每处替换都是一个字换一个字，位置不变。
 */
const CN_CAPITAL: Record<string, string> = {
  壹: '一',
  贰: '二',
  貳: '二',
  叁: '三',
  參: '三',
  肆: '四',
  伍: '五',
  陆: '六',
  陸: '六',
  柒: '七',
  捌: '八',
  玖: '九',
  拾: '十',
  佰: '百',
  仟: '千',
  萬: '万',
};
const CN_CAPITAL_RE = /[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬]/g;
function normalizeMoneyText(text: string): string {
  return text
    .replace(/([０-９])，(?=[０-９]{3}(?![０-９]))/g, '$1,') // 全角数字里的千分位 / 小数点
    .replace(/([０-９])．(?=[０-９])/g, '$1.')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬万零]{2,}/g, (run) =>
      (run.match(CN_CAPITAL_RE) ?? []).length >= 2 ? run.replace(CN_CAPITAL_RE, (c) => CN_CAPITAL[c]) : run,
    )
    .replace(/(\d{2,}|\d\.\d+)[kK](?![A-Za-z])/g, '$1千');
}

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

/** 把回复切成句子——成交措辞只作用于它所在那一句，不该让整段的其他金额跟着作废 */
function sentences(text: string): string[] {
  return text
    .split(/[。！!？?\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

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
/**
 * 「人均 / 每人 / 总价」紧贴在数字前面（中间最多一个「大概 / 只要 / 是」这类虚词）：这个数就是钱，
 * 不必再看后面跟什么。此前中文数字还要求后面落在白名单里，「人均三万八哦」「每人两万五呢」
 * 「人均三万八这个价很划算」全都漏拦——微信销售口吻句末带语气词再普遍不过。
 * 只认紧贴：「每人都能看到五千米雪山」这种隔了几个字的，「每人」说的不是这个数。
 * 「人均起价 68800 起」「起价 68800」「每人团费 68800」同样是报价：此前「起价」隔在中间就不认，
 * 实测模型编的「南极深度体验线……人均起价 68800 起」整句没被当成钱，护栏根本没看它。
 */
const TIGHT_HINT =
  /(?:(?:人均|每人|单人|每位|一位|总价|总共|一共|共计|合计|总计|总额)(?:起价|价格|售价|报价|团费|费用|价)?|起价|售价|团费)\s*(?:大概|大约|约|只要|只需|才|要|是|在|也就|差不多|起码|至少|不到|最低|最少|仅|只)?\s*$/;

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

interface AmountHit {
  /** 原文写的数（约数取下限：「2000多」→ 2000） */
  raw: number;
  /** 中心值 ± 容差：精确金额 tol=0，「2000多」= 2500 ± 500 */
  value: number;
  tol: number;
  at: number;
  end: number;
}

/** 「2000多」的区间宽度看末尾有几个 0：2000多 = 2000~3000，2500多 = 2500~2600 */
function approxSpan(n: number): number {
  return 10 ** (/0*$/.exec(String(n))?.[0].length ?? 0);
}

function amountHits(text: string): AmountHit[] {
  const out: AmountHit[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(text); m; m = AMOUNT_RE.exec(text)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 1000) continue;
    const span = m[3] ? approxSpan(n) : 0;
    out.push({ raw: n, value: n + span / 2, tol: span / 2, at: m.index, end: m.index + m[0].length });
  }
  // 「这条线人均 33,333」：不带单位，但紧跟在「人均 / 每人 / 总价」后面，就是在报价
  BARE_NUM_RE.lastIndex = 0;
  for (let m = BARE_NUM_RE.exec(text); m; m = BARE_NUM_RE.exec(text)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 1000) continue;
    const after = text.slice(m.index + m[0].length);
    if (/^\s*(?:多|余|来)?\s*(?:元|块|万|千|[wW])/.test(after)) continue; // 带单位的由上面和口语金额那边读
    if (!TIGHT_HINT.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const ap = /^\s*(?:多|余|来)/.exec(after);
    const rest = ap ? after.slice(ap[0].length) : after;
    if (MEASURE_AFTER.test(rest) || CLASSIFIER_AFTER.test(rest)) continue; // 「总共 1,200 公里」
    const span = ap ? approxSpan(n) : 0;
    out.push({ raw: n, value: n + span / 2, tol: span / 2, at: m.index, end: m.index + m[0].length + (ap?.[0].length ?? 0) });
  }
  return out;
}

function parseAmounts(text: string): number[] {
  return amountHits(text).map((h) => h.raw);
}

// ---------------- 口语金额：「3.8 万」「3万8」「三万八」「两万五千」「一万九千八」「两千多块」 ----------------
//
// 「万」的阿拉伯写法（3.8 万 / 5万 / 1.2w）最早完全不在护栏视野里——同一个编造的价格，写成「38000元」
// 被拦、写成「3.8 万」原样发给客户，而 data/sop.md 恰恰教模型用「人均 5 万左右这个档」说价位。
// 之后补上了阿拉伯数字 + 万，但中文数字仍是盲区：「人均三万八」「两位总共七万六千」「两千多块」
// 整句绕过，「3万8」只读到「3万」（±5000 的档位容差，28,800、32,800 都能「对上」）。
// 模型换一种写法就能把编的价发出去，等于没有护栏。
//
// 同一套解析也用来读客户说过的数（白名单）：客户说「预算一万九千八」，模型复述「19,800 元」时
// 得认得出来——此前客户侧只读到「一万九千」，客户报的精确预算反被当成编价。

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
/** 可能出现在一个数里的字，用来判断「从这里开始是不是一个数的开头」以及跳过整段区间 */
const NUM_CHAR = /[\d.一二两三四五六七八九十百千万零〇点]/;
/** 缩写尾数后面紧跟量词，那个数字属于量词短语：「两万一位」是每人 2 万，不是 21,000；
 *  「人均 5 万 8 月出发」的 8 是月份，不是 58,000；「人均 2.88 万到 5.28 万三档」的三是档数——
 *  此前「档」不在表里，读成 55,800，客户问「马代和巴厘岛哪个好」收到的是一句「告诉我线路和出行人数」 */
const CLASSIFIER_AFTER = /^\s*(?:位|个|人|晚|天|间|套|份|次|趟|家|张|日|夜|名|月|号|岁|档|条|种|类|款)/;

interface Section {
  value: number;
  precision: number;
  end: number;
  firstUnit: number;
  arabic: boolean;
  bare: boolean;
}

/**
 * 读一个小于一万的「节」：三千八百 / 两千八（=2800）/ 十五 / 一千零八 / 3.8 / 8千 / 3千5。
 * precision 是最低一位的单位（两千八 → 100），决定后面的容差。
 * 「两三万」「一两千」这种数字挨着数字、中间没有单位的是区间，返回 'range' 整段不认——
 * 区间不是报价，也常常根本不是钱（「一两万字的攻略」）。
 */
function readSection(t: string, start: number, afterWan: boolean): Section | 'range' | null {
  let p = start;
  let acc = 0;
  let lastUnit = 0;
  let firstUnit = 0;
  let zero = false;
  let arabic = false;
  let seen = false;
  let pending: { v: number; prec: number; at: number } | null = null;
  while (p < t.length) {
    const ch = t[p];
    const ar = /^\d+(?:\.\d+)?/.exec(t.slice(p, p + 16));
    if (ar || CN_NUM[ch] !== undefined) {
      if (pending) {
        if (!lastUnit && !afterWan) return 'range';
        break; // 「两千八一位」「两万五一位」：后面那个「一」属于量词短语，数到此为止
      }
      if (ar) {
        const dot = ar[0].indexOf('.');
        pending = { v: Number(ar[0]), prec: dot < 0 ? 1 : 10 ** -(ar[0].length - dot - 1), at: p };
        p += ar[0].length;
        arabic = true;
        const sp = /^\s+(?=[千万wW])/.exec(t.slice(p)); // 「3.8 万」「8 千」：数字和单位之间常带空格
        if (sp) p += sp[0].length;
      } else {
        pending = { v: CN_NUM[ch], prec: 1, at: p };
        p += 1;
        if (t[p] === '点' && CN_NUM[t[p + 1]] !== undefined) {
          // 三点八万
          pending.v += CN_NUM[t[p + 1]] / 10;
          pending.prec = 0.1;
          p += 2;
        }
      }
      seen = true;
      continue;
    }
    const u = CN_UNIT[ch];
    if (u) {
      if (lastUnit && u >= lastUnit) break;
      const n = pending ? pending.v : u === 10 && !seen ? 1 : undefined; // 「十五」的十前面没有数
      if (n === undefined) break;
      acc += n * u;
      lastUnit = u;
      firstUnit ||= u;
      pending = null;
      seen = true;
      p += 1;
      // 「2 万 6 千 8」：阿拉伯数字的盘古空格写法，单位后面的空格也要跨过去，否则尾数「8」读丢
      if (arabic) {
        const sp = /^\s+(?=\d)/.exec(t.slice(p));
        if (sp) p += sp[0].length;
      }
      continue;
    }
    if ((ch === '零' || ch === '〇') && seen && !pending) {
      zero = true;
      p += 1;
      continue;
    }
    break;
  }
  if (!seen) return null;
  let value = acc;
  let precision = lastUnit || 1;
  let bare = false;
  if (pending) {
    const abbrev = lastUnit >= 100 && !zero && Number.isInteger(pending.v) && pending.v < 10;
    if (abbrev && CLASSIFIER_AFTER.test(t.slice(p))) {
      p = pending.at; // 「两千一位」：一属于「一位」
    } else if (abbrev) {
      value += (pending.v * lastUnit) / 10; // 「两千八」的八是百位
      precision = lastUnit / 10;
    } else {
      value += pending.v;
      precision = pending.prec;
      bare = !lastUnit && Number.isInteger(pending.v) && pending.v < 10;
    }
  }
  return { value, precision, end: p, firstUnit, arabic, bare };
}

interface SpokenNumber {
  start: number;
  end: number;
  value: number;
  /** 最低一位的单位：三万 → 10000，三万八 → 1000，一万九千八 → 100 */
  precision: number;
  /** 阿拉伯数字 + 万/w：护栏一直不看语境就认的写法，保持原样 */
  arabicWan: boolean;
}

/** 从 start 起读一个带「千 / 万」的数。不带千万的交给 AMOUNT_RE（阿拉伯数字）或本来就不到一千（中文数字） */
function readNumber(t: string, start: number): SpokenNumber | 'range' | null {
  const a = readSection(t, start, false);
  if (a === null || a === 'range') return a;
  let p = a.end;
  const wan = t[p] === '万' || (a.arabic && /[wW]/.test(t[p] ?? '') && !/[A-Za-z]/.test(t[p + 1] ?? ''));
  if (!wan) {
    return a.firstUnit >= 1000 ? { start, end: p, value: a.value, precision: a.precision, arabicWan: false } : null;
  }
  let value = a.value * 10000;
  let precision = a.precision * 10000;
  p += 1;
  // 「人均 4 万 6 左右起」：真实 GLM 输出就是这种盘古空格写法。此前万后面的空格挡住了尾数，
  // 只读成「4 万」（±5000，编的 46,000 也能对上）；「2 万 6 千 8」更糟，尾巴「6 千 8」被当成独立的 6,000 拦下
  const gap = /^\s+(?=[\d一二两三四五六七八九零〇])/.exec(t.slice(p));
  const q = gap ? p + gap[0].length : p;
  const zero = t[q] === '零' || t[q] === '〇';
  const b = readSection(t, zero ? q + 1 : q, true);
  // 尾数后面紧跟量词时它属于量词短语：「两万一位」是每人 2 万，「3 万 12 天」是 3 万加 12 天
  if (b && b !== 'range' && b.value < 10000 && !CLASSIFIER_AFTER.test(t.slice(b.end))) {
    if (b.bare && !zero) {
      // 「三万八」「3万8」的八是千位
      value += b.value * 1000;
      precision = 1000;
    } else {
      value += b.value;
      precision = b.precision;
    }
    p = b.end;
  }
  return {
    start,
    end: p,
    value: Math.round(value * 100) / 100,
    precision,
    arabicWan: a.arabic && /^[\d.\s]+$/.test(t.slice(start, a.end)),
  };
}

function scanSpoken(t: string): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  for (let i = 0; i < t.length;) {
    // 只在一个数的开头起读：「两万五一位」读完「两万五」后，「一」不再单独起一个数
    if (!/[\d一二两三四五六七八九十]/.test(t[i]) || (i > 0 && NUM_CHAR.test(t[i - 1]))) {
      i += 1;
      continue;
    }
    const r = readNumber(t, i);
    if (r === 'range') {
      while (i < t.length && NUM_CHAR.test(t[i])) i += 1;
      continue;
    }
    if (!r) {
      i += 1;
      continue;
    }
    out.push(r);
    i = r.end;
  }
  return out;
}

/** 约数：「两千多」= 2000~3000，「三万几」= 30000~40000。「一千多万」「十几万」这种量级都说不准的不认 */
function approxAfter(t: string, n: SpokenNumber): { approx: boolean; rest: string } | null {
  const after = t.slice(n.end);
  const m = /^(?:多|几|来|余)/.exec(after);
  if (!m) return { approx: false, rest: after };
  if (/^[万亿]/.test(after.slice(m[0].length))) return null;
  return { approx: true, rest: after.slice(m[0].length).replace(/^[千百十]/, '') };
}

const MONEY_UNIT_AFTER = /^\s*(?:元|块|人民币|RMB|rmb|美元|美金|欧元|日元|港币)/;
/** 数字后面跟着这些就不是钱：五千米、两千公里、一万步、四千五百年、三万人、两千张照片 */
const MEASURE_AFTER =
  /^\s*(?:米|公里|千米|里|步|字|人|个|名|年|岁|天|日|晚|夜|次|趟|号|度|斤|公斤|克|吨|瓦|平|亩|层|级|条|座|处|分钟|秒|小时|周|英尺|尺|户|册|本|页|粉|赞|阅读|浏览|游客|张|件|只|头|辆|台|种|项|场|首|部|篇|间|套|份|家|支|棵|株|道|顿|餐|期|批|团|架|艘|所|站|圈|遍)/;
/**
 * 中文数字后面允许跟什么（白名单）：句读、金额单位、约数词、语气词、「一位 / 每人」、「含 / 就能」这类接着讲价的字。
 * 用白名单而不是黑名单：中文数字大量出现在地名和景点里（江孜十万佛塔、四千五观景台、千户苗寨），
 * 黑名单列不全，列漏一个就是整条推荐被换成兜底话术。
 */
const CN_FOLLOW_OK =
  /^(?:$|[\s，,。.！!？?；;、：:（）()「」“”"'~～—\-/／]|元|块|人民币|RMB|rmb|美元|美金|左右|上下|出头|起|以内|以下|以上|之内|内|封顶|不到|的|这个价|这个档|这档|那档|档|含|包|全包|就|即可|能|够|到手|搞定|拿下|给|算|收|报|付|订|呢|哦|哈|啦|吧|呀|嘛|啊|是|也|都|还|每人|每位|[一两二三四五六七八九十\d]+\s*(?:位|个人|人|晚))/;
/**
 * 金额语境：同一分句里、数字前面出现这些词才当钱看（「海拔三千六」「登四千五观景台」前面都没有）。
 * 按词匹配，不按单字：此前单字「贵 / 费 / 价」让「贵州梵净山海拔两千五」「免费参观海拔三千七的布达拉宫」
 * 「性价比高，海拔三千…」都算成了金额语境，整条行程介绍被换成兜底话术。
 * 「价值两千的旅拍」仍算：那是在对客户承诺钱数。
 */
const MONEY_CUE =
  /人均|每人|单人|每位|一位|总价|总共|一共|共计|合计|总计|总额|(?<![评性])价(?!比)|(?<!免)费|预算|差额|多花|贵(?![州阳宾])|便宜|省下|省了|能省|钱|付|定金|订金|尾款|补差|花销|开销|优惠|打折|折后|折扣|[¥￥]/g;
/**
 * 金额词和数字之间隔着这些，这个数说的就是海拔 / 高度：「每人两万就能看到海拔五千二的珠峰大本营」
 * 「不用加钱就能住海拔三千六的松赞」。routes.json 本身就这么写海拔（「海拔两千五百米的康定」），
 * 模型转述时去掉「米」很常见
 */
const NOT_MONEY_BETWEEN = /海拔|高度|垭口|观景台|雪山|米/;
const ALTITUDE_BEFORE = /(?:海拔|高度)[^\d，,。！!？?；;\n]{0,4}$/;
const PER_HEAD_AFTER = /^\s*(?:元|块钱?)?\s*(?:一位|一个人|一人|每人|每位|[/／]\s*(?:人|位))/;

/** 数字前面、同一分句里的文字（最多 16 字）：逗号另起一句，前一句的「人均」管不到这里 */
function clauseBefore(t: string, start: number): string {
  const head = t.slice(Math.max(0, start - 16), start);
  const cut = Math.max(...['。', '！', '!', '？', '?', '；', ';', '\n', '，', ',', '、'].map((c) => head.lastIndexOf(c)));
  return head.slice(cut + 1);
}

/** 同一分句里、数字前面有金额词，且金额词和数字之间没隔着「海拔 / 米」这类高度说法 */
function moneyCueBefore(t: string, start: number): boolean {
  const clause = clauseBefore(t, start);
  let tail: string | null = null;
  for (const m of clause.matchAll(MONEY_CUE)) tail = clause.slice(m.index + m[0].length);
  return tail !== null && !NOT_MONEY_BETWEEN.test(tail);
}

/** 把口语数字换算成「中心值 ± 容差」：精度取最低一位单位的一半，约数覆盖整个区间 */
function toRange(n: SpokenNumber, approx: boolean): { value: number; tol: number } {
  // 「万」的写法自带精度，容差就取这个精度的一半：
  // 「5 万」是 1 位有效数字（±5000）——产品库里 45,800 的线路说成「5 万左右」是正常话术；
  // 「3.8 万」精确到 0.1 万（±500）——同一条线说成「3.8 万」就对不上任何真实价，是编的。
  // 用固定百分比（比如 ±10%）不行：产品库 20 条线的价位铺得很密，10% 的窗口几乎覆盖全域，
  // 等于放行一切。
  return approx ? { value: n.value + n.precision / 2, tol: n.precision / 2 } : { value: n.value, tol: n.precision / 2 };
}

/**
 * 回复里的口语金额。
 * 阿拉伯数字 + 万沿用原口径：不看语境，只排除「1万步」「3万人」这种后面跟着量词的。
 * 中文数字：前面紧贴「人均 / 每人 / 总价」时就是钱（只排除后面跟量词的）；否则要同时满足——后面跟的是
 * 句读/金额单位/约数词/语气词（白名单），且带金额语境：后面跟「元/块」「一位」，或同一分句里前面有
 * 「价格/预算/贵/差额…」，或本身是「三万八」「两万五千」这种带千位尾数的万级数（海拔、地名里不会有）。
 * 中文数字大量出现在海拔、天数、地名里（海拔从三千六缓降到三千、江孜十万佛塔），不设这些门槛，
 * 护栏会把正常的行程介绍当成编价。
 */
function parseWanAmounts(text: string): WanAmount[] {
  const out: WanAmount[] = [];
  for (const n of scanSpoken(text)) {
    const a = approxAfter(text, n);
    if (!a) continue;
    if (n.arabicWan) {
      if (!MONEY_UNIT_AFTER.test(a.rest) && MEASURE_AFTER.test(a.rest)) continue;
    } else {
      const head = text.slice(Math.max(0, n.start - 12), n.start);
      if (ALTITUDE_BEFORE.test(head)) continue;
      if (TIGHT_HINT.test(head)) {
        if (!MONEY_UNIT_AFTER.test(a.rest) && (MEASURE_AFTER.test(a.rest) || CLASSIFIER_AFTER.test(a.rest))) continue;
      } else {
        if (!CN_FOLLOW_OK.test(a.rest)) continue;
        const money =
          MONEY_UNIT_AFTER.test(a.rest) ||
          PER_HEAD_AFTER.test(a.rest) ||
          moneyCueBefore(text, n.start) ||
          (n.value >= 10000 && n.precision <= 1000);
        if (!money) continue;
      }
    }
    const { value, tol } = toRange(n, a.approx);
    if (value < 1000) continue;
    const before = text.slice(Math.max(0, n.start - 14), n.start);
    // 「三万八一位」「3.8万/人」：人均写在数字后面。不认的话 38,000 会拿去跟 1-50 人的全部总价比，
    // 3 人 × 12,800 = 38,400 就「对上」了
    const scope: Scope =
      PER_PERSON_HINT.test(before) || PER_HEAD_AFTER.test(a.rest) ? 'perPerson' : TOTAL_HINT.test(before) ? 'total' : 'any';
    const cm = COUNT_BEFORE.exec(before);
    out.push({
      value,
      tol,
      scope,
      travelers: cm ? parseCount(cm[1]) : undefined,
      at: n.start,
      end: text.length - a.rest.length,
    });
  }
  return out;
}

/**
 * 客户说过的口语金额（白名单来源）：「两万」「三万五」「一万九千八」「十五万」「八千」「3万5」。
 * 客户侧不要求金额语境——多放行一个客户说过的数代价很小（报成交价时客户的数本来就不作数），
 * 只排除「海拔三千米」「三万人」这种明摆着不是钱的。约数取下限：「两万多」记 20,000。
 */
function parseCnAmounts(text: string): number[] {
  const out: number[] = [];
  for (const n of scanSpoken(text)) {
    const a = approxAfter(text, n);
    if (!a) continue;
    if (!MONEY_UNIT_AFTER.test(a.rest) && MEASURE_AFTER.test(a.rest)) continue;
    if (n.value >= 1000) out.push(Math.round(n.value));
  }
  return out;
}

const CN_RANGE_RE =
  /(?<![一二两三四五六七八九十百千万\d])([一二两三四五六七八九])\s*(?:到|至|-|~|～|—)?\s*([一二两三四五六七八九])\s*(十|百|千)?\s*(万)?/g;
const AR_RANGE_RE = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s*(?:到|至|-|~|～|—)\s*(\d[\d,]*(?:\.\d+)?)\s*(千|万|[wW])?/g;

/**
 * 客户说的区间，两个端点都记：「五六千」→ 5000、6000，「两三万」「八到九千」「8000-9000」「1-2万」同理。
 * 客户说「预算每人五六千」、模型复述「五千到六千的预算」时，复述里的「六千」得对得上——此前客户侧
 * 整段不认区间，而回复侧读得出区间的上端点，两边不对称，模型原样复述客户的预算反被当成编价。
 * 只用于客户侧白名单；回复侧仍不认区间（见 readSection），报成交价的语境本来也不采信客户的数。
 */
function parseRangeEndpoints(text: string): number[] {
  const out: number[] = [];
  const keep = (v: number, rest: string) => {
    if (Number.isFinite(v) && v >= 1000 && (MONEY_UNIT_AFTER.test(rest) || !MEASURE_AFTER.test(rest))) out.push(Math.round(v));
  };
  for (const m of text.matchAll(CN_RANGE_RE)) {
    if (!m[3] && !m[4]) continue; // 「三四」后面没单位：不是钱数（「三四天」）
    const unit = (m[3] ? CN_UNIT[m[3]] : 1) * (m[4] ? 10000 : 1);
    const rest = text.slice(m.index + m[0].length);
    for (const d of [m[1], m[2]]) keep(CN_NUM[d] * unit, rest);
  }
  for (const m of text.matchAll(AR_RANGE_RE)) {
    const unit = m[3] === '千' ? 1000 : m[3] ? 10000 : 1;
    const rest = text.slice(m.index + m[0].length);
    // 不带单位时两头都得像金额（8000-9000）；「2026-10-15」这种日期一头不到一千，不认
    const a = Number(m[1].replace(/,/g, '')) * unit;
    const b = Number(m[2].replace(/,/g, '')) * unit;
    if (unit === 1 && (a < 1000 || b < 1000)) continue;
    keep(a, rest);
    keep(b, rest);
  }
  return out;
}

/**
 * 一句客户原话里说到的钱：「¥/元」「万」、中文数字和区间几种写法都算；rangeEnds 单列区间端点。
 * 引擎判断「客户到底说没说过预算、说的是多少」（见 engine.ts 的 statedBudgetCap）用的也是这一套——
 * 两边口径一旦不一致，护栏放行的「客户说过的数」和引擎认的「客户预算」就会对不上。
 */
export function spokenMoney(text: string): { amounts: number[]; rangeEnds: number[] } {
  const t = normalizeMoneyText(text);
  const rangeEnds = parseRangeEndpoints(t);
  return { amounts: [...parseAmounts(t), ...parseCnAmounts(t), ...rangeEnds], rangeEnds };
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

/** 这段文字点了名的线路。skip：这个叫法在原文里不算点名（客户说的出发地） */
export function namedRoutes(text: string, names: Map<string, string[]>, skip?: (name: string) => boolean): string[] {
  const t = text.replace(/\s+/g, '');
  return [...names].filter(([, ns]) => ns.some((n) => t.includes(n) && !skip?.(n))).map(([id]) => id);
}

/**
 * 按句号、问叹号、换行、分号、冒号切开的分句（带在原文里的起止位置）。库外目的地和金额 / 线路名在同一个分句里，
 * 才算说的是一回事：「南极我们暂时没有现成线路。\n最接近的是芬兰极光玻璃屋 8 日，人均 46,800 起」两句各说各的
 */
function clauses(text: string): { s: string; start: number; end: number }[] {
  const out: { s: string; start: number; end: number }[] = [];
  const re = /[^。！!？?\n；;：:]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  return out;
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

/** 按句读切开（句号问叹号、句末波浪号、换行都算一句的结尾），每段带着自己的结尾符 */
export function sentenceUnits(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let end = -1;
    if (c === '\n') end = i + 1;
    else if ('。！!？?'.includes(c)) {
      end = i + 1;
      while (end < text.length && '。！!？?」”’）)'.includes(text[end])) end += 1;
    } else if (
      (c === '～' || c === '~') &&
      !/[\d一二两三四五六七八九十万千]/.test(text[i - 1] ?? '') &&
      !/^\s*[\d一二两三四五六七八九十]/.test(text.slice(i + 1))
    ) {
      // 「好的～您几位」的波浪号是句末语气；「2~3 万」「五万～六万」里的是区间，不断句
      end = i + 1;
      while (end < text.length && '～~'.includes(text[end])) end += 1;
    }
    if (end > 0) {
      out.push({ start, end });
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

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
      return routes.filter((r) => [r.destination, ...(r.aliases ?? [])].some((p) => !!p && t.includes(p))).map((r) => r.destination);
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
