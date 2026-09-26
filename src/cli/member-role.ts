// 改成员在本租户的角色。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/member-role.ts --tenant <slug> --email <e> --role <role>
import { setRole } from '../auth/accounts.js';
import type { Role } from '../auth/session.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'member-role --tenant <slug> --email <e> --role <role>';
main(async () => {
  const a = args({ tenant: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } }, USAGE);
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const r = await setRole(db, {
      tenantSlug: need(a.tenant, '--tenant', USAGE),
      email: need(a.email, '--email', USAGE),
      role: need(a.role, '--role', USAGE) as Role,
    });
    (r.code === 0 ? console.log : console.error)(`[member-role] ${r.message}`);
    return r.code;
  } finally {
    await close();
  }
});
