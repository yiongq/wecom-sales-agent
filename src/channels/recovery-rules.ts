// 启动恢复的判定（docs/architecture/03-channels-v2/spec.md「重启、崩溃与恢复」的出站恢复表与入站恢复表、「渠道行与会话落库（R21）」
// 末尾的保底三条、R5、开放问题 6、7，不变量 5、10、15）。纯函数：不 import src/db/、store、engine、llm、adapters
// （scripts/check-boundaries.ts 登记）。调用方（src/channels/recovery.ts 与企微适配器）把库里与会话里的事实收齐交进来，这里只按表给出处理。

import type { InboxKind } from '../shared/channel-types.js';
import type { OutboundKind } from '../shared/conversation-types.js';

/**
 * R5、开放问题 4、7：企微对同一 msgid 是否去重核实之前为假——重启时还是 sending 的段记 unknown、不补发（客户可能少收这一段，
 * 工作台「可能没送达」、告警一条）。核实为「去重」之后改成真：sending 的段保持 sending、按同一 msgid 补发，这条边界随之消失。
 * 只改这一个常量（自测经适配器的 __channelTest 在子进程里设）
 */
export const RESEND_UNKNOWN = false;

/** 开放问题 6 的裁决：停在 pending 的人工回复，建这一行起这么久之内、会话的接手人没变才按同一 msgid 补发 */
export const HUMAN_RESEND_WINDOW_MS = 10 * 60_000;

// ---------------- 出站恢复表 ----------------

/** 一行没结果的出站（库里 pending、sending）在启动那一刻的事实 */
export interface OpenOutboundFacts {
  status: 'pending' | 'sending';
  kind: OutboundKind;
  /** 建这一行的时刻（outbound_sends.sent_at：pending 的行是排进发送那一刻，毫秒） */
  sentAt: number;
  inboxId: string | null;
  /** 有 inbox_id 时：那条入站还没结束（received、recorded、replied）；已结束（done、abandoned）或已被清理为 false */
  inboxOpen: boolean;
  /** 账号的恢复截止点（R7，毫秒；没有为 null） */
  recordOnlyUntil: number | null;
  /**
   * 人工回复：这条人工消息的作者此刻仍是会话的接手人（开放问题 6 的「接手人没变」）。会话里找不到这条消息、会话没有接手人
   * （交还了）、换了人接手都是 false
   */
  humanAssigneeSame: boolean;
  /** 这一行所属的会话此刻有接手人（转人工且有 assignee） */
  hasAssignee: boolean;
  now: number;
  resendUnknown: boolean;
  /**
   * 这个账号有一条还没处理完的失败回执（send_fail 的入站行停在 received，回执的短事务没写成，第 9 步）指着这一段：它已经失败了
   */
  failReceived: boolean;
}

/** 出站恢复表一行的处理，按 spec 的行名 */
export type OutboundCancelWhy =
  | 'restore_cutoff'
  | 'inbox_finished'
  | 'followup'
  | 'human_stale'
  | 'human_assignee_changed'
  | 'menu'
  | 'welcome'
  | 'ai_without_inbox'
  | 'card';

export type OutboundRecovery =
  /** sending、RESEND_UNKNOWN 为假：记 unknown、不补发（R5 的边界），告警一条 */
  | { do: 'unknown' }
  /** 按同一 msgid、同一内容补发。alreadySending：RESEND_UNKNOWN 为真时的 sending 段，已是 sending，直接发（spec「直接走第 5 步」） */
  | { do: 'resend'; alreadySending: boolean }
  | { do: 'cancel'; why: OutboundCancelWhy }
  /** 有 inbox_id、入站行还没结束：不在这里发，留给入站恢复（出队时照常计次、判过期与截止，再按 replied 一行处理） */
  | { do: 'inbound' }
  /** 已收到失败回执、回执还没处理完：不补发、不改，留给入站恢复重做回执的短事务（迁到 failed） */
  | { do: 'receipt' };

const cancel = (why: OutboundCancelWhy): OutboundRecovery => ({ do: 'cancel', why });

/** AI 产生的分段种类（不变量 10：有接手人的会话里重启后不补发）；通知与人工回复不在里面。card 只在 02 的旧行上，是 AI 回复的卡片 */
const AI_KINDS: ReadonlySet<OutboundKind> = new Set<OutboundKind>(['ai', 'followup', 'menu', 'welcome', 'card']);

/**
 * spec「出站恢复」表，自上而下第一行命中的为准。表前多一行（第 9 步评审之后才有的情形，表里没写）：失败回执的入站行停在 received
 * 而指着这一段的，这一段已经失败（不变量 5：failed 永不再发），出站恢复不补发、不取消、不记 unknown，等入站恢复重做回执把它迁到 failed
 */
export function outboundRecovery(f: OpenOutboundFacts): OutboundRecovery {
  if (f.failReceived) return { do: 'receipt' };
  if (f.status === 'sending') {
    if (!f.resendUnknown) return { do: 'unknown' };
    // RESEND_UNKNOWN 为真：保持 sending、按同一 msgid 补发；但有接手人的会话里 AI 产生的分段不补发、记 unknown（不变量 10，
    // 协调者 2026-10-09 裁决）。通知、人工回复照表补发
    return f.hasAssignee && AI_KINDS.has(f.kind) ? { do: 'unknown' } : { do: 'resend', alreadySending: true };
  }
  if (f.recordOnlyUntil !== null && f.sentAt <= f.recordOnlyUntil) return cancel('restore_cutoff');
  if (f.inboxId !== null) return f.inboxOpen ? { do: 'inbound' } : cancel('inbox_finished');
  switch (f.kind) {
    case 'followup':
      // 对应的跟进任务在 sending，02 的启动归位把它记 abandoned、不重发，两边同一口径
      return cancel('followup');
    case 'notice':
      // 从没发过，客户要知道钱到了
      return { do: 'resend', alreadySending: false };
    case 'human':
      if (f.now - f.sentAt > HUMAN_RESEND_WINDOW_MS) return cancel('human_stale');
      return f.humanAssigneeSame ? { do: 'resend', alreadySending: false } : cancel('human_assignee_changed');
    case 'menu':
      // 同意菜单按 02「再问一次」的规则下次再问
      return cancel('menu');
    case 'welcome':
      return cancel('welcome');
    case 'ai':
      // 没有 inbox_id 的 ai 是异常道歉：过时了就不该再发
      return cancel('ai_without_inbox');
    case 'card':
      // 不会出现（库里账号的卡片段记它那一组的 kind）；万一出现按 cancelled 处理、调用方记一行日志
      return cancel('card');
  }
}

