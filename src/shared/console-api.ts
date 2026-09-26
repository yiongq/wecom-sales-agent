// 后台接口的请求与响应（docs/architecture/01-pg-config-console/spec.md「后台 API 与页面」）。前后端共用，只依赖 zod。
// 请求体用 zod 校验（src/console-api/app.ts 经 zValidator 挂上）；响应是纯类型，handler 按这些类型返回，
// Hono RPC 据此推出前端 hc 客户端的类型：这里改一个字段名，服务端和 console/src 的使用处都会在 typecheck 报错。
// 配置层的领域类型（SopVersion、CatalogItem、ContractViolation）也定义在这里，src/config 与 src/sop 再导出，只此一份。
import { z } from 'zod';
import type { Hotel, Route } from './catalog-types.js';
import type { CatalogKind } from './catalog.js';

export type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'viewer';

// ---------------- 请求 ----------------

/** 查询串里的正整数：前端 hc 传的是字符串 */
const intParam = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .pipe(z.number().int().max(max));

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** 原样放行的 JSON 对象：值取请求原文，不经 zod 重建（产品库写库的是原文，见 src/config/catalog.ts） */
const jsonObject = z.custom<Record<string, unknown>>(isPlainObject, { message: '应为 JSON 对象' });

export const LoginBody = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

export const VersionsQuery = z.object({
  limit: intParam(100).optional(),
  before: intParam(Number.MAX_SAFE_INTEGER).optional(),
});

/** 没有草稿时 rev 传 null、basedOn 是当前已发布版本的 id；已有草稿时 rev 必须等于草稿的 rev */
export const SaveDraftBody = z.strictObject({
  basedOn: z.string().min(1).max(64),
  rev: z.number().int().nonnegative().nullable(),
  edits: z
    .array(z.strictObject({ key: z.string().min(1).max(64), body: z.string().max(100_000) }))
    .min(1)
    .max(32),
});

export const RevBody = z.strictObject({ rev: z.number().int().nonnegative() });

export const PublishBody = z.strictObject({ rev: z.number().int().nonnegative(), changeNote: z.string().max(500) });

export const RollbackBody = z.strictObject({ changeNote: z.string().max(500) });

export const CatalogKindParam = z.object({ kind: z.enum(['route', 'hotel']) });
export const CatalogItemParam = z.object({ kind: z.enum(['route', 'hotel']), code: z.string().min(1).max(128) });

export const CreateItemBody = z.strictObject({ payload: jsonObject });

/** 字段级补丁：set 里点名的顶层字段整体替换，unset 里的字段删除，没点名的不动 */
export const PatchItemBody = z.strictObject({
  rev: z.number().int().nonnegative(),
  set: jsonObject,
  unset: z.array(z.string().min(1).max(64)).max(64).optional(),
});

/** 会话只读列表：offset 分页，limit ≤ 100 */
export const ConvQuery = z.object({
  limit: intParam(100).optional(),
  offset: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .optional(),
});

export const AuditQuery = z.object({
  limit: intParam(100).optional(),
  /** 上一页最后一行的 id */
  before: intParam(Number.MAX_SAFE_INTEGER).optional(),
  action: z.string().min(1).max(64).optional(),
});

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
  detail: string;
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
}

export interface Me {
  userId: string;
  displayName: string;
  role: Role;
  /** 写请求放进 x-csrf 头 */
  csrf: string;
  tenantSlug: string;
}

/** 匿名（demo）只有 mode */
export interface AnonStatus {
  mode: 'db';
}

export interface Status {
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

/** 会话只读列表的一行：只投影这几个字段，不带消息正文和客户画像 */
export interface ConversationRow {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  messageCount: number;
  updatedAt: string;
}

export interface ConversationPage {
  items: ConversationRow[];
  /** 可列的会话总数（不含 sim- 访客会话） */
  total: number;
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
