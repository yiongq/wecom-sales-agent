// 价格出口校验：报价数字必须能追溯到产品库或本会话的工具结果，模型自己写的价格发不出去。
//
// 此前 URL/订单号有确定性护栏，价格却只有提示词约束（「严禁自己编造任何价格」）——
// 模型真写错一个数字就直接发给客户了。对高客单价产品这是最贵的一类错误：客户按错价
// 下单、成交后才发现，要么公司认亏要么当场翻脸。
import { loadRoutes } from './tools.js';
import { getOrder } from './store.js';
import type { Session } from './types.js';

/** 精确金额：¥12,345 / 12,345元 / 12345 元，且 ≥1000 */
const AMOUNT_RE = /(?:¥|￥)\s*([\d][\d,]{2,})|([\d][\d,]{2,})\s*元/g;

/**
 * 档位口径金额：「3.8 万」「5万」「1.2w」。
 * 这个形态此前完全不在护栏视野里——同一个编造的价格，写成「38000元」会被拦，
 * 写成「3.8 万」就原样发给客户了。而 data/sop.md 恰恰教模型在没调工具前用
 * 「人均 5 万左右这个档」说价位，所以这是漏得最狠的一条路径。
 */
const WAN_RE = /([\d]+(?:\.\d+)?)\s*(?:万|[wW](?![A-Za-z]))/g;

/** 与 tools.ts parseTravelers 的上限对齐。此前只枚举到 20，25 人团的真实工具报价
 *  会被自己的护栏判成「编造」，且模型重算还是同一个数字，客户永远拿不到总价 */
const MAX_TRAVELERS = 50;

/**
 * 回复里出现这些词，说明这是在对客户「报出成交价」，而不是复述他的预算。
 * 此时金额必须来自产品库定价规则或本会话的工具结果——客户自己喊的数字不作数，
 * 否则客户只要说一句「别家 6800，你给我 6800 我立刻订」，模型顺着答
 * 「好的，就按 6800 给您锁定」就能过护栏，而客户点开支付页收的是真实价。
 */
const CLOSING_PRICE =
  /就按|按这个价|按这个数|给您锁定|锁定名额|成交价|优惠价|这个价格给您|给您这个价|就这个价|帮您下单|为您下单/;
/** 婉拒砍价的说法。sop.md 要求「不许直接降价、可以讲价值或换更低档线路」，
 *  于是模型会写「这个价格给您安排不了」「我们没法按这个价走」——里面照样含客户
 *  报的数字和上面的成交措辞，但语义是**拒绝**，不是报成交价。不排除就会把
 *  SOP 教的标准话术整条替换成兜底，客户看到 AI 答非所问。 */
const PRICE_REFUSAL = /做不了|安排不了|没法|无法|不能按|做不到|没有.{0,6}(?:这样|这个)|达不到|恐怕|抱歉/;

/** 把回复切成句子——成交措辞只作用于它所在那一句，不该让整段的其他金额跟着作废 */
function sentences(text: string): string[] {
  return text.split(/[。！!？?\n]+/).map((x) => x.trim()).filter(Boolean);
}

/** 这条回复里有没有「在报成交价」的句子（排除婉拒句） */
function hasClosingPrice(visible: string): boolean {
  return sentences(visible).some((s) => CLOSING_PRICE.test(s) && !PRICE_REFUSAL.test(s));
}

/** 金额说的是人均还是总价——由紧邻的限定词决定，认不出来就两边都比 */
type Scope = 'perPerson' | 'total' | 'any';
const PER_PERSON_HINT = /(?:人均|每人|单人|每位|一位)[^\d¥￥]{0,4}$/;
const TOTAL_HINT = /(?:总价|总共|一共|共计|合计|总计|总额)[^\d¥￥]{0,4}$/;

interface WanAmount { value: number; tol: number; scope: Scope; travelers?: number }

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

/**
 * 「万」的写法自带精度，容差就取这个精度的一半：
 * 「5 万」是 1 位有效数字（±5000）——产品库里 45,800 的线路说成「5 万左右」是正常话术；
 * 「3.8 万」精确到 0.1 万（±500）——同一条线说成「3.8 万」就对不上任何真实价，是编的。
 * 用固定百分比（比如 ±10%）不行：产品库 20 条线的价位铺得很密，10% 的窗口几乎覆盖全域，
 * 等于放行一切。
 */
function wanTolerance(raw: string): number {
  const dot = raw.indexOf('.');
  const decimals = dot < 0 ? 0 : raw.length - dot - 1;
  return 10000 / 2 / 10 ** decimals;
}

