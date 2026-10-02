// PG 会话后端（docs/architecture/02-conversations-workbench/spec.md「identity map 与写入」，R2、R4、R7）：
// 分批预载、每会话写队列与合并、一次落库的七步、进快照即冻结、失败两类与 poisoned、撞上另一写者即优雅停机、
// drain 段排空、exit 时的 spill 与启动时的回放。
// 内存里的两张 Map（store.ts 持有）是本进程的权威，PG 是持久副本；只管真实会话，demo 类仍归文件后端（R6）。
// 经 src/db/repo/** 与 client.ts 的 withTenant 访问库（pg、drizzle-orm 只在 src/db/**）。
// 落库事务的回调里只有 SQL：不调模型、不发企微、不等别的会话（不变量 9）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pgErrorOf, trySavepoint, withTenant, type Db, type TenantCtx, type Tx } from '../db/client.js';
import { writeAuditAs, type AuditEntry } from '../db/repo/audit.js';
import { appendConsents, type ConsentRow } from '../db/repo/consents.js';
import {
  insertConversation,
  lockConversation,
  readConversationsAfter,
  updateConversation,
  type ConversationSeqs,
} from '../db/repo/conversations.js';
import { cancelPendingJobs, enqueueJob, setJobStatus, type JobKind, type JobStatus } from '../db/repo/jobs.js';
import { insertMessages, readMessagesFrom, readRecentCustomerMsgids, readWindowMessages } from '../db/repo/messages.js';
import { readLiveOrders, upsertOrders } from '../db/repo/orders.js';
import { insertOutboundSends, type OutboundSendRow } from '../db/repo/outbound.js';
import { insertGuardEvents, insertTurnTraces, type GuardEventRow, type TurnTraceRow } from '../db/repo/traces.js';
import { shortIdOf } from '../shared/conversation.js';
import type { ChatMessage, Order, Session } from '../types.js';
import { SessionStoreStartupError, StoreConflictError, StoreLaggingError, type StoreBackend, type StoreHealth } from './backend.js';
import { deliverCommitted, type DomainEvent } from './events.js';
import {
  conversationValuesFrom,
  isDemoClassId,
  lastCustomerAtOf,
  messageToRow,
  normalizeForStore,
  orderToRow,
  ProjectionError,
  rowToMessage,
  rowToOrder,
  rowToSession,
  sessionState,
  type ConversationValuesShape,
  type MessageRowShape,
  type OrderRowShape,
} from './project.js';
import { assignSeqs, lastSeqOf, seedSeqs, seqOf, WindowCorruptError, windowStartOf } from './seq.js';

// 模块加载时取一个空的异步上下文：每次落库都在它里面启动。在 withTenant 回调或轮次上下文里调 saveSession，
// 排出的落库也不继承那个上下文（withTenant 不能嵌套，轮次的 trace 也不该串进落库）
const detached = AsyncLocalStorage.snapshot();

/** 预载每批的会话数（R2）：每条语句都在 agent_app 的 5 秒语句超时之内 */
const PRELOAD_BATCH = 500;
/** 企微去重集合：预载最近 7 天带 msgid 的客户消息 */
const MSGID_WINDOW_MS = 7 * 86_400_000;
/** 连接与超时类失败的退避：1 秒、5 秒、30 秒、2 分钟，之后每 2 分钟 */
const RETRY_MS = [1_000, 5_000, 30_000, 120_000];
/** 单个落库事务超过它记一行 warn 并计数 */
const SLOW_TX_MS = 2_000;
const SPILL_RE = /^store-spill-.+\.json$/;

// ---------------- 排进下一次落库的附带行 ----------------

export type AuditActor = TenantCtx['actor'];
/** 一行审计：各自带操作者与 IP（合批时分不清操作者，所以不用事务的上下文） */
export interface AuditItem {
  actor: AuditActor;
  entry: AuditEntry;
}
/** 任务的排程与状态变化（第 10 步起有生产者）；时间是毫秒，能原样写进 spill */
export type JobOp =
  | { op: 'enqueue'; kind: JobKind; dedupeKey: string; runAt: number; payload: unknown; maxAttempts: number }
  | { op: 'cancel'; dedupeKey: string }
  | {
      op: 'status';
      id: string;
      status: JobStatus;
      from?: JobStatus[];
      lastError?: string | null;
      attemptsDelta?: number;
      runAt?: number;
    };
/** 同意记录（第 16 步起有生产者）：会话 id 由落库补上，时间是毫秒 */
export type ConsentItem = Omit<ConsentRow, 'conversationId' | 'at'> & { at: number };
/** 写在存档点里的几类（第 9、12 步起有生产者）：写失败只丢这几行，会话照常提交；不进 spill */
export interface TelemetryRows {
  traces?: TurnTraceRow[];
  guards?: GuardEventRow[];
  outbound?: OutboundSendRow[];
}

// ---------------- spill 文件 ----------------

