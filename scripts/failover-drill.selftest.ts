// 纯逻辑与假命令巡检；不运行 Docker、deploy.sh、真实模型或外部请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { acquiredAt, healthOK, localDockerEndpoint, pairState, parseDrillPorts, summarize } from './failover-drill.js';
import { acceptanceReport, emptyMetrics, metricNames, metricsPass, type DrillResult, type Scope } from './failover-metrics.js';
import {
  callbackEnvelope,
  fakeWecom,
  hasWaitMode,
  summarizeWecom,
  type CustomerMessage,
  type OutboundRow,
  type RequestRecord,
} from './failover-wecom.js';
import { computeSignature, decryptWecom } from '../src/wecom-crypto.js';

assert.equal(healthOK({ ok: 'true' }), false);
assert.equal(healthOK({ nested: { ok: true } }), false);
assert.equal(pairState({ ok: true }, null), 'app');
assert.equal(pairState(null, { ok: true }), 'app-standby');
assert.equal(pairState({ ok: true }, { ok: true }), 'both');
assert.equal(pairState({ ok: false }, null), 'none');
assert.deepEqual(
  summarize([
    { id: 'sim-a', status: 200, replied: true, waitMs: 20 },
    { id: 'sim-b', status: 502, replied: false, waitMs: 15000 },
    { id: 'sim-c', status: 200, replied: true, waitMs: 40 },
  ]),
  { sent: 3, replied: 2, missing: ['sim-b'], maxWaitMs: 15000 },
);
const now = Date.parse('2026-11-08T00:00:00Z');
assert.equal(acquiredAt('2026-11-08T00:00:00.200Z {"msg":"tenant_lock_acquired"}', now, /tenant_lock_acquired/), now + 200);
assert.equal(acquiredAt('2026-11-07T00:00:00Z tenant_lock_acquired', now, /tenant_lock_acquired/), null);
assert.equal(acquiredAt('2026-11-08T00:00:00Z server ready', now, /tenant_lock_acquired/), null);
assert.equal(localDockerEndpoint('unix:///var/run/docker.sock'), true);
assert.equal(localDockerEndpoint('ssh://remote'), false);
assert.equal(localDockerEndpoint('tcp://127.0.0.1:2375'), false);
assert.deepEqual(parseDrillPorts([41001, 41002, 41003]), { app: 41001, standby: 41002, caddy: 41003 });
for (const bad of [null, [], [41001, 41001, 41003], [0, 41002, 41003], [80, 41002, 41003], [65536, 41002, 41003], ['41001', 41002, 41003]])
  assert.throws(() => parseDrillPorts(bad), /drill_invalid_ports/);
assert.equal(summarize([{ id: 'sim-probe-failed', status: 0, replied: false, waitMs: null }]).maxWaitMs, null);

// 网络拓扑是演练契约：Caddy 不走容器名，探测与 Caddy 同在 Docker host 的回环网络。
const drillCompose = fs.readFileSync('deploy/drill/compose.drill.yml', 'utf8');
const caddyService = drillCompose.slice(drillCompose.indexOf('\n  caddy:'), drillCompose.indexOf('\n  probe:'));
assert.match(caddyService, /network_mode: host/);
assert.doesNotMatch(caddyService, /\bports:/);
assert.match(drillCompose.slice(drillCompose.indexOf('\n  probe:')), /network_mode: host/);
for (const variable of ['DRILL_APP_PORT', 'DRILL_STANDBY_PORT']) assert.ok(drillCompose.includes(`127.0.0.1:\${${variable}:?}:3200`));
const drillCaddy = fs.readFileSync('deploy/drill/Caddyfile', 'utf8');
assert.ok(drillCaddy.includes('import /etc/caddy/app.snippet 127.0.0.1:{$DRILL_APP_PORT} 127.0.0.1:{$DRILL_STANDBY_PORT}'));
assert.ok(drillCaddy.includes('http://127.0.0.1:{$DRILL_CADDY_PORT}') && drillCaddy.includes('bind 127.0.0.1'));
assert.doesNotMatch(drillCaddy, /app(?:-standby)?:3200/);

