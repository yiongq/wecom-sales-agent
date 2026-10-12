// 开通和启动共用同一个预载入口；取锁之后才装配置、会话和隐私说明。
import { closeConfig, initConfig, type ConfigDeps } from '../../config/source.js';
import type { TenantLock } from '../../db/client.js';
import { watchStoreAlerts } from '../../ops/alert.js';
import { initPrivacy } from '../../privacy/privacy.js';
import { initSessionStore } from '../../store.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { profile } from '../../profile.js';
import { dropTenantState } from '../state.js';
import {
  createTenantRuntime,
  registerRuntime,
  runtimeOf,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
  type TenantRuntime,
} from '../runtime.js';
import { normalizeHost } from '../hosts.js';
import { assertSandboxRunning } from './lifecycle.js';
import { sandboxFlags } from './role.js';
import { initializeSandboxBudget } from './budget.js';
import { withTenant } from '../../db/client.js';
import { readSandboxWechat } from '../../db/repo/sandbox-wechat.js';
import { sandboxWechatIndex } from './outbound.js';
import { buildIndex } from '../../core/retrieval.js';

export interface SandboxRow {
  id: string;
  slug: string;
  expiresAt: Date | string;
}

export async function loadSandboxRuntime(
  deps: ConfigDeps,
  row: SandboxRow,
  host: string,
  acquire: (tenantId: string) => Promise<TenantLock | null>,
): Promise<TenantRuntime | null> {
  assertSandboxRunning();
  if (runtimeOf(row.id)) throw new Error('sandbox_already_loaded');
  const held = await acquire(row.id);
  if (!held) return null;
  const rt = createTenantRuntime({
    id: row.id,
    slug: row.slug,
    kind: 'sandbox',
    expiresAt: new Date(row.expiresAt).getTime(),
    publicBase: `https://${normalizeHost(host)}`,
    flags: sandboxFlags(profile().flags),
  });
  try {
    registerRuntime(rt);
    await withTenantScope(rt, async () => {
      await initConfig({ ...deps, tenantSlug: row.slug, lock: async () => held, closeDb: undefined });
      await initializeSandboxBudget(rt, deps.db);
      await initSessionStore({ db: deps.db, tenantId: row.id, tenantSlug: row.slug, varDir: '' });
      await initPrivacy({ strict: true });
      const wechat = await withTenant(
        deps.db,
        { tenantId: rt.id, actor: { kind: 'system', userId: null, name: null, ip: null } },
        readSandboxWechat,
      );
      assertSandboxRunning();
      // 无微信附属行的底层建租户仍可服务工作台；未发布令牌时出站与 /wx/ 均拒绝。
      if (wechat) {
        sandboxWechatIndex.publishLink(rt, wechat.linkToken);
        if (wechat.codeHash && wechat.codeExpiresAt)
          sandboxWechatIndex.publishCode(rt, wechat.codeHash, new Date(wechat.codeExpiresAt).getTime());
        if (wechat.externalUserid && wechat.boundAt)
          sandboxWechatIndex.publishRebuiltBinding(rt, wechat.externalUserid, BigInt(wechat.boundAt));
      }
      watchStoreAlerts();
      void buildIndex().catch(() => console.warn('[sandbox] sandbox_index_build_failed'));
    });
    assertSandboxRunning();
    return rt;
  } catch (error) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig).catch(() => {});
    await held.release();
    dropTenantState(rt.id);
    dropShutdownHooks(rt);
    unregisterRuntime(rt.id);
    throw error;
  }
}