interface SpillOrder {
  order: Record<string, unknown>;
  voided: { at: number; reason: 'reset' | 'resync' } | null;
}
interface SpillSideRows {
  audits: AuditItem[];
  jobs: JobOp[];
  consents: ConsentItem[];
}
/** spill 文件里的一个会话（spec「停机」）：已提交到第几条、没提交的消息连同 seq、会话投影、排着的订单与附带行；trace 与账本行不写 */
interface SpillEntry extends SpillSideRows {
  id: string;
  committedSeq: number;
  /** 在途（或等着重试）的那次落库：提交没得到确认。回放时库里的 flush_id 是它，说明它其实提交了，只补它之后的 */
  inflight: (SpillSideRows & { flushId: string; lastSeq: number }) | null;
  /** 回放这一条用的 flush_id：回放提交之后、删掉 spill 文件之前崩溃，再回放时据此认出已经回放过 */
  flushId: string;
  lastSeq: number;
  windowStartSeq: number;
  messages: { seq: number; message: ChatMessage }[];
  state: Record<string, unknown>;
  lastCustomerAt: number | null;
  orders: SpillOrder[];
  poisoned: string | null;
}
interface SpillDoc {
  version: 1;
  tenant: string;
  at: number;
  sessions: SpillEntry[];
}

// ---------------- 写队列 ----------------

/** 一次落库的快照：第一个 await 之前同步取好，消息进快照即冻结 */
interface Snap {
  flushId: string;
  /** 快照取到的改动代次：提交后 committedGen = gen */
  gen: number;
  /** 库里应当已提交到第几条 */
  baseSeq: number;
  lastSeq: number;
  windowStartSeq: number;
  messages: MessageRowShape[];
  values: ConversationValuesShape;
  orders: OrderRowShape[];
  audits: AuditItem[];
  jobs: JobOp[];
  consents: ConsentItem[];
  telemetry: Required<TelemetryRows>;
  events: DomainEvent[];
}

interface Waiter {
  gen: number;
  resolve(): void;
  reject(e: Error): void;
}

interface Entry {
  id: string;
  session: Session;
  /** 库里有这个会话的行（预载来的，或提交过一次） */
  inDb: boolean;
  /** 已提交到第几条（库里的 last_seq） */
  committedSeq: number;
  /** 分配了 seq 而还没提交的消息，按 seq 排；分配之后被重置、裁剪掉的也在（照样落库） */
  pending: ChatMessage[];
  /** 改动代次：每次改动加 1；committedGen 是已提交的那一代 */
  gen: number;
  committedGen: number;
  /** 最早一次没提交的改动的时刻；sinceNext 是在途快照之后的第一次改动 */
  since: number | null;
  sinceNext: number | null;
  inflight: Snap | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
  /** 数据类错误停写的原因（SQLSTATE 与约束名、window_corrupt、projection） */
  poisoned: string | null;
  orderIds: Set<string>;
  voids: Map<string, OrderRowShape>;
  audits: AuditItem[];
  jobs: JobOp[];
  consents: ConsentItem[];
  telemetry: Required<TelemetryRows>;
  events: DomainEvent[];
  waiters: Set<Waiter>;
  /** 企微去重集合：预载的最近 7 天，加上本进程分配过 seq 的客户消息 */
  msgids: Set<string>;
}

export interface PgBackendDeps {
  db: Db;
  tenantId: string;
  varDir: string;
  sessions: Map<string, Session>;
  orders: Map<string, Order>;
  /** 落库撞上另一写者：store.ts 接到 gracefulExit(1) */
  onConflict(detail: string): void;
  /** 租户锁还在本进程手里。被别的进程拿走（held_by_other）时 drain 不写库，直接 spill */
  writable(): boolean;
}

export interface PgStoreStats {
  /** 发起的落库事务（含重试） */
  attempts: number;
  commits: number;
  /** COMMIT 时断线、重试时按 flush_id 认出上一次其实提交了 */
  recognized: number;
  retries: number;
  slowTx: number;
  /** 存档点里写失败、丢掉的 trace / 护栏事件 / 账本批次 */
  telemetryDropped: number;
  /** saveSession 收到与 identity map 里不同的同 id 对象、拒绝落库的次数 */
  foreign: number;
  /** 启动时回放的 spill 会话数（应用的，与认出已经在库里而跳过的） */
  replayed: number;
  replaySkipped: number;
}

export interface PgBackend extends StoreBackend {
  /** 把预载的会话与订单放进 identity map（initSessionStore 在全部校验通过之后同步调） */
  install(): void;
  /** saveSession 之前：map 里有同 id 的另一个对象就拒绝（日志一行、不落库），不变量 3 */
  accepts(s: Session): boolean;
  /** deleteOrdersOfSession：订单记作废（voided_at、void_reason），调用方随后把它移出内存 */
  voidOrder(o: Order, reason: 'reset' | 'resync'): void;
  queueAudit(sessionId: string, item: AuditItem): void;
  queueJobs(sessionId: string, ops: readonly JobOp[]): void;
  queueConsents(sessionId: string, items: readonly ConsentItem[]): void;
  queueTelemetry(sessionId: string, rows: TelemetryRows): void;
  /** demo 类会话的审计：单独一个短事务（R6） */
  writeStandaloneAudit(item: AuditItem): Promise<void>;
  recentMsgids(sessionId: string): ReadonlySet<string>;
  /** late 段：此后不再发起落库，退避中的重试也停掉；没落库的留给 exit 时的 spill */
  close(): void;
  stats(): PgStoreStats;
}

