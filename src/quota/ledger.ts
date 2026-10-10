// 企微发送账本（docs/architecture/02-conversations-workbench/spec.md「企微：发送账本、回执与去重」、R7、R18、不变量 33、34）。
// 每次 send_msg 的每个分段带一个我们生成的 msgid（≤32 字节，同一分段重试沿用），在这里恰有一行：
//   accepted 接口回了成功；rejected 接口明确报错；unknown 超时或网络异常、结果不明（计入额度）；failed 之后收到 msg_send_fail。
//   还在发的记 pending（只在内存里）：结果出来之前也算进已用条数（可能已经送达，只会少发）；取 access_token 失败、send_msg
//   一次都没发出去的那一段不记。send_msg_on_event（新客户的欢迎语）不进账本、不计条数（R18 与不变量 33 说的是 send_msg）。
//   某次尝试超时或网络异常时这一行立刻记 unknown、排进落库，不等重试跑完；之后的重试成功再升成 accepted（只有这一种升级）。
// 账本在内存里，读（sendWindow 等）不查库（不变量 9）。db 存储下：预载读出每个会话最后一条客户消息之后的发送；真实会话的账本行
// 经 queueTelemetry 随会话的下一次落库写（存档点之内）；还没有会话的（老客户补发的欢迎语）单独一个短事务；msg_send_fail 的状态
// 更新单独一个短事务。demo 类与文件存储下只在内存。
// 窗口按 R18 的保守口径算：客户最后一条消息起 48 小时，至多 5 次 send_msg。起点取这条消息的 min(sentAt, at)（企微 send_time 与
// 本机收到它的时刻），账本行记本机时刻、按最后一次尝试的时刻计数：两个钟不一致、重试晚于客户新消息时都只会多算。
// 开放问题 8 实测之后只改这里的常量与适配器。
//
// 03「先落库、后发送」（docs/architecture/03-channels-v2/spec.md「出站：投递状态」、R4、R6、R21，不变量 4、6、7、10）：
// 库里的企微账号走 planOutbound → commitOutbound → 每段 markSending → send_msg → settleIntent（或 cancelIntents）。
//   planOutbound 一组分段切好之后同步调：校验会撞约束的东西（不过就抛 OutboundPlanError，什么都不排），每段一行 pending（带 payload）
//     排进这个会话的下一次落库的主事务；没有会话的单独一个短事务。recordSend / holdSend 那套是 env 账号的（02 原样）。
//   内存里的状态按账号种类分（每行记着 v2）：库里账号的行用 03 的七种，库与内存相同，内存的每次改动都过同一张迁移表
//     （src/channels/transitions.ts）；env 账号与 02 留下的行照 02 不改名（内存里的 pending 是「结果还没出来」，写库映射成 unknown，
//     quota.selftest.ts 的断言因此不用改）。计数与工作台显示按 spec 的映射表：pending、sending、accepted、unknown 计入已用条数；
//     工作台见 deliveryOfSegments（src/shared/conversation-types.ts）。
//   结果（accepted、rejected、unknown、attempts、errcode，payload 置空）随会话的下一次落库写进存档点；cancelled 写进主事务；
//     sending、迁回 pending、没有会话可挂的、运行时才补的段各是一个短事务。
//   R6：pending 等不到提交（至多 5 秒）、markSending 库不可用时调用方照发，每次「没落库就发」经 noteUnsafeSend 计数、告警（channel）
//   入站（03 第 9 步，spec「入站：channel_inbox」、R3、R21）：planOutbound 的 inboxId 不为空时，同一次落库（pending 排进的那一次）
//     把入站行改 replied；入站行记 abandoned 时 cancelInboxIntents 取消它名下没发的段；库里账号的回执经 onSendFailInbox，
//     出站行的 failed 与回执入站行的 done 同一个短事务
import { randomBytes } from 'node:crypto';
import { accountForSession, type ChannelAccount } from '../channels/accounts.js';
import { canMoveOutbound } from '../channels/transitions.js';
import type { OutboundStatus } from '../shared/channel-types.js';
import {
  deliveryOfSegments,
  type DeliveryView,
  type OutboundKind,
  QUOTA_EXHAUSTED_TEXT,
  type SendWindow,
  sendFailText,
  WINDOW_CLOSED_TEXT,
} from '../shared/conversation-types.js';
import { cleanText } from '../shared/text.js';
import {
  emitAfterCommit,
  flushSession,
  getSession,
  isDemoClassId,
  markOutboundFailedInDb,
  markOutboundSendingInDb,
  onOutboundCommitted,
  onSessionSaved,
  queueInboxState,
  queueOutboundRows,
  queueTelemetry,
  saveSession,
  seqOf,
  sessionStoreMode,
  takePreloadedOutbound,
  unmarkOutboundInDb,
  writeInboxStateNow,
  writeOutboundNow,
  writeStandaloneOutbound,
  type MarkSendingResult,
  type OutboundRow,
} from '../store.js';
import type { ChatMessage } from '../types.js';

/** 窗口长度：客户最后一条消息起 48 小时 */
export const WINDOW_MS = 48 * 3_600_000;
/** 窗口里至多几次 send_msg */
export const WINDOW_SENDS = 5;
/** 跟进要求窗口剩余至少几条、至少多久（R18） */
export const FOLLOWUP_MIN_REMAINING = 2;
export const FOLLOWUP_MIN_LEFT_MS = 2 * 3_600_000;
/** 内存里留多久的发送：回执与重放对齐要找得到；更早的在这个会话下一次记账时摘掉 */
const KEEP_MS = 7 * 86_400_000;
/**
 * 对应消息还没分到 seq 的账本行最多等多久（从这条消息最后一个分段有结果时起算，还有分段在发时不计时）。调用方在推送返回之后的
 * 同一段同步代码里把消息写进会话，所以正常时一拍就够；等过了还没有，就是没写进会话（没送达、结果不明的跟进），message_seq 记 NULL
 */
const SEQ_WAIT_MS = 2_000;
/** msg_send_fail 改库的短事务失败之后，隔多久再试一次（只试一次） */
const RECEIPT_RETRY_MS = 1_000;
/**
 * 03 库里账号的回执（带入站行）：短事务没写成时隔多久再试。它可能要等另一个事务里还没提交的出站行（唯一键上的插入），
 * 一次至多等到语句超时（5 秒），所以多试几次；都没写成时入站行停在 received，重启时由启动恢复重做
 */
const RECEIPT_INBOX_RETRY_MS = [1_000, 5_000, 30_000];
/**
 * 03 R6：发送前等这一组 pending 提交至多多久（与 02 不变量 20 同一口径，从 planOutbound 那一刻算起）；markSending 的短事务至多等多久，
 * 等不到判 db_unavailable。自测经 __ledgerTest.setWaits 缩短
 */
const waits = { commitMs: 5_000, markMs: 5_000 };
/** 03：一段 payload 序列化之后的上限（spec planOutbound 的校验） */
const PAYLOAD_MAX_BYTES = 16 * 1024;
/** 03：一组至多几段（outbound_sends.segment 是 smallint，运行时补的段接在后面，留出余量） */
const SEGMENT_MAX = 32_000;
/** 03：「没落库就发」的告警窗口 */
const UNSAFE_WINDOW_MS = 10 * 60_000;

export type SendResult = 'accepted' | 'rejected' | 'unknown';
/** 内存里一行的状态：库里账号的行是 03 的七种；env 账号的行只有 pending（还在发）与四种结果 */
type Status = OutboundStatus;

/** 03：一段要发的内容（spec 原样；link 的缩略图 media_id 发送时现取，不进 payload） */
export type OutboundPayload =
  | { msgtype: 'text'; text: { content: string } }
  | { msgtype: 'link'; link: { title: string; desc: string; url: string } }
  | { msgtype: 'msgmenu'; msgmenu: { head_content: string; list: unknown[] } };

