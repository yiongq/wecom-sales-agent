// 通用金额与口语数字解析（04 R12）：只解析文字，不判断价格出处。
// 金额下限与精度容差由调用方提供；人数、产品、订单与行业裁决不进入此模块。
export interface Money {
  amount: number;
  currency: 'CNY' | null;
  /** 原文单位；无单位时为空串，千 / 万 / k 等倍率写法照原文保留。 */
  unit: string;
}

export interface MoneyParseOptions {
  minimumAmount: number;
  /** 非约数的容差 = 最低一位单位 × 此系数；约数用其区间的中心与半宽。 */
  precisionTolerance: number;
  /**
   * 08 R6：为 true 时额外认低单价与两位小数（3.65元、99块、单价3.80、3块6毛5），此时 minimumAmount 由调用方取 0.01 一类的值。
   * 缺省 false：每个导出函数的识别结果与加这一项之前逐条相同，旅游不传。
   */
  decimals?: boolean;
}

export interface SpokenAmount {
  /** 原文的数值，约数取下限；value / tol 表达区间。 */
  raw: number;
  value: number;
  tol: number;
  at: number;
  end: number;
}

/**
 * 精确金额：¥12,345 / 12,345元 / 12345 块，且达到调用方的下限。「3万8000元」里的 8000 是 38,000 的尾巴，不单独算。
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
export function normalizeMoneyText(text: string): string {
  return text
    .replace(/([０-９])，(?=[０-９]{3}(?![０-９]))/g, '$1,') // 全角数字里的千分位 / 小数点
    .replace(/([０-９])．(?=[０-９])/g, '$1.')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬万零]{2,}/g, (run) =>
      (run.match(CN_CAPITAL_RE) ?? []).length >= 2 ? run.replace(CN_CAPITAL_RE, (c) => CN_CAPITAL[c]) : run,
    )
    .replace(/(\d{2,}|\d\.\d+)[kK](?![A-Za-z])/g, '$1千');
}

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

/**
 * decimals 模式（08 R6）的 TIGHT_HINT：在原有词之外，紧跟「单价 / 报价 / 价格 / 每件 / 每个」的裸数也是钱
 *（「单价3.80」「报价 12.5」）；价格词后面允许一个冒号（「单价：3.80」「报价: 12.5」），报价清单里最常见的写法，
 * 认不出就等于编的价放行。其余部分与 TIGHT_HINT 相同；旅游不走这条。
 */
const TIGHT_HINT_DEC =
  /(?:(?:人均|每人|单人|每位|一位|总价|总共|一共|共计|合计|总计|总额)(?:起价|价格|售价|报价|团费|费用|价)?|起价|售价|团费|单价|报价|价格|每件|每个)\s*[:：]?\s*(?:大概|大约|约|只要|只需|才|要|是|在|也就|差不多|起码|至少|不到|最低|最少|仅|只)?\s*$/;

