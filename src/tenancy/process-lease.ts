// 18 R3：宿主共享锁连接的进程闸；epoch 按租户保存，失锁与过期影响整个宿主。
import { randomUUID } from 'node:crypto';
import { registerTenantState } from './state.js';

export const processHolder = randomUUID();
const epochs = new Map<string, bigint>();
const listeners = new Set<() => void>();
const waiters = new Map<string, Set<(active: boolean) => void>>();
let acquired = false;
let held = false;
let stale = false;
let stopping = false;
let finalized = false;
let exitStale: (() => void) | undefined;

export const processLeaseEnabled = (): boolean => process.env.TENANT_LOCK_WAIT === 'forever' && process.env.APP_ROLE !== 'sandbox';
export const processLeaseWaiting = (): boolean => processLeaseEnabled() && !acquired;
export const processLeaseStale = (): boolean => processLeaseEnabled() && stale;
export const processLeaseHeld = (): boolean => !processLeaseEnabled() || (held && !stale);
export const processLeaseFinalized = (): boolean => processLeaseEnabled() && finalized;
export const processEpoch = (tenantId: string): bigint | undefined => epochs.get(tenantId);

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      console.error('[failover] 进程锁状态订阅异常');
    }
  }
  if (held || stale || stopping) {
    for (const pending of waiters.values()) for (const resolve of pending) resolve(held && !stale);
    waiters.clear();
  }
}
export function onProcessLeaseChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function acquireProcessLease(onStale: () => void): void {
  acquired = true;
  held = true;
  exitStale = onStale;
}
export function rememberProcessEpoch(tenantId: string, epoch: bigint): void {
  epochs.set(tenantId, epoch);
}
export function loseProcessLease(): void {
  held = false;
  notify();
}
export function resumeProcessLease(): void {
  if (stale || stopping) return;
  held = true;
  notify();
}
/** 正常停机只解除暂停中的等待；仍持锁的在途发送继续服从原停机截止。 */
export function stopProcessLeaseWaits(): void {
  if (!processLeaseEnabled()) return;
  stopping = true;
  notify();
}
/** 最终 spill 完成后禁止再写、再发；随后才允许释放 advisory lock。 */
export function finalizeProcessLease(): void {
  finalized = true;
  held = false;
  stopProcessLeaseWaits();
}
export function staleProcessLease(): void {
  if (stale) return;
  stale = true;
  held = false;
  console.error('[failover] process_epoch_stale：停止拉取、新轮次与发送，优雅退出');
  notify();
  if (!stopping) exitStale?.();
}
export class ProcessEpochStale extends Error {
  readonly code = 'process_epoch_stale';
  constructor() {
    super('process_epoch_stale');
  }
}
export class ProcessLeaseUnavailable extends Error {
  readonly code = 'process_lock_lost';
  constructor() {
    super('process_lock_lost');
  }
}
export const isProcessLeaseError = (error: unknown): boolean =>
  error instanceof ProcessLeaseUnavailable || error instanceof ProcessEpochStale;
export function assertProcessLeaseHeld(): void {
  if (processLeaseStale()) throw new ProcessEpochStale();
  if (!processLeaseHeld()) throw new ProcessLeaseUnavailable();
}

/** 排队但尚未开轮次的消息等待恢复；过期后留给新主的启动恢复。 */
export function waitForProcessLease(tenantId: string): Promise<boolean> {
  if (processLeaseHeld()) return Promise.resolve(true);
  if (processLeaseStale() || stopping) return Promise.resolve(false);
  return new Promise((resolve) => {
    const pending = waiters.get(tenantId) ?? new Set<(active: boolean) => void>();
    pending.add(resolve);
    waiters.set(tenantId, pending);
  });
}

registerTenantState({
  name: 'processLease.waiters',
  keyCount: (id) => waiters.get(id)?.size ?? 0,
  drop: (id) => {
    for (const resolve of waiters.get(id) ?? []) resolve(false);
    waiters.delete(id);
  },
  reset: () => {
    for (const pending of waiters.values()) for (const resolve of pending) resolve(false);
    waiters.clear();
  },
});

registerTenantState({
  name: 'processLease.epochs',
  keyCount: (id) => Number(epochs.has(id)),
  drop: (id) => {
    epochs.delete(id);
  },
  reset: () => {
    epochs.clear();
  },
});
