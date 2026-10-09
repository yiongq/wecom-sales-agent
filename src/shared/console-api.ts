// 后台接口的请求与响应（docs/architecture/01-pg-config-console/spec.md「后台 API 与页面」）。前后端共用，只依赖 zod。
// 请求体用 zod 校验（src/console-api/app.ts 经 zValidator 挂上）；响应是纯类型，handler 按这些类型返回，
// Hono RPC 据此推出前端 hc 客户端的类型：这里改一个字段名，服务端和 console/src 的使用处都会在 typecheck 报错。
// 配置层的领域类型（SopVersion、CatalogItem、ContractViolation）也定义在这里，src/config 与 src/sop 再导出，只此一份。
import { z } from 'zod';
import type { ChannelKind, ChannelAccountStatus } from './channel-types.js';
import type { Hotel, Route } from './catalog-types.js';
import type { CatalogKind } from './catalog.js';
import type { DeliveryView, HandoffKind, MessageAuthor, OrderStatus, PaymentMode, SendWindow } from './conversation-types.js';

export type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'viewer';

// ---------------- 请求 ----------------

/** 查询串里的正整数：前端 hc 传的是字符串 */
const intParam = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .pipe(z.number().int().max(max));

/** int4 列的上限：拿去和 int4 列比较的数超过它，库报 22003，不是命名错误，会变成 500 */
const INT4_MAX = 2_147_483_647;

/**
 * 库存得下的文本：text 与 jsonb 都不收 NUL，json / jsonb 不收孤立代理项，库报的错不是命名错误、会变成 500。
 * 请求里会进库或拿去查库的字符串都先过它（不合规 400）；产品库条目的文本字段在 schema 里过它（422，点名字段，见 catalog.ts）。
 * SOP 正文另有更严的编码检查（sections.ts，422 invalid_sop），口令不进库，这两处不过它
 */
export const storableText = (s: string): boolean => !/[\0\p{Cs}]/u.test(s);
export const UNSTORABLE_TEXT = '不能含 NUL 字符或孤立的代理项';
const str = z.string().refine(storableText, UNSTORABLE_TEXT);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** 原样放行的 JSON 对象：值取请求原文，不经 zod 重建（产品库写库的是原文，见 src/config/catalog.ts） */
const jsonObject = z.custom<Record<string, unknown>>(isPlainObject, { message: '应为 JSON 对象' });

