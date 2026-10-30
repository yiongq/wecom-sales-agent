import { assertSandboxRunning } from './tenancy/sandbox/lifecycle.js';
import { currentRuntime, withoutTenantScope, withTenantScope } from './tenancy/runtime.js';
import { costOf, sandboxCostOf, recordUsage, type UsagePurpose } from './usage.js';
import { reserveSandboxIndex } from './tenancy/sandbox/budget.js';
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
const MAX_INFLIGHT = Math.max(0, numEnv('LLM_MAX_INFLIGHT', process.env.APP_ROLE === 'sandbox' ? 2 : 8));
/** 失败重试次数（不含首次）。0 表示不重试 */
const MAX_RETRY = Math.max(0, numEnv('LLM_MAX_RETRY', 2));

const inflight = { chat: 0, vision: 0 };
/** 排队中的请求。放弃了的会被摘掉，名额不会交棒给一个已经不要它的请求（那样名额就丢了） */
const waiting: Record<'chat' | 'vision', (() => void)[]> = { chat: [], vision: [] };

function poolLimit(pool: 'chat' | 'vision'): number {
  return pool === 'vision' ? Math.max(1, Math.floor(numEnv('LLM_VISION_MAX_INFLIGHT', 2))) : MAX_INFLIGHT;
}

/**
 * 拿一个名额。排队也要响应 abort：整轮 deadline 到了、或对冲已有一方胜出，就别再等——
 * 此前排队时不看信号，要等某个名额空出来才发现自己早过期了，LLM_ROUND_TIMEOUT_MS 标称的
 * 墙钟上限在排队阶段并不成立。
 */
function acquire(signal: AbortSignal, pool: 'chat' | 'vision'): Promise<void> {
  const max = poolLimit(pool);
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!max || inflight[pool] < max) {
    inflight[pool] += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const grant = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      const i = waiting[pool].indexOf(grant);
      if (i >= 0) waiting[pool].splice(i, 1);
      reject(signal.reason);
    };
    waiting[pool].push(grant);
    withoutTenantScope(() => signal.addEventListener('abort', onAbort, { once: true }));
  });
}

/** 退避等待，abort 时立刻醒来抛出：对冲的输家若正在退避，不能再白占名额睡满 0.6~1.5s */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = withoutTenantScope(() =>
      setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms),
    );
    withoutTenantScope(() => signal.addEventListener('abort', onAbort, { once: true }));
  });
}

function release(pool: 'chat' | 'vision'): void {
  const next = waiting[pool].shift();
  if (next) next(); // 名额直接交棒，inflight 计数不变
  else inflight[pool] = Math.max(0, inflight[pool] - 1);
}

/** 这些是「等一下就好」的错误，值得重试；4xx 参数错/鉴权错重试无意义 */
function retriable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export interface GateResult {
  res: Response;
  attempts: number;
  /** 成功响应由调用方沿原有路径解析后结算；解析失败传 null。不会额外读取 body。 */
  settleUsage(data: unknown): void;
  /** 沙箱主对话在 onLlmCall 之后报告已结算的成功用量；失败与取消始终立即报告。 */
  reportUsage?(): void;
  /** 错误响应的正文。重试时这里已经把 body 读掉了，调用方再 res.text() 会抛
   *  「Body is unusable」，把 429 的真实原因（配额说明、限频提示）整条吃掉，
   *  日志里只剩一个 TypeError。所以由本函数读一次并原样带出来。 */
  errorBody?: string;
}

/**
 * 受控地发一次 LLM 请求：排队拿到名额 → 发请求 → 遇到可重试错误则退避重试。
 * 返回最终的 Response（可能仍是错误状态，由调用方决定怎么处理）。
 */
