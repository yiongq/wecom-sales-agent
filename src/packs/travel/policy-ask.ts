// 07 R14：政策问法进上下文。客户这句在「问」退款、退订、改期、保险、费用含不含时，确定性地取出相关条款，
// 并进本轮 contextNote，让模型照原文说、句末写出处。不加模型工具（工具定义一改就动前缀）、不调嵌入、不改预取。
//
// 只认问法：问句、「能不能退」「怎么算」「含不含」「包不包」一类。提到这些词的陈述句不算（「我想退款」「我们改期了」），
// 「保险起见」「更保险」这类副词不算，「走路累不累」「住哪」这类细节问法不归这里（引擎照旧预取线路详情）。
// 签证已在 06 的 SENSITIVE_ASK，不在这里；clauses() 里的签证条款保持可用。
import type { Order, PolicyTopic } from '../../core/pack-api.js';
import { clauses, travelPolicySchema, type TravelPolicy } from './policy.js';

/** 问的信号：问号、语气词、A不A、疑问词、请客服告知。光有主题词不算，「我想退款」「我们改期了」是陈述 */
const ASK_CUE =
  /[？?]|[吗嘛]|([一-龥])不\1|有没有|是否|能否|可否|怎么|怎样|如何|咋|多少|几成|几折|(?<!没有?|无|不用|不需要|不要|不)(?:什么|啥)|有哪些|哪些|哪家|了解|请问|问下|问一下|想问|想知道|告诉我|说说|讲讲|介绍|[么呢]\s*(?:[！!。~～]|$)/u;

/**
 * 退款、退订、取消、改期同属退改，取条款时合并成一组。
 * 单字「退」只在后面不是「退房、退烧、退出」这类别的词时算；前面是「后、撤」的「后退、撤退」不算。
 */
const REFUND_WORD = /退款|退订|退钱|退费|退团|退改|退掉|退票|退定|取消|(?<![后撤倒告减])退(?![房休烧役出步群场伍学货一而税])/u;
const CHANGE_WORD = /改期|改(?:个|一下|下)?(?:日期|时间|出发)|换(?:个|一下|下)?(?:日期|时间)|延期|推迟出发|改签/u;
/** 整句就是「退改政策」「取消规则」这样的名词短语（客户常常只打关键词） */
const BARE_RULE = /^[\s，,]*(?:退改|退款|退订|取消|改期)(?:的)?(?:规则|政策|条款|规定|须知|说明)[\s。！!？?]*$/u;

// g 标志只给 replace 用；判断有没有用 search，不用带 lastIndex 的 test
const INSURANCE_WORD = /保险|意外险|医疗险|高原险|旅游险|旅行险|取消险|救援险/gu;
/** 不是在说保险产品：「保险起见」「保险点」「这样更保险」。先从句子里去掉，再认保险词 */
const INSURANCE_IDIOM = /保险起见|为了?保险|保险[一点些]|(?:比较|更加?|最|很|挺|蛮|太|不太|稳妥|这样|这么|那样|那么)保险/gu;
/** 保险特有的问法：没有疑问词也是在问保什么、怎么赔 */
const INSURANCE_CUE = /理赔|保额|赔付|保什么|保哪些|保障范围/u;

/** 费用里含不含：含/包的问法。裸「含不含」「包不包」也算，客户常常省掉宾语。「包车吗」「包场」不算 */
const INCLUDE_ASK =
  /含不含|包不包|(?:包含|包括|含)[^，。！？!?；;\n]{0,6}[吗么嘛]|包[吗么]|包(?:机票|早餐|午餐|晚餐|三餐|餐|门票|接送|接机|送机|酒水|小费|住宿|住|吃|保险|签证|税|导游|行李)[^，。！？!?；;\n]{0,4}[吗么嘛]|(?:包含|包括)(?:了|的)?(?:什么|哪些|啥|哪几)|(?:不含|不包含|不包括)(?:的)?(?:什么|哪些|啥|哪几)/u;
/** 另外要花的钱：要同时有问的信号才算（「有自费项目吗」算，「自费的话再说」不算） */
const EXTRA_COST = /另付|另外(?:收|付|交|花)|另收|额外(?:收费|费用|付|花钱|加钱|交)|加收|隐形(?:消费|费用)|自费/u;
/** 句子里还说了保险时，费用问法要有保险以外的宾语才另算一个主题，免得「含保险吗」同时取两句 */
const FEE_OBJECT =
  /机票|交通|飞机|航班|餐|吃|门票|景点|接送|接机|送机|酒水|小费|住宿|住|酒店|导游|税|签证|行李|自费|购物|儿童|小孩|孩子|全部|所有/u;

const SENTENCE_END = /(?<=[。！!？?；;\n])/;
const HEADER = '可引用的条款（照原文说，说到哪条就在句末写出处）：';

/** 这句话（一个句子）问的是不是退改 */
function asksRefund(s: string): boolean {
  return BARE_RULE.test(s) || ((REFUND_WORD.test(s) || CHANGE_WORD.test(s)) && ASK_CUE.test(s));
}

