// 租户状态登记表（05 R5）：计数、删除证明与评测重置共用同一份登记。
export interface TenantScopedState {
  name: string;
  keyCount(tenantId: string): number;
  drop(tenantId: string): void;
  reset(): void;
}
const states = new Map<string, TenantScopedState>();
export function registerTenantState(s: TenantScopedState): void {
  // 模块重载可以重新接线同名能力；状态本身仍在同一个租户运行时上。
  states.set(s.name, s);
}
export function tenantKeys(tenantId: string): Record<string, number> {
  return Object.fromEntries([...states].map(([name, s]) => [name, s.keyCount(tenantId)]));
}
export function dropTenantState(tenantId: string): void {
  for (const s of states.values()) s.drop(tenantId);
}
export function resetTenantState(): void {
  for (const s of states.values()) s.reset();
}
