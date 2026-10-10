// 04 R2、R3：行业包取得核心能力的唯一出口；这里不装载行业包，也不引旧门面。
import type { SectionSpec } from '../shared/sop-sections.js';
import type { CustomerProfile, HandoffRecord, Hotel, Order, Route, SalesStage, Session } from '../types.js';
import type { ToolDef } from '../tool-defs.js';
import type { MoneyParseOptions } from './parse/money.js';
import type { PaymentMode } from '../shared/conversation-types.js';
import type { CatalogItem } from '../shared/console-api.js';

export type { CustomerProfile, SalesStage, Session, Order, AgentReply, Route, Hotel } from '../types.js';
export { toolDefs, type ToolDef } from '../tool-defs.js';
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
  /** 绑定本轮会话，经确定性的 create_order 工具建单或复用；不直接写订单表。 */
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

/** R15：最终文本的站内链接部件，只用于渠道投影，不写入 ChatMessage。 */
export type { MessagePart } from '../shared/channel-types.js';

export interface ChannelCaps {
  markdown: false;
}

export { partsOf } from './message-parts.js';

/**
 * spec 尚未定义这些引用类型的字段与副作用方法签名。
 * 保留类型参数，不用伪业务实现或任意字段表补齐；装载前需确认具体契约。
 */
export interface PackRuntimeTypes {
  LegacyTexts: unknown;
  BrandTemplates: unknown;
  ToolContext: ToolContext;
  TurnOutcome: unknown;
  TurnContext: unknown;
  PrefetchResult: unknown;
  DeterministicReply: unknown;
  GuardContext: GuardContext;
  HandoffVocab: unknown;
  DejargonVocab: unknown;
  PackThresholds: unknown;
  FollowupTemplates: unknown;
  InsightPrompts: unknown;
  MockPolicy: unknown;
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
  extractProfile(text: string, session: Session): Partial<CustomerProfile>;
  advanceStage(session: Session, turn: T['TurnOutcome']): SalesStage | null;
  prefetch?(ctx: T['TurnContext']): Promise<T['PrefetchResult'] | null>;
  contextNote(ctx: T['TurnContext']): string[];
  preModel?(ctx: T['TurnContext']): T['DeterministicReply'] | null;
  replySteps: GuardStep<T['GuardContext']>[];
  followupSteps: GuardStep<T['GuardContext']>[];
  vocab: { handoff: T['HandoffVocab']; dejargon: T['DejargonVocab'] };
  thresholds: T['PackThresholds'];
  retrievalText(item: CatalogItem): string;
  followupTemplates: T['FollowupTemplates'];
  insightPrompts: T['InsightPrompts'];
  mock: T['MockPolicy'];
}

export interface PackBinding<T extends PackRuntimeTypes = PackRuntimeTypes> {
  runtime: PackRuntime<T>;
  /** null 是旧版模式；defaultBrand 不替代旧版模式。 */
  brand: BrandProfile | null;
}

let binding: PackBinding | null = null;

/** 第 18 步由配置组合根注入；当前生产路径不调用。 */
export function bindPack<T extends PackRuntimeTypes>(runtime: PackRuntime<T>, brand: BrandProfile | null): void {
  binding = { runtime, brand };
}

export function boundPack(): PackBinding | null {
  return binding;
}
