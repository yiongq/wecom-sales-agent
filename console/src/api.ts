// 后台接口的客户端：hc<ConsoleApp> 从服务端路由推出类型（ADR-002），这里不手写接口类型。
// 写请求要带 x-csrf：登录或 /me 拿到后存在内存里，刷新页面时 /me 再给一次。
import { hc } from 'hono/client';
import type { ConsoleApp } from '../../src/console-api/app.js';
import type { ApiError } from '../../src/shared/console-api.js';

let csrf = '';
export function setCsrf(value: string): void {
  csrf = value;
}

export const api = hc<ConsoleApp>('/', {
  headers: (): Record<string, string> => (csrf ? { 'x-csrf': csrf } : {}),
}).api.console;

/** 非 200 的响应：status 与服务端的 { error, detail, … } */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.detail ?? body.error);
  }
}

type Success<R> = R extends { status: 200; json(): Promise<infer T> } ? T : never;

/** 取 200 的响应体；其余状态抛 HttpError */
export async function unwrap<R extends { status: number; json(): Promise<unknown> }>(req: Promise<R>): Promise<Success<R>> {
  const res = await req;
  const body = (await res.json().catch(() => ({ error: 'bad_response' }))) as unknown;
  if (res.status !== 200) throw new HttpError(res.status, body as ApiError);
  return body as Success<R>;
}

/** 给人看的错误说明 */
export function describe(e: unknown): string {
  if (e instanceof HttpError) return e.body.detail ?? `${e.status} ${e.body.error}`;
  return e instanceof Error ? e.message : String(e);
}
