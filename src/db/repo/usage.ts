// 用量（02 spec「逐轮 trace、护栏事件与用量」）：内存里按（天、模型、用途）累加，定时与停机时累加进 usage_daily
import { sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { usageDaily } from '../schema.js';

export type UsagePurpose = 'chat' | 'followup' | 'insight' | 'suggestion' | 'draft' | 'embedding';

export interface UsageDelta {
  /** 服务器时区的日期，'YYYY-MM-DD' */
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

const COUNTERS = ['calls', 'promptTokens', 'completionTokens', 'cachedTokens', 'reasoningTokens', 'costMilliCny'] as const;

/**
 * INSERT … ON CONFLICT DO UPDATE SET calls = usage_daily.calls + excluded.calls …。
 * 同一（天、模型、用途）出现多次时先在这里合并：一条语句里同一行冲突两次会报错
 */
export async function addUsage(tx: Tx, deltas: readonly UsageDelta[]): Promise<void> {
  const merged = new Map<string, UsageDelta>();
  for (const d of deltas) {
    const key = JSON.stringify([d.day, d.model, d.purpose]);
    const prev = merged.get(key);
    if (!prev) merged.set(key, { ...d });
    else for (const c of COUNTERS) prev[c] += d[c];
  }
  if (!merged.size) return;
  const { tenantId } = currentTenantCtx();
  await tx
    .insert(usageDaily)
    .values([...merged.values()].map((d) => ({ tenantId, ...d })))
    .onConflictDoUpdate({
      target: [usageDaily.tenantId, usageDaily.day, usageDaily.model, usageDaily.purpose],
      set: {
        calls: sql`${usageDaily.calls} + excluded.calls`,
        promptTokens: sql`${usageDaily.promptTokens} + excluded.prompt_tokens`,
        completionTokens: sql`${usageDaily.completionTokens} + excluded.completion_tokens`,
        cachedTokens: sql`${usageDaily.cachedTokens} + excluded.cached_tokens`,
        reasoningTokens: sql`${usageDaily.reasoningTokens} + excluded.reasoning_tokens`,
        costMilliCny: sql`${usageDaily.costMilliCny} + excluded.cost_milli_cny`,
      },
    });
}
