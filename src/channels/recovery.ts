// 启动恢复（docs/architecture/03-channels-v2/spec.md「重启、崩溃与恢复」、R5、R21 的保底，不变量 5、6、10、15；验收 4、7、18、20）。
// 库里每个启用的企微账号起运行时之后、开始拉取之前做一遍（企微适配器的 startWecomAccount 调，src/adapters/wecom.ts 的 runRecovery）：
//   1. 出站恢复（入站恢复之前、按账号一次扫完）：initChannels 那一刻读到的 pending、sending 收进内存账本，逐行按出站恢复表
//      （recovery-rules.ts 的 outboundRecovery）记 unknown、取消、补发，或留给入站恢复；补发一段一段等完（同一会话的先后不乱）
//   2. 入站恢复：没结束的入站行按 ord 派发进各自会话的处理链（适配器的 dispatchInboxRows；出队时照常计次、判过期与截止，再按种类与
//      状态处理：recovery-rules.ts 的 effectiveInboxState、recordedRecovery、repliedRecovery）。派发完就算做完：处理链按会话串行，
//      之后拉到的同一客户的新消息排在这些行后面（不变量 12），不必等它们处理完
//   3. 做完之后 RecoveryGate 打开：这之前这个账号的 push（人工回复、跟进、通知）排队等待，至多 30 秒（spec），超时返回 false
// 判定都是 recovery-rules.ts 的纯函数；这里只收集事实、调账本与适配器交进来的发送口子（RecoveryPort）。RESEND_UNKNOWN 的生效值与
// 自测出口 __channelTest 在这里（适配器原样再导出：spec「RESEND_UNKNOWN 经适配器的 __channelTest 在子进程里设」），不读环境变量
import {
  adoptOpenOutbound,
  cancelIntents,
  payloadProblem,
  recoverAsUnknown,
  type OpenOutboundLike,
  type OutboundIntent,
} from '../quota/ledger.js';
import { getSession, seqOf } from '../store.js';
import { HUMAN_RESEND_WINDOW_MS, outboundRecovery, RESEND_UNKNOWN, type OpenOutboundFacts } from './recovery-rules.js';

export type { OpenOutboundLike } from '../quota/ledger.js';

let resendUnknown = RESEND_UNKNOWN;

/** RESEND_UNKNOWN 的生效值（缺省是常量；只有自测经 __channelTest 改） */
export function resendUnknownNow(): boolean {
  return resendUnknown;
}

/**
 * 这一批出站里重启就会按出站恢复表记 unknown 的段数（startChannels 据此加一条启动告警：R5 的边界、「sending 转 unknown」）。
 * 与 recoverOutbound 同一套事实与判定
 */
export function unknownAtRestart(
  rows: readonly OpenOutboundLike[],
  openInbox: readonly OpenInboxLike[],
  recordOnlyUntil: number | null,
): number {
  const ctx = factsContext(openInbox, recordOnlyUntil);
  return rows.filter((r) => outboundRecovery(factsOf(r, ctx)).do === 'unknown').length;
}

// ---------------- 恢复做完之前 push 排队等待 ----------------

/** spec「重启、崩溃与恢复」：恢复做完之前这个账号的 push 排队等待，至多 30 秒 */
export const PUSH_WAIT_MS = 30_000;
let pushWaitMs = PUSH_WAIT_MS;

/** 一个账号的启动恢复做没做完：没做完时 push 在这里等 */
export class RecoveryGate {
  private opened: boolean;
  private readonly waiters = new Set<() => void>();
  constructor(opened: boolean) {
    this.opened = opened;
  }
  get isOpen(): boolean {
    return this.opened;
  }
  /** 恢复做完：叫醒在等的 push */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }
  /** 等恢复做完，至多 30 秒：做完了 true，超时 false（跟进按 02 的明确失败处理，人工回复记「未能发送」） */
  wait(): Promise<boolean> {
    if (this.opened) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, pushWaitMs);
      timer.unref();
      this.waiters.add(wake);
    });
  }
}

// ---------------- 出站恢复 ----------------

