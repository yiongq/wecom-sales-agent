// 07 R22：政策陈述护栏（旅游包 policy_claims 步骤的正文）。排在 claim_words 之后、price 之前，只换小句或补出处，
// 不建单、不转人工、不调工具；含 /pay/、/proposal/ 链接（或链接空位）的句子整句不动（同 06 R13）。
//
// 三条规则，按本轮捕获的已发布 policy 与本轮条款查：
//   1 退改语境（退、退款、取消）里带数字的天数与比例对不上档位 → 换成那一档条款原句加出处「（退改条款第N条）」；
//     对得上没写出处 → 句末补出处（patch）。没有数字的句子不动（K16：「退改条款都写明」）。
//   2 「上浮 N%」「N 折」「N 人及以上」与 pricing 不符、「超过 N 个月」与 booking 不符 → 换成生成段原句。
//     与默认 policy 相等的各种写法（带不带空格、「了」、「4 位」「4人」）一字不改（K19）。
//   3 客户这句是政策问法（保险、费用含不含），回复里有这一主题的肯定说法，而会话里出现过的线路在产品库里的「含」都没有这个说法
//     → 换成 claim-words.ts 的口径句。「待顾问确认」备注由后面的 system_note 记：口径句带「由顾问跟您确认」，它按
//     DEFER_TO_CONSULTANT 记一条，这里不另记，免得一轮两条（K18：别的轮次不记）。否定说法（不含、要另付）一律不动（K14）。
//   另：回复里有被产品库「含」支持的肯定说法、句末没写出处时，补「（《线路名》费用说明）」（动作 patch）。
//
// 不改 dropUnbackedClaims 与 claim_words：本文件只做纯文字变换，由 reply-steps.ts 的步骤接线。
import { sentenceUnits, type GuardToolSource, type Order, type Route, type Session } from '../../core/pack-api.js';
import { FEES_REPLY, INSURANCE_REPLY } from './claim-words.js';
import { policyAsk } from './policy-ask.js';
import { clauses as policyClauses, peakPercent, segments, travelPolicySchema, type TravelPolicy } from './policy.js';

export interface PolicyClaimsEnv {
  /** 本轮捕获的已发布 policy（核心以 unknown 持有）；读不出来整步不动 */
  policy: unknown;
  /** 客户这一句：规则 3 只在它是政策问法时才查 */
  inputText: string;
  /** 会话里出现过的线路在产品库里的样子（见 routesInScope） */
  scope: readonly Route[];
}

export interface PolicyClaimsDeps {
  /** 这句话里有链接空位记号：整句不动 */
  hasHole?: (s: string) => boolean;
}

/** 一处改动，供日志与自测归因 */
export interface PolicyEdit {
  rule: 'refund' | 'pricing' | 'booking' | 'unbacked' | 'cite';
  action: 'replace' | 'patch';
  before: string;
  after: string;
}

// ---------------- 小工具 ----------------

const NUM = '(?:\\d{1,3}|[一二两三四五六七八九十]{1,3})';

function digit(c: string): number {
  return '一二三四五六七八九'.indexOf(c === '两' ? '二' : c) + 1;
}

/** 「30」「三十」「十五」「二十九」「七」→ 数；读不出返回 undefined */
function num(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw);
  if (m) return (m[1] ? digit(m[1]) : 1) * 10 + (m[2] ? digit(m[2]) : 0);
  return /^[一二两三四五六七八九]$/.test(raw) ? digit(raw) : undefined;
}

function isLinkSentence(s: string, deps: PolicyClaimsDeps): boolean {
  return /\/(?:pay|proposal)\//.test(s) || !!deps.hasHole?.(s);
}

/** 句子别处已经往顾问那儿引了：换上去的口径句不再重复 */
const ALREADY_DEFERS = /由顾问|顾问[^，。！？!?\n]{0,10}(?:确认|核实|为准|说明|答复)|以[^，。！？!?\n]{0,12}为准|政策会变/;

// ---------------- 句子拆成小句 ----------------

interface Piece {
  text: string;
  /** 小句后面的分隔符（最后一个为空） */
  sep: string;
  /** 换上去的是自带句号的整句口径：它后面不再接逗号，在句末时句末标点由它自己带 */
  terminal?: boolean;
}
interface UnitParts {
  /** 句首的分点记号（「· 」「1. 」） */
  lead: string;
  pieces: Piece[];
  /** 句末标点与换行 */
  tail: string;
}

function parseUnit(unit: string): UnitParts {
  const lead = /^\s*(?:(?:[·•\-*]|\d{1,2}[.、)）])\s*)?/.exec(unit)![0];
  const tail = /(?:[。！!？?～~][」”’）)]*|\s)*$/.exec(unit.slice(lead.length))![0];
  const body = unit.slice(lead.length, unit.length - tail.length);
  const pieces: Piece[] = [];
  let at = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const thousands = c === ',' && /\d/.test(body[i - 1] ?? '') && /^\d{3}(?!\d)/.test(body.slice(i + 1));
    if (c === '—') {
      let end = i;
      while (body[end + 1] === '—') end += 1;
      pieces.push({ text: body.slice(at, i), sep: body.slice(i, end + 1) });
      at = end + 1;
      i = end;
    } else if ('，,；;、'.includes(c) && !thousands) {
      pieces.push({ text: body.slice(at, i), sep: c });
      at = i + 1;
    }
  }
  pieces.push({ text: body.slice(at), sep: '' });
  return { lead, pieces, tail };
}

