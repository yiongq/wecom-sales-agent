// /traces/$turnId 的懒加载部分（spec「性能 · 按路由拆包」）：单轮记录与 AI 记录共用样式
import { createLazyRoute } from '@tanstack/react-router';
import '../conversations/trace-detail.css';
import '../traces/traces.css';
import { TraceDetailPage } from '../traces/TraceDetailPage.js';

export const Route = createLazyRoute('/traces/$turnId')({ component: TraceDetailPage });
