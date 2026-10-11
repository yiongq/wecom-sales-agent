// 仅供独立 tsx 自测和 eval：在租户状态访问之前建立夹具作用域。
// 作用域随进程结束；子进程须自行接线，并发多租户仍用 withTenantScope。
import { __tenantTest, type TenantRuntime } from './runtime.js';

export function enterTenantScopeForTest(rt: TenantRuntime): void {
  __tenantTest.enterScope(rt);
}
