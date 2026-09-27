// 路由（TanStack Router，代码式定义）：挂在 /console 下。登录与否由 Shell 判断，不单独占一个路由
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, useRouterState } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { AuditPage } from './pages/AuditPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { ConversationsPage } from './pages/ConversationsPage.js';
import { SopPage } from './pages/SopPage.js';
import { NotFound, Shell } from './shell/Shell.js';

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
const sop = createRoute({ getParentRoute: () => root, path: '/sop', component: SopPage });
const catalog = createRoute({
  getParentRoute: () => root,
  path: '/catalog/$kind',
  params: {
    parse: (p: { kind: string }): { kind: 'route' | 'hotel' } => ({ kind: p.kind === 'hotel' ? 'hotel' : 'route' }),
    stringify: (p: { kind: 'route' | 'hotel' }) => ({ kind: p.kind }),
  },
  component: CatalogPage,
});
const conversations = createRoute({ getParentRoute: () => root, path: '/conversations', component: ConversationsPage });
const audit = createRoute({ getParentRoute: () => root, path: '/audit', component: AuditPage });

const specimenSearch = (s: Record<string, unknown>): { theme?: 'light' | 'dark' } =>
  s.theme === 'light' || s.theme === 'dark' ? { theme: s.theme } : {};
const specimen = SPECIMEN
  ? [
      createRoute({
        getParentRoute: () => root,
        path: '/_specimen',
        validateSearch: specimenSearch,
        component: lazyRouteComponent(() => import('./_specimen/ControlsSpecimen.js'), 'ControlsSpecimen'),
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/_specimen/type',
        validateSearch: specimenSearch,
        component: lazyRouteComponent(() => import('./_specimen/TypeSpecimen.js'), 'TypeSpecimen'),
      }),
    ]
  : [];

export const router = createRouter({
  routeTree: root.addChildren([index, sop, catalog, conversations, audit, ...specimen]),
  basepath: '/console',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
