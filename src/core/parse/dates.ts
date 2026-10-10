// 04 第 8 步：通用日期选择与改口；行业节日解析由调用方提供。
import { parseDayCount } from './counts.js';

export interface DateSpan {
  at: number;
  end: number;
}
export interface DateReadResult {
  pick: SpokenDate | null;
  exact: string[];
  pickAt?: DateSpan;
  skipped: DateSpan[];
}
export interface YearMonth {
  y: number;
  mo: number;
  said?: string;
}
export interface DateParsePolicy {
  /** 无捕获组的节日名模式；核心另捕获可选年份与节日名。 */
  holidayPattern?: string;
  /** 行业特有的模糊时间说法，无捕获组。 */
  vaguePattern?: string;
  holidayDate?(name: string, year: string | undefined, today: string): SpokenDate;
  monthAnchor?(text: string, read: DateReadResult, today: string): YearMonth | undefined;
}
export interface MonthParsePolicy {
  /** 无捕获组的节日模式；空串表示只识别通用月份。 */
  holidayPattern: string;
  holidayMonths: Readonly<Record<string, number[]>>;
}
export interface MonthMention {
  months: number[];
  at: number;
  end: number;
}

/** y-m-d 是否真实存在的日历日期（拒绝 2 月 31 日这类） */
export function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const isoOf = (y: number, m: number, d: number): string | undefined =>
  isRealDate(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined;

/** iso 往后数 n 天 */
export function addDays(iso: string, n: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const EXPLICIT_DATE_RE = /([0-9]{4})\s*年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*[号日]/g;
const PAST_TRIP_AFTER = /^[^，。,！？!?\n]{0,8}(?:去过|来过|玩过|到过|走过)/;
export function statedPastDate(text: string, today: string): string | null {
  for (const m of text.matchAll(EXPLICIT_DATE_RE)) {
    if (PAST_TRIP_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    const iso = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    return iso < today ? iso : null;
  }
  return null;
}

/** 认得出具体哪天的说法。只认阿拉伯数字的月日（与此前口径一致）；「十一」只在跟着假期说法时算国庆，
 *  不然「十一个人」「十一天」都成了国庆 */
const dateMention = (policy: DateParsePolicy): RegExp =>
  new RegExp(
    [
      '(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[号日]',
      '(明年)?\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[号日]',
      '(\\d{4})-(\\d{2})-(\\d{2})',
      '(下个?月|这个?月|本月)\\s*(\\d{1,2})\\s*[号日]',
      ...(policy.holidayPattern ? [`(今年|明年|\\d{4}\\s*年)?\\s*(${policy.holidayPattern})`] : []),
    ].join('|'),
    'g',
  );
/** 说了时间、但说不准哪天（「11月」「月底」「下周」「十月三号」「5号」）。客户最近一次说的是这种时，
 *  不能拿他更早说过的日期去补——他已经改口了，只是改成了引擎认不准的说法。
 *  不收「明天」「周一」：销售对话里它们几乎都是在约联系时间（「明天再说」「周一给你答复」），
 *  算进来的话一句客套就让之后整段对话都补不上日期 */
const vagueDate = (policy: DateParsePolicy): RegExp =>
  new RegExp(
    [
      '\\d{1,2}\\s*月份?',
      '(?:[一二三四五六七八九]|十[一二]?)\\s*月',
      '月[底初中末]|[上中下]旬',
      '下个?月|这个?月|本月',
      '(?:下|这|本)个?(?:周末?|星期|礼拜)|周末',
      '年[底初]|明年|后年',
      ...(policy.vaguePattern ? [policy.vaguePattern] : []),
      '(?<![\\d第])\\d{1,2}\\s*号(?![线楼院房])',
    ].join('|'),
    'g',
  );
/** 不是这次的出发日期：返程（「7号回来」「10月5号回」「玩到7号」）、过去的经历（「去年国庆」「10月去过」）、
 *  不去了（「国庆人太多，不去了」）、改掉的旧日子（「原定10月2号」）、约的是联系时间（「下周再说」「月底答复您」） */
const NOT_DEPART_BEFORE =
  /(?:返程|回程|回来|返回|回国|玩到|待到|呆到|住到|一直到|去年|前年|上次|上回|那次|原定|原计划|原先|原来|避开|错开|除了|不想|不要)[^，。,！？!?；;\n]{0,3}$/;
const NOT_DEPART_AFTER =
  /^\s*(?:节|假期|长假|期间|那天|当天|左右|前后)?\s*(?:就|再|才|要|得)?\s*(?:回来|回程|返程|返回|回国|回家|到家|结束|不去|不行|去不了|走不了|没空|太挤|人太多|再说|再聊|再联系|联系|答复|回复|商量|回)/;
/** 时间后面跟的是别的安排（「这个周末我跟家人商量一下」「明年再考虑日本」「这个月底前给你答复」「孩子下个月还要考试」
 *  「10月8号要上班」）：说的不是出发。只看同一小句里紧跟着的几个字，而且后面明说了出发/走/去的不算（见 DEPART_AFTER） */
const OTHER_PLAN_AFTER = /^[^，。,！？!?；;\n]{0,6}?(?:商量|考虑|答复|回复|给你|给您|联系|再说|再聊|定下来|考试|开学|上学|上班|开会|生日)/;
/** 读起来就是出发：后面跟着出发/走/去 */
const DEPART_AFTER = /^\s*(?:节|假期|长假|小长假|黄金周|期间|那天|当天|左右)?\s*(?:再|就|才)?\s*(?:出发|动身|启程|走|去|飞)/;
/** 同一句里后面的日子算改口：前面带「改到/改成/推到…」，或后面紧跟「出发/走」（不含「去」：「10月1号出发，3号去丽江」是行程里的一站） */
const SWITCH_BEFORE = /(?:改到|改成|改为|改在|换到|换成|推到|推迟到|延到|延后到|提前到|挪到|定在|定到)\s*$/;
const SWITCH_AFTER = /^\s*(?:节|假期|长假|小长假|黄金周|期间|那天|当天|左右)?\s*(?:再|就|才)?\s*(?:出发|动身|启程|走)/;
/** 「国庆前 / 10月1号之后」：在那天前后，不是那天 */
const NEAR_NOT_ON = /^\s*(?:节|假期|长假|期间)?\s*(?:前(?!后)|之前|以前|后|之后|以后)/;
/** 「过完春节 / 过了国庆」：那个节日之后，同样不是那天 */
const AFTER_HOLIDAY = /(?:过完|过了)\s*$/;

/** 说的节日（没说哪年，或说的就是正在放的那年）今天正在放假：这次假期还剩的几天，今天到假期最后一天。
 *  报价、下单不看它，只拿来认顺口一问说的是不是眼下这次（见 departMonths） */
export interface HolidayLeft {
  from: string;
  to: string;
}
export type SpokenDate =
  /** iso 为空：说的是一个用不了的日子（2 月 31 日、写明年份的过去日期、这个月已过的日子）。
   *  说不准哪天的（vague）也可能带 ongoing：农历表里最后一次春节放到初二以后，下一次不在表里，照样在放眼下这次 */
  { kind: 'date'; iso?: string; exact: boolean; ongoing?: HolidayLeft } | { kind: 'vague'; ongoing?: HolidayLeft };

/**
 * 一句话里客户说的出发日期（pick）和他在这句里明说的所有具体出发日子（exact，下单核日期用）。
 * 先说的那个就是出发日期；后面的只有像改口时才换（「原定10月2号，改到10月5号」「国庆人多，10月3号出发」），
 * 或是把前面说不准的说具体了。此前一律取最后一处，「10月1号出发，玩到10月7号」成了 7 号出发，
 * 「国庆出发吧，孩子下个月还要考试」成了说不准哪天。返程、经历、区间终点（「10月1号到7号」的 7 号）、
 * 别的安排（「这个周末商量一下」）不算；一处都没有返回 pick=null。
 * 节假日取最近的未来那一次，exact=false；这次节日正在放假时另带 ongoing（见 SpokenDate）。today 参数只为自测能模拟任意日期。
 */
export function readDepartDates(text: string, today: string, policy: DateParsePolicy = {}): DateReadResult {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const spans: { at: number; end: number; date: SpokenDate }[] = [];
  for (const m of text.matchAll(dateMention(policy))) {
    const at = m.index ?? 0;
    let date: SpokenDate;
    if (m[1]) {
      // 客户明写了年份就按他说的算，不许改：此前只认「X月Y号」，「2020年1月1号出发」被顺手滚到明年建了单。
      // 过去的日期不给——交给工具层报错，让模型去问客户
      const iso = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
      date = { kind: 'date', iso: iso && iso >= today ? iso : undefined, exact: true };
    } else if (m[5]) {
      // 「X月Y号」按未来最近的那一次；今年已过（含当月已过的日子）就是明年，客户说了「明年」就是明年
      const [mo, d] = [Number(m[5]), Number(m[6])];
      const thisYear = isoOf(year, mo, d);
      const nextYear = !!m[4] || (!!thisYear && thisYear < today);
      date = { kind: 'date', iso: isoOf(nextYear ? year + 1 : year, mo, d), exact: true };
    } else if (m[7]) {
      date = { kind: 'date', iso: isoOf(Number(m[7]), Number(m[8]), Number(m[9])), exact: true };
    } else if (m[10]) {
      // 「下个月15号」：下个月（跨年）的那天；「这个月20号」已过就是说错了，不往后滚
      const next = !m[10].startsWith('这') && !m[10].startsWith('本');
      const [y, mo] = next ? (month === 12 ? [year + 1, 1] : [year, month + 1]) : [year, month];
      const iso = isoOf(y, mo, Number(m[11]));
      date = { kind: 'date', iso: iso && iso >= today ? iso : undefined, exact: true };
    } else {
      // 没说哪年就取最近的未来那一次；说了（「明年国庆」「2028年春节」）就是那年的，已经过去的不给
      date = policy.holidayDate?.(m[13], m[12], today) ?? { kind: 'vague' };
    }
    spans.push({ at, end: at + m[0].length, date });
  }
  const items = spans.map((s) => ({ ...s, mention: true }));
  // 说不准的说法只在不和上面认出来的日子重叠时才算（「10月2号」里的「10月」「2号」不算）
  for (const m of text.matchAll(vagueDate(policy))) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (spans.some((s) => at < s.end && end > s.at)) continue;
    items.push({ at, end, date: { kind: 'vague' }, mention: false });
  }
  items.sort((a, b) => a.at - b.at);
  let found: SpokenDate | null = null;
  let pickAt: { at: number; end: number } | undefined;
  const exact: string[] = [];
  const skipped: { at: number; end: number }[] = [];
  let prevEnd = -1;
  for (const it of items) {
    const before = text.slice(0, it.at);
    const after = text.slice(it.end);
    const rangeEnd = prevEnd >= 0 && /^\s*(?:到|至|-|~|～|—)\s*$/.test(text.slice(prevEnd, it.at));
    prevEnd = it.end;
    if (
      rangeEnd ||
      NOT_DEPART_BEFORE.test(before) ||
      NOT_DEPART_AFTER.test(after) ||
      PAST_TRIP_AFTER.test(after) ||
      (!DEPART_AFTER.test(after) && OTHER_PLAN_AFTER.test(after))
    ) {
      skipped.push({ at: it.at, end: it.end });
      continue;
    }
    const date: SpokenDate = it.mention && (NEAR_NOT_ON.test(after) || AFTER_HOLIDAY.test(before)) ? { kind: 'vague' } : it.date;
    if (date.kind === 'date' && date.exact && date.iso) exact.push(date.iso);
    if (!found || SWITCH_BEFORE.test(before) || SWITCH_AFTER.test(after) || (found.kind === 'vague' && date.kind === 'date')) {
      found = date;
      pickAt = { at: it.at, end: it.end };
    }
  }
  return { pick: found, exact, pickAt, skipped };
}

export function spokenDepartDate(text: string, today: string, policy: DateParsePolicy = {}): SpokenDate | null {
  return readDepartDates(text, today, policy).pick;
}

// 顺口问到节假日、月份（「国庆期间景区人多吗」「国庆放几天」「12月冷不冷」）不是在说出发时间：是问句、后面没跟出发/走/去、
// 也没说改。此前照样算作客户最近说的出发时间，客户早先说过的「10月3号出发」就被一句问话冲成了「国庆」这个大概——
// 模型按 10月3号 下单被拦下，又去问一遍客户早就说过的日子
const ASIDE_QUESTION = /吗|？|\?|呢|多不多|几天|怎么样|咋样|如何|冷不冷|热不热|好不好/;
const ASIDE_NOT = /出发|走|去|动身|启程|飞|改|换|算了|推迟|延|提前|不去/;
/** 出发时间说法所在的年月（节假日按那天，只说到月份的按 monthSaid）；说不出是哪个月的返回空。
 *  节日正在放假时，这次假期还剩的那几天所在的月份也算（见 HolidayLeft）：此前 10月2号顺口问「国庆期间景区人多吗」只读成明年 10 月，
 *  和客户早先说的「10月3号出发」不在同一个月，这句问话就冲掉了 10月3号，下单被驳回去再问哪天 */
function departMonths(pick: SpokenDate, text: string, today: string, policy: DateParsePolicy): string[] {
  // 假期最长七天，跨不出两个月：今天和假期最后一天所在的月份就是剩下那几天的全部月份。
  // 2028 年春节放到 2月1日，1月28号问「春节期间人多吗」，客户早先说的「2月1号出发」也在眼下这次假期里
  const days = pick.ongoing ? [pick.ongoing.from, pick.ongoing.to] : [];
  if (pick.kind === 'date' && pick.iso) days.push(pick.iso);
  const months = days.map((d) => d.slice(0, 7));
  const ym = pick.kind === 'vague' ? monthSaid(text, today, policy) : undefined;
  if (ym) months.push(`${ym.y}-${String(ym.mo).padStart(2, '0')}`);
  return [...new Set(months)];
}
export function isAside(pick: SpokenDate, text: string): boolean {
  return !(pick.kind === 'date' && pick.exact) && ASIDE_QUESTION.test(text) && !ASIDE_NOT.test(text);
}
// 只说到月份的问句（「4月去三亚会不会很热啊」「12月走冷不冷」）：带着「去 / 走」，问的却是那个月的天气人流。
// C02 客户先说「改到明年4月5号吧」，下一句这么一问，出发日期就被降成「只说了 4 月」，报价回复被要求别写具体哪天，
// 接着下单还会被驳回去问哪天。这种只在更早说过同一个月的具体哪天时才起作用（见 latestDepart），真改口的说法（改、换、定）不算
const MONTH_ASIDE_QUESTION =
  /会不会|是不是|热吗|冷吗|热不热|冷不冷|人多|下雨|天气|温度|气温|几度|适合|好玩|值得|怎么样|咋样|如何|吗|呢|？|\?/;
const MONTH_ASIDE_NOT = /改|换|算了|推迟|延期|延后|提前|不去|定|订|下单|别的|其他/;
export function isMonthAside(pick: SpokenDate, text: string): boolean {
  return pick.kind === 'vague' && MONTH_ASIDE_QUESTION.test(text) && !MONTH_ASIDE_NOT.test(text);
}

/**
 * 会话里客户最近一次说出发时间的那句话读出来的（从最新一句往前找，改口以最新为准），text 是那句原话。
 * 最近那句只是顺口问到节假日、月份（见 isAside）时，往前找：同一个月里更早明说过具体哪天，就以那天为准
 */
export function latestDepart(
  customerTexts: string[],
  today: string,
  policy: DateParsePolicy = {},
): { pick: SpokenDate; exact: string[]; text: string } | null {
  let aside: { pick: SpokenDate; exact: string[]; text: string; months: string[] } | null = null;
  const byTheWay = (pick: SpokenDate, t: string): boolean => isAside(pick, t) || isMonthAside(pick, t);
  for (let i = customerTexts.length - 1; i >= 0; i--) {
    const r = readDepartDates(customerTexts[i], today, policy);
    if (!r.pick) continue;
    const got = { pick: r.pick, exact: r.exact, text: customerTexts[i] };
    const months = departMonths(r.pick, customerTexts[i], today, policy);
    if (!aside) {
      // 说不出是哪个月的问句也记下：往前找时和哪句都对不上，照样以它为准
      if (!byTheWay(r.pick, customerTexts[i])) return got;
      aside = { ...got, months };
      continue;
    }
    const asideMonths = aside.months;
    if (!months.some((m) => asideMonths.includes(m))) break;
    if (r.pick.kind === 'date' && r.pick.exact) return got;
    if (!byTheWay(r.pick, customerTexts[i])) break;
  }
  return aside && { pick: aside.pick, exact: aside.exact, text: aside.text };
}

/**
 * 解析出发日期为 YYYY-MM-DD：这句话里客户说了就按他说的（见 spokenDepartDate；说的是「11月」这种
 * 说不准的日子就是没有，不回退到画像里的旧日期——他已经改口了）；这句没提时间才回退到画像 ISO。
 * 只说「X月」不猜具体哪天——猜出来的 15 号会顺着画像流进成单安全网，替客户创建一个他从未确认过日期的真实订单。
 */
export function resolveDepartDate(
  dates: string | undefined,
  text: string,
  today: string,
  policy: DateParsePolicy = {},
): string | undefined {
  const said = spokenDepartDate(text, today, policy);
  const iso = (dates ?? '').match(/(\d{4})-(\d{2})-(\d{2})/);
  const known = iso ? isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3])) : undefined;
  if (!said) return known;
  if (said.kind === 'date') return said.iso;
  // 顺口问同一个月怎么样（见 isMonthAside），记着的那天照用
  const ym = monthSaid(text, today, policy);
  return known && ym && isMonthAside(said, text) && known.startsWith(`${ym.y}-${String(ym.mo).padStart(2, '0')}-`) ? known : undefined;
}

