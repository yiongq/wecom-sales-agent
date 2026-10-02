// 把库里的真实会话导回 var/ 的 JSON（02 spec「导入、导出与切换 · export-sessions」），切回文件存储之前跑。以 app 身份运行，
// 要求应用已停（要取租户锁）：
//   docker compose stop app
//   install -d -o 1000 -g 1000 /root/sessions-keep-<日期>
//   docker compose run --rm -v /root/sessions-keep-<日期>:/keep app \
//     node --import tsx src/cli/export-sessions.ts --tenant <slug> --keep /keep --var /app/var
// 之后 .env 去掉 SESSION_STORE=db 再起应用。再切回 db 存储：停应用，import-sessions --resync。
// 没有标记文件（已经导出过）而 JSON 里的真实会话与库里不一致时以 2 拒绝、什么都不动：JSON 比库新，要切回 db 存储用 import-sessions --resync。
// 退出码：0 已导出或已经导出过；2 JSON 比库新（见上）；3 应用还在跑（拿不到租户锁）；1 其他错误（含数据目录里有没回放的 spill 文件、--keep 写不进去）
import { holdTenantLock } from '../db/client.js';
import { args, dbFromEnv, main, need } from './common.js';
import { exportSessions } from './session-transfer.js';

const USAGE = 'export-sessions --tenant <slug> --keep <dir> --var <dir>';
main(async () => {
  const a = args({ tenant: { type: 'string' }, keep: { type: 'string' }, var: { type: 'string' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const keepDir = need(a.keep, '--keep', USAGE);
  const varDir = need(a.var, '--var', USAGE);
  const { db, url, close } = await dbFromEnv('DATABASE_URL');
  try {
    const r = await exportSessions({ db, tenantSlug, keepDir, varDir, lock: (tenantId) => holdTenantLock(url, tenantId) });
    for (const line of r.lines) (r.code === 0 ? console.log : console.error)(`[export-sessions] ${line}`);
    return r.code;
  } finally {
    await close();
  }
});
