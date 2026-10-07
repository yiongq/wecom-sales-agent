// 接手、交还、人工回复的状态机（docs/architecture/02-conversations-workbench/spec.md「接手、人工回复与交还」，R10、R11）。
// takeover、release 是同步的内存操作（在 identity map 的活对象上比较并设置，单进程下两个并发的接手恰有一个成功），之后 saveSession；
// reply 先同步检查（不通过就什么都不改），再入库、等提交、发送。调用方（后台接口、旧接口）都再 await flushSession(id, { timeoutMs: 5000 })。
// 接手代次是进程内计数，不进 Session：每次成为接手人（含改派）加 1；引擎在 push AI 回复之前、企微适配器在 sendRich 之前拿它比较（不变量 28）。
// 渠道发送经 setReplyTransport 注入（server.ts 按会话的渠道选适配器）：本模块不 import 适配器（适配器反过来 import 本模块的代次）。
import type { Role } from '../shared/console-api.js';
import { shortIdOf } from '../shared/conversation.js';
import { cleanText } from '../shared/text.js';
import { holdSend, humanReplyVerdict } from '../quota/ledger.js';
import {
  conversationRef,
  emitAfterCommit,
  flushSession,
  getOrder,
  getSession,
  queueAudit,
  queueJobs,
  saveSession,
  seqOf,
  storeLagging,
  StoreLaggingError,
  storeUnrecoverable,
  type AuditActor,
} from '../store.js';
import { handoffNotifyOps } from '../jobs/notify.js';
import type { ChatMessage, PushOpts, Session } from '../types.js';
import { enterHandoff, HANDOFF_REASON, terminalStageKey } from './record.js';

/** 操作者：console 成员（role 是成员角色），或 ADMIN_PASS 旧接口的共享工作台（role 'shared'，userId 为 null，权限同坐席） */
export interface Actor {
  userId: string | null;
  name: string;
  role: Role | 'shared';
  /** 审计记的来源地址（spec 的 Actor 没有这一项：审计行要带 IP，见「identity map 与写入」第 5 步） */
  ip?: string | null;
}

/** 共享工作台的名字（spec「转人工记录与四种状态」Assignee.name） */
export const SHARED_WORKBENCH = '共享工作台';
export const sharedActor = (ip: string | null = null): Actor => ({ userId: null, name: SHARED_WORKBENCH, role: 'shared', ip });

/** 成员在后台主动接手、而会话还没转人工时，转人工记录写的原因（共享工作台照旧写「共享工作台转人工」） */
export const MEMBER_TAKEOVER_REASON = '顾问主动接手';

/** 引擎与企微适配器在接手代次变了时记的那一条 system（spec 原文） */
export const TAKEN_OVER_NOTE = '本轮未发送（顾问已接手）';

/** 交还时记的 system 消息：固定模板「{姓名}把会话交还 AI」。匿名可读的旧接口据 isReleaseNote 把它改写成「顾问把会话交还 AI」（不变量 44） */
const RELEASE_SUFFIX = '把会话交还 AI';
export const releaseNote = (name: string): string => `${name}${RELEASE_SUFFIX}`;
/** 按交还模板生成的那一条：system、单行、以模板的后半句结尾 */
export const isReleaseNote = (m: Pick<ChatMessage, 'role' | 'content'>): boolean =>
  m.role === 'system' && m.content.endsWith(RELEASE_SUFFIX) && !m.content.includes('\n');

/** 人工回复没送达时记的 system（与 02 之前的旧 /reply 相同） */
export const REPLY_FAILED_NOTE = '⚠️ 上一条人工回复未能发送到客户（企微发送失败：可能是 48h 会话窗口已关闭或企微配置问题）';
/** 等提交时发现不会再提交（poisoned 或冲突）时记的 system：没发给客户，内容还留在内存里（停机时进 spill，修好原因后重启回放） */
export const REPLY_UNRECOVERABLE_NOTE = '⚠️ 上一条人工回复未能发送到客户（写库失败，请联系技术确认原因后重试）';

