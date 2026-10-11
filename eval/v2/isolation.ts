// 只在常驻评测子进程安装：给没有 reset 出口的私有状态挂清理回调。
// load hook 仅追加清理函数，不改运行逻辑或磁盘上的 src；串行对照模式不装它。
// 私有补丁只保留实例级预算文件、用量文件与模型探测；租户状态由登记表统一重置。
import { register } from 'node:module';

const resets = new Map<string, () => void | Promise<void>>();
const key = Symbol.for('wecom.eval.v2.resets');
Object.defineProperty(globalThis, key, { value: resets, configurable: true });
const bodies: Record<string, string> = {
  'budget.ts': `
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    state = { day: today(), calls: 0, perSession: {} };`,
  'usage.ts': `
    if (timer) clearTimeout(timer);
    timer = null; state = blank(); warnedUnknown.clear();`,
  'core/retrieval.ts': 'shared.clear(); retryBackoff = RETRY_BACKOFF_MS;',
  'core/llm/client.ts': `
    learnedThinking.clear(); warnedIgnoredDisabled.clear(); requestObserver = null;
    for (const k of Object.keys(stats)) stats[k] = 0;`,
};
export const resetModuleNames = Object.freeze(Object.keys(bodies));

function assertResetsRegistered(): void {
  const missing = resetModuleNames.filter((name) => typeof resets.get(name) !== 'function');
  if (missing.length) throw new Error(`v2 isolation: 清理回调未登记：${missing.join('、')}；模块搬家后要同步改 eval/v2/isolation.ts`);
}

export function installResets(): void {
  register(new URL('./isolation-loader.mjs', import.meta.url), {
    data: Object.entries(bodies).map(([name, body]) => [new URL(`../../src/${name}`, import.meta.url).href, { name, body }]),
  });
}

// 在引擎与后端初始化后主动加载全部清理目标，包括尚未走到的业务分支。
export async function loadResetModules(): Promise<void> {
  await Promise.all(resetModuleNames.map((name) => import(new URL(`../../src/${name}`, import.meta.url).href)));
  await Promise.all(
    ['core/insight', 'core/retrieval', 'handoff/takeover', 'quota/ledger', 'privacy/privacy', 'ops/metrics'].map(
      (name) => import(new URL(`../../src/${name}.ts`, import.meta.url).href),
    ),
  );
  assertResetsRegistered();
}

export async function resetCaseState(varDir: string): Promise<void> {
  assertResetsRegistered();
  const { __profileTest } = await import('../../src/profile.js');
  __profileTest.reset();
  const { tenantRuntimes, tenantStoreIfLoaded, withTenantScope } = await import('../../src/tenancy/runtime.js');
  const { resetTenantState } = await import('../../src/tenancy/state.js');
  const { drainStore } = await import('../../src/store.js');
  const { flushUsageDaily, __usageDailyTest } = await import('../../src/trace/usage-daily.js');
  // 池复用已装载的配置与连接：先排空，摘掉每个会话的后端缓存，再统一 reset。
  // 发布快照是本次评测的固定夹具，reset 之后重新装回，不靠私有源码补丁保留。
  const fixtures = tenantRuntimes().map((rt) => ({ rt, config: { ...rt.config }, pack: rt.pack }));
  for (const { rt } of fixtures)
    await withTenantScope(rt, async () => {
      const store = tenantStoreIfLoaded(rt);
      if (!store) return;
      const { undrained } = await drainStore(5000);
      if (undrained.length) throw new Error('v2 isolation: PG 写队列未排空');
      await flushUsageDaily();
      for (const id of store.sessions.keys()) store.pgBackend?.forget(id);
    });
  resetTenantState();
  for (const { rt, config, pack } of fixtures) {
    Object.assign(rt.config, config);
    rt.pack = pack;
  }
  // 第 9、10 步尚未登记的模块先用其公开测试出口，合入后由各自 reset 接管。
  const { __followupTest } = await import('../../src/core/followup.js');
  const { __handoffNotifyTest } = await import('../../src/notify/handoff.js');
  const { __jobsTest } = await import('../../src/jobs/runner.js');
  for (const { rt } of fixtures)
    withTenantScope(rt, () => {
      __followupTest.resetForTest();
      __handoffNotifyTest.reset();
      __jobsTest.reset();
      __usageDailyTest.rearm(30000);
    });
  for (const name of resetModuleNames) await resets.get(name)!();
  const { gateStatus } = await import('../../src/llm-gate.js');
  const gate = gateStatus();
  if (gate.inflight || gate.waiting) throw new Error('v2 isolation: 模型请求未排空');
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(varDir)) fs.rmSync(`${varDir}/${entry}`, { recursive: true, force: true });
}

// parity-clock.ts 的偏移在首次 import 时固定；池内每条 case 都必须重新拨钟。
const RealDate = Date;
export function setCaseClock(now?: string): void {
  const offset = now ? Date.parse(now) - RealDate.now() : 0;
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FixtureDate as DateConstructor;
}
