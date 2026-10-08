// 设置租户的保留期（02 spec「隐私说明、敏感信息同意、保留期与行权」，开放问题 2）。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/tenant-retention.ts --tenant <slug> [--lead <天>] [--customer <天>] [--trace <天>]
// 三个都可改、可省（省的不动）；至少给一个。范围 7–3650（CHECK 约束兜底，这里先校验给出更明白的错）。
// tenants 不带 RLS，agent_platform 的 UPDATE 只给这三列（列级授权），不经 withTenant；写一行 platform.tenant_retention 审计
// （带 withTenant，audit_log 有 RLS），diff 是改前改后的三个值。
// 退出码：0 成功；1 其他错误（租户不存在、天数不在范围内、一个都没给）
import { withTenant } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, readRetention, updateRetention } from '../db/repo/tenants.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'tenant-retention --tenant <slug> [--lead <天>] [--customer <天>] [--trace <天>]';
const MIN_DAYS = 7;
const MAX_DAYS = 3650;

function parseDays(raw: string | undefined, flag: string, usage: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    console.error(`${flag} 要是 ${MIN_DAYS}–${MAX_DAYS} 之间的整数\n用法：${usage}`);
    process.exit(1);
  }
  return n;
}

main(async () => {
  const a = args({ tenant: { type: 'string' }, lead: { type: 'string' }, customer: { type: 'string' }, trace: { type: 'string' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const leadDays = parseDays(a.lead, '--lead', USAGE);
  const customerDays = parseDays(a.customer, '--customer', USAGE);
  const traceDays = parseDays(a.trace, '--trace', USAGE);
  if (leadDays === undefined && customerDays === undefined && traceDays === undefined) {
    console.error(`至少给一个 --lead / --customer / --trace\n用法：${USAGE}`);
    return 1;
  }
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const tenant = await findTenantBySlug(db, tenantSlug);
    if (!tenant) {
      console.error(`[tenant-retention] tenant_not_found：没有 slug 为「${tenantSlug}」的租户`);
      return 1;
    }
    const before = await readRetention(db, tenant.id);
    if (!before) {
      console.error('[tenant-retention] 租户读不到保留期设置');
      return 1;
    }
    const patch = { leadDays, customerDays, traceDays };
    await updateRetention(db, tenant.id, patch);
    const after = {
      leadDays: leadDays ?? before.leadDays,
      customerDays: customerDays ?? before.customerDays,
      traceDays: traceDays ?? before.traceDays,
    };
    await withTenant(db, { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'tenant-retention', ip: null } }, (tx) =>
      writeAudit(tx, {
        action: 'platform.tenant_retention',
        targetType: 'tenant',
        targetId: tenant.id,
        diff: { before, after },
      }),
    );
    console.log(
      `[tenant-retention] 租户 ${tenantSlug} 的保留期：线索 ${after.leadDays} 天、客户 ${after.customerDays} 天、trace ${after.traceDays} 天`,
    );
    return 0;
  } finally {
    await close();
  }
});
