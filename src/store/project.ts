// Session / Order / ChatMessage 与库里的行之间的投影，以及 normalizeForStore
// （docs/architecture/02-conversations-workbench/spec.md「identity map 与写入」「数据库」）。
// 纯函数：不 import 库、store、引擎、工具、模型与渠道（scripts/check-boundaries.ts 守），PG 后端与第 6 步的命令行共用。
// 行的形状与 src/db/repo/ 里的行类型逐字段相同：纯模块不能 import 那边，类型在调用处按结构对上。
import { cleanText } from '../shared/text.js';
import type { ChatMessage, Order, Session } from '../types.js';

/** 「真实会话在库里，JSON 只剩 demo 类」的标记文件（spec「导入、导出与切换」）。store.ts 原样再导出，命令行从这里取 */
export const SESSIONS_IN_DB_MARKER = 'sessions-in-db.json';

const DEMO_CLASS_RE = /^(sim-|wecom:cust_)/;

/** sim- 或 wecom:cust_ 开头：demo 类会话（网页访客与种子），永不进 PG（R6）。store.ts 原样再导出 */
export function isDemoClassId(id: string): boolean {
  return DEMO_CLASS_RE.test(id);
}

/** 投影不出合法的行（时间不是有限的毫秒数）：确定性的错误，PG 后端按数据类处理（会话标 poisoned） */
export class ProjectionError extends Error {
  constructor(readonly field: string) {
    super(`投影不出合法的行：${field}`);
  }
}

// ---------------- normalizeForStore ----------------

function cleanDeep(x: unknown): unknown {
  if (typeof x === 'string') return cleanText(x);
  if (Array.isArray(x)) return x.map(cleanDeep);
  if (x !== null && typeof x === 'object') {
    // fromEntries 建的是自有属性：键是 __proto__ 时也不会改到原型上
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [cleanText(k), cleanDeep(v)]));
  }
  return x;
}

/**
 * 进库之前、比对往返之前的规范化：按 JSON 的语义取一遍（值为 undefined 的键去掉、数组里的 undefined 变 null、Date 变串），
 * 再对其中每个字符串（含键）做 cleanText 同样的清洗（去 U+0000、修孤立代理项，不截断）。text 与 json 列都不收这两样
 */
export function normalizeForStore<T>(v: T): T {
  const json = JSON.stringify(v);
  if (json === undefined) return v;
  return cleanDeep(JSON.parse(json)) as T;
}

// ---------------- 行的形状（与 src/db/repo/ 同构） ----------------

/** conversations 由会话投影出来、每次落库整行写入的列（repo/conversations.ts 的 ConversationValues） */
export interface ConversationValuesShape {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  handoffKind: string | null;
  handoffAt: Date | null;
  firstHandoffAt: Date | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  lastCustomerAt: Date | null;
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** messages 的一行（repo/messages.ts 的 MessageValues） */
export interface MessageRowShape {
  seq: number;
  role: 'customer' | 'agent' | 'system';
  author: 'ai' | 'human' | 'followup' | null;
  authorUserId: string | null;
  authorName: string | null;
  content: string;
  at: Date;
  sentAt: Date | null;
  msgid: string | null;
  turnId: string | null;
  extra: Record<string, unknown> | null;
}

/** orders 的一行（repo/orders.ts 的 OrderRow） */
export interface OrderRowShape {
  id: string;
  sessionId: string | null;
  routeId: string;
  status: Order['status'];
  totalPrice: number;
  createdAt: Date;
  paidAt: Date | null;
  confirmedAt: Date | null;
  voidedAt: Date | null;
  voidReason: 'reset' | 'resync' | null;
  data: Record<string, unknown>;
}

const toDate = (ms: unknown, field: string): Date => {
  const d = typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms) : null;
  if (!d || Number.isNaN(d.getTime())) throw new ProjectionError(field);
  return d;
};
const optDate = (ms: unknown, field: string): Date | null => (ms === undefined || ms === null ? null : toDate(ms, field));

// ---------------- 会话 ----------------

/** 会话对象去掉 messages 之后，经 normalizeForStore：conversations.state 列，键序原样，重建只读它 */
export function sessionState(s: Session): Record<string, unknown> {
  const { messages: _messages, ...rest } = s;
  return normalizeForStore(rest) as Record<string, unknown>;
}

/** 客户最后一条消息的时间：企微 send_time（sentAt），没有就用处理时刻 at（与后台列表的 lastCustomerAt 同一口径） */
export function lastCustomerAtOf(messages: readonly ChatMessage[] | undefined): number | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'customer') return m.sentAt ?? m.at;
  }
  return null;
}

/** 由 state（sessionState 的结果）与 lastCustomerAt 投影出整行要写的列。投影列只是给 SQL 用的副本，重建只读 state */
export function conversationValuesFrom(state: Record<string, unknown>, lastCustomerAt: number | null): ConversationValuesShape {
  const st = state as Partial<Session>;
  return {
    id: st.id as string,
    channel: st.channel as string,
    stage: st.stage as string,
    handedOver: st.handedOver === true,
    handoffKind: st.handoff?.kind ?? null,
    handoffAt: st.handoff ? toDate(st.handoff.at, 'handoff.at') : null,
    firstHandoffAt: optDate(st.firstHandoffAt, 'firstHandoffAt'),
    assigneeUserId: st.assignee?.userId ?? null,
    assigneeName: st.assignee?.name ?? null,
    lastCustomerAt: optDate(lastCustomerAt, 'lastCustomerAt'),
    state,
    createdAt: toDate(st.createdAt, 'createdAt'),
    updatedAt: toDate(st.updatedAt, 'updatedAt'),
  };
}

