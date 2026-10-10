// 04 R4、R6：平台身份修改待生效品牌，set/clear 不发布、不改变运行中实例。退出码 0 成功，1 拒绝或读写失败。
// docker compose run --rm platform node --import tsx src/cli/tenant-brand.ts set --tenant <slug> --brand-file <json>
// docker compose run --rm platform node --import tsx src/cli/tenant-brand.ts clear --tenant <slug>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BRAND_FIELDS, type BrandProfile } from '../core/pack-api.js';
import { withTenant, type Db } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, readBrand, updateBrand } from '../db/repo/tenants.js';
import { readBrandFile } from './brand-file.js';
import { dbFromEnv, main } from './common.js';

const USAGE = 'tenant-brand set --tenant <slug> --brand-file <json> | tenant-brand clear --tenant <slug>';

export async function runTenantBrand(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  try {
    const command = argv[0];
    if (command !== 'set' && command !== 'clear') {
      console.error(`用法：${USAGE}`);
      return 1;
    }
    let a;
    try {
      a = parseArgs({
        args: argv.slice(1),
        options: { tenant: { type: 'string' }, 'brand-file': { type: 'string' } },
        strict: true,
        allowPositionals: false,
      }).values;
    } catch {
      console.error(`参数不正确；用法：${USAGE}`);
      return 1;
    }
    if (!a.tenant || (command === 'set' && !a['brand-file']) || (command === 'clear' && a['brand-file'] !== undefined)) {
      console.error(`缺少 --tenant 或 --brand-file；用法：${USAGE}`);
      return 1;
    }
    let brand: BrandProfile | null = null;
    if (command === 'set') {
      try {
        brand = readBrandFile(a['brand-file']!);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
    }
    const { db, close } = await deps.connect();
    try {
      const tenant = await findTenantBySlug(db, a.tenant);
      if (!tenant) {
        console.error('[tenant-brand] tenant_not_found');
        return 1;
      }
      await withTenant(
        db,
        { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'tenant-brand', ip: null } },
        async (tx) => {
          const before = await readBrand(tx, tenant.id, true);
          if (before === undefined) throw new Error('tenant_not_found');
          const fields = BRAND_FIELDS.filter((field) => before?.[field] !== brand?.[field]);
          await updateBrand(tx, tenant.id, brand);
          const audit = {
            targetType: 'tenant',
            targetId: tenant.id,
            diff: { fields },
          };
          await writeAudit(tx, command === 'set' ? { action: 'tenant.brand_set', ...audit } : { action: 'tenant.brand_clear', ...audit });
        },
      );
      console.log('[tenant-brand] 已更新待生效品牌配置，下次启动生效');
      return 0;
    } finally {
      await close();
    }
  } catch {
    // 数据库错误可能带 SQL 参数；不把品牌文字或连接串写到日志。
    console.error('[tenant-brand] 数据库读写失败，请检查平台身份与权限');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(() => runTenantBrand(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_PLATFORM_URL') }));
}
