// 企微发送账本（docs/architecture/02-conversations-workbench/spec.md「企微：发送账本、回执与去重」、R7、R18、不变量 33、34）。
// 每次 send_msg 的每个分段带一个我们生成的 msgid（≤32 字节，同一分段重试沿用），在这里恰有一行：
//   accepted 接口回了成功；rejected 接口明确报错；unknown 超时或网络异常、结果不明（计入额度）；failed 之后收到 msg_send_fail。
//   还在发的记 pending（只在内存里）：结果出来之前也算进已用条数（可能已经送达，只会少发）；取 access_token 失败、send_msg
//   一次都没发出去的那一段不记。send_msg_on_event（新客户的欢迎语）不进账本、不计条数（R18 与不变量 33 说的是 send_msg）。
// 账本在内存里，读（sendWindow 等）不查库（不变量 9）。db 存储下：预载读出每个会话最后一条客户消息之后的发送；真实会话的账本行
// 经 queueTelemetry 随会话的下一次落库写（存档点之内）；还没有会话的（老客户补发的欢迎语）单独一个短事务；msg_send_fail 的状态
// 更新单独一个短事务。demo 类与文件存储下只在内存。
// 窗口按 R18 的保守口径算：客户最后一条消息的 sentAt（企微 send_time，没有就用 at）起 48 小时，至多 5 次 send_msg。
// 开放问题 8 实测之后只改这里的常量与适配器。
import { randomBytes } from 'node:crypto';
import type { OutboundKind, SendWindow } from '../shared/conversation-types.js';
import { lastCustomerAtOf } from '../store/project.js';
import {
  emitAfterCommit,
  flushSession,
  getSession,
  isDemoClassId,
  markOutboundFailedInDb,
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
  sentAt: number;
  status: Status;
  errcode: number | null;
  failType: number | null;
  /** 已经排进落库（或单独写）的那一行：回执来得早、还没写进库时直接改它 */
  dbRow: OutboundRow | null;
}

const bySession = new Map<string, Row[]>();
const byMsgid = new Map<string, Row>();

/** 已用条数算哪几种：送达的、结果不明的，以及还在发的（可能已经送达） */
const COUNTED: ReadonlySet<Status> = new Set<Status>(['accepted', 'unknown', 'pending']);

