// 首次把 data/ 导入租户（spec「导入、导出与回滚 · import-config」）。以 app 身份运行：
//   docker compose run --rm app node --import tsx src/cli/import-config.ts --tenant <slug> [--data <dir>] [--dry-run]
// 退出码：0 已导入或库里已是这份内容；2 库里已有不同的内容；3 应用正持着租户锁；1 其他错误
import fs from 'node:fs';
import path from 'node:path';
import { holdTenantLock } from '../db/client.js';
import { importConfig } from '../config/transfer.js';
import { decodeSopFile } from '../sop/sections.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'import-config --tenant <slug> [--data <dir>] [--dry-run]';
main(async () => {
  const a = args({ tenant: { type: 'string' }, data: { type: 'string' }, 'dry-run': { type: 'boolean' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const { db, url, close } = await dbFromEnv('DATABASE_URL');
  try {
    const r = await importConfig({
      db,
      tenantSlug,
      dataDir: a.data ?? path.join(process.cwd(), 'data'),
      imageSop: decodeSopFile(fs.readFileSync(path.join(process.cwd(), 'data', 'sop.md'))),
      lock: (tenantId) => holdTenantLock(url, tenantId),
      dryRun: a['dry-run'] ?? false,
    });
    (r.code === 0 ? console.log : console.error)(`[import-config] ${r.message}`);
    if (r.hashes) console.log(`promptHash=${r.hashes.promptHash}\nprefixHash=${r.hashes.prefixHash}\nsopHash=${r.hashes.sopHash}`);
    return r.code;
  } finally {
    await close();
  }
});
