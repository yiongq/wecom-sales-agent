// 不启动 Docker：保护隔离环境与资源命名边界。
import assert from 'node:assert/strict';
import { previewCookie, previewEnv, previewListenArgs, previewNames } from './preview-stack.js';
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
