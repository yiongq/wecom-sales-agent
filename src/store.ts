// 会话存储门面（docs/architecture/02-conversations-workbench/spec.md「两种会话存储与启动」）。
// 内存里的两张 Map 是本进程的权威，getSession / getOrder / saveSession 都是同步的；持久化交给后端：
// 文件存储是 var/sessions.json、var/orders.json 的整文件重写（src/store/file-backend.ts）；db 存储（SESSION_STORE=db）
// 另由 PG 后端管真实会话，demo 类会话仍走文件（R6）。
// 导入期行为与存储模式无关（R3）：读 JSON、探针、exit 钩子、信号接线（src/shutdown.ts）、保鲜与清理定时器；
// db 存储另由 boot() 在 initConfig 之后调 initSessionStore。
// 注意：数据权威在本进程内存，多副本部署会脑裂——本项目按单实例设计（01 的租户锁拒绝第二个进程）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { configMode, configRuntime, tenantLockTaken } from './config/source.js';
import { withTenant, type Db, type Tx } from './db/client.js';
import type { InboxStateWrite } from './db/repo/channel-inbox.js';
import { writeAuditAs, type AuditEntry } from './db/repo/audit.js';
import { numEnv } from './env.js';
import { convLabel, setConvRefResolver } from './log.js';
import { profile } from './profile.js';
import { INBOX_ABANDON_REASONS, type InboxAbandonReason } from './shared/channel-types.js';
import { shortIdOf } from './shared/conversation.js';
import { gracefulExit, onShutdown } from './shutdown.js';
import {
  SessionStoreStartupError,
  StoreLaggingError,
  type SessionStoreMode,
  type StoreBackend,
  type StoreHealth,
} from './store/backend.js';
import { onCommitted, onHandoffUnsaved, type DomainEvent, type HandoffStartedEvent } from './store/events.js';
import { createFileBackend } from './store/file-backend.js';
import {
  JobsTxRefused,
  openPgBackend,
  type AuditActor,
  type ConsentItem,
  type JobOp,
  type MarkSendingResult,
  type PgBackend,
  type PgStoreStats,
  type PurgeHold,
  type TelemetryRows,
} from './store/pg-backend.js';
// isDemoClassId 与标记文件名在纯模块里：第 6 步的命令行要用，依赖规则不许它们 import store.ts
import { isDemoClassId, SESSIONS_IN_DB_MARKER } from './store/project.js';
import { linkTurn, noteWindowReset, seqOf, turnIdOf, windowStartOf } from './store/seq.js';
import { flushUsageDaily, startUsageDaily } from './trace/usage-daily.js';
import type { ChatMessage, MessageAuthor, Session, Order } from './types.js';

export { gracefulExit, onShutdown, runShutdownHooks } from './shutdown.js';
export {
  JobsTxRefused,
  SessionStoreStartupError,
  StoreLaggingError,
  onCommitted,
  onHandoffUnsaved,
  seqOf,
  noteWindowReset,
  isDemoClassId,
  SESSIONS_IN_DB_MARKER,
  linkTurn,
  turnIdOf,
  windowStartOf,
};
export type {
  AuditActor,
  ConsentItem,
  DomainEvent,
  HandoffStartedEvent,
  JobOp,
  MarkSendingResult,
  SessionStoreMode,
  StoreHealth,
  TelemetryRows,
};
/** 一行发送账本（落库的形状，02 的列加 03 的几列）：src/quota 经这里取，不直接 import src/db/** */
export type OutboundRow = NonNullable<TelemetryRows['outbound']>[number];
/** 回执改库的结果（markOutboundFailedInDb） */
export type OutboundFailResult = { ok: true; sessionId: string | null } | { ok: false };

// 数据变更事件：SSE 后台看板据此实时推送（发 'change'）
export const storeEvents = new EventEmitter();
storeEvents.setMaxListeners(100);

/**
 * 写库的事故（02 spec「可观测性与告警」的 store 告警，startAlerts 订阅）：conflict 是落库撞上另一写者（随后优雅停机），
 * spill 是 drain 段结束时还有真实会话没落库、退出时要写进 spill 文件。只带会话短码与个数
 */
export type StoreIncident = { kind: 'conflict'; detail: string } | { kind: 'spill'; sessions: number };
const incidentHooks = new Set<(i: StoreIncident) => void>();
export function onStoreIncident(cb: (i: StoreIncident) => void): () => void {
  incidentHooks.add(cb);
  return () => incidentHooks.delete(cb);
}
function incident(i: StoreIncident): void {
  for (const cb of incidentHooks) {
    try {
      cb(i);
    } catch {
      /* 订阅者出错不影响停机 */
    }
  }
}

// VAR_DIR 可用 env 覆盖（selftest 指到临时目录，避免污染真实数据）
const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');

/** 数据目录：boot 拼 initSessionStore 的依赖用，与本模块读写的是同一个 */
export function varDir(): string {
  return VAR_DIR;
}

const sessions = new Map<string, Session>();
const orders = new Map<string, Order>();
/** 被保留期清理或行权删除移出内存的会话对象（第 16 步）：拿着旧对象的 saveSession 记一行日志、不执行 */
const tombstoned = new WeakSet<Session>();

/** PG 后端，db 存储下由 initSessionStore 装上；装上之前与文件存储下都是 null */
let pgBackend: PgBackend | null = null;

const fileBackend = createFileBackend({
  varDir: VAR_DIR,
  sessions,
  orders,
  owns: (id) => !pgBackend || isDemoClassId(id),
  // 孤儿订单（所属会话不在内存里）也留在 JSON，由文件后端原样保留（spec「导入、导出与切换」）；同 id 的会话建出来、
  // 订单被 PG 后端收养之后，在它随会话在库里提交过一次之前仍归文件后端（崩溃不丢），提交之后 ordersTaken 才让 JSON 去掉它
  ownsOrder: (o) => !pgBackend || isDemoClassId(o.sessionId) || !sessions.has(o.sessionId) || pgBackend.adoptedUncommitted(o.id),
  isReal: (id) => !isDemoClassId(id),
  afterPersist: () => storeEvents.emit('change'),
});
fileBackend.load();
fileBackend.probe();

