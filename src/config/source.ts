// 配置源（docs/architecture/01-pg-config-console/spec.md「两种模式与启动装载」）。
// 文件模式（CONFIG_SOURCE 未设、空串或 file）什么都不做，引擎和工具照旧读 data/。
// DB 模式在启动时一次装载已发布的 SOP 与 active 条目，放进进程内缓存；每轮对话只读缓存、不查库。
// 本模块不 import store / tools / engine：它们反过来 import 这里，快照变化经 onCatalogChanged 回调通知。
import fs from 'node:fs';
import path from 'node:path';
import { holdTenantLock, openDb, redactUrl, serverEncoding, withTenant, type Db, type TenantCtx, type TenantLock } from '../db/client.js';
import { appliedMigrationHashes, imageMigrationHashes } from '../db/migrate.js';
import { readActiveCatalog, type CatalogRow } from '../db/repo/catalog.js';
import { readPublishedSop, type SopVersionRow } from '../db/repo/sop.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import type { RenderInputs } from '../db/schema.js';
import { renderSystemPrompt } from '../prompt/system.js';
import type { Hotel, Route } from '../shared/catalog-types.js';
import { deepFreeze } from '../shared/freeze.js';
import { checkSopContract, SOP_KNOWN_FIELDS } from '../sop/contract.js';
import { decodeSopFile, joinSop, mergeWithImage, splitSop, TRAVEL_SOP_SECTIONS, type SopSection } from '../sop/sections.js';
import { toolDefs } from '../tool-defs.js';
import { promptHashes, renderInputsFor, sha256 } from './hashes.js';

export type { TenantLock } from '../db/client.js';
export type ConfigMode = 'file' | 'db';

export interface PublishedSop {
  tenantId: string;
  versionId: string;
  versionNo: number;
  /** 与镜像合并之后的全部节，deep-frozen；匿名只读页也从这里取，不查库 */
  sections: readonly SopSection[];
  /** 整段 system prompt。每轮原样交给 chat()，从不重新渲染 */
  renderedPrompt: string;
  /** 以下都是 64 位小写十六进制 sha256，含义见 spec「渲染与哈希」 */
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
}

export interface CatalogSnapshot {
  tenantId: string;
  /** 进程内单调递增，每次快照变化加 1。检索索引据此丢弃过期的构建结果；文件模式恒为 0 */
  generation: number;
  /** 只含 active 条目，各自按 ord 升序，deep-frozen */
  routes: readonly Route[];
  hotels: readonly Hotel[];
}

export interface ConfigHealth {
  lock: 'held' | 'lost';
  sopStale: boolean;
  catalogStale: boolean;
}

/** 装载所需的全部外部依赖。生产由 productionConfigDeps 构造；自测逐项替换 */
export interface ConfigDeps {
  db: Db;
  tenantSlug: string;
  /** null = 锁在别人手里 */
  lock(tenantId: string): Promise<TenantLock | null>;
  /** 镜像里 data/sop.md 的全文，启动时读一次，之后的发布、回滚、导出都用这一份 */
  imageSop: string;
  /** JSON.stringify(toolDefs)，与 promptPrefix().tools 相同 */
  toolsJson: string;
  toolNames: readonly string[];
  knownFields: readonly string[];
  render(sop: string): string;
  /** 与 SIGTERM 走同一条停机路径（store.ts 的 gracefulExit），配置层不 import store */
  gracefulExit(code: number): void;
  /** 关闭连接池。spec 的接口里没有，失败与停机时要关；PGlite 由测试自己关，不传 */
  closeDb?: () => Promise<void>;
  /** 镜像的 data/ 目录，只用来在启动日志里点名与库里的差异；默认 cwd/data */
  imageDataDir?: string;
}

