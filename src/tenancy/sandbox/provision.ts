// 05 第 14 步：HTTP / cookie 之外的开通核心。第 15 步直接调用，只有成功装载才交出登录令牌。
import { createHash, randomBytes } from 'node:crypto';
import { ConfigStartupError, type ConfigDeps } from '../../config/source.js';
import { publishedBrand } from '../../config/hashes.js';
import { writeTemplateConfig } from '../../config/transfer.js';
import { writeSeedSessions } from '../../cli/session-transfer.js';
import { withNewSandboxTenant, type NewSandboxTenant, type TenantLock } from '../../db/client.js';
import { expireBrokenSandbox, sandboxStartupRows } from '../../db/sandbox-process.js';
import { writeAudit } from '../../db/repo/audit.js';
import { readSandboxTemplate, insertSandboxWechat, seedSandboxPrivacy } from '../../db/repo/sandbox.js';
import { copyQuickReplies } from '../../db/repo/quick-replies.js';
import { alert } from '../../ops/alert.js';
import { SessionStoreStartupError } from '../../store/backend.js';
import { withoutTenantScope } from '../runtime.js';
import { assertSandboxRunning } from './lifecycle.js';
import { loadSandboxRuntime } from './load.js';
import { sandboxSeeds } from './seeds.js';

// 实例互斥链：包括判限额、读快照、提交与预载；失败不能毒化下一次开通。
let provisioning: Promise<void> = Promise.resolve();

export class SandboxProvisionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly reason: 'sandbox_limited' | 'sandbox_unavailable',
    readonly retryAfter?: number,
    options?: ErrorOptions,
  ) {
    super(reason, options);
  }
}
export interface ProvisionOptions {
  deps: ConfigDeps;
  templateSlug: string;
  host: string;
  epoch: string;
  acquireTenant(tenantId: string): Promise<TenantLock | null>;
  ip: string | null;
  userAgent: string | null;
  /** 第 19、20 步在锁内接全量限额与池预算；当前至少判同时存活 20 个。 */
  admit?: () => Promise<void>;
}
export interface ProvisionedSandbox extends NewSandboxTenant {
  slug: string;
  token: string;
  user: { userId: string; tenantId: string; role: 'owner'; displayName: '体验访客' };
}

export function provisionSandbox(o: ProvisionOptions): Promise<ProvisionedSandbox> {
  return withoutTenantScope(() => {
    const run = provisioning.then(() => provision(o));
    provisioning = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

/** 正常停机先关开通入口，再等当前开通确认提交或回滚，才释放进程锁。 */
export async function drainSandboxProvisioning(): Promise<void> {
  await provisioning;
}

// 不输出异常正文、SQL 参数或地址；只认内部固定原因与驱动错误码。
function failureCode(error: unknown): string {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; depth++) {
    if (e instanceof ConfigStartupError || e instanceof SessionStoreStartupError) return e.reason;
    const { code, reason, message, cause } = e as { code?: unknown; reason?: unknown; message?: unknown; cause?: unknown };
    for (const candidate of [reason, message]) {
      if (
        typeof candidate === 'string' &&
        [
          'sandbox_template_unpublished_inputs',
          'sandbox_template_contract_failed',
          'sandbox_template_invalid',
          'sandbox_tenant_lock_held',
          'sandbox_already_loaded',
          'sandbox_epoch_stale',
          'sandbox_process_stopped',
          'pack_unknown',
          'no_published_sop',
        ].includes(candidate)
      )
        return candidate;
    }
    if (typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || /^E[A-Z_]{2,30}$/.test(code))) return code;
    e = cause;
  }
  return 'unknown';
}

function reportFailure(stage: 'provision' | 'expire', error: unknown): void {
  const code = failureCode(error);
  const text = stage === 'expire' ? '沙箱装载失败后标记到期也失败' : '沙箱开通失败';
  console.error(`[sandbox] ${text}（${code}）`);
  alert('store', `${text}（${code}）`, { instance: true, scope: `sandbox_${stage}:${code}` });
}

async function provision(o: ProvisionOptions): Promise<ProvisionedSandbox> {
  try {
    assertSandboxRunning();
    if ((await sandboxStartupRows(o.deps.db)).length >= 20) throw new SandboxProvisionError(429, 'sandbox_limited', 60);
    await o.admit?.();
    const template = await readSandboxTemplate(o.deps.db, o.templateSlug);
    const slug = `sbx-${[...randomBytes(20)].map((n) => 'abcdefghijklmnopqrstuvwxyz234567'[n & 31]).join('')}`;
    const token = randomBytes(32).toString('base64url');
    const created = await withNewSandboxTenant(
      o.deps.db,
      {
        slug,
        templateTenantId: template.tenantId,
        brand: publishedBrand(template.pub.renderInputs).brand,
        tokenHash: createHash('sha256').update(token).digest(),
        ip: o.ip,
        userAgent: o.userAgent,
      },
      async (tx, tenant) => {
        await writeTemplateConfig(tx, template.pub, template.items, o.deps.imageSop);
        if (template.privacy) await seedSandboxPrivacy(tx, template.privacy.body);
        await copyQuickReplies(tx, template.replies);
        const seeds = sandboxSeeds(tenant.expiresAt.getTime() - 24 * 60 * 60_000);
        await writeSeedSessions(tx, seeds.sessions, seeds.orders);
        await insertSandboxWechat(tx, randomBytes(32).toString('base64url'));
        await writeAudit(tx, {
          action: 'sandbox.create',
          diff: { sessions: seeds.sessions.length, orders: seeds.orders.length, items: template.items.length },
        });
        return tenant;
      },
      { epoch: o.epoch },
    );
    try {
      const rt = await loadSandboxRuntime(o.deps, { id: created.tenantId, slug, expiresAt: created.expiresAt }, o.host, o.acquireTenant);
      if (!rt) throw new Error('sandbox_tenant_lock_held');
    } catch (error) {
      reportFailure('provision', error);
      try {
        await expireBrokenSandbox(o.deps.db, created.tenantId);
      } catch (expireError) {
        reportFailure('expire', expireError);
      }
      throw new SandboxProvisionError(503, 'sandbox_unavailable', undefined, { cause: error });
    }
    return {
      ...created,
      slug,
      token,
      user: { userId: created.userId, tenantId: created.tenantId, role: 'owner', displayName: '体验访客' },
    };
  } catch (error) {
    if (error instanceof SandboxProvisionError) throw error;
    reportFailure('provision', error);
    throw new SandboxProvisionError(503, 'sandbox_unavailable', undefined, { cause: error });
  }
}