/** 这个会话的改动交给哪个后端：db 存储下真实会话走 PG，其余（demo 类、文件存储）走文件 */
const backendFor = (sessionId: string): StoreBackend => (pgBackend && !isDemoClassId(sessionId) ? pgBackend : fileBackend);
/** 只管内存里有的会话的 PG 后端：db 存储下的真实会话；孤儿订单（所属会话不在内存里）与 demo 类归文件后端 */
const pgFor = (sessionId: string): PgBackend | null =>
  pgBackend && !isDemoClassId(sessionId) && sessions.has(sessionId) ? pgBackend : null;

let changeTimer: NodeJS.Timeout | null = null;
/**
 * db 存储下真实会话的提交：旧的 /api/admin/stream 照样收到 storeEvents 的 change（与文件后端一样约 200ms 合并一次），
 * 只在提交之后（不变量 10）。文件存储下 change 仍由文件后端在每次去抖落盘之后发
 */
function committedChange(): void {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    storeEvents.emit('change');
  }, 200);
  changeTimer.unref();
}

/** 当前装着的会话存储：装上 PG 后端之后是 'db'，否则 'file'。SESSION_STORE 的取值由 01 的 initConfigFromEnv 校验 */
export function sessionStoreMode(): SessionStoreMode {
  return pgBackend ? 'db' : 'file';
}

export interface SessionStoreDeps {
  db: Db;
  tenantId: string;
  /** 补写标记文件时记进 tenant（与 import-sessions 写的同一种内容） */
  tenantSlug: string;
  varDir: string;
}

/**
 * 导入期已经按文件后端读好 JSON（两种模式相同，R3）。
 * deps 为 null（文件存储）：var/ 下有标记文件时以 sessions_in_db reject，否则立即 resolve。
 * deps 不为 null（db 存储）：分批预载真实会话与订单（R2）→ 校验（每个会话的 last_seq 与窗口一致、订单引用的会话都在、
 * 库里没有 demo 类）→ 回放 spill 文件 → 装上 PG 后端 → 登记 drain 与 late 两段停机钩子。
 * 预载之前先查 JSON：sessions.json 里有真实会话（不是 demo 类）就以 real_in_json reject、JSON 原样不动（db 存储下 JSON
 * 只装 demo 类，R6；不拒绝的话，没碰过的真实会话会在下一次 demo 落盘时从 sessions.json 消失，库里也没有）。
 * 装上之后 var/ 里没有标记文件就补写一份（没经过 import-sessions、直接以 db 存储起的实例）。
 * 任何一步失败都以 SessionStoreStartupError reject，不留半装载状态，绝不回落到文件存储。
 */
export async function initSessionStore(deps: SessionStoreDeps | null): Promise<void> {
  if (deps === null) {
    if (fs.existsSync(path.join(VAR_DIR, SESSIONS_IN_DB_MARKER))) {
      throw new SessionStoreStartupError(
        'sessions_in_db',
        `${VAR_DIR} 下有 ${SESSIONS_IN_DB_MARKER}：真实会话在库里，要切回文件存储先跑 export-sessions`,
      );
    }
    return;
  }
  // 装过一次再调：会话已经由库管着（只可能是调用方调了两次，自测与 eval 才会碰到）
  if (pgBackend) throw new SessionStoreStartupError('sessions_in_db', 'PG 会话存储已经装上了，initSessionStore 只能调一次');
  const real = [...sessions.keys()].filter((id) => !isDemoClassId(id));
  if (real.length) {
    const shown = real.slice(0, 5).map((id) => shortIdOf(id) || '?');
    throw new SessionStoreStartupError(
      'real_in_json',
      `sessions.json 里有 ${real.length} 个真实会话（${shown.join('、')}${real.length > shown.length ? ' 等' : ''}）：` +
        'db 存储下 JSON 只装 demo 类，先跑 import-sessions 把它们导进库',
    );
  }
  const backend = await openPgBackend({
    ...deps,
    sessions,
    orders,
    onConflict: (detail) => {
      incident({ kind: 'conflict', detail });
      gracefulExit(1, `store_conflict（${detail}）：落库撞上另一写者`);
    },
    writable: () => !tenantLockTaken(),
    afterCommit: committedChange,
    ordersTaken: (ids) => fileBackend.markChanged(ids),
    outboundCommitted: (rows) => {
      for (const cb of outboundCommitHooks) {
        try {
          cb(rows);
        } catch (e) {
          console.error('[store] 出站行提交的订阅者出错（已忽略）:', e instanceof Error ? e.name : e);
        }
      }
    },
  });
  backend.install();
  pgBackend = backend;
  ensureMarker(deps);
  onShutdown(
    async ({ deadline }) => {
      const { undrained } = await drainStore(Math.max(0, deadline - Date.now()));
      const real = undrained.filter((id) => !isDemoClassId(id));
      if (real.length) {
        console.error(
          `[store] drain 段结束时还有 ${real.length} 个会话没落库（${real.map((id) => shortIdOf(id)).join('、')}），退出时写进 spill`,
        );
        incident({ kind: 'spill', sessions: real.length });
      }
    },
    { phase: 'drain' },
  );
  onShutdown(() => backend.close(), { phase: 'late' });
  // 用量：每 30 秒与 drain 段累加进 usage_daily（spec「逐轮 trace、护栏事件与用量」），不经会话写队列。已冲突、租户锁在别人手里时不写
  startUsageDaily((deltas) => backend.writeUsage(deltas));
  onShutdown(() => flushUsageDaily(), { phase: 'drain' });
}

/**
 * db 存储装上之后，数据目录里没有标记文件就补写一份（{ tenant, at, sessions: 预载的真实会话数 }，先写临时文件再改名）：
 * 没经过 import-sessions、一上来就以 db 存储起的实例（新实例、新租户）也有它，之后去掉 SESSION_STORE 时文件存储照样以
 * sessions_in_db 拒绝（不变量 15），deploy.sh 的回滚前检查也认得出。写不进去只记一行错误、照常启动：db 存储本身是好的，
 * 回滚前检查另外看 .env 的 SESSION_STORE，下次启动再补
 */
