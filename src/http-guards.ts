// server.ts 与后台子应用（src/console-api/app.ts）共用的 HTTP 防护：跨站写保护、客户端地址、按 IP 的限流。
// 从 server.ts 原样搬出，行为不变；查询限流是一个进程内的计数桶，两边挂的是同一个。
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { numEnv } from './env.js';

/**
 * 跨站写保护。管理面走 HTTP Basic，浏览器会给任何跨站请求自动带上缓存的凭据——
 * 一个自动提交的表单就能让已登录的顾问向真实客户发出任意消息，或把会话永久转人工。
 * 同源 fetch 一定带 Sec-Fetch-Site: same-origin；缺这个头的（curl、老浏览器）放行，
 * 因为真正的跨站攻击载体一定是现代浏览器，它一定会带。
 */
export function isCrossSite(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
}
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (isCrossSite(c)) {
    return c.json({ error: '跨站请求已拒绝' }, 403);
  }
  return next();
};

// 靠 ID 访问的公开端点（订单、访客会话、SSE）也要限流，否则 ID 可以被慢慢穷举
const LOOKUP_RATE_PER_MIN = Math.max(1, numEnv('LOOKUP_RATE_PER_MIN', 60));
// 键的总量上限，防止「每请求换一个 IP」把内存打爆；
// 超过上限就退化成全局限流（宁可误伤也不能被打挂）。
const RATE_MAX_KEYS = 10_000;

/**
 * 限流键 = 客户端真实来源地址。
 *
 * 两条都要卡住，少一条限流就形同虚设：
 * 1. 不能取 XFF 的**第一段**——那一段完全由客户端写，换一个假 IP 就是换一个新桶
 *    （实测放行量约 20 万/分钟）。反代（Caddy）是把真实对端**追加**到 XFF 末尾的，
 *    所以真实地址在从右往左数第 TRUST_PROXY_HOPS 跳。
 * 2. XFF 本身也只在「直连对端确实是我们的反代」时才可信。否则把服务直接暴露出去
 *    （或本地 pnpm dev）时，攻击者自己捏一个 XFF 就又绕过去了——线上 Caddy 反代到
 *    127.0.0.1，容器看到的对端是内网地址，据此判定。公网直连的请求一律按 socket 地址算。
 */
const TRUST_PROXY_HOPS = Math.max(0, numEnv('TRUST_PROXY_HOPS', 1));
// peer 已剥掉 ::ffff: 前缀，这里只需匹配裸 IPv4 与真 IPv6 私网
const PRIVATE_PEER = /^(?:127\.|::1$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd])/i;

export function clientKey(c: Context): string {
  let peer = '';
  try {
    // 双栈监听（serve() 不传 hostname → Node 绑 ::）下，IPv4 对端会以
    // ::ffff:172.17.0.1 这种形式出现。不剥掉前缀，下面的私网判定就只认裸 IPv4——
    // 线上正是 Docker 网关 172.17.0.1，结果 XFF 永不被采信、全站退化成一个限流桶。
    peer = (getConnInfo(c).remote.address ?? '').replace(/^::ffff:/i, '');
  } catch {
    /* 拿不到对端地址就退回 XFF 末段 */
  }
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const viaProxy = peer === '' || PRIVATE_PEER.test(peer);
  if (viaProxy && TRUST_PROXY_HOPS > 0 && chain.length) {
    return chain[Math.max(0, chain.length - TRUST_PROXY_HOPS)];
  }
  return peer || chain[chain.length - 1] || 'direct';
}

/** 独立命名的滑动窗口计数桶（聊天与查询各自一套，互不挤占） */
export function makeLimiter(perMin: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      const recent = v.filter((t) => now - t < 60_000);
      if (recent.length) hits.set(k, recent);
      else hits.delete(k);
    }
  }, 5 * 60_000).unref();
  return (key: string): boolean => {
    const now = Date.now();
    const k = hits.has(key) || hits.size < RATE_MAX_KEYS ? key : '__overflow__';
    const recent = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMin) {
      hits.set(k, recent);
      return true;
    }
    recent.push(now);
    hits.set(k, recent);
    return false;
  };
}

const lookupRateLimited = makeLimiter(LOOKUP_RATE_PER_MIN);

/** 挂在靠 ID 访问的公开端点前，让穷举 ID 的成本不可承受 */
export const lookupLimit: MiddlewareHandler = async (c, next) => {
  if (lookupRateLimited(clientKey(c))) return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  return next();
};
