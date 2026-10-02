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
import type { Db } from './db/client.js';
import { numEnv } from './env.js';
import { profile } from './profile.js';
import {
  SessionStoreStartupError,
  StoreLaggingError,
  type SessionStoreMode,
  type StoreBackend,
  type StoreHealth,
} from './store/backend.js';
import { onCommitted, type DomainEvent } from './store/events.js';
import { createFileBackend } from './store/file-backend.js';
import { seqOf } from './store/seq.js';
import type { Session, Order } from './types.js';

export { gracefulExit, onShutdown, runShutdownHooks } from './shutdown.js';
export { SessionStoreStartupError, StoreLaggingError, onCommitted, seqOf };
export type { DomainEvent, SessionStoreMode, StoreHealth };

// 数据变更事件：SSE 后台看板据此实时推送（发 'change'）
export const storeEvents = new EventEmitter();
storeEvents.setMaxListeners(100);

// VAR_DIR 可用 env 覆盖（selftest 指到临时目录，避免污染真实数据）
const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');

/** 数据目录：boot 拼 initSessionStore 的依赖用，与本模块读写的是同一个 */
export function varDir(): string {
  return VAR_DIR;
}

/** 「真实会话在库里，JSON 只剩 demo 类」的标记文件（spec「导入、导出与切换」） */
export const SESSIONS_IN_DB_MARKER = 'sessions-in-db.json';

const sessions = new Map<string, Session>();
const orders = new Map<string, Order>();

const DEMO_CLASS_RE = /^(sim-|wecom:cust_)/;

/** sim- 或 wecom:cust_ 开头：demo 类会话（网页访客与种子），永不进 PG（R6） */
export function isDemoClassId(id: string): boolean {
  return DEMO_CLASS_RE.test(id);
}

/** PG 后端，db 存储下由 initSessionStore 装上（第 5 步）；装上之前与文件存储下都是 null */
// 写成断言而不是类型标注：第 5 步之前没有赋值点，标注会让 TS 把它收窄成 null
let pgBackend = null as StoreBackend | null;

const fileBackend = createFileBackend({
  varDir: VAR_DIR,
  sessions,
  orders,
  owns: (id) => !pgBackend || isDemoClassId(id),
  // 孤儿订单（所属会话不在内存里）也留在 JSON，由文件后端原样保留（spec「导入、导出与切换」）
  ownsOrder: (o) => !pgBackend || isDemoClassId(o.sessionId) || !sessions.has(o.sessionId),
  isReal: (id) => !isDemoClassId(id),
  afterPersist: () => storeEvents.emit('change'),
});
fileBackend.load();
fileBackend.probe();

/** 这个会话的改动交给哪个后端：db 存储下真实会话走 PG，其余（demo 类、文件存储）走文件 */
const backendFor = (sessionId: string): StoreBackend => (pgBackend && !isDemoClassId(sessionId) ? pgBackend : fileBackend);

/** 当前装着的会话存储：装上 PG 后端之后是 'db'，否则 'file'。SESSION_STORE 的取值由 01 的 initConfigFromEnv 校验 */
export function sessionStoreMode(): SessionStoreMode {
  return pgBackend ? 'db' : 'file';
}

export interface SessionStoreDeps {
  db: Db;
  tenantId: string;
  varDir: string;
}

/**
 * 导入期已经按文件后端读好 JSON（两种模式相同，R3）。
 * deps 为 null（文件存储）：var/ 下有标记文件时以 sessions_in_db reject，否则立即 resolve。
 * deps 不为 null（db 存储）：预载 PG 并换上 PG 后端（第 5 步实现；在那之前拒绝启动，绝不回落到文件存储）
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
  throw new Error('这个版本还没有 PG 会话存储（02 plan 第 5 步），不要设 SESSION_STORE=db');
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
  backendFor(sessionId).emitAfterCommit(sessionId, ev);
}

/** 写库健康：db 存储下是 PG 后端的（只数真实会话），文件存储下是文件后端的 */
export function storeHealth(): StoreHealth {
  return (pgBackend ?? fileBackend).health();
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
  if (touch) s.updatedAt = Date.now();
  sessions.set(s.id, s);
  backendFor(s.id).schedule(s);
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
  backendFor(order.sessionId).scheduleOrder(order.id);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

/** 只有待付款的单能付。被新订单替代的旧单（superseded）不能再付：此前 status !== 'paid' 就置为已付，
 *  客户点开改单前那条旧链接照样付得了，一趟行程收两笔钱。调用方据返回的 status 判断付没付成 */
export function markOrderPaid(id: string): Order | undefined {
  const o = orders.get(id);
  if (!o) return undefined;
  if (o.status === 'pending_payment') {
    o.status = 'paid';
    o.paidAt = Date.now();
    backendFor(o.sessionId).scheduleOrder(id);
  }
  return o;
}

/** 把待付款的旧单标成被 byId 替代。已付款的单绝不动（返回 false），调用方只拿这个结果决定要不要告诉客户旧链接失效 */
export function supersedeOrder(id: string, byId: string): boolean {
  const o = orders.get(id);
  if (!o || o.status !== 'pending_payment') return false;
  o.status = 'superseded';
  o.supersededBy = byId;
  backendFor(o.sessionId).scheduleOrder(id);
  return true;
}

/**
 * 删除某个会话名下的全部订单。仅供「重置」口令使用。
 * 只清 session.orderIds 是不够的——后台按 orderIds 之外还会用 sessionId 反查订单，
 * 而且 GMV / 成交率是直接扫 orders 算的，留着孤儿订单会让重置后的会话
 * 仍然显示订单、仍然计入经营数据。
 */
export function deleteOrdersOfSession(sessionId: string): number {
  let n = 0;
  for (const [id, o] of orders) {
    if (o.sessionId === sessionId) {
      orders.delete(id);
      n += 1;
    }
  }
  // db 存储下改为把订单记作废、不删（R5，第 5 步）
  if (n) fileBackend.markChanged([sessionId]);
  return n;
}

export function listOrders(): Order[] {
  return [...orders.values()].toSorted((a, b) => b.createdAt - a.createdAt);
}