function ensureMarker(deps: SessionStoreDeps): void {
  const file = path.join(deps.varDir, SESSIONS_IN_DB_MARKER);
  if (fs.existsSync(file)) return;
  const real = [...sessions.keys()].filter((id) => !isDemoClassId(id)).length;
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ tenant: deps.tenantSlug, at: new Date().toISOString(), sessions: real })}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(
      `[store] ⚠️ 补写 ${SESSIONS_IN_DB_MARKER} 失败（${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.name : 'unknown')}）：` +
        '去掉 SESSION_STORE=db 之前先跑 export-sessions',
    );
  }
}

/** 等这个会话当前的改动落库（db）或落盘（file）。超时以 StoreLaggingError reject，改动仍在写队列里 */
export function flushSession(id: string, opts?: { timeoutMs?: number }): Promise<void> {
  return backendFor(id).flush(id, opts);
}

/** drain 阶段调用：排空所有写队列；超时返回还没落库的会话 id（日志只写短码） */
export async function drainStore(timeoutMs: number): Promise<{ undrained: string[] }> {
  const parts = await Promise.all([fileBackend, ...(pgBackend ? [pgBackend] : [])].map((b) => b.drain(timeoutMs)));
  return { undrained: parts.flatMap((p) => p.undrained) };
}

/** 改动随这个会话的下一次落库提交；提交后才交给 onCommitted 的订阅者 */
export function emitAfterCommit(sessionId: string, ev: DomainEvent): void {
  (pgFor(sessionId) ?? fileBackend).emitAfterCommit(sessionId, ev);
}

// ---------------- 排进「这个会话下一次落库」的附带行 ----------------
// db 存储的真实会话随它的下一次落库提交（spec「identity map 与写入」第 5、6 步）。demo 类会话的 trace、账本、同意记录只在内存（R6），
// 文件存储下这几类也只在内存（R16）；审计例外，见 queueAudit。第 5 步只有订单与审计真有生产者，其余的生产者在第 9、10、12、16 步

/**
 * 一行审计（带操作者与 IP）：db 存储的真实会话随它的下一次落库写；db 存储的 demo 类会话（以及内存里没有的会话）单独一个短事务（R6）。
 * 文件存储（02 第 13 步定）：DB 配置模式下同样单独一个短事务（与 db 存储的 demo 类同一个做法，只试一次、失败记一行）；
 * 文件配置模式没有审计表，不写
 */
export function queueAudit(sessionId: string, actor: AuditActor, entry: AuditEntry): void {
  const pg = pgFor(sessionId);
  if (pg) pg.queueAudit(sessionId, { actor, entry });
  else if (pgBackend) void pgBackend.writeStandaloneAudit({ actor, entry });
  else if (configMode() === 'db') void writeFileModeAudit(actor, entry);
}

/** 文件存储下审计的短事务在空的异步上下文里起：调用方在 withTenant 回调里排审计也不会嵌套（同 PG 后端的写队列） */
const detachedAudit = AsyncLocalStorage.snapshot();
async function writeFileModeAudit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    const { db, tenantId } = configRuntime();
    await detachedAudit(() => withTenant(db, { tenantId, actor }, (tx) => writeAuditAs(tx, actor, entry)));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    console.error(`[store] 审计没写进去（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}）：${entry.action}`);
  }
}

/**
 * 写库跟不上（02 spec「接手、人工回复与交还」）：这个会话所在的后端积压超过 5 秒、已冲突，或这个会话因数据类错误停写（poisoned）。
 * 人工回复与订单动作在改动之前查它，是真就 503 store_lagging、什么都不改
 */
export function storeLagging(sessionId: string): boolean {
  const b = backendFor(sessionId);
  const h = b.health();
  return h.lagMs > 5000 || h.conflict || (pgBackend !== null && b === pgBackend && pgBackend.isPoisoned(sessionId));
}

/**
 * 这个会话等提交（flushSession）失败之后，还会不会再提交（审查第 4、5 条，concurrency[0][1]）：已冲突（优雅停机，没落库的
 * 转去 spill）或这个会话因数据类错误停写（poisoned）就不会再提交；与 storeLagging 不同之处是不看 lagMs——
 * 只是还没到 5 秒、或刚好卡在重试退避里，仍可能提交，不算「不会再提交」。
 * 等提交之后的分支（人工回复、付款确认）据此区分「真超时，照发，persisted:false」与「不会再提交，不发，503」
 */
export function storeUnrecoverable(sessionId: string): boolean {
  const b = backendFor(sessionId);
  const h = b.health();
  return h.conflict || (pgBackend !== null && b === pgBackend && pgBackend.isPoisoned(sessionId));
}
/**
 * 这个会话有没有未落库的改动，或正在落库（第 16 步保留期清理据此跳过有动静的会话：库里读到的候选可能已经过期）。
 * 文件存储、demo 类、内存里没有这个会话恒为 false
 */
export function pendingWrite(sessionId: string): boolean {
  return pgFor(sessionId)?.hasPendingWrite(sessionId) ?? false;
}
/**
 * 保留期清理专用（第 16 步审查第二轮，spec「保留期」「逐个在它的写队列上处理」）：挂起这个会话的写队列、
 * 原子地核过没有动静（与 pendingWrite 同一套判断，但不留 TOCTOU 的缝——判断与挂起是一次调用）。
 * 返回 null 时调用方当「有动静」跳过这个候选；拿到句柄之后见 `PurgeHold` 的文档注释。文件存储、demo 类恒为一个空句柄
 */