/** 03：一组分段里的一段（planOutbound 的返回）。重试与重启后的补发都用这一个 msgid */
export interface OutboundIntent {
  readonly msgid: string;
  readonly accountId: string;
  /** 会话 id；老客户欢迎语还没有会话时是将要用的那个 id（前缀 + external_userid，02 的写法），所以 outbound_sends.conversation_id 照旧非空 */
  readonly sessionId: string;
  readonly hasSession: boolean;
  /** 回的是哪条入站（客户消息的回复、非文本的引导提示）；人工回复、跟进、通知、同意菜单、欢迎语、异常道歉为 null */
  readonly inboxId: string | null;
  readonly kind: OutboundKind;
  /** 这一组里的第几段，从 0 起；运行时才补的段接在这一组最大段号之后 */
  readonly segment: number;
  readonly message: ChatMessage | null;
  readonly payload: OutboundPayload;
}

/** planOutbound 的同步校验没过：什么都没排，调用方按这一组发送失败处理（会话加说明、告警），不进事务。reason 里不带正文 */
export class OutboundPlanError extends Error {
  override readonly name = 'OutboundPlanError';
  constructor(readonly reason: string) {
    super(`出站分段没排进发送：${reason}`);
  }
}

/** cancelIntents 的原因（只进日志）。aborted：调用方在发送之前放弃了这一组（跟进的记账没提交上、任务已不在本次认领手里等） */
export type CancelReason = 'taken_over' | 'inbox_abandoned' | 'restore' | 'export' | 'aborted';

interface Row {
  sessionId: string;
  msgid: string;
  kind: OutboundKind;
  /** 本进程记的：对应的会话消息对象（送达之后才写进会话的，写进去时是同一个对象） */
  message: ChatMessage | null;
  /** 预载来的：库里的 message_seq */
  seq: number | null;
  /** 记账（第一次尝试；03 的行是 planOutbound）的时刻 */
  sentAt: number;
  /** 最后一次尝试的时刻：窗口按它计数，落库的 sent_at 也写它（重试晚于客户新消息时算进新窗口，只会多算） */
  lastAttemptAt: number;
  status: Status;
  errcode: number | null;
  failType: number | null;
  /** 这一段还在发（recordSend 到 settle / discard 之间；03 的行是 planOutbound 到结果或取消之间）；预占的行也是 */
  inFlight: boolean;
  /** 预占（holdSend）的行，推送的第一个分段还没接过去 */
  held: boolean;
  /** 最近一次排进落库（或单独写）的那一行：回执来得早、还没写进库时直接改它 */
  dbRow: OutboundRow | null;
  /** 已在库里：预载来的，或本进程已排进落库。回执按 msgid 改库只对这种行做 */
  inDb: boolean;
  /** 03：库里企微账号的行（状态是 03 的七种，库与内存相同）；false 是 env 账号与 02 留下的行 */
  v2: boolean;
  accountId: string | null;
  inboxId: string | null;
  segment: number;
  payload: OutboundPayload | null;
  /** 发过几次请求（03 落库的 attempts） */
  attempts: number;
  /** 03：这一行的 pending 落库了没有：committed 已提交；failed 短事务没写成；null 还在等（或不用等：只在内存里的会话） */
  commit: 'committed' | 'failed' | null;
  /** 等这一行 pending 提交的 */
  commitWaiters: (() => void)[];
  /**
   * 03：按定死的 msgid 新建的运行时补段（卡片发失败的补文），内存里原来没有这一行：库里可能早有同一 msgid 的行（已有结果、没预载进来），
   * markSending 回 not_pending 时从账本摘掉，不留一行假的「发送中」
   */
  probe: boolean;
}

const bySession = new Map<string, Row[]>();
const byMsgid = new Map<string, Row>();
/** 预占的行，按要发的那条消息认 */
const holds = new Map<ChatMessage, Row>();
/** 等对应消息分到 seq 的账本行，按消息对象：分到之后同一条消息的这几行一起排进落库 */
const awaitingSeq = new Map<ChatMessage, { rows: Set<Row>; timer: NodeJS.Timeout | null }>();
/** 03：pending 那一行的写入对象 → 账本行（主事务提交的回调据它认出是哪一行） */
const pendingWrites = new WeakMap<OutboundRow, Row>();

/** 已用条数算哪几种：送达的、结果不明的，以及还在发的（可能已经送达）；03 的 pending、sending 也算（R18 的保守口径） */
const COUNTED: ReadonlySet<Status> = new Set<Status>(['accepted', 'unknown', 'pending', 'sending']);

function add(row: Row): void {
  const list = bySession.get(row.sessionId);
  if (list) list.push(row);
  else bySession.set(row.sessionId, [row]);
  byMsgid.set(row.msgid, row);
}

function remove(row: Row): void {
  byMsgid.delete(row.msgid);
  const list = bySession.get(row.sessionId);
  if (list)
    bySession.set(
      row.sessionId,
      list.filter((r) => r !== row),
    );
}

function newRow(sessionId: string, kind: OutboundKind, message: ChatMessage | null, now: number): Row {
  return {
    sessionId,
    msgid: randomBytes(16).toString('hex'),
    kind,
    message,
    seq: null,
    sentAt: now,
    lastAttemptAt: now,
    status: 'pending',
    errcode: null,
    failType: null,
    inFlight: true,
    held: false,
    dbRow: null,
    inDb: false,
    v2: false,
    accountId: null,
    inboxId: null,
    segment: 0,
    payload: null,
    attempts: 0,
    commit: null,
    commitWaiters: [],
    probe: false,
  };
}

/** 预载的行在第一次用到账本时搬进来（之后 takePreloadedOutbound 返回空的）。带账号 uuid 的是库里账号的行（03 的状态） */
function ensureLoaded(): void {
  const pre = takePreloadedOutbound();
  for (const [sessionId, rows] of pre) {
    for (const r of rows) {
      if (byMsgid.has(r.channelMsgid)) continue;
      const v2 = 'accountId' in r && typeof r.accountId === 'string';
      add({
        ...newRow(sessionId, r.kind, null, r.sentAt.getTime()),
        msgid: r.channelMsgid,
        seq: r.messageSeq,
        status: r.status,
        errcode: r.errcode,
        failType: r.failType,
        inFlight: false,
        inDb: true,
        v2,
        accountId: v2 ? (r.accountId ?? null) : null,
        commit: v2 ? 'committed' : null,
      });
    }
  }
}

/** 摘掉 7 天前的；还在发的（02 的 pending，03 的 pending、sending）不摘 */
function prune(sessionId: string, now: number): void {
  const list = bySession.get(sessionId);
  if (!list?.length || list[0]!.sentAt >= now - KEEP_MS) return;
  const kept = list.filter((r) => r.sentAt >= now - KEEP_MS || r.status === 'pending' || r.status === 'sending');
  for (const r of list) if (!kept.includes(r)) byMsgid.delete(r.msgid);
  bySession.set(sessionId, kept);
}

/** 这条账本行在库里的那一份：db 存储的真实会话才有，demo 类与文件存储只在内存 */
const writesToDb = (sessionId: string): boolean => sessionStoreMode() === 'db' && !isDemoClassId(sessionId);

