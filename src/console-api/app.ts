// 后台接口子应用（docs/architecture/01-pg-config-console/spec.md「后台 API 与页面」）。
// 必须链式注册，Hono RPC 才推得出类型（ADR-002）；console/src 只用 import type 引 ConsoleApp。
// 公共中间件依次是：安全头 → 只在 DB 模式 → 读会话 → 写保护；每个路由再挂自己的权限，没匹配上的路径回 JSON。
// prod（anon_readonly_admin 关）下匿名除了登录处处 401，靠的就是每个路由都挂了权限、兜底在 prod 下也是 401。
// 匿名（demo）只拿投影，出自进程内缓存与快照、不查库，并挂查询限流。命名错误在 onError 里统一映射成 { error, … }。
import { isIP } from 'node:net';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { PasswordBusyError } from '../auth/password.js';
import {
  ABSOLUTE_MS,
  claimSessionLookup,
  LoginRateLimitedError,
  login,
  logout,
  resolveSession,
  SESSION_COOKIE,
  type AuthedUser,
} from '../auth/session.js';
import { listAudit } from '../config/audit.js';
import {
  activateCatalogItem,
  CatalogCodeTakenError,
  CatalogCsvError,
  CatalogLockedFieldError,
  CatalogNotFoundError,
  CatalogRevConflictError,
  CatalogValidationError,
  createCatalogItem,
  getCatalogItem,
  importCatalogCsv,
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
  currentTenant,
} from '../config/source.js';
import { isUniqueViolation, withTenant, type TenantCtx, type Tx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { readMessagesBefore } from '../db/repo/messages.js';
import { readOutboundForSeqs, type OutboundSendRow } from '../db/repo/outbound.js';
import {
  archiveQuickReply,
  createQuickReply,
  listQuickReplies,
  moveQuickReply,
  updateQuickReply,
  type QuickReplyRow,
} from '../db/repo/quick-replies.js';
import { readGuardTotals, readTurnDiff, readTurnSteps, readTurnTrace } from '../db/repo/traces.js';
import {
  AssignedToOtherError,
  ConsentDeclinedError,
  ConversationNotFoundError,
  EmptyReplyError,
  ForbiddenError,
  NotHandlingError,
  release,
  reply,
  ReplyTooLongError,
  SendWindowError,
  takeover,
} from '../handoff/takeover.js';
import { clientKey, isCrossSite, lookupLimit } from '../http-guards.js';
import { requestLogContext } from '../log.js';
import { readMetricsView } from '../ops/metrics.js';
import { cancelOrder, confirmOrder, markPaidByAdvisor, OrderNotFoundError, OrderStateError } from '../payment/orders.js';
import { profile } from '../profile.js';
import { indexHealth } from '../retrieval.js';
import { csvLabelsOf } from '../shared/catalog-csv.js';
import {
  AuditQuery,
  CancelOrderBody,
  CatalogItemParam,
  CatalogKindParam,
  ConvQuery,
  CreateItemBody,
  ImportCsvBody,
  LoginBody,
  MessagesQuery,
  MetricsQuery,
  MoveBody,
  OrdersQuery,
  PatchItemBody,
  PublishBody,
  QuickReplyBody,
  ReplyBody,
  RevBody,
  RollbackBody,
  SaveDraftBody,
  TakeoverBody,
  VersionsQuery,
  type AnonCatalogItem,
  type AnonSopOverview,
  type AnonStatus,
  type ApiError,
  type AuditPage,
  type CatalogItem,
  type ConversationCounts,
  type ConversationDetail,
  type ConversationPage,
  type DraftCheck,
  type Me,
  type MessagesPage,
  type MessageView,
  type MetricsView,
  type OrderPage,
  type OrderSummary,
  type OrderView,
  type QuickReply,
  type ReplyResultView,
  type Role,
  type RollbackResult,
  type SopOverview,
  type SopVersion,
  type Status,
  type TurnDiffView,
  type TurnStepsView,
  type TurnTraceView,
} from '../shared/console-api.js';
import { conversationState } from '../shared/conversation.js';
import type { IndustryPack } from '../shared/pack.js';
import { CONSOLE_SECURITY_HEADERS } from '../shared/security-headers.js';
import { SopEncodingError, SopStructureError } from '../sop/sections.js';
import { flushSession, getSession, isDemoClassId, listOrders, sessionStoreMode, storeHealth, StoreLaggingError } from '../store.js';
import { rowToMessage } from '../store/project.js';
import type { Session } from '../types.js';
import { safeEqual } from '../wecom-crypto.js';
import { addListener, ensureEventHub, eventTiming, replayAfter, tailId, type Buffered } from './events.js';
import { maskNumbers } from './mask.js';
import {
  actorOf,
  byRecent,
  conversationCounts,
  conversationDetail,
  conversationRow,
  inPaidNeedsHuman,
  isListed,
  listedSessions,
  messageView,
  needVocabulary,
  orderView,
  tracedInDb,
  waitingFirst,
  windowTurnIds,
} from './workbench.js';

type ConsoleEnv = { Variables: { user: AuthedUser | null; token: string | null } };

/** /console/* 与 /api/console/* 共用（第 16 步托管 /console 时挂上） */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(CONSOLE_SECURITY_HEADERS)) c.res.headers.set(k, v);
};

