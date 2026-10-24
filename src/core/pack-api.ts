import { currentRuntime, tenantRuntimes, runtimeOf } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { packPipelines } from './engine/pipelines.js';
// 04 R2、R3：行业包取得核心能力的唯一出口；这里不装载行业包，也不引旧门面。
import type { SectionSpec } from '../shared/sop-sections.js';
import type { CustomerProfile, HandoffRecord, Hotel, Order, Route, SalesStage, Session } from '../types.js';
import type { ToolDef } from '../tool-defs.js';
import type { MoneyParseOptions } from './parse/money.js';
import type { PaymentMode } from '../shared/conversation-types.js';
import type { AnyOrder, LineOrder } from './order-view.js';
import type { RefundQuote, RefundTexts } from './refund.js';
import type { CatalogItem, ConversationNeed, ConversationQuote } from '../shared/console-api.js';
import type { CatalogSnapshot } from '../config/source.js';
import { z } from 'zod';

export type { CustomerProfile, SalesStage, Session, Order, AgentReply, Route, Hotel } from '../types.js';
export type { ToolDef } from '../tool-defs.js';
export { quoteRefund, type RefundQuote, type RefundTexts } from './refund.js';
export { deepFreeze } from '../shared/freeze.js';
export { ALWAYS_LOCKED, CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, REPRICE_FIELDS, type CatalogKind } from '../shared/catalog.js';
export { UNSTORABLE_TEXT, type CatalogItem } from '../shared/console-api.js';
export {
  checkItem,
  checkPack,
  ENTITY_ICONS,
  type CheckIssue,
  type EntityType,
  type FieldDef,
  type IndustryPack,
  type ItemCheck,
} from '../shared/pack.js';
export type { QuickReplyDefault } from '../shared/quick-reply-defaults.js';
export { createLineOrder, orderDisplay, type LinePick } from './order-view.js';
export { yuanToFen } from '../shared/catalog-money.js';
export type { SectionSpec, SectionSpec as SopSectionDef, SopSection } from '../shared/sop-sections.js';

// 04 第 7 步：包只经本出口取得通用解析；调用方显式传入金额政策。
export {
  amountHits,
  normalizeMoneyText,
  parseAmounts,
  parseCnAmounts,
  parseMoney,
  parseRangeEndpoints,
  parseSpokenAmounts,
  spokenMoney,
  type AmountHit,
  type Money,
  type MoneyParseOptions,
  type SpokenAmount,
} from './parse/money.js';
export { clauses, sentences, sentenceUnits } from './parse/sentences.js';

// 04 第 8 步：日期/人数语境由调用方选，核心不装载旅游节日与范围政策。
export {
  budgetHeadcount,
  groupSizeIn,
  hasTotalHeadcount,
  headcountIn,
  parseCountArg,
  parseDayCount,
  spokenHeadcounts,
  type CountRange,
  type Headcount,
  type HeadcountRead,
} from './parse/counts.js';
export {
  addDays,
  dayInMonth,
  isAside,
  isMonthAside,
  isRealDate,
  isValidIsoDate,
  isoOf,
  latestDepart,
  MONTH_PATTERN,
  monthSaid,
  monthsOf,
  readDepartDates,
  resolveDepartDate,
  saysDay,
  spokenDepartDate,
  statedPastDate,
  whensIn,
  type DateParsePolicy,
  type DateReadResult,
  type DateSpan,
  type HolidayLeft,
  type MonthMention,
  type MonthParsePolicy,
  type SpokenDate,
  type YearMonth,
} from './parse/dates.js';

// 04 第 9 步：价格护栏的输入与读取能力；旧门面接线，包不直接读取核心存储或工具门面。
export { cleanText } from '../shared/text.js';
export { peakMonths } from '../shared/season.js';
export type { PaymentMode, HandoffRecord } from '../shared/conversation-types.js';

export interface TurnToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface PriceGuardSources {
  loadRoutes(): Route[];
  loadHotels(): Hotel[];
  getOrder(id: string): Order | undefined;
  isConfigNotReadyError(error: unknown): boolean;
  mentionsPlace(text: string, word: string): boolean;
  isOriginMention(text: string, word: string): boolean;
  offCatalogPlaces(text: string): { kw: string; at: number }[];
}

export interface PriceRuleSources extends Pick<PriceGuardSources, 'loadRoutes' | 'getOrder' | 'isConfigNotReadyError' | 'mentionsPlace'> {
  paymentMode(): PaymentMode;
}

export interface PriceThresholds extends MoneyParseOptions {
  tierTolerance: number;
  maxTravelers: number;
  groupMinimum: number;
  groupDiscount: number;
  peakMultiplier: number;
  lowlandMaxAltitude: number;
}

export type SopContractRule =
  | { id: string; kind: 'include'; text: string; from: string }
  | { id: string; kind: 'exclude'; text: string; from: string }
  | { id: string; kind: 'exclude-pattern'; pattern: RegExp; from: string };

export interface BrandProfile {
  brandName: string;
  advisorTitle: string;
  aiTitle: string;
  scopeNoun: string;
  identityLine: string;
}

