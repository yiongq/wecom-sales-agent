// 后台接口的客户端：hc<ConsoleApp> 从服务端路由推出类型（ADR-002），这里不手写接口类型。
// 请求都经 session.ts 的 sessionFetch：写请求带 x-csrf（登录或 /me 拿到后存在内存里，刷新页面时 /me 再给一次），
// 成员身份下判会话过期、就地重登后重放（spec「会话过期的判定」）。
// 出错时给人看的文案取 parts/errors.ts 的 ERROR_COPY；服务端的 detail 只在技术详情里（不变量 8）
import { hc } from 'hono/client';
import type { ConsoleApp } from '../../src/console-api/app.js';
import type { CatalogKind } from '../../src/shared/catalog.js';
import { type ApiError, CatalogKindParam } from '../../src/shared/console-api.js';
import { csrfHeader, sessionFetch } from './session.js';

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
 * 行业包里实体的 kind（字符串）→ 接口要求的 kind。console 只在这一处转换（spec「行业包通用架构 · 下发」）；
 * 接口还不认识的 kind 是 null，调用方不发请求
 */
export function catalogKind(kind: string): CatalogKind | null {
  const r = CatalogKindParam.shape.kind.safeParse(kind);
  return r.success ? r.data : null;
}

type Success<R> = R extends { status: 200; json(): Promise<infer T> } ? T : never;

/** 取 200 的响应体；其余状态抛 HttpError */
export async function unwrap<R extends { status: number; json(): Promise<unknown> }>(req: Promise<R>): Promise<Success<R>> {
  const res = await req;
  const body = (await res.json().catch(() => ({ error: 'bad_response' }))) as unknown;
  if (res.status !== 200) throw new HttpError(res.status, body as ApiError);
  return body as Success<R>;
}
