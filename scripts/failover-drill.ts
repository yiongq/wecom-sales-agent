// 本机一次性演练：pnpm exec tsx scripts/failover-drill.ts kill|rolling
// 不属于 pnpm test；纯逻辑见 failover-drill.selftest.ts。不会读取部署 env 或调用 deploy.sh。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { acceptanceReport, emptyMetrics, metricsPass, type DrillResult, type Scope } from './failover-metrics.js';

const exec = promisify(execFile);
type Slot = 'app' | 'app-standby';
export interface Sample {
  id: string;
  status: number;
  replied: boolean;
  waitMs: number | null;
}
export function summarize(samples: Sample[]) {
  return {
    sent: samples.length,
    replied: samples.filter((s) => s.replied).length,
    missing: samples.filter((s) => !s.replied).map((s) => s.id),
    maxWaitMs: samples.some((s) => s.waitMs === null) ? null : Math.max(0, ...samples.map((s) => s.waitMs!)),
  };
}
export function healthOK(body: unknown): boolean {
  return !!body && typeof body === 'object' && 'ok' in body && body.ok === true;
}
export function pairState(a: unknown, b: unknown): 'app' | 'app-standby' | 'both' | 'none' {
  return healthOK(a) ? (healthOK(b) ? 'both' : 'app') : healthOK(b) ? 'app-standby' : 'none';
}
// 日志事件名由进程侧决定；缺日志时返回 null，不能拿健康时间冒充拿锁时间。
export function acquiredAt(logs: string, since: number, event: RegExp): number | null {
  for (const line of logs.split('\n')) {
    const space = line.indexOf(' ');
    const at = Date.parse(line.slice(0, space));
    if (Number.isFinite(at) && at >= since && event.test(line.slice(space + 1))) return at;
  }
  return null;
}
export function localDockerEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('unix://') || endpoint.startsWith('npipe://');
}

export function parseDrillPorts(value: unknown): { app: number; standby: number; caddy: number } {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    new Set(value).size !== 3 ||
    !value.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)
  )
    throw new Error('drill_invalid_ports');
  return { app: value[0], standby: value[1], caddy: value[2] };
}
interface ProbeReply {
  status: number;
  body: unknown;
  waitMs: number;
}

