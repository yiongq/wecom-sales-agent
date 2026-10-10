// 对话引擎：组 prompt → LLM 工具循环 → 从工具调用推导阶段/画像 → 落盘。
// 销售阶段不靠模型自 report，而是看它这轮实际调了哪些工具（调了 create_order
// 就是 closing），可靠且反映真实行为；画像同理从工具参数沉淀。
import { createTravelReplyHelpers } from './packs/travel/reply-helpers.js';
import { trimDangling, stripMarkdown, IDENTITY_QUESTION, answerIdentity as coreAnswerIdentity } from './core/guards/text.js';
import fs from 'node:fs';
import { dejargon as coreDejargon } from './core/guards/dejargon.js';
import { coreReplySteps } from './core/guards/reply.js';
import { loadGuardPipeline } from './core/guards/execute.js';
import { travelReplySteps } from './packs/travel/reply-steps.js';
import { travelFollowupSteps, type FollowupGuardContext } from './packs/travel/followup-steps.js';
import { travelPriceThresholds } from './packs/travel/thresholds.js';
import { createTravelTurnHooks } from './packs/travel/turn.js';
import { CUSTOM_PROMISE } from './packs/travel/itinerary.js';
import { dejargonVocab } from './packs/travel/dejargon-vocab.js';
import { createToolRegistry } from './core/tools/registry.js';
import type { TurnContext, TurnToolContext, ReplyGuardContext } from './core/pack-api.js';
import {
  advanceStage,
  createTravelProfileExtractor,
  BUDGET_RE,
  detectSegment,
  isBudgetTalk,
  isObjection,
} from './packs/travel/progress.js';
import { saysDay } from './core/parse/dates.js';
import path from 'node:path';
import type { AgentReply, ChatMessage, CustomerProfile, Order, PreparedPush, Session } from './types.js';
import { profileForPrompt } from './types.js';
import {
  deleteOrdersOfSession,
  getOrCreateSession,
  getOrder,
  getSession,
  noteWindowReset,
  queueInboxState,
  queueJobs,
  saveSession,
} from './store.js';
import {
  enterHandoff,
  executeTool,
  getToolSpec,
  isOriginMention,
  loadRoutes,
  mentionsPlace,
  offCatalogPlaces,
  rememberShownRoutes,
  searchRoutes,
  toolDefs,
  visitedDestinations,
} from './tools.js';
import { chat, reuseToolResult, type PrefetchedCall } from './llm.js';
import { tryReserveVisitorLLM } from './budget.js';
import { dropSentences, findUnbackedPriceHits, priceMentions, saidBefore, spokenMoney, strandedAfterDrop } from './price-guard.js';
import { BUDGET_LIFTED, dropUnbackedClaims, liftsBudget } from './price-rules.js';
import { numEnv, todayIso } from './env.js';
import { profile } from './profile.js';
import { paymentMode } from './payment/mode.js';
import { renderSystemPrompt } from './prompt/system.js';
import { ConfigNotReadyError, configMode, currentSop, pinCatalogForTurn } from './config/source.js';
import { promptHashes } from './config/hashes.js';
import { emergencyReason, HANDOFF_REASON, isTerminalStage } from './handoff/record.js';
import { TAKEN_OVER_NOTE, takeoverGen } from './handoff/takeover.js';
import {
  consentWithdrawalOf,
  emergencyOf,
  negativeLevel,
  pushWindow,
  sensitiveCategoriesOf,
  SENTIMENT_WINDOW,
  sentimentThresholdReached,
  type SensitiveCategory,
} from './handoff/triggers.js';
import {
  awaitingConsent,
  CONSENT_WITHDRAWAL_REASON,
  CONSENT_WITHDRAWN_REPLY,
  consentMenuText,
  noteSensitiveMentions,
  sensitiveContextNote,
  withdrawConsent,
} from './handoff/consent.js';
import { currentPrivacyNotice } from './privacy/privacy.js';
import { prepareChannel, pushToChannel } from './handoff/takeover.js';
import { cleanText } from './shared/text.js';
import { stripAdvisorPrefix, withAdvisorPrefix } from './shared/conversation.js';
import { convLabel } from './log.js';
import { followupOptOutOf } from './jobs/optout.js';
import { cancelHandoffNotifyOps } from './jobs/notify.js';
import {
  endTurn,
  noteDraft,
  noteGuard,
  noteGuardVerdict,
  notePrefix,
  noteSignals,
  noteToolError,
  noteToolResult,
  startTurn,
  traceToolCall,
  withTurnScope,
  type TurnOutcome,
} from './trace/recorder.js';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** 工具返回的原文。出口修补链接时要用「本轮工具真给过的那条」，不能照参数自己拼 */
  result?: string;
}

// 第 18 步把这些能力接线归到组合根；这里不复制旅游判断。
const turnHooks = createTravelTurnHooks({
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
});
const {
  PURCHASE_INTENT,
  OTHER_ORDER,
  RESEND_ASK,
  BUDGET_FLOOR,
  haggling,
  requestedDays,
  isComplaint,
  isHandoffIntent,
  statedPastDate,
  spokenDepartDate,
  latestDepart,
  resolveDepartDate,
  monthSaid,
  departNoteForHandoff,
  planPrefetch,
  perPersonBudget,
  planDetailPrefetch,
  quoteTimingNote,
  routeInFocus,
  routesIn,
  toolHints,
} = turnHooks;

const dejargon = (text: string, sessionId: string): string => coreDejargon(text, sessionId, dejargonVocab);

// 旧调用点只适配本轮能力；extractProfile 保留包接口的两个参数，不增加模型前抽取。
function extractProfile(session: Session, calls: ToolCall[], text: string): CustomerProfile {
  return {
    ...session.profile,
    ...createTravelProfileExtractor({
      loadRoutes,
      toolCalls: () => calls,
      isMonthOnly: turnHooks.isMonthOnly,
      todayIso,
      liftsBudget,
      budgetLifted: BUDGET_LIFTED,
    }).extractProfile(text, session),
  };
}

