// LLM 请求的并发闸 + 退避重试。
//
// Node 的异步 I/O 解决的是「我们自己的服务器不被阻塞」：等 LLM 响应时线程去服务别的请求，
// 所以 50 个客户同时聊，50 个 HTTP 请求是同时在飞的，总耗时≈单次耗时而不是 50 倍。
//
// 它**没有**解决的是下游：模型服务商按账号限 QPS。Node 很乐意一口气发 500 个并发出去，
// 服务商直接回 429，于是这 500 个客户全部收到「我这边卡了一下」——我们自己不崩，
// 但客户体验一样是崩的。所以要在出口处自己限流：
//   1. 同时在飞的请求数封顶（超出的排队等，不是丢弃）
//   2. 429 / 5xx / 网络抖动按指数退避重试，而不是直接把错误甩给客户

import { numEnv } from './env.js';

/** 同时在飞的 LLM 请求上限。0 表示不限制 */
const MAX_INFLIGHT = Math.max(0, numEnv('LLM_MAX_INFLIGHT', 8));
/** 失败重试次数（不含首次）。0 表示不重试 */
const MAX_RETRY = Math.max(0, numEnv('LLM_MAX_RETRY', 2));

let inflight = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (!MAX_INFLIGHT || inflight < MAX_INFLIGHT) {
    inflight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // 名额直接交棒，inflight 计数不变
  else inflight = Math.max(0, inflight - 1);
}

/** 这些是「等一下就好」的错误，值得重试；4xx 参数错/鉴权错重试无意义 */
function retriable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export interface GateResult {
  res: Response;
  attempts: number;
  /** 错误响应的正文。重试时这里已经把 body 读掉了，调用方再 res.text() 会抛
   *  「Body is unusable」，把 429 的真实原因（配额说明、限频提示）整条吃掉，
   *  日志里只剩一个 TypeError。所以由本函数读一次并原样带出来。 */
  errorBody?: string;
}

/**
 * 受控地发一次 LLM 请求：排队拿到名额 → 发请求 → 遇到可重试错误则退避重试。
 * 返回最终的 Response（可能仍是错误状态，由调用方决定怎么处理）。
 */
export async function gatedFetch(url: string, init: RequestInit, signalFactory: () => AbortSignal): Promise<GateResult> {
  await acquire();
  try {
    let last: Response | null = null;
    let lastBody = '';
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (attempt > 0) {
        // 指数退避 + 抖动：同一批被限流的请求不要在同一刻一起重试，否则又一起撞墙
        const base = 600 * 2 ** (attempt - 1);
        const wait = base + Math.floor(Math.random() * 300);
        console.warn(`[llm] 第 ${attempt} 次重试，等待 ${wait}ms（上次状态 ${last?.status ?? '网络异常'}）`);
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        const res = await fetch(url, { ...init, signal: signalFactory() });
        if (res.ok || !retriable(res.status)) return { res, attempts: attempt + 1 };
        last = res;
        // 读出来既是释放 body（避免连接悬挂），也是保住错误原因：这个 Response
        // 可能被当作最终结果返回，届时 body 已不可再读
        lastBody = await res.text().catch(() => '');
      } catch (e) {
        // 网络异常/超时：超时是我们自己 abort 的，重试一次仍有意义（上游偶发挂起）
        if (attempt === MAX_RETRY) throw e;
        last = null;
        lastBody = '';
      }
    }
    if (last) return { res: last, attempts: MAX_RETRY + 1, errorBody: lastBody };
    throw new Error('LLM 请求重试后仍失败');
  } finally {
    release();
  }
}

export function gateStatus(): { inflight: number; waiting: number; maxInflight: number } {
  return { inflight, waiting: waiting.length, maxInflight: MAX_INFLIGHT };
}