export class BudgetExhausted extends Error {
  constructor() {
    super('llm_budget_exhausted');
    this.name = 'BudgetExhausted';
  }
}
interface GateUsage {
  purpose?: UsagePurpose;
  estimateMilli?: number;
  sessionId?: string;
  poolOnly?: boolean;
  deferUsage?: boolean;
  /** 视觉只尝试一次；省略时保留主对话的重试策略。 */
  maxRetry?: number;
}
/** standard 保留既有估值；沙箱从实际请求体计算上限，调用方不能缩小预占绕过额度。 */
function requestUsage(init: RequestInit, url: string, opts: GateUsage): { model: string; purpose: UsagePurpose; estimateMilli: number } {
  let body: { model?: string; max_tokens?: number; max_completion_tokens?: number; messages?: { content?: unknown }[] } = {};
  try {
    if (typeof init.body === 'string') body = JSON.parse(init.body);
  } catch {
    /* 请求格式仍由上游检查 */
  }
  const model = body.model ?? '';
  // 视觉按实际消息计提示字数与图片张数；沙箱也不能按 base64 的体积预占。
  const inputTokens =
    opts.purpose === 'vision'
      ? (body.messages ?? []).reduce((total, message) => {
          if (typeof message.content === 'string') return total + message.content.length;
          if (!Array.isArray(message.content)) return total;
          return (
            total +
            message.content.reduce(
              (n: number, part: { type?: string; text?: string }) =>
                n + (part.type === 'image_url' ? 4000 : typeof part.text === 'string' ? part.text.length : 0),
              0,
            )
          );
        }, 0)
      : typeof init.body === 'string'
        ? Buffer.byteLength(init.body, 'utf8')
        : 0;
  return {
    model,
    purpose: opts.purpose ?? (url.endsWith('/embeddings') ? 'embedding' : 'chat'),
    estimateMilli:
      currentRuntime().kind === 'sandbox'
        ? sandboxCostOf(model, inputTokens, body.max_tokens ?? body.max_completion_tokens ?? 0, 0, true) * 1000
        : (opts.estimateMilli ?? costOf(model, inputTokens, body.max_tokens ?? body.max_completion_tokens ?? 0) * 1000),
  };
}
function actualCost(data: unknown, model: string): number | null {
  try {
    const parsed = data as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    if (!parsed?.usage) return null;
    const u = parsed.usage;
    if (
      currentRuntime().kind === 'sandbox' &&
      (typeof u.prompt_tokens !== 'number' ||
        !Number.isFinite(u.prompt_tokens) ||
        u.prompt_tokens < 0 ||
        (u.completion_tokens !== undefined && (!Number.isFinite(u.completion_tokens) || u.completion_tokens < 0)))
    )
      return null;
    const milli =
      (currentRuntime().kind === 'sandbox' ? sandboxCostOf : costOf)(
        model,
        u.prompt_tokens ?? 0,
        u.completion_tokens ?? 0,
        u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      ) * 1000;
    return currentRuntime().kind === 'sandbox' && !Number.isFinite(milli) ? null : milli;
  } catch {
    return null;
  }
}
export async function gatedFetch(
  url: string,
  init: RequestInit,
  signalFactory: () => AbortSignal,
  opts: GateUsage = {},
): Promise<GateResult> {
  const rt = currentRuntime();
  if (rt.cancel.aborted) throw new Error('tenant_closing');
  // 沙箱必须给输出一个实际生效的上限，才能预占足额。宿主 payload 保持原样。
  if (rt.kind === 'sandbox' && !url.endsWith('/embeddings') && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_tokens = 4096;
    init = { ...init, body: JSON.stringify(body) };
  }
  const signal = () => AbortSignal.any([rt.cancel, signalFactory()]);
  const work = () => fetchThroughGate(url, init, signal, opts);
  return rt.kind === 'sandbox' ? rt.inflight.track(work) : work();
}