const replyHelpers = createTravelReplyHelpers({
  loadRoutes,
  getOrder,
  paymentMode,
  mentionsPlace,
  turnHooks,
  isConfigNotReadyError: (error) => error instanceof ConfigNotReadyError,
  priceGuard: { priceMentions, saidBefore, dropSentences },
  extractProfile,
  isTerminalStage,
});
const {
  keptBesideCustomPromise,
  PROPOSAL_PROMISE,
  LINK_PROMISE,
  markLinkHoles,
  promiseInsertAt,
  restoreProposalSuffixes,
  HANDED_OVER_FALLBACK,
  dropProposalOffers,
  claimsTransfer,
  safetyNetKind,
  handoffReply,
  fallbackReply,
} = replyHelpers;
const answerIdentity = (text: string, reply: string): string => coreAnswerIdentity(text, reply, replyHelpers.IDENTITY_ANSWER);

// 第 18 步接 PackRuntime.followupSteps；现在独立装载并校验 11 步跟进表。
const followupPipeline = loadGuardPipeline(
  travelFollowupSteps({
    helpers: replyHelpers,
    turnHooks,
    priceGuard: { findUnbackedPriceHits, dropSentences, strandedAfterDrop },
    priceRules: { dropUnbackedClaims },
    dejargon,
    stripMarkdown,
    trimDangling,
    stripAdvisorPrefix,
  }),
);

// 第 18 步把包装载移到组合根；现在启动时即校验完整 28 步表。
const replySteps = [
  ...coreReplySteps(),
  ...travelReplySteps({
    helpers: replyHelpers,
    turnHooks,
    priceGuard: { findUnbackedPriceHits, strandedAfterDrop },
    priceRules: { dropUnbackedClaims },
    getOrder,
    paymentMode,
    dejargon,
    handoffReasons: HANDOFF_REASON,
  }),
];
const replyOrder = [
  'pre_clean',
  'takeover_check:pre',
  'stage_advance',
  'other_order',
  'order_net',
  'link_whitelist',
  'markdown',
  'repair_links:mark',
  'dejargon',
  'custom_promise-a',
  'repair_links:fill',
  'handoff_claims',
  'injection',
  'encyclopedia',
  'unbacked_claims',
  'price',
  'stranded',
  'adults',
  'dangling',
  'advisor_prefix',
  'identity',
  'custom_promise-b',
  'post_handoff',
  'proposal_suffix',
  'takeover_check:post',
  'turn_failure',
  'final_clean',
  'system_note',
];
const replyPipeline = loadGuardPipeline(
  replyOrder.map((id) => {
    const step = replySteps.find((step) => step.id === id);
    if (!step) throw new Error(`缺少主回复步骤：${id}`);
    return step;
  }),
);

const HISTORY_LIMIT = 30;
// 历史窗口**按块推进，不逐条滑动**——这条是为前缀缓存服务的，别改回 slice(-30)。
//
// 逐条滑动时，会话超过 30 轮以后每一轮的历史开头都往后挪一条，发给模型的
// messages 公共前缀在第一条历史那里就断了：SOP 那段还能命中缓存，1000+ token
// 的历史却要每轮按全价重算，而且长会话恰恰是最贵的那些会话。
//
// 按块推进后，同一块内的起点逐字不变，历史部分也能一直命中。代价是窗口实际长度
// 在 30~39 之间浮动——多带几条旧消息对回复质量没有影响，比每轮多付一遍钱划算。
const HISTORY_BLOCK = 10;

/** 取发给模型的历史窗口。导出仅为自测断言块边界，业务侧不要直接调 */
export function historyWindow<T>(msgs: T[]): T[] {
  if (msgs.length <= HISTORY_LIMIT) return msgs;
  // 丢弃条数向下取整到块边界，于是起点每 HISTORY_BLOCK 轮才动一次
  const drop = Math.floor((msgs.length - HISTORY_LIMIT) / HISTORY_BLOCK) * HISTORY_BLOCK;
  return msgs.slice(drop);
}

// sop.md 由数据模块产出，运行时读取；SOP_PATH 仅供测试指向 fixture
function loadSop(): string {
  const p = process.env.SOP_PATH ?? path.join(process.cwd(), 'data', 'sop.md');
  if (!fs.existsSync(p)) {
    throw new Error(`销售 SOP 缺失: ${p} 不存在（应由 data/sop.md 提供，见 SPEC 模块 1）`);
  }
  return fs.readFileSync(p, 'utf8');
}

// system prompt 的拼装与前缀缓存的讲究见 prompt/system.ts。这里只决定 SOP 从哪来：
// DB 模式取发布时渲染好的那一串（每轮逐字节复用，从不重新渲染），文件模式每轮按 data/sop.md 现渲染
function buildSystemPrompt(): string {
  return configMode() === 'db' ? currentSop().renderedPrompt : renderSystemPrompt(loadSop());
}

/** 文件模式下的 SOP 原文（SOP_PATH 或 data/sop.md），给 /healthz 算 sopHash */
export function sopFileText(): string {
  return loadSop();
}

/**
 * 这一轮的 system 与它的追溯标签（spec「渲染与哈希」每轮可追溯：SOP 版本与前缀哈希前 12 位）。两样在轮开始时同一刻取：
 * 模型往返期间发布了新版本，日志仍记这一轮实际用的那个。文件模式的版本记 file，哈希按这一轮的 system 算，要打日志时才算
 */
function turnPrefix(): { system: string; tag: () => string; sopVersion: number | null; prefixHash: () => string } {
  const system = buildSystemPrompt();
  if (configMode() === 'db') {
    const s = currentSop();
    const tag = `SOP v${s.versionNo} · 前缀 ${s.prefixHash.slice(0, 12)}`;
    return { system, tag: () => tag, sopVersion: s.versionNo, prefixHash: () => s.prefixHash };
  }
  let hash = '';
  const prefixHash = (): string => (hash ||= promptHashes(system, JSON.stringify(toolDefs), '').prefixHash);
  return { system, tag: () => `SOP file · 前缀 ${prefixHash().slice(0, 12)}`, sopVersion: null, prefixHash };
}

