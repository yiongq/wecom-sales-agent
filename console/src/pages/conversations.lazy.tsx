// /conversations 的懒加载部分（spec「性能 · 按路由拆包」）：页面代码只在第一次进这一页时下载
import { createLazyRoute } from '@tanstack/react-router';
import { ConversationsPage } from './ConversationsPage.js';

export const Route = createLazyRoute('/conversations')({ component: ConversationsPage });
