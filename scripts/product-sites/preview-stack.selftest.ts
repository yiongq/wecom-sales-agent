// 不启动 Docker：保护隔离环境与资源命名边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import {
  consumePreviewInternal,
  previewInternalEnv,
  type PreviewState,
  previewCookie,
  previewEnv,
  previewListenArgs,
  previewNames,
} from './preview-stack.js';
const env = previewEnv({
  PATH: 'synthetic-path',
  HOME: 'synthetic-home',
  DATABASE_URL: 'forbidden',
  LLM_API_KEY: 'forbidden',
  WECOM_APP_SECRET: 'forbidden',
  ALERT_WEBHOOK_URL: 'forbidden',
  LLM_MOCK: '0',
  FLAG_ANON_READONLY_ADMIN: 'on',
  TRIAL_TENANT_ALLOWLIST: 'forbidden',
});
assert.equal(env.LLM_MOCK, '1');
assert.equal(env.DEPLOY_PROFILE, 'prod');
assert.equal(env.CONFIG_SOURCE, 'db');
assert.equal(env.SESSION_STORE, 'db');
for (const key of [
  'DATABASE_URL',
  'LLM_API_KEY',
  'WECOM_APP_SECRET',
  'ALERT_WEBHOOK_URL',
  'FLAG_ANON_READONLY_ADMIN',
  'TRIAL_TENANT_ALLOWLIST',
])
  assert.equal(env[key], undefined);
