// 新建租户（spec「导入、导出与回滚」的平台命令行）。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/tenant-create.ts --slug <slug> --name <name> --pack travel [--locale zh-CN] [--region CN]
// 退出码：0 已建好，或同名租户已存在且字段相同；2 同名租户已存在但字段不同；1 其他错误
import { withTenant } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { findTenantBySlug, insertTenant } from '../db/repo/tenants.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'tenant-create --slug <slug> --name <name> --pack travel [--locale zh-CN] [--region CN]';
const PACKS = ['travel'];
main(async () => {
  const a = args(
    {
      slug: { type: 'string' },
      name: { type: 'string' },
      pack: { type: 'string' },
      locale: { type: 'string' },
      region: { type: 'string' },
    },
    USAGE,
  );
  const want = {
    slug: need(a.slug, '--slug', USAGE),
    name: need(a.name, '--name', USAGE),
    packId: need(a.pack, '--pack', USAGE),
    locale: a.locale ?? 'zh-CN',
    region: a.region ?? 'CN',
  };
  if (!PACKS.includes(want.packId)) {
    console.error(`--pack 只能是 ${PACKS.join('、')}`);
    return 1;
  }
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const existing = await findTenantBySlug(db, want.slug);
    if (existing) {
      const same =
        existing.name === want.name &&
        existing.packId === want.packId &&
        existing.locale === want.locale &&
        existing.region === want.region;
      (same ? console.log : console.error)(
        `[tenant-create] 租户 ${want.slug} 已存在${same ? '，字段相同' : '，但字段不同，没有改动'}（id ${existing.id}）`,
      );
      return same ? 0 : 2;
    }
    const t = await insertTenant(db, want);
    await withTenant(db, { tenantId: t.id, actor: { kind: 'platform', userId: null, name: 'tenant-create', ip: null } }, (tx) =>
      writeAudit(tx, {
        action: 'platform.tenant_create',
        targetType: 'tenant',
        targetId: t.id,
        diff: { slug: t.slug, name: t.name, packId: t.packId },
      }),
    );
    console.log(`[tenant-create] 已建租户 ${t.slug}（id ${t.id}）`);
    return 0;
  } finally {
    await close();
  }
});
