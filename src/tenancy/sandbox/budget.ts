// R15：单进程持实例锁；同步预占同时修改租户与池，异步只用于恢复及刷写。
import type { TenantBudget, Reservation } from '../budget.js';
import { readSandboxPoolBudget, type Db } from '../../db/client.js';
import { readSandboxBudget, writeSandboxIndexUsage } from '../../db/sandbox-budget.js';
import { todayIso } from '../../env.js';
import { currentRuntime, tenantRuntimes, withoutTenantScope, type TenantRuntime } from '../runtime.js';
import { registerTenantState } from '../state.js';
import { sandboxStopped } from './lifecycle.js';

interface BudgetState {
  calls: number;
  costMilli: number;
  ready: boolean;
  dropped: boolean;
}
interface IndexUsage {
  day: string;
  calls: number;
  costMilli: number;
  oldest: number;
}
const budgets = new WeakMap<TenantBudget, BudgetState>();
// 池总额不随运行时 drop 减少；首次索引的待写用量也不属于任何租户。
const pool = {
  db: null as Db | null,
  loading: null as Promise<void> | null,
  day: '',
  calls: 0,
  costMilli: 0,
  reservedCalls: 0,
  reservedMilli: 0,
  capMilli: 10_000,
  capCalls: 300,
  tenantCapMilli: 1000,
  minimumMilli: 0,
  alertedDay: '',
  indexClaimed: false,
  pending: [] as IndexUsage[],
  flushing: [] as IndexUsage[],
  chain: Promise.resolve(),
  timer: null as NodeJS.Timeout | null,
  usageOldest: (() => null) as () => number | null,
};
export function setSandboxUsageLagReader(read: () => number | null): void {
  pool.usageOldest = read;
}

function positive(env: NodeJS.ProcessEnv, key: string, fallback: number, integer = false): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`sandbox_budget_invalid:${key}`);
  return value;
}
export function validateSandboxBudget(env: NodeJS.ProcessEnv): void {
  positive(env, 'SANDBOX_LLM_CALLS', 300, true);
  positive(env, 'SANDBOX_LLM_CNY', 1);
  positive(env, 'SANDBOX_POOL_DAILY_CNY', 10);
}
function rollDay(): void {
  const day = todayIso();
  if (pool.day === day) return;
  pool.day = day;
  // 在飞的尝试可能在新一天结算；午夜不能把它们的预占额度释放给新请求。
  pool.calls = pool.reservedCalls;
  pool.costMilli = pool.reservedMilli;
}
function poolAlert(text: string): void {
  if (pool.alertedDay === pool.day) return;
  pool.alertedDay = pool.day;
  void withoutTenantScope(() =>
    import('../../ops/alert.js')
      .then(({ alert }) => {
        if (!sandboxStopped()) alert('sandbox_pool', text, { instance: true, escalate: true });
      })
      .catch(() => console.warn('[sandbox] sandbox_pool_alert_failed')),
  );
}
/** 全局开通限额和模型池不足共用当天一次的告警。IP 限额不调用这里。 */
export function notifySandboxProvisionLimited(): void {
  rollDay();
  poolAlert('沙箱开通被全局限额拒绝，暂停新体验');
}

export async function initializeSandboxPool(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (pool.db === db) return;
  if (pool.loading) return pool.loading;
  validateSandboxBudget(env);
  if (pool.timer) clearInterval(pool.timer);
  pool.indexClaimed = false;
  pool.alertedDay = '';
  pool.capMilli = positive(env, 'SANDBOX_POOL_DAILY_CNY', 10) * 1000;
  pool.capCalls = positive(env, 'SANDBOX_LLM_CALLS', 300, true);
  pool.tenantCapMilli = positive(env, 'SANDBOX_LLM_CNY', 1) * 1000;
  pool.loading = (async () => {
    const { llmCfg } = await import('../../core/llm/client.js');
    const { sandboxCostOf } = await import('../../usage.js');
    // 当前主模型的一次请求至少要预占缺省输出上限；尚无用户文本时输入下界为 0。
    pool.minimumMilli = sandboxCostOf(llmCfg().model, 0, 4096, 0, true) * 1000;
    const day = todayIso();
    const snapshot = await readSandboxPoolBudget(db, day);
    pool.day = day;
    pool.calls = snapshot.calls;
    pool.costMilli = snapshot.costMilli;
    if (pool.costMilli >= pool.capMilli || pool.capMilli - pool.costMilli < pool.minimumMilli) pool.alertedDay = day;
    pool.db = db;
    pool.timer = withoutTenantScope(() =>
      setInterval(() => {
        void flushSandboxIndexUsage();
      }, 30_000),
    );
    pool.timer.unref();
  })().finally(() => {
    pool.loading = null;
  });
  return pool.loading;
}
export async function initializeSandboxBudget(rt: TenantRuntime, db: Db): Promise<void> {
  await initializeSandboxPool(db);
  const state = budgets.get(rt.budget);
  if (!state || state.ready) return;
  const loaded = await readSandboxBudget(db, rt.id);
  if (state.dropped) return;
  Object.assign(state, loaded, { ready: true });
}

