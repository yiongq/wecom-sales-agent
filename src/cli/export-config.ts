// 把租户当前的已发布 SOP 与 active 条目导出成文件（spec「导入、导出与回滚 · export-config」）。以 app 身份运行，只读库：
//   docker compose run --rm app node --import tsx src/cli/export-config.ts --tenant <slug> --out <dir> [--image-sop <path>]
// 回到旧版本前用 --image-sop 指向目标版本的 data/sop.md，锁定节按它合并。导出的两个 JSON 提交前用 oxfmt 格式化
import fs from 'node:fs';
import path from 'node:path';
import { exportConfig } from '../config/transfer.js';
import { decodeSopFile } from '../sop/sections.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'export-config --tenant <slug> --out <dir> [--image-sop <path>]';
main(async () => {
  const a = args({ tenant: { type: 'string' }, out: { type: 'string' }, 'image-sop': { type: 'string' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const outDir = need(a.out, '--out', USAGE);
  const { db, close } = await dbFromEnv('DATABASE_URL');
  try {
    const r = await exportConfig({
      db,
      tenantSlug,
      outDir,
      imageSop: decodeSopFile(fs.readFileSync(path.join(process.cwd(), 'data', 'sop.md'))),
      targetImageSop: a['image-sop'] === undefined ? undefined : decodeSopFile(fs.readFileSync(a['image-sop'])),
    });
    (r.code === 0 ? console.log : console.error)(`[export-config] ${r.message}`);
    if (r.code === 0)
      console.log(
        `versionNo=${r.versionNo}\nsopHash=${r.hashes?.sopHash}${a['image-sop'] === undefined ? `\npromptHash=${r.hashes?.promptHash}` : ''}`,
      );
    return r.code;
  } finally {
    await close();
  }
});
