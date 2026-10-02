// 会话相关的共享契约类型（docs/architecture/02-conversations-workbench/spec.md「模块与依赖方向」）。
// 后台接口与服务端模块都从这里 import；src/types.ts 等反过来从这里再导出。本文件只能 import zod 与 src/shared/。

/** 消息的作者：客户、AI、顾问人工回复、自动跟进、系统 */
export type MessageAuthor = 'customer' | 'ai' | 'human' | 'followup' | 'system';

/** 转人工的类型（spec「转人工记录与四种状态」） */
export type HandoffKind =
  | 'request' // 客户要人工（isHandoffIntent 的普通诉求）
  | 'complaint' // 投诉
  | 'refund' // 要退款、退订
  | 'emergency' // 紧急情况（R15）
  | 'failure' // 交互失败达到阈值（R15）
  | 'sentiment' // 负面情绪（R15）
  | 'model' // 模型调了 handoff_to_human
  | 'promise' // 模型许诺改行程（CUSTOM_PROMISE），删句后转人工
  | 'claimed' // 回复里说了转接、引擎补转
  | 'consent' // 客户不同意或撤回同意处理敏感信息（R23）
  | 'agent'; // 顾问在后台接手，或旧工作台点了转人工

export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled' | 'superseded';