let clock = (): number => Date.now();

/**
 * cookie 里的后台会话。文件模式没有账号，一律 null。带 cookie 的请求先按 IP 占一个查库名额（查库之前同步占好，
 * 并发的一批不会都看到旧计数），占不到就当匿名；会话有效就把名额退回去，只有无效的才算数。
 * server.ts 的 /api/admin/stream 也用它
 */
export async function consoleSession(c: Context): Promise<{ user: AuthedUser; token: string } | null> {
  if (configMode() !== 'db') return null;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const now = clock();
  const giveBack = claimSessionLookup(clientKey(c), now);
  if (!giveBack) return null;
  const user = await resolveSession(token, now);
  if (!user) return null;
  giveBack();
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
/** 只给成员：版本历史、单个版本 */
const signedIn: MiddlewareHandler<ConsoleEnv> = async (c, next) => (c.var.user ? next() : unauthorized(c));
/** 会话只读列表：所有成员都能看，匿名（demo 也一样）401 */
const canSeeCustomers = signedIn;
/** 改 SOP、发布、回滚、上新、编辑、上架，以及看审计：只有 owner / admin */
const ownerOrAdmin: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const { user } = c.var;
  if (!user) return unauthorized(c);
  return EDITORS.has(user.role) ? next() : fail(c, 403, { error: 'forbidden', detail: '只有 owner 和 admin 能做这件事' });
};
const canEdit = ownerOrAdmin;
const canAudit = ownerOrAdmin;
/** 钱与运行数字（02 spec「后台接口」权限表：本月成交额、运行数字）：只有 owner / admin */
const canSeeMoney = ownerOrAdmin;
/** trace 原文（原稿、参数、耗时、模型、前缀）：只有 owner / admin */
const canSeeTraces = ownerOrAdmin;

/** 角色在这几种里才放行，否则 403 forbidden（角色不够）；会话归不归你在接手状态机里查（409），不在中间件里 */
const roleIn =
  (roles: ReadonlySet<Role>, detail: string): MiddlewareHandler<ConsoleEnv> =>
  async (c, next) => {
    const { user } = c.var;
    if (!user) return unauthorized(c);
    return roles.has(user.role) ? next() : fail(c, 403, { error: 'forbidden', detail });
  };
/** 接手、人工回复、交还、订单动作（02 spec 权限表）：owner、admin、supervisor、agent；viewer 403 */
const canHandle = roleIn(new Set<Role>(['owner', 'admin', 'supervisor', 'agent']), '只读成员不能处理会话');
/** 管理快捷回复：owner、admin、supervisor */
const canManageReplies = roleIn(new Set<Role>(['owner', 'admin', 'supervisor']), '只有所有者、管理员与主管能管理快捷回复');

/** 只在 db 存储有的接口（更早的消息、trace、运行数字）在文件存储下 → 503 store_file_mode */
class StoreFileModeError extends Error {}

/** console 打得开的会话：内存里有、不是 sim- 访客会话；否则 404 conversation_not_found */
function listedSessionOf(id: string): Session {
  const s = isListed(id) ? getSession(id) : undefined;
  if (!s) throw new ConversationNotFoundError(id);
  return s;
}

