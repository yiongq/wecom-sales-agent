// 后台事件流 GET /api/console/events（docs/architecture/02-conversations-workbench/spec.md「通知」、不变量 31）。
// 来源只有 store 的 onCommitted：领域事件在包含那次改动的落库（落盘）提交之后才到这里（不变量 10）。
// 事件只带 id、状态、类型、seq 与时间，不带消息正文、客户原话和画像；sim- 访客会话的不发（console 不列也不开它们）。
// id 是「启动标识-序号」，最近 500 条留在环形缓冲里：重连带的 Last-Event-ID 不是本次启动的、或比缓冲还旧，先发 resync。
// counts 在提交后去抖 300ms 推一次完整的 ConversationCounts。连接每 20 秒一行注释心跳，每 50 秒用 auth_session_touch 复核一次登录
// （spec 写的是「60 秒」；正好卡在整 60 秒复核、下一次还要等查库，最坏会晚于 60 秒才关——留 10 秒余量，确保「60 秒内」是真的不超，
// 审查第 11 条，spec[4]），失效（过期、被移出、停用）就发 auth 并关闭。第一个连接到来时才订阅（文件配置模式不用它，也不该在导入期碰配置）
import {
  currentRuntime,
  tenantRuntimes,
  withTenantScope,
  withoutTenantScope,
  tenantCallback,
  type ConsoleEventHub,
} from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import type { ConsoleEventMap, ConsoleEventName } from '../shared/console-api.js';
import { onCommitted, type DomainEvent } from '../store.js';

/** 本次启动的标识：Last-Event-ID 不是它开头的，说明进程重启过、缓冲里的序号接不上 */
const hub = () => currentRuntime().events;
const RING = 500;

export interface Buffered {
  id: string;
  n: number;
  event: ConsoleEventName;
  data: string;
}

function publish<K extends ConsoleEventName>(event: K, data: ConsoleEventMap[K]): void {
  hub().last += 1;
  const b: Buffered = { id: `${hub().boot}-${hub().last}`, n: hub().last, event, data: JSON.stringify(data) };
  hub().ring.push(b);
  if (hub().ring.length > RING) hub().ring.shift();
  for (const l of hub().listeners) {
    try {
      l(b);
    } catch {
      /* 连接已断，onAbort 会摘掉它 */
    }
  }
}

function scheduleCounts(): void {
  if (hub().countsTimer || !hub().countsOf) return;
  const rt = currentRuntime();
  const events = hub();
  events.countsTimer = withoutTenantScope(() =>
    setTimeout(
      tenantCallback(rt, () => {
        hub().countsTimer = null;
        try {
          if (events.countsOf) publish('counts', events.countsOf());
        } catch (e) {
          console.error('[console-api] 事件流的计数算不出来:', e instanceof Error ? e.name : e);
        }
      }),
      events.timing.countsDebounceMs,
    ),
  );
  events.countsTimer!.unref();
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
        assigned: ev.assigned,
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
  hub().countsOf = counts;
  if (!hub().unsubscribe) hub().unsubscribe = onCommitted(relay);
}

type EventListener = ((b: Buffered) => void) & { close?: () => void };
export function addListener(fn: (b: Buffered) => void, close?: () => void): () => void {
  const listeners = hub().listeners;
  const listener: EventListener = (event) => fn(event);
  listener.close = close;
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 当前最后一条的 id（还没有事件时是「启动标识-0」）：连上时随首个 counts 下发，前端重连从它接着 */
export const tailId = (): string => `${hub().boot}-${hub().last}`;

/**
 * 重连带来的 Last-Event-ID 之后要补的事件；接不上（不是本次启动的、格式不对、或比缓冲最旧的一条还早）返回 null，调用方先发 resync
 */
export function replayAfter(lastEventId: string): Buffered[] | null {
  const m = /^([0-9a-f]+)-(\d{1,15})$/.exec(lastEventId);
  if (!m || m[1] !== hub().boot) return null;
  const n = Number(m[2]);
  if (n > hub().last) return null;
  if (n === hub().last) return [];
  const oldest = hub().ring[0]?.n ?? hub().last + 1;
  if (n < oldest - 1) return null;
  return hub().ring.filter((b) => b.n > n);
}

export const eventTiming = () => hub().timing;

/** 仅供自测：调短心跳与复核登录的间隔、计数的去抖；看缓冲 */
export const __eventsTest = {
  setTiming(t: Partial<ConsoleEventHub['timing']>): void {
    hub().timing = { ...hub().timing, ...t };
  },
  reset(): void {
    hub().timing = { heartbeatMs: 20_000, recheckMs: 50_000, countsDebounceMs: 300 };
  },
  get boot() {
    return hub().boot;
  },
  ringSize: (): number => hub().ring.length,
  listeners: (): number => hub().listeners.size,
  publish,
};

function eventRegistration(key: 'ring' | 'last' | 'listeners' | 'countsOf' | 'countsTimer' | 'unsubscribe') {
  const clear = (events: ConsoleEventHub): void => {
    if (key === 'ring') events.ring.length = 0;
    else if (key === 'last') events.last = 0;
    else if (key === 'listeners') {
      for (const listener of events.listeners) (listener as EventListener).close?.();
      events.listeners.clear();
    } else if (key === 'countsOf') events.countsOf = null;
    else if (key === 'countsTimer') {
      if (events.countsTimer) clearTimeout(events.countsTimer);
      events.countsTimer = null;
    } else {
      events.unsubscribe?.();
      events.unsubscribe = null;
    }
  };
  return {
    keyCount: (id: string) => {
      const value = tenantRuntimes().find((rt) => rt.id === id)?.events[key];
      return Array.isArray(value) ? value.length : value instanceof Set ? value.size : Number(!!value);
    },
    drop: (id: string) => {
      const rt = tenantRuntimes().find((rt) => rt.id === id);
      if (rt) withTenantScope(rt, () => clear(rt.events));
    },
    reset: () => {
      for (const rt of tenantRuntimes()) withTenantScope(rt, () => clear(rt.events));
    },
  };
}

registerTenantState({ name: 'console.events.ring', ...eventRegistration('ring') });
registerTenantState({ name: 'console.events.last', ...eventRegistration('last') });
registerTenantState({ name: 'console.events.listeners', ...eventRegistration('listeners') });
registerTenantState({ name: 'console.events.countsOf', ...eventRegistration('countsOf') });
registerTenantState({ name: 'console.events.countsTimer', ...eventRegistration('countsTimer') });
registerTenantState({ name: 'console.events.unsubscribe', ...eventRegistration('unsubscribe') });
