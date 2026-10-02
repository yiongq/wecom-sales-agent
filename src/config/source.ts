// 配置源（docs/architecture/01-pg-config-console/spec.md「两种模式与启动装载」）。
// 文件模式（CONFIG_SOURCE 未设、空串或 file）什么都不做，引擎和工具照旧读 data/。
// DB 模式在启动时一次装载已发布的 SOP 与 active 条目，放进进程内缓存；每轮对话只读缓存、不查库。
// 本模块不 import store / tools / engine：它们反过来 import 这里，快照变化经 onCatalogChanged 回调通知。
// 02 加了产品库条目版本（02 spec「报价快照与产品库字段开放」）：全部版本启动时读进内存，之后的新版本提交后加进来；
// 一轮对话之内 currentCatalog() 返回这一轮开始时的那一代快照（pinCatalogForTurn）。
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import {
  holdTenantLock,
  lockTenantConfig,
  openDb,
  redactUrl,
  serverEncoding,
  withTenant,
  type Db,
  type TenantCtx,
  type TenantLock,
} from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { appliedMigrationHashes, imageMigrationHashes } from '../db/migrate.js';
import { readActiveCatalog, setItemVersion, type CatalogRow } from '../db/repo/catalog.js';
import { insertCatalogVersion, readCatalogVersions, type CatalogVersionRow } from '../db/repo/catalog-versions.js';
import { archivePublished, insertPublishedSop, maxVersionNo, readPublishedSop, type SopVersionRow } from '../db/repo/sop.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import type { RenderInputs } from '../db/schema.js';
import { packById } from '../packs/registry.js';
import { renderSystemPrompt } from '../prompt/system.js';
import type { Hotel, Route } from '../shared/catalog-types.js';
import type { ConfigDrift } from '../shared/console-api.js';
import { deepFreeze } from '../shared/freeze.js';
import type { IndustryPack } from '../shared/pack.js';
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
  /** ISO 8601；匿名只读页要显示，放进缓存免得查库 */
  publishedAt: string;
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
  /**
   * 每个 active 条目当前的版本（02「报价快照」），键是 catalogVersionKey（'route:r-guizhou'）。与 routes、hotels 是同一代：
   * 一轮之内工具拿到的报价与链接上的 ?v= 出自同一份。文件模式没有快照，条目一律当版本 1
   */
  versions: Readonly<Record<string, number>>;
}

/** 条目版本的键：与 turn_traces.catalog_versions 同一个写法（02 spec「逐轮 trace」） */
export const catalogVersionKey = (kind: CatalogRow['kind'], code: string): string => `${kind}:${code}`;

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
  | 'pack_unknown'
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

/** 第 1 步之后再访问库（解析租户、取锁、读快照、写 rerender）：库断开、锁连接连不上也以 ConfigStartupError 报出，boot 才点得出原因 */
async function dbStep<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConfigStartupError) throw e;
    throw startup('db_unreachable', `${what}：${message(e)}`);
  }
}

// ---------------- 状态 ----------------

interface Loaded {
  deps: ConfigDeps;
  tenantId: string;
  /** 启动时装载的租户行里的名称与行业包：/me 的 tenantName、/pack 用，不查库 */
  tenantName: string;
  pack: IndustryPack;
  lock: TenantLock;
  imageSections: readonly SopSection[];
  sop: PublishedSop;
  catalog: CatalogSnapshot;
  /** 快照数组本身不带 ord：另存一份 code → ord，applyCatalogRow 按它插到正确位置 */
  ords: Record<CatalogRow['kind'], Map<string, number>>;
  /** 全部条目的全部版本（catalogVersionKey → 版本号 → deep-frozen 的 payload）：方案书按 ?v= 渲染时只读这里，不查库 */
  history: VersionHistory;
}
type VersionHistory = Map<string, Map<number, unknown>>;

