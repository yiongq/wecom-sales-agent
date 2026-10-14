// 每个运行时独立的配置缓存与锁状态（05 R3 / R5）。
import type { ConfigDeps, PublishedSop, CatalogSnapshot, LockEvent } from './source.js';
import type { TenantLock } from '../db/client.js';
import type { IndustryPack } from '../shared/pack.js';
import type { SopSection } from '../sop/sections.js';
import type { CatalogRow } from '../db/repo/catalog.js';
type VersionHistory = Map<string, Map<number, unknown>>;
export interface Loaded {
  deps: ConfigDeps;
  tenantId: string;
  /** 启动时装载的租户行里的名称与行业包：/me 的 tenantName、/pack 用，不查库 */
  tenantName: string;
  pack: IndustryPack;
  lock: TenantLock;
  imageSections: readonly SopSection[];
  /** 保留旧版镜像，供预算还原首次导入品牌的默认前言；不能用当前租户镜像替代。 */
  legacyImageSop: string;
  sop: PublishedSop;
  catalog: CatalogSnapshot;
  /** 快照数组本身不带 ord：另存一份 code → ord，applyCatalogRow 按它插到正确位置 */
  ords: Record<CatalogRow['kind'], Map<string, number>>;
  /** 全部条目的全部版本（catalogVersionKey → 版本号 → deep-frozen 的 payload）：方案书按 ?v= 渲染时只读这里，不查库 */
  history: VersionHistory;
}

export interface TenantConfig {
  loaded: Loaded | null;
  dbInstalled: boolean;
  lockState: 'held' | 'lost';
  lockTaken: boolean;
  sopStale: boolean;
  catalogStale: boolean;
  shuttingDown: boolean;
  reacquireMs: number;
  reacquireTimer: NodeJS.Timeout | null;
  catalogListeners: ((snap: CatalogSnapshot) => void)[];
  lockListeners: Set<(ev: LockEvent) => void>;
  catalogWrites: number;
  reloading: Promise<void> | null;
  reloadAgain: boolean;
  reloadBackoff: number[];
}
export function createTenantConfig(): TenantConfig {
  return {
    loaded: null,
    dbInstalled: false,
    lockState: 'held',
    lockTaken: false,
    sopStale: false,
    catalogStale: false,
    shuttingDown: false,
    reacquireMs: 5000,
    reacquireTimer: null,
    catalogListeners: [],
    lockListeners: new Set(),
    catalogWrites: 0,
    reloading: null,
    reloadAgain: false,
    reloadBackoff: [5000, 30000, 120000],
  };
}
