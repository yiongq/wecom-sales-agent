// R8 / R9：只读会话与已发布配置；跟进版本只删，不调用业务工具。
import {
  orderDisplay,
  expandedReply,
  willPlaceReplyBlock,
  getAnyOrder,
  partsOf,
  sentenceUnits,
  quoteState,
  type FollowupGuardContext,
  type GuardStep,
  type PackSources,
  type ReplyGuardContext,
  type Session,
  type LineOrder,
} from '../../core/pack-api.js';
import { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } from './quote-candidate.js';
import { mentionedParts, unresolvedParts, FIXED } from './turn.js';
import { draftParts, readState } from './state.js';
import { MAX_QTY, priceLine } from './catalog.js';
import { normalizePartNo } from './normalize.js';
import { live } from './live.js';
import { IndustrialPolicySchema, taxInvoiceText } from './policy.js';

export const INVENTORY_FALLBACK = '库存和交期以顾问确认为准';
export const SUBSTITUTE_FALLBACK = '能否替代请顾问确认';
export const PROMISE_FALLBACK = '价格按数量档位执行，额外优惠需要顾问确认。';
export const PAYMENT_FALLBACK = '收款账户以顾问提供的公司账户为准。';
export const NOTE_FALLBACK = '发货和备注要求请和顾问确认。';
export const NOT_SUBMITTED = '报价单还没有提交，需要的话请告诉我，我马上起草。';
export const ACCEPT_ASK = '这份报价还需要您明确确认：请回复「接受这份报价」，我再通知顾问安排付款和发货。';
export const QUOTE_WITHDRAWN = '这份报价单已撤回，顾问会跟您重新确认';
export const QUOTE_EXPIRED = '这份报价已过期，您这次确认没有生效。回复「重新报价」，我按原来的型号和数量重新算价。';
export const TRIM_FALLBACK = '询价明细较多，需要的话我出一份正式报价单。';
type TrimmedLine = { code?: string; qty: number; version?: number; unitPrice?: number; amount?: number };
export function trimNote(n: number, session?: Session, lines: readonly TrimmedLine[] = []): string {
  const quote = session && latestQuoteCandidate({ ...session, packState: {} }, Date.now());
  if (quote?.kind !== 'quote' || quote.state !== 'pending') return `另外 ${n} 行已算好，需要的话我出一份正式报价单`;
  // 只为实际被裁掉的行作证；同型号的不同数量、版本或金额不能借待审单冒充已入单。
  const remaining = [...quote.order.lines];
  const included =
    lines.length === n &&
    lines.every((line) => {
      const i = remaining.findIndex(
        (row) =>
          row.code === line.code &&
          row.qty === line.qty &&
          (line.version === undefined || row.version === line.version) &&
          (line.unitPrice === undefined || row.unitPriceFen === Math.round(line.unitPrice * 100)) &&
          (line.amount === undefined || row.amountFen === Math.round(line.amount * 100)),
      );
      if (i < 0) return false;
      remaining.splice(i, 1);
      return true;
    });
  return included ? `另外 ${n} 行已在待审的正式报价单里` : `另外 ${n} 行已算好`;
}
const nonAssertion =
  /[?？]|如果|假如|若是|的话|是否|有没有|能不能|可以吗|以.{0,8}确认为准|不能|不可|不保证|不承诺|不是|没有|无现货|不够|不足/;
const inventoryClaim = /现货|有货|库存(?:充足|有?\s*\d+)|今天.{0,3}发|明天.{0,3}发|\d+\s*天|保证交期|交期\s*(?:约|预计)?\s*\d+\s*天/;
const substituteClaim = /可以替代|可替代|通用|一样的|能互换/;
const internalRule =
  /代码与工具决定|本轮已发布政策|询价太长时只列前\d+行|(?:find_parts|quote_items|create_quote_sheet)\s*[（(]|【硬性要求】/;
const pricePromise = /全网最低|保证不涨价|还能再便宜/;
const discountClaim =
  /打\s*[一二三四五六七八九十两零〇点\d.]+\s*折|[一二三四五六七八九十两零〇点\d.]+\s*折优惠|(?:给您|给你|提供|享受|额外)折扣|让利|抹零|再优惠|再减|(?:便宜|优惠)\s*[一二三四五六七八九十百千万两\d.]+\s*元/;
const shippingClaim = /免运费|包邮|运费全免|运费我们出|不收运费/;
const giftClaim = /赠送|附赠|送您|送你|送一个|搭赠|返点|返利|返现/;
// 运费固定为 0 时这些说法都不对；政策有运费或门槛时说「另计」是对的，不拦。
const shippingDenial =
  /(?:未|不)(?:包)?含运费|运费另(?:计|议|付)(?:为?\s*0(?:\.0+)?\s*元?)?|运费另以[^，,。；;）)]*确认为准|运费(?:按政策另计)?以实际结算为准|运费按政策另计/;
// 款进公司账户：产品没有收款页，报价单上也没有账户，不能让客户理解成付给顾问或个人。
// 「转给、打到」也说转接和打电话，要有钱字才算；钱字后面跟这些词说的是别的事（付款问题转给顾问、凭证发给顾问）。
const payToAdvisor =
  /(?:[货尾余全]款|款项|[定订]金|[把将]款|(?<![价少])钱|转账|打款|(?<![交托])付|汇(?![报总集率]))(?:(?!事|问题|安排|方式|情况|确认|收|发|传|报|我|帮|后|前)[^，,。；;]){0,10}?(?:给|至|[到入](?!账|位|了)|[转打汇](?=顾问[^，,。；;]{0,3}(?:账[户号]|卡)))(?:(?!公司|对公|后|再|才|会)[^，,。；;]){0,6}?(?:顾问(?!(?:提供|指定|给|发|告知)[^，,。；;]{0,6}(?:公司|对公))|(?:个人|私人)的?(?:微信|支付宝))|收款(?:账[户号]|人|方)[是为][^，,。；;]{0,4}?顾问(?!(?:提供|指定|给|发|告知)[^，,。；;]{0,6}(?:公司|对公))|直接转给[^，,。；;]{0,4}顾问收款|报价单上的[^，,。；;]{0,4}账[户号]/;
