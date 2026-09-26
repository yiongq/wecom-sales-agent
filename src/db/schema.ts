// 01 的七张表（docs/architecture/01-pg-config-console/spec.md「数据库 · DDL」）。
// 这里只写表、索引和约束，由 drizzle-kit 生成迁移；RLS、策略、触发器、认证函数和授权在 custom 迁移里。
// 列名一律显式写 snake_case，不依赖 casing 推导：迁移 SQL 与 spec 的 DDL 逐列对得上。
// 改这个文件之后跑 `pnpm db:generate` 生成新迁移，已提交的迁移文件永远不改（lint 会查）。
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    /** 海外适配保留的缝，01 没有读方 */
    locale: text('locale').notNull().default('zh-CN'),
    region: text('region').notNull().default('CN'),
    status: text('status', { enum: ['trial', 'active', 'suspended'] })
      .notNull()
      .default('active'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('tenants_slug_check', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('tenants_status_check', sql`${t.status} IN ('trial', 'active', 'suspended')`),
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
