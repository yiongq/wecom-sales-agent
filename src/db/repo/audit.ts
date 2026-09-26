// 审计（spec「审计」）：只追加。租户与操作者从 withTenant 的上下文取，调用方只给动作和内容
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