function parseAmounts(text: string): number[] {
  const out: number[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(text); m; m = AMOUNT_RE.exec(text)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1000) out.push(n);
  }
  return out;
}

function parseWanAmounts(text: string): WanAmount[] {
  const out: WanAmount[] = [];
  WAN_RE.lastIndex = 0;
  for (let m = WAN_RE.exec(text); m; m = WAN_RE.exec(text)) {
    const n = Number(m[1]) * 10000;
    if (!Number.isFinite(n) || n < 1000) continue;
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    const scope: Scope = PER_PERSON_HINT.test(before) ? 'perPerson' : TOTAL_HINT.test(before) ? 'total' : 'any';
    const cm = COUNT_BEFORE.exec(before);
    out.push({ value: n, tol: wanTolerance(m[1]), scope, travelers: cm ? parseCount(cm[1]) : undefined });
  }
  return out;
}

/**
 * 客户自己说过的金额：当前这句 + 全部历史消息，「¥/元」与「万」两种写法都算。
 * 此前「万」换算只对当前这句做，客户首轮说「预算每人3万」、几轮后模型复述
 * 「我给您控制在 30,000元 以内」会被判成编价，客户看到 AI 突然不认自己的预算。
 */
function customerAmounts(session: Session, customerText: string): number[] {
  const texts = [
    customerText,
    ...(session.messages ?? []).filter((m) => m.role === 'customer').map((m) => m.content),
  ];
  return texts.flatMap((t) => [...parseAmounts(t), ...parseWanAmounts(t).map((w) => w.value)]);
}

interface Allowed {
  perPerson: Set<number>;
  total: Set<number>;
  /** 按出行人数分桶的总价：话里写了人数时只比对对应那一桶 */
  totalByCount: Map<number, Set<number>>;
  /** 工具真算出来的报价/订单金额，以及客户自己说的数——与人数无关，永远放行 */
  authoritative: Set<number>;
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
function allowedAmounts(session: Session, customerText: string, includeCustomerSaid: boolean): Allowed {
  const perPerson = new Set<number>();
  const total = new Set<number>();
  const totalByCount = new Map<number, Set<number>>();
  const authoritative = new Set<number>();
  const add = (set: Set<number>, n: number) => { if (Number.isFinite(n) && n > 0) set.add(Math.round(n)); };

  let routes: { priceFrom: number }[] = [];
  try { routes = loadRoutes(); } catch { /* 数据文件坏了另有告警，这里不阻断对话 */ }
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
  const q = session.lastQuote;
  if (q?.perPerson) { add(perPerson, q.perPerson); add(authoritative, q.perPerson); }
  if (q?.total) { add(total, q.total); add(authoritative, q.total); }
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
      add(perPerson, n); add(total, n); add(authoritative, n);
    }
  }
  return { perPerson, total, totalByCount, authoritative };
}

function setsFor(ok: Allowed, w: WanAmount): Set<number>[] {
  if (w.scope === 'perPerson') return [ok.perPerson];
  // 话里写了人数就只认那一桶的总价（外加工具真算过的金额）
  const totals = w.travelers ? [ok.totalByCount.get(w.travelers) ?? new Set<number>(), ok.authoritative] : [ok.total];
  return w.scope === 'total' ? totals : [ok.perPerson, ...totals];
}

/**
 * 校验回复中的金额。返回未能追溯来源的金额列表（空数组=通过）。
 * PRICE_GUARD=0 可关闭（仅在排查误杀时使用）。
 *
 * 已知边界：产品库里真实存在的价位，模型即使张冠李戴地安到另一条线上也认不出来
 * （护栏只判「这个数字有没有出处」，不判「出处对不对」）。真正编造的数字挡得住。
 */
export function findUnbackedPrices(visible: string, session: Session, customerText: string): number[] {
  if (process.env.PRICE_GUARD === '0') return [];
  // 在报成交价：客户自己喊过的数字不能当白名单，否则等于让客户自己定价
  const closing = hasClosingPrice(visible);
  const ok = allowedAmounts(session, customerText, !closing);
  const bad: number[] = [];
  for (const n of parseAmounts(visible)) {
    if (!ok.perPerson.has(n) && !ok.total.has(n)) bad.push(n);
  }
  for (const w of parseWanAmounts(visible)) {
    const backed = setsFor(ok, w).some((set) => {
      for (const a of set) if (Math.abs(w.value - a) <= w.tol) return true;
      return false;
    });
    if (!backed) bad.push(w.value);
  }
  return bad;
}

/** 仅供自测使用的内部函数出口 */
export const __priceGuardTest = { parseAmounts, parseWanAmounts, wanTolerance, CLOSING_PRICE, hasClosingPrice };
