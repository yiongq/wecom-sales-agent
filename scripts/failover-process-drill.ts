// pnpm exec tsx scripts/failover-process-drill.ts kill|terminate
// 两个真实 Node 进程 + 同一临时真实 PG 库；不启动 Docker，不读取部署 env，不调用真实企微。
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { acceptanceReport, emptyMetrics, metricsPass, type DrillResult, type Scope } from './failover-metrics.js';
import { callbackEnvelope, fakeWecom, hasWaitMode, summarizeWecom, type OutboundRow } from './failover-wecom.js';
import { CHANNEL_KEY_ENV } from '../src/channels/secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) sources.push(...(await sourceFiles(target)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.selftest.ts')) sources.push(await readFile(target, 'utf8'));
  }
  return sources;
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(false));
    socket.setTimeout(100, () => done(false));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED'));
  });
}
interface Running {
  child: ChildProcess;
  exitAt: number | null;
  failed: boolean;
  port: number;
}
export async function runProcessDrill(scenario: string) {
  if (!['kill', 'terminate'].includes(scenario)) throw new Error('用法：failover-process-drill.ts kill|terminate');
  const scope: Scope = scenario === 'kill' ? 'processKill' : 'processTerminate';
  const result: DrillResult = { scope, metrics: emptyMetrics(scope), scopeComplete: false, cleanupComplete: false };
  const report: Record<string, unknown> = { ...result, scenario, samplingIntervalMs: 20, phase: 'capability' };
  const m = result.metrics;
  const originalCwd = process.cwd();
  let tmp: string | undefined;
  let database: Awaited<ReturnType<typeof import('./failover-postgres.js').processDatabase>> | undefined;
  let fake: Awaited<ReturnType<typeof fakeWecom>> | undefined;
  let watcher: fs.FSWatcher | undefined;
  let traffic: ReturnType<typeof setInterval> | undefined;
  let interrupted = false;
  const monitoring = { active: false };
  let monitor: Promise<void> | undefined;
  let monitorError = false;
  const processes: Running[] = [];
  const pending = new Set<Promise<unknown>>();
  const spills: { at: number; name: string }[] = [];
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const deadline = setTimeout(onSignal, 180_000);
  async function until<T>(fn: () => Promise<T | null>, timeout = 30_000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (interrupted) throw new Error('drill_interrupted');
      if (processes.some((p) => p.failed)) throw new Error('drill_spawn_failed');
      const value = await fn();
      if (value !== null) return value;
      await sleep(20);
    }
    throw new Error('drill_wait_timeout');
  }
  async function healthy(port: number) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(100) });
      const body = (await response.json()) as { ok?: boolean };
      return response.ok && body.ok === true;
    } catch {
      return false;
    }
  }
  try {
    // 必须先报能力缺失：当前尚未合并进程侧代码时，连 PG_TEST_URL 都不需要提供。
    if (!hasWaitMode(await sourceFiles(path.join(root, 'src')))) throw new Error('等锁模式不可用：尚未合入 TENANT_LOCK_WAIT 进程实现');
    if (!process.env.PG_TEST_URL) throw new Error('缺少 PG_TEST_URL：须由协调者提供一次性真实 Postgres');
    report.phase = 'database_setup';
    tmp = await mkdtemp(path.join(os.tmpdir(), 'failover-process-'));
    const varDir = path.join(tmp, 'var');
    await mkdir(varDir);
    // cwd 没有 .env；只链接运行所需静态目录，写入全部落在共享临时 VAR_DIR。
    for (const name of ['data', 'public', 'console']) await symlink(path.join(root, name), path.join(tmp, name));
    fake = await fakeWecom();
    // db 层会间接导入 env.ts；先移到没有 .env 的临时 cwd，防止读取工作区配置。
    process.chdir(tmp);
    const { processDatabase } = await import('./failover-postgres.js');
    database = await processDatabase(process.env.PG_TEST_URL);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TZ: 'Asia/Shanghai',
      DEPLOY_PROFILE: 'demo',
      CONFIG_SOURCE: 'db',
      SESSION_STORE: 'db',
      APP_ROLE: 'host',
      TENANT_LOCK_WAIT: 'forever',
      LLM_MOCK: '1',
      LOG_FORMAT: 'json',
      DATABASE_URL: database.appUrl,
      DEFAULT_TENANT_SLUG: 'drill',
      VAR_DIR: varDir,
      ADMIN_PASS: randomBytes(24).toString('hex'),
      [CHANNEL_KEY_ENV]: `drill:${randomBytes(32).toString('base64')}`,
      DAILY_VISITOR_LLM_CALLS: '0',
      CHAT_RATE_PER_MIN: '600',
    };
    const tsx = import.meta.resolve('tsx');
    async function cli(file: string, args: string[]) {
      try {
        await exec(process.execPath, ['--import', tsx, path.join(root, file), ...args], {
          cwd: tmp,
          env,
          timeout: 30_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        });
      } catch {
        throw new Error('drill_seed_cli_failed');
      }
    }
    report.phase = 'seed_config';
    await cli('src/cli/import-config.ts', ['--tenant', 'drill']);
    const secrets = {
      corpId: 'drill-corp',
      openKfId: 'drill-kf',
      appSecret: randomBytes(24).toString('hex'),
      callbackToken: randomBytes(24).toString('hex'),
      callbackAesKey: randomBytes(32).toString('base64').replace(/=$/, ''),
    };
    const secretsFile = path.join(tmp, 'channel.json');
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    report.phase = 'seed_channel';
    await cli('src/cli/channel-account.ts', [
      'add-wecom',
      '--tenant',
      'drill',
      '--key',
      'drill',
      '--name',
      '合成企微',
      '--secrets-file',
      secretsFile,
    ]);
    // 冷启动从空 cursor 0 开始；此时假服务没有消息，不人为跳过任何客户消息。
    await database.query("update channel_accounts set cursor='0', cursor_at=now() where key='drill'");
    async function launch(label: string): Promise<Running> {
      const dir = path.join(tmp!, label);
      await mkdir(dir);
      const preload = path.join(dir, 'fetch.mjs');
      await copyFile(path.join(root, 'scripts/failover-fetch-preload.mjs'), preload);
      await writeFile(path.join(dir, 'failover-fetch.json'), JSON.stringify({ origin: fake!.origin, auth: fake!.auth, process: label }), {
        mode: 0o600,
      });
      const port = await freePort();
      const url = new URL(database!.appUrl);
      url.searchParams.set('application_name', `${database!.name}_${label}`);
      const child = spawn(process.execPath, ['--import', preload, '--import', tsx, path.join(root, 'src/server.ts')], {
        cwd: tmp,
        env: { ...env, PORT: String(port), DATABASE_URL: url.toString() },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const run: Running = { child, port, exitAt: null, failed: false };
      child.once('error', () => {
        run.failed = true;
      });
      child.once('exit', () => {
        run.exitAt = Date.now();
      });
      processes.push(run);
      return run;
    }
    report.phase = 'primary_startup';
    const primary = await launch('a');
    await until(async () => ((await healthy(primary.port)) ? true : null));
    report.phase = 'standby_validation';
    const secondary = await launch('b');
    await sleep(2000);
    if (secondary.exitAt !== null || !(await refused(secondary.port)) || fake.requests.some((r) => r.process === 'b'))
      throw new Error('等锁模式不可用：备用未保持存活且不监听、不访问企微');
    report.phase = 'traffic';
    let sequence = 0;
    const callback = async (port: number) => {
      const envelope = callbackEnvelope(secrets);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/wecom/callback/drill?${envelope.query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/xml' },
          body: envelope.xml,
          signal: AbortSignal.timeout(800),
        });
        return response.ok && (await response.text()) === 'success';
      } catch {
        return false;
      }
    };
    const trigger = () => {
      const work = Promise.all([callback(primary.port), callback(secondary.port)]).finally(() => pending.delete(work));
      pending.add(work);
    };
    const tick = () => {
      if (interrupted) return;
      const n = ++sequence;
      fake!.messages.push({
        msgid: `drill-in-${n}`,
        external_userid: `wmDrill${n}`,
        open_kfid: secrets.openKfId,
        send_time: Math.floor(Date.now() / 1000),
        origin: 3,
        msgtype: 'text',
        text: { content: '你好' },
        queuedAt: Date.now(),
      });
      trigger();
    };
    tick();
    traffic = setInterval(tick, 1000);
    await until(async () =>
      fake!.requests.filter((r) => r.process === 'a' && r.endpoint === 'kf/send_msg' && r.end !== null).length >= 2 ? true : null,
    );
    // 固定在 sending 请求仍在途时注入故障，确保不是空载切换；请求回包在观察接管后才放行。
    fake.holdNextSend();
    await until(async () => (fake!.hasHeldSend() ? true : null));
    const before = await database.query<{ msgid: string }>("select channel_msgid as msgid from outbound_sends where status='sending'");
    const sendingAtFault = new Set(before.map((r) => r.msgid));
    if (!sendingAtFault.size) throw new Error('drill_missing_inflight_sending');
    const locks = () =>
      database!.query<{ pid: number; application_name: string }>(
        "select distinct a.pid, a.application_name from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.datname=current_database() and l.locktype='advisory' and l.granted and a.application_name in ($1,$2)",
        [`${database!.name}_a`, `${database!.name}_b`],
      );
    const owners = await locks();
    if (owners.length !== 1 || owners[0]!.application_name !== `${database.name}_a`) throw new Error('drill_expected_primary_lock');
    watcher = fs.watch(varDir, (_event, name) => {
      if (name?.startsWith('store-spill-')) spills.push({ at: Date.now(), name: String(name) });
    });
    watcher.on('error', () => {
      monitorError = true;
    });
    report.phase = 'fault_and_takeover';
    const faultAt = Date.now();
    let acquired: number | null = null;
    let lastNotHeldAt = faultAt;
    let ready: number | null = null;
    let closed: number | null = null;
    let lastSampleAt = faultAt;
    let maxSampleGapMs = 0;
    monitoring.active = true;
    monitor = (async () => {
      while (monitoring.active) {
        const sampleStarted = Date.now();
        const current = await locks();
        const at = Date.now();
        maxSampleGapMs = Math.max(maxSampleGapMs, at - lastSampleAt);
        lastSampleAt = at;
        if (acquired === null) {
          if (current.some((r) => r.application_name === `${database!.name}_b`)) acquired = at;
          else lastNotHeldAt = sampleStarted;
        }
        if (closed === null && (await refused(primary.port))) closed = Date.now();
        if (ready === null && acquired !== null && (await healthy(secondary.port))) ready = Date.now();
        await sleep(20);
      }
    })().catch(() => {
      monitorError = true;
    });
    if (scenario === 'kill') {
      if (!primary.child.kill('SIGKILL')) throw new Error('drill_kill_failed');
    } else {
      const terminated = await database.query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [owners[0]!.pid]);
      if (!terminated[0]?.ok) throw new Error('drill_terminate_failed');
    }
    report.faultInjectionMs = Date.now() - faultAt;
    if (scenario === 'terminate')
      m.inFlightAtLoss = fake.requests.filter((r) => r.process === 'a' && r.start <= faultAt && (r.end === null || r.end > faultAt)).length;
    await until(async () => (acquired !== null && ready !== null ? true : null));
    fake.release();
    // 接管后继续每秒入站，并反复回调两侧，观察旧进程有没有继续拉取。
    let lastTrigger = 0;
    await until(async () => {
      if (Date.now() - lastTrigger >= 100) {
        trigger();
        lastTrigger = Date.now();
      }
      return primary.exitAt !== null && Date.now() - faultAt >= 3500 ? true : null;
    }, 20_000);
    await sleep(3000);
    clearInterval(traffic);
    traffic = undefined;
    await Promise.allSettled(pending);
    const readRows = () =>
      database!.query<OutboundRow>(
        'select i.msgid as inbound, o.channel_msgid as msgid, o.status, o.segment, o.message_seq as "messageSeq" from outbound_sends o left join channel_inbox i on i.tenant_id=o.tenant_id and i.id=o.inbox_id',
      );
    // 给接管恢复留完整窗口；失败后照样输出逐消息账本，不能把超时变成通过。
    try {
      await until(async () => {
        const summary = summarizeWecom(fake!.messages, fake!.requests, await readRows(), sendingAtFault);
        return summary.missingOutsideBoundary === 0 ? true : null;
      }, 30_000);
    } catch {
      report.repliesTimedOut = true;
    }
    report.phase = 'statistics';
    const rows = await readRows();
    const stats = summarizeWecom(fake.messages, fake.requests, rows, sendingAtFault);
    m.sent = stats.sent;
    m.replied = stats.replied;
    m.maxWaitMs = stats.maxWaitMs;
    m.lockAcquiredMs = acquired === null ? null : acquired - faultAt;
    const received = fake.requests.find((r) => r.process === 'b' && r.endpoint === 'kf/sync_msg' && r.start >= faultAt);
    const sent = fake.requests.find((r) => r.process === 'b' && r.endpoint === 'kf/send_msg' && r.start >= faultAt);
    m.lockToServingMs =
      acquired === null || ready === null || !received || !sent ? null : Math.max(ready, received.start, sent.start) - lastNotHeldAt;
    if (m.lockToServingMs !== null) m.lockToServingMs = Math.max(0, m.lockToServingMs);
    if (scenario === 'kill') {
      for (const name of ['missingOutsideBoundary', 'duplicateReplies', 'unknownSegments', 'boundarySegments'] as const)
        m[name] = stats[name];
    } else {
      const polls = fake.requests.filter((r) => r.process === 'a' && r.endpoint === 'kf/sync_msg');
      m.pollStoppedMs = polls.length && primary.exitAt !== null ? Math.max(0, ...polls.map((r) => r.start - faultAt)) : null;
      m.listenerClosedMs = closed === null ? null : closed - faultAt;
      m.oldProcessExited = primary.exitAt === null ? 0 : 1;
      m.observationMs = Date.now() - faultAt;
      m.dualProcessSentSegments = stats.dualProcessSentSegments;
      m.spillEvents = monitorError ? null : spills.filter((s) => s.at >= faultAt && s.at <= (primary.exitAt ?? Date.now())).length;
    }
    report.perMessage = stats.perMessage;
    report.unknownSegments = stats.unknownSegments;
    report.boundarySegments = stats.boundarySegments;
    report.maxLockSampleGapMs = maxSampleGapMs;
    report.lockAcquisitionWindowMs = acquired === null ? null : acquired - lastNotHeldAt;
    report.fakeApiErrors = fake.errors;
    report.sendLedger = fake.requests
      .filter((r) => r.endpoint.includes('send_msg'))
      .map((r) => ({
        process: r.process,
        endpoint: r.endpoint,
        msgid: r.body.msgid ?? null,
        conversation: r.body.touser ?? null,
        startMs: r.start - faultAt,
        endMs: r.end === null ? null : r.end - faultAt,
      }));
    result.scopeComplete = metricsPass(scope, m) && !monitorError && !fake.errors.length && !interrupted;
  } catch (error) {
    // 只输出脚本自己的无凭据错误；PG/子进程原异常不回显。
    const message = error instanceof Error ? error.message : '';
    report.error = /^(drill_|等锁模式不可用|缺少 PG_TEST_URL)/.test(message) ? message : 'drill_process_failed';
  } finally {
    clearTimeout(deadline);
    if (traffic) clearInterval(traffic);
    monitoring.active = false;
    await monitor;
    fake?.release();
    await Promise.allSettled(pending);
    watcher?.close();
    const cleanupErrors: string[] = String(report.error ?? '').includes('cleanup_failed') ? ['database_setup'] : [];
    for (const run of processes) {
      if (run.exitAt === null) run.child.kill('SIGTERM');
    }
    const stopAt = Date.now() + 12_000;
    while (processes.some((p) => p.exitAt === null && !p.failed) && Date.now() < stopAt) await sleep(50);
    for (const run of processes) {
      if (run.exitAt === null && !run.failed) {
        run.child.kill('SIGKILL');
        await Promise.race([new Promise<void>((resolve) => run.child.once('exit', () => resolve())), sleep(3000)]);
        if (run.exitAt === null) cleanupErrors.push('child');
      }
    }
    await fake?.close().catch(() => cleanupErrors.push('fake_wecom'));
    await database?.drop().catch(() => cleanupErrors.push('database'));
    process.chdir(originalCwd);
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => cleanupErrors.push('temporary_files'));
    result.cleanupComplete = cleanupErrors.length === 0;
    if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
    result.scopeComplete &&= result.cleanupComplete;
    Object.assign(report, result, acceptanceReport([result]));
    // 当前执行的 metrics 与四个场景的汇总分开，供离线合并。
    report.metrics = m;
    report.acceptanceMetrics = acceptanceReport([result]).metrics;
    console.log(JSON.stringify(report, null, 2));
    if (!result.scopeComplete) process.exitCode = 1;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProcessDrill(process.argv[2] ?? '').catch(() => {
    console.error('用法：failover-process-drill.ts kill|terminate');
    process.exitCode = 1;
  });
}
