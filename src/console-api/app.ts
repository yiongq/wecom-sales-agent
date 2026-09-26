// 后台接口子应用（docs/architecture/01-pg-config-console/spec.md「后台 API 与页面」）。
// 必须链式注册，Hono RPC 才推得出类型（ADR-002）；console/src 只用 import type 引 ConsoleApp。
// 公共中间件依次是：安全头 → 只在 DB 模式 → 读会话 → 写保护；每个路由再挂自己的权限，没匹配上的路径匿名一律 401。
// prod（anon_readonly_admin 关）下匿名除了登录处处 401，靠的就是每个路由都挂了权限、兜底也是 401。
// 匿名（demo）只拿投影，出自进程内缓存与快照、不查库，并挂查询限流。命名错误在 onError 里统一映射成 { error, … }。
import { isIP } from 'node:net';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { PasswordBusyError } from '../auth/password.js';
import {
  ABSOLUTE_MS,
  allowSessionLookup,
  LoginRateLimitedError,
  login,
  logout,
  noteInvalidSession,
  resolveSession,
  SESSION_COOKIE,
  type AuthedUser,
} from '../auth/session.js';
import { listAudit } from '../config/audit.js';
import {
  activateCatalogItem,
  CatalogCodeTakenError,
  CatalogLockedFieldError,
  CatalogNotFoundError,
  CatalogRevConflictError,
  CatalogValidationError,
  createCatalogItem,
  getCatalogItem,
  listCatalog,
  updateCatalogItem,
} from '../config/catalog.js';
import {
  checkSopDraft,
  discardSopDraft,
  getSopOverview,
  getSopVersion,
  listSopVersions,
  publishSopDraft,
  rollbackSop,
  saveSopDraft,
  SopConflictError,
  SopContractError,
  SopInputError,
  SopLockedSectionError,
  SopNotFoundError,
  SopRevConflictError,
} from '../config/sop.js';
import {
  ConfigLockLostError,
  ConfigNotReadyError,
  configDrift,
  configHealth,
  configMode,
  configRuntime,
  currentCatalog,
  currentSop,
} from '../config/source.js';
import { isUniqueViolation, type TenantCtx } from '../db/client.js';
import { clientKey, isCrossSite, lookupLimit } from '../http-guards.js';
import { profile } from '../profile.js';
import { indexHealth } from '../retrieval.js';
import {
  AuditQuery,
  CatalogItemParam,
  CatalogKindParam,
  CreateItemBody,
  LoginBody,
  PatchItemBody,
  PublishBody,
  RevBody,
  RollbackBody,
  SaveDraftBody,
  VersionsQuery,
  type AnonCatalogItem,
  type AnonSopOverview,
  type AnonStatus,
  type ApiError,
  type AuditPage,
  type CatalogItem,
  type DraftCheck,
  type Me,
  type Role,
  type RollbackResult,
  type SopOverview,
  type SopVersion,
  type Status,
} from '../shared/console-api.js';
import { SopEncodingError, SopStructureError } from '../sop/sections.js';
import { safeEqual } from '../wecom-crypto.js';

type ConsoleEnv = { Variables: { user: AuthedUser | null; token: string | null } };

/** /console/* 与 /api/console/* 共用：响应里有 csrf 和草稿，不许缓存；同源的 XSS 能拿到 csrf，CSP 只许本站脚本 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
};

let clock = (): number => Date.now();

/**
 * cookie 里的后台会话。文件模式没有账号，一律 null。带 cookie 但会话无效的请求先按 IP 限流，过了才查库。
 * server.ts 的 /api/admin/stream 也用它
 */
export async function consoleSession(c: Context): Promise<{ user: AuthedUser; token: string } | null> {
  if (configMode() !== 'db') return null;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const ip = clientKey(c);
  const now = clock();
  if (!allowSessionLookup(ip, now)) return null;
  const user = await resolveSession(token, now);
  if (!user) {
    noteInvalidSession(ip, now);
    return null;
  }
  return { user, token };
}

const fail = (c: Context, status: 401 | 403 | 404 | 415, body: ApiError) => c.json(body, status);
const unauthorized = (c: Context) => fail(c, 401, { error: 'unauthorized', detail: '需要登录后台' });

const LOGIN_PATH = '/api/console/auth/login';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;
const EDITORS: ReadonlySet<Role> = new Set(['owner', 'admin']);

const requireDbMode: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (configMode() === 'db') return next();
  const body: ApiError = { error: 'db_disabled', detail: '后台只在 CONFIG_SOURCE=db 时可用' };
  return c.json(body, 503);
};

