// 05「界面」：只认开通后的操作，种子不算完成；从持久化数据读，不增加进程缓存。
import { sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import type { Me } from '../../shared/console-api.js';
import type { IndustryPack } from '../../shared/pack.js';

export async function readSandboxSteps(tx: Tx, pack: IndustryPack): Promise<NonNullable<Me['sandbox']>['steps']> {
  const tenantId = currentTenantCtx().tenantId;
  const [row] = rowsOf<{ chat: boolean; quote: boolean; human: boolean }>(
    await tx.execute(sql`
      select
        exists (select 1 from messages a join messages c
          on c.tenant_id = a.tenant_id and c.conversation_id = a.conversation_id and c.seq < a.seq
          where a.tenant_id = t.id and a.role = 'agent' and (a.author is null or a.author = 'ai') and a.at >= t.created_at
            and c.role = 'customer' and c.at >= t.created_at) as chat,
        exists (select 1 from turn_traces tr, json_array_elements(tr.calls) call
          where tr.tenant_id = t.id and tr.started_at >= t.created_at
            and call->>'name' in ('create_quote', 'generate_proposal')
            and call->>'resultHead' ~ '"total"[[:space:]]*:[[:space:]]*[0-9]+') as quote,
        exists (select 1 from messages m where m.tenant_id = t.id
          and m.author = 'human' and m.author_user_id is not null and m.at >= t.created_at) as human
      from tenants t where t.id = ${tenantId} and t.kind = 'sandbox'
    `),
  );
  const audits = rowsOf<{ action: string; target_type: string | null; diff: Record<string, unknown> | null }>(
    await tx.execute(sql`select action, target_type, diff from audit_log
      where tenant_id = ${tenantId} and actor_kind = 'user'
        and action in ('catalog.update', 'catalog.locked_fix', 'order.mark_paid', 'sop.publish')`),
  );
  const changed = audits.some((a) => {
    if (a.action === 'order.mark_paid' || a.action === 'sop.publish') return true;
    const entity = pack.entities.find((e) => e.kind === a.target_type);
    return (
      entity?.fields.some((f) => {
        if (!f.reprices) return false;
        const [key, ...path] = f.key.split('.');
        const pair = a.diff?.[key!];
        if (!Array.isArray(pair) || pair.length !== 2) return false;
        const value = (v: unknown): unknown =>
          path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v);
        return JSON.stringify(value(pair[0])) !== JSON.stringify(value(pair[1]));
      }) ?? false
    );
  });
  return [row?.chat ?? false, row?.quote ?? false, row?.human ?? false, changed];
}
