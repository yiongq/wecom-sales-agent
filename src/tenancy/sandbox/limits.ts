// 05 R14：开通计数归进程，写速率 / SSE 归租户；持久化数量由持写锁的调用方传入。
import { isIP } from 'node:net';
import { scopedRuntime } from '../runtime.js';
import { scopedState } from '../scoped-state.js';
import { registerTenantState } from '../state.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WRITE_DEFAULTS = Object.freeze({
  requestsPerMinute: 30,
  catalogItems: 80,
  versionsPerItem: 20,
  importRows: 80,
  sopPublishesPerDay: 20,
  quickReplies: 50,
});
export type SandboxWriteLimits = { -readonly [K in keyof typeof WRITE_DEFAULTS]: number };

export class SandboxLimitError extends Error {
  readonly status = 429;
  constructor(
    readonly reason: 'sandbox_limited' | 'sandbox_write_limited',
    readonly retryAfter = 60,
  ) {
    super(reason);
  }
}

function limit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('sandbox_limits_invalid');
  return value;
}

/** SANDBOX_WRITE_LIMITS 是 JSON 对象，省略的字段沿用开放问题 8 默认值。 */
export function sandboxWriteLimits(env: NodeJS.ProcessEnv = process.env): SandboxWriteLimits {
  if (!env.SANDBOX_WRITE_LIMITS) return WRITE_DEFAULTS;
  let input: unknown;
  try {
    input = JSON.parse(env.SANDBOX_WRITE_LIMITS);
  } catch {
    throw new Error('sandbox_limits_invalid');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('sandbox_limits_invalid');
  const out: SandboxWriteLimits = { ...WRITE_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(out, key) || !Number.isSafeInteger(value) || typeof value !== 'number' || value < 1)
      throw new Error('sandbox_limits_invalid');
    out[key as keyof SandboxWriteLimits] = value;
  }
  return out;
}

/** 规范化 IPv4（含 IPv4-mapped IPv6），IPv6 展开后只取前 64 位。 */
export function sandboxIpKey(ip: string | null): string {
  const address = (ip ?? '').replace(/%.*$/, '');
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return 'unknown';
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = host.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b];
  if (words.slice(0, 5).every((w) => Number.parseInt(w, 16) === 0) && words[5] === 'ffff') {
    const hi = Number.parseInt(words[6]!, 16);
    const lo = Number.parseInt(words[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return words
    .slice(0, 4)
    .map((w) => Number.parseInt(w, 16).toString(16).padStart(4, '0'))
    .join(':');
}

// 只记录已提交的开通。数量被全局开通上限约束，按日主动淘汰，不为被拒请求建键。
const provisioned: { at: number; day: string; ip: string }[] = [];
export function assertSandboxProvisionAllowed(
  input: { live: number; provisioned: number; day: string; ip: string | null },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): void {
  for (let i = provisioned.length - 1; i >= 0; i--)
    if (provisioned[i]!.day !== input.day && now - provisioned[i]!.at >= HOUR) provisioned.splice(i, 1);
  const hourly = provisioned.filter((p) => now - p.at < HOUR);
  const ip = sandboxIpKey(input.ip);
  const dailyIp = provisioned.filter((p) => p.day === input.day && p.ip === ip);
  if (input.live >= limit(env, 'SANDBOX_MAX_LIVE', 20)) throw new SandboxLimitError('sandbox_limited');
  if (input.provisioned >= limit(env, 'SANDBOX_PER_DAY', 50)) throw new SandboxLimitError('sandbox_limited', DAY / 1000);
  if (hourly.length >= limit(env, 'SANDBOX_PER_HOUR', 10))
    throw new SandboxLimitError('sandbox_limited', Math.max(1, Math.ceil((hourly[0]!.at + HOUR - now) / 1000)));
  if (dailyIp.length >= limit(env, 'SANDBOX_PER_IP_DAY', 3)) throw new SandboxLimitError('sandbox_limited', DAY / 1000);
}
export function recordSandboxProvision(ip: string | null, day: string, now = Date.now()): void {
  provisioned.push({ at: now, day, ip: sandboxIpKey(ip) });
}

const tenantState = scopedState(() => ({ writes: [] as number[], streams: new Set<() => void>() }), {
  streams: (streams) => {
    for (const close of streams) close();
  },
});
registerTenantState({ name: 'sandbox.limits.writes', ...tenantState.registration('writes') });
registerTenantState({ name: 'sandbox.limits.streams', ...tenantState.registration('streams') });

export function assertSandboxWriteRate(now = Date.now()): void {
  if (scopedRuntime()?.kind !== 'sandbox') return;
  const state = tenantState.get();
  state.writes = state.writes.filter((at) => now - at < 60_000);
  if (state.writes.length >= sandboxWriteLimits().requestsPerMinute)
    throw new SandboxLimitError('sandbox_write_limited', Math.max(1, Math.ceil((state.writes[0]! + 60_000 - now) / 1000)));
  state.writes.push(now);
}

/** 必须在相应写锁内调用；无内容变化的更新不产生版本，也不占版本名额。 */
export function assertSandboxWriteCapacity(kind: Exclude<keyof SandboxWriteLimits, 'requestsPerMinute'>, count: number, add = 1): void {
  if (scopedRuntime()?.kind === 'sandbox' && count + add > sandboxWriteLimits()[kind]) throw new SandboxLimitError('sandbox_write_limited');
}

/** 种子的 createdAt 在开通前；重启后仍按同一持久化字段排除，不依赖内存基线。 */
export function assertSandboxNewConversation(sessions: Iterable<{ createdAt: number }>): void {
  const rt = scopedRuntime();
  if (rt?.kind !== 'sandbox') return;
  const createdAt = rt.expiresAt! - DAY;
  let count = 0;
  for (const s of sessions) if (s.createdAt >= createdAt) count++;
  if (count >= limit(process.env, 'SANDBOX_MAX_CONVERSATIONS', 30)) throw new SandboxLimitError('sandbox_limited');
}

/** 在响应成为 SSE 前同步占名额；释放幂等，drop 同时关闭连接。 */
export function claimSandboxStream(close: () => void): () => void {
  if (scopedRuntime()?.kind !== 'sandbox') return () => {};
  const streams = tenantState.get().streams;
  if (streams.size >= 10) throw new SandboxLimitError('sandbox_limited');
  streams.add(close);
  return () => {
    streams.delete(close);
  };
}

export const __sandboxLimitsTest = Object.freeze({
  dropTenantLimits: (id: string) => {
    tenantState.registration('writes').drop(id);
    tenantState.registration('streams').drop(id);
  },
  resetProvisioned: () => {
    provisioned.length = 0;
  },
});