export class ConfigNotReadyError extends Error {
  constructor() {
    super('DB 模式的配置源还没装载完成');
  }
}
/** 锁连接断开期间的配置写入 → 503 lock_lost */
export class ConfigLockLostError extends Error {
  constructor() {
    super('租户锁连接断开，配置写入暂停');
  }
}
export type ConfigStartupReason =
  | 'env_invalid'
  | 'env_privileged'
  | 'db_unreachable'
  | 'db_encoding'
  | 'schema_behind'
  | 'tenant_not_found'
  | 'tenant_suspended'
  | 'lock_held'
  | 'image_sop_invalid'
  | 'no_published_sop'
  | 'integrity'
  | 'renderer_nondeterministic'
  | 'contract_failed'
  | 'no_active_routes';
export class ConfigStartupError extends Error {
  constructor(
    readonly reason: ConfigStartupReason,
    readonly detail: string,
  ) {
    super(`${reason}：${detail}`);
  }
}
const startup = (reason: ConfigStartupReason, detail: string): ConfigStartupError => new ConfigStartupError(reason, detail);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------- 状态 ----------------

interface Loaded {
  deps: ConfigDeps;
  tenantId: string;
  lock: TenantLock;
  imageSections: readonly SopSection[];
  sop: PublishedSop;
  catalog: CatalogSnapshot;
}

/** initConfig 收到非空 deps 之后就是 DB 模式，装载失败时撤回 */
let dbInstalled = false;
let loaded: Loaded | null = null;
let lockState: 'held' | 'lost' = 'held';
let sopStale = false;
let catalogStale = false;
let shuttingDown = false;
let generation = 0;
let reacquireMs = 5_000;
let reacquireTimer: NodeJS.Timeout | null = null;
const catalogListeners: ((snap: CatalogSnapshot) => void)[] = [];

/** 装过 DB 配置源（initConfig 收到非空 deps），或 CONFIG_SOURCE === 'db'，就是 'db'；否则 'file' */
export function configMode(): ConfigMode {
  return dbInstalled || process.env.CONFIG_SOURCE === 'db' ? 'db' : 'file';
}

/** db 模式且装载完成后才能调用，否则抛 ConfigNotReadyError */
export function currentSop(): PublishedSop {
  if (!loaded) throw new ConfigNotReadyError();
  return loaded.sop;
}
export function currentCatalog(): CatalogSnapshot {
  if (!loaded) throw new ConfigNotReadyError();
  return loaded.catalog;
}

/** 产品库快照变化后回调；retrieval.ts 在加载时注册，用来失效并重建索引 */
export function onCatalogChanged(cb: (snap: CatalogSnapshot) => void): void {
  catalogListeners.push(cb);
}

export function configHealth(): ConfigHealth {
  return { lock: lockState, sopStale, catalogStale };
}

/** 配置写入前调：锁连接断开期间一律拒绝（第 7、8 步的写函数用） */
export function assertConfigWritable(): void {
  if (!loaded) throw new ConfigNotReadyError();
  if (lockState !== 'held') throw new ConfigLockLostError();
}

// ---------------- 生产依赖 ----------------

const PRIVILEGED = ['DATABASE_OWNER_URL', 'DATABASE_PLATFORM_URL', 'POSTGRES_PASSWORD'];

/**
 * 从环境变量构造生产依赖。CONFIG_SOURCE 由 initConfigFromEnv 先查；这里要求 DATABASE_URL 是 postgres:// 或 postgresql://，
 * DEFAULT_TENANT_SLUG 与 DEPLOY_PROFILE 显式设置；环境里不能有 owner / platform / 超级用户的凭据。连接串一律脱敏
 */
