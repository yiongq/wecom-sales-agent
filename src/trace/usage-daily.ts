// usage_daily 的累加器（docs/architecture/02-conversations-workbench/spec.md「逐轮 trace、护栏事件与用量」、R16）。
// 订阅 usage.ts 的 onUsage（所有模型调用的唯一汇聚点），内存里按（天、模型、用途）累加；db 存储装上之后（store.ts 的
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

const acc = new Map<string, Acc>();
let writer: ((deltas: UsageDailyDelta[]) => Promise<void>) | null = null;
let timer: NodeJS.Timeout | null = null;
/** 写入串行：30 秒的定时与 drain 段可能撞在一起，同一批不能写两遍 */
let chain: Promise<void> = Promise.resolve();
let lastDay = '';

onUsage((e: UsageEvent) => {
  // 没有写入函数（文件存储）时只留当天的：换天就把前一天的丢掉，免得长期运行的文件存储实例越攒越多
  if (!writer && e.day !== lastDay) acc.clear();
  lastDay = e.day;
  const key = JSON.stringify([e.day, e.model, e.purpose]);
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
});

/** 把累加的部分写一次。先从累加器里扣掉再写（写入期间来的新用量另起一份），写失败就加回去、下一次再试 */
async function flushOnce(): Promise<void> {
  if (!writer) return;
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
    for (const { a, d } of batch) {
      for (const c of COUNTERS) a[c] += d[c];
      a.milli += d.costMilliCny;
    }
    const code = (e as { code?: unknown })?.code;
    console.warn(
      `[usage] usage_daily 写入失败（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}），这批用量留到下一次再写`,
    );
    return;
  }
  // 写完的、前一天的只剩零头（不到 1 厘）的项不再留着
  for (const [k, a] of acc) if (!a.calls && a.day !== lastDay) acc.delete(k);
}

/** 写一次累加的用量（定时器与 drain 段调用）；没装写入函数（文件存储）时什么都不做。不抛 */
export function flushUsageDaily(): Promise<void> {
  const run = chain.then(flushOnce, flushOnce);
  chain = run.catch(() => undefined);
  return chain;
}

/**
 * db 存储装上之后由 store.ts 调：此后每 intervalMs（默认 30 秒）写一次；停机的 drain 段由 store.ts 另挂钩子调 flushUsageDaily。
 * 装上之前记下的用量（启动时建检索索引的 embedding）随第一次写入
 */
export function startUsageDaily(write: (deltas: UsageDailyDelta[]) => Promise<void>, intervalMs = 30_000): void {
  writer = write;
  arm(intervalMs);
}

let armedMs: number | null = null;
function arm(ms: number): void {
  if (timer) clearInterval(timer);
  armedMs = ms;
  timer = setInterval(() => void flushUsageDaily(), ms);
  timer.unref();
}

/** 仅供自测 */
export const __usageDailyTest = {
  /** 累加器里还没写进库的部分（金额是带小数的千分之一元） */
  pending(): (Omit<UsageDailyDelta, 'costMilliCny'> & { milli: number })[] {
    return [...acc.values()].map((a) => ({ ...a }));
  },
  /** 定时写入的间隔；还没装上写入函数为 null */
  intervalMs: (): number | null => (writer ? armedMs : null),
  /** 换一个间隔重新起定时器（写入函数不变）：自测里要排除定时写入插进来的那几段用 */
  rearm(ms: number): void {
    if (writer) arm(ms);
  },
};
