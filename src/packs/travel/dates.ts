// 04 第 8 步：旅游节日、模糊假期与季节月份；通用解析只经 pack-api 取得。
import {
  addDays,
  type DateParsePolicy,
  type DateReadResult,
  type MonthParsePolicy,
  type SpokenDate,
  type YearMonth,
} from '../../core/pack-api.js';
import { travelDateThresholds } from './thresholds.js';

/** 农历节日的公历日期没有固定规则，只能逐年查表。表只覆盖到 2028 年，超出就当说不准、不补——
 *  宁可按平日价报，也不能拿错的日期去报价。2027 年春节是 2 月 6 日（朔在北京时间 6 日 23:56）；
 *  Node 的 Intl chinese 历会算成 7 日，别拿它来「校正」这张表 */
const LUNAR_HOLIDAYS: Record<string, string[]> = {
  春节: ['2026-02-17', '2027-02-06', '2028-01-26'],
  端午: ['2026-06-19', '2027-06-09', '2028-05-28'],
  中秋: ['2026-09-25', '2027-09-15', '2028-10-03'],
};
/** 节日按当天算（国庆 = 10月1日）。这只是个大概，所以只拿来补报价、方案书，不拿来改下单日期（见 groundToolArgs） */
const SOLAR_HOLIDAYS: Record<string, string> = { 国庆: '10-01', 五一: '05-01', 元旦: '01-01' };
const HOLIDAY_ALIAS: Record<string, string> = { 十一: '国庆', 劳动节: '五一', 大年初一: '春节', 八月十五: '中秋' };
/** 节日假期从节日那天（上面两张表里的日子）算起放几天，按国务院办公厅每年发的放假安排（法定假日连调休）常见的天数：
 *  国庆 10月1日至7日，五一 5月1日至5日，元旦 1月1日至3日，春节从初一到初七，端午、中秋连周末三天（个别年份节日落在
 *  三天里的最后一天，这里一律从节日那天往后数）。只拿来认「这次节日正在放假中」（见 holidayInProgress）。
 *  节日那天之前放的几天（除夕、端午前的周末）不用管：那时节日那天还没到，本来就读成这一次 */
const HOLIDAY_DAYS: Record<string, number> = { 国庆: 7, 五一: 5, 元旦: 3, 春节: 7, 端午: 3, 中秋: 3 };

/** 今天在放的那一次节日假期：start 是节日那天，end 是假期最后一天（没在放就是 undefined）。10月2号的国庆已经过了
 *  「10月1日」那天，readDepartDates 照旧读成明年的国庆，但客户这时顺口问「国庆期间人多吗」，说的多半就是眼下这个 */
function holidayInProgress(name: string, today: string): { start: string; end: string } | undefined {
  const days = HOLIDAY_DAYS[name];
  const solar = SOLAR_HOLIDAYS[name];
  const starts = solar ? [`${today.slice(0, 4)}-${solar}`] : (LUNAR_HOLIDAYS[name] ?? []);
  for (const start of days ? starts : []) {
    const end = addDays(start, days - 1);
    if (start <= today && today <= end) return { start, end };
  }
  return undefined;
}