export async function productionConfigDeps(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<ConfigDeps> {
  const privileged = [...PRIVILEGED, ...Object.keys(env).filter((k) => /^AGENT_[A-Z0-9_]+_PASSWORD$/.test(k))].filter((k) => env[k]);
  if (privileged.length) {
    throw startup(
      'env_privileged',
      `app 的环境里不能有 ${[...new Set(privileged)].join('、')}：它们只给 migrate、platform 与 db 服务（spec R19）`,
    );
  }
  const url = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(url)) throw startup('env_invalid', 'DB 模式要设 DATABASE_URL，只接受 postgres:// 或 postgresql://');
  const tenantSlug = env.DEFAULT_TENANT_SLUG ?? '';
  if (!tenantSlug) throw startup('env_invalid', 'DB 模式要设 DEFAULT_TENANT_SLUG');
  if (!env.DEPLOY_PROFILE) throw startup('env_invalid', 'DB 模式要显式设置 DEPLOY_PROFILE，不接受缺省的 demo');
  for (const k of ['SOP_PATH', 'ROUTES_PATH', 'HOTELS_PATH']) {
    if (env[k]) console.warn(`[config] DB 模式下忽略 ${k}：它只给文件模式的测试夹具与回归跑法用`);
  }
  const imagePath = path.join(process.cwd(), 'data', 'sop.md');
  let imageSop: string;
  try {
    imageSop = decodeSopFile(fs.readFileSync(imagePath));
  } catch (e) {
    throw startup('image_sop_invalid', `读不到镜像里的 ${imagePath}：${message(e)}`);
  }
  let opened: Awaited<ReturnType<typeof openDb>>;
  try {
    opened = await openDb(url);
  } catch (e) {
    throw startup('db_unreachable', `${redactUrl(url)}：${message(e)}`);
  }
  return {
    db: opened.db,
    closeDb: opened.close,
    tenantSlug,
    lock: (tenantId) => holdTenantLock(url, tenantId),
    imageSop,
    toolsJson: JSON.stringify(toolDefs),
    toolNames: toolDefs.map((t) => t.function.name),
    knownFields: SOP_KNOWN_FIELDS,
    render: renderSystemPrompt,
    gracefulExit,
  };
}

/** 生产入口：先校验 CONFIG_SOURCE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式 */
export async function initConfigFromEnv(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<void> {
  const mode = env.CONFIG_SOURCE ?? '';
  if (mode !== '' && mode !== 'file' && mode !== 'db') {
    // 只回显看起来像个取值的短词：配错位置的整行环境变量里可能带着连接串口令
    const shown = /^[a-z]{1,16}$/i.test(mode) ? `CONFIG_SOURCE=${mode}` : 'CONFIG_SOURCE 的值';
    throw startup('env_invalid', `${shown} 不合法，只能是 file 或 db`);
  }
  if (mode !== 'db') return initConfig(null);
  return initConfig(await productionConfigDeps(env, gracefulExit));
}

// ---------------- 装载 ----------------

const systemCtx = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });

/** 完整性：存下来的哈希与内容对得上。手工改过已发布行（绕过触发器）时在这里拦住 */
function assertIntegrity(row: SopVersionRow): void {
  if (!row.renderedPrompt || !row.promptHash || !row.sopHash) throw startup('integrity', `已发布版本 v${row.versionNo} 缺少渲染结果或哈希`);
  if (sha256(row.renderedPrompt) !== row.promptHash)
    throw startup('integrity', `已发布版本 v${row.versionNo} 的 rendered_prompt 与 prompt_hash 对不上`);
  if (sha256(joinSop(row.sections)) !== row.sopHash)
    throw startup('integrity', `已发布版本 v${row.versionNo} 的 sections 与 sop_hash 对不上（有人改过这一行？）`);
}

function snapshotOf(tenantId: string, rows: readonly CatalogRow[], gen: number): CatalogSnapshot {
  const of = <T>(kind: CatalogRow['kind']): T[] => rows.filter((r) => r.kind === kind).map((r) => r.payload as T);
  return deepFreeze({ tenantId, generation: gen, routes: of<Route>('route'), hotels: of<Hotel>('hotel') });
}