const HANDLERS: ReadonlySet<Actor['role']> = new Set(['owner', 'admin', 'supervisor', 'agent', 'shared']);
const SUPERVISORS: ReadonlySet<Actor['role']> = new Set(['owner', 'admin', 'supervisor']);

/** 会话不存在（后台接口 404 conversation_not_found） */
export class ConversationNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super('这个会话已经不在了');
  }
}
/** 别人接手中 → 409 assigned_to_other */
export class AssignedToOtherError extends Error {
  constructor(readonly assigneeName: string) {
    super(`${assigneeName}正在处理这个会话`);
  }
}
/** 企微发送窗口已过或额度用完 → 409 send_window_closed / send_quota_exhausted */
export class SendWindowError extends Error {
  constructor(
    readonly reason: 'window_closed' | 'quota_exhausted',
    readonly closesAt: number | null,
    readonly remaining: number,
    message = reason === 'window_closed' ? '发送窗口已过' : '发送额度已用完',
  ) {
    super(message);
  }
}
/** 角色够、但会话不归你 → 409 not_assignee */
export class NotHandlingError extends Error {
  constructor() {
    super('这个会话不归你处理');
  }
}
/** 角色不够 → 403 forbidden */
export class ForbiddenError extends Error {
  constructor() {
    super('你的角色不能做这件事');
  }
}
/** 客户不同意或撤回了同意，不能交还 AI → 409 consent_declined（R23） */
export class ConsentDeclinedError extends Error {
  constructor() {
    super('客户没有同意处理敏感信息，不能交给 AI');
  }
}
/** 清洗（trim、去 NUL）之后正文为空 → 400 bad_request（审查第 3 条：之前抛 RangeError，两条路径都回 500） */
export class EmptyReplyError extends Error {
  constructor() {
    super('人工回复不能为空');
  }
}
/** 清洗之后仍超过 2000 字 → 400 bad_request（审查第 3 条，与旧 /reply 悄悄截断的那条一起修：不能截断照发） */
export class ReplyTooLongError extends Error {
  constructor() {
    super('人工回复过长（≤2000 字）');
  }
}

const gens = new Map<string, number>();

/** 接手代次：进程内计数，不进 Session */
export function takeoverGen(sessionId: string): number {
  return gens.get(sessionId) ?? 0;
}

/** 接手人是不是这个操作者：成员比 user id，共享工作台与共享工作台算同一个 */
function isMine(assignee: { userId: string | null }, actor: Actor): boolean {
  return actor.userId === null ? assignee.userId === null : assignee.userId === actor.userId;
}

/** 当前的接手人：只有转人工中的会话有 */
export const assigneeOf = (s: Session) => (s.handedOver ? (s.assignee ?? null) : null);

/** 操作者是不是这个会话当前的接手人 */
export function isAssignee(s: Session, actor: Actor): boolean {
  const cur = assigneeOf(s);
  return !!cur && isMine(cur, actor);
}
/** 能处理会话的角色（权限表的 canHandle 加共享工作台） */
export const handlesConversations = (role: Actor['role']): boolean => HANDLERS.has(role);
/** supervisor 以上：改派、交还别人接手的、动任何订单 */
export const supervisesConversations = (role: Actor['role']): boolean => SUPERVISORS.has(role);

function sessionOf(sessionId: string): Session {
  const s = getSession(sessionId);
  if (!s) throw new ConversationNotFoundError(sessionId);
  return s;
}

const auditActorOf = (a: Actor): AuditActor => ({ kind: 'user', userId: a.userId, name: a.name, ip: a.ip ?? null });

/** 会话类审计（spec「后台接口」）：target 是会话行的 ref（不含客户标识，文件存储与 demo 类没有 ref 时为空），diff 带短码 */
function auditConversation(s: Session, actor: Actor, entry: { action: string; diff?: Record<string, unknown> }): void {
  const ref = conversationRef(s.id);
  queueAudit(s.id, auditActorOf(actor), {
    action: entry.action,
    targetType: 'conversation',
    ...(ref ? { targetId: ref } : {}),
    diff: { shortId: shortIdOf(s.id), ...entry.diff },
  });
}

