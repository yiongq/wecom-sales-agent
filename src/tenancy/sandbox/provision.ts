// 05 第 14 步：HTTP / cookie 之外的开通核心。第 15 步直接调用，只有成功装载才交出登录令牌。
import { createHash, randomBytes } from 'node:crypto';
import { ConfigStartupError, imageSopOf, packSources, type ConfigDeps } from '../../config/source.js';
import { publishedBrand, publishedPolicy } from '../../config/hashes.js';
import { writeTemplateConfig } from '../../config/transfer.js';
import { writeSeedSessions } from '../../cli/session-transfer.js';
import { withNewSandboxTenant, type NewSandboxTenant, type TenantLock } from '../../db/client.js';
import { expireBrokenSandbox, sandboxStartupRows, sandboxPoolHealth } from '../../db/sandbox-process.js';
import { writeAudit } from '../../db/repo/audit.js';
import { readSandboxTemplate, insertSandboxWechat, seedSandboxPrivacy } from '../../db/repo/sandbox.js';
import { copyQuickReplies } from '../../db/repo/quick-replies.js';
import { copyKbSnapshot } from '../../db/repo/kb.js';
import { alert } from '../../ops/alert.js';
import { SessionStoreStartupError } from '../../store/backend.js';
import { withoutTenantScope } from '../runtime.js';
import { assertSandboxRunning } from './lifecycle.js';
import { loadSandboxRuntime } from './load.js';
import { sandboxSeeds, type SeedContext } from './seeds.js';
import { assertSandboxProvisionAllowed, recordSandboxProvision, sandboxWriteLimits, SandboxLimitError } from './limits.js';
import { initializeSandboxPool, sandboxPoolAvailable, notifySandboxProvisionLimited } from './budget.js';
import { todayIso } from '../../env.js';
import { runtimeById } from '../../packs/registry.js';
import { paymentMode } from '../../payment/mode.js';

// 实例互斥链：包括判限额、读快照、提交与预载；失败不能毒化下一次开通。
let provisioning: Promise<void> = Promise.resolve();

export class SandboxProvisionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly reason: 'sandbox_limited' | 'sandbox_unavailable',
    readonly retryAfter?: number,
    options?: ErrorOptions,
    readonly scope?: 'pool' | 'ip',
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
  env?: NodeJS.ProcessEnv;
  /** 第 20 步在锁内接池预算；拒绝时尚未提交开通计数。 */
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
          'sandbox_template_catalog_limit',
          'sandbox_template_quick_replies_limit',
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

/**
 * 07 R21：种子里的退款要按沙箱里已发布的 policy 与品牌算（开通复制的就是模板这一份），支付模式取进程的收款开关。
 * 包没有退款能力（没有 policy 或没有退款文字）就不给，G01 不生成。
 */
function seedContext(pub: Parameters<typeof publishedPolicy>[1] & { packId: string }, today: string): SeedContext {
  const runtime = runtimeById(pub.packId, packSources());
  const words = runtime?.engineHooks.refund;
  if (!runtime?.policy || !words) return { today, refund: null };
  const pack = runtime.policy;
  const { policy, policyHash } = publishedPolicy(pack, pub);
  const terms = pack.refund(policy);
  if (!terms) return { today, refund: null };
  return {
    today,
    refund: {
      terms,
      policy,
      policyHash,
      brand: publishedBrand(pub.renderInputs).brand,
      paymentMode: paymentMode(),
      words,
      clauseTitle: (tierId) => pack.clauses(policy).find((c) => c.id === tierId)?.title ?? '退改条款',
    },
  };
}

async function provision(o: ProvisionOptions): Promise<ProvisionedSandbox> {
  try {
    assertSandboxRunning();
    await initializeSandboxPool(o.deps.db, o.env);
    const [live, pool] = await Promise.all([sandboxStartupRows(o.deps.db), sandboxPoolHealth(o.deps.db)]);
    assertSandboxProvisionAllowed({ live: live.length, provisioned: pool.provisioned, day: pool.day, ip: o.ip }, o.env);
    if (!sandboxPoolAvailable()) throw new SandboxProvisionError(503, 'sandbox_unavailable');
    await o.admit?.();
    const template = await readSandboxTemplate(o.deps.db, o.templateSlug);
    const limits = sandboxWriteLimits(o.env);
    // 模板过大是部署配置问题；保留完整快照，拒绝开通而不是截断复制。
    if (template.items.length > limits.catalogItems) throw new Error('sandbox_template_catalog_limit');
    if (template.replies.length > limits.quickReplies) throw new Error('sandbox_template_quick_replies_limit');
    const slug = `sbx-${[...randomBytes(20)].map((n) => 'abcdefghijklmnopqrstuvwxyz234567'[n & 31]).join('')}`;
    const token = randomBytes(32).toString('base64url');
    let provisionDay = todayIso();
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
        // 08 R10：镜像按模板租户的包取，不把旅游文本喂给非旅游模板
        await writeTemplateConfig(tx, template.pub, template.items, imageSopOf(o.deps, template.pub.packId));
        if (template.privacy) await seedSandboxPrivacy(tx, template.privacy.body);
        await copyQuickReplies(tx, template.replies);
        // 07 R13：块与向量跟着同一个只读快照走，开通不发嵌入请求
        await copyKbSnapshot(tx, template.kb);
        const seedAt = tenant.expiresAt.getTime() - 24 * 60 * 60_000;
        const seeds = sandboxSeeds(seedAt, seedContext(template.pub, todayIso(new Date(seedAt))));
        await writeSeedSessions(tx, seeds.sessions, seeds.orders);
        await insertSandboxWechat(tx, randomBytes(32).toString('base64url'));
        await writeAudit(tx, {
          action: 'sandbox.create',
          diff: { sessions: seeds.sessions.length, orders: seeds.orders.length, items: template.items.length },
        });
        return tenant;
      },
      {
        epoch: o.epoch,
        beforeCreate: async (tx, day) => {
          provisionDay = day;
          const current = await sandboxPoolHealth(tx, day);
          assertSandboxProvisionAllowed({ live: live.length, provisioned: current.provisioned, day, ip: o.ip }, o.env);
          if (!sandboxPoolAvailable()) throw new SandboxProvisionError(503, 'sandbox_unavailable');
        },
      },
    );
    recordSandboxProvision(o.ip, provisionDay);
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
    if (error instanceof SandboxLimitError) {
      if (error.global) notifySandboxProvisionLimited();
      throw new SandboxProvisionError(429, 'sandbox_limited', error.retryAfter, undefined, error.global ? 'pool' : 'ip');
    }
    if (error instanceof SandboxProvisionError) throw error;
    reportFailure('provision', error);
    throw new SandboxProvisionError(503, 'sandbox_unavailable', undefined, { cause: error });
  }
}
