import { installPublicHost, validatePublicHosts } from '../tenancy/hosts.js';
import {
  currentRuntime,
  scopedRuntime,
  hostRuntime,
  identifyRuntime,
  withTenantScope,
  withoutTenantScope,
  tenantCallback,
  tenantRuntimes,
  configureTenancy,
  createTenantRuntime,
  registerRuntime,
} from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { createTenantConfig, type Loaded, type TenantConfig } from './state.js';
// 配置源（docs/architecture/01-pg-config-console/spec.md「两种模式与启动装载」）。
// 文件模式（CONFIG_SOURCE 未设、空串或 file）读有效 SOP_PATH 同目录品牌，引擎和工具照旧读文件。
// 08 R11：同目录有 pack.json（{ "id": "<包>" }）就按这个包装载，非旅游包的产品库读 catalog/<kind>.json；没有就是旅游，与以前相同。
// DB 模式在启动时一次装载已发布的 SOP 与 active 条目，放进进程内缓存；每轮对话只读缓存、不查库。
// 本模块不加载存储与发送能力：启动时按 pack_id 绑定包，运行时能力经延后调用的函数注入。
// 02 加了产品库条目版本（02 spec「报价快照与产品库字段开放」）：全部版本启动时读进内存，之后的新版本提交后加进来；
// 一轮对话之内 currentCatalog() 返回这一轮开始时的那一代快照（pinCatalogForTurn）。
import { HANDOFF_REASON } from '../handoff/reasons.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import {
  holdTenantLock,
  holdTenantLocks,
  lockTenantConfig,
  openDb,
  redactUrl,
  serverEncoding,
  withTenant,
  type Db,
  type TenantCtx,
  type TenantLock,
} from '../db/client.js';
import { abandonGates } from '../db/repo/gate.js';
import { writeAudit } from '../db/repo/audit.js';
import { appliedMigrationHashes, imageMigrationHashes } from '../db/migrate.js';
import { readActiveCatalog, type CatalogRow } from '../db/repo/catalog.js';
import { insertCatalogVersion, readCatalogVersions, type CatalogVersionRow } from '../db/repo/catalog-versions.js';
import { archivePublished, insertPublishedSop, maxVersionNo, readPublishedSop, type SopVersionRow } from '../db/repo/sop.js';
import { findTenantBySlug, readBrand, standardTenants } from '../db/repo/tenants.js';
import type { RenderInputs } from '../db/schema.js';
import { setLogTenant } from '../log.js';
import { packById, runtimeById, legacyTravelRuntime as travelRuntime } from '../packs/registry.js';
import { renderSystemPrompt } from '../core/prompt.js';
import { embedEndpointAllowed, embedEndpointHost } from '../core/llm/endpoints.js';
import { packPipelines } from '../core/engine/pipelines.js';
import {
  bindPack,
  boundPack,
  BrandProfileSchema,
  type CatalogKindSpec,
  type PackBinding,
  type PackRuntime,
  type PackSources,
  type BrandProfile,
} from '../core/pack-api.js';
import type { Hotel, Route } from '../shared/catalog-types.js';
import type { ConfigDrift } from '../shared/console-api.js';
import { deepFreeze } from '../shared/freeze.js';
import type { IndustryPack } from '../shared/pack.js';
import { checkSopContract } from '../sop/contract.js';
import { decodeSopFile, joinSop, mergeWithImage, splitSop, type SectionSpec, type SopSection } from '../sop/sections.js';
import { contractInputs, readImageSop, tenantImage, tenantRenderer, switchPreamble, preambleWarning } from './brand.js';
import { readPackFile } from './pack-file.js';
import { readFilePolicy } from './file-policy.js';
import { promptHashes, renderInputsFor, sha256, publishedBrand, policySnapshot, publishedPolicy } from './hashes.js';

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
  /** 04 R6：来自 render_inputs，绝不从 tenants.brand 现读。 */
  brand: BrandProfile | null;
  brandHash: string;
  policy: unknown;
  policyHash: string;
}

