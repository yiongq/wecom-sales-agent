// 第 21 步：一次完整 3 遍基线 / 3 遍沙箱对比。不进 pnpm test。
// 用法：PG_TEST_URL=<本机一次性库> LOAD_REPORT=<仓库外 JSON 文件> node --import tsx scripts/load/sandbox-run.ts
// --provision-only 只检查 20 次开通与 RSS，不跑对话与写压测。
// 总计约 7 分钟；不与其他套件并行。只在进程表受限且操作人已明确确认空闲时，才设 LOAD_IDLE_CONFIRMED=1。
// 每组独立进程，宿主 8 会话 × 5 轮；沙箱 20 × 5 轮 + 30 次/分钟配置写入，假模型固定等待 200ms。
// 等待口径是模型请求准备到 fetch（含并发闸）；写积压取宿主实时 lag 与最早 save→commit 的最大值。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { runMigrations } from '../../src/db/migrate.js';
import { openDb, holdTenantLock } from '../../src/db/client.js';
import { importConfig } from '../../src/config/transfer.js';
import { createTenantRuntime, withTenantScope } from '../../src/tenancy/runtime.js';

const provisionOnly = process.argv.includes('--provision-only');
const root = process.cwd();
const superUrl = process.env.PG_TEST_URL;
assert.ok(superUrl, '必须设置指向一次性 PG 的 PG_TEST_URL');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(superUrl).hostname), '压测只允许本机一次性 PG');
const median = (values: number[]) => {
  assert.ok(values.length);
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
if (!provisionOnly)
  try {
    const processTable = execFileSync('ps', ['-axo', 'pid=,pcpu=,comm='], { encoding: 'utf8', timeout: 5000 });
    const heavy = processTable.split('\n').filter((line) => {
      const m = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      return m && Number(m[1]) !== process.pid && Number(m[2]) >= 50;
    });
    assert.equal(heavy.length, 0, `发现重负载进程，拒绝压测：${heavy.join('; ')}`);
    console.log('压测前检查通过：没有 CPU ≥50% 的其他进程。');
  } catch (error) {
    if (error instanceof assert.AssertionError || process.env.LOAD_IDLE_CONFIRMED !== '1') throw error;
    console.log('进程表不可读；使用操作人明确确认的独占窗口。');
  }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-load-'));
const children = new Set<ChildProcess>();
function query(connection: string, sql: string): string {
  const u = new URL(connection);
  return execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-A', '-t'], {
    input: sql,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: u.pathname.slice(1),
    },
  }).trim();
}
const dbName = `sandbox_load_${randomBytes(6).toString('hex')}`;
const pw = { owner: randomBytes(16).toString('hex'), app: randomBytes(16).toString('hex'), platform: randomBytes(16).toString('hex') };
function url(user: string, password: string) {
  const u = new URL(superUrl!);
  u.username = user;
  u.password = password;
  u.pathname = `/${dbName}`;
  return u.href;
}
const appUrl = url('agent_app', pw.app);
const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LOAD_PROVISION_ONLY: provisionOnly ? '1' : '0',
  TZ: process.env.TZ ?? 'Asia/Shanghai',
  DEPLOY_PROFILE: 'demo',
  CONFIG_SOURCE: 'db',
  SESSION_STORE: 'db',
  DATABASE_URL: appUrl,
  SERVER_SELFTEST: '1',
  LLM_MOCK: '0',
  LLM_PROVIDER: 'default',
  LLM_API_KEY: 'fixture-model',
  LLM_MODEL: 'fixture-model',
  LLM_MODEL_CHEAP: 'fixture-model',
  LLM_BASE_URL: 'http://model.example.invalid',
  EMBED_API_KEY: '',
  ZHIPU_API_KEY: '',
  LLM_MAX_RETRY: '0',
  PUBLIC_BASE_URL: 'https://host.example.invalid',
  ALERT_WEBHOOK_URL: '',
  DEMO_PRUNE_HOURS: '0',
  SANDBOX_HOST: 'sandbox.example.invalid',
  SANDBOX_TEMPLATE_SLUG: 'template',
  SANDBOX_PER_HOUR: '100',
  SANDBOX_PER_IP_DAY: '100',
  SANDBOX_PER_DAY: '100',
  SANDBOX_LLM_CNY: '100',
  SANDBOX_POOL_DAILY_CNY: '1000',
};
type Ready = { type: 'ready'; idleRssMB?: number; loadedRssMB?: number; provisionMs?: number[] };
type Result = {
  type: 'result';
  waits: number[];
  writes: number[];
  maxLagMs: number;
  modelCalls: number;
  acceptedWrites: number;
  limitedWrites: number;
  rssMB: number;
};
function worker(role: 'host' | 'sandbox', iteration: number) {
  const log = fs.openSync(path.join(scratch, `${role}-${iteration}.log`), 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/load/sandbox-worker.ts'], {
    cwd: root,
    env: {
      ...baseEnv,
      APP_ROLE: role,
      LLM_MAX_INFLIGHT: role === 'host' ? '8' : '2',
      ...(role === 'host' ? { DEFAULT_TENANT_SLUG: 'template' } : {}),
      VAR_DIR: path.join(scratch, `${role}-${iteration}`),
    },
    stdio: ['ignore', log, log, 'ipc'],
  });
  fs.closeSync(log);
  children.add(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  let readyResolve!: (r: Ready) => void, resultResolve!: (r: Result) => void;
  let readyReject!: (e: Error) => void, resultReject!: (e: Error) => void;
  let receivedReady = false,
    receivedResult = false;
  const ready = new Promise<Ready>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<Result>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  // ready 失败时 result 也被拒，调用方可能还没进入等待。
  void result.catch(() => {});
  child.on('message', (m: Ready | Result) => {
    if (m.type === 'ready') {
      receivedReady = true;
      readyResolve(m);
    } else if (m.type === 'result') {
      receivedResult = true;
      resultResolve(m);
    }
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      readyReject(error);
      resultReject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0 && receivedReady && receivedResult) resolve();
      else {
        const error = new Error(
          `${role} 退出 ${code ?? signal}：${fs.readFileSync(path.join(scratch, `${role}-${iteration}.log`), 'utf8').slice(-5000)}`,
        );
        readyReject(error);
        resultReject(error);
        reject(error);
      }
    });
  });
  void done.catch(() => {});
  return { child, ready, result, done };
}
const cancel = () => {
  for (const child of children) child.kill('SIGKILL');
};
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.on('SIGALRM', cancel);
const baseline: Result[] = [],
  loaded: Result[] = [],
  sandbox: { ready: Ready; result: Result }[] = [];
