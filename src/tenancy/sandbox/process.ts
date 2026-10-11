// 05 第 12 步组合根：不启动渠道注册表、任务、宿主文件状态或体验客服。
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  checkConfigDatabase,
  closeConfig,
  ConfigStartupError,
  initConfig,
  markConfigShuttingDown,
  productionConfigDeps,
  type ConfigDeps,
} from '../../config/source.js';
import {
  acquireSandboxProcess,
  advanceSandboxEpoch,
  checkSandboxStartup,
  expireBrokenSandbox,
  sandboxPoolHealth,
  sandboxStartupRows,
} from '../../db/sandbox-process.js';
import type { ProcessTenantLock } from '../../db/client.js';
import { gateStatus } from '../../llm-gate.js';
import { alert } from '../../ops/alert.js';
import { profile } from '../../profile.js';
import { initPrivacy } from '../../privacy/privacy.js';
import { initSessionStore, storeHealth } from '../../store.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { dropTenantState } from '../state.js';
import { SessionStoreStartupError } from '../../store/backend.js';
import { normalizeHost } from '../hosts.js';
import {
  configureTenancy,
  createTenantRuntime,
  onTenantScopeMissing,
  registerRuntime,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
  withoutTenantScope,
} from '../runtime.js';
import { assertSandboxRunning, sandboxStopped, stopSandboxProcess } from './lifecycle.js';
import { resolveRole, sandboxFlags } from './role.js';

export class SandboxProcess {
  private deps: ConfigDeps | null = null;
  private lock: ProcessTenantLock | null = null;
  private scopeMissing = 0;
  private unsubscribe: (() => void) | null = null;
  epoch: string | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  /** 同步置停、关写队列；不调用 gracefulExit，不放锁后继续服务。 */
  failStop = (): void => {
    if (sandboxStopped()) return;
    stopSandboxProcess();
    for (const rt of tenantRuntimes()) {
      rt.state = 'closed';
      withTenantScope(rt, markConfigShuttingDown);
      tenantStoreIfLoaded(rt)?.pgBackend?.close();
    }
    console.error('[sandbox] sandbox_process_lock_lost，立即退出');
    this.exit(1);
  };

  async start(): Promise<void> {
    if (resolveRole(this.env) !== 'sandbox') throw new Error('app_role_invalid');
    configureTenancy({ role: 'sandbox', standardCount: 0 });
    // 第一把锁取不到时不打开配置、不装载、不改任何沙箱。
    this.lock = await acquireSandboxProcess(this.env.DATABASE_URL ?? '', this.failStop);
    try {
      const startup = createTenantRuntime({ id: 'sandbox-startup', slug: '', kind: 'sandbox', flags: sandboxFlags(profile().flags) });
      this.deps = await withTenantScope(startup, () =>
        productionConfigDeps(this.env, () => this.failStop(), {
          tenantSlug: this.env.SANDBOX_TEMPLATE_SLUG,
        }),
      );
      await checkConfigDatabase(this.deps);
      await checkSandboxStartup(this.deps.db, this.env.SANDBOX_TEMPLATE_SLUG!, this.env.SANDBOX_WECOM_OPEN_KFID);
      this.epoch = await advanceSandboxEpoch(this.deps.db);
      // epoch UPDATE 等旧 FOR SHARE 事务落定后，才可读取装载 / 重建所用的数据。
      const rows = await sandboxStartupRows(this.deps.db);
      for (const row of rows) {
        assertSandboxRunning();
        const held = await this.lock.acquireTenant(row.id);
        if (!held) {
          console.error('[sandbox] sandbox_tenant_lock_held，跳过装载（不改到期）');
          withoutTenantScope(() =>
            alert('tenant_lock', `沙箱 ${row.slug} 的租户锁被其他进程持有，跳过装载（不改到期）`, {
              instance: true,
              scope: `sandbox:${row.id}`,
            }),
          );
          continue;
        }
        const rt = createTenantRuntime({
          id: row.id,
          slug: row.slug,
          kind: 'sandbox',
          expiresAt: new Date(row.expiresAt).getTime(),
          publicBase: `https://${normalizeHost(this.env.SANDBOX_HOST!)}`,
          flags: sandboxFlags(profile().flags),
        });
        registerRuntime(rt);
        try {
          await withTenantScope(rt, async () => {
            await initConfig({ ...this.deps!, tenantSlug: row.slug, lock: async () => held, closeDb: undefined });
            await initSessionStore({ db: this.deps!.db, tenantId: row.id, tenantSlug: row.slug, varDir: '' });
            await initPrivacy(); // 不启动隐私轮询。
          });
        } catch (error) {
          rt.state = 'closed';
          tenantStoreIfLoaded(rt)?.pgBackend?.close();
          await held.release();
          dropTenantState(rt.id);
          dropShutdownHooks(rt);
          unregisterRuntime(rt.id);
          const broken =
            (error instanceof ConfigStartupError &&
              ['pack_unknown', 'no_published_sop', 'integrity', 'contract_failed', 'no_active_routes'].includes(error.reason)) ||
            (error instanceof SessionStoreStartupError && ['preload_integrity', 'demo_class_in_db', 'orphan_order'].includes(error.reason));
          if (!broken) throw error;
          await expireBrokenSandbox(this.deps.db, row.id);
          console.error('[sandbox] sandbox_data_invalid，已标到期并跳过');
        }
      }
      this.unsubscribe = withoutTenantScope(() =>
        onTenantScopeMissing(() => {
          this.scopeMissing++;
          if (!sandboxStopped()) alert('tenant_scope_missing', '后台入口缺少租户作用域');
        }),
      );
      console.log(`[sandbox] 已启动，装载沙箱 ${tenantRuntimes().length}`);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const rt of tenantRuntimes()) await withTenantScope(rt, closeConfig);
    await this.lock?.release();
    await this.deps?.closeDb?.();
  }

  async health() {
    const health = tenantRuntimes().map((rt) => withTenantScope(rt, storeHealth));
    let reachable = !!this.deps;
    let pool = { day: '', provisioned: 0, costMilli: 0 };
    try {
      if (this.deps) pool = await sandboxPoolHealth(this.deps.db);
    } catch {
      reachable = false;
    }
    return {
      ok: reachable && !sandboxStopped(),
      revision: this.env.APP_REVISION || 'dev',
      role: 'sandbox' as const,
      sandboxes: tenantRuntimes().filter((rt) => rt.kind === 'sandbox').length,
      purgeOverdue: 0,
      scopeMissing: this.scopeMissing,
      pool: { ...pool, capMilli: Number(this.env.SANDBOX_POOL_DAILY_CNY ?? 10) * 1000 },
      llmGate: gateStatus(),
      store: { lagMs: Math.max(0, ...health.map((h) => h.lagMs)), poisoned: health.reduce((n, h) => n + h.poisoned.length, 0) },
      wecom: { configured: false, full: false, bound: 0, lastSyncOkAt: null, failing: false },
    };
  }
}

/** 后续第 15、16 步接免密租户解析与页面；本步只挂健康检查及不带数据的静态资源。 */
export function sandboxApp(process: SandboxProcess, host: string): Hono {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    if (sandboxStopped()) return c.json({ error: 'sandbox_process_stopped' }, 503);
    if (c.req.path !== '/healthz' && normalizeHost(c.req.header('host') ?? '') !== normalizeHost(host)) return c.notFound();
    return next();
  });
  app.get('/healthz', async (c) => c.json(await process.health()));
  app.use('/console/assets/*', serveStatic({ root: './console/dist', rewriteRequestPath: (p) => p.replace(/^\/console/, '') }));
  return app;
}