/** 会话 → conversations 的列（state 经 normalizeForStore） */
export function sessionToRow(s: Session): ConversationValuesShape {
  return conversationValuesFrom(sessionState(s), lastCustomerAtOf(s.messages));
}

/** 预载重建：state 原样，再挂上窗口里的消息（按 seq 排好） */
export function rowToSession(row: { state: Record<string, unknown> }, messages: ChatMessage[]): Session {
  return { ...row.state, messages } as unknown as Session;
}

// ---------------- 消息 ----------------

const AUTHORS = new Set(['ai', 'human', 'followup']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 消息 → messages 的一行。ChatMessage 上已知字段以外的键进 extra，原样往返；已知字段的取值放不进列时也进 extra
 * （重建时 extra 盖在列上）：author 只在 role='agent' 且是三种之一时进列，authorId / authorName 只在 author='human' 时进列——
 * messages_author_human_check 在 author 为 NULL 时视为通过，「没有 author 却带 author_name」的行要由这里保证不出现。
 * author='human' 的消息总带 authorId（共享工作台为 null，不变量 17），重建时照这个写回
 */
export function messageToRow(m: ChatMessage, seq: number, turnId: string | null = null): MessageRowShape {
  const { role, content, at, msgid, sentAt, author, authorId, authorName, ...rest } = normalizeForStore(m) as ChatMessage &
    Record<string, unknown>;
  const extra: Record<string, unknown> = { ...rest };
  const colAuthor = role === 'agent' && typeof author === 'string' && AUTHORS.has(author) ? author : null;
  if (author !== undefined && colAuthor === null) extra.author = author;
  const human = colAuthor === 'human';
  let authorUserId: string | null = null;
  if (authorId !== undefined) {
    if (human && (authorId === null || (typeof authorId === 'string' && UUID_RE.test(authorId)))) authorUserId = authorId;
    else extra.authorId = authorId;
  }
  let colAuthorName: string | null = null;
  if (authorName !== undefined) {
    if (human && typeof authorName === 'string') colAuthorName = authorName;
    else extra.authorName = authorName;
  }
  let colMsgid: string | null = null;
  if (msgid !== undefined) {
    if (typeof msgid === 'string') colMsgid = msgid;
    else extra.msgid = msgid;
  }
  let colSentAt: Date | null = null;
  if (sentAt !== undefined) {
    if (typeof sentAt === 'number' && Number.isFinite(sentAt)) colSentAt = new Date(sentAt);
    else extra.sentAt = sentAt;
  }
  return {
    seq,
    role,
    author: colAuthor,
    authorUserId,
    authorName: colAuthorName,
    content,
    at: toDate(at, 'message.at'),
    sentAt: colSentAt,
    msgid: colMsgid,
    turnId,
    extra: Object.keys(extra).length ? extra : null,
  };
}

/** messages 的一行 → 消息（预载）。键序：role、content、at、msgid、sentAt、author、authorId、authorName，再接 extra */
export function rowToMessage(row: Omit<MessageRowShape, 'seq' | 'turnId'>): ChatMessage {
  const m: Record<string, unknown> = { role: row.role, content: row.content, at: row.at.getTime() };
  if (row.msgid !== null) m.msgid = row.msgid;
  if (row.sentAt !== null) m.sentAt = row.sentAt.getTime();
  if (row.author !== null) m.author = row.author;
  if (row.author === 'human') {
    m.authorId = row.authorUserId;
    if (row.authorName !== null) m.authorName = row.authorName;
  }
  return (row.extra ? { ...m, ...row.extra } : m) as unknown as ChatMessage;
}

// ---------------- 订单 ----------------

/** 订单 → orders 的一行：data 是整个订单对象（经 normalizeForStore），列是它的副本；作废（重置）时带上作废的时间与原因 */
export function orderToRow(o: Order, voided?: { at: number; reason: 'reset' | 'resync' }): OrderRowShape {
  const data = normalizeForStore(o) as unknown as Record<string, unknown> & Order;
  return {
    id: data.id,
    sessionId: data.sessionId ?? null,
    routeId: data.routeId,
    status: data.status,
    totalPrice: data.totalPrice,
    createdAt: toDate(data.createdAt, 'order.createdAt'),
    paidAt: optDate(data.paidAt, 'order.paidAt'),
    confirmedAt: optDate(data.confirmedAt, 'order.confirmedAt'),
    voidedAt: voided ? toDate(voided.at, 'order.voidedAt') : null,
    voidReason: voided?.reason ?? null,
    data,
  };
}

/** orders 的一行 → 订单：只读 data */
export function rowToOrder(row: { data: Record<string, unknown> }): Order {
  return row.data as unknown as Order;
}
