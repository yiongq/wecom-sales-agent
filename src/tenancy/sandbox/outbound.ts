// R11/R21：发送边界与公开页共用进程内解析；绑定事务由第 27 步发布。
import { scopedRuntime, runtimeOf, type TenantRuntime } from '../runtime.js';
import { normalizeHost } from '../hosts.js';
import { registerTenantState } from '../state.js';
import { sandboxStopped } from './lifecycle.js';
import { alert } from '../../ops/alert.js';

export class SandboxSendRefused extends Error {
  constructor() {
    super('sandbox_send_refused');
    this.name = 'SandboxSendRefused';
  }
}

class SandboxWechatIndex {
  private readonly links = new Map<string, { tenant: string; token: string }>();
  private readonly users = new Map<string, string>();
  private readonly welcomes = new Map<string, { user: string; tenant: string | null; at: number }>();
  private readonly receipts = new Map<string, { tenant: string; at: number }>();

  publishLink(rt: TenantRuntime, token: string): void {
    if (rt.kind !== 'sandbox' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('sandbox_link_invalid');
    if (this.live(rt)) this.links.set(rt.id, { tenant: rt.id, token });
  }
  /** 只在提交后调用；改绑开始先 withdraw，两边的旧绑定立即失效。 */
  publishBinding(rt: TenantRuntime, user: string): void {
    if (!this.live(rt)) return;
    this.withdraw(rt.id);
    this.users.delete(user);
    this.users.set(user, rt.id);
  }
  withdraw(tenant: string): void {
    for (const [user, owner] of this.users) if (owner === tenant) this.users.delete(user);
  }
  private live(rt: TenantRuntime | undefined): rt is TenantRuntime {
    return (
      !!rt &&
      runtimeOf(rt.id) === rt &&
      !sandboxStopped() &&
      rt.kind === 'sandbox' &&
      rt.state === 'serving' &&
      (rt.expiresAt ?? 0) > Date.now()
    );
  }
  forUser(user: string): TenantRuntime | undefined {
    const rt = runtimeOf(this.users.get(user) ?? '');
    return this.live(rt) ? rt : undefined;
  }
  forToken(token: string): TenantRuntime | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = [...this.links.values()].find((r) => r.token === token);
    const rt = runtimeOf(row?.tenant ?? '');
    return this.live(rt) ? rt : undefined;
  }
  rememberWelcome(code: string, user: string, now = Date.now()): void {
    this.prune(now);
    // 重复的在途事件不能延长有效期或覆盖已发布归属；消费后发送方法不会重新登记。
    if (!this.welcomes.has(code)) this.welcomes.set(code, { user, tenant: null, at: now });
  }
  assignWelcome(code: string, rt: TenantRuntime): void {
    const row = this.welcomes.get(code);
    if (row && this.forUser(row.user) === rt) row.tenant = rt.id;
  }
  welcomeUser(code: string): string | undefined {
    return this.welcomes.get(code)?.user;
  }
  consumeWelcome(code: string): void {
    this.welcomes.delete(code);
  }
  rememberReceipt(msgid: string, rt: TenantRuntime, now = Date.now()): void {
    this.prune(now);
    this.receipts.set(msgid, { tenant: rt.id, at: now });
  }
  forReceipt(msgid: string, now = Date.now()): TenantRuntime | undefined {
    this.prune(now);
    const rt = runtimeOf(this.receipts.get(msgid)?.tenant ?? '');
    return this.live(rt) ? rt : undefined;
  }
  private prune(now: number): void {
    for (const [key, row] of this.welcomes) if (now - row.at >= 20_000) this.welcomes.delete(key);
    for (const [key, row] of this.receipts) if (now - row.at >= 24 * 60 * 60_000) this.receipts.delete(key);
  }
  /** 同步核对并复制请求体；调用方必须紧接着发 fetch。原正文永不改动。 */
  prepare(endpoint: string, body: Record<string, unknown>, openKfid: string, host: string, now = Date.now()): Record<string, unknown> {
    this.prune(now);
    const rt = scopedRuntime();
    const welcome = typeof body.code === 'string' ? this.welcomes.get(body.code) : undefined;
    const user = endpoint === 'kf/send_msg_on_event' ? welcome?.user : body.touser;
    let allowed =
      !sandboxStopped() && ['kf/send_msg', 'kf/send_msg_on_event'].includes(endpoint) && typeof user === 'string' && user.length > 0;
    if (endpoint === 'kf/send_msg') allowed &&= body.open_kfid === openKfid;
    else allowed &&= !!welcome;
    if (rt) {
      allowed &&= this.live(rt) && typeof user === 'string' && this.forUser(user) === rt && this.links.has(rt.id);
      if (endpoint === 'kf/send_msg_on_event') allowed &&= welcome?.tenant === rt.id;
    } else {
      const content = (body.text as { content?: unknown } | undefined)?.content;
      allowed &&= body.msgtype === 'text' && this.fixedTexts(host).includes(String(content));
      if (welcome) allowed &&= welcome.tenant === null;
    }
    if (!allowed) this.refuse();
    if (!rt) return body;
    const rewritten = this.rewriteLinks(body, this.links.get(rt.id)!.token, host, true) as Record<string, unknown>;
    if (typeof body.msgid === 'string') this.rememberReceipt(body.msgid, rt, now);
    return rewritten;
  }
  refuse(): never {
    console.warn('[sandbox-wecom] sandbox_send_refused');
    alert('sandbox_send_refused', '体验客服发送边界拒绝请求', { instance: true });
    throw new SandboxSendRefused();
  }
  /** 上传与发送使用同一份即时绑定，调用方核对后不得 await 再发请求。 */
  assertUpload(user: string | undefined): void {
    const rt = scopedRuntime();
    if (!this.live(rt) || !user || this.forUser(user) !== rt) this.refuse();
  }
  assertLinks(text: string, host: string): void {
    this.rewriteLinks(text, 'x'.repeat(43), host, true);
  }
  /** 令牌扩展也占 UTF-8 字节；这里只测长度，实际请求体仍在发送边界改写。 */
  textBytes(text: string, host: string): number {
    return Buffer.byteLength(this.rewriteLinks(text, 'x'.repeat(43), host) as string, 'utf8');
  }
  private rewriteLinks(value: unknown, token: string, host: string, strict = false): unknown {
    const base = `https://${host}`;
    const replace = (value: unknown): unknown => {
      if (typeof value === 'string') {
        // 先保留句读与括号，再解析 URL；拒绝无法改写的本站链接，避免裸链接越过发送边界。
        return value.replace(/https?:\/\/[^\s<>"'(),;；、：】」』～。，！？（）【「『[\]］》〉}]+/gi, (raw) => {
          const core = raw.replace(/[；、：】」』～。，.,);:!?！？）\]］》〉}]+$/u, '');
          const suffix = raw.slice(core.length);
          let url: URL;
          try {
            url = new URL(core);
          } catch {
            const authority = /^https?:\/\/(?:[^/@]+@)?([^/?#]+)/i.exec(core)?.[1]?.toLowerCase();
            if (strict && (normalizeHost(authority ?? '') === host || normalizeHost(authority?.replace(/:[^:]*$/, '') ?? '') === host))
              this.refuse();
            return raw;
          }
          if (normalizeHost(url.hostname) !== host) return raw;
          if (url.origin !== base || url.username || url.password || !wxPage(url.pathname)) {
            if (strict) this.refuse();
            return raw;
          }
          return `${base}/wx/${token}${url.pathname}${url.search}${url.hash}${suffix}`;
        });
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
      return value;
    };
    return replace(value);
  }
  fixedTexts(host: string): string[] {
    return [`这是体验客服，去 https://${host}/try 开一个体验，扫页面上的码就能连上`, '这个码过期了，回工作台换一个'];
  }
  keyCount(tenant: string): number {
    return (
      Number(this.links.has(tenant)) +
      [...this.users.values()].filter((id) => id === tenant).length +
      [...this.welcomes.values()].filter((r) => r.tenant === tenant).length +
      [...this.receipts.values()].filter((r) => r.tenant === tenant).length
    );
  }
  drop(tenant: string): void {
    this.links.delete(tenant);
    this.withdraw(tenant);
    for (const [key, row] of this.welcomes) if (row.tenant === tenant) this.welcomes.delete(key);
    for (const [key, row] of this.receipts) if (row.tenant === tenant) this.receipts.delete(key);
  }
  reset(): void {
    this.links.clear();
    this.users.clear();
    this.welcomes.clear();
    this.receipts.clear();
  }
}

/** 只有 R21 的三个公开页及它们的接口；不允许编码路径分隔符、点段或重定向目标。 */
export function wxPage(path: string): boolean {
  return path === '/privacy' || /^\/pay\/[A-Za-z0-9_-]+$/.test(path) || /^\/proposal\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path);
}
export function wxResource(path: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return wxPage(path) || /^\/api\/(?:orders|proposal)\/[A-Za-z0-9_-]+$/.test(path);
  return method === 'POST' && /^\/api\/orders\/[A-Za-z0-9_-]+\/pay$/.test(path);
}
export const sandboxWechatIndex = new SandboxWechatIndex();
registerTenantState({
  name: 'sandbox.wechat',
  keyCount: (id) => sandboxWechatIndex.keyCount(id),
  drop: (id) => sandboxWechatIndex.drop(id),
  reset: () => sandboxWechatIndex.reset(),
});
