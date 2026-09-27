// /sop 的懒加载部分（spec「性能 · 按路由拆包」）：页面代码（连同 @codemirror）只在第一次进这一页时下载，
// 路由的其余配置留在 router.tsx
import { createLazyRoute } from '@tanstack/react-router';
import { SopPage } from './SopPage.js';

export const Route = createLazyRoute('/sop')({ component: SopPage });
