// 新建租户（spec「导入、导出与回滚」的平台命令行）。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/tenant-create.ts --slug <slug> --name <name> --pack travel [--locale zh-CN] [--region CN]
// 退出码：0 已建好，或同名租户已存在且字段相同；2 同名租户已存在但字段不同；1 其他错误
// --pack 的可选值读行业包注册表（后台 UX spec「行业包通用架构 · 放在哪里」）：加包不用改命令行
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { BRAND_FIELDS, type BrandProfile } from '../core/pack-api.js';
import { withTenant, type Db } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, insertTenant, readBrand } from '../db/repo/tenants.js';
import { PACK_IDS } from '../packs/registry.js';
import { isExplicitDemoProfile } from '../profile.js';
import { readBrandFile } from './brand-file.js';
import { dbFromEnv, main } from './common.js';

const USAGE = `tenant-create --slug <slug> --name <name> --pack <${PACK_IDS.join('|')}> [--locale zh-CN] [--region CN] [--brand-file <json>]`;
export async function runTenantCreate(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  let a;
  try {
    a = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        slug: { type: 'string' },
        name: { type: 'string' },
        pack: { type: 'string' },
        locale: { type: 'string' },
        region: { type: 'string' },
        'brand-file': { type: 'string' },
      },
    }).values;
  } catch {
    console.error(`参数不正确；用法：${USAGE}`);
    return 1;
  }
  if (!a.slug || !a.name || !a.pack) {
    console.error(`缺少 --slug / --name / --pack；用法：${USAGE}`);
    return 1;
  }
  if (!a['brand-file'] && !isExplicitDemoProfile()) {
    console.error('tenant-create 必须提供 --brand-file；demo 实例在 `.env.platform` 里设 `DEPLOY_PROFILE=demo` 才可省略');
    return 1;
  }
  let brand: BrandProfile | null = null;
  if (a['brand-file'] !== undefined) {
    try {
      brand = readBrandFile(a['brand-file']);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }
  const want = {
    slug: a.slug,
    name: a.name,
    packId: a.pack,
    locale: a.locale ?? 'zh-CN',
    region: a.region ?? 'CN',
    brand,
  };
  if (!PACK_IDS.includes(want.packId)) {
    console.error(`--pack 只能是 ${PACK_IDS.join('、')}`);
    return 1;
  }
  try {
    const { db, close } = await deps.connect();
    try {
      // 预先分配 id，使首次插入与租户审计在同一个 withTenant 事务内完成。
      const id = randomUUID();
      const result = await withTenant(
        db,
        { tenantId: id, actor: { kind: 'platform', userId: null, name: 'tenant-create', ip: null } },
        async (tx) => {
          const existing = await findTenantBySlug(tx, want.slug);
          if (existing) {
            const same =
              existing.name === want.name &&
              existing.packId === want.packId &&
              existing.locale === want.locale &&
              existing.region === want.region &&
              isDeepStrictEqual(await readBrand(tx, existing.id, true), want.brand);
            return {
              code: same ? 0 : 2,
              message: `[tenant-create] 租户 ${want.slug} 已存在${same ? '，字段相同' : '，但字段不同，没有改动'}（id ${existing.id}）`,
            };
          }
          const t = await insertTenant(tx, { id, ...want });
          await writeAudit(tx, {
            action: 'platform.tenant_create',
            targetType: 'tenant',
            targetId: t.id,
            diff: { slug: t.slug, name: t.name, packId: t.packId, ...(brand ? { brandFields: [...BRAND_FIELDS] } : {}) },
          });
          return { code: 0, message: `[tenant-create] 已建租户 ${t.slug}（id ${t.id}）` };
        },
      );
      (result.code === 0 ? console.log : console.error)(result.message);
      return result.code;
    } finally {
      await close();
    }
  } catch {
    console.error('[tenant-create] 数据库读写失败，请检查平台身份与权限');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(() => runTenantCreate(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_PLATFORM_URL') }));
}
