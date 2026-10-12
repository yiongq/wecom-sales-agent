// R22：唯一互斥链覆盖签码、清空与绑定，提交之后才发布；删除从不等这把锁。
import { createHash, randomBytes } from 'node:crypto';
import { fenceSandboxEpoch, withTenant, type Db, type Tx } from '../../db/client.js';
import { issueSandboxWechatCode, clearSandboxWechat, bindSandboxWechat, readSandboxWechat } from '../../db/repo/sandbox-wechat.js';
import { runtimeOf, tenantRuntimes, withTenantScope, type TenantRuntime } from '../runtime.js';
import { sandboxWechatIndex } from './outbound.js';
import { sandboxStopped } from './lifecycle.js';

export class SandboxWechatError extends Error {
  constructor(
    readonly status: 409 | 410 | 429 | 503,
    readonly reason: string,
  ) {
    super(reason);
  }
}
export function normalizeWechatCode(text: string): string | null {
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}
function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
function serving(rt: TenantRuntime | undefined): rt is TenantRuntime {
  return (
    !!rt &&
    rt.kind === 'sandbox' &&
    rt.state === 'serving' &&
    runtimeOf(rt.id) === rt &&
    !sandboxStopped() &&
    !rt.cancel.aborted &&
    (rt.expiresAt ?? 0) > Date.now()
  );
}
export type BindingResult = { status: 'bound'; runtime: TenantRuntime } | { status: 'invalid' | 'expired' };

export class SandboxWechatBinding {
  // 只留微信的哈希与失败时刻；重启归零，不是租户数据。
  private readonly failures = new Map<string, number[]>();
  private readonly recovering = new Map<string, { rt: TenantRuntime; since: number; lastFailureAt: number }>();
  constructor(
    private readonly db: Db,
    private readonly epoch: string,
  ) {}

