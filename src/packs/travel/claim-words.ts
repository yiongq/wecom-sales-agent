// 06 R13：越权说法词表。补 dropUnbackedClaims 没管的说法（它管稀缺、专票、资金流程、机票代订、档期余位、电话联系，
// 输出被 price-guard 自测逐字断言，所以这里单独一步，不改它）。
//
// 规则：
//   - 只按小句删或换：在逗号、分号、破折号处切开，删命中的那一小句；剩下的只有连接词就删整句。
//   - 含 /pay/、/proposal/ 链接（或链接空位）的句子整句不动：链接要插进去，也不能误删「国庆是四川最旺的时段」这种正常的话。
//   - D 类（安全与手续断言）用正向词表，不套通用的否定守卫，所以「别担心，正常接待」这种也会命中；
//     只排除问句、条件句，以及词表词本身带否定的（「不正常开放」）。
//   - 换上去的话复用现有说法；同一句话回复里只出现一次。不建单、不转人工、不调工具。
import type { Order, Route } from '../../core/pack-api.js';
import { sentenceUnits } from '../../core/pack-api.js';
import { paymentPendingReply, type ContactMode } from './contact-words.js';

/** 全库最低起价的那条线（产品库快照由调用方传入）。search_routes 的 cheapestOverall（06 R20）复用它。 */
export function cheapestOverall(routes: readonly Route[]): Route | undefined {
  let best: Route | undefined;
  for (const r of routes) if (typeof r.priceFrom === 'number' && r.priceFrom > 0 && (!best || r.priceFrom < best.priceFrom)) best = r;
  return best;
}

export interface ClaimWordsContext {
  mode: ContactMode;
  /** 会话里的订单（含本轮新建的） */
  orders: readonly Order[];
  /** 最近一次报价的线路；没有就为空 */
  focusRouteId?: string;
  /** 本轮固定的产品库快照 */
  routes: readonly Route[];
  yuan(n: number): string;
}

type Dropper = (text: string, cuts: { at: number; end: number; replace?: string }[]) => { text: string; dropped: string[] };

export interface ClaimWordsDeps {
  dropSentences: Dropper;
  /** 这句话里有链接空位记号：整句不动 */
  hasHole?: (s: string) => boolean;
}

// ---------------- 固定话术 ----------------

const POLICY_REPLY = '这块政策会变，由顾问按您的出行时间确认。';
export const VISA_REPLY = '签证怎么办、要多久，由顾问跟您确认。';
/** 与 price-rules 的专票句同一句 */
const INVOICE_REPLY = '发票（含专票）怎么开，由顾问跟您确认。';
const HOTEL_REPLY = '酒店我可以推荐，要订请顾问确认房态。';
const MEDIA_REPLY = '照片和视频我这边发不了，请顾问发给您。';
const OLD_ORDER_REPLY = '之前那张单请先别付款，我请顾问帮您处理。';

// ---------------- 规则 ----------------

interface Rule {
  id: string;
  re: RegExp;
  /** 换上去的话；省略表示只删这一小句 */
  replace?: (ctx: ClaimWordsContext, m: RegExpExecArray) => string | undefined;
  /** 返回 true 表示这处不算：条件不成立，或是问句、条件句 */
  ignore?: (ctx: ClaimWordsContext, m: RegExpExecArray, clause: string, sentence: string) => boolean;
  /** 条件：会话里没有已付款订单等 */
  when?: (ctx: ClaimWordsContext) => boolean;
  /** 换上去的话本身就是「由顾问确认」：句子别处已经往顾问那儿引时，只删不换 */
  defers?: boolean;
  /** 回复别处已经把这层意思说了（模型自己说了「发不了」「请顾问确认房态」）：只删不换，不让同一层意思出现两遍 */
  said?: RegExp;
  /** 命中的小句本来就带金额（签证费、低于最低价的许诺），不让给价格护栏 */
  moneyOk?: boolean;
}