export const LoginBody = z.strictObject({
  email: str.trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

export const VersionsQuery = z.object({
  limit: intParam(100).optional(),
  /** 版本号，库里是 int4 */
  before: intParam(INT4_MAX).optional(),
});

/** 没有草稿时 rev 传 null、basedOn 是当前已发布版本的 id；已有草稿时 rev 必须等于草稿的 rev */
export const SaveDraftBody = z.strictObject({
  basedOn: z.string().min(1).max(64),
  rev: z.number().int().nonnegative().nullable(),
  edits: z
    .array(z.strictObject({ key: z.string().min(1).max(64), body: z.string().max(100_000) }))
    .min(1)
    .max(32),
  /**
   * 后台 UX spec 新增：把已有草稿的基线换成这个发布版本，用于合并冲突。必须是当前发布版本；
   * 三方合并撞上的节都要出现在 edits 里（edits 就是合并的结果）
   */
  rebaseOnto: z.string().min(1).max(64).optional(),
});

export const RevBody = z.strictObject({ rev: z.number().int().nonnegative() });

export const PublishBody = z.strictObject({ rev: z.number().int().nonnegative(), changeNote: str.max(500) });

export const RollbackBody = z.strictObject({ changeNote: str.max(500) });

export const CatalogKindParam = z.object({ kind: z.enum(['route', 'hotel']) });
export const CatalogItemParam = z.object({ kind: z.enum(['route', 'hotel']), code: str.min(1).max(128) });

export const CreateItemBody = z.strictObject({ payload: jsonObject });

/** CSV 导入：整份文本放在 csv 里（请求体上限 64 KB，够几百行） */
export const ImportCsvBody = z.strictObject({ csv: z.string().min(1).max(60_000) });

/** 字段级补丁：set 里点名的顶层字段整体替换，unset 里的字段删除，没点名的不动 */
export const PatchItemBody = z.strictObject({
  rev: z.number().int().nonnegative(),
  set: jsonObject,
  unset: z.array(z.string().min(1).max(64)).max(64).optional(),
});

/** 会话状态（docs/features/console-ux/spec.md「接口改动」；02 加 assigned）。判定只在 src/shared/conversation.ts 的 conversationState 里 */
export const CONVERSATION_STATES = ['ai', 'human', 'assigned', 'paid'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** 会话只读列表：offset 分页，limit ≤ 100。state、stage、order 由后台 UX spec 增补：服务端先过滤、排序，再分页 */
export const ConvQuery = z.object({
  limit: intParam(100).optional(),
  offset: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .optional(),
  /** 会话状态，判定见 conversationState */
  state: z.enum(CONVERSATION_STATES).optional(),
  /** 当前阶段（SalesStage 的 key），独立按 row.stage 过滤 */
  stage: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .optional(),
  /** waiting_first = 等人接手的在前，其余按 (updatedAt desc, id)；不给时是 01 的顺序 (updatedAt desc, id) */
  order: z.enum(['waiting_first']).optional(),
  /**
   * 02 第 13 步（开放问题 12 选 A 的接口部分）：paid_needs_human 只列「已成交客户要人工」（终态、转人工、没有接手人，见 paidNeedsHuman）。
   * 铃铛弹层与 A2 单列这一组；它们的状态仍是 paid、不进徽标
   */
  group: z.enum(['paid_needs_human']).optional(),
});

export const AuditQuery = z
  .object({
    limit: intParam(100).optional(),
    /** 上一页最后一行的 id */
    before: intParam(Number.MAX_SAFE_INTEGER).optional(),
    action: str.min(1).max(64).optional(),
    /** 逗号分隔的 action 列表，至多 64 个，只返回其中的动作（后台 UX spec 增补；审计页的类别与「显示登录记录」换算成它） */
    actions: z
      .string()
      .regex(/^[a-z_.]{1,64}(,[a-z_.]{1,64}){0,63}$/)
      .optional(),
  })
  .refine((q) => !(q.action && q.actions), { message: 'action 与 actions 只能给一个' });

/**
 * 运行数字的统计窗口（02 spec「可观测性与告警 · 运行数字」）：近 days 个自然日（含今天，按服务器时区），1–90，默认 7（上限照 spec）。
 * 实际窗口再按这个租户的 trace 保留期截断（min(days, retention_trace_days)），见 MetricsView.days
 */
export const MetricsQuery = z.object({ days: intParam(90).optional() });

// ---------------- 02：会话工作台、订单、快捷回复（docs/architecture/02-conversations-workbench/spec.md「后台接口」） ----------------

/** 人工回复：clientId 是前端生成的 uuid，同一个 clientId 10 分钟内重复提交返回第一次的结果、不重发 */
export const ReplyBody = z.strictObject({ text: str.min(1).max(2000), clientId: z.uuid() });
/** 接手；force 是改派（别人接手中时，只有 supervisor 以上） */
export const TakeoverBody = z.strictObject({ force: z.boolean().optional() });
export const CancelOrderBody = z.strictObject({ reason: str.min(1).max(200) });
/** 更早的消息：seq 小于 beforeSeq 的最近 limit 条（默认 50） */
export const MessagesQuery = z.object({ beforeSeq: intParam(INT4_MAX), limit: intParam(100).optional() });
export const OrdersQuery = z.object({
  status: z.enum(['pending_payment', 'paid', 'cancelled', 'superseded']).optional(),
  limit: intParam(100).optional(),
});
/**
 * 正文不许 markdown（02 spec「快捷回复管理」，plan 第 22 步；第 22 步审查 minor 第 3 条补全）：**加粗**、__加粗__、
 * 单星/单下划线*斜体*、_斜体_、`代码`、~~删除线~~、行首 #标题、行首 -/* 列表、行首 > 引用、独占一行的 ---/___/***
 * 分隔线、[文字](地址) 链接。覆盖面同 src/engine.ts 的 stripMarkdown（对话出口护栏），这里不剥它、直接拒绝；
 * 前后端都用这一份（console 表单提交前先查一遍）。
 */
const MARKDOWN_BLOCK_RE =
  /\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|^\s{0,3}#{1,6}\s|^\s*[-*]\s|^\s{0,3}>\s|^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$|\[[^\]]*\]\([^)]*\)/mu;
/**
 * 单星 / 单下划线的一对，必须紧贴内容（两侧都不是空白）才算，且不是 ** / __ 的一部分。先把「数字*数字」「数字_数字」
 * 这类配对去掉（常见的乘号「2*3=6」、版本号或文件名「v1_2.docx」），剩下的字符串里仍配得成对才算——不然中文句子里
 * 随手写两个算式（「单价*数量=总价，一共2*3=6元」）会被两处乘号的星号误配成一对斜体（第 22 步审查 minor 第 3 条）
 */
const stripDigitFlankedOperators = (s: string): string => s.replace(/(\d)([*_])(?=\d)/g, '$1\u0000');
const SINGLE_STAR_RE = /(?<!\*)\*(?!\s)[^*\n]+?(?<!\s)\*(?!\*)/;
const SINGLE_UNDERSCORE_RE = /(?<!_)_(?!\s)[^_\n]+?(?<!\s)_(?!_)/;
export const hasMarkdown = (s: string): boolean => {
  if (MARKDOWN_BLOCK_RE.test(s)) return true;
  const sanitized = stripDigitFlankedOperators(s);
  return SINGLE_STAR_RE.test(sanitized) || SINGLE_UNDERSCORE_RE.test(sanitized);
};
// 「- 」列表照样拦（与 AI 回复去 markdown 的口径一致），但文案直接给替代写法，不堆砌一串符号示例
// （第 22 步审查 minor 第 4 条）
export const QUICK_REPLY_MARKDOWN_MSG = '正文不能用Markdown格式，分点请用「·」或直接换行';
export const QuickReplyBody = z.strictObject({
  title: str.min(1).max(20),
  body: str
    .min(1)
    .max(500)
    .refine((v) => !hasMarkdown(v), QUICK_REPLY_MARKDOWN_MSG),
});
export const MoveBody = z.strictObject({ direction: z.enum(['up', 'down']) });

// ---------------- 领域类型 ----------------

export interface SopSectionText {
  key: string;
  text: string;
}

export interface SectionSpecView {
  key: string;
  /** 标题行去掉「## 」后的原文；前言为 null */
  heading: string | null;
  /** true：代码依赖它，后台只读 */
  locked: boolean;
}

export type ViolationCode =
  | 'structure' // 节表不符、标题被改、正文为空、正文里出现行首「## 」、不是规范形
  | 'locked_changed' // 锁定节与镜像不一致
  | 'phrase_missing'
  | 'phrase_forbidden'
  | 'unknown_tool' // snake_case 标识符不是现有工具名
  | 'unknown_field' // camelCase 标识符不在 knownFields 里
  | 'over_budget'; // 可编辑节正文总长 > 基线 × BUDGET_RATIO

export interface ContractViolation {
  code: ViolationCode;
  sectionKey: string | null;
  /** 服务端原文，只在「技术详情」里显示；界面上的说明由前端按 code、sectionKey、match 生成 */
  detail: string;
  /** 后台 UX spec 新增：phrase_forbidden 是命中的短语或正则匹配文本；phrase_missing 是必需的那句原文（rule.text）；
   *  unknown_tool / unknown_field 是标识符；其余 code 没有 */
  match?: string;
}

export type SopStatus = 'draft' | 'published' | 'archived' | 'discarded';
export type SopSource = 'import' | 'console' | 'rollback' | 'rerender';

export interface SopVersion {
  id: string;
  /** draft 与 discarded 为 null */
  versionNo: number | null;
  status: SopStatus;
  source: SopSource;
  /** 与当时镜像合并之后的全部节 */
  sections: SopSectionText[];
  basedOn: string | null;
  rev: number;
  promptHash: string | null;
  toolsHash: string | null;
  prefixHash: string | null;
  sopHash: string | null;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: string;
  publishedByName: string | null;
  publishedAt: string | null;
}

export interface CatalogItem {
  kind: CatalogKind;
  code: string;
  ord: number;
  status: 'draft' | 'active';
  rev: number;
  payload: Route | Hotel;
  updatedByName: string | null;
  updatedAt: string;
}

/** 库与镜像 data/ 的差异（以库为准）。DB 模式下改 data/ 的可编辑节或产品库不会生效，后台要让人看得见 */
export interface ConfigDrift {
  /** 可编辑节里与镜像不同的节 key */
  editedSections: string[];
  catalog: Record<CatalogKind, { changed: string[]; onlyDb: string[]; onlyImage: string[] }>;
}

// ---------------- 响应 ----------------

/** 所有错误响应的形状；error 是稳定的机器码，detail 是给人看的说明 */
export interface ApiError {
  error: string;
  detail?: string;
  violations?: ContractViolation[];
  fields?: string[];
  keys?: string[];
  current?: SopSectionText[];
  issues?: { path: string; message: string }[];
  /** CSV 导入按行的问题；row 是数据行号，0 表示表头或整份文件 */
  rows?: { row: number; issues: { path: string; message: string }[] }[];
  /** 409 assigned_to_other：正在处理这个会话的人 */
  assigneeName?: string;
  /** 409 send_window_closed / send_quota_exhausted：窗口关闭的时刻（毫秒，同 SendWindow.closesAt）与剩余条数 */
  closesAt?: number | null;
  remaining?: number;
  /** 409 order_state：订单现在的状态（unconfirmed：还没确认价格） */
  status?: string;
}

export interface Me {
  userId: string;
  displayName: string;
  role: Role;
  /** 写请求放进 x-csrf 头 */
  csrf: string;
  tenantSlug: string;
  /** tenants.name（后台 UX spec 增补）：侧栏租户行和 document.title 用；多租户以后防止改错租户 */
  tenantName: string;
}

/** 匿名（demo）只有 mode */
export interface AnonStatus {
  mode: 'db';
}

export interface ChannelStatus {
  key: string;
  kind: ChannelKind;
  status: ChannelAccountStatus;
  inactiveReason: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  openInbox: number;
  oldestOpenInboxSec: number;
  staleOutbound: number;
  cursorAgeSec: number | null;
  unknownSends24h: number;
}

export interface Status {
  channels: ChannelStatus[];
  mode: 'db';
  tenantSlug: string;
  sop: {
    versionId: string;
    versionNo: number;
    publishedAt: string;
    promptHash: string;
    toolsHash: string;
    prefixHash: string;
    sopHash: string;
  };
  lock: 'held' | 'lost';
  sopStale: boolean;
  catalogStale: boolean;
  index: { indexGeneration: number | null; snapshotGeneration: number; stale: boolean; lastError: string | null };
  drift: ConfigDrift;
  /** 02：真实会话数（不含 demo 类；只经这里给成员看，不进 /healthz） */
  conversations: number;
  /** 02：因数据类错误停写的会话短码（storeHealth().poisoned） */
  poisoned: string[];
}

export interface SopOverview {
  published: SopVersion;
  /** stale：basedOn 已不是当前发布版本 */
  draft: (SopVersion & { stale: boolean }) | null;
  spec: readonly SectionSpecView[];
  budget: { chars: number; limit: number };
}

/** 匿名（demo）投影：只有已发布版本的节、版本号、发布时间和 promptHash 前 12 位 */
export interface AnonSopOverview {
  published: { versionNo: number; publishedAt: string; promptHash: string; sections: readonly SopSectionText[] };
}

export interface DraftCheck {
  promptHash: string;
  prefixHash: string;
  chars: number;
  limit: number;
  violations: ContractViolation[];
  rebase: { needed: boolean; conflicts: string[] };
}

export type RollbackResult = SopVersion & { sameHashAsTarget: boolean };

/** 匿名（demo）投影：只有 active 条目的 kind、code、payload */
export interface AnonCatalogItem {
  kind: CatalogKind;
  code: string;
  payload: Route | Hotel;
}

/** 会话只读列表的一行：只投影这几个字段，不带消息正文和客户画像（needSummary 只用规范化的取值） */
export interface ConversationRow {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  messageCount: number;
  updatedAt: string;
  /** 02 新增：会话标题后半段，如「贵州银发4人」（见 needSummary） */
  needSummary: string | null;
  assignee: { userId: string | null; name: string } | null;
  handoff: { kind: HandoffKind; at: string; reason: string } | null;
  /** 客户最后一条消息的时间：企微 send_time，没有就用处理时刻 */
  lastCustomerAt: string | null;
  /**
   * 排序用的金额（02 第 21 步新增，02 spec「后台页面 · 总览 A2」）：这个会话待付款订单的总价，没有就用最近报价的总价，
   * 都没有为 null。不是对客文案、不进任何页面的正文——A2「等人接手」「已成交客户要人工」两行本来就不显示金额，这个字段
   * 只给「金额高的在前」排序用；哪个角色都收到真值，排序对所有角色一致，角色能不能在界面上看到钱是另一件事（见 OrderView）
   */
  amount: number | null;
}

export interface ConversationPage {
  items: ConversationRow[];
  /** 可列的会话总数（不含 sim- 访客会话）；带 state、stage 时是过滤后的条数 */
  total: number;
}

/** 一次在内存里算完的会话计数（后台 UX spec 增补）：同一次响应里各项相互对得上 */
export interface ConversationCounts {
  total: number;
  byState: Record<ConversationState, number>;
  /** AI 接待中的会话按当前阶段计数，键是 SalesStage；没有会话的阶段不出现 */
  aiByStage: Record<string, number>;
  /** 按服务器时区（TZ）今天 0 点以后有新动静的会话数 */
  updatedToday: number;
}

export interface AuditEntryView {
  id: number;
  at: string;
  actorKind: 'user' | 'system' | 'platform';
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  diff: unknown;
}

export interface AuditPage {
  items: AuditEntryView[];
  /** 下一页的 before；没有更多时为 null */
  nextBefore: number | null;
}

/**
 * 运行数字（02 spec「可观测性与告警 · 运行数字」，R24）：GET /api/console/metrics，所有者、管理员可读，只在 db 存储下有。
 * 由 turn_traces、usage_daily 现算，内存缓存 60 秒；窗口是近 days 个自然日（含今天），受 trace 保留期限制
 */
export interface MetricsView {
  /** 实际的统计窗口（天）：min(请求的 days（默认 7）, 这个租户的 trace 保留期)；下面几项都按它算，界面据此写「近 N 天」 */
  days: number;
  /** 窗口内的轮次数（库里只有真实会话） */
  turns: number;
  /** outcome='replied' 的轮次 duration_ms 的 90 分位（毫秒，取整）；没有这样的轮次为 null */
  replyP90Ms: number | null;
  /** 窗口内有 outcome='handoff' 轮次的会话 / 窗口内有轮次的会话；没有轮次为 null */
  handoffRate: number | null;
  /** 有模型调用出错（llm 数组里 error 非空）或 outcome='error' 的轮次 / 全部轮次；没有轮次为 null */
  aiErrorRate: number | null;
  /** usage_daily 今天（服务器时区）的 cost_milli_cny 之和 / 1000 */
  costTodayYuan: number;
  /** 窗口内之和 / 1000 */
  costRangeYuan: number;
}

// ---------------- 02：会话工作台、订单、快捷回复、事件流的响应 ----------------

/** J 页的一条消息（02 spec「后台接口」） */
export interface MessageView {
  /** db 存储下是库里的 seq；文件存储下是本进程分配的 seq，跨重启不保证（「identity map 与写入」） */
  seq: number;
  role: 'customer' | 'agent' | 'system';
  author: MessageAuthor;
  /** 顾问人工回复的姓名快照（共享工作台写「共享工作台」）；其余为 null */
  authorName: string | null;
  /** 只读成员（viewer）看到的是打码后的正文：手机号、证件号、银行卡号只留后 4 位 */
  text: string;
  /** handoff_note：以「AI 已转人工」开头的 system 消息，界面按时间线行渲染，不显示原文（「后台页面」） */
  kind: 'message' | 'handoff_note';
  at: string;
  /** 这条回复所属那一轮的 trace（只有 db 存储的真实会话；文件存储与 demo 类会话为 null） */
  turnId: string | null;
  /** 护栏改过这条 AI 回复：删了几句、补了几处（相对模型原稿的净差）；展开时读 /conversations/:id/turns/:turnId/diff */
  guarded: { removed: number; added: number } | null;
  /**
   * 发送账本里这条消息的投递状态（企微）：几段取 deliveryOfSegments 的那一种，failed 时带原因码；账本里没有这条时为 null。
   * 03 起多 sending（发送中）与 cancelled（未发送）
   */
  delivery: DeliveryView | null;
}

/** J 页右栏与对话里的订单（ConversationDetail.orders、GET /orders） */
export interface OrderView {
  id: string;
  routeTitle: string;
  travelers: number;
  departDate: string;
  totalPrice: number;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  /** 顾问确认过价格：时刻与确认人的姓名 */
  confirmed: { at: string; by: string } | null;
  /** 标记已付时会话是否曾经转过人工（R9）；没付或旧数据为 null */
  handoffBeforePaid: boolean | null;
  /**
   * 所属会话的最小投影（02 第 21 步新增，A2「待付款」行用：标题、「打开会话」的去向）；会话已被清除（订单不再指向
   * 内存里的会话，第 16 步之后才会出现）时为 null，这种订单的行不画
   */
  conversation: { id: string; channel: string; needSummary: string | null } | null;
}

/** GET /conversations/:id：J 页一次取全 */
export interface ConversationDetail {
  row: ConversationRow;
  /** 内存窗口，按 seq 升序 */
  messages: MessageView[];
  /** 窗口之前库里还有更早的消息（只有 db 存储的真实会话）；按 seq 往前翻页读 /conversations/:id/messages */
  hasEarlier: boolean;
  handoffCard: {
    kind: HandoffKind;
    at: string;
    reason: string;
    /** 触发这次转人工的客户原话；viewer 同样打码 */
    quote: string | null;
    departNote: string | null;
    stageBefore: string | null;
    assigneeName: string | null;
  } | null;
  /** 需求要素：规范化的取值，与 needSummary 同源 */
  need: { destination: string | null; segment: string | null; travelers: string | null; dates: string | null; budget: string | null };
  quote: {
    routeId: string;
    routeTitle: string;
    travelers: number;
    perPerson: number | null;
    total: number | null;
    departDate: string | null;
  } | null;
  orders: OrderView[];
  /** 企微渠道才有 */
  sendWindow: SendWindow | null;
  paymentMode: PaymentMode;
  /** 客户不同意或撤回了同意处理敏感信息（R23）：「交还AI」不可用（02 第 13 步加的一项，界面据此写明原因） */
  consentDeclined: boolean;
  /** 当前成员此刻能做什么（权限表与接手状态机同一套判断） */
  can: {
    takeover: boolean;
    reply: boolean;
    release: boolean;
    reassign: boolean;
    confirmOrder: boolean;
    markPaid: boolean;
    traces: boolean;
  };
}

/** GET /conversations/:id/messages：窗口以外更早的消息（只在 db 存储），按 seq 升序 */
export interface MessagesPage {
  messages: MessageView[];
  /** 这一页之前还有 */
  hasEarlier: boolean;
}

/** GET /conversations/:id/turns：每轮的工具步骤摘要（名字取行业包的工具词表），不含参数与耗时 */
export interface TurnStepsView {
  turns: {
    turnId: string;
    startedAt: string;
    outcome: string;
    steps: { name: string; label: string; prefetch: boolean }[];
  }[];
}

/** GET /conversations/:id/turns/:turnId/diff：护栏删去 / 补上的句子（相对模型原稿的净差）与逐个护栏的原样 */
export interface TurnDiffView {
  removed: string[];
  added: string[];
  events: { guard: string; action: string; removed: string[]; added: string[] }[];
}

/** GET /conversations/:id/turns/:turnId：trace 原文（只给所有者、管理员）：原稿、参数、耗时、模型、前缀 */
export interface TurnTraceView {
  turnId: string;
  startedAt: string;
  durationMs: number;
  outcome: string;
  sopVersion: number | null;
  prefixHash: string;
  catalogVersions: Record<string, number>;
  stageBefore: string | null;
  stageAfter: string | null;
  draft: string | null;
  finalText: string | null;
  calls: unknown[];
  llm: unknown[];
  signals: unknown;
}

/** POST /conversations/:id/reply */
export interface ReplyResultView {
  sent: boolean;
  seq: number;
  /** false：已发出，记录稍后保存（等满 5 秒还没提交） */
  persisted: boolean;
}

/** GET /orders */
export interface OrderPage {
  items: OrderView[];
  /** 过滤之后的条数 */
  total: number;
  /**
   * 收款方式（02 第 21 步新增）：A2「待付款」行据它判断要不要写「等你确认价格」。全租户同一个值，不是按订单的字段，
   * 放在这里是因为这个接口对所有角色都开放（/orders/summary 只有所有者、管理员），advisor 未确认的文案要让坐席也看到
   */
  paymentMode: PaymentMode;
}

/** GET /orders/summary：本月（服务器时区的自然月）的成交额与待付款 */
export interface OrderSummary {
  /** 如 2026-10 */
  month: string;
  paidTotal: number;
  paidCount: number;
  /** 现在待付款（pending_payment）的订单，不限月份 */
  pendingTotal: number;
  pendingCount: number;
}

export interface QuickReply {
  id: string;
  ord: number;
  title: string;
  body: string;
}

/**
 * GET /events（SSE）的事件名与 data（JSON）。只带 id、状态、类型、seq 与时间，不带消息正文、客户原话和画像（不变量 31）。
 * resync：Last-Event-ID 不是本次启动的或比环形缓冲还旧，前端整体重取；auth：登录失效，随后关闭连接，前端回登录页
 */
export interface ConsoleEventMap {
  counts: ConversationCounts;
  /** assigned：发出时是否已有接手人（02 第 19 步审查）；前端对 true 的这一条不弹浏览器通知，铃铛与计数照旧更新 */
  handoff: { id: string; kind: HandoffKind; at: string; escalated: boolean; paidCustomer: boolean; assigned: boolean };
  conversation: { id: string; change: 'changed' | 'assigned' | 'released'; assigneeName: string | null };
  message: { id: string; seq: number; author: MessageAuthor };
  order: { id: string; orderId: string; status: OrderStatus; confirmed: boolean };
  send_failed: { id: string; failType: number | null };
  resync: Record<string, never>;
  auth: Record<string, never>;
}
export type ConsoleEventName = keyof ConsoleEventMap;
