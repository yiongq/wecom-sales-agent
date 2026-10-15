// 06 R21：旅游包的一致性登记。三条规则、两张有期限的清单、四类文字里除对客固定文字以外的三类
// （工具提示、出口词表、渲染后的 SOP）。对客固定文字在 fixed-replies.ts。
// 通用的检查函数在 core/consistency.ts；这里只有旅游的词和判断。
import {
  cleanText,
  dejargon,
  hedgeConflicts,
  lineCapConflicts,
  passThroughConflicts,
  stripAdvisorPrefix,
  stripMarkdown,
  trimDangling,
  type ConsistencyConflict,
  type ConsistencyException,
  type ConsistencyRule,
  type ConsistencyText,
  type FixedReply,
  type PipelineOrder,
  type FixedReplyMode,
  type Order,
  type PackSources,
  type Route,
  type TextTransform,
} from '../../core/pack-api.js';
import type { TravelParts } from './runtime.js';
import { rewriteClaimWords } from './claim-words.js';
import { dejargonVocab } from './dejargon-vocab.js';
import { createTravelFixedReplies, fixtureSession, MODE_CTX, type ModeCtx } from './fixed-replies.js';
import { TRAVEL_SHAPE_LIMITS } from './shape-words.js';
import { HANDOFF_NOTE } from './tools/catalog.js';
import { QUOTE_HEDGE, QUOTE_DEFINITE, QUOTE_TEMPLATE_ID } from './consistency-sop.js';

export * from './consistency-sop.js';

// ---------------- 规则 ----------------

export const travelConsistencyRules: readonly ConsistencyRule[] = Object.freeze([
  {
    id: 'quote-final',
    a: '确定价的说法（总价、每人价，代码模板里的报价句）',
    b: '「按最终行程…微调」「可能微调」',
    scope: ['fixed', 'tool-note', 'sop'],
    why: '报价是工具算出来的确定价，同一份文字里又说“按最终行程微调”，客户读到的是价格不作数；两种说法不能同时出现在同一模板里，也不能同时出现在 SOP 的报价指引里。',
  },
  {
    id: 'sop-vs-wordlist',
    a: 'SOP_CONTRACT 的 include 短语，以及 SOP 要求模型说的固定句（如“名额以付款为准”）',
    b: '出口词表（dropUnbackedClaims 的各表、claim_words）',
    scope: ['sop', 'wordlist'],
    why: 'SOP 要求说的话穿过出口词表后必须原样留着；变了就是护栏在删 SOP 要求说的话，模型照做也白做。',
  },
  {
    id: 'fixed-vs-guards',
    a: '全部对客固定文字（三种渲染）',
    b: '纯文字护栏（只看文字、不依赖本轮工具结果的出口变换）以及固定文字所在那一类的行数上限',
    scope: ['fixed'],
    why: '代码自己发的固定文字不该被出口护栏改写，也不该长到超出它那一类的行数上限；否则客户读到的与代码里登记的不是同一份。',
  },
  {
    id: 'template-no-channel',
    a: '全部对客固定文字在模板模式（非网页）下的渲染',
    b: '渠道名「微信」「企微」「企业微信」',
    scope: ['fixed'],
    why: '模板模式是品牌白标，对客文字不点名渠道（06 原则）；联系方式只说「顾问会联系您」，旧版企微与网页的说法不受影响。',
  },
]);

/** 模板模式（非网页）的对客文字里不许出现的渠道名 */
export const TEMPLATE_CHANNEL_NAMES = /企业微信|企微|微信/;

/** sop-vs-wordlist 的待裁决清单，性质同上；现在为空（唯一的一项已改成下面的禁说示例清单） */
export const SOP_VS_WORDLIST_PENDING: readonly ConsistencyException[] = Object.freeze([]);

/**
 * SOP_CONTRACT 的 include 短语里，本身是「禁说示例」的那几条：SOP 点名不让模型说这句话（“也不说「还能升房型 / 加天数」”），
 * 词表删它正是对的，所以不拿它们查“SOP 要求说的话穿过词表不变”。
 * 自测断言：每条在渲染后的 SOP 里确实出现在禁说的上下文里（同一行、这句话前面有“不说 / 不要 / 别”之类），
 * 清单不能是空的，也不能把所有 include 短语都放行。
 */
export const SOP_FORBIDDEN_EXAMPLES: readonly { contractId: string; why: string }[] = Object.freeze([
  { contractId: 'no-upgrade-promise', why: '“也不说「还能升房型 / 加天数」”：SOP 把它当禁说的例子点名' },
]);