export function holdForPurge(sessionId: string): PurgeHold | null {
  return pgFor(sessionId)?.holdForPurge(sessionId) ?? { stillClean: () => true, release: () => {} };
}
/**
 * 保留期清理成功删除一个会话之后，同一个 tick 把它从 identity map 与 PG 后端的写队列簿记里摘掉（第 16 步，`pg-backend` 的
 * `forget(id)`）：否则这个会话的下一次落库会发现行不在了，按 `StoreConflictError` 处理、整个进程优雅停机。
 * 旧的 Session 对象进墓碑：之后拿着它的 `saveSession` 只记一行日志，不执行；客户再来时 `getSession` 建的是新对象。
 * 它名下的订单（`Order.sessionId` 一直要求是 string，不改成可选）也一并从内存订单表摘掉——库里那一行按 spec 保留
 * （清除函数把 session_id 置空、保留订单行作成交记录），但内存里不留一个 sessionId 已经找不到会话的订单；
 * 后台 `/orders`、成交额 KPI 都是从 identity map 算的，清理之后自然看不到这张单了（与种子/访客会话清理同一种做法）
 */
export function forgetSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    tombstoned.add(s);
    for (const oid of s.orderIds ?? []) orders.delete(oid);
  }
  sessions.delete(sessionId);
  pgFor(sessionId)?.forget(sessionId);
  forgetSessionProbe?.(sessionId);
}
/** 仅供自测：forgetSession 每次真的摘掉一个会话时同步调一次，见 __storeTest.setForgetSessionProbe */
let forgetSessionProbe: ((sessionId: string) => void) | null = null;
/** 任务的排程与状态变化（第 10 步）：db 存储的真实会话随它的下一次落库写，其余不入库 */
export function queueJobs(sessionId: string, ops: readonly JobOp[]): void {
  pgFor(sessionId)?.queueJobs(sessionId, ops);
}
/**
 * 给这个会话还没提交的 enqueue（dedupeKey 相同的）的 payload 并进几个字段，返回改了几个（第 14 步：unsaved 通知发出之后给立即的那个
 * handoff_notify 标上 unsavedSent，提交或经 spill 回放之后执行到它时不补发）。文件存储与 demo 类恒为 0
 */
export function patchQueuedJob(sessionId: string, dedupeKey: string, patch: Record<string, unknown>): number {
  return pgFor(sessionId)?.patchQueuedJob(sessionId, dedupeKey, patch) ?? 0;
}
/**
 * 经 queueJobs 排的、带 report 的状态变化已随这个会话的落库提交、而且改中了（取走，只报一次）。跟进在 flushSession 之后据它判断
 * running → sending 是不是本次认领的那一行：没改中（别的认领者归位、重新认领过）就不推送。文件存储与 demo 类恒为 false
 */
export function jobOpApplied(sessionId: string, jobId: string): boolean {
  return pgFor(sessionId)?.jobOpApplied(sessionId, jobId) ?? false;
}
/** 同意记录（第 16 步）：同上 */
export function queueConsents(sessionId: string, items: readonly ConsentItem[]): void {
  pgFor(sessionId)?.queueConsents(sessionId, items);
}
/** trace、护栏事件、账本行（第 9、12 步）：同上，写在存档点里，写失败只丢这几行 */
export function queueTelemetry(sessionId: string, rows: TelemetryRows): void {
  pgFor(sessionId)?.queueTelemetry(sessionId, rows);
}
/**
 * 会话行的 ref（随机 uuid，不含客户标识；02 spec「数据库」conversations.ref）：db 存储下的真实会话有，新会话在第一次落库之前也有
 * （建写队列时生成、插入时写进去）；文件存储与 demo 类会话为 null，调用方退回短码（日志的 conv 同一口径，R24）
 */
export function conversationRef(sessionId: string): string | null {
  return pgFor(sessionId)?.refOf(sessionId) ?? null;
}
// 日志的 conv（R24）：db 存储的真实会话写 ref，其余由 log.ts 退回短码
setConvRefResolver(conversationRef);
/**
 * 任务表的单独短事务（第 10 步：认领、改状态、启动与停机时的归位、与会话无关的排程）：只在 db 存储下有，不经会话写队列。
 * 文件存储下以 JobsTxRefused('closed') reject（文件存储没有任务表，跟进由扫描器驱动）
 */
export function withJobsTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pgBackend ? pgBackend.jobsTx(fn) : Promise.reject(new JobsTxRefused('closed'));
}

/** saveSession 之后的订阅者：只为 db 存储的真实会话调（排、取消跟进，src/jobs/followup.ts）。与 saveSession 同一段同步代码，排出的附带行进同一次落库 */
const saveHooks = new Set<(s: Session) => void>();
export function onSessionSaved(cb: (s: Session) => void): () => void {
  saveHooks.add(cb);
  return () => saveHooks.delete(cb);
}

/** 企微去重集合（第 12 步用）：db 存储下是预载的最近 7 天带 msgid 的客户消息，加上本进程记下的；文件存储下为空 */
export function recentMsgids(sessionId: string): ReadonlySet<string> {
  return pgFor(sessionId)?.recentMsgids(sessionId) ?? new Set();
}

// ---------------- 发送账本（第 12 步，src/quota/ledger.ts）的入口 ----------------
// 账本在内存里。db 存储下：真实会话的账本行经 queueTelemetry 随会话的下一次落库写；下面两个是不经会话写队列的短事务。
// demo 类与文件存储下只在内存

/** 预载的账本行（各会话最后一条客户消息之后的），按会话分组；取走一次。文件存储下为空 */
export function takePreloadedOutbound(): Map<string, OutboundRow[]> {
  return pgBackend?.takePreloadedOutbound() ?? new Map();
}
/** 还没有会话的账本行（老客户补发的欢迎语）：db 存储下单独一个短事务，失败记一行；文件存储下什么都不做 */
export function writeStandaloneOutbound(rows: readonly OutboundRow[]): Promise<void> {
  return pgBackend ? pgBackend.writeStandaloneOutbound(rows) : Promise.resolve();
}
// ---------------- 03 先落库后发送（src/quota/ledger.ts 的 planOutbound 等）的入口 ----------------
// 库里企微账号的出站：pending 插入与 cancelled 随会话的下一次落库写进主事务（R21），结果写在存档点里（queueTelemetry）；
// 标 sending、迁回 pending、没有会话可挂的几行各是一个短事务；会话 poisoned 之后它的出站行（含结果）也改走单独短事务，
// 还没提交的随会话进 spill 的渠道段（第 11 步）。只在 db 存储下有，文件存储下这几个入口什么都不做

