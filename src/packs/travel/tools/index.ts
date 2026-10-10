// 七个旅游工具。顺序与原 toolDefs 相同；本步声明缓存/重试政策，模型客户端第 11 步再读取。
import { toolDefs, isValidIsoDate, cleanText, type ToolSpec, type TravelToolSources } from '../../../core/pack-api.js';
import { createTravelCatalog, HANDOFF_NOTE, proposalVersionSuffix, type SearchRoutesArgs } from './catalog.js';

export function createTravelTools(sources: TravelToolSources) {
  const catalog = createTravelCatalog(sources);
  const {
    loadRoutes,
    searchRoutes,
    searchHotels,
    visitedDestinations,
    routeDetail,
    createQuote,
    routeVersion,
    rememberShownRoutes,
    rememberSeenRoutes,
    rememberQuote,
    rememberQuoteHistory,
    advisorPayNote,
    parseTravelers,
    pastDateError,
  } = catalog;
  const {
    budgetVerdict,
    createOrder,
    getOrder,
    queueJobs,
    saveSession,
    supersedeOrder,
    paymentMode,
    orderUnconfirmedNotifyOps,
    enterHandoff,
  } = sources;
  const toolError = (msg: string): string => JSON.stringify({ error: msg });
  const tools: ToolSpec[] = [
    {
      def: toolDefs[0]!,
      sideEffects: ['session'],
      cacheable: true,
      blocksRetry: false,
      onReuse(result, { session }) {
        // 与旧 engine.onReuse 相同：仅重放可识别的展示行，不重放预算差额或调用记录。
        try {
          const rows: unknown = JSON.parse(result);
          if (Array.isArray(rows))
            rememberShownRoutes(
              session,
              rows.filter(
                (r): r is { id: string; title: string; priceFrom: number } =>
                  !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string',
              ),
            );
        } catch {
          /* 工具报错返回的非 JSON 没有展示状态可重放 */
        }
      },
      async execute(input, { session, hints }) {
        const args = input as Record<string, unknown>;
        const elder = !!hints.elder || session.profile.segment === '银发';
        // 客群从画像自动补齐。只把 segment 写进工具描述是不够的——模型常常漏传，
        // 一漏传硬约束就形同虚设：画像明明认出是银发，照样能查到 5200 米的珠峰线。
        // 引擎已用确定性正则把客群沉淀到 profile，这里兜底注入，模型显式传的优先。
        const a = args as SearchRoutesArgs;
        if (!a.segment && session.profile.segment) a.segment = session.profile.segment;
        // 引擎在调工具前已把客户这句话记进会话，最后一条客户消息就是这轮的原话
        const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
        const found = await searchRoutes(a, {
          customerText: said.at(-1),
          visited: visitedDestinations(said),
          elder,
          altitudeWorry: hints.altitudeWorry,
        });
        // 工具替模型算好的超预算差额记进会话：价格护栏据此认出「比您预算多 6,800 元」
        // 是工具给的数。只留最近几次搜索的，旧的差额早已不在对话焦点里
        const gaps = found
          .map((r) => (r as Record<string, unknown>).gapPerPerson)
          .filter((g): g is number => typeof g === 'number' && g > 0);
        // 预算上限本身也记下：客户说的是总预算时，引擎按人数折成了每人数（见 engine.ts groundToolArgs），
        // 超预算提示里写的就是这个折算数——模型照着说「折合每人 15,000」，价格护栏不能当它是编的
        if (typeof a.maxBudgetPerPerson === 'number' && a.maxBudgetPerPerson > 0) gaps.push(a.maxBudgetPerPerson);
        if (gaps.length) session.budgetGaps = [...new Set([...(session.budgetGaps ?? []), ...gaps])].slice(-9);
        rememberShownRoutes(session, found);
        return JSON.stringify(found);
      },
    },
    {
      def: toolDefs[1]!,
      sideEffects: ['session'],
      cacheable: true,
      blocksRetry: false,
      onReuse: undefined,
      async execute(input, { session, hints }) {
        const args = input as Record<string, unknown>;
        const elder = !!hints.elder || session.profile.segment === '银发';
        const route = loadRoutes().find((r) => r.id === args.routeId);
        if (!route) return JSON.stringify({ error: `线路不存在: ${String(args.routeId)}` });
        rememberSeenRoutes(session, [route.id]);
        return JSON.stringify(routeDetail(route, { elder, altitudeWorry: hints.altitudeWorry }));
      },
    },
    {
      def: toolDefs[2]!,
      sideEffects: [],
      cacheable: false,
      blocksRetry: false,
      onReuse: undefined,
      async execute(input) {
        const args = input as Record<string, unknown>;
        return JSON.stringify(searchHotels(args as Parameters<typeof searchHotels>[0]));
      },
    },
    {
      def: toolDefs[3]!,
      sideEffects: ['session'],
      cacheable: false,
      blocksRetry: false,
      onReuse: undefined,
      async execute(input, { session }) {
        const args = input as Record<string, unknown>;
        if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
        const travelers = parseTravelers(args.travelers);
        if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
        if (args.departDate !== undefined) {
          if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
          const past = pastDateError(args.departDate);
          if (past) return toolError(past);
        }
        const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
        // 记住报价上下文，供成单安全网兜底下单；金额同时是价格护栏的白名单来源
        session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
        rememberQuoteHistory(session);
        rememberSeenRoutes(session, [args.routeId]);
        // 客户说过预算就替模型比好：在不在预算内、超多少。此前模型自己判断，报了每人 31,680 还说「在您 3 万预算内」。
        // 差额记进 budgetGaps，模型转述「比您预算多 1,680 元」时价格护栏才认得出
        const budget = budgetVerdict(session, q);
        if (budget?.gap) session.budgetGaps = [...new Set([...(session.budgetGaps ?? []), budget.gap])].slice(-9);
        saveSession(session);
        // 日期可能是引擎按客户原话补上的（见 engine.ts groundToolArgs），带回去模型才知道这是按哪天算的价
        return JSON.stringify({ ...q, ...(args.departDate ? { departDate: args.departDate } : {}), ...budget?.fields });
      },
    },
    {
      def: toolDefs[4]!,
      sideEffects: ['session'],
      cacheable: false,
      blocksRetry: false,
      onReuse: undefined,
      async execute(input, { session }) {
        const args = input as Record<string, unknown>;
        if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
        const travelers = parseTravelers(args.travelers);
        if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
        if (args.departDate !== undefined) {
          if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
          const past = pastDateError(args.departDate);
          if (past) return toolError(past);
        }
        const route = loadRoutes().find((r) => r.id === args.routeId);
        if (!route) return toolError(`线路不存在: ${String(args.routeId)}`);
        if (!route.itinerary?.length) return toolError(`线路 ${route.id} 暂无逐日行程数据，无法出方案书`);
        const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
        session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
        rememberQuoteHistory(session);
        rememberSeenRoutes(session, [route.id]);
        saveSession(session);
        // 无状态链接：参数编进 URL，页面按同一套规则重算，不引入新的持久化与清理负担。线路改过内容（版本大于 1）时带 ?v=，
        // 页面按这个版本的内容算，之后再改价也不变（02「报价快照」）；版本 1 的链接与开工时逐字节相同
        const url =
          `/proposal/${route.id}/${travelers}` +
          (args.departDate ? `/${String(args.departDate)}` : '') +
          proposalVersionSuffix(routeVersion(route.id));
        return JSON.stringify({
          proposalUrl: url,
          routeTitle: route.title,
          days: route.days,
          perPerson: q.perPerson,
          total: q.total,
          note: q.note,
          dayCount: route.itinerary.length,
        });
      },
    },
    {
      def: toolDefs[5]!,
      sideEffects: ['session', 'order', 'notify'],
      cacheable: false,
      blocksRetry: true,
      onReuse: undefined,
      async execute(input, { session }) {
        const args = input as Record<string, unknown>;
        if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
        const travelers = parseTravelers(args.travelers);
        if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
        if (!isValidIsoDate(args.departDate)) {
          return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期；客户没给具体日期时先问清，不要自行猜测');
        }
        {
          const past = pastDateError(args.departDate);
          if (past) return toolError(past);
        }
        // 幂等防护：同参数的待支付订单已存在时直接复用（企微消息重放、客户复述
        // 「就订」都会再触发一次 create_order，不能每次都真建一单）
        const dup = session.orderIds
          .map((id) => getOrder(id))
          .find(
            (o) =>
              o &&
              o.status === 'pending_payment' &&
              o.routeId === args.routeId &&
              o.travelers === travelers &&
              o.departDate === args.departDate,
          );
        // 结果带上订单的出发日期：引擎可能按客户明说的那天改过模型传的日期，模型要照这个写给客户。
        // 复用要说清是复用：此前字段和新建时一模一样，客户说「闺蜜那份也订上」，模型拿到的是客户自己那张单，
        // 却回「闺蜜那份也订好啦」——把本人的订单当成别人的发了出去（C06），或是「这次已经下好了」（C03）
        if (dup) {
          return JSON.stringify({
            orderId: dup.id,
            payUrl: '/pay/' + dup.id,
            total: dup.totalPrice,
            departDate: dup.departDate,
            reused: true,
            note:
              `这是本会话已有的那张订单（${dup.travelers} 位 / ${dup.departDate} 出发），不是新建的。` +
              '不要说成刚下了一单，更不要说成是给别人的订单；客户要给别人另订一份，这张单替代不了，先问清是合并成一单还是请顾问单独下。',
            ...(paymentMode() === 'advisor' ? { payNote: advisorPayNote(session) } : {}),
          });
        }
        const quote = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate });
        const order = createOrder({
          sessionId: session.id,
          routeId: args.routeId,
          routeTitle: quote.routeTitle,
          travelers: quote.travelers,
          departDate: args.departDate,
          totalPrice: quote.total,
          // 下单时线路的条目版本：金额与线路名照旧冻结在订单上，版本记下它们出自哪一份（02「报价快照」）
          catalogVersion: routeVersion(args.routeId),
        });
        // 改单：同一条线换了人数或日期重新下单，旧的待付款单作废。此前 8/8 次改单都留着两张待付款，
        // 模型却对客户说「之前的作废了 / 不用管」，旧链接照样能付。已付款的单绝不动（supersedeOrder 只认待付款）
        const superseded: string[] = [];
        for (const id of session.orderIds) {
          const o = getOrder(id);
          if (o && o.routeId === order.routeId && supersedeOrder(id, order.id)) superseded.push(id);
        }
        session.orderIds.push(order.id);
        rememberSeenRoutes(session, [args.routeId]);
        session.lastQuote = undefined; // 已成单即清除，防安全网对同一报价重复建单
        // advisor 模式：建单后排一次「待确认的订单」提醒（02 spec「收款流程」），随这次落库提交；
        // 执行体（src/notify/handoff.ts）到点时看订单还在不在待付款、确认过没有，确认过就不发
        if (paymentMode() === 'advisor') queueJobs(session.id, orderUnconfirmedNotifyOps(session.id, order.id, Date.now()));
        saveSession(session);
        // payUrl 为相对路径，渠道层负责拼 PUBLIC_BASE_URL。note 是这张单的定价说明（旺季 / 95 折），差价要讲原因时用它
        return JSON.stringify({
          orderId: order.id,
          payUrl: '/pay/' + order.id,
          total: order.totalPrice,
          departDate: order.departDate,
          note: quote.note,
          ...(superseded.length
            ? {
                supersededOrderId: superseded[superseded.length - 1],
                supersededNote:
                  '客户之前那张同线路的待付款订单已作废，旧支付链接已失效。照实告诉客户「之前那张单已作废、旧链接失效，按这张新的付款」，只发这次的新链接。',
              }
            : {}),
          ...(paymentMode() === 'advisor' ? { payNote: advisorPayNote(session) } : {}),
        });
      },
    },
    {
      def: toolDefs[6]!,
      sideEffects: ['session', 'handoff', 'notify'],
      cacheable: false,
      blocksRetry: true,
      onReuse: undefined,
      async execute(input, { session, hints }) {
        const args = input as Record<string, unknown>;
        const said = String(args.reason ?? '').trim();
        const reason = cleanText(said, 200);
        const { quote, departNote } = hints.handoff ?? {};
        enterHandoff(session, {
          kind: 'model',
          at: Date.now(),
          reason: cleanText(said, 120) || sources.modelHandoffReason,
          ...(quote ? { quote } : {}),
          ...(departNote ? { departNote } : {}),
        });
        // 原因此前只回给了模型，接手的顾问在后台看不到客户要什么（「想去南极，10 月两位」），得从头翻聊天记录。
        // 客户说出行时间的原话附在后面（见 engine.ts departNoteForHandoff）。system 消息只在后台显示，不发给客户、也不进模型历史
        if (reason) {
          session.messages.push({
            role: 'system',
            content: `AI 已转人工：${reason}${departNote ? `\n（${departNote}）` : ''}`,
            at: Date.now(),
          });
        }
        saveSession(session);
        return JSON.stringify({ ok: true, reason, note: HANDOFF_NOTE });
      },
    },
  ];
  return { ...catalog, tools };
}
