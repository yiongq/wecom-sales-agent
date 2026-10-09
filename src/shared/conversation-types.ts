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

/** 一次转人工的记录：进入时写下，交还、重置时清（R9） */
export interface HandoffRecord {
  kind: HandoffKind;
  at: number;
  /** 给顾问看的一句原因，≤120 字：model / claimed 取模型给的 reason，其余按 kind 写固定说明 */
  reason: string;
  /** 触发这次转人工的那句客户原话，≤200 字；agent 没有 */
  quote?: string;
  /** 客户原话里识别出的出行时间（departNoteForHandoff 的结果） */
  departNote?: string;
}

/** 接手人 */
export interface Assignee {
  /** console 成员的 user id；共享工作台（ADMIN_PASS 旧接口）为 null */
  userId: string | null;
  /** 写入时的显示名快照；共享工作台写「共享工作台」 */
  name: string;
  at: number;
}

export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled' | 'superseded';

/** 收款方式：online 是今天的模拟支付，advisor 是顾问确认收款（spec「收款流程」） */
export type PaymentMode = 'online' | 'advisor';

/** 出站消息的类别，记进发送账本（spec「企微：发送账本、回执与去重」） */
export type OutboundKind = 'ai' | 'human' | 'followup' | 'notice' | 'welcome' | 'menu' | 'card';

/** 企微 48 小时、5 条的发送窗口 */
export interface SendWindow {
  /** 客户最后一条消息的 sentAt（企微 send_time），没有就用 at */
  lastCustomerAt: number | null;
  /** lastCustomerAt + 48 小时 */
  closesAt: number | null;
  /** lastCustomerAt 之后 accepted 与 unknown 的分段数（send_msg_on_event 不计） */
  used: number;
  /** max(0, 5 - used)；窗口已过为 0 */
  remaining: number;
}

// ---------------- 发送窗口与送达状态的固定文案（02 第 20.2 步挪到这里） ----------------
// 原在 src/quota/ledger.ts（窗口关着、条数用完时给顾问看的说明，与 msg_send_fail 的 4、6 同一句）；J 页的消息也要显示同一句
// 说明（MessageView.delivery），而 console/src 只能 import src/shared/（scripts/check-boundaries.ts），
// 这几句纯文案挪到这里、ledger.ts 改为从这里 import 再原样 re-export，两边读的是同一份常量，不会各写一遍走样

export const WINDOW_CLOSED_TEXT = '客户超过 48 小时没说话，这条发不出去了';
export const QUOTA_EXHAUSTED_TEXT = '这一轮已经发满 5 条，等客户回复后才能再发';

/** msg_send_fail 给会话加的说明（spec 原文：4 窗口过了、6 发满 5 条、其余带原因码） */
export function sendFailText(failType: number): string {
  if (failType === 4) return WINDOW_CLOSED_TEXT;
  if (failType === 6) return QUOTA_EXHAUSTED_TEXT;
  return `这条没送达（原因码 ${failType}）`;
}