function buildUnit(u: UnitParts): string {
  const ps = u.pieces;
  // 小句全被删光：只留换行，不留孤零零的句号
  if (!ps.length) return u.tail.replace(/[^\n]/g, '');
  let out = u.lead;
  for (const [i, p] of ps.entries()) {
    let sep = i < ps.length - 1 ? p.sep : '';
    if (p.terminal) sep = '';
    else if (ps[i + 1]?.terminal) sep = /[：:]$/.test(p.text) ? '' : '。';
    out += p.text + sep;
  }
  return out + (ps.at(-1)?.terminal ? u.tail.replace(/[^\n]/g, '') : u.tail);
}

/** 一处待办：把 from..to 这几个小句换掉 / 在 to 后补一段 / 删掉 */
interface Edit {
  from: number;
  to: number;
  kind: 'replace' | 'patch' | 'drop';
  text?: string;
  terminal?: boolean;
  rule: PolicyEdit['rule'];
}

function applyEdits(parts: UnitParts, edits: Edit[]): void {
  for (const e of edits.toSorted((a, b) => b.from - a.from || b.to - a.to)) {
    if (e.kind === 'patch') parts.pieces[e.to]!.text += e.text ?? '';
    else if (e.kind === 'drop') parts.pieces.splice(e.from, e.to - e.from + 1);
    else parts.pieces.splice(e.from, e.to - e.from + 1, { text: e.text ?? '', sep: parts.pieces[e.to]!.sep, terminal: e.terminal });
  }
}

// ---------------- 规则 1：退改天数与比例 ----------------

interface Tier {
  id: string;
  /** 对客出处里的编号（退改条款第N条，从远到近） */
  index: number;
  minDays: number;
  maxDays: number | null;
  /** 低于最低档的「不能自助退」没有比例 */
  percent: number | null;
  title: string;
  text: string;
}

function refundTable(p: TravelPolicy): Tier[] {
  const tiers = p.refund.tiers.toSorted((a, b) => b.minDays - a.minDays);
  const minimum = Math.min(...tiers.map((t) => t.minDays));
  return policyClauses(p)
    .filter((c) => c.topic === 'refund')
    .map((c, i) => {
      const tier = tiers.find((t) => t.id === c.id);
      return {
        id: c.id,
        index: i + 1,
        minDays: tier?.minDays ?? 0,
        maxDays: tier ? tier.maxDays : minimum - 1,
        percent: tier ? tier.percent : null,
        title: c.title,
        text: c.text,
      };
    });
}

const tierOf = (table: readonly Tier[], days: number): Tier | undefined =>
  table.find((t) => days >= t.minDays && (t.maxDays === null || days <= t.maxDays));

/** 退改语境：退款、退订、取消……（「退房」「退烧」这类别的词不算）；保险赔付的话不归这里 */
const REFUND_CTX = /退款|退订|退钱|退费|退团|退改|退掉|退票|退定|退还|返还|取消|退(?![房休烧役出步群场伍学货一而税])/u;
const INSURED = /险|赔付|赔偿/;

type Days = { n: number; hi?: number };
/** 跨小句配对时，天数那一小句得是在说出发前或取消 */
const DEPARTURE_CUE = /出发|提前|取消|退/;

/** 「出发前 N 天」「N 天及以上」「15–29 天」「N 天前」；「N 天内 / 以内 / 以下」是区间的另一头，不判（返回 skip） */
function parseDays(c: string): Days | 'skip' | undefined {
  // 「3 到 5 天内到账」是办理时间，不是出发前的天数
  const range = new RegExp(`(${NUM})\\s*[–\\-~～到至]\\s*(${NUM})\\s*天(?![数晚夜]|内|以内|之内|到账|后)`, 'u').exec(c);
  if (range) {
    const a = num(range[1]!);
    const b = num(range[2]!);
    if (a !== undefined && b !== undefined && a <= b) return { n: a, hi: b };
  }
  const cued = new RegExp(
    `(?:出发前|提前|距出发|距离出发|离出发|距出发日)\\s*(${NUM})\\s*天(\\s*(?:及|或)?\\s*(?:以上|以外|之外)|\\s*(?:之内|以内|以下|内))?`,
    'u',
  ).exec(c);
  if (cued) {
    const n = num(cued[1]!);
    if (n === undefined) return undefined;
    return /内|以下/.test(cued[2] ?? '') ? 'skip' : { n };
  }
  const bare = new RegExp(`(${NUM})\\s*天\\s*(?:(?:及|或)?\\s*(?:以上|以外|之外)|(之内|以内|以下|内)|(?:之前|以前|前))`, 'u').exec(c);
  if (bare) {
    const n = num(bare[1]!);
    if (n === undefined) return undefined;
    return bare[2] ? 'skip' : { n };
  }
  return undefined;
}

