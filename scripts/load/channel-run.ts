// 03 plan 第 19 步「压测」的驱动脚本。不进 pnpm test，不调真实模型，不连任何外部服务。
//
// 两组对比（spec「测试与 CI · 压测」、验收 24）：
//   基线组：开工提交 5b697c2（02，env 账号、文件存储）；50 个客户都走这一个账号。
//   03 组：本 worktree（库里的两个企微账号）；两个账号各 25 个客户。
// 两组用的是同一份场景驱动代码（channel-scenario.ts + channel-fake-upstream.ts）：本脚本会把这两个文件原样
// 复制到目标仓库的 scripts/load/ 下再把目标服务起成子进程（cwd=目标仓库），驱动与假企微、假模型都在这个脚本/
// 被复制的文件里，不改一行目标仓库的产品代码。
//
// 跑法（各跑 3 遍，每遍全新一次性 PG 容器）：
//   LOAD_MODE=baseline LOAD_TARGET_REPO=/path/to/load-base-worktree LOAD_REPEATS=3 npx tsx scripts/load/channel-run.ts
//   LOAD_MODE=channels                                              LOAD_REPEATS=3 npx tsx scripts/load/channel-run.ts
// 可用环境变量先小规模跑通：LOAD_CUSTOMERS_PER_ACCOUNT=3 LOAD_TURNS=2
// 结果（含每遍原始数字与中位数）写到 LOAD_OUT_FILE（默认 scratchpad 下 channel-run-<mode>.json），同时打印到 stdout。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHANNEL_KEY_ENV } from '../../src/channels/secrets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

const MODE: 'channels' | 'baseline' =
  process.env.LOAD_MODE === 'channels'
    ? 'channels'
    : process.env.LOAD_MODE === 'baseline'
      ? 'baseline'
      : (() => {
          throw new Error('设 LOAD_MODE=baseline 或 LOAD_MODE=channels');
        })();

const TARGET_REPO = path.resolve(process.env.LOAD_TARGET_REPO ?? REPO_ROOT);
if (MODE === 'baseline' && TARGET_REPO === REPO_ROOT) {
  throw new Error('baseline 组要指定 LOAD_TARGET_REPO 指向开工提交 5b697c2 的只读 worktree');
}