// 04 第 10 步：工具运行时与包所需的能力。能力由旧门面接线，调用时读取当前配置/存储。
export { SALES_SEGMENTS, type SalesSegment } from '../types.js';

export interface ToolHints {
  elder?: boolean;
  altitudeWorry?: boolean;
  handoff?: Pick<import('../shared/conversation-types.js').HandoffRecord, 'quote' | 'departNote'>;
}

export interface ToolContext {
  session: Session;
  hints: ToolHints;
  /** R12 删除取消；正常停机排空不会触发。异步工具在落地前检查。 */
  cancel?: AbortSignal;
}

export interface ToolHooks<Context = ToolContext> {
  beforeTool?(name: string, args: unknown, ctx: Context): { args: unknown } | { reject: string };
  afterTool?(name: string, result: ToolResult, ctx: Context): void;
}

/** 调用记录的落点由调用方提供，分派器负责钩子相对它们的执行顺序。 */
export interface ToolCallRecorder {
  recordCall(name: string, args: unknown): void;
  recordResult(name: string, result: ToolResult): void;
}

export interface TravelToolSources {
  configMode: typeof import('../config/source.js').configMode;
  currentCatalog: typeof import('../config/source.js').currentCatalog;
  catalogVersionKey: typeof import('../config/source.js').catalogVersionKey;
  catalogItemAt: typeof import('../config/source.js').catalogItemAt;
  indexReady(): boolean;
  semanticRecall(query: string, topK?: number): Promise<{ id: string; score: number }[] | null>;
  budgetVerdict(
    session: Session,
    quote: { perPerson: number; total: number; travelers: number },
  ): { fields: Record<string, unknown>; gap?: number } | undefined;
  createOrder: typeof import('../store.js').createOrder;
  getOrder: typeof import('../store.js').getOrder;
  queueJobs: typeof import('../store.js').queueJobs;
  saveSession: typeof import('../store.js').saveSession;
  supersedeOrder: typeof import('../store.js').supersedeOrder;
  todayIso(): string;
  paymentMode(): PaymentMode;
  orderUnconfirmedNotifyOps: typeof import('../jobs/notify.js').orderUnconfirmedNotifyOps;
  enterHandoff: typeof import('../handoff/record.js').enterHandoff;
  modelHandoffReason: string;
}

/** 平台输入是完整档案；不接受额外字段（尤其是凭据），不改写品牌文字。 */
const brandText = z.string().refine((text) => text.trim().length > 0, '品牌字段不能为空');
export const BrandProfileSchema: z.ZodType<BrandProfile> = z.strictObject({
  brandName: brandText,
  advisorTitle: brandText,
  aiTitle: brandText,
  scopeNoun: brandText,
  identityLine: brandText,
});
export const BRAND_FIELDS = [
  'brandName',
  'advisorTitle',
  'aiTitle',
  'scopeNoun',
  'identityLine',
] as const satisfies readonly (keyof BrandProfile)[];

/** 当前工具的 wire 结果仍是 JSON 字符串，不在本步改变工具契约。 */
export type ToolResult = string;

/** 08 R8：确定性工具给出的整数分；标签仅供追溯，不进入模型上下文。 */
export interface MoneyEntry {
  fen: number;
  label: string;
}

export interface ToolSpec<Context = ToolContext> {
  def: ToolDef;
  sideEffects: ReadonlyArray<'session' | 'order' | 'handoff' | 'notify'>;
  cacheable: boolean;
  blocksRetry: boolean;
  onReuse?(result: ToolResult, ctx: Context): void;
  execute(args: unknown, ctx: Context): Promise<ToolResult>;
  amounts?(result: ToolResult, args: unknown): readonly MoneyEntry[];
}

// 04 第 11 步：模型输入与离线策略，旅游解析留在包内。
export { todayIso } from '../env.js';
export type { ChatTurn, PrefetchedCall, ChatOptions, MockPolicy, LlmRuntime } from './llm/types.js';
import type { MockPolicy } from './llm/types.js';

// 04 第 13 步：包只补行业 context、预取与确定性回复；历史与落盘由核心掌管。
export { convLabel, logQuote } from '../log.js';

export interface TurnContext {
  session: Session;
  text: string;
  /** 品牌模板模式下的品牌（旧版模式为 null）；contextNote 里对客口径按它渲染（06 原则的三种情形） */
  brand?: BrandProfile | null;
  /**
   * 本轮开始时捕获的已发布 policy 快照与 policyHash（07 R1，同品牌的做法）：整轮沿用，发布新版也不混用；
   * 运行时不读草稿、不再查库。核心以 unknown 持有，行业包在自己的边界按 schema 读
   */
  policy?: unknown;
  policyHash?: string;
  /** 经本轮注册表执行预取，并返回实际执行的参数与完整结果。 */
  callTool(name: string, args: Record<string, unknown>): Promise<import('./llm/types.js').PrefetchedCall>;
}

export interface PrefetchResult {
  calls: import('./llm/types.js').PrefetchedCall[];
  timings: string[];
}

/** 核心继续负责身份补句、清理、消息追加、保存与结束 trace。 */
export interface DeterministicReply {
  text: string;
}