function publishedFrom(tenantId: string, row: SopVersionRow, sections: readonly SopSection[]): PublishedSop {
  return deepFreeze({
    tenantId,
    versionId: row.id,
    versionNo: row.versionNo!,
    sections: sections.map((s) => ({ key: s.key, text: s.text })),
    renderedPrompt: row.renderedPrompt!,
    promptHash: row.promptHash!,
    toolsHash: row.toolsHash!,
    prefixHash: row.prefixHash!,
    sopHash: row.sopHash!,
  });
}

const CAUSE: Record<keyof RenderInputs, string> = {
  hardRulesHash: 'hard_rules',
  imageSopHash: 'locked_sections',
  sectionTableHash: 'section_table',
  toolsHash: 'tools',
};

/**
 * 启动重渲染的只读部分（spec「启动重渲染」第 1–6 步）：完整性、与镜像合并、渲染两遍、契约检查、判断要不要重渲染。
 * 返回 null 表示直接用存下来的行
 */
function resolvePublished(
  d: ConfigDeps,
  row: SopVersionRow,
  imageSections: readonly SopSection[],
): { merged: SopSection[]; causes: string[] } | null {
  assertIntegrity(row);
  const merged = mergeWithImage(row.sections, imageSections);
  const rendered = d.render(joinSop(merged));
  if (d.render(joinSop(merged)) !== rendered) throw startup('renderer_nondeterministic', '同一份 SOP 渲染两遍结果不同');
  const violations = checkSopContract({
    sections: merged,
    imageSections,
    rendered,
    toolNames: d.toolNames,
    knownFields: d.knownFields,
    baselineEditableChars: null,
  });
  if (violations.length) {
    throw startup(
      'contract_failed',
      `已发布版本 v${row.versionNo} 与当前代码合并后过不了契约检查：\n${violations.map((v) => `  - ${v.code}${v.sectionKey ? `@${v.sectionKey}` : ''}：${v.detail}`).join('\n')}`,
    );
  }
  const toolsHash = sha256(d.toolsJson);
  if (rendered === row.renderedPrompt && toolsHash === row.toolsHash) return null;
  const now = renderInputsFor(d.render, d.imageSop, d.toolsJson);
  const before = row.renderInputs;
  const causes = (Object.keys(CAUSE) as (keyof RenderInputs)[]).filter((k) => !before || before[k] !== now[k]).map((k) => CAUSE[k]);
  if (!causes.length) throw startup('renderer_nondeterministic', `渲染的输入与 v${row.versionNo} 发布时完全相同，结果却不同`);
  return { merged, causes };
}

/** 启动日志按节、按条目点名库与镜像 data/ 的差异：DB 模式下改 data/ 的可编辑节或产品库不会生效，要让人看得见 */
function logDrift(d: ConfigDeps, merged: readonly SopSection[], imageSections: readonly SopSection[], rows: readonly CatalogRow[]): void {
  const edited = TRAVEL_SOP_SECTIONS.filter(
    (s) => !s.locked && merged.find((x) => x.key === s.key)?.text !== imageSections.find((x) => x.key === s.key)?.text,
  );
  if (edited.length)
    console.log(`[config] 可编辑节与镜像 data/sop.md 不同（以库为准）：${edited.map((s) => s.heading ?? s.key).join('、')}`);
  const dir = d.imageDataDir ?? path.join(process.cwd(), 'data');
  for (const [kind, file] of [
    ['route', 'routes.json'],
    ['hotel', 'hotels.json'],
  ] as const) {
    let image: Record<string, unknown>[];
    try {
      image = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>[];
    } catch {
      continue;
    }
    const inDb = new Map(rows.filter((r) => r.kind === kind).map((r) => [r.code, JSON.stringify(r.payload)]));
    const inImage = new Map(image.map((x) => [String(x.id), JSON.stringify(x)]));
    const changed = [...inDb.keys()].filter((c) => inImage.has(c) && inImage.get(c) !== inDb.get(c));
    const onlyDb = [...inDb.keys()].filter((c) => !inImage.has(c));
    const onlyImage = [...inImage.keys()].filter((c) => !inDb.has(c));
    const parts = [
      changed.length ? `内容不同 ${changed.join('、')}` : '',
      onlyDb.length ? `只在库里 ${onlyDb.join('、')}` : '',
      onlyImage.length ? `只在镜像里（或库里不是 active）${onlyImage.join('、')}` : '',
    ].filter(Boolean);
    if (parts.length) console.log(`[config] ${file} 与库里的 active 条目不同（以库为准）：${parts.join('；')}`);
  }
}

