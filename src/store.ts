// 内存 Map + JSON 落盘（var/sessions.json、var/orders.json）。
// 写入防抖 200ms + 原子写（tmp+rename）；进程退出时同步 flush。demo 规模无需数据库。
// 注意：数据权威在本进程内存，多副本部署会脑裂——本项目按单实例设计。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { numEnv } from './env.js';
import type { Session, Order } from './types.js';

// 数据变更事件：SSE 后台看板据此实时推送（发 'change'）
export const storeEvents = new EventEmitter();
storeEvents.setMaxListeners(100);

// VAR_DIR 可用 env 覆盖（selftest 指到临时目录，避免污染真实数据）
const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
const SESSIONS_FILE = path.join(VAR_DIR, 'sessions.json');
const ORDERS_FILE = path.join(VAR_DIR, 'orders.json');

const sessions = new Map<string, Session>();
const orders = new Map<string, Order>();

// 启动时恢复上次落盘的数据。损坏文件不能静默当空库——那会在下一次落盘时
// 被空数据覆盖、损失永久化；改名备份留住现场，人工可从备份恢复。
function loadFile<T>(file: string, target: Map<string, T>): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 首次运行无文件
  }
  try {
    const arr = JSON.parse(raw) as T[];
    for (const item of arr) target.set((item as { id: string }).id, item);
  } catch (e) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.error(`[store] ${path.basename(file)} 解析失败，已备份到 ${backup}:`, e);
    } catch {
      console.error(`[store] ${path.basename(file)} 解析失败且无法备份:`, e);
    }
  }
}
loadFile<Session>(SESSIONS_FILE, sessions);
loadFile<Order>(ORDERS_FILE, orders);

// 启动即探测 VAR_DIR 可写性。典型事故：docker 绑定挂载的 var/ 归 root、容器进程是 node(1000)，
// 落盘全部 EACCES 但服务表面正常——所有会话/订单只活在内存，重启即全丢。必须在启动时就喊出来。
try {
  fs.mkdirSync(VAR_DIR, { recursive: true });
  const probe = path.join(VAR_DIR, '.write-probe');
  fs.writeFileSync(probe, String(Date.now()));
  fs.unlinkSync(probe);
} catch (e) {
  console.error(
    `[store] ⚠️⚠️ 数据目录不可写: ${VAR_DIR} —— 会话/订单将只存在内存，进程重启即全部丢失！` +
      '请修复目录权限（docker 部署：chown -R 1000:1000 该目录）。',
    e,
  );
}

// 原子写：先写 .tmp 再 rename（同一文件系统内 rename 原子），崩溃不会留半截文件
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function persistNow(): void {
  try {
    fs.mkdirSync(VAR_DIR, { recursive: true });
    writeAtomic(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2));
    writeAtomic(ORDERS_FILE, JSON.stringify([...orders.values()], null, 2));
  } catch (e) {
    console.error('[store] 落盘失败:', e);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
    storeEvents.emit('change'); // 每次落盘（约 200ms 去抖后）通知一次
  }, 200);
}

// 退出兜底：防抖窗口内的未落盘变更在进程结束前同步写出
process.on('exit', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persistNow();
  }
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143));
}

// ---------------- demo 数据保鲜 ----------------
// 种子演示会话（id 形如 wecom:cust_B01，真实企微 external_userid 不会长这样）的时间戳
// 是灌入时定死的：放几天后后台全是「N 天未回应」，工作台像个废弃系统——对外演示时
// 观感极差。这里定期把演示数据整体平移到「最新一条像 5 分钟前」，相对间隔不变；
// 真实客户会话（wecom: 非 cust_ / sim-）绝不触碰。DEMO_FRESHEN=0 可关闭。
const DEMO_SESSION_RE = /^wecom:cust_/;

export function freshenDemoData(): void {
  if (process.env.DEMO_FRESHEN === '0') return;
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
  schedulePersist();
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
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, excess);
  for (const s of victims) {
    sessions.delete(s.id);
    for (const oid of s.orderIds ?? []) orders.delete(oid);
  }
  if (victims.length) {
    console.warn(`[store] 网页访客会话超过上限 ${VISITOR_SESSION_MAX}，已淘汰最旧的 ${victims.length} 个`);
  }
}

export function pruneStaleVisitorData(): void {
  if (!PRUNE_MS) return;
  const cutoff = Date.now() - PRUNE_MS;
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (!VISITOR_SESSION_RE.test(s.id) || s.channel !== 'simulator') continue;
    if (s.updatedAt >= cutoff) continue;
    if (hasPaidOrder(s)) continue; // 有成交记录，保留
    sessions.delete(s.id);
    for (const oid of s.orderIds ?? []) orders.delete(oid); // 连同订单一起删，不留孤儿
    n++;
  }
  if (n) {
    schedulePersist();
    console.log(`[store] 已清理 ${n} 个闲置网页访客会话（阈值 ${PRUNE_MS / 3_600_000}h，仅 sim-）`);
  }
}

// 启动即保鲜/清理一次，此后每小时一次（unref 不阻退出）
freshenDemoData();
pruneStaleVisitorData();
setInterval(() => { freshenDemoData(); pruneStaleVisitorData(); }, 60 * 60_000).unref();

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
    schedulePersist();
  }
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 落盘会话。默认把 updatedAt 刷新为现在——它代表「这条会话最后一次有动静」。
 * touch=false 用于系统主动写入（如自动跟进）：跟进不该把客户的沉默时长清零，
 * 否则后台「N 小时未回应」失真、介入队列会漏掉真正该救的客户。
 */
export function saveSession(s: Session, touch = true): void {
  if (touch) s.updatedAt = Date.now();
  sessions.set(s.id, s);
  schedulePersist();
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
  schedulePersist();
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function markOrderPaid(id: string): Order | undefined {
  const o = orders.get(id);
  if (!o) return undefined;
  if (o.status !== 'paid') {
    o.status = 'paid';
    o.paidAt = Date.now();
    schedulePersist();
  }
  return o;
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
    if (o.sessionId === sessionId) { orders.delete(id); n += 1; }
  }
  if (n) schedulePersist();
  return n;
}

export function listOrders(): Order[] {
  return [...orders.values()].sort((a, b) => b.createdAt - a.createdAt);
}
