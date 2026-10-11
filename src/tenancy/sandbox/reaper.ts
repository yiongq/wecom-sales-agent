// 05 R12：前四步失败保留运行时与锁；第五步失败仍释放，下一拍只重试 purge。
import type { Db, TenantLock } from '../../db/client.js';
import { endSandbox, listSandboxes, purgeSandbox, type ReaperRow } from '../../db/sandbox-reaper.js';
import { markConfigShuttingDown } from '../../config/source.js';
import { closeTenantEventStreams } from '../../console-api/events.js';
import { closeSimulatorStreams } from '../../adapters/simulator.js';
import { flushUsageDailyForPurge } from '../../trace/usage-daily.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { alert } from '../../ops/alert.js';
import {
  cancelTenantRuntime,
  runtimeOf,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
  withoutTenantScope,
  type TenantRuntime,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { assertSandboxRunning, sandboxStopped } from './lifecycle.js';

interface Progress {
  step: 1 | 2 | 3 | 4 | 5 | 6;
  failures: number;
  lock?: TenantLock;
}

/** 计时器在空作用域创建；超时只结束等待，不提前摘在途登记。 */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = withoutTenantScope(() => setTimeout(() => resolve(false), ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function beginSandboxClosing(rt: TenantRuntime): void {
  if (rt.kind !== 'sandbox') throw new Error('sandbox_required');
  if (rt.state !== 'serving') return;
  // 不等任何互斥锁，必须当刻拒绝新业务。关连接失败由第 ① 步重试。
  rt.state = 'closing';
}

export class SandboxReaper {
  private readonly progress = new Map<string, Progress>();
  private readonly lastAccess = new Map<string, number>();
  private readonly endings = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly deps: {
      db: Db;
      acquireTenant(id: string): Promise<TenantLock | null>;
      idleMs: number;
      barrierMs?: number;
    },
  ) {}

  touch(rt: TenantRuntime, now = Date.now()): void {
    if (rt.kind === 'sandbox' && rt.state === 'serving') this.lastAccess.set(rt.id, now);
  }
  async start(): Promise<void> {
    const rows = await listSandboxes(this.deps.db);
    assertSandboxRunning();
    for (const row of rows) {
      if (!this.lastAccess.has(row.id)) this.lastAccess.set(row.id, new Date(row.lastSeenAt).getTime());
    }
    this.stop();
    this.timer = withoutTenantScope(() =>
      setInterval(() => {
        void this.tick().catch(() => console.error('[sandbox] sandbox_reaper_failed'));
      }, 60_000),
    );
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async drain(): Promise<void> {
    await this.running;
  }

  async end(id: string): Promise<void> {
    assertSandboxRunning();
    const rt = runtimeOf(id);
    if (rt) beginSandboxClosing(rt);
    // expire 的行锁可能挂住：closing 在借连接之前已生效，事务也纳入屏障。
    if (this.endings.has(id)) return this.endings.get(id)!;
    const work = withoutTenantScope(() => endSandbox(this.deps.db, id));
    const pending = (rt ? rt.inflight.track(work, true) : work).finally(() => {
      this.endings.delete(id);
    });
    this.endings.set(id, pending);
    await pending;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = withoutTenantScope(() => this.sweep()).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async sweep(): Promise<void> {
    assertSandboxRunning();
    const rows = await listSandboxes(this.deps.db);
    for (const row of rows) {
      assertSandboxRunning();
      if (row.overdue) withoutTenantScope(() => alert('sandbox_purge', '有沙箱到期超过一小时仍未删除', { instance: true }));
      const rt = runtimeOf(row.id);
      if (!row.expired && rt?.state === 'serving') {
        const seen = this.lastAccess.get(row.id) ?? new Date(row.lastSeenAt).getTime();
        this.lastAccess.set(row.id, seen);
        if (Date.now() - seen < this.deps.idleMs) continue;
        void this.end(row.id).catch(() => {});
      } else if (!row.expired) {
        if (rt?.state !== 'closing') continue;
        void this.end(row.id).catch(() => {});
      }
      await this.reap(row);
    }
    // ⑤ 已提交、⑥ 失败时库行已不存在，不能只靠查询到期行驱动释放重试。
    for (const [id, p] of this.progress) {
      if (p.step !== 6 || rows.some((r) => r.id === id)) continue;
      try {
        await this.release(id, runtimeOf(id), p);
        this.progress.delete(id);
      } catch {
        console.error('[sandbox] sandbox_release_failed');
      }
    }
  }
  private async reap(row: ReaperRow): Promise<void> {
    const rt = runtimeOf(row.id);
    const p = this.progress.get(row.id) ?? { step: rt ? 1 : 5, failures: 0 };
    this.progress.set(row.id, p);
    const scoped = <T>(fn: () => T): T => (rt ? withTenantScope(rt, fn) : withoutTenantScope(fn));
    let failedAt: number | undefined;
    try {
      if (p.step === 1 && rt) {
        beginSandboxClosing(rt);
        scoped(() => {
          markConfigShuttingDown();
          closeTenantEventStreams();
          closeSimulatorStreams();
          rt.events.storeEvents.emit('close');
        });
        p.step = 2;
      }
      if (p.step === 2 && rt) {
        cancelTenantRuntime(rt);
        if (!(await settleWithin(rt.inflight.drain(), this.deps.barrierMs ?? 30_000))) return;
        if (!row.expired && !(await listSandboxes(this.deps.db)).find((r) => r.id === row.id)?.expired)
          throw new Error('sandbox_expire_pending');
        p.step = 3;
      }
      if (p.step === 3 && rt) {
        await scoped(flushUsageDailyForPurge);
        p.step = 4;
      }
      if (p.step === 4 && rt) {
        scoped(() => tenantStoreIfLoaded(rt)?.pgBackend?.close());
        p.step = 5;
      }
      if (p.step === 5) {
        // 启动时没有运行时，也必须先取租户锁，避免删另一个持锁者的数据。
        if (!rt) {
          p.lock = (await this.deps.acquireTenant(row.id)) ?? undefined;
          if (!p.lock) throw new Error('sandbox_tenant_lock_held');
        }
        try {
          const result = await scoped(() => purgeSandbox(this.deps.db, row.id));
          p.failures = 0;
          console.log(
            `[sandbox] deleted ${row.slug.slice(-6)} lifetimeMs=${Math.max(0, Date.now() - new Date(row.createdAt).getTime())} turns=${result.turns} calls=${result.calls} costMilli=${result.costMilli} counts=${JSON.stringify(result.counts)}`,
          );
        } catch (error) {
          p.failures++;
          failedAt = 5;
          throw error;
        } finally {
          p.step = 6;
          await this.release(row.id, rt, p);
        }
        this.progress.delete(row.id);
      } else if (p.step === 6) {
        await this.release(row.id, rt, p);
        p.step = 5;
      }
    } catch {
      console.error(`[sandbox] sandbox_purge_failed step=${failedAt ?? p.step}`);
      if (p.step === 6 && !runtimeOf(row.id) && !p.lock) p.step = 5;
      if (p.failures >= 5 || row.overdue) withoutTenantScope(() => alert('sandbox_purge', '沙箱删除积压或连续失败', { instance: true }));
    }
  }
  private async release(id: string, rt: TenantRuntime | undefined, p: Progress): Promise<void> {
    // 清理函数需要注册表里的 rt：先 drop、最后摘。保留独立 lock 引用以便失败重试释放。
    if (rt) {
      rt.state = 'closed';
      p.lock ??= rt.config.loaded?.lock;
      withTenantScope(rt, () => dropTenantState(id));
      dropShutdownHooks(rt);
      unregisterRuntime(id);
    }
    await p.lock?.release();
    p.lock = undefined;
    this.lastAccess.delete(id);
  }
  async overdue(): Promise<number> {
    const rows = await listSandboxes(this.deps.db);
    const n = rows.filter((r) => r.overdue).length;
    if (n && !sandboxStopped()) withoutTenantScope(() => alert('sandbox_purge', '有沙箱到期超过一小时仍未删除', { instance: true }));
    return n;
  }
}
