// 05 第 6 步先提供 standard 的接口；第 10、20 步接记账与沙箱预占。
import type { UsagePurpose } from '../db/repo/usage.js';
export interface Reservation {
  settle(actualMilli: number | null): void;
}
export interface TenantBudget {
  reserve(purpose: UsagePurpose, estimateMilli: number): Reservation | null;
  status(): { calls: number; costMilli: number; capCalls: number | null; capMilli: number | null };
}
export function createStandardBudget(): TenantBudget {
  return {
    reserve: () => ({ settle() {} }),
    status: () => ({ calls: 0, costMilli: 0, capCalls: null, capMilli: null }),
  };
}