/** 写接口在内存改动之后等这个会话的改动提交（≤5 秒），超时 503 store_lagging（改动已在内存生效，稍后落库） */
const committed = (sessionId: string): Promise<void> => flushSession(sessionId, { timeoutMs: 5000 });

/** console 读库的那几处（trace 类、快捷回复）：本租户、当前成员 */
const readTx = <T>(c: Context<ConsoleEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTenant(configRuntime().db, ctxOf(c), fn, { readOnly: true });

/** 账本行里对应这条消息的状态，几段取最重的（同 src/quota/ledger.ts 的 deliveryOf；更早的消息读库里的行） */
const RANK = { accepted: 0, unknown: 1, rejected: 2, failed: 3 } as const;
function deliveryFromRows(rows: readonly OutboundSendRow[], seq: number): MessageView['delivery'] {
  let worst: OutboundSendRow | null = null;
  for (const r of rows) if (r.messageSeq === seq && (!worst || RANK[r.status] > RANK[worst.status])) worst = r;
  return worst ? { status: worst.status, failType: worst.status === 'failed' ? worst.failType : null } : null;
}

const quickReplyView = (r: QuickReplyRow): QuickReply => ({ id: r.id, ord: r.ord, title: r.title, body: r.body });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  tenantName: currentTenant().name,
});

// 会话列表的投影、排序与计数在 ./workbench.ts（J 页与事件流共用）

const cookie = (value: string, maxAgeSec: number): string =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;