async function drill(scenario: string): Promise<void> {
  if (!['kill', 'rolling'].includes(scenario)) throw new Error('用法：failover-drill.ts kill|rolling');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const project = `failover-drill-${randomBytes(6).toString('hex')}`;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'failover-drill-'));
  const envFile = path.join(tmp, 'compose.env');
  const oldImage = `${project}:old`;
  const newImage = `${project}:new`;
  const password = randomBytes(24).toString('hex');
  const images: Record<Slot, string> = { app: oldImage, 'app-standby': oldImage };
  let ports: ReturnType<typeof parseDrillPorts> | undefined;
  // 不继承任何应用配置/密钥；只保留查找本机 Docker 所需变量。
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'TMPDIR'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  let started = false;
  let stopping = false;
  const built: string[] = [];
  const samples: Sample[] = [];
  const pending = new Set<Promise<void>>();
  let traffic: ReturnType<typeof setInterval> | undefined;
  const failures: string[] = [];
  const scope: Scope = scenario === 'kill' ? 'containerKill' : 'containerRolling';
  const result: DrillResult = { scope, metrics: emptyMetrics(scope), scopeComplete: false, cleanupComplete: false };
  const report: Record<string, unknown> = { scenario, project, probeLocation: 'docker-host-loopback', caddyDualUpstream: null };
  const m = result.metrics;
  const check = (ok: boolean, name: string) => {
    if (!ok) failures.push(name);
  };
  async function docker(args: string[], timeout = 60_000): Promise<string> {
    try {
      const { stdout, stderr } = await exec('docker', args, {
        cwd: root,
        env,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      });
      return (args.includes('logs') ? `${stdout}\n${stderr}` : stdout).trim();
    } catch {
      // Docker/Compose 错误可能带展开后的连接串；不打印 stderr、命令参数或原异常。
      throw new Error(`drill_docker_${args[0]}_failed`);
    }
  }
  async function writeEnv() {
    await writeFile(
      envFile,
      [
        `DRILL_PASSWORD=${password}`,
        `DRILL_OLD_IMAGE=${oldImage}`,
        `DRILL_NEW_IMAGE=${newImage}`,
        `DRILL_APP_IMAGE=${images.app}`,
        `DRILL_STANDBY_IMAGE=${images['app-standby']}`,
        // 0 仅供启动选端口的 probe 时解析 compose；app/Caddy 启动前替换成虚拟机里选出的固定端口。
        `DRILL_APP_PORT=${ports?.app ?? 0}`,
        `DRILL_STANDBY_PORT=${ports?.standby ?? 0}`,
        `DRILL_CADDY_PORT=${ports?.caddy ?? 0}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  const compose = (args: string[], timeout?: number) =>
    docker(['compose', '--env-file', envFile, '-p', project, '-f', 'deploy/drill/compose.drill.yml', ...args], timeout);
  function origin(service: Slot | 'caddy') {
    if (!ports) throw new Error('drill_ports_unavailable');
    return `http://127.0.0.1:${ports[service === 'app-standby' ? 'standby' : service]}`;
  }
  async function request(url: string, body?: string, timeout = 1000): Promise<ProbeReply> {
    const raw = await compose(
      ['exec', '-T', 'probe', 'node', '/drill/probe.mjs', 'request', JSON.stringify({ url, body, timeout })],
      timeout + 10_000,
    );
    const response = JSON.parse(raw) as ProbeReply;
    if (
      !Number.isInteger(response.status) ||
      response.status < 0 ||
      response.status > 599 ||
      !Number.isFinite(response.waitMs) ||
      response.waitMs < 0 ||
      !('body' in response)
    )
      throw new Error('drill_invalid_probe_result');
    return response;
  }
  async function json(url: string): Promise<unknown> {
    const response = await request(url);
    return response.status >= 200 && response.status < 300 ? response.body : null;
  }
  async function until<T>(read: () => Promise<T | null>, timeout = 60_000, interval = 100): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (stopping) throw new Error('drill_interrupted');
      const value = await read();
      if (value !== null) return value;
      await sleep(interval);
    }
    throw new Error('drill_wait_timeout');
  }
  async function active(): Promise<Slot> {
    const [a, b] = await Promise.all([origin('app'), origin('app-standby')]);
    const state = pairState(...(await Promise.all([json(`${a}/healthz`), json(`${b}/healthz`)])));
    if (state === 'both' || state === 'none') throw new Error(`drill_active_${state}`);
    return state;
  }
  async function healthy(slot: Slot, revision: string, timeout = 60_000): Promise<number> {
    const base = await origin(slot);
    return until(async () => {
      const health = await json(`${base}/healthz`);
      return healthOK(health) && (health as { revision?: string }).revision === revision ? Date.now() : null;
    }, timeout);
  }
  async function cleanup() {
    stopping = true;
    if (traffic) clearInterval(traffic);
    await Promise.allSettled(pending);
    let cleaned = true;
    if (started) {
      try {
        await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], 60_000);
      } catch {
        cleaned = false;
        console.error(`清理失败：仅清理 compose project ${project}；请按手册处理。`);
      }
    }
    for (const image of built) {
      try {
        await docker(['image', 'rm', image], 20_000);
      } catch {
        cleaned = false;
        console.error(`清理失败：演练镜像 ${image}`);
      }
    }
    await rm(tmp, { recursive: true, force: true });
    result.cleanupComplete = cleaned;
    if (!cleaned) process.exitCode = 1;
  }
  const onSignal = () => {
    stopping = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const deadline = setTimeout(onSignal, 20 * 60_000);
  try {
    // 演练 Caddy 已配置双上游；显式开启，并经过与 deploy.sh 相同的只读门槛。
    // 不读取服务器或本机仓库的 .env.ops；未确认时禁止进入后面的主备演练与回滚。
    await writeFile(path.join(tmp, '.env.ops'), 'CADDY_DUAL_UPSTREAM=1\n', { mode: 0o600 });
    const { stdout: caddyMode } = await exec('bash', [path.join(root, 'deploy/caddy-dual-upstream.sh'), tmp, project], {
      env,
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    if (caddyMode.trim() !== '1') throw new Error('drill_caddy_dual_upstream_unconfirmed');
    report.caddyDualUpstream = true;
    const context = await docker(['context', 'show'], 5000);
    const endpoint = env.DOCKER_HOST ?? (await docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], 5000));
    if (!localDockerEndpoint(endpoint)) throw new Error('drill_requires_local_docker');
    // 固定到已验证的本机 socket，防止默认 context 或 DOCKER_CONTEXT 改变后操作远端。
    delete env.DOCKER_CONTEXT;
    env.DOCKER_HOST = endpoint;
    await writeEnv();
    for (const [image, revision] of [
      [oldImage, 'drill-old'],
      [newImage, 'drill-new'],
    ]) {
      if (stopping) throw new Error('drill_interrupted');
      console.error(`构建 ${revision}`);
      built.push(image);
      await docker(['build', '--build-arg', `APP_REVISION=${revision}`, '-t', image, '.'], 600_000);
    }
    started = true;
    ports = parseDrillPorts(
      JSON.parse(await compose(['run', '--rm', '--no-deps', 'probe', 'node', '/drill/probe.mjs', 'reserve'], 10_000)),
    );
    await writeEnv();
    report.ports = ports;
    await compose(['up', '-d', '--no-deps', 'probe']);
    await compose(['up', '-d', '--wait', 'db'], 90_000);
    await compose(['run', '--rm', 'migrate'], 90_000);
    await compose([
      'run',
      '--rm',
      '--no-deps',
      'platform',
      'node',
      '--import',
      'tsx',
      'src/cli/tenant-create.ts',
      '--slug',
      'drill',
      '--name',
      '合成演练',
      '--pack',
      'travel',
    ]);
    await compose(['run', '--rm', '--no-deps', 'app', 'node', '--import', 'tsx', 'src/cli/import-config.ts', '--tenant', 'drill']);
    await compose(['up', '-d', '--no-deps', 'app']);
    await healthy('app', 'drill-old');
    await compose(['up', '-d', '--no-deps', 'app-standby', 'caddy']);
    await sleep(3000);
    m.watchBeforeNormal = (await active()) === 'app' ? 1 : 0;
    check(m.watchBeforeNormal === 1, '启动时必须恰好一个活动端口');
    const proxy = origin('caddy');
    await until(async () => (healthOK(await json(`${proxy}/healthz`)) ? true : null));
    async function proxyReady(revision: string) {
      return until(async () => {
        const health = await json(`${proxy}/healthz`);
        return healthOK(health) && (health as { revision?: string }).revision === revision ? Date.now() : null;
      });
    }
    async function send() {
      const id = `sim-${randomBytes(12).toString('hex')}`;
      let status = 0,
        replied = false;
      let waitMs: number | null = null;
      try {
        const response = await request(`${proxy}/api/chat`, JSON.stringify({ sessionId: id, text: '你好，我想了解旅游线路' }), 25_000);
        status = response.status;
        waitMs = response.waitMs;
        const body = response.body as { reply?: { text?: string } } | null;
        replied = status >= 200 && status < 300 && !!body?.reply?.text;
      } catch {
        check(false, '测量进程或 Docker exec 失败，请求等待时长未知');
      }
      samples.push({ id, status, replied, waitMs });
    }

    const tick = () => {
      if (stopping) return;
      const job = send().finally(() => pending.delete(job));
      pending.add(job);
    };
    tick();
    traffic = setInterval(tick, 1000);
    await sleep(3000);
    const primary = await active();
    const secondary: Slot = primary === 'app' ? 'app-standby' : 'app';
    const primaryId = await compose(['ps', '-q', primary]);
    const lockEvent = new RegExp(process.env.DRILL_LOCK_EVENT ?? 'tenant_locks?_acquired|process_locks_acquired|拿到.*租户锁|取得.*租户锁');
    let switchAt = Date.now();
    let readyAt: number;
    if (scenario === 'kill') {
      await docker(['kill', primaryId], 5000);
      await healthy(secondary, 'drill-old');
      readyAt = await proxyReady('drill-old');
    } else {
      await compose(['run', '--rm', 'migrate'], 90_000);
      images[secondary] = newImage;
      await writeEnv();
      await compose(['up', '-d', '--no-deps', '--force-recreate', secondary]);
      await sleep(2000);
      check((await active()) === primary, '重建备用期间原主继续服务');
      switchAt = Date.now();
      await compose(['stop', primary], 20_000);
      await healthy(secondary, 'drill-new');
      readyAt = await proxyReady('drill-new');
      images[primary] = newImage;
      await writeEnv();
      await compose(['up', '-d', '--no-deps', '--force-recreate', primary]);
      await sleep(2000);
      check((await active()) === secondary, '滚动后恰好一个活动端口');
    }
    const logs = await compose(['logs', '--no-color', '--no-log-prefix', '--timestamps', secondary]);
    const lockAt = acquiredAt(logs, switchAt, lockEvent);
    m.lockAcquiredMs = lockAt === null ? null : lockAt - switchAt;
    m.lockToServingMs = lockAt === null ? null : readyAt - lockAt;
    report.switchToServingMs = readyAt - switchAt;
    check(lockAt !== null, '缺少拿锁日志；用 DRILL_LOCK_EVENT 对齐进程侧事件名后重跑');
    if (scenario === 'kill' && lockAt !== null) check(lockAt - switchAt <= 1000, '杀主后 1 秒内拿锁');
    if (lockAt !== null) check(readyAt - lockAt <= 5000, '拿锁到服务目标 5 秒');
    await sleep(3000);
    clearInterval(traffic);
    traffic = undefined;
    await Promise.all(pending);
    const stats = summarize(samples);
    report.messages = stats;
    report.perMessage = samples;
    m.sent = stats.sent;
    m.replied = stats.replied;
    m.maxWaitMs = samples.length ? stats.maxWaitMs : null;
    m.watchAfterNormal = (await active()) === secondary ? 1 : 0;
    check(samples.length > 0 && samples.every((s) => s.replied), '每条 HTTP 消息都有回复');
    if (scenario === 'rolling') check(stats.maxWaitMs !== null && stats.maxWaitMs <= 15_000, '滚动最长等待目标 15 秒');
    report.coverage = '网页一问一答只测对外可用性；企微重复发送、unknown 边界、失锁停机由进程演练统计。';
    if (scenario === 'rolling') {
      // 单独准备旧版本基线，再演练坏新镜像的健康失败与回滚；此阶段不混进滚动流量统计。
      const main = await active();
      const spare: Slot = main === 'app' ? 'app-standby' : 'app';
      await compose(['stop', 'app', 'app-standby'], 30_000);
      images[main] = oldImage;
      images[spare] = newImage;
      await writeEnv();
      await compose(['up', '-d', '--no-deps', '--force-recreate', main]);
      await healthy(main, 'drill-old');
      const badFile = path.join(tmp, 'bad.yml');
      await writeFile(badFile, `services:\n  ${spare}:\n    environment:\n      CONFIG_SOURCE: invalid-drill-config\n`);
      await compose(['-f', badFile, 'up', '-d', '--no-deps', '--force-recreate', spare]);
      await compose(['stop', main], 20_000);
      let failed = false;
      try {
        await healthy(spare, 'drill-new', 5000);
      } catch {
        failed = true;
      }
      check(failed, '坏配置必须健康超时');
      await compose(['stop', spare], 20_000);
      await compose(['up', '-d', '--no-deps', '--force-recreate', main]);
      await healthy(main, 'drill-old');
      await proxyReady('drill-old');
      const restoredId = await compose(['ps', '-q', main]);
      report.rollbackImageMatches = (await docker(['inspect', '--format', '{{.Config.Image}}', restoredId])) === oldImage;
      check(report.rollbackImageMatches === true, '回滚必须恢复旧镜像');
      check((await active()) === main, '回滚后恢复原主且恰好一个端口');
      m.rollbackRecovered = failed && report.rollbackImageMatches === true && (await active()) === main ? 1 : 0;
      // 故障回滚后不把坏配置的容器留着自动重启。
    }
    result.scopeComplete = failures.length === 0 && metricsPass(scope, m) && !stopping;
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'drill_failed';
    report.messages = summarize(samples);
    result.scopeComplete = false;
  } finally {
    clearTimeout(deadline);
    await cleanup().catch(() => {
      result.cleanupComplete = false;
    });
    result.scopeComplete &&= result.cleanupComplete;
    Object.assign(report, result, { failures, acceptanceMetrics: acceptanceReport([result]).metrics, acceptance10to12Complete: false });
    console.log(JSON.stringify(report, null, 2));
    if (!result.scopeComplete) process.exitCode = 1;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    if (process.argv[2] === 'report') {
      const reports = await Promise.all(process.argv.slice(3).map(async (file) => JSON.parse(await readFile(file, 'utf8')) as DrillResult));
      const result = acceptanceReport(reports);
      console.log(JSON.stringify(result, null, 2));
      if (!result.acceptance10to12Complete) process.exitCode = 1;
    } else await drill(process.argv[2] ?? '');
  };
  run().catch(() => {
    console.error('演练失败：用法 failover-drill.ts kill|rolling，或 report <四份 JSON 结果>');
    process.exitCode = 1;
  });
}
