// 05 沙箱组合根：不启动渠道注册表、任务或宿主文件状态。
import { Hono } from 'hono';
import { assertSandboxWriteRate, validateSandboxLimits, SandboxLimitError } from './limits.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { consolePages } from '../../console-api/host.js';
import { getCookie } from 'hono/cookie';
import { isIP } from 'node:net';
import { clientKey, isCrossSite } from '../../http-guards.js';
import { claimSessionLookup } from '../../auth/session.js';
import { requestLogContext } from '../../log.js';
import {
  sandboxCookie,
  SANDBOX_COOKIE,
  clearSandboxCookie,
  resolveSandboxSession,
  sandboxRefusal,
  setSandboxSession,
  sandboxSessionOf,
  type SandboxSession,
} from './session.js';
import {
  checkConfigDatabase,
  closeConfig,
  ConfigStartupError,
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
import { alert, startAlerts, stopAlertPolling } from '../../ops/alert.js';
import { profile } from '../../profile.js';
import { storeHealth } from '../../store.js';
import { SessionStoreStartupError } from '../../store/backend.js';
import { onShutdown } from '../../shutdown.js';
import { normalizeHost } from '../hosts.js';
import {
  configureTenancy,
  cancelTenantRuntime,
  createTenantRuntime,
  onTenantScopeMissing,
  tenantRuntimes,
  tenantStoreIfLoaded,
  withTenantScope,
  withoutTenantScope,
} from '../runtime.js';
import { createSandboxWecom, type SandboxWecom } from './wecom.js';
import { assertSandboxRunning, sandboxStopped, stopSandboxProcess } from './lifecycle.js';
import { resolveRole, sandboxFlags } from './role.js';
import { loadSandboxRuntime } from './load.js';
import { SandboxReaper } from './reaper.js';
import { drainSandboxProvisioning, provisionSandbox, SandboxProvisionError, type ProvisionedSandbox } from './provision.js';

export class SandboxProcess {
  private deps: ConfigDeps | null = null;
  private lock: ProcessTenantLock | null = null;
  private scopeMissing = 0;
  private unsubscribe: (() => void) | null = null;
  private accepting = false;
  private reaper: SandboxReaper | null = null;
  private wecom: SandboxWecom | null = null;
  epoch: string | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  /** 同步置停、关写队列；不调用 gracefulExit，不放锁后继续服务。 */
  failStop = (): void => {
    if (sandboxStopped()) return;
    stopSandboxProcess();
    this.wecom?.stop();
    this.reaper?.stop();
    for (const rt of tenantRuntimes()) {
      rt.state = 'closed';
      cancelTenantRuntime(rt);
      withTenantScope(rt, markConfigShuttingDown);
      tenantStoreIfLoaded(rt)?.pgBackend?.close();
    }
    console.error('[sandbox] sandbox_process_lock_lost，立即退出');
    this.exit(1);
  };

  async start(): Promise<void> {
    if (resolveRole(this.env) !== 'sandbox') throw new Error('app_role_invalid');
    validateSandboxLimits(this.env);
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
      this.reaper = new SandboxReaper({
        db: this.deps.db,
        acquireTenant: (id) => this.lock!.acquireTenant(id),
        idleMs: Number(this.env.SANDBOX_IDLE_MINUTES ?? 120) * 60_000,
      });
      // R2：先删已到期的，不装载它们；失败留给每分钟的重试。
      await this.reaper.tick();
      // epoch UPDATE 等旧 FOR SHARE 事务落定后，才可读取装载 / 重建所用的数据。
      const rows = await sandboxStartupRows(this.deps.db);
      for (const row of rows) {
        assertSandboxRunning();
        try {
          const rt = await loadSandboxRuntime(this.deps, row, this.env.SANDBOX_HOST!, (id) => this.lock!.acquireTenant(id));
          if (!rt) {
            console.error('[sandbox] sandbox_tenant_lock_held，跳过装载（不改到期）');
            withoutTenantScope(() =>
              alert('tenant_lock', `沙箱 ${row.slug} 的租户锁被其他进程持有，跳过装载（不改到期）`, {
                instance: true,
                scope: `sandbox:${row.id}`,
              }),
            );
          }
        } catch (error) {
          const broken =
            (error instanceof ConfigStartupError &&
              ['pack_unknown', 'no_published_sop', 'integrity', 'contract_failed', 'no_active_routes'].includes(error.reason)) ||
            (error instanceof SessionStoreStartupError && ['preload_integrity', 'demo_class_in_db', 'orphan_order'].includes(error.reason));
          if (!broken) throw error;
          await expireBrokenSandbox(this.deps.db, row.id);
          console.error('[sandbox] sandbox_data_invalid，已标到期并跳过');
        }
      }
      this.wecom = createSandboxWecom(this.env, this.deps.db, this.epoch);
      await withoutTenantScope(() => this.wecom?.start());
      withoutTenantScope(() => onShutdown(() => this.wecom?.close()));
      this.unsubscribe = withoutTenantScope(() =>
        onTenantScopeMissing(() => {
          this.scopeMissing++;
          if (!sandboxStopped()) alert('tenant_scope_missing', '后台入口缺少租户作用域');
        }),
      );
      console.log(`[sandbox] 已启动，装载沙箱 ${tenantRuntimes().length}`);
      this.accepting = true;
      await this.reaper.start();
      withoutTenantScope(() => onShutdown(() => this.reaper?.stop()));
      withoutTenantScope(startAlerts);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** 第 15 步的 POST 核心入口；同源检查、cookie 复用与签发由 HTTP 层负责。 */
  provision(input: { ip: string | null; userAgent: string | null }): Promise<ProvisionedSandbox> {
    if (!this.accepting || !this.deps || !this.lock || this.epoch === null)
      return Promise.reject(new SandboxProvisionError(503, 'sandbox_unavailable'));
    return provisionSandbox({
      ...input,
      env: this.env,
      deps: this.deps,
      templateSlug: this.env.SANDBOX_TEMPLATE_SLUG!,
      host: this.env.SANDBOX_HOST!,
      epoch: this.epoch,
      acquireTenant: (id) => this.lock!.acquireTenant(id),
    });
  }

  async resolve(token: string | undefined): Promise<SandboxSession> {
    if (!this.deps) return Promise.reject(new SandboxProvisionError(503, 'sandbox_unavailable'));
    const session = await withoutTenantScope(() => resolveSandboxSession(this.deps!.db, token));
    if (session.status === 'ok') this.reaper?.touch(session.runtime);
    return session;
  }

  async end(tenantId: string): Promise<void> {
    assertSandboxRunning();
    if (!this.deps) throw new SandboxProvisionError(503, 'sandbox_unavailable');
    if (!this.reaper) throw new SandboxProvisionError(503, 'sandbox_unavailable');
    await this.reaper.end(tenantId);
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.wecom?.close();
    this.wecom = null;
    stopAlertPolling();
    this.reaper?.stop();
    await this.reaper?.drain();
    this.reaper = null;
    await drainSandboxProvisioning();
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const rt of tenantRuntimes()) {
      if (rt.kind !== 'sandbox') continue;
      rt.state = 'closed';
      cancelTenantRuntime(rt);
      tenantStoreIfLoaded(rt)?.pgBackend?.close();
      await withTenantScope(rt, closeConfig);
      // 保留到 exit：store 的退出钩子还要统计未落库条数，且沙箱不写 spill。
    }
    await this.lock?.release();
    await this.deps?.closeDb?.();
    this.lock = null;
    this.deps = null;
    this.epoch = null;
  }

  wecomRoutes(): Hono | null {
    return this.wecom?.routes ?? null;
  }

  async health() {
    const health = tenantRuntimes().map((rt) => withTenantScope(rt, storeHealth));
    let reachable = !!this.deps;
    let pool = { day: '', provisioned: 0, costMilli: 0 };
    let purgeOverdue = 0;
    try {
      if (this.deps) pool = await sandboxPoolHealth(this.deps.db);
      purgeOverdue = (await this.reaper?.overdue()) ?? 0;
    } catch {
      reachable = false;
    }
    return {
      ok: reachable && !sandboxStopped() && purgeOverdue === 0,
      revision: this.env.APP_REVISION || 'dev',
      role: 'sandbox' as const,
      sandboxes: tenantRuntimes().filter((rt) => rt.kind === 'sandbox').length,
      purgeOverdue,
      scopeMissing: this.scopeMissing,
      pool: { ...pool, capMilli: Number(this.env.SANDBOX_POOL_DAILY_CNY ?? 10) * 1000 },
      llmGate: gateStatus(),
      store: { lagMs: Math.max(0, ...health.map((h) => h.lagMs)), poisoned: health.reduce((n, h) => n + h.poisoned.length, 0) },
      wecom: this.wecom?.health() ?? { configured: false, full: false, bound: 0, lastSyncOkAt: null, failing: false },
    };
  }
}

/** 沙箱边界在共用路由之前运行；选择结果沿 Hono Context 传给 console 与公开页面。 */
export function sandboxApp(
  process: Pick<SandboxProcess, 'health' | 'resolve' | 'provision' | 'end'> & Partial<Pick<SandboxProcess, 'wecomRoutes'>>,
  host: string,
  routes?: Hono,
) {
  const app = new Hono();
  app.use('/*', requestLogContext);
  app.use('/*', async (c, next) => {
    if (sandboxStopped()) return c.json({ error: 'sandbox_process_stopped' }, 503);
    if (c.req.path !== '/healthz' && normalizeHost(c.req.header('host') ?? '') !== normalizeHost(host)) return c.notFound();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && isCrossSite(c)) return c.json({ error: 'cross_site' }, 403);
    return next();
  });
  app.get('/healthz', async (c) => c.json(await process.health()));
  // app 在 start() 之前创建：每次请求现取已启动的实例路由，不捕获启动前的 null。
  app.all('/wecom/callback', (c) => process.wecomRoutes?.()?.fetch(c.req.raw) ?? c.notFound());
  app.use('/console/assets/*', async (c) => consolePages.fetch(c.req.raw));
  app.get('/share-cover.png', serveStatic({ root: './public' }));
  app.get('/web.css', serveStatic({ root: './public' }));
  app.get('/web.js', serveStatic({ root: './public' }));
  app.use('/*', async (c, next) => {
    // 固定不存在的入口不能落进宿主路由或匿名静态兜底。
    if (
      /^\/api\/console\/auth\/(?:login|logout)\/?$/.test(c.req.path) ||
      /^\/(?:guide\.html|admin\.html|kf-qr\.png|wecom(?:\/|$)|w(?:\/|$)|wx(?:\/|$))/i.test(c.req.path) ||
      /^\/api\/(?:admin|web|usage|insights)(?:\/|$)/.test(c.req.path) ||
      /^\/api\/(?:sessions|orders)\/?$/.test(c.req.path) ||
      /^\/api\/sessions\/[^/]+\//.test(c.req.path)
    )
      return c.notFound();
    const token = getCookie(c, SANDBOX_COOKIE);
    // 与宿主共用限流：查库前同步占名额，只有无效 cookie 保留计数。
    const giveBack = token ? claimSessionLookup(clientKey(c), Date.now()) : undefined;
    let session: SandboxSession;
    try {
      session = token && !giveBack ? { status: 'invalid' } : await process.resolve(token);
    } catch (error) {
      giveBack?.();
      throw error;
    }
    if (session.status !== 'invalid') giveBack?.();
    if (session.status === 'unavailable') return c.json({ error: 'sandbox_unavailable' }, 503);
    if (session.status !== 'ok') {
      if (c.req.path !== '/try' && !(c.req.path === '/api/sandbox' && c.req.method === 'POST')) return sandboxRefusal(c, session.status);
      clearSandboxCookie(c);
      return next();
    }
    setSandboxSession(c, session);
    return withTenantScope(session.runtime, () => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) assertSandboxWriteRate();
      return next();
    });
  });
  // 第 16 步替换为完整开通页；GET 永远不建租户。
  app.get('/try', (c) =>
    c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>体验工作台</title><body>体验工作台</body></html>'),
  );
  app.post('/api/sandbox', async (c) => {
    if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'unsupported_media_type' }, 415);
    const session = sandboxSessionOf(c);
    if (session) return c.json({ url: '/console/', expiresAt: session.expiresAt }, 200);
    const ip = clientKey(c).replace(/%.*$/, '');
    const result = await process.provision({ ip: isIP(ip) ? ip : null, userAgent: c.req.header('user-agent')?.slice(0, 512) ?? null });
    c.header('Set-Cookie', sandboxCookie(result.token, result.expiresAt.toISOString()));
    return c.json({ url: '/console/', expiresAt: result.expiresAt.toISOString() }, 201);
  });
  app.post('/api/sandbox/end', async (c) => {
    const session = sandboxSessionOf(c)!;
    await process.end(session.user.tenantId);
    clearSandboxCookie(c);
    return c.json({ ok: true }, 200);
  });
  if (routes) app.route('/', routes);
  app.onError((error, c) => {
    if (error instanceof SandboxLimitError) {
      c.header('Retry-After', String(error.retryAfter));
      return c.json({ error: error.reason, retryAfter: error.retryAfter }, error.status);
    }
    if (error instanceof SandboxProvisionError) {
      if (error.retryAfter) c.header('Retry-After', String(error.retryAfter));
      return c.json({ error: error.reason, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) }, error.status);
    }
    console.error('[sandbox-http] 请求失败', error instanceof Error ? error.name : 'unknown');
    return c.json({ error: 'sandbox_unavailable' }, 503);
  });
  return app;
}