/** 这句话在 SOP 的某一行里，前面是否有禁说的词 */
const FORBIDDEN_CUE = /不说|不要说?|别说|别|不许|不能说?|不得|严禁|禁止|一句都不/;
export function appearsAsForbidden(sop: string, phrase: string): boolean {
  return sop.split(String.fromCharCode(10)).some((line) => {
    const at = line.indexOf(phrase);
    return at >= 0 && FORBIDDEN_CUE.test(line.slice(Math.max(0, at - 24), at));
  });
}

// ---------------- SOP 要求说的固定句 ----------------

/**
 * SOP 里要求模型照说的固定句（不含 SOP_CONTRACT 的短语，那些由 contractRules 给）。
 * 每一条都必须真的出现在渲染后的 SOP 里（自测核），所以这张表不会悄悄烂掉。
 */
export const SOP_REQUIRED_SENTENCES: readonly { id: string; text: string }[] = Object.freeze([
  { id: 'push-by-payment', text: '名额以付款为准' },
  { id: 'ask-depart-day', text: '您计划几号出发？我按日期给您出准确报价' },
  { id: 'detail-to-advisor', text: '行程里没写，我让顾问确认' },
  { id: 'cheapest-already', text: '这已经是我们这边最实惠的一条了' },
  { id: 'superseded-order', text: '之前那张单已作废、旧链接失效，按这张新的付款' },
  { id: 'kids-headcount', text: '这单按 2 位出行下的' },
  { id: 'holiday-which-day', text: '国庆具体哪天走？' },
  { id: 'ack-expensive', text: '确实不便宜' },
  { id: 'family-decision', text: '我先把这条线的详细行程发您，您跟家人对一下日期' },
]);

// ---------------- 登记 ----------------

export type FixedText = ConsistencyText & { kind: 'rich' | 'plain'; afterHandoff: boolean; generatedList: boolean };

/** 把登记的固定文字摊开成待查的文字：每条每种渲染一段 */
export async function flattenFixed(fixed: readonly FixedReply[]): Promise<FixedText[]> {
  const out: FixedText[] = [];
  for (const f of fixed) {
    for (const s of await f.samples()) {
      out.push({
        id: `fixed:${f.id}[${s.mode}]`,
        where: `fixed:${f.id}`,
        text: s.text,
        mode: s.mode,
        origin: f.producedBy,
        kind: f.kind,
        afterHandoff: !!f.afterHandoff,
        generatedList: !!f.generatedList,
      });
    }
  }
  return out;
}

const walkStrings = (value: unknown, path: string, out: { path: string; text: string }[]): void => {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, out);
};

/** templates.ts（模板模式的代码模板）里的全部字符串，位置键统一是 templates.ts */
export function templateTexts(templates: unknown): ConsistencyText[] {
  const found: { path: string; text: string }[] = [];
  walkStrings(templates, '', found);
  return found.map((f) => ({ id: `templates.ts:${f.path}`, where: 'templates.ts', text: f.text }));
}

/** quote-final：确定价与「微调」不共存。texts 是已摊开的各类文字（固定文字、工具提示、SOP 段、代码模板、源码字面量） */
export function quoteFinalConflicts(texts: readonly ConsistencyText[]): ConsistencyConflict[] {
  return hedgeConflicts({ rule: 'quote-final', texts, hedge: QUOTE_HEDGE, definite: QUOTE_DEFINITE, counterpart: QUOTE_TEMPLATE_ID });
}

/** fixed-vs-guards：纯文字护栏不改它，也不超行数上限 */
export async function fixedVsGuardsConflicts(
  fixed: readonly FixedText[],
  guards: readonly TextTransform[],
  order: PipelineOrder,
): Promise<ConsistencyConflict[]> {
  return [
    ...(await passThroughConflicts({ rule: 'fixed-vs-guards', items: fixed, transforms: guards, order })),
    ...lineCapConflicts({
      rule: 'fixed-vs-guards',
      items: fixed,
      caps: {
        rich: TRAVEL_SHAPE_LIMITS.richMaxLines,
        plain: TRAVEL_SHAPE_LIMITS.plainMaxLines,
        list: TRAVEL_SHAPE_LIMITS.generatedListMaxLines,
      },
    }),
  ];
}

