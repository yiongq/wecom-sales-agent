// 部署与演练共用的 IPv4 网段校验；无依赖，部署前可直接用 Node 执行。
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_UPSTREAM = { subnet: '172.30.250.0/28', appIP: '172.30.250.10', standbyIP: '172.30.250.11' };

function ipv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) throw new Error('上游 IP 必须是规范 IPv4 地址');
  return value.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}
function cidr(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+\/(0|[1-9]\d?)$/.test(value)) throw new Error('上游子网必须是 IPv4 CIDR');
  const [ip, prefix] = value.split('/');
  const bits = Number(prefix);
  if (bits > 32) throw new Error('上游子网 CIDR 前缀无效');
  const address = ipv4(ip);
  const size = 2 ** (32 - bits);
  const start = Math.floor(address / size) * size;
  return { address, start, end: start + size - 1, bits };
}
function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}
export function validateUpstream(subnet, appIP, standbyIP, side = false) {
  const range = cidr(subnet);
  if (range.address !== range.start || range.bits > 29) throw new Error('上游子网须使用网络地址，前缀不大于 /29（保留网关和两个上游）');
  const a = ipv4(appIP),
    b = ipv4(standbyIP);
  if (a === b) throw new Error('两个上游 IP 不能相同');
  for (const ip of [a, b]) {
    // Docker bridge 默认把首个可用地址给网关；网络地址和广播地址也不能分配给 app。
    if (ip <= range.start + 1 || ip >= range.end) throw new Error('上游 IP 必须在子网内，且不能是网络地址、默认网关或广播地址');
  }
  if (side && overlaps(range, cidr(DEFAULT_UPSTREAM.subnet)))
    throw new Error(
      '旁路实例须同时更换 APP_UPSTREAM_SUBNET、APP_UPSTREAM_IP、STANDBY_UPSTREAM_IP，不能与线上默认子网重叠；自定义线上网段还须在服务器核对',
    );
  return { subnet, appIP, standbyIP };
}

export function selectDrillUpstream(networks) {
  if (!Array.isArray(networks)) throw new Error('drill_network_inspect_invalid：无法确认已有 Docker 子网');
  const occupied = [];
  for (const network of networks) {
    const configs = network?.IPAM?.Config;
    if (configs === null) continue; // host/none 等无 IPAM 地址的网络。
    if (!Array.isArray(configs)) throw new Error('drill_network_inspect_invalid：缺少 IPAM.Config');
    for (const config of configs) {
      const subnet = config?.Subnet;
      if (typeof subnet !== 'string') throw new Error('drill_network_inspect_invalid：缺少 Subnet');
      const [address, prefix, extra] = subnet.split('/');
      if (isIP(address) === 6 && /^(0|[1-9]\d*)$/.test(prefix) && Number(prefix) <= 128 && extra === undefined) continue;
      try {
        occupied.push(cidr(subnet));
      } catch {
        throw new Error('drill_network_inspect_invalid：已有子网格式无效');
      }
    }
  }
  // 有限候选池，逐段检查相交（包括已有更大的网段），不删除或改动任何已有网络。
  for (const second of [30, 31]) {
    for (let third = 0; third < 256; third++) {
      const base = `172.${second}.${third}`;
      const subnet = `${base}.0/28`;
      if (!occupied.some((range) => overlaps(cidr(subnet), range))) return validateUpstream(subnet, `${base}.10`, `${base}.11`);
    }
  }
  throw new Error('drill_no_free_subnet：172.30/16、172.31/16 候选池没有可用子网，请检查本机 Docker 网络');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateUpstream(process.argv[2], process.argv[3], process.argv[4], process.argv[5] === '1');
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