const PER_ACCOUNT = Number(process.env.LOAD_CUSTOMERS_PER_ACCOUNT ?? 25);
// 03 组固定两个企微账号（spec 原文「两个客服账号各 25 个客户」）；baseline 组只有一个 env 账号，
// 要扛下两组相同的总客户数，所以按账号数折算（见 runOneRepeat 里的 scnPerAccount）
const CHANNELS_ACCOUNT_COUNT = 2;
const TURNS = Number(process.env.LOAD_TURNS ?? 10);
const SEED = Number(process.env.LOAD_SEED ?? 20261009);
const REPEATS = Number(process.env.LOAD_REPEATS ?? 1);
const HTTP_PORT = Number(process.env.LOAD_PORT ?? 38622);
const LLM_HOST = 'llm.fake.invalid';
const PG_CONTAINER = process.env.LOAD_PG_CONTAINER ?? 'pgload-03s19';
const PG_PORT = Number(process.env.LOAD_PG_PORT ?? 55438);
const PG_PW = 'pgload';
const OWNER_URL = `postgres://agent_owner:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
const PLATFORM_URL = `postgres://agent_platform:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
const APP_URL = `postgres://agent_app:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
const CHAT_TENANT = process.env.LOAD_CHAT_TENANT ?? 'load03';

const SCRATCH = process.env.LOAD_SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-channel-load-'));
fs.mkdirSync(SCRATCH, { recursive: true });
const OUT_FILE = process.env.LOAD_OUT_FILE ?? path.join(SCRATCH, `channel-run-${MODE}.json`);
console.log(`[channel-run] 分组=${MODE} 目标仓库=${TARGET_REPO} 临时目录=${SCRATCH}`);

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; input?: string; stdio?: 'inherit' } = {},
): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    killSignal: 'SIGKILL',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    stdio: opts.stdio,
  });
}

function mustOk(r: SpawnSyncReturns<string>, label: string): void {
  if (r.error) throw new Error(`${label} 没跑起来：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${label} 失败（退出码 ${r.status}）\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`);
  }
}

// ==================== PG 一次性容器（每遍都全新：跑之前强制清掉重建，跑完强制删除） ====================

function ensurePgFresh(): void {
  sh('docker', ['rm', '-f', PG_CONTAINER], { timeoutMs: 20_000 });
  const r = sh(
    'docker',
    ['run', '-d', '--name', PG_CONTAINER, '-e', `POSTGRES_PASSWORD=${PG_PW}`, '-p', `127.0.0.1:${PG_PORT}:5432`, 'pgvector/pgvector:pg17'],
    { timeoutMs: 30_000 },
  );
  mustOk(r, 'docker run pgload-03s19');
  for (let i = 0; i < 60; i++) {
    const ready = sh('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'postgres'], { timeoutMs: 5_000 });
    if (ready.status === 0) {
      console.log(`[channel-run] 一次性容器 ${PG_CONTAINER}（端口 ${PG_PORT}）就绪`);
      return;
    }
    sh('sleep', ['1']);
  }
  throw new Error(`${PG_CONTAINER} 一直没 ready`);
}

function teardownPg(): void {
  sh('docker', ['rm', '-f', PG_CONTAINER], { timeoutMs: 20_000 });
  console.log(`[channel-run] 一次性容器 ${PG_CONTAINER} 已删除`);
}

function ensureRoles(): void {
  const sqlPath = path.join(REPO_ROOT, 'deploy', 'db-init', 'roles.sql');
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      `owner_password=${PG_PW}`,
      '-v',
      `app_password=${PG_PW}`,
      '-v',
      `platform_password=${PG_PW}`,
      '-v',
      'db_name=agent',
    ],
    { input: fs.readFileSync(sqlPath, 'utf8'), encoding: 'utf8', timeout: 30_000 },
  );
  mustOk(r, 'roles.sql');
  console.log('[channel-run] 角色与库建好');
}

function ensureMigrated(): void {
  // 03 的迁移只在 03（本 worktree）跑；baseline 组不建渠道层的表，产品代码本来就不用它们
  const r = sh('npx', ['tsx', 'src/db/migrate.ts'], { cwd: REPO_ROOT, env: { DATABASE_OWNER_URL: OWNER_URL }, timeoutMs: 60_000 });
  mustOk(r, 'migrate');
  console.log('[channel-run] 迁移完成');
}

function ensureTenant(slug: string, name: string): void {
  const r = sh('npx', ['tsx', 'src/cli/tenant-create.ts', '--slug', slug, '--name', name, '--pack', 'travel'], {
    cwd: REPO_ROOT,
    env: { DATABASE_PLATFORM_URL: PLATFORM_URL, DEPLOY_PROFILE: 'demo' },
    timeoutMs: 30_000,
  });
  mustOk(r, `tenant-create ${slug}`);
  console.log(`[channel-run] 租户 ${slug} 就绪`);
}

function ensureConfig(slug: string): void {
  const r = sh('npx', ['tsx', 'src/cli/import-config.ts', '--tenant', slug], {
    cwd: REPO_ROOT,
    env: { DATABASE_URL: APP_URL },
    timeoutMs: 30_000,
  });
  mustOk(r, `import-config ${slug}`);
  console.log(`[channel-run] 配置已导入 ${slug}`);
}

/** 建一个企微客服账号（03 的 channel-account.ts add-wecom），返回库里的账号 id（uuid） */
function addWecomAccount(key: string, name: string, corpId: string, openKfId: string, channelKey: string): string {
  const secretsFile = path.join(SCRATCH, `secrets-${key}.json`);
  fs.writeFileSync(
    secretsFile,
    JSON.stringify({
      corpId,
      openKfId,
      appSecret: `loadtest-secret-${key}`,
      callbackToken: `loadtest-cbtoken-${key}`,
      callbackAesKey: `loadtest-cbaeskey-${key}`,
    }),
  );
  fs.chmodSync(secretsFile, 0o600);
  const r = sh(
    'npx',
    [
      'tsx',
      'src/cli/channel-account.ts',
      'add-wecom',
      '--tenant',
      CHAT_TENANT,
      '--key',
      key,
      '--name',
      name,
      '--secrets-file',
      secretsFile,
    ],
    { cwd: REPO_ROOT, env: { DATABASE_URL: APP_URL, [CHANNEL_KEY_ENV]: channelKey }, timeoutMs: 20_000 },
  );
  mustOk(r, `channel-account add-wecom ${key}`);
  console.log(`[channel-run] 企微账号 ${key} 已建`);
  const q = sh(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-At', '-U', 'postgres', '-d', 'agent', '-c', `select id from channel_accounts where key='${key}'`],
    {
      timeoutMs: 10_000,
    },
  );
  mustOk(q, `查询账号 id ${key}`);
  const id = q.stdout.trim();
  if (!id) throw new Error(`没查到账号 ${key} 的 id`);
  return id;
}

// ==================== 把场景驱动文件复制到目标仓库（两组跑的是同一份代码） ====================

function copyScenarioFiles(): void {
  for (const f of ['channel-scenario.ts', 'channel-fake-upstream.ts']) {
    const src = path.join(HERE, f);
    const dst = path.join(TARGET_REPO, 'scripts', 'load', f);
    if (path.resolve(src) === path.resolve(dst)) continue; // 03 组：目标仓库就是本 worktree，本来就是同一个文件
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`[channel-run] 已把 ${f} 复制到 ${TARGET_REPO}/scripts/load/`);
  }
}

// ==================== 跑一遍场景（子进程，cwd=目标仓库） ====================

interface ScenarioOut {
  mode: string;
  totalCustomers: number;
  turns: number;
  issues: string[];
  duplicateMsgids: string[];
  totalMessages: number;
  totalMatchedReplies: number;
  latenciesMs: number[];
  p50: number;
  p95: number;
  p99: number;
}

function runOneRepeat(repeatIdx: number): ScenarioOut {
  console.log(`[channel-run] === ${MODE} 第 ${repeatIdx + 1}/${REPEATS} 遍 ===`);
  ensurePgFresh();
  try {
    let accounts: { id?: string; openKfId: string }[];
    const varDir = fs.mkdtempSync(path.join(SCRATCH, `var-${MODE}-${repeatIdx}-`));
    const baseEnv: Record<string, string> = {
      DEPLOY_PROFILE: 'demo',
      VAR_DIR: varDir,
      PORT: String(HTTP_PORT),
      PUBLIC_BASE_URL: '',
      LLM_MOCK: '0',
      LLM_PROVIDER: '',
      LLM_BASE_URL: `http://${LLM_HOST}/v1`,
      LLM_API_KEY: 'loadtest-fake-key',
      LLM_MODEL: 'glm-5.3-flashx',
      EMBED_BASE_URL: `http://${LLM_HOST}/v1`,
      EMBED_API_KEY: 'loadtest-fake-key',
      LLM_HEDGE_MODEL: '',
      LLM_HEDGE_MS: '',
      FOLLOWUP_ENABLED: '',
      ALERT_WEBHOOK_URL: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    };

    if (MODE === 'baseline') {
      accounts = [{ openKfId: 'loadtest-kf-env' }];
      Object.assign(baseEnv, {
        CONFIG_SOURCE: '',
        SESSION_STORE: '',
        DATABASE_URL: '',
        WECOM_CORP_ID: 'loadtest-corp-env',
        WECOM_APP_SECRET: 'loadtest-secret-env',
        WECOM_KF_OPEN_KFID: 'loadtest-kf-env',
      });
    } else {
      ensureRoles();
      ensureMigrated();
      ensureTenant(CHAT_TENANT, '压测渠道层租户');
      ensureConfig(CHAT_TENANT);
      const channelKey = `k1:${randomBytes(32).toString('base64')}`;
      const idA = addWecomAccount('a1', '压测账号A', 'loadtest-corp-a', 'loadtest-kf-a', channelKey);
      const idB = addWecomAccount('a2', '压测账号B', 'loadtest-corp-b', 'loadtest-kf-b', channelKey);
      accounts = [
        { id: idA, openKfId: 'loadtest-kf-a' },
        { id: idB, openKfId: 'loadtest-kf-b' },
      ];
      Object.assign(baseEnv, {
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        DATABASE_URL: APP_URL,
        DEFAULT_TENANT_SLUG: CHAT_TENANT,
        [CHANNEL_KEY_ENV]: channelKey,
      });
    }

    copyScenarioFiles();

    const outFile = path.join(SCRATCH, `scenario-${MODE}-${repeatIdx}.json`);
    // 总客户数两组要相同（spec：「同样的 50 个客户」）：channels 组 2 个账号各 PER_ACCOUNT 个；baseline 组只有
    // 1 个账号，这一个账号要扛下两组的总数，所以这里按账号数折算每账号的客户数，而不是直接照搬 PER_ACCOUNT。
    const scnPerAccount = (PER_ACCOUNT * CHANNELS_ACCOUNT_COUNT) / accounts.length;
    const scnEnv: Record<string, string> = {
      ...baseEnv,
      SCN_MODE: MODE,
      SCN_ACCOUNTS: JSON.stringify(accounts),
      SCN_CUSTOMERS_PER_ACCOUNT: String(scnPerAccount),
      SCN_TURNS: String(TURNS),
      SCN_SEED: String(SEED),
      SCN_LLM_HOST: LLM_HOST,
      SCN_OUT_FILE: outFile,
    };
    const r = sh('npx', ['tsx', 'scripts/load/channel-scenario.ts'], {
      cwd: TARGET_REPO,
      env: scnEnv,
      timeoutMs: 1_800_000, // 安全网：正常情况下远用不到（10 轮 × 120 秒超时上限 = 20 分钟量级）
      stdio: 'inherit',
    });
    mustOk(r, 'channel-scenario.ts');
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as ScenarioOut;
  } finally {
    teardownPg();
  }
}

