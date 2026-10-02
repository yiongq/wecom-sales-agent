// 企微发送账本（02 spec「企微：发送账本、回执与去重」）：账本在内存里，落库时写行；收到 msg_send_fail 按 msgid 改状态
import { eq } from 'drizzle-orm';
import type { OutboundKind } from '../../shared/conversation-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { outboundSends } from '../schema.js';

export type OutboundStatus = 'accepted' | 'rejected' | 'unknown' | 'failed';

export interface OutboundSendRow {
  conversationId: string;
  /** 我们生成、随 send_msg 下发；同一分段重试沿用 */
  channelMsgid: string;
  /** 对应的会话消息；欢迎语、同意菜单为 null */
  messageSeq: number | null;
  kind: OutboundKind;
  sentAt: Date;
  status: OutboundStatus;
  errcode: number | null;
  failType: number | null;
}

export async function insertOutboundSends(tx: Tx, rows: readonly OutboundSendRow[]): Promise<void> {
  if (!rows.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.insert(outboundSends).values(rows.map((r) => ({ tenantId, ...r })));
}

/** 按 msgid 改状态（回执）；errcode、failType 不给就不动。返回是否找到了这一行 */
export async function setOutboundStatus(
  tx: Tx,
  channelMsgid: string,
  status: OutboundStatus,
  opts: { errcode?: number | null; failType?: number | null } = {},
): Promise<boolean> {
  const out = await tx
    .update(outboundSends)
    .set({
      status,
      ...(opts.errcode !== undefined ? { errcode: opts.errcode } : {}),
      ...(opts.failType !== undefined ? { failType: opts.failType } : {}),
    })
    .where(eq(outboundSends.channelMsgid, channelMsgid))
    .returning({ id: outboundSends.id });
  return out.length === 1;
}
