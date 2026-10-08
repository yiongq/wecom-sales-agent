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
  readSessionBatch,
  updateConversation,
  type ConversationSeqs,
} from '../db/repo/conversations.js';
import { cancelPendingJobs, cancelPendingJobsOfSession, enqueueJob, setJobStatus, type JobKind, type JobStatus } from '../db/repo/jobs.js';
import { insertMessages, readMessagesFrom, readRecentCustomerMsgids } from '../db/repo/messages.js';
import { readOrderIdsIn, upsertOrders } from '../db/repo/orders.js';
import { insertOutboundSends, markOutboundFailed, readOutboundAfterLastCustomer, type OutboundSendRow } from '../db/repo/outbound.js';
import { insertGuardEvents, insertTurnTraces, type GuardEventRow, type TurnTraceRow } from '../db/repo/traces.js';
import { addUsage, type UsageDelta } from '../db/repo/usage.js';
import { shortIdOf } from '../shared/conversation.js';
import type { ChatMessage, Order, Session } from '../types.js';
import { SessionStoreStartupError, StoreConflictError, StoreLaggingError, type StoreBackend, type StoreHealth } from './backend.js';
import { deliverCommitted, deliverHandoffUnsaved, type DomainEvent } from './events.js';
import {
  conversationValuesFrom,
  isDemoClassId,
  lastCustomerAtOf,
  messageToRow,
  normalizeForStore,
  orderToRow,
  ProjectionError,
  rebuildSessions,
  rowToMessage,
  rowToOrder,
  sessionState,
  SPILL_FILE_RE,
  type ConversationValuesShape,
  type MessageRowShape,
  type OrderRowShape,
} from './project.js';
import { assignSeqs, lastSeqOf, linkTurn, seedSeqs, seqOf, turnIdOf, WindowCorruptError, windowStartOf } from './seq.js';

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

// ---------------- 排进下一次落库的附带行 ----------------

export type AuditActor = TenantCtx['actor'];
/** 一行审计：各自带操作者与 IP（合批时分不清操作者，所以不用事务的上下文） */
export interface AuditItem {
  actor: AuditActor;
  entry: AuditEntry;
}
/**
 * 任务的排程与状态变化（第 10 步起有生产者）；时间是毫秒，能原样写进 spill。
 * status 的 claimedAt 是认领令牌（只改 claimed_at 仍是它的那一行）；report 为 true 时，提交之后经 jobOpApplied 报回改中了没有
 * （跟进的 running → sending：没改中就不推送）
 */