const outboundCommitHooks = new Set<(rows: readonly OutboundRow[]) => void>();
/** 主事务里的出站行随会话提交之后调（poisoned 之后的短事务提交了也调；行对象就是 queueOutboundRows 交进来的那几个） */
export function onOutboundCommitted(cb: (rows: readonly OutboundRow[]) => void): () => void {
  outboundCommitHooks.add(cb);
  return () => outboundCommitHooks.delete(cb);
}
/**
 * 出站 pending 插入与 cancelled 排进这个会话的下一次落库（主事务）。db 存储的真实会话、内存里有这个会话时返回 true；
 * 否则 false（调用方改走 writeOutboundNow）
 */
export function queueOutboundRows(sessionId: string, rows: readonly OutboundRow[]): boolean {
  return pgFor(sessionId)?.queueChannel(sessionId, rows) ?? false;
}
/** 没有会话可挂的出站行：单独一个短事务，写成了 true。文件存储下 false */
export function writeOutboundNow(rows: readonly OutboundRow[]): Promise<boolean> {
  return pgBackend ? pgBackend.writeOutboundNow(rows) : Promise.resolve(false);
}
/** markSending 的库里那一步（单独一个短事务，至多等 timeoutMs）。文件存储下 db_unavailable（调用方不该走到这里） */
export function markOutboundSendingInDb(channelMsgid: string, timeoutMs: number): Promise<MarkSendingResult> {
  return pgBackend ? pgBackend.markOutboundSending(channelMsgid, timeoutMs) : Promise.resolve('db_unavailable');
}
/** sending 迁回 pending（停机截止之后、还没发请求的那一段）：单独一个短事务，写成了 true */
export function unmarkOutboundInDb(channelMsgid: string): Promise<boolean> {
  return pgBackend ? pgBackend.unmarkOutbound(channelMsgid) : Promise.resolve(false);
}

/**
 * msg_send_fail 的状态更新：db 存储下单独一个短事务。写成了是 ok，带那一行的会话 id（没找到、已是 failed 为 null）；没写成（库报错、
 * 冲突、late 段之后、租户锁在别人手里）不是 ok，调用方据此再试。文件存储下恒为 ok、会话 id 为 null。
 * 03：给了 inboxId（库里账号的回执入站行）时同一个短事务把它记 done；给了 full（本进程计划过的那一整行，状态 failed）时按迁移表
 * upsert 这一行，而不是只 UPDATE（会话 id 为 null）
 */
export function markOutboundFailedInDb(
  channelMsgid: string,
  failType: number,
  inboxId?: string | null,
  full?: OutboundRow | null,
): Promise<OutboundFailResult> {
  return pgBackend ? pgBackend.markOutboundFailed(channelMsgid, failType, inboxId, full) : Promise.resolve({ ok: true, sessionId: null });
}

// ---------------- 03 入站：channel_inbox 的状态变化（src/channels/inbox.ts 与企微适配器、引擎） ----------------
// docs/architecture/03-channels-v2/spec.md「入站：channel_inbox」、R3、R21，不变量 3、8。只在 db 存储下有；文件存储下这几个入口什么都不做

/** 一次入站状态变化（spec 的 queueInboxState 参数）。recorded 带上这条客户消息（取它分到的 seq） */
export interface InboxChange {
  inboxId: string;
  state: 'recorded' | 'replied' | 'done' | 'abandoned';
  message?: ChatMessage;
  reason?: InboxAbandonReason;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INBOX_CHANGE_STATES: ReadonlySet<string> = new Set(['recorded', 'replied', 'done', 'abandoned']);

/**
 * 排进落库之前的同步校验（R21：会撞约束的在这里拦下，不进事务、不让会话 poisoned）：inboxId 是 uuid、状态是这四种之一、
 * reason 只跟着 abandoned 且是认得的原因。过了返回要写的那一行；没过记一行错误、返回 null（这次变化不写，入站行停在之前的状态，
 * 重启时由启动恢复处理）。recorded 的 message_seq 取这条消息此刻分到的 seq（调用方在 saveSession 之后同一段同步代码里排）
 */
function inboxWriteOf(change: InboxChange): InboxStateWrite | null {
  const reason = change.reason ?? null;
  const bad = !UUID_RE.test(change.inboxId)
    ? 'inboxId 不是 uuid'
    : !INBOX_CHANGE_STATES.has(change.state)
      ? `状态 ${String(change.state)} 不能随落库写`
      : (change.state === 'abandoned') !== (reason !== null)
        ? 'reason 只跟着 abandoned'
        : reason !== null && !INBOX_ABANDON_REASONS.includes(reason)
          ? `不认识的 reason ${String(reason)}`
          : null;
  if (bad) {
    console.error(`[store] ⚠️ 一次入站状态变化没过校验（${bad}），这次不写`);
    return null;
  }
  const seq = change.message ? seqOf(change.message) : undefined;
  if (change.message && seq === undefined)
    console.error('[store] ⚠️ recorded 的客户消息还没分到 seq（应在 saveSession 之后排），message_seq 记空');
  return { inboxId: change.inboxId, state: change.state, reason, messageSeq: seq ?? null };
}

/**
 * 入站状态变化随这个会话的下一次落库写进主事务（不在存档点里，R21）：recorded 与这条客户消息同一次提交、message_seq 是它分到的 seq
 * （不变量 3）；replied 与回复的出站 pending 同一次提交；done、abandoned 与引起它的会话改动同一次提交。同一次落库里同一行的几次变化
 * 按排进来的先后逐条写。db 存储下内存里没有这个会话（已被清除、demo 类）时改走单独短事务（迁移表让它对已清除的行是无操作）。
 * 会话已 poisoned：pg 后端改走单独短事务（R21，写不进去留在内存里 1 秒后再试、停机时进 spill）；还没提交的随会话进 spill 的渠道段
 * （InboxStateWrite 只有 JSON 能装的值）
 */
export function queueInboxState(sessionId: string, change: InboxChange): void {
  const w = inboxWriteOf(change);
  if (!w || !pgBackend) return;
  const pg = pgFor(sessionId);
  if (pg?.queueInbox(sessionId, [w])) return;
  void pgBackend.writeInboxNow([w]);
}

/**
 * 没有会话可挂的入站状态变化（回执、没建出会话的毒消息、过期的消息）：单独一个短事务。写成了 true；文件存储与没过校验的 false
 */
export function writeInboxStateNow(change: {
  inboxId: string;
  state: 'done' | 'abandoned';
  reason?: InboxAbandonReason;
}): Promise<boolean> {
  const w = inboxWriteOf(change);
  if (!w || !pgBackend) return Promise.resolve(false);
  return pgBackend.writeInboxNow([w]);
}

/**
 * 03 入站的单独短事务（src/channels/inbox.ts 的 acceptPage、beginAttempt、load）：不经会话写队列。已冲突、late 段之后、租户锁在别人手里
 * 时以 JobsTxRefused reject；文件存储下以 JobsTxRefused('closed') reject（文件存储没有 channel_inbox）
 */
export function withChannelTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pgBackend ? pgBackend.channelTx(fn) : Promise.reject(new JobsTxRefused('closed'));
}