/** 问句、条件句不是断言 */
const HYPOTHETICAL = /如果|要是|假如|若是|倘若|是否|能不能|可不可以|会不会|有没有|是不是|对不对|吗|[?？]/;
/** 句子别处已经往顾问那儿引了 */
const ALREADY_DEFERS = /由顾问|顾问[^，。！？!?\n]{0,10}(?:确认|核实|为准|说明|答复)|以[^，。！？!?\n]{0,12}为准|政策会变/;
const NEGATE_BEFORE = /(?:没法|无法|不能|不用|不必|不需要|不会|不|没|未|别)[^，。！？!?\n]{0,6}$/;

const hasPaidOrder = (ctx: ClaimWordsContext): boolean => ctx.orders.some((o) => ['paid', 'refund_pending', 'refunded'].includes(o.status));
const hasConfirmedOrder = (ctx: ClaimWordsContext): boolean =>
  ctx.orders.some((o) => (o.status === 'pending_payment' || ['paid', 'refund_pending', 'refunded'].includes(o.status)) && !!o.confirmedAt);
/** 会话里有别的线路的待付款单：最近一次报价（没有就取最新一张订单）指的不是它 */
function hasOtherPending(ctx: ClaimWordsContext): boolean {
  const live = ctx.orders.filter((o) => o.status === 'pending_payment');
  if (!live.length) return false;
  const focus = ctx.focusRouteId ?? ctx.orders.at(-1)?.routeId;
  return live.some((o) => o.routeId !== focus);
}