export function saysDay(text: string, iso: string): boolean {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [mo, d] = [Number(m[1]), Number(m[2])];
  const t = text.replace(/[一二两三四五六七八九十]{1,3}(?=\s*[月号日])/g, (w) => String(parseDayCount(w) ?? w));
  return (
    new RegExp(`(?<!\\d)${mo}\\s*(?:月|[./-])\\s*${d}(?!\\d)`).test(t) ||
    new RegExp(`(?<![\\d月./-]\\s*)${d}\\s*(?:号|日(?![游行]))`).test(t)
  );
}
/**
 * 只说到月的出发时间（「明年2月」「12月初」「10月中旬」「年底」「过完年」）读成年月；一句话里说了好几个月份的不猜。
 * 行业特有的时间锚点由 policy.monthAnchor 解析，可带原文 said。
 * 客户排除掉的时间（readDepartDates 跳过的：「春节人太多」「过年要回老家」「10月人太多」）不读；春节前后的说法还得是
 * readDepartDates 选中的那一处。此前在整句里找：「春节人太多 暑假带孩子去」读成 2 月，报价被引擎改成 2 月 1 日的旺季价、
 * 还让模型说「春节出发」（第五轮复核）
 */
export function monthSaid(text: string, today: string, policy: DateParsePolicy = {}): YearMonth | undefined {
  const year = Number(today.slice(0, 4));
  const read = readDepartDates(text, today, policy);
  // 遮掉跳过的那几处（等长替换，位置不变）
  for (const k of read.skipped) text = text.slice(0, k.at) + '×'.repeat(k.end - k.at) + text.slice(k.end);
  const months = [...text.matchAll(MONTH_SAID)];
  if (months.length === 1) {
    const [, rel, y4, raw] = months[0];
    const mo = parseDayCount(raw);
    if (!mo || mo > 12) return undefined;
    const y = y4
      ? Number(y4)
      : rel === '明年'
        ? year + 1
        : rel === '后年'
          ? year + 2
          : rel === '今年'
            ? year
            : mo >= Number(today.slice(5, 7))
              ? year
              : year + 1;
    return { y, mo };
  }
  const end = months.length ? null : /(明年|今年)?\s*年[底末]/.exec(text);
  if (end) return { y: end[1] === '明年' ? year + 1 : year, mo: 12 };
  const at = read.pickAt;
  if (months.length || !at) return undefined;
  return policy.monthAnchor?.(text, read, today);
}

