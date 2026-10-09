// /catalog/$kind/$code 与 /catalog/new/$kind 的懒加载部分（spec「性能 · 按路由拆包」）：两个路由共用这一块，
// 只在第一次打开一条或新建时下载；路由的参数解析留在 router.tsx。字段渲染器与详情页的样式随这一块下载
import { createLazyRoute } from '@tanstack/react-router';
import '../fields/fields.css';
import '../catalog/detail.css';
import { CatalogItemPage, CatalogNewPage } from './CatalogItemPage.js';

export const ItemRoute = createLazyRoute('/catalog/$kind/$code')({ component: CatalogItemPage });
export const NewRoute = createLazyRoute('/catalog/new/$kind')({ component: CatalogNewPage });