export interface TurnToolContext extends ToolContext {
  text: string;
  args: Record<string, unknown>;
  notes: Record<string, string>;
  handoffDeclined: boolean;
}

export interface TravelTurnSources extends Pick<
  PriceGuardSources,
  'loadRoutes' | 'getOrder' | 'mentionsPlace' | 'isOriginMention' | 'offCatalogPlaces'
> {
  searchRoutes(args: { destination: string }): Promise<Pick<Route, 'id' | 'title' | 'days' | 'hotelLevel' | 'priceFrom' | 'highlights'>[]>;
  rememberShownRoutes(session: Session, routes: { id: string; title: string; priceFrom: number }[]): void;
  visitedDestinations(texts: string[], routes?: Route[]): string[];
  paymentMode(): PaymentMode;
  spokenMoney(text: string): ReturnType<typeof import('./parse/money.js').spokenMoney>;
  liftsBudget(text: string): boolean;
}

// 04 第 14 步：辅助模块的数据契约；执行与缓存暂留旧路径。
export interface FollowupTemplates {
  idleMinutes: Partial<Record<SalesStage, number>>;
  byStage: Partial<Record<SalesStage, string>>;
  fallback: string;
  system: string;
}

export interface InsightPrompts {
  insights: string;
  suggestion: string;
  draft: string;
  reach: Record<string, number>;
  funnelNames: readonly string[];
  draftFallback: Record<string, string>;
  draftFallbackStage: SalesStage;
  stuckStages: readonly SalesStage[];
}

export interface DejargonVocab {
  english: Record<string, string>;
  internal: [RegExp, string][];
}

export type EmergencyKind = 'altitude' | 'injury' | 'medical' | 'documents' | 'stranded';

export interface EmergencyRule {
  kind: EmergencyKind;
  /** 带 g：同一小句里同一类的几处逐个看 */
  re: RegExp;
  /** 关键词本身就在持续（喘不上气、呼吸困难、联系不上我妈）：不要求了与此刻标记 */
  ongoing?: boolean;
  /** 关键词里已经带着人（联系不上我妈、把我们扔下、孩子丢了）：不再找前面的主语 */
  withParty?: boolean;
  /** 天灾路况：人要在关键词所在的小句里、关键词前面，前面不是那边、那里、当地 */
  disaster?: boolean;
  /** 被困：说了在哪儿（被困在山上、困在电梯里）就算在持续；说的是问题、工作、会议的不算 */
  trapped?: boolean;
  /** 叫救护车、打 120：前面是求救（帮我、快、赶紧、请）就算，不然要有人、已经打了 */
  ambulance?: boolean;
  /** 摔了一跤、跌倒、滑倒、摔破：同一句话里要说了后果（起不来、动不了、骨折、肿得厉害、流血），摔的不能是东西 */
  fall?: boolean;
  /** 车船坏了、抛锚、陷住：同一句话里要说了走不了、出不来、回不去 */
  vehicle?: boolean;
  /** 流了好多血：同一句话里要说了伤在哪儿或怎么伤的（「为了这趟旅行流了好多血」说的是花钱） */
  bleeding?: boolean;
}

