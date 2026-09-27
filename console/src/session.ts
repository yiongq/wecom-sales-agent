// 会话过期的判定与就地重登（spec「通用部件 · 会话过期的判定」、不变量 24）。
// 后台的请求都经 sessionFetch（api.ts 交给 hc）。只在前端当前是成员身份时判定：本次启动时 /me 成功过，或在本页登录成功过；
// 匿名身份下的 401 都不算过期，启动时 /me 的 401 就是进入匿名的信号。不单看 401：登录接口的 invalid_credentials 也是 401，
// demo 下会话失效后 GET 返回 200 的匿名投影，只有写请求才 401。成员身份下满足任一条就判为过期：
//   1. 响应体的 error 是 'unauthorized'；
//   2. 某个 GET 返回了匿名形状（ANON_SHAPES，每个接口一个判断）；
//   3. /me 返回 401。
// 判为过期的响应不交给调用方：请求停在这里，等 SessionExpiredDialog 就地登录，成功后带新的 csrf 重放。所以 React Query 的缓存
// 不清，当前页不卸载，编辑中的内容还在，匿名形状的数据也进不了缓存。登录框被关掉时，等着的请求拿到 401 unauthorized
// （匿名形状的 200 也换成 401，数据不交出去），页面按 ERROR_COPY 显示「登录已过期」。
import type {
  AnonCatalogItem,
  AnonSopOverview,
  AnonStatus,
  ApiError,
  CatalogItem,
  Me,
  SopOverview,
  Status,
} from '../../src/shared/console-api.js';

const API = '/api/console';
const EXEMPT = new Set([`${API}/auth/login`, `${API}/auth/logout`]);
const ME = `${API}/me`;

const has = (v: unknown, key: string): boolean => !!v && typeof v === 'object' && key in v;

/** 只在成员视图里有、匿名投影里没有的键；类型变了（匿名投影也带上这个键）typecheck 就会失败 */
type MemberOnly<M, A, K extends string> = K extends keyof M ? (K extends keyof A ? never : K) : never;
const STATUS_KEY: MemberOnly<Status, AnonStatus, 'tenantSlug'> = 'tenantSlug';
const SOP_KEY: MemberOnly<SopOverview, AnonSopOverview, 'spec'> = 'spec';
const ITEM_KEY: MemberOnly<CatalogItem, AnonCatalogItem, 'status'> = 'status';

/**
 * 成员与匿名形状不同的 GET，每个接口一个判断。其余 GET 对匿名一律 401（第 1 条管），或者两种身份拿到的本来就一样（/pack）。
 * 空的产品库列表分不出身份，按成员算
 */
export const ANON_SHAPES: ReadonlyArray<{ path: RegExp; isAnonShape: (body: unknown) => boolean }> = [
  { path: /^\/api\/console\/status$/, isAnonShape: (b) => !has(b, STATUS_KEY) },
  { path: /^\/api\/console\/sop$/, isAnonShape: (b) => !has(b, SOP_KEY) },
  {
    path: /^\/api\/console\/catalog\/[^/]+$/,
    isAnonShape: (b) => has(b, 'items') && ((b as { items: unknown[] }).items ?? []).some((i) => !has(i, ITEM_KEY)),
  },
  { path: /^\/api\/console\/catalog\/[^/]+\/[^/]+$/, isAnonShape: (b) => !has(b, ITEM_KEY) },
];

// ---------------- 身份 ----------------

let member = false;
let csrf = '';
let expired = false;
let waiting: Array<(resumed: boolean) => void> = [];
const listeners = new Set<() => void>();

function setExpired(v: boolean): void {
  if (expired === v) return;
  expired = v;
  for (const l of listeners) l();
}

function settle(resumed: boolean): void {
  const w = waiting;
  waiting = [];
  setExpired(false);
  for (const resolve of w) resolve(resumed);
}

/** 写请求带的头 */
export const csrfHeader = (): Record<string, string> => (csrf ? { 'x-csrf': csrf } : {});

/** /me 成功、或登录成功：进入成员身份 */
export function beginMemberSession(me: Pick<Me, 'csrf'>): void {
  member = true;
  csrf = me.csrf;
}

/** 退出登录：先离开成员身份，之后的 401 都不算过期；等着重登的请求拿到 401 */
export function endMemberSession(): void {
  member = false;
  csrf = '';
  settle(false);
}

export const isMemberSession = (): boolean => member;
export const isSessionExpired = (): boolean => expired;
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 就地登录成功：换上新的 csrf，重放等着的请求 */
export function resumeSession(me: Pick<Me, 'csrf'>): void {
  beginMemberSession(me);
  settle(true);
}

/** 登录框被关掉：等着的请求拿到 401，仍是成员身份（下一个请求过期了还会再弹） */
export function abandonRelogin(): void {
  settle(false);
}

function waitForRelogin(): Promise<boolean> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    setExpired(true);
  });
}

// ---------------- 请求 ----------------

async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    return null;
  }
}

async function isExpiry(res: Response, method: string, path: string): Promise<boolean> {
  if (path === ME && res.status === 401) return true;
  if (res.ok) {
    if (method !== 'GET') return false;
    const shape = ANON_SHAPES.find((s) => s.path.test(path));
    if (!shape) return false;
    const body = await jsonOf(res);
    return body !== null && shape.isAnonShape(body);
  }
  const body = await jsonOf(res);
  return has(body, 'error') && (body as ApiError).error === 'unauthorized';
}

function unauthorized(): Response {
  const body: ApiError = { error: 'unauthorized' };
  return new Response(JSON.stringify(body), { status: 401, headers: { 'Content-Type': 'application/json' } });
}

/** 包一层 fetch：成员身份下判过期、等重登、重放。自测传假的 fetch */
export function createSessionFetch(base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const run = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const res = await base(input, init);
    if (!member) return res;
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://console.invalid');
    if (EXEMPT.has(url.pathname)) return res;
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!(await isExpiry(res, method, url.pathname))) return res;
    if (!(await waitForRelogin())) return res.status === 401 ? res : unauthorized();
    const headers = new Headers(init.headers);
    if (csrf) headers.set('x-csrf', csrf);
    else headers.delete('x-csrf');
    return run(input, { ...init, headers });
  };
  return run;
}

export const sessionFetch = createSessionFetch((input, init) => fetch(input, init));
