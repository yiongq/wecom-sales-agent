// 租户运行时与作用域（05 R3）。严格策略在启动时固定，运行时增删不能启用回落。
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Buffered } from '../console-api/events.js';
import type { ConsoleEventMap } from '../shared/console-api.js';
import type { MiddlewareHandler } from 'hono';
import type { PackBinding } from '../core/pack-api.js';
import { createTenantConfig, type TenantConfig } from '../config/state.js';
import { profile, type DeployFlags } from '../profile.js';
import type { TenantStore } from '../store.js';
import { createStandardBudget, type TenantBudget } from './budget.js';
export type { TenantConfig, TenantStore, TenantBudget };
export type TenantKind = 'standard' | 'sandbox';

/** 第 18 步在关闭屏障中使用；登记到完成为止，不能提前摘掉。 */
export class InflightRegistry {
  private readonly entries = new Set<Promise<unknown>>();
  private sealed = false;
  seal(): void {
    this.sealed = true;
  }
  track<T>(work: Promise<T> | (() => Promise<T>), maintenance = false): Promise<T> {
    if (this.sealed && !maintenance) {
      if (typeof work !== 'function') void work.catch(() => undefined);
      return Promise.reject(new Error('tenant_closing'));
    }
    const pending = typeof work === 'function' ? work() : work;
    this.entries.add(pending);
    void pending.finally(() => this.entries.delete(pending)).catch(() => undefined);
    return pending;
  }
  get size(): number {
    return this.entries.size;
  }
  async drain(): Promise<void> {
    while (this.entries.size) await Promise.allSettled(this.entries);
  }
}
/** 第 9 步把 console 环接到这里；store 发出方始终在所属租户作用域内。 */
export interface ConsoleEventHub {
  readonly storeEvents: EventEmitter;
  readonly boot: string;
  readonly ring: Buffered[];
  last: number;
  readonly listeners: Set<(event: Buffered) => void>;
  countsOf: (() => ConsoleEventMap['counts']) | null;
  countsTimer: NodeJS.Timeout | null;
  unsubscribe: (() => void) | null;
  timing: { heartbeatMs: number; recheckMs: number; countsDebounceMs: number };
}
export interface TenantRuntime {
  readonly id: string;
  readonly slug: string;
  readonly kind: TenantKind;
  readonly isHost: boolean;
  readonly expiresAt: number | null;
  readonly publicBase: string;
  readonly flags: Readonly<DeployFlags>;
  state: 'serving' | 'closing' | 'closed';
  readonly cancel: AbortSignal;
  readonly inflight: InflightRegistry;
  readonly config: TenantConfig;
  pack: PackBinding;
  readonly store: TenantStore;
  readonly budget: TenantBudget;
  readonly events: ConsoleEventHub;
}
export class TenantScopeMissing extends Error {
  constructor() {
    super('tenant_scope_missing');
    this.name = 'TenantScopeMissing';
  }
}
const als = new AsyncLocalStorage<TenantRuntime>();
// 实例级注册表、启动策略与工厂。工厂延后初始化，配置 CLI 不加载 store 或发送模块。
const registry = new Map<string, TenantRuntime>();
let strict = process.env.APP_ROLE === 'sandbox' || process.env.TENANCY_STRICT === '1';
let fallback: TenantRuntime | undefined;
let storeFactory: ((rt: TenantRuntime) => TenantStore) | undefined;
export function installTenantStoreFactory(factory: (rt: TenantRuntime) => TenantStore): void {
  storeFactory = factory;
}
export function withTenantScope<T>(rt: TenantRuntime, fn: () => T): T {
  return als.run(rt, fn);
}
/** 仅供 testing.ts 建立独立自测进程的默认作用域；生产入口仍用 withTenantScope。 */
export const __tenantTest = Object.freeze({
  missingExpectation: new AsyncLocalStorage<string>(),
  enterScope(rt: TenantRuntime): void {
    als.enterWith(rt);
  },
});
/** 创建异步资源时清空 ALS。EventEmitter / EventTarget 不捕获注册时的 ALS：
 * 同步监听继承发出方；实例回调要在执行时 exit，租户回调要显式进入 owner。 */