// ---------------- 入站恢复表与保底 ----------------

/** 一行没结束的入站在出队那一刻的事实（客户消息才用得上保底） */
export interface OpenInboundFacts {
  kind: InboxKind;
  state: 'received' | 'recorded' | 'replied';
  /** 会话窗口里有这个 msgid 的客户消息 */
  inSession: boolean;
  /** 7 天的 msgid 集合里有它（在库里，可能已在窗口之外） */
  known: boolean;
  /** 库里有挂在这条入站名下的出站行（任何状态） */
  hasOutbound: boolean;
}

/**
 * 保底三条（R21，覆盖 R6、poisoned 与 spill 回放失败）：received 的客户消息，名下已有出站行的按 replied 处理，会话里已有这条的按
 * recorded 处理；recorded 而会话里找不到这条（会话部分没写进库）的，先用 payload 把它补进会话（restore）再按 recorded 处理。
 * 只对客户消息（message）；菜单点击、回执原样
 */
export function effectiveInboxState(f: OpenInboundFacts): { state: 'received' | 'recorded' | 'replied'; restore: boolean } {
  if (f.kind !== 'message') return { state: f.state, restore: false };
  if (f.state === 'received') {
    if (f.hasOutbound) return { state: 'replied', restore: false };
    if (f.inSession || f.known) return { state: 'recorded', restore: false };
    return { state: 'received', restore: false };
  }
  if (f.state === 'recorded' && !f.inSession && !f.known) return { state: 'recorded', restore: true };
  return { state: f.state, restore: false };
}

/** recorded 的客户消息在出队那一刻的事实 */
export interface RecordedFacts {
  /** 这句在会话窗口里（补进会话之后的也算） */
  inWindow: boolean;
  /** 这句之后、下一条客户消息之前有 AI 回复（见 aiReplyAfter） */
  aiReplyAfter: boolean;
  /** 会话已转人工 */
  handedOver: boolean;
  /** 会话有接手人（转人工且有 assignee） */
  hasAssignee: boolean;
}

export type RecordedRecovery =
  /** 按那条回复切分段、planOutbound、照常发，不调模型（这条回复没进过 replied，说明一段都没发过） */
  | { do: 'send_reply' }
  /** 有回复、会话有接手人：AI 回复的分段不发（不变量 10）；分段排进去随即取消，工作台「未发送」，会话记「本轮未发送」 */
  | { do: 'cancel_reply' }
  | { do: 'done'; why: 'handed_over' | 'out_of_window' }
  /** 以 alreadyRecorded 重跑（这句不再记一遍） */
  | { do: 'rerun' };

/**
 * spec 入站恢复表的三行 recorded。out_of_window：这句只在 7 天集合里、已不在会话窗口（被重置或裁剪），这一轮早已过去，记 done（02 去重
 * 情况 2 的口径）。有回复而会话有接手人：表里没写，按不变量 10「重启后不补发 AI 回复的分段」与 replied 一行的同一口径
 */
export function recordedRecovery(f: RecordedFacts): RecordedRecovery {
  if (!f.inWindow) return { do: 'done', why: 'out_of_window' };
  if (f.aiReplyAfter) return f.hasAssignee ? { do: 'cancel_reply' } : { do: 'send_reply' };
  if (f.handedOver) return { do: 'done', why: 'handed_over' };
  return { do: 'rerun' };
}

export type RepliedRecovery =
  /** 会话有接手人：名下 pending 的段 cancelled、记「本轮未发送」，done */
  | { do: 'cancel_pending' }
  /** 按同一 msgid、同一内容发名下 pending 的段，不调模型；都有结果之后 done */
  | { do: 'resend_pending' }
  /** 名下没有 pending 的段（都有结果了、或 sending 已在出站恢复里记了 unknown）：done */
  | { do: 'done' };

/** spec 入站恢复表的 replied 一行 */
export function repliedRecovery(f: { hasAssignee: boolean; pending: number }): RepliedRecovery {
  if (!f.pending) return { do: 'done' };
  return f.hasAssignee ? { do: 'cancel_pending' } : { do: 'resend_pending' };
}

/** 会话里一条消息里判「AI 回复」要的几个字段 */
export interface MessageLike {
  role: string;
  author?: string;
  content: string;
}

/**
 * 「会话里这句之后有 AI 回复」（spec 入站恢复表下的注）：at 之后、下一条客户消息之前，role='agent' 且 author 为空或 ai 的第一条
 * （欢迎语不算，02 的规则；system、人工回复、跟进跳过）。返回它的下标，没有为 -1
 */
export function aiReplyAfter(messages: readonly MessageLike[], at: number, isWelcome: (content: string) => boolean): number {
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'customer') return -1;
    if (m.role === 'agent' && (m.author === undefined || m.author === 'ai') && !isWelcome(m.content)) return i;
  }
  return -1;
}
