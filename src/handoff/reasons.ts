// 固定的通用转人工原因，纯数据，不加载存储或发送账本。
import type { HandoffKind } from '../types.js';

/**
 * 按类型写的固定原因（model 取模型给的原因，这里的只在模型没给时兜底）。
 * 不用「待人工」「已转人工」「待接管」「需要介入」这类状态词：界面上会话状态只有四种叫法（设计系统 §11）
 */
export const HANDOFF_REASON = {
  request: '客户要找顾问',
  complaint: '客户投诉',
  refund: '客户要退款或改订单',
  model: 'AI 判断要请顾问处理',
  promise: '回复里答应了改行程，要顾问重排',
  claimed: '回复里答应了转接顾问（引擎补记）',
  agent: '共享工作台转人工',
  emergency: '客户遇到紧急情况',
  failure: '客户的问题 AI 几轮都没答上',
  sentiment: '客户情绪不满',
  consent: '客户不同意处理敏感个人信息',
} as const satisfies Partial<Record<HandoffKind, string>>;
