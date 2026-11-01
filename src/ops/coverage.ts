import { writeCoverageCheckpoint } from '../db/repo/ops-coverage.js';
import { todayIso } from '../env.js';
import { storeHealth, withJobsTx, type StoreHealth } from '../store.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { invalidateTrends } from './trends.js';

const checkpoints = new TenantLocal(() => ({ written: false }));
registerTenantState({ name: 'ops.coverage', ...checkpoints.registration((s) => Number(s.written)) });

/** 成功提交才记住已启动；失败后的首次重试仍标 gap。分钟入口保证逐租户串行。 */
export async function checkpointCoverage(now = Date.now(), health: StoreHealth = storeHealth()): Promise<void> {
  const rt = currentRuntime();
  const state = checkpoints.get(rt);
  const gap = !state.written || health.conflict || health.poisoned.length > 0 || health.lagMs > 60_000;
  await withJobsTx((tx) => writeCoverageCheckpoint(tx, todayIso(new Date(now)), new Date(now), gap));
  if (!rt.cancel.aborted && checkpoints.owns(rt, state)) {
    state.written = true;
    // coverage 变了，展示缓存里的完整性判断随之作废
    invalidateTrends();
  }
}
