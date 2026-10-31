// 两身份仅在隔离的平台运维进程中存在；不 import env.ts，不给 app 服务平台凭据。
import fs from 'node:fs';
import { holdTenantLock } from '../db/client.js';
import { trialApprovalSchema, resetTrial } from '../tenancy/trial/reset.js';
import { args, dbFromEnv, main, need, passwordSource } from './common.js';

const USAGE = 'trial-reset --tenant <slug> --approval <私有盘点文件> --var <共享运行目录> [--batch <恢复批次>] [--password-stdin]';
main(async () => {
  const a = args(
    {
      tenant: { type: 'string' },
      approval: { type: 'string' },
      var: { type: 'string' },
      batch: { type: 'string' },
      'password-stdin': { type: 'boolean' },
    },
    USAGE,
  );
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const varDir = need(a.var, '--var', USAGE);
  let approval;
  try {
    approval = trialApprovalSchema().parse(JSON.parse(fs.readFileSync(need(a.approval, '--approval', USAGE), 'utf8')));
  } catch {
    console.error('[trial-reset] invalid approval');
    return 1;
  }
  const app = await dbFromEnv('DATABASE_URL');
  const platform = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    // 同一数据库端点/库名，不能把 app 的检查与 platform 的删除分配到不同数据库。
    const endpoint = (url: string) => {
      const u = new URL(url);
      return [u.protocol, u.hostname, u.port, u.pathname].join('|');
    };
    if (endpoint(app.url) !== endpoint(platform.url)) throw new Error('trial_database_mismatch');
    const id = approval.allowlist.find((e) => e.slug === tenantSlug)?.tenantId;
    if (!id) throw new Error('trial_allowlist_mismatch');
    const batch = await resetTrial({
      app: app.db,
      platform: platform.db,
      tenantSlug,
      hostSlug: process.env.DEFAULT_TENANT_SLUG ?? '',
      varDir,
      approval,
      batch: a.batch,
      lock: () => holdTenantLock(app.url, id),
      password: passwordSource(a['password-stdin'] ?? false),
    });
    console.log(`[trial-reset] complete batch=${batch}；重启应用重建内存后才开放试用`);
    return 0;
  } catch {
    // SQL、私有输入、原始客户 id、凭据都不输出；不完整批次可从 audit_log 受控读取后 --batch 恢复。
    console.error('[trial-reset] refused；保持维护，核对盘点、锁和本租户批次后恢复');
    return 1;
  } finally {
    await platform.close();
    await app.close();
  }
});
