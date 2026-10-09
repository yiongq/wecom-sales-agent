// 出站与入站的状态迁移表（docs/architecture/03-channels-v2/spec.md「出站：投递状态」的迁移表、R3 的入站状态机、R4、
// 不变量 7、8）。纯数据加两个查表函数，只 import src/shared/：repo 的 SQL 条件（src/db/repo/outbound.ts、channel-inbox.ts）
// 与第 8 步的内存账本都从这里取，表外的写入一律当无操作、不报错——晚到的写入盖不回终态。

import type { InboxState, OutboundStatus } from '../shared/channel-types.js';

/**
 * 出站的写入方，即迁移表「谁写」一列：
 * - plan：planOutbound 排进的会话落库，或没有会话时的短事务；运行时才补的段
 * - mark：markSending 的短事务
 * - settle：settleIntent 写结果；R6 下 pending 还没落库、或 sending 没写成就发了的结果；同一进程里那一段的重试
 * - cancel：cancelIntents；本进程标了 sending、提交回来之后发现已被接手、还没发请求
 * - unmark：本进程标了 sending、提交回来之后发现已过停机截止、还没发请求，迁回 pending
 * - recover：启动恢复、restore-cutoff、channel-export
 * - receipt：发送失败回执（msg_send_fail）
 */
export type OutboundWriter = 'plan' | 'mark' | 'settle' | 'cancel' | 'unmark' | 'recover' | 'receipt';

export interface OutboundTransition {
  /** null：库里还没有这一行（插入） */
  readonly from: OutboundStatus | null;
  readonly to: OutboundStatus;
  readonly by: readonly OutboundWriter[];
}

/** spec 的迁移表，一格一行。「行已存在时什么都不改」的 pending 插入、终态（rejected、failed、cancelled）都靠「表里没有」表达 */
export const OUTBOUND_TRANSITIONS: readonly OutboundTransition[] = [
  { from: null, to: 'pending', by: ['plan'] },
  { from: null, to: 'accepted', by: ['settle'] },
  { from: null, to: 'rejected', by: ['settle'] },
  { from: null, to: 'unknown', by: ['settle'] },
  { from: 'pending', to: 'sending', by: ['mark'] },
  { from: 'pending', to: 'accepted', by: ['settle'] },
  { from: 'pending', to: 'rejected', by: ['settle'] },
  { from: 'pending', to: 'unknown', by: ['settle'] },
  { from: 'pending', to: 'cancelled', by: ['cancel', 'recover'] },
  { from: 'sending', to: 'accepted', by: ['settle'] },
  { from: 'sending', to: 'rejected', by: ['settle'] },
  { from: 'sending', to: 'unknown', by: ['settle', 'recover'] },
  { from: 'sending', to: 'cancelled', by: ['cancel'] },
  { from: 'sending', to: 'pending', by: ['unmark'] },
  { from: 'unknown', to: 'accepted', by: ['settle'] },
  { from: 'unknown', to: 'unknown', by: ['settle'] },
  { from: 'pending', to: 'failed', by: ['receipt'] },
  { from: 'sending', to: 'failed', by: ['receipt'] },
  { from: 'accepted', to: 'failed', by: ['receipt'] },
  { from: 'unknown', to: 'failed', by: ['receipt'] },
  // 回执先于这一行落库（R6）：落库时直接插成 failed，之后晚到的 pending 插入与结果写入都不改它
  { from: null, to: 'failed', by: ['receipt'] },
];

/** payload 只在这两种状态时有值；迁到别的状态的同一条语句把它置空（不变量 7） */
export const OUTBOUND_KEEPS_PAYLOAD: readonly OutboundStatus[] = ['pending', 'sending'];

/** 迁到 to 时允许的出发状态（null 表示可以插入新行），只看 by 里这几个写入方的格子 */
export function outboundFromStates(to: OutboundStatus, by: readonly OutboundWriter[]): (OutboundStatus | null)[] {
  return OUTBOUND_TRANSITIONS.filter((t) => t.to === to && t.by.some((w) => by.includes(w))).map((t) => t.from);
}

export function canMoveOutbound(from: OutboundStatus | null, to: OutboundStatus, by: readonly OutboundWriter[]): boolean {
  return outboundFromStates(to, by).includes(from);
}

export interface InboxTransition {
  /** null：库里还没有这一行（插入） */
  readonly from: InboxState | null;
  readonly to: InboxState;
}

/**
 * R3：received → recorded → replied → done，任一步可到 abandoned（带原因）；只往前走，done、abandoned 是终态（不变量 8，
 * 库里另有触发器拦）。跳步的几格是 spec 写到的短路
 */
export const INBOX_TRANSITIONS: readonly InboxTransition[] = [
  // acceptPage 插入新消息、菜单点击、回执；channel-import 的在途
  { from: null, to: 'received' },
  // acceptPage 的进入会话事件（只为去重）；channel-import 只在 handled 里的（legacy）
  { from: null, to: 'done' },
  // acceptPage 冷启动时早于截止的（cold_start）
  { from: null, to: 'abandoned' },
  { from: 'received', to: 'recorded' },
  // 非文本消息：占位（recorded）与引导提示的分段（replied）在同一次落库里
  { from: 'received', to: 'replied' },
  // 菜单点击、回执的短路；启动保底把 received 按 recorded、replied 处理完之后
  { from: 'received', to: 'done' },
  { from: 'received', to: 'abandoned' },
  { from: 'recorded', to: 'replied' },
  // 静默（转人工等）、已转人工的 recorded
  { from: 'recorded', to: 'done' },
  { from: 'recorded', to: 'abandoned' },
  { from: 'replied', to: 'done' },
  { from: 'replied', to: 'abandoned' },
];

/** 没结束的三种：启动时读出、清理时超期记 abandoned */
export const INBOX_OPEN_STATES: readonly InboxState[] = ['received', 'recorded', 'replied'];
/** 终态：payload 为空，不再变化 */
export const INBOX_FINISHED_STATES: readonly InboxState[] = ['done', 'abandoned'];

/** 迁到 to 时允许的出发状态（null 表示可以插入新行） */
export function inboxFromStates(to: InboxState): (InboxState | null)[] {
  return INBOX_TRANSITIONS.filter((t) => t.to === to).map((t) => t.from);
}

export function canMoveInbox(from: InboxState | null, to: InboxState): boolean {
  return inboxFromStates(to).includes(from);
}
