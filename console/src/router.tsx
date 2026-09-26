// 路由（TanStack Router，代码式定义）：挂在 /console 下。登录与否由 Shell 判断，不单独占一个路由
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AuditPage } from './pages/AuditPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { SopPage } from './pages/SopPage.js';
import { NotFound, Shell } from './Shell.js';

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });

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
const audit = createRoute({ getParentRoute: () => root, path: '/audit', component: AuditPage });

export const router = createRouter({ routeTree: root.addChildren([index, sop, catalog, audit]), basepath: '/console' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