const personalAccount = /私户|对私(?!人)|(?:个人|私人)的?(?:银行)?(?:[账帐][户号]|卡(?!片)|收款码)/;
// 账号只能由顾问给，模型报的都是编的；金额跟在账户后面不算账号。
const accountNumber =
  /(?:[账帐][户号]|卡号|银行卡|支付宝|(?:转账|[转打汇付存]款?)[到至入])[^，,。；;\d]{0,10}(?<![\d.¥￥])\d(?:[\s-]?\d){5,}(?![\d.,\s]*(?:万?元|块))|(?<![\d.¥￥])\d(?:[\s-]?\d){5,}(?![\d.,\s]*(?:万?元|块))[^，,。；;\d]{0,8}(?:收款|[账帐][户号]|卡号|银行卡)/;
// 条件句也是承诺，不放行；否定词要落在收款方前面且不隔着公司账户，或收款方后面明说不行（货款不用走对公直接打给顾问仍要拦）。
const paymentNonAssertion =
  /[?？]|[吗么呢][。！？?!，,；;]?\s*$|(?:不要|不用|不必|不需要?|不能|不可|不会|不得|不应|不该|不让|不走|不经|不收|不接受|不允许|不支持|不建议|不提供|不是|绝不|没有|无需|无须|无法|没法|(?<![分特个类区])别|勿|禁止|严禁|谨防|防止|避免|小心|警惕|拒绝|如有人|若有人|如遇)(?:(?!对公|公司)[^，,。；;])*(?:顾问|个人|私|\d)|(?:顾问|个人|私|\d)[^，,。；;]*(?:不行|不可以|不能|不是|不安全|不合规|不允许|不接受|不支持|不认|不算|不对|无效|无法|违规|有风险)/;
const promiseNonAssertion =
  /[吗么呢][。！？?!，,；;]?\s*$|[?？]|是否|有没有|能不能|可以吗|以.{0,8}确认为准|不能|不可|不保证|不承诺|不是|没有|无法|没法|没办法|做不了|不会|给不了|需要?顾问确认|请(?:顾问)?确认|不(?:再|予|提供|支持|享受)?(?:打(?:\s*[一二三四五六七八九十两零〇点\d.]+\s*)?折|包邮|免运费|赠送|附赠|送您|送你|送一个|搭赠|返点|返利|返现|让利|抹零|优惠|折扣)|无(?:额外)?(?:优惠|折扣|赠品|赠送|返点|返利|返现)/;

// 数字单位、材料 / 防护等级、螺纹是规格，不是待校验的型号。
const specToken =
  /^(?:\d+(?:\.\d+)?(?:MM|CM|M|MPA|KPA|PA|V|KV|W|KW|A|MA|HZ|KG|G|NM)|DC\d+(?:\.\d+)?V|AC\d+(?:\.\d+)?V|IP\d{2,3}|Q\d{3}|A[24]-\d+|[GR]\d+\/\d+)$/i;
const tokens = (text: string): string[] => text.match(/[A-Za-z0-9]+(?:[-_/×.*][A-Za-z0-9]+)*/g) ?? [];
// 系统没有备注动作，模型说记下了，顾问其实看不到。
const noteClaim =
  /已(?:经)?(?:同步|写入|加了?|添加|注明|记下|记录|登记)[^，,。；;\n]{0,8}备注|已(?:经)?备注|备注已(?:经)?(?:注明|写|加|同步)|已(?:在|把)[^，,。；;\n]{0,10}备注/;
const quoteSubmitted =
  /(?:报价单|单据)[^，,。；;\n]{0,8}已(?:经)?(?:提交|生成|起草|创建|建好|送审)|已(?:经)?(?:为您|帮您|给您)?(?:提交|生成|起草|创建)[^，,。；;\n]{0,10}(?:报价单|单据)|(?:报价单|单据)[^，,。；;\n]{0,6}(?:审核中|待审|待顾问审核)/;
// 只有 acceptance.ts 记下才算接受；模型说客户已确认，顾问却收不到通知。
const acceptClaim =
  /您已(?:经)?确认|已(?:经)?(?:收到|记下|记录)您?的?(?:确认|接受)|已(?:为您)?(?:确认|记下)(?:采购|下单|您)|已记录您接受|确认您接受|(?:订单|采购)已(?:经)?(?:进入|确认|受理|开始)|进入[^，,。；;\n]{0,4}流程|已按[^，,。；;\n]{0,14}(?:确认|安排|下单)/;
const wantsQuoteSheet = /(?:出|起草|生成|做|开|发|要)[^，,。；;\n]{0,6}报价单|正式报价/;
const declinesQuoteSheet = /暂不|先别|不用|不要|不需要|不出/;
const hasModel = (text: string, model: string): boolean => normalizePartNo(text).includes(normalizePartNo(model));
const bracketed = /（[^（）]*）|\([^()]*\)|「[^「」]*」|“[^“”]*”/g;