/** 版本行建成内存里的历史：只追加，同一个版本号只认第一次见到的那份 */
function historyOf(rows: readonly Pick<CatalogVersionRow, 'kind' | 'code' | 'version' | 'payload'>[]): VersionHistory {
  const h: VersionHistory = new Map();
  for (const r of rows) addVersion(h, r.kind, r.code, r.version, r.payload);
  return h;
}
function addVersion(h: VersionHistory, kind: CatalogRow['kind'], code: string, version: number, payload: unknown): void {
  const key = catalogVersionKey(kind, code);
  let m = h.get(key);
  if (!m) h.set(key, (m = new Map()));
  if (!m.has(version)) m.set(version, deepFreeze(structuredClone(payload)));
}
const latestOf = (h: VersionHistory, key: string): number => Math.max(0, ...(h.get(key)?.keys() ?? []));

const ordsOf = (rows: readonly CatalogRow[]): Loaded['ords'] => ({
  route: new Map(rows.filter((r) => r.kind === 'route').map((r) => [r.code, r.ord])),
  hotel: new Map(rows.filter((r) => r.kind === 'hotel').map((r) => [r.code, r.ord])),
});

/** initConfig 收到非空 deps 之后就是 DB 模式，装载失败时撤回 */
let dbInstalled = false;
let loaded: Loaded | null = null;
let lockState: 'held' | 'lost' = 'held';
/** 重取时发现锁已在另一个进程手里（held_by_other）：此后本进程不该再写会话（02 spec「identity map 与写入 · 停机」） */
let lockTaken = false;
let sopStale = false;
let catalogStale = false;
let shuttingDown = false;
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
  const pinned = turnPin.getStore();
  return pinned && pinned.tenantId === loaded.tenantId ? pinned : loaded.catalog;
}

/** 一轮之内固定的产品库快照（01 裁决 R6 推迟到 02 的那条、02 R14）。只经 pinCatalogForTurn 设置 */
const turnPin = new AsyncLocalStorage<CatalogSnapshot>();

/**
 * 记下开始时的 CatalogSnapshot，fn 之内（含它起的异步续体）currentCatalog() 都返回它：一轮里工具结果、链接上的 ?v= 与护栏
 * 看到的是同一代快照，中途有人改价也不混用（不变量 36）。文件模式（或还没装载完）什么都不做
 */
export function pinCatalogForTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (!loaded) return fn();
  return turnPin.run(loaded.catalog, fn);
}

/**
 * 条目某个版本的 payload（deep-frozen），只读内存（匿名的方案书路由用，不查库，不变量 35）。版本只追加、旧版本永远在，
 * 所以不看本轮固定的快照。文件模式、没有这条或没有这个版本时返回 null
 */
export function catalogItemAt(kind: CatalogRow['kind'], code: string, version: number): unknown {
  return loaded?.history.get(catalogVersionKey(kind, code))?.get(version) ?? null;
}

/** 有条目版本大于 1（改过 active 条目的内容）：/healthz 的 config.catalogVersioned，回滚到 02 之前的镜像据此拒绝。文件模式恒为 false */
export function catalogVersioned(): boolean {
  if (!loaded) return false;
  return Object.values(loaded.catalog.versions).some((v) => v > 1);
}

/** 产品库快照变化后回调；retrieval.ts 在加载时注册，用来失效并重建索引 */
export function onCatalogChanged(cb: (snap: CatalogSnapshot) => void): void {
  catalogListeners.push(cb);
}

/** 租户锁已被另一个进程拿走（重取得到 held_by_other）。PG 会话存储的 drain 段据此不写库、直接 spill */
export function tenantLockTaken(): boolean {
  return lockTaken;
}

export function configHealth(): ConfigHealth {
  return { lock: lockState, sopStale, catalogStale };
}

