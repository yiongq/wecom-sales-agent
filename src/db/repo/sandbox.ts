// 05 R9：模板只读快照与新沙箱的附属行；所有 SQL 留在数据库层。
import { and, eq, sql } from 'drizzle-orm';
import { currentTenantCtx, withTenant, rowsOf, pgErrorOf, type Db, type Tx } from '../client.js';
import { sandboxWechat, tenants } from '../schema.js';
import { readPublishedSop } from './sop.js';
import { readActiveCatalog } from './catalog.js';
import { listQuickReplies } from './quick-replies.js';
import { readLatestPrivacyNotice } from './privacy.js';
import { readKbSnapshot } from './kb.js';

export async function readSandboxTemplate(db: Db, slug: string) {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.kind, 'standard')));
  if (!tenant) throw new Error('sandbox_template_invalid');
  return withTenant(
    db,
    {
      tenantId: tenant.id,
      actor: { kind: 'system', userId: null, name: null, ip: null },
    },
    async (tx) => {
      const pub = await readPublishedSop(tx);
      if (!pub) throw new Error('no_published_sop');
      const items = await readActiveCatalog(tx);
      const replies = await listQuickReplies(tx);
      const privacy = await readLatestPrivacyNotice(tx);
      // 07 R13：宿主的线路块与向量在同一个只读快照里读出来，开通时原样复制，沙箱装载时不用再发嵌入请求
      const kb = await readKbSnapshot(tx);
      return { tenantId: tenant.id, pub, items, replies, privacy, kb };
    },
    { isolation: 'repeatable read', readOnly: true },
  );
}

export async function insertSandboxWechat(tx: Tx, linkToken: string): Promise<void> {
  const { tenantId } = currentTenantCtx();
  await tx.insert(sandboxWechat).values({ tenantId, linkToken });
}

/** 只通过受限 DEFINER 函数写入第一版，agent_app 没有隐私说明表的 INSERT 权限。 */
export async function seedSandboxPrivacy(tx: Tx, body: string): Promise<void> {
  const { tenantId } = currentTenantCtx();
  await tx.execute(sql`select public.sandbox_privacy_seed(${tenantId}::uuid, ${body})`);
}

export type SandboxSessionRow = { status: 'invalid' | 'expired' } | { status: 'ok'; tenantId: string; userId: string; expiresAt: string };

export async function sandboxSessionResolve(db: Db, tokenHash: Buffer): Promise<SandboxSessionRow> {
  try {
    const [r] = rowsOf<{ o_status: 'ok' | 'expired' | 'invalid'; o_tenant: string; o_user: string; o_expires_at: Date | string }>(
      await db.execute(sql`select * from public.sandbox_session_resolve(${tokenHash})`),
    );
    if (!r) return { status: 'invalid' };
    if (r.o_status !== 'ok') return { status: r.o_status };
    return { status: 'ok', tenantId: r.o_tenant, userId: r.o_user, expiresAt: new Date(r.o_expires_at).toISOString() };
  } catch (error) {
    // 0008 按 R7 拒绝 standard token；HTTP 解析契约按 R10 统一为 invalid。
    if (pgErrorOf(error).code === '22023') return { status: 'invalid' };
    throw error;
  }
}

/** R21：只在租户作用域中读取链接令牌；不向任何公开投影交出。 */
export async function readSandboxLink(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ token: sandboxWechat.linkToken }).from(sandboxWechat);
  return row?.token ?? null;
}