export interface HandoffVocab {
  TRAD: Record<string, string>;
  TRAD_RE: RegExp;
  COND: RegExp;
  HEARSAY: RegExp;
  PAST: RegExp;
  PAST_CUT: RegExp;
  HEARSAY_CUT: RegExp;
  NOW_LEAD: RegExp;
  ASKING_TAIL: RegExp;
  ASKING_WORDS: RegExp;
  NOT_A_QUESTION: RegExp;
  NEG_BEFORE: RegExp;
  E_ALTITUDE_MARKER: RegExp;
  E_ALTITUDE_OVERLAP: RegExp;
  EMERGENCY_RULES: EmergencyRule[];
  CARELESS: RegExp;
  E_HYPO: RegExp;
  E_PRETRIP: RegExp;
  E_NEAR: RegExp;
  E_HABIT: RegExp;
  E_PRICE: RegExp;
  E_JOKE: RegExp;
  E_POLICY: RegExp;
  E_HEARSAY: RegExp;
  E_NEG_BEFORE: RegExp;
  E_UNSURE: RegExp;
  E_EXAGGERATE: RegExp;
  E_AFTER_SKIP: RegExp;
  E_ATTACHED: RegExp;
  E_HAPPENED_BEFORE: RegExp;
  E_FEVER: RegExp;
  E_NOW: RegExp;
  E_ONGOING: RegExp;
  E_FALL_HURT: RegExp;
  E_FALL_THING: RegExp;
  E_VEHICLE_STUCK: RegExp;
  E_WOUND: RegExp;
  E_FINE_AFTER: RegExp;
  E_TRAPPED_AT: RegExp;
  E_TRAPPED_ABSTRACT: RegExp;
  E_NOT_STUCK: RegExp;
  E_ELSEWHERE: RegExp;
  E_RESCUE_LEAD: RegExp;
  E_HELP: RegExp;
  E_IDENTITY: RegExp;
  E_GREETING: RegExp;
  E_UNKNOWN: RegExp;
  E_ASKING: RegExp;
  E_EVERY: RegExp;
  E_ARRANGE: RegExp;
  COMPANION_PHRASE: RegExp;
  COMPANION_MARK: string;
  PARTY_MENTION: RegExp;
  OTHER_MENTION: RegExp;
  NOT_SUBJECT_LEAD: RegExp;
  FAMILY_LEAD: RegExp;
  THIRD_PARTY: RegExp;
  ASK_TAIL: RegExp;
  EMBEDDED: RegExp;
  DEPENDS_LEAD: RegExp;
  ASK_WORDS: RegExp;
  EVERY_AFTER: RegExp;
  EVERY_ANOTA_AFTER: RegExp;
  NOT_ASKING_REST: RegExp;
  US: RegExp;
  OWNED_BY_US: RegExp;
  OWNED_KIND: RegExp;
  SELF: RegExp;
  OTHERS: RegExp;
  OBJECT_LEAD: RegExp;
  OTHER_AGENCY: RegExp;
  JOKE: RegExp;
  DOUBT_WORD: RegExp;
  STRONG_DIRECTED: RegExp;
  INSULT: RegExp;
  STUPID: RegExp;
  INSULT_TARGET_AFTER: RegExp;
  INSULT_OBJECT: RegExp;
  BARE_FILLER: RegExp;
  BARE_INSULT: RegExp;
  BROKEN: RegExp;
  INTENSIFIER: RegExp;
  WEAK: RegExp;
  SLOW_PACE: RegExp;
  WEAK_US_BEFORE: RegExp;
  WEAK_RHETORICAL: RegExp;
  REPEAT_SAID: RegExp;
  PEOPLE: RegExp;
  WEAK_DIRECTED: RegExp;
  POSITIVE_BEFORE: RegExp;
  WORRY_BEFORE: RegExp;
  SEG_ASKING: RegExp;
  COMPLAINT_TAG: RegExp;
  ONLY_US: RegExp;
  HEALTH: RegExp;
  PERSON: RegExp;
  CHILD_AGE_AFTER: RegExp;
  CHILD_AGE_BEFORE: RegExp;
  SCHOOL: RegExp;
  CHILD_RE: RegExp;
  WITHDRAW: readonly RegExp[];
  POLITE_ASK: RegExp;
  POLICY_ASK: RegExp;
  NOT_WANTED: RegExp;
}

export type StepVerdict =
  | { action: 'pass' }
  | { action: 'drop_sentence' | 'replace' | 'patch' | 'append' | 'strip'; text: string; removed?: string[]; added?: string[] }
  | { action: 'handoff'; text: string; reason: string }
  | { action: 'abort' };

/** R8：全部执行过的裁决，保留执行位置后缀；不含客户原文或转人工原因。 */
export interface GuardVerdict {
  id: string;
  action: StepVerdict['action'];
}

/** 开工表的局部变量映射；正文、会话字段与工具调用不放进 flags。 */
export interface GuardTurnFlags extends Record<string, unknown> {
  emptyModelReply?: boolean;
  wantsOrder?: boolean;
  friendsOwn?: Order;
  customPromise?: string | null;
  handedOverSelfDecided?: boolean;
  guardHit?: 'injection' | 'price' | null;
  preDropSnapshot?: string;
  saidAll?: string[];
}

/** 与现有本轮工具记录同形，补工具时继续追加，result 是原始 JSON 字符串。 */
export interface GuardToolSource {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
}

/** 阈值的字段由搬阈值的步骤填实；允许包用自己的类型收窄。 */
export interface GuardContextTypes {
  flags: GuardTurnFlags;
  toolSources: GuardToolSource[];
  orderSources: readonly AnyOrder[];
  thresholds: object;
}

