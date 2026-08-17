// 模拟器渠道：网页聊天经 SSE 收服务端推送。
// server.ts 在 /api/stream/:sessionId 建立连接时调 subscribe 注册下发函数。
import type { ChannelAdapter } from '../types.js';

type Send = (text: string) => void;

/** sessionId → 该会话所有在线 SSE 连接的下发函数（同一会话可开多个标签页） */
const clients = new Map<string, Set<Send>>();

/** 注册一条 SSE 连接，返回注销函数（连接断开时必须调用，防泄漏） */
export function subscribe(sessionId: string, send: Send): () => void {
  let set = clients.get(sessionId);
  if (!set) {
    set = new Set();
    clients.set(sessionId, set);
  }
  set.add(send);
  return () => {
    set.delete(send);
    if (set.size === 0) clients.delete(sessionId);
  };
}

export const simulatorAdapter: ChannelAdapter = {
  name: 'simulator',
  async push(sessionId: string, text: string): Promise<boolean> {
    const set = clients.get(sessionId);
    if (!set) return true; // 客户不在线：消息已在 session.messages 里，刷新页面可见
    for (const send of set) {
      try {
        send(text);
      } catch {
        // 单条连接写失败不影响其余连接
      }
    }
    return true;
  },
};
