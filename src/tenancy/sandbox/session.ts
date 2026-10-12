// R10：先在空租户作用域解析 cookie，成功之后才进入运行时；不复用成员认证。
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { csrfFor, type AuthedUser } from '../../auth/session.js';
import { sandboxSessionResolve } from '../../db/repo/sandbox.js';
import type { Db } from '../../db/client.js';
import { runtimeOf, type TenantRuntime } from '../runtime.js';

export const SANDBOX_COOKIE = '__Host-sbx';
export type SandboxSession =
  | { status: 'ok'; token: string; user: AuthedUser; runtime: TenantRuntime; expiresAt: string }
  | { status: 'invalid' | 'expired' | 'unavailable' };

export async function resolveSandboxSession(db: Db, token: string | undefined): Promise<SandboxSession> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 'invalid' };
  const row = await sandboxSessionResolve(db, createHash('sha256').update(token).digest());
  if (row.status !== 'ok') return { status: row.status };
  const runtime = runtimeOf(row.tenantId);
  if (runtime?.kind !== 'sandbox') return { status: 'unavailable' };
  if (runtime.state !== 'serving') return { status: 'expired' };
  return {
    status: 'ok',
    token,
    runtime,
    expiresAt: row.expiresAt,
    user: { userId: row.userId, tenantId: row.tenantId, role: 'owner', displayName: '体验访客', csrf: csrfFor(token) },
  };
}

export function sandboxCookie(token: string, expiresAt: string, now = Date.now()): string {
  return `${SANDBOX_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))}`;
}

export function clearSandboxCookie(c: Context): void {
  c.header('Set-Cookie', sandboxCookie('', new Date(0).toISOString()));
}

export function sandboxSessionOf(c: Context): Extract<SandboxSession, { status: 'ok' }> | undefined {
  return c.get('sandboxSession');
}

export function setSandboxSession(c: Context, session: Extract<SandboxSession, { status: 'ok' }>): void {
  c.set('sandboxSession', session);
  c.set('publicHostRuntime', session.runtime);
}

export function sandboxRefusal(c: Context, status: 'invalid' | 'expired'): Response {
  clearSandboxCookie(c);
  const expired = status === 'expired';
  return c.req.path.startsWith('/api/')
    ? c.json({ error: expired ? 'sandbox_expired' : 'sandbox_required' }, expired ? 410 : 401)
    : c.redirect(expired ? '/try?ended=1' : '/try');
}

/** 页面生成的 sim id 映射到可持久化的 sbx id；已有会话只在当前租户里读取。 */
export function sandboxSimulatorId(id: string): string | null {
  if (/^sim-[0-9a-f]{24,64}$/.test(id)) return `sbx-${id.slice(4)}`;
  if (/^sbx-[0-9a-f]{24,64}$/.test(id)) return id;
  return null;
}

export const SANDBOX_WECHAT_COOKIE = '__Host-sbxw';
export function sandboxWechatCookie(token: string, expiresAt: number, now = Date.now()): string {
  return `${SANDBOX_WECHAT_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiresAt - now) / 1000))}`;
}

/** 链接 cookie 只选择公开页租户，不签发 console 的 owner 身份。 */
export function setSandboxWechatRuntime(c: Context, rt: TenantRuntime): void {
  c.set('publicHostRuntime', rt);
}
