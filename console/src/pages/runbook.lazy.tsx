// /ops/runbooks/$key 的懒加载部分（spec「性能 · 按路由拆包」）
import { createLazyRoute } from '@tanstack/react-router';
import '../ops/runbook.css';
import { RunbookPage } from '../ops/RunbookPage.js';

export const Route = createLazyRoute('/ops/runbooks/$key')({ component: RunbookPage });