export interface AmountHit {
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

// ---------------- decimals 模式（08 R6）：低单价、两位小数、口语「3块6毛5」 ----------------
//
// 只在 options.decimals 为 true 时走到这里；缺省时 amountHits / parseSpokenAmounts / parseCnAmounts /
// parseRangeEndpoints / parseMoney 的老路径一字不动。金额一律以元计，口语的角分先攒成整数分再除 100，避免浮点误差。

/**
 * decimals 模式的精确金额：¥0.85 / 3.65元 / 99块 / 1,330.50 元，整数部分不限位数（老写法仍认），小数最多两位。
 * 小数后面不许再跟数字（3.655元不是金额）；「,」后面只认标准千分位，「12,3元」不读成 123。
 * 前缀 ¥ 与后缀单位是两个分支，按位置先到先得，「¥3.65元」只读一次。
 */
const AMOUNT_RE_DEC =
  /(?:¥|￥)\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?!\d|[.,]\d)|(?<![万千.\d])(?<!\d,)(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(多|余|来)?\s*(元|块)/g;
/** decimals 模式的不带单位数字：1–2 位小数，只在紧跟价格词时才当金额（TIGHT_HINT_DEC） */
const BARE_NUM_RE_DEC = /(?<![\d,.万千¥￥])(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?!\d|\.\d)/g;

/**
 * 「块」后面紧跟的汉字如果属于价格说法而不是名词，这个「块」才是钱：块钱 / 块一个 / 块起 / 块左右 / 块的 / 块包邮。
 * 其余汉字开头（2块样板、50块钢板、3块砖）按量词算，不是金额。用白名单：名词列不全，列漏一个就把正常句子当成价。
 */
const BLOCK_PRICE_CONT =
  /^(?:钱|一|每|半|多|余|来|起|整|左右|上下|出头|以内|以下|以上|之内|内|封顶|不到|的|含|包|就|即可|能|够|到手|给|算|收|报|付|订|加|外|另|减|折|不|共|总|和|及|或|到|至|呢|哦|哈|啦|吧|呀|嘛|啊|是|也|都|还)/;
const HANZI = /^[\u4e00-\u9fff]/;
/** 数字后面紧跟的东西是价格说法或根本不是汉字：「块」「口语尾数」都用它判断是不是量词 */
function priceContinuation(rest: string): boolean {
  return !HANZI.test(rest) || BLOCK_PRICE_CONT.test(rest);
}

/**
 * 「3块6」「3块6毛5」「3块半」「3元5角」里「块 / 元」后面的零头：半（5 毛）、N 毛 [M 分]、裸尾数 N（= N 毛）。
 * 贴着单位写，不带空格（口语不会在「块」和「6」之间断开）；粘性匹配，从 pos 起读。
 */
const FEN_TAIL_RE = /(半)|([0-9一二两三四五六七八九])(毛|角)(?:([0-9一二两三四五六七八九])(?:分(?!钟))?)?|([1-9一二两三四五六七八九])/y;

function tailDigit(ch: string): number {
  return /\d/.test(ch) ? Number(ch) : CN_NUM[ch];
}

/**
 * 读零头，返回要加的分数与结束位置；不是零头返回 null（调用方回到整块：「3块」）。
 * 「半」和裸尾数只跟「块」（「3元6」不是说法）；尾数后面不许再是数字，也不许紧跟量词、单位或名词：
 * 「3块6个」「3块6块」「3块5厘米厚」「3块6毛巾」都不是 3.6 元，这时「3块」自己照常读。
 */
function readFenTail(text: string, pos: number, unit: string): { cents: number; end: number } | null {
  FEN_TAIL_RE.lastIndex = pos;
  const m = FEN_TAIL_RE.exec(text);
  if (!m) return null;
  let cents: number;
  if (m[1] !== undefined) {
    if (unit !== '块') return null;
    cents = 50;
  } else if (m[3] !== undefined) {
    cents = tailDigit(m[2]) * 10 + (m[4] === undefined ? 0 : tailDigit(m[4]));
  } else {
    if (unit !== '块') return null;
    cents = tailDigit(m[5]) * 10;
  }
  const end = pos + m[0].length;
  const rest = text.slice(end);
  if (/^\.?\d/.test(rest) || !priceContinuation(rest)) return null;
  if (m[3] === undefined && (/^\s*[元块毛角分万千百]/.test(rest) || MEASURE_AFTER.test(rest) || CLASSIFIER_AFTER.test(rest))) return null;
  return { cents, end };
}

/** 小数后跟约数词（多 / 余 / 来）不按约数算，容差取最末一位的半个单位：12.5多 → 12.5 ± 0.05，12.50多 → 12.5 ± 0.005。frac 带小数点（".5"） */
function halfLastUnit(frac: string): number {
  return 5 / 10 ** frac.length;
}

function amountHitsDecimal(text: string, options: MoneyParseOptions): AmountHit[] {
  const out: AmountHit[] = [];
  AMOUNT_RE_DEC.lastIndex = 0;
  for (let m = AMOUNT_RE_DEC.exec(text); m; m = AMOUNT_RE_DEC.exec(text)) {
    const prefixed = m[1] !== undefined;
    const whole = (prefixed ? m[1] : m[3]).replace(/,/g, '');
    const frac = (prefixed ? m[2] : m[4]) ?? '';
    const approx = prefixed ? undefined : m[5];
    const unit = prefixed ? undefined : m[6];
    let n = Number(whole + frac);
    let end = m.index + m[0].length;
    if (unit) {
      const tail = frac || approx ? null : readFenTail(text, end, unit);
      if (tail) {
        n = (Number(whole) * 100 + tail.cents) / 100;
        end = tail.end;
        AMOUNT_RE_DEC.lastIndex = end; // 零头已经读掉，不再当成下一个数的开头
      } else if (unit === '块' && !priceContinuation(text.slice(end))) {
        continue; // 「2块样板」「50块钢板」：量词
      }
    }
    if (!Number.isFinite(n) || n < options.minimumAmount) continue;
    let value = n;
    let tol = 0;
    if (approx && frac) {
      tol = halfLastUnit(frac);
    } else if (approx) {
      const span = approxSpan(n);
      value = n + span / 2;
      tol = span / 2;
    }
    out.push({ raw: n, value, tol, at: m.index, end });
  }
  // 「单价3.80」「报价 12.5」：不带单位，但紧跟价格词，就是在报价
  BARE_NUM_RE_DEC.lastIndex = 0;
  for (let m = BARE_NUM_RE_DEC.exec(text); m; m = BARE_NUM_RE_DEC.exec(text)) {
    const frac = m[2] ?? '';
    const n = Number(m[1].replace(/,/g, '') + frac);
    if (!Number.isFinite(n) || n < options.minimumAmount) continue;
    const after = text.slice(m.index + m[0].length);
    if (/^\s*(?:多|余|来)?\s*(?:元|块|万|千|[wW])/.test(after)) continue; // 带单位的由上面和口语金额那边读
    if (!TIGHT_HINT_DEC.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const ap = /^\s*(?:多|余|来)/.exec(after);
    const rest = ap ? after.slice(ap[0].length) : after;
    if (MEASURE_AFTER.test(rest) || CLASSIFIER_AFTER.test(rest)) continue; // 「报价 3 档」「每个 2 人」
    let value = n;
    let tol = 0;
    if (ap && frac) {
      tol = halfLastUnit(frac);
    } else if (ap) {
      const span = approxSpan(n);
      value = n + span / 2;
      tol = span / 2;
    }
    out.push({ raw: n, value, tol, at: m.index, end: m.index + m[0].length + (ap?.[0].length ?? 0) });
  }
  return out;
}

/** 汉字数开头的口语金额：十五块钱 / 三块六毛五 / 两块五 / 三块半。阿拉伯数字开头的由 amountHitsDecimal 读。 */
const CN_COLLOQUIAL_RE =
  /(?<![一二两三四五六七八九十百千万零〇点\d.])([一二三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])(块|元)/g;

function cnUnder100(s: string): number {
  const ten = s.indexOf('十');
  if (ten < 0) return CN_NUM[s];
  return (ten === 0 ? 1 : CN_NUM[s[0]]) * 10 + (s.length > ten + 1 ? CN_NUM[s[ten + 1]] : 0);
}

/**
 * 汉字数的口语金额。比阿拉伯数字保守：「三块」「十块」本身常是量词（三块砖、两块布），
 * 所以必须带零头（三块六、三块六毛五、两块半）或紧跟「钱」（三块钱）才认。值是精确的分，容差 0。
 */
function cnColloquialHits(text: string, options: MoneyParseOptions): SpokenAmount[] {
  const out: SpokenAmount[] = [];
  CN_COLLOQUIAL_RE.lastIndex = 0;
  for (let m = CN_COLLOQUIAL_RE.exec(text); m; m = CN_COLLOQUIAL_RE.exec(text)) {
    const pos = m.index + m[0].length;
    let cents = cnUnder100(m[1]) * 100;
    let end = pos;
    const tail = readFenTail(text, pos, m[2]);
    if (tail) {
      cents += tail.cents;
      end = tail.end;
      CN_COLLOQUIAL_RE.lastIndex = end;
    } else if (!(m[2] === '块' && text.startsWith('钱', pos))) {
      continue;
    }
    const value = cents / 100;
    if (value < options.minimumAmount) continue;
    out.push({ raw: value, value, tol: 0, at: m.index, end });
  }
  return out;
}

export function amountHits(text: string, options: MoneyParseOptions): AmountHit[] {
  if (options.decimals) return amountHitsDecimal(text, options);
  const out: AmountHit[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(text); m; m = AMOUNT_RE.exec(text)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n < options.minimumAmount) continue;
    const span = m[3] ? approxSpan(n) : 0;
    out.push({ raw: n, value: n + span / 2, tol: span / 2, at: m.index, end: m.index + m[0].length });
  }
  // 「这条线人均 33,333」：不带单位，但紧跟在「人均 / 每人 / 总价」后面，就是在报价
  BARE_NUM_RE.lastIndex = 0;
  for (let m = BARE_NUM_RE.exec(text); m; m = BARE_NUM_RE.exec(text)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n) || n < options.minimumAmount) continue;
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

export function parseAmounts(text: string, options: MoneyParseOptions): number[] {
  return amountHits(text, options).map((h) => h.raw);
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

/** 把口语数字换算成「中心值 ± 容差」：精确数的容差由调用方给，约数覆盖整个区间 */
function toRange(n: SpokenNumber, approx: boolean, options: MoneyParseOptions): { value: number; tol: number } {
  // 「万」的写法自带精度，旅游调用方的默认容差取这个精度的一半：
  // 「5 万」是 1 位有效数字（±5000）——产品库里 45,800 的线路说成「5 万左右」是正常话术；
  // 「3.8 万」精确到 0.1 万（±500）——同一条线说成「3.8 万」就对不上任何真实价，是编的。
  // 用固定百分比（比如 ±10%）不行：产品库 20 条线的价位铺得很密，10% 的窗口几乎覆盖全域，
  // 等于放行一切。
  return approx
    ? { value: n.value + n.precision / 2, tol: n.precision / 2 }
    : { value: n.value, tol: n.precision * options.precisionTolerance };
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
export function parseSpokenAmounts(text: string, options: MoneyParseOptions): SpokenAmount[] {
  const out: SpokenAmount[] = [];
  const tightHint = options.decimals ? TIGHT_HINT_DEC : TIGHT_HINT;
  for (const n of scanSpoken(text)) {
    const a = approxAfter(text, n);
    if (!a) continue;
    if (n.arabicWan) {
      if (!MONEY_UNIT_AFTER.test(a.rest) && MEASURE_AFTER.test(a.rest)) continue;
    } else {
      const head = text.slice(Math.max(0, n.start - 12), n.start);
      if (ALTITUDE_BEFORE.test(head)) continue;
      if (tightHint.test(head)) {
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
    const { value, tol } = toRange(n, a.approx, options);
    if (value < options.minimumAmount) continue;
    out.push({
      raw: n.value,
      value,
      tol,
      at: n.start,
      end: text.length - a.rest.length,
    });
  }
  // 08 R6：「三块六毛五」这类汉字数开头的口语金额；两路的数字不会重叠（那边的数必须带千 / 万）
  if (options.decimals) {
    out.push(...cnColloquialHits(text, options));
    out.sort((x, y) => x.at - y.at);
  }
  return out;
}

/**
 * 客户说过的口语金额（白名单来源）：「两万」「三万五」「一万九千八」「十五万」「八千」「3万5」。
 * 客户侧不要求金额语境——多放行一个客户说过的数代价很小（报成交价时客户的数本来就不作数），
 * 只排除「海拔三千米」「三万人」这种明摆着不是钱的。约数取下限：「两万多」记 20,000。
 */
export function parseCnAmounts(text: string, options: MoneyParseOptions): number[] {
  const out: number[] = [];
  // decimals 模式不取整到元：口语的角分（三块六毛五）要留到分
  const round = options.decimals ? (v: number) => Math.round(v * 100) / 100 : (v: number) => Math.round(v);
  for (const n of scanSpoken(text)) {
    const a = approxAfter(text, n);
    if (!a) continue;
    if (!MONEY_UNIT_AFTER.test(a.rest) && MEASURE_AFTER.test(a.rest)) continue;
    if (n.value >= options.minimumAmount) out.push(round(n.value));
  }
  if (options.decimals) for (const h of cnColloquialHits(text, options)) out.push(round(h.value));
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
export function parseRangeEndpoints(text: string, options: MoneyParseOptions): number[] {
  const out: number[] = [];
  const round = options.decimals ? (v: number) => Math.round(v * 100) / 100 : (v: number) => Math.round(v);
  const keep = (v: number, rest: string) => {
    if (Number.isFinite(v) && v >= options.minimumAmount && (MONEY_UNIT_AFTER.test(rest) || !MEASURE_AFTER.test(rest))) out.push(round(v));
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
    if (unit === 1 && (a < options.minimumAmount || b < options.minimumAmount)) continue;
    // decimals 模式下金额下限小到一分钱，「2026-10-15」「6205-2RS」两头都过得了下限：不带千 / 万时必须带金额单位才算区间
    if (unit === 1 && options.decimals && !MONEY_UNIT_AFTER.test(rest)) continue;
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
export function spokenMoney(text: string, options: MoneyParseOptions): { amounts: number[]; rangeEnds: number[] } {
  const t = normalizeMoneyText(text);
  const rangeEnds = parseRangeEndpoints(t, options);
  return { amounts: [...parseAmounts(t, options), ...parseCnAmounts(t, options), ...rangeEnds], rangeEnds };
}

/** 金额后面紧跟的币种：人民币记 CNY，其余外币记 null 并保留原单位（R12）。长的写法排前面（新台币先于台币）。 */
const CURRENCY_SUFFIX =
  /^\s*(元|块|人民币|RMB|rmb|美元|美金|美刀|欧元|日元|港币|港元|英镑|澳元|澳币|加元|加币|新加坡元|新币|新台币|台币|韩元|泰铢|卢布|瑞郎|USD|EUR|JPY|HKD|GBP|AUD|CAD|SGD|TWD|KRW|THB)/;

/** 按回复的金额识别口径返回 Money，保留原单位，不做外币换算或出处裁决。 */
export function parseMoney(text: string, options: MoneyParseOptions): Money[] {
  const t = normalizeMoneyText(text);
  const hits = [
    ...amountHits(t, options).map((h) => ({ amount: h.raw, at: h.at, end: h.end })),
    ...parseSpokenAmounts(t, options).map((h) => ({ amount: h.raw, at: h.at, end: h.end })),
  ].toSorted((a, b) => a.at - b.at);
  return hits.map(({ amount, at, end }) => {
    const body = text.slice(at, end);
    const suffix = CURRENCY_SUFFIX.exec(text.slice(end))?.[1];
    // 口语「3块6毛5」整段是一个金额，单位在中间；这类 body 以数字 + 块 / 元开头
    const colloquial = options.decimals ? /^[\d,一二两三四五六七八九十]+(块|元)/.exec(body)?.[1] : undefined;
    const explicit = suffix ?? /^(¥|￥)/.exec(body)?.[1] ?? /(元|块)\s*$/.exec(body)?.[1] ?? colloquial;
    // 无币种标记时保留倍率单位，不推断币种；数字归一逐字替换，原文位置仍能直接用。
    const unit = explicit ?? body.match(/[万萬千仟wWkK]/g)?.at(-1) ?? '';
    const currency = explicit && /^(?:元|块|人民币|RMB|rmb|¥|￥)$/.test(explicit) ? 'CNY' : null;
    return { amount, currency, unit };
  });
}
