// 模块私有状态以 tenantId 分桶，启动补身份时移动桶；工厂只在作用域内访问时运行。
import { currentRuntime, withTenantScope, type TenantRuntime } from './runtime.js';
import type { TenantScopedState } from './state.js';

export function scopedState<S extends object>(factory: () => S, dispose: Partial<{ [K in keyof S]: (value: S[K]) => void }> = {}) {
  const buckets = new Map<string, { rt: TenantRuntime; value: S }>();
  const peek = (rt: TenantRuntime): S | undefined => {
    const current = buckets.get(rt.id);
    if (current?.rt === rt) return current.value;
    // file 宿主在 DB 装载时才获得 uuid，所有已注册的订阅与状态仍属于同一个对象。
    for (const [id, bucket] of buckets)
      if (bucket.rt === rt) {
        if (current) throw new Error('租户状态身份重复');
        buckets.delete(id);
        buckets.set(rt.id, bucket);
        return bucket.value;
      }
    return undefined;
  };
  const get = (): S => {
    const rt = currentRuntime();
    const existing = peek(rt);
    if (existing) return existing;
    if (buckets.has(rt.id)) throw new Error('租户状态身份重复');
    const value = factory();
    buckets.set(rt.id, { rt, value });
    return value;
  };
  const count = (v: unknown): number => {
    if (v instanceof Map || v instanceof Set) return v.size;
    if (Array.isArray(v)) return v.length;
    return Number(v !== null && v !== undefined && v !== false && v !== 0);
  };
  const clear = <K extends keyof S>(rt: TenantRuntime, value: S, key: K): void => {
    withTenantScope(rt, () => dispose[key]?.(value[key]));
    const previous = value[key];
    if (previous instanceof Map || previous instanceof Set) previous.clear();
    else if (Array.isArray(previous) && !Object.isFrozen(previous)) previous.length = 0;
    value[key] = factory()[key];
  };
  const releaseEmpty = (): void => {
    for (const [id, { value }] of buckets) if (Object.values(value).every((v) => count(v) === 0)) buckets.delete(id);
  };
  const registration = <K extends keyof S>(key: K): Omit<TenantScopedState, 'name'> => ({
    keyCount: (id) => [...buckets.values()].filter(({ rt }) => rt.id === id).reduce((n, { value }) => n + count(value[key]), 0),
    drop: (id) => {
      for (const { rt, value } of buckets.values()) if (rt.id === id) clear(rt, value, key);
      releaseEmpty();
    },
    reset: () => {
      for (const { rt, value } of buckets.values()) clear(rt, value, key);
      releaseEmpty();
    },
  });
  return { get, registration, peek, owners: () => [...buckets.values()].map(({ rt }) => rt) };
}
