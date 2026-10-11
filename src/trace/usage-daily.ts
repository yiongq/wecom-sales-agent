import { currentRuntime, withTenantScope, withoutTenantScope, backgroundEntry, type TenantRuntime } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';
import { initializeStandardBudget } from '../tenancy/budget.js';
import { todayIso } from '../env.js';
// usage_daily 的累加器（docs/architecture/02-conversations-workbench/spec.md「逐轮 trace、护栏事件与用量」、R16）。
// 订阅 usage.ts 的 onUsage（所有模型调用的唯一汇聚点），内存里按（租户、天、模型、用途）累加；db 存储装上之后（store.ts 的
// initSessionStore 调 startUsageDaily）每 30 秒与停机的 drain 段把累加的部分交给写入函数 upsert 进 usage_daily。
// 不 import src/db/**：写入函数由 store 注入（PG 后端的 writeUsage）。文件存储下没有写入函数，不写库，只留当天的几项。
// 天是 usage.ts 记账时的日期（服务器时区 TZ，与 usage.json 同一个口径）；金额按千分之一元取整，零头留到下一次（不按次四舍五入，
// 不然每 30 秒只有几次便宜调用的实例永远记成 0）。
import { onUsage, type UsageEvent, type UsagePurpose } from '../usage.js';

/** 交给写入函数的一行：与 src/db/repo/usage.ts 的 UsageDelta 同构 */
export interface UsageDailyDelta {
  day: string;
  model: string;
  purpose: UsagePurpose;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** 千分之一元 */
  costMilliCny: number;
}

interface Acc extends Omit<UsageDailyDelta, 'costMilliCny'> {
  /** 还没写进库的金额（千分之一元，带小数） */
  milli: number;
}

const COUNTERS = ['calls', 'promptTokens', 'completionTokens', 'cachedTokens', 'reasoningTokens'] as const;

interface DailyState {
  owner: TenantRuntime;
  acc: Map<string, Acc>;
  writer: ((deltas: UsageDailyDelta[]) => Promise<void>) | null;
  chain: Promise<void>;
  queued: number;
  lastDay: string;
  intervalMs: number | null;
  nextAt: number;
  /** 本运行时已提交的当日金额；与库快照在同一写队列里核对，防止软上限重复计费。 */
  persistedDay: string;
  persistedMilli: number;
}
const states = new Map<string, DailyState>();
// 唯一实例定时器在空作用域创建；每拍显式恢复各 writer 的租户。
let timer: NodeJS.Timeout | null = null;
// 实例唯一的刷新拍间隔；租户累计值仍在各自登记的累加器中。
let armedMs: number | null = null;
function daily(): DailyState {
  const rt = currentRuntime();
  let state = states.get(rt.id);
  // 文件兼容入口在 DB 启动时补身份；保留已累加的启动 embedding。
  if (!state) {
    for (const [id, entry] of states)
      if (entry.owner === rt) {
        states.delete(id);
        state = entry;
        states.set(rt.id, entry);
        break;
      }
  }
  if (!state) {
    state = {
      owner: rt,
      acc: new Map(),
      writer: null,
      chain: Promise.resolve(),
      queued: 0,
      lastDay: '',
      intervalMs: null,
      nextAt: 0,
      persistedDay: '',
      persistedMilli: 0,
    };
    states.set(rt.id, state);
  }
  return state;
}

withoutTenantScope(() =>
  onUsage((e: UsageEvent) => {
    const rt = currentRuntime();
    if (rt.state !== 'serving') return;
    const state = daily();
    const { acc, writer } = state;
    // 没有写入函数（文件存储）时只留当天的：换天就把前一天的丢掉，免得长期运行的文件存储实例越攒越多
    if (!writer && e.day !== state.lastDay) acc.clear();
    state.lastDay = e.day;
    const key = JSON.stringify([rt.id, e.day, e.model, e.purpose]);
    let a = acc.get(key);
    if (!a) {
      a = {
        day: e.day,
        model: e.model,
        purpose: e.purpose,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        milli: 0,
      };
      acc.set(key, a);
    }
    a.calls += 1;
    a.promptTokens += e.promptTokens;
    a.completionTokens += e.completionTokens;
    a.cachedTokens += e.cachedTokens;
    a.reasoningTokens += e.reasoningTokens;
    a.milli += e.cny * 1000;
  }),
);

/** 把累加的部分写一次。先从累加器里扣掉再写（写入期间来的新用量另起一份），写失败就加回去、下一次再试 */
async function flushOnce(rt: TenantRuntime, state: DailyState): Promise<void> {
  const { acc, writer } = state;
  if (!writer || states.get(rt.id) !== state) return;
  const batch: { a: Acc; d: UsageDailyDelta }[] = [];
  for (const a of acc.values()) {
    // 加一点余量再取整：0.1 + 0.2 这类浮点零头不该让 1 厘变成 0
    const milli = Math.max(0, Math.floor(a.milli + 1e-6));
    if (!a.calls && !milli) continue;
    const d: UsageDailyDelta = {
      day: a.day,
      model: a.model,
      purpose: a.purpose,
      calls: a.calls,
      promptTokens: a.promptTokens,
      completionTokens: a.completionTokens,
      cachedTokens: a.cachedTokens,
      reasoningTokens: a.reasoningTokens,
      costMilliCny: milli,
    };
    batch.push({ a, d });
  }
  if (!batch.length) return;
  for (const { a, d } of batch) {
    for (const c of COUNTERS) a[c] -= d[c];
    a.milli -= d.costMilliCny;
  }
  try {
    await writer(batch.map((b) => b.d));
  } catch (e) {
    if (states.get(rt.id) !== state) return;
    for (const { a, d } of batch) {
      for (const c of COUNTERS) a[c] += d[c];
      a.milli += d.costMilliCny;
    }
    // 只打原因码：PG 后端的 writeUsage 已在 db 一侧归好类（UsageWriteError.code：SQLSTATE 沿 cause 链取，或 conflict / closed /
    // held_by_other），不打错误原文
    const code = (e as { code?: unknown })?.code;
    console.warn(
      `[usage] usage_daily 写入失败（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}），这批用量留到下一次再写`,
    );
    return;
  }
  if (states.get(rt.id) !== state) return;
  const day = todayIso();
  if (state.persistedDay !== day) {
    state.persistedDay = day;
    state.persistedMilli = 0;
  }
  for (const { d } of batch) if (d.day === day) state.persistedMilli += d.costMilliCny;
  // 写完的、前一天的只剩零头（不到 1 厘）的项不再留着
  for (const [k, a] of acc) if (!a.calls && a.day !== state.lastDay) acc.delete(k);
}

