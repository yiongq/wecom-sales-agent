// 05 第 2 步 / R23：两种配置来源下的首页跳转与旧引导页退役。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-entry-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
for (const key of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[key] = '';

const { app } = await import('./server.js');
const { __profileTest } = await import('./profile.js');
const { initConfig, closeConfig, configMode, __configTest } = await import('./config/source.js');
const { openTestDb, installSeededConfig } = await import('./db/testing.js');
const profiles = [
  { name: 'prod', env: { DEPLOY_PROFILE: 'prod' } },
  { name: 'demo', env: { DEPLOY_PROFILE: 'demo' } },
  { name: 'demo 关模拟器', env: { DEPLOY_PROFILE: 'demo', FLAG_VISITOR_SIMULATOR: 'off' } },
] as const;
const guidePaths = [
  '/guide.html',
  '/GUIDE.HTML',
  '/Guide.Html',
  '/%67uide.html',
  '/%47uide%2eHtml',
  '/%2567uide.html',
  '/guide.html?from=qr',
];

async function checkEntry(source: 'file' | 'db'): Promise<void> {
  assert.equal(configMode(), source);
  for (const { name, env } of profiles) {
    __profileTest.use(env);
    const label = `${source} / ${name}`;
    const home = await app.request('/');
    assert.equal(home.status, 302, `${label}：首页 302`);
    assert.equal(home.headers.get('location'), '/console/', `${label}：首页进工作台`);
    for (const url of guidePaths) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = await app.request(url, { method });
        assert.equal(response.status, 404, `${label}：${method} ${url}`);
      }
    }
  }
}

try {
  await initConfig(null);
  await checkEntry('file');
  const db = await openTestDb();
  try {
    await installSeededConfig(db);
    await checkEntry('db');
  } finally {
    await closeConfig();
    __configTest.reset();
    await db.close();
  }
  console.log('主站入口自测通过：file / db × prod / demo / demo 关模拟器，首页 302 到工作台，旧引导页的大小写与编码写法均 404');
} finally {
  __profileTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
