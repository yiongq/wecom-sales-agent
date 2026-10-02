// 把 var/ 里的真实会话导进库（02 spec「导入、导出与切换 · import-sessions」）。以 app 身份运行，要求应用已停（要取租户锁）：
//   docker compose stop app
//   install -d -o 1000 -g 1000 /root/sessions-keep-<日期>
//   docker compose run --rm -v /root/sessions-keep-<日期>:/keep app \
//     node --import tsx src/cli/import-sessions.ts --tenant <slug> --keep /keep [--dry-run] [--resync]
// --keep 必须在 var/ 之外（原件不进每晚 var/ 的备份），并且是挂进来的宿主目录：写在容器里的会随 --rm 删掉。
// --var 缺省与应用相同（VAR_DIR，没设就是 ./var）。--resync：回退到文件存储跑过一段之后再切回。
// 退出码：0 已导入、已经导入过或补完改写；2 库里已有不一致的内容（提示 --resync）或读回与 JSON 不等；3 应用还在跑（拿不到租户锁）；1 其他错误
import path from 'node:path';
import { holdTenantLock } from '../db/client.js';
import { args, dbFromEnv, main, need } from './common.js';
import { importSessions } from './session-transfer.js';

const USAGE = 'import-sessions --tenant <slug> --keep <dir> [--var <dir>] [--dry-run] [--resync]';
main(async () => {
  const a = args(
    {
      tenant: { type: 'string' },
      keep: { type: 'string' },
      var: { type: 'string' },
      'dry-run': { type: 'boolean' },
      resync: { type: 'boolean' },
    },
    USAGE,
  );
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const keepDir = need(a.keep, '--keep', USAGE);
  const { db, url, close } = await dbFromEnv('DATABASE_URL');
  try {
    const r = await importSessions({
      db,
      tenantSlug,
      keepDir,
      varDir: a.var ?? process.env.VAR_DIR ?? path.join(process.cwd(), 'var'),
      lock: (tenantId) => holdTenantLock(url, tenantId),
      dryRun: a['dry-run'] ?? false,
      resync: a.resync ?? false,
    });
    for (const line of r.lines) (r.code === 0 ? console.log : console.error)(`[import-sessions] ${line}`);
    return r.code;
  } finally {
    await close();
  }
});