/** R7：步骤只经 context 取得状态与副作用能力，不直接 import 存储。 */
export interface GuardContext<T extends GuardContextTypes = GuardContextTypes> {
  session: Session;
  text: string;
  turn: { flags: T['flags'] };
  toolSources: T['toolSources'];
  orderSources: T['orderSources'];
  brand: BrandProfile | null;
  thresholds: T['thresholds'];
  /** 绑定本轮会话，经包声明的确定性建单工具建单或复用；不直接写订单表。 */
  createOrder(args: Record<string, unknown>): Promise<ToolResult>;
  /** 绑定本轮会话，保留现有转人工记录的形状与语义。 */
  enterHandoff(record: HandoffRecord): void;
  /** 绑定本轮会话，经工具分派、观察者与结果记录；不绕过工具安全网。 */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface GuardStep<Context extends GuardContext = GuardContext> {
  id: string;
  after?: readonly string[];
  reads?: readonly string[];
  writes?: readonly string[];
  run(ctx: Context): Promise<StepVerdict> | StepVerdict;
}

/** 第 16 步：主回复共享旗标的实际形状；步骤表声明它们的首次写入位置。 */
export interface ReplyGuardFlags extends GuardTurnFlags {
  emptyModelReply: boolean;
  wantsOrder: boolean;
  customPromise: string;
  handedOverSelfDecided: boolean;
  guardHit: 'injection' | 'price' | null;
  preDropSnapshot: string;
  saidAll: string[];
  /** 06 R10：本轮回复整段由代码生成或替换（订单文本、兜底话术等）时由对应步骤置位，shape_check 对它只记形状、不删句 */
  fixedReply?: boolean;
  /** 06 R10：shape_check 算出的本轮形状，引擎在轮次结束时写进 trace */
  replyShape?: ReplyShape;
}

/** 06 R10：每轮回复的形状（turn_traces.reply_shape）。rewrite 在 R11 推后期间固定 'off'，rewriteMs 为 null */
export interface ReplyShape {
  class: 'rich' | 'plain';
  lines: number;
  chars: number;
  /** 本轮行数上限 */
  limit: number;
  /** 整段由代码生成的推荐 / 线路列表（rich 类且 flags.fixedReply）：limit 用 generatedListMaxLines，只记形状不裁；不是这类时不写这个字段 */
  generatedList?: true;
  /** 裁掉的句数 */
  trimmed: number;
  /** 最终文本仍超行数或字数上限（发的是裁剪稿，或整段由代码生成不裁剪） */
  overLimit: boolean;
  rewrite: 'off' | 'skipped_time' | 'skipped_budget' | 'used' | 'discarded' | 'timeout' | null;
  rewriteMs: number | null;
}

/** 06 R10：包给 shape_check 的阈值与可删句定义，放在包的 thresholds.shape 里；包没给就不检查 */
export interface ShapePolicy {
  /** 推荐 / 报价类上限（行） */
  richMaxLines: number;
  /** 普通类上限（行） */
  plainMaxLines: number;
  /** 整段由代码生成的推荐 / 线路列表（rich 类、flags.fixedReply）的上限（行）；包没给就按 richMaxLines */
  generatedListMaxLines?: number;
  /** 字数上限（非空白，按码点） */
  maxChars: number;
  /** 本轮调过其中任一工具的算推荐 / 报价类 */
  richTools: readonly string[];
  /** 客户这句在问价 */
  asksPrice(inputText: string): boolean;
  /** 客户这句是收尾（R12 同一判定） */
  isClosingTurn(inputText: string): boolean;
  /** 这一行是线路名行（受保护） */
  isRouteTitleLine(line: string): boolean;
  /** 这句是结尾句（收尾轮里受保护） */
  isClosingLine(sentence: string): boolean;
  /** 本会话已发过方案书 */
  proposalSent(session: Session): boolean;
  /** 包定义的可删句（③）：返回删它的理由，不可删返回 null */
  droppable(
    sentence: string,
    info: {
      closingTurn: boolean;
      proposalSent: boolean;
      askedPrice: boolean;
      /** 这句里的金额（归一后） */
      amounts: readonly string[];
      /** 本会话 AI 回复里已出现过的金额（归一后） */
      priorAmounts: ReadonlySet<string>;
    },
  ): string | null;
}

/** 通用主回复步骤所需的本轮能力；记录、消息追加由引擎绑定。 */
export interface ReplyGuardContext extends GuardContext<GuardContextTypes & { flags: ReplyGuardFlags }> {
  raw: string;
  inputText: string;
  /** 本轮开始时捕获的已发布 policy 快照与 policyHash（07 R1，同 TurnContext）：整轮沿用，运行时不读草稿；核心以 unknown 持有 */
  policy?: unknown;
  policyHash?: string;
  stageAtStart: SalesStage;
  ordersBefore: number;
  handoffDeclined: boolean;
  takenOver(): boolean;
  isTerminalStage(stage: SalesStage): boolean;
  advanceStage(session: Session, turn: StageTurnOutcome): SalesStage;
  modelRequestedHandoff(): boolean;
  retrievalEmpty(calls: readonly GuardToolSource[]): boolean;
  repeatedQuestion(text: string, previous: readonly string[]): boolean;
  extractProfile(session: Session, calls: GuardToolSource[], text: string): CustomerProfile;
  fallbackReply(stage: SalesStage): string;
  answerIdentity(text: string, reply: string): string;
  /** identityOnly：只要一句不带转接与联系方式的身份承认（后面的正文已经在讲转接，06 R16） */
  handoffReply(session: Session, text: string, kind: 'complaint' | 'refund' | 'request', opts?: { identityOnly?: boolean }): string;
  departNoteForHandoff(session: Session): string | undefined;
  failureReason: string;
  handoffFallback: string;
  recordGuard(guard: string, before: string, after: string, action: Exclude<StepVerdict['action'], 'pass' | 'abort'>): void;
  recordSignals(signals: import('../handoff/triggers.js').TurnSignals): void;
  appendMessage(message: import('../types.js').ChatMessage): void;
  /** 06 R10/R11：从 handleMessage 收到这条消息起已用的毫秒数。 */
  elapsedMs(): number;
  /** 06 R11：超限重写一次；关闭、超预算、超时、出错都返回 null。 */
  rewriteReply(input: { customerText: string; draft: string; maxLines: number; protected: string[] }): Promise<string | null>;
  /** 06 R11/R12：本轮是否转人工。 */
  handoffThisTurn(): boolean;
}

export { replyStep } from './guards/reply-step.js';
export { moneyProvenanceStep, moneyProvenanceFollowupStep } from './money-provenance.js';

/** 06 R21：一致性检查的登记类型；通用的检查函数在 core/consistency.ts，包只登记文字和规则 */
export type {
  ConsistencyConflict,
  ConsistencyException,
  ConsistencyGroup,
  ConsistencyRule,
  ConsistencyText,
  FixedReply,
  FixedReplyMode,
  FixedReplyOrigin,
  PipelineOrder,
  FixedReplySample,
  TextTransform,
} from './consistency.js';
export {
  hedgeConflicts,
  passThroughConflicts,
  lineCapConflicts,
  resolveConflicts,
  formatConflict,
  originProblems,
  FIXED_REPLY_MODES,
} from './consistency.js';

/** R15：最终文本的站内链接部件，只用于渠道投影，不写入 ChatMessage。 */
export type { MessagePart } from '../shared/channel-types.js';

export interface ChannelCaps {
  markdown: false;
}

// 04 第 12 步：阶段推导消费已执行的本轮工具；终态判定由核心传入。
export { profileForPrompt } from '../types.js';

export interface StageTurnOutcome {
  calls: readonly TurnToolCall[];
  terminal: boolean;
  /** 只在主回复原阶段推进位置传入；就地推进与接管前补推不判异议。 */
  customerText?: string;
}

/** 画像的本轮输入由核心注入，包不读取引擎私有变量或会话之外的存储。 */
export interface ProfileExtractionSources {
  loadRoutes(): Route[];
  toolCalls(session: Session): readonly TurnToolCall[];
  isMonthOnly(args: Record<string, unknown>): boolean;
  todayIso(): string;
  liftsBudget(text: string): boolean;
  budgetLifted: RegExp;
}

export { partsOf } from './message-parts.js';

/**
 * 第 18 步收口实际工具、主回复与跟进 context；第 20 步补齐客户出口品牌模板。
 */
export interface PackRuntimeTypes {
  LegacyTexts: LegacyTexts;
  BrandTemplates: BrandTemplates;
  ToolContext: TurnToolContext;
  TurnOutcome: StageTurnOutcome;
  TurnContext: TurnContext;
  PrefetchResult: PrefetchResult;
  DeterministicReply: DeterministicReply;
  GuardContext: ReplyGuardContext;
  HandoffVocab: HandoffVocab;
  DejargonVocab: DejargonVocab;
  PackThresholds: object;
  FollowupTemplates: FollowupTemplates;
  InsightPrompts: InsightPrompts;
  MockPolicy: MockPolicy;
}

export type PolicyTopic = 'refund' | 'change' | 'visa' | 'insurance' | 'fees';
/** title 是对客出处，如「退改条款第2条」。 */
export type PolicyClause = { id: string; topic: PolicyTopic; title: string; text: string };
/** 距出发天数闭区间；null 表示不封顶，percent 是 0–100 的整数。 */
export type RefundTier = { id: string; minDays: number; maxDays: number | null; percent: number };
export type RefundTerms = { selfService: boolean; approvalThresholdYuan: number; tiers: readonly RefundTier[] };
export interface PackPolicy<P = unknown> {
  schema: z.ZodType<P>;
  defaults: P;
  editable: readonly string[];
  canonical(p: P): string;
  upgrade(old: unknown): P;
  clauses(p: P): PolicyClause[];
  refund(p: P): RefundTerms | null;
  segments: Readonly<Record<string, (p: P) => string>>;
}

/** 08 R2、R7、R9：产品种类声明；装载时与后台字段配置核对。 */
export interface CatalogKindSpec {
  schema: z.ZodType<Record<string, unknown>>;
  titleKey: string;
  lockedWhenActive: readonly string[];
  repriceFields: readonly string[];
  /** 数组项用 []，如 tiers[].unitPrice。 */
  moneyFields: readonly { path: string; decimals: 0 | 2 }[];
  retrieval: boolean;
}

/** 08 R4：包的画像字段声明；attrs 的键只有声明过的才进模型（核心再筛一次） */
export interface ProfileFieldDef {
  key: string;
  label: string;
}

/** 08 R4：会话状态槽的声明。核心只存取；包写入前用 schema 校验，重置时核心只清 resetKeys 里的键 */
export interface SessionStateSpec {
  schema: z.ZodType<Record<string, unknown>>;
  resetKeys: readonly string[];
}

/**
 * 08 R4：包给的画像展示。title 是会话标题后半段（没有为空串），rows 是画像卡的行；viewer 的打码由核心做。
 * need 只有旅游填：沿用旧接口的 ConversationDetail.need 形状（budget 不打码，核心按 viewer 打码）；
 * 填了，工作台下发 need 而不下发 profileCard，其余包走 profileCard
 */
export interface ProfileView {
  title: string;
  rows: { label: string; value: string }[];
  need?: ConversationNeed;
}

/**
 * 08 R4：包给的报价卡（工作台报价卡与 A2 排序金额）。amountFen 是整数分，null 表示有报价但没有金额（不参与排序）。
 * quote 只有旅游填：沿用旧接口的 ConversationDetail.quote 形状；填了，工作台下发 quote 而不下发 quoteCard
 */
export interface QuoteCard {
  title: string;
  amountFen: number | null;
  lines: string[];
  quote?: ConversationQuote;
}

export interface PackRuntime<T extends PackRuntimeTypes = PackRuntimeTypes> {
  id: string;
  documents?: { proposal?: boolean };
  policy?: PackPolicy;
  defaultBrand: BrandProfile;
  legacy: T['LegacyTexts'];
  templates: T['BrandTemplates'];
  sopSections: SectionSpec[];
  contractRules(mode: 'legacy' | { brand: BrandProfile }): SopContractRule[];
  knownFields: { names: readonly string[]; sourceFiles: readonly string[] };
  stages: { id: SalesStage; terminal?: boolean }[];
  tools: ToolSpec<T['ToolContext']>[];
  beforeTool?(name: string, args: unknown, ctx: T['ToolContext']): { args: unknown } | { reject: string };
  afterTool?(name: string, result: ToolResult, ctx: T['ToolContext']): void;
  extractProfile(text: string, session: Session, calls?: readonly TurnToolCall[]): Partial<CustomerProfile>;
  advanceStage(session: Session, turn: T['TurnOutcome']): SalesStage | null;
  prefetch?(ctx: T['TurnContext']): Promise<T['PrefetchResult'] | null>;
  contextNote(ctx: T['TurnContext']): string[];
  preModel?(ctx: T['TurnContext']): T['DeterministicReply'] | null;
  replySteps: GuardStep<T['GuardContext']>[];
  /** 行业步骤的结束位置，用于把后续核心步骤接回原顺序。 */
  replyAnchors?: Readonly<Record<string, string>>;
  followupSteps: GuardStep<FollowupGuardContext>[];
  engineHooks: EnginePackHooks;
  vocab: { handoff: T['HandoffVocab']; dejargon: T['DejargonVocab'] };
  thresholds: T['PackThresholds'];
  /** 08 R6：金额解析选项（PackThresholds 是不透明对象，放不进去）。没给的包按各调用方自己传的选项走；`decimals: true` 才认两位小数与低单价。 */
  money?: MoneyParseOptions;
  retrievalText(item: CatalogItem): string;
  retrievalItems(): CatalogItem[];
  retrievalCacheFile: string;
  followupTemplates: T['FollowupTemplates'];
  insightPrompts: T['InsightPrompts'];
  mock: T['MockPolicy'];
  /** 06 R21：全部对客固定文字（id 加样例）。没登记的包，一致性检查什么都不查 */
  fixedReplies?: readonly import('./consistency.js').FixedReply[];
  /** 06 R21：这个包要守的一致性规则 */
  consistencyRules?: readonly import('./consistency.js').ConsistencyRule[];
  catalog: Readonly<Record<string, CatalogKindSpec>>;
  catalogStartupCheck?(snapshot: CatalogSnapshot): string | null;
  /** 08 R3：确定性计价；没有此钩子的包不能建通用单。 */
  priceLine?(
    item: Readonly<Record<string, unknown>>,
    qty: number,
    ctx: { kind: string; session: Session },
  ): { unitPriceFen: number; unit: string; attrs?: Record<string, string> } | { reject: string; detail?: Record<string, unknown> };
  maxQty?: number;
  /** 08 R4：会话状态槽（Session.packState）。旅游不声明、不写 */
  sessionState?: SessionStateSpec;
  /** 08 R4：画像里 attrs 的键与对客标签。旅游不声明 */
  profileFields?: readonly ProfileFieldDef[];
  /** 08 R4：发给模型的画像（主对话、后台建议与代拟、沉默跟进共用）。核心对输出再删昵称与头像，attrs 再按 profileFields 筛一次 */
  profileForPrompt(profile: CustomerProfile): Record<string, unknown>;
  /** 08 R4：会话标题与画像卡 */
  profileView(profile: CustomerProfile): ProfileView;
  /** 08 R4：工作台的报价卡与排序金额。没实现就没有报价卡、排序金额只取待付订单 */
  quoteCard?(session: Session): QuoteCard | null;
  /** 08 R4：交还 AI 时没有接管前阶段、也没付款时的阶段。没实现（或返回 null）就按有订单 closing、否则 discovery */
  stageOnReturn?(session: Session): SalesStage | null;
  /** 08 R4：沙箱种子写进会话的包内状态。seed 由核心现算（refundQuote：已发布 policy 算出的退款报价）。没实现就什么都不写 */
  seedSession?(session: Session, seed: Readonly<Record<string, unknown>>): void;
}

export interface PackBinding<T extends PackRuntimeTypes = PackRuntimeTypes> {
  runtime: PackRuntime<T>;
  pipelines: ReturnType<typeof packPipelines>;
  /** null 是旧版模式；defaultBrand 不替代旧版模式。 */
  brand: BrandProfile | null;
}

/** R2：由配置组合根注入；null 品牌保留旧版模式。 */
export function bindPack<T extends PackRuntimeTypes>(runtime: PackRuntime<T>, brand: BrandProfile | null): void {
  const pipelines = packPipelines(runtime);
  currentRuntime().pack = { runtime, brand, pipelines };
}

export function boundPack(): PackBinding | null {
  return currentRuntime().pack ?? null;
}

/** 第 18 步：模型前安全网、重置与支付通知的行业能力，按旧调用位置注入。 */
export interface EnginePackHooks {
  afterSales?(input: AfterSalesInput): AfterSalesStep | null;
  isComplaint(text: string): boolean;
  isHandoffIntent(text: string): boolean;
  safetyNetKind(session: Session, text: string): 'complaint' | 'refund' | 'request';
  /**
   * opts 由引擎带上（品牌快照、客户这句是不是在问身份），旧调用不传也行：
   * 06 R16 的合并句与联系方式渲染按它选文字
   */
  handoffReply(
    session: Session,
    text: string,
    kind: 'complaint' | 'refund' | 'request',
    opts?: { brand?: BrandProfile | null; identity?: boolean; identityOnly?: boolean },
  ): string;
  departNoteForHandoff(session: Session): string | undefined;
  fallbackReply(stage: SalesStage): string;
  hintsFor(name: string, ctx: TurnToolContext): ToolHints;
  withNotes(result: ToolResult, notes: Record<string, string>): ToolResult;
  modelRequestedHandoff(calls: readonly TurnToolCall[]): boolean;
  retrievalEmpty(calls: readonly TurnToolCall[]): boolean;
  createOrderTool: string | null;
  resetSession(session: Session): void;
  paidText(order: Order): string;
  /** 待 owner 确认（plan Open 2）：通用单付款确认，未实现时由核心给默认话术。 */
  paidLineText?(order: LineOrder): string;
  /** 07 R19：退款文字由包提供，核心与后台只负责提交和通知。 */
  refund?: {
    quoteText(order: Order, quote: import('./refund.js').RefundQuote, ctx: RefundTextContext): string;
    chooseText(orders: readonly Order[]): string;
    texts(quote: import('./refund.js').RefundQuote, ctx: RefundTextContext): import('./refund.js').RefundTexts;
    noticeText(order: Order, kind: 'settled' | 'rejected', ctx: RefundTextContext): string;
  };
}

export type AfterSalesInput = {
  session: Session;
  text: string;
  policy: unknown;
  policyHash: string;
  brand: BrandProfile | null;
  today: string;
};
export type AfterSalesStep =
  | { kind: 'reply'; text: string }
  | { kind: 'submit'; quote: RefundQuote; texts: RefundTexts }
  | { kind: 'handoff'; text: string; record: Pick<HandoffRecord, 'kind' | 'reason' | 'quote'> };

export interface RefundTextContext {
  policy: unknown;
  channel: string;
  brand: BrandProfile | null;
}

/** 客户出口；模板用 {BrandProfile 字段名}，不做递归替换。 */
export interface BrandTexts {
  identityAnswer: string;
  offTopicReply: string;
  welcomeText: string;
  welcomeBackText: string;
  webWelcome: string;
  mockOpening: string;
  quickReplies: readonly import('../shared/quick-reply-defaults.js').QuickReplyDefault[];
}

export type BrandPage = 'pay' | 'proposal' | 'chat' | 'web';
export interface BrandPageSlot {
  /** 页面中的完整原文片段；一次匹配，避免品牌值再次成为替换目标。 */
  legacy: string;
  template: string;
  context: 'html-text' | 'html-attribute' | 'js-string' | 'js-template' | 'json';
  /** JS 字面量最终写入 innerHTML 时，先按内层 HTML 上下文转义品牌值。 */
  htmlContext?: 'text' | 'attribute';
}

export interface BrandTemplates extends BrandTexts {
  hardRequirements: string;
  lockedSectionTemplates: Readonly<Record<string, string>>;
  preamble: string;
  pages: Partial<Record<BrandPage, readonly BrandPageSlot[]>>;
}

/** 旧版文字保持原始字节；硬性要求与锁定节的模板发布由第 22 步接通。 */
export interface LegacyTexts extends BrandTexts {
  hardRequirements: string;
  resetReply: string;
  resetDisabledReply: string;
  handoffFallback: string;
}

export interface FollowupGuardContext extends GuardContext {
  recordGuard(guard: string, before: string, after: string, action: 'strip' | 'replace' | 'drop_sentence'): void;
}

/** 包工厂的存储、配置与检索能力，组合根提供，包不引用运行时模块。 */
export interface PackSources extends Omit<TravelToolSources, 'budgetVerdict'> {
  isConfigNotReadyError(error: unknown): boolean;
  isTerminalStage(stage: SalesStage): boolean;
  handoffReasons: typeof import('../handoff/record.js').HANDOFF_REASON;
}

export { dejargon } from './guards/dejargon.js';
export { stripMarkdown, trimDangling } from './guards/text.js';
export { stripAdvisorPrefix, needParts, type NeedVocabulary } from '../shared/conversation.js';

export { brandTexts, renderBrandTemplate, renderBrandPage } from './brand.js';

registerTenantState({
  name: 'pack.binding',
  keyCount: (id) => (runtimeOf(id)?.pack ? 1 : 0),
  drop: (id) => {
    const rt = runtimeOf(id);
    if (rt) Reflect.deleteProperty(rt, 'pack');
  },
  reset: () => {
    for (const rt of tenantRuntimes()) Reflect.deleteProperty(rt, 'pack');
  },
});

export type { LineOrder } from './order-view.js';
