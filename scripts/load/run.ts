// 02 spec「压测」一节（plan 第 25 步）。本机真实 Postgres（一次性容器）、db 会话存储、假企微接口（照
// src/adapters/wecom.selftest.ts 的写法）、假模型（本机假服务，照 src/trace/trace.selftest.ts 的写法，
// 按 2–8 秒均匀分布延迟应答，可拉一段「429 风暴」）。不进 pnpm test，不调真实模型，不连任何外部服务。
//
// 跑法（两组对比，各跑一次，各自全新容器）：
//   NODE_OPTIONS=--expose-gc LOAD_FRESH_CONTAINER=1 LOAD_HEDGE=0 npx tsx scripts/load/run.ts   # 关对冲
//   NODE_OPTIONS=--expose-gc LOAD_FRESH_CONTAINER=1 LOAD_HEDGE=1 npx tsx scripts/load/run.ts   # 开对冲（.env.example 的推荐配置）
// 可用环境变量覆盖规模（默认即 spec 的数字），方便先小规模跑通再上全量：
//   LOAD_CUSTOMERS=50 LOAD_TURNS=10 LOAD_PRELOAD_SESSIONS=5000 LOAD_PRELOAD_MESSAGES=300
// LOAD_FRESH_CONTAINER=1：容器一次性（跑之前强制清掉同名旧容器重建，跑完强制删除），不与上一次复用、不留旧数据；
// 默认 0 时「已在跑就复用」，方便小规模反复调试脚本本身。LOAD_GROUP_LABEL 给结果打标签，默认按 LOAD_HEDGE 自动取名。
// 结果写到 scratchpad 的 results.json（给收尾时记「验收记录」用），同时打印到 stdout。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

// ---------------- 规模（环境变量可覆盖，默认即 spec 的数字） ----------------
const N_CUSTOMERS = Number(process.env.LOAD_CUSTOMERS ?? 50);
const N_TURNS = Number(process.env.LOAD_TURNS ?? 10);
const N_CONSOLE_SSE = Number(process.env.LOAD_SSE ?? 20);
const N_HANDOFF = Number(process.env.LOAD_HANDOFF ?? 5);
const N_ADVISOR_TAKEOVER = Number(process.env.LOAD_TAKEOVER ?? 2);
const PRELOAD_SESSIONS = Number(process.env.LOAD_PRELOAD_SESSIONS ?? 5000);
const PRELOAD_MESSAGES = Number(process.env.LOAD_PRELOAD_MESSAGES ?? 300);
const STORM_MS = Number(process.env.LOAD_STORM_MS ?? 60_000);
const STORM_AFTER_ROUND = Number(process.env.LOAD_STORM_AFTER_ROUND ?? 2); // 第几轮（0 起）结束后开始风暴
// 对冲：按 .env.example 推荐的线上演示配置（LLM_HEDGE_MODEL=glm-5.2、LLM_HEDGE_MS=4000），对冲模型走同一个假模型、
// 同样的延迟分布；LOAD_HEDGE=0（默认）跑生产默认关闭对冲的那组，=1 跑开对冲那组
const HEDGE_ON = process.env.LOAD_HEDGE === '1';
// 一次性容器：=1 时开跑前强制清掉同名容器重建、跑完强制删除（两组对比专用，不留旧数据）；
// 默认 0 走「已在跑就复用」的幂等逻辑（方便小规模反复调试脚本）
const FRESH_CONTAINER = process.env.LOAD_FRESH_CONTAINER === '1';
const GROUP_LABEL = process.env.LOAD_GROUP_LABEL ?? (HEDGE_ON ? 'hedge-on' : 'hedge-off');

// ---------------- 固定基础设施参数 ----------------
const PG_CONTAINER = 'pgload-02s25';
const PG_PORT = 55437;
const PG_PW = 'pgload';
const OWNER_URL = `postgres://agent_owner:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
const PLATFORM_URL = `postgres://agent_platform:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
const APP_URL = `postgres://agent_app:${PG_PW}@127.0.0.1:${PG_PORT}/agent`;
// 两个租户名可覆盖：小规模跑通性时用一次性的名字，不污染已经跑过全量数字的正式租户
const CHAT_TENANT = process.env.LOAD_CHAT_TENANT ?? 'loadtest';
const PRELOAD_TENANT = process.env.LOAD_PRELOAD_TENANT ?? 'loadtest-preload';
const HTTP_PORT = Number(process.env.LOAD_PORT ?? 38521);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const LLM_HOST = 'llm.fake.invalid';