/** 发给模型的固定前缀：system 是请求里第一条 system 消息的全文，tools 是 JSON.stringify(toolDefs)。
 *  前缀稳定测试拿它比对每个请求（00 spec「前缀稳定测试」） */
export function promptPrefix(): { system: string; tools: string } {
  return { system: buildSystemPrompt(), tools: JSON.stringify(toolDefs) };
}

/**
 * 工具调用观测钩子。评测器订阅它来断言「这一轮该调的工具调了没」，
 * 生产上也可用来统计工具使用分布（哪个工具最常用、哪个从来没被调过）。
 */
/** prefetch=true：这次是引擎预取替模型调的。评测据此区分「模型自己查了」和「代码替它查了」，
 *  不区分的话，模型横评里弱模型的「调了工具」会被预取抬成满分 */
export interface ToolCallMeta {
  prefetch?: boolean;
}
type ToolObserver = (name: string, args: Record<string, unknown>, sessionId: string, meta?: ToolCallMeta) => void;
const toolObservers = new Set<ToolObserver>();
export function onToolCall(fn: ToolObserver): () => void {
  toolObservers.add(fn);
  return () => toolObservers.delete(fn);
}
// 逐轮 trace 的订阅者（02 spec「逐轮 trace」）：调用记进当前这一轮，结果由 runTool 执行完补上（noteToolResult）
onToolCall(traceToolCall);

// 同会话串行：一个客户手快连发几条、或网络重发时，多个 handleMessage 会并发跑。
// 它们共享同一个 session 对象，谁先 await 回来谁先 push——实测四条消息倒序入库，
// 且每条回复都没看到其他几条的上下文（回「什么时候去合适」时还在问「您想去哪」）。
// 企微侧本来就按客户分组串行，网页侧一直漏着。这里按会话排成一条链，跨会话仍并发。
const sessionChain = new Map<string, Promise<unknown>>();

/** 把同一会话的处理排队；链上任何一环失败都不影响后续（catch 掉再续） */
function serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionChain.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // 只保留链尾，且不让 rejected promise 挂在 Map 上产生 unhandled rejection
  const tail = next.catch(() => undefined);
  sessionChain.set(sessionId, tail);
  // 链尾跑完且没有新任务接上时删掉条目。此前比较的是 `=== undefined`，而刚 set 进去的
  // 是个 promise，条件恒为假 —— Map 只增不减，公开演示页每来一个访客就永久多一条。
  void tail.finally(() => {
    if (sessionChain.get(sessionId) === tail) sessionChain.delete(sessionId);
  });
  return next;
}

/** 客户消息进会话前的清洗与截断。企微重放对齐（adapters/wecom.ts）按同一个调用比对原文，否则长消息永远对不上 */
export function inboundText(text: string): string {
  return cleanText(text, 2000); // 超长输入截断：防恶意长文刷爆 prompt token
}

export function trimSessionMessages(session: Session): void {
  // 会话历史封顶：超过 400 条裁到最近 300，防单会话无限膨胀拖垮全量落盘
  if (session.messages.length > 400) session.messages.splice(0, session.messages.length - 300);
}

/** handleMessage 的可选参数（02 spec「消息只追加」） */
export interface HandleOpts {
  /** 渠道消息 id：企微文本消息带上，记在客户消息上，重放时按它对齐 */
  msgid?: string;
  /** 企微 send_time（毫秒）：发送窗口从它起算（R18） */
  sentAt?: number;
  /** 这句客户原话已经记在会话末尾（企微重放：上次停在「已记下、回复还没生成」），引擎不再 push 一遍 */
  alreadyRecorded?: boolean;
  /**
   * 03（spec「入站：channel_inbox」、R3、不变量 3）：这句来自库里企微账号的哪一行入站（channel_inbox.id）。引擎把客户消息写进会话的
   * 两处（重置口令分支与正常分支）都在那一段同步代码里、saveSession 之后排 recorded（message_seq 取这条消息分到的 seq），
   * 与这条消息同一次落库提交。alreadyRecorded 时不排（这句上次已经记过）
   */
  inboxId?: string;
}

/** 这一轮写进会话的那条回复消息（02 第 12 步：渠道发送时交给发送账本，账本行据它取 seq）。不往 AgentReply 上加字段 */
const replyMessages = new WeakMap<AgentReply, ChatMessage>();

/** handleMessage 返回的回复对应会话里的哪条消息；静默、没写进会话的没有 */
export function replyMessageOf(r: AgentReply): ChatMessage | undefined {
  return replyMessages.get(r);
}

/**
 * 发给模型的历史里人工回复的说明（02 spec「接手、人工回复与交还」）：窗口里有 author='human' 的消息时加在 contextNote 末尾。
 * 没有人工消息的会话一个字节都不变；contextNote 在 system prompt 之外（独立的 system 消息），前缀哈希不受影响
 */
const ADVISOR_NOTE = '历史里标【顾问】的话是人工顾问说的，不是你说的；顾问答应过的事以顾问为准，不要改口，也不要在自己的回复里写【顾问】。';
/** 敏感信息的两个类别（R23，02 第 16 步）：contextNote 的提醒、同意菜单的触发按这个顺序检查 */
const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = ['health', 'minor'];

/**
 * 敏感信息同意（R23，02 第 16 步）：客户这句话里第一次／第二次出现某个还没有结论的类别，本轮回复之后追加一条企微菜单消息
 * （写进会话、经渠道发送，message_seq 为空）。没有发布隐私说明时 currentPrivacyNotice() 为 null，什么都不做（demo 恒为 null，
 * 不变量 40）。送达才记进会话——跟欢迎语同一个口径，没送达的话不该在后台显得「AI 已经问过」
 */
