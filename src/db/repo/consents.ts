// 敏感信息同意记录（02 spec「隐私说明、敏感信息同意、保留期与行权」）：只追加，随会话落库写；会话被清除时级联删掉
import { currentTenantCtx, type Tx } from '../client.js';
import { consents } from '../schema.js';

export interface ConsentRow {
  conversationId: string;
  category: 'health' | 'minor';
  decision: 'asked' | 'granted' | 'declined' | 'withdrawn';
  noticeVersion: number;
  /** 企微菜单的 menu_id 或客户原话，≤200 字 */
  evidence: string | null;
  at: Date;
}

export async function appendConsents(tx: Tx, rows: readonly ConsentRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.insert(consents).values(rows.map((r) => ({ tenantId, ...r })));
}