function add(row: Row): void {
  const list = bySession.get(row.sessionId);
  if (list) list.push(row);
  else bySession.set(row.sessionId, [row]);
  byMsgid.set(row.msgid, row);
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
        status: r.status,
        errcode: r.errcode,
        failType: r.failType,
        dbRow: null,
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

/**
 * 有了结果的一行写进库：会话在内存里就随它的下一次落库（queueTelemetry），没有会话（老客户补发的欢迎语）单独一个短事务。
 * 对应的消息送达之后才写进会话的（引导提示、跟进）：等调用方把它写进会话、分到 seq 再排（下一个宏任务；调用方在推送返回之后的
 * 同一段同步代码里写进会话），没写进去就是 message_seq 为 NULL
 */
function persist(row: Row): void {
  if (!writesToDb(row.sessionId)) return;
  const write = (): void => {
    const dbRow: OutboundRow = {
      conversationId: row.sessionId,
      channelMsgid: row.msgid,
      messageSeq: row.message ? (seqOf(row.message) ?? null) : row.seq,
      kind: row.kind,
      sentAt: new Date(row.sentAt),
      status: row.status === 'pending' ? 'unknown' : row.status,
      errcode: row.errcode,
      failType: row.failType,
    };
    row.dbRow = dbRow;
    if (getSession(row.sessionId)) queueTelemetry(row.sessionId, { outbound: [dbRow] });
    else void writeStandaloneOutbound([dbRow]);
  };
  if (row.message && seqOf(row.message) === undefined) setImmediate(write);
  else write();
}

/** 一个分段的记账口子：sendText / sendRich / 欢迎语 / 菜单的每个分段调一次 recordSend，发完调一次 settle（或 discard） */
export interface SendHandle {
  /** 随 send_msg 下发的 msgid：32 个十六进制字符；同一分段的重试沿用它 */
  readonly msgid: string;
  /** 这一段的结果，只认第一次；之前已收到回执（failed）的照样写库 */
  settle(result: SendResult, errcode?: number): void;
  /** send_msg 一次都没发出去（取 access_token 失败）：这一段不记 */
  discard(): void;
}

/**
 * sendText 每个分段调一次：生成 msgid（重试沿用），settle 记 accepted / rejected / unknown。message 写库时经 seqOf 换成 seq。
 * 结果出来之前这一行是 pending，算进已用条数
 */
export function recordSend(sessionId: string, kind: OutboundKind, message: ChatMessage | null): SendHandle {
  ensureLoaded();
  const now = Date.now();
  prune(sessionId, now);
  const row: Row = {
    sessionId,
    msgid: randomBytes(16).toString('hex'),
    kind,
    message,
    seq: null,
    sentAt: now,
    status: 'pending',
    errcode: null,
    failType: null,
    dbRow: null,
  };
  add(row);
  let done = false;
  return {
    msgid: row.msgid,
    settle(result, errcode) {
      if (done) return;
      done = true;
      if (row.status === 'pending') {
        row.status = result;
        row.errcode = errcode ?? null;
      }
      persist(row);
    },
    discard() {
      if (done) return;
      done = true;
      byMsgid.delete(row.msgid);
      const list = bySession.get(sessionId);
      if (list)
        bySession.set(
          sessionId,
          list.filter((r) => r !== row),
        );
    },
  };
}

/** 发送窗口（只读内存）：客户最后一条消息的 sentAt（没有就用 at）起 48 小时，之后 accepted、unknown 与还在发的分段数 */
export function sendWindow(sessionId: string, now: number): SendWindow {
  ensureLoaded();
  const s = getSession(sessionId);
  const lastCustomerAt = s ? lastCustomerAtOf(s.messages) : null;
  if (lastCustomerAt === null) return { lastCustomerAt: null, closesAt: null, used: 0, remaining: 0 };
  const closesAt = lastCustomerAt + WINDOW_MS;
  let used = 0;
  for (const r of bySession.get(sessionId) ?? []) if (r.sentAt >= lastCustomerAt && COUNTED.has(r.status)) used += 1;
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
 * 之前由旧 /reply 调
 */
export function humanReplyVerdict(sessionId: string, now: number): HumanReplyVerdict {
  const w = sendWindow(sessionId, now);
  if (w.closesAt === null || now >= w.closesAt) {
    return { ok: false, reason: 'window_closed', closesAt: w.closesAt, remaining: 0, message: WINDOW_CLOSED_TEXT };
  }
  if (w.remaining <= 0) return { ok: false, reason: 'quota_exhausted', closesAt: w.closesAt, remaining: 0, message: QUOTA_EXHAUSTED_TEXT };
  return { ok: true, window: w };
}

/** 这条消息在账本里的行：本进程记的按对象认，预载来的按 seq 认 */
function rowsOf(sessionId: string, message: ChatMessage): Row[] {
  ensureLoaded();
  const seq = seqOf(message);
  return (bySession.get(sessionId) ?? []).filter((r) => r.message === message || (r.message === null && r.seq !== null && r.seq === seq));
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
 * sync_msg 里 origin=4 的 msg_send_fail：按 fail_msgid 找到账本行记 failed 与 fail_type，给会话追加说明、发 send.failed 事件。
 * 幂等：已经记过 failed 的不再加说明。db 存储下库里那一行单独一个短事务改（先等这个会话排着的账本行落库，免得改在它前面）；
 * 内存里没有（预载窗口之外）的按 msgid 直接改库，改中了再给那个会话加说明
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
    if (row.dbRow && writesToDb(row.sessionId)) {
      const sid = row.sessionId;
      void (async () => {
        if (getSession(sid)) await flushSession(sid, { timeoutMs: 5000 }).catch(() => undefined);
        await markOutboundFailedInDb(channelMsgid, failType);
      })();
    }
    return;
  }
  if (sessionStoreMode() !== 'db') return;
  void markOutboundFailedInDb(channelMsgid, failType).then((sid) => {
    if (sid) explain(sid, failType);
  });
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
      message: r.message,
    }));
  },
  reset(): void {
    bySession.clear();
    byMsgid.clear();
  },
};
