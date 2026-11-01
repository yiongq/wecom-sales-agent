// 实例唯一分钟入口；第 5 步的延迟窗口检查接在同一租户作用域内。
import { configHealth, configMode, tenantLockTaken } from '../config/source.js';
import { onShutdown, sessionStoreMode } from '../store.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { tenantRuntimes, tenantStoreIfLoaded, withTenantScope, withoutTenantScope } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { checkpointCoverage } from './coverage.js';

const failures = new TenantLocal(() => ({ loggedAt: -Infinity }));
registerTenantState({ name: 'ops.minute.failures', ...failures.registration((s) => Number(Number.isFinite(s.loggedAt))) });
let timer: ReturnType<typeof setInterval> | null = null;
let pending: Promise<void> | null = null;

async function tick(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    if (!timer) break;
    if (rt.kind !== 'standard' || rt.state !== 'serving' || rt.cancel.aborted || !tenantStoreIfLoaded(rt)) continue;
    await withTenantScope(rt, async () => {
      try {
        if (configMode() !== 'db' || sessionStoreMode() !== 'db' || configHealth().lock !== 'held' || tenantLockTaken()) return;
        await rt.inflight.track(async () => {
          await checkpointCoverage();
          // 第 5 步：在这里检查已结束的延迟窗口。
        });
      } catch {
        const state = failures.get(rt);
        const now = Date.now();
        if (now - state.loggedAt >= 30 * 60_000) {
          state.loggedAt = now;
          console.warn('[ops] 分钟检查失败，留待下次重试');
        }
      }
    });
  }
}
function run(): void {
  if (!pending)
    pending = tick().finally(() => {
      pending = null;
    });
}

export function startOpsMinute(): void {
  if (timer || process.env.APP_ROLE === 'sandbox') return;
  withoutTenantScope(() => {
    timer = setInterval(run, 60_000);
    timer.unref();
    onShutdown(async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await pending;
    });
    run();
  });
}
