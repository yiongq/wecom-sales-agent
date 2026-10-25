import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SimDeps, Tokens } from './runner.js';
import { Meter } from './runner.js';
import type { Snapshot } from './judge.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import { PACK_FILE, readPackFile } from '../../src/config/pack-file.js';

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

/** 导出目录（07 R9，`export-config` 写的那种）里评测必须有的文件；policy.json、brand.json 可选。 */
export const CONFIG_DIR_REQUIRED = ['sop.md', 'routes.json', 'hotels.json'] as const;
/** 08 R11：目录里有 pack.json 指向非旅游包时必须有的：sop.md 与 pack.json；产品库在 catalog/，包声明的每个 kind 都要有 catalog/<kind>.json（resolveConfigDir 逐 kind 严检） */
export const PACK_DIR_REQUIRED = ['sop.md', PACK_FILE] as const;

/** 目录里 pack.json 指的非旅游包 id；没有（或写的就是 travel）是 null，按旅游的老样子。pack.json 写坏了抛错 */
function packIdOf(abs: string): string | null {
  const id = readPackFile(abs)?.id;
  return id === undefined || id === 'travel' ? null : id;
}

/**
 * --config-dir 的静态检查：是目录；旅游有 sop.md、routes.json、hotels.json；非旅游包（目录里有 pack.json）有 sop.md、pack.json，
 * 以及包声明的每个 kind 的 catalog/<kind>.json（08 R11：逐 kind 严检，缺哪个就点名哪个，不把缺的当空数组）。
 * 返回绝对路径。文件内容是否合格由引擎装载时判（品牌 / policy 不合格会在 engineRuntime 里直接抛出，一个目标都不跑）。
 */