/** template-no-channel：模板模式的固定文字不点名渠道，失败时点名文字 id 与命中的词 */
export function templateNoChannelConflicts(fixed: readonly FixedText[]): ConsistencyConflict[] {
  const out: ConsistencyConflict[] = [];
  for (const f of fixed) {
    if (f.mode !== 'template') continue;
    const hit = TEMPLATE_CHANNEL_NAMES.exec(f.text);
    if (!hit) continue;
    out.push({
      rule: 'template-no-channel',
      a: f.id,
      b: `渠道名「${hit[0]}」`,
      detail: `模板模式的对客文字点名了渠道：…${f.text.slice(Math.max(0, hit.index - 8), hit.index + hit[0].length + 8).replace(/\n/g, ' ')}…`,
      where: f.where,
      match: hit[0],
    });
  }
  return out;
}

/** sop-vs-wordlist：SOP 要求说的固定句穿过出口词表后不变 */
export function sopVsWordlistConflicts(
  items: readonly ConsistencyText[],
  wordlists: readonly TextTransform[],
): Promise<ConsistencyConflict[]> {
  return passThroughConflicts({ rule: 'sop-vs-wordlist', items, transforms: wordlists });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function safeRoutes(parts: TravelParts): Route[] {
  try {
    return parts.catalog.loadRoutes();
  } catch {
    return [];
  }
}

export function createTravelConsistency(world: (over: Partial<PackSources>) => TravelParts) {
  const fixedReplies = createTravelFixedReplies(world);
  return {
    fixedReplies,
    rules: travelConsistencyRules,

    /** 纯文字护栏：主回复和跟进两条管线里只看文字、不依赖本轮工具结果的出口变换 */
    textGuards(): TextTransform[] {
      const { helpers } = world({});
      return [
        { id: 'guard:markdown', steps: { reply: 'markdown', followup: 'markdown' }, run: stripMarkdown },
        { id: 'guard:dangling', steps: { reply: 'dangling', followup: 'stranded' }, run: trimDangling },
        { id: 'guard:advisor_prefix', steps: { reply: 'advisor_prefix', followup: 'final_clean' }, run: stripAdvisorPrefix },
        { id: 'guard:dejargon', steps: { reply: 'dejargon', followup: 'dejargon' }, run: (t) => dejargon(t, 'consistency', dejargonVocab) },
        { id: 'guard:final_clean', steps: { reply: 'final_clean', followup: 'final_clean' }, run: (t) => cleanText(t) },
        { id: 'guard:adults', steps: { reply: 'adults' }, run: helpers.unassumeAdults },
        // 只在转人工之后生效
        {
          id: 'guard:post_handoff',
          steps: { reply: 'post_handoff' },
          run: helpers.dropPostHandoffPromises,
          applies: (i) => i.afterHandoff,
        },
      ];
    },

    /**
     * 两套出口词表：dropUnbackedClaims（价格规则、预算、稀缺、服务承诺、电话；本轮工具调用按空算）与 claim_words（越权说法）。
     * 联系方式的说法按文字的渲染模式走，没有模式的（SOP 句）按旧版。
     */
    wordlists(): TextTransform[] {
      const parts = world({});
      const modeOf = (item: { mode?: FixedReplyMode }): ModeCtx => MODE_CTX.find((m) => m.mode === item.mode) ?? MODE_CTX[0]!;
      return [
        {
          id: 'wordlist:dropUnbackedClaims',
          steps: { reply: 'unbacked_claims', followup: 'unbacked_claims' },
          run: (t, item) =>
            parts.priceRules.dropUnbackedClaims(t, fixtureSession(modeOf(item)), [], { templateMode: modeOf(item).contact.templateMode })
              .text,
        },
        {
          id: 'wordlist:claim_words',
          steps: { reply: 'claim_words' },
          run: (t, item) =>
            rewriteClaimWords(
              t,
              { mode: modeOf(item).contact, orders: [], routes: safeRoutes(parts), yuan: parts.helpers.yuan },
              { dropSentences: parts.priceGuard.dropSentences, hasHole: (s) => new RegExp(parts.helpers.ANY_HOLE.source).test(s) },
            ).text,
        },
      ];
    },

    /** 工具结果里的提示模板，由真实工具代码现渲染 */
    async toolNotes(): Promise<ConsistencyText[]> {
      const parts = world({});
      const { catalog } = parts;
      const routes = catalog.loadRoutes();
      const lowland = (r: Route): boolean => typeof r.maxAltitude !== 'number' || r.maxAltitude < 2500;
      const high = routes.filter((r) => !lowland(r));
      const silver = high.find((r) => r.segments?.includes('银发'));
      const notSilver = high.find((r) => !r.segments?.includes('银发'));
      const tough = routes.find((r) => r.intensity && r.intensity.level !== '轻松');
      const peakRoute = routes.find((r) => r.bestSeason);
      if (!peakRoute || !silver || !notSilver || !tough) {
        throw new Error('产品库里挑不出工具提示的样本线路（上浮、银发高海拔、非银发高海拔、强度）');
      }
      const year = new Date().getFullYear() + 1;
      const peakMonth = String(Number(/(\d{1,2})/.exec(peakRoute.bestSeason)?.[1] ?? 10)).padStart(2, '0');
      const notes: { id: string; text: string | undefined }[] = [
        { id: 'quote.peak', text: catalog.quoteFor(peakRoute, { travelers: 2, departDate: `${year}-${peakMonth}-15` }).note },
        {
          id: 'quote.off-season',
          text: catalog.quoteFor({ ...peakRoute, bestSeason: '6月' }, { travelers: 2, departDate: `${year}-01-15` }).note,
        },
        { id: 'quote.group', text: catalog.quoteFor(peakRoute, { travelers: 4 }).note },
        { id: 'quote.standard', text: catalog.quoteFor(peakRoute, { travelers: 2 }).note },
        { id: 'altitude.elder-silver', text: str(catalog.routeDetail(silver, { elder: true }).altitudeNote) },
        { id: 'altitude.elder', text: str(catalog.routeDetail(notSilver, { elder: true }).altitudeNote) },
        { id: 'altitude.worry', text: str(catalog.routeDetail(notSilver, { altitudeWorry: true }).altitudeNote) },
        { id: 'intensity', text: str(catalog.routeDetail(tough, { elder: true }).intensityNote) },
        { id: 'detail', text: str(catalog.routeDetail(routes[0]!, {}).detailNote) },
        { id: 'pay.wecom', text: catalog.advisorPayNote(fixtureSession(MODE_CTX[0]!)) },
        { id: 'pay.web', text: catalog.advisorPayNote(fixtureSession(MODE_CTX[1]!)) },
        { id: 'date.past', text: catalog.pastDateError('2000-01-01') ?? undefined },
        { id: 'date.far', text: catalog.pastDateError('2999-01-01') ?? undefined },
        { id: 'handoff', text: HANDOFF_NOTE },
      ];
      // create_order 的两条提示（复用、作废旧单）：换一份假订单存储，真走一遍工具
      const created = new Map<string, Order>();
      let seq = 0;
      const orderWorld = world({
        getOrder: (id) => created.get(id),
        createOrder: (o) => {
          const order = { ...o, id: `ord_note${++seq}`, status: 'pending_payment', createdAt: 0 } as Order;
          created.set(order.id, order);
          return order;
        },
        supersedeOrder: (id, by) => {
          const old = created.get(id);
          if (old?.status !== 'pending_payment') return false;
          old.status = 'superseded';
          old.supersededBy = by;
          return true;
        },
        saveSession: () => undefined,
        queueJobs: () => undefined,
        paymentMode: () => 'online',
      });
      const createOrderTool = orderWorld.catalog.tools.find((t) => t.def.function.name === 'create_order')!;
      const orderSession = fixtureSession(MODE_CTX[0]!);
      const placeOrder = async (travelers: number): Promise<Record<string, unknown>> =>
        JSON.parse(
          await createOrderTool.execute({ routeId: peakRoute.id, travelers, departDate: `${year}-${peakMonth}-15` }, {
            session: orderSession,
            hints: {},
          } as never),
        ) as Record<string, unknown>;
      await placeOrder(2);
      const reused = await placeOrder(2);
      const superseded = await placeOrder(3);
      // search_routes 的两条提示：库外目的地、问境外全貌
      const miss = (await catalog.searchRoutes({ destination: '南极' }, {})) as Record<string, unknown>[];
      const abroad = (await catalog.searchRoutes({ query: '境外都有哪些线路' }, {})) as Record<string, unknown>[];
      notes.push(
        { id: 'order.reused', text: str(reused.note) },
        { id: 'order.superseded', text: str(superseded.supersededNote) },
        { id: 'search.destination-miss', text: str(miss.find((r) => r.destinationMiss)?.destinationMiss) },
        { id: 'search.abroad', text: str(abroad.find((r) => r.abroadNote)?.abroadNote) },
      );
      return notes.map(({ id, text }) => {
        if (!text) throw new Error(`工具提示 ${id} 没有渲染出来，登记的样本要改`);
        return { id: `tool-note:${id}`, where: `tool-note:${id}`, text };
      });
    },
  };
}