/** 金额：「5000」「5,000」「3万」「两万五」「1.5万」 */
const AMOUNT = '(?:\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万|千|[wWkK])?|[一二两三四五六七八九十]+\\s*(?:万|千)[一二三四五六七八九]?)';
export function parseSpokenAmount(raw: string): number | undefined {
  const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = raw.replace(/[\s,]/g, '');
  const num = /^(\d+(?:\.\d+)?)(万|千|[wWkK])?$/.exec(t);
  if (num) {
    const unit = num[2] === '万' || num[2]?.toLowerCase() === 'w' ? 10000 : num[2] === '千' || num[2]?.toLowerCase() === 'k' ? 1000 : 1;
    return Math.round(Number(num[1]) * unit);
  }
  const cn = /^([一二两三四五六七八九十]+)(万|千)([一二三四五六七八九])?$/.exec(t);
  if (cn) {
    const base = cn[1] === '十' ? 10 : (CN_DIGIT[cn[1]] ?? Number.NaN);
    const unit = cn[2] === '万' ? 10000 : 1000;
    const value = base * unit + (cn[3] ? CN_DIGIT[cn[3]] * (unit / 10) : 0);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/** 规则表（每次现建：模块层不留对象，免得登记成租户状态） */
function buildRules(): Rule[] {
  return [
    // ---- 付款确认（会话里没有已付款订单时）。「已到账」「款项到账后」这类条件说法不算 ----
    {
      id: 'paid_claim',
      // 「付款已收到」「订单正式生效了」：06 第 14 步验收里待付款单上漏过一次
      re: /(?:付款|支付)已?(?:经)?完成|(?:款项|付款|支付)已(?:经)?(?:确认|收到|到账)|已(?:经)?收到(?:您的?)?(?:款项|付款|支付)|(?<![未没尚还])已(?:经)?到账|订单(?:已(?:经)?|现已)?(?:正式)?生效/,
      when: (ctx) => !hasPaidOrder(ctx),
      ignore: (_c, m, clause) =>
        /(?:后|之后|才会?|才能|一旦|如果|要是|等到?|待|的话|确认|核实)/.test(clause.replace(m[0], '')) || HYPOTHETICAL.test(clause),
      replace: (ctx) => paymentPendingReply(ctx.mode),
    },
    // 「订单已确认」：顾问收款模式下带 confirmedAt 的订单那是真话，另外排除
    {
      id: 'order_confirmed',
      re: /订单已(?:经)?确认/,
      when: (ctx) => !hasPaidOrder(ctx) && !hasConfirmedOrder(ctx),
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause) || /(?:后|之后|才会?|才能|一旦|等到?|待)/.test(clause),
      replace: (ctx) => paymentPendingReply(ctx.mode),
    },
    // ---- 旧单失效（会话里有别的线路的待付款单时）----
    {
      id: 'old_order',
      re: /直接失效|不用管(?:它|这张|那张|这单|那单|这笔|那笔|旧单|旧链接)|不(?:付款|支付|付)(?:的话)?(?:就|则|会)?(?:自动)?(?:无效|失效)/,
      when: hasOtherPending,
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause),
      replace: () => OLD_ORDER_REPLY,
      said: /先别付款|先不要付款|请顾问帮您处理/,
      defers: true,
    },
    // ---- 低于全库最低价的许诺 ----
    {
      id: 'below_floor',
      moneyOk: true,
      re: new RegExp(
        `(?:帮您|给您|替您|为您)(?:再)?(?:找找?|看看?|问问?|争取|申请|谈|想想办法找)[^。！？!?\\n，,]{0,6}?(${AMOUNT})\\s*(?:元|块)?\\s*(?:以内|以下|之内|内|左右)?`,
        'g',
      ),
      when: (ctx) => !!cheapestOverall(ctx.routes),
      ignore: (ctx, m) => {
        const amount = parseSpokenAmount(m[1]);
        const floor = cheapestOverall(ctx.routes)?.priceFrom;
        // 没写单位的小数字（「帮您看看 3 个」）不是金额；够得着最低价的许诺不算
        return amount === undefined || floor === undefined || amount < 1000 || amount >= floor;
      },
      replace: (ctx) => {
        const r = cheapestOverall(ctx.routes);
        return r ? `我们这边最实惠的一条是《${r.title}》，人均 ${ctx.yuan(r.priceFrom)} 起。要不要请顾问帮您看看？` : undefined;
      },
    },
    // ---- D 安全与手续断言（正向词表）----
    {
      id: 'safety_claim',
      re: new RegExp(
        [
          '不(?:用|需要|必)办(?:理)?(?:任何|什么)?(?:特殊)?的?手续',
          '(?:无需|不需要)办理(?:任何|什么)?(?:特殊)?的?手续',
          '(?:只要|只需|只需要)?带(?:上|好)?(?:您的|你的)?(?:本人)?身份证(?:就|即)?(?:行|可以|可|够了|足够)',
          '(?:一直|始终|全年|常年|照常)(?:都)?正常(?:对外)?(?:开放|营业|接待)',
          '(?<![不未没])正常(?:开放|接待)(?:游客|客人|客户)?',
          '(?:一直|始终|照常|持续)(?:都)?在?发团(?:出行)?',
          '全年(?:都)?有客人(?:在走|出行)',
          '协助(?:您)?办(?:好|理|妥)',
          '(?<![不没])身体负担(?:很|比较|相对|会)?(?:小|轻)',
          '(?:几乎|基本)(?:无|没有)(?:明显)?(?:的)?高反',
        ].join('|'),
      ),
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause),
      replace: () => POLICY_REPLY,
      defers: true,
    },
    // ---- D 签证时长与费用 ----
    {
      id: 'visa_claim',
      moneyOk: true,
      re: /签证[^，。！？!?\n]{0,8}?[\d一二两三四五六七八九十]+\s*(?:周|个?工作日|天|个?星期|个月)|签证费(?:用)?(?:大概|大约|一般|通常|约|基本)/,
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause) || /免签|不用签证|无需签证|不需要签证|没有签证|落地签/.test(clause),
      replace: () => VISA_REPLY,
      defers: true,
    },
    // ---- 普通发票（专票已由现有护栏管）----
    {
      id: 'invoice',
      re: /(?<![不没无未])(?:可以|能够?|支持|没问题)(?:给您|为您|帮您)?开(?:具)?(?:普通|增值税)?(?:发票|普票)|(?:发票|普票)(?:这块|这个)?(?:当然)?(?:可以|能|没问题)(?:开|开具)?/,
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause),
      replace: () => INVOICE_REPLY,
      defers: true,
    },
    // ---- 单订酒店 ----
    {
      id: 'hotel_only',
      re: /(?<![不没无])(?:可以|能够?|支持)(?:单独|单)(?:订|预订|订房|预定|购买)(?:房|酒店)?/,
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause),
      replace: () => HOTEL_REPLY,
      said: /顾问[^，。！？!?\n]{0,6}确认房态|确认房态/,
    },
    // ---- 照片、视频、定位：方案书里有实拍 ----
    {
      id: 'media',
      re: /(?:方案书|方案|行程单)(?:里|中)?(?:都|也|会)?(?:有|附|带)[^。！？!?\n，,]{0,8}(?:实拍|照片|图片|视频)|(?:实拍|照片|图片|视频)[^。！？!?\n]{0,14}?(?:方案书|方案)(?:时|里|中)?[^。！？!?\n]{0,6}?(?:附|看全|看得全|看到|能看|可以看)/,
      ignore: (_c, m, clause) => HYPOTHETICAL.test(clause) || /[不没无未]/.test(m[0]),
      replace: () => MEDIA_REPLY,
      said: /发不了|发不出|没法发|无法发送|请顾问(?:把|发|给)|顾问(?:会)?(?:把|给)[^，。！？!?\n]{0,8}发(?:给)?您/,
    },
    // ---- 锁名额类催单（SCARCITY 没收）：只删 ----
    {
      id: 'lock_urge',
      re: /锁(?:定)?(?:住)?(?:您的?)?(?:档期|名额|位置|房源)|越早(?:定|订|下单|预订|预定|付款)[^，。！？!?\n]{0,2}越(?:好|主动|有保障|有优势|安心)|一票难求|(?:早点|尽早|趁早)(?:定|订|下单)(?:比较)?(?:好|稳|保险)/,
      ignore: (_c, m, _clause, sentence) => NEGATE_BEFORE.test(sentence.slice(0, m.index)),
    },
    // ---- 编价格理由（HOLIDAY_REASON 没收）：只删。「国庆是四川最旺的时段」不收 ----
    {
      id: 'price_reason',
      re: /节[后後](?:出行|出发|再去|去)?(?:的?价格?)?(?:都|就)?会?(?:更)?(?:低|便宜|实惠|划算|降|回落)(?:一些|一点|不少|很多)?|比(?:夏|冬|春|秋)(?:天|季)?(?:上浮|贵|高|涨)(?:了)?(?:不少|一些|很多|一点)?|(?:已含|已经含|已包含|包含了|含了)(?:旺季|节日|节假日)(?:因素|加价|涨幅|溢价)/,
      ignore: (_c, _m, clause) => HYPOTHETICAL.test(clause),
    },
  ];
}