/** 落库的形状。env 账号的行照 02：内存里的 pending（结果还没出来）写成 unknown，没有 03 的几列；库里账号的行原样 */
function writeShape(row: Row, status: Status = row.status): OutboundRow {
  const base = {
    conversationId: row.sessionId,
    channelMsgid: row.msgid,
    messageSeq: row.message ? (seqOf(row.message) ?? null) : row.seq,
    kind: row.kind,
    sentAt: new Date(row.lastAttemptAt),
    errcode: row.errcode,
    failType: row.failType,
  };
  if (!row.v2) return { ...base, status: status === 'pending' ? 'unknown' : status };
  return {
    ...base,
    status,
    accountId: row.accountId,
    inboxId: row.inboxId,
    segment: row.segment,
    attempts: row.attempts,
    payload: status === 'pending' || status === 'sending' ? row.payload : null,
  };
}

/**
 * 排进落库（结果）：会话在内存里就随它的下一次落库（queueTelemetry，存档点之内），没有会话（老客户补发的欢迎语）单独一个短事务
 */
function write(row: Row): void {
  const dbRow = writeShape(row);
  row.dbRow = dbRow;
  row.inDb = true;
  if (getSession(row.sessionId)) queueTelemetry(row.sessionId, { outbound: [dbRow] });
  else if (row.v2) void writeOutboundNow([dbRow]);
  else void writeStandaloneOutbound([dbRow]);
}

/**
 * 这一行有了结果（或状态变了）：写进库。同一行再排一次（unknown 升 accepted、最后一次尝试的时刻往后挪）由库里按 msgid upsert，
 * 仍是一行（不变量 33）。对应的消息还没分到 seq 的（送达之后才写进会话的引导提示、跟进）：等它分到 seq 再排（同一条消息的几个分段
 * 一起），见 awaitSeq
 */
function persist(row: Row): void {
  if (!writesToDb(row.sessionId)) return;
  if (row.message && seqOf(row.message) === undefined) awaitSeq(row);
  else write(row);
}

function awaitSeq(row: Row): void {
  const msg = row.message!;
  let w = awaitingSeq.get(msg);
  if (!w) awaitingSeq.set(msg, (w = { rows: new Set(), timer: null }));
  w.rows.add(row);
  armSeqTimer(msg);
}

/** 等 seq 的上限只在这条消息没有还在发的分段时走：分段之间要等网络，不能让前一段的上限先到 */
function armSeqTimer(msg: ChatMessage): void {
  const w = awaitingSeq.get(msg);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  const sid = [...w.rows][0]?.sessionId;
  if (sid !== undefined && (bySession.get(sid) ?? []).some((r) => r.message === msg && r.inFlight)) return;
  w.timer = setTimeout(() => releaseAwaiting(msg, true), SEQ_WAIT_MS);
  w.timer.unref();
}

function releaseAwaiting(msg: ChatMessage, timedOut: boolean): void {
  const w = awaitingSeq.get(msg);
  if (!w) return;
  awaitingSeq.delete(msg);
  if (w.timer) clearTimeout(w.timer);
  if (timedOut && seqOf(msg) === undefined) {
    console.warn(`[quota] ${w.rows.size} 行发送账本等不到对应消息写进会话（没送达或结果不明），message_seq 记 NULL`);
  }
  for (const r of w.rows) write(r);
}

// 消息写进会话、分到 seq 的那一刻（saveSession 同步分配 seq 之后，db 存储下才有这个钩子）：等着它的账本行在下一个宏任务一起排进落库。
// 不在 saveSession 里面排：同一段同步代码里还要记这一轮的 trace，分开排，trace 那几行写不进去（存档点回滚）时不连带丢账本行
onSessionSaved(() => {
  if (!awaitingSeq.size) return;
  for (const msg of awaitingSeq.keys()) if (seqOf(msg) !== undefined) setImmediate(() => releaseAwaiting(msg, false));
});

/**
 * 一个分段最后的结果（settle 收到的那一个，只报一次）：02 spec 的 wecom_send 告警挂在这里（rejected 或 unknown 算最终发送失败）。
 * 只交结果、错误码与 kind，不交会话与正文
 */
export interface SendSettled {
  account: string;
  result: SendResult;
  errcode: number | null;
  kind: OutboundKind;
}
const settledListeners = new Set<(s: SendSettled) => void>();
export function onSendSettled(cb: (s: SendSettled) => void): () => void {
  settledListeners.add(cb);
  return () => settledListeners.delete(cb);
}
function notifySettled(s: SendSettled): void {
  for (const cb of settledListeners) {
    try {
      cb(s);
    } catch {
      /* 订阅者出错不影响记账 */
    }
  }
}

/** 一个分段的记账口子：sendText / sendRich / 欢迎语 / 菜单的每个分段调一次 recordSend，发完调一次 settle（或 discard） */
export interface SendHandle {
  /** 随 send_msg 下发的 msgid：32 个十六进制字符；同一分段的重试沿用它 */
  readonly msgid: string;
  /** 每次尝试发出之前调（第一次也调）：记下这次尝试的时刻，窗口按最后一次尝试计数 */
  attempt(): void;
  /** 某次尝试超时或网络异常：这一行立刻记 unknown 并排进落库，不等重试跑完（之后的重试成功再升 accepted） */
  unknown(): void;
  /** 这一段最后的结果，只认第一次。只有 unknown 能升成 accepted；之前已收到回执（failed）的不改 */
  settle(result: SendResult, errcode?: number): void;
  /** send_msg 一次都没发出去（取 access_token 失败）：这一段不记 */
  discard(): void;
}

/**
 * sendText 每个分段调一次：生成 msgid（重试沿用），settle 记 accepted / rejected / unknown。message 写库时经 seqOf 换成 seq。
 * 结果出来之前这一行是 pending，算进已用条数。这条消息有预占（holdSend）的行时，第一个分段接过那一行（沿用它的 msgid）。
 * env 账号（02 的老路）用；库里的企微账号走 planOutbound
 */
export function recordSend(sessionId: string, kind: OutboundKind, message: ChatMessage | null): SendHandle {
  ensureLoaded();
  const now = Date.now();
  prune(sessionId, now);
  let row = message ? holds.get(message) : undefined;
  if (row && row.sessionId === sessionId && message) {
    holds.delete(message);
    remove(row); // 挪到这个会话的末尾：账本按记账顺序
    Object.assign(row, { kind, held: false, sentAt: now, lastAttemptAt: now });
  } else row = newRow(sessionId, kind, message, now);
  add(row);
  if (message) armSeqTimer(message); // 这条消息又有分段在发：等 seq 的上限先停
  const r = row;
  let done = false;
  const finish = (): void => {
    done = true;
    r.inFlight = false;
  };
  return {
    msgid: r.msgid,
    attempt() {
      if (!done) r.lastAttemptAt = Date.now();
    },
    unknown() {
      if (done || r.status !== 'pending') return;
      r.status = 'unknown';
      persist(r);
    },
    settle(result, errcode) {
      if (done) return;
      finish();
      if (r.status === 'pending') {
        r.status = result;
        r.errcode = errcode ?? null;
      } else if (r.status === 'unknown' && result === 'accepted') {
        r.status = 'accepted';
        r.errcode = null;
      } else if (r.status === 'unknown' && result === 'unknown') r.errcode = errcode ?? null;
      persist(r);
      notifySettled({ result, errcode: errcode ?? null, kind, account: accountForSession(sessionId)?.key ?? 'env' });
    },
    discard() {
      if (done) return;
      finish();
      remove(r);
      if (r.message) armSeqTimer(r.message);
    },
  };
}

/**
 * 人工回复与跟进的「检查 + 占一个名额」（不变量 34）：检查通过之后在同一段同步代码里调，记一行预占（pending，算进已用条数），
 * 并发的另一条检查就看得到它。推送的第一个分段（同一个 message）接过这一行、沿用它的 msgid（02 的 recordSend 与 03 的 planOutbound
 * 都接）。返回撤销：推送结束之后调，没被接过去（一段都没开始发）就删掉这一行
 */
