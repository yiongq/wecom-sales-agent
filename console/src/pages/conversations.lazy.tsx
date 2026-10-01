// /conversations 的懒加载部分（spec「性能 · 按路由拆包」）：会话列表的代码与样式只在第一次进这一页时下载
import { createLazyRoute } from '@tanstack/react-router';
import '../conversations/conversations.css';
import { ConversationsPage } from '../conversations/ConversationsPage.js';

export const Route = createLazyRoute('/conversations')({ component: ConversationsPage });
