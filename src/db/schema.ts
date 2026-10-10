// 01 的七张表（docs/architecture/01-pg-config-console/spec.md「数据库 · DDL」），与 02 的十二张表、tenants 的三个保留期列、
// catalog_items.version（docs/architecture/02-conversations-workbench/spec.md「数据库」与各节的 DDL），03 的两张渠道表、
// outbound_sends 的新列与新状态、conversations.channel_account_id（docs/architecture/03-channels-v2/spec.md「数据库」）。
// 这里只写表、索引和约束，由 drizzle-kit 生成迁移；RLS、策略、触发器、函数、授权，以及 drizzle 表达不了的约束
// （orders 那条带列清单的 ON DELETE SET NULL (session_id)）在 custom 迁移里。
// 列名一律显式写 snake_case，不依赖 casing 推导：迁移 SQL 与 spec 的 DDL 逐列对得上。
// 改这个文件之后跑 `pnpm db:generate` 生成新迁移，已提交的迁移文件永远不改（lint 会查）。
import { sql } from 'drizzle-orm';
import type { BrandProfile, GuardVerdict } from '../core/pack-api.js';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CHANNEL_ACCOUNT_STATUSES,
  CHANNEL_KINDS,
  INBOX_ABANDON_REASONS,
  INBOX_KINDS,
  INBOX_STATES,
  OUTBOUND_STATUSES,
} from '../shared/channel-types.js';

