// / 的懒加载部分（spec「性能 · 按路由拆包」）：总览的代码与样式在这一块里，scripts/check-console-dist.ts 把它算进首屏预算
import { createLazyRoute } from '@tanstack/react-router';
import '../overview/overview.css';
import { OverviewPage } from '../overview/OverviewPage.js';

export const Route = createLazyRoute('/')({ component: OverviewPage });
