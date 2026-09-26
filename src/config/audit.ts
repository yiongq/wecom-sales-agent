// 审计日志的读取（spec「后台 API 与页面 · 审计日志」）：分页，可按 action 过滤。只读事务，受 RLS 约束
import { withTenant, type TenantCtx } from '../db/client.js';
import { readAudit } from '../db/repo/audit.js';
import type { AuditPage } from '../shared/console-api.js';
import { configRuntime } from './source.js';

export async function listAudit(ctx: TenantCtx, q: { limit: number; before?: number; action?: string }): Promise<AuditPage> {
  const { db, tenantId } = configRuntime();
  if (ctx.tenantId !== tenantId) throw new Error('这个租户不是本进程装载的租户');
  const limit = Math.max(1, Math.min(100, Math.floor(q.limit)));
  // 多取一行判断还有没有下一页
  const rows = await withTenant(db, ctx, (tx) => readAudit(tx, { limit: limit + 1, beforeId: q.before, action: q.action }), {
    readOnly: true,
  });
  const items = rows.slice(0, limit).map((r) => ({ ...r, at: r.at.toISOString() }));
  return { items, nextBefore: rows.length > limit ? items[items.length - 1]!.id : null };
}