export function holdSend(sessionId: string, kind: OutboundKind, message: ChatMessage): () => void {
  ensureLoaded();
  const row = newRow(sessionId, kind, message, Date.now());
  row.held = true;
  add(row);
  holds.set(message, row);
  return () => {
    if (holds.get(message) !== row) return;
    holds.delete(message);
    remove(row);
  };
}

// ======================================================================================
// 03 先落库、后发送（库里的企微账号）
// ======================================================================================

/** 发送账本里认得的种类：kind 是组的种类，card 只出现在 env 账号与 02 的旧行上（spec「出站行的 kind」） */
const PLAN_KINDS: ReadonlySet<OutboundKind> = new Set<OutboundKind>(['ai', 'human', 'followup', 'notice', 'menu', 'welcome']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSGID_RE = /^[0-9a-f]{32}$/;

/** 一段字符串是不是已经过了 cleanText（不含 NUL、没有孤立代理）且非空 */
const cleanNonEmpty = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && cleanText(v) === v;

/** 一段 payload 的问题（没有为 null）：形状、字符串已清洗、序列化之后 ≤16 KB。启动恢复补发库里读出的 payload 之前也查它 */
export function payloadProblem(p: OutboundPayload): string | null {
  if (!p || typeof p !== 'object') return 'payload 不是对象';
  if (p.msgtype === 'text') {
    if (!cleanNonEmpty(p.text?.content)) return 'text.content 为空或没清洗';
  } else if (p.msgtype === 'link') {
    if (!cleanNonEmpty(p.link?.title) || !cleanNonEmpty(p.link?.url)) return 'link 的标题或地址为空或没清洗';
    if (typeof p.link.desc !== 'string' || cleanText(p.link.desc) !== p.link.desc) return 'link.desc 没清洗';
  } else if (p.msgtype === 'msgmenu') {
    if (!cleanNonEmpty(p.msgmenu?.head_content) || !Array.isArray(p.msgmenu.list)) return 'msgmenu 的问句为空或按钮不是数组';
  } else return `不认识的 msgtype（${String((p as { msgtype?: unknown }).msgtype)}）`;
  let json: string;
  try {
    json = JSON.stringify(p);
  } catch {
    return 'payload 序列化不了';
  }
  if (Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES) return `一段超过 ${PAYLOAD_MAX_BYTES / 1024} KB`;
  return null;
}

/** planOutbound 的同步校验：会撞库里约束（kind、payload CHECK、账号外键、json）或写进去就错的，在排进落库之前拦下 */
function planProblem(
  account: ChannelAccount,
  target: { sessionId: string; hasSession: boolean },
  kind: OutboundKind,
  inboxId: string | null,
  payloads: readonly OutboundPayload[],
): string | null {
  if (!PLAN_KINDS.has(kind)) return `kind ${kind} 不是一组的种类`;
  if (account.kind !== 'wecom_kf' || account.source !== 'db' || !UUID_RE.test(account.id)) return '不是库里的企微账号';
  const prefix = account.wecom?.idPrefix;
  if (!prefix || !target.sessionId.startsWith(prefix)) return '会话 id 不是这个账号的前缀';
  const owner = accountForSession(target.sessionId, getSession(target.sessionId));
  if (owner?.id !== account.id) return '会话不属于这个账号';
  if (inboxId !== null && !UUID_RE.test(inboxId)) return 'inboxId 不是 uuid';
  // 回复一条入站的组：replied 随 pending 排进这个会话的同一次落库，所以会话必须在内存里（入站的客户消息已经写进了它）
  if (inboxId !== null && !(target.hasSession && getSession(target.sessionId))) return '回复入站的一组没有会话可挂';
  // outbound_sends.segment 是 smallint（运行时补的段还要再加 1）
  if (payloads.length > SEGMENT_MAX) return `一组超过 ${SEGMENT_MAX} 段`;
  for (const p of payloads) {
    const bad = payloadProblem(p);
    if (bad) return bad;
  }
  return null;
}

const planRejectedListeners = new Set<(reason: string) => void>();
/** planOutbound 的校验没过（告警 channel 订阅，只有原因、不带会话与正文） */
export function onPlanRejected(cb: (reason: string) => void): () => void {
  planRejectedListeners.add(cb);
  return () => planRejectedListeners.delete(cb);
}
function planRejected(reason: string): OutboundPlanError {
  for (const cb of planRejectedListeners) {
    try {
      cb(reason);
    } catch {
      /* 订阅者出错不影响调用方 */
    }
  }
  return new OutboundPlanError(reason);
}

const intentOf = (r: Row): OutboundIntent => ({
  msgid: r.msgid,
  accountId: r.accountId!,
  sessionId: r.sessionId,
  hasSession: getSession(r.sessionId) !== undefined,
  inboxId: r.inboxId,
  kind: r.kind,
  segment: r.segment,
  message: r.message,
  payload: r.payload!,
});

/** pending 那一行提交了（随会话或短事务）或短事务没写成：叫醒在等的 commitOutbound */
function pendingSettled(row: Row, ok: boolean): void {
  if (row.commit === 'committed') return;
  row.commit = ok ? 'committed' : 'failed';
  const ws = row.commitWaiters;
  row.commitWaiters = [];
  for (const w of ws) w();
}
onOutboundCommitted((rows) => {
  for (const w of rows) {
    const r = pendingWrites.get(w);
    if (r) pendingSettled(r, true);
  }
});

/** 每段的 pending：会话在内存里就排进它的下一次落库（主事务），没有会话的单独一个短事务 */
function writePending(rows: readonly Row[], hasSession: boolean): void {
  if (!rows.length) return;
  const sessionId = rows[0]!.sessionId;
  if (!writesToDb(sessionId)) {
    for (const r of rows) r.commit = 'committed'; // 只在内存里的会话（demo 类）：没有库可等
    return;
  }
  const writes = rows.map((r) => {
    const w = writeShape(r, 'pending');
    pendingWrites.set(w, r);
    r.dbRow = w;
    r.inDb = true;
    return w;
  });
  if (hasSession && queueOutboundRows(sessionId, writes)) return;
  void writeOutboundNow(writes).then((ok) => {
    for (const r of rows) pendingSettled(r, ok);
  });
}

/**
 * 一组分段切好之后同步调：校验（kind、账号存在且与会话一致、inboxId、每段 payload 的形状、已过 cleanText、序列化后 ≤16 KB），
 * 不过就抛 OutboundPlanError、什么都不排（调用方按这一组发送失败处理）；过了就生成 msgid、记进内存账本（pending，计入已用条数）、
 * 排进这个会话的落库（主事务；没有会话的单独一个短事务）。02 的 holdSend 预占的那一行由第一段接过来（同一 msgid）。
 * inboxId 不为空时同一次落库把入站行改成 replied（不变量 3：回复的出站 pending 写进库的那次提交，入站行同时是 replied）
 */
export function planOutbound(
  account: ChannelAccount,
  target: { sessionId: string; hasSession: boolean },
  kind: OutboundKind,
  message: ChatMessage | null,
  inboxId: string | null,
  payloads: readonly OutboundPayload[],
): OutboundIntent[] {
  ensureLoaded();
  const problem = planProblem(account, target, kind, inboxId, payloads);
  if (problem) throw planRejected(problem);
  if (!payloads.length) return [];
  const sessionId = target.sessionId;
  const now = Date.now();
  prune(sessionId, now);
  const held = message ? holds.get(message) : undefined;
  const rows: Row[] = [];
  payloads.forEach((payload, segment) => {
    let row: Row;
    if (segment === 0 && held && held.sessionId === sessionId && MSGID_RE.test(held.msgid)) {
      holds.delete(message!);
      remove(held); // 挪到这个会话的末尾：账本按记账顺序
      Object.assign(held, { kind, held: false, sentAt: now, lastAttemptAt: now });
      row = held;
    } else row = newRow(sessionId, kind, message, now);
    Object.assign(row, {
      v2: true,
      status: 'pending',
      inFlight: true,
      accountId: account.id,
      inboxId,
      segment,
      payload,
      attempts: 0,
      commit: null,
      commitWaiters: [],
    });
    add(row);
    rows.push(row);
  });
  if (message) armSeqTimer(message);
  writePending(rows, target.hasSession && getSession(sessionId) !== undefined);
  // 与上面的 pending 同一段同步代码排进同一个会话：同一次落库、同一个主事务（排在 pending 之后，按排进来的先后逐条写）
  if (inboxId !== null && writesToDb(sessionId)) queueInboxState(sessionId, { inboxId, state: 'replied' });
  const intents = rows.map(intentOf);
  planHook?.(intents);
  return intents;
}

/**
 * 运行时才补的段（卡片发失败之后补的「标题 + 链接」文字）：段号取这一组最大段号加 1，同一组的种类、消息、入站与账号，
 * 单独一个短事务写成 pending（至多等 5 秒）之后再走 markSending 与发送。返回这一段与它的 pending 落没落库（timeout 时照 R6 处理）。
 * 校验同 planOutbound，不过就抛 OutboundPlanError。
 * msgid：调用方按卡片段定死的 msgid（启动恢复再补同一张卡片时是同一行）。账本里已有这一行：还没结果的复用它（不另建一行），已有结果的
 * 返回 null（这一块补文已经发过或不会再发，不用再发）；账本里没有：按它新建，pending 插入遇到库里已有的行什么都不改（迁移表），
 * 之后 markSending 回 not_pending 就不发
 */
export async function planRuntimeSegment(
  group: readonly OutboundIntent[],
  payload: OutboundPayload,
  msgid?: string,
): Promise<{ intent: OutboundIntent; commit: 'committed' | 'timeout' } | null> {
  const first = group[0];
  const base = first ? byMsgid.get(first.msgid) : undefined;
  if (!first || !base?.v2) throw planRejected('运行时补的段找不到它那一组');
  if (group.length >= 32_767) throw planRejected('一组的段号用完了');
  const bad = payloadProblem(payload);
  if (bad) throw planRejected(bad);
  if (msgid !== undefined && !MSGID_RE.test(msgid)) throw planRejected('运行时补的段 msgid 不对');
  const known = msgid === undefined ? undefined : byMsgid.get(msgid);
  if (known?.v2) {
    if (known.status !== 'pending' && known.status !== 'sending') return null;
    known.payload ??= payload;
    return { intent: intentOf(known), commit: known.commit === 'committed' ? 'committed' : 'timeout' };
  }
  const now = Date.now();
  const row = newRow(first.sessionId, first.kind, first.message, now);
  Object.assign(row, {
    ...(msgid === undefined ? {} : { msgid, probe: true }),
    v2: true,
    accountId: first.accountId,
    inboxId: first.inboxId,
    segment: Math.max(...group.map((i) => i.segment)) + 1,
    payload,
  });
  add(row);
  if (row.message) armSeqTimer(row.message);
  if (!writesToDb(row.sessionId)) {
    row.commit = 'committed';
    return { intent: intentOf(row), commit: 'committed' };
  }
  const w = writeShape(row, 'pending');
  pendingWrites.set(w, row);
  row.dbRow = w;
  row.inDb = true;
  const ok = await raceTimeout(writeOutboundNow([w]), waits.commitMs, false);
  pendingSettled(row, ok);
  return { intent: intentOf(row), commit: ok ? 'committed' : 'timeout' };
}

function raceTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), Math.max(0, ms));
    void p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/**
 * 等这一组的 pending 提交（有会话的随 flushSession 那一次落库，没有会话的短事务）：至多 5 秒，从 planOutbound 那一刻算起
 * （人工回复、跟进等调用方自己已经等过一次提交，不再叠一个 5 秒）。等到了返回 committed；超时、短事务没写成返回 timeout，
 * 调用方照发（R6）并计数。只在内存里的会话（demo 类）恒为 committed
 */
