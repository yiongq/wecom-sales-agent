// 后台会话（docs/architecture/01-pg-config-console/spec.md「鉴权」）。
// cookie 是 32 字节随机数的 base64url，库里只存它的 sha256；空闲 12 小时、绝对 7 天过期，失效的在下一次被访问时删行。
// 登录只接纳本实例租户（DEFAULT_TENANT_SLUG）的成员。限流都在进程内（单副本），键数到上限按 LRU 淘汰。
import { createHash, randomBytes } from 'node:crypto';
import { configRuntime } from '../config/source.js';
import { withTenant } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { authLoginLookup, authPasswordRehash, authSessionCreate, authSessionDelete, authSessionTouch, type Role } from '../db/repo/auth.js';
import { fakeHash, hashPassword, verifyPassword } from './password.js';

export type { Role } from '../db/repo/auth.js';

export interface AuthedUser {
  userId: string;
  tenantId: string;
  role: Role;
  displayName: string;
  csrf: string;
}

export const IDLE_MS = 12 * 3_600_000;
export const ABSOLUTE_MS = 7 * 24 * 3_600_000;
export const SESSION_COOKIE = '__Host-sid';

/** 登录被限流 → 429。响应体对存在与不存在的邮箱完全相同，限流不能用来探测邮箱 */
export class LoginRateLimitedError extends Error {
  constructor() {
    super('尝试太频繁，请稍后再试');
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** base64url(sha256('csrf:' + token))：从 token 派生，不另外存库 */
export function csrfFor(token: string): string {
  return sha256(`csrf:${token}`).toString('base64url');
}

// ---------------- 限流 ----------------

/** IPv6 按 /64 归桶（一台机器通常拿到整个 /64，按整地址计数等于没限）；IPv4 映射地址还原成 IPv4 */
export function ipBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right] : left;
  return `${full
    .slice(0, 4)
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** 固定窗口计数，键数到上限按 LRU 淘汰最久没碰过的键（Map 的插入顺序就是最近使用顺序） */
class Window {
  private readonly map = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}
  private entry(key: string, now: number): { start: number; count: number } {
    let e = this.map.get(key);
    if (e) this.map.delete(key);
    if (!e || now - e.start >= this.windowMs) e = { start: now, count: 0 };
    this.map.set(key, e);
    if (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value!);
    return e;
  }
  hit(key: string, now: number): number {
    return ++this.entry(key, now).count;
  }
  peek(key: string, now: number): number {
    const e = this.map.get(key);
    return e && now - e.start < this.windowMs ? e.count : 0;
  }
  clear(key: string): void {
    this.map.delete(key);
  }
  reset(): void {
    this.map.clear();
  }
}

const perIp = new Window(60_000);
const failByEmailIp = new Window(15 * 60_000);
const failByEmail = new Window(15 * 60_000);
const invalidCookieByIp = new Window(60_000);
let slowDelayMs = 2_000;

/** 带 cookie 但会话无效的请求：先按 IP 限流（每分钟 60 次），过了才查库。返回 false 表示该拒绝 */
export function allowSessionLookup(ip: string | null, now: number): boolean {
  return invalidCookieByIp.peek(ipBucket(ip), now) < 60;
}
export function noteInvalidSession(ip: string | null, now: number): void {
  invalidCookieByIp.hit(ipBucket(ip), now);
}

// ---------------- 登录、会话、登出 ----------------

/**
 * 登录。未知邮箱、密码错误、账号停用、不是本实例成员，一律返回 null（调用方回同一个 401），耗时也相同。
 * 限流：同一 IP 每分钟最多 10 次；同一「邮箱 + IP」15 分钟内失败 5 次后锁到窗口结束，登录成功时清零；
 * 同一邮箱（不分 IP）15 分钟内失败满 10 次后，每次先延迟 2 秒再校验，不锁死——攻击者锁不住 owner。超限抛 LoginRateLimitedError
 */
export async function login(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  now: number;
}): Promise<{ token: string; user: AuthedUser } | null> {
  const { db, tenantId } = configRuntime();
  const email = input.email.trim().toLowerCase();
  const ip = ipBucket(input.ip);
  const pairKey = `${email}|${ip}`;
  if (perIp.hit(ip, input.now) > 10) throw new LoginRateLimitedError();
  if (failByEmailIp.peek(pairKey, input.now) >= 5) throw new LoginRateLimitedError();
  if (failByEmail.peek(email, input.now) >= 10) await new Promise((r) => setTimeout(r, slowDelayMs));

  const found = await authLoginLookup(db, tenantId, email);
  const { ok, needsRehash } = await verifyPassword(input.password, found?.passwordHash ?? (await fakeHash()));
  if (!found || !ok) {
    failByEmailIp.hit(pairKey, input.now);
    failByEmail.hit(email, input.now);
    return null;
  }
  failByEmailIp.clear(pairKey);
  const token = randomBytes(32).toString('base64url');
  await authSessionCreate(db, {
    tenantId,
    tokenHash: sha256(token),
    userId: found.userId,
    now: new Date(input.now),
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (needsRehash) await authPasswordRehash(db, tenantId, found.userId, found.passwordHash, await hashPassword(input.password));
  await withTenant(db, { tenantId, actor: { kind: 'user', userId: found.userId, name: found.displayName, ip: input.ip } }, (tx) =>
    writeAudit(tx, { action: 'auth.login', targetType: 'user', targetId: found.userId }),
  );
  return { token, user: { userId: found.userId, tenantId, role: found.role, displayName: found.displayName, csrf: csrfFor(token) } };
}

/** 空闲 12 小时或过了 7 天绝对期限、账号停用、已不是成员、租户停用：返回 null（前两种顺带删行） */
export async function resolveSession(token: string, now: number): Promise<AuthedUser | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { db, tenantId } = configRuntime();
  const r = await authSessionTouch(db, tenantId, sha256(token), new Date(now));
  return r ? { userId: r.userId, tenantId, role: r.role, displayName: r.displayName, csrf: csrfFor(token) } : null;
}

/** 登出删行；会话还有效时记一行 auth.logout 审计 */
export async function logout(token: string, now = Date.now()): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  const user = await resolveSession(token, now);
  const { db, tenantId } = configRuntime();
  await authSessionDelete(db, sha256(token));
  if (user) {
    await withTenant(db, { tenantId, actor: { kind: 'user', userId: user.userId, name: user.displayName, ip: null } }, (tx) =>
      writeAudit(tx, { action: 'auth.logout', targetType: 'user', targetId: user.userId }),
    );
  }
}

/** 仅供自测：清空限流计数；把「按邮箱延迟」调短 */
export const __authTest = {
  reset(): void {
    perIp.reset();
    failByEmailIp.reset();
    failByEmail.reset();
    invalidCookieByIp.reset();
    slowDelayMs = 2_000;
  },
  setSlowDelay(ms: number): void {
    slowDelayMs = ms;
  },
};
