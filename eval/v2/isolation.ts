// 只在常驻评测子进程安装：给没有 reset 出口的私有状态挂清理回调。
// load hook 仅追加清理函数，不改运行逻辑或磁盘上的 src；串行对照模式不装它。
// 私有依赖：store 的 sessions/orders/pgBackend/changeTimer/fileBackend，PG factory 的 entries/preRefs/adopted/voidedIds/conflict/lastError/stats/isDirty，
// budget/usage 的 state/flushTimer/timer/today/blank/warnedUnknown，llm 的 learnedThinking/warnedIgnoredDisabled/requestObserver/stats，usage-daily 的 timer/chain/acc/lastDay，takeover 的 gens 及下面的 __*Test 出口。
// 模块搬家或私有变量改名后，同步 bodies 的路径与清理代码（PG factory 定位另见 isolation-loader.mjs），再跑池 / 隔离对照自测。
import { register } from 'node:module';

const resets = new Map<string, () => void | Promise<void>>();
const key = Symbol.for('wecom.eval.v2.resets');
Object.defineProperty(globalThis, key, { value: resets, configurable: true });
const bodies: Record<string, string> = {
  'store.ts': `
    for (const id of sessions.keys()) pgBackend?.forget(id);
    sessions.clear(); orders.clear();
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = null;
    fileBackend.flushNow();`,
  'store/pg-backend.ts': `
    for (const e of entries.values()) {
      if (e.inflight || e.pcRun || isDirty(e)) throw new Error('v2 isolation: PG 写队列未排空');
      if (e.timer) clearTimeout(e.timer);
      if (e.pcTimer) clearTimeout(e.pcTimer);
    }
    entries.clear(); preRefs.clear(); adopted.clear(); voidedIds.clear();
    conflict = false; lastError = null;
    for (const k of Object.keys(stats)) stats[k] = 0;`,
  'budget.ts': `
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    state = { day: today(), calls: 0, perSession: {} };`,
  'usage.ts': `
    if (timer) clearTimeout(timer);
    timer = null; state = blank(); warnedUnknown.clear();`,
  'llm.ts': `
    learnedThinking.clear(); warnedIgnoredDisabled.clear(); requestObserver = null;
    for (const k of Object.keys(stats)) stats[k] = 0;`,
  'trace/usage-daily.ts': `
    if (timer) clearInterval(timer);
    timer = null;
    await chain;
    acc.clear(); lastDay = ''; __usageDailyTest.rearm(30000);`,
  'retrieval.ts': '__retrievalTest.reset();',
  'followup.ts': '__followupTest.resetForTest();',
  'notify/handoff.ts': '__handoffNotifyTest.reset();',
  'jobs/runner.ts': '__jobsTest.reset();',
  'handoff/takeover.ts': 'gens.clear(); __takeoverTest.resetRecent();',
  'quota/ledger.ts': '__ledgerTest.reset();',
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
  assertResetsRegistered();
}

export async function resetCaseState(varDir: string): Promise<void> {
  assertResetsRegistered();
  const { __profileTest } = await import('../../src/profile.js');
  __profileTest.reset();
  // PG 的队列/timer 在摘掉 identity map 之前清，且必须确认没有在途写入。
  await resets.get('store/pg-backend.ts')!();
  for (const name of resetModuleNames) if (name !== 'store/pg-backend.ts') await resets.get(name)!();
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
