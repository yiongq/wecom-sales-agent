// 错误文案（spec「通用部件 · 错误文案（ERROR_COPY）」）：按 ApiError.error 映射成固定的中文，不拼接服务端的 detail；
// detail 与原码只进「技术详情」（TechDetails）。表里没有的 error 用兜底：「无法完成这项操作 · 重试」；
// 网络失败（含页面块没取到）与表里没有的 5xx（含 internal）是「服务暂时连不上 · 重试」；页面渲染时抛的错走兜底。
// 文案本身在 src/shared/ui-labels.ts（前后端共用的界面文案），这里按错误挑一条。不依赖 React，自测直接 import
import type { ApiError } from '../../../src/shared/console-api.js';
import {
  type CopyContext,
  ERROR_COPY,
  type ErrorAction,
  type ErrorEntry,
  type ErrorPlace,
  type ErrorTone,
  FALLBACK_COPY,
  NETWORK_COPY,
} from '../../../src/shared/ui-labels.js';
import { HttpError } from '../api.js';

export {
  type CopyContext,
  ERROR_ACTION_LABEL as ACTION_LABEL,
  ERROR_COPY,
  type ErrorAction,
  type ErrorPlace,
  type ErrorTone,
  FALLBACK_COPY,
  NETWORK_COPY,
} from '../../../src/shared/ui-labels.js';

export interface ErrorCopy {
  title: string;
  next: string | null;
  place: ErrorPlace;
  tone: ErrorTone;
  action: ErrorAction | null;
}

/**
 * 懒加载的页面块没取到（断网，或者发版后旧的块已经不在了）：三个引擎 import() 失败时的消息（与 TanStack Router 的
 * isModuleNotFoundError 同一组），外加 vite 预载页面块的 CSS 失败。前三种是 TypeError，最后一种是普通的 Error
 */
const CHUNK_LOAD =
  /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS)/;

export function isChunkLoadError(e: unknown): boolean {
  return e instanceof Error && CHUNK_LOAD.test(e.message);
}

/**
 * 页面渲染时抛出的错误（路由的出错组件用它包一层）：是页面代码的毛病，不是网络，重新载入也不一定好，文案走兜底。
 * 不是 TypeError，所以「Cannot read properties of undefined」不会被当成 fetch 连不上；技术详情照旧列出原来的类型与消息
 */
export class PageCrash extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

/** 路由的出错组件接住的错误：接口的错误和页面块没取到照原样，其余都是渲染时抛的，包成 PageCrash */
export function routeError(e: unknown): unknown {
  return e instanceof HttpError || isChunkLoadError(e) ? e : new PageCrash(e);
}

function entryOf(e: unknown): { entry: ErrorEntry; body: ApiError } {
  if (e instanceof HttpError) {
    const known = Object.hasOwn(ERROR_COPY, e.body.error) ? ERROR_COPY[e.body.error] : undefined;
    if (known) return { entry: known, body: e.body };
    return { entry: e.status >= 500 ? NETWORK_COPY : FALLBACK_COPY, body: e.body };
  }
  // fetch 连不上服务时抛 TypeError；页面块没取到也是连不上
  return { entry: e instanceof TypeError || isChunkLoadError(e) ? NETWORK_COPY : FALLBACK_COPY, body: { error: 'client' } };
}

/** 一个错误该显示的固定文案 */
export function errorCopy(e: unknown, ctx: CopyContext = {}): ErrorCopy {
  const { entry, body } = entryOf(e);
  return {
    title: typeof entry.title === 'function' ? entry.title(body, ctx) : entry.title,
    next: entry.next,
    place: entry.place,
    tone: entry.tone,
    action: entry.action ?? null,
  };
}
