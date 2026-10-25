// 首次把 data/ 导入租户（spec「导入、导出与回滚 · import-config」）。以 app 身份运行：
//   docker compose run --rm app node --import tsx src/cli/import-config.ts --tenant <slug> [--data <dir>] [--dry-run]
// 退出码：0 已导入或库里已是这份内容；2 库里已有不同的内容；3 应用正持着租户锁；1 其他错误
// --data 缺省按租户的包：旅游是 ./data（sop.md、routes.json、hotels.json），其他包是它的参考配置 ./data/packs/<包>/（sop.md、pack.json、
// catalog/<kind>.json，08 R11）；也可以指向 export-config 的输出。目录的包（pack.json，没有就是旅游）与租户绑定的包不符时拒绝，报错点名两边的包
import { holdTenantLock } from '../db/client.js';
import { defaultDataDir, importConfig } from '../config/transfer.js';
import { readImageSop } from '../config/brand.js';
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
      // 没传 --data：解析出租户的包之后按包取（旅游 ./data，其他包 ./data/packs/<包>/）
      dataDir: a.data ?? ((packId) => defaultDataDir(packId)),
      // 08 R10：解析出租户的包之后才读镜像（旅游 data/sop.md，其他包 data/packs/<id>/sop.md）
      imageSop: (packId) => readImageSop(packId),
      lock: (tenantId) => holdTenantLock(url, tenantId),
      dryRun: a['dry-run'] ?? false,
    });
    (r.code === 0 ? console.log : console.error)(`[import-config] ${r.message}`);
    if (r.hashes)
      console.log(
        `promptHash=${r.hashes.promptHash}\npolicyHash=${r.hashes.policyHash}\nprefixHash=${r.hashes.prefixHash}\nsopHash=${r.hashes.sopHash}`,
      );
    return r.code;
  } finally {
    await close();
  }
});
