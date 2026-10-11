// 05 R4：请求 Host 与平台命令共用；只接受主机名（可带端口），不接受 URL 或转发头列表。
import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';
import { currentRuntime, hostRuntime, scopedRuntime, tenantRuntimes, withTenantScope, type TenantRuntime } from './runtime.js';

/** 去端口、去末尾点、转小写；非法 Host 返回 null。IPv6 保留方括号，便于拼绝对链接。 */
export function normalizeHost(raw: string): string | null {
  if (!raw || /[\s/%\\?#@,]/.test(raw)) return null;
  const ipv6 = raw.match(/^\[([^\]]+)\](?::([0-9]+))?$/);
  if (raw.startsWith('[')) {
    if (!ipv6 || isIP(ipv6[1]!) !== 6 || !validPort(ipv6[2])) return null;
    return `[${ipv6[1]!.toLowerCase()}]`;
  }
  const authority = raw.match(/^([^:]+)(?::([0-9]+))?$/);
  if (!authority || !validPort(authority[2])) return null;
  const host = authority[1]!.replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253) return null;
  if (!host.split('.').every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return host;
}

function validPort(port: string | undefined): boolean {
  return port === undefined || (port.length <= 5 && Number(port) <= 65535);
}

// 按运行时对象保存启动快照，不随平台命令的后续修改而变化。
const publicHosts = new WeakMap<TenantRuntime, string>();

export function validatePublicHosts(tenants: readonly { publicHost: string | null; isHost: boolean }[], hostBase: string): void {
  if (tenants.length > 1 && tenants.some((t) => !t.publicHost)) throw new Error('tenant_host_missing');
  const seen = new Set<string>();
  for (const tenant of tenants) {
    if (tenant.publicHost === null) continue;
    const host = normalizeHost(tenant.publicHost);
    if (!host || seen.has(host)) throw new Error('tenant_host_invalid');
    seen.add(host);
    if (tenant.isHost) {
      let base: URL;
      try {
        base = new URL(hostBase);
      } catch {
        throw new Error('tenant_public_base_mismatch');
      }
      if (!/^https?:$/.test(base.protocol) || base.username || base.password || normalizeHost(base.host) !== host)
        throw new Error('tenant_public_base_mismatch');
    }
  }
}

/** 启动装载时调用；runtime 接口保持不变。 */
export function installPublicHost(rt: TenantRuntime, raw: string | null): void {
  if (raw === null) publicHosts.delete(rt);
  else {
    const host = normalizeHost(raw);
    if (!host) throw new Error('tenant_host_invalid');
    publicHosts.set(rt, host);
  }
}

/** 宿主保留现有 PUBLIC_BASE_URL 语义；其他租户只用自己的启动快照。 */
export function publicBase(rt = currentRuntime()): string {
  return (rt.isHost ? (process.env.PUBLIC_BASE_URL ?? rt.publicBase) : rt.publicBase).trim().replace(/\/+$/, '');
}

export function resolveHost(raw: string | undefined): TenantRuntime | undefined {
  const standards = tenantRuntimes().filter((rt) => rt.kind === 'standard');
  if (standards.length === 1) return standards[0]!.state === 'serving' ? standards[0] : undefined;
  const host = raw === undefined ? null : normalizeHost(raw);
  if (!host) return undefined;
  return standards.find((rt) => rt.state === 'serving' && publicHosts.get(rt) === host);
}

/** 公开表中仅宿主拥有的模拟器、旧接口与文件入口。匹配解码后的路径。 */
export function hostOnlyPath(path: string): boolean {
  return (
    /\/(?:admin\.html|chat\.html|kf-qr\.png)\/?$/i.test(path) ||
    /^\/api\/(?:chat|stream(?:\/.*)?|sessions(?:\/.*)?|orders|admin(?:\/.*)?|usage|insights)\/?$/.test(path)
  );
}

export const publicHostMiddleware: MiddlewareHandler = async (c, next) => {
  if (scopedRuntime()) return next(); // 嵌入子应用时沿用外层的选择。
  if (c.req.path === '/healthz') return withTenantScope(hostRuntime(), next);
  // 文件模式 HTTP 自测未运行 boot；真实 DB 进程在开始监听前已装载。
  if (tenantRuntimes().length === 0 && process.env.CONFIG_SOURCE !== 'db' && process.env.APP_ROLE !== 'sandbox') hostRuntime();
  const rt = resolveHost(c.req.header('host'));
  if (!rt || (!rt.isHost && hostOnlyPath(c.req.path))) return c.notFound();
  return withTenantScope(rt, next);
};