export interface TakeoverResult {
  /** 这次真的成为了接手人（已经是自己时为 false，什么都不改） */
  changed: boolean;
  /** 改派时原来的接手人姓名 */
  reassignedFrom: string | null;
}

/**
 * 没有接手人或接手人就是自己：成为接手人（未转人工时先以 kind='agent' 进入转人工）。
 * 别人接手中：不带 force 抛 AssignedToOtherError；带 force 而角色低于 supervisor（含 agent 与 shared）抛 ForbiddenError；
 * supervisor 以上改派。每次成为接手人（含改派）这个会话的接手代次加 1。viewer 抛 ForbiddenError。
 * 同一段同步代码里：改内存、排审计与事件、saveSession；调用方再 await flushSession
 */
export function takeover(sessionId: string, actor: Actor, opts: { force?: boolean } = {}): TakeoverResult {
  const s = sessionOf(sessionId);
  if (!HANDLERS.has(actor.role)) throw new ForbiddenError();
  const cur = assigneeOf(s);
  if (cur && isMine(cur, actor)) return { changed: false, reassignedFrom: null };
  if (cur && !opts.force) throw new AssignedToOtherError(cur.name);
  if (cur && !SUPERVISORS.has(actor.role)) throw new ForbiddenError();
  const now = Date.now();
  if (!s.handedOver) {
    enterHandoff(s, { kind: 'agent', at: now, reason: actor.role === 'shared' ? HANDOFF_REASON.agent : MEMBER_TAKEOVER_REASON });
    // 接手时才进入的转人工当场就有人处理：enterHandoff 刚排的两个转人工通知（立即、10 分钟没人接手）一并取消，随同一次落库提交
    queueJobs(
      s.id,
      handoffNotifyOps(s.id, now, { escalated: false }).flatMap((op) =>
        op.op === 'enqueue' ? [{ op: 'cancel' as const, dedupeKey: op.dedupeKey }] : [],
      ),
    );
  }
  s.assignee = { userId: actor.userId, name: actor.name, at: now };
  gens.set(s.id, takeoverGen(s.id) + 1);
  emitAfterCommit(s.id, { type: 'conversation.assigned', id: s.id, assigneeName: actor.name });
  auditConversation(s, actor, cur ? { action: 'conversation.reassign', diff: { from: cur.name } } : { action: 'conversation.takeover' });
  saveSession(s);
  return { changed: true, reassignedFrom: cur?.name ?? null };
}

/** 客户不同意或撤回了同意的会话（R23）：session.consent 里任何类别的当前取值是 declined 或 withdrawn */
export function consentDeclined(s: Pick<Session, 'consent'>): boolean {
  return Object.values(s.consent ?? {}).some((v) => v === 'declined' || v === 'withdrawn');
}

/**
 * 交还 AI：接手人本人、supervisor 以上，或会话转人工但没人接手时任何能处理会话的成员（含共享工作台）；其余抛 NotHandlingError。
 * 客户不同意处理敏感信息时抛 ConsentDeclinedError。清 handedOver、handoff、assignee（失败与情绪两个窗口不清，不变量 25）；
 * 阶段按 02 之前旧 /resume 的规则恢复，「已付」照旧按订单读（种子 A01 是「stage=handoff 而订单已付」），写入的是行业包终态。
 * 不给客户发消息，记一条 system「{姓名}把会话交还 AI」。没在转人工中：什么都不改
 */
