import { currentRuntime, tenantRuntimes } from '../tenancy/runtime.js';

// 只记已校验配置的签名；运行时集合改变时重新核验，不保存租户业务状态。
let validated = '';
export function opsEnabled(kind: 'digest' | 'latency'): boolean {
  const all = tenantRuntimes();
  const values = [process.env.OPS_DIGEST_TENANTS ?? '', process.env.OPS_LATENCY_TENANTS ?? ''];
  const signature = JSON.stringify([values, all.map((r) => [r.id, r.slug, r.kind])]);
  if (signature !== validated) {
    validated = signature;
    for (const [index, raw] of values.entries()) {
      for (const slug of new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )) {
        if (!all.some((r) => r.slug === slug && r.kind === 'standard'))
          console.error(`[ops] ${index ? 'OPS_LATENCY_TENANTS' : 'OPS_DIGEST_TENANTS'} 包含无效项，已跳过`);
      }
    }
  }
  const rt = currentRuntime();
  return rt.kind === 'standard' && values[kind === 'digest' ? 0 : 1]!.split(',').some((s) => s.trim() === rt.slug);
}
