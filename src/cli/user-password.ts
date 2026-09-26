// 改口令，同时吊销该用户的全部会话。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/user-password.ts --tenant <slug> --email <e> [--password-stdin]
import { setPassword } from '../auth/accounts.js';
import { args, dbFromEnv, main, need, passwordSource } from './common.js';

const USAGE = 'user-password --tenant <slug> --email <e> [--password-stdin]';
main(async () => {
  const a = args({ tenant: { type: 'string' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' } }, USAGE);
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const r = await setPassword(db, {
      tenantSlug: need(a.tenant, '--tenant', USAGE),
      email: need(a.email, '--email', USAGE),
      password: passwordSource(a['password-stdin'] ?? false),
    });
    (r.code === 0 ? console.log : console.error)(`[user-password] ${r.message}`);
    return r.code;
  } finally {
    await close();
  }
});
