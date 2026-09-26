// 审计（spec「审计」）：只追加。租户与操作者从 withTenant 的上下文取，调用方只给动作和内容
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { auditLog } from '../schema.js';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  diff?: unknown;
}

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const { tenantId, actor } = currentTenantCtx();
  await tx.insert(auditLog).values({
    tenantId,
    actorUserId: actor.userId,
    actorName: actor.name,
    actorKind: actor.kind,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    diff: entry.diff ?? null,
    ip: actor.ip,
  });
}

export interface AuditRow {
  id: number;
  at: Date;
  actorKind: 'user' | 'system' | 'platform';
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  diff: unknown;
}

/** 本租户的审计，按 id 倒序（走 audit_log_by_tenant）；beforeId 翻页，action 精确过滤 */
export async function readAudit(tx: Tx, q: { limit: number; beforeId?: number; action?: string }): Promise<AuditRow[]> {
  const where: SQL[] = [];
  if (q.beforeId !== undefined) where.push(lt(auditLog.id, q.beforeId));
  if (q.action !== undefined) where.push(eq(auditLog.action, q.action));
  return tx
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorKind: auditLog.actorKind,
      actorName: auditLog.actorName,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      diff: auditLog.diff,
    })
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.id))
    .limit(q.limit);
}
