// 会话状态与短码（docs/features/console-ux/spec.md「接口改动」、不变量 17）：前后端共用，只依赖 src/shared。
// 全站只有这一处判定会话状态：服务端的过滤、计数和 console 的列表、首页、徽标、铃铛都调 conversationState，
// console 里不直接读 handedOver、也不拿 stage 和 'paid' 比（plan 第 3.3 步的检查拦这两种写法）。
import type { ConversationRow, ConversationState } from './console-api.js';

/** paid：stage === 'paid'；human（等人接手）：handedOver 且没付款；ai（AI 接待中）：其余 */
export function conversationState(row: Pick<ConversationRow, 'stage' | 'handedOver'>): ConversationState {
  if (row.stage === 'paid') return 'paid';
  if (row.handedOver) return 'human';
  return 'ai';
}

/**
 * 会话的短码，如 wecom:cust_A01 → A01。与 public/admin.html 的 shortIdOf 同一规则，后台和工作台里能对上号：
 * 去掉 wecom:、sim-、cust / cust_ 前缀，只留字母数字，取最后 4 位转大写。没有字母数字时是空串
 */
export function shortIdOf(id: string): string {
  return id
    .replace(/^wecom:/, '')
    .replace(/^sim-/, '')
    .replace(/^cust_?/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
}
