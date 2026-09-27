// /catalog/$kind 的懒加载部分（spec「性能 · 按路由拆包」）：页面代码只在第一次进这一页时下载，
// 路由的参数解析留在 router.tsx
import { createLazyRoute } from '@tanstack/react-router';
import { CatalogPage } from './CatalogPage.js';

export const Route = createLazyRoute('/catalog/$kind')({ component: CatalogPage });
