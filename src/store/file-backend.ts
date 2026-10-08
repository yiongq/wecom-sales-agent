// 文件后端：var/sessions.json、var/orders.json 的整文件重写，写入去抖 200ms + 原子写（tmp+rename），进程退出时同步写出。
// 从 src/store.ts 抽出来，落盘的内容与时机和开工时相同（docs/architecture/02-conversations-workbench/spec.md R3）。
// db 存储下它只管 demo 类会话及其订单（R6），由 owns / ownsOrder 过滤。
import fs from 'node:fs';
import path from 'node:path';
import { logError } from '../log.js';
import type { Order, Session } from '../types.js';
import { StoreLaggingError, type StoreBackend, type StoreHealth } from './backend.js';
import { deliverCommitted, type DomainEvent } from './events.js';
import { ORDERS_JSON, SESSIONS_JSON } from './project.js';
import { assignSeqs, seedSeqs } from './seq.js';

export interface FileBackendDeps {
  varDir: string;
  sessions: Map<string, Session>;
  orders: Map<string, Order>;
  /** 这个会话归不归文件后端落盘（文件存储：全部；db 存储：demo 类） */
  owns(sessionId: string): boolean;
  ownsOrder(o: Order): boolean;
  /** 真实会话（不是 demo 类）：health().conversations 只数它们 */
  isReal(sessionId: string): boolean;
  /** 每次落盘成功之后调：storeEvents 的 'change'，/api/admin/stream 据此推送（02 第 13 步：提交后发，失败不发，不变量 10） */
  afterPersist(): void;
}

export interface FileBackend extends StoreBackend {
  /** 启动时恢复上次落盘的数据，并给每个会话的消息按顺序记上 seq（只在本进程有效） */
  load(): void;
  /** 启动即探测数据目录可写 */
  probe(): void;
  /** 不经 saveSession 的改动（保鲜、清理、删订单）：标脏并排一次落盘 */
  markChanged(sessionIds: readonly string[]): void;
  /** 跳过去抖，立刻同步落盘（flushStoreNow） */
  flushNow(): void;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

export function createFileBackend(d: FileBackendDeps): FileBackend {
  const SESSIONS_FILE = path.join(d.varDir, SESSIONS_JSON);
  const ORDERS_FILE = path.join(d.varDir, ORDERS_JSON);

  /** 有没落盘改动的会话 → 最早一次改动的时刻 */
  const dirty = new Map<string, number>();
  let pendingEvents: DomainEvent[] = [];
  const waiters = new Set<{ sessionId: string; resolve(): void }>();
  let lastError: string | null = null;
  let saveTimer: NodeJS.Timeout | null = null;

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
        console.error(`[store] ${path.basename(file)} 解析失败，已备份到 ${backup}:`, logError(e));
      } catch {
        console.error(`[store] ${path.basename(file)} 解析失败且无法备份:`, logError(e));
      }
    }
  }

  // 原子写：先写 .tmp 再 rename（同一文件系统内 rename 原子），崩溃不会留半截文件
  function writeAtomic(file: string, data: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  function markDirty(sessionId: string): void {
    if (!dirty.has(sessionId)) dirty.set(sessionId, Date.now());
  }

  /** 同步写出两个文件。成功之后清脏、交出排着的事件、放行在等的 flushSession；失败时这些都留到下一次成功 */
  function persistNow(): boolean {
    try {
      fs.mkdirSync(d.varDir, { recursive: true });
      writeAtomic(
        SESSIONS_FILE,
        JSON.stringify(
          [...d.sessions.values()].filter((s) => d.owns(s.id)),
          null,
          2,
        ),
      );
      writeAtomic(
        ORDERS_FILE,
        JSON.stringify(
          [...d.orders.values()].filter((o) => d.ownsOrder(o)),
          null,
          2,
        ),
      );
    } catch (e) {
      lastError = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.name : 'unknown');
      console.error('[store] 落盘失败:', e);
      return false;
    }
    dirty.clear();
    const events = pendingEvents;
    pendingEvents = [];
    for (const w of waiters) w.resolve();
    waiters.clear();
    deliverCommitted(events);
    return true;
  }

  function schedulePersist(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (persistNow()) d.afterPersist(); // 每次落盘成功（约 200ms 去抖后）通知一次；失败不通知，留到下一次成功
    }, 200);
  }

  function cancelTimer(): boolean {
    if (!saveTimer) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    return true;
  }

  return {
    mode: 'file',
    load() {
      loadFile<Session>(SESSIONS_FILE, d.sessions);
      loadFile<Order>(ORDERS_FILE, d.orders);
      for (const s of d.sessions.values()) if (Array.isArray(s.messages)) seedSeqs(s, 1);
    },
    // 启动即探测 VAR_DIR 可写性。典型事故：docker 绑定挂载的 var/ 归 root、容器进程是 node(1000)，
    // 落盘全部 EACCES 但服务表面正常——所有会话/订单只活在内存，重启即全丢。必须在启动时就喊出来。
    probe() {
      try {
        fs.mkdirSync(d.varDir, { recursive: true });
        const probe = path.join(d.varDir, '.write-probe');
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
      } catch (e) {
        console.error(
          `[store] ⚠️⚠️ 数据目录不可写: ${d.varDir} —— 会话/订单将只存在内存，进程重启即全部丢失！` +
            '请修复目录权限（docker 部署：chown -R 1000:1000 该目录）。',
          e,
        );
      }
    },
    schedule(s) {
      assignSeqs(s, 'lenient');
      markDirty(s.id);
      schedulePersist();
    },
    scheduleOrder(orderId) {
      const o = d.orders.get(orderId);
      if (o?.sessionId !== undefined) markDirty(o.sessionId);
      schedulePersist();
    },
    markChanged(ids) {
      for (const id of ids) markDirty(id);
      schedulePersist();
    },
    emitAfterCommit(sessionId, ev) {
      pendingEvents.push(ev);
      markDirty(sessionId);
      schedulePersist();
    },
    flush(sessionId, opts = {}) {
      if (!dirty.has(sessionId)) return Promise.resolve();
      schedulePersist();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
      return new Promise<void>((resolve, reject) => {
        const w = {
          sessionId,
          resolve() {
            clearTimeout(timer);
            resolve();
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new StoreLaggingError(sessionId));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    drain() {
      if ((cancelTimer() || dirty.size) && persistNow()) d.afterPersist();
      return Promise.resolve({ undrained: [...dirty.keys()] });
    },
    // 退出兜底：防抖窗口内（或上次落盘失败后）的未落盘变更在进程结束前同步写出
    spillSync() {
      const n = dirty.size;
      if ((cancelTimer() || n) && persistNow()) return n;
      return 0;
    },
    flushNow() {
      cancelTimer();
      if (persistNow()) d.afterPersist();
    },
    health(): StoreHealth {
      let oldest = Infinity;
      for (const t of dirty.values()) oldest = Math.min(oldest, t);
      let conversations = 0;
      for (const id of d.sessions.keys()) if (d.isReal(id)) conversations++;
      return {
        mode: 'file',
        conversations,
        dirty: dirty.size,
        lagMs: dirty.size ? Date.now() - oldest : 0,
        lastError,
        conflict: false,
        poisoned: [],
      };
    },
  };
}
