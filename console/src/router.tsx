// 路由（TanStack Router，代码式定义）：挂在 /console 下。登录与否由 Shell 判断，不单独占一个路由。
// 各页按路由拆包（spec「性能 · 按路由拆包」）：这里只留路径与参数，页面组件在 pages/*.lazy.tsx，由 .lazy() 按需下载。
// 入口集合里不能有页面代码，scripts/check-console-dist.ts 按 vite 的 manifest 查预算与 @codemirror
import { createRootRoute, createRoute, createRouter, type ErrorComponentProps, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { auditSearch } from './audit-search.js';
import { catalogSearch } from './catalog/params.js';
import { conversationsSearch } from './conversations-search.js';
import { PageSkeleton, RouteError, StateView } from './parts/StateView.js';
import { NotFound, Shell } from './shell/Shell.js';

/**
 * 页面的块还在下载：内容面板里马上换成整页骨架，照 StateView 的规矩 300ms 后才看得见（spec「通用部件 · StateView」）。
 * 所以 defaultPendingMs、defaultPendingMinMs 都设 0：路由默认先留着上一页 1 秒（侧栏和地址已经换了，面板还是上一页、
 * 还能点），骨架出来后至少停 0.5 秒。骨架不按页定制，见 spec 顶部 Revisions（第 2.4 步）
 */
function PagePending(): ReactElement {
  return <StateView pending skeleton={<PageSkeleton />} />;
}

/**
 * 页面的块没取到，或页面渲染时抛错：就地说明，不用路由自带的英文错误页（两种的文案见 parts/StateView.tsx 的 RouteError）。
 * 重试是整页重新载入：index.html 不缓存，重新载入就拿到新的块名；失败过的 import() 浏览器可能记着，原地重试不一定重新下载
 */
function PageError({ error }: ErrorComponentProps): ReactElement {
  return <RouteError error={error} onRetry={() => window.location.reload()} />;
}

// 样张页（spec「字体与标点样张」）只在 VITE_SPECIMEN=1 的构建里注册。条件在构建时就定了：生产构建里这些分支连同
// 样张页的代码一起被摇掉（scripts/check-console-dist.ts 查产物里没有 _specimen）
const SPECIMEN = import.meta.env.VITE_SPECIMEN === '1';

/** 走查构建的根组件：样张页不带外壳，也不请求 /me */
function RootWithSpecimen(): ReactElement {
  const path: string = useRouterState({ select: (s) => s.location.pathname });
  return /^(\/console)?\/_specimen(\/|$)/.test(path) ? <Outlet /> : <Shell />;
}

const root = createRootRoute({ component: SPECIMEN ? RootWithSpecimen : Shell, notFoundComponent: NotFound });

// 总览（spec「总览」）：取代原来跳到 /sop 的重定向。scripts/check-console-dist.ts 按这个懒加载文件名把它算进首屏预算
const index = createRoute({ getParentRoute: () => root, path: '/' }).lazy(() => import('./pages/overview.lazy.js').then((m) => m.Route));
const sop = createRoute({ getParentRoute: () => root, path: '/sop' }).lazy(() => import('./pages/sop.lazy.js').then((m) => m.Route));
// 产品库列表：kind 原样交给页面，页面按当前租户的行业包找实体，包里没有的是「没有这个页面」（第 9 步）。
// 页签、搜索、筛选写进地址（spec 路由表的 status、q、f；不变量 22）
const catalog = createRoute({
  getParentRoute: () => root,
  path: '/catalog/$kind',
  validateSearch: catalogSearch,
}).lazy(() => import('./pages/catalog.lazy.js').then((m) => m.Route));
// 会话列表的 state、stage 筛选：总览的业务数与阶段条带过来（conversations-search.ts）
const conversations = createRoute({ getParentRoute: () => root, path: '/conversations', validateSearch: conversationsSearch }).lazy(() =>
  import('./pages/conversations.lazy.js').then((m) => m.Route),
);
// 审计日志的类别与「显示登录记录」写进地址（audit-search.ts）
const audit = createRoute({ getParentRoute: () => root, path: '/audit', validateSearch: auditSearch }).lazy(() =>
  import('./pages/audit.lazy.js').then((m) => m.Route),
);

const specimenSearch = (s: Record<string, unknown>): { theme?: 'light' | 'dark' } =>
  s.theme === 'light' || s.theme === 'dark' ? { theme: s.theme } : {};
const fieldsSpecimenSearch = (s: Record<string, unknown>): { theme?: 'light' | 'dark'; kind?: string; code?: string; as?: string } => ({
  ...specimenSearch(s),
  ...(typeof s.kind === 'string' ? { kind: s.kind } : {}),
  ...(typeof s.code === 'string' ? { code: s.code } : {}),
  ...(typeof s.as === 'string' ? { as: s.as } : {}),
});
const specimen = SPECIMEN
  ? [
      createRoute({ getParentRoute: () => root, path: '/_specimen', validateSearch: specimenSearch }).lazy(() =>
        import('./_specimen/controls.lazy.js').then((m) => m.Route),
      ),
      createRoute({ getParentRoute: () => root, path: '/_specimen/type', validateSearch: specimenSearch }).lazy(() =>
        import('./_specimen/type.lazy.js').then((m) => m.Route),
      ),
      // 字段渲染器样张（plan 第 3.2 步）：kind、code 选实体和条目，as 选形态（已上架、草稿、新建、没有编辑权限）
      createRoute({ getParentRoute: () => root, path: '/_specimen/fields', validateSearch: fieldsSpecimenSearch }).lazy(() =>
        import('./_specimen/fields.lazy.js').then((m) => m.Route),
      ),
    ]
  : [];

export const router = createRouter({
  routeTree: root.addChildren([index, sop, catalog, conversations, audit, ...specimen]),
  basepath: '/console',
  defaultPendingComponent: PagePending,
  defaultPendingMs: 0,
  defaultPendingMinMs: 0,
  defaultErrorComponent: PageError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
