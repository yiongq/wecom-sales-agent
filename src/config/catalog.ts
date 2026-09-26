// 产品库的编辑流程（docs/architecture/01-pg-config-console/spec.md「产品库 · 编辑规则」）。
// 每个写函数在 withTenant 里第一句取配置写锁；更新按 rev 乐观锁；写库的是「旧 payload 应用补丁」按旧键序递归合并的对象，
// 值取请求原文，不取 zod 的输出；合并后的整条再过一遍 schema。提交之后用 RETURNING 的行更新快照，结果不明时整体重读。
// 接口上没有下架和删除：已上架的条目回不到 draft（触发器也拦），删了已发出的方案书就 404。
import { isUniqueViolation, lockTenantConfig, withTenant, type Db, type TenantCtx, type Tx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import {
  activateItem,
  insertDraftItem,
  maxOrd,
  readCatalogItem,
  readCatalogItemForUpdate,
  readCatalogOfKind,
  updateItemPayload,
  type CatalogRow,
} from '../db/repo/catalog.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { ALWAYS_LOCKED, applyCatalogPatch, CATALOG_SCHEMAS, lockedFieldChanges, type CatalogKind } from '../shared/catalog.js';
import type { Hotel, Route } from '../shared/catalog-types.js';
import type { CatalogItem } from '../shared/console-api.js';
import { applyCatalogRow, assertConfigWritable, configRuntime, reloadFromDb } from './source.js';

export type { CatalogKind } from '../shared/catalog.js';

export type { CatalogItem } from '../shared/console-api.js';

/** 字段级补丁：set 里点名的顶层字段整体替换，unset 里的字段删除，没点名的一律不动 */
export interface CatalogPatch {
  rev: number;
  set: Record<string, unknown>;
  unset?: string[];
}

/** → 422，逐条列出哪里不合格 */
export class CatalogValidationError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`条目不合格：${issues.map((i) => `${i.path || '（整条）'} ${i.message}`).join('；')}`);
  }
}
/** → 422，逐个点名字段 */
export class CatalogLockedFieldError extends Error {
  constructor(readonly fields: string[]) {
    super(`这些字段已锁定，不能改：${fields.join('、')}`);
  }
}
/** → 409 */
export class CatalogRevConflictError extends Error {}
/** → 409 catalog_code_taken */
export class CatalogCodeTakenError extends Error {}
/** → 404 */
export class CatalogNotFoundError extends Error {}

const toItem = (r: CatalogRow): CatalogItem => ({
  kind: r.kind,
  code: r.code,
  ord: r.ord,
  status: r.status,
  rev: r.rev,
  payload: r.payload as unknown as Route | Hotel,
  updatedByName: r.updatedByName,
  updatedAt: r.updatedAt.toISOString(),
});

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 整条过 schema；不合格抛 CatalogValidationError。只做校验，返回值不用（写库的是原对象） */
function validate(kind: CatalogKind, payload: unknown): void {
  const r = CATALOG_SCHEMAS[kind].safeParse(payload);
  if (!r.success) throw new CatalogValidationError(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

/** 审计的 diff：只放变了的顶层字段 { 字段: [旧, 新] }；原样提交回去时为空对象 */
function topLevelDiff(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out[k] = [prev[k] ?? null, next[k] ?? null];
  }
  return out;
}

const by = (ctx: TenantCtx): { userId: string | null; name: string | null } => ({ userId: ctx.actor.userId, name: ctx.actor.name });

function runtimeFor(ctx: TenantCtx): ReturnType<typeof configRuntime> {
  const rt = configRuntime();
  if (ctx.tenantId !== rt.tenantId) throw new Error('这个租户不是本进程装载的租户');
  return rt;
}

/** 写事务外壳：持锁检查、配置写锁；COMMIT 结果不明时整体重读。提交之后用返回的行更新快照 */
async function write(ctx: TenantCtx, fn: (tx: Tx) => Promise<CatalogRow>): Promise<CatalogItem> {
  assertConfigWritable();
  const rt = runtimeFor(ctx);
  let reachedCommit = false;
  let row: CatalogRow;
  try {
    row = await withTenant(rt.db, ctx, async (tx) => {
      await lockTenantConfig(tx);
      const out = await fn(tx);
      reachedCommit = true;
      return out;
    });
  } catch (e) {
    if (reachedCommit) void reloadFromDb().catch(() => {});
    // 唯一约束一律 409：code 撞了是 catalog_code_taken，其余（ord 之类）当并发冲突
    if (isUniqueViolation(e, 'catalog_items_tenant_kind_code_uq')) throw new CatalogCodeTakenError('这个 code 已经有了');
    if (isUniqueViolation(e)) throw new CatalogRevConflictError('并发写入冲突，刷新后重来');
    throw e;
  }
  applyCatalogRow(row);
  return toItem(row);
}

// ---------------- 读 ----------------

/** 按 ord 排序，含 draft；v0 条目只有几十条，不分页 */
export async function listCatalog(ctx: TenantCtx, kind: CatalogKind): Promise<CatalogItem[]> {
  const rt = runtimeFor(ctx);
  return withTenant(rt.db, ctx, async (tx) => (await readCatalogOfKind(tx, kind)).map(toItem), { readOnly: true });
}

export async function getCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string): Promise<CatalogItem | null> {
  const rt = runtimeFor(ctx);
  const row = await withTenant(rt.db, ctx, (tx) => readCatalogItem(tx, kind, code), { readOnly: true });
  return row ? toItem(row) : null;
}

// ---------------- 写 ----------------