export interface CatalogSnapshot {
  tenantId: string;
  /** 进程内单调递增，每次快照变化加 1。检索索引据此丢弃过期的构建结果；文件模式恒为 0 */
  generation: number;
  /** 只含 active 条目，各自按 ord 升序，deep-frozen */
  items: Readonly<Record<string, readonly unknown[]>>;
  /** 旅游兼容别名，直接引用 items 里的数组；缺少对应 kind 时为空数组 */
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
  /** 生产组合根按实际 pack_id 的定义渲染；自测显式注入的渲染依赖照旧。 */
  usePackRuntime?: boolean;
  brand?: BrandProfile | null;
  runtime?: PackBinding['runtime'];
  db: Db;
  tenantSlug: string;
  /** null = 锁在别人手里 */
  lock(tenantId: string): Promise<TenantLock | null>;
  /**
   * 旅游租户的镜像 SOP 全文（data/sop.md），装载时用一次，之后的发布、回滚、导出都用这一份。生产组合根在连库之前读并校验它
   * （读不到是 image_sop_invalid）。非旅游包不用它：解析出租户的包之后读 data/packs/<id>/sop.md（08 R10）。
   */
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
  constructor(detail = 'DB 模式的配置源还没装载完成') {
    super(detail);
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
  | 'tenant_host_missing'
  | 'tenant_not_found'
  | 'pack_unknown'
  | 'lock_held'
  | 'image_sop_invalid'
  | 'no_published_sop'
  | 'integrity'
  | 'renderer_nondeterministic'
  | 'contract_failed'
  | 'no_active_routes'
  | 'catalog_startup'
  | 'embed_endpoint_forbidden'
  | 'gate_unavailable'
  // owner 2026-10-24 定（plan Open 1）：非旅游包只支持模板模式，租户没有品牌时用它拒绝启动。
  | 'brand_required';
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

/** 装载中 d.runtime 一定已按租户的包绑好（loadConfig 先于一切检查）；类型上可选，是因为自测直接造 ConfigDeps */
export function runtimeOf(d: Pick<ConfigDeps, 'runtime'>): PackRuntime {
  if (!d.runtime) throw new Error('行业包运行时尚未绑定');
  return d.runtime;
}

/**
 * 08 R10：租户的镜像文本，解析出租户的包之后才取。旅游就是 deps.imageSop（生产组合根在连库之前读好的 data/sop.md，自测可注入）；
 * 其他包读 data/packs/<id>/sop.md，永远不用旅游的文本。读不到或编码不合格是 image_sop_invalid。
 */
export function imageSopOf(d: Pick<ConfigDeps, 'imageSop'>, packId: string): string {
  if (packId === 'travel') return d.imageSop;
  try {
    return readImageSop(packId);
  } catch (e) {
    throw startup('image_sop_invalid', `读不到行业包 ${packId} 的镜像 SOP：${message(e)}`);
  }
}

/**
 * owner 2026-10-24 定（plan Open 1）：非旅游包只支持模板模式（08 R10），没有品牌就不能启动，也不能写出已发布的 SOP。
 * 启动、沙箱模板复制、首次导入都经这一处，原因都是 brand_required；owner 选别的写法时只改这里。
 * subject 点名是谁缺品牌（租户或沙箱模板），进错误文案。
 */
export function assertBrandForPack(runtime: Pick<PackRuntime, 'id'>, brand: BrandProfile | null, subject: string): void {
  if (runtime.id !== 'travel' && brand === null)
    throw startup('brand_required', `${subject}的行业包「${runtime.id}」只支持模板模式，要先设置品牌档案`);
}

// ---------------- 状态 ----------------

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
/**
 * 条目的当前版本：行上的 version 与版本历史里最大的那个取大。启动补写不改 catalog_items.version（改了触发器会把「更新于」
 * 写成启动时刻），补写出的新版本只在历史里，这一列落后；之后的写入照旧按 max(version) + 1 取号、同一条 UPDATE 里改这一列
 */
const currentVersionOf = (row: { kind: CatalogRow['kind']; code: string; version: number }, h: VersionHistory): number =>
  Math.max(row.version, latestOf(h, catalogVersionKey(row.kind, row.code)));

function ordsOf(rows: readonly CatalogRow[]): Loaded['ords'] {
  return Object.fromEntries(
    [...new Set(rows.map((r) => r.kind))].map((kind) => [kind, new Map(rows.filter((r) => r.kind === kind).map((r) => [r.code, r.ord]))]),
  );
}

function configState(): TenantConfig {
  return currentRuntime().config;
}
const catalogSubscriptions: ((snap: CatalogSnapshot) => void)[] = [];
/** 装过 DB 配置源（initConfig 收到非空 deps），或 CONFIG_SOURCE === 'db'，就是 'db'；否则 'file' */
export function configMode(): ConfigMode {
  const state = configState();
  return state.dbInstalled || process.env.CONFIG_SOURCE === 'db' ? 'db' : 'file';
}

/** db 模式且装载完成后才能调用，否则抛 ConfigNotReadyError */
export function currentSop(): PublishedSop {
  const state = configState();
  if (!state.loaded) throw new ConfigNotReadyError();
  return state.loaded.sop;
}
export function currentCatalog(): CatalogSnapshot {
  const state = configState();
  if (!state.loaded) return fileCatalog(state);
  const pinned = turnPin.getStore();
  return pinned && pinned.tenantId === state.loaded.tenantId ? pinned : state.loaded.catalog;
}

/** 一轮之内固定的产品库快照（01 裁决 R6 推迟到 02 的那条、02 R14）。只经 pinCatalogForTurn 设置 */
const turnPin = new AsyncLocalStorage<CatalogSnapshot>();

/**
 * 记下开始时的 CatalogSnapshot，fn 之内（含它起的异步续体）currentCatalog() 都返回它：一轮里工具结果、链接上的 ?v= 与护栏
 * 看到的是同一代快照，中途有人改价也不混用（不变量 36）。文件模式（或还没装载完）什么都不做
 */
export function pinCatalogForTurn<T>(fn: () => Promise<T>): Promise<T> {
  const state = configState();
  if (!state.loaded) return fn();
  return turnPin.run(state.loaded.catalog, fn);
}

/**
 * 条目某个版本的 payload（deep-frozen），只读内存（匿名的方案书路由用，不查库，不变量 35）。版本只追加、旧版本永远在，
 * 所以不看本轮固定的快照。文件模式、没有这条或没有这个版本时返回 null
 */
export function catalogItemAt(kind: CatalogRow['kind'], code: string, version: number): unknown {
  const state = configState();
  return state.loaded?.history.get(catalogVersionKey(kind, code))?.get(version) ?? null;
}

/** 有条目版本大于 1（改过 active 条目的内容）：/healthz 的 config.catalogVersioned，回滚到 02 之前的镜像据此拒绝。文件模式恒为 false */
export function catalogVersioned(): boolean {
  const state = configState();
  if (!state.loaded) return false;
  return Object.values(state.loaded.catalog.versions).some((v) => v > 1);
}

/** 产品库快照变化后回调；retrieval.ts 在加载时注册，用来失效并重建索引 */
export function onCatalogChanged(cb: (snap: CatalogSnapshot) => void): void {
  if (scopedRuntime()) configState().catalogListeners.push(cb);
  else catalogSubscriptions.push(cb);
}

/**
 * 租户锁的状态变化（02 spec 的 tenant_lock 告警，startAlerts 订阅）：lost 锁连接断开、开始重取；held 重新取得；
 * taken 重取时发现已在别的进程手里、本进程开始停机
 */
export type LockEvent = 'lost' | 'held' | 'taken';
const lockSubscriptions = new Set<(ev: LockEvent) => void>();
export function onLockEvent(cb: (ev: LockEvent) => void): () => void {
  const listeners = scopedRuntime() ? configState().lockListeners : lockSubscriptions;
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function lockEvent(ev: LockEvent): void {
  for (const cb of [...lockSubscriptions, ...configState().lockListeners]) {
    try {
      cb(ev);
    } catch {
      /* 订阅者出错不影响锁的处理 */
    }
  }
}

/** 租户锁已被另一个进程拿走（重取得到 held_by_other）。PG 会话存储的 drain 段据此不写库、直接 spill */
export function tenantLockTaken(): boolean {
  const state = configState();
  return state.lockTaken;
}

export function configHealth(): ConfigHealth {
  const state = configState();
  return { lock: state.lockState, sopStale: state.sopStale, catalogStale: state.catalogStale };
}

/** 当前缓存与镜像 data/ 的差异，给后台 /status：每次现算，发布和上架之后跟着变 */
export function configDrift(): ConfigDrift {
  const state = configState();
  if (!state.loaded) throw new ConfigNotReadyError();
  const { catalog } = state.loaded;
  const active = Object.entries(catalog.items).flatMap(([kind, items]) =>
    items.map((payload) => ({ kind, code: String((payload as { id: string }).id), payload })),
  );
  const { deps } = state.loaded;
  return driftOf(imageDirOf(deps), runtimeOf(deps).sopSections, state.loaded.sop.sections, state.loaded.imageSections, active);
}

/** 配置写入前调：锁连接断开期间一律拒绝（第 7、8 步的写函数用） */
export function assertConfigWritable(): void {
  if (currentRuntime().state !== 'serving') throw new Error('tenant_closing');
  const state = configState();
  if (!state.loaded) throw new ConfigNotReadyError();
  if (state.lockState !== 'held') throw new ConfigLockLostError();
}

// ---------------- 生产依赖 ----------------

const PRIVILEGED = ['DATABASE_OWNER_URL', 'DATABASE_PLATFORM_URL', 'POSTGRES_PASSWORD'];

/**
 * 从环境变量构造生产依赖。CONFIG_SOURCE 由 initConfigFromEnv 先查；这里要求 DATABASE_URL 是 postgres:// 或 postgresql://，
 * DEFAULT_TENANT_SLUG 与 DEPLOY_PROFILE 显式设置；环境里不能有 owner / platform / 超级用户的凭据。连接串一律脱敏
 */
export async function productionConfigDeps(
  env: NodeJS.ProcessEnv,
  gracefulExit: (code: number) => void,
  opts: { tenantSlug?: string } = {},
): Promise<ConfigDeps> {
  const privileged = [...PRIVILEGED, ...Object.keys(env).filter((k) => /^AGENT_[A-Z0-9_]+_PASSWORD$/.test(k))].filter((k) => env[k]);
  if (privileged.length) {
    throw startup(
      'env_privileged',
      `app 的环境里不能有 ${[...new Set(privileged)].join('、')}：它们只给 migrate、platform 与 db 服务（spec R19）`,
    );
  }
  const url = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(url)) throw startup('env_invalid', 'DB 模式要设 DATABASE_URL，只接受 postgres:// 或 postgresql://');
  const tenantSlug = opts.tenantSlug ?? env.DEFAULT_TENANT_SLUG ?? '';
  if (!tenantSlug) throw startup('env_invalid', 'DB 模式要设 DEFAULT_TENANT_SLUG');
  if (!env.DEPLOY_PROFILE) throw startup('env_invalid', 'DB 模式要显式设置 DEPLOY_PROFILE，不接受缺省的 demo');
  for (const k of ['SOP_PATH', 'ROUTES_PATH', 'HOTELS_PATH']) {
    if (env[k]) console.warn(`[config] DB 模式下忽略 ${k}：它只给文件模式的测试夹具与回归跑法用`);
  }
  // 旅游的镜像照旧在连库之前读并校验：镜像缺失与连不上库同时发生时，先报 image_sop_invalid（08 R10 不改旅游的启动顺序）
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
    usePackRuntime: true,
    db: opened.db,
    closeDb: opened.close,
    tenantSlug,
    lock: (tenantId) => holdTenantLock(url, tenantId),
    imageSop,
    // 08 R10：下面四项都要等 loadConfig 解析出租户的包之后，由 usePackRuntime 整体换成该包的，所以这里是占位，不取旅游缺省；
    // 没换就被用到是 bug，渲染直接抛。
    toolsJson: '[]',
    toolNames: [],
    knownFields: [],
    render: () => {
      throw new Error('渲染器要等解析出租户的包之后才有');
    },
    gracefulExit,
  };
}

// 07 R15：嵌入服务的地址。配置层不 import 检索模块（依赖方向，同 onCatalogChanged 与 installRuntimeSources）：
// src/core/retrieval.ts 加载时把 `embedCfg().baseUrl` 装进来，DB 模式装载租户时据此校验。
// 没装（进程没加载检索模块，比如只跑配置的 CLI）就没有地址可查，不校验。
let embedBaseUrl: (() => string) | null = null;
export function bindEmbedBaseUrl(read: () => string): void {
  embedBaseUrl = read;
}

/**
 * DB 模式启动校验的第 0 步（07 R15）：嵌入请求会带着客户原文出去，目的地的主机不在境内已备案清单里就拒绝启动。
 * 不碰库，所以排在连库之前。LLM_MOCK=1 时 readEmbedding 一个请求都不发，端点用不到，不校验（行为不变，同 K4 的 mock 优先）。
 * 提示里只有主机：地址里可能带账号口令
 */
function assertEmbedEndpoint(): void {
  if (process.env.LLM_MOCK === '1' || !embedBaseUrl) return;
  const url = embedBaseUrl();
  if (embedEndpointAllowed(url)) return;
  throw startup(
    'embed_endpoint_forbidden',
    `嵌入服务（EMBED_BASE_URL，没配时跟着智谱或主模型走）的主机 ${embedEndpointHost(url)} 不在境内已备案清单里，或清单内主机没用 https：客户原文只发往清单里的 https 端点（07 R15）`,
  );
}

async function loadStandardTenants(deps: ConfigDeps) {
  await checkConfigDatabase(deps);
  return dbStep('读 standard 租户清单', () => standardTenants(deps.db));
}

/** 只回显看起来像个取值的短词：配错位置的整行环境变量里可能带着连接串口令 */
const shownValue = (name: string, v: string): string => (/^[a-z]{1,16}$/i.test(v) ? `${name}=${v}` : `${name} 的值`);

/**
 * 生产入口：先校验 CONFIG_SOURCE 与 SESSION_STORE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式。
 * SESSION_STORE（02 spec R1）：未设、空串、file 是文件存储，db 是 PG 会话存储且要求 CONFIG_SOURCE=db，绝不回落
 */
export async function initConfigFromEnv(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<void> {
  return withTenantScope(hostRuntime(), () => loadConfigFromEnv(env, gracefulExit));
}
async function loadConfigFromEnv(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<void> {
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
  if (mode !== 'db') {
    configureTenancy({ role: 'host', standardCount: 1, strict: env.TENANCY_STRICT === '1' });
    return initConfig(null);
  }
  assertGateAvailable(env);
  const deps = await productionConfigDeps(env, gracefulExit);
  let hostLocks: TenantLock | null = null;
  try {
    const standards = await loadStandardTenants(deps);
    const host = standards.find((t) => t.slug === deps.tenantSlug);
    if (!host) throw startup('tenant_not_found', '宿主必须是 standard 租户');
    const selected = standards.filter((t) => t.id === host.id || t.publicHost);
    for (const t of standards) if (!selected.includes(t)) console.log(`[config] 跳过未设置 public_host 的租户 ${t.slug}`);
    if (selected.length > 1 && selected.some((t) => !t.publicHost))
      throw startup('tenant_host_missing', '多个 standard 租户都必须设置 public_host');
    validatePublicHosts(
      selected.map((t) => ({ publicHost: t.publicHost, isHost: t.id === host.id })),
      env.PUBLIC_BASE_URL ?? '',
    );
    configureTenancy({ role: 'host', standardCount: selected.length, strict: env.TENANCY_STRICT === '1' });
    const held = await dbStep('取宿主进程租户锁', () =>
      holdTenantLocks(
        env.DATABASE_URL!,
        selected.map((t) => t.id),
      ),
    );
    hostLocks = held;
    if (!held) throw startup('lock_held', '装载的 standard 租户中有锁被另一个进程持有');
    // 共享连接只在所有运行时完成 late 收尾后释放；每个配置保留自己的锁视图。
    let remaining = selected.length;
    const locks = new Map(
      selected.map((t) => {
        let released = false;
        const lock: TenantLock = {
          onLost: (cb) => held.onLost(cb),
          reacquire: () => held.reacquire(),
          release: async () => {
            if (!released) {
              released = true;
              if (--remaining === 0) {
                await held.release();
                await deps.closeDb?.();
              }
            }
          },
        };
        return [t.id, lock] as const;
      }),
    );
    for (const t of selected) {
      const rt = t.id === host.id ? hostRuntime() : createTenantRuntime({ id: t.id, slug: t.slug, publicBase: `https://${t.publicHost}` });
      installPublicHost(rt, t.publicHost);
      if (!rt.isHost) registerRuntime(rt);
      await withTenantScope(rt, () => initConfig({ ...deps, tenantSlug: t.slug, lock: async () => locks.get(t.id)!, closeDb: undefined }));
    }
  } catch (e) {
    for (const rt of tenantRuntimes()) await withTenantScope(rt, closeConfig);
    await hostLocks?.release().catch(() => {});
    await deps.closeDb?.().catch(() => {});
    throw e;
  }
}

// ---------------- 装载 ----------------

const systemCtx = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });

/** 完整性：存下来的哈希与内容对得上。手工改过已发布行（绕过触发器）时在这里拦住 */
function assertIntegrity(row: SopVersionRow): void {
  try {
    publishedBrand(row.renderInputs);
    publishedPolicy(runtimeById(row.packId, packSources())?.policy, row);
  } catch {
    throw startup('integrity', `已发布版本 v${row.versionNo} 的品牌、政策快照或哈希不合规`);
  }
  if (!row.renderedPrompt || !row.promptHash || !row.sopHash) throw startup('integrity', `已发布版本 v${row.versionNo} 缺少渲染结果或哈希`);
  if (sha256(row.renderedPrompt) !== row.promptHash)
    throw startup('integrity', `已发布版本 v${row.versionNo} 的 rendered_prompt 与 prompt_hash 对不上`);
  if (sha256(joinSop(row.sections)) !== row.sopHash)
    throw startup('integrity', `已发布版本 v${row.versionNo} 的 sections 与 sop_hash 对不上（有人改过这一行？）`);
}

/** 兼容数组不复制：别名和通用条目始终指向同一个数组。 */
function catalogAliases(items: CatalogSnapshot['items']): Pick<CatalogSnapshot, 'routes' | 'hotels'> {
  return { routes: (items.route ?? []) as readonly Route[], hotels: (items.hotel ?? []) as readonly Hotel[] };
}

function snapshotOf(tenantId: string, rows: readonly CatalogRow[], gen: number, history: VersionHistory): CatalogSnapshot {
  const active = rows.filter((r) => r.status === 'active');
  const items = Object.fromEntries(
    [...new Set(active.map((r) => r.kind))].map((kind) => [
      kind,
      active
        .filter((r) => r.kind === kind)
        .toSorted((a, b) => a.ord - b.ord)
        .map((r) => r.payload),
    ]),
  );
  const versions: Record<string, number> = {};
  for (const r of active) {
    const key = catalogVersionKey(r.kind, r.code);
    const v = currentVersionOf(r, history);
    if (v > 0) versions[key] = v;
  }
  return deepFreeze({ tenantId, generation: gen, items, ...catalogAliases(items), versions });
}

type VersionWrite = { kind: CatalogRow['kind']; code: string; version: number; payload: Record<string, unknown> };

/**
 * 启动补写（02 spec「报价快照」）要写的：没有任何版本行的 active 条目（回滚到 01 镜像期间上架的）以当前 payload 写版本 1；
 * 最新版本的 payload 与条目不同的（01 镜像期间改过）写下一个版本。不动 catalog_items 这一行（见 currentVersionOf）
 */
function backfillPlan(items: readonly CatalogRow[], versions: readonly CatalogVersionRow[]): VersionWrite[] {
  const history = historyOf(versions);
  const writes: VersionWrite[] = [];
  for (const it of items) {
    const key = catalogVersionKey(it.kind, it.code);
    const latest = latestOf(history, key);
    if (latest === 0 || JSON.stringify(history.get(key)!.get(latest)) !== JSON.stringify(it.payload)) {
      writes.push({ kind: it.kind, code: it.code, version: latest + 1, payload: it.payload });
    }
  }
  return writes;
}

/** 启动补写的写入：一个事务，取配置写锁；每个新版本记 source='backfill' 与一行 catalog.version 审计 */
async function writeBackfill(d: ConfigDeps, tenantId: string, writes: readonly VersionWrite[]): Promise<void> {
  await withTenant(d.db, systemCtx(tenantId), async (tx) => {
    await lockTenantConfig(tx);
    for (const w of writes) {
      await insertCatalogVersion(tx, { ...w, source: 'backfill', createdByName: 'system' });
      await writeAudit(tx, {
        action: 'catalog.version',
        targetType: w.kind,
        targetId: w.code,
        diff: { version: w.version, source: 'backfill' },
      });
    }
  });
  console.log(`[config] 条目版本启动补写：${writes.map((w) => `${catalogVersionKey(w.kind, w.code)} v${w.version}`).join('、')}`);
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
    ...publishedBrand(row.renderInputs),
    ...publishedPolicy(runtimeById(row.packId, packSources())?.policy, row),
  });
}