/**
 * deps 为 null：文件模式，立即返回。否则依次执行，前 8 步只读：
 *   1 连库，核对 server_encoding 为 UTF8 → 2 核对迁移 → 3 按 tenantSlug 解析租户，拒绝 suspended → 4 取租户锁
 *   → 5 切分并校验 imageSop → 6 装载已发布 SOP，校验完整性，算出合并、渲染与契约结果 → 7 装载产品库快照（至少一条 active 线路）
 *   → 8 按节、按条目打印 DB 与镜像 data/ 的差异 → 9 需要时写入 rerender 版本 → 10 装上缓存。
 * 任何一步失败都以 ConfigStartupError reject，释放锁、关闭连接池，不留半装载状态
 */
export async function initConfig(d: ConfigDeps | null): Promise<void> {
  if (!d) return;
  if (loaded) throw new Error('配置源已经装载过');
  dbInstalled = true;
  let lock: TenantLock | null = null;
  try {
    // 1
    let encoding: string;
    try {
      encoding = await serverEncoding(d.db);
    } catch (e) {
      throw startup('db_unreachable', message(e));
    }
    if (encoding !== 'UTF8') throw startup('db_encoding', `server_encoding 是 ${encoding}，要求 UTF8`);
    // 2 镜像里的每条迁移都要在库里；库里多出来的（来自更新的镜像，回滚到 :prev 时就是这样）只警告
    let applied: string[];
    try {
      applied = await appliedMigrationHashes(d.db);
    } catch (e) {
      throw startup('schema_behind', `读不到迁移记录（从没跑过迁移？）：${message(e)}`);
    }
    const image = imageMigrationHashes();
    const missing = image.filter((h) => !applied.includes(h));
    if (missing.length) throw startup('schema_behind', `镜像里有 ${missing.length} 条迁移没在库里，先跑 migrate`);
    const extra = applied.filter((h) => !image.includes(h));
    if (extra.length) console.warn(`[config] 库里多出 ${extra.length} 条镜像里没有的迁移（库比镜像新），照常启动`);
    // 3
    const tenant = await findTenantBySlug(d.db, d.tenantSlug);
    if (!tenant) throw startup('tenant_not_found', `没有 slug 为「${d.tenantSlug}」的租户`);
    if (tenant.status === 'suspended') throw startup('tenant_suspended', `租户「${d.tenantSlug}」已停用`);
    // 4
    lock = await d.lock(tenant.id);
    if (!lock) throw startup('lock_held', `租户「${d.tenantSlug}」的锁在另一个进程手里：同一个库只能跑一个应用副本`);
    // 5
    let imageSections: SopSection[];
    try {
      imageSections = splitSop(d.imageSop);
    } catch (e) {
      throw startup('image_sop_invalid', `镜像里的 data/sop.md 不合格：${message(e)}`);
    }
    // 6、7 在同一个只读快照里读，SOP 与产品库是同一时刻的
    const { row, items } = await withTenant(
      d.db,
      systemCtx(tenant.id),
      async (tx) => ({ row: await readPublishedSop(tx), items: await readActiveCatalog(tx) }),
      { isolation: 'repeatable read', readOnly: true },
    );
    if (!row) throw startup('no_published_sop', `租户「${d.tenantSlug}」没有已发布的 SOP，先跑 import-config`);
    const rerender = resolvePublished(d, row, imageSections);
    if (!items.some((r) => r.kind === 'route')) throw startup('no_active_routes', `租户「${d.tenantSlug}」没有 active 的线路`);
    // 8
    const merged = rerender?.merged ?? mergeWithImage(row.sections, imageSections);
    logDrift(d, merged, imageSections, items);
    // 9 启动重渲染的写入在 01 第 7 步实现；在那之前，渲染结果与存下来的不一致就拒绝启动
    if (rerender) {
      throw startup(
        'contract_failed',
        `已发布版本 v${row.versionNo} 需要启动重渲染（${rerender.causes.join('、')} 变了），这一步还没实现：先用与发布时相同的代码版本启动`,
      );
    }
    // 10
    loaded = {
      deps: d,
      tenantId: tenant.id,
      lock,
      imageSections: deepFreeze(imageSections),
      sop: publishedFrom(tenant.id, row, merged),
      catalog: snapshotOf(tenant.id, items, 0),
    };
    lockState = 'held';
    sopStale = false;
    catalogStale = false;
    lock.onLost(onLockLost);
    const { sop } = loaded;
    console.log(
      `[config] DB 模式：租户 ${d.tenantSlug} · SOP v${sop.versionNo} · 线路 ${loaded.catalog.routes.length} 条、酒店 ${loaded.catalog.hotels.length} 家 · 前缀 ${sop.prefixHash.slice(0, 12)}`,
    );
  } catch (e) {
    dbInstalled = false;
    await lock?.release().catch(() => {});
    await d.closeDb?.().catch(() => {});
    throw e;
  }
}