/** 当前缓存与镜像 data/ 的差异，给后台 /status：每次现算，发布和上架之后跟着变 */
export function configDrift(): ConfigDrift {
  if (!loaded) throw new ConfigNotReadyError();
  const { catalog } = loaded;
  const active = [
    ...catalog.routes.map((p) => ({ kind: 'route' as const, code: p.id, payload: p })),
    ...catalog.hotels.map((p) => ({ kind: 'hotel' as const, code: p.id, payload: p })),
  ];
  return driftOf(imageDirOf(loaded.deps), loaded.sop.sections, loaded.imageSections, active);
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

/** 只回显看起来像个取值的短词：配错位置的整行环境变量里可能带着连接串口令 */
const shownValue = (name: string, v: string): string => (/^[a-z]{1,16}$/i.test(v) ? `${name}=${v}` : `${name} 的值`);

/**
 * 生产入口：先校验 CONFIG_SOURCE 与 SESSION_STORE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式。
 * SESSION_STORE（02 spec R1）：未设、空串、file 是文件存储，db 是 PG 会话存储且要求 CONFIG_SOURCE=db，绝不回落
 */
export async function initConfigFromEnv(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<void> {
  const mode = env.CONFIG_SOURCE ?? '';
  if (mode !== '' && mode !== 'file' && mode !== 'db') {
    throw startup('env_invalid', `${shownValue('CONFIG_SOURCE', mode)} 不合法，只能是 file 或 db`);
  }
  const store = env.SESSION_STORE ?? '';
  if (store !== '' && store !== 'file' && store !== 'db') {
    throw startup('env_invalid', `${shownValue('SESSION_STORE', store)} 不合法，只能是 file 或 db`);
  }
  if (store === 'db' && mode !== 'db') {
    throw startup('env_invalid', 'SESSION_STORE=db 要求 CONFIG_SOURCE=db（会话存储不会回落到文件）');
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

function snapshotOf(tenantId: string, rows: readonly CatalogRow[], gen: number, history: VersionHistory): CatalogSnapshot {
  const of = <T>(kind: CatalogRow['kind']): T[] => rows.filter((r) => r.kind === kind).map((r) => r.payload as T);
  const versions: Record<string, number> = {};
  for (const r of rows) {
    const key = catalogVersionKey(r.kind, r.code);
    const v = latestOf(history, key);
    if (v > 0) versions[key] = v;
  }
  return deepFreeze({ tenantId, generation: gen, routes: of<Route>('route'), hotels: of<Hotel>('hotel'), versions });
}

type VersionWrite = { kind: CatalogRow['kind']; code: string; version: number; payload: Record<string, unknown> };

/**
 * 启动补写（02 spec「报价快照」）要写的：没有任何版本行的 active 条目（回滚到 01 镜像期间上架的）以当前 payload 写版本 1；
 * 最新版本的 payload 与条目不同的（01 镜像期间改过）写下一个版本；catalog_items.version 与最终的最新版本对不上的对齐
 */
function backfillPlan(
  items: readonly CatalogRow[],
  versions: readonly CatalogVersionRow[],
): { writes: VersionWrite[]; align: CatalogRow[] } {
  const history = historyOf(versions);
  const writes: VersionWrite[] = [];
  const align: CatalogRow[] = [];
  for (const it of items) {
    const key = catalogVersionKey(it.kind, it.code);
    const latest = latestOf(history, key);
    let final = latest;
    if (latest === 0 || JSON.stringify(history.get(key)!.get(latest)) !== JSON.stringify(it.payload)) {
      final = latest + 1;
      writes.push({ kind: it.kind, code: it.code, version: final, payload: it.payload });
    }
    if (it.version !== final) align.push({ ...it, version: final });
  }
  return { writes, align };
}

/** 启动补写的写入：一个事务，取配置写锁；每个新版本记 source='backfill' 与一行 catalog.version 审计 */
async function writeBackfill(d: ConfigDeps, tenantId: string, plan: ReturnType<typeof backfillPlan>): Promise<void> {
  await withTenant(d.db, systemCtx(tenantId), async (tx) => {
    await lockTenantConfig(tx);
    for (const w of plan.writes) {
      await insertCatalogVersion(tx, { ...w, source: 'backfill', createdByName: 'system' });
      await writeAudit(tx, {
        action: 'catalog.version',
        targetType: w.kind,
        targetId: w.code,
        diff: { version: w.version, source: 'backfill' },
      });
    }
    for (const a of plan.align) await setItemVersion(tx, a.kind, a.code, a.version);
  });
  if (plan.writes.length) {
    console.log(`[config] 条目版本启动补写：${plan.writes.map((w) => `${catalogVersionKey(w.kind, w.code)} v${w.version}`).join('、')}`);
  }
}

/** 从库里的一行构造缓存用的 PublishedSop：sections 用与镜像合并之后的全部节 */
export function toPublishedSop(tenantId: string, row: SopVersionRow, sections: readonly SopSection[]): PublishedSop {
  return deepFreeze({
    tenantId,
    versionId: row.id,
    versionNo: row.versionNo!,
    publishedAt: row.publishedAt!.toISOString(),
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
): { merged: SopSection[]; rendered: string; causes: string[] } | null {
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
  return { merged, rendered, causes };
}

/**
 * 库与镜像 data/ 的差异（以库为准）：可编辑节按节，产品库按条目。active 是库里的 active 条目；
 * 镜像文件读不到或解析不了时，那一类不报差异
 */
function driftOf(
  dir: string,
  merged: readonly SopSection[],
  imageSections: readonly SopSection[],
  active: readonly { kind: CatalogRow['kind']; code: string; payload: unknown }[],
): ConfigDrift {
  const editedSections = TRAVEL_SOP_SECTIONS.filter(
    (s) => !s.locked && merged.find((x) => x.key === s.key)?.text !== imageSections.find((x) => x.key === s.key)?.text,
  ).map((s) => s.key);
  const catalog: ConfigDrift['catalog'] = {
    route: { changed: [], onlyDb: [], onlyImage: [] },
    hotel: { changed: [], onlyDb: [], onlyImage: [] },
  };
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
    const inDb = new Map(active.filter((r) => r.kind === kind).map((r) => [r.code, JSON.stringify(r.payload)]));
    const inImage = new Map(image.map((x) => [String(x.id), JSON.stringify(x)]));
    catalog[kind] = {
      changed: [...inDb.keys()].filter((c) => inImage.has(c) && inImage.get(c) !== inDb.get(c)),
      onlyDb: [...inDb.keys()].filter((c) => !inImage.has(c)),
      onlyImage: [...inImage.keys()].filter((c) => !inDb.has(c)),
    };
  }
  return { editedSections, catalog };
}

const imageDirOf = (d: ConfigDeps): string => d.imageDataDir ?? path.join(process.cwd(), 'data');

/** 启动日志按节、按条目点名库与镜像 data/ 的差异：DB 模式下改 data/ 的可编辑节或产品库不会生效，要让人看得见 */
function logDrift(d: ConfigDeps, merged: readonly SopSection[], imageSections: readonly SopSection[], rows: readonly CatalogRow[]): void {
  const drift = driftOf(imageDirOf(d), merged, imageSections, rows);
  const headings = drift.editedSections.map((k) => TRAVEL_SOP_SECTIONS.find((s) => s.key === k)?.heading ?? k);
  if (headings.length) console.log(`[config] 可编辑节与镜像 data/sop.md 不同（以库为准）：${headings.join('、')}`);
  for (const [kind, file] of [
    ['route', 'routes.json'],
    ['hotel', 'hotels.json'],
  ] as const) {
    const { changed, onlyDb, onlyImage } = drift.catalog[kind];
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
 *   1 连库，核对 server_encoding 为 UTF8 → 2 核对迁移 → 3 按 tenantSlug 解析租户，拒绝 suspended 和注册表里没有的行业包 → 4 取租户锁
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
    const tenant = await dbStep('解析租户', () => findTenantBySlug(d.db, d.tenantSlug));
    if (!tenant) throw startup('tenant_not_found', `没有 slug 为「${d.tenantSlug}」的租户`);
    if (tenant.status === 'suspended') throw startup('tenant_suspended', `租户「${d.tenantSlug}」已停用`);
    // 后台 UX spec「接口改动 · /pack」：包不在注册表里时拒绝启动（tenant-create 已按注册表校验，这里防手改库）
    const pack = packById(tenant.packId);
    if (!pack) throw startup('pack_unknown', `租户「${d.tenantSlug}」的行业包「${tenant.packId}」不在注册表里`);
    // 4
    const held = await dbStep('取租户锁', () => d.lock(tenant.id));
    lock = held;
    if (!held) throw startup('lock_held', `租户「${d.tenantSlug}」的锁在另一个进程手里：同一个库只能跑一个应用副本`);
    // 取到锁就订阅断开：锁连接在装载途中断了，装上缓存时直接进入 lost 并开始重取，而不是一直以为持着锁
    let lostWhileLoading = false;
    held.onLost(() => {
      if (!loaded) lostWhileLoading = true;
      else if (loaded.lock === held) onLockLost();
    });
    // 5
    let imageSections: SopSection[];
    try {
      imageSections = splitSop(d.imageSop);
    } catch (e) {
      throw startup('image_sop_invalid', `镜像里的 data/sop.md 不合格：${message(e)}`);
    }
    // 6、7 在同一个只读快照里读，SOP、产品库与条目版本是同一时刻的
    const { row, items, versions } = await dbStep('读已发布 SOP 与产品库', () =>
      withTenant(
        d.db,
        systemCtx(tenant.id),
        async (tx) => ({ row: await readPublishedSop(tx), items: await readActiveCatalog(tx), versions: await readCatalogVersions(tx) }),
        { isolation: 'repeatable read', readOnly: true },
      ),
    );
    if (!row) throw startup('no_published_sop', `租户「${d.tenantSlug}」没有已发布的 SOP，先跑 import-config`);
    const rerender = resolvePublished(d, row, imageSections);
    if (!items.some((r) => r.kind === 'route')) throw startup('no_active_routes', `租户「${d.tenantSlug}」没有 active 的线路`);
    // 8
    const merged = rerender?.merged ?? mergeWithImage(row.sections, imageSections);
    logDrift(d, merged, imageSections, items);
    // 9 以上全部通过之后才写：一个事务里归档旧版本、发布一个 source='rerender' 的新版本，运营编辑过的可编辑节原样保留
    const current = rerender ? await dbStep('写入 rerender 版本', () => writeRerender(d, tenant.id, row, rerender)) : row;
    // 9（02）条目版本的启动补写，两种会话存储都做；补写的版本随后与读到的一起进内存
    const plan = backfillPlan(items, versions);
    if (plan.writes.length || plan.align.length) await dbStep('补写条目版本', () => writeBackfill(d, tenant.id, plan));
    const history = historyOf([...versions, ...plan.writes]);
    // 10
    loaded = {
      deps: d,
      tenantId: tenant.id,
      tenantName: tenant.name,
      pack,
      lock: held,
      imageSections: deepFreeze(imageSections),
      sop: toPublishedSop(tenant.id, current, merged),
      catalog: snapshotOf(tenant.id, items, 0, history),
      ords: ordsOf(items),
      history,
    };
    lockState = 'held';
    sopStale = false;
    catalogStale = false;
    // 缓存照常装上（对话要用），配置写入暂停、开始重取
    if (lostWhileLoading) onLockLost();
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

/**
 * 启动重渲染的写入（spec「启动重渲染」第 8 步）：硬性要求、锁定节、节表或工具定义变了，system 的字节跟着变，
 * 存下来的版本就对不上当前代码了。一次失败的部署最多留下两个 rerender 版本（新镜像一个、回滚到 :prev 再一个反向的）
 */
async function writeRerender(
  d: ConfigDeps,
  tenantId: string,
  row: SopVersionRow,
  r: { merged: SopSection[]; rendered: string; causes: string[] },
): Promise<SopVersionRow> {
  const hashes = promptHashes(r.rendered, d.toolsJson, joinSop(r.merged));
  const next = await withTenant(d.db, systemCtx(tenantId), async (tx) => {
    await lockTenantConfig(tx);
    await archivePublished(tx, row.id);
    const v = await insertPublishedSop(tx, {
      tenantId,
      versionNo: (await maxVersionNo(tx)) + 1,
      source: 'rerender',
      packId: row.packId,
      sections: r.merged,
      basedOn: row.id,
      renderedPrompt: r.rendered,
      ...hashes,
      renderInputs: renderInputsFor(d.render, d.imageSop, d.toolsJson),
      changeNote: `启动重渲染：${r.causes.join('、')} 变了`,
      createdBy: null,
      createdByName: 'system',
    });
    await writeAudit(tx, {
      action: 'sop.rerender',
      targetType: 'sop_version',
      targetId: v.id,
      diff: {
        causes: r.causes,
        fromVersionNo: row.versionNo,
        toVersionNo: v.versionNo,
        oldPromptHash: row.promptHash,
        newPromptHash: v.promptHash,
      },
    });
    return v;
  });
  console.log(`[config] 启动重渲染：v${row.versionNo} → v${next.versionNo}（${r.causes.join('、')} 变了）`);
  return next;
}

/** 启动时装载的租户名称与行业包（后台 UX spec「接口改动」）：/me 的 tenantName 与 GET /pack 用，不查库 */
export function currentTenant(): { name: string; pack: IndustryPack } {
  if (!loaded) throw new ConfigNotReadyError();
  return { name: loaded.tenantName, pack: loaded.pack };
}

// ---------------- 给编辑流程用 ----------------

/** 只给 src/config/sop.ts、catalog.ts 用，以及 boot 给 db 会话存储拼依赖：装载时的库、租户、依赖与镜像节 */
export function configRuntime(): { db: Db; tenantId: string; deps: ConfigDeps; imageSections: readonly SopSection[] } {
  if (!loaded) throw new ConfigNotReadyError();
  return { db: loaded.deps.db, tenantId: loaded.tenantId, deps: loaded.deps, imageSections: loaded.imageSections };
}

/**
 * 提交之后换产品库快照的次数（applyCatalogRow 真的换了才加 1）。重读据此认出自己读到的产品库可能已经过时。
 * SOP 不用计数：版本号只增不减，重读读到的旧版本号不会换上去
 */
let catalogWrites = 0;

/** 只给 src/config/{sop,catalog}.ts 在事务提交之后调用；next.versionNo 不大于当前值时忽略 */
export function replacePublishedSop(next: PublishedSop): void {
  if (!loaded || next.versionNo <= loaded.sop.versionNo) return;
  loaded.sop = next;
  sopStale = false;
}

/**
 * 只给 src/config/catalog.ts 在事务提交之后调用：用 RETURNING 拿回的行在内存里更新快照——替换同 code 的条目，
 * 或按 ord 插入新上架的条目；generation 加 1。单副本、单写者，结果是确定的，不从库里重读。draft 行不进快照。
 * 行上的 version 是这次写下的（或没变的）条目版本：它的 payload 就是这一行的 payload，没见过就加进版本历史（02「报价快照」）
 */
export function applyCatalogRow(row: {
  kind: CatalogRow['kind'];
  code: string;
  ord: number;
  status: 'draft' | 'active';
  version: number;
  payload: unknown;
}): void {
  const cur = loaded;
  if (!cur || row.status !== 'active') return;
  catalogWrites++;
  addVersion(cur.history, row.kind, row.code, row.version, row.payload);
  const versions = { ...cur.catalog.versions, [catalogVersionKey(row.kind, row.code)]: row.version };
  const key = row.kind === 'route' ? 'routes' : 'hotels';
  const ords = cur.ords[row.kind];
  const idOf = (x: unknown): string => String((x as { id: unknown }).id);
  const items: { ord: number; payload: unknown }[] = (cur.catalog[key] as readonly unknown[])
    .filter((x) => idOf(x) !== row.code)
    .map((x) => ({ ord: ords.get(idOf(x)) ?? Number.MAX_SAFE_INTEGER, payload: x }));
  items.push({ ord: row.ord, payload: structuredClone(row.payload) });
  ords.set(row.code, row.ord);
  const list = items.toSorted((a, b) => a.ord - b.ord).map((x) => x.payload);
  setCatalog(cur, { ...cur.catalog, [key]: list, versions, generation: cur.catalog.generation + 1 });
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
    lockTaken = true;
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

/**
 * 读一次库、换上缓存。返回 false 表示没换：读的途中有产品库写入提交并换了快照，这份快照可能早于那次写入，
 * 整体换上去会把那次修改冲掉（spec 否决的「提交后重读」就是这个竞态），要重读。SOP 由版本号只增不减兜住
 */
async function reloadOnce(cur: Loaded): Promise<boolean> {
  const writesBefore = catalogWrites;
  const { row, items, versions } = await withTenant(
    cur.deps.db,
    systemCtx(cur.tenantId),
    async (tx) => ({ row: await readPublishedSop(tx), items: await readActiveCatalog(tx), versions: await readCatalogVersions(tx) }),
    { isolation: 'repeatable read', readOnly: true },
  );
  if (!row) throw new Error('库里没有已发布的 SOP');
  assertIntegrity(row);
  if (loaded !== cur) return true;
  if (catalogWrites !== writesBefore) return false;
  // 版本号只增不减（不变式 13）
  if (row.versionNo! > cur.sop.versionNo) cur.sop = toPublishedSop(cur.tenantId, row, mergeWithImage(row.sections, cur.imageSections));
  sopStale = false;
  // 版本只追加：库里读到的并进内存里已有的（内存里有、库里没有的不会出现：只有提交之后才加进内存）
  for (const v of versions) addVersion(cur.history, v.kind, v.code, v.version, v.payload);
  const next = snapshotOf(cur.tenantId, items, cur.catalog.generation, cur.history);
  cur.ords = ordsOf(items);
  if (
    JSON.stringify(next.routes) !== JSON.stringify(cur.catalog.routes) ||
    JSON.stringify(next.hotels) !== JSON.stringify(cur.catalog.hotels) ||
    JSON.stringify(next.versions) !== JSON.stringify(cur.catalog.versions)
  ) {
    setCatalog(cur, { ...next, generation: cur.catalog.generation + 1 });
  }
  catalogStale = false;
  return true;
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
          // 读的途中产品库快照被写入换过：这份快照作废，立即再读一遍（不算失败，不退避）
          if (!(await reloadOnce(cur))) reloadAgain = true;
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
    lockTaken = false;
    sopStale = false;
    catalogStale = false;
    shuttingDown = false;
    reloading = null;
    reloadAgain = false;
    reacquireMs = 5_000;
    reloadBackoff = RELOAD_BACKOFF_MS;
    // 不清 catalogListeners：它们是各模块加载时登记的（retrieval.ts），模块不会再加载一次
  },
  /**
   * 换掉装载好的行业包，返回原来那份：后台接口按另一个包（家装假包）判定会话状态时用。
   * 假包不进注册表（不变量 25），租户行里写它的 pack_id 启动不了，只能这样换
   */
  swapPack(pack: IndustryPack): IndustryPack {
    if (!loaded) throw new ConfigNotReadyError();
    const prev = loaded.pack;
    loaded.pack = pack;
    return prev;
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
