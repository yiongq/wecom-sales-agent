// 入站：channel_inbox（docs/architecture/03-channels-v2/spec.md「入站：channel_inbox」、R2、R3、不变量 1、2、8、11、12）。
// 库里的企微账号用；env 账号照旧用 var/wecom-cursor.json（src/adapters/wecom-state.ts 的 FileWecomState）。
// 一个账号一个 AccountInbox（企微运行时持有它）：
//   load         启动：这个账号的 cursor、恢复截止点、没结束的行（received、recorded、replied），按 ord；没有 cursor 时定冷启动截止
//   acceptPage   sync_msg 拉到一页之后一个事务：按页内顺序把要记的条目插进 channel_inbox（冲突即跳过）并推进 cursor；返回真正新插入的行。
//                提交之后调用方才派发；事务失败（库写不进去）这一页不派发、cursor 不动，下一次拉取重来（入站必须先落库，不走 R6 的照发）
//   beginAttempt 一行真正从会话的处理链里出队、开始处理时，单独一个短事务把 attempts 加 1 并提交，再调引擎（排在队头后面、从没开始处理的
//                行不计次，不变量 11）
// 随会话落库的状态变化（recorded、replied、done、abandoned）不在这里：经 store 的 queueInboxState 进会话那一次落库的主事务（R21）；
// 没有会话可挂的经 writeInboxStateNow 单独一个短事务。出队时的判定（poison、too_old、恢复截止）在适配器的处理链里（src/adapters/wecom.ts）。
// 短事务都经 store 的 withChannelTx（与任务表的短事务同一套拒写规则：已冲突、停机、租户锁在别人手里时不写）。
import type { KfMessage } from '../adapters/wecom-state.js';
import { pgErrorOf, type Tx } from '../db/client.js';
import { readAccountCursor, updateChannelAccount } from '../db/repo/channel-accounts.js';
import { bumpInboxAttempts, insertInboxRows, readOpenInbox, type InboxRecord, type NewInboxRow } from '../db/repo/channel-inbox.js';
import type { InboxAbandonReason, InboxKind, InboxState } from '../shared/channel-types.js';
import { cleanText } from '../shared/text.js';
import { withChannelTx } from '../store.js';

export interface InboxRow {
  id: string;
  /** 插入顺序；派发与恢复都按它 */
  ord: number;
  accountId: string;
  msgid: string;
  kind: InboxKind;
  /** 消息、菜单点击、回执、进入会话事件：id 前缀 + external_userid */
  conversationId: string | null;
  /** 企微 send_time（毫秒） */
  sentAt: number | null;
  state: InboxState;
  attempts: number;
  messageSeq: number | null;
  /** done、abandoned 时为 null */
  payload: InboxPayload | null;
}

/** message、menu_click：企微原样的消息；send_fail：只有 { fail_msgid, fail_type }，不存 external_userid 以外的任何东西 */
export type InboxPayload = KfMessage | { fail_msgid: string; fail_type: number };

/** spec 的 PgInbox：一个账号的入站。方法照 spec 带 accountId（AccountInbox 只认它自己的账号） */
export interface PgInbox {
  load(accountId: string): Promise<{ cursor: string; recordOnlyUntil: number | null; open: InboxRow[] }>;
  acceptPage(accountId: string, msgs: readonly KfMessage[], nextCursor: string): Promise<InboxRow[]>;
  beginAttempt(row: InboxRow): Promise<number>;
}

/**
 * 入站的短事务没写成（库不可用、已冲突、停机、租户锁在别人手里）。code 是 SQLSTATE、errno 码或拒写的原因，message 里只有它：
 * 驱动的报错原文带 SQL 参数（cursor、客户原文），不进日志
 */
export class InboxWriteError extends Error {
  override readonly name = 'InboxWriteError';
  constructor(
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(`channel_inbox 的短事务没写成（${code}）`, options);
  }
}

/** 短事务：失败一律换成 InboxWriteError（只带错误码） */
async function inboxTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withChannelTx(fn);
  } catch (e) {
    if (e instanceof InboxRowGone) throw e;
    const refused = (e as { code?: unknown } | null)?.code;
    const code = pgErrorOf(e).code ?? (typeof refused === 'string' ? refused : e instanceof Error ? e.name : 'unknown');
    throw new InboxWriteError(code, { cause: e });
  }
}

/** beginAttempt：这一行已结束（被清理记了 abandoned、或已被清除），不再处理 */
export class InboxRowGone extends Error {
  override readonly name = 'InboxRowGone';
  constructor() {
    super('入站行已结束或已不在库里');
  }
}

