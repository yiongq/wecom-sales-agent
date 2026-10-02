// 隐私说明（02 spec「隐私说明、敏感信息同意、保留期与行权」）：平台发布新版本（agent_platform 有 INSERT），应用只读最新一版
import { desc, sql } from 'drizzle-orm';
import { currentTenantCtx, type Tx } from '../client.js';
import { privacyNotices } from '../schema.js';

export interface PrivacyNoticeRow {
  version: number;
  body: string;
  publishedAt: Date;
  publishedByName: string | null;
}

const columns = {
  version: privacyNotices.version,
  body: privacyNotices.body,
  publishedAt: privacyNotices.publishedAt,
  publishedByName: privacyNotices.publishedByName,
};

/** 发布：版本号是本租户已有的最大版本加 1（第一版是 1） */
export async function publishPrivacyNotice(tx: Tx, n: { body: string; publishedByName: string | null }): Promise<PrivacyNoticeRow> {
  const { tenantId } = currentTenantCtx();
  const [max] = await tx.select({ v: sql<number>`coalesce(max(${privacyNotices.version}), 0)::int` }).from(privacyNotices);
  const [row] = await tx
    .insert(privacyNotices)
    .values({ tenantId, version: (max?.v ?? 0) + 1, body: n.body, publishedByName: n.publishedByName })
    .returning(columns);
  return row!;
}

/** 最新一版；没发布过返回 null */
export async function readLatestPrivacyNotice(tx: Tx): Promise<PrivacyNoticeRow | null> {
  const [row] = await tx.select(columns).from(privacyNotices).orderBy(desc(privacyNotices.version)).limit(1);
  return row ?? null;
}