const CAUSE: Record<Exclude<keyof RenderInputs, 'brand'>, string> = {
  hardRulesHash: 'hard_rules',
  imageSopHash: 'locked_sections',
  sectionTableHash: 'section_table',
  toolsHash: 'tools',
  brandHash: 'brand',
  policyHash: 'policy',
};

/**
 * 启动重渲染的只读部分（spec「启动重渲染」第 1–6 步）：完整性、与镜像合并、渲染两遍、契约检查、判断要不要重渲染。
 * 返回 null 表示直接用存下来的行
 */
function resolvePublished(
  d: ConfigDeps,
  row: SopVersionRow,
  imageSections: readonly SopSection[],
  previousImage: readonly SopSection[],
): { merged: SopSection[]; rendered: string; causes: string[] } | null {
  const runtime = runtimeOf(d);
  const changedBrand =
    publishedBrand(row.renderInputs).brandHash !==
    renderInputsFor(d.render, d.imageSop, d.toolsJson, runtime.sopSections, d.brand ?? null).brandHash;
  const policy = publishedPolicy(runtime.policy, row);
  const changedPolicy = (runtime.policy !== undefined && row.policy == null) || row.renderInputs?.policyHash !== policy.policyHash;
  const stored = changedBrand ? switchPreamble(row.sections, previousImage, imageSections) : row.sections;
  const merged = mergeWithImage(stored, imageSections, runtime.sopSections);
  const rendered = d.render(joinSop(merged));
  if (d.render(joinSop(merged)) !== rendered) throw startup('renderer_nondeterministic', '同一份 SOP 渲染两遍结果不同');
  const violations = checkSopContract({
    sections: merged,
    imageSections,
    rendered,
    toolNames: d.toolNames,
    knownFields: d.knownFields,
    baselineEditableChars: null,
    ...contractInputs(runtime, d.brand ?? null, policy.policy),
    hardRequirements: d.render(''),
  });
  if (violations.length) {
    throw startup(
      'contract_failed',
      `已发布版本 v${row.versionNo} 与当前代码合并后过不了契约检查：\n${violations.map((v) => `  - ${v.code}${v.sectionKey ? `@${v.sectionKey}` : ''}：${v.detail}`).join('\n')}`,
    );
  }
  const toolsHash = sha256(d.toolsJson);
  if (rendered === row.renderedPrompt && toolsHash === row.toolsHash && !changedBrand && !changedPolicy) return null;
  const now = renderInputsFor(d.render, d.imageSop, d.toolsJson, runtime.sopSections, d.brand ?? null, policy.policyHash);
  const before = row.renderInputs;
  const causes = (Object.keys(CAUSE) as (keyof typeof CAUSE)[])
    .filter((k) => (k === 'brandHash' ? changedBrand : k === 'policyHash' ? changedPolicy : !before || before[k] !== now[k]))
    .map((k) => CAUSE[k]);
  if (!causes.length) throw startup('renderer_nondeterministic', `渲染的输入与 v${row.versionNo} 发布时完全相同，结果却不同`);
  return { merged, rendered, causes };
}

