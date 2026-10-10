// 旅游的模型输入与工具钩子；会话持久化、历史窗口、额度与敏感信息仍由核心编排。
import {
  cleanText,
  convLabel,
  logQuote,
  todayIso,
  SALES_SEGMENTS,
  groupSizeIn,
  hasTotalHeadcount,
  headcountIn,
  parseDayCount,
  dayInMonth as parseDayInMonth,
  latestDepart as parseLatestDepart,
  monthSaid as parseMonthSaid,
  readDepartDates as parseDepartDates,
  resolveDepartDate as parseResolvedDate,
  saysDay,
  spokenDepartDate as parseSpokenDate,
  statedPastDate as parseStatedPastDate,
  type CustomerProfile,
  type Order,
  type Route,
  type SalesSegment,
  type Session,
  type SpokenDate,
  type ToolHints,
  type TurnToolCall,
  type TurnContext,
  type TurnToolContext,
  type TravelTurnSources,
  type PrefetchResult,
  type DeterministicReply,
  type PackRuntime,
  type PackRuntimeTypes,
} from '../../core/pack-api.js';
import {
  BUDGET_NOT_CAP_AFTER,
  BUDGET_NOT_CAP_BEFORE,
  detectSegment,
  latestSegment,
  isBudgetTalk,
  isObjection,
  isPastRecommendationStage,
  segmentsSaid,
  travellingText,
} from './progress.js';
import { holidayIn, travelDatePolicy } from './dates.js';
import { TARGET_DAYS, requestedDays, customHandoffReply } from './itinerary.js';

export interface TravelTurnTypes extends PackRuntimeTypes {
  ToolContext: TurnToolContext;
}

