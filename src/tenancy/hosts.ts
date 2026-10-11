// 05 R4：请求 Host 与平台命令共用；只接受主机名（可带端口），不接受 URL 或转发头列表。
import { isIP } from 'node:net';

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