// ---------------- 小句 ----------------

/** 句子里按逗号、分号、破折号切开的小句（位置相对句子，不含句末标点）；千分位的逗号不断 */
function clauseSpans(s: string): { at: number; end: number }[] {
  const body = s.replace(/[。！!？?～~\n」”’）)\s]+$/, '').length;
  const out: { at: number; end: number }[] = [];
  let at = 0;
  for (let i = 0; i <= body; i++) {
    const thousands = s[i] === ',' && /\d/.test(s[i - 1] ?? '') && /^\d{3}(?!\d)/.test(s.slice(i + 1));
    if (i === body || ('，,；;'.includes(s[i]) && !thousands) || s[i] === '—') {
      out.push({ at, end: i });
      while (s[i] === '—' && s[i + 1] === '—') i += 1;
      at = i + 1;
    }
  }
  return out;
}

const MONEY = /\d[\d,]{3,}|\d+(?:\.\d+)?\s*[万元块]|[一二两三四五六七八九十]+\s*[万千]|[¥￥]/;
/** 句子自己在引出支付 / 方案链接（链接由后面的步骤插进去，或就在下一行） */
const LINK_PROMISE = /点(?:此|击|这里|开)|完成支付|去支付|支付入口/;

const SEP_TAIL = /[，,；;、\s—]+$/;
const SEP_HEAD = /^[，,；;、\s—]+/;
const CONNECTIVE = /^(?:而且|并且|同时|另外|还有|此外|所以|因此|不过|但是|但|而|且|也|还|就|都|和|与|及|以及|那么|那|好的|嗯|对|是的|好)+$/;

