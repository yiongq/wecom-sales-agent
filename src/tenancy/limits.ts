// 14 R2、R3：standard 的月度回复计数与只读运行时快照；闸门调用方由后续步骤接线。
import { withTenant } from '../db/client.js';
import { readTenantLimits } from '../db/repo/tenants.js';
import { readMonthlyReplyCount } from '../db/repo/usage.js';
import { onShutdown } from '../shutdown.js';
import { withUsageDailySnapshot } from '../trace/usage-daily.js';
import { recordReplyUsage } from '../usage.js';
import { currentRuntime, withTenantScope, withoutTenantScope, backgroundEntry, type TenantRuntime } from './runtime.js';
import { scopedState } from './scoped-state.js';
import { registerTenantState } from './state.js';

export interface TenantLimits {
  status: 'trial' | 'active' | 'suspended';
  monthlyQuota: number | null;
  monthlyUsed: number;
  dailyCapMilli: number | null;
}
export type LimitVerdict = 'ok' | 'quota' | 'suspended';

function today(): string {
  const date = new Date(deps.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
async function read(rt: TenantRuntime, month: string): Promise<TenantLimits> {
  return withTenant(
    rt.config.loaded!.deps.db,
    { tenantId: rt.id, actor: { kind: 'system', userId: null, name: null, ip: null } },
    async (tx) => {
      const limits = await readTenantLimits(tx, rt.id);
      if (!limits) throw new Error('tenant_limits_missing');
      return { ...limits, monthlyUsed: await readMonthlyReplyCount(tx, month) };
    },
    { readOnly: true, isolation: 'repeatable read' },
  );
}
function notify(rt: TenantRuntime, percent: number, month: string): void {
  void import('../ops/alert.js')
    .then(({ alert }) => {
      if (rt.state === 'closed' || rt.cancel.aborted) return;
      withTenantScope(rt, () =>
        alert('usage_limit', `${rt.slug} AI 回复额度 ${percent}%`, { scope: `replies:${month}:${percent}`, escalate: true }),
      );
    })
    .catch(() => console.warn('[limits] usage_limit_alert_failed'));
}
const deps = { now: () => Date.now(), read, alert: notify };
interface State {
  value: TenantLimits;
  month: string;
  localReplies: number;
  baselineReplies: number;
  loading: Promise<void> | null;
  alerted: Set<number>;
  closed: boolean;
}
const tenantState = scopedState(() => ({ current: null as State | null }), {
  current: (s) => {
    if (s) s.closed = true;
  },
});
registerTenantState({ name: 'limits.current', ...tenantState.registration('current') });
let pollTimer: ReturnType<typeof setInterval> | null = null;

function enabled(rt: TenantRuntime): boolean {
  return rt.kind === 'standard' && !!rt.config.loaded && !!rt.store.pgBackend && rt.state !== 'closed' && !rt.cancel.aborted;
}
function state(): State {
  const bucket = tenantState.get();
  return (bucket.current ??= {
    value: { status: 'active', monthlyQuota: null, monthlyUsed: 0, dailyCapMilli: null },
    month: today().slice(0, 7),
    localReplies: 0,
    baselineReplies: 0,
    loading: null,
    alerted: new Set(),
    closed: false,
  });
}
function rollMonth(s: State): void {
  const month = today().slice(0, 7);
  if (s.month === month) return;
  s.month = month;
  s.localReplies = 0;
  s.baselineReplies = 0;
  s.value.monthlyUsed = 0;
  s.alerted.clear();
}

/** 同步、不读库；返回副本供预算与用量读接口使用。文件与沙箱返回 null。 */
export function getTenantLimits(): TenantLimits | null {
  if (!enabled(currentRuntime())) return null;
  const s = state();
  rollMonth(s);
  return { ...s.value };
}
/** 同步、不读库，停用优先于额度；NULL 不限，0 全拦。 */
export function limitVerdict(): LimitVerdict {
  const limits = getTenantLimits();
  if (!limits) return 'ok';
  if (limits.status === 'suspended') return 'suspended';
  return limits.monthlyQuota !== null && limits.monthlyUsed >= limits.monthlyQuota ? 'quota' : 'ok';
}
/** 每条已经落进会话的 ai/followup 消息调用一次；不判定、不转人工。 */
export function noteAiReply(): void {
  const rt = currentRuntime();
  if (!enabled(rt)) return;
  const s = state();
  rollMonth(s);
  s.localReplies++;
  s.value.monthlyUsed = s.baselineReplies + s.localReplies;
  recordReplyUsage(today());
  const quota = s.value.monthlyQuota;
  if (quota === null) return;
  for (const percent of [80, 100]) {
    if (s.value.monthlyUsed * 100 < quota * percent || s.alerted.has(percent)) continue;
    s.alerted.add(percent);
    deps.alert(rt, percent, s.month);
  }
}

/** 启动时由 usage_daily writer 接线；之后每 30 秒更新，失败保留最后一次成功的配置与计数基数。 */
export function initializeTenantLimits(rt = currentRuntime()): Promise<void> {
  if (!enabled(rt)) return Promise.resolve();
  return withTenantScope(rt, () => {
    const s = state();
    rollMonth(s);
    if (s.closed) return Promise.resolve();
    if (!pollTimer) {
      pollTimer = withoutTenantScope(() => setInterval(pollTenantLimits, 30_000));
      pollTimer.unref();
    }
    if (s.loading) return s.loading;
    const day = today();
    const month = s.month;
    const work = withUsageDailySnapshot(day, async (_persistedMilli, persistedReplies) => {
      const value = await deps.read(rt, month);
      if (s.closed || !enabled(rt) || s.month !== month || today().slice(0, 7) !== month) return;
      // 本运行时的 localReplies 包括已经提交的回复；与 writer 串行读，扣掉提交部分，避免重复计数。
      s.baselineReplies = Math.max(0, value.monthlyUsed - persistedReplies);
      s.value = { ...value, monthlyUsed: s.baselineReplies + s.localReplies };
    })
      .catch(() => {
        if (!s.closed && enabled(rt)) console.warn('[limits] tenant_limits_poll_failed');
      })
      .finally(() => {
        s.loading = null;
      });
    s.loading = rt.inflight.track(work);
    return s.loading;
  });
}
async function pollTenantLimits(): Promise<void> {
  await Promise.all(
    tenantState
      .owners()
      .filter((rt) => enabled(rt) && rt.state === 'serving')
      .map((rt) => backgroundEntry(() => withTenantScope(rt, () => initializeTenantLimits(rt)))),
  );
}
export function stopTenantLimits(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
withoutTenantScope(() => onShutdown(stopTenantLimits));

/** 仅注入时钟、读库与告警；计数、快照队列、判定仍走生产路径。 */
export const __limitsTest = {
  configure(input: Partial<typeof deps>): void {
    Object.assign(deps, input);
  },
  reader: () => deps.read,
  poll: pollTenantLimits,
  timer: () => pollTimer,
  reset(): void {
    stopTenantLimits();
    tenantState.registration('current').reset();
    Object.assign(deps, { now: () => Date.now(), read, alert: notify });
  },
};