export type JobOp =
  | { op: 'enqueue'; kind: JobKind; dedupeKey: string; runAt: number; payload: unknown; maxAttempts: number }
  | { op: 'cancel'; dedupeKey: string }
  /** 取消这个会话某一种还没开始执行的任务（按 payload 的 sessionId） */
  | { op: 'cancelSession'; kind: JobKind; sessionId: string }
  | {
      op: 'status';
      id: string;
      status: JobStatus;
      from?: JobStatus[];
      claimedAt?: number;
      lastError?: string | null;
      attemptsDelta?: number;
      runAt?: number;
      report?: boolean;
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

/** spill 里的订单：normalizeForStore 之后的原始对象与作废信息，不在 spill 时投影（投影失败的订单正是 poisoned 的原因），回放时再投影 */
interface SpillOrder {
  order: Record<string, unknown>;
  voided: { at: number; reason: 'reset' | 'resync' } | null;
}
/** 记了作废、还没落库的订单：原始对象（订单已移出内存）与作废的时间、原因，取快照时才投影 */
interface VoidedOrder {
  order: Record<string, unknown>;
  at: number;
  reason: 'reset' | 'resync';
}
interface SpillSideRows {
  audits: AuditItem[];
  jobs: JobOp[];
  consents: ConsentItem[];
}
/** spill 文件里的一个会话（spec「停机」）：已提交到第几条、没提交的消息连同 seq、会话投影、排着的订单与附带行；trace 与账本行不写 */
interface SpillEntry extends SpillSideRows {
  id: string;
  /** 会话行的 ref（第 18 步起写；之前的 spill 没有，回放时由库生成）：还没插进库的新会话回放时用它，日志与 OpenTelemetry 里的引用前后一致 */
  ref?: string;
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
  /** 这次落库里改中了的 report 状态变化（任务 id）：提交之后才交给 jobOpApplied */
  applied: string[];
}

interface Waiter {
  gen: number;
  resolve(): void;
  reject(e: Error): void;
}

interface Entry {
  id: string;
  /**
   * 会话行的 ref（随机 uuid，不含客户标识）：预载的取库里的；新会话在建写队列时生成、第一次落库插入时写进去，
   * 所以还没提交过也有（日志、OpenTelemetry 用，第 17、18 步）
   */
  ref: string;
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
  /** 已经排了一个 microtask 去起落库：同一段同步代码里的改动合进同一个快照 */
  kickQueued: boolean;
  /**
   * 保留期清理正在为这个会话执行清除 SQL（第 16 步审查第二轮，spec「保留期」「逐个在它的写队列上处理」）：持有期间
   * change() 照常标脏、排着，但 kick 不起新的落库——否则清除 SQL 执行期间（它本身是一次 await）来一条新消息，
   * 两笔事务会在数据库行锁上抢跑，输的一方可能是清除赢了之后这笔写发现行不在了，抛 StoreConflictError 优雅停机。
   * 持有者（purge.ts 的 holdForPurge）负责在清除成功之前同步核一次 gen 没变、失败或释放时如果变脏了手动补一次 kick
   */
  purgeHeld: boolean;
  attempts: number;
  timer: NodeJS.Timeout | null;
  /** 数据类错误停写的原因（SQLSTATE 与约束名、window_corrupt、projection） */
  poisoned: string | null;
  orderIds: Set<string>;
  voids: Map<string, VoidedOrder>;
  audits: AuditItem[];
  jobs: JobOp[];
  consents: ConsentItem[];
  telemetry: Required<TelemetryRows>;
  events: DomainEvent[];
  waiters: Set<Waiter>;
  /** 企微去重集合：预载的最近 7 天，加上本进程分配过 seq 的客户消息 */
  msgids: Set<string>;
  /** 已提交、改中了的 report 状态变化（任务 id），jobOpApplied 取走 */
  applied: Set<string>;
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
  /** 每次提交之后调（store.ts 接旧 /api/admin/stream 的 change，只在提交之后发，不变量 10） */
  afterCommit?(): void;
  /**
   * 这些会话名下的订单已经在库里了：收养的孤儿订单随会话提交了，或者 JSON 读进来的副本库里已有（作废的也算）。
   * store.ts 接 fileBackend.markChanged，让 orders.json 去掉它们
   */
  ordersTaken?(sessionIds: readonly string[]): void;
}

export interface PgStoreStats {
  /** 发起的落库事务（含重试） */
  attempts: number;
  commits: number;
  /** COMMIT 时断线、重试时按 flush_id 认出上一次其实提交了 */
  recognized: number;
  retries: number;
  /** 最近一次排重试用的退避（毫秒），没排过为 0 */
  lastRetryDelayMs: number;
  slowTx: number;
  /**
   * 丢掉的 trace / 护栏事件 / 账本批次：存档点里写失败的；以数据类错误失败的那次落库快照里的；会话 poisoned 时排着的
   * 与之后再来的（poisoned 会话不再落库，spill 也不带它们）
   */
  telemetryDropped: number;
  /** saveSession 收到与 identity map 里不同的同 id 对象、拒绝落库的次数 */
  foreign: number;
  /** 启动时回放的 spill 会话数（应用的，与认出已经在库里而跳过的） */
  replayed: number;
  replaySkipped: number;
  /** 启动时回放失败（或读不出来）、改名 .failed 的 spill 文件数（store 告警，R24） */
  replayFailedFiles: number;
}

/** holdForPurge 的持有句柄（第 16 步审查第二轮）：见 PgBackend.holdForPurge 的文档注释 */
export interface PurgeHold {
  /** 持有期间这个会话有没有被改动（change() 的 gen 有没有变）；清除 SQL 的事务提交之前据此决定提交还是让路回滚 */
  stillClean(): boolean;
  /** 释放持有：持有期间变脏了就补一次 kick（否则这次改动会一直排在写队列上、直到下一次不相关的改动才被捎带落库） */
  release(): void;
}

export interface PgBackend extends StoreBackend {
  /** 把预载的会话与订单放进 identity map（initSessionStore 在全部校验通过之后同步调） */
  install(): void;
  /** saveSession 之前：map 里有同 id 的另一个对象就拒绝（日志一行、不落库），不变量 3 */
  accepts(s: Session): boolean;
  /** 收养了、还没随会话在库里提交过一次的孤儿订单：这段时间里仍归文件后端，orders.json 照写（崩溃不丢） */
  adoptedUncommitted(orderId: string): boolean;
  /** deleteOrdersOfSession：订单记作废（voided_at、void_reason），调用方随后把它移出内存 */
  voidOrder(o: Order, reason: 'reset' | 'resync'): void;
  queueAudit(sessionId: string, item: AuditItem): void;
  queueJobs(sessionId: string, ops: readonly JobOp[]): void;
  /**
   * 给还没提交的 enqueue（在途快照与写队列上、dedupeKey 相同的）的 payload 并进几个字段，返回改了几个。第 14 步：库写不进去时
   * unsaved 通知发出之后，给这次转人工立即的那个 handoff_notify 标上 unsavedSent，之后提交（或停机写进 spill、重启回放）再执行到它
   * 时不补发。在途的那次尝试已经写过这一行的不受影响（同一进程里由通知模块的内存记录兜住）
   */
  patchQueuedJob(sessionId: string, dedupeKey: string, patch: Record<string, unknown>): number;
  /** report 的状态变化已随这个会话的落库提交、而且改中了：取走（只报一次）。没提交、没改中都是 false */
  jobOpApplied(sessionId: string, jobId: string): boolean;
  queueConsents(sessionId: string, items: readonly ConsentItem[]): void;
  queueTelemetry(sessionId: string, rows: TelemetryRows): void;
  /** demo 类会话的审计：单独一个短事务（R6） */
  writeStandaloneAudit(item: AuditItem): Promise<void>;
  /**
   * 用量累加进 usage_daily（02 spec「用量」：每 30 秒与 drain 段由累加器调，不经会话写队列）。一个短事务；已冲突、late 段之后、
   * 租户锁在别人手里时不写、直接 reject（累加器把这批留着下次再试）。失败一律以 UsageWriteError reject，code 分得出原因
   */
  writeUsage(deltas: readonly UsageDelta[]): Promise<void>;
  recentMsgids(sessionId: string): ReadonlySet<string>;
  /** 预载的发送账本行（各会话最后一条客户消息之后的，第 12 步）：取走一次，之后返回空的（账本在内存里，src/quota/ledger.ts） */
  takePreloadedOutbound(): Map<string, OutboundSendRow[]>;
  /**
   * 还没有会话的账本行（老客户进入会话时补发的欢迎语，会话不在内存里）：单独一个短事务，只试一次、失败记一行。
   * 已冲突、late 段之后、租户锁在别人手里时不写
   */
  writeStandaloneOutbound(rows: readonly OutboundSendRow[]): Promise<void>;
  /**
   * 收到 msg_send_fail：单独一个短事务按 msgid 记 failed 与 fail_type（不经会话写队列）。写成了是 ok，带那一行的会话 id（找不到、
   * 已经是 failed 为 null）；这次没写（同上三种情况、库报错，记一行）不是 ok，调用方再试一次
   */
  markOutboundFailed(channelMsgid: string, failType: number): Promise<{ ok: true; sessionId: string | null } | { ok: false }>;
  /**
   * 会话行的 ref（不含客户标识）：预载的与本进程建过写队列的会话都有，新会话还没提交过也有；还没建写队列的先生成好，建写队列时
   * 用它（日志的 conv 在第一次 saveSession 之前就要，R24）。只由 store.conversationRef 为内存里的真实会话调
   */
  refOf(sessionId: string): string | null;
  /** 这个会话因数据类错误停写了（poisoned）：人工回复、订单动作在改动之前就 503（第 13 步） */
  isPoisoned(sessionId: string): boolean;
  /** 这个会话有没有未落库的改动，或正在落库（第 16 步：保留期清理据此跳过有动静的会话） */
  hasPendingWrite(sessionId: string): boolean;
  /**
   * 保留期清理删除会话之后，把它从写队列的簿记里摘掉（第 16 步）：entries 里的那一项连同预生成的 ref 一起删。
   * store.ts 的 forgetSession 同一个 tick 里再把它从 identity map 移出；客户用同一个 id 再来时，schedule() 建全新的 entry
   */
  forget(sessionId: string): void;
  /**
   * 清除 SQL 执行期间把这个会话的写队列挂起（第 16 步审查第二轮，spec「保留期」「逐个在它的写队列上处理」）：这个会话
   * 没有未落库的改动、没有在途落库、没有 poisoned 时返回一个持有句柄，否则返回 null（调用方当「有动静」跳过这个候选，
   * 与 hasPendingWrite 同一套判断，原子地做在一次调用里，不留 TOCTOU 的缝）。持有期间 change() 照常标脏、kick 按兵不动；
   * 内存里没有这个会话（这个进程从没建过写队列）时返回一个恒为「干净」的空句柄，不持有什么、release 什么都不做。
   */
  holdForPurge(sessionId: string): PurgeHold | null;
  /**
   * 任务表的单独短事务（认领、改状态、启动与停机时的归位、与会话无关的排程；02 spec「任务表与跟进」）：不经会话写队列，
   * 同落库一样在模块加载时取的空异步上下文里起。已冲突、late 段之后、租户锁在别人手里时不写，以 JobsTxRefused reject
   */
  jobsTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** late 段：此后不再发起落库，退避中的重试也停掉；没落库的留给 exit 时的 spill */
  close(): void;
  stats(): PgStoreStats;
  /** 这个会话还留在内存里的遥测行数（排着的加在途快照里的，自测用） */
  queuedTelemetry(sessionId: string): number;
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

/** jobsTx 主动不写：已冲突、已停机（late 段之后）、租户锁不在本进程手里 */
export class JobsTxRefused extends Error {
  override readonly name = 'JobsTxRefused';
  constructor(readonly code: 'conflict' | 'closed' | 'held_by_other') {
    super(`任务表这次不写（${code}）`);
  }
}

/**
 * writeUsage 没写进去。code：主动不写的三种（conflict 已冲突、closed 已停机、held_by_other 租户锁不在本进程），
 * 或库报的 SQLSTATE / errno 码（沿 cause 链取，取不到是错误名）。message 里只有 code，不带驱动错误的原文
 */
export class UsageWriteError extends Error {
  override readonly name = 'UsageWriteError';
  constructor(
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(`usage_daily 没写进去（${code}）`, options);
  }
}

// ---------------- 预载 ----------------

interface Preloaded {
  sessions: Session[];
  orders: Order[];
  seqs: Map<string, ConversationSeqs>;
  /** 会话行的 ref（不含客户标识的引用） */
  refs: Map<string, string>;
  msgids: Map<string, Set<string>>;
  /** 发送账本：各会话最后一条客户消息之后的发送（第 12 步） */
  outbound: Map<string, OutboundSendRow[]>;
  /** orders.json 读进来、所属会话是预载的那些订单：库里已有（作废的也算）的 id，与库里没有的 id */
  jsonInDb: string[];
  jsonAdopt: string[];
}

/**
 * 分批预载全部真实会话、窗口内的消息、未作废订单与 7 天 msgid 集合，并逐批校验（R2）；最后按 id 查 orders.json 读进来的、
 * 所属会话是预载的那些订单在不在库里（作废的也查）。整个预载一个只读的长事务
 */
async function preload(d: PgBackendDeps): Promise<Preloaded> {
  const out: Preloaded = {
    sessions: [],
    orders: [],
    seqs: new Map(),
    refs: new Map(),
    msgids: new Map(),
    outbound: new Map(),
    jsonInDb: [],
    jsonAdopt: [],
  };
  const since = new Date(Date.now() - MSGID_WINDOW_MS);
  try {
    await withTenant(
      d.db,
      systemCtx(d.tenantId),
      async (tx) => {
        let after: string | null = null;
        for (;;) {
          // 会话行、窗口内消息、未作废订单的读法与重建，和 import-sessions / export-sessions 的读回是同一条路（不变量 14）
          const { rows, messages, orders: ords } = await readSessionBatch(tx, after, PRELOAD_BATCH);
          if (!rows.length) break;
          const ids = rows.map((r) => r.id);
          const mids = await readRecentCustomerMsgids(tx, ids, since);
          const batch = new Set(ids);
          // 带 turn_id 的消息先按会话分好组：每个会话只看自己那几条，不在每个会话里把整批消息扫一遍
          const turnRows = new Map<string, typeof messages>();
          for (const r of messages) {
            if (!r.turnId) continue;
            const list = turnRows.get(r.conversationId);
            if (list) list.push(r);
            else turnRows.set(r.conversationId, [r]);
          }
          for (const { row, session, windowCount } of rebuildSessions(rows, messages)) {
            if (isDemoClassId(row.id)) throw new SessionStoreStartupError('demo_class_in_db', `库里有 demo 类会话 ${short(row.id)}`);
            if (!session) {
              throw new SessionStoreStartupError(
                'preload_integrity',
                `会话 ${short(row.id)} 的 last_seq=${row.lastSeq}、window_start_seq=${row.windowStartSeq}，窗口里却是 ${windowCount} 条`,
              );
            }
            seedSeqs(session, row.windowStartSeq);
            // AI 回复所属的轮次（messages.turn_id）记回 WeakMap：重启之后 J 页照样认得出哪条回复有 trace
            for (const r of turnRows.get(row.id) ?? []) {
              const m = session.messages[r.seq - row.windowStartSeq];
              if (m) linkTurn(m, r.turnId!);
            }
            for (const m of session.messages) Object.freeze(m);
            out.sessions.push(session);
            out.seqs.set(row.id, { lastSeq: row.lastSeq, windowStartSeq: row.windowStartSeq, flushId: row.flushId });
            out.refs.set(row.id, row.ref);
            out.msgids.set(row.id, new Set());
          }
          for (const r of mids) out.msgids.get(r.conversationId)?.add(r.msgid);
          for (const r of await readOutboundAfterLastCustomer(tx, ids)) {
            const list = out.outbound.get(r.conversationId);
            if (list) list.push(r);
            else out.outbound.set(r.conversationId, [r]);
          }
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
        const json: string[] = [];
        for (const [id, o] of d.orders) if (typeof id === 'string' && out.seqs.has(o.sessionId)) json.push(id);
        if (json.length) {
          const inDb = new Set(await readOrderIdsIn(tx, json));
          for (const id of json) (inDb.has(id) ? out.jsonInDb : out.jsonAdopt).push(id);
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

/** 审计、任务、同意记录。返回改中了的 report 状态变化（任务 id） */
async function writeSideRows(tx: Tx, sessionId: string, side: SpillSideRows): Promise<string[]> {
  const applied: string[] = [];
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
    } else if (j.op === 'cancelSession') {
      await cancelPendingJobsOfSession(tx, j.kind, j.sessionId);
    } else {
      const ok = await setJobStatus(tx, j.id, j.status, {
        from: j.from,
        claimedAt: j.claimedAt === undefined ? undefined : new Date(j.claimedAt),
        lastError: j.lastError,
        attemptsDelta: j.attemptsDelta,
        runAt: j.runAt === undefined ? undefined : new Date(j.runAt),
      });
      if (ok && j.report) applied.push(j.id);
    }
  }
  await appendConsents(
    tx,
    side.consents.map((c) => ({ ...c, conversationId: sessionId, at: new Date(c.at) })),
  );
  return applied;
}

const spillOrderRow = (o: SpillOrder): OrderRowShape => orderToRow(o.order as unknown as Order, o.voided ?? undefined);

/**
 * 回放 spill 里的一个会话（spec「spill 回放」）：
 * 库里的 flush_id 就是这一条的 → 回放过了，跳过；库里是在途那次的 flush_id 与 last_seq → 在途那次其实提交了，只补它之后的；
 * 库里的 last_seq 等于「已提交到第几条」→ 按一次落库写入；已经等于文件里最后一条的 seq 且内容一致 → 跳过；其余接不上
 */
async function replayEntry(tx: Tx, entry: SpillEntry): Promise<'applied' | 'skipped' | 'conflict'> {
  let row = await lockConversation(tx, entry.id);
  let base: number;
  let side: SpillSideRows;
  for (;;) {
    if (row && row.flushId === entry.flushId) return row.lastSeq === entry.lastSeq ? 'skipped' : 'conflict';
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
    const ins = { ...conversationValuesFrom(entry.state, entry.lastCustomerAt), ...(entry.ref ? { ref: entry.ref } : {}) };
    if (row || (await insertConversation(tx, ins))) break;
    // 插入撞上别的事务刚提交的同一行（上一个进程还没完成的 COMMIT）：插入等到它提交才返回，这时再锁一次就看得见，按库里的行重新判定
    row = await lockConversation(tx, entry.id);
    if (!row) return 'conflict';
  }
  const values = conversationValuesFrom(entry.state, entry.lastCustomerAt);
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

/** 文件系统错误与其余意外错误的标签：只有错误名与 errno 码，不带路径与 message */
const fsLabel = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  const name = e instanceof Error ? e.name : 'unknown';
  return code ? `${name}/${code}` : name;
};

/**
 * 按时间顺序回放 var/ 下的 spill 文件。接不上以 spill_conflict 拒绝启动（文件留着）；某条回放仍然失败（数据类错误）就把
 * 文件改名 .failed、记一行（点名已回放与失败的会话，要人工处理），从库里的状态起；全部成功就删掉文件。
 * 读不出来或结构不对（version、sessions）的文件同样改名 .failed。文件系统出错与其余意外错误以 spill_conflict 拒绝启动，
 * detail 只写文件名与错误码。返回回放与跳过的会话数
 */
async function replaySpills(d: PgBackendDeps): Promise<Replayed> {
  let names: string[];
  try {
    names = fs.readdirSync(d.varDir).filter((f) => SPILL_FILE_RE.test(f));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { applied: 0, skipped: 0, failedFiles: 0 };
    throw new SessionStoreStartupError('spill_conflict', `读不了数据目录里的 spill 文件（${fsLabel(e)}）`);
  }
  let applied = 0;
  let skipped = 0;
  let failedFiles = 0;
  for (const name of names.toSorted()) {
    try {
      const r = await replayFile(d, name);
      applied += r.applied;
      skipped += r.skipped;
      failedFiles += r.failedFiles;
    } catch (e) {
      if (e instanceof SessionStoreStartupError) throw e;
      throw new SessionStoreStartupError('spill_conflict', `${name}：${fsLabel(e)}`);
    }
  }
  return { applied, skipped, failedFiles };
}

/** 回放 spill 的结果：应用、跳过的会话数，改名 .failed 的文件数 */
interface Replayed {
  applied: number;
  skipped: number;
  failedFiles: number;
}

async function replayFile(d: PgBackendDeps, name: string): Promise<Replayed> {
  const file = path.join(d.varDir, name);
  const raw = fs.readFileSync(file, 'utf8');
  let doc: SpillDoc | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<SpillDoc> | null;
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.sessions)) doc = parsed as SpillDoc;
  } catch {
    doc = null;
  }
  if (!doc) {
    fs.renameSync(file, `${file}.failed`);
    console.error(
      `[store] spill 文件 ${name} 读不出来（不是 JSON，或 version、sessions 对不上），已改名 .failed，从库里的状态起；需要人工处理`,
    );
    return { applied: 0, skipped: 0, failedFiles: 1 };
  }
  if (doc.tenant !== d.tenantId) throw new SessionStoreStartupError('spill_conflict', `${name} 不是本租户的 spill`);
  let applied = 0;
  let skipped = 0;
  const done: string[] = [];
  const failed: string[] = [];
  for (const entry of doc.sessions) {
    let r: 'applied' | 'skipped' | 'conflict';
    try {
      r = await detached(() => withTenant(d.db, systemCtx(d.tenantId), (tx) => replayEntry(tx, entry)));
    } catch (e) {
      if (classify(e) === 'retry') throw new SessionStoreStartupError('db_unreachable', `回放 ${name} 时连不上库（${errLabel(e)}）`);
      failed.push(`${short(entry.id)}（${errLabel(e)}）`);
      console.error(`[store] 回放 ${name} 里的会话 ${short(entry.id)} 失败（${errLabel(e)}）`);
      continue;
    }
    if (r === 'conflict') {
      throw new SessionStoreStartupError('spill_conflict', `${name} 里的会话 ${short(entry.id)} 接不上库里的 last_seq`);
    }
    done.push(short(entry.id));
    if (r === 'applied') applied++;
    else skipped++;
  }
  if (failed.length) {
    fs.renameSync(file, `${file}.failed`);
    // 不能叫人改回原名重启：已回放的会话之后再写过库，flush_id 与 last_seq 就和文件对不上，改回原名必然 spill_conflict
    console.error(
      `[store] spill 文件 ${name} 有会话回放失败，已改名 .failed，从库里的状态起；需要人工处理，不要直接改回原名重启。` +
        `已回放：${done.join('、') || '无'}；失败：${failed.join('、')}`,
    );
  } else fs.unlinkSync(file);
  return { applied, skipped, failedFiles: failed.length ? 1 : 0 };
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

function createBackend(d: PgBackendDeps, pre: Preloaded, replay: Replayed): PgBackend {
  const ctx = systemCtx(d.tenantId);
  const entries = new Map<string, Entry>();
  /** refOf 先生成好、还没建写队列的新会话的 ref（建写队列时取走） */
  const preRefs = new Map<string, string>();
  /** 收养了、还没随会话在库里提交过一次的孤儿订单 id：提交之前仍归文件后端（orders.json 照写），提交之后 ordersTaken */
  const adopted = new Set<string>();
  /** 本进程记了作废的订单 id：作废的订单不再进写队列，upsert 不会把 voided_at 写回 NULL */
  const voidedIds = new Set<string>();
  let conflict = false;
  let closed = false;
  let lastError: string | null = null;
  const stats: PgStoreStats = {
    attempts: 0,
    commits: 0,
    recognized: 0,
    retries: 0,
    lastRetryDelayMs: 0,
    slowTx: 0,
    telemetryDropped: 0,
    foreign: 0,
    replayed: replay.applied,
    replaySkipped: replay.skipped,
    replayFailedFiles: replay.failedFiles,
  };

  const emptyTelemetry = (): Required<TelemetryRows> => ({ traces: [], guards: [], outbound: [] });
  const hasTelemetry = (t: TelemetryRows): boolean => !!(t.traces?.length || t.guards?.length || t.outbound?.length);
  /** 再也写不进库的遥测行（spill 不带它们）：丢掉、算一批（与存档点里写失败同一个口径） */
  const dropTelemetry = (holder: { telemetry: Required<TelemetryRows> }): void => {
    if (!hasTelemetry(holder.telemetry)) return;
    stats.telemetryDropped++;
    holder.telemetry = emptyTelemetry();
  };
  const newEntry = (s: Session, ref: string, inDb: boolean, committedSeq: number, msgids: Set<string>): Entry => ({
    id: s.id,
    ref,
    session: s,
    inDb,
    committedSeq,
    pending: [],
    gen: 0,
    committedGen: 0,
    since: null,
    sinceNext: null,
    inflight: null,
    kickQueued: false,
    purgeHeld: false,
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
    applied: new Set(),
  });

  /**
   * 这个会话的写队列。不是预载来的就是新建的会话（seq 从 1 起；JSON 里的真实会话在启动时以 real_in_json 拒绝）。
   * 窗口里已有 seq 的消息仍整段算没提交（防御：不会只写尾巴留下空洞）
   */
  function entryOf(s: Session): Entry {
    let e = entries.get(s.id);
    if (!e) {
      e = newEntry(s, preRefs.get(s.id) ?? randomUUID(), false, 0, new Set());
      preRefs.delete(s.id);
      for (const m of Array.isArray(s.messages) ? s.messages : []) if (m && seqOf(m) !== undefined) e.pending.push(m);
      // 孤儿订单（所属会话不在内存里，留在 orders.json）在同 id 的会话又建出来时转归 PG（plan 第 2 步）：
      // 随它的第一次落库写进库；提交之前仍归文件后端，提交之后才让 orders.json 去掉它
      for (const o of d.orders.values()) adopt(e, o);
      entries.set(s.id, e);
    }
    return e;
  }
  function adopt(e: Entry, o: Order): void {
    if (o.sessionId !== e.id || voidedIds.has(o.id)) return;
    e.orderIds.add(o.id);
    adopted.add(o.id);
  }
  const entryById = (id: string): Entry | null => {
    const s = d.sessions.get(id);
    return s ? entryOf(s) : null;
  };
  const isDirty = (e: Entry): boolean => e.gen !== e.committedGen;

  /**
   * 标脏，起落库推迟到 microtask：同一段同步代码里的改动（引擎重置的作废订单、清转人工、追加回复与 saveSession，
   * 建单与 orderIds.push）合进同一个快照、同一个事务，库里不会留下半个重置
   */
  function change(e: Entry): void {
    e.gen++;
    const now = Date.now();
    e.since ??= now;
    if (e.inflight) e.sinceNext ??= now;
    if (e.kickQueued) return;
    e.kickQueued = true;
    queueMicrotask(() => {
      e.kickQueued = false;
      kick(e);
    });
  }

  function rejectWaiters(e: Entry): void {
    for (const w of e.waiters) w.reject(new StoreLaggingError(e.id));
    e.waiters.clear();
  }

  function poison(e: Entry, label: string): void {
    if (e.poisoned) return;
    e.poisoned = label;
    lastError = `${label} · ${short(e.id)}`;
    // 此后不再起落库：排着的遥测行再也写不进库，现在就丢掉、计数，不留在内存里；之后来的在 queueTelemetry 丢。
    // 在途的那次落库不动（window_corrupt 时它照常跑完，提交了就照样写进去；它以数据类错误失败时在 failed 里丢）
    dropTelemetry(e);
    console.error(`[store] 会话 ${short(e.id)} 停止落库（${label}）：内存照旧服务客户，停机时写进 spill；修好原因后重启回放`);
    rejectWaiters(e);
    // 排着的转人工再也提交不了：交给外部通道的 unsaved 通知（02 spec「通知」）。在途的那次照常跑完，失败时在 failed 里报
    deliverHandoffUnsaved(e.events);
  }

  /**
   * 第一个 await 之前同步取好快照（第 1 步）：没提交的消息（schedule 分配 seq 时已冻结）、会话投影、排着的订单（这时才投影）
   * 与附带行一起移进快照。投影失败就抛，排着的原样留在写队列上（随 spill 写出）
   */
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
      const o = voidedIds.has(id) ? undefined : d.orders.get(id);
      if (o) orders.push(orderToRow(o));
    }
    for (const v of e.voids.values()) orders.push(orderToRow(v.order as unknown as Order, { at: v.at, reason: v.reason }));
    const snap: Snap = {
      flushId: randomUUID(),
      gen: e.gen,
      baseSeq: e.committedSeq,
      lastSeq,
      windowStartSeq: windowStartOf(s),
      messages: e.pending.map((m) => messageToRow(m, seqOf(m)!, turnIdOf(m) ?? null)),
      values: conversationValuesFrom(sessionState(s), lastCustomerAtOf(s.messages)),
      orders,
      audits: e.audits,
      jobs: e.jobs,
      consents: e.consents,
      telemetry: e.telemetry,
      events: e.events,
      applied: [],
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

  /**
   * 排一次落库：同一会话至多一个在途，在途期间的改动合并成它提交之后的那一次。
   * 租户锁在别的进程手里（held_by_other）时不起落库：改动留给 exit 时的 spill，免得把新的持锁进程也撞成 store_conflict
   */
  function kick(e: Entry): void {
    if (closed || conflict || e.poisoned || e.inflight || e.purgeHeld || !isDirty(e) || !d.writable()) return;
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
      if (await insertConversation(tx, { ...snap.values, ref: e.ref })) cur = { lastSeq: 0, windowStartSeq: 1, flushId: null };
      else {
        // 新会话第一次落库 COMMIT 时断线、服务端稍后才提交：重试时那一行还看不见（锁不到），插入在主键上等到它提交、
        // 冲突了不报错。再锁一次就看得见，照常按 flush_id 与 last_seq 判定（多半是认出已提交）
        cur = await lockConversation(tx, e.id);
        if (!cur) throw new StoreConflictError(e.id, `会话 ${short(e.id)} 的行插入时冲突，锁时又不见了`);
      }
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
    // 5 订单、审计（各自的操作者）、任务、同意记录。改中了的 report 状态变化记在快照上，提交之后才交出去（按 flush_id 认出
    // 上一次其实提交了的，走不到这里，留着的正是提交了的那一次的结果）
    await upsertOrders(tx, snap.orders);
    snap.applied = await writeSideRows(tx, e.id, snap);
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

  /**
   * 第 7 步之后：记下已提交到第几条，把排在这次落库上的领域事件交给订阅者，收养的孤儿订单交还文件后端（orders.json 去掉它），
   * 放行在等的 flush，接着排下一次
   */
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
    let taken = false;
    for (const r of snap.orders) if (adopted.delete(r.id)) taken = true;
    if (taken) d.ordersTaken?.([e.id]);
    for (const id of snap.applied) e.applied.add(id);
    deliverCommitted(snap.events);
    d.afterCommit?.();
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
      // 这次落库不会再试：快照里的遥测行（spill 不带）一并丢掉、计数
      dropTelemetry(snap);
      // 快照里的转人工提交不了（排在它后面的由 poison 报）：交给外部通道的 unsaved 通知（02 spec「通知」）
      deliverHandoffUnsaved(snap.events);
      poison(e, label);
      return;
    }
    // 这次与排在它后面的转人工还没提交：交给外部通道的 unsaved 通知（emergency 立即，其余失败持续 30 秒后；每次失败都报，订阅者去重）
    deliverHandoffUnsaved([...snap.events, ...e.events]);
    lastError = `${label} · ${short(e.id)}`;
    if (closed) return; // late 段之后不再重试：没提交的随 spill 写出
    e.attempts++;
    stats.retries++;
    const delay = RETRY_MS[Math.min(e.attempts - 1, RETRY_MS.length - 1)]!;
    stats.lastRetryDelayMs = delay;
    console.warn(`[store] 会话 ${short(e.id)} 落库失败（${label}），第 ${e.attempts} 次，${delay / 1000} 秒后重试`);
    e.timer = setTimeout(() => {
      e.timer = null;
      // 租户锁到点时已在别人手里：不再写库，这个快照留在「在途」位置给 spill
      if (!closed && !conflict && d.writable()) detached(() => void runFlush(e, snap));
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

  /** spill 里的一个会话：消息、投影、订单都存 normalizeForStore 之后的原始对象，不在这里投影（回放时才投影） */
  function spillEntryOf(e: Entry): SpillEntry {
    const s = e.session;
    const inf = e.inflight;
    const orders = new Map<string, SpillOrder>();
    const live = (o: Order): SpillOrder => ({ order: normalizeForStore(o) as unknown as Record<string, unknown>, voided: null });
    for (const r of inf?.orders ?? []) {
      const now = r.voidedAt || voidedIds.has(r.id) ? undefined : d.orders.get(r.id);
      orders.set(
        r.id,
        now ? live(now) : { order: r.data, voided: r.voidedAt ? { at: r.voidedAt.getTime(), reason: r.voidReason ?? 'reset' } : null },
      );
    }
    for (const id of e.orderIds) {
      const o = voidedIds.has(id) ? undefined : d.orders.get(id);
      if (o) orders.set(id, live(o));
    }
    for (const [id, v] of e.voids) orders.set(id, { order: v.order, voided: { at: v.at, reason: v.reason } });
    return {
      id: e.id,
      ref: e.ref,
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
        entries.set(s.id, newEntry(s, pre.refs.get(s.id)!, true, seqs.lastSeq, pre.msgids.get(s.id) ?? new Set()));
      }
      // orders.json 读进来、所属会话是预载的订单：库里已有的（作废的也算）以库为准，删掉 JSON 副本、让 orders.json 去掉它
      // （作废的不会复活）；库里没有的挂到这个会话的写队列上，提交之前仍归文件后端
      const taken = new Set<string>();
      for (const id of pre.jsonInDb) {
        const o = d.orders.get(id);
        if (o) taken.add(o.sessionId);
        d.orders.delete(id);
      }
      for (const o of pre.orders) d.orders.set(o.id, o);
      for (const id of pre.jsonAdopt) {
        const o = d.orders.get(id);
        const e = o ? entries.get(o.sessionId) : undefined;
        if (!o || !e) continue;
        adopt(e, o);
        change(e);
      }
      if (taken.size) d.ordersTaken?.([...taken]);
    },
    accepts(s) {
      const cur = d.sessions.get(s.id);
      if (cur === undefined || cur === s) return true;
      stats.foreign++;
      console.warn(`[store] 会话 ${short(s.id)}：saveSession 收到同 id 的另一个对象，不落库（db 存储下 identity map 里的对象是唯一的）`);
      return false;
    },
    adoptedUncommitted: (orderId) => adopted.has(orderId),
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
      for (const m of fresh) {
        // 分配了 seq 就冻结：起落库推迟到 microtask，冻结不能等到取快照，否则「saveSession 之后再改」是否进库要看时机
        Object.freeze(m);
        if (m.role === 'customer' && typeof m.msgid === 'string') e.msgids.add(m.msgid);
      }
      change(e);
    },
    scheduleOrder(orderId) {
      const o = d.orders.get(orderId);
      const e = o ? entryById(o.sessionId) : null;
      if (!o || !e || voidedIds.has(orderId)) return;
      e.orderIds.add(orderId);
      change(e);
    },
    voidOrder(o, reason) {
      const e = entryById(o.sessionId);
      if (!e) return;
      e.orderIds.delete(o.id);
      voidedIds.add(o.id);
      // 存原始对象（订单随后移出内存），取快照时才投影：投影失败只让会话 poisoned，作废照样随 spill 写出
      e.voids.set(o.id, { order: normalizeForStore(o) as unknown as Record<string, unknown>, at: Date.now(), reason });
      change(e);
    },
    emitAfterCommit(sessionId, ev) {
      const e = entryById(sessionId);
      if (!e) return;
      e.events.push(ev);
      change(e);
      // 停写的会话、或在途的那次已经失败过在等重试：这次转人工排在一次提交不了的落库后面，同样交给 unsaved 通知
      if (ev.type === 'handoff.started' && (e.poisoned || (e.inflight && e.attempts > 0))) deliverHandoffUnsaved([ev]);
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
    patchQueuedJob(sessionId, dedupeKey, patch) {
      const e = entries.get(sessionId);
      if (!e) return 0;
      let n = 0;
      for (const list of [e.inflight?.jobs, e.jobs]) {
        if (!list) continue;
        list.forEach((op, i) => {
          if (op.op !== 'enqueue' || op.dedupeKey !== dedupeKey) return;
          const base = op.payload && typeof op.payload === 'object' ? (op.payload as Record<string, unknown>) : {};
          list[i] = { ...op, payload: { ...base, ...patch } };
          n++;
        });
      }
      return n;
    },
    jobOpApplied(sessionId, jobId) {
      return entries.get(sessionId)?.applied.delete(jobId) ?? false;
    },
    queueConsents(sessionId, items) {
      const e = entryById(sessionId);
      if (!e || !items.length) return;
      e.consents.push(...items);
      change(e);
    },
    queueTelemetry(sessionId, rows) {
      const e = entryById(sessionId);
      if (!e || !hasTelemetry(rows)) return;
      // poisoned 的会话不再落库：收下就只进不出，直接丢掉、计数
      if (e.poisoned) {
        stats.telemetryDropped++;
        return;
      }
      e.telemetry.traces.push(...(rows.traces ?? []));
      e.telemetry.guards.push(...(rows.guards ?? []));
      e.telemetry.outbound.push(...(rows.outbound ?? []));
      change(e);
    },
    async writeUsage(deltas) {
      if (!deltas.length) return;
      if (conflict) throw new UsageWriteError('conflict');
      if (closed) throw new UsageWriteError('closed');
      if (!d.writable()) throw new UsageWriteError('held_by_other');
      try {
        await detached(() => withTenant(d.db, ctx, (tx) => addUsage(tx, deltas)));
      } catch (err) {
        // drizzle 把驱动错误包一层，SQLSTATE 在 cause 里：在这一侧取好（src/trace 不 import src/db/**）
        throw new UsageWriteError(pgErrorOf(err).code ?? (err instanceof Error ? err.name : 'unknown'), { cause: err });
      }
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
    takePreloadedOutbound() {
      const out = pre.outbound;
      pre.outbound = new Map();
      return out;
    },
    async writeStandaloneOutbound(rows) {
      if (!rows.length) return;
      if (conflict || closed || !d.writable()) {
        console.error(
          `[store] 没有会话的发送账本行这次不写（${conflict ? 'conflict' : closed ? 'closed' : 'held_by_other'}），丢弃 ${rows.length} 行`,
        );
        return;
      }
      try {
        await detached(() => withTenant(d.db, ctx, (tx) => insertOutboundSends(tx, rows)));
      } catch (err) {
        console.error(`[store] 没有会话的发送账本行没写进去（${errLabel(err)}），丢弃 ${rows.length} 行`);
      }
    },
    async markOutboundFailed(channelMsgid, failType) {
      if (conflict || closed || !d.writable()) {
        console.error(`[store] msg_send_fail 回执这次不写库（${conflict ? 'conflict' : closed ? 'closed' : 'held_by_other'}）`);
        return { ok: false };
      }
      try {
        const sessionId = await detached(() => withTenant(d.db, ctx, (tx) => markOutboundFailed(tx, channelMsgid, failType)));
        return { ok: true, sessionId };
      } catch (err) {
        console.error(`[store] msg_send_fail 回执没写进库（${errLabel(err)}）`);
        return { ok: false };
      }
    },
    // 还没建写队列的新会话（第一轮在第一次 saveSession 之前就要打日志）先生成好 ref，建写队列时用它：日志的 conv 从第一行起就是同一个
    refOf: (sessionId) => {
      const e = entries.get(sessionId);
      if (e) return e.ref;
      let ref = preRefs.get(sessionId);
      if (!ref) {
        ref = randomUUID();
        preRefs.set(sessionId, ref);
      }
      return ref;
    },
    isPoisoned: (sessionId) => entries.get(sessionId)?.poisoned != null,
    hasPendingWrite: (sessionId) => {
      const e = entries.get(sessionId);
      return !!e && (isDirty(e) || e.inflight !== null);
    },
    forget: (sessionId) => {
      const e = entries.get(sessionId);
      // 极窄的残留窗口（第 16 步审查第二轮，holdForPurge 的 stillClean 已经在提交之前核过一次干净）：清除事务已经提交、
      // forgetSession 这一刻之间真的又来一笔写（COMMIT 的网络往返那一瞬），这个 entry 会带着没提交的改动被摘掉——
      // spec 墓碑设计认可的结果（不静默吞到查不出来），记一行日志
      if (e && isDirty(e)) console.warn(`[store] 会话 ${short(sessionId)} 刚被保留期清理删除，一笔极窄窗口里赶上的改动一并丢弃`);
      entries.delete(sessionId);
      preRefs.delete(sessionId);
    },
    holdForPurge: (sessionId) => {
      const e = entries.get(sessionId);
      // 这个进程从没给这个会话建过写队列（预载批次之外、从没收过它的消息）：没有并发写的风险，当恒为干净处理
      if (!e) return { stillClean: () => true, release: () => {} };
      // 与 hasPendingWrite 同一套判断，原子地在拿到持有的这一刻做：poisoned 的也当有动静（内存状态不可信，不该顺手清掉）
      if (e.poisoned || isDirty(e) || e.inflight !== null) return null;
      e.purgeHeld = true;
      const genAtHold = e.gen;
      let released = false;
      return {
        stillClean: () => e.gen === genAtHold,
        release: () => {
          if (released) return;
          released = true;
          e.purgeHeld = false;
          // 持有期间来过改动（gen 变了）：kick 当时被 purgeHeld 挡住了，补一次，不然要等下一次不相关的改动才会被捎带落库
          if (isDirty(e)) kick(e);
        },
      };
    },
    jobsTx(fn) {
      if (conflict) return Promise.reject(new JobsTxRefused('conflict'));
      if (closed) return Promise.reject(new JobsTxRefused('closed'));
      if (!d.writable()) return Promise.reject(new JobsTxRefused('held_by_other'));
      return detached(() => withTenant(d.db, ctx, fn));
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
    queuedTelemetry(sessionId) {
      const e = entries.get(sessionId);
      const n = (t: Required<TelemetryRows>): number => t.traces.length + t.guards.length + t.outbound.length;
      return e ? n(e.telemetry) + (e.inflight ? n(e.inflight.telemetry) : 0) : 0;
    },
  };
}
