// 14 R7：每租户、每会话的滑动窗口；关闭时不分配桶或会话状态。
import { currentRuntime } from './runtime.js';
import { scopedState } from './scoped-state.js';
import { registerTenantState } from './state.js';

interface Window {
  minute: number[];
  hour: number[];
  warnedAt: number | null;
}
const tenantState = scopedState(() => ({ conversations: new Map<string, Window>() }));
registerTenantState({ name: 'customerRate.conversations', ...tenantState.registration('conversations') });
const cap = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export function customerRate(sessionId: string, channel: string, now = Date.now()): 'ok' | 'warn' | 'silent' {
  const perMin = cap(process.env.CUSTOMER_RATE_PER_MIN);
  const perHour = cap(process.env.CUSTOMER_RATE_PER_HOUR);
  if (!perMin && !perHour) return 'ok';
  const rt = currentRuntime();
  if (rt.kind !== 'standard' || !rt.config.loaded || !rt.store.pgBackend || (channel !== 'wecom' && channel !== 'web')) return 'ok';
  const entries = tenantState.get().conversations;
  const entry = entries.get(sessionId) ?? { minute: [], hour: [], warnedAt: null };
  // Map 的顺序是最近活动顺序；只有 10 万个会话，各窗口只存判断所需的最后 cap 次。
  entries.delete(sessionId);
  entries.set(sessionId, entry);
  if (entries.size > 100_000) entries.delete(entries.keys().next().value!);
  const record = (times: number[], windowMs: number, limit: number): boolean => {
    if (!limit) return false;
    while (times.length && times[0]! <= now - windowMs) times.shift();
    const blocked = times.length >= limit;
    if (blocked) times.shift();
    times.push(now);
    return blocked;
  };
  const minute = record(entry.minute, 60_000, perMin);
  const hour = record(entry.hour, 3600_000, perHour);
  if (!minute && !hour) return 'ok';
  if (entry.warnedAt !== null && now - entry.warnedAt < 600_000) return 'silent';
  entry.warnedAt = now;
  return 'warn';
}
