// 05 R21/R22：体验客服收件、绑定派发与名额状态；未绑定路径不建会话、不调用模型。
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SandboxWecomRuntime, installSandboxWecomOutbound } from '../../adapters/wecom.js';
import type { KfMessage } from '../../adapters/wecom-state.js';
export type { KfMessage } from '../../adapters/wecom-state.js';
import type { CallbackQuery } from '../../adapters/wecom-callback.js';
import { readSandboxWecomState, commitSandboxWecomCursor, markSandboxWecomFull } from '../../db/repo/sandbox-wecom.js';
import type { Db } from '../../db/client.js';
import { alert } from '../../ops/alert.js';
import { computeSignature, decryptWecom, safeEqual } from '../../wecom-crypto.js';
import { sandboxWechatIndex, SandboxSendRefused } from './outbound.js';
import { onSendFail } from '../../quota/ledger.js';
import { withTenantScope, withoutTenantScope, type TenantRuntime } from '../runtime.js';
import { SandboxWechatBinding, SandboxWechatError } from './binding.js';
import { todayIso } from '../../env.js';
import { sandboxStopped } from './lifecycle.js';
import { SANDBOX_WECOM_NAMES, SandboxStartupError } from './role.js';
import { configRuntime } from '../../config/source.js';
import { authLoginLookup } from '../../db/repo/auth.js';
import { getSession, flushSession } from '../../store.js';
import { ConsentDeclinedError, release } from '../../handoff/takeover.js';

