// R11/R21/R22：发送边界与公开页共用进程内解析；绑定提交后才发布。
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
  private readonly codes = new Map<string, { tenant: string; expiresAt: number }>();
  private readonly issued = new Map<string, number[]>();
  private serial: Promise<void> = Promise.resolve();
  private available = false;
  private full = false;
  private readonly links = new Map<string, { tenant: string; token: string }>();
  private readonly users = new Map<string, string>();
  private readonly boundAt = new Map<string, bigint>();
  private readonly quarantined = new Map<string, { users: Set<string>; codes: Set<string> }>();
  private readonly bindingUsers = new Map<string, Set<Promise<void>>>();
  private readonly welcomes = new Map<string, { user: string; tenant: string | null; at: number }>();
  private readonly receipts = new Map<string, { tenant: string; at: number }>();

  exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.serial.then(work);
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  async drain(): Promise<void> {
    await this.serial;
  }
  beginBinding(users: string[]): () => void {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const user of users) {
      const tasks = this.bindingUsers.get(user) ?? new Set();
      tasks.add(pending);
      this.bindingUsers.set(user, tasks);
    }
    return () => {
      for (const user of users) {
        const tasks = this.bindingUsers.get(user);
        tasks?.delete(pending);
        if (!tasks?.size) this.bindingUsers.delete(user);
      }
      finish();
    };
  }
  async awaitBinding(user: string): Promise<void> {
    while (this.bindingUsers.has(user)) await Promise.all(this.bindingUsers.get(user) ?? []);
  }
  /** 提交回执不确定且重读失败：三张解析表一起撤下，不能猜测授权。 */
  quarantine(tenant: string, users: string[] = []): void {
    const blocked = this.quarantined.get(tenant) ?? { users: new Set<string>(), codes: new Set<string>() };
    for (const [user, owner] of this.users) if (owner === tenant) blocked.users.add(user);
    users.forEach((user) => blocked.users.add(user));
    for (const [hash, row] of this.codes) if (row.tenant === tenant) blocked.codes.add(hash);
    this.quarantined.set(tenant, blocked);
    this.clearCode(tenant);
    this.links.delete(tenant);
    this.withdraw(tenant);
    for (const [key, row] of this.welcomes) if (row.tenant === tenant) this.welcomes.delete(key);
    for (const [key, row] of this.receipts) if (row.tenant === tenant) this.receipts.delete(key);
  }
  isQuarantined(tenant?: string, user?: string, hash?: string): boolean {
    return (
      (!!tenant && this.quarantined.has(tenant)) ||
      [...this.quarantined.values()].some((entry) => (!!user && entry.users.has(user)) || (!!hash && entry.codes.has(hash)))
    );
  }
  restore(tenant: string): void {
    this.quarantined.delete(tenant);
  }
  setAvailability(available: boolean, full: boolean): void {
    this.available = available;
    this.full = full;
  }
  wechatState(rt: TenantRuntime): 'off' | 'full' | 'unbound' | 'bound' {
    if (!this.available && !this.full) return 'off';
    if (this.boundUser(rt)) return 'bound';
    return this.full ? 'full' : this.available ? 'unbound' : 'off';
  }
  boundUser(rt: TenantRuntime): string | undefined {
    if (!this.live(rt)) return undefined;
    return [...this.users].find(([, id]) => id === rt.id)?.[0];
  }
  boundCount(): number {
    return [...this.users.keys()].filter((u) => this.forUser(u)).length;
  }
  code(hash: string): { runtime: TenantRuntime | undefined; expiresAt: number } | undefined {
    const row = this.codes.get(hash);
    return row && { runtime: runtimeOf(row.tenant), expiresAt: row.expiresAt };
  }
  publishCode(rt: TenantRuntime, hash: string, expiresAt: number): void {
    if (!this.live(rt)) return;
    this.clearCode(rt.id);
    this.codes.set(hash, { tenant: rt.id, expiresAt });
  }
  clearCode(tenant: string): void {
    for (const [hash, row] of this.codes) if (row.tenant === tenant) this.codes.delete(hash);
  }
  canIssue(rt: TenantRuntime, now: number): boolean {
    const times = (this.issued.get(rt.id) ?? []).filter((at) => now - at < 3600_000);
    this.issued.set(rt.id, times);
    return times.length < 10;
  }
  recordIssue(rt: TenantRuntime, now: number): void {
    this.issued.get(rt.id)?.push(now);
  }

  publishLink(rt: TenantRuntime, token: string): void {
    if (rt.kind !== 'sandbox' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('sandbox_link_invalid');
    if (this.live(rt)) this.links.set(rt.id, { tenant: rt.id, token });
  }
  /** 只在提交后调用；改绑开始先 withdraw，两边的旧绑定立即失效。 */
  publishCommittedBinding(rt: TenantRuntime, user: string, at = BigInt(Date.now()) * 1000n): void {
    if (!this.live(rt)) return;
    this.withdraw(rt.id);
    this.users.delete(user);
    this.users.set(user, rt.id);
    this.boundAt.set(user, at);
  }
  publishRebuiltBinding(rt: TenantRuntime, user: string, at: bigint): void {
    const previous = this.forUser(user);
    if (previous && previous !== rt) {
      console.warn('[sandbox-wecom] duplicate_binding_older_ignored');
      const previousAt = this.boundAt.get(user) ?? 0n;
      if (previousAt > at || (previousAt === at && previous.id > rt.id)) return;
    }
    this.publishCommittedBinding(rt, user, at);
  }
  /** 第 29 步之前既有自测的直接发布钩子；生产只发布已提交 / 重建的行。 */
  publishBinding(rt: TenantRuntime, user: string): void {
    this.publishCommittedBinding(rt, user);
  }
  withdraw(tenant: string): void {
    for (const [user, owner] of this.users)
      if (owner === tenant) {
        this.users.delete(user);
        this.boundAt.delete(user);
      }
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
  /** 先固化、改写，再核对最终字节的纯数据副本；fetch 必须原封不动发送返回值。 */
  prepare(endpoint: string, original: Record<string, unknown>, openKfid: string, host: string, now = Date.now()): string {
    this.prune(now);
    const rt = scopedRuntime();
    let bytes: string;
    let body: Record<string, unknown>;
    try {
      // getter / toJSON 只在核对前执行；后面不再读取原对象。
      const snapshot: unknown = JSON.parse(JSON.stringify(original));
      const rewritten = rt ? this.rewriteLinks(snapshot, this.links.get(rt.id)?.token ?? '', host, true) : snapshot;
      bytes = JSON.stringify(rewritten);
      body = JSON.parse(bytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) this.refuse();
    } catch (error) {
      if (error instanceof SandboxSendRefused) throw error;
      this.refuse();
    }
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
    this.assertFinalLinks(bytes, host, rt ? this.links.get(rt.id)!.token : undefined);
    if (rt && typeof body.msgid === 'string') this.rememberReceipt(body.msgid, rt, now);
    return bytes;
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
    const token = 'x'.repeat(43);
    this.assertFinalLinks(JSON.stringify(this.rewriteLinks(text, token, host, true)), host, token);
  }
  /** 与 URL 提取无关的最终检查：字段名、正文、卡片及所有嵌套字符串都扫描。 */
  private assertFinalLinks(bytes: string, host: string, token?: string): void {
    const base = `https://${host}`;
    const protectedHosts = new Set([host]);
    // 主站链接仅用于 /try 网页导航，不属于体验客服的出站文案。
    if (process.env.PUBLIC_BASE_URL) {
      try {
        const mainHost = normalizeHost(new URL(process.env.PUBLIC_BASE_URL).hostname);
        if (mainHost) protectedHosts.add(mainHost);
      } catch {
        /* 启动配置检查负责非法 PUBLIC_BASE_URL。 */
      }
    }
    const scan = (value: unknown): void => {
      if (typeof value === 'string') {
        // 白名单只能在原始、精确的形式上匹配；解码后的别名不能借白名单放行。
        let rest = value === this.fixedTexts(host)[0] ? value.replace(`${base}/try`, '/try') : value;
        rest = rest.replace(/https?:\/\/[^\s<>"'(),;；、：】」』～。，！？（）【「『[\]］》〉}]+/gi, (raw) => {
          const core = raw.replace(/[；、：】」』～。，.,);:!?！？）\]］》〉}]+$/u, '');
          if (!token || !core.startsWith(`${base}/wx/${token}/`)) return raw;
          let url: URL;
          try {
            url = new URL(core);
          } catch {
            return raw;
          }
          const page = url.pathname.slice(`/wx/${token}`.length);
          // 逐项写死三种公开页；精确 origin、当前令牌、路径及序列化结果均须相同。
          const allowed =
            page === '/privacy' || /^\/pay\/[A-Za-z0-9_-]+$/.test(page) || /^\/proposal\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(page);
          if (!allowed || core !== `${base}${url.pathname}${url.search}${url.hash}`) return raw;
          // 只去掉获准的 origin；query/hash 里夹带的 Host 仍然必须检查。
          return raw.slice(base.length);
        });
        // JSON.parse 已解开真实 JSON 转义；同时检查正文里的字面转义与多层百分号编码。
        for (;;) {
          const decoded = rest
            .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\([\\/])/g, '$1')
            .replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
              try {
                return decodeURIComponent(encoded);
              } catch {
                return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
              }
            })
            .normalize('NFKC')
            .replace(/[。．｡]/g, '.');
          if (decoded === rest) break;
          rest = decoded;
        }
        const folded = rest.toLowerCase();
        for (const protectedHost of protectedHosts) if (folded.includes(protectedHost)) this.refuse();
      } else if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          scan(key);
          scan(item);
        }
      }
    };
    scan(JSON.parse(bytes));
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
          if (core !== `${base}${url.pathname}${url.search}${url.hash}` || url.username || url.password || !wxPage(url.pathname)) {
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
      Number(this.quarantined.has(tenant)) +
      Number(this.links.has(tenant)) +
      Number(this.issued.has(tenant)) +
      [...this.codes.values()].filter((r) => r.tenant === tenant).length +
      [...this.users.values()].filter((id) => id === tenant).length +
      [...this.welcomes.values()].filter((r) => r.tenant === tenant).length +
      [...this.receipts.values()].filter((r) => r.tenant === tenant).length
    );
  }
  drop(tenant: string): void {
    this.quarantined.delete(tenant);
    this.clearCode(tenant);
    this.issued.delete(tenant);
    this.links.delete(tenant);
    this.withdraw(tenant);
    for (const [key, row] of this.welcomes) if (row.tenant === tenant) this.welcomes.delete(key);
    for (const [key, row] of this.receipts) if (row.tenant === tenant) this.receipts.delete(key);
  }
  reset(): void {
    this.quarantined.clear();
    this.codes.clear();
    this.issued.clear();
    this.available = false;
    this.full = false;
    this.links.clear();
    this.users.clear();
    this.boundAt.clear();
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
