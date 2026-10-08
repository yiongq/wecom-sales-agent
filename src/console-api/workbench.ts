// 会话工作台的投影（docs/architecture/02-conversations-workbench/spec.md「后台接口」）：列表行、计数、J 页详情、消息、订单。
// 读接口只读内存（identity map、发送账本）；例外只有 spec 写明的 trace 类读法（护栏改写的句数、更早的消息、步骤摘要与改写对照），
// 它们只在 db 存储的真实会话上查库，文件存储与 demo 类会话不查（返回 null、空或 503，见 app.ts）。
// 不把 store 里的活对象原样返回：每个字段都投影一遍，只读成员（viewer）看到的正文与客户原话打码（mask.ts）
import { currentCatalog, currentTenant } from '../config/source.js';
import type { AuthedUser } from '../auth/session.js';
import { type Actor, assigneeOf, consentDeclined, handlesConversations, isAssignee, supervisesConversations } from '../handoff/takeover.js';
import { paymentMode } from '../payment/mode.js';
import { deliveryOf, sendWindow } from '../quota/ledger.js';
import { SALES_SEGMENTS } from '../shared/catalog-types.js';
import type { ConversationCounts, ConversationDetail, ConversationRow, MessageView, OrderView } from '../shared/console-api.js';
import { conversationState, needParts, needSummary, paidNeedsHuman, type NeedVocabulary } from '../shared/conversation.js';
import type { IndustryPack } from '../shared/pack.js';
import { cleanText } from '../shared/text.js';
import { getOrder, getSession, isDemoClassId, listSessions, seqOf, sessionStoreMode, turnIdOf, windowStartOf } from '../store.js';
import type { ChatMessage, MessageAuthor, Order, Session } from '../types.js';
import { maskNumbers } from './mask.js';

/**
 * 列得出来的会话：不含 sim- 访客会话（演示访客会话凭 id 就能读全文，id 本身就是凭据；02：console 不列也不开它们，
 * 详情等接口对它们回 404 conversation_not_found）。会话列表与计数都从这里取，两边对同一批会话分类，计数才对得上列表的 total
 */
export const listedSessions = (): Session[] => listSessions().filter((s) => !s.id.startsWith('sim-'));
export const isListed = (id: string): boolean => !id.startsWith('sim-');

/**
 * needSummary 的词表：目的地取产品库 active 条目的 destination；客群取旅游包的五个客群值，短标签暂时就是客群值本身
 * （「贵州银发4人」）。spec 举例的「带爸妈」这类短标签要进行业包的词汇表，用到的字不在 UI 优先片里，要重切字体，留给画列表的第 19 步
 */
