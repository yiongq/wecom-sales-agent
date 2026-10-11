// 05 R23 / 验收 17：宿主体验入口、配置矩阵与 demo 的匿名只读契约。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-entry-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
for (const key of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[key] = '';

const { app } = await import('../server.js');
const { __profileTest } = await import('../profile.js');
const { initConfig, closeConfig, __configTest } = await import('../config/source.js');
const { openTestDb, installSeededConfig } = await import('../db/testing.js');
const oldHost = process.env.SANDBOX_HOST;
const cases = [
  { env: { DEPLOY_PROFILE: 'prod' }, host: '', enabled: false },
  { env: { DEPLOY_PROFILE: 'prod' }, host: 'sandbox.test', enabled: false },
  { env: { DEPLOY_PROFILE: 'demo' }, host: '', enabled: false },
  { env: { DEPLOY_PROFILE: 'demo' }, host: 'sandbox.test', enabled: true },
  { env: { DEPLOY_PROFILE: 'demo', FLAG_VISITOR_SIMULATOR: 'off' }, host: 'sandbox.test', enabled: true },
] as const;

async function matrix(source: string): Promise<void> {
  for (const { env, host, enabled } of cases) {
    __profileTest.use(env);
    process.env.SANDBOX_HOST = host;
    const label = `${source} / ${env.DEPLOY_PROFILE} / host=${!!host}`;
    const entry = await app.request('/api/console/entry');
    assert.equal(entry.status, 200, label);
    assert.deepEqual(await entry.json(), { tryUrl: enabled ? '/try' : null }, label);
    assert.equal(entry.headers.get('cache-control'), 'no-store', label);
    const attempt = await app.request('/try');
    assert.equal(attempt.status, enabled ? 302 : 404, label);
    assert.equal(attempt.headers.get('location'), enabled ? 'https://sandbox.test/try' : null, label);
    assert.equal((await app.request('/')).headers.get('location'), '/console/', label);
    const cover = await app.request('/share-cover.png');
    assert.equal(cover.status, 200, `${label}：登录页产品图可访问`);
    assert.match(cover.headers.get('content-type') ?? '', /^image\/png/);
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  __profileTest.use({ DEPLOY_PROFILE: 'demo' });
  for (const host of [
    'https://sandbox.test',
    'sandbox.test/path',
    'user@sandbox.test',
    'sandbox.test:443',
    'sandbox.test?x=1',
    'sandbox.test#x',
    'sandbox.test\\evil',
    '-bad.test',
  ]) {
    process.env.SANDBOX_HOST = host;
    assert.equal((await app.request('/try')).status, 404, `${source}：无效 Host 不跳转`);
    assert.deepEqual(await (await app.request('/api/console/entry')).json(), { tryUrl: null });
  }
}

try {
  await initConfig(null);
  await matrix('file');
  const db = await openTestDb();
  try {
    await installSeededConfig(db);
    await matrix('db');
    // entry 只是入口配置；匿名包与只读投影以及写操作边界保持原契约。
    assert.equal((await app.request('/api/console/pack')).status, 200);
    assert.deepEqual(await (await app.request('/api/console/status')).json(), { mode: 'db' });
    assert.equal((await app.request('/api/console/sop')).status, 200);
    assert.equal((await app.request('/api/console/catalog/route')).status, 200);
    assert.equal((await app.request('/api/console/auth/logout', { method: 'POST' })).status, 401);
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    assert.equal((await app.request('/api/console/pack')).status, 401);
  } finally {
    await closeConfig();
    __configTest.reset();
    await db.close();
  }
  console.log('体验入口自测通过：file / db 配置矩阵、无效 Host、匿名只读投影与写操作边界');
} finally {
  __profileTest.reset();
  if (oldHost === undefined) delete process.env.SANDBOX_HOST;
  else process.env.SANDBOX_HOST = oldHost;
  fs.rmSync(dir, { recursive: true, force: true });
}