/**
 * 冷启动（没有 cursor）时 sync_msg 会返回近 3 天的消息：启动前 10 分钟之前的直接记 abandoned（cold_start），不派发。
 * 与 env 账号（src/adapters/wecom-state.ts 的 COLD_START_GRACE_MS）同一个口径
 */
const COLD_START_GRACE_MS = 10 * 60 * 1000;
/** channel_inbox.msgid 的 CHECK：1–128 字节 */
const MSGID_MAX_BYTES = 128;

/**
 * 一条企微消息要不要记、记成哪一种（R2，与 02 适配器 drainMessages 的判法与先后相同）：发送失败回执、同意菜单的点击（带 menu_id 的
 * 文本）、进入会话事件、客户发来的消息（origin = 3，含非文本）。其余事件与我们自己发出的回声不记
 */
export function inboxKindOf(msg: KfMessage): Exclude<InboxKind, 'legacy'> | null {
  if (msg.origin === 4 && msg.msgtype === 'event' && msg.event?.event_type === 'msg_send_fail') return 'send_fail';
  if (msg.msgtype === 'text' && msg.text?.menu_id != null) return 'menu_click';
  if (msg.msgtype === 'event' && msg.event?.event_type === 'enter_session') return 'enter_session';
  if (msg.origin === 3) return 'message';
  return null;
}

/** 一段文字能原样进库（非空、不含 NUL、没有孤立代理项） */
const storable = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && cleanText(s) === s;

/** payload 里的字符串一律清洗（NUL 与孤立代理项 json 不收：撞上就整页提交不了，这个账号从此卡在这一页） */
function cleanPayload<T>(v: T): T {
  if (typeof v === 'string') return cleanText(v) as T;
  if (Array.isArray(v)) return v.map((x) => cleanPayload(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanPayload(x)])) as T;
  return v;
}

/** 库里读出的一行换成 spec 的 InboxRow */
export function inboxRowOf(r: InboxRecord): InboxRow {
  return {
    id: r.id,
    ord: Number(r.ord),
    accountId: r.accountId,
    msgid: r.msgid,
    kind: r.kind,
    conversationId: r.conversationId,
    sentAt: r.sentAt ? r.sentAt.getTime() : null,
    state: r.state,
    attempts: r.attempts,
    messageSeq: r.messageSeq,
    payload: (r.payload ?? null) as InboxPayload | null,
  };
}

// ---------------- 告警出口（poison、too_old、恢复截止） ----------------

/** 一行入站在出队时记了 abandoned（只有原因与账号 key，不带会话与原文）。告警 channel 订阅 */
export interface InboxAbandoned {
  reason: InboxAbandonReason;
  account: string;
}
const abandonedListeners = new Set<(e: InboxAbandoned) => void>();
export function onInboxAbandoned(cb: (e: InboxAbandoned) => void): () => void {
  abandonedListeners.add(cb);
  return () => abandonedListeners.delete(cb);
}
export function noteInboxAbandoned(e: InboxAbandoned): void {
  for (const cb of abandonedListeners) {
    try {
      cb(e);
    } catch {
      /* 订阅者出错不影响处理 */
    }
  }
}

// ---------------- 一个账号的入站 ----------------

export interface InboxAccount {
  id: string;
  /** 会话 id 前缀（R11） */
  idPrefix: string;
  /** 日志前缀（带账号 key，不带 corp_id、open_kfid） */
  tag: string;
}

/**
 * 一个库里企微账号的入站状态：拉取位置（cursor，只在 acceptPage 的事务提交之后才在内存里推进）、冷启动截止、恢复截止点，
 * 与 spec PgInbox 的三个方法
 */
export class AccountInbox implements PgInbox {
  readonly kind = 'channel_inbox' as const;
  /** 库里这个账号最近一次随入站提交的 cursor（空串表示还没拉过） */
  cursor = '';
  /** 非 0 表示本进程是冷启动：send_time 早于它的直接记 abandoned（cold_start） */
  coldStartCutoff = 0;
  /** 恢复截止点（R7）：sent_at 不晚于它的消息只补记、不调模型（毫秒；null 没有） */
  recordOnlyUntil: number | null = null;

  constructor(readonly account: InboxAccount) {}

  private own(accountId: string): void {
    if (accountId !== this.account.id) throw new Error('AccountInbox 只管它自己的账号');
  }