/** 扣、收、损失、手续费后面跟的比例是扣掉的那部分，折成退的比例 */
const DEDUCT = /(?:扣除?|收取?|损失|违约金|手续费|罚)[^，。；\d%]{0,6}$/;

/**
 * 命中前面几个字里有否定（「不能全额退」「没有上浮 20%」「不打 9 折」）：说的是做不到、没有的事，不是承诺，不判。
 * 「不超过 6 个月」不走这里——它是在说上限
 */
const NEGATED_BEFORE = /(?:不能|不可以|不可|无法|没法|不会|不是|并非|没有|没|不了|不用|不必|不|无|别|未)[^，。；]{0,3}$/;
const negatedAt = (c: string, at: number): boolean => NEGATED_BEFORE.test(c.slice(Math.max(0, at - 8), at));

/** 退多少：「80%」「百分之八十」「八成」「全额 / 全款」「一半」「不退」；没说返回 undefined */
function parsePct(c: string): number | undefined {
  const hits: { at: number; value: number }[] = [];
  const push = (at: number, value: number): void => {
    if (!negatedAt(c, at)) hits.push({ at, value: DEDUCT.test(c.slice(0, at)) ? 100 - value : value });
  };
  for (const m of c.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) push(m.index, Number(m[1]));
  for (const m of c.matchAll(new RegExp(`百分之\\s*(${NUM})`, 'gu'))) {
    const v = num(m[1]!);
    if (v !== undefined) push(m.index, v);
  }
  for (const m of c.matchAll(/(\d|[一二两三四五六七八九十])\s*成(?![功团交行人就为立长熟])/gu)) {
    const v = num(m[1]!);
    if (v !== undefined) push(m.index, v * 10);
  }
  for (const m of c.matchAll(/(?<![付交缴])(?:全额|全款|足额|全退)(?!支付|付清|预付)/gu)) push(m.index, 100);
  for (const m of c.matchAll(/一半|半价|对半/gu)) push(m.index, 50);
  for (const m of c.matchAll(/不予退|不退|无法退|不能退|概不退|不可退|不给退/gu)) hits.push({ at: m.index, value: 0 });
  return hits.toSorted((a, b) => a.at - b.at)[0]?.value;
}

/** 句里已经写了出处：「（退改条款第2条）」「适用退改条款第2条」 */
function parseCite(c: string): number | undefined {
  const m = new RegExp(`退改条款第\\s*(${NUM})\\s*条`, 'u').exec(c);
  return m ? num(m[1]!) : undefined;
}

const tierLine = (t: Tier): string => `${t.text}（${t.title}）`;

/** 句末是问号、这个小句又带问法词：它在问，不是在断言（「出发前 7 天能全额退吗？」），不改成答案 */
const QUESTION_WORD = /吗|嘛|么|是否|能不能|可不可以|有没有|会不会|是不是|对不对/;
function asking(parts: UnitParts, to: number): boolean {
  return /[?？]/.test(parts.tail) && to === parts.pieces.length - 1 && QUESTION_WORD.test(parts.pieces[to]!.text);
}