function lagging(): boolean {
  const oldest = Math.min(pool.usageOldest() ?? Infinity, ...[...pool.pending, ...pool.flushing].map((p) => p.oldest));
  return Date.now() - oldest > 60_000;
}
/** 开通判定与 reserve 使用同一个池内存数，包含在飞的预占。 */
export function sandboxPoolAvailable(): boolean {
  rollDay();
  if (!pool.db || lagging() || sandboxStopped()) return false;
  if (pool.costMilli >= pool.capMilli || pool.capMilli - pool.costMilli < pool.minimumMilli) {
    poolAlert(
      pool.costMilli >= pool.capMilli ? '沙箱池当天额度已用完，暂停收费调用与开通' : '沙箱池剩余不足一次调用的最小预占，暂停新体验',
    );
    return false;
  }
  return true;
}
export function sandboxBudgetPoolStatus() {
  rollDay();
  return { day: pool.day, calls: pool.calls, costMilli: pool.costMilli, capMilli: pool.capMilli };
}

function reserve(state: BudgetState | null, estimateMilli: number): Reservation | null {
  const rt = currentRuntime();
  rollDay();
  if (
    !pool.db ||
    rt.kind !== 'sandbox' ||
    rt.state === 'closed' ||
    rt.cancel.aborted ||
    sandboxStopped() ||
    lagging() ||
    (state && (!state.ready || state.dropped)) ||
    !Number.isFinite(estimateMilli) ||
    estimateMilli < 0
  )
    return null;
  if (state && (state.calls >= pool.capCalls || state.costMilli + estimateMilli > pool.tenantCapMilli)) return null;
  if (pool.costMilli + estimateMilli > pool.capMilli || pool.costMilli >= pool.capMilli) {
    poolAlert(pool.costMilli >= pool.capMilli ? '沙箱池当天额度已用完，暂停收费调用与开通' : '沙箱池剩余不足一次调用的预占，拒绝本次尝试');
    return null;
  }
  pool.calls++;
  pool.costMilli += estimateMilli;
  pool.reservedCalls++;
  pool.reservedMilli += estimateMilli;
  if (state) {
    state.calls++;
    state.costMilli += estimateMilli;
  }
  let settled = false;
  return {
    settle(actualMilli) {
      if (settled || state?.dropped || rt.state === 'closed') return;
      if (currentRuntime() !== rt) throw new Error('结算不属于当前租户');
      settled = true;
      const actual = actualMilli === null ? estimateMilli : Math.max(0, actualMilli);
      rollDay();
      pool.costMilli += actual - estimateMilli;
      pool.reservedCalls--;
      pool.reservedMilli -= estimateMilli;
      if (state) state.costMilli += actual - estimateMilli;
      else pool.pending.push({ day: pool.day, calls: 1, costMilli: actual, oldest: Date.now() });
    },
  };
}
export function createSandboxBudget(): TenantBudget {
  const state: BudgetState = { calls: 0, costMilli: 0, ready: false, dropped: false };
  const owner = () => {
    if (currentRuntime().budget !== budget) throw new Error('预算不属于当前租户');
  };
  const budget: TenantBudget = {
    reserve: (_purpose, estimate) => {
      owner();
      return reserve(state, estimate);
    },
    status: () => {
      owner();
      return { calls: state.calls, costMilli: state.costMilli, capCalls: pool.capCalls, capMilli: pool.tenantCapMilli };
    },
  };
  budgets.set(budget, state);
  return budget;
}
/** 只有进程第一次建立共享索引的 embedding 免占单租户额度；重建与查询照常。 */
export function claimSandboxInitialIndex(): boolean {
  if (currentRuntime().kind !== 'sandbox' || pool.indexClaimed) return false;
  pool.indexClaimed = true;
  return true;
}
export function reserveSandboxIndex(estimate: number): Reservation | null {
  return reserve(null, estimate);
}

export function flushSandboxIndexUsage(): Promise<void> {
  pool.chain = pool.chain.then(async () => {
    if (!pool.db || !pool.pending.length) return;
    const batch = pool.pending;
    pool.pending = [];
    pool.flushing = batch;
    const rows = [...new Set(batch.map((p) => p.day))].map((day) => {
      const entries = batch.filter((p) => p.day === day);
      return {
        day,
        calls: entries.reduce((n, p) => n + p.calls, 0),
        costMilli: Math.ceil(entries.reduce((n, p) => n + p.costMilli, 0) - 1e-6),
      };
    });
    try {
      await writeSandboxIndexUsage(pool.db, rows);
    } catch {
      pool.pending.unshift(...batch);
      console.warn('[sandbox] sandbox_index_usage_write_failed');
    } finally {
      pool.flushing = [];
    }
  });
  return pool.chain;
}
/** 正常停机先刷共享索引费用，再释放进程连接。 */
export async function closeSandboxBudgetPool(): Promise<void> {
  if (pool.timer) clearInterval(pool.timer);
  pool.timer = null;
  await flushSandboxIndexUsage();
  if (pool.pending.length) console.warn(`[sandbox] 关闭时丢弃共享索引用量 ${pool.pending.reduce((n, p) => n + p.calls, 0)} 条`);
  pool.pending = [];
  pool.db = null;
}
registerTenantState({
  name: 'budget.sandbox',
  keyCount: (id) => Number(tenantRuntimes().some((rt) => rt.id === id && budgets.has(rt.budget))),
  drop: (id) => {
    for (const rt of tenantRuntimes())
      if (rt.id === id) {
        const s = budgets.get(rt.budget);
        if (s) s.dropped = true;
        budgets.delete(rt.budget);
      }
  },
  reset: () => {
    for (const rt of tenantRuntimes()) {
      const s = budgets.get(rt.budget);
      if (s) Object.assign(s, { calls: 0, costMilli: 0, ready: false });
    }
  },
});