// ---------------- 锁丢失 ----------------

function onLockLost(): void {
  if (shuttingDown || !loaded) return;
  lockState = 'lost';
  console.error(`[config] 租户锁连接断开：配置写入暂停，对话照常；每 ${reacquireMs / 1000} 秒重取`);
  scheduleReacquire();
}

function scheduleReacquire(): void {
  if (reacquireTimer) return;
  reacquireTimer = setTimeout(() => {
    reacquireTimer = null;
    void reacquireOnce();
  }, reacquireMs);
  reacquireTimer.unref();
}

async function reacquireOnce(): Promise<void> {
  const cur = loaded;
  if (shuttingDown || !cur) return;
  const r = await cur.lock.reacquire().catch(() => 'unreachable' as const);
  if (shuttingDown || loaded !== cur) return;
  if (r === 'ok') {
    lockState = 'held';
    console.log('[config] 租户锁已重新取得，配置写入恢复');
  } else if (r === 'held_by_other') {
    // 另一个进程已经接管：先跑全部停机钩子（在途的企微回复发完、会话落盘），再退出
    console.error('[config] 租户锁已被另一个进程拿走，本进程优雅退出');
    cur.deps.gracefulExit(1);
  } else {
    scheduleReacquire();
  }
}

// ---------------- 重读 ----------------

let reloading: Promise<void> | null = null;
let reloadAgain = false;
const RELOAD_BACKOFF_MS = [5_000, 30_000, 120_000];
let reloadBackoff = RELOAD_BACKOFF_MS;

async function reloadOnce(cur: Loaded): Promise<void> {
  const { row, items } = await withTenant(
    cur.deps.db,
    systemCtx(cur.tenantId),
    async (tx) => ({ row: await readPublishedSop(tx), items: await readActiveCatalog(tx) }),
    { isolation: 'repeatable read', readOnly: true },
  );
  if (!row) throw new Error('库里没有已发布的 SOP');
  assertIntegrity(row);
  if (loaded !== cur) return;
  if (row.versionNo !== cur.sop.versionNo) cur.sop = publishedFrom(cur.tenantId, row, mergeWithImage(row.sections, cur.imageSections));
  sopStale = false;
  const next = snapshotOf(cur.tenantId, items, cur.catalog.generation);
  if (
    JSON.stringify(next.routes) !== JSON.stringify(cur.catalog.routes) ||
    JSON.stringify(next.hotels) !== JSON.stringify(cur.catalog.hotels)
  ) {
    setCatalog(cur, { ...next, generation: ++generation });
  }
  catalogStale = false;
}