/** 写库健康：db 存储下是 PG 后端的（只数真实会话），文件存储下是文件后端的 */
export function storeHealth(): StoreHealth {
  return (pgBackend ?? fileBackend).health();
}

/**
 * 告警读的两个计数（02 spec 的 store 告警）：丢掉的遥测批次（存档点里写失败的、poisoned 会话丢掉的），启动时回放失败、改名 .failed
 * 的 spill 文件数。只在 db 存储下有，文件存储下为 null
 */
export function storeCounters(): { telemetryDropped: number; replayFailedFiles: number } | null {
  if (!pgBackend) return null;
  const s = pgBackend.stats();
  return { telemetryDropped: s.telemetryDropped, replayFailedFiles: s.replayFailedFiles };
}

/**
 * 跳过 200ms 去抖、立刻同步落盘。只给「写完必须马上落地」的场景用：自动跟进先记账再外发，
 * 记账还在去抖窗口里时进程被 SIGKILL / OOM 杀掉，重启后同一条跟进会再发一遍。
 */
export function flushStoreNow(): void {
  fileBackend.flushNow();
}

// 退出兜底：没落盘的变更在进程结束前同步写出（文件），没落库的真实会话写进 spill 文件（PG）
process.on('exit', () => {
  fileBackend.spillSync();
  pgBackend?.spillSync();
});

// ---------------- demo 数据保鲜 ----------------
// 种子演示会话（id 形如 wecom:cust_B01，真实企微 external_userid 不会长这样）的时间戳
// 是灌入时定死的：放几天后后台全是「N 天未回应」，工作台像个废弃系统——对外演示时
// 观感极差。这里定期把演示数据整体平移到「最新一条像 5 分钟前」，相对间隔不变；
// 真实客户会话（wecom: 非 cust_ / sim-）绝不触碰。开关 seed_freshen 关闭时不动（prod 封顶为关；旧变量 DEMO_FRESHEN=0 等价于关）。
const DEMO_SESSION_RE = /^wecom:cust_/;

export function freshenDemoData(): void {
  if (!profile().flags.seed_freshen) return;
  const demo = [...sessions.values()].filter((s) => DEMO_SESSION_RE.test(s.id));
  if (!demo.length) return;
  const newest = Math.max(...demo.map((s) => s.updatedAt));
  const delta = Date.now() - 5 * 60_000 - newest; // 最新演示会话恒定在 5 分钟前
  if (delta < 60_000) return; // 已足够新，避免无意义抖动
  for (const s of demo) {
    s.createdAt += delta;
    s.updatedAt += delta;
    for (const m of s.messages ?? []) m.at += delta;
    // 02 的转人工记录与接手人也是会话上的时刻，不跟着挪的话 handoff.at 会早于触发它的那句、firstHandoffAt 早于 createdAt。
    // sentAt 只有真实企微消息才带，种子没有
    if (s.handoff) s.handoff.at += delta;
    if (s.firstHandoffAt != null) s.firstHandoffAt += delta;
    if (s.assignee) s.assignee.at += delta;
  }
  for (const o of orders.values()) {
    if (DEMO_SESSION_RE.test(o.sessionId)) {
      o.createdAt += delta;
      if (o.paidAt) o.paidAt += delta;
      // 02 第 13 步起后台能确认种子订单的价格：确认时刻同样跟着挪
      if (o.confirmedAt != null) o.confirmedAt += delta;
    }
  }
  fileBackend.markChanged(demo.map((s) => s.id));
  console.log(`[store] demo 保鲜：${demo.length} 个演示会话时间前移 ${(delta / 3_600_000).toFixed(1)} 小时`);
}

// 网页模拟器体验数据自动清理：链接放到公开渠道后，访客点 chat.html 产生的会话
// 人人可见且越积越多。DEMO_PRUNE_HOURS>0 时每小时清一次闲置超过该小时数的**模拟器**会话。
//
// 白名单式判定，只清 sim- 网页访客：企微真实客户会话 id 是 `wecom:<external_userid>`，
// 与种子的 `wecom:cust_*` 只差前缀——用「非种子即可删」的黑名单写法会把真实客户
// 连人带订单删掉（客户第二天回消息时历史全无、已发出的支付链接 404）。
// 另：已支付订单是唯一的成交凭证，任何情况下都不删。
// 默认 24 小时（此前默认 0 = 不清理）。链接一对外公开，访客会话就只涨不掉，
// 而它们既占内存又让每次落盘都要重新序列化全量数据。DEMO_PRUNE_HOURS=0 可显式关闭。
const PRUNE_MS = Math.max(0, numEnv('DEMO_PRUNE_HOURS', 24)) * 3_600_000;
const VISITOR_SESSION_RE = /^sim-/;

