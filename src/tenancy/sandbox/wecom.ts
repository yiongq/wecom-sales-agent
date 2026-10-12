// 05 R21：体验客服实例收件。收件不建会话、不调用模型；第 27 步接绑定派发。
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SandboxWecomRuntime, installSandboxWecomOutbound } from '../../adapters/wecom.js';
import type { KfMessage } from '../../adapters/wecom-state.js';
import type { CallbackQuery } from '../../adapters/wecom-callback.js';
import { readSandboxWecomState, commitSandboxWecomCursor } from '../../db/repo/sandbox-wecom.js';
import type { Db } from '../../db/client.js';
import { alert } from '../../ops/alert.js';
import { computeSignature, decryptWecom, safeEqual } from '../../wecom-crypto.js';
import { sandboxWechatIndex } from './outbound.js';
import { onSendFail } from '../../quota/ledger.js';
import { withTenantScope, withoutTenantScope } from '../runtime.js';
import { sandboxStopped } from './lifecycle.js';
import { SANDBOX_WECOM_NAMES, SandboxStartupError } from './role.js';

interface WecomState {
  cursor: string | null;
  fullSince: Date | string | null;
}
interface Problem {
  endpoint: string;
  errcode: string;
}
interface Failure extends Problem {
  firstAt: number;
  lastAt: number;
}
interface WecomDeps {
  read: () => Promise<WecomState>;
  commit: (cursor: string) => Promise<void>;
  request?: typeof fetch;
  now?: () => number;
  notify?: (failing: boolean, problem?: Problem) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
}

function tag(xml: string, name: string): string | undefined {
  const start = xml.indexOf(`<${name}>`);
  if (start < 0) return undefined;
  const end = xml.indexOf(`</${name}>`, start + name.length + 2);
  if (end < 0) return undefined;
  const value = xml.slice(start + name.length + 2, end);
  return value.startsWith('<![CDATA[') && value.endsWith(']]>') ? value.slice(9, -3) : value;
}