const systemCtx = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });

/** 失败分两类（spec「失败」）：conflict 与 data 不重试，其余重试 */
function classify(err: unknown): 'conflict' | 'data' | 'retry' {
  if (err instanceof StoreConflictError) return 'conflict';
  if (err instanceof WindowCorruptError || err instanceof ProjectionError) return 'data';
  const { code } = pgErrorOf(err);
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    // 22 数据（text 里的 NUL 之类）、23 约束、42 权限与语法：重来一遍还是一样
    if (/^(22|23|42)/.test(code)) return 'data';
    // 08 连接、40001 / 40P01、57014 语句超时、53 资源、57P 停机，以及 spec 没点名的类：退避重试
    return 'retry';
  }
  // 网络层的 errno 码与不带码的「连接意外中断」是连接类；不带码的 TypeError / RangeError 是确定性的程序错误
  if (!code && (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError)) return 'data';
  return 'retry';
}

/** 日志与 lastError 里的错误：只有错误码与约束名，不带 err.detail 与 err.message（可能带客户原话） */
function errLabel(err: unknown): string {
  if (err instanceof StoreConflictError) return 'store_conflict';
  if (err instanceof WindowCorruptError) return 'window_corrupt';
  if (err instanceof ProjectionError) return `projection ${err.field}`;
  const { code, constraint } = pgErrorOf(err);
  if (code) return constraint ? `${code} ${constraint}` : code;
  return err instanceof Error ? err.name : 'unknown';
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
/** 日志只写短码，不写会话原 id（会话 id 里有 external_userid） */
const short = (id: string): string => shortIdOf(id) || '?';

class AlreadyCommitted extends Error {}

// ---------------- 预载 ----------------

interface Preloaded {
  sessions: Session[];
  orders: Order[];
  seqs: Map<string, ConversationSeqs>;
  msgids: Map<string, Set<string>>;
}

/** 分批预载全部真实会话、窗口内的消息、未作废订单与 7 天 msgid 集合，并逐批校验（R2）。整个预载一个只读的长事务 */
async function preload(d: PgBackendDeps): Promise<Preloaded> {
  const out: Preloaded = { sessions: [], orders: [], seqs: new Map(), msgids: new Map() };
  const since = new Date(Date.now() - MSGID_WINDOW_MS);
  try {
    await withTenant(
      d.db,
      systemCtx(d.tenantId),
      async (tx) => {
        let after: string | null = null;
        for (;;) {
          const rows = await readConversationsAfter(tx, after, PRELOAD_BATCH);
          if (!rows.length) break;
          const ids = rows.map((r) => r.id);
          const msgs = await readWindowMessages(tx, ids);
          const ords = await readLiveOrders(tx, ids);
          const mids = await readRecentCustomerMsgids(tx, ids, since);
          const byConv = new Map<string, typeof msgs>();
          for (const m of msgs) {
            const list = byConv.get(m.conversationId) ?? [];
            list.push(m);
            byConv.set(m.conversationId, list);
          }
          const batch = new Set(ids);
          for (const row of rows) {
            if (isDemoClassId(row.id)) throw new SessionStoreStartupError('demo_class_in_db', `库里有 demo 类会话 ${short(row.id)}`);
            const list = byConv.get(row.id) ?? [];
            const consistent =
              list.length === row.lastSeq - row.windowStartSeq + 1 && list.every((m, i) => m.seq === row.windowStartSeq + i);
            if (!consistent) {
              throw new SessionStoreStartupError(
                'preload_integrity',
                `会话 ${short(row.id)} 的 last_seq=${row.lastSeq}、window_start_seq=${row.windowStartSeq}，窗口里却是 ${list.length} 条`,
              );
            }
            const session = rowToSession(row, list.map(rowToMessage));
            seedSeqs(session, row.windowStartSeq);
            for (const m of session.messages) Object.freeze(m);
            out.sessions.push(session);
            out.seqs.set(row.id, { lastSeq: row.lastSeq, windowStartSeq: row.windowStartSeq, flushId: row.flushId });
            out.msgids.set(row.id, new Set());
          }
          for (const r of mids) out.msgids.get(r.conversationId)?.add(r.msgid);
          for (const r of ords) {
            const o = rowToOrder(r);
            if (r.sessionId === null || !batch.has(r.sessionId) || o.sessionId !== r.sessionId || o.id !== r.id) {
              throw new SessionStoreStartupError('orphan_order', `订单 ${r.id} 的 data 与列对不上，或引用的会话不在库里`);
            }
            out.orders.push(o);
          }
          after = rows.at(-1)!.id;
          if (rows.length < PRELOAD_BATCH) break;
        }
      },
      { isolation: 'repeatable read', readOnly: true, longRunning: true },
    );
  } catch (e) {
    if (e instanceof SessionStoreStartupError) throw e;
    throw new SessionStoreStartupError('db_unreachable', `预载失败（${errLabel(e)}）`);
  }
  return out;
}

// ---------------- spill 回放 ----------------

const rowSide = (side: SpillSideRows, extra?: SpillSideRows): SpillSideRows => ({
  audits: [...side.audits, ...(extra?.audits ?? [])],
  jobs: [...side.jobs, ...(extra?.jobs ?? [])],
  consents: [...side.consents, ...(extra?.consents ?? [])],
});

async function writeSideRows(tx: Tx, sessionId: string, side: SpillSideRows): Promise<void> {
  for (const a of side.audits) await writeAuditAs(tx, a.actor, a.entry);
  for (const j of side.jobs) {
    if (j.op === 'enqueue') {
      await enqueueJob(tx, {
        kind: j.kind,
        dedupeKey: j.dedupeKey,
        runAt: new Date(j.runAt),
        payload: j.payload,
        maxAttempts: j.maxAttempts,
      });
    } else if (j.op === 'cancel') {
      await cancelPendingJobs(tx, j.dedupeKey);
    } else {
      await setJobStatus(tx, j.id, j.status, {
        from: j.from,
        lastError: j.lastError,
        attemptsDelta: j.attemptsDelta,
        runAt: j.runAt === undefined ? undefined : new Date(j.runAt),
      });
    }
  }
  await appendConsents(
    tx,
    side.consents.map((c) => ({ ...c, conversationId: sessionId, at: new Date(c.at) })),
  );
}

const spillOrderRow = (o: SpillOrder): OrderRowShape => orderToRow(o.order as unknown as Order, o.voided ?? undefined);

/**
 * 回放 spill 里的一个会话（spec「spill 回放」）：
 * 库里的 flush_id 就是这一条的 → 回放过了，跳过；库里是在途那次的 flush_id 与 last_seq → 在途那次其实提交了，只补它之后的；
 * 库里的 last_seq 等于「已提交到第几条」→ 按一次落库写入；已经等于文件里最后一条的 seq 且内容一致 → 跳过；其余接不上
 */
async function replayEntry(tx: Tx, entry: SpillEntry): Promise<'applied' | 'skipped' | 'conflict'> {
  const row = await lockConversation(tx, entry.id);
  if (row && row.flushId === entry.flushId) return row.lastSeq === entry.lastSeq ? 'skipped' : 'conflict';
  let base: number;
  let side: SpillSideRows;
  if (entry.inflight && row && row.flushId === entry.inflight.flushId && row.lastSeq === entry.inflight.lastSeq) {
    base = entry.inflight.lastSeq;
    side = rowSide(entry);
  } else if ((row?.lastSeq ?? 0) === entry.committedSeq && (row !== null || entry.committedSeq === 0)) {
    base = entry.committedSeq;
    side = entry.inflight ? rowSide(entry.inflight, entry) : rowSide(entry);
  } else if (row && row.lastSeq === entry.lastSeq && entry.messages.length) {
    const inDb = await readMessagesFrom(tx, entry.id, entry.messages[0]!.seq);
    const want = entry.messages.map((m) => rowToMessage(messageToRow(m.message, m.seq)));
    return isDeepStrictEqual(inDb.map(rowToMessage), want) ? 'skipped' : 'conflict';
  } else {
    return 'conflict';
  }
  const values = conversationValuesFrom(entry.state, entry.lastCustomerAt);
  if (!row) await insertConversation(tx, values);
  await insertMessages(
    tx,
    entry.id,
    entry.messages.filter((m) => m.seq > base).map((m) => messageToRow(m.message, m.seq)),
  );
  await updateConversation(tx, values, { lastSeq: entry.lastSeq, windowStartSeq: entry.windowStartSeq, flushId: entry.flushId });
  await upsertOrders(tx, entry.orders.map(spillOrderRow));
  await writeSideRows(tx, entry.id, side);
  return 'applied';
}

/**
 * 按时间顺序回放 var/ 下的 spill 文件。接不上以 spill_conflict 拒绝启动（文件留着）；某条回放仍然失败（数据类错误）就把
 * 文件改名 .failed、记一行，从库里的状态起；全部成功就删掉文件。返回回放与跳过的会话数
 */
async function replaySpills(d: PgBackendDeps): Promise<{ applied: number; skipped: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(d.varDir).filter((f) => SPILL_RE.test(f));
  } catch {
    return { applied: 0, skipped: 0 };
  }
  let applied = 0;
  let skipped = 0;
  for (const name of names.toSorted()) {
    const file = path.join(d.varDir, name);
    let doc: SpillDoc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8')) as SpillDoc;
    } catch {
      fs.renameSync(file, `${file}.failed`);
      console.error(`[store] spill 文件 ${name} 读不出来，已改名 .failed，从库里的状态起`);
      continue;
    }
    if (doc.tenant !== d.tenantId) throw new SessionStoreStartupError('spill_conflict', `${name} 不是本租户的 spill`);
    let failed = false;
    for (const entry of doc.sessions) {
      let r: 'applied' | 'skipped' | 'conflict';
      try {
        r = await detached(() => withTenant(d.db, systemCtx(d.tenantId), (tx) => replayEntry(tx, entry)));
      } catch (e) {
        if (classify(e) === 'retry') throw new SessionStoreStartupError('db_unreachable', `回放 ${name} 时连不上库（${errLabel(e)}）`);
        failed = true;
        console.error(`[store] 回放 ${name} 里的会话 ${short(entry.id)} 失败（${errLabel(e)}）`);
        continue;
      }
      if (r === 'conflict') {
        throw new SessionStoreStartupError('spill_conflict', `${name} 里的会话 ${short(entry.id)} 接不上库里的 last_seq`);
      }
      if (r === 'applied') applied++;
      else skipped++;
    }
    if (failed) {
      fs.renameSync(file, `${file}.failed`);
      console.error(`[store] spill 文件 ${name} 有会话回放失败，已改名 .failed，从库里的状态起（修好原因后改回原名再启动）`);
    } else fs.unlinkSync(file);
  }
  return { applied, skipped };
}