/** 适配器交进来的口子：这个账号的标识、恢复截止点、补发一段的发送路径、停机 */
export interface RecoveryPort {
  accountId: string;
  /** 日志前缀（带账号 key，不带 corp_id、open_kfid） */
  tag: string;
  /** 账号的恢复截止点（R7，毫秒；没有为 null） */
  recordOnlyUntil: number | null;
  /**
   * 补发一段（同一 msgid、同一内容）：走「发一条 AI 回复」第 3–5 步——先比停机截止与接手（人工回复与通知不比接手），再 markSending、
   * 提交之后才发；alreadySending（RESEND_UNKNOWN 为真时的 sending 段）不再 markSending，AI 产生的照样比接手（以判定这一刻的代次为准）。
   * stillEligible：人工回复每次真正发请求之前的资格复核（不符合就不发、记 cancelled）
   */
  resend(intent: OutboundIntent, alreadySending: boolean, stillEligible?: () => boolean): Promise<void>;
  /** 停机中：不再开始补发 */
  stopping(): boolean;
}

export interface OutboundRecoverySummary {
  unknown: number;
  cancelled: number;
  resent: number;
  /** 留给入站恢复的（有 inbox_id、入站行还没结束；或已收到失败回执、回执还没处理完） */
  inbound: number;
  /** 停机了、没开始补发的（留在库里原样，下次启动再按表处理） */
  left: number;
}

/**
 * 开放问题 6 的「接手人没变」：这条人工回复（outbound 行的 message_seq 指向的那条 author='human' 的消息）的作者此刻仍是会话的接手人。
 * 共享工作台（user id 为空）与共享工作台算同一个（与 takeover.ts 的 isMine 同一口径）；找不到这条消息、会话交还了都算变了
 */
function humanAssigneeSame(r: OpenOutboundLike): boolean {
  if (r.kind !== 'human' || r.messageSeq === null) return false;
  const s = getSession(r.conversationId);
  if (!s) return false;
  const msg = s.messages.find((m) => seqOf(m) === r.messageSeq);
  const assignee = s.handedOver ? (s.assignee ?? null) : null;
  return !!msg && msg.author === 'human' && assignee !== null && assignee.userId === (msg.authorId ?? null);
}

/** 恢复补发的人工回复此刻仍有资格：建这一行起仍在 10 分钟内，会话的接手人仍是这条回复的作者 */
function humanStillEligible(r: OpenOutboundLike): boolean {
  return Date.now() - r.sentAt.getTime() <= HUMAN_RESEND_WINDOW_MS && humanAssigneeSame(r);
}

/** initChannels 读到的一行没结束的入站（出站恢复只看它的 id、种类与回执的 fail_msgid） */
export interface OpenInboxLike {
  id: string;
  kind: string;
  payload: unknown;
}

interface FactsContext {
  openInboxIds: ReadonlySet<string>;
  /** 停在 received 的失败回执指着的 msgid */
  failed: ReadonlySet<string>;
  recordOnlyUntil: number | null;
}

function factsContext(openInbox: readonly OpenInboxLike[], recordOnlyUntil: number | null): FactsContext {
  return {
    openInboxIds: new Set(openInbox.map((r) => r.id)),
    failed: new Set(
      openInbox
        .filter((r) => r.kind === 'send_fail')
        .map((r) => (r.payload as { fail_msgid?: unknown } | null)?.fail_msgid)
        .filter((m): m is string => typeof m === 'string'),
    ),
    recordOnlyUntil,
  };
}

/** 一行没结果的出站在此刻的事实（会话从内存里读：接手人、人工回复的作者） */
function factsOf(r: OpenOutboundLike, ctx: FactsContext): OpenOutboundFacts {
  const s = getSession(r.conversationId);
  return {
    status: r.status,
    kind: r.kind,
    sentAt: r.sentAt.getTime(),
    inboxId: r.inboxId,
    inboxOpen: r.inboxId !== null && ctx.openInboxIds.has(r.inboxId),
    recordOnlyUntil: ctx.recordOnlyUntil,
    humanAssigneeSame: humanAssigneeSame(r),
    hasAssignee: !!(s?.handedOver && s.assignee),
    now: Date.now(),
    resendUnknown,
    failReceived: ctx.failed.has(r.channelMsgid),
  };
}

