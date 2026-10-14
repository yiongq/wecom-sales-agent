// R22：每次读写都在所属沙箱的 RLS 事务里；写之前持有 epoch 的 FOR SHARE。
import { sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';

export interface SandboxWechatRow {
  linkToken: string;
  codeHash: string | null;
  codeExpiresAt: Date | string | null;
  externalUserid: string | null;
  boundAt: string | null;
}
export async function readSandboxWechat(tx: Tx): Promise<SandboxWechatRow | undefined> {
  return rowsOf<SandboxWechatRow>(
    await tx.execute(sql`select link_token as "linkToken",
    encode(code_hash, 'hex') as "codeHash", code_expires_at as "codeExpiresAt",
    external_userid as "externalUserid", (extract(epoch from bound_at) * 1000000)::bigint::text as "boundAt" from sandbox_wechat`),
  )[0];
}
export async function issueSandboxWechatCode(tx: Tx, hash: string): Promise<Date> {
  const [row] = rowsOf<{ expiresAt: Date | string }>(
    await tx.execute(sql`update sandbox_wechat
    set code_hash = decode(${hash}, 'hex'), code_expires_at = now() + interval '10 minutes'
    where tenant_id = ${currentTenantCtx().tenantId} returning code_expires_at as "expiresAt"`),
  );
  if (!row) throw new Error('sandbox_wechat_missing');
  return new Date(row.expiresAt);
}
export async function clearSandboxWechat(tx: Tx): Promise<void> {
  await tx.execute(sql`update sandbox_wechat set external_userid = null, bound_at = null
    where tenant_id = ${currentTenantCtx().tenantId}`);
}
export async function bindSandboxWechat(tx: Tx, hash: string, user: string): Promise<string | undefined> {
  return rowsOf<{ boundAt: string }>(
    await tx.execute(sql`update sandbox_wechat
    set external_userid = ${user}, bound_at = clock_timestamp(), code_hash = null, code_expires_at = null
    where tenant_id = ${currentTenantCtx().tenantId} and code_hash = decode(${hash}, 'hex')
      and code_expires_at > clock_timestamp()
      returning (extract(epoch from bound_at) * 1000000)::bigint::text as "boundAt"`),
  )[0]?.boundAt;
}