// 执行容器内实际使用的测量程序；这里用本机 HTTP 服务器验证，无需 Docker。
const probeScript = path.resolve('scripts/failover-probe.mjs');
const execProbe = (mode: string, input?: unknown) =>
  promisify(execFile)(process.execPath, [probeScript, mode, JSON.stringify(input ?? {})], {
    env: { PATH: process.env.PATH },
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
const reserved = parseDrillPorts(JSON.parse((await execProbe('reserve')).stdout));
assert.notEqual(reserved.app, reserved.standby);
let drops = 0;
let healthHits = 0;
const probeServer = createServer(async (req, res) => {
  if (req.url === '/drop') {
    drops++;
    req.socket.destroy();
    return;
  }
  if (req.url === '/stall') return;
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/healthz' }).end();
    return;
  }
  if (req.url === '/healthz') {
    healthHits++;
    res.end('{"ok":true}');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }));
});
await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
try {
  const probeOrigin = `http://127.0.0.1:${(probeServer.address() as { port: number }).port}`;
  const request = async (route: string, body?: string, timeout = 1000) =>
    JSON.parse((await execProbe('request', { url: probeOrigin + route, body, timeout })).stdout) as {
      status: number;
      body: unknown;
      waitMs: number;
    };
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.ok(health.waitMs >= 0);
  const body = JSON.stringify({ sessionId: 'sim-probe', text: '你好' });
  assert.deepEqual((await request('/chat', body)).body, { method: 'POST', body });
  const dropped = await request('/drop', body);
  assert.equal(dropped.status, 0);
  assert.equal(dropped.body, null);
  assert.equal(drops, 1, '连接后断开的 POST 不由探测客户端重发');
  assert.equal((await request('/redirect')).status, 302);
  assert.equal(healthHits, 1, '不跟随重定向');
  const timedOut = await request('/stall', undefined, 60);
  assert.equal(timedOut.status, 0);
  assert.equal(timedOut.body, null);
  assert.ok(timedOut.waitMs >= 50, '超时计入实际 HTTP 等待时间');
  await assert.rejects(execProbe('request', { url: 'http://localhost:1234', timeout: 100 }), /drill_probe_failed/);
} finally {
  probeServer.closeAllConnections();
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));
}
console.log('容器探测：host 回环拓扑、固定端口、HTTP 计时、POST 不重发、超时与未知值自测通过');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-selftest-'));
try {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const command = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
  command('docker', 'case "$*" in *RestartCount*) echo 0 ;; *) exit 1 ;; esac');
  command('df', 'echo "Filesystem Blocks Used Available Capacity Mounted"; echo "fake 100 10 90 10% /"');
  command(
    'curl',
    `case "$*" in
    *:3210/healthz*) body="$PROBE_A" ;;
    *:3212/healthz*) body="$PROBE_B" ;;
    *) exit 97 ;;
  esac
  [ "$body" != down ] || exit 7
  printf '%s' "$body"`,
  );
  fs.writeFileSync(path.join(tmp, '.env'), 'DEPLOY_PROFILE=demo\n');
  const state = path.join(tmp, 'watch.state');
  let minute = 0;
  const watch = (a: string, b: string) => {
    const result = execFileSync('bash', [path.resolve('deploy/watch.sh'), tmp], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        COMPOSE_PROJECT: 'drill-selftest',
        WATCH_BACKUP: '0',
        WATCH_STATE: state,
        WATCH_NOW: String(100000 + minute++ * 60),
        PROBE_A: a,
        PROBE_B: b,
      },
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return result;
  };
  const ok = '{ "ok" : true, "revision": "test" }';
  for (let i = 0; i < 3; i++) watch(ok, 'down');
  assert.match(fs.readFileSync(state, 'utf8'), /health_bad=0/);
  for (let i = 0; i < 3; i++) watch('down', ok);
  assert.match(fs.readFileSync(state, 'utf8'), /health_bad=0/);
  for (let i = 0; i < 3; i++) watch(ok, ok);
  assert.match(fs.readFileSync(state, 'utf8'), /a_health_active=1/);
  for (let i = 0; i < 3; i++) watch('down', ok);
  assert.match(fs.readFileSync(state, 'utf8'), /a_health_active=0/);
  for (let i = 0; i < 3; i++) watch('down', '{"ok":false}');
  assert.match(fs.readFileSync(state, 'utf8'), /a_health_active=1/);
  console.log('failover-drill：统计、日志缺失、本机 Docker 限制、巡检主备切换/双活/全断/恢复自测通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 只提取第 7 步的函数，以内存中的假 ssh/compose 执行，不运行 deploy.sh。
// 确认任意一侧为主时都先重建备、再停主；健康失败不能重建原主或更新 current。
const deploy = fs.readFileSync('deploy.sh', 'utf8');
const swap = deploy.slice(deploy.indexOf('swap_app() {'), deploy.indexOf('\n\necho "[7/7]'));
assert.ok(swap.startsWith('swap_app() {') && swap.endsWith('}'));
const selectMode = deploy.slice(deploy.indexOf('# 7)'), deploy.indexOf('# 每次探测与整轮都有时限'));
const rollback = deploy.slice(deploy.indexOf('rollback_health() {'), deploy.indexOf('\nif restore_app >&2'));
assert.ok(selectMode.startsWith('# 7)') && rollback.trimEnd().endsWith('}'));
const modeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-mode-'));
try {
  const bin = path.join(modeTmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
test "$*" = 'ps -q --filter label=com.docker.compose.project=drill --filter label=com.docker.compose.service=app-standby' || exit 99
case "$FAKE_STANDBY" in running) echo standby-id ;; error) exit 1 ;; stopped|absent) ;; *) exit 99 ;; esac
`,
    { mode: 0o755 },
  );
  const modeTrace = (ops: string | null, standby = 'absent', slot = 'app', newTag = true) => {
    fs.rmSync(path.join(modeTmp, '.env.ops'), { force: true });
    if (ops !== null) fs.writeFileSync(path.join(modeTmp, '.env.ops'), ops);
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
REMOTE_DIR="$1" BUILD_DIR="$1" SERVER=synthetic NAME=drill TAG=new HOST_PORT=4000 HOST_ROLE=host
SANDBOX_ENABLED=0 SIDE=1 LIVE_NAME=unused
compose() { printf 'compose[%s]' "$1"; }
perl() { shift 2; "$@"; }
git() { if [ "$NEW_TAG" = 1 ]; then echo '  app-standby:'; fi; }
ssh() {
  shift
  if [ "$1" = bash ]; then
    if [ "$#" = 5 ]; then "$@"; else cat >/dev/null; echo "$ACTIVE_SLOT"; fi
  else
    case "$*" in
      *curl*) return 7 ;;
      *'test -z'*) [ "$FAKE_STANDBY" = absent ]; return $? ;;
    esac
    printf 'SSH %s\\n' "$*"
  fi
}
health_ok() { printf 'SINGLE_HEALTH %s\\n' "$*"; }
rolling_health() { printf 'ROLLING_HEALTH %s\\n' "$*"; }
${selectMode}
echo "MODE=$ROLLING"
${swap}
${rollback}
swap_app
PREV_ROLE=host PREV_REVISION=old
restore_app
rollback_health
`,
        '--',
        modeTmp,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_STANDBY: standby,
          ACTIVE_SLOT: slot,
          NEW_TAG: newTag ? '1' : '0',
          CADDY_DUAL_UPSTREAM: '1', // 本地变量不能绕过服务器缺失的确认。
        },
      },
    );
    assert.ifError(r.error);
    return { code: r.status, out: r.stdout, error: r.stderr };
  };
  for (const ops of [null, '', 'CADDY_DUAL_UPSTREAM=0\n', 'CADDY_DUAL_UPSTREAM=true\n']) {
    for (const standby of ['absent', 'stopped']) {
      const r = modeTrace(ops, standby);
      assert.equal(r.code, 0, r.out + r.error);
      assert.ok(r.error.includes('Caddy 未确认双上游，本次不启用备用'));
      assert.ok(r.out.includes('MODE=0') && r.out.includes('compose[drill:latest] up -d app'));
      assert.ok(r.out.includes('compose[drill:prev] up -d --no-deps app') && r.out.includes('SINGLE_HEALTH old host 4000'));
      assert.ok(!r.out.includes('app-standby') && !r.out.includes('ROLLING_HEALTH'));
    }
    const r = modeTrace(ops, 'running');
    assert.equal(r.code, 1, r.out + r.error);
    assert.ok(r.error.includes('已有 app-standby 运行') && r.error.includes('CADDY_DUAL_UPSTREAM=1'));
    assert.ok(!r.out.includes('up -d') && !r.out.includes('docker stop'));
  }
  const unknown = modeTrace(null, 'error');
  assert.equal(unknown.code, 1);
  assert.ok(unknown.error.includes('无法确认 app-standby 是否运行') && !unknown.out.includes('up -d'));
  for (const ops of ['CADDY_DUAL_UPSTREAM=1\n', ' export CADDY_DUAL_UPSTREAM = "1" # confirmed\r\n', "CADDY_DUAL_UPSTREAM='1'\n"]) {
    for (const slot of ['app', 'app-standby']) {
      const r = modeTrace(ops, 'running', slot);
      assert.equal(r.code, 0, r.out + r.error);
      assert.ok(r.out.includes('MODE=1') && r.out.includes('ROLLING_HEALTH new'));
      assert.ok(r.out.includes(`APP_IMAGE=drill:prev`) && r.out.includes(`up -d --no-deps --force-recreate ${slot}`));
      assert.ok(r.out.includes(`ROLLING_HEALTH old ${slot === 'app' ? 4000 : 4002}`) && !r.out.includes('SINGLE_HEALTH'));
    }
  }
  assert.ok(modeTrace('CADDY_DUAL_UPSTREAM=1\nCADDY_DUAL_UPSTREAM=0\n').out.includes('MODE=0'));
  const literal = modeTrace('CADDY_DUAL_UPSTREAM=$(echo 1)\nUNRELATED=$(echo OPS_SHOULD_NOT_EXECUTE >&2)\n');
  assert.ok(literal.out.includes('MODE=0') && !literal.error.includes('OPS_SHOULD_NOT_EXECUTE'));
  assert.ok(modeTrace('CADDY_DUAL_UPSTREAM=1\n', 'absent', 'app', false).out.includes('MODE=0'));
  const oldTag = modeTrace('CADDY_DUAL_UPSTREAM=1\n', 'stopped', 'app', false);
  assert.equal(oldTag.code, 1);
  assert.ok(oldTag.error.includes('部署旧 tag 前须先停止并删除') && !oldTag.out.includes('up -d'));
} finally {
  fs.rmSync(modeTmp, { recursive: true, force: true });
}
console.log('Caddy 确认：默认单容器、本地变量不覆盖、备用运行/未知时拒绝、开启才滚动、两种模式回滚自测通过');
function swapTrace(primary: string, secondary: string, failHealth = false) {
  const script = `
set -uo pipefail
ROLLING=1 BOOTSTRAP=0 SERVER=synthetic NAME=drill TAG=new
PRIMARY=${primary} SECONDARY=${secondary}
PRIMARY_CONTAINER=old-main PRIMARY_PORT=4000 SECONDARY_PORT=4002
compose() { printf 'compose[%s]' "$1"; }
perl() { shift 2; "$@"; }
ssh() { case "$*" in *curl*) return 7 ;; esac; printf 'SSH %s\\n' "$*"; }
rolling_health() { printf 'HEALTH %s %s\\n' "$1" "$2"; return ${failHealth ? 1 : 0}; }
${swap}
swap_app
`;
  try {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  } catch (error) {
    return String((error as { stdout: string }).stdout);
  }
}
for (const [primary, secondary] of [
  ['app', 'app-standby'],
  ['app-standby', 'app'],
]) {
  const success = swapTrace(primary, secondary);
  const rebuildSpare = success.indexOf(`up -d --no-deps --force-recreate ${secondary}`);
  const stopMain = success.indexOf('docker stop -t 10 old-main');
  const health = success.indexOf('HEALTH new 4002');
  const rebuildMain = success.lastIndexOf(`up -d --no-deps --force-recreate ${primary}`);
  const current = success.indexOf('docker tag drill:latest drill:current');
  assert.ok(rebuildSpare >= 0 && stopMain > rebuildSpare && health > stopMain && rebuildMain > health && current > rebuildMain);
  const failed = swapTrace(primary, secondary, true);
  assert.ok(failed.includes('docker stop -t 10 old-main'));
  assert.ok(!failed.includes(`up -d --no-deps --force-recreate ${primary}\n`));
  assert.ok(!failed.includes('drill:current'));
}
console.log('滚动顺序：两种主备方向、健康失败停止后续替换自测通过');

