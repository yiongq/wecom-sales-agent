// 部署 profile 与开关（docs/architecture/00-baseline/spec.md「部署 profile」「部署 profile 与开关」）。
// 全仓唯一读取 DEPLOY_PROFILE、FLAG_* 与旧变量 DEMO_FRESHEN 的地方。demo 的默认值就是演示实例现在的行为；
// prod 对每个开关硬封顶，环境变量放宽不了（03 起的租户设置也只能经 capFlags 生效）。
// 调用点在用到时读 profile().flags.<名字>，不在模块加载时拷进常量，自测才能在同一进程里切换 profile。
// 本模块不 import 任何业务模块：profile-boot 要排在 store 之前加载。

export type DeployProfileName = 'demo' | 'prod';

export interface DeployFlags {
  reset_command: boolean; // 「重置」口令
  anon_readonly_admin: boolean; // 后台匿名只读：种子会话 + 请求者本人的访客会话
  seed_freshen: boolean; // 种子演示数据的时间保鲜
  visitor_simulator: boolean; // 网页模拟器：匿名访客聊天、SSE 与 sim- 会话直读
  mock_pay: boolean; // 不带管理凭据也能调用的模拟支付
  ai_disclosure: 'always'; // AI 显式标识。00 只有这一个取值
}

export interface DeployProfile {
  readonly name: DeployProfileName;
  readonly flags: Readonly<DeployFlags>;
}

type BoolFlag = Exclude<keyof DeployFlags, 'ai_disclosure'>;

export const DEMO_DEFAULTS: Readonly<DeployFlags> = Object.freeze({
  reset_command: true,
  anon_readonly_admin: true,
  seed_freshen: true,
  visitor_simulator: true,
  mock_pay: true,
  ai_disclosure: 'always',
});

/** prod 下每个开关最宽能取到的值；prod 的默认值就是它 */
export const PROD_CEILING: Readonly<DeployFlags> = Object.freeze({
  reset_command: false,
  anon_readonly_admin: false,
  seed_freshen: false,
  visitor_simulator: false,
  mock_pay: false,
  ai_disclosure: 'always',
});

/** 布尔开关各自的环境变量，取值 on / off */
const FLAG_ENV: Readonly<Record<BoolFlag, string>> = Object.freeze({
  reset_command: 'FLAG_RESET_COMMAND',
  anon_readonly_admin: 'FLAG_ANON_READONLY_ADMIN',
  seed_freshen: 'FLAG_SEED_FRESHEN',
  visitor_simulator: 'FLAG_VISITOR_SIMULATOR',
  mock_pay: 'FLAG_MOCK_PAY',
});
const BOOL_FLAGS = Object.keys(FLAG_ENV) as BoolFlag[];

/** 本模块读的全部 profile 变量。自测与 eval 在加载业务模块之前把它们钉住（见 selftest-env.ts） */
export const PROFILE_ENV_NAMES: readonly string[] = ['DEPLOY_PROFILE', ...Object.values(FLAG_ENV), 'FLAG_AI_DISCLOSURE', 'DEMO_FRESHEN'];

/** 配了其中任何一个，就是要接真实企微客户的实例（与 deploy.sh 查旁路实例的是同一组） */
const WECOM_CREDENTIAL_ENV: readonly string[] = ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID'];

export class ProfileConfigError extends Error {}

/**
 * 从环境变量解析。空串一律当未设置。
 * 遇到非法值、prod 下越过封顶、DEMO_FRESHEN=0 与 FLAG_SEED_FRESHEN=on 同时出现、配了企微凭据却没设 DEPLOY_PROFILE，抛 ProfileConfigError。
 * prod 下试图放宽开关是启动失败而不是静默压回去：静默忽略会让人以为开关是开着的
 */
export function resolveProfile(env: Readonly<Record<string, string | undefined>>): DeployProfile {
  const get = (k: string): string | undefined => (env[k] === '' ? undefined : env[k]);
  // 要接真实客户的实例，profile 不能靠缺省值猜：没设就按 demo 跑，会开着匿名只读、「重置」与模拟支付（00 开放问题 1，2026-09-26 定）
  const credential = WECOM_CREDENTIAL_ENV.find((k) => get(k) !== undefined);
  if (get('DEPLOY_PROFILE') === undefined && credential) {
    throw new ProfileConfigError(`配了企微凭据（${credential}）就必须显式设置 DEPLOY_PROFILE=demo 或 DEPLOY_PROFILE=prod`);
  }
  const name = get('DEPLOY_PROFILE') ?? 'demo';
  if (name !== 'demo' && name !== 'prod') throw new ProfileConfigError(`DEPLOY_PROFILE=${name} 不合法，只能是 demo 或 prod`);
  const requested: Partial<DeployFlags> = {};
  for (const flag of BOOL_FLAGS) {
    const key = FLAG_ENV[flag];
    const v = get(key);
    if (v === undefined) continue;
    if (v !== 'on' && v !== 'off') throw new ProfileConfigError(`${key}=${v} 不合法，只能是 on 或 off`);
    if (name === 'prod' && v === 'on' && !PROD_CEILING[flag]) throw new ProfileConfigError(`prod 下 ${key} 不能设成 on`);
    requested[flag] = v === 'on';
  }
  const disclosure = get('FLAG_AI_DISCLOSURE');
  if (disclosure !== undefined && disclosure !== 'always') {
    throw new ProfileConfigError(`FLAG_AI_DISCLOSURE=${disclosure} 不合法，只能是 always`);
  }
  // 旧变量：0 等价于 FLAG_SEED_FRESHEN=off，其他值照旧忽略。现网 .env 里的这一项不用改
  if (get('DEMO_FRESHEN') === '0') {
    if (requested.seed_freshen === true) throw new ProfileConfigError('DEMO_FRESHEN=0 与 FLAG_SEED_FRESHEN=on 冲突');
    requested.seed_freshen = false;
  }
  return Object.freeze({ name, flags: Object.freeze(capFlags(name, requested)) });
}

/** 把请求的开关值压进 profile 允许的范围。租户设置（03）只能经由它生效。布尔开关 false 比 true 严 */
export function capFlags(name: DeployProfileName, requested: Partial<DeployFlags>): DeployFlags {
  const flags: DeployFlags = { ...(name === 'demo' ? DEMO_DEFAULTS : PROD_CEILING) };
  for (const k of BOOL_FLAGS) {
    const want = requested[k];
    if (want === undefined) continue;
    flags[k] = name === 'demo' ? want : want && PROD_CEILING[k];
  }
  return flags;
}

let current: DeployProfile | null = null;

/** 当前进程的 profile：首次调用时解析 process.env，之后缓存 */
export function profile(): DeployProfile {
  return (current ??= resolveProfile(process.env));
}

/** 仅供自测：在同一进程里切换 profile。用完调 reset()，下一次 profile() 重新解析 process.env */
export const __profileTest = {
  use(env: Record<string, string | undefined>): void {
    current = resolveProfile(env);
  },
  reset(): void {
    current = null;
  },
};
