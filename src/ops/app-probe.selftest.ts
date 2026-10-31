// 真实 console API + PGlite + 系统 curl + watch.sh；故障注入只在传输层。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { openTestDb, installSeededConfig } from '../db/testing.js';
import { insertTenant } from '../db/repo/tenants.js';
import { imageCode } from '../config/transfer.js';
import { createUser } from '../auth/accounts.js';
import { __authTest } from '../auth/session.js';
import { createIndustrialRuntime } from '../packs/industrial/runtime.js';
import type { Server } from 'node:http';
import { closeConfig, packSources } from '../config/source.js';
import { hostRuntime, createTenantRuntime, withTenantScope } from '../tenancy/runtime.js';
import { installPublicHost } from '../tenancy/hosts.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import { __profileTest } from '../profile.js';

fs.mkdirSync('var', { recursive: true });
const dir = fs.mkdtempSync(path.resolve('var/app-probe-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', LLM_MOCK: '1' });
const bin = path.join(dir, 'bin');
const tmp = path.join(dir, 'tmp');
fs.mkdirSync(bin);
fs.mkdirSync(tmp);
const realCurl = spawnSync('which', ['curl'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
assert.ok(realCurl);
const script = path.resolve('deploy/watch.sh');
const source = fs.readFileSync(script, 'utf8');
assert.doesNotMatch(source, /(?:^|\s)(?:-k|--insecure)(?:\s|$)/m);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const command = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
command('docker', 'exit 1');
command('df', 'echo "fs 100 20 80 20% /"');
// 记录真实 argv，但绝不记录 stdin；真实登录/会话/CSRF 均由真实 API 判定。
command(
  'curl',
  `
for arg in "$@"; do
  url="$arg"
  case "$arg" in */healthz) printf '{"ok":true}'; exit 0 ;; esac
done
printf '%s\\n' "$@" >> "$PROBE_TEST_ARGV"
mode="$(cat "$PROBE_TEST_MODE")"
case "$mode:$url" in
  login:*/login|me:*/me|both:*/me|counts:*/counts|logout:*/logout|both:*/logout) printf 502; exit 0 ;;
  tls:*) exit 60 ;;
esac
exec "$PROBE_TEST_CURL" "$@"
`,
);
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const db = await openTestDb();
let server: ReturnType<typeof serve> | undefined;
let slow = false;
const timers = new Set<ReturnType<typeof setTimeout>>();
const hits: { path: string; cookie: string; csrf: string; status: number }[] = [];
const secrets = new Set<string>();
const password = 'synthetic-probe-"\\$word\nline';
const email = 'probe@app.example.test';
const modeFile = path.join(dir, 'mode');
const argvFile = path.join(dir, 'argv');
const stateFile = path.join(dir, 'watch.state');
const logs: string[] = [];
try {
  await installSeededConfig(db);
  await db.pg.exec('RESET ROLE');
  const industrialRow = await insertTenant(db.db, {
    slug: 'probe-industrial',
    name: '合成工业',
    packId: 'industrial',
    locale: 'zh-CN',
    region: 'CN',
    brand: createIndustrialRuntime(packSources()).defaultBrand,
  });
  const industrial = createTenantRuntime({ id: industrialRow.id, slug: industrialRow.slug });
  await withTenantScope(industrial, () =>
    installSeededConfig(db, {
      slug: industrial.slug,
      dataDir: 'data/packs/industrial',
      deps: {
        ...imageCode(createIndustrialRuntime(packSources())),
        imageSop: fs.readFileSync('data/packs/industrial/sop.md', 'utf8'),
        imageDataDir: path.resolve('data/packs/industrial'),
      },
    }),
  );
  for (const tenant of [rt, industrial]) {
    await db.pg.exec('SET ROLE agent_platform');
    const created = await createUser(db.db, {
      tenantSlug: tenant.slug,
      email: tenant === rt ? 'other@app.example.test' : email,
      name: '拨测成员',
      role: 'agent',
      password: async () => password,
    });
    assert.equal(created.code, 0, created.message);
  }
  await db.pg.exec('SET ROLE agent_app');
  installPublicHost(industrial, 'localhost');
  installPublicHost(rt, '127.0.0.1');
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  // 走完整服务入口：全站中间件（如请求体上限）只在这里，单挂 consoleApi 测不出。
  const { app } = await import('../server.js');
  const http = new Hono()
    .use('*', async (c, next) => {
      if (slow && c.req.path.endsWith('/me')) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            resolve();
          }, 8500);
          timers.add(timer);
        });
      }
      await next();
      for (const folder of fs.readdirSync(tmp)) {
        const privateDir = path.join(tmp, folder);
        assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
        for (const file of fs.readdirSync(privateDir)) assert.equal(fs.statSync(path.join(privateDir, file)).mode & 0o077, 0);
      }
      const cookie = c.req.header('cookie') ?? '';
      const csrf = c.req.header('x-csrf') ?? '';
      if (cookie) secrets.add(cookie.split('=')[1]!);
      if (csrf) secrets.add(csrf);
      hits.push({ path: c.req.path, cookie, csrf, status: c.res.status });
      if (c.req.path.endsWith('/login') && c.res.status === 200) assert.match(c.res.headers.get('set-cookie')!, /; Secure;/);
    })
    .all('*', (c) => app.fetch(c.req.raw, c.env));
  server = serve({ fetch: http.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://localhost:${port}`;
  const base = { PROBE_APP_ORIGIN: origin, PROBE_TENANT_SLUG: industrial.slug, PROBE_EMAIL: email, PROBE_PASSWORD: password };
  fs.writeFileSync(path.join(dir, '.env'), 'DEPLOY_PROFILE=prod\n');
  let now = 1800000000;
  const state = () => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '');
  const reset = () => {
    fs.rmSync(stateFile, { force: true });
  };
  const run = async (config: Record<string, string> = base, mode = '', advance = 60) => {
    __authTest.reset(); // 巡检时钟是合成分钟；不把几十轮巡检挤进真实一分钟的登录限流。
    now += advance;
    fs.writeFileSync(modeFile, mode);
    fs.writeFileSync(argvFile, '');
    fs.writeFileSync(
      path.join(dir, '.env.ops'),
      Object.entries({ COMPOSE_PROJECT: 'probe-test', WATCH_BACKUP: '0', WATCH_STATE: stateFile, ...config })
        .map(([k, v]) => `${k}=${quote(v)}`)
        .join('\n'),
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: tmp,
      WATCH_NOW: String(now),
      PROBE_TEST_MODE: modeFile,
      PROBE_TEST_ARGV: argvFile,
      PROBE_TEST_CURL: realCurl,
    };
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/bash', [script, dir], { env });
      let output = '';
      child.stdout.on('data', (b) => {
        output += b;
      });
      child.stderr.on('data', (b) => {
        output += b;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`watch exit ${code}: ${output}`));
      });
    });
    const argv = fs.readFileSync(argvFile, 'utf8');
    for (const secret of [password, ...secrets]) {
      assert.ok(!argv.includes(secret), '凭据不进入 argv');
      assert.ok(!out.includes(secret), '凭据不进入日志');
    }
    for (const value of [origin, email, industrial.slug, password]) assert.ok(!out.includes(value), '告警不含配置值');
    assert.deepEqual(fs.readdirSync(tmp), [], '所有分支清理临时文件');
    assert.match(state(), /^(?:[a-z0-9_]+=[0-9 :]*\n)*$/);
    logs.push(out);
    return { out, argv };
  };
  const three = async (config = base, mode = '') => {
    assert.doesNotMatch((await run(config, mode)).out, /业务拨测连续/);
    assert.doesNotMatch((await run(config, mode)).out, /业务拨测连续/);
    return (await run(config, mode)).out;
  };
  const before = hits.length;
  assert.equal((await run({})).argv, '');
  assert.equal(hits.length, before);
  assert.doesNotMatch(logs.at(-1)!, /业务拨测/);
  assert.match((await run({ PROBE_EMAIL: email })).out, /业务拨测配置不完整/);
  assert.equal(hits.length, before);
  assert.equal((await run({ PROBE_EMAIL: email })).out, '');
  for (let mask = 1; mask < 15; mask++) {
    reset();
    const partial = Object.fromEntries(Object.entries(base).filter((_, bit) => (mask & (1 << bit)) !== 0));
    assert.match((await run(partial)).out, /业务拨测配置不完整/);
    assert.equal(hits.length, before);
  }
  reset();
  const ok = await run();
  assert.equal(ok.out, '');
  assert.deepEqual(
    hits.slice(-4).map((h) => h.path),
    ['/api/console/auth/login', '/api/console/me', '/api/console/conversations/counts', '/api/console/auth/logout'],
  );
  assert.ok(hits.at(-3)!.cookie && hits.at(-1)!.csrf, '真实 curl 在 localhost 回传 Secure cookie 和 csrf');
  assert.equal(hits.at(-1)!.status, 200);
  const stored = await db.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return {
      sessions: (await tx.query<{ n: number }>('select count(*)::int as n from auth_sessions')).rows[0]!.n,
      audits: (await tx.query<{ n: number }>("select count(*)::int as n from audit_log where action='auth.login'")).rows[0]!.n,
    };
  });
  assert.equal(stored.sessions, 0, '真实退出删除会话');
  assert.equal(stored.audits, 1, '真实登录写入审计');
  const n = hits.length;
  assert.equal((await run(base, '', 599)).argv, '');
  assert.equal(hits.length, n, '健康时间隔内不登录');
  assert.ok((await run(base, '', 1)).argv.includes('/auth/login'));
  assert.equal((await run(base, '', 1)).argv, '');
  assert.ok((await run({ ...base, PROBE_EVERY_S: '2' }, '', 2)).argv.includes('/auth/login'));
  reset();
  assert.match(await three({ ...base, PROBE_PASSWORD: 'wrong-synthetic-password' }), /业务拨测连续 3 次失败（登录，HTTP 401）/);
  assert.equal((await run({ ...base, PROBE_PASSWORD: 'wrong-synthetic-password' })).out, '', '告警去重');
  assert.match((await run({ ...base, PROBE_PASSWORD: 'wrong-synthetic-password' }, '', 1800)).out, /连续 5 次失败/);
  assert.equal((await run()).out, '');
  assert.equal((await run()).out, '');
  assert.equal((await run({ ...base, PROBE_PASSWORD: 'wrong-synthetic-password' })).out, '', '中间失败打断恢复计数');
  assert.equal((await run()).out, '');
  assert.equal((await run()).out, '');
  assert.match((await run()).out, /已恢复：业务拨测连续 3 次成功/);
  assert.equal((await run()).argv, '', '恢复后重新遵守健康间隔');
  reset();
  assert.match(
    await three({ ...base, PROBE_APP_ORIGIN: `http://127.0.0.1:${port}`, PROBE_EMAIL: 'other@app.example.test' }),
    /身份，租户不符/,
  );
  assert.equal(hits.at(-1)!.path, '/api/console/auth/logout');
  assert.equal(hits.at(-1)!.status, 200);
  for (const [mode, step] of [
    ['login', '登录'],
    ['me', '身份'],
    ['counts', '成员资源'],
    ['logout', '退出'],
    ['both', '身份'],
  ] as const) {
    reset();
    assert.match(await three(base, mode), new RegExp(`连续 3 次失败（${step}，HTTP 502）`));
    if (mode !== 'login') assert.match(fs.readFileSync(argvFile, 'utf8'), /\/auth\/logout/, '中途失败仍退出');
    if (mode === 'me' || mode === 'counts') assert.equal(hits.at(-1)!.status, 200);
  }
  reset();
  assert.match(await three(base, 'tls'), /登录，curl 退出码 60/);
  reset();
  // 两次先前失败后，真实 curl 的单请求超时触发第三次；仍退出，网络期限不叠加。
  await run(base, 'me');
  await run(base, 'me');
  slow = true;
  const started = Date.now();
  assert.match((await run()).out, /身份，curl 退出码 28/);
  slow = false;
  assert.ok(Date.now() - started < 40000);
  assert.equal(hits.at(-1)!.path, '/api/console/auth/logout');
  assert.equal(hits.at(-1)!.status, 200);
  console.log('PASS app-probe: real API/curl/watch login → Secure cookie → tenant → counts → csrf/logout; foreign tenant rejected');
  console.log(
    'PASS app-probe: empty/partial config, intervals/retries, 3 failures/recovery/dedupe, HTTP/curl/timeout, cleanup, secret-free argv/logs',
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  (server as Server | undefined)?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  // 各租户配置的锁和定时器都由 closeConfig 收尾。
  const { tenantRuntimes } = await import('../tenancy/runtime.js');
  for (const tenant of tenantRuntimes()) await withTenantScope(tenant, closeConfig);
  await db.close();
  __profileTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