interface WecomState {
  cursor: string | null;
  fullSince: Date | string | null;
  fullRevision?: string;
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
  binding?: SandboxWechatBinding;
  markFull?: () => Promise<void>;
  notifyFull?: () => void;
  touch?: (rt: TenantRuntime) => void;
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
  private fullPending = false;
  private fullRevision = 0;
  private readonly fullTasks = new Map<number, Promise<void>>();
  private persistedFullRevision: string | undefined;
  private readonly seen = new Map<string, number>();
  private stateTask: Promise<void> | null = null;
  private recoveryStartedAt: number | null = null;
  private recoveryLastFailureAt: number | null = null;
  private recoveryQuarantinedSince: number | null = null;
  private recoveryFailing = false;
  private recoveryAlerted = false;
  private fullAlertDay = '';
  private readonly users = new Map<string, Promise<void>>();
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
      (endpoint, errcode, expectedRejection) => {
        if (endpoint === 'gettoken' && errcode !== '0')
          this.failure('ready', { endpoint, errcode }, { endpoint, errcode: 'request_failed' });
        if (['kf/send_msg', 'kf/send_msg_on_event'].includes(endpoint)) {
          if (errcode === '0') {
            this.failures.delete('send');
            return;
          }
          if (!expectedRejection && !['42001', '40014', '95003'].includes(errcode))
            this.failure('send', { endpoint, errcode }, { endpoint, errcode: 'request_failed' });
        }
        this.warn(endpoint, errcode);
        if (errcode === '95003' && this.running()) {
          this.full = true;
          this.fullRevision++;
          this.fullPending = true;
          this.publishAvailability();
          this.notifyFull();
          void this.persistFull();
        }
      },
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
    await this.deps.binding?.rebuild();
    const state = await this.deps.read();
    this.cursor = state.cursor;
    this.cold = !this.cursor;
    this.full = state.fullSince !== null;
    this.persistedFullRevision = state.fullRevision;
    if (this.full) this.fullAlertDay = todayIso();
    this.publishAvailability();
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
    return this.running() && !this.failures.has('ready') && !this.full ? this.link : null;
  }

  issueCode(rt: TenantRuntime) {
    if (this.full) return Promise.reject(new SandboxWechatError(409, 'sandbox_wecom_full'));
    if (!this.deps.binding) return Promise.reject(new SandboxWechatError(503, 'sandbox_wecom_unavailable'));
    return this.deps.binding.issue(
      rt,
      () => this.contactLink(),
      () => this.full,
    );
  }
  private publishAvailability(): void {
    sandboxWechatIndex.setAvailability(this.running() && !!this.link && !this.failures.has('ready'), this.full);
  }
  private notifyFull(): void {
    const day = todayIso();
    if (this.full && this.fullAlertDay !== day) {
      this.fullAlertDay = day;
      this.deps.notifyFull?.();
    }
  }
  private persistFull(): Promise<void> {
    if (!this.running() || !this.fullPending) return Promise.resolve();
    const revision = this.fullRevision;
    const existing = this.fullTasks.get(revision);
    if (existing) return existing;
    const task = withoutTenantScope(async () => {
      try {
        await this.deps.markFull?.();
        if (revision === this.fullRevision) this.fullPending = false;
      } catch {
        this.warn('state', 'full_write_failed');
      } finally {
        this.fullTasks.delete(revision);
      }
    });
    this.fullTasks.set(revision, task);
    return task;
  }

  /** R22：体验客服独立、单飞的定时任务重读状态，避免迟到的旧快照覆盖新状态。 */
  refreshFull(): Promise<void> {
    if (!this.running()) return Promise.resolve();
    if (this.stateTask) return this.stateTask;
    this.recoveryStartedAt = this.now();
    this.stateTask ??= withoutTenantScope(async () => {
      // 先登记单飞与开始时刻，健康检查无需等待恢复链。
      await Promise.resolve();
      try {
        await this.deps.binding?.refresh();
        await this.persistFull();
        const revision = this.fullRevision;
        const state = await this.deps.read();
        if (this.running() && !this.fullPending && revision === this.fullRevision) {
          if (state.fullRevision !== this.persistedFullRevision) this.fullRevision++;
          this.persistedFullRevision = state.fullRevision;
          this.full = state.fullSince !== null;
        }
      } catch (error) {
        this.recoveryLastFailureAt = this.now();
        this.failure('pull', error, { endpoint: 'state', errcode: 'read_failed' });
      } finally {
        this.stateTask = null;
        this.recoveryStartedAt = null;
        if (this.running()) this.notify();
      }
    });
    return this.stateTask;
  }

  health() {
    this.notify();
    return {
      configured: true,
      full: this.full,
      bound: sandboxWechatIndex.boundCount(),
      lastSyncOkAt: this.lastSyncOkAt === null ? null : new Date(this.lastSyncOkAt).toISOString(),
      failing: this.failures.size > 0 || this.recoveryFailing,
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
    if (kind === 'send' && problem.errcode === '95003') return;
    const now = this.now();
    const old = this.failures.get(kind);
    this.failures.set(kind, { ...problem, firstAt: old && now - old.lastAt < 10 * 60_000 ? old.firstAt : now, lastAt: now });
    if (problem === fallback) this.warn(problem.endpoint, problem.errcode);
  }

  private notify(): void {
    if (!this.running()) return;
    const now = this.now();
    const recovery = this.deps.binding?.recoveryStatus();
    // 两次观测之间已经解除隔离再失败，也应视为新的一段。
    if (recovery && this.recoveryQuarantinedSince !== null && recovery.since > this.recoveryQuarantinedSince && this.recoveryAlerted) {
      this.recoveryAlerted = false;
      this.deps.notify?.(false, { endpoint: 'binding_recovery', errcode: 'recovered' });
    }
    this.recoveryQuarantinedSince = recovery?.since ?? null;
    if (recovery) this.recoveryLastFailureAt = recovery.lastFailureAt;
    else if (this.recoveryStartedAt === null) this.recoveryLastFailureAt = null;
    const quarantined =
      this.recoveryLastFailureAt !== null && this.recoveryQuarantinedSince !== null && now - this.recoveryQuarantinedSince >= 10 * 60_000;
    const stalled = this.recoveryStartedAt !== null && now - this.recoveryStartedAt >= 10 * 60_000;
    this.recoveryFailing = quarantined || stalled;
    if (this.recoveryFailing && !this.recoveryAlerted) {
      this.recoveryAlerted = true;
      const problem = { endpoint: 'binding_recovery', errcode: stalled ? 'stalled' : 'recovery_pending' };
      this.warn(problem.endpoint, problem.errcode);
      this.deps.notify?.(true, problem);
    } else if (!recovery && this.recoveryStartedAt === null && this.recoveryAlerted) {
      this.recoveryAlerted = false;
      this.deps.notify?.(false, { endpoint: 'binding_recovery', errcode: 'recovered' });
    }
    for (const [kind, failure] of this.failures) if (now - failure.lastAt >= 10 * 60_000) this.failures.delete(kind);
    const sustained = [...this.failures.values()].find((failure) => now - failure.firstAt >= 10 * 60_000);
    if (sustained && !this.alerted) {
      this.alerted = true;
      this.deps.notify?.(true, sustained);
    } else if (!this.failures.size && this.alerted) {
      this.alerted = false;
      this.deps.notify?.(false);
    }
    this.publishAvailability();
    this.notifyFull();
  }

  tick(): Promise<void> {
    if (!this.running()) return Promise.resolve();
    // 上一拍可能仍在拉取 / 派发；持续失败的告警不等待那条处理链。
    this.notify();
    void this.refreshFull();
    this.tickTask ??= withoutTenantScope(async () => {
      // 即使链接已就绪，也让任务先完成登记，避免同步 finally 留下已完成的单飞 promise。
      await Promise.resolve();
      try {
        if (!this.link || this.failures.has('ready')) {
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
              if ((message.open_kfid || message.event?.open_kfid) !== this.env.SANDBOX_WECOM_OPEN_KFID) continue;
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
    for (const [id, at] of this.seen) if (arrivedAt - at >= 7 * 86400_000) this.seen.delete(id);
    if (this.seen.has(message.msgid)) return;
    this.seen.set(message.msgid, arrivedAt);
    if (message.origin === 4 && message.event?.event_type === 'msg_send_fail') {
      const msgid = message.event.fail_msgid;
      const rt = msgid && sandboxWechatIndex.forReceipt(msgid, this.now());
      if (rt) withTenantScope(rt, () => onSendFail(msgid!, message.event!.fail_type ?? 0));
      else this.warn('receipt', 'unknown_msgid');
      return;
    }
    const entered = message.event?.event_type === 'enter_session';
    if (!entered && message.origin !== 3) return;
    const user = entered ? (message.event?.external_userid ?? message.external_userid) : message.external_userid;
    if (!user) return;
    if (entered && message.event?.welcome_code) sandboxWechatIndex.rememberWelcome(message.event.welcome_code, user, arrivedAt);
    if (this.deps.binding) {
      const hash = createHash('sha256').update(user).digest('hex');
      const previous = this.users.get(hash) ?? Promise.resolve();
      const task = previous
        .then(() => this.handle(message, user, entered))
        .catch((error: unknown) => {
          if (error instanceof SandboxSendRefused) return;
          this.failure('send', error, { endpoint: 'binding', errcode: 'request_failed' });
        })
        .finally(() => {
          this.tasks.delete(task);
          if (this.users.get(hash) === task) this.users.delete(hash);
          if (this.running()) this.notify();
        });
      this.users.set(hash, task);
      this.tasks.add(task);
      return;
    }
    this.replyFixed(user, entered ? message.event?.welcome_code : undefined);
  }

  private async handle(message: KfMessage, user: string, entered: boolean): Promise<void> {
    if (!this.running()) return;
    const welcome = entered ? message.event?.welcome_code : undefined;
    const text = entered ? message.event?.scene_param : message.text?.content;
    const previouslyBound = await this.deps.binding!.resolve(user);
    const typedCode = text && /^[0-9a-z]{8}$/i.test(text.replace(/[\s-]/g, ''));
    const bindingText = (entered && text !== undefined) || (typedCode && (!previouslyBound || this.deps.binding!.matchesCode(text!)));
    if (bindingText) {
      let result;
      try {
        result = await this.deps.binding!.bind(user, text!, welcome, entered);
      } catch {
        // 同一条失败欢迎码保持未归属，只能用于固定话术。
        if (!entered || !previouslyBound) this.replyFixed(user, welcome);
        return;
      }
      if (!this.running()) return;
      if (result.status === 'bound') {
        const rt = result.runtime;
        await withTenantScope(rt, () =>
          rt.inflight.track(async () => {
            try {
              // loadSandboxRuntime 已经经 initSessionStore 预载库里的会话，重启后也读同一份 identity map。
              const id = `wecom:${user}`;
              if (getSession(id)?.handedOver) {
                // 沙箱唯一的成员是开通时建的合成用户，邮箱固定为 `<slug>@sandbox.invalid`（迁移 0011）。
                const member = await authLoginLookup(configRuntime().db, rt.id, `${rt.slug}@sandbox.invalid`);
                if (!member) throw new Error('sandbox_member_missing');
                if (this.running() && rt.state === 'serving' && !rt.cancel.aborted && sandboxWechatIndex.forUser(user) === rt) {
                  release(id, { userId: member.userId, name: member.displayName, role: member.role });
                  await flushSession(id, { timeoutMs: 5000 });
                }
              }
            } catch (error) {
              this.warn('binding', error instanceof ConsentDeclinedError ? 'consent_declined' : 'release_failed');
            }
            await this.api.welcomeUser(user, welcome);
          }),
        );
        return;
      }
      if (!entered || !previouslyBound) this.replyFixed(user, welcome, result.status === 'expired');
      return;
    }
    const rt = await this.deps.binding!.resolve(user, welcome);
    if (!this.running()) return;
    if (!rt) {
      this.replyFixed(user, welcome);
      return;
    }
    if (!entered) this.deps.touch?.(rt);
    await withTenantScope(rt, () => (entered ? this.api.welcomeUser(user, welcome) : this.api.receive(message)));
  }

  private replyFixed(user: string, welcomeCode?: string, expired = false): void {
    if (this.full || !this.running()) return;
    const now = this.now();
    for (const [key, at] of this.replies) if (now - at.at >= 10 * 60_000) this.replies.delete(key);
    this.hourly = this.hourly.filter((at) => now - at < 60 * 60_000);
    const hash = createHash('sha256').update(user).digest('hex');
    if (this.replies.has(hash) || this.hourly.length >= 200) return;
    const reservation = { at: now };
    this.replies.set(hash, reservation);
    this.hourly.push(now);
    const task = this.api
      .replyUnbound(user, welcomeCode, expired)
      .then(() => {
        if (this.running()) this.failures.delete('send');
      })
      .catch((error: unknown) => {
        // 只撤销这次认领，不能删除晚到期间另一个请求的新记录。
        if (this.replies.get(hash) === reservation) this.replies.delete(hash);
        if (error instanceof SandboxSendRefused) return;
        this.failure('send', error, { endpoint: welcomeCode ? 'kf/send_msg_on_event' : 'kf/send_msg', errcode: 'request_failed' });
      })
      .finally(() => {
        this.tasks.delete(task);
        if (this.running()) this.notify();
      });
    this.tasks.add(task);
  }

  /** 等实例后台与已派发任务落定；不重放已提交页面。 */
  async drain(): Promise<void> {
    while (this.tickTask || this.syncTask || this.fullTasks.size || this.stateTask || this.tasks.size)
      await Promise.allSettled([this.tickTask, this.syncTask, ...this.fullTasks.values(), this.stateTask, ...this.tasks]);
  }

  stop(): void {
    this.stopping = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.api.stop();
    this.link = null;
    this.publishAvailability();
    this.replies.clear();
    this.hourly.length = 0;
    this.seen.clear();
  }

  async close(): Promise<void> {
    this.stop();
    await this.drain();
  }
}

export function createSandboxWecom(
  env: NodeJS.ProcessEnv,
  db: Db,
  epoch: string,
  touch?: (rt: TenantRuntime) => void,
): SandboxWecom | null {
  if (!SANDBOX_WECOM_NAMES.some((key) => env[key] !== undefined)) return null;
  return new SandboxWecom(env, {
    touch,
    read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID!),
    commit: (cursor) => commitSandboxWecomCursor(db, epoch, env.SANDBOX_WECOM_OPEN_KFID!, cursor),
    binding: new SandboxWechatBinding(db, epoch),
    markFull: () => markSandboxWecomFull(db, epoch, env.SANDBOX_WECOM_OPEN_KFID!),
    notifyFull: () =>
      alert('sandbox_wecom_full', '微信体验名额已满，已退回模拟器', { instance: true, scope: `sandbox-full:${todayIso()}` }),
    notify: (failing, problem) =>
      alert(
        'channel',
        failing
          ? `企微账号 sandbox 连续 10 分钟收发或绑定恢复失败 · interface=${problem?.endpoint} errcode=${problem?.errcode}`
          : '企微账号 sandbox 收发已恢复',
        {
          instance: true,
          scope: problem?.endpoint === 'binding_recovery' ? 'binding_recovery:sandbox' : 'pull:sandbox',
          resolved: !failing,
          escalate: failing,
        },
      ),
  });
}
