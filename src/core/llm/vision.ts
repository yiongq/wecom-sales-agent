import type { ZodType } from 'zod';
import { inTenantTx } from '../../db/client.js';
import { gatedFetch, type GateResult } from '../../llm-gate.js';
import { currentRuntime } from '../../tenancy/runtime.js';
import { recordUsage } from '../../usage.js';
import { llmCfg, notifyLlmCall, thinkingParams, type CallTrace } from './client.js';
import { reserveVisionCall } from './vision-limit.js';
import type { VisionContent } from './types.js';

export type VisionResult<T> = { ok: true; value: T } | { ok: false; reason: 'limit' | 'failed' };

export interface VisionRequest<T> {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  prompt: string;
  schema: ZodType<T>;
  maxOutputTokens: number;
  signal: AbortSignal;
  sessionId: string;
  /** 离线包注入固定 JSON 值或脚本；脚本须响应 signal。 */
  mock?: unknown | ((signal: AbortSignal) => unknown | Promise<unknown>);
}

interface VisionCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** 即使离线脚本未响应取消，也按总时限返回，迟到结果不再生效。 */
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 单张图片的独立 JSON 请求；不经过主对话的 wire、工具循环、对冲或自愈。 */
export async function vision<T>(req: VisionRequest<T>): Promise<VisionResult<T>> {
  try {
    const rt = currentRuntime();
    const work = () => runVision(req);
    // 跟踪到正文读完与结算结束；沙箱回收不能在响应头到达时提前排空。
    return await (rt.kind === 'sandbox' ? rt.inflight.track(work) : work());
  } catch {
    // 配置、作用域或结算失败同样不向调用方抛；不记录可能含图片/提示的异常原文。
    return { ok: false, reason: 'failed' };
  }
}

async function runVision<T>(req: VisionRequest<T>): Promise<VisionResult<T>> {
  let step: CallTrace | undefined;
  let gate: GateResult | undefined;
  let data: VisionCompletion | undefined;
  let attempted = false;
  const started = Date.now();
  const rt = currentRuntime();
  try {
    if (inTenantTx()) return { ok: false, reason: 'failed' };
    const signal = AbortSignal.any([req.signal, rt.cancel, AbortSignal.timeout(40_000)]);
    signal.throwIfAborted();
    if (!Number.isSafeInteger(req.maxOutputTokens) || req.maxOutputTokens <= 0) return { ok: false, reason: 'failed' };
    const { baseUrl, apiKey } = llmCfg();
    const model = process.env.LLM_VISION_MODEL || 'glm-5.3-flashx';
    if (process.env.LLM_MOCK !== '1' && !apiKey) throw new Error('vision_configuration');
    if (!(await abortable(() => reserveVisionCall(req.sessionId, signal), signal))) return { ok: false, reason: 'limit' };
    attempted = true;
    step = { model, purpose: 'vision', hedged: false, ms: Date.now() - started, tools: [], toolMs: 0, reused: [], error: null };
    // 先建 trace 槽位，沙箱闸口的 HTTP/取消结算也能找到对应调用；finally 更新同一对象。
    notifyLlmCall(step);
    if (process.env.LLM_MOCK === '1') {
      const value = await abortable(async () => (typeof req.mock === 'function' ? req.mock(signal) : req.mock), signal);
      const parsed = req.schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
      if (!parsed.success) throw new SyntaxError('vision_schema');
      return { ok: true, value: parsed.data };
    }
    const content: VisionContent = [
      { type: 'text', text: req.prompt },
      { type: 'image_url', image_url: { url: `data:${req.mime};base64,${Buffer.from(req.bytes).toString('base64')}` } },
    ];
    gate = await gatedFetch(
      baseUrl + '/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          temperature: 0.1,
          max_tokens: req.maxOutputTokens,
          // 第 13 步实测：不带时约一半回复把 JSON 包在 ```json 代码块里；带上之后 9/9 是裸 JSON，内容与时延不变。
          response_format: { type: 'json_object' },
          ...thinkingParams(baseUrl, model),
        }),
      },
      () => AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      { purpose: 'vision', maxRetry: 0, sessionId: req.sessionId, deferUsage: true },
    );
    if (!gate.res.ok) {
      step.error = gate.res.status === 429 ? 'rate_limited' : gate.res.status >= 500 ? 'http_5xx' : 'bad_response';
      await gate.res.body?.cancel().catch(() => {});
      return { ok: false, reason: 'failed' };
    }
    data = (await gate.res.json()) as VisionCompletion;
    signal.throwIfAborted();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length' || typeof choice?.message?.content !== 'string') throw new SyntaxError('vision_response');
    // 换了不认 response_format 的服务商时，仍容忍外面包一层 ```json 代码块。
    const body = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i.exec(choice.message.content)?.[1] ?? choice.message.content;
    const parsed = req.schema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new SyntaxError('vision_schema');
    return { ok: true, value: parsed.data };
  } catch (error) {
    if (step) {
      const name = error instanceof Error ? error.name : '';
      step.error =
        name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : error instanceof SyntaxError ? 'bad_response' : 'http_5xx';
    }
    return { ok: false, reason: 'failed' };
  } finally {
    if (step) {
      step.ms = Date.now() - started;
    }
    gate?.settleUsage(data ?? null);
    gate?.reportUsage?.();
    if (attempted && rt.kind !== 'sandbox' && step) {
      const u = data?.usage;
      recordUsage(
        step.model,
        u?.prompt_tokens ?? 0,
        u?.completion_tokens ?? 0,
        req.sessionId,
        u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0,
        u?.completion_tokens_details?.reasoning_tokens ?? 0,
        'vision',
      );
    }
  }
}
