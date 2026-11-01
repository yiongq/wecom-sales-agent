// 14 R8：平台命令只改一个已授权的列；租户锁与原子审计由调用方持有。
import { eq } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { tenants } from '../schema.js';

export async function updateTenantBudgetLimits(
  tx: Tx,
  tenantId: string,
  patch: { monthlyReplyQuota?: number | null; llmDailyCapMilli?: number | null; status?: 'active' | 'trial' | 'suspended' },
): Promise<void> {
  await tx.update(tenants).set(patch).where(eq(tenants.id, tenantId));
}