/** 剩下的话还成不成一句：只有连接词、末尾悬着冒号、末小句是没有下文的从句都不算 */
function leftoverIsEmpty(before: string, after: string): boolean {
  const core = (before + after).replace(/[\s，,；;、。！？!?～~：:—·•\-*「」"'（）()]/g, '');
  if (!core || CONNECTIVE.test(core)) return true;
  return !after.trim() && /[：:]\s*$/.test(before);
}

interface Edit {
  /** 单元（句）在原文里的位置 */
  start: number;
  end: number;
  /** 改后的句子；省略表示整句删（replace 为换上的话） */
  next?: string;
  cut?: { replace?: string };
  dropped: string;
}

function tailOf(s: string): string {
  return /[。！!？?～~\n」”’）)\s]*$/.exec(s)?.[0] ?? '';
}

// ---------------- 主函数 ----------------

export function rewriteClaimWords(text: string, ctx: ClaimWordsContext, deps: ClaimWordsDeps): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  let cur = text;
  // 每轮至少少一处命中；换上去的话不命中任何规则（自测守），所以一定收得住
  for (let round = 0; round < 24; round++) {
    const pass = onePass(cur, ctx, deps);
    dropped.push(...pass.dropped);
    if (pass.text === cur) break;
    cur = pass.text;
    if (!pass.again) break;
  }
  return { text: cur, dropped };
}

function onePass(text: string, ctx: ClaimWordsContext, deps: ClaimWordsDeps): { text: string; dropped: string[]; again: boolean } {
  const rules = buildRules();
  const edits: Edit[] = [];
  const usedThisPass = new Set<string>();
  const units = sentenceUnits(text);
  // 「当面」换成渠道说法（先于小句规则；不动句子结构）
  let work = text;
  for (const u of units.toReversed()) {
    const s = text.slice(u.start, u.end);
    if (!s.trim() || isLinkSentence(s, deps)) continue;
    const swapped = swapFaceToFace(s, ctx.mode);
    if (swapped !== s) work = work.slice(0, u.start) + swapped + work.slice(u.end);
  }
  if (work !== text) return { text: work, dropped: [], again: true };

  for (const [k, u] of units.entries()) {
    const s = text.slice(u.start, u.end);
    if (!s.trim() || isLinkSentence(s, deps) || LINK_PROMISE.test(s)) continue;
    // 紧挨着链接行的那一句（「好的，已为您锁定名额，点此完成支付～」下一行就是 /pay/ 链接）也不动
    const next = units[k + 1];
    if (next && isLinkSentence(text.slice(next.start, next.end), deps)) continue;
    // 引出链接的那一句（「订单已确认好啦：」后面跟着支付链接）：链接要接在它后面，和链接句一起不动
    if (/[：:]\s*$/.test(s) && introducesLink(text, units.slice(k + 1), deps)) continue;
    const spans = clauseSpans(s);
    for (const rule of rules) {
      if (rule.when && !rule.when(ctx)) continue;
      const re = new RegExp(rule.re.source, rule.re.flags.replace('g', '') + 'g');
      let hit: { m: RegExpExecArray; i: number; j: number } | undefined;
      for (const m of s.matchAll(re)) {
        const mm = m as RegExpExecArray;
        const i = Math.max(
          0,
          spans.findIndex((c) => mm.index < c.end || c === spans.at(-1)),
        );
        const j = Math.max(
          i,
          spans.findIndex((c) => mm.index + mm[0].length <= c.end || c === spans.at(-1)),
        );
        const clause = s.slice(spans[i].at, spans[j].end);
        if (rule.ignore?.(ctx, mm, clause, s)) continue;
        // 带金额的小句归价格护栏：它要看见这个价才会拦（并记 guardHit），这里不替它删
        if (!rule.moneyOk && MONEY.test(clause)) continue;
        hit = { m: mm, i, j };
        break;
      }
      if (!hit) continue;
      // 前一小句是没有下文就悬着的从句（「如果您感兴趣，可以单独订房」「两位既然是头回上高原，……」）：连它一起删
      let first = hit.i;
      if (first > 0 && /既然|如果|要是|只要|假如|因为|由于|虽然|尽管/.test(s.slice(spans[first - 1].at, spans[first - 1].end))) first -= 1;
      const a = spans[first].at;
      const b = spans[hit.j].end;
      const before = s.slice(0, a).replace(SEP_TAIL, '');
      const tail = tailOf(s);
      const afterBody = s.slice(b, s.length - tail.length).replace(SEP_HEAD, '');
      const claimText = s.slice(a, b).trim();
      const rest = text.slice(0, u.start) + text.slice(u.end);
      let replacement = rule.replace?.(ctx, hit.m);
      // 换上去的话回复里已经有了，或同一句别处已经往顾问那儿引：只删不换
      if (
        replacement &&
        (usedThisPass.has(replacement) ||
          rest.includes(replacement) ||
          (rule.defers && ALREADY_DEFERS.test(before + afterBody)) ||
          (rule.said && rule.said.test(rest + before + afterBody)))
      )
        replacement = undefined;
      if (replacement) usedThisPass.add(replacement);
      if (leftoverIsEmpty(before, afterBody)) {
        edits.push({ start: u.start, end: u.end, cut: { replace: replacement }, dropped: s.trim() });
      } else {
        const newlines = tail.replace(/[^\n]/g, '');
        let body: string;
        let end: string;
        if (replacement) {
          body = (before ? before + (/[：:]$/.test(before) ? '' : '。') : '') + replacement + afterBody;
          end = afterBody ? tail : newlines;
        } else {
          body = before + (before && afterBody ? '，' : '') + afterBody;
          // 删的是最后一小句：句号补回；后面还有话就沿用原来的句末
          end = afterBody || /[。！!？?～~]/.test(tail) ? tail : '。' + newlines;
        }
        edits.push({ start: u.start, end: u.end, next: body + end, dropped: claimText });
      }
      break;
    }
  }
  if (!edits.length) return { text, dropped: [], again: false };
  const clauseEdits = edits.filter((e) => e.next !== undefined);
  if (clauseEdits.length) {
    let t = text;
    for (const e of clauseEdits.toReversed()) t = t.slice(0, e.start) + e.next + t.slice(e.end);
    return { text: t, dropped: clauseEdits.map((e) => e.dropped), again: true };
  }
  const res = deps.dropSentences(
    text,
    edits.map((e) => ({ at: e.start, end: e.end, replace: e.cut?.replace })),
  );
  return { text: res.text, dropped: res.dropped, again: false };
}

