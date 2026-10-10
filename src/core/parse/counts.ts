// 04 第 8 步：通用数字与人数读法；调用方选择语境，不合并识别范围。
const CN_DAY: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function parseDayCount(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw) || null;
  const m = /^([一二两三四五六七八九])?(十)?([一二两三四五六七八九])?$/.exec(raw);
  if (!m) return null;
  const [, a, ten, b] = m;
  if (!ten && a && b) return null; // 「三五天」是约数，不是一个确定的天数
  const n = ten ? (a ? CN_DAY[a] : 1) * 10 + (b ? CN_DAY[b] : 0) : CN_DAY[a ?? b];
  return n || null;
}

// 客户或模型这轮说到的人数（「4个人」「两位」「3大人」）。「每人」「人均」前面没有数，不会被当成人数
const HEADCOUNT = /(?<![\d,.])(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个大人|个人|位|大人|人)(?![均次])/g;
/** 「一个人多少钱」问的是单价，不是说这次一个人去 */
const PER_PERSON_ASK = /^\s*的?话?\s*(?:多少|怎么算|啥价|什么价|价格|价钱|费用|单价|大概多少|要多少)/;
/** 「再加一个人」「少两位」「至少3个人」说的是增减或范围，不是总数 */
const HEADCOUNT_DELTA = /(?:加|添|多带|再带|再来|多|少|减|去掉)了?\s*$/;

/**
 * 话里说到的总人数，按出现顺序。此前「一个人多少钱？方案发我看看」被读成 1 人：补发了一份 1 人方案书、
 * 覆盖了 lastQuote，下一轮「就订这个」安全网照着建了一张 1 人的单；「再加一个人」同样读成 1 人。
 * 说单价的「一个人」跳过；出现增减说法时 delta 为真，这时算不出总数，交给调用方去问
 */
export function spokenHeadcounts(s: string): HeadcountRead {
  const counts: (number | null)[] = [];
  let delta = false;
  for (const m of s.matchAll(HEADCOUNT)) {
    const at = m.index ?? 0;
    if (HEADCOUNT_DELTA.test(s.slice(Math.max(0, at - 4), at))) {
      delta = true;
      continue;
    }
    const n = parseDayCount(m[1]);
    if (n === 1 && PER_PERSON_ASK.test(s.slice(at + m[0].length))) continue;
    counts.push(n);
  }
  return { counts, delta };
}

const TOTAL_HEADCOUNT = /(?:一共|总共|共|加起来|合计)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个大人|个人|位|个|人|口人?)/;
const KIDS_COUNT =
  /(?:\d{1,2}|[一二两三四五六七八九十])\s*(?:个|位|名)?\s*(?:小孩|孩子|儿童|娃|小朋友|宝宝|婴儿)|(?:\d|[一二两三四五六七八九])\s*大\s*(?:\d|[一二两三四五六七八九])\s*小/;
/** 'delta'：说的是增减（「再加一个人」），算不出总数 */
export function headcountIn(s: string): Headcount {
  const total = TOTAL_HEADCOUNT.exec(s);
  if (total) return parseDayCount(total[1]) ?? 'ambiguous';
  if (KIDS_COUNT.test(s)) return 'ambiguous';
  const { counts: ns, delta } = spokenHeadcounts(s);
  if (delta) return 'delta';
  if (!ns.length) return undefined;
  return ns.every((n) => n !== null && n === ns[0]) ? (ns[0] as number) : 'ambiguous';
}

/** 「我们三个」「我们俩」「一家三口」：没带「人」字的人数，HEADCOUNT 认不到。只拿来核总预算 ÷ 人数
 *  （「我们三个一起去，预算一共6万」→ 每人两万）；其他语境是否采用由调用方选择。 */
export function groupSizeIn(s: string): number | undefined {
  if (/我们俩|咱们俩|咱俩|我俩|两口子/.test(s)) return 2;
  const m = /(?:我们|咱们|俺们|一家)\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*(?:个|口)(?![月天晚周星礼小钟])/.exec(s);
  return m ? (parseDayCount(m[1]) ?? undefined) : undefined;
}

const HEADS_SAID =
  /(?<![\d一二两三四五六七八九十])(\d{1,2}|[一二两三四五六七八九十])\s*(?:个大人|个人|位|口人|大人|人)(?![均次])|(我们俩|咱们俩|咱俩|我俩|俩人|两口子|小两口)/;
export function budgetHeadcount(t: string): number | undefined {
  const m = HEADS_SAID.exec(t);
  if (!m) return undefined;
  if (m[2]) return 2;
  return parseDayCount(m[1]) ?? undefined;
}

/** 是否明确说了总人数；其他订单与儿童口径判断也沿用同一个窄语法。 */
export function hasTotalHeadcount(text: string): boolean {
  return TOTAL_HEADCOUNT.test(text);
}

export type Headcount = number | 'ambiguous' | 'delta' | undefined;
export interface HeadcountRead {
  counts: (number | null)[];
  delta: boolean;
}
export interface CountRange {
  min: number;
  max: number;
}

/** 工具参数的数字强制转换照旧（包括数字字符串），范围由执行端显式给出。 */
export function parseCountArg(value: unknown, range: CountRange): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
}
