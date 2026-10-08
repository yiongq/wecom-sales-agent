// 压测要量的几个数字：事件循环延迟、落库延迟、百分位。不碰产品代码，只用 store.ts 已经导出的只读钩子
// （onSessionSaved、onCommitted）在外部旁听。
import { onCommitted, onSessionSaved, type DomainEvent } from '../../src/store.js';

export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** 每隔 intervalMs 排一个 setTimeout，实际触发比预期晚了多少毫秒，就是这一刻的事件循环延迟 */
export function startEventLoopLagSampler(intervalMs = 50): { samples: number[]; stop(): void } {
  const samples: number[] = [];
  let stopped = false;
  let expected = Date.now() + intervalMs;
  let timer: NodeJS.Timeout;
  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    samples.push(Math.max(0, now - expected));
    expected = now + intervalMs;
    timer = setTimeout(tick, intervalMs);
    timer.unref();
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref();
  return {
    samples,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * 旁听「这个会话有改动排队」到「这次改动提交」的墙钟间隔（db 存储的真实会话落库延迟，02 spec 验收 30）。
 * onSessionSaved 在 saveSession 内同步触发（改动刚排进写队列）；onCommitted 的 conversation.changed
 * 在提交之后触发——同一个会话在两次提交之间可能被 saveSession 多次，按「这次提交覆盖了从上次提交以来
 * 最早的一次排队」取时间差，与 pg-backend 的「每会话写队列合并」口径一致。
 */
export function startWriteLatencySampler(): { samples: number[]; stop(): void } {
  const samples: number[] = [];
  const pending = new Map<string, number[]>();
  const offSaved = onSessionSaved((s) => {
    const list = pending.get(s.id) ?? [];
    list.push(Date.now());
    pending.set(s.id, list);
  });
  const offCommitted = onCommitted((ev: DomainEvent) => {
    if (ev.type !== 'conversation.changed') return;
    const list = pending.get(ev.id);
    if (!list || !list.length) return;
    const first = list[0]!;
    samples.push(Math.max(0, Date.now() - first));
    pending.delete(ev.id);
  });
  return {
    samples,
    stop() {
      offSaved();
      offCommitted();
    },
  };
}

export function fmtMs(n: number): string {
  return `${Math.round(n)}ms`;
}