// ==================== 主流程：跑 REPEATS 遍，取中位数 ====================

function median(nums: readonly number[]): number {
  const s = [...nums].toSorted((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

async function main(): Promise<void> {
  const repeats: ScenarioOut[] = [];
  for (let i = 0; i < REPEATS; i++) repeats.push(runOneRepeat(i));

  const allIssues = repeats.flatMap((r, i) => r.issues.map((s) => `[遍 ${i + 1}] ${s}`));
  const allDup = repeats.flatMap((r) => r.duplicateMsgids);
  const p50s = repeats.map((r) => r.p50);
  const p95s = repeats.map((r) => r.p95);
  const p99s = repeats.map((r) => r.p99);

  const summary = {
    mode: MODE,
    targetRepo: TARGET_REPO,
    machine: `${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length} 核`,
    repeats: REPEATS,
    perAccount: PER_ACCOUNT,
    turns: TURNS,
    seed: SEED,
    correctnessOk: allIssues.length === 0 && allDup.length === 0,
    issues: allIssues,
    duplicateMsgids: allDup,
    perRepeat: repeats.map((r, i) => ({
      repeat: i + 1,
      totalCustomers: r.totalCustomers,
      totalMessages: r.totalMessages,
      totalMatchedReplies: r.totalMatchedReplies,
      p50: r.p50,
      p95: r.p95,
      p99: r.p99,
    })),
    medianP50: median(p50s),
    medianP95: median(p95s),
    medianP99: median(p99s),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  console.log(`[channel-run] 汇总结果写到 ${OUT_FILE}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error('[channel-run] 失败：', e);
    process.exit(1);
  },
);
