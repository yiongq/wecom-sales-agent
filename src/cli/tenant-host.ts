// 05 R7：以 agent_platform 改 public_host，与字段名审计原子提交，下次启动生效。
// docker compose run --rm platform node --import tsx src/cli/tenant-host.ts set --tenant <slug> --host <host>
// docker compose run --rm platform node --import tsx src/cli/tenant-host.ts clear --tenant <slug>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTenant, type Db } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, lockTenantKind, updatePublicHost } from '../db/repo/tenants.js';
import { normalizeHost } from '../tenancy/hosts.js';
import { dbFromEnv, main } from './common.js';

const USAGE = 'tenant-host set --tenant <slug> --host <host> | tenant-host clear --tenant <slug>';

export async function runTenantHost(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  const command = argv[0];
  if (command !== 'set' && command !== 'clear') {
    console.error(`用法：${USAGE}`);
    return 1;
  }
  let a;
  try {
    a = parseArgs({
      args: argv.slice(1),
      options: { tenant: { type: 'string' }, host: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  if (!a.tenant || (command === 'set' && !a.host) || (command === 'clear' && a.host !== undefined)) {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  const host = command === 'set' ? normalizeHost(a.host!) : null;
  if (command === 'set' && host === null) {
    console.error('[tenant-host] invalid_host');
    return 1;
  }
  try {
    const { db, close } = await deps.connect();
    try {
      const tenant = await findTenantBySlug(db, a.tenant);
      if (!tenant) {
        console.error('[tenant-host] tenant_not_found');
        return 1;
      }
      await withTenant(
        db,
        { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'tenant-host', ip: null } },
        async (tx) => {
          if ((await lockTenantKind(tx, tenant.id)) !== 'standard') throw new Error('standard_tenant_required');
          await updatePublicHost(tx, tenant.id, host);
          await writeAudit(tx, {
            action: `tenant.host_${command}`,
            targetType: 'tenant',
            targetId: tenant.id,
            diff: { fields: ['public_host'] },
          });
        },
      );
      console.log('[tenant-host] 已更新，下次启动生效');
      return 0;
    } finally {
      await close();
    }
  } catch {
    // 数据库错误可能包含 SQL 参数，不输出 Host 或连接串。
    console.error('[tenant-host] 更新失败，请检查 standard 租户、Host 唯一性、数据库约束与平台权限');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(() => runTenantHost(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_PLATFORM_URL') }));
}
