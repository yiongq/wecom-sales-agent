// 15：设置专用白名单投影。成员只经受限函数；渠道 SQL 不读取标识、密文或凭据。
import { sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import type { ChannelView, MemberView, OrganizationView } from '../../shared/console-api.js';
import type { BrandProfile } from '../../core/pack-api.js';

export async function readConsoleMembers(tx: Tx, tokenHash: string): Promise<MemberView[]> {
  const { tenantId } = currentTenantCtx();
  const rows = rowsOf<{ user_id: string; display_name: string; email: string; role: MemberView['role']; disabled: boolean }>(
    await tx.execute(sql`select * from public.console_members_read(${tenantId}::uuid, ${tokenHash})`),
  );
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email, role: r.role, disabled: r.disabled }));
}

export async function readConsoleOrganization(
  tx: Tx,
): Promise<{ view: Omit<OrganizationView, 'publishedBrandName' | 'pendingBrandChange'>; brand: BrandProfile | null }> {
  const { tenantId } = currentTenantCtx();
  const [r] = rowsOf<{ name: string; slug: string; pack_id: string; status: OrganizationView['status']; brand: BrandProfile | null }>(
    await tx.execute(sql`select name,slug,pack_id,status,brand from tenants where id=${tenantId}::uuid`),
  );
  if (!r) throw new Error('settings_tenant_missing');
  return { view: { name: r.name, slug: r.slug, packId: r.pack_id, status: r.status }, brand: r.brand };
}

export async function readConsoleChannels(tx: Tx): Promise<ChannelView[]> {
  const rows = rowsOf<{ id: string; key: string; name: string; kind: string; enabled: boolean; configured: boolean }>(
    await tx.execute(sql`select id,key,name,kind,status='active' as enabled,
      (kind='wecom_kf' and secrets_ct is not null and secrets_key_id is not null and corp_id is not null and open_kfid is not null) as configured
      from channel_accounts order by created_at,key`),
  );
  return rows.map((r) => ({
    accountId: r.id,
    key: r.key,
    name: r.name,
    kind: r.kind === 'wecom_kf' ? 'wecom' : 'web',
    source: 'db',
    enabled: r.enabled,
    loaded: false,
    blockedByProfile: false,
    credentialsConfigured: r.configured,
    callbackPath: r.kind === 'wecom_kf' ? `/wecom/callback/${encodeURIComponent(r.key)}` : null,
    lastInboundAt: null,
  }));
}

/** 已持久化的客户消息才算入站；握手、拉取 cursor、种子及页面点击均不算。 */
export async function readConsoleInbound(tx: Tx): Promise<Map<string | null, string>> {
  const rows = rowsOf<{ account_id: string | null; at: string | Date }>(
    await tx.execute(sql`
    select c.channel_account_id as account_id,max(m.at) as at from conversations c join messages m
    on m.tenant_id=c.tenant_id and m.conversation_id=c.id
    where c.channel='wecom' and m.role='customer' group by c.channel_account_id`),
  );
  return new Map(rows.map((r) => [r.account_id, new Date(r.at).toISOString()]));
}