async function fetchThroughGate(
  url: string,
  init: RequestInit,
  signalFactory: () => AbortSignal,
  opts: GateUsage = {},
): Promise<GateResult> {
  const rt = currentRuntime();
  const usage = requestUsage(init, url, opts);
  const maxRetry = opts.maxRetry ?? MAX_RETRY;
  // 排队用的信号同样带着一个从此刻起算的单次超时，所以排队本身也不会超过 LLM_TIMEOUT_MS
  const pool = opts.purpose === 'vision' ? 'vision' : 'chat';
  await acquire(signalFactory(), pool);
  let holdSlot = false;
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release(pool);
  };
  try {
    let last: Response | null = null;
    let lastBody = '';
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      // 每次尝试（含退避之前）先看调用方是否已放弃：整轮 deadline 到期、或对冲请求
      // 已经有一方胜出。此时 signalFactory() 拿到的都是已中止的信号，fetch 必然秒失败，
      // 再退避重试只是白占名额约 2s——而这恰好发生在系统最拥堵的时候，排在后面的
      // 客户请求会被一起拖慢。
      let signal = signalFactory();
      if (signal.aborted) throw signal.reason;
      if (attempt > 0) {
        // 指数退避 + 抖动：同一批被限流的请求不要在同一刻一起重试，否则又一起撞墙
        const base = 600 * 2 ** (attempt - 1);
        const wait = base + Math.floor(Math.random() * 300);
        console.warn(`[llm] 第 ${attempt} 次重试，等待 ${wait}ms（上次状态 ${last?.status ?? '网络异常'}）`);
        await sleep(wait, signal); // 退避中途被放弃（对冲输了、deadline 到了）就立刻让出名额
        // 重新取一个信号，单次超时从真正发请求时起算
        signal = signalFactory();
        if (signal.aborted) throw signal.reason;
      }
      // 预占在拿到实例名额后、每次真正发请求前；拒绝不进入重试分支。
      assertSandboxRunning();
      if (rt.cancel.aborted) throw new Error('tenant_closing');
      const reservation =
        rt.kind === 'sandbox' && opts.poolOnly
          ? reserveSandboxIndex(usage.estimateMilli)
          : rt.budget.reserve(usage.purpose, usage.estimateMilli);
      if (!reservation) throw new BudgetExhausted();
      let settled = false;
      let handedOff = false;
      let pendingReport: (() => void) | undefined;
      const reportUsage = (): void => {
        const report = pendingReport;
        pendingReport = undefined;
        report?.();
      };
      const settleUsage = (data: unknown): void => {
        if (settled) return;
        settled = true;
        if (holdSlot) releaseOnce();
        rt.cancel.removeEventListener('abort', onCancel);
        const actual = actualCost(data, usage.model);
        reservation.settle(actual);
        if (rt.kind === 'sandbox' && !opts.poolOnly) {
          const u =
            actual === null
              ? undefined
              : (
                  data as {
                    usage: {
                      prompt_tokens?: number;
                      completion_tokens?: number;
                      prompt_cache_hit_tokens?: number;
                      prompt_tokens_details?: { cached_tokens?: number };
                      completion_tokens_details?: { reasoning_tokens?: number };
                    };
                  }
                ).usage;
          const report = () =>
            recordUsage(
              usage.model,
              u?.prompt_tokens ?? 0,
              u?.completion_tokens ?? 0,
              opts.sessionId,
              u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0,
              u?.completion_tokens_details?.reasoning_tokens ?? 0,
              usage.purpose,
              actual ?? usage.estimateMilli,
            );
          if (opts.deferUsage && handedOff && data !== null) pendingReport = report;
          else report();
        }
      };
      // 响应头已交出但正文未读完时，删除仍要同步结算；迟到的成功解析不会再记一次。
      const onCancel = () => withTenantScope(rt, () => settleUsage(null));
      if (rt.kind === 'sandbox') rt.cancel.addEventListener('abort', onCancel, { once: true });
      try {
        const res = await fetch(url, { ...init, signal });
        if (rt.cancel.aborted) {
          await res.body?.cancel().catch(() => {});
          throw new Error('tenant_closing');
        }
        if (res.ok) {
          handedOff = true;
          holdSlot = pool === 'vision';
          return { res, attempts: attempt + 1, settleUsage, ...(rt.kind === 'sandbox' ? { reportUsage } : {}) };
        }
        settleUsage(null);
        if (!retriable(res.status)) return { res, attempts: attempt + 1, settleUsage };
        last = res;
        // 读出来既是释放 body（避免连接悬挂），也是保住错误原因：这个 Response
        // 可能被当作最终结果返回，届时 body 已不可再读
        lastBody = await res.text().catch(() => '');
      } catch (e) {
        // 网络异常/超时：超时是我们自己 abort 的，重试一次仍有意义（上游偶发挂起）
        if (attempt === maxRetry) throw e;
        last = null;
        lastBody = '';
      } finally {
        if (!handedOff) settleUsage(null);
      }
    }
    if (last) return { res: last, attempts: maxRetry + 1, errorBody: lastBody, settleUsage: () => {} };
    throw new Error('LLM 请求重试后仍失败');
  } finally {
    if (!holdSlot) releaseOnce();
  }
}

/** 名额已满（再发就要排队）。对冲请求据此决定要不要加发：拥堵时再加一个请求只会让队更长 */
export function gateBusy(): boolean {
  return MAX_INFLIGHT > 0 && inflight.chat >= MAX_INFLIGHT;
}

export function gateStatus(): { inflight: number; waiting: number; maxInflight: number } {
  return { inflight: inflight.chat, waiting: waiting.chat.length, maxInflight: MAX_INFLIGHT };
}
