// 11 R4：租户配置地址的唯一网络出口。错误只携带码，不保留 Node 的原始错误。
import { Resolver as DnsResolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export interface EgressRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
  deadline: number;
  maxBytes: number;
}

export type EgressCode =
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'host'
  | 'blocked_address'
  | 'dns'
  | 'timeout'
  | 'too_large'
  | 'redirect'
  | 'network';

export class EgressError extends Error {
  constructor(public readonly code: EgressCode) {
    super(code);
    this.name = 'EgressError';
  }
}

/** c-ares 的两个查询方法；测试可注入同形状的解析器，不使用系统 lookup。 */
export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

function ipNumber(address: string): bigint {
  if (isIP(address) === 4) return address.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
  // resolve6 也可能给出带点分尾部的合法 IPv6。
  const expanded = address.replace(/\d+\.\d+\.\d+\.\d+$/, (tail) => {
    const n = ipNumber(tail);
    return `${(n >> 16n).toString(16)}:${(n & 65535n).toString(16)}`;
  });
  const [left, right] = expanded.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const parts = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b];
  return parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}

function inRange(n: bigint, base: string, bits: number, width: number): boolean {
  const shift = BigInt(width - bits);
  return n >> shift === ipNumber(base) >> shift;
}

const V4_DENY = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;
const V6_DENY = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const;

function loopback(address: string): boolean {
  const family = isIP(address);
  return (family === 4 && inRange(ipNumber(address), '127.0.0.0', 8, 32)) || (family === 6 && ipNumber(address) === 1n);
}

function allowed(address: string, allowLoopback: boolean, httpOnly: boolean): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (allowLoopback && loopback(address)) return true;
  if (httpOnly) return false;
  const n = ipNumber(address);
  if (family === 4) return !V4_DENY.some(([base, bits]) => inRange(n, base, bits, 32));
  return inRange(n, '2000::', 3, 128) && !V6_DENY.some(([base, bits]) => inRange(n, base, bits, 128));
}

function parseBaseUrl(raw: string, allowLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('host');
  }
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:')) throw new EgressError('scheme');
  if (url.username || url.password) throw new EgressError('userinfo');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const name = host.replace(/\.$/, '').toLowerCase();
  if (!host || name === 'localhost' || name.endsWith('.localhost') || url.href.includes('?') || url.href.includes('#')) {
    throw new EgressError('host');
  }
  const literal = isIP(host);
  if (literal && !allowed(host, allowLoopback, url.protocol === 'http:')) throw new EgressError('blocked_address');
  if (!(allowLoopback && (!literal || loopback(host))) && !['443', '8443', '8069'].includes(url.port || '443')) {
    throw new EgressError('port');
  }
  return url;
}

export function normalizeBaseUrl(raw: string): { ok: true; url: string } | { ok: false; code: EgressCode } {
  try {
    return { ok: true, url: parseBaseUrl(raw).href.replace(/\/+$/, '') };
  } catch (error) {
    return { ok: false, code: error instanceof EgressError ? error.code : 'host' };
  }
}

export function createEgress(baseUrl: string, opts?: { allowLoopback?: true; resolver?: Resolver }) {
  const url = parseBaseUrl(baseUrl, opts?.allowLoopback);
  const plain = url.protocol === 'http:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // timeout 由 Agent 管：空闲时取它与服务端 Keep-Alive 提示里较短的一个，到点关闭；请求时限另有计时器。
  const keepAlive = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30_000 };
  const agent = plain ? new http.Agent(keepAlive) : new https.Agent({ ...keepAlive, rejectUnauthorized: true, minVersion: 'TLSv1.2' });

  // Agent 在同一 origin 的旧 socket 关闭后，可能沿用它的 options 为排队请求建连接。
  // lookup 必须是实例级的稳定函数，不能闭包引用某次请求的完成状态。
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const own = opts?.resolver ? undefined : new DnsResolver({ timeout: 500, tries: 1 });
    const resolver = opts?.resolver ?? own!;
    let done = false;
    const complete = (code?: EgressCode, addresses: { address: string; family: number }[] = []) => {
      if (done) return;
      done = true;
      clearTimeout(dnsTimer);
      own?.cancel();
      if (code) callback(new EgressError(code), []);
      else if (options.all) callback(null, addresses);
      else {
        const first = addresses.find((a) => !options.family || a.family === options.family);
        if (first) callback(null, first.address, first.family);
        else callback(new EgressError('dns'), []);
      }
    };
    const dnsTimer = setTimeout(() => complete('dns'), 500);
    const query = async (family: 4 | 6) => {
      try {
        const addresses = await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host));
        if (addresses.some((address) => isIP(address) !== family)) throw new EgressError('dns');
        return addresses.map((address) => ({ address, family }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
        throw new EgressError('dns');
      }
    };
    // 两族任意一族失败都不能把另一族交给连接；全部地址先校验再回调。
    void Promise.all([query(4), query(6)])
      .then((families) => {
        const addresses = families.flat();
        if (!addresses.length) return complete('dns');
        if (addresses.some(({ address }) => !allowed(address, !!opts?.allowLoopback, plain))) return complete('blocked_address');
        if (!addresses.every(({ address }) => loopback(address)) && !['443', '8443', '8069'].includes(url.port || '443')) {
          return complete('port');
        }
        complete(undefined, addresses);
      })
      .catch(() => complete('dns'));
  };

  return (req: EgressRequest): Promise<{ status: number; mediaType: string | null; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const remaining = req.deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return reject(new EgressError('timeout'));
      let request: http.ClientRequest | undefined;
      let response: http.IncomingMessage | undefined;
      let settled = false;
      const finish = (code?: EgressCode, result?: { status: number; mediaType: string | null; body: Buffer }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code) {
          response?.destroy();
          request?.destroy();
          reject(new EgressError(code));
        } else resolve(result!);
      };
      const timer = setTimeout(() => finish('timeout'), Math.min(remaining, 2_147_483_647));
      try {
        if (!Number.isSafeInteger(req.maxBytes) || req.maxBytes < 0) return finish('too_large');
        request = (plain ? http : https).request(
          {
            protocol: url.protocol,
            hostname: host,
            port: url.port || (plain ? 80 : 443),
            path: url.pathname.replace(/\/+$/, '') + req.path,
            method: 'POST',
            headers: req.headers,
            agent,
            lookup,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          },
          (res) => {
            response = res;
            if (settled) return res.destroy();
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) return finish('redirect');
            const length = res.headers['content-length'];
            if (length !== undefined && Number(length) > req.maxBytes) return finish('too_large');
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > req.maxBytes) finish('too_large');
              else chunks.push(chunk);
            });
            res.on('error', () => finish('network'));
            res.on('aborted', () => finish('network'));
            res.on('end', () => {
              if (Date.now() >= req.deadline) return finish('timeout');
              finish(undefined, {
                status,
                mediaType: res.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null,
                body: Buffer.concat(chunks),
              });
            });
          },
        );
        request.on('error', (error) => finish(error instanceof EgressError ? error.code : 'network'));
        request.end(req.body);
      } catch {
        finish('network');
      }
    });
}
