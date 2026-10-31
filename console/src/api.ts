// 后台接口的客户端：hc<ConsoleApp> 从服务端路由推出类型（ADR-002），这里不手写接口类型。
// 请求都经 session.ts 的 sessionFetch：写请求带 x-csrf（登录或 /me 拿到后存在内存里，刷新页面时 /me 再给一次），
// 成员身份下判会话过期、就地重登后重放（spec「会话过期的判定」）。
// 出错时给人看的文案取 parts/errors.ts 的 ERROR_COPY；服务端的 detail 只在技术详情里（不变量 8）
import { hc } from 'hono/client';
import type { ConsoleApp } from '../../src/console-api/app.js';
import type { CatalogKind } from '../../src/shared/catalog.js';
import type { ApiError } from '../../src/shared/console-api.js';
import { csrfHeader, createSessionFetch } from './session.js';

// 在就地重登等待之前通知敏感页面清缓存，不改变既有请求的认证及重放规则。
const accessListeners = new Set<(status: 401 | 403, path: string) => void>();
export function subscribeConsoleAccess(listener: (status: 401 | 403, path: string) => void): () => void {
  accessListeners.add(listener);
  return () => void accessListeners.delete(listener);
}
const sessionFetch = createSessionFetch(async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401 || response.status === 403) {
    const path = new URL(
      input instanceof Request ? input.url : String(input),
      typeof window === 'undefined' ? 'https://console.invalid' : window.location.origin,
    ).pathname;
    for (const listener of accessListeners) listener(response.status, path);
  }
  return response;
});

export const api = hc<ConsoleApp>('/', { fetch: sessionFetch as typeof fetch, headers: csrfHeader }).api.console;

/** 非 200 的响应：status 与服务端的 { error, detail, … }。message 只写状态码与机器码，不带 detail */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(`${status} ${body.error}`);
  }
}

/**
 * 行业包里实体的 kind（字符串）→ 接口客户端要求的 kind 类型。console 只在这一处转换（spec「行业包通用架构 · 下发」），
 * 只转类型、不筛：界面不认行业，侧栏、⌘K、计数对任何包的实体都照发 `GET /catalog/:kind`。服务端不认识的 kind 由接口答 400，
 * 按各处的出错显示；加一个行业包时 console/src 零改动（验收 5 的假包走查就靠这一点）
 */
export const catalogKind = (kind: string): CatalogKind => kind as CatalogKind;

type Success<R> = R extends { status: 200; json(): Promise<infer T> } ? T : never;

/** 取 200 的响应体；其余状态抛 HttpError */
export async function unwrap<R extends { status: number; json(): Promise<unknown> }>(req: Promise<R>): Promise<Success<R>> {
  const res = await req;
  const body = (await res.json().catch(() => ({ error: 'bad_response' }))) as unknown;
  if (res.status !== 200) throw new HttpError(res.status, body as ApiError);
  return body as Success<R>;
}