export async function commitOutbound(intents: readonly OutboundIntent[]): Promise<'committed' | 'timeout'> {
  const rows = intents.map((i) => byMsgid.get(i.msgid)).filter((r): r is Row => r !== undefined && r.v2);
  const waiting = rows.filter((r) => r.commit === null);
  if (waiting.length) {
    const deadline = Math.min(...rows.map((r) => r.sentAt)) + waits.commitMs;
    await new Promise<void>((resolve) => {
      let left = waiting.length;
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      for (const r of waiting) {
        r.commitWaiters.push(() => {
          left -= 1;
          if (left === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    });
  }
  return rows.every((r) => r.commit === 'committed') ? 'committed' : 'timeout';
}

let markHook: ((intent: OutboundIntent) => void | Promise<void>) | null = null;
let planHook: ((intents: readonly OutboundIntent[]) => void) | null = null;

/**
 * 每段发之前单独一个短事务迁到 sending（UPDATE … WHERE status = 'pending'，命中 0 行时同一事务再看这一行在不在），至多等 5 秒。
 * marked：可以发。not_pending：行在、已经不是 pending（被取消、已有结果）——不发。absent：库里没有这一行——这一组的
 * commitOutbound 返回过 timeout（R6，pending 还没落库）就照发并计数，返回过 committed（行提交过又没了，只会是被清除）就不发、记一行错误。
 * db_unavailable：库不可用（或等满 5 秒），照发（R6）并计数。只在内存里的会话（demo 类）只改内存
 */
export async function markSending(intent: OutboundIntent): Promise<MarkSendingResult> {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2) return 'absent';
  if (markHook) await markHook(intent);
  if (!writesToDb(row.sessionId)) {
    if (!canMoveOutbound(row.status, 'sending', ['mark'])) return 'not_pending';
    row.status = 'sending';
    return 'marked';
  }
  const r = await markOutboundSendingInDb(intent.msgid, waits.markMs);
  if (r === 'marked' && canMoveOutbound(row.status, 'sending', ['mark'])) row.status = 'sending';
  // 按定死的 msgid 新建的补段，库里早有同一 msgid 的行、已有结果：这一块补文已经发过（或不会再发），从账本摘掉，以库里的为准
  if (r === 'not_pending' && row.probe && row.status === 'pending') {
    finishRow(row);
    remove(row);
  }
  return r;
}

/**
 * 本进程标了 sending、提交回来之后发现已过停机截止、还没发请求：单独一个短事务迁回 pending（迁移表的 unmark）。写成了 true；
 * 写不成时这一段留在 sending、重启后按出站恢复记 unknown（没发过，工作台显示「可能没送达」）
 */
export async function unmarkSending(intent: OutboundIntent): Promise<boolean> {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2) return false;
  const ok = writesToDb(row.sessionId) ? await unmarkOutboundInDb(intent.msgid) : true;
  if (ok && canMoveOutbound(row.status, 'pending', ['unmark'])) row.status = 'pending';
  if (!ok) console.error('[quota] 停机截止之后标了 sending 的一段迁回 pending 没写成：它留在 sending，重启后记 unknown（没发过）');
  return ok;
}

/** 不会再发的状态：同一进程里的重试遇到它就停（不变量 5：accepted、rejected、failed、cancelled 永不再发） */
const NO_MORE_SENDS: ReadonlySet<Status> = new Set<Status>(['accepted', 'rejected', 'failed', 'cancelled']);

/**
 * 这一段还能不能再发一次请求（同一进程里的重试、强刷 token 之后的再次请求之前同步调）：内存账本里已是终态（退避期间收到
 * msg_send_fail 记了 failed、被取消等）就不能。unknown、sending、pending 可以（unknown 只在同一进程里那一段的重试中再发）
 */
export function maySendAgain(intent: OutboundIntent): boolean {
  const row = byMsgid.get(intent.msgid);
  return !!row && !NO_MORE_SENDS.has(row.status);
}

/** 一次尝试发出之前调（第一次也调）：记下这次尝试的时刻（窗口按最后一次尝试计数）与次数 */
export function noteAttempt(intent: OutboundIntent): void {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2) return;
  row.lastAttemptAt = Date.now();
  row.attempts += 1;
}

/** 写一行结果（存档点，或没有会话时的短事务）：对应消息还没分到 seq 的等它分到再写（02 同一个做法） */
function persistResult(row: Row): void {
  persist(row);
}

/**
 * 某次尝试超时或网络异常（请求可能已经到了企微）：这一行立刻记 unknown 并排进落库，不等重试跑完（02 的规则；之后的重试成功
 * 由 settleIntent 升 accepted）
 */
export function noteUnknown(intent: OutboundIntent, errcode?: number): void {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2 || !canMoveOutbound(row.status, 'unknown', ['settle'])) return;
  row.status = 'unknown';
  row.errcode = errcode ?? null;
  persistResult(row);
}