function refundEdits(parts: UnitParts, unit: string, table: readonly Tier[]): Edit[] {
  if (!REFUND_CTX.test(unit)) return [];
  // 说保险赔付的小句不归退改档位（「取消险最高赔付 90%」），其余小句照查
  const infos = parts.pieces.map((p) =>
    INSURED.test(p.text)
      ? { days: undefined, pct: undefined, cite: undefined }
      : { days: parseDays(p.text), pct: parsePct(p.text), cite: parseCite(p.text) },
  );
  const claims = (i: number): boolean => infos[i]!.pct !== undefined || infos[i]!.cite !== undefined;
  interface Item {
    from: number;
    to: number;
    days?: Days;
    pct?: number;
    cite?: number;
  }
  const items: Item[] = [];
  const used = new Set<number>();
  for (let i = 0; i < infos.length; i++) {
    if (used.has(i)) continue;
    const a = infos[i]!;
    const next = infos[i + 1];
    const nextFree = !!next && !used.has(i + 1);
    if (a.days === 'skip') {
      // 「7 天内取消，退 30%」：前半句是区间的另一头，后半句的比例也不判
      used.add(i);
      if (nextFree && next.days === undefined && claims(i + 1)) used.add(i + 1);
    } else if (a.days && claims(i)) {
      items.push({ from: i, to: i, days: a.days, pct: a.pct, cite: a.cite });
      used.add(i);
    } else if (a.days) {
      // 天数在前、比例或出处在下一小句
      if (nextFree && next.days === undefined && claims(i + 1) && DEPARTURE_CUE.test(parts.pieces[i]!.text)) {
        items.push({ from: i, to: i + 1, days: a.days, pct: next.pct, cite: next.cite });
        used.add(i).add(i + 1);
      }
    } else if (claims(i)) {
      // 比例或出处在前、天数在下一小句（那一小句得是在说出发前或取消），否则就是没说天数的比例
      if (nextFree && typeof next.days === 'object' && !claims(i + 1) && DEPARTURE_CUE.test(parts.pieces[i + 1]!.text)) {
        items.push({ from: i, to: i + 1, days: next.days, pct: a.pct, cite: a.cite });
        used.add(i).add(i + 1);
      } else {
        items.push({ from: i, to: i, pct: a.pct, cite: a.cite });
        used.add(i);
      }
    }
  }

  const percents = new Set(table.flatMap((t) => (t.percent === null ? [] : [t.percent])));
  const edits: Edit[] = [];
  for (const item of items) {
    if (asking(parts, item.to)) continue;
    // 没说天数的「不退」：没有数字可核（「不退不换，请谨慎下单」），不判
    if (!item.days && item.pct === 0 && item.cite === undefined) continue;
    const dayTier = item.days ? tierOf(table, item.days.n) : undefined;
    if (item.days && !dayTier) continue; // 档位覆盖不到（policy lint 会拦），不判
    const citeTier = item.cite === undefined ? undefined : table.find((t) => t.index === item.cite);
    let bad: string | undefined;
    let tier = dayTier ?? citeTier;
    if (dayTier && item.days?.hi !== undefined && tierOf(table, item.days.hi)?.id !== dayTier.id) bad = tierLine(dayTier);
    else if (item.cite !== undefined && !citeTier) {
      if (!dayTier) continue; // 引了不存在的条款又没说天数：不判
      bad = tierLine(dayTier);
    } else if (dayTier && citeTier && dayTier.id !== citeTier.id) bad = tierLine(dayTier);
    else if (item.pct !== undefined) {
      if (tier) {
        if (tier.percent === null || tier.percent !== item.pct) bad = tierLine(tier);
      } else if (!percents.has(item.pct)) {
        // 没说天数、比例也不是任何一档：不知道指哪一档，列全部
        bad = table.map(tierLine).join('；');
      } else {
        const same = table.filter((t) => t.percent === item.pct);
        tier = same.length === 1 ? same[0] : undefined;
      }
    }
    if (bad !== undefined) {
      edits.push({ from: item.from, to: item.to, kind: 'replace', text: bad, rule: 'refund' });
    } else if (tier && item.days && item.pct !== undefined && item.cite === undefined && !unit.includes(tier.title)) {
      edits.push({ from: item.from, to: item.to, kind: 'patch', text: `（${tier.title}）`, rule: 'cite' });
    }
  }
  return edits;
}

// ---------------- 规则 2：定价与预订月数 ----------------

/** 「N 折」的折扣率：95 折、9.5 折、九五折 → 0.95；9 折 → 0.9 */
function discountOf(m: RegExpMatchArray): number | undefined {
  if (m[1] !== undefined) {
    const n = Number(m[1]);
    return n === 10 ? 1 : n > 10 ? n / 100 : n / 10;
  }
  return m[2] ? (digit(m[2]) + (m[3] ? digit(m[3]) / 10 : 0)) / 10 : undefined;
}

const DISCOUNT = /(?<![\d.])(?:(\d{1,3}(?:\.\d)?)|([一二三四五六七八九])([一二三四五六七八九])?)\s*折(?![扣合叠腾射])/gu;
const PEAK_WORD = '(?:上浮|上涨|涨价|加价|上调)';
const GROUP_CUE = /折|优惠|折扣|减|享|打|每人/;