/** 与 writer 串行读库；传入库快照中已包含的本运行时金额（只计成功提交）。 */
export function withUsageDailySnapshot<T>(day: string, read: (persistedMilli: number) => Promise<T>): Promise<T> {
  const rt = currentRuntime();
  const state = daily();
  state.queued++;
  const run = state.chain.then(() =>
    withTenantScope(rt, () => read(state.owner === rt && state.persistedDay === day ? state.persistedMilli : 0)),
  );
  state.chain = run
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      state.queued--;
    });
  return run;
}

/** 写一次累加的用量（定时器与 drain 段调用）；没装写入函数（文件存储）时什么都不做。不抛 */
export function flushUsageDaily(): Promise<void> {
  const rt = currentRuntime();
  if (rt.state === 'closed') return Promise.resolve();
  const state = daily();
  state.queued++;
  const run = state.chain.then(() => withTenantScope(rt, () => flushOnce(rt, state)));
  state.chain = run
    .catch(() => undefined)
    .finally(() => {
      state.queued--;
    });
  return state.chain;
}

/** 每租户接一份 writer；启动、drain 均由所属 rt 调用。 */
export function startUsageDaily(write: (deltas: UsageDailyDelta[]) => Promise<void>, intervalMs = 30_000): Promise<void> {
  const rt = currentRuntime();
  const state = daily();
  state.writer = write;
  state.intervalMs = intervalMs;
  state.nextAt = Date.now() + intervalMs;
  const ready = initializeStandardBudget(rt);
  arm();
  return ready;
}
function arm(): void {
  if (timer) clearInterval(timer);
  timer = null;
  armedMs = null;
  const intervals = [...states.values()].flatMap((s) => (s.writer && s.intervalMs !== null ? [s.intervalMs] : []));
  if (!intervals.length) return;
  armedMs = Math.min(...intervals);
  const period = armedMs;
  timer = withoutTenantScope(() =>
    setInterval(() => {
      for (const state of states.values()) {
        const rt = state.owner;
        if (!state.writer || rt.state !== 'serving' || Date.now() < state.nextAt) continue;
        state.nextAt = Date.now() + state.intervalMs!;
        backgroundEntry(() => withTenantScope(rt, flushUsageDaily));
      }
    }, period),
  );
  timer.unref();
}
function drop(id: string): void {
  for (const [key, state] of states)
    if (state.owner.id === id) {
      state.writer = null;
      state.acc.clear();
      states.delete(key);
    }
  arm();
}
function dailyRegistration(field: 'acc' | 'writer' | 'intervalMs' | 'queued' | 'lastDay') {
  return {
    keyCount: (id: string) =>
      [...states]
        .filter(([, s]) => s.owner.id === id)
        .reduce((n, [, s]) => n + (field === 'acc' ? s.acc.size + Number(s.persistedMilli > 0) : Number(Boolean(s[field]))), 0),
    drop,
    reset: () => {
      for (const s of states.values()) {
        s.writer = null;
        s.acc.clear();
      }
      states.clear();
      arm();
    },
  };
}
registerTenantState({ name: 'usage.daily.acc', ...dailyRegistration('acc') });
registerTenantState({ name: 'usage.daily.writer', ...dailyRegistration('writer') });
registerTenantState({ name: 'usage.daily.timer', ...dailyRegistration('intervalMs') });
registerTenantState({ name: 'usage.daily.chain', ...dailyRegistration('queued') });
registerTenantState({ name: 'usage.daily.lastDay', ...dailyRegistration('lastDay') });

/** 仅供自测；读取的始终是当前租户。 */
export const __usageDailyTest = {
  /** 常驻评测保留连接夹具，统一 reset 后只恢复 writer，不带回金额、队列或软上限基数。 */
  captureWriters(): () => void {
    const writers = [...states.values()].flatMap((s) =>
      s.writer && s.intervalMs !== null ? [{ owner: s.owner, writer: s.writer, intervalMs: s.intervalMs }] : [],
    );
    return () => {
      for (const { owner, writer, intervalMs } of writers)
        withTenantScope(owner, () => {
          const state = daily();
          state.writer = writer;
          state.intervalMs = intervalMs;
          state.nextAt = Date.now() + intervalMs;
        });
      // 不在这里初始化预算：worker 随后才清数据库，下一条 case 读的是清理后的基数。
      arm();
    };
  },
  pending(): (Omit<UsageDailyDelta, 'costMilliCny'> & { milli: number })[] {
    return [...daily().acc.values()].map((a) => ({ ...a }));
  },
  intervalMs: (): number | null => daily().intervalMs,
  rearm(ms: number): void {
    const state = daily();
    if (state.writer) {
      state.intervalMs = ms;
      state.nextAt = Date.now() + ms;
      arm();
    }
  },
};