/** 按逗号、分号切小句，括号和引号里的不切：切开后只替换半边，会留下不成对的括号。 */
function clausesOf(unit: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < unit.length; i++) {
    const char = unit[i]!;
    if ('（(「“'.includes(char)) depth++;
    else if ('）)」”'.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && '，,；;'.includes(char)) {
      clauses.push(unit.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < unit.length) clauses.push(unit.slice(start));
  return clauses;
}

type Evidence = { partNo: string; stock?: string; leadDays?: number; substitutes?: string[]; delivery?: string };
function evidence(ctx: FollowupGuardContext, sources: PackSources): Evidence[] {
  // 摘要的版本不随缓存淘汰；只有 exact 试算行才可借历史版本恢复库存 / 交期依据。
  const state = readState(ctx.session);
  const parts = draftParts(ctx.session, sources);
  const entries: Evidence[] = parts.flatMap((part) => {
    const line = state.rfqDraft?.lines.find((line) => line.match === 'exact' && line.code === part.id);
    if (!line || !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) return [];
    let current = part;
    if (sources.erp?.active('part')) {
      const value = sources.erp.fresh('part', part.id);
      if (!value) return [{ partNo: part.partNo, substitutes: part.substitutes }];
      current = live(part, value);
    }
    const priced = priceLine(current, line.qty);
    if ('reject' in priced) return [];
    return [{ partNo: part.partNo, delivery: priced.attrs?.['交期'], leadDays: current.leadDays, substitutes: part.substitutes }];
  });
  for (const call of ctx.toolSources) {
    if (!call.result || !['find_parts', 'quote_items'].includes(call.name)) continue;
    try {
      const result = JSON.parse(call.result);
      for (const item of result.parts ?? result.lines ?? []) {
        if (typeof item.partNo === 'string') entries.push(item);
      }
    } catch {
      // 失败工具不是事实来源。
    }
  }
  // 本轮工具的同型号结果覆盖较早的摘要证据，不混用两次库存；试算行不带的交期天数沿用查询结果。
  const latest = new Map<string, Evidence>();
  for (const entry of entries) {
    const key = normalizePartNo(entry.partNo);
    const previous = latest.get(key);
    latest.set(key, { substitutes: previous?.substitutes, leadDays: previous?.leadDays, ...entry });
  }
  return [...latest.values()];
}

const acceptPending = (quote: ReturnType<typeof latestQuoteCandidate>): boolean =>
  quote?.kind === 'quote' && quote.state === 'approved' && quote.order.approval?.acceptedAt === undefined;
/** 客户确认的报价发送前失效：过期说明后请客户回「重新报价」（prefetch 按原型号和数量续算）；有新批准的单就发新单请客户确认；其余是撤回。 */
export function staleAcceptText(session: Session, state: ReturnType<typeof quoteState>): string {
  if (state === 'expired') return QUOTE_EXPIRED;
  const quote = latestQuoteCandidate({ ...session, packState: {} }, Date.now());
  return quote?.kind === 'quote' && acceptPending(quote)
    ? `报价单：/quote/${quote.order.id}\n合计${orderDisplay(quote.order).totalText}\n${ACCEPT_ASK}`
    : QUOTE_WITHDRAWN;
}
const unitsOf = (text: string): string[] => sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
/** 说了没发生的事：整句换成实话，多句只换一次，其余内容留着。 */
function correctClaim(text: string, claim: RegExp | ((unit: string) => boolean), truth: string): string {
  let replaced = false;
  return unitsOf(text)
    .map((unit) => {
      if (!(typeof claim === 'function' ? claim(unit) : claim.test(unit))) return unit;
      if (replaced) return '';
      replaced = true;
      return truth;
    })
    .join('')
    .trim();
}

// 09 R1：工具账本证明金额出处，试算标识证明身份；待审正式金额不能借账本放行。
const moneyText = /(?:[¥￥]\s*\d|\d+(?:\.\d+)?\s*元)/;
// 09 R6：新单待审只取代旧待审单；旧单已批准且有效时，不能说它已经作废或只能以新单为准。
const oldQuoteReplaced =
  /(?:原|旧|之前|此前|刚才|上一)[^。！？\n]*(?:作废|不再(?:使用|沿用|用|[^。！？\n]*生效)|不予理会|忽略|不用管)|以(?:这|本|新)[^。！？\n]{0,8}为准/;
const OLD_QUOTE_VALID = '原报价单仍有效，待新报价单审核通过后才会作废。';
const OLD_QUOTE_NEEDS_NEW = '原报价单仍有效，需要按新需求起草新的报价单，待新报价单审核通过后才会作废。';
const pendingQuoteClaim =
  /审核中|(?:还|仍|尚|正在)(?:在|处于)?(?:顾问)?审核|(?:待|等待|等|需要?|需)(?:顾问)?审核|(?:审核|审批)通过(?:之)?后/;
const pendingQuoteNonAssertion =
  /[?？]|(?:不再|不用|不必|无需|无须|不需要|不是|并非|没有|不在|不处于)[^，,。；;\n]{0,8}(?:审核|待审)|已(?:经)?(?:通过(?:了)?(?:顾问)?审核|(?:顾问)?审核通过)|(?:审核|审批)通过(?:之)?后已/;
const newQuoteSubject = /新(?:的)?(?:正式)?(?:报价单|单子|单)|另(?:外)?一[张份](?:报价单|单)/;
function quoteBehaviorText(ctx: FollowupGuardContext, sources: PackSources, followup: boolean): string {
  const now = Date.now();
  const quote = latestQuoteCandidate({ ...ctx.session, packState: {} }, now);
  let text = ctx.text;
  if (quote?.kind === 'quote' && quote.state === 'pending') {
    const unsafe = (unit: string) => moneyText.test(unit) && (!/试算/.test(unit) || /正式报价单[^。！？\n]*\d+(?:\.\d+)?\s*元/.test(unit));
    const units = sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
    if (!followup && text.trim() === FIXED.pending && ctx.turn) ctx.turn.flags.blocksSuppressed = true;
    if (units.some(unsafe)) {
      const kept = units.map((unit) => (unsafe(unit) ? '' : unit));
      if (!followup) {
        // 引子只管紧接的金额明细段；后面的库存、审核等独立说明不能替删空的明细撑住标题。
        // 按原始行核对，同行仍有正文、后续仍有试算行或占位符时保留，交给放块步骤继续处理。
        for (let i = 0; i < units.length; i++) {
          if (!/[：:]\s*$/.test(kept[i]!)) continue;
          let removed = false;
          let content = false;
          for (let j = i + 1; j < units.length;) {
            let original = '';
            let remaining = '';
            do {
              original += units[j]!;
              remaining += kept[j]!;
            } while (!units[j++]!.endsWith('\n') && j < units.length);
            if (!original.trim()) {
              if (removed || content) break;
              continue;
            }
            if (!moneyText.test(original) && !/\{\{(?:试算明细|档位价|应付金额)\}\}/.test(original)) break;
            removed ||= remaining !== original;
            content ||= !!remaining.trim();
          }
          if (removed && !content) kept[i] = '';
        }
      }
      text = kept.join('');
      // 18 第 0.9 步：局部删句保留正文和块，不写旗标；只有删空 / 仅剩标题、残句才整段兜底并抑制块。
      // 有效占位符留给 reply_blocks:place；照抄的块行也由该步骤清理，不在这里重复裁正文。
      const hasContent = unitsOf(text).some((unit) => {
        const body = unit.trim().replace(/^(?:[·•-]|\d+[.、)）])\s*/, '');
        return (
          /[\p{L}\p{N}]/u.test(body) &&
          !/[：:，,、]$/.test(body) &&
          !/^(?:试算(?:结果)?|报价明细|价格明细|合计如下|好的|好|另外|不过|以及)[。！!？?]*$/.test(body)
        );
      });
      if (!followup && !hasContent) {
        if (ctx.turn) ctx.turn.flags.blocksSuppressed = true;
        text = FIXED.pending;
      }
    }
    if (!followup) {
      // 「原单」按最近一张旧单核对；更早还有已批准单，也不能否认刚被取代的待审单已作废。
      const previous = ctx.session.orderIds
        .map((id) => getAnyOrder(id))
        .filter(
          (old): old is LineOrder => !!old && old.sessionId === ctx.session.id && 'v' in old && !!old.approval && old.id !== quote.order.id,
        )
        .toSorted((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))[0];
      if (previous && quoteState(previous, now) === 'approved') text = correctClaim(text, oldQuoteReplaced, OLD_QUOTE_VALID);
    }
  }
  if (!followup) {
    const accepting = 'acceptingOrderId' in ctx && typeof ctx.acceptingOrderId === 'string' ? getAnyOrder(ctx.acceptingOrderId) : undefined;
    const approved =
      accepting && accepting.sessionId === ctx.session.id && 'v' in accepting && quoteState(accepting, now) === 'approved'
        ? accepting
        : quote?.kind === 'quote' && quote.state === 'approved'
          ? quote.order
          : undefined;
    if (approved) {
      const otherPending = ctx.session.orderIds.some((id) => {
        const order = getAnyOrder(id);
        return (
          !!order && order.sessionId === ctx.session.id && 'v' in order && order.id !== approved.id && quoteState(order, now) === 'pending'
        );
      });
      // 新批准单确实取代了旧单时保留作废说明；更新的试算则仍指向下一次重出。
      const replacesOld = ctx.session.orderIds.some((id) => {
        const old = getAnyOrder(id);
        return !!old && old.sessionId === ctx.session.id && old.supersededBy === approved.id;
      });
      if (
        quote?.kind === 'quote' &&
        quote.state === 'approved' &&
        !otherPending &&
        (!replacesOld || latestQuoteCandidate(ctx.session, now)?.kind === 'draft')
      )
        text = correctClaim(
          text,
          (unit) =>
            clausesOf(unit).some(
              (clause) =>
                oldQuoteReplaced.test(clause) &&
                !/仍有效|未作废|没有作废|不会作废|不(?:会|能|可|要|用|必|需要)作废|无需作废|审核通过后|如果|假如|是否|[?？]/.test(clause),
            ),
          OLD_QUOTE_NEEDS_NEW,
        );
      // 接受旧批准单时可能另有新单待审：只纠正当前这份报价的错话，不把新单说成已批准。
      text = correctClaim(
        text,
        (unit) =>
          !(otherPending && newQuoteSubject.test(unit)) &&
          !/(?:待|等)新的?(?:报价单|单)审核通过后/.test(unit) &&
          !/(?:发票|合同|资质|图纸|资料|退款|账期|样品)[^，,。；;\n]{0,8}(?:审核|审批)/.test(unit) &&
          clausesOf(unit).some((clause) => pendingQuoteClaim.test(clause) && !pendingQuoteNonAssertion.test(clause)),
        `${FIXED.accepted.replace(/^好的，/, '这份报价已批准，')}。`,
      );
    }
  }
  if (followup && !quote)
    text = unitsOf(text)
      .filter((unit) => !quoteSubmitted.test(unit))
      .join('');
  if (followup && acceptPending(quote))
    text = unitsOf(text)
      .filter((unit) => !acceptClaim.test(unit))
      .join('');
  if (quote?.kind === 'quote' && quote.state === 'expired') {
    if (followup) {
      text = sentenceUnits(text)
        .map(({ start, end }) => text.slice(start, end))
        .filter((unit) => !/(?:报价单|新报价).*(?:已|审核)|(?:已|正在).*(?:起草|提交|审核)|确认下单|付款和发货/.test(unit))
        .join('');
    } else if (expiredQuoteAwaitingConfirmation(ctx.session, Date.now())) {
      const call = ctx.toolSources.findLast((call) => call.name === 'quote_items' && call.result);
      if (call?.result) {
        const result = JSON.parse(call.result) as { total?: number; unmatched?: number };
        if (result.unmatched === 0 && result.total !== undefined) {
          if (ctx.turn) ctx.turn.flags.blocksSuppressed = true;
          text = `原报价单已过期，已按当前价重新试算，合计${result.total}元。请确认本次试算，确认后再起草新的报价单。`;
        }
      }
    }
  }
  const draft = readState(ctx.session).rfqDraft;
  const below = draftParts(ctx.session, sources).filter((part) =>
    draft?.lines.some((line) => line.match === 'exact' && line.code === part.id && line.qty < part.moq),
  );
  if (below.length) {
    const units = sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
    text = units
      .filter(
        (unit) => !(moneyText.test(unit) && (below.some((part) => hasModel(unit, part.partNo)) || below.length === draft?.lines.length)),
      )
      .join('');
  }
  const input = 'inputText' in ctx ? String(ctx.inputText) : (ctx.session.messages.findLast((m) => m.role === 'customer')?.content ?? '');
  if ('acceptingOrderId' in ctx && ctx.acceptingOrderId) return text;
  // 客户消息在 preflight 先入会话，预取 / 模型工具随后才执行；同毫秒也不借本轮工具反推客户选择。
  const before = followup ? Infinity : ctx.session.messages.findLast((message) => message.role === 'customer')?.at;
  const selected = new Set<string>();
  if (before !== undefined) {
    if (draft && draft.at < before) for (const line of draft.lines) if (line.match === 'exact') selected.add(line.code);
    for (const id of ctx.session.orderIds) {
      const order = getAnyOrder(id);
      if (!order || !('v' in order) || order.sessionId !== ctx.session.id || !order.approval) continue;
      if (order.createdAt >= before || order.approval.requestedAt >= before) continue;
      for (const line of order.lines) selected.add(line.code);
    }
  }
  const ambiguous = unresolvedParts(input, sources).filter((mention) => !mention.parts.some((part) => selected.has(part.id)));
  // 非字面（语义）候选也由工具结果决定，不把候选缓存当成已选型号。
  const candidates = ambiguous.flatMap((m) => m.parts.map((part) => part.partNo));
  for (const call of ctx.toolSources) {
    if (call.name !== 'find_parts' || !call.result) continue;
    const result = JSON.parse(call.result) as { match?: string; parts?: { partNo: string; code?: string }[] };
    if (
      result.match === 'ambiguous' &&
      !result.parts?.some((part) => part.code && selected.has(part.code)) &&
      !mentionedParts(input, sources).some((m) => m.match === 'exact' && result.parts?.some((part) => part.partNo === m.parts[0]?.partNo))
    )
      candidates.push(...(result.parts ?? []).map((part) => part.partNo));
  }
  const models = [...new Set(candidates)];
  if (models.length) {
    if (followup)
      text = sentenceUnits(text)
        .map(({ start, end }) => text.slice(start, end))
        .filter((unit) => !/已.*(?:选|确定)|(?:就|先|按).*报价|为您.*选/.test(unit) && !moneyText.test(unit))
        .join('');
    else if (
      !models.every((model) => hasModel(text, model)) ||
      !/哪种|哪个|哪一款|选择|确认.{0,6}型号|型号.{0,6}确认/.test(text) ||
      /已为您选|替您选/.test(text)
    ) {
      if (ctx.turn) ctx.turn.flags.blocksSuppressed = true;
      text =
        models.length === 1
          ? `查到的是 ${models[0]}，请确认是不是这个型号。`
          : `查到多个候选，请选择需要的型号：\n${models.map((model) => `· ${model}`).join('\n')}`;
    }
  }
  return text;
}