function holidayDate(word: string, yearText: string | undefined, today: string): SpokenDate {
  const year = Number(today.slice(0, 4));
  const name = HOLIDAY_ALIAS[word] ?? word;
  const solar = SOLAR_HOLIDAYS[name];
  const want = !yearText ? undefined : yearText === '今年' ? year : yearText === '明年' ? year + 1 : Number(yearText.slice(0, 4));
  const iso = solar
    ? `${want ?? (`${year}-${solar}` >= today ? year : year + 1)}-${solar}`
    : LUNAR_HOLIDAYS[name].find((d) => (want ? d.startsWith(`${want}-`) : d >= today));
  // 正在放的这次节日：没说哪年的，或说的就是这次的年份（「今年国庆」）才算；「明年国庆」说的不是眼下这次。
  // 不看 iso 找没找到：2028 年春节初二到初七，表里没有下一次春节，iso 找不到、读成说不准，眼下这次照样在放
  const now = holidayInProgress(name, today);
  const ongoing = now && (want === undefined || now.start.startsWith(`${want}-`)) ? { ongoing: { from: today, to: now.end } } : {};
  return !iso ? { kind: 'vague', ...ongoing } : { kind: 'date', iso: iso >= today ? iso : undefined, exact: false, ...ongoing };
}
const NEW_YEAR_SAID = new RegExp(
  '(明年|今年)?\\s*(?:(过完年|过了年|过完春节|过了春节|(?:过年|春节(?:假期|长假)?(?:过)?)(?:之后|以后|后)|(?<![\\d一二两三四五六七八九十几多半去前今明后成])年后)' +
    '|((?:过年|春节)(?:之前|以前|前)(?!后)|(?<![\\d一二两三四五六七八九十几多半去前今明后成])年前)|(过年(?!好|快乐)|春节))',
);
const NEW_YEAR_SAID_ALL = new RegExp(NEW_YEAR_SAID.source, 'g');
function newYearMonth(text: string, today: string): { y: number; mo: number; said: string } | undefined {
  const m = NEW_YEAR_SAID.exec(text);
  if (!m) return undefined;
  const shift = m[2] ? 7 : m[3] ? -7 : 0;
  const year = Number(today.slice(0, 4));
  const want = m[1] === '明年' ? year + 1 : m[1] === '今年' ? year : undefined;
  for (const day of LUNAR_HOLIDAYS.春节) {
    if (want && !day.startsWith(`${want}-`)) continue;
    const t = new Date(`${day}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + shift);
    const anchor = t.toISOString().slice(0, 10);
    if (anchor < today) continue;
    return { y: Number(anchor.slice(0, 4)), mo: Number(anchor.slice(5, 7)), said: m[2] ?? m[3] ?? m[4] };
  }
  return undefined;
}

function monthAnchor(text: string, read: DateReadResult, today: string): YearMonth | undefined {
  const at = read.pickAt;
  if (!at) return undefined;
  // 只认通用解析实际选中的春节前后说法；不从其他日子的旁句补月份。
  const ny = [...text.matchAll(NEW_YEAR_SAID_ALL)].find((m) => m.index! < at.end && m.index! + m[0].length > at.at);
  return ny ? newYearMonth(ny[0], today) : undefined;
}

export const travelDatePolicy: DateParsePolicy = {
  holidayPattern: '国庆|十一(?=\\s*(?:假期|长假|小长假|黄金周|期间))|五一|劳动节|元旦|春节|大年初一|端午|中秋|八月十五',
  vaguePattern: '寒假|暑假|过完年|过了年|过年(?!好|快乐)|(?<![\\d一二两三四五六七八九十几多半去前今明后成])年[前后]',
  holidayDate,
  monthAnchor,
};
/** 客户说的、落在 iso 那天的节假日叫法（「十一」按国庆说）。一句里说了几个节日时认日子：「去年国庆去过云南了 明年五一想去三亚」是五一 */
export function holidayIn(text: string, iso: string): string | undefined {
  const names = [
    ...text.matchAll(/国庆|十一(?=\s*(?:假期|长假|小长假|黄金周|期间|出发|去|走))|五一|劳动节|元旦|春节|大年初一|端午|中秋|八月十五/g),
  ].map((m) => HOLIDAY_ALIAS[m[0]] ?? m[0]);
  return names.find((n) => SOLAR_HOLIDAYS[n] === iso.slice(5) || LUNAR_HOLIDAYS[n]?.includes(iso));
}

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
export const PRICE_HOLIDAY_PATTERN =
  '国庆|黄金周|五一|劳动节|春节|过年|寒假|元旦|暑假|圣诞|中秋|清明|端午|(?<![\\d一二三四五六七八九十])十一(?![月个位人天日号点多万千百年岁])';

export const travelMonthPolicy: MonthParsePolicy = {
  holidayPattern: PRICE_HOLIDAY_PATTERN,
  holidayMonths: HOLIDAY_MONTHS,
};

/** 保留工具原来的本地年份口径；可订上界属于旅游政策。 */
export function latestBookableDate(year = new Date().getFullYear()): string {
  return `${year + travelDateThresholds.bookableYears}-12-31`;
}