export function withoutTenantScope<T>(fn: () => T): T {
  return als.exit(fn);
}
export function scopedRuntime(): TenantRuntime | undefined {
  return als.getStore();
}
export function currentRuntime(): TenantRuntime {
  const rt = als.getStore();
  if (rt) return rt;
  if (strict) throw new TenantScopeMissing();
  return fallback ?? hostRuntime();
}
export function runtimeOf(tenantId: string): TenantRuntime | undefined {
  return registry.get(tenantId);
}
export function tenantRuntimes(): readonly TenantRuntime[] {
  return [...registry.values()];
}
export function registerRuntime(rt: TenantRuntime): void {
  if (registry.has(rt.id)) throw new Error('租户运行时重复登记');
  registry.set(rt.id, rt);
}
export function unregisterRuntime(tenantId: string): void {
  registry.delete(tenantId);
}
export function configureTenancy(opts: { role: 'host' | 'sandbox'; standardCount: number; strict?: boolean }): void {
  strict =
    opts.role === 'sandbox' ||
    process.env.APP_ROLE === 'sandbox' ||
    opts.standardCount !== 1 ||
    opts.strict === true ||
    process.env.TENANCY_STRICT === '1';
}
export interface RuntimeOptions {
  id: string;
  slug: string;
  kind?: TenantKind;
  isHost?: boolean;
  expiresAt?: number | null;
  publicBase?: string;
  flags?: Readonly<DeployFlags>;
}
class Runtime implements TenantRuntime {
  constructor(public identity: RuntimeOptions) {}
  get id(): string {
    return this.identity.id;
  }
  get slug(): string {
    return this.identity.slug;
  }
  get kind(): TenantKind {
    return this.identity.kind ?? 'standard';
  }
  get isHost(): boolean {
    return this.identity.isHost ?? false;
  }
  get expiresAt(): number | null {
    return this.identity.expiresAt ?? null;
  }
  get publicBase(): string {
    return this.identity.publicBase ?? '';
  }
  get flags(): Readonly<DeployFlags> {
    return this.identity.flags ?? profile().flags;
  }
  state: TenantRuntime['state'] = 'serving';
  private readonly controller = new AbortController();
  readonly cancel = this.controller.signal;
  abort(): void {
    this.inflight.seal();
    this.controller.abort(new Error('tenant_closing'));
  }
  readonly inflight = new InflightRegistry();
  readonly config = createTenantConfig();
  pack!: PackBinding;
  readonly budget = createStandardBudget();
  readonly events: ConsoleEventHub = {
    storeEvents: new EventEmitter().setMaxListeners(100),
    boot: randomBytes(6).toString('hex'),
    ring: [],
    last: 0,
    listeners: new Set(),
    countsOf: null,
    countsTimer: null,
    unsubscribe: null,
    timing: { heartbeatMs: 20_000, recheckMs: 50_000, countsDebounceMs: 300 },
  };
  private storage?: TenantStore;
  peekStore(): TenantStore | undefined {
    return this.storage;
  }
  get store(): TenantStore {
    if (!this.storage) {
      if (!storeFactory) throw new Error('会话存储工厂尚未接线');
      this.storage = withTenantScope(this, () => storeFactory!(this));
    }
    return this.storage;
  }
}
export function createTenantRuntime(opts: RuntimeOptions): TenantRuntime {
  return new Runtime({ ...opts });
}
/** R12 取消只发信号；登记的 promise 仍须真正落定。 */
export function cancelTenantRuntime(rt: TenantRuntime): void {
  if (rt instanceof Runtime) rt.abort();
}
/** 停机与删除证明不得为了检查存储而惰性装载文件。 */
export function tenantStoreIfLoaded(rt: TenantRuntime): TenantStore | undefined {
  return rt instanceof Runtime ? rt.peekStore() : undefined;
}
/** 文件兼容宿主在入口显式装载；DB 解析后补身份，保留已读文件数据与后端闭包所属对象。 */
export function hostRuntime(): TenantRuntime {
  if (!fallback) {
    fallback = createTenantRuntime({ id: 'file', slug: '', isHost: true, publicBase: process.env.PUBLIC_BASE_URL ?? '' });
    registerRuntime(fallback);
  }
  return fallback;
}
export function identifyRuntime(rt: TenantRuntime, opts: RuntimeOptions): void {
  if (!(rt instanceof Runtime)) throw new Error('只能在启动时补运行时身份');
  const other = registry.get(opts.id);
  if (other && other !== rt) throw new Error('租户运行时重复登记');
  registry.delete(rt.id);
  rt.identity = { ...rt.identity, ...opts };
  registry.set(rt.id, rt);
}

// 实例级缺作用域观测：不 import 告警模块（否则配置 CLI 会加载渠道与存储）。
const missingListeners = new Set<() => void>();
export function onTenantScopeMissing(fn: () => void): () => void {
  missingListeners.add(fn);
  return () => {
    missingListeners.delete(fn);
  };
}
function reportMissing(): void {
  console.error('[tenancy] tenant_scope_missing');
  withoutTenantScope(() => {
    for (const fn of missingListeners) {
      try {
        fn();
      } catch {
        /* 告警失败不能退出后台入口 */
      }
    }
  });
}
export function backgroundEntry<T>(fn: () => T): T | undefined {
  try {
    // 后台入口必须自己选 owner；调用者或测试夹具的 ALS 不能替它补作用域。
    const result = withoutTenantScope(fn);
    if (result instanceof Promise)
      return result.catch((e: unknown) => {
        if (!(e instanceof TenantScopeMissing)) throw e;
        reportMissing();
        return undefined;
      }) as T;
    return result;
  } catch (e) {
    if (!(e instanceof TenantScopeMissing)) throw e;
    reportMissing();
    return undefined;
  }
}
export function tenantCallback<A extends unknown[], T>(rt: TenantRuntime, fn: (...args: A) => T): (...args: A) => T | undefined {
  return (...args) => backgroundEntry(() => withTenantScope(rt, () => fn(...args)));
}
/** 第 8 步 Host 解析将把选择结果交进来；当前只为单 standard 建作用域，多租户无解析不得回落。 */
export const tenantScopeMiddleware: MiddlewareHandler = async (_c, next) => {
  if (scopedRuntime()) return next();
  const all = tenantRuntimes().filter((rt) => rt.kind === 'standard');
  if (all.length > 1 || (strict && all.length !== 1)) throw new TenantScopeMissing();
  const rt = all[0] ?? hostRuntime();
  await withTenantScope(rt, next);
};
