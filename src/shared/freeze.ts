// 递归冻结（01 spec「产品库 · 快照」）：loadRoutes() / loadHotels() 返回的对象两种模式下都冻结，
// 漏网的原地修改在测试里当场抛 TypeError，而不是悄悄改掉下一轮看到的产品库。返回同一个引用。
// 已冻结的对象也要往下走：它的子对象未必冻结了。用 seen 防环
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    Object.freeze(v);
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return value;
}