const loadSession: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const s = await consoleSession(c);
  c.set('user', s?.user ?? null);
  c.set('token', s?.token ?? null);
  return next();
};

/**
 * 非 GET 请求：跨站一律 403（沿用 sameOriginOnly 的判定）；登录接口还没有会话，只要求 application/json——
 * 跨站请求带这个类型必须先过 CORS 预检，而我们不开 CORS；其余要有效会话，且 x-csrf 等于 csrfFor(token)
 */
const guardWrites: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  if (isCrossSite(c)) return fail(c, 403, { error: 'cross_site', detail: '跨站请求已拒绝' });
  if (c.req.path === LOGIN_PATH) {
    if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) return fail(c, 415, { error: 'unsupported_media_type' });
    return next();
  }
  const { user } = c.var;
  if (!user) return unauthorized(c);
  if (!safeEqual(c.req.header('x-csrf') ?? '', user.csrf))
    return fail(c, 403, { error: 'csrf', detail: 'x-csrf 缺失或不对，刷新页面后重试' });
  return next();
};

/** 读 SOP、产品库、状态：成员都行；demo 下匿名拿投影，挂查询限流 */
const canRead: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (c.var.user) return next();
  return profile().flags.anon_readonly_admin ? lookupLimit(c, next) : unauthorized(c);
};
/** 只给成员：版本历史、单个版本（会话只读列表在第 13 步） */
const signedIn: MiddlewareHandler<ConsoleEnv> = async (c, next) => (c.var.user ? next() : unauthorized(c));
/** 改 SOP、发布、回滚、上新、编辑、上架，以及看审计：只有 owner / admin */
const ownerOrAdmin: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const { user } = c.var;
  if (!user) return unauthorized(c);
  return EDITORS.has(user.role) ? next() : fail(c, 403, { error: 'forbidden', detail: '只有 owner 和 admin 能做这件事' });
};
const canEdit = ownerOrAdmin;
const canAudit = ownerOrAdmin;

/** 请求体、查询串、路径参数不合规：400，逐条列出 */
const badRequest = (
  result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } },
  c: Context,
) => {
  if (result.success) return;
  const issues = (result.error?.issues ?? []).map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  const body: ApiError = { error: 'bad_request', issues };
  return c.json(body, 400);
};

/** 审计与操作者：库里的 ip 列是 inet，拿不到合法地址就记 null */
function dbIp(c: Context): string | null {
  const k = clientKey(c).replace(/%.*$/, '');
  return isIP(k) ? k : null;
}

function ctxOf(c: Context<ConsoleEnv>): TenantCtx {
  const u = c.var.user!;
  return { tenantId: u.tenantId, actor: { kind: 'user', userId: u.userId, name: u.displayName, ip: dbIp(c) } };
}

const meOf = (u: AuthedUser): Me => ({
  userId: u.userId,
  displayName: u.displayName,
  role: u.role,
  csrf: u.csrf,
  tenantSlug: configRuntime().deps.tenantSlug,
});

const cookie = (value: string, maxAgeSec: number): string =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;

/** 命名错误 → 状态码与 { error, … }；不认识的返回 null，按 500 处理 */
function mapError(e: unknown): { status: 400 | 404 | 409 | 422 | 429 | 503; body: ApiError } | null {
  if (e instanceof HTTPException) return { status: 400, body: { error: 'bad_request', detail: e.message } };
  if (e instanceof SopConflictError)
    return { status: 409, body: { error: 'sop_conflict', detail: e.message, keys: e.keys, current: e.current } };
  if (e instanceof SopRevConflictError || e instanceof CatalogRevConflictError) {
    return { status: 409, body: { error: 'rev_conflict', detail: e.message } };
  }
  if (e instanceof CatalogCodeTakenError) return { status: 409, body: { error: 'catalog_code_taken', detail: e.message } };
  if (isUniqueViolation(e)) return { status: 409, body: { error: 'conflict', detail: '并发写入冲突，刷新后重来' } };
  if (e instanceof SopLockedSectionError) return { status: 422, body: { error: 'locked_section', detail: e.message, keys: [e.key] } };
  if (e instanceof SopContractError) return { status: 422, body: { error: 'contract', detail: e.message, violations: e.violations } };
  if (e instanceof SopInputError || e instanceof SopEncodingError || e instanceof SopStructureError) {
    return { status: 422, body: { error: 'invalid_sop', detail: e.message } };
  }
  if (e instanceof CatalogLockedFieldError) return { status: 422, body: { error: 'locked_field', detail: e.message, fields: e.fields } };
  if (e instanceof CatalogValidationError) return { status: 422, body: { error: 'invalid_item', detail: e.message, issues: e.issues } };
  if (e instanceof SopNotFoundError || e instanceof CatalogNotFoundError)
    return { status: 404, body: { error: 'not_found', detail: e.message } };
  if (e instanceof LoginRateLimitedError) return { status: 429, body: { error: 'rate_limited', detail: e.message } };
  if (e instanceof PasswordBusyError) return { status: 429, body: { error: 'busy', detail: e.message } };
  if (e instanceof ConfigLockLostError)
    return { status: 503, body: { error: 'lock_lost', detail: '租户锁连接断开，配置写入暂停，稍后再试' } };
  if (e instanceof ConfigNotReadyError) return { status: 503, body: { error: 'not_ready', detail: '配置还没装载好' } };
  return null;
}

