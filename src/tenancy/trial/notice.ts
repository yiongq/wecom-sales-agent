import { z } from 'zod';
import type { TenantRuntime } from '../runtime.js';

function trialAllowlist() {
  return z.array(
    z
      .object({
        tenantId: z.uuid(),
        slug: z.string().min(1),
        packId: z.literal('industrial'),
        kind: z.literal('standard'),
        isHost: z.literal(false),
      })
      .strict(),
  );
}

/** 私有服务端配置，与重置签收中的 allowlist 使用相同投影；缺失或损坏时不猜租户。 */
export function sharedTrial(rt: TenantRuntime, raw = process.env.TRIAL_TENANT_ALLOWLIST): boolean {
  if (!raw || rt.isHost || rt.kind !== 'standard' || rt.pack.runtime.id !== 'industrial') return false;
  try {
    const entries = trialAllowlist().parse(JSON.parse(raw));
    return entries.some((entry) => entry.tenantId === rt.id && entry.slug === rt.slug);
  } catch {
    return false;
  }
}
