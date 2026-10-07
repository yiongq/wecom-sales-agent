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
import { randomBytes } from 'node:crypto';
import type { OutboundKind, SendWindow } from '../shared/conversation-types.js';
import {
  emitAfterCommit,
  flushSession,
  getSession,
  isDemoClassId,
  markOutboundFailedInDb,
  onSessionSaved,
  queueTelemetry,
  saveSession,
  seqOf,
  sessionStoreMode,
  takePreloadedOutbound,
  writeStandaloneOutbound,
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

export type SendResult = 'accepted' | 'rejected' | 'unknown';
type Status = 'pending' | SendResult | 'failed';

interface Row {
  sessionId: string;
  msgid: string;
  kind: OutboundKind;
  /** 本进程记的：对应的会话消息对象（送达之后才写进会话的，写进去时是同一个对象） */
  message: ChatMessage | null;
  /** 预载来的：库里的 message_seq */
  seq: number | null;
  /** 记账（第一次尝试）的时刻 */
  sentAt: number;
  /** 最后一次尝试的时刻：窗口按它计数，落库的 sent_at 也写它（重试晚于客户新消息时算进新窗口，只会多算） */
  lastAttemptAt: number;
  status: Status;
  errcode: number | null;
  failType: number | null;
  /** 这一段还在发（recordSend 到 settle / discard 之间）；预占的行也是 */
  inFlight: boolean;
  /** 预占（holdSend）的行，推送的第一个分段还没接过去 */
  held: boolean;
  /** 最近一次排进落库（或单独写）的那一行：回执来得早、还没写进库时直接改它 */
  dbRow: OutboundRow | null;
  /** 已在库里：预载来的，或本进程已排进落库。回执按 msgid 改库只对这种行做 */
  inDb: boolean;
}

const bySession = new Map<string, Row[]>();
const byMsgid = new Map<string, Row>();
/** 预占的行，按要发的那条消息认 */
const holds = new Map<ChatMessage, Row>();
/** 等对应消息分到 seq 的账本行，按消息对象：分到之后同一条消息的这几行一起排进落库 */
const awaitingSeq = new Map<ChatMessage, { rows: Set<Row>; timer: NodeJS.Timeout | null }>();

/** 已用条数算哪几种：送达的、结果不明的，以及还在发的（可能已经送达） */
const COUNTED: ReadonlySet<Status> = new Set<Status>(['accepted', 'unknown', 'pending']);

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
  };
}

/** 预载的行在第一次用到账本时搬进来（之后 takePreloadedOutbound 返回空的） */
function ensureLoaded(): void {
  const pre = takePreloadedOutbound();
  for (const [sessionId, rows] of pre) {
    for (const r of rows) {
      if (byMsgid.has(r.channelMsgid)) continue;
      add({
        sessionId,
        msgid: r.channelMsgid,
        kind: r.kind,
        message: null,
        seq: r.messageSeq,
        sentAt: r.sentAt.getTime(),
        lastAttemptAt: r.sentAt.getTime(),
        status: r.status,
        errcode: r.errcode,
        failType: r.failType,
        inFlight: false,
        held: false,
        dbRow: null,
        inDb: true,
      });
    }
  }
}

function prune(sessionId: string, now: number): void {
  const list = bySession.get(sessionId);
  if (!list?.length || list[0]!.sentAt >= now - KEEP_MS) return;
  const kept = list.filter((r) => r.sentAt >= now - KEEP_MS || r.status === 'pending');
  for (const r of list) if (!kept.includes(r)) byMsgid.delete(r.msgid);
  bySession.set(sessionId, kept);
}

/** 这条账本行在库里的那一份：db 存储的真实会话才有，demo 类与文件存储只在内存 */
const writesToDb = (sessionId: string): boolean => sessionStoreMode() === 'db' && !isDemoClassId(sessionId);

