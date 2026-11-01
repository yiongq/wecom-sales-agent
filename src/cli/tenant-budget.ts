// 05 R7、R15：standard 租户的每日软告警上限，单位为千分之一元（1000 表示 1 元）；0 有效，clear 取消。
// docker compose run --rm platform node --import tsx src/cli/tenant-budget.ts set --tenant <slug> --milli <非负整数>
// docker compose run --rm platform node --import tsx src/cli/tenant-budget.ts clear --tenant <slug>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTenant, type Db } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, lockTenantKind, readTenantLimits, updateLlmDailyAlert } from '../db/repo/tenants.js';
import { readMonthlyReplyCount } from '../db/repo/usage.js';
import { updateTenantBudgetLimits } from '../db/repo/tenant-budget.js';
import { dbFromEnv, main } from './common.js';

const USAGE =
  'tenant-budget set --tenant <slug> --milli <非负整数> | clear --tenant <slug> | show --tenant <slug> | quota --tenant <slug> (--replies <非负整数> | --clear) | cap --tenant <slug> (--milli <非负整数> | --clear) | status --tenant <slug> --set <active|trial|suspended>';

export async function runTenantBudget(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  const command = argv[0];
  if (!command || !['set', 'clear', 'show', 'quota', 'cap', 'status'].includes(command)) {
    console.error(`用法：${USAGE}`);
    return 1;
  }
  let a;
  try {
    a = parseArgs({
      args: argv.slice(1),
      options: {
        tenant: { type: 'string' },
        ...(command === 'set' || command === 'cap' ? { milli: { type: 'string' as const } } : {}),
        ...(command === 'quota' ? { replies: { type: 'string' as const } } : {}),
        ...(command === 'cap' || command === 'quota' ? { clear: { type: 'boolean' as const } } : {}),
        ...(command === 'status' ? { set: { type: 'string' as const } } : {}),
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  const raw = (command === 'quota' ? a.replies : a.milli) as string | undefined;
  const status = a.set as 'active' | 'trial' | 'suspended' | undefined;
  if (
    !a.tenant ||
    (command === 'set' && raw === undefined) ||
    ((command === 'quota' || command === 'cap') && (raw !== undefined) === !!a.clear) ||
    (command === 'status' && !['active', 'trial', 'suspended'].includes(status ?? ''))
  ) {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  const milli = raw === undefined ? null : Number(raw);
  if (raw !== undefined && (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(milli))) {
    console.error(`[tenant-budget] --${command === 'quota' ? 'replies' : 'milli'} 要是非负安全整数`);
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
          if (command === 'show') {
            const date = new Date();
            const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            const limits = await readTenantLimits(tx, tenant.id);
            if (!limits) throw new Error('tenant_not_found');
            console.log(JSON.stringify({ ...limits, monthlyUsed: await readMonthlyReplyCount(tx, month) }));
            return;
          }
          const change =
            command === 'quota'
              ? { action: 'tenant.quota_update', field: 'monthly_reply_quota' }
              : command === 'cap'
                ? { action: 'tenant.cap_update', field: 'llm_daily_cap_milli' }
                : command === 'status'
                  ? { action: 'tenant.status_update', field: 'status' }
                  : { action: `tenant.budget_${command}`, field: 'llm_daily_alert_milli' };
          if (command === 'quota') await updateTenantBudgetLimits(tx, tenant.id, { monthlyReplyQuota: milli });
          else if (command === 'cap') await updateTenantBudgetLimits(tx, tenant.id, { llmDailyCapMilli: milli });
          else if (command === 'status') await updateTenantBudgetLimits(tx, tenant.id, { status: status! });
          else await updateLlmDailyAlert(tx, tenant.id, milli);
          await writeAudit(tx, {
            action: change.action,
            targetType: 'tenant',
            targetId: tenant.id,
            diff: { fields: [change.field] },
          });
        },
      );
      if (command !== 'show')
        console.log(
          command === 'set' || command === 'clear' ? '[tenant-budget] 已更新，下次启动生效' : '[tenant-budget] 已更新，30 秒内生效',
        );
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