/** 那个月里拿来定季节价的一天：季节价只看月份，取 1 号；当月已过 1 号就取今天，整个月都过去了就不给 */
export function dayInMonth(ym: YearMonth, today: string): string | undefined {
  const first = isoOf(ym.y, ym.mo, 1);
  if (!first) return undefined;
  if (first >= today) return first;
  return today.startsWith(first.slice(0, 8)) ? today : undefined;
}
// 「明年1-2月」「1到2月」是个区间：前面紧挨着「数字 + 到/-」的月份不单读，否则只剩 2 月被读成「2027年2月」
const MONTH_SAID =
  /(明年|今年|后年|(\d{4})\s*年)?\s*(?<![\d一二三四五六七八九十]\s*(?:-|－|~|～|—|到|至)\s*)(\d{1,2}|十[一二]?|[一二三四五六七八九])\s*月(?!\s*\d{1,2}\s*[号日])/g;
export const MONTH_PATTERN = '(?<![\\d一二三四五六七八九十])(?:1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\\s*月(?:份)?';

export function monthsOf(word: string, policy: MonthParsePolicy): number[] {
  if (policy.holidayMonths[word]) return policy.holidayMonths[word];
  const raw = word.replace(/\s+/g, '').replace(/月(?:份)?$/, '');
  const n = /^\d+$/.test(raw) ? Number(raw) : /^(?:十[一二]?|[一二三四五六七八九])$/.test(raw) ? (parseDayCount(raw) ?? NaN) : NaN;
  return n >= 1 && n <= 12 ? [n] : [];
}

/** 这段话里说到的日子（节日或几月），带位置 */
export function whensIn(s: string, policy: MonthParsePolicy): MonthMention[] {
  const pattern = policy.holidayPattern ? `${policy.holidayPattern}|${MONTH_PATTERN}` : MONTH_PATTERN;
  return [...s.matchAll(new RegExp(pattern, 'g'))]
    .map((m) => ({ months: monthsOf(m[0], policy), at: m.index!, end: m.index! + m[0].length }))
    .filter((w) => w.months.length);
}

/** 工具执行端调用的 ISO 格式与日历校验。 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return !!m && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}