export const needVocabulary = (): NeedVocabulary => ({
  destinations: [...new Set(currentCatalog().routes.map((r) => r.destination))],
  segments: Object.fromEntries(SALES_SEGMENTS.map((k) => [k, k])),
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** 客户最后一条消息的时间：企微 send_time（sentAt），没有就用处理时刻 at */
function lastCustomerAt(s: Session): string | null {
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    const m = s.messages[i]!;
    if (m.role === 'customer') return iso(m.sentAt ?? m.at);
  }
  return null;
}

/** 列表的一行：只投影这几个字段，不把 store 里的活对象原样返回，不带消息正文和客户画像。viewer 的转人工原因也要打码（不变量 47） */
export const conversationRow = (s: Session, vocab: NeedVocabulary, viewer: boolean): ConversationRow => ({
  id: s.id,
  channel: s.channel,
  stage: s.stage,
  handedOver: s.handedOver,
  messageCount: s.messages.length,
  updatedAt: iso(s.updatedAt),
  needSummary: needSummary(s.profile, vocab),
  assignee: s.assignee ? { userId: s.assignee.userId, name: s.assignee.name } : null,
  handoff: s.handoff
    ? { kind: s.handoff.kind, at: iso(s.handoff.at), reason: viewer ? maskNumbers(s.handoff.reason) : s.handoff.reason }
    : null,
  lastCustomerAt: lastCustomerAt(s),
});

/** 01 的顺序：(updatedAt desc, id) */
export const byRecent = (a: Session, b: Session): number => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** 等人接手的在前，同组内仍按 (updatedAt desc, id)（设计系统 §10.0 修正 1：I 页里 F01 在 A01 前；02：其余照旧） */
export const waitingFirst =
  (pack: IndustryPack) =>
  (a: Session, b: Session): number =>
    Number(conversationState(b, pack) === 'human') - Number(conversationState(a, pack) === 'human') || byRecent(a, b);

/** 「已成交客户要人工」一组（ConvQuery.group=paid_needs_human，开放问题 12 选 A 的接口部分） */
export const inPaidNeedsHuman = (s: Session, pack: IndustryPack): boolean => paidNeedsHuman(s, pack);

/**
 * 一次同步遍历算完的计数（后台 UX spec「接口改动」）：同一次结果里 byState 之和等于 total，aiByStage 之和等于 byState.ai。
 * 事件流的 counts 与 GET /conversations/counts 用同一个
 */
export function conversationCounts(now: number): ConversationCounts {
  const midnight = new Date(now).setHours(0, 0, 0, 0); // 服务器时区（TZ）的今天 0 点
  const body: ConversationCounts = { total: 0, byState: { ai: 0, human: 0, assigned: 0, paid: 0 }, aiByStage: {}, updatedToday: 0 };
  const pack = currentTenant().pack;
  for (const s of listedSessions()) {
    const state = conversationState(s, pack);
    body.total += 1;
    body.byState[state] += 1;
    if (state === 'ai') body.aiByStage[s.stage] = (body.aiByStage[s.stage] ?? 0) + 1;
    if (s.updatedAt >= midnight) body.updatedToday += 1;
  }
  return body;
}

// ---------------- J 页 ----------------

/** 操作者：console 成员 */
export const actorOf = (u: AuthedUser, ip: string | null): Actor => ({ userId: u.userId, name: u.displayName, role: u.role, ip });

/** trace 类数据只在 db 存储的真实会话上有（demo 类不进库，R6；文件存储下 trace 只在内存） */
export const tracedInDb = (s: Pick<Session, 'id'>): boolean => sessionStoreMode() === 'db' && !isDemoClassId(s.id);

/** 以「AI 已转人工」开头的 system 消息：界面按时间线行渲染，不显示原文 */
const HANDOFF_NOTE_RE = /^AI 已转人工/;

const authorOf = (m: Pick<ChatMessage, 'role' | 'author'>): MessageAuthor => (m.role === 'agent' ? (m.author ?? 'ai') : m.role);

export interface MessageViewOpts {
  viewer: boolean;
  /** turnId 只在 db 存储的真实会话上给（库里才有 trace） */
  withTurns: boolean;
  guarded: ReadonlyMap<string, { removed: number; added: number }>;
}

/** 一条消息的投影。seq 由调用方给（内存里的取 seqOf，更早的取库里的列）；delivery 同样由调用方给 */
export function messageView(
  m: ChatMessage,
  seq: number,
  turnId: string | null,
  delivery: MessageView['delivery'],
  o: MessageViewOpts,
): MessageView {
  const tid = o.withTurns ? turnId : null;
  return {
    seq,
    role: m.role,
    author: authorOf(m),
    authorName: m.role === 'agent' && m.author === 'human' ? (m.authorName ?? null) : null,
    text: o.viewer ? maskNumbers(m.content) : m.content,
    kind: m.role === 'system' && HANDOFF_NOTE_RE.test(m.content) ? 'handoff_note' : 'message',
    at: iso(m.at),
    turnId: tid,
    guarded: tid ? (o.guarded.get(tid) ?? null) : null,
    delivery,
  };
}

/** 内存窗口里的消息（按 seq 升序）；还没分到 seq 的（同一段同步代码里正在写的）不列，下一次取就有了 */
export function windowMessages(s: Session): { m: ChatMessage; seq: number }[] {
  const out: { m: ChatMessage; seq: number }[] = [];
  for (const m of s.messages) {
    const seq = seqOf(m);
    if (seq !== undefined) out.push({ m, seq });
  }
  return out;
}

/** AI 回复关联的轮次（读 guard 总数用） */
export const windowTurnIds = (s: Session): string[] =>
  windowMessages(s).flatMap(({ m }) => {
    const t = m.role === 'agent' ? turnIdOf(m) : undefined;
    return t ? [t] : [];
  });

/**
 * 订单所属会话的最小投影（A2「待付款」行用）：会话被清除（第 16 步之后才会出现）时为 null。不带短码——
 * console 一侧 conversationLabel(row, pack) 已经会从 id 现算 shortIdOf，这里重复发一遍只是多一个字段
 */
function orderConversation(o: Order): OrderView['conversation'] {
  const s = getSession(o.sessionId);
  if (!s) return null;
  return { id: s.id, channel: s.channel, needSummary: needSummary(s.profile, needVocabulary()) };
}

export function orderView(o: Order): OrderView {
  return {
    id: o.id,
    routeTitle: o.routeTitle,
    travelers: o.travelers,
    departDate: o.departDate,
    totalPrice: o.totalPrice,
    status: o.status,
    createdAt: iso(o.createdAt),
    paidAt: o.paidAt != null ? iso(o.paidAt) : null,
    confirmed: o.confirmedAt != null ? { at: iso(o.confirmedAt), by: o.confirmedBy?.name ?? '' } : null,
    handoffBeforePaid: o.handoffBeforePaid ?? null,
    conversation: orderConversation(o),
  };
}

/** 出发日期只认规范的 YYYY-MM-DD（引擎记画像时就是这个写法） */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** J 页「客户与交接」的需求要素：与 needSummary 同源的三段，加规范写法的出行日期与预算原话的摘要（≤20 字） */
function needOf(s: Session, vocab: NeedVocabulary, viewer: boolean): ConversationDetail['need'] {
  const p = needParts(s.profile, vocab);
  const dates = typeof s.profile.dates === 'string' && ISO_DATE.test(s.profile.dates) ? s.profile.dates : null;
  const budgetRaw = typeof s.profile.budget === 'string' ? cleanText(s.profile.budget.trim(), 20) : '';
  const budget = budgetRaw ? (viewer ? maskNumbers(budgetRaw) : budgetRaw) : null;
  return { ...p, dates, budget };
}

/** GET /conversations/:id 的主体（guarded 由调用方在 db 存储下一次读好这一屏的） */
export function conversationDetail(
  s: Session,
  user: AuthedUser,
  guarded: ReadonlyMap<string, { removed: number; added: number }>,
  now: number,
): ConversationDetail {
  const viewer = user.role === 'viewer';
  const withTurns = tracedInDb(s);
  const mask = (t: string | undefined | null): string | null => (t == null ? null : viewer ? maskNumbers(t) : t);
  const opts: MessageViewOpts = { viewer, withTurns, guarded };
  const messages = windowMessages(s).map(({ m, seq }) =>
    messageView(m, seq, turnIdOf(m) ?? null, s.channel === 'wecom' && m.role === 'agent' ? deliveryOf(s.id, m) : null, opts),
  );
  const vocab = needVocabulary();
  const actor = actorOf(user, null);
  const handles = handlesConversations(actor.role);
  const supervises = supervisesConversations(actor.role);
  const cur = assigneeOf(s);
  const mine = isAssignee(s, actor);
  const declined = consentDeclined(s);
  const q = s.lastQuote;
  return {
    row: conversationRow(s, vocab, viewer),
    messages,
    hasEarlier: withTurns && windowStartOf(s) > 1,
    handoffCard: s.handoff
      ? {
          kind: s.handoff.kind,
          at: iso(s.handoff.at),
          reason: mask(s.handoff.reason)!,
          quote: mask(s.handoff.quote),
          departNote: mask(s.handoff.departNote),
          stageBefore: s.stageBeforeHandoff ?? null,
          assigneeName: cur?.name ?? null,
        }
      : null,
    need: needOf(s, vocab, viewer),
    quote: q
      ? {
          routeId: q.routeId,
          routeTitle: q.routeTitle,
          travelers: q.travelers,
          perPerson: q.perPerson ?? null,
          total: q.total ?? null,
          departDate: q.departDate ?? null,
        }
      : null,
    orders: s.orderIds.flatMap((id) => {
      const o = getOrder(id);
      return o ? [orderView(o)] : [];
    }),
    sendWindow: s.channel === 'wecom' ? sendWindow(s.id, now) : null,
    paymentMode: paymentMode(),
    consentDeclined: declined,
    can: {
      takeover: handles && !cur,
      reply: handles && (!cur || mine),
      release: handles && s.handedOver && (!cur || mine || supervises) && !declined,
      reassign: supervises && !!cur && !mine,
      confirmOrder: handles && (supervises || mine),
      markPaid: handles && (supervises || mine),
      traces: (user.role === 'owner' || user.role === 'admin') && withTurns,
    },
  };
}
