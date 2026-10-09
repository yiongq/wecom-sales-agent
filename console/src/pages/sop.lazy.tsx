// /sop 的懒加载部分（spec「性能 · 按路由拆包」）：页面代码（连同 @codemirror）只在第一次进这一页时下载，
// 路由的其余配置留在 router.tsx。话术页自己的样式（sop/sop.css）也随这一块下载；组件本身不 import CSS，自测才能在 Node 里 import
import '../sop/sop.css';
import { createLazyRoute } from '@tanstack/react-router';
import { SopPage } from './SopPage.js';

export const Route = createLazyRoute('/sop')({ component: SopPage });