/** 新条目为 draft，ord 取该 kind 的最大 ord 加 1 */
export async function createCatalogItem(ctx: TenantCtx, kind: CatalogKind, payload: unknown): Promise<CatalogItem> {
  if (!isPlainObject(payload)) throw new CatalogValidationError([{ path: '', message: '条目必须是对象' }]);
  validate(kind, payload);
  return write(ctx, async (tx) => {
    if (await readCatalogItem(tx, kind, String(payload.id))) throw new CatalogCodeTakenError('这个 code 已经有了');
    const row = await insertDraftItem(tx, { tenantId: ctx.tenantId, kind, ord: (await maxOrd(tx, kind)) + 1, payload, by: by(ctx) });
    await writeAudit(tx, { action: 'catalog.create', targetType: kind, targetId: row.code, diff: topLevelDiff({}, payload) });
    return row;
  });
}

export async function updateCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string, patch: CatalogPatch): Promise<CatalogItem> {
  if (!isPlainObject(patch.set) || (patch.unset !== undefined && !Array.isArray(patch.unset))) {
    throw new CatalogValidationError([{ path: '', message: '补丁要有 set 对象，unset 是字段名数组' }]);
  }
  return write(ctx, async (tx) => {
    const cur = await readCatalogItemForUpdate(tx, kind, code);
    if (!cur) throw new CatalogNotFoundError(`没有 ${kind} ${code}`);
    if (cur.rev !== patch.rev) throw new CatalogRevConflictError('条目已被别人改过，刷新后重来');
    let next: Record<string, unknown>;
    try {
      next = applyCatalogPatch(cur.payload, { set: patch.set, unset: patch.unset });
    } catch (e) {
      throw new CatalogValidationError([{ path: '', message: e instanceof Error ? e.message : String(e) }]);
    }
    // 锁定字段（active 按 LOCKED_WHEN_ACTIVE，任何状态都按 ALWAYS_LOCKED）有变化就拒；unset 锁定字段也算变化
    const locked = lockedFieldChanges(kind, cur.status, cur.payload, next);
    if (locked.length) throw new CatalogLockedFieldError(locked);
    validate(kind, next);
    const row = await updateItemPayload(tx, kind, code, cur.rev, next, by(ctx));
    if (!row) throw new CatalogRevConflictError('条目已被别人改过，刷新后重来');
    await writeAudit(tx, { action: 'catalog.update', targetType: kind, targetId: code, diff: topLevelDiff(cur.payload, next) });
    return row;
  });
}

/** draft → active，上架前整条再过一遍 schema。已经是 active 的原样返回，不写库、不动快照 */
export async function activateCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string, input: { rev: number }): Promise<CatalogItem> {
  const existing = await getCatalogItem(ctx, kind, code);
  if (!existing) throw new CatalogNotFoundError(`没有 ${kind} ${code}`);
  if (existing.status === 'active' && existing.rev === input.rev) return existing;
  return write(ctx, async (tx) => {
    const cur = await readCatalogItemForUpdate(tx, kind, code);
    if (!cur) throw new CatalogNotFoundError(`没有 ${kind} ${code}`);
    if (cur.rev !== input.rev || cur.status !== 'draft') throw new CatalogRevConflictError('条目已被别人改过，刷新后重来');
    validate(kind, cur.payload);
    const row = await activateItem(tx, kind, code, cur.rev, by(ctx));
    if (!row) throw new CatalogRevConflictError('条目已被别人改过，刷新后重来');
    await writeAudit(tx, { action: 'catalog.activate', targetType: kind, targetId: code, diff: { status: ['draft', 'active'] } });
    return row;
  });
}

// ---------------- 锁定字段的紧急修正（catalog-fix 命令行） ----------------

/**
 * 锁定字段的唯一修正途径（spec「导入、导出与回滚 · catalog-fix」）：补丁规则同后台，只是允许改 LOCKED_WHEN_ACTIVE 里的字段，
 * id 除外；写一行带 reason 的 catalog.locked_fix 审计。调用方先拿租户锁（应用必须停着），改完重启应用重新装载快照
 */
export async function fixLockedFields(input: {
  db: Db;
  tenantSlug: string;
  kind: CatalogKind;
  code: string;
  set: Record<string, unknown>;
  reason: string;
}): Promise<CatalogItem> {
  if (!input.reason.trim()) throw new CatalogValidationError([{ path: 'reason', message: '要写明修正原因' }]);
  if (!isPlainObject(input.set)) throw new CatalogValidationError([{ path: 'set', message: '--set 必须是 JSON 对象' }]);
  const tenant = await findTenantBySlug(input.db, input.tenantSlug);
  if (!tenant) throw new CatalogNotFoundError(`没有 slug 为「${input.tenantSlug}」的租户`);
  const ctx: TenantCtx = { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'catalog-fix', ip: null } };
  const row = await withTenant(input.db, ctx, async (tx) => {
    await lockTenantConfig(tx);
    const cur = await readCatalogItemForUpdate(tx, input.kind, input.code);
    if (!cur) throw new CatalogNotFoundError(`没有 ${input.kind} ${input.code}`);
    const next = applyCatalogPatch(cur.payload, { set: input.set });
    const idChanged = lockedFieldChanges(input.kind, 'draft', cur.payload, next).filter((f) =>
      (ALWAYS_LOCKED as readonly string[]).includes(f),
    );
    if (idChanged.length) throw new CatalogLockedFieldError(idChanged);
    validate(input.kind, next);
    const updated = await updateItemPayload(tx, input.kind, input.code, cur.rev, next, { userId: null, name: 'catalog-fix' });
    if (!updated) throw new CatalogRevConflictError('条目在修正期间被改过');
    await writeAudit(tx, {
      action: 'catalog.locked_fix',
      targetType: input.kind,
      targetId: input.code,
      diff: { ...topLevelDiff(cur.payload, next), reason: input.reason },
    });
    return updated;
  });
  return toItem(row);
}