/** drizzle 0.45 没有内置 bytea。node-postgres 读出 Buffer，PGlite 读出 Uint8Array，统一成 Buffer */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** 'travel'，决定 SOP 节表和产品库的 kind */
    packId: text('pack_id').notNull(),
    /** 04 R4、R6：待生效品牌；null 为旧版模式，运行时只用已发布快照。 */
    brand: json('brand').$type<BrandProfile>(),
    /** 海外适配保留的缝，01 没有读方 */
    locale: text('locale').notNull().default('zh-CN'),
    region: text('region').notNull().default('CN'),
    status: text('status', { enum: ['trial', 'active', 'suspended'] })
      .notNull()
      .default('active'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    // 02 的保留期（天）：默认值即 02 开放问题 2 的裁决；租户要别的值由 tenant-retention 设置（agent_platform 只有这三列的 UPDATE）
    retentionLeadDays: integer('retention_lead_days').notNull().default(180),
    retentionCustomerDays: integer('retention_customer_days').notNull().default(730),
    retentionTraceDays: integer('retention_trace_days').notNull().default(90),
  },
  (t) => [
    check('tenants_slug_check', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('tenants_status_check', sql`${t.status} IN ('trial', 'active', 'suspended')`),
    check('tenants_retention_lead_days_check', sql`${t.retentionLeadDays} BETWEEN 7 AND 3650`),
    check('tenants_retention_customer_days_check', sql`${t.retentionCustomerDays} BETWEEN 7 AND 3650`),
    check('tenants_retention_trace_days_check', sql`${t.retentionTraceDays} BETWEEN 7 AND 3650`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** 'scrypt$<logN>$<r>$<p>$<salt>$<hash>'（base64url），参数随哈希存 */
    passwordHash: text('password_hash').notNull(),
    disabledAt: tstz('disabled_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'admin', 'supervisor', 'agent', 'viewer'] }).notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    check('memberships_role_check', sql`${t.role} IN ('owner', 'admin', 'supervisor', 'agent', 'viewer')`),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    /** sha256(cookie 值) */
    tokenHash: bytea('token_hash').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: tstz('created_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull(),
    /** created_at + 7 天，绝对上限 */
    expiresAt: tstz('expires_at').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [check('auth_sessions_token_hash_check', sql`octet_length(${t.tokenHash}) = 32`), index('auth_sessions_by_user').on(t.userId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    /** 写入时的 display_name 快照；列表不再查 users */
    actorName: text('actor_name'),
    actorKind: text('actor_kind', { enum: ['user', 'system', 'platform'] }).notNull(),
    /** 取值见 spec「审计」 */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    diff: jsonb('diff'),
    ip: inet('ip'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_log_actor_kind_check', sql`${t.actorKind} IN ('user', 'system', 'platform')`),
    // 与 spec 的 (tenant_id, id DESC) 一致：Postgres 的 DESC 默认 NULLS FIRST，drizzle 的 desc() 不写就生成 NULLS LAST，
    // 查询里的 order by id desc 就用不上这个索引的顺序
    index('audit_log_by_tenant').on(t.tenantId, t.id.desc().nullsFirst()),
  ],
);

export interface SopSectionRow {
  key: string;
  text: string;
}

export interface RenderInputs {
  hardRulesHash: string;
  imageSopHash: string;
  sectionTableHash: string;
  toolsHash: string;
}

export const sopVersions = pgTable(
  'sop_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** 发布时分配；draft 与 discarded 为 NULL */
    versionNo: integer('version_no'),
    status: text('status', { enum: ['draft', 'published', 'archived', 'discarded'] }).notNull(),
    source: text('source', { enum: ['import', 'console', 'rollback', 'rerender'] }).notNull(),
    packId: text('pack_id').notNull(),
    /** 数组顺序就是拼接顺序 */
    sections: jsonb('sections').$type<SopSectionRow[]>().notNull(),
    basedOn: uuid('based_on'),
    /** 草稿的乐观锁，由触发器加 1 */
    rev: integer('rev').notNull().default(1),
    /** 整段 system prompt；draft 与 discarded 为 NULL */
    renderedPrompt: text('rendered_prompt'),
    promptHash: text('prompt_hash'),
    toolsHash: text('tools_hash'),
    prefixHash: text('prefix_hash'),
    sopHash: text('sop_hash'),
    renderInputs: jsonb('render_inputs').$type<RenderInputs>(),
    changeNote: text('change_note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdByName: text('created_by_name'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    publishedBy: uuid('published_by').references(() => users.id),
    publishedByName: text('published_by_name'),
    publishedAt: tstz('published_at'),
  },
  (t) => [
    unique('sop_versions_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('sop_versions_tenant_id_version_no_uq').on(t.tenantId, t.versionNo),
    // 租户内的外键带上 tenant_id：外键检查以属主身份运行、不受 FORCE RLS 约束，单列外键拦不住跨租户引用
    foreignKey({
      name: 'sop_versions_based_on_fk',
      columns: [t.tenantId, t.basedOn],
      foreignColumns: [t.tenantId, t.id],
    }),
    check('sop_versions_version_no_check', sql`${t.versionNo} > 0`),
    check('sop_versions_status_check', sql`${t.status} IN ('draft', 'published', 'archived', 'discarded')`),
    check('sop_versions_source_check', sql`${t.source} IN ('import', 'console', 'rollback', 'rerender')`),
    check('sop_versions_prompt_hash_check', sql`${t.promptHash} ~ '^[0-9a-f]{64}$'`),
    check('sop_versions_tools_hash_check', sql`${t.toolsHash} ~ '^[0-9a-f]{64}$'`),
    check('sop_versions_prefix_hash_check', sql`${t.prefixHash} ~ '^[0-9a-f]{64}$'`),
    check('sop_versions_sop_hash_check', sql`${t.sopHash} ~ '^[0-9a-f]{64}$'`),
    check('sop_versions_version_no_iff_released', sql`(${t.status} IN ('published', 'archived')) = (${t.versionNo} IS NOT NULL)`),
    check('sop_versions_prompt_iff_released', sql`(${t.status} IN ('published', 'archived')) = (${t.renderedPrompt} IS NOT NULL)`),
    check(
      'sop_versions_render_all_or_none',
      sql`num_nulls(${t.renderedPrompt}, ${t.promptHash}, ${t.toolsHash}, ${t.prefixHash}, ${t.sopHash}, ${t.renderInputs}) IN (0, 6)`,
    ),
    check(
      'sop_versions_prompt_hash_matches',
      sql`${t.promptHash} IS NULL OR ${t.promptHash} = encode(sha256(convert_to(${t.renderedPrompt}, 'UTF8')), 'hex')`,
    ),
    check(
      'sop_versions_prefix_hash_matches',
      sql`${t.prefixHash} IS NULL OR ${t.prefixHash} = encode(sha256(convert_to(${t.toolsHash} || ${t.promptHash}, 'UTF8')), 'hex')`,
    ),
    uniqueIndex('sop_one_published')
      .on(t.tenantId)
      .where(sql`${t.status} = 'published'`),
    uniqueIndex('sop_one_draft')
      .on(t.tenantId)
      .where(sql`${t.status} = 'draft'`),
  ],
);

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ['route', 'hotel'] }).notNull(),
    /** 'r-yunnan-mid'、'h-aman-tokyo' */
    code: text('code').notNull(),
    ord: integer('ord').notNull(),
    status: text('status', { enum: ['draft', 'active'] })
      .notNull()
      .default('draft'),
    /** 条目原对象。json 而非 jsonb：json 原样保存输入文本，读出后键序不变（spec「产品库 · 存储」） */
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    rev: integer('rev').notNull().default(1),
    /** 当前内容的条目版本（02「报价快照」）：上架是 1，active 条目每次内容变化加 1，与 catalog_item_versions 的最新一行对应 */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedByName: text('updated_by_name'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('catalog_items_tenant_kind_code_uq').on(t.tenantId, t.kind, t.code),
    unique('catalog_items_tenant_kind_ord_uq').on(t.tenantId, t.kind, t.ord),
    check('catalog_items_kind_check', sql`${t.kind} IN ('route', 'hotel')`),
    check('catalog_items_code_check', sql`${t.code} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
    check('catalog_items_status_check', sql`${t.status} IN ('draft', 'active')`),
    check('catalog_items_payload_check', sql`json_typeof(${t.payload}) = 'object' AND coalesce(${t.payload}->>'id' = ${t.code}, false)`),
  ],
);

// ---------------- 02：会话入库（spec「数据库」与各节的 DDL） ----------------
// 所有新表都带 tenant_id、套 01 的 RLS 模板（custom 迁移）；租户内的外键一律带上 tenant_id

export const conversations = pgTable(
  'conversations',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: text('id').notNull(),
    /** 不含客户标识的引用：审计 target、日志、OpenTelemetry 用它 */
    ref: uuid('ref').notNull().defaultRandom(),
    channel: text('channel').notNull(),
    stage: text('stage').notNull(),
    handedOver: boolean('handed_over').notNull(),
    /** 投影：state.handoff.kind */
    handoffKind: text('handoff_kind'),
    handoffAt: tstz('handoff_at'),
    firstHandoffAt: tstz('first_handoff_at'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id),
    assigneeName: text('assignee_name'),
    lastCustomerAt: tstz('last_customer_at'),
    lastSeq: integer('last_seq').notNull().default(0),
    windowStartSeq: integer('window_start_seq').notNull().default(1),
    /** 会话对象去掉 messages 后的 JSON，键序原样；重建只读它 */
    state: json('state').$type<Record<string, unknown>>().notNull(),
    /** 最近一次提交的落库 id：COMMIT 时断线，重试据此认出已提交 */
    flushId: uuid('flush_id'),
    createdAt: tstz('created_at').notNull(),
    /** = session.updatedAt；触发器保证只进不退、不晚于 now() + 5 分钟 */
    updatedAt: tstz('updated_at').notNull(),
    /** 03：会话对象的 channelAccountId 的投影；NULL 表示渠道的默认账号（前缀为 wecom: 的那个，R11） */
    channelAccountId: uuid('channel_account_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('conversations_tenant_id_ref_uq').on(t.tenantId, t.ref),
    foreignKey({
      name: 'conversations_channel_account_fk',
      columns: [t.tenantId, t.channelAccountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }),
    // demo 类会话（sim-、wecom:cust_）永不进库（不变量 11）
    check('conversations_id_check', sql`${t.id} !~ '^(sim-|wecom:cust_)' AND length(${t.id}) BETWEEN 1 AND 200`),
    check('conversations_last_seq_check', sql`${t.lastSeq} >= 0`),
    check('conversations_window_start_seq_check', sql`${t.windowStartSeq} BETWEEN 1 AND ${t.lastSeq} + 1`),
    check('conversations_state_check', sql`json_typeof(${t.state}) = 'object' AND coalesce(${t.state}->>'id' = ${t.id}, false)`),
    index('conversations_by_updated').on(t.tenantId, t.updatedAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    tenantId: uuid('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['customer', 'agent', 'system'] }).notNull(),
    author: text('author', { enum: ['ai', 'human', 'followup'] }),
    authorUserId: uuid('author_user_id'),
    authorName: text('author_name'),
    content: text('content').notNull(),
    /** ChatMessage.at（毫秒）原样往返 */
    at: tstz('at').notNull(),
    /** ChatMessage.sentAt（企微 send_time） */
    sentAt: tstz('sent_at'),
    /** 不建唯一索引（spec「企微 · 去重」） */
    msgid: text('msgid'),
    /** 软引用 turn_traces：trace 比消息先到期 */
    turnId: uuid('turn_id'),
    /** ChatMessage 上已知字段以外的键，原样往返；没有就是 NULL */
    extra: json('extra').$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.conversationId, t.seq] }),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    check('messages_seq_check', sql`${t.seq} > 0`),
    check('messages_role_check', sql`${t.role} IN ('customer', 'agent', 'system')`),
    check('messages_author_check', sql`${t.author} IN ('ai', 'human', 'followup')`),
    check('messages_author_role_check', sql`${t.role} = 'agent' OR ${t.author} IS NULL`),
    check('messages_author_human_check', sql`${t.author} = 'human' OR (${t.authorUserId} IS NULL AND ${t.authorName} IS NULL)`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** 新单是 ord_ 加 24 位十六进制；旧数据原样 */
    id: text('id').notNull(),
    /** 会话被清除或删除后置空。外键 (tenant_id, session_id) → conversations ON DELETE SET NULL (session_id) 在 custom 迁移里 */
    sessionId: text('session_id'),
    /** 不对产品库建外键 */
    routeId: text('route_id').notNull(),
    status: text('status', { enum: ['pending_payment', 'paid', 'cancelled', 'superseded'] }).notNull(),
    totalPrice: integer('total_price').notNull(),
    createdAt: tstz('created_at').notNull(),
    /** 触发器：写入之后不能改、不能清空 */
    paidAt: tstz('paid_at'),
    confirmedAt: tstz('confirmed_at'),
    voidedAt: tstz('voided_at'),
    voidReason: text('void_reason', { enum: ['reset', 'resync'] }),
    /** 整个 Order 对象，键序原样；重建只读它 */
    data: json('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    check('orders_id_check', sql`${t.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check('orders_status_check', sql`${t.status} IN ('pending_payment', 'paid', 'cancelled', 'superseded')`),
    check('orders_total_price_check', sql`${t.totalPrice} >= 0`),
    check('orders_void_reason_check', sql`${t.voidReason} IN ('reset', 'resync')`),
    check('orders_data_check', sql`json_typeof(${t.data}) = 'object' AND coalesce(${t.data}->>'id' = ${t.id}, false)`),
    index('orders_by_status').on(t.tenantId, t.status, t.createdAt),
  ],
);

export const turnTraces = pgTable(
  'turn_traces',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull(),
    conversationId: text('conversation_id').notNull(),
    startedAt: tstz('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    outcome: text('outcome', { enum: ['replied', 'silent', 'handoff', 'deterministic', 'reset', 'budget', 'error'] }).notNull(),
    sopVersion: integer('sop_version'),
    prefixHash: text('prefix_hash').notNull(),
    /** { 'route:r-guizhou': 2 }：本轮工具结果里出现过的条目版本 */
    catalogVersions: json('catalog_versions').$type<Record<string, number>>().notNull(),
    stageBefore: text('stage_before'),
    stageAfter: text('stage_after'),
    draft: text('draft'),
    finalText: text('final_text'),
    calls: json('calls').$type<unknown[]>().notNull(),
    /** 每次模型调用一项，带 error（R24 的 AI 出错率） */
    llm: json('llm').$type<unknown[]>().notNull(),
    signals: json('signals'),
    /** 04 R8：全部执行过的主回复步骤；未进入流水线为 null。 */
    guardVerdicts: json('guard_verdicts').$type<GuardVerdict[]>(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'turn_traces_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    check('turn_traces_outcome_check', sql`${t.outcome} IN ('replied', 'silent', 'handoff', 'deterministic', 'reset', 'budget', 'error')`),
    check('turn_traces_prefix_hash_check', sql`${t.prefixHash} ~ '^[0-9a-f]{64}$'`),
    index('turn_traces_by_conv').on(t.tenantId, t.conversationId, t.startedAt),
    // 运行数字（R24）
    index('turn_traces_by_time').on(t.tenantId, t.startedAt),
  ],
);

export const guardEvents = pgTable(
  'guard_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    turnId: uuid('turn_id').notNull(),
    ord: smallint('ord').notNull(),
    guard: text('guard').notNull(),
    action: text('action', { enum: ['drop_sentence', 'replace', 'patch', 'append', 'strip', 'handoff'] }).notNull(),
    removed: json('removed').$type<string[]>().notNull(),
    added: json('added').$type<string[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.turnId, t.ord] }),
    foreignKey({
      name: 'guard_events_turn_fk',
      columns: [t.tenantId, t.turnId],
      foreignColumns: [turnTraces.tenantId, turnTraces.id],
    }).onDelete('cascade'),
    check('guard_events_guard_check', sql`${t.guard} ~ '^[a-z_]{2,40}$'`),
    check('guard_events_action_check', sql`${t.action} IN ('drop_sentence', 'replace', 'patch', 'append', 'strip', 'handoff')`),
  ],
);

export const usageDaily = pgTable(
  'usage_daily',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** 服务器时区（TZ）的日期，'YYYY-MM-DD' */
    day: date('day', { mode: 'string' }).notNull(),
    model: text('model').notNull(),
    purpose: text('purpose', { enum: ['chat', 'followup', 'insight', 'suggestion', 'draft', 'embedding'] }).notNull(),
    calls: integer('calls').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
    /** 千分之一元，避免浮点 */
    costMilliCny: bigint('cost_milli_cny', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.model, t.purpose] }),
    check('usage_daily_purpose_check', sql`${t.purpose} IN ('chat', 'followup', 'insight', 'suggestion', 'draft', 'embedding')`),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    kind: text('kind', { enum: ['followup', 'handoff_notify', 'retention_purge'] }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    runAt: tstz('run_at').notNull(),
    status: text('status', { enum: ['pending', 'running', 'sending', 'done', 'failed', 'cancelled', 'abandoned'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    payload: json('payload').notNull(),
    lastError: text('last_error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    claimedAt: tstz('claimed_at'),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    check('jobs_kind_check', sql`${t.kind} IN ('followup', 'handoff_notify', 'retention_purge')`),
    check('jobs_status_check', sql`${t.status} IN ('pending', 'running', 'sending', 'done', 'failed', 'cancelled', 'abandoned')`),
    check('jobs_max_attempts_check', sql`${t.maxAttempts} BETWEEN 1 AND 10`),
    // 同一 dedupe_key 至多一个没结束的任务（enqueue 的唯一性兜底）
    uniqueIndex('jobs_open_uq')
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.status} IN ('pending', 'running', 'sending')`),
    index('jobs_due')
      .on(t.tenantId, t.runAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const quickReplies = pgTable(
  'quick_replies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    ord: integer('ord').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    archivedAt: tstz('archived_at'),
    updatedByName: text('updated_by_name'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    check('quick_replies_title_check', sql`length(${t.title}) BETWEEN 1 AND 20`),
    check('quick_replies_body_check', sql`length(${t.body}) BETWEEN 1 AND 500`),
  ],
);

export const outboundSends = pgTable(
  'outbound_sends',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    /** 不建外键：老客户进入会话时补发的欢迎语可能还没有会话；清除与删除函数按 id 显式删 */
    conversationId: text('conversation_id').notNull(),
    /** 我们生成、随 send_msg 下发；同一分段重试沿用 */
    channelMsgid: text('channel_msgid').notNull(),
    /** 对应的会话消息；欢迎语、同意菜单为 NULL */
    messageSeq: integer('message_seq'),
    kind: text('kind', { enum: ['ai', 'human', 'followup', 'notice', 'welcome', 'menu', 'card'] }).notNull(),
    /** pending 时是建这一行的时刻，之后每次尝试往后挪（窗口计数与 purge_expired_traces 按它） */
    sentAt: tstz('sent_at').notNull(),
    /**
     * 02：rejected 接口明确报错；unknown 超时或网络异常、结果不明（计入额度）；failed 收到 msg_send_fail。
     * 03 加 pending（已落库、还没发）、sending（这一段已开始发）、cancelled（不会再发）；只按迁移表变化（src/channels/transitions.ts）
     */
    status: text('status', { enum: OUTBOUND_STATUSES }).notNull(),
    errcode: integer('errcode'),
    failType: integer('fail_type'),
    /** 03：库里的渠道账号；02 的旧行与 env 账号为 NULL（前缀为 wecom: 的默认账号，ENV_ACCOUNT_ID 永不落库） */
    accountId: uuid('account_id'),
    /** 03：回的是哪条入站；人工回复、跟进、通知、同意菜单、欢迎语为 NULL */
    inboxId: uuid('inbox_id'),
    /** 03：这一组里的第几段，从 0 起 */
    segment: smallint('segment').notNull().default(0),
    attempts: smallint('attempts').notNull().default(0),
    /** 03：要发的内容，只在 pending、sending 时有值 */
    payload: json('payload'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('outbound_sends_tenant_id_channel_msgid_uq').on(t.tenantId, t.channelMsgid),
    foreignKey({
      name: 'outbound_sends_account_fk',
      columns: [t.tenantId, t.accountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }),
    check('outbound_sends_channel_msgid_check', sql`octet_length(${t.channelMsgid}) <= 32`),
    check('outbound_sends_kind_check', sql`${t.kind} IN ('ai', 'human', 'followup', 'notice', 'welcome', 'menu', 'card')`),
    check(
      'outbound_sends_status_check',
      sql`${t.status} IN ('pending', 'sending', 'accepted', 'rejected', 'unknown', 'failed', 'cancelled')`,
    ),
    check('outbound_sends_payload_check', sql`${t.status} IN ('pending', 'sending') OR ${t.payload} IS NULL`),
    index('outbound_sends_by_conv').on(t.tenantId, t.conversationId, t.sentAt),
    index('outbound_sends_open')
      .on(t.tenantId, t.accountId)
      .where(sql`${t.status} IN ('pending', 'sending')`),
  ],
);

/** 每个 active 条目的每次内容变化一行，永不修改（spec「报价快照」） */
export const catalogItemVersions = pgTable(
  'catalog_item_versions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    code: text('code').notNull(),
    version: integer('version').notNull(),
    /** 与 catalog_items.payload 同为 json，键序原样 */
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    source: text('source', { enum: ['backfill', 'activate', 'console', 'fix'] }).notNull(),
    createdByName: text('created_by_name'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.kind, t.code, t.version] }),
    foreignKey({
      name: 'catalog_item_versions_item_fk',
      columns: [t.tenantId, t.kind, t.code],
      foreignColumns: [catalogItems.tenantId, catalogItems.kind, catalogItems.code],
    }),
    check('catalog_item_versions_version_check', sql`${t.version} > 0`),
    check('catalog_item_versions_source_check', sql`${t.source} IN ('backfill', 'activate', 'console', 'fix')`),
  ],
);

export const privacyNotices = pgTable(
  'privacy_notices',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: integer('version').notNull(),
    /** 纯文本，租户提供 */
    body: text('body').notNull(),
    publishedAt: tstz('published_at').notNull().defaultNow(),
    publishedByName: text('published_by_name'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.version] }), check('privacy_notices_version_check', sql`${t.version} > 0`)],
);

export const consents = pgTable(
  'consents',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    category: text('category', { enum: ['health', 'minor'] }).notNull(),
    decision: text('decision', { enum: ['asked', 'granted', 'declined', 'withdrawn'] }).notNull(),
    noticeVersion: integer('notice_version').notNull(),
    /** 企微菜单的 menu_id 或客户原话，≤200 字 */
    evidence: text('evidence'),
    at: tstz('at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'consents_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    check('consents_category_check', sql`${t.category} IN ('health', 'minor')`),
    check('consents_decision_check', sql`${t.decision} IN ('asked', 'granted', 'declined', 'withdrawn')`),
  ],
);

// ---------------- 03：渠道层 v2（spec「数据库」） ----------------
// 两张新表都带 tenant_id、套 01 的 RLS 模板（custom 迁移）；agent_app 对它们没有 DELETE，入站行只经 purge_channel_inbox 与
// 02 的清除、删除函数删除；channel_accounts 的列级 UPDATE、两个触发器也在 custom 迁移里

/** 一行一个入口：wecom_kf（一个客服账号）或 web（一个网页入口）。kind、key、id_prefix、corp_id、open_kfid 建好不改（触发器） */
export const channelAccounts = pgTable(
  'channel_accounts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    /** 路由、日志、告警里用 */
    key: text('key').notNull(),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: CHANNEL_ACCOUNT_STATUSES }).notNull().default('active'),
    /** wecom_kf：'wecom:' 或 'wecom:<key>:'（R11） */
    idPrefix: text('id_prefix'),
    /** 标识不是密钥，明文存；不进仓库、不进日志 */
    corpId: text('corp_id'),
    openKfid: text('open_kfid'),
    /** nonce(12) ‖ 密文 ‖ tag(16)（R9） */
    secretsCt: bytea('secrets_ct'),
    secretsKeyId: text('secrets_key_id'),
    /** sync_msg 的 cursor；NULL 表示冷启动 */
    cursor: text('cursor'),
    cursorAt: tstz('cursor_at'),
    /** 恢复截止点（R7） */
    recordOnlyUntil: tstz('record_only_until'),
    settings: json('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** 触发器在每次 UPDATE 时写 now() */
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('channel_accounts_tenant_id_key_uq').on(t.tenantId, t.key),
    unique('channel_accounts_tenant_id_id_prefix_uq').on(t.tenantId, t.idPrefix),
    unique('channel_accounts_tenant_id_open_kfid_uq').on(t.tenantId, t.openKfid),
    check('channel_accounts_key_check', sql`${t.key} ~ '^[a-z][a-z0-9-]{1,30}$'`),
    check('channel_accounts_kind_check', sql`${t.kind} IN ('wecom_kf', 'web')`),
    check('channel_accounts_name_check', sql`length(${t.name}) BETWEEN 1 AND 40`),
    check('channel_accounts_status_check', sql`${t.status} IN ('active', 'disabled', 'exported')`),
    check('channel_accounts_settings_check', sql`json_typeof(${t.settings}) = 'object'`),
    // id_prefix 为 NULL 时 IN 的结果是 NULL、CHECK 会放行：coalesce 成 false，企微账号必须有前缀
    check(
      'channel_accounts_wecom_check',
      sql`${t.kind} <> 'wecom_kf' OR (coalesce(${t.idPrefix} IN ('wecom:', 'wecom:' || ${t.key} || ':'), false) AND ${t.corpId} IS NOT NULL AND ${t.openKfid} IS NOT NULL AND ${t.secretsCt} IS NOT NULL AND ${t.secretsKeyId} IS NOT NULL)`,
    ),
    check(
      'channel_accounts_web_check',
      sql`${t.kind} <> 'web' OR (${t.idPrefix} IS NULL AND ${t.corpId} IS NULL AND ${t.openKfid} IS NULL AND ${t.secretsCt} IS NULL AND ${t.cursor} IS NULL AND ${t.recordOnlyUntil} IS NULL)`,
    ),
  ],
);

/**
 * 入站记录（R2、R3）：以（account_id，msgid）去重，ord 定顺序（同一页的 received_at 相同、send_time 只到秒）。
 * 状态只按迁移表往前走（src/channels/transitions.ts）；done、abandoned 之后不再变（触发器）
 */
export const channelInbox = pgTable(
  'channel_inbox',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    /** 插入顺序：同一页按页内顺序逐行分配 */
    ord: bigint('ord', { mode: 'number' }).generatedAlwaysAsIdentity(),
    accountId: uuid('account_id').notNull(),
    msgid: text('msgid').notNull(),
    kind: text('kind', { enum: INBOX_KINDS }).notNull(),
    /** 不建外键：会话可能还没建（同 outbound_sends）；带着 external_userid 的行一律填，清除与行权删除按它删 */
    conversationId: text('conversation_id'),
    /** 企微 send_time */
    sentAt: tstz('sent_at'),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    state: text('state', { enum: INBOX_STATES }).notNull(),
    reason: text('reason', { enum: INBOX_ABANDON_REASONS }),
    attempts: smallint('attempts').notNull().default(0),
    messageSeq: integer('message_seq'),
    /** done、abandoned 时为空 */
    payload: json('payload'),
    /** 触发器在每次 UPDATE 时写 now()；清理按它删 */
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('channel_inbox_tenant_id_account_id_msgid_uq').on(t.tenantId, t.accountId, t.msgid),
    foreignKey({
      name: 'channel_inbox_account_fk',
      columns: [t.tenantId, t.accountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }),
    check('channel_inbox_msgid_check', sql`octet_length(${t.msgid}) BETWEEN 1 AND 128`),
    check('channel_inbox_kind_check', sql`${t.kind} IN ('message', 'menu_click', 'enter_session', 'send_fail', 'legacy')`),
    check('channel_inbox_state_check', sql`${t.state} IN ('received', 'recorded', 'replied', 'done', 'abandoned')`),
    check('channel_inbox_reason_check', sql`${t.reason} IN ('too_old', 'poison', 'cold_start', 'restore_cutoff', 'resync')`),
    check('channel_inbox_reason_iff_abandoned', sql`(${t.state} = 'abandoned') = (${t.reason} IS NOT NULL)`),
    check('channel_inbox_payload_check', sql`${t.state} NOT IN ('done', 'abandoned') OR ${t.payload} IS NULL`),
    check('channel_inbox_conversation_check', sql`${t.kind} = 'legacy' OR ${t.conversationId} IS NOT NULL`),
    index('channel_inbox_open')
      .on(t.tenantId, t.accountId, t.ord)
      .where(sql`${t.state} IN ('received', 'recorded', 'replied')`),
    index('channel_inbox_by_conv').on(t.tenantId, t.conversationId),
    index('channel_inbox_finished')
      .on(t.tenantId, t.updatedAt)
      .where(sql`${t.state} IN ('done', 'abandoned')`),
  ],
);
