// /audit 的懒加载部分（spec「性能 · 按路由拆包」）：审计日志的代码与样式只在第一次进这一页时下载
import { createLazyRoute } from '@tanstack/react-router';
import '../audit/audit.css';
import { AuditPage } from '../audit/AuditPage.js';

export const Route = createLazyRoute('/audit')({ component: AuditPage });
