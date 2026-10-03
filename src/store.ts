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
import { EventEmitter } from 'node:events';
import { tenantLockTaken } from './config/source.js';
import type { Db, Tx } from './db/client.js';
import type { AuditEntry } from './db/repo/audit.js';
import { numEnv } from './env.js';
import { setConvRefResolver } from './log.js';
import { profile } from './profile.js';
import { shortIdOf } from './shared/conversation.js';
import { gracefulExit, onShutdown } from './shutdown.js';
import {
  SessionStoreStartupError,
  StoreLaggingError,
  type SessionStoreMode,
  type StoreBackend,
  type StoreHealth,
} from './store/backend.js';
import { onCommitted, type DomainEvent } from './store/events.js';
import { createFileBackend } from './store/file-backend.js';
import {
  JobsTxRefused,
  openPgBackend,
  type AuditActor,
  type ConsentItem,
  type JobOp,
  type PgBackend,
  type PgStoreStats,
  type TelemetryRows,
} from './store/pg-backend.js';
// isDemoClassId 与标记文件名在纯模块里：第 6 步的命令行要用，依赖规则不许它们 import store.ts
import { isDemoClassId, SESSIONS_IN_DB_MARKER } from './store/project.js';
import { linkTurn, noteWindowReset, seqOf, turnIdOf } from './store/seq.js';
import { flushUsageDaily, startUsageDaily } from './trace/usage-daily.js';
import type { Session, Order } from './types.js';

export { gracefulExit, onShutdown, runShutdownHooks } from './shutdown.js';
export {
  JobsTxRefused,
  SessionStoreStartupError,
  StoreLaggingError,
  onCommitted,
  seqOf,
  noteWindowReset,
  isDemoClassId,
  SESSIONS_IN_DB_MARKER,
  linkTurn,
  turnIdOf,
};
export type { AuditActor, ConsentItem, DomainEvent, JobOp, SessionStoreMode, StoreHealth, TelemetryRows };
/** 一行发送账本（落库的形状）：src/quota 经这里取，不直接 import src/db/** */
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
 * 文件存储下不写：会话类审计在文件存储下的去处由第 13 步定
 */
export function queueAudit(sessionId: string, actor: AuditActor, entry: AuditEntry): void {
  const pg = pgFor(sessionId);
  if (pg) pg.queueAudit(sessionId, { actor, entry });
  else if (pgBackend) void pgBackend.writeStandaloneAudit({ actor, entry });
}
/** 任务的排程与状态变化（第 10 步）：db 存储的真实会话随它的下一次落库写，其余不入库 */
export function queueJobs(sessionId: string, ops: readonly JobOp[]): void {
  pgFor(sessionId)?.queueJobs(sessionId, ops);
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
/**
 * msg_send_fail 的状态更新：db 存储下单独一个短事务。写成了是 ok，带那一行的会话 id（没找到、已是 failed 为 null）；没写成（库报错、
 * 冲突、late 段之后、租户锁在别人手里）不是 ok，调用方据此再试。文件存储下恒为 ok、会话 id 为 null
 */
export function markOutboundFailedInDb(channelMsgid: string, failType: number): Promise<OutboundFailResult> {
  return pgBackend ? pgBackend.markOutboundFailed(channelMsgid, failType) : Promise.resolve({ ok: true, sessionId: null });
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
  const b = backendFor(s.id);
  // db 存储下 identity map 里的对象是唯一的（不变量 3）：同 id 的另一个对象，PG 后端记一行日志、不落库，也不换掉 map 里的
  if (b === pgBackend && !pgBackend.accepts(s)) return;
  if (touch) s.updatedAt = Date.now();
  sessions.set(s.id, s);
  b.schedule(s);
  if (b !== pgBackend) return;
  for (const cb of saveHooks) {
    try {
      cb(s);
    } catch (e) {
      console.error('[store] saveSession 的订阅者出错（已忽略）:', e instanceof Error ? e.name : e);
    }
  }
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
  /** 交给事故的订阅者（store_conflict 会走优雅停机，自测进程里造不出来） */
  emitIncident(i: StoreIncident): void {
    incident(i);
  },
};