function finishRow(row: Row): void {
  row.inFlight = false;
  row.commitWaiters = [];
  if (row.message) armSeqTimer(row.message);
}

/**
 * 结果：accepted / rejected / unknown，带 errcode 与尝试次数；随会话的下一次落库写进存档点，没有会话的单独短事务。
 * 只按迁移表改：已收到回执（failed）、已取消的不改（库里同样不改）。wecom_send 告警照 02 挂在这里
 */
export function settleIntent(intent: OutboundIntent, result: SendResult, detail: { errcode?: number; attempts: number }): void {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2) return;
  row.attempts = Math.max(row.attempts, detail.attempts);
  const moved = canMoveOutbound(row.status, result, ['settle']);
  if (moved) {
    row.status = result;
    row.errcode = result === 'accepted' ? null : (detail.errcode ?? null);
  }
  finishRow(row);
  if (moved) persistResult(row);
  // 一次请求都没发出去的（取 token 失败、卡片的缩略图拿不到）不进 wecom_send 的计数：那是 send_msg 的失败告警
  if (detail.attempts > 0)
    notifySettled({ result, errcode: detail.errcode ?? null, kind: row.kind, account: accountForSession(row.sessionId)?.key ?? 'env' });
}

/**
 * 不会再发：会话已有人接手，或所属入站行记了 abandoned（毒消息、过期、恢复截止），或恢复与导出时按规则取消，或调用方在发送之前
 * 放弃（aborted）。原因只进日志。cancelled 写进主事务（随会话的下一次落库；没有会话的单独短事务），pending、sending 才改。
 * 停机截止不取消：没发的段留在 pending，重启后按出站恢复表处理
 */
export function cancelIntents(intents: readonly OutboundIntent[], reason: CancelReason): void {
  let n = 0;
  for (const i of intents) {
    const row = byMsgid.get(i.msgid);
    if (!row?.v2 || !canMoveOutbound(row.status, 'cancelled', ['cancel'])) continue;
    row.status = 'cancelled';
    finishRow(row);
    n += 1;
    if (!writesToDb(row.sessionId)) continue;
    const w = writeShape(row, 'cancelled');
    row.dbRow = w;
    if (!(getSession(row.sessionId) && queueOutboundRows(row.sessionId, [w]))) void writeOutboundNow([w]);
  }
  if (n) console.log(`[quota] 取消 ${n} 段出站（${reason}），不会再发`);
}

/**
 * 入站行记了 abandoned（毒消息、过期、恢复截止）：它名下本进程排过、还没结果的段一律取消（spec「出站」cancelIntents 的
 * inbox_abandoned）。cancelled 与 abandoned 排进同一个会话、同一段同步代码时就是同一次落库
 */
export function cancelInboxIntents(inboxId: string): void {
  const rows = [...byMsgid.values()].filter((r) => r.v2 && r.inboxId === inboxId && (r.status === 'pending' || r.status === 'sending'));
  if (rows.length) cancelIntents(rows.map(intentOf), 'inbox_abandoned');
}

// ---------------- 03 启动恢复（src/channels/recovery.ts） ----------------

/**
 * 库里没结果的一行出站（pending、sending），带 02 预载不读的几列：src/db/repo/outbound.ts 的 OpenOutboundRow 的形状
 * （src/quota/ 不 import src/db/，这里按结构写一份）
 */
export interface OpenOutboundLike {
  conversationId: string;
  channelMsgid: string;
  messageSeq: number | null;
  kind: OutboundKind;
  sentAt: Date;
  status: 'pending' | 'sending';
  accountId: string | null;
  inboxId: string | null;
  segment: number;
  attempts: number;
  payload: unknown;
}

/**
 * 启动恢复：把一个账号库里没结果的出站行收进内存账本，返回它们的 intent（顺序同 rows）。预载已经读进来的同一 msgid（各会话最后一条
 * 客户消息之后的）补上 payload、段号、入站与账号；没读进来的（更早的）新建一行。状态以库里的为准（pending、sending，都在库里、
 * commit 已提交），计入已用条数、工作台「发送中」，之后按出站恢复表补发、取消或记 unknown。account_id 为空的 02 旧行记在这个账号下
 * （只在内存里，库里那一列不改）
 */
export function adoptOpenOutbound(accountId: string, rows: readonly OpenOutboundLike[]): OutboundIntent[] {
  ensureLoaded();
  return rows.map((r) => {
    let row = byMsgid.get(r.channelMsgid);
    if (!row) {
      row = { ...newRow(r.conversationId, r.kind, null, r.sentAt.getTime()), msgid: r.channelMsgid };
      add(row);
    }
    Object.assign(row, {
      kind: r.kind,
      seq: r.messageSeq,
      status: r.status,
      inFlight: true,
      inDb: true,
      v2: true,
      accountId: r.accountId ?? accountId,
      inboxId: r.inboxId,
      segment: r.segment,
      payload: r.payload as OutboundPayload | null,
      attempts: r.attempts,
      commit: 'committed',
      commitWaiters: [],
    });
    return intentOf(row);
  });
}

/**
 * 启动恢复（RESEND_UNKNOWN 为假）：重启时还是 sending 的段记 unknown、不补发（迁移表的 recover；R5 的边界）。随会话的下一次落库
 * 写进存档点（与别的结果同一类：丢了下次启动再记一遍），没有会话的单独短事务。工作台随之「可能没送达」
 */
export function recoverAsUnknown(intent: OutboundIntent): void {
  const row = byMsgid.get(intent.msgid);
  if (!row?.v2 || !canMoveOutbound(row.status, 'unknown', ['recover'])) return;
  row.status = 'unknown';
  finishRow(row);
  persistResult(row);
}

/** 入站恢复（replied 一行）：这条入站名下还在 pending 的段，按段号（启动恢复收进来的，与本进程排过、还没发的） */
export function pendingIntentsOfInbox(inboxId: string): OutboundIntent[] {
  return [...byMsgid.values()]
    .filter((r) => r.v2 && r.inboxId === inboxId && r.status === 'pending')
    .toSorted((a, b) => a.segment - b.segment)
    .map(intentOf);
}

// ---------------- 03 R6：没落库就发 ----------------

