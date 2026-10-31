// 05 R15 软告警与 14 R5 日费用硬上限；未配置硬上限仍走原来的记账路径。
// limits 依赖 writer 与关闭钩子，不能反向静态引入（runtime 构造预算）。
let dailyCapReader: () => number | null = () => null;
export function setStandardDailyCapReader(read: () => number | null): void {
  dailyCapReader = read;
}
import type { UsagePurpose } from '../db/repo/usage.js';
import { withTenant } from '../db/client.js';
import { todayIso } from '../env.js';
import { currentRuntime, tenantRuntimes, withTenantScope, withoutTenantScope, type TenantRuntime } from './runtime.js';
import { registerTenantState } from './state.js';
export interface Reservation {
  settle(actualMilli: number | null): void;
}
export interface TenantBudget {
  reserve(purpose: UsagePurpose, estimateMilli: number): Reservation | null;
  status(): { calls: number; costMilli: number; capCalls: number | null; capMilli: number | null };
}
interface StandardState {
  calls: number;
  costMilli: number;
  day: string;
  dailyMilli: number;
  baselineMilli: number;
  alertMilli: number | null;
  capLoaded: boolean;
  alerted: boolean;
  hardAlerted: boolean;
  reservedMilli: number;
  initializedDay: string | null;
  loading: Promise<void> | null;
  dropped: boolean;
}
const states = new WeakMap<TenantBudget, StandardState>();
const amount = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);
function rollDay(state: StandardState): void {
  const day = todayIso();
  if (state.day === day) return;
  state.day = day;
  state.dailyMilli = 0;
  state.baselineMilli = 0;
  state.alerted = false;
  state.hardAlerted = false;
  state.reservedMilli = 0;
  // 持租户锁的运行时是唯一写者；换天的库基数为 0，软上限保留启动快照。
  state.initializedDay = state.capLoaded ? day : null;
}
function checkAlert(rt: TenantRuntime, state: StandardState): void {
  if (state.dropped || rt.state !== 'serving' || state.alerted || state.alertMilli === null || state.initializedDay !== state.day) return;
  const cost = state.baselineMilli + state.dailyMilli;
  if (cost <= state.alertMilli) return;
  state.alerted = true;
  // 复用实例告警的总限流与安全正文；每日是否发由当前租户预算控制。
  void withoutTenantScope(() =>
    import('../ops/alert.js')
      .then(({ alert }) => {
        if (state.dropped || rt.state !== 'serving') return;
        withTenantScope(rt, () =>
          withoutTenantScope(() =>
            alert('model_errors', `模型当日用量超过软上限（${Math.floor(cost)} 厘，上限 ${state.alertMilli} 厘）`, {
              scope: `llm_daily:${rt.id}`,
              escalate: true,
            }),
          ),
        );
      })
      .catch(() => console.warn('[budget] llm_daily_alert_failed')),
  );
}
/** 接 writer 时读取启动时的软上限与当日已记用量；不改变 TenantRuntime / TenantBudget 接口。 */
export function initializeStandardBudget(rt: TenantRuntime): Promise<void> {
  const state = states.get(rt.budget);
  if (!state || rt.kind !== 'standard' || state.dropped) return Promise.resolve();
  rollDay(state);
  if (state.initializedDay === state.day) return Promise.resolve();
  if (state.loading) return state.loading;
  const loaded = rt.config.loaded;
  if (!loaded) return Promise.resolve();
  const day = state.day;
  const work = withTenantScope(rt, async () => {
    // runtime 的构造依赖预算；用量入口也依赖 runtime。调用时再接快照队列，避免模块加载环。
    const { withUsageDailySnapshot } = await import('../trace/usage-daily.js');
    if (state.dropped || rt.cancel.aborted || rt.state === 'closed' || state.day !== day) return;
    return withUsageDailySnapshot(day, (persistedMilli) =>
      withTenant(
        loaded.deps.db,
        {
          tenantId: rt.id,
          actor: { kind: 'system', userId: null, name: null, ip: null },
        },
        async (tx) => {
          const tenant = state.capLoaded
            ? undefined
            : await tx.query.tenants.findFirst({
                columns: { llmDailyAlertMilli: true },
                where: (t, { eq }) => eq(t.id, rt.id),
              });
          const usage = await tx.query.usageDaily.findMany({
            columns: { costMilliCny: true },
            where: (t, { and, eq }) => and(eq(t.tenantId, rt.id), eq(t.day, day)),
          });
          if (state.dropped || state.day !== day || rt.cancel.aborted || rt.state === 'closed') return;
          if (!state.capLoaded) {
            state.alertMilli = tenant?.llmDailyAlertMilli ?? null;
            state.capLoaded = true;
          }
          // 库总额包含初始化失败期间本运行时刷入的费用；扣掉后只留下启动前的基数。
          state.baselineMilli = Math.max(0, usage.reduce((n, row) => n + row.costMilliCny, 0) - persistedMilli);
          state.initializedDay = day;
          checkAlert(rt, state);
        },
        { readOnly: true },
      ),
    );
  })
    .catch(() => {
      console.warn('[budget] llm_daily_alert_load_failed');
    })
    .finally(() => {
      state.loading = null;
    });
  state.loading = rt.inflight.track(work);
  return state.loading;
}
export function createStandardBudget(): TenantBudget {
  const state: StandardState = {
    calls: 0,
    costMilli: 0,
    day: todayIso(),
    dailyMilli: 0,
    baselineMilli: 0,
    alertMilli: null,
    capLoaded: false,
    alerted: false,
    hardAlerted: false,
    reservedMilli: 0,
    initializedDay: null,
    loading: null,
    dropped: false,
  };
  const owner = (): TenantRuntime => {
    const rt = currentRuntime();
    if (rt.budget !== budget) throw new Error('预算不属于当前租户');
    return rt;
  };
  const budget: TenantBudget = {
    reserve: (_purpose, estimateMilli) => {
      const rt = owner();
      rollDay(state);
      void initializeStandardBudget(rt).catch(() => console.warn('[budget] llm_daily_alert_load_cancelled'));
      const cap = dailyCapReader();
      const estimate = amount(estimateMilli);
      if (cap !== null && (cap === 0 || state.baselineMilli + state.dailyMilli + state.reservedMilli + estimate > cap)) {
        if (!state.hardAlerted) {
          state.hardAlerted = true;
          void import('../ops/alert.js')
            .then(({ alert }) => {
              if (!state.dropped && rt.state === 'serving' && !rt.cancel.aborted)
                withTenantScope(rt, () =>
                  alert('usage_limit', `${rt.slug} 今日 AI 用量已到上限`, { scope: `daily:${state.day}`, escalate: true }),
                );
            })
            .catch(() => console.warn('[budget] usage_limit_alert_failed'));
        }
        return null;
      }
      const reservedDay = state.day;
      // 包括上限在途变更前已开始的请求，防止并发尝试共同越过硬上限。
      state.reservedMilli += estimate;
      state.calls++;
      let settled = false;
      return {
        settle(actualMilli) {
          if (settled) return;
          if (state.dropped || rt.cancel.aborted || rt.state === 'closed') {
            settled = true;
            return;
          }
          if (currentRuntime() !== rt) throw new Error('结算不属于当前租户');
          settled = true;
          rollDay(state);
          if (state.day === reservedDay) state.reservedMilli = Math.max(0, state.reservedMilli - estimate);
          const cost = amount(actualMilli ?? estimateMilli);
          state.costMilli += cost;
          state.dailyMilli += cost;
          checkAlert(rt, state);
        },
      };
    },
    status: () => {
      owner();
      return { calls: state.calls, costMilli: state.costMilli, capCalls: null, capMilli: null };
    },
  };
  states.set(budget, state);
  return budget;
}
registerTenantState({
  name: 'budget.standard',
  keyCount: (id) => (tenantRuntimes().some((rt) => rt.id === id && states.has(rt.budget)) ? 1 : 0),
  drop: (id) => {
    for (const rt of tenantRuntimes())
      if (rt.id === id) {
        const state = states.get(rt.budget);
        if (state) state.dropped = true;
        states.delete(rt.budget);
      }
  },
  reset: () => {
    for (const rt of tenantRuntimes()) {
      const s = states.get(rt.budget);
      if (s)
        Object.assign(s, {
          calls: 0,
          costMilli: 0,
          dailyMilli: 0,
          baselineMilli: 0,
          alerted: false,
          hardAlerted: false,
          reservedMilli: 0,
          initializedDay: null,
          capLoaded: false,
        });
    }
  },
});