async function maybeAskConsent(sessionId: string, text: string): Promise<void> {
  const notice = currentPrivacyNotice();
  if (!notice) return;
  const categories = sensitiveCategoriesOf(text);
  if (!categories.length) return;
  const session = getSession(sessionId);
  if (!session) return;
  const toAsk = noteSensitiveMentions(session, categories, notice.version, cleanText(text, 200));
  if (!toAsk.length) return;
  saveSession(session);
  // 03：库里的企微账号把每张菜单的 pending 排进「问过」的同一次落库（同一段同步代码里），逐张 push 时交回去
  const prepared = toAsk.map((category) => prepareChannel(sessionId, consentMenuText(category), { kind: 'menu', category }));
  for (const [i, category] of toAsk.entries()) {
    const content = consentMenuText(category);
    const ok = await pushToChannel(sessionId, content, { kind: 'menu', category, prepared: prepared[i] ?? null });
    if (ok) {
      session.messages.push({ role: 'agent', content, at: Date.now() });
      saveSession(session);
    } else {
      console.warn(`[engine] 同意菜单没送达（会话 ${convLabel(sessionId)}，类别 ${category}）`);
    }
  }
}

/**
 * 对外入口：同会话串行，跨会话并发。一轮的正文包在 pinCatalogForTurn 里（02 R14、不变量 36）：轮到它真正开始时记下产品库快照，
 * 这一轮的工具、链接上的 ?v= 与护栏都看这一代，中途有人改价也不混用。文件模式下什么都不做。
 * 同意菜单在同一段串行链里、这一轮的回复之后处理（R23）：失败只打日志，不影响这一轮已经算出的回复
 */
export function handleMessage(sessionId: string, text: string, channel: string, opts: HandleOpts = {}): Promise<AgentReply> {
  return serialize(sessionId, async () => {
    const reply = await pinCatalogForTurn(() => withTurnScope(() => handleMessageInner(sessionId, text, channel, opts)));
    try {
      await maybeAskConsent(sessionId, text);
    } catch (e) {
      console.error(`[engine] 同意菜单处理异常（会话 ${convLabel(sessionId)}）:`, e instanceof Error ? e.message : e);
    }
    return reply;
  });
}