  private write<T>(rt: TenantRuntime, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!serving(rt)) return Promise.reject(new SandboxWechatError(410, 'sandbox_expired'));
    return withTenantScope(rt, () =>
      withTenant(this.db, { tenantId: rt.id, actor: { kind: 'system', userId: null, name: null, ip: null } }, async (tx) => {
        await fenceSandboxEpoch(tx, this.epoch);
        if (!serving(rt)) throw new SandboxWechatError(410, 'sandbox_expired');
        return work(tx);
      }),
    );
  }
  /** 读完所有存活沙箱再裁决重复行；旧副本清空提交后才发布新授权。 */
  private async recover(runtimes: TenantRuntime[], users: string[] = []): Promise<boolean> {
    const affected = new Map(runtimes.map((rt) => [rt.id, rt]));
    try {
      const rows = [];
      for (const rt of tenantRuntimes().filter(serving)) {
        const row = await withTenantScope(rt, () =>
          withTenant(this.db, { tenantId: rt.id, actor: { kind: 'system', userId: null, name: null, ip: null } }, readSandboxWechat, {
            readOnly: true,
            sandboxMaintenance: true,
          }),
        );
        rows.push({ rt, row });
      }
      const newest = new Map<string, (typeof rows)[number]>();
      for (const entry of rows) {
        const { rt, row } = entry;
        if (!row?.externalUserid || !row.boundAt || !serving(rt)) continue;
        const previous = newest.get(row.externalUserid);
        const time = BigInt(row.boundAt),
          previousTime = BigInt(previous?.row?.boundAt ?? '0');
        if (!previous || time > previousTime || (time === previousTime && rt.id > previous.rt.id)) newest.set(row.externalUserid, entry);
      }
      for (const entry of rows) {
        const { rt, row } = entry;
        if (!row?.externalUserid || newest.get(row.externalUserid) === entry || !serving(rt)) continue;
        affected.set(rt.id, rt);
        const winner = newest.get(row.externalUserid)!;
        affected.set(winner.rt.id, winner.rt);
        sandboxWechatIndex.quarantine(rt.id, [row.externalUserid]);
        await this.write(rt, clearSandboxWechat);
        row.externalUserid = null;
        row.boundAt = null;
      }
      const changed = rows.filter(({ rt }) => affected.has(rt.id));
      for (const { rt } of changed) sandboxWechatIndex.quarantine(rt.id);
      for (const { rt, row } of changed) {
        this.recovering.delete(rt.id);
        sandboxWechatIndex.restore(rt.id);
        if (!serving(rt) || !row) continue;
        sandboxWechatIndex.publishLink(rt, row.linkToken);
        if (row.codeHash && row.codeExpiresAt) sandboxWechatIndex.publishCode(rt, row.codeHash, new Date(row.codeExpiresAt).getTime());
        if (row.externalUserid && row.boundAt) sandboxWechatIndex.publishRebuiltBinding(rt, row.externalUserid, BigInt(row.boundAt));
      }
      // 删除屏障可能在读取期间关闭或摘下运行时；不恢复它的任何授权。
      for (const rt of affected.values()) {
        const id = rt.id;
        if (!serving(rt)) this.recovering.delete(id);
      }
      return true;
    } catch {
      const now = Date.now();
      const since = this.recoveryStatus()?.since ?? now;
      for (const rt of affected.values()) {
        const id = rt.id;
        sandboxWechatIndex.quarantine(id, users);
        if (serving(rt)) {
          this.recovering.set(id, { rt, since, lastFailureAt: now });
        } else this.recovering.delete(id);
      }
      console.warn('[sandbox-wecom] binding_recovery_pending');
      return false;
    }
  }
  /** 启动装完全部运行时后调用，旧副本清理失败时保持隔离、由定时恢复重试。 */
  rebuild(): Promise<void> {
    return sandboxWechatIndex.exclusive(async () => {
      await this.recover(tenantRuntimes().filter(serving));
    });
  }
  matchesCode(text: string): boolean {
    const code = normalizeWechatCode(text);
    const row = code && sandboxWechatIndex.code(codeHash(code));
    return !!row && row.expiresAt > Date.now() && serving(row.runtime);
  }
  /** 无锁读取恢复事实；拉取成功不能清掉仍隔离的故障。 */
  recoveryStatus(): { since: number; lastFailureAt: number } | null {
    const pending = [...this.recovering.values()].filter(({ rt }) => serving(rt));
    return pending.length
      ? { since: Math.min(...pending.map((entry) => entry.since)), lastFailureAt: Math.max(...pending.map((entry) => entry.lastFailureAt)) }
      : null;
  }
  /** 实例每分钟调用；不另建定时器，关闭过程仍由同一互斥链 drain。 */
  refresh(): Promise<void> {
    if (!this.recovering.size) return Promise.resolve();
    return sandboxWechatIndex.exclusive(async () => {
      const runtimes = [...this.recovering.values()].map(({ rt }) => rt).filter(serving);
      for (const [id, { rt }] of this.recovering) if (!serving(rt)) this.recovering.delete(id);
      if (runtimes.length) await this.recover(runtimes);
    });
  }
  issue(rt: TenantRuntime, contact: () => string | null, full: () => boolean) {
    if (!serving(rt)) return Promise.reject(new SandboxWechatError(410, 'sandbox_expired'));
    if (sandboxWechatIndex.isQuarantined(rt.id)) return Promise.reject(new SandboxWechatError(503, 'sandbox_wecom_unavailable'));
    return sandboxWechatIndex.exclusive(async () => {
      if (!serving(rt)) throw new SandboxWechatError(410, 'sandbox_expired');
      if (sandboxWechatIndex.isQuarantined(rt.id)) throw new SandboxWechatError(503, 'sandbox_wecom_unavailable');
      if (full()) throw new SandboxWechatError(409, 'sandbox_wecom_full');
      const contactLink = contact();
      if (!contactLink) throw new SandboxWechatError(503, 'sandbox_wecom_unavailable');
      const now = Date.now();
      if (!sandboxWechatIndex.canIssue(rt, now)) throw new SandboxWechatError(429, 'sandbox_wechat_limited');
      return rt.inflight.track(async () => {
        let code: string, hash: string;
        do {
          code = [...randomBytes(8)].map((n) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n & 31]).join('');
          hash = codeHash(code);
        } while (sandboxWechatIndex.code(hash));
        let expiresAt: Date;
        try {
          expiresAt = await this.write(rt, (tx) => issueSandboxWechatCode(tx, hash));
        } catch (error) {
          await this.recover([rt]);
          throw error;
        }
        // 提交间隙到期也不发布、不交出码；库里的状态留给 purge。
        if (!serving(rt)) throw new SandboxWechatError(410, 'sandbox_expired');
        sandboxWechatIndex.publishCode(rt, hash, expiresAt.getTime());
        sandboxWechatIndex.recordIssue(rt, now);
        return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: expiresAt.toISOString(), contactLink };
      });
    });
  }

  bind(user: string, text: string, welcomeCode?: string, ignoreInvalidBoundScene = false): Promise<BindingResult> {
    const preCode = normalizeWechatCode(text);
    const preHash = preCode ? codeHash(preCode) : undefined;
    if (sandboxWechatIndex.isQuarantined(undefined, user, preHash))
      return Promise.reject(new SandboxWechatError(503, 'sandbox_wecom_unavailable'));
    const preRow = preHash && sandboxWechatIndex.code(preHash);
    if (preRow && !serving(preRow.runtime)) return Promise.resolve({ status: 'expired' });
    const finishUser = sandboxWechatIndex.beginBinding([user]);
    return sandboxWechatIndex
      .exclusive<BindingResult>(async () => {
        const now = Date.now();
        if (sandboxWechatIndex.isQuarantined(undefined, user, preHash)) throw new SandboxWechatError(503, 'sandbox_wecom_unavailable');
        for (const [key, times] of this.failures) {
          const recent = times.filter((at) => now - at < 3600_000);
          if (recent.length) this.failures.set(key, recent);
          else this.failures.delete(key);
        }
        const key = createHash('sha256').update(user).digest('hex');
        const times = this.failures.get(key) ?? [];
        if (times.length >= 10) return { status: 'invalid' };
        const failed = (status: 'invalid' | 'expired'): BindingResult => {
          if (ignoreInvalidBoundScene && sandboxWechatIndex.forUser(user)) return { status };
          times.push(now);
          this.failures.set(key, times);
          return { status };
        };
        const code = normalizeWechatCode(text);
        const hash = code && codeHash(code);
        const row = hash && sandboxWechatIndex.code(hash);
        if (!row) return failed('invalid');
        const target = row.runtime;
        if (row.expiresAt <= now) return failed('expired');
        if (sandboxWechatIndex.isQuarantined(target?.id, user, hash || undefined))
          throw new SandboxWechatError(503, 'sandbox_wecom_unavailable');
        if (!serving(target)) return failed('expired');
        const old = sandboxWechatIndex.forUser(user);
        const previous = sandboxWechatIndex.boundUser(target);
        if (sandboxWechatIndex.isQuarantined(old?.id, previous)) throw new SandboxWechatError(503, 'sandbox_wecom_unavailable');
        const finishPrevious = sandboxWechatIndex.beginBinding(previous && previous !== user ? [previous] : []);
        return target.inflight.track(() => {
          const work = async (): Promise<BindingResult> => {
            // 两边已登记屏障之后、任何数据库 await 之前同步撤下。
            sandboxWechatIndex.withdraw(target.id);
            if (old && old !== target) sandboxWechatIndex.withdraw(old.id);
            try {
              if (old && old !== target && serving(old)) {
                try {
                  await this.write(old, clearSandboxWechat);
                } catch (error) {
                  // 等连接 / epoch 时旧沙箱进入 closing：留给 purge，仍可绑定活着的目标。
                  if (!(error instanceof SandboxWechatError && error.status === 410 && !serving(old))) throw error;
                }
              }
              if (!serving(target)) throw new SandboxWechatError(410, 'sandbox_expired');
              const bound = await this.write(target, (tx) => bindSandboxWechat(tx, hash!, user));
              if (!bound) throw new SandboxWechatError(410, 'sandbox_code_expired');
              // 码是否有效只由库内条件更新判断；提交成功后不因回执迟到而撤销。
              // 成功落库，但 closing 时不得回写解析表。
              if (!serving(target)) return failed('expired');
              sandboxWechatIndex.clearCode(target.id);
              sandboxWechatIndex.publishCommittedBinding(target, user, BigInt(bound));
              if (welcomeCode) sandboxWechatIndex.assignWelcome(welcomeCode, target);
              return { status: 'bound', runtime: target };
            } catch (error) {
              // 回滚失败和 COMMIT 回执丢失都不能按旧快照恢复。读取库里的真实结果。
              const recovered = await this.recover(old && old !== target ? [old, target] : [target], [
                user,
                ...(previous ? [previous] : []),
              ]);
              if (recovered && serving(target) && sandboxWechatIndex.forUser(user) === target && !sandboxWechatIndex.code(hash!)) {
                if (welcomeCode) sandboxWechatIndex.assignWelcome(welcomeCode, target);
                return { status: 'bound', runtime: target };
              }
              if (error instanceof SandboxWechatError && error.status === 410) return failed('expired');
              throw error;
            }
          };
          return (old && old !== target ? old.inflight.track(work) : work()).finally(finishPrevious);
        });
      })
      .finally(finishUser);
  }
  resolve(user: string, welcomeCode?: string): Promise<TenantRuntime | undefined> {
    return sandboxWechatIndex.awaitBinding(user).then(() => {
      const rt = sandboxWechatIndex.forUser(user);
      if (rt && welcomeCode) sandboxWechatIndex.assignWelcome(welcomeCode, rt);
      return rt;
    });
  }
}
