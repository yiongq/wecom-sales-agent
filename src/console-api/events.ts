// 后台事件流 GET /api/console/events（docs/architecture/02-conversations-workbench/spec.md「通知」、不变量 31）。
// 来源只有 store 的 onCommitted：领域事件在包含那次改动的落库（落盘）提交之后才到这里（不变量 10）。
// 事件只带 id、状态、类型、seq 与时间，不带消息正文、客户原话和画像；sim- 访客会话的不发（console 不列也不开它们）。
// id 是「启动标识-序号」，最近 500 条留在环形缓冲里：重连带的 Last-Event-ID 不是本次启动的、或比缓冲还旧，先发 resync。
// counts 在提交后去抖 300ms 推一次完整的 ConversationCounts。连接每 20 秒一行注释心跳，每 60 秒用 auth_session_touch 复核一次登录，
// 失效（过期、被移出、停用）就发 auth 并关闭。第一个连接到来时才订阅（文件配置模式不用它，也不该在导入期碰配置）
import { randomBytes } from 'node:crypto';
import type { ConsoleEventMap, ConsoleEventName } from '../shared/console-api.js';
import { onCommitted, type DomainEvent } from '../store.js';

/** 本次启动的标识：Last-Event-ID 不是它开头的，说明进程重启过、缓冲里的序号接不上 */
const BOOT = randomBytes(6).toString('hex');
const RING = 500;

export interface Buffered {
  id: string;
  n: number;
  event: ConsoleEventName;
  data: string;
}

const ring: Buffered[] = [];
let last = 0;
const listeners = new Set<(b: Buffered) => void>();

let timing = { heartbeatMs: 20_000, recheckMs: 60_000, countsDebounceMs: 300 };
let countsOf: (() => ConsoleEventMap['counts']) | null = null;
let countsTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;

function publish<K extends ConsoleEventName>(event: K, data: ConsoleEventMap[K]): void {
  last += 1;
  const b: Buffered = { id: `${BOOT}-${last}`, n: last, event, data: JSON.stringify(data) };
  ring.push(b);
  if (ring.length > RING) ring.shift();
  for (const l of listeners) {
    try {
      l(b);
    } catch {
      /* 连接已断，onAbort 会摘掉它 */
    }
  }
}

function scheduleCounts(): void {
  if (countsTimer || !countsOf) return;
  countsTimer = setTimeout(() => {
    countsTimer = null;
    try {
      if (countsOf) publish('counts', countsOf());
    } catch (e) {
      console.error('[console-api] 事件流的计数算不出来:', e instanceof Error ? e.name : e);
    }
  }, timing.countsDebounceMs);
  countsTimer.unref();
}

/** 领域事件 → 事件流的一条（不带正文）；sim- 访客会话的不发 */
function relay(ev: DomainEvent): void {
  if (ev.id.startsWith('sim-')) return;
  switch (ev.type) {
    case 'handoff.started':
      publish('handoff', {
        id: ev.id,
        kind: ev.kind,
        at: new Date(ev.at).toISOString(),
        escalated: ev.escalated,
        paidCustomer: ev.paidCustomer,
      });
      break;
    case 'conversation.changed':
      publish('conversation', { id: ev.id, change: 'changed', assigneeName: null });
      break;
    case 'conversation.assigned':
      publish('conversation', { id: ev.id, change: 'assigned', assigneeName: ev.assigneeName });
      break;
    case 'conversation.released':
      publish('conversation', { id: ev.id, change: 'released', assigneeName: null });
      break;
    case 'message.appended':
      publish('message', { id: ev.id, seq: ev.seq, author: ev.author });
      break;
    case 'order.changed':
      publish('order', { id: ev.id, orderId: ev.orderId, status: ev.status, confirmed: ev.confirmed });
      break;
    case 'send.failed':
      publish('send_failed', { id: ev.id, failType: ev.failType });
      break;
  }
  scheduleCounts();
}

/** 第一个连接到来时订阅 store 的提交后事件（之后一直订阅着，重连的才补得上） */
export function ensureEventHub(counts: () => ConsoleEventMap['counts']): void {
  countsOf = counts;
  if (!unsubscribe) unsubscribe = onCommitted(relay);
}

export function addListener(fn: (b: Buffered) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 当前最后一条的 id（还没有事件时是「启动标识-0」）：连上时随首个 counts 下发，前端重连从它接着 */
export const tailId = (): string => `${BOOT}-${last}`;

/**
 * 重连带来的 Last-Event-ID 之后要补的事件；接不上（不是本次启动的、格式不对、或比缓冲最旧的一条还早）返回 null，调用方先发 resync
 */
export function replayAfter(lastEventId: string): Buffered[] | null {
  const m = /^([0-9a-f]+)-(\d{1,15})$/.exec(lastEventId);
  if (!m || m[1] !== BOOT) return null;
  const n = Number(m[2]);
  if (n > last) return null;
  if (n === last) return [];
  const oldest = ring[0]?.n ?? last + 1;
  if (n < oldest - 1) return null;
  return ring.filter((b) => b.n > n);
}

export const eventTiming = () => timing;

/** 仅供自测：调短心跳与复核登录的间隔、计数的去抖；看缓冲 */
export const __eventsTest = {
  setTiming(t: Partial<typeof timing>): void {
    timing = { ...timing, ...t };
  },
  reset(): void {
    timing = { heartbeatMs: 20_000, recheckMs: 60_000, countsDebounceMs: 300 };
  },
  boot: BOOT,
  ringSize: (): number => ring.length,
  listeners: (): number => listeners.size,
  publish,
};