export const consoleApi = new Hono<ConsoleEnv>()
  .basePath('/api/console')
  .use('*', securityHeaders, requireDbMode, loadSession, guardWrites)

  // ---------------- 登录 ----------------
  .post('/auth/login', zValidator('json', LoginBody, badRequest), async (c) => {
    const { email, password } = c.req.valid('json');
    const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
    const r = await login({ email, password, ip: dbIp(c), userAgent, now: clock() });
    // 未知邮箱、口令错误、账号停用、不是本实例成员：状态码与响应体完全相同
    if (!r) return fail(c, 401, { error: 'invalid_credentials', detail: '邮箱或口令不对' });
    c.header('Set-Cookie', cookie(r.token, ABSOLUTE_MS / 1000));
    return c.json(meOf(r.user), 200);
  })
  .post('/auth/logout', async (c) => {
    await logout(c.var.token!, clock());
    c.header('Set-Cookie', cookie('', 0));
    return c.json({ ok: true as const }, 200);
  })
  .get('/me', signedIn, (c) => c.json(meOf(c.var.user!), 200))

  // ---------------- 状态 ----------------
  .get('/status', canRead, (c) => {
    if (!c.var.user) {
      const anon: AnonStatus = { mode: 'db' };
      return c.json(anon, 200);
    }
    const sop = currentSop();
    const h = configHealth();
    const body: Status = {
      mode: 'db',
      tenantSlug: configRuntime().deps.tenantSlug,
      sop: {
        versionId: sop.versionId,
        versionNo: sop.versionNo,
        publishedAt: sop.publishedAt,
        promptHash: sop.promptHash,
        toolsHash: sop.toolsHash,
        prefixHash: sop.prefixHash,
        sopHash: sop.sopHash,
      },
      lock: h.lock,
      sopStale: h.sopStale,
      catalogStale: h.catalogStale,
      index: indexHealth(),
      drift: configDrift(),
    };
    return c.json(body, 200);
  })

  // ---------------- SOP ----------------
  .get('/sop', canRead, async (c) => {
    if (!c.var.user) {
      const s = currentSop();
      const anon: AnonSopOverview = {
        published: { versionNo: s.versionNo, publishedAt: s.publishedAt, promptHash: s.promptHash.slice(0, 12), sections: s.sections },
      };
      return c.json(anon, 200);
    }
    const body: SopOverview = await getSopOverview(ctxOf(c));
    return c.json(body, 200);
  })
  .get('/sop/versions', signedIn, zValidator('query', VersionsQuery, badRequest), async (c) => {
    const q = c.req.valid('query');
    const items: SopVersion[] = await listSopVersions(ctxOf(c), { limit: q.limit ?? 20, beforeVersionNo: q.before });
    return c.json({ items }, 200);
  })
  .get('/sop/versions/:id', signedIn, async (c) => {
    const body: SopVersion = await getSopVersion(ctxOf(c), c.req.param('id'));
    return c.json(body, 200);
  })
  .put('/sop/draft', canEdit, zValidator('json', SaveDraftBody, badRequest), async (c) => {
    const body: SopVersion = await saveSopDraft(ctxOf(c), c.req.valid('json'));
    return c.json(body, 200);
  })
  // 总是 200 带 violations；只有 publish 在有 violation 时 422
  .post('/sop/draft/check', canEdit, async (c) => {
    const body: DraftCheck = await checkSopDraft(ctxOf(c));
    return c.json(body, 200);
  })
  .post('/sop/draft/publish', canEdit, zValidator('json', PublishBody, badRequest), async (c) => {
    const body: SopVersion = await publishSopDraft(ctxOf(c), c.req.valid('json'));
    return c.json(body, 200);
  })
  .post('/sop/draft/discard', canEdit, zValidator('json', RevBody, badRequest), async (c) => {
    await discardSopDraft(ctxOf(c), c.req.valid('json'));
    return c.json({ ok: true as const }, 200);
  })
  .post('/sop/versions/:id/rollback', canEdit, zValidator('json', RollbackBody, badRequest), async (c) => {
    const body: RollbackResult = await rollbackSop(ctxOf(c), { versionId: c.req.param('id'), changeNote: c.req.valid('json').changeNote });
    return c.json(body, 200);
  })

  // ---------------- 产品库 ----------------
  .get('/catalog/:kind', canRead, zValidator('param', CatalogKindParam, badRequest), async (c) => {
    const { kind } = c.req.valid('param');
    if (!c.var.user) {
      const snap = currentCatalog();
      const items: AnonCatalogItem[] = (kind === 'route' ? snap.routes : snap.hotels).map((p) => ({ kind, code: p.id, payload: p }));
      return c.json({ items }, 200);
    }
    const items: CatalogItem[] = await listCatalog(ctxOf(c), kind);
    return c.json({ items }, 200);
  })
  .get('/catalog/:kind/:code', canRead, zValidator('param', CatalogItemParam, badRequest), async (c) => {
    const { kind, code } = c.req.valid('param');
    if (!c.var.user) {
      const snap = currentCatalog();
      const p = (kind === 'route' ? snap.routes : snap.hotels).find((x) => x.id === code);
      if (!p) return fail(c, 404, { error: 'not_found' });
      const anon: AnonCatalogItem = { kind, code, payload: p };
      return c.json(anon, 200);
    }
    const item: CatalogItem | null = await getCatalogItem(ctxOf(c), kind, code);
    if (!item) return fail(c, 404, { error: 'not_found' });
    return c.json(item, 200);
  })
  .post(
    '/catalog/:kind',
    canEdit,
    zValidator('param', CatalogKindParam, badRequest),
    zValidator('json', CreateItemBody, badRequest),
    async (c) => {
      const item: CatalogItem = await createCatalogItem(ctxOf(c), c.req.valid('param').kind, c.req.valid('json').payload);
      return c.json(item, 200);
    },
  )
  .patch(
    '/catalog/:kind/:code',
    canEdit,
    zValidator('param', CatalogItemParam, badRequest),
    zValidator('json', PatchItemBody, badRequest),
    async (c) => {
      const { kind, code } = c.req.valid('param');
      const item: CatalogItem = await updateCatalogItem(ctxOf(c), kind, code, c.req.valid('json'));
      return c.json(item, 200);
    },
  )
  .post(
    '/catalog/:kind/:code/activate',
    canEdit,
    zValidator('param', CatalogItemParam, badRequest),
    zValidator('json', RevBody, badRequest),
    async (c) => {
      const { kind, code } = c.req.valid('param');
      const item: CatalogItem = await activateCatalogItem(ctxOf(c), kind, code, c.req.valid('json'));
      return c.json(item, 200);
    },
  )

  // ---------------- 审计 ----------------
  .get('/audit', canAudit, zValidator('query', AuditQuery, badRequest), async (c) => {
    const q = c.req.valid('query');
    const page: AuditPage = await listAudit(ctxOf(c), { limit: q.limit ?? 50, before: q.before, action: q.action });
    return c.json(page, 200);
  })

  // 没匹配上的路径：匿名一律 401（demo 下匿名也只能碰上面那几个投影端点），成员 404 JSON，不落到静态文件
  .all('*', (c) => (c.var.user ? fail(c, 404, { error: 'not_found' }) : unauthorized(c)))

  .onError((e, c) => {
    const mapped = mapError(e);
    if (mapped) return c.json(mapped.body, mapped.status);
    console.error(`[console-api] 未捕获异常 ${c.req.method} ${c.req.path}:`, e instanceof Error ? e.message : e);
    const body: ApiError = { error: 'internal', detail: '服务暂时不可用，请稍后重试' };
    return c.json(body, 500);
  });

export type ConsoleApp = typeof consoleApi;

/** 仅供自测：换掉时钟（登录、会话过期、登出都按它算）；直接看错误映射（23505 在接口上被各写函数先转成命名错误，走不到这里） */
export const __consoleTest = {
  mapError,
  setClock(fn: () => number): void {
    clock = fn;
  },
  reset(): void {
    clock = () => Date.now();
  },
};