let unsafeAt: number[] = [];
const unsafeListeners = new Set<(countIn10m: number) => void>();
/** 「没落库就发」（R6）：每次计数，订阅者（告警 channel）收到最近 10 分钟的次数 */
export function onUnsafeSend(cb: (countIn10m: number) => void): () => void {
  unsafeListeners.add(cb);
  return () => unsafeListeners.delete(cb);
}
/** 调用方决定照发的那一刻调：这一段的 sending 没在发请求之前提交（pending 等不到提交、markSending 库不可用） */
export function noteUnsafeSend(): void {
  const t = Date.now();
  unsafeAt = unsafeAt.filter((x) => t - x < UNSAFE_WINDOW_MS);
  unsafeAt.push(t);
  for (const cb of unsafeListeners) {
    try {
      cb(unsafeAt.length);
    } catch {
      /* 订阅者出错不影响发送 */
    }
  }
}
/** 最近 10 分钟「没落库就发」的次数（/status 用，第 13 步） */
export function unsafeSendsIn10m(now = Date.now()): number {
  return unsafeAt.filter((x) => now - x < UNSAFE_WINDOW_MS).length;
}

// ======================================================================================
// 读：窗口、去重、工作台
// ======================================================================================

/** 窗口起点：客户最后一条消息的 min(sentAt, at)。sentAt 是企微的钟、at 与账本行是本机的钟：本机钟慢时取 at，同一个钟比较 */
function windowStartOf(messages: readonly ChatMessage[] | undefined): number | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'customer') continue;
    const ts = [m.sentAt, m.at].filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    return ts.length ? Math.min(...ts) : null;
  }
  return null;
}

/**
 * 发送窗口（只读内存）：客户最后一条消息的 min(sentAt, at) 起 48 小时，最后一次尝试在这之后的 accepted、unknown 与还在发
 * （含预占；03 的 pending、sending）的分段数
 */
export function sendWindow(sessionId: string, now: number): SendWindow {
  ensureLoaded();
  const s = getSession(sessionId);
  const lastCustomerAt = s ? windowStartOf(s.messages) : null;
  if (lastCustomerAt === null) return { lastCustomerAt: null, closesAt: null, used: 0, remaining: 0 };
  const closesAt = lastCustomerAt + WINDOW_MS;
  let used = 0;
  for (const r of bySession.get(sessionId) ?? []) if (r.lastAttemptAt >= lastCustomerAt && COUNTED.has(r.status)) used += 1;
  return { lastCustomerAt, closesAt, used, remaining: now >= closesAt ? 0 : Math.max(0, WINDOW_SENDS - used) };
}

/** 跟进放不放行（R18、不变量 34）：窗口剩余至少 2 条、至少 2 小时 */
export function followupWindowAllows(sessionId: string, now: number): boolean {
  const w = sendWindow(sessionId, now);
  return w.closesAt !== null && w.remaining >= FOLLOWUP_MIN_REMAINING && w.closesAt - now >= FOLLOWUP_MIN_LEFT_MS;
}

// 窗口关着、条数用完时给顾问看的说明（与 msg_send_fail 的 4、6 同一句）：挪到 src/shared/conversation-types.ts，
// 这里原样 re-export，公开名字不变（见该文件顶部「发送窗口与送达状态的固定文案」）
export { QUOTA_EXHAUSTED_TEXT, WINDOW_CLOSED_TEXT };

export type HumanReplyVerdict =
  | { ok: true; window: SendWindow }
  | { ok: false; reason: 'window_closed' | 'quota_exhausted'; closesAt: number | null; remaining: number; message: string };

/**
 * 人工回复放不放行（spec「接手、人工回复与交还」：剩 0 条或窗口已过时拒绝并写明原因）。第 13 步的 reply() 据它抛 SendWindowError；
 * 之前由旧 /reply 调。放行之后在同一段同步代码里 holdSend 占一个名额
 */
export function humanReplyVerdict(sessionId: string, now: number): HumanReplyVerdict {
  const w = sendWindow(sessionId, now);
  if (w.closesAt === null || now >= w.closesAt) {
    return { ok: false, reason: 'window_closed', closesAt: w.closesAt, remaining: 0, message: WINDOW_CLOSED_TEXT };
  }
  if (w.remaining <= 0) return { ok: false, reason: 'quota_exhausted', closesAt: w.closesAt, remaining: 0, message: QUOTA_EXHAUSTED_TEXT };
  return { ok: true, window: w };
}

/** 这条消息在账本里的行（预占还没被接过去的不算）：本进程记的按对象认，预载来的按 seq 认 */
function rowsOf(sessionId: string, message: ChatMessage): Row[] {
  ensureLoaded();
  const seq = seqOf(message);
  return (bySession.get(sessionId) ?? []).filter(
    (r) => !r.held && (r.message === message || (r.message === null && r.seq !== null && r.seq === seq)),
  );
}

/**
 * 去重情况 4：那条回复在账本里有没有 accepted 或 unknown 的行（有就是已经送出，或可能已经送出，不再重发）。
 * 库里账号的行另算 pending、sending（这一组已经排进发送，由它自己发完，不再另起一组）
 */
export function replyDelivered(sessionId: string, message: ChatMessage): boolean {
  return rowsOf(sessionId, message).some((r) => (r.v2 ? COUNTED.has(r.status) : r.status === 'accepted' || r.status === 'unknown'));
}

/**
 * push 返回 false 之后，这条消息可能已经到了客户手里吗：有分段 accepted、unknown（超时或网络异常、结果不明），或还没出结果。
 * 跟进的执行体与文件存储的扫描器据它把「结果不明」按已发处理（不退账、不重排），只有一段都没送出才算明确失败
 */
export function mayHaveDelivered(sessionId: string, message: ChatMessage): boolean {
  return rowsOf(sessionId, message).some((r) => COUNTED.has(r.status));
}

/**
 * J 页消息的投递状态（02 第 13 步，MessageView.delivery）：只读内存里的账本（不变量 9）。一条消息分几段、加卡片时按 03 的映射表
 * （deliveryOfSegments）：有分段还在发（02 的 pending，03 的 pending、sending）是「发送中」；否则 failed > rejected > unknown >
 * cancelled > accepted。预占的不算。账本里没有这条为 null
 */
export function deliveryOf(sessionId: string, message: ChatMessage): DeliveryView | null {
  return deliveryOfSegments(rowsOf(sessionId, message).map((r) => ({ status: r.status, failType: r.failType })));
}

export { sendFailText };

/** 会话追加说明、发 send.failed 事件（第 13 步的 SSE 接上之前经 onCommitted 这个现有出口），随会话的下一次落库提交 */
function explain(sessionId: string, failType: number): void {
  const s = getSession(sessionId);
  if (!s) return;
  s.messages.push({ role: 'system', content: sendFailText(failType), at: Date.now() });
  emitAfterCommit(sessionId, { type: 'send.failed', id: sessionId, failType });
  saveSession(s, false); // 系统写的说明不算客户的动静
}

/**
 * 回执改库（单独一个短事务）。没写成（库报错、冲突、late 段之后、租户锁在别人手里）的进本进程的待补：隔一拍再试一次，仍失败记 error。
 * explainHit：内存里没有这一行，改中了才知道是哪个会话，那时再加说明（重试改中的也加）。
 * inboxId（03 库里账号的回执入站行）：同一个短事务把它记 done；几次都没写成时入站行停在 received，重启时由启动恢复重做（第 10 步）。
 * full（03 本进程计划过的那一段，内存里已是 failed）：短事务里按迁移表写这一整行 failed（没有就插入、pending 等可迁的迁过去），
 * 而不是只 UPDATE——这一段的 pending 可能还在另一个没提交的落库事务里，UPDATE 看不到它，回执的 done 却会先提交，
 * 那次落库之后库里留着 pending（第 9 步评审）。插入会等那个事务结束再按迁移表判；之后晚到的 pending、结果都不改 failed
 */
