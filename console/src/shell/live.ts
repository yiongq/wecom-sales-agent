// 外壳的事件流（02 spec「通知」「后台接口 · /events」）：EventSource 订阅 /api/console/events，带 Last-Event-ID 续传。
// - counts：直接写进 React Query 缓存（铃铛徽标、标签页标题前缀与 I 页页签都从它读）；
// - handoff/conversation/message/order/send_failed：让 ['conversations', …] 开头的查询重取（铃铛列表、I 页列表都跟着新）；
//   handoff 另弹浏览器通知（授权了才弹，由调用方传 pack 与打开 J 页的回调，这个模块不碰路由）；
// - resync：Last-Event-ID 接不上（不是本次启动的、或比缓冲还旧），整体重取；
// - auth：登录失效，关闭连接、回登录页（与退出登录同一套：清掉除 viewer 外的查询缓存，重取 viewer 判定出登录页）。
// SSE 连不上或断开超过 30 秒，退回 30 秒轮询；重连成功立刻停轮询（spec「通知」）。连接状态不进 React 组件树，
// 用一个小的订阅者模式（同 session.ts）往外暴露，铃铛与 I 页的计数查询都读它，不用一层层传 props。
// 页面隐藏时不停这个连接（浏览器自己的 EventSource 不因 visibilitychange 断开，这里不另加处理，照 spec）。
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ConsoleEventMap, ConsoleEventName } from '../../../src/shared/console-api.js';
import { endMemberSession } from '../session.js';
import { VIEWER_KEY } from '../viewer.js';
import { conversationCountsQuery } from '../queries.js';

/** 断线超过这么久仍没重连，退回轮询（spec「通知」：30 秒） */
export const GRACE_MS = 30_000;

export interface LiveState {
  /** 这一刻连着 */
  connected: boolean;
  /** 该退回轮询了（断线满 GRACE_MS 还没重连）；连上的瞬间立刻变回 false */
  polling: boolean;
}

export const INITIAL_LIVE: LiveState = { connected: false, polling: false };

/** 连上：立刻停轮询（纯函数，自测直接调，不用等真的计时器） */
export const onOpen = (): LiveState => ({ connected: true, polling: false });
/** 断线或出错：连接状态改，轮询状态不变，由计时器到期才决定 */
export const onClose = (s: LiveState): LiveState => ({ ...s, connected: false });
/** 断线满 GRACE_MS 还没重连：退回轮询；这期间已经重连上的，这一条不生效 */
export const onGraceExpired = (s: LiveState): LiveState => (s.connected ? s : { ...s, polling: true });

// ---------------- 外部状态（同 session.ts 的订阅者模式） ----------------

let state: LiveState = INITIAL_LIVE;
const listeners = new Set<() => void>();

function setLiveState(next: LiveState): void {
  if (next.connected === state.connected && next.polling === state.polling) return;
  state = next;
  for (const l of listeners) l();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const getSnapshot = (): LiveState => state;
const getServerSnapshot = (): LiveState => INITIAL_LIVE;

export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 铃铛、I 页的计数查询用：连着（或还在断线的 30 秒宽限内）不轮询，退回轮询时用这个间隔（通常是外壳既有的 30 秒） */
export function useLivePollInterval(pollMs: number): number | false {
  return useLive().polling ? pollMs : false;
}

/** 仅供自测：把模块状态和计时器都还原（真的 startLiveEvents 不会重复 new，但每个用例要从头来） */
export const __liveTest = {
  reset(): void {
    setLiveState(INITIAL_LIVE);
  },
  get(): LiveState {
    return state;
  },
  /** 不等 30 秒宽限，直接把状态改成「已退回轮询」或改回来，给只关心查询选项的用例用 */
  setPolling(polling: boolean): void {
    setLiveState({ ...state, polling });
  },
};

// ---------------- 事件流接线 ----------------

/** EventSource 的最小依赖形状：原生 EventSource 已经满足它，自测传假的 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface LiveDeps {
  qc: QueryClient;
  /** 收到 handoff 事件时调用；授权、标题与正文由调用方（notifications.ts 的 notifyHandoff）决定，这里只转发 */
  onNotify: (data: ConsoleEventMap['handoff']) => void;
  /** 断线多久退回轮询，默认 GRACE_MS；自测传很小的数 */
  graceMs?: number;
  /** 默认用全局 EventSource；自测传假的 */
  createEventSource?: (url: string) => EventSourceLike;
}

const defaultCreate = (url: string): EventSourceLike => new EventSource(url, { withCredentials: true });

