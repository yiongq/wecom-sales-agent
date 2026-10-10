import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SimDeps, Tokens } from './runner.js';
import { Meter } from './runner.js';
import type { Snapshot } from './judge.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';

export const FIXTURE_CLOCK = '2026-10-10T12:00:00+08:00';
export function fixtureClock(): () => void {
  const RealDate = Date;
  const offset = RealDate.parse(FIXTURE_CLOCK) - RealDate.now();
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (!args.length) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FixtureDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
export interface PriceRow {
  in: number;
  out: number;
  cachedIn: number;
}
export function validatePrices(value: unknown): Record<string, PriceRow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--prices 必须是按模型名索引的对象');
  for (const [model, row] of Object.entries(value)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`--prices ${model}: 无效单价`);
    const r = row as Record<string, unknown>;
    if (
      Object.keys(r).length !== 3 ||
      !['in', 'out', 'cachedIn'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= 0)
    )
      throw new Error(`--prices ${model}: 需要非负的 in/out/cachedIn（元/百万 token）`);
  }
  return value as Record<string, PriceRow>;
}

// 只改变评测进程的部署/存储与时钟；销售模型、SOP、工具定义照引擎原配置。
export async function engineRuntime(
  meter: Meter,
  customerModel: string | undefined,
  overrides: Record<string, PriceRow> = {},
): Promise<{
  deps: SimDeps;
  close(): Promise<void>;
  metadata: Record<string, unknown>;
}> {
  const restoreClock = fixtureClock();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sim-'));
  const savedEnv = { ...process.env };
  process.env.VAR_DIR = temp;
  process.env.CONFIG_SOURCE = 'file';
  process.env.SOP_PATH = path.resolve('data/sop.md');
  process.env.ROUTES_PATH = path.resolve('data/routes.json');
  process.env.HOTELS_PATH = path.resolve('data/hotels.json');
  const restoreProcess = async (): Promise<void> => {
    await fs.rm(temp, { recursive: true, force: true });
    restoreClock();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  };
  const load = async () => {
    await import('../../src/selftest-env.js');
    const usage = await import('../../src/usage.js');
    const llm = await import('../../src/llm.js');
    const engine = await import('../../src/engine.js');
    const recorder = await import('../../src/trace/recorder.js');
    const store = await import('../../src/store.js');
    return { usage, llm, engine, recorder, store };
  };
  const modules = await load().catch(async (e: unknown) => {
    await restoreProcess();
    throw e;
  });
  const { costOf, onUsage } = modules.usage;
  const { llmCfg, llmStats } = modules.llm;
  const { handleMessage } = modules.engine;
  const { onTurnEnd } = modules.recorder;
  const store = modules.store;
  const salesCfg = llmCfg();
  const customerCfg = {
    baseUrl: process.env.SIM_CUSTOMER_BASE_URL || salesCfg.baseUrl,
    apiKey: process.env.SIM_CUSTOMER_API_KEY || salesCfg.apiKey,
    model: customerModel ?? salesCfg.model,
  };
  const knownFree = new Set(['glm-4.7-flash', 'glm-4.5-flash']);
  const checkModel = (m: string): void => {
    if (!overrides[m] && !knownFree.has(m) && costOf(m, 1_000_000, 1_000_000) === 0)
      throw new Error(`模型 ${m} 单价未知；请用 --prices 显式提供，不能按零费用运行`);
  };
  const price = (model: string, t: Tokens): number => {
    checkModel(model);
    const row = overrides[model];
    const cached = Math.max(0, Math.min(t.promptTokens, t.cachedTokens));
    return row
      ? ((t.promptTokens - cached) * row.in + cached * row.cachedIn + t.completionTokens * row.out) / 1_000_000
      : costOf(model, t.promptTokens, t.completionTokens, t.cachedTokens);
  };
  const realFetch = globalThis.fetch;
  let accountingError = false;
  const unsubscribe = onUsage((e) => {
    try {
      meter.add({
        side: 'sales',
        model: e.model,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        cachedTokens: e.cachedTokens,
        reasoningTokens: e.reasoningTokens,
        cny: price(e.model, e),
      });
    } catch {
      accountingError = true;
    }
  });
  // onUsage 发生在每次模型回包后。下一次 HTTP（含同一销售轮的工具往返）先检查预算，
  // 共享 abort signal 取消已在途请求。生产客户端及其配置不改。
  globalThis.fetch = (input, init) => {
    if (meter.stopped) return Promise.reject(new Error('budget_stop'));
    if (accountingError) return Promise.reject(new Error('accounting_usage_missing'));
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return realFetch(input, { ...init, signal: requestSignal ? AbortSignal.any([requestSignal, meter.signal]) : meter.signal });
  };
  const snapshot = (id: string): Snapshot => {
    const s = store.getSession(id)!;
    return structuredClone({
      orders: store.listOrders().filter((o) => o.sessionId === id),
      handedOver: s.handedOver,
      handoff: s.handoff ?? null,
      stage: s.stage,
    });
  };
  const close = async (): Promise<void> => {
    globalThis.fetch = realFetch;
    unsubscribe();
    try {
      await store.drainStore(5000);
    } finally {
      // usage/budget 有短延迟落盘；等落盘后再清理目录，避免退出时重建临时目录。
      await new Promise((r) => setTimeout(r, 3100));
      await restoreProcess();
    }
  };
  try {
    if (process.env.LLM_MOCK === '1' || !salesCfg.apiKey || !customerCfg.apiKey)
      throw new Error('模拟评测需要模型服务配置，不能使用 LLM_MOCK 或隐式 mock');
    for (const model of new Set(
      [salesCfg.model, llmCfg(true).model, customerCfg.model, llmStats().hedgeModel].filter((m): m is string => !!m),
    ))
      checkModel(model);
    const deps: SimDeps = {
      customerModel: customerCfg.model,
      price,
      async customer(persona, history, retry) {
        const response = await fetch(`${customerCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${customerCfg.apiKey}` },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model: customerCfg.model,
            stream: false,
            max_tokens: 512,
            messages: [
              {
                role: 'system',
                content: `你扮演客户，遵循下面的隐藏设定，只输出 JSON {"say":string,"done":boolean}。say 是下一句话，done 表示本句之后结束；只结束时 say 可为空。不得替销售回答。\n今天是 2026-10-10。\n${persona}`,
              },
              ...history,
              {
                role: 'user',
                content: retry ? '上次输出不符合协议，请只输出含 say 字符串和 done 布尔值的 JSON。' : '请说客户的下一句话。',
              },
            ],
          }),
        });
        if (!response.ok) throw new Error('customer_http');
        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        const u = data.usage;
        if (
          !u ||
          !Number.isFinite(u.prompt_tokens) ||
          !Number.isFinite(u.completion_tokens) ||
          u.prompt_tokens! < 0 ||
          u.completion_tokens! < 0
        )
          throw new Error('accounting_usage_missing');
        return {
          raw: data.choices?.[0]?.message?.content ?? '',
          tokens: {
            promptTokens: u.prompt_tokens!,
            completionTokens: u.completion_tokens!,
            cachedTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
          },
        };
      },
      start() {
        const id = `sim-eval-${randomUUID()}`;
        store.getOrCreateSession(id, 'simulator');
        return { id, initial: snapshot(id) };
      },
      async sales(id, customer) {
        let trace: FinishedTurn | undefined;
        const off = onTurnEnd((t) => {
          if (t.turn.conversationId === id) trace = structuredClone(t);
        });
        try {
          const reply = await handleMessage(id, customer.say, 'simulator');
          if (!trace) throw new Error('trace_missing');
          if (accountingError) throw new Error('accounting_usage_missing');
          return { customer, reply: reply.text, silent: !!reply.silent, trace, state: snapshot(id) };
        } finally {
          off();
        }
      },
      async end(id) {
        await store.flushSession(id, { timeoutMs: 5000 });
        store.deleteOrdersOfSession(id);
        store.forgetSession(id);
      },
    };
    return {
      deps,
      close,
      metadata: {
        clock: FIXTURE_CLOCK,
        timezone: 'Asia/Shanghai',
        config: 'file',
        brand: 'legacy',
        salesModel: salesCfg.model,
        customerModel: customerCfg.model,
        pricesSource: 'src/usage.ts costOf; --prices 覆盖项由运行者提供，待协调者核对',
        priceOverrides: overrides,
        toolResults: '现有 onTurnEnd: resultHead 前4096字节 + resultBytes；可能截断',
        budgetBoundary: '回包费用达到上限后不发新 HTTP，取消在途请求；现有引擎没有取消参数，当前确定性工具与收尾可能继续完成。',
        accounting:
          'onUsage 全部销售调用（含 embedding），客户回包 usage；reasoning 已含在 completion 中。已取消/无 usage 的请求费用无法由观察口核算。预算可超出最后一笔回包费用。',
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