/** 命名错误 → 状态码与 { error, … }；不认识的返回 null，按 500 处理 */
function mapError(e: unknown): { status: 400 | 403 | 404 | 409 | 422 | 429 | 503; body: ApiError } | null {
  if (e instanceof HTTPException) return { status: 400, body: { error: 'bad_request', detail: e.message } };
  // 02「后台接口」的新错误码：角色不够 403，角色够但会话不归你 409（不变量 23 与权限表的分界）
  if (e instanceof ForbiddenError) return { status: 403, body: { error: 'forbidden', detail: e.message } };
  if (e instanceof ConversationNotFoundError) return { status: 404, body: { error: 'conversation_not_found', detail: e.message } };
  if (e instanceof OrderNotFoundError) return { status: 404, body: { error: 'not_found', detail: e.message } };
  if (e instanceof AssignedToOtherError)
    return { status: 409, body: { error: 'assigned_to_other', detail: e.message, assigneeName: e.assigneeName } };
  if (e instanceof NotHandlingError) return { status: 409, body: { error: 'not_assignee', detail: e.message } };
  if (e instanceof ConsentDeclinedError) return { status: 409, body: { error: 'consent_declined', detail: e.message } };
  // 清洗之后为空或仍超过 2000 字：请求不合规，400，不是服务端异常（审查第 3、10 条）
  if (e instanceof EmptyReplyError || e instanceof ReplyTooLongError)
    return { status: 400, body: { error: 'bad_request', detail: e.message } };
  if (e instanceof SendWindowError) {
    const error = e.reason === 'window_closed' ? 'send_window_closed' : 'send_quota_exhausted';
    return { status: 409, body: { error, detail: e.message, closesAt: e.closesAt, remaining: e.remaining } };
  }
  if (e instanceof OrderStateError) return { status: 409, body: { error: 'order_state', detail: e.message, status: e.status } };
  if (e instanceof StoreLaggingError)
    return {
      status: 503,
      body: { error: 'store_lagging', detail: '写库跟不上：改动之前就拒绝的什么都没改，等提交超时的已在内存生效、稍后保存' },
    };
  if (e instanceof StoreFileModeError) return { status: 503, body: { error: 'store_file_mode', detail: e.message } };
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
  if (e instanceof CatalogCsvError) return { status: 422, body: { error: 'invalid_csv', detail: e.message, rows: e.rows } };
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
  // requestLogContext：req 与 x-request-id（02 spec R24）；挂在 server.ts 下时沿用外层生成的那个
  .use('*', requestLogContext, securityHeaders, requireDbMode, loadSession, guardWrites)

  // ---------------- 登录 ----------------
  .post('/auth/login', zValidator('json', LoginBody, badRequest), async (c) => {
    const { email, password } = c.req.valid('json');
    const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
    const r = await login({ email, password, ip: dbIp(c), userAgent, now: clock() });
    // 未知邮箱、口令错误、账号停用、不是本实例成员：状态码与响应体完全相同
    if (!r) return fail(c, 401, { error: 'invalid_credentials', detail: '邮箱或密码不对' });
    c.header('Set-Cookie', cookie(r.token, ABSOLUTE_MS / 1000));
    return c.json(meOf(r.user), 200);
  })
  .post('/auth/logout', async (c) => {
    await logout(c.var.token!, clock());
    c.header('Set-Cookie', cookie('', 0));
    return c.json({ ok: true as const }, 200);
  })
  .get('/me', signedIn, (c) => c.json(meOf(c.var.user!), 200))

  // ---------------- 行业包 ----------------
  // 当前租户（tenants.pack_id）的界面配置，取自启动时装载的租户行、不查库。它是代码里的公开配置，不含租户名、成员、草稿，
  // 所以 demo 下匿名也能读（挂查询限流）；prod 下匿名 401（后台 UX spec「行业包通用架构 · 下发」）
  .get('/pack', canRead, (c) => {
    const body: IndustryPack = currentTenant().pack;
    return c.json(body, 200);
  })

  // ---------------- 状态 ----------------
  .get('/status', canRead, (c) => {
    if (!c.var.user) {
      const anon: AnonStatus = { mode: 'db' };
      return c.json(anon, 200);
    }
    const sop = currentSop();
    const h = configHealth();
    const store = storeHealth();
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
      // 02「两种会话存储与启动」：会话数与停写会话的短码只给成员看，不进 /healthz
      conversations: store.conversations,
      poisoned: store.poisoned,
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
  // 只建 draft，只收平铺字段，数组用「、」分隔；整份全部合格才一次建出来（见 src/shared/catalog-csv.ts）。
  // 表头也认字段的中文标签（后台 UX spec「CSV 导入」）：标签表取自租户的行业包
  .post(
    '/catalog/:kind/import-csv',
    canEdit,
    zValidator('param', CatalogKindParam, badRequest),
    zValidator('json', ImportCsvBody, badRequest),
    async (c) => {
      const kind = c.req.valid('param').kind;
      const entity = currentTenant().pack.entities.find((e) => e.kind === kind);
      const labels = entity ? csvLabelsOf(entity) : undefined;
      const items: CatalogItem[] = await importCatalogCsv(ctxOf(c), kind, c.req.valid('json').csv, labels);
      return c.json({ items }, 200);
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

  // ---------------- 会话只读列表 ----------------
  // 读现有的文件 store：先按 state、stage 过滤，按 (updatedAt desc, id) 或 waiting_first 排序，再 offset 分页；
  // 每条只投影几个字段（conversationRow）。不列 sim- 会话。演示数据保鲜会整体平移时间戳，保鲜期间翻页可能漂移
  .get('/conversations', canSeeCustomers, zValidator('query', ConvQuery, badRequest), (c) => {
    const { limit = 20, offset = 0, state, stage, order, group } = c.req.valid('query');
    const pack = currentTenant().pack; // 已成交按租户行业包的终态判定（不变量 17）
    const all = listedSessions()
      .filter(
        (s) =>
          (!state || conversationState(s, pack) === state) &&
          (!stage || s.stage === stage) &&
          (group !== 'paid_needs_human' || inPaidNeedsHuman(s, pack)),
      )
      .toSorted(order === 'waiting_first' ? waitingFirst(pack) : byRecent);
    const vocab = needVocabulary();
    const page: ConversationPage = {
      total: all.length,
      items: all.slice(offset, offset + limit).map((s) => conversationRow(s, vocab, c.var.user!.role === 'viewer')),
    };
    return c.json(page, 200);
  })
  // 一次同步遍历算完（后台 UX spec「接口改动」）：同一次响应里 byState 之和等于 total，aiByStage 之和等于 byState.ai（不变量 18）
  .get('/conversations/counts', canSeeCustomers, (c) => {
    const body: ConversationCounts = conversationCounts(clock());
    return c.json(body, 200);
  })

  // ---------------- 会话工作台（02 spec「后台接口」，J 页） ----------------
  // 读接口只读内存；trace 类（护栏改写的句数、更早的消息、步骤摘要、改写对照、trace 原文）只在 db 存储的真实会话上查库：
  // 文件存储下 503 store_file_mode（权限先于它），种子会话返回空。写接口改完内存后等提交（≤5 秒），超时 503 store_lagging
  .get('/conversations/:id', canSeeCustomers, async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    const turnIds = tracedInDb(s) ? windowTurnIds(s) : [];
    const guarded = turnIds.length ? await readTx(c, (tx) => readGuardTotals(tx, turnIds)) : new Map();
    const body: ConversationDetail = conversationDetail(s, c.var.user!, guarded, clock());
    return c.json(body, 200);
  })
  .get('/conversations/:id/messages', canSeeCustomers, zValidator('query', MessagesQuery, badRequest), async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    if (sessionStoreMode() !== 'db') throw new StoreFileModeError('更早的消息只在 SESSION_STORE=db 时有');
    const empty: MessagesPage = { messages: [], hasEarlier: false };
    if (isDemoClassId(s.id)) return c.json(empty, 200);
    const { beforeSeq, limit = 50 } = c.req.valid('query');
    const page = await readTx(c, async (tx) => {
      const { rows, hasEarlier } = await readMessagesBefore(tx, s.id, beforeSeq, limit);
      const guarded = await readGuardTotals(
        tx,
        rows.flatMap((r) => (r.turnId ? [r.turnId] : [])),
      );
      const outbound =
        s.channel === 'wecom'
          ? await readOutboundForSeqs(
              tx,
              s.id,
              rows.filter((r) => r.role === 'agent').map((r) => r.seq),
            )
          : [];
      return { rows, hasEarlier, guarded, outbound };
    });
    const opts = { viewer: c.var.user!.role === 'viewer', withTurns: true, guarded: page.guarded };
    const body: MessagesPage = {
      messages: page.rows.map((r) =>
        messageView(rowToMessage(r), r.seq, r.turnId, r.role === 'agent' ? deliveryFromRows(page.outbound, r.seq) : null, opts),
      ),
      hasEarlier: page.hasEarlier,
    };
    return c.json(body, 200);
  })
  .get('/conversations/:id/turns', canSeeCustomers, async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    if (sessionStoreMode() !== 'db') throw new StoreFileModeError('AI 步骤只在 SESSION_STORE=db 时有');
    const tools = currentTenant().pack.vocabulary.tools;
    const rows = isDemoClassId(s.id) ? [] : await readTx(c, (tx) => readTurnSteps(tx, s.id));
    const body: TurnStepsView = {
      turns: rows.map((r) => ({
        turnId: r.turnId,
        startedAt: r.startedAt.toISOString(),
        outcome: r.outcome,
        steps: r.steps.map((st) => ({
          name: st.name,
          label: Object.hasOwn(tools, st.name) ? tools[st.name]! : st.name,
          prefetch: st.prefetch,
        })),
      })),
    };
    return c.json(body, 200);
  })
  .get('/conversations/:id/turns/:turnId/diff', canSeeCustomers, async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    if (sessionStoreMode() !== 'db') throw new StoreFileModeError('护栏改写对照只在 SESSION_STORE=db 时有');
    const turnId = c.req.param('turnId');
    const d = isDemoClassId(s.id) ? null : await readTx(c, (tx) => readTurnDiff(tx, s.id, turnId));
    if (!d) return fail(c, 404, { error: 'not_found', detail: '这一轮没有记录' });
    // 只读成员：AI 原稿与发出的句子同样打码（不变量 47）
    const m = c.var.user!.role === 'viewer' ? maskNumbers : (t: string) => t;
    const body: TurnDiffView = {
      removed: d.removed.map(m),
      added: d.added.map(m),
      events: d.events.map((e) => ({ guard: e.guard, action: e.action, removed: e.removed.map(m), added: e.added.map(m) })),
    };
    return c.json(body, 200);
  })
  .get('/conversations/:id/turns/:turnId', canSeeTraces, async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    if (sessionStoreMode() !== 'db') throw new StoreFileModeError('trace 只在 SESSION_STORE=db 时有');
    const turnId = c.req.param('turnId');
    const r = isDemoClassId(s.id) ? null : await readTx(c, (tx) => readTurnTrace(tx, s.id, turnId));
    if (!r) return fail(c, 404, { error: 'not_found', detail: '这一轮没有记录' });
    const body: TurnTraceView = {
      turnId: r.id,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      outcome: r.outcome,
      sopVersion: r.sopVersion,
      prefixHash: r.prefixHash,
      catalogVersions: r.catalogVersions,
      stageBefore: r.stageBefore,
      stageAfter: r.stageAfter,
      draft: r.draft,
      finalText: r.finalText,
      calls: r.calls,
      llm: r.llm,
      signals: r.signals,
    };
    return c.json(body, 200);
  })
  // 接手：没人接手或是自己 → 成为接手人；别人接手中 409 assigned_to_other；带 force 改派只给 supervisor 以上（坐席 403）
  .post('/conversations/:id/takeover', canHandle, zValidator('json', TakeoverBody, badRequest), async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    takeover(s.id, actorOf(c.var.user!, dbIp(c)), { force: c.req.valid('json').force });
    await committed(s.id);
    return c.json({ ok: true as const }, 200);
  })
  // 交还 AI：接手人本人、supervisor 以上、或没人接手时任何能处理的成员；别人的 409 not_assignee，客户不同意 409 consent_declined
  .post('/conversations/:id/release', canHandle, async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    release(s.id, actorOf(c.var.user!, dbIp(c)));
    await committed(s.id);
    return c.json({ ok: true as const }, 200);
  })
  // 人工回复即接手：查健康 → 入库 → 等提交 → 发送（src/handoff/takeover.ts 的 reply）；等提交超时也照发，persisted: false
  .post('/conversations/:id/reply', canHandle, zValidator('json', ReplyBody, badRequest), async (c) => {
    const s = listedSessionOf(c.req.param('id'));
    const { text, clientId } = c.req.valid('json');
    const body: ReplyResultView = await reply(s.id, actorOf(c.var.user!, dbIp(c)), text, clientId);
    return c.json(body, 200);
  })

  // ---------------- 订单（02 spec「后台接口」「收款流程」） ----------------
  // 从 identity map 算（含 demo 类订单，作废的已不在内存里），不查 orders 表。所有者、管理员以外只接受 status=pending_payment
  .get('/orders', canSeeCustomers, zValidator('query', OrdersQuery, badRequest), (c) => {
    const { status, limit = 50 } = c.req.valid('query');
    if (!EDITORS.has(c.var.user!.role) && status !== 'pending_payment') {
      return fail(c, 403, { error: 'forbidden', detail: '只有所有者和管理员能看全部订单，其余只能看待付款的' });
    }
    const all = listOrders().filter((o) => !status || o.status === status);
    const body: OrderPage = { items: all.slice(0, limit).map(orderView), total: all.length };
    return c.json(body, 200);
  })
  // 本月成交额：服务器时区的自然月里付了款的订单（作废的已不在内存里）；待付款是现在所有 pending_payment 的
  .get('/orders/summary', canSeeMoney, (c) => {
    const now = new Date(clock());
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const body: OrderSummary = {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      paidTotal: 0,
      paidCount: 0,
      pendingTotal: 0,
      pendingCount: 0,
    };
    for (const o of listOrders()) {
      if (o.status === 'paid' && o.paidAt != null && o.paidAt >= from && o.paidAt < to) {
        body.paidTotal += o.totalPrice;
        body.paidCount += 1;
      } else if (o.status === 'pending_payment') {
        body.pendingTotal += o.totalPrice;
        body.pendingCount += 1;
      }
    }
    return c.json(body, 200);
  })
  // 确认价格、确认收款、取消订单：坐席只限订单所属会话的接手人本人（409 not_assignee），每次一行审计（不变量 39）
  .post('/orders/:id/confirm', canHandle, async (c) => {
    const o = confirmOrder(c.req.param('id'), actorOf(c.var.user!, dbIp(c)));
    await committed(o.sessionId);
    const body: OrderView = orderView(o);
    return c.json(body, 200);
  })
  .post('/orders/:id/mark-paid', canHandle, async (c) => {
    const { order, persisted } = await markPaidByAdvisor(c.req.param('id'), actorOf(c.var.user!, dbIp(c)));
    if (!persisted) throw new StoreLaggingError(order.sessionId);
    const body: OrderView = orderView(order);
    return c.json(body, 200);
  })
  .post('/orders/:id/cancel', canHandle, zValidator('json', CancelOrderBody, badRequest), async (c) => {
    const o = cancelOrder(c.req.param('id'), actorOf(c.var.user!, dbIp(c)), c.req.valid('json').reason);
    await committed(o.sessionId);
    const body: OrderView = orderView(o);
    return c.json(body, 200);
  })

  // ---------------- 快捷回复（02 spec「后台接口」；默认模板与管理抽屉在第 22 步） ----------------
  // 只要求 DB 配置模式，两种会话存储下都可用。写入与审计在同一个事务里
  .get('/quick-replies', canSeeCustomers, async (c) => {
    const rows = await readTx(c, (tx) => listQuickReplies(tx));
    return c.json({ items: rows.map(quickReplyView) }, 200);
  })
  .post('/quick-replies', canManageReplies, zValidator('json', QuickReplyBody, badRequest), async (c) => {
    const { title, body } = c.req.valid('json');
    const row = await withTenant(configRuntime().db, ctxOf(c), async (tx) => {
      const r = await createQuickReply(tx, { title, body, byName: c.var.user!.displayName });
      await writeAudit(tx, { action: 'quick_reply.create', targetType: 'quick_reply', targetId: r.id, diff: { title } });
      return r;
    });
    return c.json(quickReplyView(row), 200);
  })
  .patch('/quick-replies/:id', canManageReplies, zValidator('json', QuickReplyBody.partial(), badRequest), async (c) => {
    const id = c.req.param('id');
    const patch = c.req.valid('json');
    if (!UUID_RE.test(id)) return fail(c, 404, { error: 'not_found' });
    const row = await withTenant(configRuntime().db, ctxOf(c), async (tx) => {
      const cur = (await listQuickReplies(tx)).find((r) => r.id === id);
      if (!cur) return null;
      const title = patch.title ?? cur.title;
      const r = await updateQuickReply(tx, id, { title, body: patch.body ?? cur.body, byName: c.var.user!.displayName });
      if (r) await writeAudit(tx, { action: 'quick_reply.update', targetType: 'quick_reply', targetId: id, diff: { title } });
      return r;
    });
    if (!row) return fail(c, 404, { error: 'not_found' });
    return c.json(quickReplyView(row), 200);
  })
  .post('/quick-replies/:id/archive', canManageReplies, async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return fail(c, 404, { error: 'not_found' });
    const ok = await withTenant(configRuntime().db, ctxOf(c), async (tx) => {
      const cur = (await listQuickReplies(tx)).find((r) => r.id === id);
      if (!cur || !(await archiveQuickReply(tx, id, c.var.user!.displayName))) return false;
      await writeAudit(tx, { action: 'quick_reply.archive', targetType: 'quick_reply', targetId: id, diff: { title: cur.title } });
      return true;
    });
    if (!ok) return fail(c, 404, { error: 'not_found' });
    return c.json({ ok: true as const }, 200);
  })
  .post('/quick-replies/:id/move', canManageReplies, zValidator('json', MoveBody, badRequest), async (c) => {
    const id = c.req.param('id');
    const { direction } = c.req.valid('json');
    if (!UUID_RE.test(id)) return fail(c, 404, { error: 'not_found' });
    const moved = await withTenant(configRuntime().db, ctxOf(c), async (tx) => {
      const cur = (await listQuickReplies(tx)).find((r) => r.id === id);
      if (!cur) return null;
      if (!(await moveQuickReply(tx, id, direction, c.var.user!.displayName))) return false;
      await writeAudit(tx, { action: 'quick_reply.move', targetType: 'quick_reply', targetId: id, diff: { title: cur.title, direction } });
      return true;
    });
    if (moved === null) return fail(c, 404, { error: 'not_found' });
    // 已在最前（最后）：什么都不改，照样 200
    return c.json({ ok: true as const, moved }, 200);
  })

  // ---------------- 事件流（02 spec「通知」，SSE） ----------------
  // 成员才能连（viewer 也行），匿名 401。只带 id、状态、类型、seq 与时间。连上时先补 Last-Event-ID 之后的（接不上就 resync），
  // 没带 Last-Event-ID 的先收一条当前的 counts；之后每 20 秒一行注释心跳，每 50 秒复核登录（留查库余量，保证 60 秒内关闭），失效就发 auth 并关闭
  .get('/events', canSeeCustomers, (c) => {
    ensureEventHub(() => conversationCounts(clock()));
    const token = c.var.token!;
    const lastEventId = c.req.header('last-event-id');
    return streamSSE(c, async (stream) => {
      let open = true;
      const write = (b: Buffered): void => {
        if (open) void stream.writeSSE({ id: b.id, event: b.event, data: b.data }).catch(() => undefined);
      };
      // 补发、首条与订阅在同一段同步代码里排进写队列：中间不会漏掉也不会乱序
      const missed = lastEventId ? replayAfter(lastEventId) : [];
      const off = addListener(write);
      // 等下一次心跳或复核：连接一断就醒（不留着计时器把进程拖住）
      let wake = (): void => {};
      const wait = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref();
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      stream.onAbort(() => {
        open = false;
        off();
        wake();
      });
      if (missed === null) void stream.writeSSE({ id: tailId(), event: 'resync', data: '{}' });
      else if (!lastEventId) void stream.writeSSE({ id: tailId(), event: 'counts', data: JSON.stringify(conversationCounts(clock())) });
      else for (const b of missed) write(b);
      const { heartbeatMs, recheckMs } = eventTiming();
      let nextBeat = Date.now() + heartbeatMs;
      let nextCheck = Date.now() + recheckMs;
      while (open && !stream.aborted) {
        await wait(Math.max(1, Math.min(nextBeat, nextCheck) - Date.now()));
        if (!open || stream.aborted) break;
        const now = Date.now();
        if (now >= nextCheck) {
          nextCheck = now + recheckMs;
          let alive = true;
          try {
            // 01 的 auth_session_touch：开着的事件流算活动，7 天的绝对期限照旧；过期、被移出、停用都是 null
            alive = (await resolveSession(token, clock())) !== null;
          } catch (e) {
            // 库一时连不上：认不出失效，下一次再复核（不因库故障把所有人踢回登录页）
            console.error('[console-api] 事件流复核登录失败:', e instanceof Error ? e.name : e);
          }
          if (!alive) {
            open = false;
            off();
            await stream.writeSSE({ event: 'auth', data: '{}' }).catch(() => undefined);
            break;
          }
        }
        if (now >= nextBeat) {
          nextBeat = now + heartbeatMs;
          await stream.write(': ping\n\n').catch(() => undefined);
        }
      }
      off();
    });
  })

  // ---------------- 审计 ----------------
  .get('/audit', canAudit, zValidator('query', AuditQuery, badRequest), async (c) => {
    const q = c.req.valid('query');
    const page: AuditPage = await listAudit(ctxOf(c), {
      limit: q.limit ?? 50,
      before: q.before,
      action: q.action,
      actions: q.actions?.split(','),
    });
    return c.json(page, 200);
  })

  // ---------------- 运行数字（02 spec「可观测性与告警 · 运行数字」） ----------------
  // 只在 db 存储下有（trace 只在那时入库）：文件存储 503 store_file_mode。权限先于它：角色不够照样 403
  .get('/metrics', canSeeMoney, zValidator('query', MetricsQuery, badRequest), async (c) => {
    if (sessionStoreMode() !== 'db') {
      const body: ApiError = { error: 'store_file_mode', detail: '运行数字只在 SESSION_STORE=db 时有' };
      return c.json(body, 503);
    }
    const body: MetricsView = await readMetricsView(ctxOf(c), c.req.valid('query').days ?? 7, clock());
    return c.json(body, 200);
  })

  // 没匹配上的路径回 JSON，不落到静态文件：成员与 demo 下的匿名 404；prod 下匿名 401（除了登录处处 401）
  .all('*', (c) => (c.var.user || profile().flags.anon_readonly_admin ? fail(c, 404, { error: 'not_found' }) : unauthorized(c)))

  .onError((e, c) => {
    const mapped = mapError(e);
    if (mapped) return c.json(mapped.body, mapped.status);
    // 日志不打会话原 id（不变量 48）：路由模板（如 /conversations/:id/reply），不是实际路径（含 external_userid）
    console.error(`[console-api] 未捕获异常 ${c.req.method} ${c.req.routePath}:`, e instanceof Error ? e.message : e);
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
