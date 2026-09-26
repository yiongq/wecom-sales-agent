// 停用账号（设 disabled_at），吊销全部会话。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/user-disable.ts --tenant <slug> --email <e>
import { disable } from '../auth/accounts.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'user-disable --tenant <slug> --email <e>';
main(async () => {
  const a = args({ tenant: { type: 'string' }, email: { type: 'string' } }, USAGE);
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const r = await disable(db, { tenantSlug: need(a.tenant, '--tenant', USAGE), email: need(a.email, '--email', USAGE) });
    (r.code === 0 ? console.log : console.error)(`[user-disable] ${r.message}`);
    return r.code;
  } finally {
    await close();
  }
});