function setCatalog(cur: Loaded, snap: CatalogSnapshot): void {
  cur.catalog = deepFreeze(snap);
  for (const cb of catalogListeners) {
    try {
      cb(cur.catalog);
    } catch (e) {
      console.error('[config] onCatalogChanged 回调异常：', e);
    }
  }
}

/**
 * COMMIT 抛错、结果不明时调用：标脏，从库里整体重读 SOP 与产品库。
 * 单飞：进行中再被调用只置位，结束后再跑一遍；失败按 5 秒、30 秒、2 分钟退避重试，之后每 2 分钟一次
 */
export function reloadFromDb(): Promise<void> {
  const cur = loaded;
  if (!cur) return Promise.reject(new ConfigNotReadyError());
  sopStale = true;
  catalogStale = true;
  if (reloading) {
    reloadAgain = true;
    return reloading;
  }
  reloading = (async () => {
    do {
      reloadAgain = false;
      for (let attempt = 0; ; attempt++) {
        if (shuttingDown || loaded !== cur) return;
        try {
          await reloadOnce(cur);
          break;
        } catch (e) {
          const wait = reloadBackoff[Math.min(attempt, reloadBackoff.length - 1)]!;
          console.error(`[config] 从库里重读配置失败，${wait / 1000} 秒后重试：${message(e)}`);
          await new Promise((r) => setTimeout(r, wait).unref());
        }
      }
    } while (reloadAgain);
  })().finally(() => {
    reloading = null;
  });
  return reloading;
}

// ---------------- 停机 ----------------

/** onShutdown 的普通阶段调：此后忽略锁连接的一切事件 */
export function markConfigShuttingDown(): void {
  shuttingDown = true;
  if (reacquireTimer) clearTimeout(reacquireTimer);
  reacquireTimer = null;
}

/** onShutdown 的 late 阶段调：其他停机钩子都结束之后，释放锁、关连接池 */
export async function closeConfig(): Promise<void> {
  const cur = loaded;
  if (!cur) return;
  await cur.lock.release().catch(() => {});
  await cur.deps.closeDb?.().catch(() => {});
}

/** 仅供自测：卸下配置源、清空缓存，回到文件模式 */
export const __configTest = {
  reset(): void {
    if (reacquireTimer) clearTimeout(reacquireTimer);
    reacquireTimer = null;
    dbInstalled = false;
    loaded = null;
    lockState = 'held';
    sopStale = false;
    catalogStale = false;
    shuttingDown = false;
    reloading = null;
    reloadAgain = false;
    reacquireMs = 5_000;
    reloadBackoff = RELOAD_BACKOFF_MS;
    catalogListeners.length = 0;
  },
  /** 锁重取间隔与重读退避调短，测试不用真等几秒 */
  setTimings(t: { reacquireMs?: number; reloadBackoffMs?: number[] }): void {
    if (t.reacquireMs !== undefined) reacquireMs = t.reacquireMs;
    if (t.reloadBackoffMs) reloadBackoff = t.reloadBackoffMs;
  },
};

/** 文件模式与 DB 模式共用的哈希摘要，给 /healthz 用：DB 模式取缓存，文件模式按当前文件现算 */
export function prefixSummary(file: () => { system: string; tools: string; sop: string }): {
  sopVersion: number | null;
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
} {
  if (loaded) {
    const s = loaded.sop;
    return { sopVersion: s.versionNo, promptHash: s.promptHash, toolsHash: s.toolsHash, prefixHash: s.prefixHash, sopHash: s.sopHash };
  }
  const f = file();
  return { sopVersion: null, ...promptHashes(f.system, f.tools, f.sop) };
}