async function markFailedInDb(
  channelMsgid: string,
  failType: number,
  explainHit: boolean,
  inboxId: string | null = null,
  full: OutboundRow | null = null,
): Promise<void> {
  const delays = inboxId === null ? [RECEIPT_RETRY_MS] : RECEIPT_INBOX_RETRY_MS;
  for (let i = 0; ; i++) {
    const r = await markOutboundFailedInDb(channelMsgid, failType, inboxId, full);
    if (r.ok) {
      if (explainHit && r.sessionId) explain(r.sessionId, failType);
      return;
    }
    if (i >= delays.length) break;
    await new Promise<void>((resolve) => setTimeout(resolve, delays[i]).unref());
  }
  console.error(
    `[quota] msg_send_fail 回执改库重试${delays.length === 1 ? '一' : ` ${delays.length} `}次仍没写成（fail_type=${failType}），库里那一行没记 failed`,
  );
}

/**
 * sync_msg 里 origin=4 的 msg_send_fail：按 fail_msgid 找到账本行记 failed 与 fail_type，给会话追加说明、发 send.failed 事件。
 * 幂等：已经记过 failed 的不再加说明。db 存储下库里那一行单独一个短事务改：本进程排进落库的先等这个会话排着的落库提交（免得改在
 * 它前面），预载来的本来就在库里、直接改；还在等 seq、没排进落库的不用改库（排进去时就是 failed）。内存里没有（预载窗口之外）的
 * 按 msgid 直接改库，改中了再给那个会话加说明。库里账号的行按迁移表：rejected、cancelled 收到回执不改（库里同样不改）
 */
export function onSendFail(channelMsgid: string, failType: number): void {
  void receipt(channelMsgid, failType, null);
}

/**
 * 03 库里账号的回执（spec「入站」的 send_fail）：同 onSendFail，另外把回执的入站行记 done——出站行的 failed 与它同一个短事务
 * （库里那一行不用改时这个短事务只记 done，迁移表让重复的回执无害）。重复的回执不再加说明（02 规则）。写完（或重试一次仍失败）才返回，
 * 处理链据此保序
 */
export function onSendFailInbox(channelMsgid: string, failType: number, inboxId: string): Promise<void> {
  return receipt(channelMsgid, failType, inboxId);
}

async function receipt(channelMsgid: string, failType: number, inboxId: string | null): Promise<void> {
  ensureLoaded();
  const row = byMsgid.get(channelMsgid);
  let toDb = false;
  let explainHit = false;
  let waitFor: string | null = null;
  let full: OutboundRow | null = null;
  if (row) {
    const moves = row.status !== 'failed' && (!row.v2 || canMoveOutbound(row.status, 'failed', ['receipt']));
    if (moves) {
      row.status = 'failed';
      row.failType = failType;
      if (row.v2) finishRow(row);
      if (row.dbRow) {
        // 回执先于这一行落库（R6）：内存里排着的那一行直接改成 failed，落库时就插成 failed（迁移表的「没有这一行 → failed」）
        row.dbRow.status = 'failed';
        row.dbRow.failType = failType;
        if (row.v2) row.dbRow.payload = null;
      }
      explain(row.sessionId, failType);
      // 库里账号的行：对应的消息还没写进会话（跟进、引导提示送达之后才写）时，等它分到 seq 再写一行 failed——库里那一行由回执的短事务
      // 先记了 failed、message_seq 还是 NULL，这一行只把 seq 补上（不是状态变化），工作台按 seq 才查得到这一段的失败
      if (row.v2 && row.message && seqOf(row.message) === undefined && writesToDb(row.sessionId)) awaitSeq(row);
      if (!row.v2 && row.inDb && writesToDb(row.sessionId)) {
        toDb = true;
        // 本进程排进落库的先等这个会话排着的落库提交（免得改在它前面）
        if (row.dbRow !== null) waitFor = row.sessionId;
      }
    }
    // 03 库里账号、本进程计划过的段：内存里是 failed（这次改的，或重复的回执）就在回执的短事务里写这一整行 failed（见 markFailedInDb）。
    // 先等这个会话排着的落库（多半已提交，短事务里的插入就不必等锁）；等不到也照写，插入会等那个事务结束。
    // 内存里是别的终态（rejected、cancelled：迁移表不许改 failed）的不写出站行，只记入站 done
    if (row.v2 && writesToDb(row.sessionId) && row.status === 'failed') {
      toDb = true;
      full = writeShape(row, 'failed');
      if (row.dbRow !== null) waitFor = row.sessionId;
    }
  } else if (sessionStoreMode() === 'db') {
    toDb = true;
    explainHit = true;
  }
  if (!toDb) {
    // 库里那一行不用改（已是 failed、终态、还在等 seq 没排进落库、只在内存里）：库里账号的回执入站行照样单独记 done
    if (inboxId !== null && !(await writeInboxStateNow({ inboxId, state: 'done' }))) {
      console.error('[quota] 回执的入站行没记成 done（库写不进去），重启时由启动恢复重做');
    }
    return;
  }
  if (waitFor !== null && getSession(waitFor)) await flushSession(waitFor, { timeoutMs: 5000 }).catch(() => undefined);
  await markFailedInDb(channelMsgid, failType, explainHit, inboxId, full);
}

/** 仅供自测：账本里的行（按记账顺序）与清空 */
export const __ledgerTest = {
  rows(sessionId?: string): {
    sessionId: string;
    msgid: string;
    kind: OutboundKind;
    status: Status;
    errcode: number | null;
    failType: number | null;
    sentAt: number;
    lastAttemptAt: number;
    held: boolean;
    message: ChatMessage | null;
    v2: boolean;
    segment: number;
    attempts: number;
    payload: OutboundPayload | null;
    commit: 'committed' | 'failed' | null;
  }[] {
    ensureLoaded();
    const lists = sessionId === undefined ? [...bySession.values()] : [bySession.get(sessionId) ?? []];
    return lists.flat().map((r) => ({
      sessionId: r.sessionId,
      msgid: r.msgid,
      kind: r.kind,
      status: r.status,
      errcode: r.errcode,
      failType: r.failType,
      sentAt: r.sentAt,
      lastAttemptAt: r.lastAttemptAt,
      held: r.held,
      message: r.message,
      v2: r.v2,
      segment: r.segment,
      attempts: r.attempts,
      payload: r.payload,
      commit: r.commit,
    }));
  },
  reset(): void {
    bySession.clear();
    byMsgid.clear();
    holds.clear();
    for (const w of awaitingSeq.values()) if (w.timer) clearTimeout(w.timer);
    awaitingSeq.clear();
    unsafeAt = [];
    markHook = null;
    planHook = null;
  },
  /** 缩短 R6 的两个等待（自测）；不给的项不变，null 换回 5 秒 */
  setWaits(w: { commitMs?: number; markMs?: number } | null): void {
    if (w === null) {
      waits.commitMs = 5_000;
      waits.markMs = 5_000;
      return;
    }
    if (w.commitMs !== undefined) waits.commitMs = w.commitMs;
    if (w.markMs !== undefined) waits.markMs = w.markMs;
  },
  /**
   * markSending 发短事务之前先 await 它（自测在这里挂住库、在挂住期间接手或跨过停机截止，验收 5、20）。
   * 只是自测出口，不由环境变量触发
   */
  setMarkHook(fn: ((intent: OutboundIntent) => void | Promise<void>) | null): void {
    markHook = fn;
  },
  /** planOutbound 排完 pending、返回之前同步调（自测在这里挡住写库，验收 7 的 B） */
  setPlanHook(fn: ((intents: readonly OutboundIntent[]) => void) | null): void {
    planHook = fn;
  },
};