function pricingEdits(parts: UnitParts, p: TravelPolicy): Edit[] {
  const edits: Edit[] = [];
  const { pieces } = parts;
  const taken = new Set<number>();
  const take = (from: number, to: number): boolean => {
    for (let i = from; i <= to; i++) if (taken.has(i)) return false;
    for (let i = from; i <= to; i++) taken.add(i);
    return true;
  };

  // 上浮 N%：按小句查，只换那一小句
  const peak = peakPercent(p);
  for (const [i, piece] of pieces.entries()) {
    const found = [
      ...piece.text.matchAll(new RegExp(`${PEAK_WORD}(?:了|约|大约|近|将近|差不多)*\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'gu')),
      ...piece.text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:的)?\\s*${PEAK_WORD}`, 'gu')),
      ...piece.text.matchAll(new RegExp(`${PEAK_WORD}(?:了|约|大约)*\\s*百分之\\s*(${NUM})`, 'gu')),
    ].filter((m) => !negatedAt(piece.text, m.index));
    const wrong = found.some((m) => {
      const v = /^\d/.test(m[1]!) ? Number(m[1]) : num(m[1]!);
      return v !== undefined && Math.abs(v - peak) > 0.01;
    });
    if (!wrong || asking(parts, i) || !take(i, i)) continue;
    const month = /(\d{1,2})\s*月/.exec(piece.text)?.[1];
    const note = segments['note:peak'](p);
    edits.push({
      from: i,
      to: i,
      kind: 'replace',
      text: month ? note.replace('{month}', month) : note.replace('{month}月为', ''),
      rule: 'pricing',
    });
  }

  // N 折、N 人及以上：同一处优惠说的两个数，相邻的小句合成一处换
  const groupInfo = pieces.map((piece) => ({
    discounts: [...piece.text.matchAll(DISCOUNT)].filter((m) => !negatedAt(piece.text, m.index)).map(discountOf),
    thresholds: [
      ...piece.text.matchAll(new RegExp(`(${NUM})\\s*(?:人|位)\\s*(?:及|或)?\\s*以上`, 'gu')),
      ...piece.text.matchAll(new RegExp(`满\\s*(${NUM})\\s*(?:人|位)`, 'gu')),
    ]
      .filter((m) => !negatedAt(piece.text, m.index))
      .map((m) => num(m[1]!)),
    cue: GROUP_CUE.test(piece.text),
  }));
  const qualifies = (i: number): boolean => {
    const g = groupInfo[i];
    if (!g) return false;
    return (
      g.discounts.length > 0 ||
      (g.thresholds.length > 0 && (g.cue || !!groupInfo[i - 1]?.discounts.length || !!groupInfo[i + 1]?.discounts.length))
    );
  };
  for (let i = 0; i < pieces.length; i++) {
    if (!qualifies(i)) continue;
    let j = i;
    while (qualifies(j + 1)) j += 1;
    const run = groupInfo.slice(i, j + 1);
    const wrong =
      run.some((g) => g.discounts.some((d) => d === undefined || Math.abs(d - p.pricing.groupDiscount) > 1e-6)) ||
      run.some((g) => g.thresholds.some((n) => n !== p.pricing.groupMinimum));
    if (wrong && !asking(parts, j) && take(i, j))
      edits.push({ from: i, to: j, kind: 'replace', text: segments['note:group'](p), rule: 'pricing' });
    i = j;
  }

  // 超过 N 个月：只在说预订、出发、报价时查
  const months = p.booking.maxDepartMonths;
  const BOOKING_CUE = /出发|出行|预订|预定|下单|受理|报价|价格|参考价|订单|可订|能订|订不了/;
  for (const [i, piece] of pieces.entries()) {
    if (!BOOKING_CUE.test(piece.text)) continue;
    const said: number[] = [];
    const toMonths = (raw: string, kind: string): number | undefined => {
      const n = raw === '半' ? 0.5 : num(raw);
      return n === undefined ? undefined : kind === '年' ? Math.round(n * 12) : n;
    };
    for (const m of piece.text.matchAll(new RegExp(`(?:超过|超出|多于|大于|晚于)\\s*(半|${NUM})\\s*(个月|年)`, 'gu'))) {
      const v = toMonths(m[1]!, m[2]!);
      if (v !== undefined) said.push(v);
    }
    for (const m of piece.text.matchAll(new RegExp(`(${NUM})\\s*个月\\s*(?:以上|以外|之外|以后|之后)`, 'gu'))) {
      const v = toMonths(m[1]!, '个月');
      if (v !== undefined) said.push(v);
    }
    for (const m of piece.text.matchAll(new RegExp(`(?:最远|最多|至多|仅|只能|只受理|只接受|只可)[^，。；]{0,8}?(${NUM})\\s*个月`, 'gu'))) {
      const v = toMonths(m[1]!, '个月');
      if (v !== undefined) said.push(v);
    }
    if (said.some((v) => v !== months) && !asking(parts, i) && take(i, i)) {
      edits.push({ from: i, to: i, kind: 'replace', text: segments['note:far-future'](p), rule: 'booking' });
    }
  }
  return edits;
}

// ---------------- 规则 3：保险、费用含不含 ----------------

const INS = '(?:保险|意外险|医疗险|责任险|高原险|旅游险|旅行险|救援险)';
const INS_IN = /保险|意外险|医疗险|责任险|高原险|旅游险|旅行险|救援险/;
/** 问句、条件句、建议与否定：这些小句不算肯定说法 */
const HYPOTHETICAL = /如果|要是|假如|若是|倘若|是否|能不能|可不可以|会不会|有没有|是不是|对不对|吗|[么?？]|需要|要不要|想要/;
const NEGATED =
  /不含|不包含|不包括|不包|不带|不提供|不赠|没有|没含|未含|未包含|无(?!忧)|另付|另购|另买|另外(?:买|购|付)|自理|自费|自行|需(?:要)?另|要另|建议|推荐|可选|选购|加购|附加|代(?:买|购|办|订)/;

interface FeeItem {
  name: string;
  ask: RegExp;
  /** 线路的「含」里有这一项 */
  inc: RegExp;
}

function feeItems(): FeeItem[] {
  return [
    { name: '机票', ask: /机票|航班|飞机/, inc: /机票|航班|飞机/ },
    { name: '交通', ask: /交通|用车|接送|接机|送机/, inc: /交通|用车|接送|接机|送机|高铁|机票/ },
    { name: '门票', ask: /门票|景区/, inc: /门票|景区/ },
    { name: '餐', ask: /早餐|午餐|晚餐|三餐|正餐|餐/, inc: /餐|早|宴/ },
    { name: '住宿', ask: /住宿|酒店/, inc: /住宿|酒店|晚/ },
    { name: '酒水', ask: /酒水|饮料|饮品/, inc: /酒水|饮品|饮用水|饮料/ },
    { name: '小费', ask: /小费|服务费/, inc: /小费|服务费/ },
    { name: '签证', ask: /签证/, inc: /签证/ },
    { name: '行李', ask: /行李/, inc: /行李/ },
    { name: '导游', ask: /导游|向导|司导/, inc: /导游|向导|司导/ },
  ];
}