assert.equal(hasWaitMode(['// TENANT_LOCK_WAIT\n/* TENANT_LOCK_WAIT */']), false);
assert.equal(hasWaitMode(["const wait = process.env.TENANT_LOCK_WAIT === 'forever';"]), true);
const goodReports: DrillResult[] = (Object.keys(metricNames) as Scope[]).map((scope) => ({
  scope,
  scopeComplete: true,
  cleanupComplete: true,
  metrics: Object.fromEntries(
    metricNames[scope].map((key) => [
      key,
      ['sent', 'replied', 'watchBeforeNormal', 'watchAfterNormal', 'rollbackRecovered', 'oldProcessExited'].includes(key)
        ? 1
        : key === 'observationMs'
          ? 4000
          : 0,
    ]),
  ),
}));
assert.equal(acceptanceReport(goodReports).acceptance10to12Complete, true);
for (const report of goodReports) {
  assert.equal(metricsPass(report.scope, emptyMetrics(report.scope)), false);
  for (const key of metricNames[report.scope]) {
    const missing = structuredClone(goodReports);
    missing.find((r) => r.scope === report.scope)!.metrics[key] = null;
    assert.equal(acceptanceReport(missing).acceptance10to12Complete, false, `${report.scope}.${key} 缺失不能通过`);
  }
}
assert.equal(acceptanceReport(goodReports.slice(1)).acceptance10to12Complete, false);
assert.equal(acceptanceReport([...goodReports, goodReports[0]!]).acceptance10to12Complete, false);
assert.equal(metricsPass('containerRolling', { ...goodReports[1]!.metrics, maxWaitMs: 15001 }), false);
assert.equal(metricsPass('processKill', { ...goodReports[2]!.metrics, lockAcquiredMs: 1001 }), false);
for (const key of ['pollStoppedMs', 'listenerClosedMs'])
  assert.equal(metricsPass('processTerminate', { ...goodReports[3]!.metrics, [key]: 1001 }), false);
