// 提交后的领域事件总线（docs/architecture/02-conversations-workbench/spec.md「通知」）。
// 事件由 store 的 emitAfterCommit 排在某个会话的下一次落库（db）或落盘（file）上，提交成功之后才交给这里的订阅者；
// 提交失败时不发（不变量 10）。事件里只有 id、状态、类型、seq 与时间，不带消息正文和客户原话。
import type { HandoffKind, MessageAuthor, OrderStatus } from '../shared/conversation-types.js';

export type DomainEvent =
  | { type: 'conversation.changed'; id: string }
  | { type: 'message.appended'; id: string; seq: number; author: MessageAuthor }
  | {
      type: 'handoff.started';
      id: string;
      kind: HandoffKind;
      at: number;
      escalated: boolean;
      paidCustomer: boolean;
      /** 发出时是否已有接手人（02 第 19 步审查）：true 只在 takeover() 当场接手触发的那一次，前端不弹浏览器通知 */
      assigned: boolean;
    }
  | { type: 'conversation.assigned'; id: string; assigneeName: string }
  | { type: 'conversation.released'; id: string }
  | { type: 'order.changed'; id: string; orderId: string; status: OrderStatus; confirmed: boolean }
  | { type: 'send.failed'; id: string; failType: number | null };

const subscribers = new Set<(ev: DomainEvent) => void>();

export function onCommitted(cb: (ev: DomainEvent) => void): () => void {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
}

/** 后端在提交成功之后调。订阅者抛错只记日志，不影响别的订阅者，也不回滚已经提交的改动 */
export function deliverCommitted(events: readonly DomainEvent[]): void {
  for (const ev of events) {
    for (const cb of subscribers) {
      try {
        cb(ev);
      } catch (e) {
        console.error(`[store] 领域事件 ${ev.type} 的订阅者出错:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

// ---------------- 库写不进去时的转人工（02 spec「通知」，不变量 10 唯一的例外） ----------------

export type HandoffStartedEvent = Extract<DomainEvent, { type: 'handoff.started' }>;

const unsavedSubscribers = new Set<(ev: HandoffStartedEvent) => void>();

/**
 * 带 handoff.started 的落库没写进去：那次落库失败（连接类，正在退避重试；或数据类，会话停写），或它排在一次失败的落库后面，
 * 或会话已停写（poisoned）时又转人工。PG 后端每次失败都会再报一遍同一个事件，订阅者按 id 与 at 去重；提交成功时这个事件照常
 * 经 onCommitted 发出（订阅者据此取消还没发的提醒）。外部通道的 unsaved 通知（src/notify/handoff.ts）订阅它
 */
export function onHandoffUnsaved(cb: (ev: HandoffStartedEvent) => void): () => void {
  unsavedSubscribers.add(cb);
  return () => void unsavedSubscribers.delete(cb);
}

/** PG 后端在落库失败、会话停写时调：只交 handoff.started。订阅者抛错只记日志 */
export function deliverHandoffUnsaved(events: readonly DomainEvent[]): void {
  for (const ev of events) {
    if (ev.type !== 'handoff.started') continue;
    for (const cb of unsavedSubscribers) {
      try {
        cb(ev);
      } catch (e) {
        console.error('[store] 转人工没落库的订阅者出错:', e instanceof Error ? e.message : e);
      }
    }
  }
}