/** ['conversations', …] 开头的查询全部让它们重取：铃铛的等人接手列表、已成交客户要人工、I 页的列表都跟着新 */
function invalidateConversations(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['conversations'] });
}

/**
 * 接上事件流，返回清理函数（关掉连接、清掉计时器）。第一个连接到来才有事件可收：这里不管重试节奏，
 * 浏览器的 EventSource 出错后自己按它的 retry 间隔重连，这个函数只管「断线多久算该退回轮询」与收到事件之后做什么
 */
export function startLiveEvents(deps: LiveDeps): () => void {
  const { qc } = deps;
  const graceMs = deps.graceMs ?? GRACE_MS;
  const create = deps.createEventSource ?? defaultCreate;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 已经在倒计时就不要重排：真实浏览器的 EventSource 断线后约每 3 秒自动重连一次，每次失败都触发 error，
  // 如果每次都重排计时器，30 秒倒计时永远被拨回起点，onGraceExpired 永远不触发（审查第 1 条，blocker）。
  // 只有 open（clearGrace）或这次宽限本身到期，才清掉 timer；下一次断线才重新起一个干净的 30 秒
  const armGrace = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const before = getSnapshot();
      const next = onGraceExpired(before);
      setLiveState(next);
      // 刚从「还在宽限内」变成「退回轮询」：react-query 的 refetchInterval 是从现在起等一整个间隔才发下一次，
      // 不补一次的话实际要到宽限 + 30 秒（约 60 秒）才真的发出第一次轮询请求，不只是宽限那 30 秒
      // （真实 Chromium 复验带出的细节，连同审查第 1 条一起改；这里只在真的从 false 变 true 那一刻补一次，
      // 之后每次断线的 error 重新 armGrace 不会反复触发）
      if (next.polling && !before.polling) invalidateConversations(qc);
    }, graceMs);
  };
  const clearGrace = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  setLiveState(INITIAL_LIVE);
  armGrace();
  let es: EventSourceLike | null = null;
  try {
    es = create('/api/console/events');
  } catch (e) {
    // 建不出连接（没有 EventSource 这个全局、CSP 拦住了，或别的构造期错误）：当成断线，按断线满 30 秒退回轮询的
    // 同一条路走，不让这一步把整个外壳摔崩；armGrace() 已经排了那个计时器，这里直接返回清理函数
    console.error('[console] EventSource接不上:', e instanceof Error ? e.name : e);
    return clearGrace;
  }
  if (!es) return clearGrace;

  // 具名事件的数据在 ev.data（SSE 的 data 字段）；EventSourceLike 的 addEventListener 按 EventTarget 的通用签名声明
  // （listener: (ev: Event) => void），这样假的 EventSource（自测用 EventTarget 子类）才能通过 implements 检查，
  // 这里按形状断言出 .data
  const on = <K extends ConsoleEventName>(name: K, fn: (data: ConsoleEventMap[K]) => void): void => {
    es.addEventListener(name, (ev) => {
      try {
        fn(JSON.parse((ev as unknown as { data: string }).data) as ConsoleEventMap[K]);
      } catch {
        // 坏数据（不该发生）：这一条忽略，等下一条；不因为一条解析失败断开连接
      }
    });
  };

  es.addEventListener('open', () => {
    setLiveState(onOpen());
    clearGrace();
  });
  es.addEventListener('error', () => {
    setLiveState(onClose(getSnapshot()));
    armGrace();
  });
  on('counts', (data) => qc.setQueryData(conversationCountsQuery.queryKey, data));
  on('handoff', (data) => {
    invalidateConversations(deps.qc);
    // assigned 为真：这一次转人工发出时已经有接手人（顾问自己点「接手」触发的那一次），不弹浏览器通知，
    // 铃铛与计数照旧靠上面的 invalidateConversations 更新（02 第 19 步审查第 2 条）
    if (!data.assigned) deps.onNotify(data);
  });
  on('conversation', () => invalidateConversations(deps.qc));
  on('message', () => invalidateConversations(deps.qc));
  on('order', () => invalidateConversations(deps.qc));
  on('send_failed', () => invalidateConversations(deps.qc));
  on('resync', () => invalidateConversations(deps.qc));
  es.addEventListener('auth', () => {
    es.close();
    clearGrace();
    // 与「退出登录」同一套：先离开成员身份，再清掉除 viewer 外的查询缓存，重取 viewer 判定出登录页（spec「通知」：回登录页）
    endMemberSession();
    deps.qc.removeQueries({ predicate: (q) => q.queryKey[0] !== VIEWER_KEY[0] });
    void deps.qc.resetQueries({ queryKey: VIEWER_KEY });
  });

  return () => {
    es.close();
    clearGrace();
  };
}
