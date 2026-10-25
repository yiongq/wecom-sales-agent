// 把租户当前的已发布 SOP、品牌快照与 active 条目导出成文件（04 R17）。以 app 身份运行，只读库：
//   docker compose run --rm -v <宿主目录>:/export app node --import tsx src/cli/export-config.ts --tenant <slug> --out /export [--image-sop /export/<文件>]
// --out 必须落在挂进来的宿主目录里：写在容器里的文件会随 --rm 一起删掉，而这里照样打印成功。宿主目录的准备见 deploy/compose.yml 开头。
// 旅游写 sop.md、routes.json、hotels.json、policy.json（与品牌）；其他行业包写 sop.md、policy.json（与品牌）、pack.json 和每个 kind 的 catalog/<kind>.json（08 R11）。
// --out 可以复用：写之前先删旧的 routes.json、hotels.json、pack.json 与 catalog/（只这四样），换了包不会留下上一个包的产品文件。
// 回到旧版本前用 --image-sop 指向目标版本的 data/sop.md（先放进同一个宿主目录），锁定节按它合并。导出的 JSON 提交前用 oxfmt 格式化
import fs from 'node:fs';
import { exportConfig } from '../config/transfer.js';
import { readImageSop } from '../config/brand.js';
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
      imageSop: (packId) => readImageSop(packId),
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
