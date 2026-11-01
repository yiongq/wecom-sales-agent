// 15 验收 3/4/5：真实 PG、完整 prod server 启动、HTTP Host/登录/签名回调；只有外部传输与模型替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { KfMessage } from '../adapters/wecom-state.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(label);
}
interface Sent {
  open_kfid: string;
  touser: string;
  text?: { content: string };
}
interface Snapshot {
  tenants: { id: string; slug: string; isHost: boolean; verdict: string; file: boolean }[];
  accounts: { id: string; key: string; tenantId: string; source: string }[];
  sent: Sent[];
}

async function parent(superUrl: string): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  fs.mkdirSync(path.join(root, 'var'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'var/wsa15-surface-'));
  // env.ts 只会看到本次空目录；不读取开发机 .env。镜像内容仍使用仓库原文件。
  for (const name of ['data', 'public', 'console']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
  const oldCwd = process.cwd();
  process.chdir(dir);
  await import('../selftest-env.js');
  Object.assign(process.env, { VAR_DIR: path.join(dir, 'parent-state'), CONFIG_SOURCE: 'file', LLM_MOCK: '1' });
  const testing = await import('../db/testing.js');
  const { openDb, holdTenantLock } = await import('../db/client.js');
  const { importConfig } = await import('../config/transfer.js');
  const { readImageSop } = await import('../config/brand.js');
  const { createUser } = await import('../auth/accounts.js');
  const { sealSecrets, CHANNEL_KEY_ENV } = await import('../channels/secrets.js');
  const { computeSignature } = await import('../wecom-crypto.js');
  const fx = await testing.createRealPgFixture(superUrl, { slug: 'surface-travel' });
  const appDb = await openDb(fx.urls.app);
  const platform = await openDb(fx.urls.platform);
  const travelHost = 'travel.erp.example.test';
  const industryHost = 'app.erp.example.test';
  const accountId = randomUUID();
  const accountKey = 'industrial-main';
  const key = randomBytes(32);
  const aes = randomBytes(32);
  const callbackToken = 'synthetic-callback';
  const ring = { current: { id: 'fixture', key }, all: new Map([['fixture', key]]) };
  let proc: ChildProcess | null = null;
  let port = 0;
  let seq = 0;
  let logs = '';
  const pending = new Map<number, (s: Snapshot) => void>();
  async function rpc(op = 'snapshot', extra: object = {}): Promise<Snapshot> {
    assert.ok(proc?.connected, 'server child must be connected');
    const id = ++seq;
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('server observation timeout'));
      }, 5000);
      pending.set(id, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      proc!.send({ id, op, ...extra });
    });
  }
  async function stop(): Promise<void> {
    if (!proc) return;
    const p = proc;
    proc = null;
    if (p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => p.kill('SIGKILL'), 12_000);
      p.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }
  async function request(host: string, url: string, init: RequestInit = {}): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: url,
          method: init.method ?? 'GET',
          headers: { ...Object.fromEntries(new Headers(init.headers)), host },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
      req.end(init.body as string | undefined);
    });
  }
  async function start(): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logs = '';
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      DEPLOY_PROFILE: 'prod',
      APP_ROLE: 'host',
      CONFIG_SOURCE: 'db',
      SESSION_STORE: 'db',
      DATABASE_URL: fx.urls.app,
      DEFAULT_TENANT_SLUG: 'surface-travel',
      PUBLIC_BASE_URL: `https://${travelHost}`,
      PORT: String(port),
      VAR_DIR: path.join(dir, 'server-state'),
      ADMIN_PASS: 'synthetic-admin',
      LLM_MOCK: '1',
      SOP_GATE: '',
      LLM_API_KEY: 'synthetic-model',
      LLM_BASE_URL: 'https://erp.example.test/v1',
      EMBED_API_KEY: '',
      EMBED_BASE_URL: 'https://erp.example.test/v1',
      WECOM_CORP_ID: 'synthetic-travel-corp',
      WECOM_APP_SECRET: 'synthetic-travel-secret',
      WECOM_KF_OPEN_KFID: 'travel-kf',
      WECOM_CALLBACK_TOKEN: callbackToken,
      WECOM_CALLBACK_AES_KEY: aes.toString('base64').replace(/=$/, ''),
      WECOM_POLL_INTERVAL_MS: '3600000',
      FOLLOWUP_ENABLED: '1',
      FOLLOWUP_QUIET_START: '0',
      FOLLOWUP_QUIET_END: '0',
      [CHANNEL_KEY_ENV]: `fixture:${key.toString('base64')}`,
    };
    proc = fork(fileURLToPath(new URL('../tenancy/product-surface.selftest.ts', import.meta.url)), ['--server'], {
      cwd: dir,
      env,
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    proc.stdout!.on('data', (b) => {
      logs += String(b);
    });
    proc.stderr!.on('data', (b) => {
      logs += String(b);
    });
    let ready = false;
    proc.on('message', (m: { ready?: boolean; id?: number; snapshot: Snapshot }) => {
      if (m.ready) ready = true;
      if (m.id) {
        pending.get(m.id)?.(m.snapshot);
        pending.delete(m.id);
      }
    });
    await until(async () => {
      assert.ok(proc!.exitCode === null, `prod startup failed: ${logs}`);
      return ready;
    }, 'production startup timeout');
    await until(async () => {
      try {
        return (await request(industryHost, '/healthz')).status === 200;
      } catch {
        return false;
      }
    }, 'listener readiness');
  }
  async function checkUi(role: 'owner' | 'agent'): Promise<void> {
    const ui = fork(fileURLToPath(new URL('../../console/src/settings/settings.selftest.tsx', import.meta.url)), ['--real-api'], {
      cwd: root,
      execArgv: ['--import', 'tsx'],
      silent: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        TSX_TSCONFIG_PATH: path.join(root, 'console/tsconfig.json'),
        SETTINGS_TEST_ORIGIN: `http://127.0.0.1:${port}`,
        SETTINGS_TEST_ROLE: role,
      },
    });
    let output = '';
    ui.stdout!.on('data', (b) => {
      output += String(b);
    });
    ui.stderr!.on('data', (b) => {
      output += String(b);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => ui.kill('SIGKILL'), 90_000);
      ui.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ui.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`settings real UI ${role} exit=${code} signal=${signal}: ${output}`));
      });
    });
    for (const line of output.split('\n')) if (line.includes('REAL UI PASS')) console.log(line);
  }
  const login = (host: string, email: string) =>
    request(host, '/api/console/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `https://${host}` },
      body: JSON.stringify({ email, password: 'synthetic-member-password' }),
    });
  const cookie = (r: Response): string => {
    const c = r.headers.get('set-cookie')?.split(';')[0];
    assert.ok(c);
    return c;
  };
  let msgNo = 0;
  async function message(host: string, uid: string, text: string): Promise<void> {
    const industrial = host === industryHost;
    const kf = industrial ? 'industrial-kf' : 'travel-kf';
    const m: KfMessage = {
      msgid: `surface-${++msgNo}`,
      open_kfid: kf,
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: text },
    };
    await rpc('queue', { kf, messages: [m] });
    const plain = Buffer.from(`<xml><Token>synthetic-sync</Token><OpenKfId>${kf}</OpenKfId></xml>`);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(plain.length);
    const raw = Buffer.concat([randomBytes(16), len, plain, Buffer.from(industrial ? 'synthetic-industry-corp' : 'synthetic-travel-corp')]);
    const padding = 32 - (raw.length % 32);
    const cipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16));
    cipher.setAutoPadding(false);
    const encrypt = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const q = new URLSearchParams({
      timestamp,
      nonce: 'synthetic-nonce',
      msg_signature: computeSignature(callbackToken, timestamp, 'synthetic-nonce', encrypt),
    });
    const r = await request(host, `/wecom/callback${industrial ? `/${accountKey}` : ''}?${q}`, {
      method: 'POST',
      body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    });
    assert.equal(r.status, 200);
    await until(
      async () =>
        (await fx.query('select 1 from messages where tenant_id=$1 and content=$2', [industrial ? industryId : fx.tenantId, text])).length >
        0,
      `inbound persisted: ${text}`,
    );
  }
  const sent = async (kf: string, uid: string) =>
    (await rpc()).sent.filter((s) => s.open_kfid === kf && s.touser === uid).map((s) => s.text?.content);
  let industryId = '';
  try {
    await fx.query('update tenants set public_host=$2 where id=$1', [fx.tenantId, travelHost]);
    industryId = (
      await fx.query<{ id: string }>(
        "insert into tenants(slug,name,pack_id,public_host) values ('surface-industrial','合成工业','industrial',$1) returning id",
        [industryHost],
      )
    )[0]!.id;
    const { createIndustrialRuntime } = await import('../packs/industrial/runtime.js');
    const { packSources } = await import('../config/source.js');
    await fx.query('update tenants set brand=$2 where id=$1', [
      industryId,
      JSON.stringify(createIndustrialRuntime(packSources()).defaultBrand),
    ]);
    for (const [slug, dataDir] of [
      ['surface-travel', 'data'],
      ['surface-industrial', 'data/packs/industrial'],
    ]) {
      const result = await importConfig({
        db: appDb.db,
        tenantSlug: slug!,
        dataDir: path.join(root, dataDir!),
        imageSop: readImageSop,
        lock: (id) => holdTenantLock(fx.urls.app, id),
      });
      assert.equal(result.code, 0, result.message);
      const resultUser = await createUser(platform.db, {
        tenantSlug: slug!,
        email: `${slug}@erp.example.test`,
        name: '合成成员',
        role: 'agent',
        password: async () => 'synthetic-member-password',
      });
      assert.equal(resultUser.code, 0, resultUser.message);
    }
    // 同意/行权路径按 02 契约只在已发布隐私说明时启用；由真实启动读取，不能用 __privacyTest 注入。
    for (const id of [fx.tenantId, industryId])
      await fx.query("insert into privacy_notices(tenant_id,version,body) values ($1,1,'合成隐私说明')", [id]);
    const sealed = sealSecrets(
      ring,
      { tenantId: industryId, accountId },
      { appSecret: 'synthetic-industry-secret', callbackToken, callbackAesKey: aes.toString('base64').replace(/=$/, '') },
    );
    await fx.query(
      `insert into channel_accounts(tenant_id,id,key,name,kind,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id,cursor)
      values ($1,$2,$3,'合成渠道','wecom_kf','active','wecom:','synthetic-industry-corp','industrial-kf',decode($4,'hex'),$5,'started')`,
      [industryId, accountId, accountKey, sealed.ct.toString('hex'), sealed.keyId],
    );
    const ownerResult = await createUser(platform.db, {
      tenantSlug: 'surface-industrial',
      email: 'owner@settings.example.test',
      name: '合成所有者',
      role: 'owner',
      password: async () => 'synthetic-member-password',
    });
    assert.equal(ownerResult.code, 0, ownerResult.message);
    await start();
    assert.match(logs, /\[profile\] prod/);
    const initial = await rpc();
    assert.deepEqual(initial.tenants.map((t) => [t.slug, t.isHost, t.verdict]).sort(), [
      ['surface-industrial', false, 'ok'],
      ['surface-travel', true, 'ok'],
    ]);
    assert.equal(initial.tenants.find((t) => t.id === industryId)!.file, false);
    assert.deepEqual(
      initial.accounts.map((a) => [a.tenantId, a.source, a.key]).sort(),
      [
        [fx.tenantId, 'env', 'env'],
        [industryId, 'db', accountKey],
      ].sort(),
    );
    assert.notEqual(accountId, accountKey);
    const users = await fx.query<{ id: string }>('select id from users');
    assert.ok(users.every((u) => u.id !== accountId && u.id !== accountKey));
    console.log('15 验收 4 PASS: prod boot env account belongs only to travel; industrial DB account/key/userId distinct');
    const industryLogin = await login(industryHost, 'surface-industrial@erp.example.test');
    assert.equal(industryLogin.status, 200);
    const industryCookie = cookie(industryLogin);
    const ownerLogin = await login(industryHost, 'owner@settings.example.test');
    assert.equal(ownerLogin.status, 200);
    const ownerCookie = cookie(ownerLogin);
    const setting = (page: string, memberCookie = ownerCookie) =>
      request(industryHost, `/api/console/settings/${page}`, { headers: { cookie: memberCookie } });
    for (const page of ['organization', 'members', 'channels', 'onboarding']) {
      assert.equal((await setting(page)).status, 200);
      assert.equal((await setting(page, industryCookie)).status, 403);
      assert.equal((await request(industryHost, `/api/console/settings/${page}`)).status, 401);
      assert.equal((await request(travelHost, `/api/console/settings/${page}`, { headers: { cookie: ownerCookie } })).status, 401);
    }
    for (const url of ['/api/console/sop/draft', '/api/console/catalog/product']) {
      const r = await request(industryHost, url, {
        method: url.includes('/sop/') ? 'PUT' : 'POST',
        headers: {
          cookie: industryCookie,
          'x-csrf': (await industryLogin.clone().json()).csrf,
          'content-type': 'application/json',
          origin: `https://${industryHost}`,
        },
        body: '{}',
      });
      assert.equal(r.status, 403, '15 验收 2 agent cannot edit');
    }
    const before = (await (await setting('channels')).json()).items;
    assert.deepEqual(
      before.map((a: { accountId: string; key: string; loaded: boolean; lastInboundAt: string | null }) => [
        a.accountId,
        a.key,
        a.loaded,
        a.lastInboundAt,
      ]),
      [[accountId, accountKey, true, null]],
    );
    assert.equal((await (await setting('onboarding')).json()).steps.find((s: { key: string }) => s.key === 'channel').state, 'todo');
    // 有效 GET 握手也不等于客户消息。
    const echo = Buffer.from('synthetic-echo');
    const echoLen = Buffer.alloc(4);
    echoLen.writeUInt32BE(echo.length);
    const echoRaw = Buffer.concat([randomBytes(16), echoLen, echo, Buffer.from('synthetic-industry-corp')]);
    const echoPadding = 32 - (echoRaw.length % 32);
    const echoCipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16));
    echoCipher.setAutoPadding(false);
    const encryptedEcho = Buffer.concat([
      echoCipher.update(Buffer.concat([echoRaw, Buffer.alloc(echoPadding, echoPadding)])),
      echoCipher.final(),
    ]).toString('base64');
    const echoTime = String(Math.floor(Date.now() / 1000));
    const handshakeQuery = new URLSearchParams({
      timestamp: echoTime,
      nonce: 'synthetic-handshake',
      echostr: encryptedEcho,
      msg_signature: computeSignature(callbackToken, echoTime, 'synthetic-handshake', encryptedEcho),
    });
    const handshake = await request(industryHost, `/wecom/callback/${accountKey}?${handshakeQuery}`);
    assert.equal(handshake.status, 200);
    assert.equal(await handshake.text(), 'synthetic-echo');
    assert.equal((await (await setting('onboarding')).json()).steps.find((s: { key: string }) => s.key === 'channel').state, 'todo');
    await message(industryHost, 'wmSurfaceI', '你好，我要询价');
    await until(async () => (await sent('industrial-kf', 'wmSurfaceI')).length > 0, 'industrial engine outbound');
    console.log('15 验收 5 PASS: industrial Host login + authenticated conversations + signed callback/inbox/engine/outbound');
    const after = (await (await setting('channels')).json()).items;
    assert.equal(after.length, 1);
    assert.equal(after[0].loaded, true);
    assert.equal(after[0].credentialsConfigured, true);
    assert.ok(after[0].lastInboundAt);
    assert.equal(after[0].callbackPath, `/wecom/callback/${accountKey}`);
    assert.deepEqual(
      Object.keys(after[0]).sort(),
      [
        'accountId',
        'key',
        'name',
        'kind',
        'source',
        'enabled',
        'loaded',
        'blockedByProfile',
        'credentialsConfigured',
        'callbackPath',
        'lastInboundAt',
      ].sort(),
    );
    assert.ok(!JSON.stringify(after).includes('synthetic-industry-corp'));
    assert.equal((await (await setting('onboarding')).json()).steps.find((s: { key: string }) => s.key === 'channel').state, 'done');
    console.log(
      '15 验收 4/5 PASS: real prod boot/Host/login/DB account + signed callback/inbox/engine/send → settings inbound and onboarding done',
    );
    await checkUi('owner');
    await stop();
    await start();
    const renewed = await login(industryHost, 'owner@settings.example.test');
    const freshCookie = cookie(renewed);
    assert.equal(
      (await (await setting('onboarding', freshCookie)).json()).steps.find((s: { key: string }) => s.key === 'channel').state,
      'done',
    );
    await fx.query(
      "update memberships set role='agent' where tenant_id=$1 and user_id=(select id from users where email='owner@settings.example.test')",
      [industryId],
    );
    for (const page of ['organization', 'members', 'channels', 'onboarding']) assert.equal((await setting(page, freshCookie)).status, 403);
    await checkUi('agent');
    console.log(
      '15 验收 3 PASS: restart preserves real inbound evidence, owner downgraded → all settings 403; agent SOP/catalog writes denied',
    );
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    await stop();
    await platform.close();
    await appDb.close();
    await fx.drop();
    process.chdir(oldCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.env.PG_TEST_URL) await parent(process.env.PG_TEST_URL);
else if (process.env.CI === 'true') throw new Error('15 settings e2e requires PG_TEST_URL');
else console.log('15 SETTINGS E2E: PG_TEST_URL missing, real PG not run');