/**
 * 出站恢复表（入站恢复之前，按账号一次扫完，不变量 15：每一行都给出处理）。rows 是 initChannels 读到的这个账号的 pending、sending
 * （按建行时刻、段号），openInbox 是同一个快照里这个账号没结束的入站行（判「入站行还没结束」与「已收到失败回执」）。补发按 rows 的
 * 顺序一段一段等完
 */
export async function recoverOutbound(
  port: RecoveryPort,
  rows: readonly OpenOutboundLike[],
  openInbox: readonly OpenInboxLike[],
): Promise<OutboundRecoverySummary> {
  const sum: OutboundRecoverySummary = { unknown: 0, cancelled: 0, resent: 0, inbound: 0, left: 0 };
  if (!rows.length) return sum;
  const ctx = factsContext(openInbox, port.recordOnlyUntil);
  const intents = adoptOpenOutbound(port.accountId, rows);
  for (const [i, r] of rows.entries()) {
    const intent = intents[i]!;
    const action = outboundRecovery(factsOf(r, ctx));
    if (action.do === 'unknown') {
      recoverAsUnknown(intent);
      sum.unknown += 1;
      continue;
    }
    if (action.do === 'inbound' || action.do === 'receipt') {
      sum.inbound += 1;
      continue;
    }
    if (action.do === 'cancel') {
      if (action.why === 'card') console.error(`${port.tag} ⚠️ 恢复时遇到 kind=card 的 pending 出站（库里账号不该有），记 cancelled`);
      cancelIntents([intent], 'restore');
      sum.cancelled += 1;
      continue;
    }
    if (port.stopping()) {
      sum.left += 1;
      continue;
    }
    const bad = payloadProblem(intent.payload);
    if (bad) {
      // 库里的 payload 发不了（不该发生：排进发送之前校验过）。没发过的取消；已是 sending 的可能发出去过，记 unknown
      console.error(`${port.tag} ⚠️ 恢复时一段出站的 payload 不合格（${bad}），不补发`);
      if (action.alreadySending) {
        recoverAsUnknown(intent);
        sum.unknown += 1;
      } else {
        cancelIntents([intent], 'restore');
        sum.cancelled += 1;
      }
      continue;
    }
    // 人工回复：判定时有资格，等 token、markSending 期间会话可能被交还或改派、10 分钟也可能过了——真正发请求之前再复核（开放问题 6）
    const human = r.kind === 'human' && !action.alreadySending;
    await port.resend(intent, action.alreadySending, human ? () => humanStillEligible(r) : undefined);
    sum.resent += 1;
  }
  console.log(
    `${port.tag} 启动恢复（出站）：${rows.length} 段没结果——补发 ${sum.resent}、取消 ${sum.cancelled}、记 unknown ${sum.unknown}、` +
      `留给入站恢复 ${sum.inbound}${sum.left ? `、停机没补发 ${sum.left}` : ''}`,
  );
  return sum;
}

// ---------------- 入站恢复要的库里的事实 ----------------

/**
 * 入站恢复（保底）要的：这几条没结束的入站名下有出站行的（任何状态）。与拉取位置、没结束的行在同一个短事务里读
 * （src/channels/inbox.ts 的 loadForRecovery）
 */
export interface InboundRecoveryCtx {
  withOutbound: ReadonlySet<string>;
}

// ---------------- 自测出口 ----------------

/** 仅供自测（spec：RESEND_UNKNOWN 经适配器的 __channelTest 在子进程里设；不在产品代码里留按环境变量触发的钩子） */
export const __channelTest = {
  setResendUnknown(v: boolean): void {
    resendUnknown = v;
  },
  /** 缩短 push 等恢复的上限（null 换回 30 秒） */
  setPushWaitMs(ms: number | null): void {
    pushWaitMs = ms ?? PUSH_WAIT_MS;
  },
};