export function release(sessionId: string, actor: Actor): void {
  const s = sessionOf(sessionId);
  if (!HANDLERS.has(actor.role)) throw new ForbiddenError();
  if (!s.handedOver) return;
  const cur = s.assignee ?? null;
  if (cur && !isMine(cur, actor) && !SUPERVISORS.has(actor.role)) throw new NotHandlingError();
  if (consentDeclined(s)) throw new ConsentDeclinedError();
  s.handedOver = false;
  delete s.handoff;
  delete s.assignee;
  // 只在原阶段是 handoff（被转人工「吸」走）时才还原：否则会把 closing 的客户拉回 quote，终态会话本来就停在终态
  if (s.stage === 'handoff') {
    // 优先用接管前记下的真实阶段；反推只是没有该记录时的兜底。已支付是既成事实，优先级高于记录值（接管期间完成支付）
    const paid = s.orderIds.map((id) => getOrder(id)).some((o) => o?.status === 'paid');
    const done = terminalStageKey();
    const inferred = paid ? done : s.orderIds.length ? 'closing' : s.lastQuote ? 'quote' : 'discovery';
    s.stage = paid ? done : (s.stageBeforeHandoff ?? inferred);
    delete s.stageBeforeHandoff;
  }
  s.messages.push({ role: 'system', content: releaseNote(actor.name), at: Date.now() });
  emitAfterCommit(s.id, { type: 'conversation.released', id: s.id });
  auditConversation(s, actor, { action: 'conversation.release' });
  saveSession(s);
}

// ---------------- 人工回复 ----------------

export interface ReplyResult {
  sent: boolean;
  /** 这条人工回复的 seq（文件存储下只在本进程有效） */
  seq: number;
  /** 发送之前改动已提交；等满 5 秒还没提交时为 false（改动仍在写队列里，停机时进 spill） */
  persisted: boolean;
}

type Transport = (sessionId: string, text: string, opts: PushOpts) => Promise<boolean>;
let transport: Transport = (sessionId) => {
  console.error(`[takeover] 没有接上渠道发送（会话 ${shortIdOf(sessionId) || '?'}）`);
  return Promise.resolve(false);
};
/** server.ts 在模块加载时接上：按会话的渠道选适配器 push */
export function setReplyTransport(fn: Transport): void {
  transport = fn;
}
/** 经会话的渠道发一条（人工回复、后台确认收款之后的付款确认共用）；抛错当没送达 */
export async function pushToChannel(sessionId: string, text: string, opts: PushOpts): Promise<boolean> {
  try {
    return await transport(sessionId, text, opts);
  } catch {
    return false;
  }
}

/** clientId 去重：10 分钟内同一会话、同一 clientId 的重复提交返回第一次的结果，不重发 */
const CLIENT_ID_TTL_MS = 10 * 60_000;
const recent = new Map<string, { at: number; result: Promise<ReplyResult> }>();
function pruneRecent(now: number): void {
  for (const [k, v] of recent) {
    if (now - v.at < CLIENT_ID_TTL_MS) break; // 按插入顺序，越往后越新
    recent.delete(k);
  }
}

/**
 * 人工回复：
 * 1. 同步检查，不通过就什么都不改：别人接手中抛 AssignedToOtherError；企微渠道查发送账本，剩 0 条或窗口已过抛 SendWindowError；
 *    写库积压超过 5 秒、已冲突或这个会话 poisoned 时抛 StoreLaggingError。放行就在同一段同步代码里占一个发送名额（第 12 步）。
 * 2. 没有接手人时先 takeover；push 一条 author='human' 的消息（cleanText，1–2000 字）并 saveSession。
 * 3. await flushSession(id, { timeoutMs: 5000 })，提交之后才发；超时也照发，返回 persisted: false。
 * 4. 经渠道发出（客户侧带「【顾问】」，适配器加）；发送失败追加一条 system 消息并返回 { sent: false }。
 * clientId 相同的重复提交在 10 分钟内返回第一次的结果，不重发。正文不过价格护栏（人可以做承诺）
 */
export function reply(sessionId: string, actor: Actor, text: string, clientId: string): Promise<ReplyResult> {
  try {
    return Promise.resolve(replySync(sessionId, actor, text, clientId));
  } catch (e) {
    return Promise.reject(e);
  }
}

