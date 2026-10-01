// /catalog/$kind 的懒加载部分（spec「性能 · 按路由拆包」）：页面代码只在第一次进这一页时下载，
// 路由的参数解析留在 router.tsx。字段渲染器、列表与 CSV 导入弹窗的样式随这一块下载（渲染器、列表组件本身不 import CSS，自测在 Node 里 import 它们）
import { createLazyRoute } from '@tanstack/react-router';
import '../fields/fields.css';
import '../catalog/catalog.css';
import '../catalog/csv-import.css';
import { CatalogPage } from './CatalogPage.js';

export const Route = createLazyRoute('/catalog/$kind')({ component: CatalogPage });