/** 冒号收尾的句子后面，到下一个空行为止（最多 10 句）有没有链接：订单信息块、方案书块 */
function introducesLink(text: string, following: { start: number; end: number }[], deps: ClaimWordsDeps): boolean {
  for (const n of following.slice(0, 10)) {
    const t = text.slice(n.start, n.end);
    if (!t.trim()) return false;
    if (isLinkSentence(t, deps)) return true;
  }
  return false;
}

function isLinkSentence(s: string, deps: ClaimWordsDeps): boolean {
  return /\/(?:pay|proposal)\//.test(s) || !!deps.hasHole?.(s);
}

const CHANNEL_PHRASE = /在微信上|在微信里|在这个页面里|在页面里/;
/**
 * 「当面」换成渠道说法：企微说「在微信上」，网页说「在这个页面里」，模板模式非网页不点名渠道（删掉）。
 * 句子里已经有渠道说法的只删「当面」，不重复；「不能当面…」这种否定不动
 */
function swapFaceToFace(s: string, mode: ContactMode): string {
  return s.replace(/当面(?=(?:跟|和|与|给)?(?:您|你)?(?:详细)?(?:聊|沟通|交流|谈|详谈|说|讲|确认))/g, (m, at: number) => {
    if (NEGATE_BEFORE.test(s.slice(Math.max(0, at - 6), at))) return m;
    if (CHANNEL_PHRASE.test(s)) return '';
    if (mode.channel === 'web') return '在这个页面里';
    return mode.templateMode ? '' : '在微信上';
  });
}

/** 仅供自测使用 */
export function claimWordsTest() {
  return {
    rules: buildRules(),
    POLICY_REPLY,
    VISA_REPLY,
    INVOICE_REPLY,
    HOTEL_REPLY,
    MEDIA_REPLY,
    OLD_ORDER_REPLY,
    swapFaceToFace,
    clauseSpans,
  };
}
