// /conversations/$id 的懒加载部分（spec「性能 · 按路由拆包」）：会话工作台（J 页）的代码与样式只在
// 第一次打开某个会话时下载
import { createLazyRoute } from '@tanstack/react-router';
import '../conversations/workbench.css';
import { WorkbenchPage } from '../conversations/WorkbenchPage.js';

export const Route = createLazyRoute('/conversations/$id')({ component: WorkbenchPage });