// ---------------- 后端 ----------------

/**
 * 预载 → 校验 → 回放 spill（回放过就再预载一遍）→ 返回还没装上的后端。不改 identity map：任何一步失败都以
 * SessionStoreStartupError reject，不留半装载状态；全部通过之后由调用方 install()
 */
export async function openPgBackend(d: PgBackendDeps): Promise<PgBackend> {
  let pre = await detached(() => preload(d));
  const replay = await replaySpills(d);
  if (replay.applied) pre = await detached(() => preload(d));
  return createBackend(d, pre, replay);
}

function createBackend(d: PgBackendDeps, pre: Preloaded, replay: { applied: number; skipped: number }): PgBackend {
  const ctx = systemCtx(d.tenantId);
  const entries = new Map<string, Entry>();
  let conflict = false;
  let closed = false;
  let lastError: string | null = null;
  const stats: PgStoreStats = {
    attempts: 0,
    commits: 0,
    recognized: 0,
    retries: 0,
    slowTx: 0,
    telemetryDropped: 0,
    foreign: 0,
    replayed: replay.applied,
    replaySkipped: replay.skipped,
  };

  const emptyTelemetry = (): Required<TelemetryRows> => ({ traces: [], guards: [], outbound: [] });
  const newEntry = (s: Session, inDb: boolean, committedSeq: number, msgids: Set<string>): Entry => ({
    id: s.id,
    session: s,
    inDb,
    committedSeq,
    pending: [],
    gen: 0,
    committedGen: 0,
    since: null,
    sinceNext: null,
    inflight: null,
    attempts: 0,
    timer: null,
    poisoned: null,
    orderIds: new Set(),
    voids: new Map(),
    audits: [],
    jobs: [],
    consents: [],
    telemetry: emptyTelemetry(),
    events: [],
    waiters: new Set(),
    msgids,
  });

  /** 这个会话的写队列。不是预载来的：新建的会话（seq 从 1 起），或第 6 步之前 JSON 里读来的真实会话——窗口整段都还没提交 */
  function entryOf(s: Session): Entry {
    let e = entries.get(s.id);
    if (!e) {
      e = newEntry(s, false, 0, new Set());
      for (const m of Array.isArray(s.messages) ? s.messages : []) if (m && seqOf(m) !== undefined) e.pending.push(m);
      // 孤儿订单（所属会话不在内存里，留在 orders.json）在同 id 的会话又建出来时转归 PG（plan 第 2 步）
      for (const o of d.orders.values()) if (o.sessionId === s.id) e.orderIds.add(o.id);
      entries.set(s.id, e);
    }
    return e;
  }
  const entryById = (id: string): Entry | null => {
    const s = d.sessions.get(id);
    return s ? entryOf(s) : null;
  };
  const isDirty = (e: Entry): boolean => e.gen !== e.committedGen;

  function change(e: Entry): void {
    e.gen++;
    const now = Date.now();
    e.since ??= now;
    if (e.inflight) e.sinceNext ??= now;
    kick(e);
  }

  function rejectWaiters(e: Entry): void {
    for (const w of e.waiters) w.reject(new StoreLaggingError(e.id));
    e.waiters.clear();
  }

  function poison(e: Entry, label: string): void {
    if (e.poisoned) return;
    e.poisoned = label;
    lastError = `${label} · ${short(e.id)}`;
    console.error(`[store] 会话 ${short(e.id)} 停止落库（${label}）：内存照旧服务客户，停机时写进 spill；修好原因后重启回放`);
    rejectWaiters(e);
  }

  /** 第一个 await 之前同步取好快照（第 1 步）：没提交的消息进快照即冻结，排着的附带行一起移进快照 */
  function takeSnapshot(e: Entry): Snap {
    const s = e.session;
    for (const m of e.pending) Object.freeze(m);
    const lastSeq = lastSeqOf(s);
    const tail = e.pending.at(-1);
    if ((tail ? seqOf(tail) : e.committedSeq) !== lastSeq) {
      throw new WindowCorruptError(s.id, `没提交的消息到 seq ${tail ? seqOf(tail) : e.committedSeq}，会话却分配到了 ${lastSeq}`);
    }
    const orders: OrderRowShape[] = [];
    for (const id of e.orderIds) {
      const o = d.orders.get(id);
      if (o) orders.push(orderToRow(o));
    }
    orders.push(...e.voids.values());
    const snap: Snap = {
      flushId: randomUUID(),
      gen: e.gen,
      baseSeq: e.committedSeq,
      lastSeq,
      windowStartSeq: windowStartOf(s),
      messages: e.pending.map((m) => messageToRow(m, seqOf(m)!)),
      values: conversationValuesFrom(sessionState(s), lastCustomerAtOf(s.messages)),
      orders,
      audits: e.audits,
      jobs: e.jobs,
      consents: e.consents,
      telemetry: e.telemetry,
      events: e.events,
    };
    e.orderIds = new Set();
    e.voids = new Map();
    e.audits = [];
    e.jobs = [];
    e.consents = [];
    e.telemetry = emptyTelemetry();
    e.events = [];
    e.sinceNext = null;
    return snap;
  }

  /** 排一次落库：同一会话至多一个在途，在途期间的改动合并成它提交之后的那一次 */
  function kick(e: Entry): void {
    if (closed || conflict || e.poisoned || e.inflight || !isDirty(e)) return;
    detached(() => {
      let snap: Snap;
      try {
        snap = takeSnapshot(e);
      } catch (err) {
        poison(e, errLabel(err));
        return;
      }
      e.inflight = snap;
      void runFlush(e, snap);
    });
  }

  /** 一次落库的第 2–6 步（第 7 步 COMMIT 由 withTenant 做） */
  async function writeSnap(tx: Tx, e: Entry, snap: Snap): Promise<void> {
    // 2 锁会话行；没有就插入（last_seq = 0）
    let cur = await lockConversation(tx, e.id);
    if (!cur) {
      if (e.inDb || snap.baseSeq !== 0) throw new StoreConflictError(e.id, `会话 ${short(e.id)} 的行不在库里了`);
      await insertConversation(tx, snap.values);
      cur = { lastSeq: 0, windowStartSeq: 1, flushId: null };
    }
    if (cur.flushId === snap.flushId) {
      // 上一次尝试其实提交了（COMMIT 时断线）：回滚本事务，补做提交后的步骤
      if (cur.lastSeq === snap.lastSeq) throw new AlreadyCommitted();
      throw new StoreConflictError(e.id, `会话 ${short(e.id)} 的 flush_id 是本次的，last_seq 却是 ${cur.lastSeq}`);
    }
    if (cur.lastSeq !== snap.baseSeq) {
      throw new StoreConflictError(e.id, `会话 ${short(e.id)} 库里 last_seq=${cur.lastSeq}，预期 ${snap.baseSeq}`);
    }
    // 3 按 seq 插消息
    await insertMessages(tx, e.id, snap.messages);
    // 4 会话行：投影列、state、last_seq、window_start_seq、updated_at、flush_id
    await updateConversation(tx, snap.values, { lastSeq: snap.lastSeq, windowStartSeq: snap.windowStartSeq, flushId: snap.flushId });
    // 5 订单、审计（各自的操作者）、任务、同意记录
    await upsertOrders(tx, snap.orders);
    await writeSideRows(tx, e.id, snap);
    // 6 存档点里写 trace、护栏事件、账本行：出错只丢这几行，会话照常提交
    const t = snap.telemetry;
    if (t.traces.length || t.guards.length || t.outbound.length) {
      const r = await trySavepoint(tx, 'telemetry', async () => {
        await insertTurnTraces(tx, t.traces);
        await insertGuardEvents(tx, t.guards);
        await insertOutboundSends(tx, t.outbound);
      });
      if (!r.ok) {
        stats.telemetryDropped++;
        console.warn(`[store] 会话 ${short(e.id)} 的 trace / 护栏事件 / 账本行写入失败（${errLabel(r.error)}），已丢弃这几行`);
      }
    }
  }

  async function runFlush(e: Entry, snap: Snap): Promise<void> {
    stats.attempts++;
    const t0 = Date.now();
    let error: unknown = null;
    let recognized = false;
    try {
      await withTenant(d.db, ctx, (tx) => writeSnap(tx, e, snap));
    } catch (err) {
      if (err instanceof AlreadyCommitted) recognized = true;
      else error = err;
    }
    const ms = Date.now() - t0;
    if (ms > SLOW_TX_MS) {
      stats.slowTx++;
      console.warn(`[store] 会话 ${short(e.id)} 的一次落库用了 ${ms}ms（超过 ${SLOW_TX_MS}ms）`);
    }
    if (error === null) {
      if (recognized) {
        stats.recognized++;
        console.warn(`[store] 会话 ${short(e.id)} 上一次落库其实已经提交（按 flush_id 认出），补做提交后的步骤`);
      }
      afterCommit(e, snap);
    } else failed(e, snap, error);
  }

  /** 第 7 步之后：记下已提交到第几条，把排在这次落库上的领域事件交给订阅者，放行在等的 flush，接着排下一次 */
  function afterCommit(e: Entry, snap: Snap): void {
    stats.commits++;
    e.inflight = null;
    e.attempts = 0;
    e.inDb = true;
    e.committedSeq = snap.lastSeq;
    e.pending = e.pending.filter((m) => (seqOf(m) ?? 0) > snap.lastSeq);
    e.committedGen = snap.gen;
    e.since = isDirty(e) ? (e.sinceNext ?? Date.now()) : null;
    e.sinceNext = null;
    deliverCommitted(snap.events);
    for (const w of e.waiters) {
      if (w.gen <= e.committedGen) {
        e.waiters.delete(w);
        w.resolve();
      }
    }
    kick(e);
  }

  function failed(e: Entry, snap: Snap, err: unknown): void {
    const label = errLabel(err);
    const kind = classify(err);
    if (kind === 'conflict') {
      if (conflict) return;
      conflict = true;
      lastError = `store_conflict · ${short(e.id)}`;
      console.error(
        `[store] store_conflict：会话 ${short(e.id)} 落库时发现另一写者（库里的 last_seq 与预期不符），优雅停机，没落库的写进 spill`,
      );
      for (const x of entries.values()) rejectWaiters(x);
      d.onConflict(`会话 ${short(e.id)}`);
      return;
    }
    if (kind === 'data') {
      poison(e, label);
      return;
    }
    lastError = `${label} · ${short(e.id)}`;
    if (closed) return; // late 段之后不再重试：没提交的随 spill 写出
    e.attempts++;
    stats.retries++;
    const delay = RETRY_MS[Math.min(e.attempts - 1, RETRY_MS.length - 1)]!;
    console.warn(`[store] 会话 ${short(e.id)} 落库失败（${label}），第 ${e.attempts} 次，${delay / 1000} 秒后重试`);
    e.timer = setTimeout(() => {
      e.timer = null;
      if (!closed && !conflict) detached(() => void runFlush(e, snap));
    }, delay);
    e.timer.unref();
  }

  /** 等这个会话当前的改动提交，或者到 deadline（drain 用：到点就放弃，不 reject） */
  function settled(e: Entry, deadline: number): Promise<void> {
    if (!isDirty(e) || e.poisoned) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const w: Waiter = {
        gen: e.gen,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(
        () => {
          e.waiters.delete(w);
          resolve();
        },
        Math.max(0, deadline - Date.now()),
      );
      e.waiters.add(w);
    });
  }

  function spillEntryOf(e: Entry): SpillEntry {
    const s = e.session;
    const inf = e.inflight;
    const orders = new Map<string, SpillOrder>();
    const put = (r: OrderRowShape): void => {
      orders.set(r.id, { order: r.data, voided: r.voidedAt ? { at: r.voidedAt.getTime(), reason: r.voidReason ?? 'reset' } : null });
    };
    for (const r of inf?.orders ?? []) {
      const live = r.voidedAt ? undefined : d.orders.get(r.id);
      put(live ? orderToRow(live) : r);
    }
    for (const id of e.orderIds) {
      const o = d.orders.get(id);
      if (o) put(orderToRow(o));
    }
    for (const r of e.voids.values()) put(r);
    return {
      id: e.id,
      committedSeq: e.committedSeq,
      inflight: inf ? { flushId: inf.flushId, lastSeq: inf.lastSeq, audits: inf.audits, jobs: inf.jobs, consents: inf.consents } : null,
      flushId: randomUUID(),
      lastSeq: lastSeqOf(s),
      windowStartSeq: windowStartOf(s),
      messages: e.pending.map((m) => ({ seq: seqOf(m)!, message: normalizeForStore(m) })),
      state: sessionState(s),
      lastCustomerAt: lastCustomerAtOf(s.messages),
      orders: [...orders.values()],
      audits: e.audits,
      jobs: e.jobs,
      consents: e.consents,
      poisoned: e.poisoned,
    };
  }

  return {
    mode: 'db',
    install() {
      for (const s of pre.sessions) {
        const seqs = pre.seqs.get(s.id)!;
        d.sessions.set(s.id, s);
        entries.set(s.id, newEntry(s, true, seqs.lastSeq, pre.msgids.get(s.id) ?? new Set()));
      }
      for (const o of pre.orders) d.orders.set(o.id, o);
    },
    accepts(s) {
      const cur = d.sessions.get(s.id);
      if (cur === undefined || cur === s) return true;
      stats.foreign++;
      console.warn(`[store] 会话 ${short(s.id)}：saveSession 收到同 id 的另一个对象，不落库（db 存储下 identity map 里的对象是唯一的）`);
      return false;
    },
    schedule(s) {
      const e = entryOf(s);
      let fresh: ChatMessage[];
      if (e.poisoned) fresh = assignSeqs(s, 'lenient');
      else {
        try {
          fresh = assignSeqs(s, 'strict');
        } catch (err) {
          if (!(err instanceof WindowCorruptError)) throw err;
          poison(e, 'window_corrupt');
          // 之后对它改用宽松模式：新消息照样有 seq，spill 才写得出「没提交的消息连同 seq」
          fresh = assignSeqs(s, 'lenient');
        }
      }
      e.pending.push(...fresh);
      for (const m of fresh) if (m.role === 'customer' && typeof m.msgid === 'string') e.msgids.add(m.msgid);
      change(e);
    },
    scheduleOrder(orderId) {
      const o = d.orders.get(orderId);
      const e = o ? entryById(o.sessionId) : null;
      if (!o || !e) return;
      e.orderIds.add(orderId);
      change(e);
    },
    voidOrder(o, reason) {
      const e = entryById(o.sessionId);
      if (!e) return;
      e.orderIds.delete(o.id);
      try {
        e.voids.set(o.id, orderToRow(o, { at: Date.now(), reason }));
      } catch (err) {
        poison(e, errLabel(err));
      }
      change(e);
    },
    emitAfterCommit(sessionId, ev) {
      const e = entryById(sessionId);
      if (!e) return;
      e.events.push(ev);
      change(e);
    },
    queueAudit(sessionId, item) {
      const e = entryById(sessionId);
      if (!e) return;
      e.audits.push(item);
      change(e);
    },
    queueJobs(sessionId, ops) {
      const e = entryById(sessionId);
      if (!e || !ops.length) return;
      e.jobs.push(...ops);
      change(e);
    },
    queueConsents(sessionId, items) {
      const e = entryById(sessionId);
      if (!e || !items.length) return;
      e.consents.push(...items);
      change(e);
    },
    queueTelemetry(sessionId, rows) {
      const e = entryById(sessionId);
      if (!e) return;
      e.telemetry.traces.push(...(rows.traces ?? []));
      e.telemetry.guards.push(...(rows.guards ?? []));
      e.telemetry.outbound.push(...(rows.outbound ?? []));
      change(e);
    },
    async writeStandaloneAudit(item) {
      try {
        await detached(() => withTenant(d.db, ctx, (tx) => writeAuditAs(tx, item.actor, item.entry)));
      } catch (err) {
        console.error(`[store] demo 类会话的审计没写进去（${errLabel(err)}）：${item.entry.action}`);
      }
    },
    recentMsgids(sessionId) {
      return entries.get(sessionId)?.msgids ?? new Set();
    },
    flush(sessionId, opts = {}) {
      const e = entries.get(sessionId);
      if (!e || !isDirty(e)) return Promise.resolve();
      if (conflict || e.poisoned) return Promise.reject(new StoreLaggingError(sessionId));
      const timeoutMs = opts.timeoutMs ?? 5000;
      return new Promise<void>((resolve, reject) => {
        const w: Waiter = {
          gen: e.gen,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          e.waiters.delete(w);
          reject(new StoreLaggingError(sessionId));
        }, timeoutMs);
        e.waiters.add(w);
      });
    },
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      // 已冲突或租户锁在别人手里：不写库，全部留给 exit 时的 spill
      if (!conflict && d.writable()) {
        for (const e of entries.values()) {
          if (e.poisoned || !isDirty(e)) continue;
          if (e.timer && e.inflight) {
            // 退避中的重试不等了，现在就试一次
            clearTimeout(e.timer);
            e.timer = null;
            const snap = e.inflight;
            detached(() => void runFlush(e, snap));
          } else kick(e);
        }
        await Promise.all([...entries.values()].map((e) => settled(e, deadline)));
      }
      return { undrained: [...entries.values()].filter(isDirty).map((e) => e.id) };
    },
    spillSync() {
      try {
        const dirty = [...entries.values()].filter(isDirty);
        if (!dirty.length) return 0;
        const out: SpillEntry[] = [];
        for (const e of dirty) {
          try {
            out.push(spillEntryOf(e));
          } catch (err) {
            console.error(`[store] 会话 ${short(e.id)} 写不进 spill（${errLabel(err)}）`);
          }
        }
        if (!out.length) return 0;
        const doc: SpillDoc = { version: 1, tenant: d.tenantId, at: Date.now(), sessions: out };
        const file = path.join(d.varDir, `store-spill-${stamp()}.json`);
        fs.mkdirSync(d.varDir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc));
        fs.renameSync(`${file}.tmp`, file);
        console.error(`[store] ${out.length} 个会话还有没落库的改动，已写进 ${path.basename(file)}，下次启动先回放`);
        return out.length;
      } catch (err) {
        console.error(`[store] spill 写不出来（${errLabel(err)}）：没落库的改动随进程退出丢失`);
        return 0;
      }
    },
    health(): StoreHealth {
      let dirty = 0;
      let oldest = Number.POSITIVE_INFINITY;
      const poisoned: string[] = [];
      for (const e of entries.values()) {
        if (isDirty(e)) {
          dirty++;
          if (e.since !== null) oldest = Math.min(oldest, e.since);
        }
        if (e.poisoned) poisoned.push(short(e.id));
      }
      let conversations = 0;
      for (const id of d.sessions.keys()) if (!isDemoClassId(id)) conversations++;
      return {
        mode: 'db',
        conversations,
        dirty,
        lagMs: Number.isFinite(oldest) ? Date.now() - oldest : 0,
        lastError,
        conflict,
        poisoned,
      };
    },
    close() {
      closed = true;
      for (const e of entries.values()) {
        if (e.timer) clearTimeout(e.timer);
        e.timer = null;
      }
    },
    stats: () => ({ ...stats }),
  };
}
