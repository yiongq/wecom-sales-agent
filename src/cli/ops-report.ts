import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTenant, type Db } from '../db/client.js';
import { reportCommand } from '../db/repo/ops-reports.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { dbFromEnv, main } from './common.js';

// 不 import ops/digest 或 env.ts；平台命令不装载运行时、不读本机环境文件。
export async function runOpsReport(
  argv: string[],
  deps: { connect(): Promise<{ db: Db; close(): Promise<void> }>; now?: number },
): Promise<number> {
  const command = argv[0];
  if (command !== 'retry' && command !== 'prepare-rollback') {
    console.error('[ops-report] 需要 retry 或 prepare-rollback');
    return 1;
  }
  let args;
  try {
    args = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: false,
      options: {
        tenant: { type: 'string' },
        ...(command === 'retry' ? { day: { type: 'string' as const }, 'ack-duplicate-risk': { type: 'boolean' as const } } : {}),
      },
    }).values;
  } catch {
    console.error('[ops-report] 参数不正确');
    return 1;
  }
  const d = new Date(deps.now ?? Date.now());
  const yesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (!args.tenant || (command === 'retry' && (!args['ack-duplicate-risk'] || args.day !== day))) {
    console.error('[ops-report] retry 必须确认重复风险且只接受部署时区的昨日');
    return 1;
  }
  try {
    const { db, close } = await deps.connect();
    try {
      const tenant = await findTenantBySlug(db, args.tenant);
      if (!tenant) throw new Error('tenant_not_found');
      await withTenant(db, { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'ops-report', ip: null } }, (tx) =>
        reportCommand(tx, command, command === 'retry' ? day : undefined),
      );
      console.log('[ops-report] 已更新账本与任务');
      return 0;
    } finally {
      await close();
    }
  } catch {
    console.error('[ops-report] 操作失败，请检查平台权限、租户和报告状态');
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(() => runOpsReport(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_PLATFORM_URL') }));
}
