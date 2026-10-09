// 会话存储后端的接口（docs/architecture/02-conversations-workbench/spec.md「identity map 与写入」）。
// 内存里的两张 Map 由 src/store.ts 持有，是本进程的权威；后端只管把改动持久化（文件：整文件重写；PG：每会话写队列）。
import type { Session } from '../types.js';
import type { DomainEvent } from './events.js';

export type SessionStoreMode = 'file' | 'db';

export interface StoreHealth {
  mode: SessionStoreMode;
  /** 真实会话数（不含 demo 类）。只经 console 的 /status 给成员看，不进 /healthz */
  conversations: number;
  /** 有未落库改动的会话数，与其中最早一次改动距今的毫秒数 */
  dirty: number;
  lagMs: number;
  /** 最近一次失败：只有错误码（SQLSTATE、errno 码）、约束名与会话短码，不带 err.detail 与 err.message */
  lastError: string | null;
  conflict: boolean;
  /** 因数据类错误停写的会话短码 */
  poisoned: string[];
}

/** initSessionStore 的拒绝启动。定义在这里而不是 store.ts：boot.ts 要认它，又不该为此带上 store 的导入期副作用 */
export class SessionStoreStartupError extends Error {
  constructor(
    readonly reason:
      | 'db_unreachable'
      | 'preload_integrity'
      | 'demo_class_in_db'
      | 'orphan_order'
      | 'real_in_json' // db 存储而 JSON 里有真实会话：重跑 import-sessions（补完改写或提示 --resync）
      | 'sessions_in_db' // 文件存储而 var/ 里有标记文件：会话在库里，先 export-sessions
      | 'spill_conflict', // spill 文件接不上库里的 last_seq
    readonly detail: string,
  ) {
    super(`${reason}：${detail}`);
  }
}

/** flushSession 超时：改动仍在写队列里。console 写接口据此返回 503 store_lagging */
export class StoreLaggingError extends Error {
  constructor(readonly sessionId: string) {
    super('会话改动还没落库');
  }
}

/**
 * 落库时库里的 last_seq 与「已提交到第几条」对不上（或该有的会话行不见了）：有另一写者。不重试，PG 后端标 conflict、走优雅停机，
 * drain 段不再写库、直接 spill（spec「identity map 与写入 · 失败」、不变量 12）
 */
export class StoreConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`store_conflict：${detail}`);
  }
}

export interface StoreBackend {
  readonly mode: SessionStoreMode;
  /** saveSession 调：同步分配 seq（assignSeqs）、标脏并排进这个会话的写队列 */
  schedule(session: Session): void;
  /** 订单改动（createOrder、markOrderPaid、supersedeOrder、作废）排进订单所属会话的写队列 */
  scheduleOrder(orderId: string): void;
  /** 事件排在这个会话的下一次落库上，提交成功之后才交给 onCommitted 的订阅者 */
  emitAfterCommit(sessionId: string, ev: DomainEvent): void;
  /** 等这个会话当前的改动落库。超时以 StoreLaggingError reject，改动仍在写队列里 */
  flush(sessionId: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** drain 阶段调用：排空所有写队列；超时返回还没落库的会话 id */
  drain(timeoutMs: number): Promise<{ undrained: string[] }>;
  /** exit 钩子里同步调用：文件后端同步写出没落盘的改动；PG 后端把没落库的真实会话写进 spill 文件。返回会话数 */
  spillSync(): number;
  health(): StoreHealth;
}
