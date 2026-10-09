// 回退 02 前停应用，以 app 身份运行；--tenant <slug> --var <dir> --keep <var 之外持久挂载目录>。
// 退出码：0 成功/无操作，1 用法/IO，2 无法安全回退，3 租户锁。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdTenantLock, openDb } from '../db/client.js';
import { runChannelTransfer, type ChannelTransferDeps } from './channel-transfer.js';

export const runChannelExport = (argv: string[], deps: ChannelTransferDeps): Promise<number> => runChannelTransfer('export', argv, deps);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(
    await runChannelExport(process.argv.slice(2), {
      connect: async () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('缺少 DATABASE_URL');
        const conn = await openDb(url);
        return { ...conn, lock: (tenantId) => holdTenantLock(url, tenantId) };
      },
    }),
  );
}
