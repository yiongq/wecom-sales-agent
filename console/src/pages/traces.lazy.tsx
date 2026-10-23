// /traces 的懒加载部分（spec「性能 · 按路由拆包」）：AI 记录的代码与样式只在第一次进这一页时下载。
// trace 详情的样式（trace-detail.css）与会话工作台共用，两个页面各自引入
import { createLazyRoute } from '@tanstack/react-router';
import '../conversations/trace-detail.css';
import '../traces/traces.css';
import { TracesPage } from '../traces/TracesPage.js';

export const Route = createLazyRoute('/traces')({ component: TracesPage });
