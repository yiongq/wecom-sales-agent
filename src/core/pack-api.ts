import { packPipelines } from './engine/pipelines.js';
// 04 R2、R3：行业包取得核心能力的唯一出口；这里不装载行业包，也不引旧门面。
import type { SectionSpec } from '../shared/sop-sections.js';
import type { CustomerProfile, HandoffRecord, Hotel, Order, Route, SalesStage, Session } from '../types.js';
import type { ToolDef } from '../tool-defs.js';
import type { MoneyParseOptions } from './parse/money.js';
import type { PaymentMode } from '../shared/conversation-types.js';
import type { CatalogItem } from '../shared/console-api.js';
import { z } from 'zod';

export type { CustomerProfile, SalesStage, Session, Order, AgentReply, Route, Hotel } from '../types.js';
export type { ToolDef } from '../tool-defs.js';
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

export interface ToolSpec<Context = ToolContext> {
  def: ToolDef;
  sideEffects: ReadonlyArray<'session' | 'order' | 'handoff' | 'notify'>;
  cacheable: boolean;
  blocksRetry: boolean;
  onReuse?(result: ToolResult, ctx: Context): void;
  execute(args: unknown, ctx: Context): Promise<ToolResult>;
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
  orderSources: readonly Order[];
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
}

/** 通用主回复步骤所需的本轮能力；记录、消息追加由引擎绑定。 */
export interface ReplyGuardContext extends GuardContext<GuardContextTypes & { flags: ReplyGuardFlags }> {
  raw: string;
  inputText: string;
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
  handoffReply(session: Session, text: string, kind: 'complaint' | 'refund' | 'request'): string;
  departNoteForHandoff(session: Session): string | undefined;
  failureReason: string;
  handoffFallback: string;
  recordGuard(guard: string, before: string, after: string, action: Exclude<StepVerdict['action'], 'pass' | 'abort'>): void;
  recordSignals(signals: import('../handoff/triggers.js').TurnSignals): void;
  appendMessage(message: import('../types.js').ChatMessage): void;
}

export { replyStep } from './guards/reply-step.js';

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
 * 第 18 步收口实际工具、主回复与跟进 context；品牌模板仍由第 20 步填实。
 */
export interface PackRuntimeTypes {
  LegacyTexts: LegacyTexts;
  BrandTemplates: unknown;
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

export interface PackRuntime<T extends PackRuntimeTypes = PackRuntimeTypes> {
  id: string;
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
  retrievalText(item: CatalogItem): string;
  retrievalItems(): CatalogItem[];
  retrievalCacheFile: string;
  followupTemplates: T['FollowupTemplates'];
  insightPrompts: T['InsightPrompts'];
  mock: T['MockPolicy'];
}

export interface PackBinding<T extends PackRuntimeTypes = PackRuntimeTypes> {
  runtime: PackRuntime<T>;
  pipelines: ReturnType<typeof packPipelines>;
  /** null 是旧版模式；defaultBrand 不替代旧版模式。 */
  brand: BrandProfile | null;
}

let binding: PackBinding | null = null;

/** R2：由配置组合根注入；null 品牌保留旧版模式。 */
export function bindPack<T extends PackRuntimeTypes>(runtime: PackRuntime<T>, brand: BrandProfile | null): void {
  const pipelines = packPipelines(runtime);
  binding = { runtime, brand, pipelines };
}

export function boundPack(): PackBinding | null {
  return binding;
}

/** 第 18 步：模型前安全网、重置与支付通知的行业能力，按旧调用位置注入。 */
export interface EnginePackHooks {
  isComplaint(text: string): boolean;
  isHandoffIntent(text: string): boolean;
  safetyNetKind(session: Session, text: string): 'complaint' | 'refund' | 'request';
  handoffReply(session: Session, text: string, kind: 'complaint' | 'refund' | 'request'): string;
  departNoteForHandoff(session: Session): string | undefined;
  fallbackReply(stage: SalesStage): string;
  hintsFor(name: string, ctx: TurnToolContext): ToolHints;
  withNotes(result: ToolResult, notes: Record<string, string>): ToolResult;
  modelRequestedHandoff(calls: readonly TurnToolCall[]): boolean;
  retrievalEmpty(calls: readonly TurnToolCall[]): boolean;
  createOrderTool: string | null;
  resetSession(session: Session): void;
  paidText(order: Order): string;
}

/** 品牌模板由第 20 步填实；本步只消费已存在的旧版文字。 */
export interface LegacyTexts {
  hardRequirements: string;
  identityAnswer: string;
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
export { stripAdvisorPrefix } from '../shared/conversation.js';