export async function resolveConfigDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('--config-dir 不是目录');
  let packId: string | null;
  try {
    packId = packIdOf(abs);
  } catch (e) {
    throw new Error(`--config-dir 里的 ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  for (const name of packId === null ? CONFIG_DIR_REQUIRED : PACK_DIR_REQUIRED) {
    const file = await fs.stat(path.join(abs, name)).catch(() => null);
    if (!file?.isFile()) throw new Error(`--config-dir 里缺 ${name}`);
  }
  if (packId !== null) {
    if (!(await fs.stat(path.join(abs, 'catalog')).catch(() => null))?.isDirectory()) throw new Error('--config-dir 里缺 catalog/');
    // 包声明的 kind 取注册表（后台定义与对话运行时的 kind 一致，注册表装载时已核对）。动态引入：旅游目录不碰注册表，
    // 注册表的模块图装载时不读 VAR_DIR / SOP_PATH 一类评测要改的变量，可以早于 engineRuntime 设环境变量
    const { packById } = await import('../../src/packs/registry.js');
    const pack = packById(packId);
    if (!pack) throw new Error(`--config-dir 里的 pack.json 指向行业包「${packId}」，它不在注册表里`);
    for (const { kind } of pack.entities) {
      if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new Error(`--config-dir：kind「${kind}」不能当文件名用`);
      const file = await fs.stat(path.join(abs, 'catalog', `${kind}.json`)).catch(() => null);
      if (!file?.isFile()) throw new Error(`--config-dir 里缺 catalog/${kind}.json`);
    }
  }
  return abs;
}

// 只改变评测进程的部署/存储与时钟；销售模型、SOP、工具定义照引擎原配置。
// options.configDir：给了就读这个目录里的配置——旅游是 sop.md / routes.json / hotels.json，其他包是 sop.md / pack.json / catalog/<kind>.json
// （policy.json、brand.json 在 SOP_PATH 同目录，有就用，没有走包默认）；目录里有 pack.json 指向非旅游包时只设 SOP_PATH，
// 包与产品库（catalog/）由同目录的 pack.json 认（08 R11）；
// 没给照旧读 data/（07 plan 风险 G3）。用完照旧恢复 process.env。
export async function engineRuntime(
  meter: Meter,
  customerModel: string | undefined,
  overrides: Record<string, PriceRow> = {},
  options: { configDir?: string } = {},
): Promise<{
  deps: SimDeps;
  close(): Promise<void>;
  metadata: Record<string, unknown>;
}> {
  const configDir = options.configDir === undefined ? undefined : await resolveConfigDir(options.configDir);
  const restoreClock = fixtureClock();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sim-'));
  // 被信号终止（闸超时）时 src/shutdown.ts 经 process.exit 退出，exit 钩子把临时目录一并清掉。
  // store 的 exit 钩子会把没落盘的状态写回 VAR_DIR，所以引擎模块装载之后还要再挂一次，保证排在它后面。
  const removeTemp = (): void => rmSync(temp, { recursive: true, force: true });
  process.on('exit', removeTemp);
  const savedEnv = { ...process.env };
  process.env.VAR_DIR = temp;
  process.env.CONFIG_SOURCE = 'file';
  process.env.SOP_PATH = configDir ? path.join(configDir, 'sop.md') : path.resolve('data/sop.md');
  // 非旅游包的目录没有 routes.json / hotels.json，也不设这两个变量
  if (!configDir || packIdOf(configDir) === null) {
    process.env.ROUTES_PATH = configDir ? path.join(configDir, 'routes.json') : path.resolve('data/routes.json');
    process.env.HOTELS_PATH = configDir ? path.join(configDir, 'hotels.json') : path.resolve('data/hotels.json');
  }
  // 同一进程里先后建几个 runtime（不同配置目录）：包绑定与文件模式的产品库快照跟着配置目录走，关闭时放回建 runtime 之前的样子
  let restoreConfig = (): void => {};
  const restoreProcess = async (): Promise<void> => {
    process.off('exit', removeTemp);
    await fs.rm(temp, { recursive: true, force: true });
    restoreClock();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    restoreConfig();
  };
  const load = async () => {
    await import('../../src/selftest-env.js');
    const usage = await import('../../src/usage.js');
    const llm = await import('../../src/llm.js');
    const engine = await import('../../src/engine.js');
    const recorder = await import('../../src/trace/recorder.js');
    const store = await import('../../src/store.js');
    const tools = await import('../../src/tools.js');
    const source = await import('../../src/config/source.js');
    const orderView = await import('../../src/core/order-view.js');
    return { usage, llm, engine, recorder, store, tools, source, orderView };
  };
  const modules = await load().catch(async (e: unknown) => {
    await restoreProcess();
    throw e;
  });
  process.off('exit', removeTemp);
  process.on('exit', removeTemp);
  const { costOf, onUsage } = modules.usage;
  const { llmCfg, llmStats } = modules.llm;
  const { handleMessage } = modules.engine;
  const { onTurnEnd } = modules.recorder;
  const store = modules.store;
  const { createQuote, routeVersion } = modules.tools;
  const { createLineOrder } = modules.orderView;
  const { currentPack, currentPolicy, initConfig, prefixSummary, saveFileConfig } = modules.source;
  restoreConfig = saveFileConfig();
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
      orders: store.listAnyOrders().filter((o) => o.sessionId === id),
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
    // 配置读不出来（policy.json 不合格、brand.json 不合格、非旅游包的 pack.json / catalog/*.json 不合格……）在这里就抛，一个目标都不跑；
    // 两个哈希随报告走，父进程可以核对子进程跑的就是它导出的那一份。
    // 先显式装载当前配置目录（同服务启动的 initConfig(null)：包、品牌、policy，非旅游包还有产品库）：
    // 同一进程里上一个 runtime 留下的包绑定与产品库快照不能带到这一个
    let loaded: { policyHash: string; promptHash: string; brand: ReturnType<typeof currentPack>['brand']; pack: string };
    try {
      await initConfig(null);
      const { brand, runtime: boundRuntime } = currentPack();
      const policyHash = currentPolicy().policyHash;
      const { promptHash } = prefixSummary(() => ({ ...modules.engine.promptPrefix(), sop: modules.engine.sopFileText() }));
      loaded = { policyHash, promptHash, brand, pack: boundRuntime.id };
    } catch (e) {
      throw new Error(`配置不合格: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')}`, { cause: e });
    }
    const { brand, policyHash, promptHash, pack } = loaded;
    const deps: SimDeps = {
      customerModel: customerCfg.model,
      configDir,
      pack,
      price,
      async customer(persona, history, retry) {
        const response = await fetch(`${customerCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${customerCfg.apiKey}` },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model: customerCfg.model,
            stream: false,
            // 智谱 glm-5.3 强制思考、默认最高档：不压档时思考吃光上限，JSON 被截断（第 5 步实测）
            max_tokens: 2048,
            ...(customerCfg.baseUrl.includes('bigmodel')
              ? /^glm-5\.3/i.test(customerCfg.model)
                ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
                : { thinking: { type: 'disabled' } }
              : {}),
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
      async start(seed) {
        const id = `sim-eval-${randomUUID()}`;
        const session = store.getOrCreateSession(id, 'simulator');
        if (seed) {
          // 订单走真实的订单状态：待付款 / 已付款 / 作废都由 store 的函数落成，不靠对话里口头说
          const now = Date.now();
          const history = seed.history ?? [];
          session.messages = history.map((m, i) => ({
            role: m.role === 'customer' ? 'customer' : 'agent',
            content: m.content,
            at: now - (history.length - i) * 60_000,
          }));
          Object.assign(session.profile, seed.profile);
          for (const o of seed.orders ?? []) {
            if ('lines' in o) {
              // 08 R11：通用单的种子只给条目和数量，经包的 priceLine 建；状态建好后再改成种子要的
              const result = await createLineOrder(session, o.lines);
              if ('rejected' in result) throw new Error(`种子订单被包拒绝：${JSON.stringify(result.rejected)}`);
              if (o.status === 'paid') store.markOrderPaid(result.order.id);
              else if (o.status !== 'pending_payment') {
                result.order.status = o.status;
                store.saveOrder(result.order);
              }
              continue;
            }
            const quote = createQuote({ routeId: o.routeId, travelers: o.travelers, departDate: o.departDate });
            const order = store.createOrder({
              sessionId: id,
              routeId: o.routeId,
              routeTitle: quote.routeTitle,
              travelers: quote.travelers,
              departDate: o.departDate,
              totalPrice: quote.total,
              catalogVersion: routeVersion(o.routeId),
            });
            if (['paid', 'refund_pending', 'refunded'].includes(o.status)) {
              store.markOrderPaid(order.id);
              order.status = o.status;
              store.saveOrder(order);
            } else if (o.status === 'cancelled') {
              order.status = 'cancelled';
              store.saveOrder(order);
            }
            session.orderIds.push(order.id);
          }
          session.stage =
            seed.stage ??
            ((seed.orders ?? []).some((o) => ['paid', 'refund_pending', 'refunded'].includes(o.status)) ? 'paid' : session.stage);
          store.saveSession(session);
        }
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
        config: configDir ? 'config-dir' : 'file',
        configDir: configDir ? path.basename(configDir) : null,
        brand: brand ? brand.brandName : 'legacy',
        promptHash,
        policyHash,
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
