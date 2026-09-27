// 路由（TanStack Router，代码式定义）：挂在 /console 下。登录与否由 Shell 判断，不单独占一个路由。
// 各页按路由拆包（spec「性能 · 按路由拆包」）：这里只留路径与参数，页面组件在 pages/*.lazy.tsx，由 .lazy() 按需下载。
// 入口集合里不能有页面代码，scripts/check-console-dist.ts 按 vite 的 manifest 查预算与 @codemirror
import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { StateView } from './parts/StateView.js';
import { NotFound, Shell } from './shell/Shell.js';

/** 页面的块还在下载：内容面板里放通用骨架（换页时路由先留着上一页，超过 1 秒才换成它） */
function PagePending(): ReactElement {
  return <StateView pending />;
}

/**
 * 页面的块没取到（断网，或者发版后旧的块已经不在了），或页面渲染时抛错：就地说明，不用路由自带的英文错误页。
 * 重试是整页重新载入：index.html 不缓存，重新载入就拿到新的块名；失败过的 import() 浏览器可能记着，原地重试不一定重新下载
 */
function PageError({ error }: ErrorComponentProps): ReactElement {
  return <StateView error={error} onRetry={() => window.location.reload()} />;
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

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/sop' });
  },
});
const sop = createRoute({ getParentRoute: () => root, path: '/sop' }).lazy(() => import('./pages/sop.lazy.js').then((m) => m.Route));
const catalog = createRoute({
  getParentRoute: () => root,
  path: '/catalog/$kind',
  params: {
    parse: (p: { kind: string }): { kind: 'route' | 'hotel' } => ({ kind: p.kind === 'hotel' ? 'hotel' : 'route' }),
    stringify: (p: { kind: 'route' | 'hotel' }) => ({ kind: p.kind }),
  },
}).lazy(() => import('./pages/catalog.lazy.js').then((m) => m.Route));
const conversations = createRoute({ getParentRoute: () => root, path: '/conversations' }).lazy(() =>
  import('./pages/conversations.lazy.js').then((m) => m.Route),
);
const audit = createRoute({ getParentRoute: () => root, path: '/audit' }).lazy(() => import('./pages/audit.lazy.js').then((m) => m.Route));

const specimenSearch = (s: Record<string, unknown>): { theme?: 'light' | 'dark' } =>
  s.theme === 'light' || s.theme === 'dark' ? { theme: s.theme } : {};
const specimen = SPECIMEN
  ? [
      createRoute({ getParentRoute: () => root, path: '/_specimen', validateSearch: specimenSearch }).lazy(() =>
        import('./_specimen/controls.lazy.js').then((m) => m.Route),
      ),
      createRoute({ getParentRoute: () => root, path: '/_specimen/type', validateSearch: specimenSearch }).lazy(() =>
        import('./_specimen/type.lazy.js').then((m) => m.Route),
      ),
    ]
  : [];

export const router = createRouter({
  routeTree: root.addChildren([index, sop, catalog, conversations, audit, ...specimen]),
  basepath: '/console',
  defaultPendingComponent: PagePending,
  defaultErrorComponent: PageError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