for (const key of ['dualProcessSentSegments', 'spillEvents'])
  assert.equal(metricsPass('processTerminate', { ...goodReports[3]!.metrics, [key]: 1 }), false);
const customer: CustomerMessage = {
  msgid: 'incoming',
  external_userid: 'wmDrill1',
  open_kfid: 'drill-kf',
  send_time: 1,
  origin: 3,
  msgtype: 'text',
  text: { content: '你好' },
  queuedAt: 10,
};
const send: RequestRecord = {
  process: 'a',
  endpoint: 'kf/send_msg',
  start: 30,
  end: 40,
  body: { touser: customer.external_userid, msgid: 's1' },
};
const row: OutboundRow = { inbound: customer.msgid, msgid: 's1', status: 'accepted', segment: 0, messageSeq: 2 };
const single = summarizeWecom([customer], [send], [row], new Set());
assert.equal(single.replied, 1);
assert.equal(single.perMessage[0]!.replyCount, 1);
assert.equal(single.maxWaitMs, 20);
const split = summarizeWecom(
  [customer],
  [send, { ...send, body: { ...send.body, msgid: 's2' } }],
  [row, { ...row, msgid: 's2', segment: 1 }],
  new Set(),
);
assert.equal(split.duplicateReplies, 0, '一条回复分成两段不是重复回复');
assert.equal(split.perMessage[0]!.replyCount, 1);
const dual = summarizeWecom([customer], [send, { ...send, process: 'b' }], [row], new Set());
assert.equal(dual.dualProcessSentSegments, 1);
assert.equal(dual.perMessage[0]!.replyCount, 2);
assert.ok(dual.duplicateReplies > 0);
const regenerated = summarizeWecom(
  [customer],
  [send, { ...send, process: 'b', body: { ...send.body, msgid: 's2' } }],
  [row, { ...row, msgid: 's2', messageSeq: 3 }],
  new Set(),
);
assert.equal(regenerated.dualProcessSentSegments, 1, '同一入站同一段换 msgid 也不能逃过双进程统计');
assert.equal(regenerated.perMessage[0]!.replyCount, 2);
assert.equal(regenerated.duplicateReplies, 1);
const boundary = summarizeWecom([customer], [], [{ ...row, status: 'unknown' }], new Set(['s1']));
assert.equal(boundary.boundarySegments, 1);
assert.equal(boundary.perMessage[0]!.replyCount, 0);
assert.equal(boundary.missingOutsideBoundary, 0);
assert.equal(boundary.maxWaitMs, null);
const unrelatedUnknown = summarizeWecom([customer], [], [{ ...row, status: 'unknown' }], new Set());
assert.equal(unrelatedUnknown.missingOutsideBoundary, 1);
assert.equal(unrelatedUnknown.boundarySegments, 0, '不能把全部 unknown 都当成 03 R5 边界');
assert.equal(summarizeWecom([customer], [], [], new Set()).missingOutsideBoundary, 1);
const secrets = {
  corpId: 'drill-corp',
  openKfId: 'drill-kf',
  callbackToken: randomBytes(12).toString('hex'),
  callbackAesKey: randomBytes(32).toString('base64').replace(/=$/, ''),
};
const envelope = callbackEnvelope(secrets);
const encrypted = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/.exec(envelope.xml)![1]!;
const query = new URLSearchParams(envelope.query);
assert.equal(computeSignature(secrets.callbackToken, query.get('timestamp')!, query.get('nonce')!, encrypted), query.get('msg_signature'));
const decrypted = decryptWecom(secrets.callbackAesKey, encrypted);
assert.equal(decrypted.receiveId, secrets.corpId);
assert.match(decrypted.msg, /<Event>kf_msg_or_event<\/Event>/);
assert.match(decrypted.msg, /<OpenKfId>drill-kf<\/OpenKfId>/);
console.log('企微统计：分段、双进程重发、sending→unknown 边界、签名加密、缺失数字与阈值自测通过');