function replySync(sessionId: string, actor: Actor, text: string, clientId: string): Promise<ReplyResult> {
  const now = Date.now();
  pruneRecent(now);
  const key = `${sessionId}\u0000${clientId}`;
  const hit = recent.get(key);
  if (hit) return hit.result;
  const s = sessionOf(sessionId);
  if (!HANDLERS.has(actor.role)) throw new ForbiddenError();
  const cur = assigneeOf(s);
  if (cur && !isMine(cur, actor)) throw new AssignedToOtherError(cur.name);
  // 先清洗（去 NUL、trim）再量，不先按 2000 截断：截断之后还非空就照发等于悄悄截了客户收不到的那一半（审查第 3、10 条）
  const cleaned = cleanText(text.trim()).trim();
  if (!cleaned) throw new EmptyReplyError();
  if (cleanText(cleaned, 2000) !== cleaned) throw new ReplyTooLongError();
  const content = cleaned;
  if (storeLagging(s.id)) throw new StoreLaggingError(s.id);
  const message: ChatMessage = {
    role: 'agent',
    content,
    at: now,
    author: 'human',
    authorId: actor.userId,
    authorName: actor.name,
  };
  let releaseHold = (): void => {};
  if (s.channel === 'wecom') {
    const verdict = humanReplyVerdict(s.id, now);
    if (!verdict.ok) throw new SendWindowError(verdict.reason, verdict.closesAt, verdict.remaining, verdict.message);
    releaseHold = holdSend(s.id, 'human', message);
  }
  // 检查都过了才改：没有接手人（或还没转人工）时先接手，接手人是自己时什么都不改
  if (!cur) takeover(s.id, actor);
  s.messages.push(message);
  saveSession(s);
  const result = deliver(s.id, message, releaseHold);
  recent.set(key, { at: now, result });
  result.catch(() => recent.delete(key));
  return result;
}

/**
 * 等这个会话当前的改动提交（审查第 4、5 条，concurrency[0][1]）：真超时（仍可能提交）返回 persisted:false，调用方照发；
 * 等提交时发现不会再提交（已冲突或这个会话 poisoned）抛 StoreLaggingError，调用方不发、回 503 store_lagging——
 * 不能在「客户收到了、库里没有」和「等满 5 秒也没见底」之间，把「不会再提交」也当成后一种
 */
export async function awaitCommit(sessionId: string): Promise<{ persisted: boolean }> {
  try {
    await flushSession(sessionId, { timeoutMs: 5000 });
    return { persisted: true };
  } catch {
    if (storeUnrecoverable(sessionId)) throw new StoreLaggingError(sessionId);
    return { persisted: false };
  }
}

async function deliver(sessionId: string, message: ChatMessage, releaseHold: () => void): Promise<ReplyResult> {
  const seq = seqOf(message) ?? 0;
  let persisted: boolean;
  try {
    ({ persisted } = await awaitCommit(sessionId));
  } catch (e) {
    // 不会再提交：不发，记一条没发出去的说明（内容还留在内存里，停机时进 spill，修好原因后重启回放）
    releaseHold();
    const s = getSession(sessionId);
    if (s) {
      s.messages.push({ role: 'system', content: REPLY_UNRECOVERABLE_NOTE, at: Date.now() });
      saveSession(s, false);
    }
    throw e;
  }
  let sent = false;
  try {
    sent = await pushToChannel(sessionId, message.content, { kind: 'human', message });
  } finally {
    releaseHold();
  }
  if (!sent) {
    // 发送失败必须让操作者知道：否则后台显示「已回复」、客户实际什么都没收到
    const s = getSession(sessionId);
    if (s) {
      s.messages.push({ role: 'system', content: REPLY_FAILED_NOTE, at: Date.now() });
      saveSession(s, false);
    }
  }
  return { sent, seq, persisted };
}

/** 仅供自测：模拟一次接手的代次变化（不改会话）；清掉 clientId 去重表 */
export const __takeoverTest = {
  bump(sessionId: string): void {
    gens.set(sessionId, takeoverGen(sessionId) + 1);
  },
  resetRecent(): void {
    recent.clear();
  },
  recentSize: (): number => recent.size,
};
