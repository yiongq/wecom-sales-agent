// 锁定字段的紧急修正（spec「导入、导出与回滚 · catalog-fix」）。要取租户锁，所以先停应用：
//   docker compose stop app
//   docker compose run --rm app node --import tsx src/cli/catalog-fix.ts --tenant <slug> --kind route|hotel --code <code> --set '<json>' --reason <text>
//   docker compose up -d app        # 启动时重新装载快照
// 退出码：0 已修正；3 应用还在跑（拿不到租户锁）；1 其他错误
import { fixLockedFields } from '../config/catalog.js';
import { holdTenantLock } from '../db/client.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = "catalog-fix --tenant <slug> --kind route|hotel --code <code> --set '<json>' --reason <text>";
main(async () => {
  const a = args(
    { tenant: { type: 'string' }, kind: { type: 'string' }, code: { type: 'string' }, set: { type: 'string' }, reason: { type: 'string' } },
    USAGE,
  );
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const kind = need(a.kind, '--kind', USAGE);
  const code = need(a.code, '--code', USAGE);
  const reason = need(a.reason, '--reason', USAGE);
  if (kind !== 'route' && kind !== 'hotel') {
    console.error('--kind 只能是 route 或 hotel');
    return 1;
  }
  let set: Record<string, unknown>;
  try {
    set = JSON.parse(need(a.set, '--set', USAGE)) as Record<string, unknown>;
  } catch (e) {
    console.error(`--set 不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const { db, url, close } = await dbFromEnv('DATABASE_URL');
  try {
    const tenant = await findTenantBySlug(db, tenantSlug);
    if (!tenant) {
      console.error(`没有 slug 为「${tenantSlug}」的租户`);
      return 1;
    }
    const lock = await holdTenantLock(url, tenant.id);
    if (!lock) {
      console.error(`[catalog-fix] 租户「${tenantSlug}」的锁在别的进程手里：先 docker compose stop app`);
      return 3;
    }
    try {
      console.warn(`[catalog-fix] ⚠️ 已发出的方案书会按新值重算：${kind} ${code} 的 ${Object.keys(set).join('、')}`);
      const item = await fixLockedFields({ db, tenantSlug, kind, code, set, reason });
      console.log(`[catalog-fix] 已修正 ${kind} ${code}（rev ${item.rev}）。docker compose up -d app 让应用重新装载`);
      return 0;
    } catch (e) {
      console.error(`[catalog-fix] ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    } finally {
      await lock.release();
    }
  } finally {
    await close();
  }
});
