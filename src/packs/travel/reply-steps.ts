import { renderBrandTemplate } from '../../core/pack-api.js';
import { travelTemplates } from './templates.js';
// 04 R7：旅游主回复步骤，顺序由核心与本表组合；副作用仅经本轮 context。
import { convLabel, logQuote, cleanText, replyStep, type GuardStep, type ReplyGuardContext } from '../../core/pack-api.js';
import { CUSTOM_PROMISE } from './itinerary.js';
import type { createTravelTurnHooks } from './turn.js';
import type { createTravelPriceRules } from './price-rules.js';
import type { TravelPriceGuard } from './price-guard.js';
import type { TravelReplyHelpers } from './reply-helpers.js';

export interface TravelReplyStepSources {
  helpers: TravelReplyHelpers;
  turnHooks: ReturnType<typeof createTravelTurnHooks>;
  priceGuard: Pick<TravelPriceGuard, 'findUnbackedPriceHits' | 'strandedAfterDrop'>;
  priceRules: Pick<ReturnType<typeof createTravelPriceRules>, 'dropUnbackedClaims'>;
  getOrder: (id: string) => import('../../core/pack-api.js').Order | undefined;
  paymentMode: () => import('../../core/pack-api.js').PaymentMode;
  dejargon(text: string, sessionId: string): string;
  handoffReasons: { promise: string; claimed: string };
}
export function travelReplySteps(sources: TravelReplyStepSources): GuardStep<ReplyGuardContext>[] {
  const {
    quoteShown,
    INJECTION_INTENT,
    ON_TOPIC,
    INJECTION_REPLY,
    hasHijackResidue,
    ENCYCLOPEDIA_HINT,
    HAS_PRODUCT,
    keptBesideCustomPromise,
    ANY_HOLE,
    markLinkHoles,
    splitSentences,
    proposalUrlOf,
    proposalSuffixOf,
    restoreProposalSuffixes,
    ORDER_DONE_CLAIM,
    HANDED_OVER_FALLBACK,
    dropPostHandoffPromises,
    rewriteUnbackedPrices,
    unassumeAdults,
    strandedReply,
    repairLinks,
    dropProposalOffers,
    saysTransfer,
    dropTransferClaims,
    yuan,
    allowedPayLinks,
    whitelistLinks,
    DEFER_TO_CONSULTANT,
    promisesContact,
  } = sources.helpers;
  const {
    PURCHASE_INTENT,
    PURCHASE_INTENT_MAX_LEN,
    OTHER_ORDER,
    WANTS_PERSON,
    DEMANDS_EXCEPTION,
    haggling,
    otherPartyPending,
    askOtherOrder,
    travelersKnown,
    orderDepartDate,
    cardDate,
    neutralizeStandardDays,
    customHandoffReply,
    unwarrantedHandoff,
    isHandoffIntent,
    destinationsInText,
    deterministicRecommend,
    kidsHeadcountUnclear,
  } = sources.turnHooks;
  const { findUnbackedPriceHits, strandedAfterDrop } = sources.priceGuard;
  const { dropUnbackedClaims } = sources.priceRules;
  const { getOrder, paymentMode, dejargon, handoffReasons: HANDOFF_REASON } = sources;
  return [
    replyStep('other_order', 'stage_advance', [], ['wantsOrder', 'friendsOwn'], (ctx) => {
      const { session } = ctx;
      const orderedThisTurn = session.orderIds.length > ctx.ordersBefore;
      ctx.turn.flags.wantsOrder =
        !session.handedOver &&
        !orderedThisTurn &&
        !!session.lastQuote &&
        ctx.inputText.length <= PURCHASE_INTENT_MAX_LEN &&
        PURCHASE_INTENT.test(ctx.inputText) &&
        !haggling(session, ctx.inputText, ctx.text);
      // 给别人另订一份（「闺蜜她们也想去…帮她们报个价」→「行，那就订这个」）：和模型调 create_order 同一个判断（见 otherPartyPending）。
      // 此前安全网只看这一句，照 3 人的报价建了单，把客户本人那张 2 人的待付款单作废了
      ctx.turn.flags.friendsOwn = ctx.turn.flags.wantsOrder
        ? otherPartyPending(session, session.lastQuote!.routeId, session.lastQuote!.travelers)
        : undefined;
      if (ctx.turn.flags.friendsOwn) {
        console.warn(`[engine] 客户在说给别人另订，安全网不兜底建单（会话 ${convLabel(session.id)}）：${logQuote(ctx.inputText)}`);
        const rest = splitSentences(ctx.text)
          .filter((s) => !ORDER_DONE_CLAIM.test(s))
          .join('')
          .trim();
        const before = ctx.text;
        if (!/[？?]/.test(rest)) ctx.text = [rest, askOtherOrder(ctx.turn.flags.friendsOwn, ctx.inputText)].filter(Boolean).join('\n\n');
        ctx.recordGuard('other_order', before, ctx.text, 'patch');
      }
    }),
    replyStep('order_net', 'other_order', ['wantsOrder', 'friendsOwn'], [], async (ctx) => {
      const { session } = ctx;
      // 客户最近说的人数和这次报价对不上（报的 2 位，客户刚问「4个人多少钱」）：按报价的人数建单就是替客户定了人数，留给模型问
      const saidTravelers = ctx.turn.flags.wantsOrder
        ? travelersKnown(
            session,
            session.messages.filter((m) => m.role === 'customer').map((m) => m.content),
          )
        : undefined;
      if (
        ctx.turn.flags.wantsOrder &&
        !ctx.turn.flags.friendsOwn &&
        !OTHER_ORDER.test(ctx.inputText) &&
        (saidTravelers === undefined || saidTravelers === session.lastQuote!.travelers)
      ) {
        const quote = session.lastQuote!;
        // 已有完全同参（线路+人数+日期）的待支付订单才重发原链接，否则重新建单。
        // 只按线路匹配会让「改了出发日期再说就订」的客户拿回旧单的旧日期。客户最近说的是「国庆」这种
        // 下不了单的日子时（wantDate 为空），按最近那次报价的日期找：「10月5号」改成「国庆」后再说「就订这个」，
        // 不能把 10月5号 那张旧单重发给他，留着模型问具体哪天
        const wantDate = orderDepartDate(session, ctx.inputText);
        const matchDate = wantDate ?? quote.departDate;
        const existing = session.orderIds
          .map((id) => getOrder(id))
          .find(
            (o) =>
              o &&
              o.status === 'pending_payment' &&
              o.routeId === quote.routeId &&
              o.travelers === quote.travelers &&
              (!matchDate || o.departDate === matchDate),
          );
        if (existing) {
          session.stage = 'closing';
          const before = ctx.text;
          // advisor 模式：这条链接不是点开就能付的，同一意思换一种说法（02 spec「收款流程」）；online 模式原样不变
          const how =
            paymentMode() === 'advisor'
              ? `订单链接：/pay/${existing.id}\n顾问会${session.channel === 'web' ? '在这个页面里' : '在微信里'}跟您核对价格并发收款方式，想改人数或日期的话跟我说一声，我重新为您安排～`
              : `直接点这里完成支付即可：/pay/${existing.id}\n想改人数或日期的话跟我说一声，我重新为您安排～`;
          ctx.text = `您这单已经建好啦～《${existing.routeTitle}》${existing.travelers} 位出行、${cardDate(existing.departDate)}出发，总价 ${yuan(existing.totalPrice)}。\n${how}`;
          ctx.recordGuard('order_net', before, ctx.text, 'replace');
        } else {
          const departDate = wantDate;
          if (departDate) {
            // 安全网建单失败（如线路被手工删掉/数据文件损坏）不能炸掉整轮回复：
            // 保留模型原话继续对话，错误进日志供排查
            try {
              const netArgs = { routeId: quote.routeId, travelers: quote.travelers, departDate };
              const out = await ctx.createOrder(netArgs);
              const res = JSON.parse(out) as {
                orderId?: string;
                payUrl?: string;
                total?: number;
                note?: string;
                supersededOrderId?: string;
              };
              if (res.orderId && res.payUrl) {
                session.stage = 'closing';
                session.profile.dates = departDate;
                // 报价时客户还没给日期、建单时补上了，可能命中旺季 +10%——总价与刚发出去的
                // 报价对不上。不解释就是「上一条 6 万、下一条 6.6 万」，客户第一反应是被坑了。
                // 原因照工具的定价说明讲（「10月为最佳出行季，价格上浮 10%」），不说含糊的「有浮动」；
                // 只有那次报价真发到过客户眼前才提「之前报的」——C07 的 47,400 只在方案书里出现过，聊天里从没报过
                const diff =
                  typeof quote.total === 'number' &&
                  typeof res.total === 'number' &&
                  res.total !== quote.total &&
                  quoteShown(session, quote.total)
                    ? `\n（之前报的是 ${yuan(quote.total)}，按 ${cardDate(departDate)}出发重新核算：${res.note ?? '按这条线的季节定价'}）`
                    : '';
                const old = res.supersededOrderId ? getOrder(res.supersededOrderId) : undefined;
                const advisor = paymentMode() === 'advisor';
                // advisor 模式：旧单作废后不说「按这张付款」，这条链接不是点开就能付的（02 spec「收款流程」）；online 模式原样不变
                const replaced = old
                  ? `\n之前那张 ${old.travelers} 位、${cardDate(old.departDate)}出发的订单已作废，旧链接失效，${advisor ? '按这张的订单链接来。' : '按这张付款就行。'}`
                  : '';
                // 没付款不算锁定名额：此前「已为您锁定名额」和「名额以付款为准」写在同一条里，前后矛盾
                const how = advisor
                  ? `订单链接：${res.payUrl}\n顾问会${session.channel === 'web' ? '在这个页面里' : '在微信里'}跟您核对价格并发收款方式，不用点链接付款。`
                  : `请点此完成支付：${res.payUrl}\n名额以付款为准，付款后顾问会与您确认行程细节～`;
                const before = ctx.text;
                ctx.text = `好的，订单已生成～\n《${quote.routeTitle}》${quote.travelers} 位出行、${cardDate(departDate)}出发，总价 ${yuan(res.total ?? 0)}。${diff}${replaced}\n${how}`;
                ctx.recordGuard('order_net', before, ctx.text, 'replace');
              }
            } catch (e) {
              console.error('[engine] 成单安全网建单失败（保留模型原回复）:', e);
            }
          }
          // 日期无法解析时不强行下单：保留模型「问日期」的回复（正确行为）
        }
      }
    }),
    replyStep('link_whitelist', 'order_net', [], [], (ctx) => {
      const { session } = ctx;
      const allowedPay = allowedPayLinks(session);
      // 方案书链接是无状态的（/proposal/线路id/人数[/日期][?v=版本]），本轮真调过 generate_proposal
      // 且线路 id 对得上才放行——参数都编在路径里，页面按同一套规则重算，编不出假价格。
      // 版本后缀（02「报价快照」）也要和那次调用给的一样：模型抄丢了 ?v=2，客户点开的就是版本 1 的旧价，抹成空位由出口修补换成真链接
      // 同一线路本轮有成功的调用时只拿成功的核对：出错的那次（参数不对让模型重试）后缀是空串，丢了 ?v=2 的链接会借它过关
      const proposalPathOk = (pathOnly: string, version = ''): boolean => {
        const m = pathOnly.match(/^\/proposal\/([A-Za-z0-9_-]+)\/\d+/);
        if (!m) return false;
        const same = ctx.toolSources.filter((c) => c.name === 'generate_proposal' && c.args.routeId === m[1]);
        const ok = same.filter((c) => proposalUrlOf(c) !== null);
        return (ok.length ? ok : same).some((c) => proposalSuffixOf(c) === version);
      };
      const beforeLinks = ctx.text;
      ctx.text = whitelistLinks(ctx.text, allowedPay, proposalPathOk);
      ctx.recordGuard('link_whitelist', beforeLinks, ctx.text, 'strip');
    }),
    replyStep('repair_links:mark', 'markdown', [], [], (ctx) => {
      const { session } = ctx;
      const beforeHoles = ctx.text;
      ctx.text = markLinkHoles(ctx.text).trim() || ctx.fallbackReply(session.stage);
      ctx.recordGuard('repair_links', beforeHoles, ctx.text, 'patch');
    }),
    replyStep('dejargon', 'repair_links:mark', [], [], (ctx) => {
      const { session } = ctx;
      const beforeJargon = ctx.text;
      ctx.text = dejargon(ctx.text, session.id);
      ctx.recordGuard('dejargon', beforeJargon, ctx.text, 'replace');
    }),
    replyStep('custom_promise-a', 'dejargon', [], ['customPromise'], (ctx) => {
      const { session } = ctx;
      // 空头承诺护栏：模型说要「帮您重排」，但系统没有这个能力；
      // 或者承诺了链接而清洗后正文里根本没有链接。
      // 改行程转人工时要附在最后的说明。非空即表示本轮因改行程承诺转了人工
      ctx.turn.flags.customPromise = '';
      // 「6 天版给您报价如下」说的是那条 6 天的现成线路，不是许诺重排。只在 N 不是上下文里任何
      // 一条现成线路的标准天数时，「N 天版」才算改行程承诺——实测 flashx 3 遍里 1 遍这么说，
      // 准备成交的客户被当成改行程转了人工，AI 此后不再应答。
      const beforeCustom = ctx.text;
      ctx.text = neutralizeStandardDays(ctx.text, session, ctx.toolSources);
      // 承诺改行程：系统真的做不到，转人工是对的（真人顾问能重排）
      if (CUSTOM_PROMISE.test(ctx.text)) {
        console.error(`[engine] ⚠️ 拦截空头承诺·承诺重排行程（会话 ${convLabel(session.id)}）：${logQuote(ctx.text)}`);
        // 只摘掉许下空头承诺的那几句，其余照常发给客户。客户常在同一条消息里问两件事
        // （「能改成 5 天吗」+「能保证看到极光吗」），整条替换会把第二个问题的回答一起吞掉，
        // 客户看到的是答非所问。转人工仍然立刻执行——系统确实改不了行程，这条不能松。
        // 一并滤掉承诺链接的句子：这里不会再补链接，留着就是第二个空头承诺。
        //
        // **这里不能提前 return**：留下来的仍是模型原文，必须照常走完下面的身份/注入/价格护栏。
        // 此前在这里直接返回，模型给压缩版编的「每人大约 13,800 元」就绕过价格护栏发给了客户。
        ctx.text = keptBesideCustomPromise(ctx.text);
        ctx.recordGuard('custom_promise', beforeCustom, ctx.text, 'handoff');
        ctx.turn.flags.customPromise = customHandoffReply(ctx.inputText);
        // 同一轮模型已经调过 handoff_to_human 的，这里保留那条 model 记录、计数不加（enterHandoff 已在转人工中只升级 emergency）
        const departNote = ctx.departNoteForHandoff(session);
        ctx.enterHandoff({
          kind: 'promise',
          at: Date.now(),
          reason: HANDOFF_REASON.promise,
          quote: cleanText(ctx.inputText, 200),
          ...(departNote ? { departNote } : {}),
        });
        return { action: 'handoff', text: ctx.text, reason: HANDOFF_REASON.promise };
      } else {
        // 承诺了链接却没链接：只是这轮少调了一次工具，不构成对客户的承诺，
        // 就地补上链接或改问一句继续对话，不转人工——否则一次工具漏调就吃掉一条线索
        // 「N 天版」改成「N 天这条」（指的是现成线路）也记在改行程这道护栏名下
        ctx.recordGuard('custom_promise', beforeCustom, ctx.text, 'replace');
      }
    }),
    replyStep('repair_links:fill', 'custom_promise-a', ['customPromise'], [], async (ctx) => {
      const { session } = ctx;
      if (!ctx.turn.flags.customPromise) {
        const beforeRepair = ctx.text;
        ctx.text =
          dropProposalOffers(
            await repairLinks(ctx.text, { session, text: ctx.inputText, calls: ctx.toolSources, runTool: ctx.callTool }),
          ) || ctx.fallbackReply(session.stage);
        ctx.recordGuard('repair_links', beforeRepair, ctx.text, 'patch');
      }
      ctx.text = ctx.text.replace(ANY_HOLE, ''); // 空位记号绝不能发给客户
    }),
    replyStep('handoff_claims', 'repair_links:fill', ['customPromise'], ['handedOverSelfDecided'], (ctx) => {
      const { session } = ctx;
      let claimed = false;
      // 回复说了「为您转接」，本轮却没转人工（A07/A11 实测）：状态跟着回复走，不然下一轮 AI 接着卖，
      // 客户同时等着顾问、又收到 AI 的推销。条件句（「需要的话我可以为您转接」）不算，见 claimsTransfer。
      // 反过来的只有一种：转人工拿的是库外目的地当理由、客户又没坚持（或这轮刚驳回过）——摘掉转接的话，继续对话
      // 驳回过的，回复里说转接、说「顾问会在微信上联系您」的句子一律摘掉，不管 saysTransfer 认没认出来
      if (!session.handedOver && !ctx.turn.flags.customPromise && (ctx.handoffDeclined || saysTransfer(ctx.text, session))) {
        const beforeClaims = ctx.text;
        if (ctx.handoffDeclined || unwarrantedHandoff(session, ctx.inputText, ctx.text)) {
          const kept = dropTransferClaims(ctx.text, session);
          if (kept !== ctx.text)
            console.warn(`[engine] 回复说了转接但客户没坚持原目的地，摘掉转接的话（会话 ${convLabel(session.id)}）：${logQuote(ctx.text)}`);
          ctx.text = kept || ctx.fallbackReply(session.stage);
          ctx.recordGuard('handoff_claims', beforeClaims, ctx.text, 'drop_sentence');
        } else if (!isHandoffIntent(ctx.inputText) && !WANTS_PERSON.test(ctx.inputText) && !DEMANDS_EXCEPTION.test(ctx.inputText)) {
          // 客户没要找人，只是问了件要顾问确认的事（专票、资质…），模型顺口说了「我帮您转接」。
          // 真转过去 AI 就此沉默，客户接着问资金、问电话都没人回（guard-13 实测）——演示当场卡住。
          // 所以摘掉转接的话、改成「记下了，请顾问确认」，后台记一条待跟进，AI 照常接着聊。
          console.warn(`[engine] 回复说了转接但客户没要找人，改为记下待顾问确认（会话 ${convLabel(session.id)}）：${logQuote(ctx.text)}`);
          const kept = dropTransferClaims(ctx.text, session);
          ctx.text = /顾问[^。！？\n]{0,12}(?:确认|核实|跟您|联系)/.test(kept)
            ? kept
            : `${kept ? `${kept}\n\n` : ''}这个我记下了，会请顾问${session.channel === 'web' ? '在这个页面里' : '在微信上'}跟您确认。`;
          ctx.recordGuard('handoff_claims', beforeClaims, ctx.text, 'patch');
          ctx.appendMessage({
            role: 'system',
            content: `待顾问跟进：客户问「${cleanText(ctx.inputText, 60)}」，AI 答应请顾问确认（未转人工）`,
            at: Date.now(),
          });
        } else {
          console.warn(
            `[engine] 回复说了转接却没调 handoff_to_human，按转人工处理（会话 ${convLabel(session.id)}）：${logQuote(ctx.text)}`,
          );
          const note = ctx.departNoteForHandoff(session);
          claimed = true;
          ctx.enterHandoff({
            kind: 'claimed',
            at: Date.now(),
            reason: HANDOFF_REASON.claimed,
            quote: cleanText(ctx.inputText, 200),
            ...(note ? { departNote: note } : {}),
          });
          ctx.appendMessage({
            role: 'system',
            content: `AI 已转人工：${HANDOFF_REASON.claimed}${note ? `\n（${note}）` : ''}`,
            at: Date.now(),
          });
        }
      }
      // 这轮自己要不要转人工，到这里已经定了（工具调用、空头承诺、回复里说了转接，都在这之前判完）。
      // 之后到 push 之前还有几道护栏（身份、注入、价格）要走，没有新的 await，不会再新增自己决定的转人工。
      // 旧 /handoff 不加接手代次（R11：共享工作台以 agent 身份接管，比代次比不出来）：从这里往后，handedOver
      // 从假变真只可能是外部动作（审查第 8 条，compat[3]），push 之前要据此补上去，不能只看代次
      ctx.turn.flags.handedOverSelfDecided = session.handedOver;
      if (claimed) return { action: 'handoff', text: ctx.text, reason: HANDOFF_REASON.claimed };
    }),
    replyStep('injection', 'handoff_claims', ['customPromise'], ['guardHit'], (ctx) => {
      const { session } = ctx;
      // 下面几道护栏命中时通常把整条换成兜底话术，但兜底话术都在追问线路/人数/预算——
      // 这一轮已经转人工、AI 之后不再应答，追问只会让客户白等。所以改行程转人工时，
      // 护栏命中就整段丢掉模型原文，只发转人工说明。
      // 模型这轮自己调了 handoff_to_human 也一样：此前价格护栏在这时换上「告诉我线路和人数，我马上给您报价」，
      // 客户照做了却再没人应，而且整条回复里一个字都没提已经转了顾问。换成转人工口径的兜底（handedOver）
      const replaceVisible = (fallback: string, handedOver = HANDED_OVER_FALLBACK): void => {
        ctx.text = ctx.turn.flags.customPromise ? '' : session.handedOver ? handedOver : fallback;
      };
      /** 本轮价格或注入护栏命中（同一处判断）：这一轮不算交互失败（R15、不变量 30） */
      ctx.turn.flags.guardHit = null;
      // 注入劫持安全网：输入像注入，且回复已经不在聊旅行了（没有任何业务词）或夹带了被劫持的
      // 输出，说明模型被带跑了——直接换成顾问口吻的拒绝。模型干净地拒绝时两条都不命中，不受影响。
      if (ctx.text && INJECTION_INTENT.test(ctx.inputText) && (!ON_TOPIC.test(ctx.text) || hasHijackResidue(ctx.text, ctx.inputText))) {
        console.error(
          `[engine] ⚠️ 拦截注入劫持（会话 ${convLabel(session.id)}）：输入=${logQuote(ctx.inputText)} 输出=${logQuote(ctx.text)}`,
        );
        const before = ctx.text;
        replaceVisible(ctx.brand ? renderBrandTemplate(travelTemplates.offTopicReply, ctx.brand) : INJECTION_REPLY);
        ctx.recordGuard('injection', before, ctx.text, 'replace');
        ctx.turn.flags.guardHit = 'injection';
      }
    }),
    replyStep('encyclopedia', 'injection', ['customPromise'], [], async (ctx) => {
      const { session } = ctx;
      // 百科式回答护栏：客户提到了我们在卖的目的地，回复却像本地理教科书且不含任何产品信息
      const beforeEncyclopedia = ctx.text;
      if (session.handedOver && ENCYCLOPEDIA_HINT.test(ctx.text) && !HAS_PRODUCT.test(ctx.text)) {
        // 已转人工，不再改写成线路推荐（推荐末尾要客户「告诉我几位出行」，之后没人应）。
        // 改行程转人工只留后面附的转人工说明；模型自己转的，原文里就有它的转接说明，照发
        if (ctx.turn.flags.customPromise) ctx.text = '';
      } else if (ENCYCLOPEDIA_HINT.test(ctx.text) && !HAS_PRODUCT.test(ctx.text)) {
        const dests = destinationsInText(ctx.inputText);
        if (dests.length) {
          const rec = await deterministicRecommend(dests[0], session);
          if (rec) {
            console.error(`[engine] ⚠️ 拦截百科式回答（会话 ${convLabel(session.id)}，目的地 ${dests[0]}）：${logQuote(ctx.text)}`);
            ctx.text = rec;
            session.stage = ctx.advanceStage(session, {
              calls: [{ name: 'search_routes', args: { destination: dests[0] } }],
              terminal: ctx.isTerminalStage(session.stage),
            });
            session.profile.destinationInterest = dests[0];
          }
        }
      }
      ctx.recordGuard('encyclopedia', beforeEncyclopedia, ctx.text, 'replace');
    }),
    replyStep('unbacked_claims', 'encyclopedia', ['customPromise'], ['preDropSnapshot', 'saidAll'], (ctx) => {
      const { session } = ctx;
      // 价格规则 / 预算判断 / 服务承诺（见 price-rules.ts）：「儿童价」「比国庆便宜」「在您预算内」「名额紧张」「支持开专票」
      // 这类话对不上工具结果和写死的定价规则，删掉那一句（服务承诺换成「由顾问确认」），其余照发。排在价格护栏前面：
      // 被删的句子里的数不必再去核
      // 删之前的样子留一份：两道护栏按句删完，拿它判剩下的是不是残句（见下面 strandedAfterDrop）
      ctx.turn.flags.preDropSnapshot = ctx.text;
      ctx.turn.flags.saidAll = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
      // 人数按客户原话认一份交给规则词守卫：还没报价时它自己认不出几位，「两位一共 3 万」没法折成每人去核「在预算内」
      const claims = dropUnbackedClaims(ctx.text, session, ctx.toolSources, { travelers: travelersKnown(session, ctx.turn.flags.saidAll) });
      if (claims.dropped.length) {
        console.error(
          `[engine] ⚠️ 删掉对不上的价格规则 / 服务承诺（会话 ${convLabel(session.id)}）：${logQuote(claims.dropped.join(' | '))}`,
        );
      }
      if (claims.text !== ctx.text) {
        const before = ctx.text;
        ctx.text =
          claims.text || (ctx.turn.flags.customPromise ? '' : session.handedOver ? HANDED_OVER_FALLBACK : ctx.fallbackReply(session.stage));
        ctx.recordGuard('unbacked_claims', before, ctx.text, 'drop_sentence');
      }
    }),
    replyStep('price', 'unbacked_claims', ['customPromise', 'guardHit'], ['guardHit'], (ctx) => {
      const { session } = ctx;
      // 价格出口校验：回复里的金额必须能追溯到产品库定价规则、本会话报价/订单，或客户自己说过的数字。
      // 追溯不到就是模型自己编的价——高客单价产品里这是最贵的一类错误（客户按错价下单，
      // 成交后要么公司认亏要么当场翻脸），不能只靠提示词「严禁编造价格」。
      // 本轮的工具调用（含预取）一并交给护栏：产品库的价只按本会话出现过的线路放行，编一条线路配上别的线路的真价不再能过
      const unbacked = findUnbackedPriceHits(ctx.text, session, ctx.inputText, ctx.toolSources);
      if (unbacked.length) {
        console.error(
          `[engine] ⚠️ 拦截无出处的报价 ${unbacked.map((h) => h.value).join(', ')}（会话 ${convLabel(session.id)}）：`,
          logQuote(ctx.text),
        );
        const before = ctx.text;
        ctx.text = rewriteUnbackedPrices(ctx.text, unbacked, {
          session,
          text: ctx.inputText,
          calls: ctx.toolSources,
          customHandoff: !!ctx.turn.flags.customPromise,
        });
        ctx.recordGuard('price', before, ctx.text, 'drop_sentence');
        ctx.turn.flags.guardHit ??= 'price';
      }
    }),
    replyStep('stranded', 'price', ['customPromise', 'preDropSnapshot'], [], async (ctx) => {
      const { session } = ctx;
      // 按句删完剩下的是残句（还指着删掉的那条线、宣称报价却没有数、只剩一句问话）：不发残句，整条换成有内容的兜底
      if (strandedAfterDrop(ctx.turn.flags.preDropSnapshot, ctx.text)) {
        console.error(`[engine] ⚠️ 按句删除后只剩残句，改用兜底（会话 ${convLabel(session.id)}）：${logQuote(ctx.text)}`);
        const before = ctx.text;
        ctx.text = ctx.turn.flags.customPromise
          ? ''
          : session.handedOver
            ? HANDED_OVER_FALLBACK
            : await strandedReply({ session, text: ctx.inputText, calls: ctx.toolSources, runTool: ctx.callTool });
        ctx.recordGuard('stranded', before, ctx.text, 'replace');
      }
    }),
    replyStep('adults', 'stranded', ['saidAll'], [], (ctx) => {
      // 客户提过带娃、没说清孩子算不算：回复别替他写成「两位大人」（flow-07），人数照客户说的写
      // 问大人还是孩子的那句不动（见 ASKS_ADULT_OR_KID）
      if (kidsHeadcountUnclear(ctx.turn.flags.saidAll) && !ctx.turn.flags.saidAll.some((t) => /大人/.test(t))) {
        const before = ctx.text;
        ctx.text = unassumeAdults(ctx.text);
        ctx.recordGuard('adults', before, ctx.text, 'patch');
      }
    }),
    replyStep('custom_promise-b', 'identity', ['customPromise'], [], (ctx) => {
      if (ctx.turn.flags.customPromise) {
        const before = ctx.text;
        ctx.text = ctx.text ? `${ctx.text}\n\n${ctx.turn.flags.customPromise}` : ctx.turn.flags.customPromise;
        ctx.recordGuard('custom_promise', before, ctx.text, 'append');
      }
    }),
    replyStep('post_handoff', 'custom_promise-b', [], [], (ctx) => {
      const { session } = ctx;
      if (session.handedOver) {
        const before = ctx.text;
        ctx.text = dropPostHandoffPromises(ctx.text);
        ctx.recordGuard('post_handoff', before, ctx.text, 'drop_sentence');
      }
    }),
    replyStep('proposal_suffix', 'post_handoff', [], [], (ctx) => {
      // 改写正文的护栏都跑完了：本轮这条线的方案书链接缺了版本后缀的补回去（见 restoreProposalSuffixes）
      const beforeSuffix = ctx.text;
      ctx.text = restoreProposalSuffixes(ctx.text, ctx.toolSources);
      ctx.recordGuard('proposal_suffix', beforeSuffix, ctx.text, 'patch');
    }),
    replyStep('system_note', 'final_clean', [], [], (ctx) => {
      const { session } = ctx;
      // 回复里说了「由顾问跟您确认」「我让顾问确认」（守卫换上的，或模型照 SOP 说的）却没转人工：记一条给后台，
      // 顾问才看得到有件事等着他确认——此前客户付款前一直等，没人知道（同「嘴上说转接却没转」是一类空头承诺）
      if (!session.handedOver && DEFER_TO_CONSULTANT.test(ctx.text)) {
        ctx.appendMessage({
          role: 'system',
          content: `待顾问确认：客户问「${cleanText(ctx.inputText, 60)}」，AI 回复说由顾问确认（未转人工）`,
          at: Date.now(),
        });
      } else if (!session.handedOver && promisesContact(ctx.text, session)) {
        // 光一句「顾问会在微信上联系您」不算转接（见 claimsTransfer），但客户听到的是有人会来找他：同样给顾问记一条。
        // 此前「签证这块需要专人办理，顾问会在微信上联系您～」发出去，后台什么都没有，没人知道答应过要联系（第三轮复核 H1/H2）
        ctx.appendMessage({
          role: 'system',
          content: `待顾问跟进：客户问「${cleanText(ctx.inputText, 60)}」，AI 回复说顾问会在微信上联系（未转人工）`,
          at: Date.now(),
        });
      }
    }),
  ];
}