/**
 * 访客会话总量硬上限。按时间清理挡不住突发：/api/chat 是公开匿名端点、限流键来自
 * 可伪造的 XFF，脚本几分钟就能刷出几十万条会话，而 persistNow 是全量同步序列化——
 * 到那时每条真实客户消息都要等一次几百 MB 的同步写。超限就按 updatedAt 淘汰最旧的，
 * 已支付订单对应的会话是成交凭证，任何情况下都不动。
 */
const VISITOR_SESSION_MAX = Math.max(100, numEnv('VISITOR_SESSION_MAX', 5000));

function hasPaidOrder(s: Session): boolean {
  return (s.orderIds ?? []).some((oid) => orders.get(oid)?.status === 'paid');
}

function evictExcessVisitorSessions(): void {
  const visitors = [...sessions.values()].filter((s) => VISITOR_SESSION_RE.test(s.id) && s.channel === 'simulator');
  const excess = visitors.length - VISITOR_SESSION_MAX;
  if (excess <= 0) return;
  const victims = visitors
    .filter((s) => !hasPaidOrder(s))
    .toSorted((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, excess);
  for (const s of victims) {
    sessions.delete(s.id);
    for (const oid of s.orderIds ?? []) orders.delete(oid);
  }
  fileBackend.markChanged(victims.map((s) => s.id));
  if (victims.length) {
    console.warn(`[store] 网页访客会话超过上限 ${VISITOR_SESSION_MAX}，已淘汰最旧的 ${victims.length} 个`);
  }
}

export function pruneStaleVisitorData(): void {
  if (!PRUNE_MS) return;
  const cutoff = Date.now() - PRUNE_MS;
  const gone: string[] = [];
  for (const s of sessions.values()) {
    if (!VISITOR_SESSION_RE.test(s.id) || s.channel !== 'simulator') continue;
    if (s.updatedAt >= cutoff) continue;
    if (hasPaidOrder(s)) continue; // 有成交记录，保留
    sessions.delete(s.id);
    for (const oid of s.orderIds ?? []) orders.delete(oid); // 连同订单一起删，不留孤儿
    gone.push(s.id);
  }
  const n = gone.length;
  if (n) {
    fileBackend.markChanged(gone);
    console.log(`[store] 已清理 ${n} 个闲置网页访客会话（阈值 ${PRUNE_MS / 3_600_000}h，仅 sim-）`);
  }
}

// 启动即保鲜/清理一次，此后每小时一次（unref 不阻退出）
freshenDemoData();
pruneStaleVisitorData();
setInterval(() => {
  freshenDemoData();
  pruneStaleVisitorData();
}, 60 * 60_000).unref();

export function getOrCreateSession(id: string, channel: string): Session {
  let s = sessions.get(id);
  if (!s) {
    const now = Date.now();
    s = {
      id,
      channel,
      stage: 'greeting',
      profile: {},
      messages: [],
      orderIds: [],
      handedOver: false,
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(id, s);
    // 新建访客会话时顺手检查总量，别等到下一次整点清理才发现已经被灌爆
    if (VISITOR_SESSION_RE.test(id) && channel === 'simulator') evictExcessVisitorSessions();
    backendFor(id).schedule(s);
  }
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 落盘会话：同步给新消息分配 seq（返回时新消息已有 seq，不变量 8）、标脏并排进这个会话的写队列。
 * 默认把 updatedAt 刷新为现在——它代表「这条会话最后一次有动静」。
 * touch=false 用于系统主动写入（如自动跟进）：跟进不该把客户的沉默时长清零，
 * 否则后台「N 小时未回应」失真、介入队列会漏掉真正该救的客户。
 */
export function saveSession(s: Session, touch = true): void {
  // 这个对象已经被保留期清理或行权删除摘掉（第 16 步）：库里那一行已经没了，不能再落库；日志一行、什么都不改
  if (tombstoned.has(s)) {
    console.log(`[store] 会话已被清理，忽略这次落库（会话 ${convLabel(s.id)}）`);
    return;
  }
  const b = backendFor(s.id);
  // db 存储下 identity map 里的对象是唯一的（不变量 3）：同 id 的另一个对象，PG 后端记一行日志、不落库，也不换掉 map 里的
  if (b === pgBackend && !pgBackend.accepts(s)) return;
  if (touch) s.updatedAt = Date.now();
  sessions.set(s.id, s);
  const unseq = unseqTail(s);
  b.schedule(s);
  emitSaved(s, unseq);
  if (b !== pgBackend) return;
  for (const cb of saveHooks) {
    try {
      cb(s);
    } catch (e) {
      console.error('[store] saveSession 的订阅者出错（已忽略）:', e instanceof Error ? e.name : e);
    }
  }
}

/** 消息数组尾部还没分配 seq 的消息（这次 saveSession 要分配的那一段）；畸形的旧数据（没有 messages、数组里有 null）跳过 */
function unseqTail(s: Session): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (!Array.isArray(s.messages)) return out;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (typeof m !== 'object' || m === null) continue;
    if (seqOf(m) !== undefined) break;
    out.unshift(m);
  }
  return out;
}

/** 事件里的作者：客户、系统原样，agent 消息看 author（缺省是 AI） */
const authorOf = (m: ChatMessage): MessageAuthor => (m.role === 'agent' ? (m.author ?? 'ai') : m.role);

/**
 * 每次 saveSession 排两类提交后的领域事件（02 第 13 步，后台的事件流与计数据此推送）：这次分到 seq 的每条消息一个 message.appended，
 * 会话本身一个 conversation.changed。只有 id、seq 与作者，不带正文（不变量 31）。停写（poisoned）的会话不再提交，不排
 */
function emitSaved(s: Session, unseq: readonly ChatMessage[]): void {
  if (pgBackend?.isPoisoned(s.id)) return;
  for (const m of unseq) {
    const seq = seqOf(m);
    if (seq !== undefined) emitAfterCommit(s.id, { type: 'message.appended', id: s.id, seq, author: authorOf(m) });
  }
  emitAfterCommit(s.id, { type: 'conversation.changed', id: s.id });
}

/** 订单改动的提交后事件（后台事件流的 order） */
function emitOrder(o: Order): void {
  emitAfterCommit(o.sessionId, {
    type: 'order.changed',
    id: o.sessionId,
    orderId: o.id,
    status: o.status,
    confirmed: o.confirmedAt != null,
  });
}

/**
 * 不经 createOrder / markOrderPaid / supersedeOrder 的订单改动（02 第 13 步，后台的确认价格、确认收款、取消订单，src/payment/orders.ts）：
 * 排进订单所属会话的下一次落库，提交后发 order.changed
 */
export function saveOrder(o: Order): void {
  if (orders.get(o.id) !== o) return;
  (pgFor(o.sessionId) ?? fileBackend).scheduleOrder(o.id);
  emitOrder(o);
}

/** 入参不含 id/createdAt/status，由 store 统一生成 */
export function createOrder(o: Omit<Order, 'id' | 'createdAt' | 'status'>): Order {
  const order: Order = {
    ...o,
    // 订单号即凭据：/api/orders/:id 与 /pay 都是匿名可访问的（支付页要用），
    // 所以 ID 必须真的猜不出来。此前截成 8 个十六进制字符只有 32 bit，注释却写着「不可猜」。
    id: 'ord_' + crypto.randomBytes(12).toString('hex'),
    status: 'pending_payment',
    createdAt: Date.now(),
  };
  orders.set(order.id, order);
  (pgFor(order.sessionId) ?? fileBackend).scheduleOrder(order.id);
  emitOrder(order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

/** 只有待付款的单能付。被新订单替代的旧单（superseded）不能再付：此前 status !== 'paid' 就置为已付，
 *  客户点开改单前那条旧链接照样付得了，一趟行程收两笔钱。调用方据返回的 status 判断付没付成。
 *  付款时记下会话是否曾经转过人工（handoffBeforePaid，R9）：转人工的标记交还时会清，firstHandoffAt 不清。
 *  02 之前转的人工没有 firstHandoffAt（导入不回填），付款时正在转人工中的也算转过（不变量 26） */
export function markOrderPaid(id: string): Order | undefined {
  const o = orders.get(id);
  if (!o) return undefined;
  if (o.status === 'pending_payment') {
    o.status = 'paid';
    o.paidAt = Date.now();
    const s = sessions.get(o.sessionId);
    o.handoffBeforePaid = s?.firstHandoffAt != null || s?.handedOver === true;
    (pgFor(o.sessionId) ?? fileBackend).scheduleOrder(id);
    emitOrder(o);
  }
  return o;
}

/** 把待付款的旧单标成被 byId 替代。已付款的单绝不动（返回 false），调用方只拿这个结果决定要不要告诉客户旧链接失效 */
export function supersedeOrder(id: string, byId: string): boolean {
  const o = orders.get(id);
  if (!o || o.status !== 'pending_payment') return false;
  o.status = 'superseded';
  o.supersededBy = byId;
  (pgFor(o.sessionId) ?? fileBackend).scheduleOrder(id);
  emitOrder(o);
  return true;
}

/**
 * 删除某个会话名下的全部订单。仅供「重置」口令使用。
 * 只清 session.orderIds 是不够的——后台按 orderIds 之外还会用 sessionId 反查订单，
 * 而且 GMV / 成交率是直接扫 orders 算的，留着孤儿订单会让重置后的会话
 * 仍然显示订单、仍然计入经营数据。
 * db 存储的真实会话：库里不删，记作废（voided_at、void_reason='reset'），内存里照样移出，之后 getOrder 返回 undefined（R5）
 */
export function deleteOrdersOfSession(sessionId: string): number {
  const pg = pgFor(sessionId);
  let n = 0;
  for (const [id, o] of orders) {
    if (o.sessionId === sessionId) {
      pg?.voidOrder(o, 'reset');
      orders.delete(id);
      n += 1;
    }
  }
  if (n && !pg) fileBackend.markChanged([sessionId]);
  return n;
}

export function listOrders(): Order[] {
  return [...orders.values()].toSorted((a, b) => b.createdAt - a.createdAt);
}

/** 仅供自测：PG 后端的计数（落库次数、认出已提交、慢事务、丢掉的存档点批次等）；文件存储下为 null */
export const __storeTest = {
  pgStats(): PgStoreStats | null {
    return pgBackend?.stats() ?? null;
  },
  /** db 存储下这个会话还留在内存里的遥测行数；文件存储下为 0 */
  pgQueuedTelemetry(sessionId: string): number {
    return pgBackend?.queuedTelemetry(sessionId) ?? 0;
  },
  /** db 存储下这个会话还留在内存里的主事务出站行数（03）；文件存储下为 0 */
  pgQueuedChannel(sessionId: string): number {
    return pgBackend?.queuedChannel(sessionId) ?? 0;
  },
  /** db 存储下这个会话还留在内存里的主事务入站状态变化数（03 第 9 步）；文件存储下为 0 */
  pgQueuedInbox(sessionId: string): number {
    return pgBackend?.queuedInbox(sessionId) ?? 0;
  },
  /** 交给事故的订阅者（store_conflict 会走优雅停机，自测进程里造不出来） */
  emitIncident(i: StoreIncident): void {
    incident(i);
  },
  /**
   * 仅供自测（第 16 步）：核保留期清理「返回 true 就在同一个 tick 里移出内存」（spec「任务表与跟进」）——
   * 不能只看「最后不在内存里」，那样把 forgetSession 延到下一拍（比如包一层 setTimeout）也测不出来，这个窗口里
   * 真有新消息撞上来，要么被墓碑静默吞掉，要么撞到行不存在走 StoreConflictError 优雅停机。做法：调用方在真正调用
   * purgeOnce 之前也排一个 setTimeout(…, 0)，两边都往同一个数组里记一笔；JS 单线程下，只要 forgetSession 与它的
   * 调用方之间没有别的 await，这次记录必定先于任何宏任务（哪怕调用方自己的 setTimeout 排得更早）——这不是猜时序，
   * 是单线程事件循环的语言语义保证
   */
  setForgetSessionProbe(fn: ((sessionId: string) => void) | null): void {
    forgetSessionProbe = fn;
  },
};
