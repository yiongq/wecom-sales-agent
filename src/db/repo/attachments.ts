// 12 R4：附件只在会话主事务写入；原件清理由受限的 DEFINER 函数执行。
import { and, asc, eq, getTableColumns, gte, lt, sql } from 'drizzle-orm';
import { numEnv } from '../../env.js';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { attachments } from '../schema.js';

export type AttachmentRow = Omit<typeof attachments.$inferSelect, 'tenantId' | 'bytes'> & { bytes: Uint8Array | null };
export type AttachmentMetadata = Omit<AttachmentRow, 'bytes'> & { stored: boolean };
/** 排队与 spill 的时间用毫秒；spill 时 bytes 必须置 null。会话 id 由写队列补齐。 */
export type AttachmentItem = Omit<AttachmentRow, 'conversationId' | 'createdAt'> & { createdAt: number };
export interface AttachmentResultWrite {
  id: string;
  intakeId: string | null;
  result: unknown | null;
}
export interface AttachmentUsage {
  count: number;
  /** 当日仍存着的原件字节数，元数据行不占原件预算。 */
  bytes: number;
}

/** 和 usage_daily 一样按服务器本地日历日；显式传边界，不依赖数据库连接的时区。 */
export function attachmentDayBounds(now = new Date()): [Date, Date] {
  return [new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)];
}
export function attachmentDailyBytesLimit(): number {
  return Math.max(0, Math.floor(numEnv('ATTACHMENT_DAILY_BYTES', 1024 ** 3)));
}
function metadataColumns() {
  const { tenantId: _tenantId, bytes: _bytes, ...columns } = getTableColumns(attachments);
  return { ...columns, stored: sql<boolean>`${attachments.bytes} is not null` };
}
export function readAttachment(tx: Tx, id: string, withBytes: true): Promise<AttachmentRow | null>;
export function readAttachment(tx: Tx, id: string, withBytes?: false): Promise<AttachmentMetadata | null>;
export async function readAttachment(tx: Tx, id: string, withBytes = false): Promise<AttachmentRow | AttachmentMetadata | null> {
  const where = and(eq(attachments.tenantId, currentTenantCtx().tenantId), eq(attachments.id, id));
  if (withBytes) {
    const { tenantId: _tenantId, ...columns } = getTableColumns(attachments);
    return (await tx.select(columns).from(attachments).where(where))[0] ?? null;
  }
  return (await tx.select(metadataColumns()).from(attachments).where(where))[0] ?? null;
}
export async function listAttachmentMetadata(tx: Tx, conversationId: string): Promise<AttachmentMetadata[]> {
  return tx
    .select(metadataColumns())
    .from(attachments)
    .where(and(eq(attachments.tenantId, currentTenantCtx().tenantId), eq(attachments.conversationId, conversationId)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
}
export async function readAttachmentUsage(tx: Tx, now = new Date()): Promise<AttachmentUsage> {
  const [start, end] = attachmentDayBounds(now);
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(octet_length(${attachments.bytes})), 0)`,
    })
    .from(attachments)
    .where(and(eq(attachments.tenantId, currentTenantCtx().tenantId), gte(attachments.createdAt, start), lt(attachments.createdAt, end)));
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}

/** 按租户串行判预算，去重的行不再扣预算；所有 SQL 都在调用者的会话事务里。 */
export async function insertAttachments(tx: Tx, conversationId: string, items: readonly AttachmentItem[]): Promise<void> {
  if (!items.length) return;
  const { tenantId } = currentTenantCtx();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attachment-bytes:${tenantId}`}, 0))`);
  const limit = attachmentDailyBytesLimit();
  for (const item of items) {
    const createdAt = new Date(item.createdAt);
    const usage = await readAttachmentUsage(tx, createdAt);
    const bytes = item.bytes !== null && usage.bytes + item.bytes.byteLength <= limit ? Buffer.from(item.bytes) : null;
    await tx
      .insert(attachments)
      .values({ ...item, tenantId, conversationId, createdAt, bytes })
      .onConflictDoNothing();
  }
}
export async function writeAttachmentResult(tx: Tx, conversationId: string, write: AttachmentResultWrite): Promise<void> {
  await tx
    .update(attachments)
    .set({ intakeId: write.intakeId, result: write.result })
    .where(
      and(
        eq(attachments.tenantId, currentTenantCtx().tenantId),
        eq(attachments.conversationId, conversationId),
        eq(attachments.id, write.id),
      ),
    );
}
export async function purgeAttachmentBytes(tx: Tx, now: Date): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`select purge_attachment_bytes(${currentTenantCtx().tenantId}::uuid, ${now.toISOString()}::timestamptz) as n`),
  );
  return row?.n ?? 0;
}
