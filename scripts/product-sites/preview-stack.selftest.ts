// 不启动 Docker：保护隔离环境与资源命名边界。
import assert from 'node:assert/strict';
import { previewEnv, previewNames } from './preview-stack.js';
const env = previewEnv({
  PATH: 'synthetic-path',
  HOME: 'synthetic-home',
  DATABASE_URL: 'forbidden',
  LLM_API_KEY: 'forbidden',
  WECOM_APP_SECRET: 'forbidden',
  ALERT_WEBHOOK_URL: 'forbidden',
  LLM_MOCK: '0',
  FLAG_ANON_READONLY_ADMIN: 'on',
});
assert.equal(env.LLM_MOCK, '1');
assert.equal(env.DEPLOY_PROFILE, 'prod');
assert.equal(env.CONFIG_SOURCE, 'db');
assert.equal(env.SESSION_STORE, 'db');
for (const key of ['DATABASE_URL', 'LLM_API_KEY', 'WECOM_APP_SECRET', 'ALERT_WEBHOOK_URL', 'FLAG_ANON_READONLY_ADMIN'])
  assert.equal(env[key], undefined);
assert.deepEqual(previewNames('abcdef123456'), { container: 'wsa15-preview-abcdef123456', directory: 'preview-abcdef123456' });
for (const invalid of ['../other', 'wsa15-unrelated', '', 'A'.repeat(12)]) assert.throws(() => previewNames(invalid));
console.log('PREVIEW STACK PURE PASS: isolated prod/mock env; owned container/runtime names; no Docker started');