/** 这句话问的是不是保险（先去掉「保险起见」这类副词） */
function asksInsurance(s: string): boolean {
  const said = s.replace(INSURANCE_IDIOM, '');
  return said.search(INSURANCE_WORD) >= 0 && (ASK_CUE.test(said) || INSURANCE_CUE.test(said));
}

function asksFees(s: string, alsoInsurance: boolean): boolean {
  const said = alsoInsurance ? s.replace(INSURANCE_WORD, '') : s;
  return (INCLUDE_ASK.test(said) || (EXTRA_COST.test(said) && ASK_CUE.test(said))) && (!alsoInsurance || FEE_OBJECT.test(said));
}

/**
 * 客户这句问的主题，按 clauses() 的顺序：退款、退订、改期都给 refund + change（全部退改条款加改期条款），
 * 保险给 insurance，费用含不含给 fees。没有政策问法返回空数组。逐句判断：问的信号要和主题词在同一个句子里
 */
export function policyAsk(text: string): PolicyTopic[] {
  let refund = false;
  let insurance = false;
  let fees = false;
  for (const raw of text.split(SENTENCE_END)) {
    const s = raw.trim();
    if (!s) continue;
    refund ||= asksRefund(s);
    const ins = asksInsurance(s);
    insurance ||= ins;
    fees ||= asksFees(s, ins);
  }
  return [
    ...(refund ? (['refund', 'change'] as const) : []),
    ...(insurance ? (['insurance'] as const) : []),
    ...(fees ? (['fees'] as const) : []),
  ];
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 出发日 − 今天，整天数（R16：按服务器时区的日期算，today 是 todayIso()）。读不出日期返回 undefined */
export function daysToDeparture(departIso: string, todayIso: string): number | undefined {
  const a = ISO_DAY.exec(departIso);
  const b = ISO_DAY.exec(todayIso);
  if (!a || !b) return undefined;
  return Math.round((Date.UTC(+a[1], +a[2] - 1, +a[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) / 86_400_000);
}

/** 这个天数落在哪一档：返回档位 id；低于最低档返回 'below-min'；已出发（负数）或档位覆盖不到返回 undefined */
function tierIdFor(p: TravelPolicy, days: number): string | undefined {
  if (days < 0) return undefined;
  const tier = p.refund.tiers.find((t) => days >= t.minDays && (t.maxDays === null || days <= t.maxDays));
  if (tier) return tier.id;
  return days < Math.min(...p.refund.tiers.map((t) => t.minDays)) ? 'below-min' : undefined;
}

/**
 * 会话名下有订单时，按这张单的距出发天数标出适用的那一条。
 * 多张单取最近一张：orderIds 是下单顺序，从后往前找第一张没作废的（待付款或已付款；已作废 / 被替代的不算，
 * 退款中、已退款的订单已经在走退款，也不再标适用条款）。只给条款与天数，不给金额（金额只出现在 R18 的代码回复里）
 */
function applicableLine(
  p: TravelPolicy,
  orderIds: readonly string[],
  getOrder: (id: string) => Order | undefined,
  today: string,
): string | undefined {
  const order = orderIds
    .map((id) => getOrder(id))
    .findLast((o): o is Order => !!o && (o.status === 'pending_payment' || o.status === 'paid'));
  if (!order) return undefined;
  const days = daysToDeparture(order.departDate, today);
  if (days === undefined) return undefined;
  if (days < 0) return '您这张单的出发日已过，不适用上面的退改条款';
  const id = tierIdFor(p, days);
  const clause = id ? clauses(p).find((c) => c.topic === 'refund' && c.id === id) : undefined;
  if (!clause) return undefined;
  return `您这张单${days === 0 ? '今天出发' : `离出发${days}天`}，适用${clause.title}`;
}

export interface PolicyNoteInput {
  /** 本轮捕获的已发布 policy（核心以 unknown 持有）；没有就不加 */
  policy: unknown;
  /** 客户这一句 */
  text: string;
  orderIds: readonly string[];
  getOrder(id: string): Order | undefined;
  /** todayIso() */
  today: string;
}

/**
 * contextNote 里追加的几行：首行说明，每条「（出处）原句」，退改主题且有订单时在退改这一组后面加适用那一行。
 * 不是政策问法（或没有 policy）返回空数组，调用处追加在已有各行之后，contextNote 一个字节都不变
 */
export function policyNote({ policy, text, orderIds, getOrder, today }: PolicyNoteInput): string[] {
  const topics = policyAsk(text);
  if (!topics.length || policy == null) return [];
  const p = travelPolicySchema.parse(policy);
  const applicable = topics.includes('refund') ? applicableLine(p, orderIds, getOrder, today) : undefined;
  const lines = [HEADER];
  for (const c of clauses(p).filter((c) => topics.includes(c.topic))) {
    lines.push(`（${c.title}）${c.text}`);
    // 适用那一行紧跟在退改这一组（档位条款与改期条款）后面
    if (c.topic === 'change' && applicable) lines.push(applicable);
  }
  return lines;
}