/** 排进落库：会话在内存里就随它的下一次落库（queueTelemetry），没有会话（老客户补发的欢迎语）单独一个短事务 */
function write(row: Row): void {
  const dbRow: OutboundRow = {
    conversationId: row.sessionId,
    channelMsgid: row.msgid,
    messageSeq: row.message ? (seqOf(row.message) ?? null) : row.seq,
    kind: row.kind,
    sentAt: new Date(row.lastAttemptAt),
    status: row.status === 'pending' ? 'unknown' : row.status,
    errcode: row.errcode,
    failType: row.failType,
  };
  row.dbRow = dbRow;
  row.inDb = true;
  if (getSession(row.sessionId)) queueTelemetry(row.sessionId, { outbound: [dbRow] });
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
 * 结果出来之前这一行是 pending，算进已用条数。这条消息有预占（holdSend）的行时，第一个分段接过那一行（沿用它的 msgid）
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
      notifySettled({ result, errcode: errcode ?? null, kind });
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
 * 并发的另一条检查就看得到它。推送的第一个分段（同一个 message）接过这一行、沿用它的 msgid。返回撤销：推送结束之后调，
 * 没被接过去（一段都没开始发）就删掉这一行
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
 * （含预占）的分段数
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

/** 窗口关着、条数用完时给顾问看的说明（与 msg_send_fail 的 4、6 同一句） */
export const WINDOW_CLOSED_TEXT = '客户超过 48 小时没说话，这条发不出去了';
export const QUOTA_EXHAUSTED_TEXT = '这一轮已经发满 5 条，等客户回复后才能再发';

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

/** 去重情况 4：那条回复在账本里有没有 accepted 或 unknown 的行（有就是已经送出，或可能已经送出，不再重发） */
export function replyDelivered(sessionId: string, message: ChatMessage): boolean {
  return rowsOf(sessionId, message).some((r) => r.status === 'accepted' || r.status === 'unknown');
}

/**
 * push 返回 false 之后，这条消息可能已经到了客户手里吗：有分段 accepted、unknown（超时或网络异常、结果不明），或还没出结果。
 * 跟进的执行体与文件存储的扫描器据它把「结果不明」按已发处理（不退账、不重排），只有一段都没送出才算明确失败
 */
export function mayHaveDelivered(sessionId: string, message: ChatMessage): boolean {
  return rowsOf(sessionId, message).some((r) => COUNTED.has(r.status));
}

/** 送达状态的轻重：一条消息分几段时取最重的 */
const DELIVERY_RANK = { accepted: 0, unknown: 1, rejected: 2, failed: 3 } as const;
export type DeliveryStatus = keyof typeof DELIVERY_RANK;

/**
 * J 页消息的送达状态（02 第 13 步，MessageView.delivery）：只读内存里的账本（不变量 9）。一条消息分几段、加卡片时取最重的：
 * failed（收到回执）> rejected（接口明确报错）> unknown（结果不明）> accepted；还在发的、预占的不算。账本里没有这条为 null
 */
export function deliveryOf(sessionId: string, message: ChatMessage): { status: DeliveryStatus; failType: number | null } | null {
  let worst: Row | null = null;
  for (const r of rowsOf(sessionId, message)) {
    if (r.status === 'pending') continue;
    if (!worst || DELIVERY_RANK[r.status] > DELIVERY_RANK[worst.status as DeliveryStatus]) worst = r;
  }
  if (!worst || worst.status === 'pending') return null;
  return { status: worst.status, failType: worst.status === 'failed' ? worst.failType : null };
}

/** msg_send_fail 给会话加的说明（spec 原文：4 窗口过了、6 发满 5 条、其余带原因码） */
export function sendFailText(failType: number): string {
  if (failType === 4) return WINDOW_CLOSED_TEXT;
  if (failType === 6) return QUOTA_EXHAUSTED_TEXT;
  return `这条没送达（原因码 ${failType}）`;
}

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
 * explainHit：内存里没有这一行，改中了才知道是哪个会话，那时再加说明（重试改中的也加）
 */
function markFailedInDb(channelMsgid: string, failType: number, explainHit: boolean, retried = false): void {
  void markOutboundFailedInDb(channelMsgid, failType).then((r) => {
    if (r.ok) {
      if (explainHit && r.sessionId) explain(r.sessionId, failType);
      return;
    }
    if (!retried) {
      setTimeout(() => markFailedInDb(channelMsgid, failType, explainHit, true), RECEIPT_RETRY_MS).unref();
      return;
    }
    console.error(`[quota] msg_send_fail 回执改库重试一次仍没写成（fail_type=${failType}），库里那一行没记 failed`);
  });
}

/**
 * sync_msg 里 origin=4 的 msg_send_fail：按 fail_msgid 找到账本行记 failed 与 fail_type，给会话追加说明、发 send.failed 事件。
 * 幂等：已经记过 failed 的不再加说明。db 存储下库里那一行单独一个短事务改：本进程排进落库的先等这个会话排着的落库提交（免得改在
 * 它前面），预载来的本来就在库里、直接改；还在等 seq、没排进落库的不用改库（排进去时就是 failed）。内存里没有（预载窗口之外）的
 * 按 msgid 直接改库，改中了再给那个会话加说明
 */
export function onSendFail(channelMsgid: string, failType: number): void {
  ensureLoaded();
  const row = byMsgid.get(channelMsgid);
  if (row) {
    if (row.status === 'failed') return;
    row.status = 'failed';
    row.failType = failType;
    if (row.dbRow) {
      row.dbRow.status = 'failed';
      row.dbRow.failType = failType;
    }
    explain(row.sessionId, failType);
    if (row.inDb && writesToDb(row.sessionId)) {
      const sid = row.sessionId;
      const queued = row.dbRow !== null;
      void (async () => {
        if (queued && getSession(sid)) await flushSession(sid, { timeoutMs: 5000 }).catch(() => undefined);
        markFailedInDb(channelMsgid, failType, false);
      })();
    }
    return;
  }
  if (sessionStoreMode() !== 'db') return;
  markFailedInDb(channelMsgid, failType, true);
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
    }));
  },
  reset(): void {
    bySession.clear();
    byMsgid.clear();
    holds.clear();
    for (const w of awaitingSeq.values()) if (w.timer) clearTimeout(w.timer);
    awaitingSeq.clear();
  },
};
