import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { productPathClosed } from './paths.js';
import { resolveProfile } from '../../profile.js';
import { assertTrialReplaySafe } from './startup.js';
import { planTrialReset } from './seeds.js';

fs.mkdirSync('var', { recursive: true });
const dir = fs.mkdtempSync(path.resolve('var/wsa15-deploy-'));
const run = (cmd: string, args: string[], env = process.env) => spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30_000 });
try {
  const checkpoint = { ...planTrialReset(['00000000-0000-4000-8000-000000000015']), phase: 'complete' as const };
  const batches = new Map([[checkpoint.batch, { checkpoint, plannedAt: new Date(1), updatedAt: new Date(10) }]]);
  const replay = path.join(dir, 'store-spill-synthetic.json');
  fs.writeFileSync(
    replay,
    JSON.stringify({ version: 1, tenant: 'synthetic', at: 20, sessions: [{ ref: checkpoint.targetConversationRefs[0] }] }),
  );
  assert.throws(() => assertTrialReplaySafe(batches, 'synthetic', dir), /trial_reset_replay_unsafe/);
  fs.writeFileSync(
    replay,
    JSON.stringify({ version: 1, tenant: 'synthetic', at: 20, sessions: [{ ref: '00000000-0000-4000-8000-000000000016' }] }),
  );
  assertTrialReplaySafe(batches, 'synthetic', dir);
  fs.unlinkSync(replay);
  const sentinel = path.join(dir, 'restored-from-backup.json');
  fs.writeFileSync(sentinel, JSON.stringify({ backupAt: new Date(0).toISOString() }));
  assert.throws(() => assertTrialReplaySafe(batches, 'synthetic', dir), /trial_reset_replay_unsafe/);
  fs.unlinkSync(sentinel);
  console.log('PASS 15 验收 6：完成后拒绝旧 ref/旧备份恢复，新 spill 仍可走原流程');
  for (const value of [
    '/try.html',
    '/TRY.html/',
    '/%74ry.html',
    '/api/orders/x/pay',
    '/API/ORDERS/x/PAY/',
    '/api/%6frders/x/pay/',
    '/admin.html',
    '/api/sessions/a',
  ])
    assert.equal(productPathClosed(value), true, value);
  for (const value of [
    '/quote/ord_abc',
    '/api/quotes/ord_abc',
    '/api/orders/ord_abc',
    '/console/',
    '/api/console/conversations',
    '/wecom/callback/main',
  ])
    assert.equal(productPathClosed(value), false, value);
  const flags = [
    'RESET_COMMAND',
    'ANON_READONLY_ADMIN',
    'SEED_FRESHEN',
    'VISITOR_SIMULATOR',
    'MOCK_PAY',
    'WEB_CHANNEL',
    'LEGACY_ADMIN_WRITES',
  ];
  for (const flag of flags) assert.throws(() => resolveProfile({ DEPLOY_PROFILE: 'prod', [`FLAG_${flag}`]: 'on' }));
  assert.equal(resolveProfile({ DEPLOY_PROFILE: 'prod' }).flags.web_channel, false);
  for (const env of [
    { DEPLOY_PROFILE: 'prod', ADMIN_PASS: '' },
    { DEPLOY_PROFILE: 'prod', ADMIN_PASS: 'synthetic-admin', FLAG_WEB_CHANNEL: 'on' },
  ]) {
    const result = run(process.execPath, ['--import', 'tsx', 'src/profile-boot.ts'], { PATH: process.env.PATH, ...env });
    assert.notEqual(result.status, 0);
  }
  const correct = run(process.execPath, ['--import', 'tsx', 'src/profile-boot.ts'], {
    PATH: process.env.PATH,
    DEPLOY_PROFILE: 'prod',
    ADMIN_PASS: 'synthetic-admin',
  });
  assert.equal(correct.status, 0, correct.stderr);
  console.log('PASS 15 验收 7：prod 真实启动预检、缺密码与七个越权 FLAG 拒绝、web_channel 封顶');
  // 执行部署入口同一预检，docker shim 只模拟“本路沙箱容器存在/不存在”，不碰机器上的容器。
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const containerMarker = path.join(dir, 'sandbox-container');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n[ -f "$TRIAL_CONTAINER_MARKER" ]\n', { mode: 0o755 });
  const appEnv = path.join(dir, 'app-env'),
    sandboxEnv = path.join(dir, 'sandbox-env');
  fs.writeFileSync(appEnv, 'DEPLOY_PROFILE=prod\n');
  fs.writeFileSync(sandboxEnv, 'DEPLOY_PROFILE=demo\n');
  const deployedCheck = fs.readFileSync('deploy.sh', 'utf8').match(/<<'PRODUCT_SANDBOX'\n([\s\S]*?)\nPRODUCT_SANDBOX/)!;
  assert.ok(deployedCheck);
  const checkFile = path.join(dir, 'check-sandbox.sh');
  fs.writeFileSync(checkFile, deployedCheck[1]!);
  const check = () =>
    run('bash', [checkFile, appEnv, sandboxEnv, 'wsa15-test-sandbox'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRIAL_CONTAINER_MARKER: containerMarker,
    });
  for (const raw of [
    'DEPLOY_PROFILE=prod\n',
    ' \tDEPLOY_PROFILE=prod\n',
    '\ufeff  DEPLOY_PROFILE=prod\r\n',
    '# comment\r\nDEPLOY_PROFILE=demo\r\n DEPLOY_PROFILE=prod\r\n',
  ]) {
    fs.writeFileSync(appEnv, raw);
    const result = check();
    assert.equal(result.status, 1, JSON.stringify(raw));
    assert.match(result.stderr, /prod 要求完成 05 长期停用/);
  }
  for (const raw of [
    'DEPLOY_PROFILE="prod"\n',
    "DEPLOY_PROFILE='prod'\n",
    'DEPLOY_PROFILE="prod\n',
    'DEPLOY_PROFILE=prod # comment\n',
    'DEPLOY_PROFILE =prod\n',
    'DEPLOY_PROFILE\n',
    'DEPLOY_PROFILE=unknown\n',
    '\u00a0DEPLOY_PROFILE=prod\n',
    'BROKEN KEY=value\nDEPLOY_PROFILE=demo\n',
  ]) {
    fs.writeFileSync(appEnv, raw);
    const result = check();
    assert.equal(result.status, 1, JSON.stringify(raw));
    assert.match(result.stderr, /env\/profile 解析失败/);
  }
  fs.writeFileSync(appEnv, 'DEPLOY_PROFILE=prod\nDEPLOY_PROFILE=demo\n');
  assert.equal(check().status, 0, 'raw env 重复键取最后一个，demo 保留沙箱');
  fs.writeFileSync(appEnv, 'DEPLOY_PROFILE=prod\n');
  assert.equal(check().status, 1);
  fs.renameSync(sandboxEnv, `${sandboxEnv}.off`);
  assert.equal(check().status, 0);
  fs.writeFileSync(containerMarker, 'stopped');
  assert.equal(check().status, 1);
  fs.unlinkSync(containerMarker);
  fs.writeFileSync(appEnv, 'DEPLOY_PROFILE=demo\n');
  fs.writeFileSync(sandboxEnv, 'DEPLOY_PROFILE=demo\n');
  assert.equal(check().status, 0);
  console.log('PASS 15 评审：实际 shell 片段覆盖空白、BOM、CRLF、引号原样拒绝、重复键最后值、损坏 env 失败关闭');
  console.log('PASS 15 验收 8：部署入口 prod 沙箱 env/残留容器拒绝、env 改名通过、demo 沙箱能力保留（shell 集成）');
  if (process.env.PRODUCT_CADDY_TEST === '1') {
    const name = 'wsa15-c-caddy';
    const image = 'caddy:2.11.2-alpine';
    const hits: { host: string; url: string; method: string; body: string; forwarded?: string; xfh?: string }[] = [];
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const hit = {
        host: req.headers.host!,
        url: req.url!,
        method: req.method!,
        body: Buffer.concat(chunks).toString(),
        forwarded: req.headers.forwarded,
        xfh: req.headers['x-forwarded-host'] as string | undefined,
      };
      hits.push(hit);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(hit));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    // 只在本地测试关 TLS 并改监听口；所有匹配器、代理与路由来自提交的模板。
    const raw = fs.readFileSync('deploy/product-surface/Caddyfile', 'utf8');
    const template = raw
      .replaceAll(/https:\/\/\{\$(PRODUCT_[A-Z_]+HOST)\}/g, (_, key: string) => `http://{$${key}}:8080`)
      .replace('http:// {', ':8081 {')
      .replace('https:// {', ':8080 {');
    const caddyfile = path.join(dir, 'Caddyfile');
    fs.writeFileSync(caddyfile, `{\n admin off\n auto_https off\n}\n${template}`);
    fs.mkdirSync(path.join(dir, 'www'));
    fs.writeFileSync(path.join(dir, 'www/index.html'), '合成官网');
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs/index.html'), '合成文档');
    const envs = {
      PRODUCT_WWW_HOST: 'www.example.test',
      PRODUCT_DOCS_HOST: 'docs.example.test',
      PRODUCT_APP_HOST: 'app.example.test',
      PRODUCT_OLD_INDUSTRIAL_HOST: 'old.example.test',
      PRODUCT_TRAVEL_HOST: 'travel.example.test',
      PRODUCT_TRAVEL_CALLBACK_KEY: 'travel-main',
      PRODUCT_WWW_ROOT: '/fixture/www',
      PRODUCT_DOCS_ROOT: '/fixture/docs',
      PRODUCT_UPSTREAM: `host.docker.internal:${upstreamPort}`,
    };
    const docker = (args: string[]) => run('docker', args);
    const modelRoot = path.join(dir, 'model');
    fs.mkdirSync(path.join(modelRoot, 'deploy'), { recursive: true });
    const modelFile = path.join(modelRoot, 'deploy/compose.yml');
    fs.copyFileSync('deploy/compose.yml', modelFile);
    for (const file of ['.env', '.env.db', '.env.migrate', '.env.platform'])
      fs.writeFileSync(path.join(modelRoot, file), 'DEPLOY_PROFILE=prod\n');
    fs.writeFileSync(path.join(modelRoot, '.env.sandbox'), 'DEPLOY_PROFILE=demo\n');
    fs.renameSync(path.join(modelRoot, '.env.sandbox'), path.join(modelRoot, '.env.sandbox.off'));
    try {
      const composeArgs = ['-p', 'wsa15-c-model', '--env-file', path.join(modelRoot, '.env'), '-f', modelFile, 'config', '--services'];
      const model = process.env.DOCKER_COMPOSE_BIN
        ? run(process.env.DOCKER_COMPOSE_BIN, composeArgs, { ...process.env, APP_CONTAINER: 'wsa15-c-model' })
        : run('docker', ['compose', ...composeArgs], { ...process.env, APP_CONTAINER: 'wsa15-c-model' });
      assert.equal(model.status, 0, model.stderr);
      assert.ok(model.stdout.split('\n').includes('app'));
      assert.ok(!model.stdout.split('\n').includes('sandbox'));
      console.log('PASS 15 验收 8：真实 compose 默认 profile 在 env 改名后不包含 sandbox');
      const started = docker([
        'run',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::8080',
        '-v',
        `${dir}:/fixture:ro`,
        ...Object.entries(envs).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        image,
        'caddy',
        'run',
        '--config',
        '/fixture/Caddyfile',
        '--adapter',
        'caddyfile',
      ]);
      assert.equal(started.status, 0, started.stderr);
      const port = Number(docker(['port', name, '8080/tcp']).stdout.trim().split(':').at(-1));
      assert.ok(port);
      const http = (host: string, url: string, method = 'GET', body = '') =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port,
              path: url,
              method,
              headers: {
                host,
                'x-forwarded-host': 'travel.example.test',
                forwarded: 'host=travel.example.test',
                'content-length': Buffer.byteLength(body),
              },
              timeout: 5000,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (b) => chunks.push(b));
              res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
            },
          );
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('proxy timeout')));
          req.end(body);
        });
      let ready = false;
      for (let n = 0; n < 50; n++) {
        try {
          await http('unknown.example.test', '/');
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(ready, docker(['logs', name]).stderr);
      for (const method of ['GET', 'POST'])
        for (const url of [
          '/wecom/callback?signature=synthetic',
          '/wecom/callback/industrial-main?x=1%2F2',
          '/quote/ord_seed_0123456789abcdef-0123456789abcdef01234567?v=1',
        ]) {
          const result = await http('old.example.test', url, method, method === 'POST' ? 'synthetic=request&x=1%2F2' : '');
          assert.equal(result.status, 200, result.body);
          const hit = JSON.parse(result.body);
          assert.equal(hit.host, 'app.example.test');
          assert.equal(hit.url, url);
          assert.equal(hit.method, method);
          assert.equal(hit.body, method === 'POST' ? 'synthetic=request&x=1%2F2' : '');
          assert.ok(!hit.forwarded);
          assert.ok(!hit.xfh);
        }
      for (const url of ['/wecom/callback?x=1', '/wecom/callback/travel-main?x=1'])
        for (const method of ['GET', 'POST']) {
          const r = await http('travel.example.test', url, method, 'synthetic');
          assert.equal(r.status, 200, `${method} ${url} ${r.body} ${docker(['logs', name]).stderr}`);
          assert.equal(JSON.parse(r.body).host, 'travel.example.test');
        }
      const before = hits.length;
      for (const url of [
        '/',
        '/pay/old',
        '/api/orders/old',
        '/admin.html',
        '/try.html',
        '/wecom/callback/other',
        '/WECOM/callback',
        '/%77ecom/callback',
        '/wecom/callback/',
        '//wecom/callback',
        '/wecom/callback/%74ravel-main',
        '/wecom/callback/travel-main/',
      ])
        for (const method of ['GET', 'POST', 'HEAD'])
          assert.equal((await http('travel.example.test', url, method)).status, 410, `${method} ${url}`);
      assert.equal((await http('travel.example.test', '/wecom/callback', 'PUT')).status, 410);
      assert.equal(hits.length, before);
      assert.equal((await http('unknown.example.test', '/api/console')).status, 421);
      assert.match((await http('www.example.test', '/')).body, /合成官网/);
      assert.equal((await http('www.example.test', '/api/console')).status, 404);
      assert.match((await http('docs.example.test', '/')).body, /合成文档/);
      console.log(
        'PASS 15 验收 7–8：真实 Caddy 固定 Host、旧回调 POST/query/body 原样、旅游严格白名单及路径变体、未知 Host 拒绝、静态根隔离',
      );
    } finally {
      docker(['rm', '-fv', name]);
      await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
    }
  } else console.log('CADDY: PRODUCT_CADDY_TEST=1 enables disposable proxy validation');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