export class SandboxWecom {
  readonly routes = new Hono();
  private readonly api: SandboxWecomRuntime;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly replies = new Map<string, { at: number }>();
  private hourly: number[] = [];
  private cursor: string | null = null;
  private cold = true;
  private full = false;
  private link: string | null = null;
  private lastSyncOkAt: number | null = null;
  private readonly failures = new Map<'ready' | 'pull' | 'send', Failure>();
  private readonly diagnostics = new Map<string, { at: number; count: number }>();
  private readonly tasks = new Set<Promise<void>>();
  private alerted = false;
  private stopping = false;
  private cancelTick: (() => void) | null = null;
  private syncTask: Promise<void> | null = null;
  private tickTask: Promise<void> | null = null;
  private pending = false;
  private pendingToken: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly deps: WecomDeps,
  ) {
    if (!SANDBOX_WECOM_NAMES.every((key) => env[key]?.trim())) throw new SandboxStartupError('sandbox_wecom_partial');
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.api = new SandboxWecomRuntime(
      {
        corpId: env.SANDBOX_WECOM_CORP_ID!,
        secret: env.SANDBOX_WECOM_SECRET!,
        openKfid: env.SANDBOX_WECOM_OPEN_KFID!,
        host: env.SANDBOX_HOST!,
      },
      deps.request,
      this.now,
      () => this.running(),
      (endpoint, errcode) => this.warn(endpoint, errcode),
    );
    this.routes.use('/wecom/callback', bodyLimit({ maxSize: 64 * 1024 }));
    this.routes.get('/wecom/callback', (c) => {
      const msg = this.decrypt(c.req.query(), c.req.query('echostr'));
      return msg === null ? c.notFound() : c.text(msg);
    });
    this.routes.post('/wecom/callback', async (c) => {
      const msg = this.decrypt(c.req.query(), tag(await c.req.text(), 'Encrypt'));
      if (msg === null) return c.text('forbidden', 403);
      const kfid = tag(msg, 'OpenKfId');
      if (kfid && kfid !== this.env.SANDBOX_WECOM_OPEN_KFID) {
        this.warn('callback', 'account_mismatch');
        return c.text('forbidden', 403);
      }
      // 回调不等待 API，成功验签即确认收件；sync 自己捕获错误、实例串行。
      void this.sync(tag(msg, 'Token'));
      return c.text('success');
    });
  }

  private running(): boolean {
    return !this.stopping && !sandboxStopped();
  }

  private decrypt(q: CallbackQuery, encrypted?: string): string | null {
    if (!this.running()) return null;
    if (!encrypted || !q.msg_signature || !q.timestamp || !q.nonce) {
      this.warn('callback', 'query_missing');
      return null;
    }
    try {
      const signature = computeSignature(this.env.SANDBOX_WECOM_TOKEN!, q.timestamp, q.nonce, encrypted);
      if (!safeEqual(signature, q.msg_signature)) {
        this.warn('callback', 'signature_invalid');
        return null;
      }
      const result = decryptWecom(this.env.SANDBOX_WECOM_AES_KEY!, encrypted);
      if (result.receiveId !== this.env.SANDBOX_WECOM_CORP_ID) {
        this.warn('callback', 'receive_id_invalid');
        return null;
      }
      return result.msg;
    } catch {
      this.warn('callback', 'decrypt_invalid');
      return null;
    }
  }

  async start(): Promise<void> {
    const state = await this.deps.read();
    this.cursor = state.cursor;
    this.cold = !this.cursor;
    this.full = state.fullSince !== null;
    installSandboxWecomOutbound(this.api);
    // 凭据占位时 API 失败不拒绝启动，GET 校验完全独立。
    // 首轮 API 在后台跑，慢拉取 / 发送不阻塞 HTTP 监听。
    void this.tick();
    if (this.running())
      this.cancelTick = withoutTenantScope(() => {
        if (this.deps.schedule) return this.deps.schedule(() => void this.tick(), 60_000);
        const timer = setInterval(() => void this.tick(), 60_000);
        timer.unref();
        return () => clearInterval(timer);
      });
  }

  /** 客服链接只在实例内存中；签码步骤可在可用时读取，不进入任何观测投影。 */
  contactLink(): string | null {
    this.notify();
    return this.running() && !this.failures.size && !this.full ? this.link : null;
  }

  health() {
    this.notify();
    return {
      configured: true,
      full: this.full,
      bound: 0,
      lastSyncOkAt: this.lastSyncOkAt === null ? null : new Date(this.lastSyncOkAt).toISOString(),
      failing: this.failures.size > 0,
    };
  }

  /** 日志只接收内部接口名与短错误码；不保留错误原文。每种错误一分钟至多一行。 */
  private warn(endpoint: string, errcode: string): void {
    if (!this.running()) return;
    const key = `${endpoint}:${errcode}`;
    const now = this.now();
    const entry = this.diagnostics.get(key);
    const count = (entry?.count ?? 0) + 1;
    if (entry && now - entry.at < 60_000) {
      entry.count = count;
      return;
    }
    this.diagnostics.set(key, { at: now, count: 0 });
    console.warn(`[sandbox-wecom] interface=${endpoint} errcode=${errcode} count=${count}`);
  }

  private failure(kind: 'ready' | 'pull' | 'send', error: unknown, fallback: Problem): void {
    if (!this.running()) return;
    const value = error as Partial<Problem> | null;
    // 只认本运行时生成的诊断字段；数据库 / fetch 异常原文不进入日志与告警。
    const endpoints = ['gettoken', 'kf/add_contact_way', 'kf/sync_msg', 'kf/send_msg', 'kf/send_msg_on_event'];
    const problem =
      value &&
      endpoints.includes(value.endpoint ?? '') &&
      typeof value.errcode === 'string' &&
      /^(-?\d{1,12}|http_\d{3}|request_failed|missing_token|missing_url)$/.test(value.errcode)
        ? { endpoint: value.endpoint!, errcode: value.errcode }
        : fallback;
    const now = this.now();
    const old = this.failures.get(kind);
    this.failures.set(kind, { ...problem, firstAt: old && now - old.lastAt < 10 * 60_000 ? old.firstAt : now, lastAt: now });
    if (problem === fallback) this.warn(problem.endpoint, problem.errcode);
  }

  private notify(): void {
    if (!this.running()) return;
    const now = this.now();
    for (const [kind, failure] of this.failures) if (now - failure.lastAt >= 10 * 60_000) this.failures.delete(kind);
    const sustained = [...this.failures.values()].find((failure) => now - failure.firstAt >= 10 * 60_000);
    if (sustained && !this.alerted) {
      this.alerted = true;
      this.deps.notify?.(true, sustained);
    } else if (!this.failures.size && this.alerted) {
      this.alerted = false;
      this.deps.notify?.(false);
    }
  }

  tick(): Promise<void> {
    if (!this.running()) return Promise.resolve();
    // 上一拍可能仍在拉取 / 派发；持续失败的告警不等待那条处理链。
    this.notify();
    this.tickTask ??= withoutTenantScope(async () => {
      try {
        if (!this.link) {
          try {
            const link = await this.api.contactWay();
            if (this.running()) {
              this.link = link;
              this.failures.delete('ready');
            }
          } catch (error) {
            this.failure('ready', error, { endpoint: 'kf/add_contact_way', errcode: 'request_failed' });
          }
        }
        try {
          const state = await this.deps.read();
          if (this.running()) this.full = state.fullSince !== null;
        } catch (error) {
          this.failure('pull', error, { endpoint: 'state', errcode: 'read_failed' });
        }
        if (this.link) void this.sync();
        if (this.running()) this.notify();
      } finally {
        this.tickTask = null;
      }
    });
    return this.tickTask;
  }

  sync(token?: string): Promise<void> {
    if (!this.running()) return Promise.resolve();
    this.pending = true;
    if (token !== undefined) this.pendingToken = token;
    this.syncTask ??= withoutTenantScope(async () => {
      try {
        while (this.pending && this.running()) {
          this.pending = false;
          const callbackToken = this.pendingToken;
          this.pendingToken = undefined;
          let more = true;
          while (more && this.running()) {
            const previousCursor = this.cursor;
            const page = await this.api.sync(this.cursor, callbackToken);
            if (!this.running()) return;
            const arrivedAt = this.now();
            const messages = page.msg_list ?? [];
            // 02/03 兼容：空页不带游标时保持原位，结束本次拉取，避免无进展循环。
            if (messages.length && (!page.next_cursor || (page.has_more && page.next_cursor === previousCursor)))
              throw new Error('sandbox_wecom_cursor_invalid');
            if (page.next_cursor) await this.deps.commit(page.next_cursor);
            if (!this.running()) return;
            this.cursor = page.next_cursor || this.cursor;
            this.lastSyncOkAt = this.now();
            this.failures.delete('pull');
            // 先提交再派发，崩溃或发送失败后不重放。
            for (const message of messages) {
              if (!this.running()) return;
              if (message.open_kfid !== this.env.SANDBOX_WECOM_OPEN_KFID) continue;
              if (this.cold && message.send_time * 1000 < this.startedAt - 10 * 60_000) continue;
              this.dispatch(message, arrivedAt);
            }
            more = page.has_more === 1 && !!page.next_cursor && page.next_cursor !== previousCursor;
          }
        }
      } catch (error) {
        this.failure('pull', error, { endpoint: 'cursor', errcode: 'commit_or_page_failed' });
      } finally {
        this.syncTask = null;
        if (this.running()) this.notify();
      }
    });
    return this.syncTask;
  }

  private dispatch(message: KfMessage, arrivedAt: number): void {
    if (message.origin === 4 && message.event?.event_type === 'msg_send_fail') {
      const msgid = message.event.fail_msgid;
      const rt = msgid && sandboxWechatIndex.forReceipt(msgid, this.now());
      if (rt) withTenantScope(rt, () => onSendFail(msgid!, message.event!.fail_type ?? 0));
      else this.warn('receipt', 'unknown_msgid');
      return;
    }
    // 第 27 步绑定发布后接客户对话；未绑定的话术仍在空作用域里发送。
    const entered = message.event?.event_type === 'enter_session';
    if (this.full || (!entered && message.origin !== 3)) return;
    const user = entered ? (message.event?.external_userid ?? message.external_userid) : message.external_userid;
    if (!user) return;
    const now = this.now();
    if (entered && message.event?.welcome_code) sandboxWechatIndex.rememberWelcome(message.event.welcome_code, user, arrivedAt);
    for (const [key, at] of this.replies) if (now - at.at >= 10 * 60_000) this.replies.delete(key);
    this.hourly = this.hourly.filter((at) => now - at < 60 * 60_000);
    const hash = createHash('sha256').update(user).digest('hex');
    if (this.replies.has(hash) || this.hourly.length >= 200) return;
    const reservation = { at: now };
    this.replies.set(hash, reservation);
    this.hourly.push(now);
    const task = this.api
      .replyUnbound(user, entered ? message.event?.welcome_code : undefined)
      .then(() => {
        if (this.running()) this.failures.delete('send');
      })
      .catch((error: unknown) => {
        // 只撤销这次认领，不能删除晚到期间另一个请求的新记录。
        if (this.replies.get(hash) === reservation) this.replies.delete(hash);
        this.failure('send', error, { endpoint: entered ? 'kf/send_msg_on_event' : 'kf/send_msg', errcode: 'request_failed' });
      })
      .finally(() => {
        this.tasks.delete(task);
        if (this.running()) this.notify();
      });
    this.tasks.add(task);
  }

  /** 等实例后台与已派发任务落定；不重放已提交页面。 */
  async drain(): Promise<void> {
    while (this.tickTask || this.syncTask || this.tasks.size) await Promise.allSettled([this.tickTask, this.syncTask, ...this.tasks]);
  }

  stop(): void {
    this.stopping = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.api.stop();
    this.link = null;
    this.replies.clear();
    this.hourly.length = 0;
  }

  async close(): Promise<void> {
    this.stop();
    await this.drain();
  }
}

export function createSandboxWecom(env: NodeJS.ProcessEnv, db: Db, epoch: string): SandboxWecom | null {
  if (!SANDBOX_WECOM_NAMES.some((key) => env[key] !== undefined)) return null;
  return new SandboxWecom(env, {
    read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID!),
    commit: (cursor) => commitSandboxWecomCursor(db, epoch, env.SANDBOX_WECOM_OPEN_KFID!, cursor),
    notify: (failing, problem) =>
      alert(
        'channel',
        failing
          ? `企微账号 sandbox 连续 10 分钟拉取或发送失败 · interface=${problem?.endpoint} errcode=${problem?.errcode}`
          : '企微账号 sandbox 收发已恢复',
        {
          instance: true,
          scope: 'pull:sandbox',
          resolved: !failing,
          escalate: failing,
        },
      ),
  });
}