/** 整句没有具体项目的费用承诺：「不用另付」「没有隐形消费」「全包」。线路的「含」里没有同样的说法就是无出处 */
const GENERIC_FEES =
  /不用另付|无需另付|不需要另付|不用额外(?:花|付|交|收)|无需额外|(?:不会|不会再)(?:有|产生|收)(?:任何)?(?:额外|其他|隐形|隐藏)(?:的)?(?:费用|消费|收费)|没有(?:任何)?(?:额外|其他|隐形|隐藏)(?:的)?(?:费用|消费|收费|自费)|无(?:任何)?(?:隐形|额外|隐藏|自费)|零(?:自费|隐形|额外)|全包|所有费用(?:都)?(?:已)?(?:包含|含)|费用(?:都)?(?:已)?(?:包含|含)了?(?:所有|全部|一切)|(?:全部|所有|一切)(?:都)?(?:已)?(?:包含|含)在内/;
const GENERIC_IN = /全包|无需另付|不用另付|无额外|无隐形/;
/** 「含的」「包含的」「有的」「是含的」：整个小句就是一声肯定的回答 */
const BARE_YES = /^(?:嗯嗯?|是的?|对的?|好的?|放心)?[，,\s]*(?:是)?(?:含|包含|包括|包|有)(?:的|了|着)?[哦呀呢啦噢哈哟~～!！]{0,2}$/u;

interface Claim {
  topic: 'insurance' | 'fees';
  /** 'insurance'、'generic'，或费用项目名 */
  item: string;
  /** 回答的是「含的」这种光杆肯定：问了什么就算说了什么 */
  bare?: boolean;
}

/** 「嗯」「是的」「好的」：只是应一声，后面接着才是答案 */
const ACK = /^(?:嗯嗯?|是的?|对的?|好的?|好呀|当然|可以的?|没问题|能的?|放心)$/u;

function claimsIn(clause: string, asked: ReadonlySet<string>, askedFee: readonly FeeItem[], opts: { first: boolean }): Claim[] {
  const text = clause.trim();
  if (!text || HYPOTHETICAL.test(text)) return [];
  const out: Claim[] = [];
  if (asked.has('fees') && GENERIC_FEES.test(text)) out.push({ topic: 'fees', item: 'generic' });
  if (NEGATED.test(text)) return out;
  if (asked.has('insurance')) {
    const a = new RegExp(
      `(?:含|包含|包括|包了|包有|已含|已包含|已包括|带有?|附带|附赠|赠送|送|配有?|配备|提供|覆盖)[^，。；！？!?\\n]{0,8}?${INS}|有(?:全程|专属|高原|旅行|旅游|意外|医疗|责任|一份|一个|份|个|的)*${INS}`,
    );
    const b = new RegExp(`${INS}[^，。；！？!?\\n]{0,4}?(?:都|已经?|也|全)?(?:包含|含|包括|在内|都有|也有|有的|已有)(?!不|吗|么|嘛|没)`);
    if (a.test(text) || b.test(text)) out.push({ topic: 'insurance', item: 'insurance' });
  }
  if (asked.has('fees')) {
    for (const f of feeItems()) {
      const a = new RegExp(`(?:含|包含|包括|包了|已含|已包含|已包括|赠送|附赠|免费提供|包)[^，。；！？!?\\n]{0,6}?(?:${f.ask.source})`);
      const b = new RegExp(
        `(?:${f.ask.source})[^，。；！？!?\\n]{0,4}?(?:都|已经?|也|全)?(?:包含|含|包括|在内|已含|都有)(?!不|吗|么|嘛|没)`,
      );
      if (a.test(text) || b.test(text)) out.push({ topic: 'fees', item: f.name });
    }
  }
  if (!out.length && opts.first && BARE_YES.test(text)) {
    if (asked.has('insurance')) out.push({ topic: 'insurance', item: 'insurance', bare: true });
    if (asked.has('fees') && askedFee.length) for (const f of askedFee) out.push({ topic: 'fees', item: f.name, bare: true });
  }
  return out;
}

