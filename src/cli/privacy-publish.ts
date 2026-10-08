// 发布隐私说明（02 spec「隐私说明、敏感信息同意、保留期与行权」，R23）。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/privacy-publish.ts --tenant <slug> --file <path>
// 版本号是这个租户已有的最大版本加 1（第一版是 1）；--file 是纯文本（UTF-8），处理者名称、联系方式、目的、保存期限、
// 行权方式、备份的保存期都写在正文里（spec 的 DDL 注释）。写一行 platform.publish 审计，diff 带新版本号与字节数（不带正文）。
// 退出码：0 发布成功；1 其他错误（租户不存在、文件读不出来）
import fs from 'node:fs';
import { withTenant } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { publishPrivacyNotice } from '../db/repo/privacy.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'privacy-publish --tenant <slug> --file <path>';
main(async () => {
  const a = args({ tenant: { type: 'string' }, file: { type: 'string' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const file = need(a.file, '--file', USAGE);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[privacy-publish] 读不了 ${file}（${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.name : 'unknown')}）`);
    return 1;
  }
  if (!body.trim()) {
    console.error('[privacy-publish] 文件是空的，没有发布');
    return 1;
  }
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const tenant = await findTenantBySlug(db, tenantSlug);
    if (!tenant) {
      console.error(`[privacy-publish] tenant_not_found：没有 slug 为「${tenantSlug}」的租户`);
      return 1;
    }
    const row = await withTenant(
      db,
      { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'privacy-publish', ip: null } },
      async (tx) => {
        const r = await publishPrivacyNotice(tx, { body, publishedByName: null });
        await writeAudit(tx, {
          action: 'privacy.publish',
          targetType: 'tenant',
          targetId: tenant.id,
          diff: { version: r.version, bytes: Buffer.byteLength(body, 'utf8') },
        });
        return r;
      },
    );
    console.log(`[privacy-publish] 租户 ${tenantSlug} 已发布隐私说明第 ${row.version} 版（${Buffer.byteLength(body, 'utf8')} 字节）`);
    console.log('[privacy-publish] 运行中的进程最多 60 秒内读到新版本（后台轮询），GET /privacy 之后会显示新正文');
    return 0;
  } finally {
    await close();
  }
});