try {
  const roles = new Set(query(superUrl, 'select rolname from pg_roles').split('\n'));
  const rolesSql = fs
    .readFileSync('deploy/db-init/roles.sql', 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('--'));
  for (let line of rolesSql) {
    const role = /^CREATE ROLE (\w+)/.exec(line)?.[1];
    if (role && roles.has(role)) line = line.replace('CREATE ROLE', 'ALTER ROLE');
    line = line
      .replaceAll(":'owner_password'", `'${pw.owner}'`)
      .replaceAll(":'app_password'", `'${pw.app}'`)
      .replaceAll(":'platform_password'", `'${pw.platform}'`)
      .replaceAll(':"db_name"', `"${dbName}"`);
    query(superUrl, line);
  }
  await runMigrations(url('agent_owner', pw.owner));
  const hostId = query(
    url('agent_owner', pw.owner),
    "insert into tenants(slug,name,pack_id) values('template','压测模板','travel') returning id",
  ).split('\n')[0]!;
  const conn = await openDb(appUrl);
  try {
    const imported = await withTenantScope(createTenantRuntime({ id: hostId, slug: 'template' }), () =>
      importConfig({
        db: conn.db,
        tenantSlug: 'template',
        dataDir: 'data',
        imageSop: fs.readFileSync('data/sop.md', 'utf8'),
        lock: (id) => holdTenantLock(appUrl, id),
      }),
    );
    assert.equal(imported.code, 0, imported.message);
  } finally {
    await conn.close();
  }
  for (let iteration = 0; iteration < (provisionOnly ? 1 : 3); iteration++) {
    // 按对比轮交替顺序，避免固定先后导致温机偏差。每轮各用新进程。
    for (const withSandbox of provisionOnly ? [true] : iteration === 1 ? [true, false] : [false, true]) {
      const host = worker('host', iteration * 2 + Number(withSandbox));
      await host.ready;
      const sb = withSandbox ? worker('sandbox', iteration) : null;
      const sbReady = sb ? await sb.ready : null;
      const startAt = Date.now() + 500;
      host.child.send({ type: 'run', startAt });
      sb?.child.send({ type: 'run', startAt });
      const hostResult = await host.result;
      const sbResult = sb ? await sb.result : null;
      await host.done;
      if (sb) await sb.done;
      (withSandbox ? loaded : baseline).push(hostResult);
      if (sbReady && sbResult) sandbox.push({ ready: sbReady, result: sbResult });
      if (!provisionOnly)
        console.log(
          `对比 ${iteration + 1}/3 ${withSandbox ? '20 沙箱' : '基线'}：宿主等待中位数 ${median(hostResult.waits).toFixed(2)}ms，写库最大 ${Math.max(hostResult.maxLagMs, ...hostResult.writes).toFixed(2)}ms`,
        );
      // 只清本次临时库的沙箱；下一次仍从 0 个开始。
      if (withSandbox) {
        const cleanupUrl = new URL(`/${dbName}`, superUrl).href;
        query(cleanupUrl, "update tenants set expires_at=now()-interval '1 second' where kind='sandbox'");
        const ids = query(cleanupUrl, "select id from tenants where kind='sandbox'").split('\n').filter(Boolean);
        const c = await openDb(appUrl);
        try {
          const { purgeSandbox } = await import('../../src/db/sandbox-reaper.js');
          for (const id of ids) await purgeSandbox(c.db, id);
        } finally {
          await c.close();
        }
      }
    }
  }
  if (provisionOnly) {
    const result = {
      provisionOnly: true,
      provisionMs: sandbox[0]!.ready.provisionMs!,
      provisionP95Ms: p95(sandbox[0]!.ready.provisionMs!),
      idleRssMB: sandbox[0]!.ready.idleRssMB,
      loadedRssMB: sandbox[0]!.ready.loadedRssMB,
    };
    if (process.env.LOAD_REPORT) fs.writeFileSync(process.env.LOAD_REPORT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.provisionP95Ms > 3000) process.exitCode = 1;
  } else {
    const baseMedian = median(baseline.map((r) => median(r.waits)));
    const loadMedian = median(loaded.map((r) => median(r.waits)));
    const writeBacklogMs = Math.max(...loaded.flatMap((r) => [r.maxLagMs, ...r.writes]));
    const provisionP95Ms = sandbox.map((s) => p95(s.ready.provisionMs!));
    const result = {
      fakeModelDelayMs: 200,
      roundsPerConversation: 5,
      hostConversations: 8,
      sandboxConversations: 20,
      baseline,
      loaded,
      sandbox,
      summary: {
        hostBaselineMedianMs: baseMedian,
        hostLoadedMedianMs: loadMedian,
        hostQueueMedianIncreaseMs: loadMedian - baseMedian,
        hostWriteBacklogMaxMs: writeBacklogMs,
        provisionP95Ms,
        provisionP95MedianMs: median(provisionP95Ms),
        idleRssMB: sandbox.map((s) => s.ready.idleRssMB),
        loadedRssMB: sandbox.map((s) => s.ready.loadedRssMB),
        peakObservedRssMB: sandbox.map((s) => s.result.rssMB),
        pass: loadMedian - baseMedian <= 1000 && writeBacklogMs <= 2000 && provisionP95Ms.every((n) => n <= 3000),
      },
    };
    if (process.env.LOAD_REPORT) fs.writeFileSync(process.env.LOAD_REPORT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.summary, null, 2));
    if (!result.summary.pass) process.exitCode = 1;
  }
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('close', () => resolve());
        }),
    ),
  );
  assert.equal(children.size, 0, '无遗留压测子进程');
  try {
    query(superUrl, `drop database if exists "${dbName}" with (force)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.off('SIGTERM', cancel);
  process.off('SIGINT', cancel);
  process.off('SIGALRM', cancel);
  console.log('清理完成：压测子进程全部退出，独立测试库已删除。');
}