function guardedText(ctx: FollowupGuardContext, sources: PackSources, followup: boolean, rawPolicy: unknown): string {
  // 上下文格式供工具策略读取；只在回复出口整行删掉内部摘要和 JSON。
  ctx = {
    ...ctx,
    text: ctx.text
      .split('\n')
      .filter((line) => !/^\s*(?:询价摘要|过期报价行)[:：]/.test(line) && !/\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(line))
      .join('\n'),
  };
  ctx = { ...ctx, text: quoteBehaviorText(ctx, sources, followup) };
  const policy = IndustrialPolicySchema.parse(rawPolicy);
  const cache = readState(ctx.session).partsInPlay ?? [];
  const known = new Set(cache.map((part) => normalizePartNo(part.partNo)));
  const knownToken = (token: string): string => {
    const normalized = normalizePartNo(token);
    if (known.has(normalized)) return normalized;
    const base = normalizePartNo(token.replace(/[×*]\d+$/, ''));
    return known.has(base) ? base : normalized;
  };
  const specs = cache.flatMap((part) => part.specs).map(normalizePartNo);
  const input =
    'inputText' in ctx
      ? String(ctx.inputText)
      : ctx.session.messages
          .filter((m) => m.role === 'customer')
          .map((m) => m.content)
          .join('\n');
  const intakeQueries = readState(ctx.session).rfqIntake?.lines.map((line) => normalizePartNo(line.q)) ?? [];
  const inputNormalized = normalizePartNo(input);
  const facts = evidence(ctx, sources);
  const models = [...new Set([...cache.map((part) => part.partNo), ...facts.map((fact) => fact.partNo)])];
  const mentionedModels = (text: string): string[] => {
    const normalized = normalizePartNo(text);
    const named = models.filter((model) => {
      const key = normalizePartNo(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![A-Z0-9])${key}(?![A-Z0-9])`).test(normalized);
    });
    // 客户提过但缓存没有的型号，也不能借其他型号的事实背书。
    return [
      ...new Set(
        [
          ...named,
          ...tokens(text).filter((token) => token.length >= 4 && /[A-Za-z]/.test(token) && /\d/.test(token) && !specToken.test(token)),
        ].map(knownToken),
      ),
    ];
  };
  // 回复里没点名型号时，说法要对本段在谈的每个型号都成立；客户这轮问了查不到依据的型号就不算。
  const factModels = facts.map((fact) => normalizePartNo(fact.partNo));
  let implied = mentionedModels(input).every((model) => factModels.includes(model)) ? factModels : [];
  const validity = new RegExp(
    `有效期内?(?:为|是|至|[:：（(])?\\s*${policy.quoteValidDays}\\s*天内?[）)]?|${policy.quoteValidDays}\\s*天内?有效`,
    'g',
  );
  const flatFree = policy.shipping.feeFen === 0 && policy.shipping.freeOverFen === 0;
  // 主回复就地改回政策事实，同一括号里的金额不受牵连；跟进只删。
  const body = flatFree && !followup ? ctx.text.replace(new RegExp(shippingDenial, 'g'), '运费0元') : ctx.text;
  const disclaimed = /以顾问(?:最终)?确认为准/.test(body);
  // 商家发布的付款条款里写明的账号是事实，不算模型编的。
  const publishedDigits = policy.paymentTerms.replace(/\D/g, '');
  const inventedAccount = (sentence: string): boolean => {
    const number = accountNumber.exec(sentence)?.[0].replace(/\D/g, '');
    return !!number && !publishedDigits.includes(number);
  };
  // 承诺和库存回退在整条回复只出现一次；其他既有回退仍按原句去重。
  const onceReplacements = new Set<string>();
  // 型号标题常独占一行；延续最近显式主语，新型号（包括未知型号）必须覆盖它。
  let subject: string[] = [];
  const judged = (sentence: string): string => {
    const explicit = mentionedModels(sentence);
    if (explicit.length) subject = explicit;
    const withoutLinks = partsOf(sentence)
      .reduce((text, link) => text.replaceAll(link.url, ''), sentence)
      .replace(/https?:\/\/[^\s，。！？]+/gi, '');
    const unknown = tokens(withoutLinks).some((token) => {
      const normalized = knownToken(token);
      return (
        token.length >= 4 &&
        /[A-Za-z]/.test(token) &&
        /\d/.test(token) &&
        !specToken.test(token) &&
        !known.has(normalized) &&
        !inputNormalized.includes(normalized) &&
        !intakeQueries.some((q) => q.includes(normalized)) &&
        !specs.some((spec) => spec.includes(normalized)) &&
        !/^https?:/i.test(sentence.trim())
      );
    });
    if (unknown) return '';
    if (followup && flatFree && shippingDenial.test(sentence)) return '';
    let text = sentence;
    const assertions = !nonAssertion.test(sentence);
    // 数量档位本身不是额外优惠；同句出现额外承诺仍须拦截。
    const freeShipping =
      /满(?:额|\s*[\d.]+\s*元)|达到包邮门槛/.test(sentence) &&
      !/未满|不满|无需满|不限|无门槛/.test(sentence) &&
      policy.shipping.freeOverFen > 0;
    const threshold = /满\s*(\d+(?:\.\d+)?)\s*元/.exec(sentence);
    const shippingSupported = freeShipping && (!threshold || Math.round(Number(threshold[1]) * 100) === policy.shipping.freeOverFen);
    // 条件句也是承诺（量大的话可以打九折），不沿用 nonAssertion 对「如果 / 的话」的放行。
    if (
      !promiseNonAssertion.test(sentence) &&
      (discountClaim.test(sentence) || giftClaim.test(sentence) || (shippingClaim.test(sentence) && !shippingSupported))
    )
      text = followup ? '' : PROMISE_FALLBACK;
    if (text === sentence && pricePromise.test(sentence)) return '';
    const inventory = sentence.replace(/报价(?:单)?有效期(?:为|是|[:：])?\s*\d+\s*天/g, '').replace(validity, '');
    if (text !== PROMISE_FALLBACK && assertions && inventoryClaim.test(inventory)) {
      const claimed = subject.length ? subject : implied;
      const supported =
        claimed.length > 0 &&
        claimed.every((model) => {
          const fact = facts.find((entry) => normalizePartNo(entry.partNo) === model);
          if (!fact) return false;
          // 单型号的剩余数量「约需 N 天到」仍是约期，后续继续核对部分现货与实际天数。
          const deliveryClaim =
            claimed.length === 1 ? inventory.replace(/((?:其余|剩余|余量)(?:\s*\d+\s*件)?\s*)约需(?=\s*\d+\s*天到)/g, '$1约') : inventory;
          if (/库存(?:有?\s*\d+)|保证交期|今天.{0,3}发|明天.{0,3}发|(?<!约\s*)\d+\s*天到/.test(deliveryClaim)) return false;
          const delivery = fact.delivery ?? '';
          const stock = fact.stock ?? (delivery === '现货' ? '现货' : delivery.startsWith('现货') ? '部分现货' : '无现货');
          if (/有货|库存充足|全(?:部|都)?现货/.test(inventory) && stock !== '现货') return false;
          const onHand = /现货\s*(\d+)/.exec(delivery)?.[1];
          const amount = /现货\s*(?:只有|仅有?|有|约)?\s*(\d+)/.exec(inventory)?.[1];
          const leading = /(\d+)\s*件\s*现货/.exec(inventory)?.[1];
          if (amount && amount !== onHand) return false;
          if (leading && onHand && leading !== onHand) return false;
          if (/部分现货|其余|剩余|余量/.test(inventory)) {
            if (stock !== '部分现货') return false;
          } else if (/现货/.test(inventory) && !amount && !(leading && onHand) && stock !== '现货') return false;
          const days = [...inventory.matchAll(/(?:交期\s*)?(\d+)\s*天(?:发)?/g)].map((match) => Number(match[1]));
          return days.every(
            (day) => day === fact.leadDays || new RegExp(`(?<![0-9])${day}天`).test((fact.delivery ?? '').replace(/\s/g, '')),
          );
        });
      if (!supported) text = followup || disclaimed ? '' : INVENTORY_FALLBACK + '。';
    }
    if (text && text !== PROMISE_FALLBACK && assertions && substituteClaim.test(sentence)) {
      const relation = substituteClaim.exec(sentence)!;
      const left = mentionedModels(sentence.slice(0, relation.index));
      const right = mentionedModels(sentence.slice(relation.index + relation[0].length));
      const pairs =
        left.length && right.length
          ? left.flatMap((from) => right.map((to) => [from, to]))
          : subject.flatMap((from, i) => subject.slice(i + 1).map((to) => [from, to]));
      const supported =
        pairs.length > 0 &&
        pairs.every(([from, to]) =>
          facts.find((fact) => normalizePartNo(fact.partNo) === from)?.substitutes?.some((other) => normalizePartNo(other) === to),
        );
      if (!supported) text = followup ? '' : SUBSTITUTE_FALLBACK + '。';
    }
    if (
      text &&
      text !== PROMISE_FALLBACK &&
      !/[?？]|如果|假如|的话|是否|能不能/.test(sentence) &&
      /含税|不含税|税率|专票|专用发票/.test(sentence)
    ) {
      const tax = /不含税/.test(sentence) ? false : /含税/.test(sentence) ? true : null;
      const offersInvoice = !/不能开|不开|不支持|无法开|不能提供/.test(sentence);
      const invoiceOk = !/专票|专用发票/.test(sentence) || offersInvoice === policy.invoice.some((kind) => /专用|专票/.test(kind));
      const rate = /税率\s*(\d+(?:\.\d+)?)%/.exec(sentence);
      if ((tax !== null && tax !== policy.taxIncluded) || !invoiceOk || (rate && Number(rate[1]) !== policy.taxRate))
        text = followup ? '' : taxInvoiceText(policy);
    }
    const payment = payToAdvisor.test(sentence) || personalAccount.test(sentence) || inventedAccount(sentence);
    if (text === sentence && payment && !paymentNonAssertion.test(sentence)) text = followup ? '' : PAYMENT_FALLBACK;
    if (text === sentence && !/[?？]/.test(sentence) && noteClaim.test(sentence)) text = followup ? '' : NOTE_FALLBACK;
    return text;
  };
  return sentenceUnits(body)
    .map(({ start, end }) => {
      const unit = body.slice(start, end);
      // 按完整句删内部指令，避免逗号分句后留下“不得自行计算”等指令残片。
      if (internalRule.test(unit)) {
        subject = [];
        implied = [];
        return '';
      }
      const replacements = new Set<string>();
      return clausesOf(unit.replace(/[（(](?:内部)?编号\s*[a-z0-9-]+[）)]/gi, ''))
        .flatMap((unit) => unit.split(/(?=但是|但(?!是)|不过|然而)/))
        .map((sentence) => {
          const text = judged(sentence);
          if (text === sentence) return text;
          // 只有括号里的说法不成立时，去掉括号，括号外的金额和正文留下。
          const bare = sentence.replace(bracketed, '');
          const kept = bare !== sentence && bare.replace(/[\s，,；;。：:]/g, '') && judged(bare) === bare ? bare : '';
          if (!text) return kept;
          const seen = text === PROMISE_FALLBACK || text === `${INVENTORY_FALLBACK}。` ? onceReplacements : replacements;
          if (seen.has(text)) return kept;
          seen.add(text);
          return kept + text;
        })
        .join('');
    })
    .join('')
    .trim();
}

/** 保留原始行 id，重建补句时统计最终完全删空的询价行；保护链接超限必须终止。 */
export function trimRfq(
  text: string,
  models: readonly string[],
  followup = false,
  expanded: (body: string) => string = (body) => body,
  showTrimNote: (body: string) => boolean = () => true,
  note: (n: number, removed: string[]) => string = (n) => trimNote(n),
): string {
  const original = text.replace(/\r\n?/g, '\n').split('\n');
  const inquiry = original.map((line) => models.some((model) => hasModel(line, model)));
  const lines = original.map((line) => line);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (inquiry[i] && ++seen > 10) lines[i] = '';
  const render = (): string => {
    const kept = lines
      .filter((line) => line.trim())
      .join('\n')
      .trim();
    const n = inquiry.filter((yes, i) => yes && !lines[i]?.trim()).length;
    return !followup && n && showTrimNote(kept)
      ? [
          kept,
          note(
            n,
            original.filter((_, i) => inquiry[i] && !lines[i]?.trim()),
          ),
        ]
          .filter(Boolean)
          .join('\n')
      : kept;
  };
  const fits = (body: string): boolean => {
    const value = expanded(body);
    return (
      (followup ? value.split('\n').length : value.split('\n').filter((line) => line.trim()).length) <= 12 &&
      [...value.replace(/\s/gu, '')].length <= 600
    );
  };
  while (!fits(render())) {
    let removed = false;
    for (let i = lines.length - 1; i >= 0 && !removed; i--) {
      const line = lines[i]!;
      for (const { start, end } of sentenceUnits(line).toReversed()) {
        const unit = line.slice(start, end);
        if (!unit.trim() || /https?:\/\//i.test(unit) || partsOf(unit).length || /\{\{/.test(unit)) continue;
        lines[i] = line.slice(0, start) + line.slice(end);
        removed = true;
        break;
      }
    }
    if (!removed) return followup ? '' : TRIM_FALLBACK;
  }
  return render();
}
const ACCEPT_RECORDED = '已记下您接受这份报价，顾问会联系您确认付款和发货。';
function asksToAccept(unit: string): boolean {
  return clausesOf(unit).some((clause) => {
    if (/无需|不用|不必|不需要|已(?:经)?确认|已(?:经)?接受/.test(clause)) return false;
    // 确认对象是其他业务信息时保留，包括「确认报价单的开票类型」。
    if (/确认[^，,。；;\n]{0,16}(?:开票|发票|抬头|税号|收货|地址|联系人|电话|付款|支付|转账|发货|交期|库存|型号|数量)/.test(clause))
      return false;
    // 「开票信息请确认」的对象在动词前；「请与顾问对接确认」也不是要求再接受报价。
    if (
      /开票|发票|抬头|税号|收货|地址|联系人|电话|付款|款项|收款|账[户号]|支付|转账|发货|交期|库存|型号|数量/.test(clause) &&
      !/确认(?:一下|下)?(?:这份|该)?(?:报价|订单|采购|下单)/.test(clause)
    )
      return false;
    return /(?:请|麻烦|需要您|还需您|待您|您可以|您再)(?:您|你)?(?:再|再次|重新|尽快|尽早|直接|及时|务必){0,2}(?:在[^，,。；;\n]{1,12})?(?:回复[「“"]?接受|(?:回复|完成)?确认(?:一下|下)?(?:(?:这份|这张|该)?报价(?:单)?|订单|采购|下单|无误)?(?=[，,。；;！!？?\s]|$))|确认下单请回复/.test(
      clause,
    );
  });
}
/** 模型说报价单提交了却没建单：客户这轮要了正式报价就补建，建出来照常人审；否则改回实话。
 *  接受状态只认落账或本轮接受目标；未接受不替客户决定，已接受不再催确认这份报价。 */
export function quoteClaimStep(): GuardStep<ReplyGuardContext> {
  return {
    id: 'quote_claim',
    writes: ['blocksSuppressed'],
    after: ['takeover_check:pre'],
    async run(ctx) {
      const quote = latestQuoteCandidate({ ...ctx.session, packState: {} }, Date.now());
      if (ctx.acceptingOrderId || (quote?.kind === 'quote' && quote.order.approval?.acceptedAt !== undefined)) {
        const text = correctClaim(
          ctx.text,
          (unit) => !(quote?.kind === 'quote' && quote.state === 'pending' && newQuoteSubject.test(unit)) && asksToAccept(unit),
          ACCEPT_RECORDED,
        );
        if (text !== ctx.text) {
          ctx.recordGuard('quote_claim', ctx.text, text, 'replace');
          return { action: 'replace', text };
        }
      }
      if (ctx.session.handedOver) return { action: 'pass' };
      if (acceptPending(quote) && quote?.kind === 'quote' && quote.order.id !== ctx.acceptingOrderId && acceptClaim.test(ctx.text)) {
        const text = correctClaim(ctx.text, acceptClaim, ACCEPT_ASK);
        ctx.recordGuard('quote_claim', ctx.text, text, 'replace');
        return { action: 'replace', text };
      }
      if (quote || !quoteSubmitted.test(ctx.text)) return { action: 'pass' };
      const lines = readState(ctx.session).rfqDraft?.lines ?? [];
      const repairable =
        !ctx.toolSources.some((call) => call.name === 'create_quote_sheet') &&
        lines.length > 0 &&
        wantsQuoteSheet.test(ctx.inputText) &&
        !declinesQuoteSheet.test(ctx.inputText);
      if (repairable && lines.every((line) => line.match === 'exact')) {
        const items = lines.flatMap((line) => (line.match === 'exact' ? [{ code: line.code, qty: line.qty }] : []));
        const result = JSON.parse(await ctx.callTool('create_quote_sheet', { items })) as {
          state?: string;
          quoteUrl?: string;
          totalText?: string;
        };
        if (result.state === 'pending') {
          ctx.recordGuard('quote_claim', ctx.text, ctx.text, 'patch');
          return { action: 'pass' };
        }
        if (result.state === 'approved') {
          ctx.turn.flags.blocksSuppressed = true;
          const text = `报价单：${result.quoteUrl}\n合计${result.totalText}`;
          ctx.recordGuard('quote_claim', ctx.text, text, 'replace');
          return { action: 'replace', text };
        }
      }
      const text = correctClaim(ctx.text, quoteSubmitted, NOT_SUBMITTED);
      ctx.recordGuard('quote_claim', ctx.text, text, 'replace');
      return { action: 'replace', text };
    },
  };
}
export function industrialReplyGuard(sources: PackSources): GuardStep<ReplyGuardContext> {
  return {
    id: 'industrial_claims',
    writes: ['blocksSuppressed'],
    after: ['stage_advance'],
    run(ctx) {
      const text = guardedText(ctx, sources, false, ctx.policy ?? sources.currentPolicy().policy);
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('industrial_claims', ctx.text, text, 'replace');
      return { action: 'replace', text };
    },
  };
}
export function industrialFollowupGuard(sources: PackSources): GuardStep<FollowupGuardContext> {
  return {
    id: 'industrial_claims',
    after: ['link_whitelist'],
    run(ctx) {
      const text = guardedText(ctx, sources, true, sources.currentPolicy().policy);
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('industrial_claims', ctx.text, text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
export function rfqTrimStep(sources: PackSources): GuardStep<ReplyGuardContext> {
  return {
    id: 'rfq_trim',
    writes: ['blocksSuppressed'],
    after: ['money_provenance'],
    run(ctx) {
      const parts = draftParts(ctx.session, sources);
      const text =
        trimRfq(
          ctx.text,
          parts.map((part) => part.partNo),
          false,
          (body) => expandedReply(ctx, body),
          (body) => !willPlaceReplyBlock(ctx, '试算明细', body),
          (n, removed) =>
            trimNote(
              n,
              ctx.session,
              removed.flatMap((text) => {
                const lines = (readState(ctx.session).rfqDraft?.lines ?? []).filter(
                  (line) => line.match === 'exact' && parts.some((part) => part.id === line.code && hasModel(text, part.partNo)),
                );
                return lines.length === 1 ? lines : [];
              }),
            ),
        ) || '请告诉我型号和数量。';
      if (text === TRIM_FALLBACK) ctx.turn.flags.blocksSuppressed = true;
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('rfq_trim', ctx.text, text, 'replace');
      return { action: 'replace', text };
    },
  };
}
export function rfqTrimFollowupStep(sources: PackSources): GuardStep<FollowupGuardContext> {
  return {
    id: 'rfq_trim',
    after: ['money_provenance'],
    run(ctx) {
      const text = trimRfq(
        ctx.text,
        draftParts(ctx.session, sources).map((part) => part.partNo),
        true,
      );
      if (text === ctx.text) return { action: 'pass' };
      ctx.recordGuard('rfq_trim', ctx.text, text, 'drop_sentence');
      return { action: 'drop_sentence', text };
    },
  };
}