const SCRATCH = process.env.LOAD_SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-load-'));
fs.mkdirSync(SCRATCH, { recursive: true });
console.log(`[load] 临时目录：${SCRATCH}`);

function sh(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number; input?: string } = {},
): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    killSignal: 'SIGKILL',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
  });
  return r;
}

function mustOk(r: SpawnSyncReturns<string>, label: string): void {
  if (r.error) throw new Error(`${label} 没跑起来：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${label} 失败（退出码 ${r.status}）\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
}

// ==================== 第一段：基础设施（容器、角色、迁移、租户、配置、账号） ====================

function dockerRunning(name: string): boolean {
  const r = sh('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function ensurePg(): void {
  if (FRESH_CONTAINER) {
    sh('docker', ['rm', '-f', PG_CONTAINER], { timeoutMs: 20_000 });
    console.log(`[load] 一次性容器模式：已清掉同名旧容器（若有），重新建`);
  }
  if (!FRESH_CONTAINER && dockerRunning(PG_CONTAINER)) {
    console.log(`[load] 复用已在跑的容器 ${PG_CONTAINER}`);
  } else {
    if (!FRESH_CONTAINER) sh('docker', ['rm', '-f', PG_CONTAINER], { timeoutMs: 20_000 }); // 容器存在但没跑：清掉重建
    const r = sh(
      'docker',
      [
        'run',
        '-d',
        '--name',
        PG_CONTAINER,
        '-e',
        `POSTGRES_PASSWORD=${PG_PW}`,
        '-p',
        `127.0.0.1:${PG_PORT}:5432`,
        'pgvector/pgvector:pg17',
      ],
      { timeoutMs: 30_000 },
    );
    mustOk(r, 'docker run pgload-02s25');
    console.log(`[load] 已起容器 ${PG_CONTAINER}（端口 ${PG_PORT}）`);
  }
  for (let i = 0; i < 60; i++) {
    const r = sh('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'postgres'], { timeoutMs: 5_000 });
    if (r.status === 0) return;
    sh('sleep', ['1']);
  }
  throw new Error('pgload-02s25 一直没 ready');
}

/** 一次性容器模式专用：跑完强制删除，不留着给下一组复用（两组互相污染不了对方的数据） */
function teardownPg(): void {
  if (!FRESH_CONTAINER) return;
  sh('docker', ['rm', '-f', PG_CONTAINER], { timeoutMs: 20_000 });
  console.log(`[load] 一次性容器 ${PG_CONTAINER} 已删除`);
}

function ensureRoles(): void {
  const check = sh('docker', [
    'exec',
    PG_CONTAINER,
    'psql',
    '-At',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-c',
    "select 1 from pg_roles where rolname='agent_owner'",
  ]);
  if (check.stdout.trim() === '1') {
    console.log('[load] 角色已存在，跳过 roles.sql');
    return;
  }
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
  console.log('[load] 角色与库建好');
}

function ensureMigrated(): void {
  const r = sh('npx', ['tsx', 'src/db/migrate.ts'], { env: { DATABASE_OWNER_URL: OWNER_URL }, timeoutMs: 60_000 });
  mustOk(r, 'migrate');
  console.log('[load] 迁移完成');
}

function ensureTenant(slug: string, name: string): void {
  const r = sh('npx', ['tsx', 'src/cli/tenant-create.ts', '--slug', slug, '--name', name, '--pack', 'travel'], {
    env: { DATABASE_PLATFORM_URL: PLATFORM_URL, DEPLOY_PROFILE: 'demo' },
    timeoutMs: 30_000,
  });
  // 退出码 0＝新建或已存在且字段相同；2＝已存在但字段不同，这里字段固定不会出现；其余非 0 都是真失败
  mustOk(r, `tenant-create ${slug}`);
  console.log(`[load] 租户 ${slug} 就绪：${r.stdout.trim()}`);
}

function ensureConfig(slug: string): void {
  const r = sh('npx', ['tsx', 'src/cli/import-config.ts', '--tenant', slug], { env: { DATABASE_URL: APP_URL }, timeoutMs: 30_000 });
  mustOk(r, `import-config ${slug}`);
  console.log(`[load] 配置已导入 ${slug}：${r.stdout.trim()}`);
}

function ensureUser(email: string, name: string, role: string): void {
  const r = sh(
    'npx',
    ['tsx', 'src/cli/user-create.ts', '--tenant', CHAT_TENANT, '--email', email, '--name', name, '--role', role, '--password-stdin'],
    {
      env: { DATABASE_PLATFORM_URL: PLATFORM_URL },
      input: `${CONSOLE_PASSWORD}\n`,
      timeoutMs: 20_000,
    },
  );
  // 0＝新建，已存在同角色也是 0；其余才是真问题
  mustOk(r, `user-create ${email}`);
  console.log(`[load] 账号就绪：${email}（${r.stdout.trim()}）`);
}

// 邮箱已存在时 user-create 不改口令（只加成员关系）：这几个账号在本机之前的手工探路里已经用这个口令建过，
// 定成同一个值，脚本重跑、手工建的账号都能登进去
const CONSOLE_PASSWORD = 'LoadTest123!';

// ==================== 第二段：预载压测（R2，独立子进程，量出「预载耗时」） ====================

interface PreloadResult {
  ok: boolean;
  preloadMs?: number;
  realSessions?: number;
  messages?: number;
  reason?: string;
}

function runPreloadMeasurement(varDir: string): PreloadResult {
  fs.mkdirSync(varDir, { recursive: true });
  const marker = path.join(varDir, 'sessions-in-db.json');
  if (!fs.existsSync(marker)) {
    console.log(`[load] 生成 ${PRELOAD_SESSIONS} 个会话 × ${PRELOAD_MESSAGES} 条消息的预载夹具`);
    const gen = sh(
      'npx',
      [
        'tsx',
        'scripts/load/gen-preload-fixtures.ts',
        '--sessions',
        String(PRELOAD_SESSIONS),
        '--messages',
        String(PRELOAD_MESSAGES),
        '--out',
        varDir,
      ],
      {
        timeoutMs: 600_000,
      },
    );
    mustOk(gen, 'gen-preload-fixtures');
    const keepDir = path.join(SCRATCH, 'preload-keep');
    const imp = sh('npx', ['tsx', 'src/cli/import-sessions.ts', '--tenant', PRELOAD_TENANT, '--keep', keepDir, '--var', varDir], {
      env: { DATABASE_URL: APP_URL },
      timeoutMs: 1_800_000,
    });
    mustOk(imp, 'import-sessions（预载夹具）');
    console.log(`[load] 预载夹具导入完成：${imp.stdout.trim()}`);
  } else {
    console.log('[load] 预载夹具已导入过（标记文件存在），直接测启动预载耗时');
  }
  const r = spawnSync('npx', ['tsx', 'scripts/load/preload-timer.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      CONFIG_SOURCE: 'db',
      DATABASE_URL: APP_URL,
      SESSION_STORE: 'db',
      DEFAULT_TENANT_SLUG: PRELOAD_TENANT,
      DEPLOY_PROFILE: 'demo',
      VAR_DIR: varDir,
    },
  });
  if (r.status !== 0) {
    return { ok: false, reason: `preload-timer 退出码 ${r.status}：${r.stdout}\n${r.stderr}` };
  }
  const line = r.stdout
    .trim()
    .split('\n')
    .findLast((l) => l.startsWith('{'));
  if (!line) return { ok: false, reason: `preload-timer 没有输出 JSON：${r.stdout}` };
  return JSON.parse(line) as PreloadResult;
}

// ==================== 第三段：压测场景（50×10、console SSE、转人工、429 风暴） ====================

/** 对冲计数的一次快照（累计值，snapshot 相减得到某个区间的增量） */
interface HedgeSnapshot {
  chatCalls: number;
  hedgeFired: number;
  hedgeWon: number;
  followupHedgeFired: number;
  followupHedgeWon: number;
}

/** 一轮的时间窗与延迟分布，外加这一轮期间的模型调用与对冲增量 */
interface RoundRecord {
  round: number;
  label: string;
  startedAt: number;
  endedAt: number;
  n: number;
  p50: number;
  p90: number;
  overlapsStorm: boolean;
  chatCallsDelta: number;
  hedgeFiredDelta: number;
  hedgeWonDelta: number;
  followupHedgeFiredDelta: number;
  followupHedgeWonDelta: number;
}

interface ScenarioResult {
  repliesOk: boolean;
  repliesDetail: string;
  duplicateSendGroups: number;
  handoffLatenciesMs: number[];
  writeLatenciesMs: number[];
  eventLoopLagMs: number[];
  rssBeforeMB: number;
  rssAfterMB: number;
  stormSurvived: boolean;
  recoveredWithin60s: boolean;
  recoveryDetail: string;
  roundTable: RoundRecord[];
  baselineP90: number;
  checkpointP90: number;
  hedgeByPhase: { before: HedgeSnapshot; during: HedgeSnapshot; after: HedgeSnapshot };
  dbMemoryMatch: boolean;
  dbMemoryDetail: string;
  memSessions: number;
  memMessages: number;
  llmStats: { chatCalls: number; chat429: number; chatOk: number; embedCalls: number };
}

function uidOf(i: number): string {
  return `wmlc${i}`;
}
function sessionIdOf(i: number): string {
  return `wecom:${uidOf(i)}`;
}

const ROUND_MESSAGES = [
  '你好，想了解一下云南的线路',
  '大概两个人，预算五千左右',
  '国庆假期出发可以吗',
  '有没有海边的推荐',
  '价格大概多少',
  '能发一下详细行程吗',
  '住宿是几星级酒店',
  '可以改签吗',
  '还有优惠吗',
  '好的，我再想想',
];
const EMERGENCY_TEXT = '证件好像丢了';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runScenario(): Promise<ScenarioResult> {
  const varDir = path.join(SCRATCH, 'chat-var');
  fs.mkdirSync(varDir, { recursive: true });

  // ---- 环境：必须在 import 任何业务模块之前设好（env.ts 只填充未设置的变量） ----
  process.env.CONFIG_SOURCE = 'db';
  process.env.DATABASE_URL = APP_URL;
  process.env.SESSION_STORE = 'db';
  process.env.DEFAULT_TENANT_SLUG = CHAT_TENANT;
  process.env.DEPLOY_PROFILE = 'demo';
  process.env.VAR_DIR = varDir;
  process.env.PORT = String(HTTP_PORT);
  process.env.WECOM_CORP_ID = 'loadtest-corp';
  process.env.WECOM_APP_SECRET = 'loadtest-secret';
  process.env.WECOM_KF_OPEN_KFID = 'loadtest-kf';
  process.env.PUBLIC_BASE_URL = '';
  process.env.LLM_MOCK = '0';
  process.env.LLM_PROVIDER = '';
  process.env.LLM_BASE_URL = `http://${LLM_HOST}/v1`;
  process.env.LLM_API_KEY = 'loadtest-fake-key';
  process.env.LLM_MODEL = 'glm-5.3-flashx';
  process.env.EMBED_BASE_URL = `http://${LLM_HOST}/v1`;
  process.env.EMBED_API_KEY = 'loadtest-fake-key';
  process.env.FOLLOWUP_ENABLED = '';
  process.env.ALERT_WEBHOOK_URL = '';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
  // 对冲：开着时对冲模型（glm-5.2）跟主模型（glm-5.3-flashx）走同一个假模型地址、同一套延迟分布与风暴逻辑——
  // fake-upstream 按 hostname 分流，不看 model 字段，不用另外写代码。LLM_HEDGE_MS_FOLLOWUP 留空按代码默认 2800
  if (HEDGE_ON) {
    process.env.LLM_HEDGE_MODEL = 'glm-5.2';
    process.env.LLM_HEDGE_MS = '4000';
  } else {
    process.env.LLM_HEDGE_MODEL = '';
    process.env.LLM_HEDGE_MS = '';
  }

  const { installFakeUpstream } = await import('./fake-upstream.js');
  const fake = installFakeUpstream({ llmHost: LLM_HOST });

  const { startEventLoopLagSampler, startWriteLatencySampler, percentile } = await import('./metrics.js');
  const elLag = startEventLoopLagSampler(50);
  const writeLat = startWriteLatencySampler();

  const { addListener: addEventTap } = await import('../../src/console-api/events.js');
  const commitSeenAt = new Map<string, number>();
  const offTap = addEventTap((b) => {
    if (b.event !== 'handoff') return;
    try {
      const d = JSON.parse(b.data) as { id: string };
      commitSeenAt.set(d.id, Date.now());
    } catch {
      /* 忽略解析失败 */
    }
  });

  console.log('[load] 启动真实 server.ts（db 存储、假企微、假模型）…');
  await import('../../src/server.js');
  await sleep(500); // 让 preflight / buildIndex 的同步部分先跑一下，不是必须，图个稳
  if (typeof global.gc === 'function') global.gc();
  const rssBefore = process.memoryUsage().rss;
  console.log(`[load] 启动完成，常驻内存 ${(rssBefore / 1024 / 1024).toFixed(1)}MB`);

  const { login, openEvents, takeover, humanReply } = await import('./console-client.js');
  const owner = await login(BASE, 'owner@loadtest.local', CONSOLE_PASSWORD);
  const agent1 = await login(BASE, 'agent1@loadtest.local', CONSOLE_PASSWORD);
  const agent2 = await login(BASE, 'agent2@loadtest.local', CONSOLE_PASSWORD);
  const pool = [owner, agent1, agent2];

  const sseLatencies: number[] = [];
  const conns = [];
  for (let i = 0; i < N_CONSOLE_SSE; i++) {
    const auth = pool[i % pool.length]!;
    // eslint-disable-next-line no-await-in-loop
    const conn = await openEvents(BASE, auth, (e) => {
      if (e.event !== 'handoff') return;
      try {
        const d = JSON.parse(e.data) as { id: string };
        const published = commitSeenAt.get(d.id);
        if (published !== undefined) sseLatencies.push(Math.max(0, e.receivedAt - published));
      } catch {
        /* 忽略 */
      }
    });
    conns.push(conn);
  }
  console.log(`[load] ${conns.length} 条 console SSE 连接已打开`);

  const { getSession } = await import('../../src/store.js');
  const { syncFromCallback, __test: wecomTest } = await import('../../src/adapters/wecom.js');
  const { llmStats } = await import('../../src/llm.js');

  const handoffIdx = Array.from({ length: N_HANDOFF }, (_, i) => i); // 前 N_HANDOFF 个客户触发转人工
  const takeoverIdx = handoffIdx.slice(0, N_ADVISOR_TAKEOVER); // 其中前 N_ADVISOR_TAKEOVER 个由顾问接手

  const roundIssues: string[] = [];
  let duplicateSendGroups = 0;
  let stormStartedAt = 0;
  let stormEndedAt = 0;
  let stormHandled = false;
  const roundTable: RoundRecord[] = [];

  const idle = async (timeoutMs: number): Promise<boolean> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!wecomTest.inspectForTest().busy) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    return !wecomTest.inspectForTest().busy;
  };

  /** 对冲与模型调用的累计快照：进程内计数器（llmStats 的 hedgeFired/Won、含 followup 那组）+ fake-upstream 自己数的总调用数 */
  const hedgeSnapshot = (): HedgeSnapshot => {
    const s = llmStats();
    return {
      chatCalls: fake.stats().chatCalls,
      hedgeFired: s.hedgeFired,
      hedgeWon: s.hedgeWon,
      followupHedgeFired: s.followupHedgeFired,
      followupHedgeWon: s.followupHedgeWon,
    };
  };

  /** 跑一轮：push 消息给 customers 这几个客户、等 idle、量每客户这一轮的延迟与对冲/模型调用增量 */
  const runRound = async (
    round: number,
    label: string,
    contentOf: (i: number) => string,
    customers: readonly number[],
  ): Promise<RoundRecord> => {
    const before = new Map(customers.map((i) => [i, fake.sentTo(uidOf(i)).length]));
    const h0 = hedgeSnapshot();
    const startedAt = Date.now();
    for (const i of customers) fake.pushCustomerMessage(uidOf(i), contentOf(i));
    await syncFromCallback(`load-${label}`);
    const ok = await idle(180_000);
    if (!ok) roundIssues.push(`${label} 180 秒内没有 idle`);
    const endedAt = Date.now();
    const h1 = hedgeSnapshot();
    const latencies: number[] = [];
    for (const i of customers) {
      const uid = uidOf(i);
      const after = fake.sentTo(uid).length;
      const delta = after - (before.get(i) ?? 0);
      const expectSilent = handoffIdx.includes(i) && round >= 1; // 转人工之后 AI 不再自动回；本轮(round===1)触发那一刻也不发 AI 回复
      if (delta > 1) {
        duplicateSendGroups += 1;
        roundIssues.push(`客户 ${uid} ${label} 收到 ${delta} 条回复（应 ≤ 1）`);
      } else if (delta === 1) {
        const last = fake.sentTo(uid).at(-1)!;
        latencies.push(Math.max(0, last.at - startedAt));
      } else if (!expectSilent) {
        const s = getSession(sessionIdOf(i));
        roundIssues.push(`客户 ${uid} ${label} 没有回复也不在预期的转人工静默里（handedOver=${s?.handedOver}）`);
      }
    }
    const overlapsStorm = stormHandled && startedAt < stormStartedAt + STORM_MS && endedAt > stormStartedAt;
    return {
      round,
      label,
      startedAt,
      endedAt,
      n: latencies.length,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      overlapsStorm,
      chatCallsDelta: h1.chatCalls - h0.chatCalls,
      hedgeFiredDelta: h1.hedgeFired - h0.hedgeFired,
      hedgeWonDelta: h1.hedgeWon - h0.hedgeWon,
      followupHedgeFiredDelta: h1.followupHedgeFired - h0.followupHedgeFired,
      followupHedgeWonDelta: h1.followupHedgeWon - h0.followupHedgeWon,
    };
  };

  const allCustomers = Array.from({ length: N_CUSTOMERS }, (_, i) => i);
  for (let r = 0; r < N_TURNS; r++) {
    const record = await runRound(
      r,
      `第 ${r} 轮`,
      (i) => (handoffIdx.includes(i) && r === 1 ? EMERGENCY_TEXT : ROUND_MESSAGES[r % ROUND_MESSAGES.length]!),
      allCustomers,
    );
    roundTable.push(record);

    if (r === STORM_AFTER_ROUND && !stormHandled) {
      stormHandled = true;
      fake.startStorm(STORM_MS);
      stormStartedAt = Date.now();
      stormEndedAt = stormStartedAt + STORM_MS;
      console.log(`[load] 第 ${r} 轮结束，开始 429 风暴（${STORM_MS}ms）`);
    }

    if (r === 1) {
      // 转人工应该已经发生；给写队列一点时间落库、SSE 一点时间送达，再让顾问接手+回复
      await sleep(1500);
      for (const i of takeoverIdx) {
        const sid = sessionIdOf(i);
        const advisor = i === takeoverIdx[0] ? agent1 : agent2;
        try {
          // eslint-disable-next-line no-await-in-loop
          await takeover(BASE, advisor, sid);
          // eslint-disable-next-line no-await-in-loop
          await humanReply(BASE, advisor, sid, '您好，我是人工顾问，已经看到您的情况，马上为您处理。', randomUUID());
        } catch (e) {
          roundIssues.push(`顾问接手/回复 ${sid} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  // ---- 风暴之后的「正常延迟」检查点：等到风暴结束满 60 秒（自然轮次已经拖过去了就立刻跑），单独跑一轮——
  // 这一轮按构造恰好是「风暴结束后 60 秒内开始的那一轮」，不依赖自然轮次边界刚好落在这个窗口里 ----
  const checkpointWaitUntil = stormEndedAt + 60_000;
  const naturalLatenessMs = Date.now() - checkpointWaitUntil; // >0：自然轮次已经把时间拖过了这个点，这一轮晚于「60 秒内」
  console.log(
    `[load] 全部 ${N_TURNS} 轮跑完，${naturalLatenessMs > 0 ? '已经过了风暴结束+60秒的检查点' : '等到风暴结束+60秒的检查点'}再跑检查点轮…`,
  );
  await sleep(Math.max(0, checkpointWaitUntil - Date.now()));
  const nonHandoffCustomers = allCustomers.filter((i) => !handoffIdx.includes(i));
  const checkpoint = await runRound(
    N_TURNS,
    '风暴后检查点轮',
    () => `[复测] ${ROUND_MESSAGES[N_TURNS % ROUND_MESSAGES.length]}`,
    nonHandoffCustomers,
  );
  roundTable.push(checkpoint);

  const steadyRounds = roundTable.filter((rr) => rr.round >= 1 && rr.round <= STORM_AFTER_ROUND);
  const baselineP90 = Math.max(0, ...steadyRounds.map((rr) => rr.p90));
  const checkpointP90 = checkpoint.p90;
  const recoveredWithin60s = checkpoint.n > 0 && checkpointP90 <= baselineP90 * 1.1;
  const recoveryDetail =
    `基线（第 ${steadyRounds.map((rr) => rr.round).join('、')} 轮，风暴之前稳态、不含第 0 轮冷启动）P90 的最大值 = ${baselineP90}ms；` +
    `检查点轮（${naturalLatenessMs > 0 ? `风暴结束 ${naturalLatenessMs}ms 后才排上（自然轮次已经拖过 60 秒线）` : '风暴结束满 60 秒时'}开始，` +
    `样本 ${checkpoint.n}/${nonHandoffCustomers.length}）P90 = ${checkpointP90}ms；判定阈值基线 × 1.1 = ${(baselineP90 * 1.1).toFixed(0)}ms → ${recoveredWithin60s ? '通过' : '不通过'}`;

  const sumHedge = (rounds: readonly RoundRecord[]): HedgeSnapshot => ({
    chatCalls: rounds.reduce((n, rr) => n + rr.chatCallsDelta, 0),
    hedgeFired: rounds.reduce((n, rr) => n + rr.hedgeFiredDelta, 0),
    hedgeWon: rounds.reduce((n, rr) => n + rr.hedgeWonDelta, 0),
    followupHedgeFired: rounds.reduce((n, rr) => n + rr.followupHedgeFiredDelta, 0),
    followupHedgeWon: rounds.reduce((n, rr) => n + rr.followupHedgeWonDelta, 0),
  });
  const hedgeByPhase = {
    before: sumHedge(roundTable.filter((rr) => rr.round <= STORM_AFTER_ROUND)),
    during: sumHedge(roundTable.filter((rr) => rr.overlapsStorm)),
    after: sumHedge(roundTable.filter((rr) => rr.round > STORM_AFTER_ROUND && !rr.overlapsStorm)),
  };

  // ---- 落库一致性：先等全部写队列落完，再用另一个独立子进程重新从库预载一遍，比对会话数与消息数 ----
  const { flushSession, listSessions, isDemoClassId } = await import('../../src/store.js');
  for (let i = 0; i < N_CUSTOMERS; i++) {
    // eslint-disable-next-line no-await-in-loop
    await flushSession(sessionIdOf(i), { timeoutMs: 10_000 }).catch(() => undefined);
  }
  await sleep(500);
  const memReal = listSessions().filter((s) => !isDemoClassId(s.id));
  const memMessages = memReal.reduce((n, s) => n + (Array.isArray(s.messages) ? s.messages.length : 0), 0);

  if (typeof global.gc === 'function') global.gc();
  const rssAfter = process.memoryUsage().rss;

  const llmStatsFinal = fake.stats();
  const stormSurvived = true; // 进程走到这里还活着，没崩

  elLag.stop();
  writeLat.stop();
  offTap();
  for (const c of conns) c.close();

  console.log('[load] 走三段停机钩子（释放租户锁、关连接池），不退出这个进程——后面还要在独立子进程里核对落库');
  // 直接跑停机钩子（不发信号、不退出进程）：释放租户锁、关 PG 连接池、停企微拉取，main() 之后要起的独立核对
  // 子进程得先等这把锁放开才能连上同一个租户
  const { runShutdownHooks } = await import('../../src/store.js');
  const drained = await runShutdownHooks();
  if (!drained) console.warn('[load] 停机钩子超时（spec 没把停机速度列进本步通过条件，继续往下跑独立核对）');

  return {
    repliesOk: roundIssues.length === 0,
    repliesDetail: roundIssues.length ? roundIssues.slice(0, 20).join('；') : '全部客户消息恰有一次回复或命中预期的转人工静默',
    duplicateSendGroups,
    handoffLatenciesMs: sseLatencies,
    writeLatenciesMs: writeLat.samples,
    eventLoopLagMs: elLag.samples,
    rssBeforeMB: rssBefore / 1024 / 1024,
    rssAfterMB: rssAfter / 1024 / 1024,
    stormSurvived,
    recoveredWithin60s,
    recoveryDetail,
    roundTable,
    baselineP90,
    checkpointP90,
    hedgeByPhase,
    dbMemoryMatch: true, // 占位，run() 里用独立子进程核对后回填
    dbMemoryDetail: `进程内存：${memReal.length} 个真实会话、${memMessages} 条消息（独立子进程核对见下）`,
    memSessions: memReal.length,
    memMessages,
    llmStats: llmStatsFinal,
  };
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  console.log(`[load] 分组：${GROUP_LABEL}（对冲 ${HEDGE_ON ? '开' : '关'}，一次性容器 ${FRESH_CONTAINER ? '是' : '否'}）`);
  try {
    ensurePg();
    ensureRoles();
    ensureMigrated();
    ensureTenant(CHAT_TENANT, '压测租户');
    ensureTenant(PRELOAD_TENANT, '压测预载租户');
    ensureConfig(CHAT_TENANT);
    ensureConfig(PRELOAD_TENANT);
    ensureUser('owner@loadtest.local', 'owner', 'owner');
    ensureUser('agent1@loadtest.local', 'agent1', 'agent');
    ensureUser('agent2@loadtest.local', 'agent2', 'agent');

    const preload = runPreloadMeasurement(process.env.LOAD_PRELOAD_VAR ?? path.join(SCRATCH, 'preload-var'));
    console.log('[load] 预载结果：', preload);

    const scenario = await runScenario();

    // 独立子进程重新预载聊天租户，核对「库里的消息数等于内存」——一次性容器下 loadtest 租户只有本次场景造的会话，
    // 两边都应该精确相等（不是「至少有」）
    const verify = spawnSync('npx', ['tsx', 'scripts/load/preload-timer.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CONFIG_SOURCE: 'db',
        DATABASE_URL: APP_URL,
        SESSION_STORE: 'db',
        DEFAULT_TENANT_SLUG: CHAT_TENANT,
        DEPLOY_PROFILE: 'demo',
        VAR_DIR: path.join(SCRATCH, 'chat-var'),
      },
    });
    let dbMemoryMatch = false;
    let dbMemoryDetail = `独立核对子进程退出码 ${verify.status}`;
    if (verify.status === 0) {
      const line = verify.stdout
        .trim()
        .split('\n')
        .findLast((l) => l.startsWith('{'));
      if (line) {
        const v = JSON.parse(line) as { realSessions: number; messages: number };
        dbMemoryDetail = `独立子进程从库重建：${v.realSessions} 个真实会话、${v.messages} 条消息（进程内存：${scenario.memSessions} 个、${scenario.memMessages} 条）`;
        dbMemoryMatch = v.realSessions === scenario.memSessions && v.messages === scenario.memMessages;
      }
    } else {
      dbMemoryDetail += `\n${verify.stdout}\n${verify.stderr}`;
    }
    scenario.dbMemoryMatch = dbMemoryMatch;
    scenario.dbMemoryDetail = dbMemoryDetail;

    const { percentile } = await import('./metrics.js');
    const rssGrowthPct = ((scenario.rssAfterMB - scenario.rssBeforeMB) / scenario.rssBeforeMB) * 100;
    const result = {
      group: GROUP_LABEL,
      hedgeOn: HEDGE_ON,
      machine: `${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length} 核`,
      preload,
      scenario: {
        ...scenario,
        handoffLatencyP99: percentile(scenario.handoffLatenciesMs, 99),
        writeLatencyP99: percentile(scenario.writeLatenciesMs, 99),
        eventLoopLagP99: percentile(scenario.eventLoopLagMs, 99),
        rssGrowthPct,
      },
    };
    const outFile = path.join(SCRATCH, 'results.json');
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`[load] 结果写到 ${outFile}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    teardownPg();
  }
}

main().then(
  () => process.exit(0), // server 的 HTTP 监听、企微兜底轮询等 ref'd 的定时器会让进程一直不退，main() 跑完就主动退出
  (e: unknown) => {
    console.error('[load] 失败：', e);
    process.exit(1);
  },
);