  async load(accountId: string): Promise<{ cursor: string; recordOnlyUntil: number | null; open: InboxRow[] }> {
    this.own(accountId);
    const { acct, open } = await inboxTx(async (tx) => ({
      acct: await readAccountCursor(tx, accountId),
      open: await readOpenInbox(tx, accountId),
    }));
    this.cursor = acct?.cursor ?? '';
    this.recordOnlyUntil = acct?.recordOnlyUntil ? acct.recordOnlyUntil.getTime() : null;
    if (!this.cursor) {
      this.coldStartCutoff = Date.now() - COLD_START_GRACE_MS;
      console.warn(
        `${this.account.tag} 无可用 cursor（库里这个账号还没拉过），冷启动：` +
          `${new Date(this.coldStartCutoff).toLocaleString('zh-CN')} 之前的消息只记下、不回复`,
      );
    }
    return { cursor: this.cursor, recordOnlyUntil: this.recordOnlyUntil, open: open.map(inboxRowOf) };
  }

  /**
   * 一个事务：按页内顺序把要记的条目插进 channel_inbox（冲突即跳过）、推进 cursor；返回本次真正新插入的行（按 ord）。
   * 冷启动时早于截止的直接记 abandoned（cold_start）；进入会话事件直接记 done（只为去重）；其余 received、attempts 0。
   * 没有要插的、cursor 也没变时不开事务。存不进库的条目（msgid、external_userid 为空或带 NUL、msgid 超过 128 字节）记一行、不记
   */
  async acceptPage(accountId: string, msgs: readonly KfMessage[], nextCursor: string): Promise<InboxRow[]> {
    this.own(accountId);
    const rows: NewInboxRow[] = [];
    const seen = new Set<string>();
    let cold = 0;
    let unstorable = 0;
    for (const m of msgs) {
      const kind = inboxKindOf(m);
      if (!kind) continue;
      const uid = kind === 'enter_session' || kind === 'send_fail' ? m.event?.external_userid || m.external_userid : m.external_userid;
      if (!storable(m.msgid) || Buffer.byteLength(m.msgid, 'utf8') > MSGID_MAX_BYTES || !storable(uid)) {
        unstorable += 1;
        continue;
      }
      if (kind === 'send_fail' && !storable(m.event?.fail_msgid)) {
        unstorable += 1;
        continue;
      }
      if (seen.has(m.msgid)) continue; // 同一页里重复的 msgid：插一次
      seen.add(m.msgid);
      const sentAt = Number.isFinite(m.send_time) ? new Date(m.send_time * 1000) : null;
      const base = { msgid: m.msgid, kind, conversationId: this.account.idPrefix + uid, sentAt };
      if (this.coldStartCutoff && sentAt !== null && sentAt.getTime() < this.coldStartCutoff) {
        cold += 1;
        rows.push({ ...base, state: 'abandoned', reason: 'cold_start' });
      } else if (kind === 'enter_session') {
        rows.push({ ...base, state: 'done' });
      } else if (kind === 'send_fail') {
        rows.push({
          ...base,
          state: 'received',
          payload: { fail_msgid: m.event!.fail_msgid!, fail_type: Number(m.event?.fail_type ?? 0) },
        });
      } else {
        rows.push({ ...base, state: 'received', payload: cleanPayload(m) });
      }
    }
    if (unstorable) console.error(`${this.account.tag} ⚠️ 这一页有 ${unstorable} 条存不进库（msgid 或 external_userid 不合规），没有记下`);
    const advance = !!nextCursor && nextCursor !== this.cursor;
    if (!rows.length && !advance) return [];
    const inserted = await inboxTx(async (tx) => {
      const ins = rows.length ? await insertInboxRows(tx, accountId, rows) : [];
      if (advance) await updateChannelAccount(tx, accountId, { cursor: nextCursor, cursorAt: new Date() });
      return ins;
    });
    // 提交之后才推进内存里的 cursor：事务失败时下一次拉取还从旧的 cursor 拉
    if (advance) this.cursor = nextCursor;
    if (cold) console.warn(`${this.account.tag} 冷启动：${cold} 条启动前的历史消息只记下（abandoned），不回复`);
    return inserted.map(inboxRowOf);
  }

  /**
   * 出队开始处理：单独一个短事务 attempts + 1 并提交，返回加之后的值。只在库里还是 row.attempts 时加（幂等：同一次出队的重试不会
   * 加两次）。行已结束或已不在库里抛 InboxRowGone；库不可写、提交结果不明时抛 InboxWriteError（调用方带同一个 row 重试）
   */
  async beginAttempt(row: InboxRow): Promise<number> {
    this.own(row.accountId);
    // 以出队时读到的 attempts 为条件（同一次出队重试几次也只加一次：上一次的提交回包丢了，这一次读回已加的值）
    const n = await inboxTx((tx) => bumpInboxAttempts(tx, row.id, row.attempts));
    if (n === null) throw new InboxRowGone();
    return n;
  }

  /** 仅供自测：内存清回刚建出来的样子（库里的不动） */
  resetForTest(): void {
    this.cursor = '';
    this.coldStartCutoff = 0;
    this.recordOnlyUntil = null;
  }
}