// 真正启动预加载模块和本地假服务；不启动应用、不连数据库、不接触真实企微。
const fake = await fakeWecom();
const preloadTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-fetch-test-'));
try {
  const preload = path.join(preloadTmp, 'fetch.mjs');
  fs.copyFileSync('scripts/failover-fetch-preload.mjs', preload);
  fs.writeFileSync(path.join(preloadTmp, 'failover-fetch.json'), JSON.stringify({ origin: fake.origin, auth: fake.auth, process: 'a' }), {
    mode: 0o600,
  });
  fake.messages.push(...Array.from({ length: 101 }, (_, i) => ({ ...customer, msgid: `incoming${i}`, external_userid: `wmDrill${i}` })));
  const script = `
    import assert from 'node:assert/strict';
    const base = 'https://qyapi.weixin.qq.com/cgi-bin/';
    const token = await (await fetch(new URL(base + 'gettoken?corpid=synthetic'))).json();
    assert.equal(token.errcode, 0);
    const first = await (await fetch(new Request(base + 'kf/sync_msg', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({cursor:'0'}) }))).json();
    assert.equal(first.msg_list.length, 100);
    assert.equal(first.msg_list[0].msgid, 'incoming0');
    assert.equal(first.next_cursor, '100');
    assert.equal(first.has_more, 1);
    const next = await (await fetch(base + 'kf/sync_msg', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({cursor:first.next_cursor})})).json();
    assert.equal(next.msg_list.length, 1);
    assert.equal(next.msg_list[0].msgid, 'incoming100');
    assert.equal(next.has_more, 0);
    for (const endpoint of ['kf/send_msg', 'kf/send_msg', 'kf/send_msg_on_event']) {
      await fetch(base + endpoint, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({msgid:'s1', touser:'wmDrill1'})});
    }
    await assert.rejects(fetch('https://example.invalid/'), /drill_unexpected_fetch/);
    await assert.rejects(fetch('http://qyapi.weixin.qq.com/cgi-bin/gettoken'), /drill_unexpected_fetch/);
    await assert.rejects(fetch('https://qyapi.weixin.qq.com.evil.invalid/cgi-bin/gettoken'), /drill_unexpected_fetch/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetch(base + 'gettoken', {signal:controller.signal}));
  `;
  await promisify(execFile)(process.execPath, ['--import', preload, '--input-type=module', '-e', script], {
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(fake.requests.filter((r) => r.endpoint === 'kf/send_msg').length, 2, '相同 msgid 的两次请求不能被假服务去重隐藏');
  assert.ok(fake.requests.every((r) => r.process === 'a'));
  assert.equal(fake.errors.length, 0);
  fake.holdNextSend();
  const heldRequest = fetch(`${fake.origin}/cgi-bin/kf/send_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-drill-auth': fake.auth, 'x-drill-process': 'a' },
    body: JSON.stringify({ msgid: 'held', touser: 'wmDrill1' }),
    signal: AbortSignal.timeout(3000),
  });
  const holdDeadline = Date.now() + 1000;
  while (!fake.hasHeldSend() && Date.now() < holdDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.hasHeldSend(), true);
  assert.equal(fake.requests.at(-1)!.end, null);
  fake.release();
  assert.equal((await heldRequest).status, 200);
} finally {
  await fake.close();
  fs.rmSync(preloadTmp, { recursive: true, force: true });
}
console.log('预加载模块：精确匹配企微地址、Request/URL/body/abort、cursor、发送账本与禁止外联自测通过');