/**
 * 库与镜像 data/ 的差异（以库为准）：可编辑节按节，产品库按条目。active 是库里的 active 条目；
 * 镜像文件读不到或解析不了时，那一类不报差异
 */
function driftOf(
  dir: string,
  spec: readonly SectionSpec[],
  merged: readonly SopSection[],
  imageSections: readonly SopSection[],
  active: readonly { kind: CatalogRow['kind']; code: string; payload: unknown }[],
): ConfigDrift {
  const editedSections = spec
    .filter((s) => !s.locked && merged.find((x) => x.key === s.key)?.text !== imageSections.find((x) => x.key === s.key)?.text)
    .map((s) => s.key);
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

/** 镜像的配置目录：旅游是 data/，其他包是 data/packs/<id>/（08 R10、R11），那里没有 routes.json、hotels.json，对应的差异就不报 */
const imageDirOf = (d: ConfigDeps): string =>
  d.imageDataDir ??
  (d.runtime && d.runtime.id !== 'travel' ? path.join(process.cwd(), 'data', 'packs', d.runtime.id) : path.join(process.cwd(), 'data'));

/** 启动日志按节、按条目点名库与镜像 data/ 的差异：DB 模式下改 data/ 的可编辑节或产品库不会生效，要让人看得见 */
function logDrift(d: ConfigDeps, merged: readonly SopSection[], imageSections: readonly SopSection[], rows: readonly CatalogRow[]): void {
  const spec = runtimeOf(d).sopSections;
  const drift = driftOf(imageDirOf(d), spec, merged, imageSections, rows);
  const headings = drift.editedSections.map((k) => spec.find((s) => s.key === k)?.heading ?? k);
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
 * deps 为 null：文件模式，装配同目录品牌。否则依次执行，前 8 步只读（第 0 步校验嵌入端点，不碰库）：
 *   0 嵌入端点在境内清单里（07 R15）→ 1 连库，核对 server_encoding 为 UTF8 → 2 核对迁移 → 3 按 tenantSlug 解析租户，拒绝注册表里没有的行业包；
 *   非旅游包没有品牌拒绝（brand_required，08 R10），再读它自己的镜像（旅游的 data/sop.md 在连库之前已读） → 4 取租户锁
 *   → 5 切分并校验镜像 → 6 装载已发布 SOP，校验完整性，算出合并、渲染与契约结果 → 7 装载产品库快照（至少一条 active 线路）
 *   → 8 按节、按条目打印 DB 与镜像 data/ 的差异 → 9 需要时写入 rerender 版本 → 10 装上缓存。
 * 任何一步失败都以 ConfigStartupError reject，释放锁、关闭连接池，不留半装载状态
 */
export async function initConfig(deps: ConfigDeps | null): Promise<void> {
  const rt = scopedRuntime() ?? hostRuntime();
  return withTenantScope(rt, () => loadConfig(deps));
}
/** 启动清单与单租户装载都必须先核对编码和迁移，保持原有错误归类。 */
export async function checkConfigDatabase(d: ConfigDeps): Promise<void> {
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
}

/** 只在 DB 装载路径调用，profile 启动行由组合根先输出；文件模式与沙箱不读取闸开关。 */
function assertGateAvailable(env: NodeJS.ProcessEnv): void {
  if (env.APP_ROLE === 'sandbox' || currentRuntime().kind === 'sandbox' || env.SOP_GATE !== 'required') return;
  const provider = (env.LLM_PROVIDER ?? '').toLowerCase();
  const key = (provider === 'zhipu' ? env.ZHIPU_API_KEY : provider === 'deepseek' ? env.DEEPSEEK_API_KEY : '') || env.LLM_API_KEY;
  if (env.LLM_MOCK === '1' || !key) throw startup('gate_unavailable', '发布闸要求真实模型配置，不能使用 LLM_MOCK 或空模型密钥');
}

/** 首次导入与装载都按完整候选快照检查；不依赖磁盘顺序或当前已发布缓存。 */
export function assertCatalogCrossItems(runtime: PackBinding['runtime'], snapshot: CatalogSnapshot): void {
  for (const [kind, spec] of Object.entries(runtime.catalog)) {
    if (!spec.crossItemCheck) continue;
    for (const item of snapshot.items[kind] ?? []) {
      const issues = spec.crossItemCheck(item as Readonly<Record<string, unknown>>, snapshot);
      if (issues.length)
        throw startup(
          'catalog_startup',
          `${kind}/${String((item as { id: string }).id)}：${issues.map((issue) => `${issue.path}：${issue.message}`).join('；')}`,
        );
    }
  }
}

/** 08 R2：只按包与快照判定产品库能否启动，不依赖 SOP 装载或租户作用域。 */
export function assertCatalogStartup(runtime: PackBinding['runtime'], snapshot: CatalogSnapshot, tenantSlug: string): void {
  assertCatalogCrossItems(runtime, snapshot);
  const detail = runtime.catalogStartupCheck?.(snapshot);
  if (detail === undefined || detail === null) return;
  if (runtime.id === 'travel') throw startup('no_active_routes', `租户「${tenantSlug}」${detail}`);
  throw startup('catalog_startup', detail);
}

async function loadConfig(deps: ConfigDeps | null): Promise<void> {
  const state = configState();
  if (!deps) {
    // 08 R11：配置目录有 pack.json 就按它装载（非旅游包还要读 catalog/），没有就是旅游，与以前逐字节相同
    state.fileCatalog = null;
    const binding = installFilePack();
    readFilePolicy(binding.runtime.policy);
    if (binding.runtime.id !== 'travel') loadFileCatalog(binding.runtime);
    return;
  }
  let d = deps;
  if (state.loaded) throw new Error('配置源已经装载过');
  state.dbInstalled = true;
  let lock: TenantLock | null = null;
  try {
    // 0
    assertGateAvailable(process.env);
    assertEmbedEndpoint();
    await checkConfigDatabase(d);
    // 3
    const tenant = await dbStep('解析租户', () => findTenantBySlug(d.db, d.tenantSlug));
    if (!tenant) throw startup('tenant_not_found', `没有 slug 为「${d.tenantSlug}」的租户`);
    identifyRuntime(currentRuntime(), {
      id: tenant.id,
      slug: tenant.slug,
      kind: currentRuntime().kind,
      isHost: currentRuntime().isHost,
      publicBase: currentRuntime().publicBase,
    });
    // 后台 UX spec「接口改动 · /pack」：包不在注册表里时拒绝启动（tenant-create 已按注册表校验，这里防手改库）
    const pack = packById(tenant.packId);
    if (!pack) throw startup('pack_unknown', `租户「${d.tenantSlug}」的行业包「${tenant.packId}」不在注册表里`);
    const runtime = runtimeById(tenant.packId, packSources());
    if (!runtime) throw startup('pack_unknown', `行业包 ${tenant.packId} 没有运行时`);
    packPipelines(runtime);
    if (d.usePackRuntime) {
      d = {
        ...d,
        toolsJson: JSON.stringify(runtime.tools.map((t) => t.def)),
        toolNames: runtime.tools.map((t) => t.def.function.name),
        knownFields: runtime.knownFields.names,
        render: (sop) => renderSystemPrompt(sop, runtime.legacy.hardRequirements),
      };
    }
    const brand = (await dbStep('读待生效品牌', () => readBrand(d.db, tenant.id))) ?? null;
    // owner 2026-10-24 定（plan Open 1）：非旅游包只支持模板模式（08 R10），没有品牌就拒绝启动，规则在 assertBrandForPack
    assertBrandForPack(runtime, brand, `租户「${d.tenantSlug}」`);
    // 08 R10：旅游用连库之前读好的 data/sop.md，其他包在这里（解析出租户的包之后）读 data/packs/<id>/sop.md
    const legacyImage = imageSopOf(d, runtime.id);
    d = { ...d, brand, runtime };
    if (brand) d = { ...d, render: tenantRenderer(runtime, brand) };
    // 4
    const held = await dbStep('取租户锁', () => d.lock(tenant.id));
    lock = held;
    if (!held) throw startup('lock_held', `租户「${d.tenantSlug}」的锁在另一个进程手里：同一个库只能跑一个应用副本`);
    // 取到锁就订阅断开：锁连接在装载途中断了，装上缓存时直接进入 lost 并开始重取，而不是一直以为持着锁
    let lostWhileLoading = false;
    held.onLost(
      tenantCallback(currentRuntime(), () => {
        if (!state.loaded) lostWhileLoading = true;
        else if (state.loaded.lock === held) onLockLost();
      }),
    );
    // 5
    let imageSections: SopSection[];
    try {
      imageSections = tenantImage(runtime, legacyImage, brand);
      d = { ...d, imageSop: joinSop(imageSections) };
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
    assertIntegrity(row);
    const previousImage = tenantImage(runtime, legacyImage, publishedBrand(row.renderInputs).brand);
    const rerender = resolvePublished(d, row, imageSections, previousImage);
    assertCatalogStartup(runtime, snapshotOf(tenant.id, items, 0, historyOf(versions)), d.tenantSlug);
    // 8
    const merged = rerender?.merged ?? mergeWithImage(row.sections, imageSections, runtime.sopSections);
    logDrift(d, merged, imageSections, items);
    if (preambleWarning(merged, imageSections)) console.warn('[config] 前言节里可能还有旧品牌名');
    // 9 以上全部通过之后才写：一个事务里归档旧版本、发布一个 source='rerender' 的新版本，运营编辑过的可编辑节原样保留
    const current = rerender ? await dbStep('写入 rerender 版本', () => writeRerender(d, tenant.id, row, rerender)) : row;
    // 9（02）条目版本的启动补写，两种会话存储都做；补写的版本随后与读到的一起进内存
    const backfill = backfillPlan(items, versions);
    if (backfill.length) await dbStep('补写条目版本', () => writeBackfill(d, tenant.id, backfill));
    if (currentRuntime().kind === 'standard')
      await dbStep('放弃重启前的发布闸', () => withTenant(d.db, systemCtx(tenant.id), (tx) => abandonGates(tx)));
    const history = historyOf([...versions, ...backfill]);
    // 10
    state.loaded = {
      deps: d,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      pack,
      lock: held,
      imageSections: deepFreeze(imageSections),
      legacyImageSop: legacyImage,
      sop: toPublishedSop(tenant.id, current, merged),
      catalog: snapshotOf(tenant.id, items, 0, history),
      ords: ordsOf(items),
      history,
    };
    bindPack(runtime, state.loaded.sop.brand);
    state.lockState = 'held';
    state.sopStale = false;
    state.catalogStale = false;
    // 日志的 tenant（R24）：只在 DB 配置模式下有
    setLogTenant(d.tenantSlug);
    // 缓存照常装上（对话要用），配置写入暂停、开始重取
    if (lostWhileLoading) onLockLost();
    const { sop } = state.loaded;
    if (runtime.id === 'travel') {
      console.log(
        `[config] DB 模式：租户 ${d.tenantSlug} · SOP v${sop.versionNo} · 线路 ${state.loaded.catalog.routes.length} 条、酒店 ${state.loaded.catalog.hotels.length} 家 · 前缀 ${sop.prefixHash.slice(0, 12)}`,
      );
    } else {
      const counts = Object.keys(runtime.catalog)
        .map((kind) => `${kind} ${state.loaded!.catalog.items[kind]?.length ?? 0} 条`)
        .join('、');
      console.log(`[config] DB 模式：租户 ${d.tenantSlug} · SOP v${sop.versionNo} · ${counts} · 前缀 ${sop.prefixHash.slice(0, 12)}`);
    }
  } catch (e) {
    state.dbInstalled = false;
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
  const runtime = runtimeOf(d);
  const policy = publishedPolicy(runtime.policy, row);
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
      policy: policy.policy,
      renderInputs: renderInputsFor(d.render, d.imageSop, d.toolsJson, runtime.sopSections, d.brand ?? null, policy.policyHash),
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
  const state = configState();
  if (!state.loaded) throw new ConfigNotReadyError();
  return { name: state.loaded.tenantName, pack: state.loaded.pack };
}

// ---------------- 给编辑流程用 ----------------

/** 只给 src/config/sop.ts、catalog.ts 用，以及 boot 给 db 会话存储拼依赖：装载时的库、租户、依赖与镜像节 */
export function configRuntime(): {
  db: Db;
  tenantId: string;
  deps: ConfigDeps;
  imageSections: readonly SopSection[];
  legacyImageSop: string;
} {
  const state = configState();
  if (!state.loaded) throw new ConfigNotReadyError();
  return {
    db: state.loaded.deps.db,
    tenantId: state.loaded.tenantId,
    deps: state.loaded.deps,
    imageSections: state.loaded.imageSections,
    legacyImageSop: state.loaded.legacyImageSop,
  };
}

/**
 * 提交之后换产品库快照的次数（applyCatalogRow 真的换了才加 1）。重读据此认出自己读到的产品库可能已经过时。
 * SOP 不用计数：版本号只增不减，重读读到的旧版本号不会换上去
 */

/** 只给 src/config/{sop,catalog}.ts 在事务提交之后调用；next.versionNo 不大于当前值时忽略 */
export function replacePublishedSop(next: PublishedSop): void {
  if (currentRuntime().state !== 'serving') return;
  const state = configState();
  if (!state.loaded || next.versionNo <= state.loaded.sop.versionNo) return;
  state.loaded.sop = next;
  state.sopStale = false;
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
  if (currentRuntime().state !== 'serving') return;
  const state = configState();
  const cur = state.loaded;
  if (!cur || row.status !== 'active') return;
  state.catalogWrites++;
  addVersion(cur.history, row.kind, row.code, row.version, row.payload);
  // 内容没变的写入（原样提交）带回的是这一列上的版本，启动补写之后它可能落后于历史：取大（见 currentVersionOf）
  const versions = { ...cur.catalog.versions, [catalogVersionKey(row.kind, row.code)]: currentVersionOf(row, cur.history) };
  const ords = Object.hasOwn(cur.ords, row.kind) ? cur.ords[row.kind]! : (cur.ords[row.kind] = new Map());
  const idOf = (x: unknown): string => String((x as { id: unknown }).id);
  const items: { ord: number; payload: unknown }[] = (cur.catalog.items[row.kind] ?? [])
    .filter((x) => idOf(x) !== row.code)
    .map((x) => ({ ord: ords.get(idOf(x)) ?? Number.MAX_SAFE_INTEGER, payload: x }));
  items.push({ ord: row.ord, payload: structuredClone(row.payload) });
  ords.set(row.code, row.ord);
  const list = items.toSorted((a, b) => a.ord - b.ord).map((x) => x.payload);
  const nextItems = { ...cur.catalog.items, [row.kind]: list };
  setCatalog(cur, { ...cur.catalog, items: nextItems, ...catalogAliases(nextItems), versions, generation: cur.catalog.generation + 1 });
}

// ---------------- 锁丢失 ----------------

function onLockLost(): void {
  const state = configState();
  if (state.shuttingDown || !state.loaded) return;
  state.lockState = 'lost';
  // 沙箱的共享锁连接由组合根 fail-stop，永远不在原进程重取。
  if (currentRuntime().kind === 'sandbox') return;
  console.error(`[config] 租户锁连接断开：配置写入暂停，对话照常；每 ${state.reacquireMs / 1000} 秒重取`);
  lockEvent('lost');
  scheduleReacquire();
}

function scheduleReacquire(): void {
  const state = configState();
  const currentRuntimeForTimer = currentRuntime();
  if (state.reacquireTimer) return;
  state.reacquireTimer = withoutTenantScope(() =>
    setTimeout(
      tenantCallback(currentRuntimeForTimer, () => {
        state.reacquireTimer = null;
        void reacquireOnce();
      }),
      state.reacquireMs,
    ),
  );
  state.reacquireTimer.unref();
}

async function reacquireOnce(): Promise<void> {
  const state = configState();
  const cur = state.loaded;
  if (state.shuttingDown || !cur) return;
  const r = await cur.lock.reacquire().catch(() => 'unreachable' as const);
  if (state.shuttingDown || state.loaded !== cur) return;
  if (r === 'ok') {
    state.lockState = 'held';
    console.log('[config] 租户锁已重新取得，配置写入恢复');
    lockEvent('held');
  } else if (r === 'held_by_other') {
    // 另一个进程已经接管：先跑全部停机钩子（在途的企微回复发完、会话落盘），再退出
    state.lockTaken = true;
    console.error('[config] 租户锁已被另一个进程拿走，本进程优雅退出');
    lockEvent('taken');
    cur.deps.gracefulExit(1);
  } else {
    scheduleReacquire();
  }
}

// ---------------- 重读 ----------------

const RELOAD_BACKOFF_MS = [5_000, 30_000, 120_000];

/**
 * 读一次库、换上缓存。返回 false 表示没换：读的途中有产品库写入提交并换了快照，这份快照可能早于那次写入，
 * 整体换上去会把那次修改冲掉（spec 否决的「提交后重读」就是这个竞态），要重读。SOP 由版本号只增不减兜住
 */
async function reloadOnce(cur: Loaded): Promise<boolean> {
  const state = configState();
  const writesBefore = state.catalogWrites;
  const { row, items, versions } = await withTenant(
    cur.deps.db,
    systemCtx(cur.tenantId),
    async (tx) => ({ row: await readPublishedSop(tx), items: await readActiveCatalog(tx), versions: await readCatalogVersions(tx) }),
    { isolation: 'repeatable read', readOnly: true },
  );
  if (!row) throw new Error('库里没有已发布的 SOP');
  assertIntegrity(row);
  if (currentRuntime().state !== 'serving' || state.loaded !== cur) return true;
  if (state.catalogWrites !== writesBefore) return false;
  // 版本号只增不减（不变式 13）
  if (row.versionNo! > cur.sop.versionNo)
    cur.sop = toPublishedSop(cur.tenantId, row, mergeWithImage(row.sections, cur.imageSections, runtimeOf(cur.deps).sopSections));
  state.sopStale = false;
  // 版本只追加：库里读到的并进内存里已有的（内存里有、库里没有的不会出现：只有提交之后才加进内存）
  for (const v of versions) addVersion(cur.history, v.kind, v.code, v.version, v.payload);
  const next = snapshotOf(cur.tenantId, items, cur.catalog.generation, cur.history);
  cur.ords = ordsOf(items);
  if (
    JSON.stringify(next.items) !== JSON.stringify(cur.catalog.items) ||
    JSON.stringify(next.versions) !== JSON.stringify(cur.catalog.versions)
  ) {
    setCatalog(cur, { ...next, generation: cur.catalog.generation + 1 });
  }
  state.catalogStale = false;
  return true;
}

function setCatalog(cur: Loaded, snap: CatalogSnapshot): void {
  const state = configState();
  cur.catalog = deepFreeze(snap);
  for (const cb of [...catalogSubscriptions, ...state.catalogListeners]) {
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
  if (currentRuntime().state !== 'serving') return Promise.resolve();
  const state = configState();
  const cur = state.loaded;
  if (!cur) return Promise.reject(new ConfigNotReadyError());
  state.sopStale = true;
  state.catalogStale = true;
  if (state.reloading) {
    state.reloadAgain = true;
    return state.reloading;
  }
  state.reloading = (async () => {
    do {
      state.reloadAgain = false;
      for (let attempt = 0; ; attempt++) {
        if (state.shuttingDown || state.loaded !== cur) return;
        try {
          // 读的途中产品库快照被写入换过：这份快照作废，立即再读一遍（不算失败，不退避）
          if (!(await reloadOnce(cur))) state.reloadAgain = true;
          break;
        } catch (e) {
          const wait = state.reloadBackoff[Math.min(attempt, state.reloadBackoff.length - 1)]!;
          console.error(`[config] 从库里重读配置失败，${wait / 1000} 秒后重试：${message(e)}`);
          await new Promise((r) => withoutTenantScope(() => setTimeout(r, wait).unref()));
        }
      }
    } while (state.reloadAgain);
  })().finally(() => {
    state.reloading = null;
  });
  return state.reloading;
}

// ---------------- 停机 ----------------

/** onShutdown 的普通阶段调：此后忽略锁连接的一切事件 */
export function markConfigShuttingDown(): void {
  const state = configState();
  state.shuttingDown = true;
  if (state.reacquireTimer) clearTimeout(state.reacquireTimer);
  state.reacquireTimer = null;
}

/** onShutdown 的 late 阶段调：其他停机钩子都结束之后，释放锁、关连接池 */
export async function closeConfig(): Promise<void> {
  const state = configState();
  const cur = state.loaded;
  if (!cur) return;
  const { stopTenantGates } = await import('./gate.js');
  await stopTenantGates(cur.tenantId);
  await cur.lock.release().catch(() => {});
  await cur.deps.closeDb?.().catch(() => {});
}

/** 仅供自测：卸下配置源、清空缓存，回到文件模式 */
export const __configTest = {
  loadStandardTenants,
  reset(): void {
    withTenantScope(scopedRuntime() ?? hostRuntime(), () => resetConfig());
  },
  /**
   * 换掉装载好的行业包，返回原来那份：后台接口按另一个包（家装假包）判定会话状态时用。
   * 假包不进注册表（不变量 25），租户行里写它的 pack_id 启动不了，只能这样换
   */
  swapPack(pack: IndustryPack): IndustryPack {
    const state = configState();
    if (!state.loaded) throw new ConfigNotReadyError();
    const prev = state.loaded.pack;
    state.loaded.pack = pack;
    return prev;
  },
  /** 锁重取间隔与重读退避调短，测试不用真等几秒 */
  setTimings(t: { reacquireMs?: number; reloadBackoffMs?: number[] }): void {
    const state = configState();
    if (t.reacquireMs !== undefined) state.reacquireMs = t.reacquireMs;
    if (t.reloadBackoffMs) state.reloadBackoff = t.reloadBackoffMs;
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
  const state = configState();
  if (state.loaded) {
    const s = state.loaded.sop;
    return { sopVersion: s.versionNo, promptHash: s.promptHash, toolsHash: s.toolsHash, prefixHash: s.prefixHash, sopHash: s.sopHash };
  }
  const f = file();
  return { sopVersion: null, ...promptHashes(f.system, f.tools, f.sop) };
}

/** 文件模式按 pack.json 延后装配（没有就是旅游）；DB 模式必须已经显式绑定包（08 R5）。 */
export function currentPack(): PackBinding {
  const state = configState();
  if (state.fileCatalog) dropStaleFileCatalog(state);
  let binding = boundPack();
  if (!binding) {
    if (configMode() === 'db') throw new ConfigNotReadyError('DB 模式没有绑定行业包');
    binding = installFilePack();
  }
  return state.loaded ? { ...binding, brand: state.loaded.sop.brand } : binding;
}

/** 每轮开始捕获一次并保留返回值：与已发布 SOP 同步，DB 读路径不查询草稿或数据库。 */
export function currentPolicy(): ReturnType<typeof policySnapshot> {
  const state = configState();
  if (state.loaded) return { policy: state.loaded.sop.policy, policyHash: state.loaded.sop.policyHash };
  if (configMode() === 'db') throw new ConfigNotReadyError();
  return readFilePolicy(currentPack().runtime.policy);
}

/** 与引擎共用有效路径，品牌不会误读 cwd/data 或产品库所在目录。 */
export function fileSopPath(): string {
  return process.env.SOP_PATH ?? path.join(process.cwd(), 'data', 'sop.md');
}

function readFileBrand(): BrandProfile | null {
  const file = path.join(path.dirname(fileSopPath()), 'brand.json');
  if (!fs.existsSync(file)) return null;
  // 严格解码：非法字节不能被替换成 U+FFFD 后照样通过校验、把损坏的品牌渲染进锁定节
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  return BrandProfileSchema.parse(JSON.parse(text));
}

// ---------------- 文件模式：按 pack.json 装载（08 R11） ----------------

/** 配置目录的 pack.json 指的非旅游包 id。没有这个文件、或写的就是 travel，都是旅游（null）；写坏了以 pack_unknown 拒绝 */
function filePackId(): string | null {
  let file: ReturnType<typeof readPackFile>;
  try {
    file = readPackFile(path.dirname(fileSopPath()));
  } catch (e) {
    throw startup('pack_unknown', message(e));
  }
  return file === null || file.id === 'travel' ? null : file.id;
}

/**
 * 文件模式装配行业包：配置目录有 pack.json 就按它的 id，没有就是旅游（与以前完全相同，不读 catalog/）。
 * 非旅游包只支持模板模式（08 R10）：镜像取 data/packs/<id>/sop.md，品牌取同目录的 brand.json，没有品牌拒绝（brand_required，同 DB 模式）；
 * 注册表里没有这个包以 pack_unknown 拒绝。
 */
function installFilePack(): PackBinding {
  const id = filePackId();
  if (id === null) return installPack('travel', readFileBrand());
  if (!packById(id)) throw startup('pack_unknown', `配置目录的 pack.json 指向行业包「${id}」，它不在注册表里`);
  const brand = readFileBrand();
  if (brand === null) throw startup('brand_required', `行业包「${id}」只支持模板模式，配置目录里要有 brand.json（品牌档案）`);
  return installPack(id, brand);
}

/** 文件模式的配置目录：SOP_PATH 所在目录，pack.json、brand.json、policy.json、catalog/ 都在这里 */
const fileConfigDir = (): string => path.dirname(fileSopPath());

/**
 * 产品库快照是按某个配置目录装的。目录变了（评测在同一进程里换 SOP_PATH）就作废；绑定还是装这份快照的那一个（没被 bindPack 换过）
 * 也一起作废，下一次按当前目录的 pack.json 重新装配。其余绑定（旅游、品牌夹具显式绑的）不动。
 */
function dropStaleFileCatalog(state: TenantConfig): void {
  const cache = state.fileCatalog;
  if (!cache || cache.dir === fileConfigDir()) return;
  state.fileCatalog = null;
  if (boundPack()?.runtime === cache.runtime) unbindPack();
}

/** 重置时去掉包绑定（TenantRuntime.pack 装载后才有，所以绕开类型）；文件模式下一次按配置目录重新装配。 */
function unbindPack(): void {
  Reflect.set(currentRuntime(), 'pack', undefined);
}

/**
 * 评测在同一进程里换配置目录前后用（eval/sim/runtime.ts 的 engineRuntime）：记下现在的包绑定与文件模式产品库快照，
 * 返回的函数把它们原样放回去。没绑过的恢复成没绑。
 */
export function saveFileConfig(): () => void {
  const rt = currentRuntime();
  const { fileCatalog: cache } = rt.config;
  const pack = boundPack();
  return () => {
    rt.config.fileCatalog = cache;
    Reflect.set(rt, 'pack', pack ?? undefined);
  };
}

/**
 * 文件模式下 currentCatalog() 的出处。非旅游包读配置目录的 catalog/<kind>.json 拼成快照，进程内读一次（同 DB 模式的启动装载，
 * 手改文件要重启）；旅游（没有 pack.json）与 DB 模式没装载完，都和以前一样抛 ConfigNotReadyError：旅游的工具自己读 ROUTES_PATH。
 */
function fileCatalog(state: TenantConfig): CatalogSnapshot {
  if (configMode() === 'file') {
    dropStaleFileCatalog(state);
    if (state.fileCatalog) return state.fileCatalog.snapshot;
    // 评测不走 initConfig、还没绑包：按 pack.json 认；没有 pack.json 就什么都不装，保持旅游的老样子
    const bound = boundPack() ?? (filePackId() === null ? null : installFilePack());
    if (bound && bound.runtime.id !== 'travel') return loadFileCatalog(bound.runtime);
  }
  throw new ConfigNotReadyError();
}

/** 包声明的每个 kind 读 catalog/<kind>.json（缺文件就是空数组），逐条过包的 schema，版本恒为 1；再套包的启动检查（catalog_startup） */
function loadFileCatalog(runtime: PackRuntime): CatalogSnapshot {
  const dir = path.join(fileConfigDir(), 'catalog');
  const items: Record<string, unknown[]> = {};
  const versions: Record<string, number> = {};
  for (const [kind, spec] of Object.entries(runtime.catalog)) {
    items[kind] = readCatalogFile(dir, kind, spec);
    for (const item of items[kind]) versions[catalogVersionKey(kind, (item as { id: string }).id)] = 1;
  }
  const snapshot: CatalogSnapshot = deepFreeze({
    tenantId: currentRuntime().id,
    generation: 0,
    items,
    ...catalogAliases(items),
    versions,
  });
  assertCatalogStartup(runtime, snapshot, '');
  configState().fileCatalog = { dir: fileConfigDir(), runtime, snapshot };
  return snapshot;
}

function readCatalogFile(dir: string, kind: string, spec: CatalogKindSpec): unknown[] {
  const name = `catalog/${kind}.json`;
  // kind 拼进文件名：包声明里的 kind 也不许带路径
  if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw startup('catalog_startup', `kind「${kind}」不能当文件名用`);
  const file = path.join(dir, `${kind}.json`);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    // 严格解码：非法字节不能被替换成 U+FFFD 后照样通过校验
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
  } catch (e) {
    throw startup('catalog_startup', `${name} 读不出来：${message(e)}`);
  }
  if (!Array.isArray(raw)) throw startup('catalog_startup', `${name} 必须是数组`);
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const parsed = spec.schema.safeParse(item);
    if (!parsed.success) {
      const why = parsed.error.issues.map((x) => `${x.path.join('.') || '(根)'}：${x.message}`).join('；');
      throw startup('catalog_startup', `${name} 第 ${i + 1} 条不合格：${why}`);
    }
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== 'string' || !id) throw startup('catalog_startup', `${name} 第 ${i + 1} 条没有字符串 id`);
    if (seen.has(id)) throw startup('catalog_startup', `${name} 里 id「${id}」重复`);
    seen.add(id);
  });
  return raw;
}

/** 文件模式保留可编辑节，只把锁定节与硬性要求按装载的品牌渲染；旧版原文不经过切分。 */
export function renderFileSop(sop: string): string {
  const { runtime, brand } = currentPack();
  if (brand === null) return renderSystemPrompt(sop, runtime.legacy.hardRequirements);
  const image = tenantImage(runtime, sop, brand);
  const legacyImage = splitSop(readImageSop(runtime.id), runtime.sopSections);
  const stored = switchPreamble(splitSop(sop, runtime.sopSections), legacyImage, image);
  return tenantRenderer(runtime, brand)(joinSop(mergeWithImage(stored, image, runtime.sopSections)));
}

function installPack(id: string, brand: BrandProfile | null = null): PackBinding {
  const runtime = runtimeById(id, packSources());
  if (!runtime) throw new Error(`行业包 ${id} 没有运行时`);
  bindPack(runtime, brand);
  return boundPack()!;
}

/** R1：旧入口补旅游能力，运行时业务仍在包内。 */
export function legacyTravelRuntime(): ReturnType<typeof travelRuntime> {
  return travelRuntime(packSources());
}

// 配置层不加载存储、接管与发送账本：能力在运行时模块初始化完成后安装。
// 包工厂只捕获这些延后调用的函数，不在装载期读取存储，因此 CLI 也能校验并绑定运行时。
let runtimeSources: PackSources | null = null;
export function installRuntimeSources(sources: PackSources): void {
  runtimeSources = sources;
}
function liveSources(): PackSources {
  if (!runtimeSources) throw new Error('运行时能力尚未初始化');
  return runtimeSources;
}
export function packSources(): PackSources {
  return {
    erp: {
      active: (...args) => runtimeSources?.erp.active(...args) ?? false,
      mapped: (...args) => runtimeSources?.erp.mapped(...args) ?? false,
      availability: (...args) => liveSources().erp.availability(...args),
      fresh: (...args) => liveSources().erp.fresh(...args),
    },
    currentPolicy,
    configMode,
    currentCatalog,
    catalogVersionKey,
    catalogItemAt,
    isConfigNotReadyError: (error) => error instanceof ConfigNotReadyError,
    modelHandoffReason: HANDOFF_REASON.model,
    handoffReasons: HANDOFF_REASON,
    indexReady: (...args) => liveSources().indexReady(...args),
    semanticRecall: (...args) => liveSources().semanticRecall(...args),
    createOrder: (...args) => liveSources().createOrder(...args),
    getOrder: (...args) => liveSources().getOrder(...args),
    queueJobs: (...args) => liveSources().queueJobs(...args),
    saveSession: (...args) => liveSources().saveSession(...args),
    supersedeOrder: (...args) => liveSources().supersedeOrder(...args),
    todayIso: (...args) => liveSources().todayIso(...args),
    paymentMode: (...args) => liveSources().paymentMode(...args),
    orderUnconfirmedNotifyOps: (...args) => liveSources().orderUnconfirmedNotifyOps(...args),
    enterHandoff: (...args) => liveSources().enterHandoff(...args),
    isTerminalStage: (...args) => liveSources().isTerminalStage(...args),
  };
}

function resetConfig(): void {
  const state = configState();
  if (state.reacquireTimer) clearTimeout(state.reacquireTimer);
  state.reacquireTimer = null;
  state.dbInstalled = false;
  state.loaded = null;
  state.fileCatalog = null;
  // 文件模式：去掉绑定，下一次 currentPack() 按当前配置目录的 pack.json 重新装配（评测在同一进程里换 SOP_PATH 靠它）。
  // DB 模式必须重新显式绑定；CONFIG_SOURCE=db 时，重置后的 currentPack() 直接抛错（08 R5）。
  unbindPack();
  setLogTenant('');
  state.lockState = 'held';
  state.lockTaken = false;
  state.sopStale = false;
  state.catalogStale = false;
  state.shuttingDown = false;
  state.reloading = null;
  state.reloadAgain = false;
  state.reacquireMs = 5_000;
  state.reloadBackoff = RELOAD_BACKOFF_MS;
  // 不清 catalogListeners：它们是各模块加载时登记的（retrieval.ts），模块不会再加载一次
}

function configRegistration(key: keyof TenantConfig) {
  return {
    keyCount: (id: string): number => {
      const rt = tenantRuntimes().find((r) => r.id === id);
      if (!rt) return 0;
      const value = rt.config[key];
      if (Array.isArray(value) || value instanceof Set) return Array.isArray(value) ? value.length : value.size;
      return rt.config.loaded ? 1 : 0;
    },
    drop: (id: string): void => {
      const rt = tenantRuntimes().find((r) => r.id === id);
      if (!rt) return;
      if (rt.config.reacquireTimer) clearTimeout(rt.config.reacquireTimer);
      Object.assign(rt.config, createTenantConfig());
    },
    reset: (): void => {
      for (const rt of tenantRuntimes()) withTenantScope(rt, resetConfig);
    },
  };
}
registerTenantState({ name: 'config.dbInstalled', ...configRegistration('dbInstalled') });
registerTenantState({ name: 'config.loaded', ...configRegistration('loaded') });
registerTenantState({
  name: 'config.fileCatalog',
  ...configRegistration('fileCatalog'),
  keyCount: (id) => (tenantRuntimes().find((r) => r.id === id)?.config.fileCatalog ? 1 : 0),
});
registerTenantState({ name: 'config.lockState', ...configRegistration('lockState') });
registerTenantState({ name: 'config.lockTaken', ...configRegistration('lockTaken') });
registerTenantState({ name: 'config.sopStale', ...configRegistration('sopStale') });
registerTenantState({ name: 'config.catalogStale', ...configRegistration('catalogStale') });
registerTenantState({ name: 'config.shuttingDown', ...configRegistration('shuttingDown') });
registerTenantState({ name: 'config.reacquireTimer', ...configRegistration('reacquireTimer') });
registerTenantState({ name: 'config.catalogListeners', ...configRegistration('catalogListeners') });
registerTenantState({ name: 'config.lockListeners', ...configRegistration('lockListeners') });
registerTenantState({ name: 'config.catalogWrites', ...configRegistration('catalogWrites') });
registerTenantState({ name: 'config.reloading', ...configRegistration('reloading') });
registerTenantState({ name: 'config.reloadAgain', ...configRegistration('reloadAgain') });
