// 错误文案（spec「通用部件 · 错误文案（ERROR_COPY）」）：按 ApiError.error 映射成固定的中文，不拼接服务端的 detail；
// detail 与原码只进「技术详情」（TechDetails）。表里没有的 error 用兜底：「无法完成这项操作 · 重试」；
// 网络失败（含页面块没取到）与表里没有的 5xx（含 internal）是「服务暂时连不上 · 重试」；页面渲染时抛的错走兜底。
// 文案先放在这里，第 3.4 步挪进 src/shared/ui-labels.ts。不依赖 React，自测直接 import
import type { ApiError } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';

/** spec 表里的「颜色」：中性 / 留意 / 出错 */
export type ErrorTone = 'neutral' | 'caution' | 'danger';

/** spec 表里的「形式」：显示在哪。页面按它放；ErrorAlert 与 StateView 只管画 */
export type ErrorPlace = 'relogin' | 'page' | 'banner' | 'field' | 'checklist' | 'whole' | 'form' | 'inline';

/** 下一步对应的按钮。页面给了对应的回调才画 */
export type ErrorAction = 'relogin' | 'refresh' | 'reload' | 'merge' | 'retry' | 'back';

export const ACTION_LABEL: Readonly<Record<ErrorAction, string>> = {
  relogin: '重新登录',
  refresh: '刷新',
  reload: '载入最新内容',
  merge: '去合并',
  retry: '重试',
  back: '回到列表',
};

/** 文案里要换成中文名的东西（锁定字段）：由页面按行业包传入，没传就不列 */
export interface CopyContext {
  fieldLabel?: (key: string) => string;
}

interface Entry {
  title: string | ((body: ApiError, ctx: CopyContext) => string);
  next: string | null;
  place: ErrorPlace;
  tone: ErrorTone;
  action?: ErrorAction;
}

const count = (n: number | undefined): number => n ?? 0;
const issueCount = (b: ApiError): number => count(b.issues?.length) + (b.rows ?? []).reduce((s, r) => s + r.issues.length, 0);

/** 按 ApiError.error 查。spec 表之外多一条 invalid_credentials（登录页的「文案取 ERROR_COPY」，spec 顶部 Revisions） */
export const ERROR_COPY: Readonly<Record<string, Entry>> = {
  unauthorized: { title: '登录已过期', next: '重新登录后接着刚才的操作', place: 'relogin', tone: 'neutral', action: 'relogin' },
  forbidden: { title: '你的角色无法执行这项操作', next: '需要所有者或管理员', place: 'page', tone: 'caution' },
  csrf: { title: '页面已过期', next: '刷新后重试', place: 'page', tone: 'danger', action: 'refresh' },
  cross_site: { title: '页面已过期', next: '刷新后重试', place: 'page', tone: 'danger', action: 'refresh' },
  rev_conflict: {
    title: '别人刚改过这里',
    next: '载入最新内容（你的改动以对比形式保留）',
    place: 'banner',
    tone: 'danger',
    action: 'reload',
  },
  sop_conflict: {
    title: (b) => `有${count(b.keys?.length)}节在你改的同时被改了`,
    next: '去合并',
    place: 'banner',
    tone: 'danger',
    action: 'merge',
  },
  catalog_code_taken: { title: '这个编号已经有了', next: '换一个', place: 'field', tone: 'danger' },
  contract: { title: (b) => `有${count(b.violations?.length)}处需要改`, next: '点一处跳过去', place: 'checklist', tone: 'danger' },
  locked_field: {
    title: (b, ctx) => {
      const names = ctx.fieldLabel ? (b.fields ?? []).map(ctx.fieldLabel) : [];
      return names.length ? `这些内容上架后锁定了：${names.join('、')}` : '这些内容上架后锁定了';
    },
    next: null,
    place: 'page',
    tone: 'danger',
  },
  invalid_item: { title: (b) => `有${issueCount(b)}处要改`, next: null, place: 'field', tone: 'danger' },
  invalid_csv: { title: (b) => `有${issueCount(b)}处要改`, next: null, place: 'field', tone: 'danger' },
  invalid_sop: { title: '无法保存这份话术：格式不对', next: '撤回刚才的改动再试', place: 'banner', tone: 'danger' },
  locked_section: { title: '固定规则节不能改', next: '撤回这一节的改动', place: 'banner', tone: 'danger' },
  not_found: { title: '没有这项内容：可能已被删除或地址写错了', next: '回到列表', place: 'whole', tone: 'neutral', action: 'back' },
  conflict: { title: '刚才有人同时在改', next: '刷新后重来', place: 'banner', tone: 'danger', action: 'refresh' },
  bad_request: { title: '无法完成这项操作', next: '刷新页面后重试', place: 'page', tone: 'danger', action: 'refresh' },
  unsupported_media_type: { title: '无法完成这项操作', next: '刷新页面后重试', place: 'page', tone: 'danger', action: 'refresh' },
  rate_limited: { title: '尝试太频繁', next: '稍后再试', place: 'form', tone: 'danger' },
  busy: { title: '尝试太频繁', next: '稍后再试', place: 'form', tone: 'danger' },
  lock_lost: {
    title: '暂时无法保存：系统在重连数据库，线上内容不受影响',
    next: '稍后重试',
    place: 'banner',
    tone: 'danger',
    action: 'retry',
  },
  not_ready: { title: '系统正在启动', next: '重试', place: 'inline', tone: 'neutral', action: 'retry' },
  db_disabled: { title: '后台只在数据库模式下可用', next: null, place: 'whole', tone: 'neutral' },
  invalid_credentials: { title: '邮箱或密码不对', next: '检查后重试', place: 'form', tone: 'danger' },
};

/** 网络失败、表里没有的 5xx（含 internal） */
export const NETWORK_COPY: Entry = { title: '服务暂时连不上', next: '重试', place: 'inline', tone: 'danger', action: 'retry' };
/** 表里没有的 error：原码进技术详情 */
export const FALLBACK_COPY: Entry = { title: '无法完成这项操作', next: '重试', place: 'inline', tone: 'danger', action: 'retry' };

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

function entryOf(e: unknown): { entry: Entry; body: ApiError } {
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