/** 会话里出现过的线路：lastShownRoutes、最近一次报价、订单、本轮工具结果里的线路，以及回复里点名的《线路》 */
export function routesInScope(
  session: Pick<Session, 'lastShownRoutes' | 'lastQuote'>,
  orders: readonly Pick<Order, 'routeId'>[],
  toolSources: readonly GuardToolSource[],
  replyText: string,
  routes: readonly Route[],
): Route[] {
  const ids = new Set<string>();
  for (const r of session.lastShownRoutes ?? []) ids.add(r.id);
  if (session.lastQuote?.routeId) ids.add(session.lastQuote.routeId);
  for (const o of orders) ids.add(o.routeId);
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      for (const key of ['id', 'routeId'] as const) {
        const v = (value as Record<string, unknown>)[key];
        if (typeof v === 'string') ids.add(v);
      }
    }
  };
  for (const call of toolSources) {
    if (typeof call.args?.routeId === 'string') ids.add(call.args.routeId);
    if (typeof call.result !== 'string') continue;
    try {
      collect(JSON.parse(call.result));
    } catch {
      /* 工具结果不是 JSON 就没有线路可认 */
    }
  }
  const squash = (s: string): string => s.replace(/\s+/g, '');
  for (const m of replyText.matchAll(/《([^》]{2,40})》/g)) {
    const name = squash(m[1]!);
    for (const r of routes) if (squash(r.title).includes(name) || name.includes(squash(r.title))) ids.add(r.id);
  }
  return routes.filter((r) => ids.has(r.id));
}

function unbackedEdits(
  parts: UnitParts,
  unit: string,
  env: {
    asked: ReadonlySet<string>;
    askedFee: readonly FeeItem[];
    scope: readonly Route[];
    first: boolean;
    replyText: string;
    used: Set<string>;
  },
): { edits: Edit[]; backed: Claim[] } {
  const edits: Edit[] = [];
  const backed: Claim[] = [];
  // 句末是问号：最后一个小句是在问，不是断言（前面的小句照查）
  const questionTail = /[?？]/.test(parts.tail);
  const inclusions = env.scope.flatMap((r) => r.inclusions ?? []);
  const fees = feeItems();
  const isBacked = (c: Claim): boolean => {
    if (c.item === 'insurance') return inclusions.some((t) => INS_IN.test(t));
    if (c.item === 'generic') return inclusions.some((t) => GENERIC_IN.test(t));
    const f = fees.find((x) => x.name === c.item);
    return !!f && inclusions.some((t) => f.inc.test(t));
  };
  const claimPieces: { index: number; unbacked: Claim[] }[] = [];
  for (const [i, piece] of parts.pieces.entries()) {
    if (questionTail && i === parts.pieces.length - 1) continue;
    const opening = env.first && parts.pieces.slice(0, i).every((p) => ACK.test(p.text.trim()));
    const found = claimsIn(piece.text, env.asked, env.askedFee, { first: opening });
    if (!found.length) continue;
    const unbacked = found.filter((c) => !isBacked(c));
    for (const c of found) if (isBacked(c)) backed.push(c);
    if (unbacked.length) claimPieces.push({ index: i, unbacked });
  }
  if (!claimPieces.length) return { edits, backed };

  // 换成口径句：同一句话回复里只出现一次；别处（回复里的别的句子，或本句没被换掉的小句）已经往顾问那儿引了就只删
  const replies = [...new Set(claimPieces.flatMap((c) => c.unbacked.map((u) => (u.topic === 'insurance' ? INSURANCE_REPLY : FEES_REPLY))))];
  const claimIdx = new Set(claimPieces.map((c) => c.index));
  const rest = parts.pieces
    .filter((_, i) => !claimIdx.has(i))
    .map((p) => p.text)
    .join('');
  const fresh = replies.filter((r) => !env.used.has(r) && !env.replyText.replace(unit, '').includes(r));
  const defers = ALREADY_DEFERS.test(rest);
  const text = defers ? '' : fresh.join('');
  for (const r of fresh) env.used.add(r);
  const first = claimPieces[0]!.index;
  // 开头只应了一声（「可以的，」「没问题，」）：应的就是被换掉的那句肯定，一起去掉
  if (first > 0 && parts.pieces.slice(0, first).every((p) => ACK.test(p.text.trim()))) {
    for (let i = 0; i < first; i++) edits.push({ from: i, to: i, kind: 'drop', rule: 'unbacked' });
  }
  for (const c of claimPieces) {
    if (c.index === first && text) edits.push({ from: c.index, to: c.index, kind: 'replace', text, terminal: true, rule: 'unbacked' });
    else edits.push({ from: c.index, to: c.index, kind: 'drop', rule: 'unbacked' });
  }
  return { edits, backed: [] };
}

/** 被「含」支持的肯定说法该写哪条线路的出处：回复点名的优先，其次最近一次报价，其余只剩一条时才补，拿不准不补 */
function citeRoute(
  backed: readonly Claim[],
  scope: readonly Route[],
  replyText: string,
  focusRouteId: string | undefined,
): Route | undefined {
  const fees = feeItems();
  const supports = (r: Route, c: Claim): boolean => {
    const inc = r.inclusions ?? [];
    if (c.item === 'insurance') return inc.some((t) => INS_IN.test(t));
    if (c.item === 'generic') return inc.some((t) => GENERIC_IN.test(t));
    const f = fees.find((x) => x.name === c.item);
    return !!f && inc.some((t) => f.inc.test(t));
  };
  const sup = scope.filter((r) => backed.every((c) => supports(r, c)));
  if (!sup.length) return undefined;
  const squash = (s: string): string => s.replace(/\s+/g, '');
  const named = sup.filter((r) => {
    const t = squash(r.title);
    return [...replyText.matchAll(/《([^》]{2,40})》/g)].some((m) => t.includes(squash(m[1]!)) || squash(m[1]!).includes(t));
  });
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  if (sup.length === 1) return sup[0];
  return sup.find((r) => r.id === focusRouteId);
}

