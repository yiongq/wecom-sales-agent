// 05 R7、R15：standard 租户的每日软告警上限，单位为千分之一元（1000 表示 1 元）；0 有效，clear 取消。
// docker compose run --rm platform node --import tsx src/cli/tenant-budget.ts set --tenant <slug> --milli <非负整数>
// docker compose run --rm platform node --import tsx src/cli/tenant-budget.ts clear --tenant <slug>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTenant, type Db } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, lockTenantKind, updateLlmDailyAlert } from '../db/repo/tenants.js';
import { dbFromEnv, main } from './common.js';

const USAGE = 'tenant-budget set --tenant <slug> --milli <非负整数> | tenant-budget clear --tenant <slug>';

export async function runTenantBudget(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  const command = argv[0];
  if (command !== 'set' && command !== 'clear') {
    console.error(`用法：${USAGE}`);
    return 1;
  }
  let a;
  try {
    a = parseArgs({
      args: argv.slice(1),
      options: { tenant: { type: 'string' }, milli: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  if (!a.tenant || (command === 'set' && a.milli === undefined) || (command === 'clear' && a.milli !== undefined)) {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  const milli = command === 'set' ? Number(a.milli) : null;
  if (command === 'set' && (!/^[0-9]+$/.test(a.milli!) || !Number.isSafeInteger(milli))) {
    console.error('[tenant-budget] --milli 要是非负安全整数');
    return 1;
  }
  try {
    const { db, close } = await deps.connect();
    try {
      const tenant = await findTenantBySlug(db, a.tenant);
      if (!tenant) {
        console.error('[tenant-budget] tenant_not_found');
        return 1;
      }
      await withTenant(
        db,
        { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'tenant-budget', ip: null } },
        async (tx) => {
          if ((await lockTenantKind(tx, tenant.id)) !== 'standard') throw new Error('standard_tenant_required');
          await updateLlmDailyAlert(tx, tenant.id, milli);
          await writeAudit(tx, {
            action: `tenant.budget_${command}`,
            targetType: 'tenant',
            targetId: tenant.id,
            diff: { fields: ['llm_daily_alert_milli'] },
          });
        },
      );
      console.log('[tenant-budget] 已更新，下次启动生效');
      return 0;
    } finally {
      await close();
    }
  } catch {
    console.error('[tenant-budget] 更新失败，请检查 standard 租户、数据库约束与平台权限');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(() => runTenantBudget(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_PLATFORM_URL') }));
}
