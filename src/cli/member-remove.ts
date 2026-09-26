// 删成员关系，吊销该用户在本租户的会话。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/member-remove.ts --tenant <slug> --email <e>
import { removeMember } from '../auth/accounts.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'member-remove --tenant <slug> --email <e>';
main(async () => {
  const a = args({ tenant: { type: 'string' }, email: { type: 'string' } }, USAGE);
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const r = await removeMember(db, { tenantSlug: need(a.tenant, '--tenant', USAGE), email: need(a.email, '--email', USAGE) });
    (r.code === 0 ? console.log : console.error)(`[member-remove] ${r.message}`);
    return r.code;
  } finally {
    await close();
  }
});
