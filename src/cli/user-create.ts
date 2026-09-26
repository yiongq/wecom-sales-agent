// 建账号并加为本租户成员（邮箱已存在时只加成员关系，不碰口令）。以 platform 身份运行：
//   docker compose run --rm platform node --import tsx src/cli/user-create.ts --tenant <slug> --email <e> --name <n> --role owner|admin|supervisor|agent|viewer [--password-stdin]
// 不给 --password-stdin 时生成一个口令，只写到 /dev/tty。退出码：0 已建或已一致；2 已是别的角色；1 其他错误
import { createUser } from '../auth/accounts.js';
import type { Role } from '../auth/session.js';
import { args, dbFromEnv, main, need, passwordSource } from './common.js';

const USAGE = 'user-create --tenant <slug> --email <e> --name <n> --role <role> [--password-stdin]';
main(async () => {
  const a = args(
    {
      tenant: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      'password-stdin': { type: 'boolean' },
    },
    USAGE,
  );
  const { db, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const r = await createUser(db, {
      tenantSlug: need(a.tenant, '--tenant', USAGE),
      email: need(a.email, '--email', USAGE),
      name: need(a.name, '--name', USAGE),
      role: need(a.role, '--role', USAGE) as Role,
      password: passwordSource(a['password-stdin'] ?? false),
    });
    (r.code === 0 ? console.log : console.error)(`[user-create] ${r.message}`);
    return r.code;
  } finally {
    await close();
  }
});