export function createTravelTurnHooks(sources: TravelTurnSources) {
  const {
    loadRoutes,
    getOrder,
    searchRoutes,
    rememberShownRoutes,
    mentionsPlace,
    offCatalogPlaces,
    isOriginMention,
    visitedDestinations,
    paymentMode,
    spokenMoney,
    liftsBudget,
  } = sources;
  type ToolCall = TurnToolCall;
  const splitSentences = (s: string): string[] => s.split(/(?<=[。！？!\n]|\?(?!v=\d))/);
  const yuan = (n: number): string => '¥' + n.toLocaleString('zh-CN');
  // 明确的购买意图（用于成单安全网）。不含「买了/订了」——叙述句（"我上次买了…"）会误伤；
  // 配合调用处的短句长度限制，只兜确定性的下单指令。
  //
  // 「就这个 / 就它」必须落在句末（可带 吧/了/啦）才算下单指令。跟着名词时是在确认参数
  // 而不是买：实测「我们就这个人数吧」「就这个季节去合适吗」「行程就这个样子对吗」
  // 原来全部命中，一句普通反问就给客户发出一张几万元的待付款订单和支付链接，
  // 而且模型原本正确的答疑会被整条丢弃。误兜的代价远高于漏兜——漏兜只是让模型自己回话。
  const PURCHASE_INTENT =
    /就订|就定|下单|购买|确定就|成交|去付款|可以下单|帮我订|预订吧|(?:就这个|就它|就要这个)(?:吧|啦|了)?(?=$|[，,。！!？?~～\s])/;
  // 安全网只认短促的下单指令，长段叙述交给模型自行判断，减少正则误伤
  const PURCHASE_INTENT_MAX_LEN = 40;

  // 还价不是下单。B01 实测「给个实在价 1万5一个人，我今天就定」命中「就定」，模型原稿已经回了「1 万 5 这个价我真批不下来」、
  // 也没调 create_order，引擎却按原价兜底建了一张 43,560 的待付款单，回复被换成「好的，已为您锁定名额」——
  // 客户要的是降价，收到的是原价订单。客户这句在砍价、在提异议，或模型原文在拒绝，安全网都不兜，保留模型原话
  const BARGAIN_WORDS =
    /便宜|实在价|实惠|优惠|降(?!落|温|雨|雪|水|压)|打(?:个)?折|折扣|能不能少|能否少|少(?:点|一点|些|收)|再少|给个价|最低|底价|抹(?:个)?零|让(?:点|一点|些|利)|砍|太贵|好贵|有点贵|嫌贵|这么贵|贵了/;
  // 夸价格、顺口一句「能便宜更好」、说自己已经比过了，都不是还价：「挺实惠的，就订这个」「也不算贵了，就订吧」
  // 「优惠的话最好，下单吧」「不用再看看了，就订这个」「别家都比过了」。此前一律算还价，客户明说要订，安全网却不兜，
  // 模型回一句「好的～」，这单就没下成。先把这些说法去掉再认还价词和异议
  const PRICE_OK =
    /(?:挺|很|蛮|还算|还挺|比较|真|超|够|也算)(?:实惠|优惠|划算|便宜)|(?:实惠|划算)的|(?:不算|也不|并不)(?:太)?贵|(?:便宜|优惠)[^，,。！!？?]{0,4}?(?:的话)?(?:最好|更好)|(?:不用|不必|不想|别)再看看|(?:别家|其他家|别的家|别人家)?(?:都|已经)比(?:较)?过了/g;
  const REFUSAL_IN_REPLY =
    /批不下来|申请不下来|批不了|给不了|给不到|没(?:有)?(?:这个)?权限|权限(?:之)?外|做不到|降不了|让不了|(?:没法|无法|不能)(?:再)?(?:降|让|优惠|便宜|少)|已经是最低|最低价了|底价了/;
  /** 拒绝得是在拒绝价格：「专票这块我这边给不了」拒的是发票，客户说「就订这个」照样兜底建单 */
  const PRICE_TOPIC = /价|降|便宜|优惠|折|让|少|砍|抹零/;
  function haggling(session: Session, text: string, modelText: string): boolean {
    const said = text.replace(PRICE_OK, '');
    if (BARGAIN_WORDS.test(said) || isObjection(session, said)) return true;
    if (splitSentences(modelText).some((s) => REFUSAL_IN_REPLY.test(s) && PRICE_TOPIC.test(s))) return true;
    // 客户自己报了个数（「1万5一个人」「15000就定」）：跟报过的每人价、总价都对不上就是在还价。
    // 不带单位的四到六位数也认（spokenMoney 不认它，见 price-guard customerAmounts），年份、ISO 日期、2026/12/10 这种写法不算
    const q = session.lastQuote;
    const bare = (text.match(/(?<![\d.,/-])\d{4,6}(?![\d.,/-]|\s*年)/g) ?? []).map(Number);
    return [...spokenMoney(text).amounts, ...bare].some((n) => n !== q?.perPerson && n !== q?.total);
  }

  // 指着另一张单的说法：给朋友再订一份、另外那份、闺蜜那单。一个会话只有客户本人那张待付款订单，
  // 此前模型把它当成「闺蜜那份」发了出去（C06：幂等复用回来的是本人订单，回复却是「闺蜜那份也订好啦」；
  // 另一遍是修补链接时补进本人订单的真链接，放在「支付链接（闺蜜二人专用）」下面）。
  // 只收朋友这类关系：「给爸妈订」多半就是客户这张单本身；「另外单独问下」不是另一张单。
  // 「她们 / 他们」不算：「带爸妈去，给他们订好点的房间」「帮他们下单吧，爸妈身份证我发你」说的就是同行的爸妈；
  // 光秃秃的「再下一单」「也下单」也不算：「日期改成12月12号，再下一单」是改单，此前被当成给别人订，改单没改成
  const THIRD_PARTY = '(?:朋友|闺蜜|同事|哥们|兄弟|姐妹|同学|邻居|亲戚|别人|其他人)';
  /** 明说了是别人的那份（朋友、闺蜜…），不含「另外那份」这种说法——模型常把客户本人改单后的那张叫「另外那张」 */
  const OTHER_PARTY_ORDER = new RegExp(
    [
      `(?:帮|给|替)(?:我的?)?${THIRD_PARTY}[^，。！？\\n]{0,8}(?:订|下单|下一单|买|报名|报个?价)`,
      `${THIRD_PARTY}(?:们|她们|他们)?(?:那|的|这)?(?:一)?[份单张]`,
      // 「闺蜜她们也想去」「朋友也要报名」
      `${THIRD_PARTY}(?:们|她们|他们)?[^，。！？\\n]{0,4}也(?:想|要|打算|准备)?(?:去|订|下单|报名)`,
      `(?:订|下|买)(?:一|个)?[份单张][^，。！？\\n]{0,4}(?:给|帮)(?:我的?)?${THIRD_PARTY}`,
      // 单数的「她/他」只认「她那份」「他的单」：「给她订」可能说的就是同行的爱人
      '[她他](?:那|的)[份单张]',
    ].join('|'),
  );
  const OTHER_ORDER = new RegExp(`另(?:外)?(?:一|那|这)?[份单张](?!独)|${OTHER_PARTY_ORDER.source}`);
  /** 合成一单下（「合并吧」「一共4个人」）：说的是按总人数重下客户这张，不是另一张 */
  const MERGE_ORDER = /合并|合成一|一起下|一起订|算一单|放一单|一单下|总共|一共|加上|加到/;

  /** 2026-10-18 → 10月18日（不是今年的带上年份），与企微卡片、支付页同一写法 */
  function cardDate(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    const md = `${Number(m[2])}月${Number(m[3])}日`;
    return m[1] === todayIso().slice(0, 4) ? md : `${m[1]}年${md}`;
  }

  // 客户要重发支付链接（「付款链接打不开 再发我一次」）。A14 实测模型直接转了人工、没补发链接，之后 AI 不再应答，
  // 这单就卡在付款前。链接本来就在，重发没有新副作用，所以引擎确定性地重发那张单，不经过模型、不转人工。
  // 只认短句，且得是在说付款：「方案再发我一份」是方案书；说了改人数/日期、给别人订的，交给模型。
  // 只认链接本身出了问题：「支付不了，余额不够」「付不了款能分期吗」要的是回答，重发一遍链接等于没听。
  // 「再发 / 再给」得带着链接、卡片、付款这类宾语：此前光一个「再给」就算，「付款前能再给点优惠吗」「付款后再发我电子发票」
  // 都收到一条重发的支付链接——客户在还价、在要发票，引擎连模型都没问
  const RESEND_ASK = new RegExp(
    [
      '(?:再|重新)(?:发|给)(?:我|一下|下|一次|一遍|个){0,2}[^，,。！!？?\\s]{0,3}(?:链接|卡片|付款码|支付码|付款|支付)',
      '(?:链接|卡片|付款码)[^，,。！!？?\\s]{0,4}(?:再|重新)(?:发|给)',
      '重发',
      '打不开',
      '点不开',
      '开不了',
      '进不去',
      '(?:链接|卡片)(?:没了|不见了|找不到|失效|过期|丢了)',
      '找不到(?:链接|卡片|付款链接|支付链接)',
    ].join('|'),
  );
  const RESEND_MAX_LEN = 30;
  /** 同一句里还问了别的（「链接打不开，另外能开专票吗」「再发下支付链接 顺便问下含保险吗」）：交给模型，一起答 */
  const OTHER_QUESTION = /吗|呢|能不能|可不可以|怎么|如何|多少|几|含|包|开票|发票|分期|保险|退|改/;
  /** 按小句看时，「能再发一下吗」这种没带宾语的也是在要重发，不算别的问题 */
  const RESEND_CLAUSE = /(?:再|重新)(?:发|给)|重发|发(?:我|一下)/;

  /** 客户要重发支付链接时的确定性回复；不是这种情况返回 undefined，照常交给模型 */
  function resendPayReply(session: Session, text: string): string | undefined {
    if (text.length > RESEND_MAX_LEN || !RESEND_ASK.test(text) || /方案|行程/.test(text)) return undefined;
    if (OTHER_ORDER.test(text) || CHANGE_REQUEST.test(text) || REFUND_REQUEST.test(text)) return undefined;
    if (BARGAIN_WORDS.test(text) || /发票|收据|行程单|确认单|合同/.test(text)) return undefined;
    if (text.split(/[，,。！!？?；;\s]+/).some((c) => c && !RESEND_ASK.test(c) && !RESEND_CLAUSE.test(c) && OTHER_QUESTION.test(c)))
      return undefined;
    if (headcountIn(text) !== undefined || readDepartDates(text).pick) return undefined;
    const o = pendingOrder(session);
    if (!o) return undefined;
    // 得是在说付款：点名了支付/付款/订单，或只说「链接」「卡片」而最近发出去的站内链接就是支付链接
    if (!/支付|付款|付钱|交钱|收银|订单/.test(text) && !(/链接|卡片/.test(text) && lastSiteLinkIsPay(session))) return undefined;
    console.warn(`[engine] 客户要重发支付链接，引擎直接重发待付款订单 ${o.id}（会话 ${convLabel(session.id)}）：${logQuote(text)}`);
    const orderLine = `/pay/${o.id}\n《${o.routeTitle}》${o.travelers} 位、${cardDate(o.departDate)}出发，合计 ${yuan(o.totalPrice)}。`;
    // advisor 模式：这条链接不能点开就付，同一意思换一种说法（02 spec「收款流程」）；online 模式原样不变
    if (paymentMode() === 'advisor') {
      return `好的，订单链接给您重新发一次：\n${orderLine}${o.confirmedAt != null ? '请按顾问发的方式付款。' : session.channel === 'web' ? '顾问会在这个页面里跟您核对价格并发收款方式。' : '顾问会在微信里跟您核对价格并发收款方式。'}`;
    }
    return `好的，支付链接给您重新发一次：\n${orderLine}`;
  }
  /** 最近一条带站内链接的回复里，最后那条是支付链接（不是方案书） */
  function lastSiteLinkIsPay(session: Session): boolean {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role !== 'agent') continue;
      const pay = m.content.lastIndexOf('/pay/');
      const proposal = m.content.lastIndexOf('/proposal/');
      if (pay >= 0 || proposal >= 0) return pay > proposal;
    }
    return false;
  }

  /**
   * 原话里点到的目的地 → 拿哪个词去查库。别名与 search_routes 共用（routes.json 的 aliases）：
   * 客户说「海南」指的就是三亚那条线。只说了别名就用别名查（「九寨沟」只该查到九寨那条，
   * 用「四川」查会把川西线也带出来）；本名也出现了、或同一目的地命中了两个不同别名，就用本名。
   * 本名、别名是另一个更长地名的一截时按整词认（mentionsPlace）：后台建了「北海」线，「想去北海道滑雪」不算点了它
   */
  function destinationMentions(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of loadRoutes()) {
      if (!r.destination) continue;
      const kw = mentionsPlace(text, r.destination) ? r.destination : (r.aliases ?? []).find((a) => mentionsPlace(text, a));
      if (!kw) continue;
      const prev = out.get(r.destination);
      out.set(r.destination, prev && prev !== kw ? r.destination : kw);
    }
    return out;
  }

  function destinationsInText(text: string): string[] {
    return [...destinationMentions(text).keys()];
  }

  /** 用真实产品库拼一条确定性的推荐回复（不经模型，杜绝再被覆盖） */
  async function deterministicRecommend(dest: string, session: Session): Promise<string | null> {
    const list = await searchRoutes({ destination: dest });
    if (!list.length) return null;
    rememberShownRoutes(session, list.slice(0, 2)); // 客户确实看到了这两条，下一轮报价要认得出
    const lines = list
      .slice(0, 2)
      .map(
        (r) => `· ${r.title}\n  ${r.days} 天 · ${r.hotelLevel} · 人均 ${yuan(r.priceFrom)} 起\n  ${cleanText(r.highlights?.[0] ?? '', 42)}`,
      );
    return `${dest}是我们的主力目的地，给您挑了这些：\n\n${lines.join('\n\n')}\n\n您几位出行、大概什么时候走？我按人数和日期给您出准确报价～`;
  }

  function pendingOrder(session: Session): Order | undefined {
    const id = session.orderIds[session.orderIds.length - 1];
    const o = id ? getOrder(id) : undefined;
    if (!o || o.status !== 'pending_payment') return undefined;
    const q = session.lastQuote;
    if (q && (q.routeId !== o.routeId || q.travelers !== o.travelers || (q.departDate && q.departDate !== o.departDate))) return undefined;
    return o;
  }

  /**
   * 这轮说的是另一张单（给朋友再订一份…），见 OTHER_ORDER。以客户的话为准；模型的话只认明说了别人的（「闺蜜那份的链接」）——
   * 模型常把客户本人那张叫「您的新订单」「另外那张旧单已作废」，此前据此判成别人的单，客户要链接却只收到一句「要合并还是单独下」
   */
  function talksOtherOrder(text: string, reply: string): boolean {
    return OTHER_ORDER.test(text) || OTHER_PARTY_ORDER.test(reply);
  }

  /**
   * 客户在说给别人另订一份，而同一条线上已有客户本人那张待付款单：在这里再下一单会把本人那张作废（改单规则），
   * 参数相同又会复用回本人那张、被说成别人的（C06）。返回本人那张；不是这种情况返回 undefined。
   * 看客户这句和上一句（「闺蜜她们也想去…帮她们报个价」→「行，那就订这个」）。合成一单按总人数重下（「合并吧」「一共4个」）不算；
   * 上一句说的别人、这句明说改日期人数（「日期改成12月12号，再下一单」）的，是改客户自己那张
   */
  function otherPartyPending(session: Session, routeId: unknown, travelers: number): Order | undefined {
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    const mine = session.orderIds.map((id) => getOrder(id)).find((o) => o?.status === 'pending_payment' && o.routeId === routeId);
    if (!mine) return undefined;
    const now = said.at(-1) ?? '';
    const merging = MERGE_ORDER.test(now) || (headcountIn(now) === travelers && travelers > mine.travelers);
    if (merging || (!OTHER_ORDER.test(now) && CHANGE_REQUEST.test(now))) return undefined;
    return said.slice(-2).some((t) => OTHER_ORDER.test(t)) ? mine : undefined;
  }

  /** 说另一张单时收尾的问句：本人这张还在待付款、另一份没下，问合成一单还是请顾问单独下 */
  function askOtherOrder(o: Order, text: string): string {
    const n = headcountIn(text);
    // 「她们也是两个人」是另一份的人数，要加上本人这单；「一共4个人」说的已经是总数
    const total = typeof n === 'number' ? (hasTotalHeadcount(text) ? n : o.travelers + n) : undefined;
    return (
      `您本人这张《${o.routeTitle}》${o.travelers} 位、${cardDate(o.departDate)}出发的订单还在待付款；另外那份还没有下单。\n` +
      `要合并成${total ? ` ${total} 位` : '一单'}一起下，还是请顾问另外单独下一单？`
    );
  }

  function cnDate(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    const md = `${Number(m[2])}月${Number(m[3])}号`;
    return m[1] === todayIso().slice(0, 4) ? md : `${m[1]}年${md}`;
  }

  function titleWordHit(said: string, r: Route, pool: Route[]): boolean {
    const others = pool
      .filter((o) => o.id !== r.id)
      .map((o) => o.title)
      .join('|');
    const runs = r.title.replace(r.destination, ' ').match(/[一-鿿]{2,}/g) ?? [];
    return runs.some((w) =>
      [...w].slice(1).some((_, i) => {
        const bi = w.slice(i, i + 2);
        return !others.includes(bi) && said.includes(bi);
      }),
    );
  }

  /** 在两三条候选里认「这条6日亲子线」「稻城亚丁那条」：别名、天数、标题里独有的两字词 */
  function routeMentioned(said: string, r: Route, pool: Route[]): boolean {
    if ((r.aliases ?? []).some((a) => mentionsPlace(said, a))) return true;
    if ([...said.matchAll(ANY_DAYS_OR_RI)].some((m) => parseDayCount(m[1]) === r.days)) return true;
    return titleWordHit(said, r, pool);
  }

  /**
   * 在全库里认「点名了这条线」，比 routeMentioned 严：那边只在两三条候选里挑，这里对着全库，
   * 「雪山」「度假」「海岛」这类两字词单独出现不能算点名（「玉龙雪山」不是在说梅里雪山那条）。
   * 认两档：'referent' 是独有的两字词后面跟着「那条/这个」（「故宫那条」「香格里拉那条」），明确在指一条线；
   * 'title' 是别名、或标题里连着三个字（「兵马俑」）——标题里也有「奢华度假」「越野摄影」「一价全包」这种泛称，
   * 只凭它不能跨目的地换线（「想要奢华度假的感觉」不是在点三亚那条），见 proposalTarget
   */
  const ROUTE_REFERENT = /^[一-鿿]{0,2}?(?:那条|这条|那一条|这一条|那个|这个|那款|这款)/;
  function routeNamed(said: string, r: Route, routes: Route[]): 'referent' | 'title' | undefined {
    const others = routes
      .filter((o) => o.id !== r.id)
      .map((o) => o.title)
      .join('|');
    const runs = r.title.replace(r.destination, ' ').match(/[一-鿿]{2,}/g) ?? [];
    let title = (r.aliases ?? []).some((a) => mentionsPlace(said, a));
    for (const w of runs) {
      for (let i = 0; i + 2 <= w.length; i++) {
        const bi = w.slice(i, i + 2);
        if (others.includes(bi)) continue;
        for (let at = said.indexOf(bi); at >= 0; at = said.indexOf(bi, at + 1)) {
          if (ROUTE_REFERENT.test(said.slice(at + 2))) return 'referent';
        }
        if ((i > 0 && said.includes(w.slice(i - 1, i + 2))) || (i + 3 <= w.length && said.includes(w.slice(i, i + 3)))) title = true;
      }
    }
    return title ? 'title' : undefined;
  }
  /** 「6天」「6日」都算天数，但「12月6日」是日期 */
  const ANY_DAYS_OR_RI = /(?<![月\d一二两三四五六七八九十]\s*)(\d+|[一二两三四五六七八九十]+)\s*[天日](?!期)/g;

  function neutralizeStandardDays(visible: string, session: Session, calls: ToolCall[]): string {
    const routes = loadRoutes();
    const ids = new Set<unknown>([
      session.lastQuote?.routeId,
      ...(session.lastShownRoutes ?? []).map((r) => r.id),
      ...calls.map((c) => c.args.routeId),
    ]);
    const days = new Set(routes.filter((r) => ids.has(r.id)).map((r) => r.days));
    return visible.replace(/(\d+)(\s*)天版/g, (m, n: string, sp: string) => (days.has(Number(n)) ? `${n}${sp}天这条` : m));
  }

  const HANDOFF_REQUEST = /转人工|要人工|人工客服|真人客服|找真人|人工顾问|要退款|要退订|要退钱|退我钱/;
  // 单独一句「人工」「真人」「要真人」只可能是在要人（欢迎语就教客户回「人工」），但这两个词放进句子里多半是别的意思：
  // 「你是真人吗」「你是人工智能吗」是身份问题（走身份兜底），「有真人导游吗」问的是服务角色，「人工湖」「人工费」是旅行话题。
  // 所以光秃秃的这两个词只认整句。「找人工」「接人工」「人工服务」也一样：放进句子里是「找人工沙滩」
  // 「接人工岛的船」「人工服务费」，当子串认的话，客户问一句旅行话题 AI 就永久闭嘴
  const HANDOFF_BARE = /^\s*我?(?:要|找|接)?(?:人工|真人)(?:服务)?\s*[!！。.~～]*\s*$/;
  // 投诉/指控类词只在陈述句里才算。小红书引流来的新客户开口常是「靠谱吗，不会是骗人的吧」
  // 「看到有差评是真的吗」——那是在打消疑虑，该好好答，不是投诉。此前一律命中：系统为一次
  // 不存在的「不好的体验」道歉、AI 永久闭嘴，线索只能等人工发现。
  // 所以按小句判断：带疑问、否定或转述的小句交给模型（它拿不准可以自己调 handoff_to_human）；
  // 「你们这个是骗人的吧，我要投诉」后半句仍是明确投诉，照转。
  //
  // 但疑问排除只该用在「骗人/差评」这类打消疑虑的问法上，不能一刀切：
  //   · 「投诉」本身就是诉求，带问号几乎都是在找投诉渠道（「怎么投诉？」「投诉电话是多少？」）。
  //     交给模型的话，它常「嘴上说转接、实际没调 handoff」，下一句又接着推销，人工还看不到这条线索。
  //     只有说的是别人的投诉（「网上有人投诉过你们吗」）或自己否认（「我不是来投诉的」）才不算。
  //   · 「没良心」「没人管」里的「没」不是在否定骗，单字「没」不算否定。
  //   · 「这不是欺骗消费者吗」是反问，是指控；「你们不是骗子吧」才是打消疑虑。
  const COMPLAINT_WORD = /差评|欺骗|骗人|骗子|被骗/;
  const DOUBT_CLAUSE = /不会|不是|会不会|是不是|是否|有没有|靠谱|有人|别人|听说|看到|网上|[吗吧嘛呢?？]/;
  /** 「不是…吗」反问。其余疑虑词（会不会/是不是/听说…）同在时仍按打消疑虑处理 */
  const RHETORICAL = /(?<!是)不是.*吗/;
  const STRONG_DOUBT = /不会|会不会|是不是|是否|有没有|靠谱|有人|别人|听说|看到|网上/;
  /** 说的是别人的投诉，或自己否认要投诉。「有没有投诉电话」里的「没有投诉」不是否认 */
  const NOT_OWN_COMPLAINT =
    /有人|别人|听说|看到|网上|被投诉|投诉(?:多|率|记录)|(?<!有)(?:不是|不想|不会|不打算|没有?|不)\s*[来去要]?\s*投诉/;
  /** 投诉或指控（按小句判，规则见上） */
  function isComplaint(text: string): boolean {
    return text
      .split(/[，,。！!；;~～\n]+/)
      .some(
        (c) =>
          (c.includes('投诉') && !NOT_OWN_COMPLAINT.test(c)) ||
          (COMPLAINT_WORD.test(c) && (!DOUBT_CLAUSE.test(c) || (RHETORICAL.test(c) && !STRONG_DOUBT.test(c)))),
      );
  }
  function isHandoffIntent(text: string): boolean {
    return HANDOFF_REQUEST.test(text) || HANDOFF_BARE.test(text) || isComplaint(text);
  }

  // ---------- 转人工要和客户的话、回复里的话对得上 ----------
  // 转人工后 AI 不再应答，转错一次这条线索就卡死。实测两类不一致：
  //   · 客户没坚持就转：B09 客户只答了时间和人数，模型就以「客户仍以桂林/厦门为准」转了人工，
  //     下一句「那你推荐的那个多少钱」没人回——库外目的地只有客户坚持时才转（sop.md）；
  //   · 嘴上转了、状态没转：A07/A11「我马上为您转接资深顾问」却没调 handoff_to_human，下一轮 AI 接着卖。
  /** 客户坚持原目的地的说法 */
  const INSIST_DEST =
    /就要|只要|只去|只想去|就想去|还是想去|还是(?:要|得)去|就去|就奔着|冲着[^，。！？]{0,6}去|非[^，。！？]{0,8}不(?:可|去)|别的(?:都)?(?:不(?:考虑|要|去|看)|没兴趣|不感兴趣)|其他(?:的|地方)?(?:都)?(?:不(?:考虑|要|去|看)|没兴趣|不感兴趣)|没(?:啥|什么)?兴趣|不感兴趣|只对[^，。！？]{0,6}感兴趣|不考虑(?:别的|其他)|不换|一定要去|必须(?:去|是)|坚持|认准/;
  /** 客户自己要找人，或提了只有真人顾问办得了的事（改行程、定制） */
  /**
   * 客户在下最后通牒、要一件只有人能拍板的事（「就是要打9折 不然不订」「必须开专票」）。
   * 这时模型顺口说的「为您转接」照转——SOP 本来就让额外折扣、特殊要求走人工；
   * 只是问一句（「能开专票吗」「签证能帮忙办吗」）则不整段转走，见说了转接却没调工具那段
   */
  const DEMANDS_EXCEPTION = /就是要|不然不|否则不|必须|一定要|非要|非得|不.{0,4}就不订|才订|才定/;
  const WANTS_PERSON = /人工|真人|顾问|客服|专人|电话|打给我|联系我|找个?人|找你们的人|问问你们|定制|改行程|换景点|加景点|重新安排|重排/;
  /** 转人工说的是别的事（SOP 转人工条件 6：额外折扣、发票、特殊资源…），与库外目的地无关，不在这里拦 */
  const OTHER_HANDOFF_TOPIC =
    /折|优惠|便宜|降价|发票|专票|开票|报销|对公|退|改期|合同|保证|担保|承诺|资源|投诉|签证|公司|企业|年会|团建|会议/;

  /**
   * 这次转人工是不是在拿「我们没有那个目的地」当理由，而客户并没有坚持。about 是模型写的转人工原因（或回复原文）。
   * 只管库外目的地这一种：本会话告诉过客户某地没有现成线路，客户这句既没坚持、也没要找人，且这次转人工说的就是那个地方，
   * 或者「没有」是本轮或上一轮刚说的（客户这句多半只是在答时间人数）。别的理由的转人工（折扣、发票、特殊资源…）不在这里拦：
   * 此前最后那条「刚说过没有」的兜底不看理由，「北欧那条能打个9折吗」「公司50人年会要开专票」的转人工全被驳回了
   */
  function unwarrantedHandoff(session: Session, text: string, about: string): boolean {
    const miss = session.missedDestinations ?? [];
    if (!miss.length) return false;
    if (INSIST_DEST.test(text) || WANTS_PERSON.test(text) || TARGET_DAYS.test(text) || isHandoffIntent(text)) return false;
    // 「还是冰岛吧」「冰岛吧，别的没兴趣」：点名要的还是那个地方
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (miss.some((m) => new RegExp(`还是(?:去)?${esc(m.place)}|${esc(m.place)}吧`).test(text))) return false;
    if (OTHER_HANDOFF_TOPIC.test(about) || OTHER_HANDOFF_TOPIC.test(text) || BARGAIN_WORDS.test(text)) return false;
    if (miss.some((m) => about.includes(m.place) || text.includes(m.place))) return true;
    if (/原目的地|没有(?:现成的?)?线路|现成线路/.test(about)) return true;
    const lastMiss = Math.max(...miss.map((m) => m.at));
    return session.messages.filter((m) => m.role === 'customer' && m.at > lastMiss).length <= 1;
  }
  /** 驳回转人工时回给模型的话 */
  const HANDOFF_DECLINED =
    '这次没有转人工：客户这句没有要找真人，也没有坚持只要我们没有的那个目的地（没说「就要去」「别的不考虑」）。继续回答客户这句话——' +
    '问什么答什么，接着推荐最接近的现成线路、报价或问出行信息。回复里不要说「为您转接」「顾问会联系您」。';

  const REFUND_REQUEST = /退款|退订|退钱|退我钱|退改|取消|不想去|不去了|不要了/;
  const CHANGE_REQUEST =
    /改期|改签|推迟|延期|(?:日期|时间|人数|天数|行程|线路)[^，,。！？]{0,3}(?:改|换|调)|(?:改|换|调)[^，,。！？]{0,4}(?:日期|时间|人数|天数|行程|线路)/;

  function readDepartDates(text: string, today = todayIso()) {
    return parseDepartDates(text, today, travelDatePolicy);
  }
  function spokenDepartDate(text: string, today = todayIso()): SpokenDate | null {
    return parseSpokenDate(text, today, travelDatePolicy);
  }
  function latestDepart(customerTexts: string[], today = todayIso()) {
    return parseLatestDepart(customerTexts, today, travelDatePolicy);
  }
  function resolveDepartDate(profile: CustomerProfile, text: string): string | undefined {
    return parseResolvedDate(profile.dates, text, todayIso(), travelDatePolicy);
  }
  function monthSaid(text: string, today = todayIso()) {
    return parseMonthSaid(text, today, travelDatePolicy);
  }
  function dayInMonth(ym: { y: number; mo: number }, today = todayIso()): string | undefined {
    return parseDayInMonth(ym, today);
  }

  /**
   * 成单安全网用的出发日期。客户最近一次说的是「国庆」这种节假日时不给：节假日只是个大概（国庆有七天），
   * 补进报价没问题（整段假期同一个季节价），但下单是真实副作用，引擎不替客户把「国庆」定成 10 月 1 日——
   * 留着模型那句「具体哪天出发」让客户说清。「12月初」「明年7月」这种只说到月的同理：此前这时回退到画像里
   * 的日期，而画像可能记着报价时按月份补的那一天，等于替客户挑了一天下单
   */
  function orderDepartDate(session: Session, text: string): string | undefined {
    const latest = latestDepart(session.messages.filter((m) => m.role === 'customer').map((m) => m.content))?.pick;
    if (latest?.kind === 'vague' || (latest?.kind === 'date' && !latest.exact)) return undefined;
    // 客户明说过的那天（可能在顺口一问之前，见 latestDepart）直接用，不经画像——画像可能记着别的
    if (latest?.kind === 'date' && latest.iso) return latest.iso;
    return resolveDepartDate(session.profile, text);
  }

  /** 这句话里客户说到了 iso 那一天：「10月3号」「十月三号」「10.3」，或只说日子（「国庆3号走」「1号吧」）。
   *  下单核日期用（见 groundToolArgs）：客户最近的说法是个大概时，模型的日子得是客户说出来的 */
  /** 客户在答应（「可以」「对」「就这天」） */
  const AGREES = /^\s*(?:对|是|好|行|可以|没问题|嗯|确认|就这|就那|ok|没错)/i;
  /** 客户说出了 iso 那天：这句或最近说出发时间的那句里说了（「国庆当天走」就是节日那天），
   *  或是答应了上一条回复里问的那天（「10月3日出发可以吗？」「可以」） */
  function customerNamedDay(session: Session, latestText: string, iso: string, holiday?: string): boolean {
    const customer = session.messages.filter((m) => m.role === 'customer');
    const now = customer.at(-1);
    if (!now) return false;
    if (saysDay(now.content, iso) || saysDay(latestText, iso)) return true;
    if (holiday === iso && /当天|那天|第一天|头一天/.test(latestText)) return true;
    if (!AGREES.test(now.content) || readDepartDates(now.content).pick) return false;
    const prev =
      session.messages
        .slice(0, session.messages.lastIndexOf(now))
        .toReversed()
        .find((m) => m.role === 'agent')?.content ?? '';
    const [, mo, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso) ?? [];
    if (!mo) return false;
    const day = new RegExp(`(?<!\\d)${Number(mo)}\\s*月\\s*${Number(d)}\\s*[日号](?!\\d)|${iso}`);
    return splitSentences(prev).some((s) => day.test(s) && /[？?]|吗|对吧|可以吧|行吧|没问题吧/.test(s));
  }

  /** 按月份补进报价的日期只是拿来定季节价的，不是客户说的哪天：画像不记它（见 extractProfile），不然会顺着画像流进下单 */
  const MONTH_ONLY_ARGS = new WeakSet<object>();

  /**
   * 转人工记录里附的出行时间参考。模型写 reason 时会把客户说的「明年2月」自己换算成「2026年2月」（今天已是 2026 年 9 月，
   * 应为 2027），顾问照着约就差了一年。handoff_to_human 的参数说明已要求照原话写；这里再把客户最近说出行时间的那句原话
   * 和引擎的读法附在后台那条记录后面，给顾问对照。只进后台：system 消息不发给客户、也不进模型历史。
   * 读法：说到哪天的按 readDepartDates 的口径（「10月12号」→ 最近的未来那天）；只说到月的（「明年2月」「11月」）
   * 这里补读到年月——报价、下单不认这种说法（说不准哪天），给顾问一个年份足够。一句话里说了好几个月份的不猜
   */
  function departNoteForHandoff(session: Session, today = todayIso()): string | undefined {
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    for (let i = said.length - 1; i >= 0; i--) {
      const { pick } = readDepartDates(said[i], today);
      if (!pick) continue;
      let reading = pick.kind === 'date' ? pick.iso : undefined;
      const ym = pick.kind === 'vague' ? monthSaid(said[i], today) : undefined;
      if (ym) reading = `${ym.y}年${ym.mo}月`;
      const whole = cleanText(said[i]);
      const cut = cleanText(whole, 40);
      const quote = cut === whole ? whole : `${cut}…`;
      return `客户原话里的出行时间：「${quote}」${reading ? `，按今天（${today}）算是 ${reading}` : ''}`;
    }
    return undefined;
  }

  function contextNote({ session, text }: TurnContext): string[] {
    const lines: string[] = [];
    // 线路 id 跨轮带着走：历史里只有文本，没有这一行，客户说「第二条报个价」时模型得先重查一遍库
    const shown = session.lastShownRoutes ?? [];
    if (shown.length) {
      lines.push(`最近查到的线路: ${shown.map((r) => `${r.id}《${r.title}》每人 ${r.priceFrom} 起`).join('；')}`);
    }
    const q = session.lastQuote;
    // 只给参数不给金额：人数或日期一变价格就得重算，给了旧金额模型会顺手沿用
    if (q) lines.push(`最近报价: ${q.routeId}《${q.routeTitle}》${q.travelers} 人${q.departDate ? `，${q.departDate} 出发` : ''}`);
    lines.push(quoteTimingNote(session, text) ?? '', headcountAskNote(session, text) ?? '');
    return lines;
  }

  // ---------- 引擎预取 ----------
  // 客户点了目的地，引擎在调模型之前自己查一次库，结果经 ChatOptions.prefetch 交给模型，
  // 模型看到的是「自己已经调过 search_routes」，直接据结果回复。两个原因：
  //   · 漏查：SOP 把「说了目的地就查库」标成最重要的一条，glm-5.2 仍有 14/48 次空手反问
  //     「您几位出行？」。智谱的 tool_choice 只支持 auto，强制不了模型调工具，只能引擎替它调。
  //   · 延迟：模型自己查要两次串行往返（先吐 tool_call，拿到结果再出文本），预取后一次就够。
  //     glm-5.3 系列每次往返有 2~3.5 秒固定开销，省下这一次决定了能不能守住「单轮 8 秒」。
  // 判错的代价是一次本地 JSON 查询加几百 token 的工具结果，但查错了地方会把模型往错的方向带，
  // 所以条件宁紧勿松：只在问需/推荐阶段、这句话点了一个新目的地、且不带否定语气时才预取。
  // 例外是客户明说换到哪儿（「高反挺吓人的 换云南吧」）：那处就是他现在要的，什么阶段都照查——此前一句「算了」
  // 把整句判成否定，模型没查库就编了两条云南线（B03）。
  const PREFETCH_NEGATION = /去过|来过|玩过|到过|不去|不想|不要|不考虑|不喜欢|没兴趣|太远|别推|除了|算了|排除/;
  // 否定是冲着某一处地名说的（「我说的是印度啊 不是印尼」「不去三亚了 想去云南」）：否掉的那处不查，也不算进上面的否定语气，
  // 同一句里肯定的那处照查。此前「不是」不在否定词里，「不是印尼」把印尼预取了，模型回「我们有一条印尼巴厘岛的线路」（B10）。
  // 「是不是 / 要不要 / 想不想去」是在问，「没去过」是想去，都不算否定。
  // 「别换云南了 就西藏」「不换云南」否的是换过去（第三轮复核：此前照样预取了云南）；「要不换云南」「要不要换云南」是在提议
  const NEG_BEFORE_PLACE =
    /(?:(?<!是)不是|(?<!要)不要|(?<!去)不去|(?<!想)不想去|(?<!考虑)不考虑|除了|别推|排除|(?<![没未]有?)(?:去过|来过|玩过|到过)|(?<!要)(?:别|不要?|不想)换(?:成|到)?)\s*(?:去|到)?\s*$/;
  const NEG_AFTER_PLACE = /^\s*(?:就?算了|去过|来过|玩过|到过|太远|不去了?|不想去|不考虑|没兴趣|不感兴趣|排除|pass\b)/i;
  /** 明说换过去：「换云南吧」「换成西藏看看」「改去贵州」「还是去云南」；「那就三亚吧」「还是云南吧」要带「吧」。「不想换 / 别换」不算 */
  const SWITCH_BEFORE_PLACE = /(?<![不别没][想要用必]?)(?:换(?:成|到|去)?|改(?:去|成|到)|还是去|那就去)\s*$/;
  const SWITCH_SOFT_BEFORE = /(?:那就|还是|就)\s*$/;
  /** 地名后面跟着在比、在问（「云南还是去四川好」「换成三亚还是云南？」），那是对比，不是拍板换过去 */
  const SWITCH_ASKING = /^[^，,。！!～~\n]*?(?:[？?]|吗|呢|哪个|比较|对比|好$|好[吗呢？?])/;
  function switchesTo(text: string, kw: string, at: number): boolean {
    const before = text.slice(Math.max(0, at - 8), at);
    const after = text.slice(at + kw.length);
    if (SWITCH_ASKING.test(after)) return false;
    return SWITCH_BEFORE_PLACE.test(before) || (SWITCH_SOFT_BEFORE.test(before) && /^\s*吧/.test(after));
  }
  /** 把点名否掉的地方连同否定词换成「，」：「我说的是印度啊 不是印尼」→「我说的是印度啊 ，」。没有就原样返回 */
  function withoutNegatedPlaces(text: string): string {
    const kws = [...new Set([...destinationMentions(text).values(), ...offCatalogPlaces(text).map((p) => p.kw)])];
    const spans: [number, number][] = [];
    for (const kw of kws) {
      for (let at = text.indexOf(kw); at >= 0; at = text.indexOf(kw, at + kw.length)) {
        const before = NEG_BEFORE_PLACE.exec(text.slice(Math.max(0, at - 8), at));
        const after = NEG_AFTER_PLACE.exec(text.slice(at + kw.length));
        if (!before && !after) continue;
        let end = at + kw.length + (after?.[0].length ?? 0);
        end += /^[了啊呀吧哈呢]*/.exec(text.slice(end))![0].length;
        spans.push([at - (before?.[0].length ?? 0), end]);
      }
    }
    if (!spans.length) return text;
    // 从后往前换，重叠的（「不是印度尼西亚」里的别名）并成一段
    spans.sort((a, b) => b[0] - a[0]);
    let out = text;
    let limit = text.length;
    for (const [s, e] of spans) {
      out = out.slice(0, s) + '，' + out.slice(Math.min(e, limit));
      limit = s;
    }
    return out;
  }
  // 预取要带上每人预算：search_routes 只有拿到预算才会标出超预算差额，而价格护栏只认工具算好的差额——
  // 不带的话，模型自己减出来的「比您预算多 6,800 元」会被当成编价整条拦下。
  // 说了钱却认不出是不是「每人」（「预算5万」可能是两个人的总数）就不预取，交给模型自己理解。
  const PER_PERSON_BUDGET =
    /(?:每人|人均)\s*(?:预算)?\s*(?:大概|大约|差不多|在)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(万|千|元|块)?(?:\s*([一二两三四五六七八九]|\d)(?![\d.])\s*千?)?/;
  const MENTIONS_MONEY = /预算|\d\s*(?:万|千|元|块)|[一二两三四五六七八九十]\s*(?:万|千(?!米))/;
  // 预算数后面接区间或下限（「一万到两万」「8000-12000」「3万以上」「5万起」），或前面带「至少/起码」，
  // 这个数就不是每人上限。当成上限的代价：「每人一万到两万」按 1 万查，工具对预算内的 16,800 算出
  // 「比您预算多 6,800 元」，价格护栏还按「工具算的差额」放行；「3万以上」按 3 万查，更贵的线路被
  // 预算内收窄直接藏掉。认出来就按「说不清的钱」处理：不预取，交给模型自己理解。
  /** 「每人两万」「人均三万五」「每人8000元」→ 元；认不出、是「三五万」这种约数、或是区间/下限时返回 undefined */
  function perPersonBudget(s: string | undefined): number | undefined {
    const m = s ? PER_PERSON_BUDGET.exec(s) : null;
    if (!m || !s) return undefined;
    if (BUDGET_NOT_CAP_AFTER.test(s.slice(m.index + m[0].length)) || BUDGET_NOT_CAP_BEFORE.test(s.slice(0, m.index))) {
      return undefined;
    }
    const [, raw, unit, tail] = m;
    // parseDayCount 就是 1~99 的中文/阿拉伯数字解析，「三五」这类约数同样返回 null
    const n = /^\d/.test(raw) ? Number(raw) : parseDayCount(raw);
    if (!n) return undefined;
    const tailK = tail ? (/\d/.test(tail) ? Number(tail) : parseDayCount(tail)!) * 1000 : 0;
    const v = unit === '万' ? n * 10000 + tailK : unit === '千' ? n * 1000 : n;
    return v >= 1000 ? v : undefined;
  }

  /** 这句话点到的一处目的地：关键词、在原文里的位置、是不是我们没有现成线路的地方 */
  interface DestinationPick {
    kw: string;
    at: number;
    off: boolean;
  }

  /** 这轮要替模型预先执行的 search_routes 参数（空数组 = 不预取） */
  function planPrefetch(session: Session, text: string): Record<string, unknown>[] {
    const budget = perPersonBudget(text);
    // 「人均8000-12000」不带单位，MENTIONS_MONEY 认不出是钱，但说了每人多少、又认不出上限，同样不预取
    if (budget === undefined && (MENTIONS_MONEY.test(text) || PER_PERSON_BUDGET.test(text))) return [];
    // 下面都按去掉了「不是X / 不去X了」的话来认（见 NEG_BEFORE_PLACE）：否掉的地方不查
    const said = withoutNegatedPlaces(text);
    // 已经在聊的目的地不重查：上一轮查到的线路在会话状态里，模型要换条件（预算/客群）会自己查
    const known = session.profile.destinationInterest;
    const knownDests = known ? [known, ...destinationsInText(known)] : [];
    // 出发地/常住地不是目的地：「我在北京，想去三亚」「四川人，想去新疆」只该查后一个
    const isOrigin = (kw: string): boolean => isOriginMention(said, kw);
    const inCatalog: DestinationPick[] = [];
    for (const [dest, kw] of destinationMentions(said)) {
      if (knownDests.includes(dest) || knownDests.includes(kw)) continue;
      if (isOrigin(kw)) continue;
      inCatalog.push({ kw, at: said.indexOf(kw), off: false });
    }
    // 我们没有的目的地（南极、冰岛…）同样替模型查：不预取时模型偶尔一个工具都不调，直接编一条
    // 「南极深度体验线的替代方向……人均起价 68800 起」（68800 是西藏松赞线的价）发给客户。预取走 search_routes
    // 已有的 destinationMiss 分支：按客户原话语义召回最接近的现成线路，并标明「不是原目的地、不要答应能去」。
    // 出发地、已在聊的地方、不像是想去那儿的说法（见 wantsToGo）跳过
    const offFound = offCatalogPlaces(said);
    const placeWords = [...offFound.map((p) => p.kw), ...destinationMentions(said).values()];
    const offCatalog: DestinationPick[] = offFound
      .filter(({ kw, at }) => !known?.includes(kw) && !isOrigin(kw) && wantsToGo(said, kw, at, placeWords))
      .map((p) => ({ ...p, off: true }));
    // 明说换过去的那处（「三亚太热了，换成西藏看看」）只查它：同一句里的另一处是刚否掉的
    const switched = [...inCatalog, ...offCatalog].filter((p) => switchesTo(said, p.kw, p.at));
    if (!switched.length) {
      if (isPastRecommendationStage(session.stage)) return [];
      if (PREFETCH_NEGATION.test(said)) return [];
    }
    // 库内、库外的地方跟在一起对比（「冰岛和瑞士哪个好」「想去冰岛，或者日本也行」）两边都查：此前只查库内那处，
    // 模型手里没有冰岛的 destinationMiss，照样能编「冰岛极光 9 日」。连不成对比的（「冰岛太贵了，日本怎么样」）
    // 库外那处不掺进来，库内的照原逻辑查
    const both = [...inCatalog, ...offCatalog].toSorted((a, b) => a.at - b.at);
    const picked = switched.length
      ? switched
      : offCatalog.length && comparing(said, both)
        ? both
        : inCatalog.length
          ? inCatalog
          : offCatalog;
    // 按原文顺序排：画像的 destinationInterest 取本轮最后一次 search_routes，按库里的顺序查会随机落在某一处
    picked.sort((a, b) => a.at - b.at);
    if (!comparing(said, picked)) return [];
    // 客群要从这句话里现取：画像要等本轮结束才更新，而银发是安全约束——「带爸妈去西藏」
    // 不带 segment 查，模型拿到的就是没有高海拔提示的 5200 米线路。画像里已有的由 executeTool 自动补
    const segment = detectSegment(text);
    // 这句刚把预算放开的，画像里的旧预算要等本轮结束才改掉，这里先不带
    const maxBudgetPerPerson = budget ?? (liftsBudget(text) ? undefined : perPersonBudget(session.profile.budget));
    const extra = { ...(segment ? { segment } : {}), ...(maxBudgetPerPerson ? { maxBudgetPerPerson } : {}) };
    // 库外的地方合成一次查就够：「冰岛和挪威哪个好」两处都没有，召回的是同一批最接近的线路。
    // 目的地写成「冰岛、挪威」，destinationMiss 才会照实说两处都没有；query 带客户原话，召回按他要的体验排。
    // 原话里否掉的那处不进 query：「不是印尼」按语义召回的正是巴厘岛
    // 最多两次查询：「四川和云南哪个好」两个都查，再多就是在罗列，交给模型挑重点
    const query = said === text ? text : said.replace(/\s*，(?:\s*，)*\s*/g, '，').replace(/^，|，$/g, '');
    const offs = picked.filter((p) => p.off).slice(0, 2);
    const calls: { at: number; args: Record<string, unknown> }[] = picked
      .filter((p) => !p.off)
      .map((p) => ({ at: p.at, args: { destination: p.kw, ...extra } }));
    if (offs.length) {
      calls.push({ at: offs[0].at, args: { destination: offs.map((p) => p.kw).join('、'), query: cleanText(query, 200), ...extra } });
    }
    return calls
      .toSorted((a, b) => a.at - b.at)
      .slice(0, 2)
      .map((c) => c.args);
  }

  /**
   * 一句话点了两处，只有两者之间是「和/还是/、」这类并列时才是在对比，都查。否则多半一个是
   * 上面没认出来的常住地（「我是三亚的，想去北京玩」）或刚否掉的（「三亚太热了，换成西藏看看」），
   * 两个都查会把模型往客户不想去的地方带——分不清就不预取，交给模型自己判断
   */
  function comparing(text: string, picked: DestinationPick[]): boolean {
    for (let i = 1; i < picked.length; i++) {
      const between = text.slice(picked[i - 1].at + picked[i - 1].kw.length, picked[i].at);
      if (between.length > 6 || !/^\s*$|和|跟|与|及|或|还是|、|\/|对比|比较/.test(between)) return false;
    }
    return true;
  }

  // 「我说的是印度」「我指的是冰岛」是在更正想去哪儿（B10）
  const TRAVEL_CUE =
    /去|到|玩|游|旅|行程|线路|路线|看|飞|怎么样|咋样|如何|呢|吗|哪|推荐|多少钱|价格|几天|几月|季节|值得|适合|度假|蜜月|自由行|跟团|考虑|说的是|指的是/;
  /** 去过的：「去年去了冰岛，这次呢」「上次去冰岛」。「之前 / 以前」不收——「国庆之前去冰岛」是想去 */
  const BEEN_THERE = /(?:去了|去年|上次|刚从)\s*(?:去|到|在)?\s*$/;
  /**
   * 库外地名是不是在说「想去那儿」。只看地名所在的分句：里面有出行的说法（去、玩、看、怎么样、哪个好…），
   * 或者去掉地名和「和 / 还是」之后这一句基本不剩什么（「南极」「冰岛和挪威」「埃及金字塔」「北海道滑雪」），才算。
   * 地名表里的地方常出现在别的话里：「美国那边签证太难办了，换个地方」「去年去了冰岛，这次呢」——
   * 当成目的地预取，模型会对客户说「我们暂时没有美国的线路」，画像的目的地也跟着记错。
   * 「法国菜」「美国签证」「迪拜转机」「我叫张泰山」这类地名紧挨着当修饰语的，offCatalogPlaces 已经排除；这里管的是隔开几个字的和时态。
   * 只用于库外地名：库内目的地的预取口径不动
   */
  function wantsToGo(text: string, kw: string, at: number, placeWords: string[]): boolean {
    const start = Math.max(...['，', ',', '。', '！', '!', '？', '?', '；', ';', '\n'].map((c) => text.lastIndexOf(c, at - 1))) + 1;
    const endHit = text.slice(at + kw.length).search(/[，,。！!？?；;\n]/);
    const clause = text.slice(start, endHit < 0 ? undefined : at + kw.length + endHit);
    if (BEEN_THERE.test(text.slice(start, at))) return false;
    let rest = clause;
    for (const w of [kw, ...placeWords]) rest = rest.split(w).join('');
    rest = rest.replace(/和|跟|与|及|或者|或|还是|[\s\p{P}\p{S}]/gu, '');
    return TRAVEL_CUE.test(rest) || rest.length <= 3;
  }

  // ---------- 这一轮说的是哪条线 ----------
  // 问细节的预取和「三样齐全就报价」都要先认出客户在说哪条线。认不准就不猜：查错线路的详情、按错线路催报价，
  // 比不查不催更糟——模型会照着错的那条讲给客户。

  /**
   * 一段话里点到的线路：目的地（或别名）只对应一条线就是它；同一目的地有几条时看天数、标题里独有的词，
   * 认不出是哪条就几条都算（调用方据此判「说不清」）；标题里连着的三个字、「兵马俑那条」这种指着说的也算。
   * 出发地、这段话里说去过的地方不算（「去年国庆去过云南了 今年国庆想去三亚」说的是三亚）。只看这段话自己：
   * 客户早先说过「马代去过了」，后来又说「那就马代吧」，这句点的就是马代
   */
  function routesIn(said: string, routes: Route[]): Route[] {
    const visited = new Set(visitedDestinations([said], routes));
    const hits = new Set<Route>();
    const mentioned = destinationMentions(said);
    for (const [dest, kw] of mentioned) {
      if (visited.has(dest) || isOriginMention(said, kw)) continue;
      const same = routes.filter((r) => r.destination === dest);
      // 同一目的地几条线共用的别名（三条马代线都叫「马代」）分不出是哪条，只看天数和标题里独有的词
      const named = same.filter(
        (r) =>
          (r.aliases ?? []).some((a) => mentionsPlace(said, a) && !same.some((o) => o !== r && o.aliases?.includes(a))) ||
          [...said.matchAll(ANY_DAYS_OR_RI)].some((m) => parseDayCount(m[1]) === r.days) ||
          titleWordHit(said, r, same),
      );
      for (const r of named.length ? named : same) hits.add(r);
    }
    // 没说目的地、只说了标题里的词（「稻城亚丁色达那条」「兵马俑那条」）。说了目的地的上面已经按天数、独有的词挑过，
    // 不再按 routeNamed 加：它把别名也算作点名，三条马代线会因为一个「马代」全加回来
    for (const r of routes) {
      if (!mentioned.has(r.destination) && !visited.has(r.destination) && routeNamed(said, r, routes)) hits.add(r);
    }
    return [...hits];
  }

  /**
   * 这一轮客户在说的那条线，认不准返回 undefined。依次看：
   *   ① 客户这句话点了哪条（点了两条以上、又不是同一目的地里报过价的那条，就是说不清）；
   *   ② 往前最近一条说到线路的消息（客户的或我们的，最多看 6 条）——刚报过价、刚推荐的那条都在这里；
   *      那条消息里说到好几条时，报过价的那条算数，否则说不清；
   *   ③ 都没说到时，报过价的那条；只查到过一条线时就是它。
   */
  function routeInFocus(session: Session, text: string, routes = loadRoutes()): Route | undefined {
    const quoteId = session.lastQuote?.routeId;
    const pool = new Set<string | undefined>([quoteId, ...(session.lastShownRoutes ?? []).map((r) => r.id)]);
    /** undefined：没说到线路；null：说到了但说不清是哪条 */
    const pick = (hits: Route[], preferQuote: boolean): Route | null | undefined => {
      if (!hits.length) return undefined;
      if (hits.length === 1) return hits[0];
      if (preferQuote && quoteId) {
        const q = hits.find((r) => r.id === quoteId);
        if (q) return q;
      }
      const shown = hits.filter((r) => pool.has(r.id));
      return shown.length === 1 && hits.every((r) => r.destination === shown[0].destination) ? shown[0] : null;
    };
    const own = routesIn(text, routes);
    const now = pick(
      own,
      own.every((r) => r.destination === own[0]?.destination),
    );
    if (now !== undefined) return now ?? undefined;
    const recent = session.messages
      .filter((m) => m.role !== 'system')
      .slice(0, -1)
      .slice(-6)
      .toReversed();
    for (const m of recent) {
      const got = pick(routesIn(m.content, routes), true);
      if (got !== undefined) return got ?? undefined;
    }
    const byId = (id: string | undefined) => routes.find((r) => r.id === id);
    if (quoteId) return byId(quoteId);
    const shown = session.lastShownRoutes ?? [];
    return shown.length === 1 ? byId(shown[0].id) : undefined;
  }

  // ---------- 问细节先查数据 ----------
  // 客户问几点、住哪、含不含、保险、走路爬山、海拔、第几天，模型不查线路数据就凭印象答：实测「黄果树有扶梯…完全没问题」
  // （贵州那条根本不去黄果树）、建议客户另买高原险（西藏那条的费用里已含）、替长辈担保北京线「全程平地」（第 3 天是约三小时的
  // 野长城）、编出「九寨天堂洲际 + 成都博舍」。同样的问题查过详情的那几遍都答对了——所以同库外目的地一样由引擎预取：
  // 会话里有明确的线路时，调模型之前先替它查一次 get_route_detail，走同一个 runTool（记录、观测、参数核正都一致）
  const DETAIL_ASK = new RegExp(
    [
      '几点',
      '住哪|住在哪|住什么|住的是|哪家酒店|什么酒店|酒店(?:是|叫|在哪)',
      '含不含|包不包|含吗|包吗|包含|包括|(?:含|包)(?:机票|餐|早餐|门票|保险|接送|酒水|签证|小费|吃|住)',
      '保险|自费|另付|机票|航班|飞机|接机|送机',
      '走路|步行|徒步|爬山|爬坡|台阶|累不累|累吗|累不|辛苦|强度|体力|腿脚|膝盖|轮椅|走得动|吃得消',
      '海拔|高反|高原反应',
      '第\\s*[几一二三四五六七八九十\\d]+\\s*天|最后一天|头一天|每天(?:怎么|都|几点)',
    ].join('|'),
  );

  /** 带着细节词、说的却不是细节：「住哪都行」「保险起见」「包括我妈在内一共3个人」「不包括孩子」「几点下班」「体力还行」 */
  const DETAIL_NOISE =
    /住(?:哪|哪儿|哪里|什么)(?:都|也)?(?:行|可以|随便|无所谓)|保险起见|包括[^，。,！？!?]{0,8}在内|不包括|几点下班|几点放假|体力(?:还行|还可以|没问题|挺好|很好)/g;
  const asksDetail = (text: string): boolean => DETAIL_ASK.test(text.replace(DETAIL_NOISE, ''));

  /**
   * 客户这句点到了焦点那条线以外的地方：我们没有的（「北海道住哪」），或别的线标题里才有的地名（「九寨海拔高吗」「稻城海拔多少」
   * 「拉萨海拔多高」）。这些地名不是目的地名也不是别名，routesIn 认不出，此前就退回报过价的那条，把云南线的详情当成九寨的答案塞给模型
   */
  function namesOtherPlace(text: string, focus: Route, routes: Route[]): boolean {
    if (offCatalogPlaces(text).length) return true;
    return routes.some(
      (r) =>
        r.destination !== focus.destination &&
        (r.title.replace(r.destination, ' ').match(/[一-鿿]{2,}/g) ?? []).some((w) =>
          [...w].slice(1).some((_, i) => {
            const bi = w.slice(i, i + 2);
            return (
              text.includes(bi) &&
              !focus.title.includes(bi) &&
              !GENERIC_TITLE_WORD.test(bi) &&
              !isOriginMention(text, bi) &&
              routes.every((o) => o.destination === r.destination || !o.title.includes(bi))
            );
          }),
        ),
    );
  }
  /** 标题里的泛称两字词，不算点了地名 */
  const GENERIC_TITLE_WORD =
    /全线|环线|秘境|深度|之旅|亲子|蜜月|度假|奢华|全景|双岛|浮潜|全包|海岛|美学|雨林|越野|摄影|纵贯|乐园|古城|极光|雪山|冰川|快车|日亲|日蜜/;

  /** 这轮要替模型预先查详情的线路 id（空数组 = 不预取）。客户这句自己点了两处不同的线（「北京和西安哪个累」）两条都查 */
  function planDetailPrefetch(session: Session, text: string): string[] {
    if (!asksDetail(text)) return [];
    const routes = loadRoutes();
    const own = routesIn(text, routes);
    if (own.length === 2 && own[0].destination !== own[1].destination) return own.map((r) => r.id);
    const r = routeInFocus(session, text, routes);
    // 这句自己没点线路、是按上下文推的焦点线：客户点了别处就不预取，交给模型自己查
    if (r && !own.length && namesOtherPlace(text, r, routes)) return [];
    return r ? [r.id] : [];
  }

  /** 客户提过高反、海拔：搜线路和查详情时附海拔提醒（见 tools.ts altitudeNoteFor） */
  const ALTITUDE_WORRY = /高反|高原反应|海拔|缺氧/;

  /**
   * 按客户原话认出的、工具那边认不全的情况（见 tools.ts ToolHints）。长辈沿用画像的客群口径（SEGMENT_RULES，
   * 按小句去掉「爸妈在家带娃」这类不同行的），不看模型传的 segment：实测客户说「婆婆72岁…也怕高反」，模型传的是「家庭」
   */
  function toolHints(session: Session): ToolHints {
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    return { elder: segmentsSaid(said).has('银发'), altitudeWorry: said.some((t) => ALTITUDE_WORRY.test(t)) };
  }

  // ---------- 三样齐全就报价 ----------
  // 线路、人数、日期都已给齐，模型仍不报价、还反问客户说过的信息：「我俩想12月28号出发」→「两个人出发吗？」；
  // 「国庆 2 个人 多少钱」只回「人均 15800 起」（国庆实价 17,380）；「下个月15号 俩大人」→「我按 11月15日出个报价？」。
  // 智谱的 tool_choice 强制不了调工具；预取 create_quote 又会写 lastQuote（成单安全网据此建单），不是只读工具，
  // 所以由引擎认出三样齐全，在会话状态里点名要这一轮报价、把参数写好
  const PRICE_ASK = /多少钱|多钱|报价|报个价|价格|价钱|什么价|啥价|怎么收费|费用|算一下|算下|重新算/;
  /** 「我俩」「俺娘俩」「就俩大人」：没带数字的两个人 */
  const PAIR = /我们俩|咱们俩|咱俩|我俩|两口子|小两口|夫妻俩|(?:娘|母女|母子|父子|父女|姐妹|兄弟)俩|俩\s*(?:大人|个人|人)|就俩/;
  /** 「1万5一个人」「两万一位」说的是每人价，不是这趟一个人去 */
  const PRICE_PER_HEAD = /[\d一二两三四五六七八九十]\s*(?:万|千|元|块)[\d一二三四五六七八九]?\s*(?:一个人|一人|一位|每人)/g;

  /** 这句话里客户说的出行人数：数得出返回人数，说了但算不出（增减、只数了大人）返回 'unclear'，没说返回 undefined */
  function travelersSaid(s: string): number | 'unclear' | undefined {
    const t = s.replace(PRICE_PER_HEAD, '');
    const n = headcountIn(t);
    if (typeof n === 'number') return n;
    if (n !== undefined) return 'unclear';
    return groupSizeIn(t) ?? (PAIR.test(t) ? 2 : undefined);
  }

  /** 这趟几个人：从客户最近说人数的那句往前找（改口以最新为准），再看报过价的人数 */
  function travelersKnown(session: Session, said: string[]): number | undefined {
    for (let i = said.length - 1; i >= Math.max(0, said.length - 12); i--) {
      const n = travelersSaid(said[i]);
      if (n === 'unclear') return undefined;
      if (n !== undefined) return n;
    }
    return session.lastQuote?.travelers;
  }

  /**
   * 三样齐全、还没按这三样报过价时，给模型的一句「这一轮报价」（附在会话状态后面）；否则 undefined。
   * 只在这句话本身带着报价要素（日期、人数、问价，或点名了线路而不是在问细节）时才提：客户问「住哪」时插一句报价是答非所问。
   * 客户在下单（成单安全网与 create_order 的事）、同参数已报过价或已下过单时不提。
   * 日期按客户原话读（节假日也算，国庆按 10 月 1 日报，和 groundToolArgs 补日期同一口径）
   */
  function quoteTimingNote(session: Session, text: string): string | undefined {
    if (PURCHASE_INTENT.test(text)) return undefined;
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    const d = latestDepart(said)?.pick;
    const iso = d?.kind === 'date' && d.iso && d.iso >= todayIso() ? d.iso : undefined;
    if (!iso) return undefined;
    // 问细节的话里顺口带了人数、线路（「我俩都怕累，北京那条累不累」）不算，得是说了日期或在问价
    const cue =
      readDepartDates(text).pick ||
      PRICE_ASK.test(text) ||
      (!asksDetail(text) && (travelersSaid(text) !== undefined || routesIn(text, loadRoutes()).length > 0));
    if (!cue) return undefined;
    const route = routeInFocus(session, text);
    const n = travelersKnown(session, said);
    if (!route || !n) return undefined;
    const q = session.lastQuote;
    if (q && q.routeId === route.id && q.travelers === n && q.departDate === iso) return undefined;
    const ordered = session.orderIds
      .map((id) => getOrder(id))
      .some((o) => o && o.status !== 'cancelled' && o.routeId === route.id && o.travelers === n && o.departDate === iso);
    if (ordered) return undefined;
    // 节假日只是个大概：点名时说「国庆出发」，不写成「10月1号出发」——模型会照抄给客户，下单时却又要问具体哪天，前后矛盾
    const holiday = d?.kind === 'date' && !d.exact ? holidayIn(latestDepart(said)?.text ?? '', iso) : undefined;
    const when = holiday ? `${holiday}出发（按 ${Number(iso.slice(5, 7))} 月的季节价报，参数照填 ${iso}）` : `${cnDate(iso)}出发`;
    return (
      `报价时机：客户已给齐线路、人数、出发日期——《${route.title}》、${n} 位、${when}。` +
      `这一轮直接调 create_quote（routeId=${route.id}，travelers=${n}，departDate=${iso}），把每人价、人数、总价报给客户，` +
      '不要再问线路、人数、日期这几样。' +
      (holiday ? `回复里只说「${holiday}出发」，不要写成具体哪一天；下单前再问具体哪天。` : '')
    );
  }

  /**
   * 客户提过带娃、这句只报了个人数（「两位 12号」），而线路还有两三条候选、这一轮报不了价（flow-07）：报价时的人数口径
   * 附在 create_quote 的结果上（见 groundToolArgs 的 headcountNote），没报价就没地方附——模型只问「选哪条」，孩子算没算没人问，
   * 还有一次写成了「两位大人」。所以放进会话状态，要它在问选哪条的同一句里顺带问一句
   */
  function headcountAskNote(session: Session, text: string): string | undefined {
    const n = travelersSaid(text);
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    if (typeof n !== 'number' || !kidsHeadcountUnclear(said)) return undefined;
    return (
      `人数口径：客户提过带孩子，这句只说了 ${n} 位，没说清算没算上小朋友。能报价就按 create_quote 结果里的 headcountNote 说；` +
      `线路还没定、要先问选哪条时，在问选哪条的同一句里顺带问一句「这 ${n} 位里算上小朋友了吗？」。客户没说「大人」，不要写成「${n} 位大人」。`
    );
  }

  // ---------- 只有客户说了算的参数：按客户原话核一遍 ----------
  // 预算、客群、出发日期是客户的事，模型却会替他编：glm-5.3-flashx 实测客户只说了「有点贵」，
  // 它调 search_routes 时自己加上每人 2 万、亲子（另一次 2 人北京游加的是蜜月），工具据此算出
  // 「超预算」差额，模型对客户说「比两万的档高出一些」；反过来客户说了「国庆出发」，报价时它又常漏传日期。
  // 提示词压不住这种偶发，按本项目一贯做法放在代码层：模型发起的调用和引擎预取都经 runTool 走到这里。

  /** 「至少每人3万」「3万以上」「5万起」「8000以上」：说的是下限，当成上限会把更贵的线路藏掉。
   *  必须连着钱说：此前单位可省，「一起去」的「一起」、「至少玩5天」「最少也得住五星」都被当成预算下限，
   *  客户说过的两万跟着被丢掉。不带单位的只认三位数以上（「8000以上」），「5天以上」「3人以上」不算 */
  const BUDGET_FLOOR = new RegExp(
    [
      '(?:至少|起码|最少|不低于|不少于)[^，。,！？!?\\d一二两三四五六七八九十]{0,4}[\\d一二两三四五六七八九十][\\d.一二两三四五六七八九十]*\\s*(?:万|千|元|块)',
      '[\\d一二两三四五六七八九十]\\s*(?:万|千|元|块)[\\d一二三四五六七八九]?\\s*(?:以上|起步|起(?!码)|往上|打底)',
      '\\d{3,}\\s*(?:以上|起步|起(?![码飞])|往上|打底)',
    ].join('|'),
  );

  /** 「一万到两万」「8000-12000」：区间只有上端能当上限。价格护栏的区间解析只认「两三万」「八到九千」这种，
   *  「一万到两万」两头各读成一个数，这里单独认 */
  const BUDGET_RANGE = /[\d一二两三四五六七八九十]\s*(?:万|千|元|块)?\s*(?:到|至|-|－|~|～|—)\s*[\d一二两三四五六七八九十]/;

  /**
   * 按客户原话核过的每人预算上限；undefined 表示不传 maxBudgetPerPerson。看客户最近一次说预算的那句话（改口以最新为准；
   * 说机票钱、别家的价、嫌某条线贵的话跳过，见 isBudgetTalk）：
   *   · 读得出每人上限（「每人两万」「人均8000」）→ 用客户的数，模型传的不一样也换成客户的；
   *   · 说了钱但不是每人上限（「预算5万」「一万到两万」）→ 模型传的数对得上原话才用：就是客户说的数，
   *     或是总数 ÷ 客户说过的人数；区间只认上端。说的是下限（「3万以上」）就不传；
   *   · 客户从没说过钱 → 不传。
   * 金额的读法与价格护栏的「客户说过的数」同一套（spokenMoney），两边才不会一个认、一个不认。
   */
  function statedBudgetCap(said: string[], modelCap: number, session: Session): number | undefined {
    for (let i = said.length - 1; i >= 0; i--) {
      if (liftsBudget(said[i])) return undefined; // 「预算不是问题」：之前说的数不再是上限（见 price-rules BUDGET_LIFTED）
      const { amounts, rangeEnds } = spokenMoney(said[i]);
      if (!amounts.length || !isBudgetTalk(said[i])) continue;
      const cap = perPersonBudget(said[i]);
      if (cap) return cap;
      if (BUDGET_FLOOR.test(said[i])) return undefined;
      const pool = rangeEnds.length || BUDGET_RANGE.test(said[i]) ? [Math.max(...amounts)] : amounts;
      const heads = [...said.map(headcountIn), ...said.map(groupSizeIn), /^(\d+)人$/.exec(session.profile.travelers ?? '')?.[1]]
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 1);
      return pool.some((a) => a === modelCap || heads.some((h) => Math.round(a / h) === modelCap)) ? modelCap : undefined;
    }
    return undefined;
  }

  /** 明说是总数的预算：「两个人预算一共3万」「全家总预算6万」 */
  const TOTAL_BUDGET = /一共|总共|总预算|合计|加起来|总计|全家|全部/;

  /**
   * 客户说过、读得准的每人预算上限——模型没传 maxBudgetPerPerson 时由引擎补上（见 groundToolArgs）。
   * A04：客户说「两个人预算一共3万左右」，模型查线路两遍都没传预算，工具算不出差额，模型就自己判断，
   * 对客户说「两位的话在 3 万预算内完全可行」（巴厘岛两位 45,600）。看客户最近一次说预算的那句（口径同 statedBudgetCap）：
   *   · 每人上限（「每人两万」）→ 就是它；
   *   · 明说是总数（「一共」「总预算」）、人数也知道 → 按人数折成每人，total 带着原话给提示用；
   *   · 下限、说不清是每人还是总共（「两个人预算5万」）→ 不补，交给 statedBudgetCap 核模型自己传的数。
   */
  function customerBudget(said: string[], session: Session): { cap: number; total?: number; heads?: number; text?: string } | undefined {
    for (let i = said.length - 1; i >= 0; i--) {
      // 客户后来把预算放开了（「算了 预算不是问题 想住好一点的」）：此前这句没带数、被跳过，照旧按「一共3万」折成每人 15000 补进去（第三轮复核 B1/B2）
      if (liftsBudget(said[i])) return undefined;
      const { amounts, rangeEnds } = spokenMoney(said[i]);
      if (!amounts.length || !isBudgetTalk(said[i])) continue;
      const cap = perPersonBudget(said[i]);
      if (cap) return { cap };
      if (BUDGET_FLOOR.test(said[i]) || !TOTAL_BUDGET.test(said[i])) return undefined;
      const heads = travelersKnown(session, said);
      const total = Math.max(...(rangeEnds.length ? rangeEnds : amounts));
      return heads && total >= 1000 ? { cap: Math.round(total / heads), total, heads, text: cleanText(said[i], 40) } : undefined;
    }
    return undefined;
  }

  /**
   * 执行前把只有客户说了算的参数按原话核一遍，返回核过的参数和要附进工具结果、提醒模型的话：
   *   · search_routes：预算见 statedBudgetCap；客群只在客户说过时才用，对不上的换成客户说的、客户没说就不传
   *    （银发除外，模型传了就留着；模型没传时同样补上客户这句刚说的——画像要等本轮结束才更新，「带爸妈去西藏」这句就得按银发查）；
   *     标签里的客群名同理，标签是硬过滤，编一个「亲子」就能把整个目的地滤空。
   *   · create_quote / generate_proposal 漏传出发日期：客户说过就补上（节假日也算），客户没说不补。
   *   · create_order 的日期模型传了、却不是客户最近明说的出发日子：按客户说的。「国庆」这种节假日只是个大概，
   *     模型问清后下单用的具体日子不改；客户写明年份的过去日期由 runTool 前面的 statedPastDate 拦，这里不碰。
   *   · generate_proposal 的日期只认客户说的：模型自己编的删掉（A10：客户说「明年7月」，方案书链接成了 /2027-07-01）。
   *   · create_quote 在客户只说到月份时（「12月初」「明年7月」）按那个月定季节价（B15：「12月初」按标准价报，少了旺季 10%）。
   *   · create_order 不执行、返回 error 的两种：客户最近说的出发时间是个大概、模型的日子又不是客户说出来的；
   *     客户在说给别人另订一份，而同一条线上已有客户本人那张待付款单（再下一单会把它作废，复用又会把它当成别人的）。
   */
  function groundToolArgs(
    name: string,
    args: Record<string, unknown>,
    session: Session,
  ): { args: Record<string, unknown>; notes: Record<string, string>; error?: string } {
    const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
    const out: Record<string, unknown> = { ...args };
    const notes: Record<string, string> = {};
    const fixed: string[] = [];
    let error: string | undefined;
    if (name === 'search_routes') {
      const told = customerBudget(said, session);
      if (told) {
        // 客户说得清的预算照客户的来：模型没传就补上，传的不一样就换掉（总预算不能当每人上限传）
        if (out.maxBudgetPerPerson !== told.cap) fixed.push(`预算 ${String(out.maxBudgetPerPerson ?? '未传')}→${told.cap}`);
        out.maxBudgetPerPerson = told.cap;
        if (told.total) {
          notes.budgetNote =
            `客户说的预算是「${told.text}」——一共 ${told.total} 元、${told.heads} 位，这次按折合每人 ${told.cap} 元比的。` +
            '转述时用客户自己的说法（一共多少、几位），超了多少只用 overBudget 里给的每人差额；超了就不要说「在您预算内」「预算很宽裕」「完全可行」。';
        }
      } else if (out.maxBudgetPerPerson !== undefined) {
        const cap = statedBudgetCap(said, Number(out.maxBudgetPerPerson), session);
        if (cap !== out.maxBudgetPerPerson) fixed.push(`预算 ${String(out.maxBudgetPerPerson)}→${cap ?? '不传'}`);
        if (cap) out.maxBudgetPerPerson = cap;
        else {
          delete out.maxBudgetPerPerson;
          const lifted = said.toReversed().find((t) => liftsBudget(t) || (spokenMoney(t).amounts.length > 0 && isBudgetTalk(t)));
          notes.budgetNote =
            lifted && liftsBudget(lifted)
              ? `客户说了「${cleanText(lifted, 30)}」，预算放开了，这次没按预算筛。不要再拿之前说的预算比、说超了多少，也不要再问预算。`
              : '客户没说过每人预算（或说的不是每人上限），这次没按预算筛。不要替客户假设预算，' +
                '也不要说「比您的预算高/低多少」；想按价位挑，直接问客户每人预算大概多少。';
        }
      }
      const segs = segmentsSaid(said);
      // 银发不剥：它是唯一的硬安全过滤，传错了只是高原线被标出来（点了目的地时）或少看几条，剥错了就是给老人推
      // 5200 米的西藏线——而「我母亲」「老两口」这类说法 SEGMENT_RULES 总有认不全的
      if (out.segment !== undefined && out.segment !== '银发' && !segs.has(out.segment as SalesSegment)) {
        notes.segmentNote = `客户没说过是${String(out.segment)}出行，不要替客户认定同行人，也不要把线路说成是为${String(out.segment)}挑的。`;
        fixed.push(`客群 ${String(out.segment)}→不认`);
        delete out.segment;
      }
      if (out.segment === undefined) {
        const seg = latestSegment(said);
        if (seg) out.segment = seg;
      }
      if (Array.isArray(out.tags)) {
        const tags = out.tags.filter((t) => !(SALES_SEGMENTS as unknown[]).includes(t) || segs.has(t as SalesSegment));
        if (tags.length < out.tags.length) fixed.push(`标签 ${out.tags.join('/')}→${tags.join('/') || '不传'}`);
        if (tags.length) out.tags = tags;
        else delete out.tags;
      }
    } else if (name === 'create_quote' || name === 'generate_proposal' || name === 'create_order') {
      const latest = latestDepart(said);
      const d = latest?.pick;
      const iso = d?.kind === 'date' && d.iso && d.iso >= todayIso() ? d.iso : undefined;
      // 方案书的日期印在客户手里的正式文件上，只能是客户说的那天（节假日按引擎的读法）；模型编的删掉，下面再按客户说的补
      if (
        name === 'generate_proposal' &&
        out.departDate !== undefined &&
        out.departDate !== iso &&
        !latest?.exact.includes(String(out.departDate))
      ) {
        fixed.push(`方案书日期 ${String(out.departDate)}→删（客户没说过这天）`);
        delete out.departDate;
      }
      if (iso && !out.departDate && name !== 'create_order') {
        out.departDate = iso;
        fixed.push(`补出发日期 ${iso}`);
      }
      // 客户只说了节假日（「国庆」）：按那天定季节价，回复里只说「国庆出发」——和只说到月份的一样（见下面 departNote）
      if (
        name !== 'create_order' &&
        d?.kind === 'date' &&
        !d.exact &&
        iso &&
        out.departDate === iso &&
        latest &&
        !/当天|那天|第一天|头一天/.test(latest.text)
      ) {
        const h = holidayIn(latest.text, iso) ?? '节假日';
        notes.departNote =
          `客户只说了${h}出发、没说具体哪天，这次按 ${Number(iso.slice(5, 7))} 月的季节价算的。` +
          `回复里只说「${h}出发」，不要写成 ${cnDate(iso)}；要下单时先问清具体哪天出发。`;
      }
      if (
        // 模型的日子是客户在那句话里明说过的出发日子就不改：一句话里说了两个日子时引擎的读法未必比模型准，
        // 改错了就是按返程那天建了真实订单。只看最近说日期的那句——更早说过、后来改掉的日子不算
        iso &&
        d?.kind === 'date' &&
        d.exact &&
        name === 'create_order' &&
        out.departDate !== iso &&
        !latest?.exact.includes(String(out.departDate))
      ) {
        fixed.push(`下单日期 ${String(out.departDate)}→${iso}`);
        out.departDate = iso;
      }
      // 只说到月份：报价按那个月的季节价算（季节价只看月份，取那个月里的一天就够），回复里只说「X月出发」
      const ym = d?.kind === 'vague' && latest ? monthSaid(latest.text) : undefined;
      const monthDay = ym ? dayInMonth(ym) : undefined;
      if (name === 'create_quote' && ym && monthDay) {
        const prefix = monthDay.slice(0, 8);
        // 「过完年」这种说法，模型填的那个月里的某天（B09 的 2027-02-20）也是它编的：一律换成拿来定季节价的那天
        if (typeof out.departDate !== 'string' || !out.departDate.startsWith(prefix) || (ym.said && out.departDate !== monthDay)) {
          fixed.push(`按月份定季节价 ${String(out.departDate ?? '未传')}→${monthDay}`);
          out.departDate = monthDay;
        }
        MONTH_ONLY_ARGS.add(out);
        const when = ym.said ?? `${ym.mo}月`;
        notes.departNote =
          `客户只说了${when}出发、没说具体哪天，这次按${ym.mo}月的季节价算的。` +
          `回复里只说「${when}出发」，不要写成具体哪一天；要下单时先问清具体哪天出发。`;
      }
      // 客户最近说的出发时间是个大概（「国庆」「12月初」「明年7月」），模型却拿一个具体日子下单：A18 实测客户说「国庆」，
      // 报价按引擎补的 10-01 出，客户回「行 订吧」，模型直接 create_order(10-01)——客户从没说过哪天走。
      // 下单是真实副作用，这一天必须是客户说出来的：这句或最近说出发时间的那句里说了那天（「3号」「十月三号」），
      // 或是答应了上一条里问的那天（「10月3日出发可以吗？」「可以」）
      if (
        name === 'create_order' &&
        latest &&
        d &&
        (d.kind === 'vague' || !d.exact) &&
        typeof out.departDate === 'string' &&
        !latest.exact.includes(out.departDate) &&
        !customerNamedDay(session, latest.text, out.departDate, d.kind === 'date' ? d.iso : undefined)
      ) {
        error =
          `客户说的出发时间还只是个大概（原话「${cleanText(latest.text, 30)}」），没说具体哪天，这次没有下单。` +
          '先直接问客户具体哪天出发（如「国庆具体哪天走？」），客户说了日子再调 create_order；不要自己挑一天，也不要说已经下单。';
      }
      // 给别人另订一份（见 otherPartyPending）：成单安全网走的是同一个判断
      if (name === 'create_order' && !error) {
        const mine = otherPartyPending(session, out.routeId, Number(out.travelers));
        if (mine) {
          error =
            `客户是要给别人另订一份。本会话已有客户本人那张待付款订单（${mine.travelers} 位 / ${mine.departDate} 出发），` +
            '同一条线在这里再下单会把那张作废，所以这次没有下单。不要说已经订好，也不要把客户本人那张单的链接当成别人的发出去。' +
            '问客户：要合并成一单按总人数重新下，还是请顾问另外单独下一单（客户选单独下，就调 handoff_to_human）。';
        }
      }
      const n = Number(out.travelers);
      if (Number.isInteger(n) && n > 0 && kidsHeadcountUnclear(said)) {
        notes.headcountNote =
          name === 'create_order'
            ? `客户提过带孩子，但没说清这 ${n} 位里算没算上小朋友。确认订单时复述一句「这单按 ${n} 位出行下的」，` +
              '并说如果小朋友还没算进去，告诉你孩子几岁，按实际人数重新下单。'
            : `客户提过带孩子，但没说清这 ${n} 位里算没算上小朋友，这次先按 ${n} 位算的。回复里顺带一句口径：` +
              `「先按 ${n} 位报的；如果是 ${n} 位大人再带小朋友，告诉我孩子几岁，我按实际人数重算」。只顺带说这一句，不要另起一轮追问。`;
      }
    }
    if (fixed.length) console.warn(`[engine] ${name} 参数按客户原话核正（会话 ${convLabel(session.id)}）：${logQuote(fixed.join('；'))}`);
    if (error) console.warn(`[engine] ${name} 未执行（会话 ${convLabel(session.id)}）：${logQuote(error)}`);
    return { args: out, notes, error };
  }

  // 客户提过带娃、却只报了个人数（「不用倒时差 带娃能玩水」→「两位 12号」），这个数算没算孩子没人知道。
  // 实测 3/3 按 2 人报价、2/3 按 2 人下了单，从没确认过——而三亚那条按人头计价，水世界通票也是每人一份。
  // SOP 里写了要顺带说口径，但模型照不照做看运气，所以由引擎按客户原话判断，把提醒附进报价/方案书/下单的工具结果。
  // 说清了的不提醒：大人小孩各几位、总人数、一家几口、孩子几岁（知道有个几岁的孩子，模型自会按人头算）
  const KID_MENTION = /带娃|[俩两几个]娃|孩子|小孩|宝宝|儿子|女儿|小朋友|幼儿|儿童|亲子/;
  const HEADCOUNT_SPLIT = new RegExp(
    '(?:\\d{1,2}|[一二两三四五六七八九十])\\s*(?:个|位|名)?\\s*大人?\\s*(?:[，,、和加带+]\\s*)?' +
      '(?:\\d{1,2}|[一二两三四五六七八九十])\\s*(?:个|位|名)?\\s*(?:小孩|孩子|儿童|娃|小朋友|宝宝|婴儿|小)',
  );
  const KIDS_SETTLED = new RegExp(
    [
      '一家[三四五六七]口',
      '(?:孩子|小孩|小朋友|娃|宝宝|儿子|女儿)\\s*(?:\\d{1,2}|[一二两三四五六七八九十]{1,2})\\s*(?:周)?岁',
      '(?:\\d{1,2}|[一二两三四五六七八九十]{1,2})\\s*(?:周)?岁的?(?:孩子|小孩|小朋友|娃|宝宝|儿子|女儿)',
      '(?:孩子|小孩|小朋友|娃)(?:也|都)?(?:算上|算|不算|含|包括)',
      '(?:含|包括|算上)(?:了)?(?:孩子|小孩|小朋友|娃)',
      // 「我和儿子两个人」：孩子就在这个数里
      '和(?:孩子|小孩|儿子|女儿|娃|宝宝)[^，。,.]{0,3}(?:\\d|[两俩三四五])\\s*(?:个人|个|人|位)',
      // 「不带孩子」「孩子不去」：说清了没有孩子
      '(?:不|没|没有)(?:带|有)?(?:孩子|小孩|小朋友|娃)|(?:孩子|小孩|小朋友|娃)(?:不|没)(?:去|跟|带|来)',
      // 「大人两个，小孩一个」：数字写在后面
      '大人\\s*(?:\\d{1,2}|[一二两三四五六七八九十])\\s*(?:个|位|名)?[^。.]{0,3}(?:小孩|孩子|儿童|小朋友|娃)\\s*(?:\\d{1,2}|[一二两三四五六七八九十])',
      // 「我们俩带个娃」「我和老公带女儿」「两口子带一个孩子」：两个大人加几个孩子，组成说清了
      '(?:我们俩|我俩|咱俩|两口子|小两口|夫妻俩|我(?:和|跟)(?:老公|老婆|爱人|先生|太太|媳妇|对象))[^，。,.]{0,4}' +
        '带(?:着)?(?:个|一个|两个|俩|三个)?(?:娃|孩子|小孩|小朋友|宝宝|儿子|女儿)',
      // 「两个孩子，四个人」：孩子几个、总共几个都说了
      '(?:\\d|[一二两三四五])\\s*个(?:孩子|小孩|娃|小朋友)[^。.]{0,6}(?:\\d{1,2}|[两三四五六七八九十])\\s*(?:个人|口人|位)',
      '(?:\\d{1,2}|[两三四五六七八九十])\\s*(?:个人|口人|位)[^。.]{0,6}(?:\\d|[一二两三四五])\\s*个(?:孩子|小孩|娃|小朋友)',
    ].join('|'),
  );
  // 儿子/女儿不一定是随行的小朋友：「女儿给我们老两口订的」「儿子让我们出去走走」说的是成年子女。
  // 此前照样当成带娃，报价时追问一对老夫妻「孩子几岁」
  const GROWN_CHILD_BOOKER = /(?:儿子|女儿|孩子|儿女|子女)(?:们)?(?:给|帮|让|替|陪|带|送)(?:我们|我俩|咱们|我和|老两口|爸妈|我爸|我妈)/g;
  const ELDER_CONTEXT = /老两口|老伴|我们老|退休|我(?:和|跟)老伴/;
  function kidsHeadcountUnclear(said: string[]): boolean {
    const elder = said.some((t) => ELDER_CONTEXT.test(t));
    const mentionsKid = (t: string): boolean => {
      let s = travellingText(t).replace(GROWN_CHILD_BOOKER, '');
      if (elder) s = s.replace(/儿子|女儿|儿女|子女/g, ''); // 老两口嘴里的儿子女儿是成年人；孙辈另有说法（孩子/娃/孙子）
      return KID_MENTION.test(s);
    };
    return said.some(mentionsKid) && !said.some((t) => HEADCOUNT_SPLIT.test(t) || hasTotalHeadcount(t) || KIDS_SETTLED.test(t));
  }

  /**
   * 把提醒附进工具结果，模型才看得到：search_routes 附在每一条线路上（与 overBudget / daysMiss 同一个位置），
   * 报价、方案书、下单的结果是单个对象，直接并进去。工具报错时不附——模型要先改参数重试，提醒留给成功的那次
   */
  function withNotes(result: string, notes: Record<string, string>): string {
    if (!Object.keys(notes).length) return result;
    try {
      const parsed: unknown = JSON.parse(result);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map((r) => (r && typeof r === 'object' ? { ...r, ...notes } : r)));
      if (parsed && typeof parsed === 'object' && !('error' in parsed)) return JSON.stringify({ ...parsed, ...notes });
      return result;
    } catch {
      return result;
    }
  }

  function statedPastDate(text: string): string | null {
    return parseStatedPastDate(text, todayIso());
  }

  const hooks: Pick<PackRuntime<TravelTurnTypes>, 'contextNote' | 'preModel' | 'prefetch' | 'beforeTool' | 'afterTool'> = {
    contextNote,
    preModel({ session, text }): DeterministicReply | null {
      const reply = resendPayReply(session, text);
      return reply ? { text: reply } : null;
    },
    async prefetch(ctx): Promise<PrefetchResult> {
      const calls: PrefetchResult['calls'] = [];
      const timings: string[] = [];
      try {
        for (const args of planPrefetch(ctx.session, ctx.text)) {
          const t = Date.now();
          const call = await ctx.callTool('search_routes', args);
          timings.push(`search_routes ${Date.now() - t}ms`);
          calls.push(call);
        }
        // 在搜索写入展示状态之后认焦点线，与旧预取顺序一致。
        for (const routeId of planDetailPrefetch(ctx.session, ctx.text)) {
          const t = Date.now();
          const call = await ctx.callTool('get_route_detail', { routeId });
          timings.push(`get_route_detail ${Date.now() - t}ms`);
          calls.push({ ...call, args: { routeId } });
        }
      } catch (e) {
        // 只优化模型输入；失败保留此前成功的结果，交给模型自己查。
        console.error('[engine] 预取线路失败（交给模型自己查）:', e);
      }
      return { calls, timings };
    },
    beforeTool(name, input, ctx) {
      const modelArgs = input as Record<string, unknown>;
      const said = statedPastDate(ctx.text);
      if (
        said &&
        (name === 'create_order' || name === 'create_quote') &&
        modelArgs.departDate !== undefined &&
        modelArgs.departDate !== said
      ) {
        return { reject: `客户说的出发日期是 ${said}，这是过去的日期。不要自行改成其他年份，请直接问客户确认真实的出发日期后再下单。` };
      }
      const { args, notes, error } = groundToolArgs(name, modelArgs, ctx.session);
      if (error) return { reject: error };
      if (name === 'handoff_to_human' && unwarrantedHandoff(ctx.session, ctx.text, String(modelArgs.reason ?? ''))) {
        ctx.handoffDeclined = true;
        console.warn(
          `[engine] 驳回转人工：客户没坚持原目的地（会话 ${convLabel(ctx.session.id)}）：${logQuote(String(modelArgs.reason ?? ''))}`,
        );
        return { reject: HANDOFF_DECLINED };
      }
      ctx.args = args;
      ctx.notes = notes;
      return { args };
    },
    afterTool(name, result, { session, args }) {
      // 调用和完整结果已由注册表记录；没有执行的调用不进入这里。
      if (name === 'search_routes' && typeof args.destination === 'string' && result.includes('"destinationMiss"')) {
        const at = Date.now();
        const places = args.destination.split(/[、,，\s]+/).filter(Boolean);
        session.missedDestinations = [
          ...(session.missedDestinations ?? []).filter((m) => !places.includes(m.place)),
          ...places.map((place) => ({ place, at })),
        ].slice(-6);
      }
    },
  };
  function hintsFor(name: string, { session, text }: TurnToolContext): ToolHints {
    return name === 'handoff_to_human'
      ? { ...toolHints(session), handoff: { quote: cleanText(text, 200), departNote: departNoteForHandoff(session) } }
      : toolHints(session);
  }
  return {
    ...hooks,
    hintsFor,
    withNotes,
    isMonthOnly: (args: object) => MONTH_ONLY_ARGS.has(args),
    PURCHASE_INTENT,
    PURCHASE_INTENT_MAX_LEN,
    OTHER_ORDER,
    REFUND_REQUEST,
    CHANGE_REQUEST,
    PRICE_ASK,
    WANTS_PERSON,
    DEMANDS_EXCEPTION,
    titleWordHit,
    RESEND_ASK,
    BUDGET_FLOOR,
    TARGET_DAYS,
    haggling,
    cardDate,
    destinationsInText,
    destinationMentions,
    deterministicRecommend,
    pendingOrder,
    talksOtherOrder,
    otherPartyPending,
    askOtherOrder,
    requestedDays,
    customHandoffReply,
    cnDate,
    routeMentioned,
    routeNamed,
    neutralizeStandardDays,
    isComplaint,
    isHandoffIntent,
    unwarrantedHandoff,
    statedPastDate,
    readDepartDates,
    spokenDepartDate,
    latestDepart,
    resolveDepartDate,
    monthSaid,
    orderDepartDate,
    departNoteForHandoff,
    planPrefetch,
    perPersonBudget,
    planDetailPrefetch,
    quoteTimingNote,
    routeInFocus,
    routesIn,
    toolHints,
    travelersKnown,
    kidsHeadcountUnclear,
  };
}