assert.deepEqual(previewNames('abcdef123456'), { container: 'wsa15-preview-abcdef123456', directory: 'preview-abcdef123456' });
for (const invalid of ['../other', 'wsa15-unrelated', '', 'A'.repeat(12)]) assert.throws(() => previewNames(invalid));
const callback = () => {};
assert.deepEqual(previewListenArgs([3200, undefined, callback]), [3200, '127.0.0.1', callback]);
assert.deepEqual(previewListenArgs([3200, '0.0.0.0', callback]), [3200, '127.0.0.1', callback]);
assert.deepEqual(previewListenArgs([3200, callback]), [3200, '127.0.0.1', callback]);
assert.deepEqual(previewListenArgs([{ port: 3200, host: '::', backlog: 32 }, callback]), [
  { port: 3200, host: '127.0.0.1', backlog: 32 },
  callback,
]);
assert.throws(() => previewListenArgs(['pipe']), /preview_listen_port_required/);
const setCookie = `__Host-sid=${'x'.repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
const url = 'http://localhost:3200/console/';
assert.equal(previewCookie(setCookie, url), setCookie.split(';')[0]);
assert.throws(() => previewCookie(setCookie, 'http://app.example.test/console/'), /preview_cookie_origin/);
assert.throws(() => previewCookie(setCookie, url, 'http://127.0.0.1:3200/'), /preview_cookie_origin/);
for (const broken of [
  null,
  setCookie.replace('__Host-sid', 'sid'),
  setCookie.replace('; Secure', ''),
  setCookie.replace('Path=/', 'Path=/console'),
  setCookie.replace('; HttpOnly', ''),
  setCookie.replace('SameSite=Lax', 'SameSite=None'),
  setCookie.replace('604800', '60'),
  `${setCookie}; Domain=localhost`,
])
  assert.throws(() => previewCookie(broken, url));
console.log(
  'PREVIEW STACK PURE PASS: isolated prod/mock env; loopback binding; unchanged Secure cookie + localhost-only browser policy; no Docker started',
);

// 真正运行内部入口，监听哨兵证明没有尝试连接继承的库；无需 Docker。
let connections = 0;
const sentinel = createServer((socket) => {
  connections++;
  socket.destroy();
});
await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
const port = (sentinel.address() as { port: number }).port;
const savedEnv = { ...process.env };
const runId = randomBytes(6).toString('hex');
const dir = path.resolve('var', previewNames(runId).directory);
fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(dir, 'state.json');
const state: PreviewState = {
  version: 1,
  runId,
  container: previewNames(runId).container,
  postgresPort: port,
  port: 3200,
  controlPort: 3201,
  serverPid: null,
  url: 'http://localhost:3200/console/',
  owner: { email: 'owner@preview.example.test', password: 'synthetic' },
  agent: { email: 'agent@preview.example.test', password: 'synthetic' },
};
fs.writeFileSync(stateFile, JSON.stringify(state));
const database = (user: string) => `postgres://${user}:synthetic@127.0.0.1:${port}/preview`;
const common = { ...previewEnv(savedEnv), DATABASE_URL: database('agent_app') };
try {
  for (const command of ['seed', 'app', 'serve'] as const) {
    for (const token of [undefined, 'f'.repeat(64)]) {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('scripts/product-sites/preview-stack.ts'), command], {
        cwd: dir,
        env: { ...common, DATABASE_OWNER_URL: database('agent_owner'), PREVIEW_INTERNAL_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (b) => {
        output += b;
      });
      child.stderr.on('data', (b) => {
        output += b;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const result = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(result, 1, output);
      assert.match(output, /preview_internal_denied/);
      assert.ok(!output.includes('synthetic@'), '不输出连接串');
    }
    const approved =
      command === 'seed'
        ? {
            ...common,
            DATABASE_OWNER_URL: database('agent_owner'),
            DATABASE_PLATFORM_URL: database('agent_platform'),
          }
        : common;
    const issued = previewInternalEnv(command, state, approved);
    const consume = (candidate = issued, cwd = dir) => consumePreviewInternal(command, candidate, cwd, stateFile);
    assert.throws(
      () => consume({ ...issued, DATABASE_URL: 'postgres://agent_app:synthetic@db.example.test/preview' }),
      /preview_internal_denied/,
    );
    assert.throws(() => consume({ ...issued, DATABASE_URL: database('agent_app') + '?host=db.example.test' }), /preview_internal_denied/);
    assert.throws(() => consume({ ...issued, DATABASE_EXTRA_URL: database('agent_app') }), /preview_internal_denied/);
    assert.throws(() => consume({ ...issued, LLM_API_KEY: 'forbidden' }), /preview_internal_denied/);
    assert.throws(() => consume(issued, path.resolve('.')), /preview_internal_denied/);
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=forbidden');
    assert.throws(() => consume(), /preview_internal_denied/);
    fs.unlinkSync(path.join(dir, '.env'));
    // 即使 ticket 自身被错误签发，也不允许外部端点、非预览库、query 覆盖、额外库身份。
    const ticketPath = path.join(dir, `.internal-${command}.json`);
    const ticket = fs.readFileSync(ticketPath, 'utf8');
    for (const url of [
      'postgres://agent_app:synthetic@db.example.test/preview',
      `postgres://agent_app:synthetic@127.0.0.1:${port + 1}/preview`,
      database('agent_app').replace('/preview', '/other'),
      database('agent_app') + '?host=db.example.test',
    ]) {
      const changed = { ...issued, DATABASE_URL: url };
      fs.writeFileSync(ticketPath, JSON.stringify({ ...JSON.parse(ticket), env: changed }));
      assert.throws(() => consume(changed), /preview_internal_denied/);
    }
    fs.writeFileSync(ticketPath, ticket);
    assert.equal(consume().runId, runId);
    assert.equal(process.env.LLM_MOCK, '1');
    assert.equal(process.env.PREVIEW_INTERNAL_TOKEN, undefined);
    assert.throws(() => consume(), /preview_internal_denied/, '票据只能消费一次');
  }
  assert.equal(connections, 0, '所有被拒入口零数据库连接');
  console.log(
    'PREVIEW INTERNAL PASS: seed/app/serve direct + forged calls exit 1; zero DB connections; run/cwd/env/endpoint checks; one-use tickets',
  );
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await new Promise<void>((resolve, reject) => sentinel.close((err) => (err ? reject(err) : resolve())));
  fs.rmSync(dir, { recursive: true, force: true });
}