// ---------------- 主函数 ----------------

export function rewritePolicyClaims(
  text: string,
  env: PolicyClaimsEnv,
  deps: PolicyClaimsDeps = {},
  focusRouteId?: string,
): { text: string; patched: string; edits: PolicyEdit[] } {
  const parsed = travelPolicySchema.safeParse(env.policy);
  if (!parsed.success) return { text, patched: text, edits: [] };
  const policy = parsed.data;
  const table = refundTable(policy);
  const asked = new Set<string>(policyAsk(env.inputText).filter((t) => t === 'insurance' || t === 'fees'));
  const askedFee = asked.has('fees') ? feeItems().filter((f) => f.ask.test(env.inputText)) : [];
  const units = sentenceUnits(text);
  // 紧挨着链接行的那一句、引出链接的那一句（冒号收尾）也不动
  const pinned = units.map((u, k) => {
    const s = text.slice(u.start, u.end);
    if (!s.trim() || isLinkSentence(s, deps)) return true;
    const next = units[k + 1];
    if (next && isLinkSentence(text.slice(next.start, next.end), deps)) return true;
    if (/[：:]\s*$/.test(s)) {
      for (const n of units.slice(k + 1, k + 11)) {
        const t = text.slice(n.start, n.end);
        if (!t.trim()) break;
        if (isLinkSentence(t, deps)) return true;
      }
    }
    return false;
  });

  const edits: PolicyEdit[] = [];
  const used = new Set<string>();
  const patchedOnly: string[] = [];
  const final: string[] = [];
  let firstUnit = true;
  for (const [k, u] of units.entries()) {
    const unit = text.slice(u.start, u.end);
    if (pinned[k]) {
      patchedOnly.push(unit);
      final.push(unit);
      if (unit.trim()) firstUnit = false;
      continue;
    }
    const parts = parseUnit(unit);
    const plan: Edit[] = [];
    const claim = (more: Edit[]): void => {
      for (const e of more) {
        const clash = plan.some((x) => !(e.to < x.from || e.from > x.to));
        if (!clash) plan.push(e);
      }
    };
    claim(refundEdits(parts, unit, table));
    claim(pricingEdits(parts, policy));
    let backed: Claim[] = [];
    if (asked.size) {
      const r = unbackedEdits(parts, unit, { asked, askedFee, scope: env.scope, first: firstUnit, replyText: text, used });
      claim(r.edits);
      backed = r.backed;
    }
    firstUnit = false;
    if (backed.length && !plan.length && !/费用说明）|（保险说明）/.test(unit)) {
      const route = citeRoute(backed, env.scope, text, focusRouteId);
      if (route)
        plan.push({
          from: parts.pieces.length - 1,
          to: parts.pieces.length - 1,
          kind: 'patch',
          text: `（《${route.title}》费用说明）`,
          rule: 'cite',
        });
    }
    if (!plan.length) {
      patchedOnly.push(unit);
      final.push(unit);
      continue;
    }
    const patchPlan = plan.filter((e) => e.kind === 'patch');
    const onlyPatched = structuredClone(parts);
    applyEdits(onlyPatched, patchPlan);
    const done = structuredClone(parts);
    applyEdits(done, plan);
    const patchedText = buildUnit(onlyPatched);
    const finalText = buildUnit(done);
    patchedOnly.push(patchedText);
    final.push(finalText);
    for (const e of plan) {
      const before =
        e.kind === 'patch'
          ? parts.pieces[e.to]!.text
          : parts.pieces
              .slice(e.from, e.to + 1)
              .map((p) => p.text)
              .join('，');
      edits.push({
        rule: e.rule,
        action: e.kind === 'patch' ? 'patch' : 'replace',
        before,
        after: e.kind === 'patch' ? `${before}${e.text}` : (e.text ?? ''),
      });
    }
  }
  return { text: final.join(''), patched: patchedOnly.join(''), edits };
}

/**
 * 步骤会换上去、由条款推出的话（给 fixed-replies 登记、一致性检查用）：每一档的条款原句加出处、列全部档位的一句、
 * 不带月份的上浮说明。文字取自与步骤同一批函数，不另抄一份。
 * 上浮（带月份）、团队优惠、预订月数三句是 policy.ts 的生成段（note:peak、note:group、note:far-future），登记时直接引用生成段
 */
export function policyReplacementTexts(p: TravelPolicy): { id: string; text: string }[] {
  const table = refundTable(p);
  return [
    ...table.map((t) => ({ id: `refund-tier.${t.id}`, text: tierLine(t) })),
    { id: 'refund-all', text: table.map(tierLine).join('；') },
    { id: 'peak-no-month', text: segments['note:peak'](p).replace('{month}月为', '') },
  ];
}

/** 仅供自测使用 */
export function policyClaimsTest() {
  return { refundTable, parseDays, parsePct, parseCite, claimsIn, feeItems, num, discountOf };
}