async function handleMessageInner(sessionId: string, text: string, channel: string, opts: HandleOpts): Promise<AgentReply> {
  text = inboundText(text);
  const session = getOrCreateSession(sessionId, channel);
  // 逐轮 trace（02 spec）：确定性路径也记。每个出口经 done 结束这一轮，与写进回复、saveSession 在同一段同步代码里
  startTurn(sessionId, text);
  const stageBefore = session.stage;
  const done = (outcome: TurnOutcome, r: AgentReply, msg?: ChatMessage): AgentReply => {
    endTurn(outcome, r.text, stageBefore, session.stage, msg);
    if (msg) replyMessages.set(r, msg);
    return r;
  };
  // 接手代次（02 spec「接手、人工回复与交还」、不变量 28）：这一轮开始时记下，模型返回之后与 AI 回复 push 进会话之前各同步比一次，
  // 变了（这一轮里有人接手，含接手之后又交还）就不发，记一条「本轮未发送（顾问已接手）」
  const turnGen = takeoverGen(sessionId);
  const takenOver = (): boolean => takeoverGen(sessionId) !== turnGen;
  const unsentTakenOver = (): AgentReply => {
    session.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
    saveSession(session);
    return done('silent', { text: '', stage: session.stage, ...(session.handedOver ? { handoff: true } : {}), silent: true });
  };

  // 重置口令（演示/测试便利）：清空会话并解除转人工，从头开始。网页与企微都生效——
  // 这是演示项目，拿手机微信反复走流程是主要用法（2026-09 曾限定为仅网页，被要求改回）。
  // 代价是接真实客户后，客户发一句「重新开始」就会绕过人工、清空聊天记录、连已支付订单一起删掉，
  // 所以 prod 用 reset_command 开关把它关掉：口令按普通客户消息处理，见下方转人工静默之后的固定回复
  const isReset = /^\s*(重置|重新开始|重来|清空会话|reset)\s*$/i.test(text);
  if (isReset && profile().flags.reset_command) {
    // 企微的口令带 msgid：先把这句记下、分到 seq（db 存储下随这次落库进库，在重置之后的窗口之外），msgid 就进了 7 天集合，
    // 重放或重新拉到这条时按去重情况 2 跳过，不再重置一遍（02 第 12 步审查 once[5]）。窗口里照旧只留重置回复；文件存储下什么都不变
    if (opts.msgid && !opts.alreadyRecorded) {
      const customerMsg: ChatMessage = {
        role: 'customer',
        content: text,
        at: Date.now(),
        msgid: opts.msgid,
        ...(opts.sentAt ? { sentAt: opts.sentAt } : {}),
      };
      session.messages.push(customerMsg);
      saveSession(session);
      // 03：入站行记 recorded，与这句同一次落库（saveSession 刚给它分了 seq）
      if (opts.inboxId) queueInboxState(session.id, { inboxId: opts.inboxId, state: 'recorded', message: customerMsg });
    }
    session.stage = 'greeting';
    session.profile = {};
    // 只追加（R5）：db 存储下库里的旧消息都留着，重置只体现为窗口起点推进到重置回复那一条；先告诉 store 这是重置，
    // 严格模式的 seq 分配才不把「窗口里原有的消息全没了」当成整体换成了副本。文件存储下什么都不变
    noteWindowReset(session);
    session.messages = [];
    // 订单要真删，不能只清引用：后台按 sessionId 反查订单，GMV/成交率也是直接扫
    // orders 算的，留着孤儿订单会让重置后的会话仍显示订单、仍计入经营数据
    deleteOrdersOfSession(session.id);
    session.orderIds = [];
    session.handedOver = false;
    // 旧的接管前阶段不清掉，下次交还 AI 时会把新对话恢复成重置前的阶段
    delete session.stageBeforeHandoff;
    session.lastQuote = undefined;
    session.quoteHistory = undefined;
    session.budgetGaps = undefined;
    session.lastShownRoutes = undefined;
    session.seenRouteIds = undefined;
    session.missedDestinations = undefined;
    // 转人工记录、接手人与两种计数一起清（R9）；firstHandoffAt、handoffCount 永不清。待执行的转人工通知一并取消，随这次落库提交
    // （db 存储；文件存储与 demo 类没有任务表，queueJobs 什么都不做）
    queueJobs(session.id, cancelHandoffNotifyOps(session.id));
    delete session.handoff;
    delete session.assignee;
    delete session.turnSignals;
    delete session.negativeHits;
    session.updatedAt = Date.now();
    const reply = '好的，我们重新开始～这次想去哪儿玩呢？😊';
    const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('reset', { text: reply, stage: 'greeting' }, msg);
  }

  // 企微重放时这句可能已经记在会话末尾（见 HandleOpts.alreadyRecorded）：不再记一遍，也不删了重记（消息只追加）
  let customerMsg: ChatMessage | null = null;
  if (!opts.alreadyRecorded) {
    customerMsg = {
      role: 'customer',
      content: text,
      at: Date.now(),
      ...(opts.msgid ? { msgid: opts.msgid } : {}),
      ...(opts.sentAt ? { sentAt: opts.sentAt } : {}),
    };
    session.messages.push(customerMsg);
    trimSessionMessages(session);
  }
  // 跟进的拒绝识别（02 spec「任务表与跟进」，两种存储都做）：客户说「别发了」这类话就记下，此后这个会话不再跟进。
  // 只记标记，这一轮照常回复；db 存储下排着的跟进随这次落库取消（src/jobs/followup.ts 的落库钩子：客户回话即取消）
  if (!session.followupOptOut && followupOptOutOf(text)) {
    session.followupOptOut = { at: Date.now(), quote: cleanText(text, 200) };
    console.log(`[followup] 客户拒绝跟进，此后不再跟进（会话 ${convLabel(session.id)}）`);
  }
  // 负面情绪的窗口（02 spec「确定性转人工触发」、R15、开放问题 4）：每条客户消息的强弱都记进最近 3 条客户消息的窗口，
  // 紧急那一句、已转人工期间的、prod 下被关掉的重置口令那一句也记（第 11 步第三轮审查 consistency[1]：原先这几句不记，
  // 更早的弱词会多留一轮）；阈值只在下面 AI 接待的路径上判。投诉（isComplaint）由安全网按投诉转人工，记 0，不重复计。
  // 企微重放（alreadyRecorded）不再记：这句上次已经和它的窗口值一起落了库（记窗口与入库在同一段同步代码里，同一次落库的快照里两样都在）
  const negative = isComplaint(text) ? 0 : negativeLevel(text);
  if (!opts.alreadyRecorded) setWindow(session, 'negativeHits', pushWindow(session.negativeHits, negative, SENTIMENT_WINDOW));
  // 先落一次盘：客户这句话立刻出现在作战室（并经 SSE 推给前端），顾问看到的是
  // 「客户刚说了什么 + AI 正在生成回复」。此前要等整轮跑完（4~10 秒）才落盘，
  // 后台看起来像卡住了——延迟其实来自这里，不是 SSE。
  saveSession(session);
  // 03：入站行记 recorded，与这句同一次落库（与上面 push 是同一段同步代码，saveSession 刚给它分了 seq）
  if (customerMsg && opts.inboxId) queueInboxState(session.id, { inboxId: opts.inboxId, state: 'recorded', message: customerMsg });

  // 紧急情况（02 spec「确定性转人工触发」、R15、不变量 29）：客户消息入库之后、「已转人工」判断之前判，本轮不调模型。
  // 已转人工：不回话（00 不变量 14），只把记录升级为 emergency，enterHandoff 再发一次 handoff.started（升级）、db 存储下再排一个
  // 立即的 handoff_notify，随下面静默分支的落库提交。终态会话（已付款、正在出行）照样转人工、阶段保留终态（R9）
  const emergency = emergencyOf(text);
  if (emergency) {
    const wasHandedOver = session.handedOver;
    const departNote = departNoteForHandoff(session);
    enterHandoff(session, {
      kind: 'emergency',
      at: Date.now(),
      reason: emergencyReason(emergency),
      quote: cleanText(text, 200),
      ...(departNote ? { departNote } : {}),
    });
    if (!wasHandedOver) {
      // 同一句在问身份时先承认是 AI（00 不变量 16）
      const reply = cleanText(answerIdentity(text, EMERGENCY_REPLY));
      const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
      session.messages.push(msg);
      saveSession(session);
      return done('handoff', { text: reply, stage: session.stage, handoff: true }, msg);
    }
  }

  // 撤回同意与删除请求（R23，02 第 16 步）：客户命中 consentWithdrawalOf，本轮不调模型，固定回复，转人工（kind='consent'）。
  // 只在发布过隐私说明时判（没发布就没有同意记录可撤回，demo 永远不会走到这里，不变量 40）；已经转人工（无论什么原因）
  // 也照样回这一句、记录撤回——这是客户的行权请求，不该被「已转人工静默」吞掉
  if (currentPrivacyNotice() && consentWithdrawalOf(text)) {
    withdrawConsent(session, cleanText(text, 200), currentPrivacyNotice()!.version);
    const departNote = departNoteForHandoff(session);
    enterHandoff(session, {
      kind: 'consent',
      at: Date.now(),
      reason: CONSENT_WITHDRAWAL_REASON,
      quote: cleanText(text, 200),
      ...(departNote ? { departNote } : {}),
    });
    const msg: ChatMessage = { role: 'agent', content: CONSENT_WITHDRAWN_REPLY, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('handoff', { text: CONSENT_WITHDRAWN_REPLY, stage: session.stage, handoff: true }, msg);
  }

  // 已转人工：AI 彻底沉默，只记录客户消息（供后台人工查看），不再自动回复。
  // 转人工的那一句确认在触发时已发过，之后重复「已转人工」既烦又不专业。
  // 阶段停在终态（已成交客户要人工，R9）的不改回 handoff：成交统计不变
  if (session.handedOver) {
    if (!isTerminalStage(session.stage)) session.stage = 'handoff';
    // 人工接待期间客户的话也进了情绪窗口（上面入库时记的），这里只记不判：交还 AI 之后窗口里是最近 3 条，
    // 转人工那一句带的弱词不会隔着整段人工接待和交还后的一句凑成 2 弱（第 11 步第二轮审查 engine[2]）
    saveSession(session); // 客户消息已在上方入库
    return done('silent', { text: '', stage: session.stage, handoff: true, silent: true });
  }

  // 重置口令被 reset_command 关掉（prod）：已入库、已转人工时照常静默（上面），否则回一句固定话术，
  // 不调模型，阶段、画像、订单一概不动。交给模型的话，它可能顺着口令说「已经清空、重新开始」，会话其实什么都没变
  if (isReset) {
    const reply = '想换方向或改订单，直接告诉我新的需求就行～';
    const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('deterministic', { text: reply, stage: session.stage }, msg);
  }

  // 负面情绪：这条客户消息的强弱在入库时已经记进窗口（见上）；企微重放不再记，阈值照现有的窗口判。
  // 交互失败的窗口在回复出来之后才记，重放照常记

  // 转人工安全网：明确要人工/投诉/退款时，引擎确定性转人工，不赌模型是否调工具
  // （模型常「嘴上说转接、实际没调 handoff」，导致下一句又继续卖）。
  if (isHandoffIntent(text)) {
    const kind = safetyNetKind(session, text);
    const departNote = departNoteForHandoff(session);
    enterHandoff(session, {
      kind,
      at: Date.now(),
      reason: HANDOFF_REASON[kind],
      quote: cleanText(text, 200),
      ...(departNote ? { departNote } : {}),
    });
    const reply = cleanText(answerIdentity(text, handoffReply(session, text, kind)));
    const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('handoff', { text: reply, stage: session.stage, handoff: true }, msg);
  }

  // 负面情绪达到阈值（最近 3 条里 1 强或 2 弱），而且这一句本身是负面的（交还之后一句中性的话不按情绪转人工）：
  // 与投诉同样处理（handoffReply 的投诉措辞），kind='sentiment'，本轮不调模型；窗口清零
  if (negative > 0 && sentimentThresholdReached(session.negativeHits ?? [])) {
    const departNote = departNoteForHandoff(session);
    enterHandoff(session, {
      kind: 'sentiment',
      at: Date.now(),
      reason: HANDOFF_REASON.sentiment,
      quote: cleanText(text, 200),
      ...(departNote ? { departNote } : {}),
    });
    delete session.negativeHits;
    const reply = cleanText(answerIdentity(text, handoffReply(session, text, 'complaint')));
    const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('handoff', { text: reply, stage: session.stage, handoff: true }, msg);
  }

  // 客户要重发支付链接：确定性地重发那张待付款单，不经过模型、不转人工（见 RESEND_ASK）
  const turnContext: TurnContext = {
    session,
    text,
    // preModel/contextNote 不调用工具；此能力在后面的预取位置才使用。
    callTool: async (name, args) => {
      const result = await runTool(name, args, { prefetch: true });
      return { name, args: calls[calls.length - 1]?.args ?? args, result };
    },
  };
  const resend = turnHooks.preModel?.(turnContext);
  if (resend) {
    const reply = cleanText(answerIdentity(text, resend.text));
    const msg: ChatMessage = { role: 'agent', content: reply, at: Date.now() };
    session.messages.push(msg);
    saveSession(session);
    return done('deterministic', { text: reply, stage: session.stage }, msg);
  }

  const ordersBefore = session.orderIds.length;
  // 本轮开始时的阶段。await 期间客户可能刚好付款（notifyPaid 直接改同一个 session 对象），
  // 拿被改过的 stage 去 advanceStage 会把 paid 推回 discovery/recommend，已成交客户在
  // 后台漏斗里凭空退档，followup 里 `stage === 'paid'` 的免打扰保护也跟着失效。
  const stageAtStart = session.stage;
  const talk = session.messages.filter((m) => m.role !== 'system');
  // 企微重放「已记下、回复还没生成」：这句后面可能夹了欢迎语（handleEnterSession 直接写进会话）。会话里这句留在原位（消息只追加），
  // 发给模型的历史照 02 之前的样子把它挪到末尾（那时适配器删掉再记一遍），模型回答的是客户这句，contextNote 也插在它前面
  if (opts.alreadyRecorded) {
    const i = talk.findLastIndex((m) => m.role === 'customer');
    if (i >= 0 && i < talk.length - 1) talk.push(...talk.splice(i, 1));
  }
  // 人工回复（author='human'）映射成 assistant、正文前加「【顾问】」：交还之后模型分得清哪些话是顾问说的（不变量 18）
  const windowed = historyWindow(talk);
  const advisorInWindow = windowed.some((m) => m.role === 'agent' && m.author === 'human');
  const history = windowed.map((m) => ({
    role: m.role === 'customer' ? ('user' as const) : ('assistant' as const),
    content: m.role === 'agent' && m.author === 'human' ? withAdvisorPrefix(m.content) : m.content,
  }));

  // 记录本轮工具调用，用于事后推导阶段/画像
  const calls: ToolCall[] = [];
  /** 本轮模型要转人工、被引擎驳回了（见 unwarrantedHandoff）：回复里再说「为您转接」就摘掉，不按转人工处理 */
  let handoffDeclined = false;
  /** 本轮所有工具调用的唯一入口：模型发起的和引擎预取的走同一条路，calls 记录、观测者通知、日期拦截、
   *  参数核正（groundToolArgs）都一致 */
  const toolRegistry = createToolRegistry<TurnToolContext>(
    toolDefs.map((def) => {
      const spec = getToolSpec(def.function.name)!;
      return {
        ...spec,
        // 完整结果在注册表记结果之前补上提醒，afterTool 只补会话状态。
        execute: async (args: unknown, ctx: TurnToolContext) => {
          ctx.hints = turnHooks.hintsFor(def.function.name, ctx);
          return turnHooks.withNotes(await spec.execute(args, ctx), ctx.notes);
        },
      };
    }),
    turnHooks,
  );
  const runTool = (name: string, modelArgs: Record<string, unknown>, meta?: ToolCallMeta): Promise<string> => {
    const ctx: TurnToolContext = { session, text, hints: {}, args: modelArgs, notes: {}, handoffDeclined: false };
    let call: ToolCall | undefined;
    const running = toolRegistry.execute(name, modelArgs, ctx, {
      recordCall(toolName, actualArgs) {
        const args = actualArgs as Record<string, unknown>;
        ctx.args = args;
        call = { name: toolName, args };
        calls.push(call);
        for (const fn of toolObservers) {
          try {
            fn(toolName, args, sessionId, meta);
          } catch {
            /* 观测者出错不影响对话 */
          }
        }
      },
      recordResult(_name, result) {
        call!.result = result;
        noteToolResult(call!.args, result);
      },
    });
    handoffDeclined ||= ctx.handoffDeclined;
    // 执行抛错仍由调用方处理；拒绝的调用没有 call，不记录执行失败。
    running.catch(() => {
      if (call) noteToolError(call.args);
    });
    return running;
  };
  // 公开链接会被陌生人（和脚本）随便点，网页访客的真实 LLM 轮次有日预算上限。
  // 超额后降级到离线脚本回复——演示流程照样走得完，只是话术固定；
  // 企微渠道是真实客户，永远不降级。
  const visitor = channel === 'simulator';
  // 「查额度」和「记一笔」必须是同一个同步动作：此前是 check-then-act，
  // 上千个并发请求会在第一个 chat() 返回前全部读到同一个未超限的计数，日预算整体失守。
  const reserved = visitor && tryReserveVisitorLLM(sessionId);
  const degraded = visitor && !reserved;

  // 会话状态在预取之前拼：预取的结果已经以工具消息的形式给了模型，不必在状态里再列一遍。
  // 三样齐全时附一句「这一轮报价」（见 quoteTimingNote）
  const contextNote = [
    '【当前会话状态】',
    `今天日期: ${todayIso()}（客户说的月日一律按未来最近的日期理解）`,
    `销售阶段: ${session.stage}`,
    `客户画像: ${JSON.stringify(profileForPrompt(session.profile))}`,
    ...turnHooks.contextNote(turnContext),
    advisorInWindow ? ADVISOR_NOTE : '',
    // 问过还没有结论的敏感信息类别（R23）：提示模型别在回复里主动提它，没问过或已有结论的会话一个字节都不变
    ...SENSITIVE_CATEGORIES.filter((c) => awaitingConsent(session, c)).map(sensitiveContextNote),
    session.channel === 'web' ? '客户正在网页上咨询，不在微信里；说到顾问跟进时，请说顾问会在这个页面里回复您，不要说在微信上联系。' : '',
  ]
    .filter(Boolean)
    .join('\n');
  // 保留整轮的分段耗时；包预取失败时返回已完成的结果。
  const turnStart = Date.now();
  const prefetched = await turnHooks.prefetch?.(turnContext);
  const prefetch: PrefetchedCall[] = prefetched?.calls ?? [];
  const prefetchTimes = prefetched?.timings ?? [];
  const modelStart = Date.now();
  const turn = turnPrefix();
  notePrefix(turn.sopVersion, turn.prefixHash());
  const raw = await chat({
    system: turn.system,
    contextNote,
    prefetch,
    messages: history,
    tools: toolDefs,
    forceMock: degraded,
    sessionId,
    executeTool: (name, args) => runTool(name, args),
    // 命中较早缓存后的展示状态重放由工具声明提供，门面适配旧回调签名。
    onReuse: (name, _args, result) => reuseToolResult(name, result, session),
  });
  // 额度已在调用前占掉（tryReserveVisitorLLM），失败也不退还：token 是真花出去了
  const modelMs = Date.now() - modelStart;
  noteDraft(raw);

  let finishedReply: AgentReply | undefined;
  let replyMsg: ChatMessage | undefined;
  const ctx: ReplyGuardContext = {
    session,
    text: raw,
    raw,
    inputText: text,
    stageAtStart,
    ordersBefore,
    handoffDeclined,
    turn: {
      flags: {
        emptyModelReply: false,
        wantsOrder: false,
        customPromise: '',
        handedOverSelfDecided: false,
        guardHit: null,
        preDropSnapshot: '',
        saidAll: [],
      },
    },
    toolSources: calls,
    orderSources: session.orderIds.map((id) => getOrder(id)).filter((o): o is Order => !!o),
    brand: null,
    thresholds: travelPriceThresholds,
    takenOver,
    isTerminalStage,
    advanceStage,
    extractProfile,
    fallbackReply,
    answerIdentity,
    handoffReply,
    departNoteForHandoff,
    failureReason: HANDOFF_REASON.failure,
    handoffFallback: HANDED_OVER_FALLBACK,
    recordGuard: noteGuard,
    recordSignals: noteSignals,
    appendMessage(message) {
      session.messages.push(message);
      if (message.role === 'agent') replyMsg = message;
    },
    enterHandoff: (record) => enterHandoff(session, record),
    callTool: runTool,
    // 保留旧成单安全网的观测路径：记工具 trace，但不追加模型/补链 calls。
    async createOrder(args) {
      for (const fn of toolObservers) {
        try {
          fn('create_order', args, sessionId);
        } catch {
          /* 观测者不影响业务 */
        }
      }
      const result = await executeTool('create_order', args, session);
      noteToolResult(args, result);
      return result;
    },
  };
  await replyPipeline.run(ctx, {
    onVerdict: noteGuardVerdict,
    onComplete(result) {
      if (result.aborted) {
        finishedReply = unsentTakenOver();
        return;
      }
      saveSession(session);
      logSlowTurn(session.id, Date.now() - turnStart, { prefetchMs: modelStart - turnStart, prefetchTimes, modelMs, tag: turn.tag });
      if (configMode() === 'db') console.log(`[engine] 本轮完成（会话 ${convLabel(session.id)}）· ${turn.tag()}`);
      const reply: AgentReply = { text: ctx.text, stage: session.stage };
      if (session.handedOver) reply.handoff = true;
      if (session.orderIds.length > ordersBefore) reply.orderId = session.orderIds[session.orderIds.length - 1];
      finishedReply = done(session.handedOver ? 'handoff' : degraded ? 'budget' : 'replied', reply, replyMsg);
    },
  });
  return finishedReply!;
}

/** 紧急情况的固定应急话术（02 spec「确定性转人工触发」） */
const EMERGENCY_REPLY =
  '您的安全最要紧。如果有生命危险，请马上拨打 120（在境外请拨当地的急救电话）；证件丢了先到就近的派出所或我国使领馆求助。我已经通知顾问，会尽快联系您。';

/** 失败与情绪的窗口：pushWindow 全 0 时返回 undefined，会话上就不留这个键 */
function setWindow(session: Session, key: 'turnSignals' | 'negativeHits', w: number[] | undefined): void {
  if (w) session[key] = w;
  else delete session[key];
}

/**
 * 整轮（预取 + 模型往返 + 出口护栏）超过 LLM_SLOW_TURN_MS（默认 8000）时打一行分段耗时。llm.ts 的同名日志有逐次调用的明细，
 * 但只从 chat() 里面算起；两行对照着看，才分得清慢在预取、模型还是出口修补（补发方案书要再调一次工具）
 */
function logSlowTurn(
  sessionId: string,
  totalMs: number,
  t: { prefetchMs: number; prefetchTimes: string[]; modelMs: number; tag: () => string },
): void {
  if (totalMs <= Math.max(0, numEnv('LLM_SLOW_TURN_MS', 8000))) return;
  const pf = t.prefetchTimes.length ? `预取 ${t.prefetchMs}ms（${t.prefetchTimes.join(' + ')}）` : `预取 ${t.prefetchMs}ms`;
  console.warn(
    `[engine] ⚠️ 整轮耗时 ${totalMs}ms（会话 ${convLabel(sessionId)}）：${pf} · 模型 ${t.modelMs}ms · 出口 ${totalMs - t.prefetchMs - t.modelMs}ms · ${t.tag()}`,
  );
}

/**
 * AI 回复所用的同一套出口护栏，给跟进这类不在对话轮次里的出站文本（02 spec「任务表与跟进」）：链接白名单、去 markdown、内部用语、
 * 空头承诺（改行程、说了发链接却没有链接、说了转接顾问、说了由顾问确认或顾问会联系）、价格规则与服务承诺、价格。
 * 与对话轮次不同的只有「没有这一轮」：没有工具调用（方案书链接一律抹掉，支付链接只认本会话没被替代的真订单），没有客户这一句
 * （金额只认会话里有出处的）；命中的只删那几句，不补链接、不换兜底话术、不转人工。全删光或删完只剩残句时返回空串，由调用方决定发什么。
 * 不在轮次里调用时 noteGuard 什么都不记（02「逐轮 trace」只记对话轮次）
 */
export async function guardOutbound(session: Session, text: string, _opts: { kind: 'followup' }): Promise<string> {
  const forbidden = (): never => {
    throw new Error('跟进护栏不允许建单或转人工');
  };
  const ctx: FollowupGuardContext = {
    session,
    text,
    turn: { flags: {} },
    toolSources: [],
    orderSources: [],
    brand: null,
    thresholds: travelPriceThresholds,
    createOrder: forbidden,
    enterHandoff: forbidden,
    async callTool(name, args) {
      const tool = getToolSpec(name);
      if (!tool || tool.sideEffects.length) throw new Error(`跟进护栏不允许调用有副作用或未注册的工具：${name}`);
      return executeTool(name, args, session);
    },
    recordGuard: noteGuard,
  };
  // 不接 noteGuardVerdict：执行器的内部裁决不写进跟进 trace（R9）。
  return (await followupPipeline.run(ctx)).text;
}

/**
 * 支付成功后的主动跟进：写入会话并置 stage=paid，推送由调用方经 adapter 完成。
 * message 是写进会话的那条（推送时交给发送账本，02 第 12 步）
 */
export async function notifyPaid(
  orderId: string,
): Promise<{ sessionId: string; text: string; message: ChatMessage; prepared: PreparedPush | null } | null> {
  const order = getOrder(orderId);
  if (!order?.sessionId) return null;
  const session = getSession(order.sessionId);
  if (!session) return null;
  const text = cleanText(
    `已收到您的支付，太开心啦 🎉\n《${order.routeTitle}》${order.travelers} 位出行、` +
      `${order.departDate} 出发已确认预订。\n专属旅行顾问稍后会与您对接行程细节和出行准备，` +
      `有任何想法随时跟我说～`,
  );
  session.stage = 'paid';
  const message: ChatMessage = { role: 'agent', content: text, at: Date.now() };
  session.messages.push(message);
  saveSession(session);
  // 03：库里的企微账号把付款确认的分段 pending 排进这条消息的同一次落库（同一段同步代码里），调用方 push 时交回去
  const prepared = prepareChannel(session.id, text, { kind: 'notice', message });
  return { sessionId: session.id, text, message, prepared };
}

/** 仅供自测：确定性转人工触发（handoff.selftest.ts）。应急话术给断言比对 */
export const __triggerTest = { EMERGENCY_REPLY };

/** 仅供自测：订单与转人工这组判定 */
export const __orderTest = { haggling, OTHER_ORDER, RESEND_ASK, claimsTransfer, saysDay, trimDangling, monthSaid };

/** 仅供自测使用的内部函数出口 */
export const __engineTest = {
  dejargon,
  restoreProposalSuffixes,
  CUSTOM_PROMISE,
  LINK_PROMISE,
  PROPOSAL_PROMISE,
  promiseInsertAt,
  markLinkHoles,
  requestedDays,
  isObjection,
  PURCHASE_INTENT,
  IDENTITY_QUESTION,
  detectSegment,
  isHandoffIntent,
  keptBesideCustomPromise,
  statedPastDate,
  BUDGET_RE,
  planPrefetch,
  perPersonBudget,
  buildSystemPrompt,
  spokenDepartDate,
  isBudgetTalk,
  BUDGET_FLOOR,
  departNoteForHandoff,
  planDetailPrefetch,
  quoteTimingNote,
  routeInFocus,
  routesIn,
  toolHints,
  dropProposalOffers,
  resolveDepartDate,
  latestDepart,
};
