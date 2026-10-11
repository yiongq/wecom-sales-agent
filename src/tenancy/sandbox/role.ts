// 05 R16：只解析进程环境，不读取租户配置或凭据内容。
import { CHANNEL_KEY_ENV } from '../../channels/secrets.js';
import type { DeployFlags } from '../../profile.js';
import { normalizeHost } from '../hosts.js';

export type AppRole = 'host' | 'sandbox';
export class SandboxStartupError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export const SANDBOX_WECOM_NAMES = [
  'SANDBOX_WECOM_CORP_ID',
  'SANDBOX_WECOM_SECRET',
  'SANDBOX_WECOM_TOKEN',
  'SANDBOX_WECOM_AES_KEY',
  'SANDBOX_WECOM_OPEN_KFID',
] as const;

export function resolveRole(env: NodeJS.ProcessEnv): AppRole {
  const role = env.APP_ROLE ?? 'host';
  if (role !== 'host' && role !== 'sandbox') throw new SandboxStartupError('app_role_invalid');
  const present = (key: string) => env[key] !== undefined;
  if (role === 'host') {
    if (Object.keys(env).some((key) => key.startsWith('SANDBOX_WECOM_') && present(key)))
      throw new SandboxStartupError('sandbox_env_forbidden');
    return role;
  }
  if (
    Object.keys(env).some((key) => key.startsWith('WECOM_') && present(key)) ||
    [CHANNEL_KEY_ENV, 'NOTIFY_WEBHOOK_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'LLM_HEDGE_MODEL', 'DEFAULT_TENANT_SLUG'].some(present)
  )
    throw new SandboxStartupError('sandbox_env_forbidden');
  if (
    env.DEPLOY_PROFILE !== 'demo' ||
    env.CONFIG_SOURCE !== 'db' ||
    env.SESSION_STORE !== 'db' ||
    !env.SANDBOX_TEMPLATE_SLUG?.trim() ||
    !env.SANDBOX_HOST ||
    !normalizeHost(env.SANDBOX_HOST)
  )
    throw new SandboxStartupError('env_invalid');
  const configured = SANDBOX_WECOM_NAMES.filter((key) => !!env[key]?.trim()).length;
  if (configured !== 0 && configured !== SANDBOX_WECOM_NAMES.length) throw new SandboxStartupError('sandbox_wecom_partial');
  if (SANDBOX_WECOM_NAMES.some(present) && configured !== SANDBOX_WECOM_NAMES.length)
    throw new SandboxStartupError('sandbox_wecom_partial');
  return role;
}

export { sandboxFlags } from '../../profile.js';

/** 与 00 的基线日志分开；由 HTTP 监听成功后的组合根调用。 */
export function logRole(role: AppRole, flags: Readonly<DeployFlags>): void {
  const values = Object.entries(flags).map(([key, value]) => `${key}=${typeof value === 'boolean' ? (value ? 'on' : 'off') : value}`);
  console.log(`[role] ${role} · ${values.join(' ')}`);
}
