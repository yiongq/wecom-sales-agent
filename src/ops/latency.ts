import { configRuntime } from '../config/source.js';
import { withTenant } from '../db/client.js';
import { lockLatency, pauseLatency, readLatency, updateLatency, type LatencyState } from '../db/repo/ops-latency.js';
import { readOpsTenant, readReplyWindow, type ReplyWindow } from '../db/repo/ops-metrics.js';
import { opsTimeout } from '../db/repo/ops-reports.js';
import { withJobsTx } from '../store.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { alertReplyLatency } from './alert.js';
import { opsEnabled } from './ops-config.js';

/** UTC epoch 对齐；窗口结束额外满一分钟才有资格。 */
export const eligibleWindowEnd = (now: number): number => Math.floor((now - 60_000) / 300_000) * 300_000;
export function advanceLatency(
  old: LatencyState,
  end: number,
  sample: ReplyWindow | null,
  now: number,
): {
  state: LatencyState;
  notification: 'slow' | 'recovered' | null;
} {
  const adjacent = !old.paused && old.lastWindowEnd?.getTime() === end - 300_000;
  const state = {
    ...old,
    paused: false,
    lastWindowEnd: new Date(end),
    badStreak: adjacent ? old.badStreak : 0,
    goodStreak: adjacent ? old.goodStreak : 0,
    lastP90Ms: sample?.p90Ms == null ? null : Math.round(sample.p90Ms),
    lastSamples: sample?.samples ?? 0,
  };
  let notification: 'slow' | 'recovered' | null = null;
  if (!sample || sample.samples < 20 || sample.p90Ms === null) {
    state.badStreak = 0;
    state.goodStreak = 0;
  } else if (sample.p90Ms > 8000) {
    state.badStreak++;
    state.goodStreak = 0;
    if ((!state.active && state.badStreak >= 3) || (state.active && (!state.lastSentAt || now - state.lastSentAt.getTime() >= 1_800_000))) {
      state.active = true;
      state.lastSentAt = new Date(now);
      notification = 'slow';
    }
  } else {
    state.badStreak = 0;
    state.goodStreak = sample.p90Ms <= 6000 ? state.goodStreak + 1 : 0;
    if (state.active && state.goodStreak >= 2) {
      state.active = false;
      state.lastSentAt = new Date(now);
      notification = 'recovered';
    }
  }
  return { state, notification };
}

export async function checkLatency(now = Date.now()): Promise<void> {
  if (!opsEnabled('latency')) return;
  const end = eligibleWindowEnd(now);
  const suspended = await withJobsTx(async (tx) => {
    if ((await readOpsTenant(tx, currentRuntime().id)).status !== 'suspended') return false;
    await pauseLatency(tx);
    return true;
  });
  if (suspended) return;
  const previous = await withJobsTx((tx) => readLatency(tx));
  if (previous?.lastWindowEnd && previous.lastWindowEnd.getTime() >= end) return;
  const { db, tenantId } = configRuntime();
  let sample: ReplyWindow | null;
  try {
    sample = await withTenant(
      db,
      { tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } },
      async (tx) => {
        await opsTimeout(tx);
        return readReplyWindow(tx, end);
      },
      { readOnly: true },
    );
  } catch {
    sample = null;
  }
  const notification = await withJobsTx(async (tx) => {
    if ((await readOpsTenant(tx, currentRuntime().id)).status === 'suspended') {
      await pauseLatency(tx);
      return null;
    }
    const old = await lockLatency(tx);
    if (old.lastWindowEnd && old.lastWindowEnd.getTime() >= end) return null;
    const next = advanceLatency(old, end, sample, now);
    return (await updateLatency(tx, old, next.state)) ? next.notification : null;
  });
  if (notification)
    alertReplyLatency(
      `${notification === 'recovered' ? '回复延迟已恢复' : '回复延迟持续偏高'}：样本 ${sample!.samples}，p90 ${Math.round(sample!.p90Ms!)}ms`,
      notification === 'recovered',
      sample?.traceId ?? null,
    );
}
