// 15 第 0 步：真实 PG、完整 prod server 启动、HTTP Host/登录/签名回调；只有外部传输与模型替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { UsageView } from '../shared/console-api.js';
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

async function child(): Promise<void> {
  const incoming = new Map<string, KfMessage[]>();
  const sent: Sent[] = [];
  let cursor = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/gettoken')) return Response.json({ access_token: 'synthetic-access', expires_in: 7200 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.includes('/kf/sync_msg')) {
      const page = incoming.get(body.open_kfid) ?? [];
      incoming.delete(body.open_kfid);
      return Response.json({ next_cursor: `c-${++cursor}`, has_more: 0, msg_list: page });
    }
    if (url.includes('/kf/send_msg')) {
      sent.push(body);
      return Response.json({ errcode: 0, msgid: body.msgid ?? `out-${cursor}` });
    }
    if (url.includes('/kf/customer/batchget')) return Response.json({ customer_list: [] });
    throw new Error('product-surface selftest: unexpected external transport');
  };
  // SERVER_SELFTEST 不设置：执行 server.ts 的 profile/preflight/boot/监听/渠道/任务全部生产路径。
  await import('../server.js');
  const { tenantRuntimes, withTenantScope } = await import('./runtime.js');
  const { limitVerdict } = await import('./limits.js');
  const { loadedAccounts } = await import('../channels/accounts.js');
  process.on('message', async (message: { id: number; op: string; kf?: string; messages?: KfMessage[] }) => {
    if (message.op === 'flushUsage')
      for (const rt of tenantRuntimes())
        await withTenantScope(rt, () => import('../trace/usage-daily.js').then((m) => m.flushUsageDaily()));
    if (message.op === 'queue') incoming.set(message.kf!, message.messages!);
    const snapshot: Snapshot = {
      tenants: tenantRuntimes().map((rt) => ({
        id: rt.id,
        slug: rt.slug,
        isHost: rt.isHost,
        verdict: withTenantScope(rt, limitVerdict),
        file: rt.store.fileBackend !== null,
      })),
      accounts: loadedAccounts().map(({ id, key, tenantId, source }) => ({ id, key, tenantId, source })),
      sent: [...sent],
    };
    process.send?.({ id: message.id, snapshot });
  });
  process.send?.({ ready: true });
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
  const { hostOnlyPath } = await import('./hosts.js');
  const { LIMIT_SUSPENDED_REPLY } = await import('./limit-replies.js');
  const { EMERGENCY_REPLY } = await import('../core/engine/index.js');
  const { CONSENT_WITHDRAWN_REPLY } = await import('../handoff/consent.js');
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
      TRIAL_TENANT_ALLOWLIST: JSON.stringify([
        { tenantId: industryId, slug: 'surface-industrial', packId: 'industrial', kind: 'standard', isHost: false },
      ]),
      FOLLOWUP_QUIET_START: '0',
      FOLLOWUP_QUIET_END: '0',
      [CHANNEL_KEY_ENV]: `fixture:${key.toString('base64')}`,
    };
    proc = fork(fileURLToPath(import.meta.url), ['--server'], { cwd: dir, env, execArgv: ['--import', 'tsx'], silent: true });
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
  const login = (host: string, email: string, password = 'synthetic-member-password') =>
    request(host, '/api/console/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `https://${host}` },
      body: JSON.stringify({ email, password }),
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
    if (msgNo === 1) {
      const priorCursor = (await fx.query<{ cursor: string }>('select cursor from channel_accounts where id=$1', [accountId]))[0]!.cursor;
      for (const badKey of [accountId, ownerId]) {
        const rejected = await request(host, `/wecom/callback/${badKey}?${q}`, {
          method: 'POST',
          body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
        });
        assert.equal(rejected.status, 200, '回调 POST 固定确认，必须检查无副作用');
      }
      const badSignature = new URLSearchParams(q);
      badSignature.set('msg_signature', 'invalid');
      await request(host, `/wecom/callback/${accountKey}?${badSignature}`, {
        method: 'POST',
        body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
      });
      await sleep(300);
      assert.equal(
        (await fx.query<{ cursor: string }>('select cursor from channel_accounts where id=$1', [accountId]))[0]!.cursor,
        priorCursor,
      );
      assert.equal((await fx.query('select 1 from channel_inbox where tenant_id=$1', [industryId])).length, 0);
      assert.deepEqual((await rpc()).sent, []);
      console.log('PASS 15 验收 9：错 key/accountId/userId 与坏签名虽 ACK 200，cursor/inbox/外发均零变化，随后正确签名重试');
    }
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
  let ownerId = '';
  let ownerCookie = '';
  async function usage(): Promise<UsageView> {
    await rpc('flushUsage');
    const r = await request(industryHost, '/api/console/usage', { headers: { cookie: ownerCookie } });
    assert.equal(r.status, 200);
    return r.json() as Promise<UsageView>;
  }
  async function checkUi() {
    const ui = fork(path.join(root, 'console/src/settings/settings.selftest.tsx'), ['--real-api'], {
      cwd: root,
      execArgv: ['--import', 'tsx'],
      silent: true,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        TSX_TSCONFIG_PATH: path.join(root, 'console/tsconfig.json'),
        SETTINGS_TEST_ORIGIN: `http://127.0.0.1:${port}`,
        SETTINGS_TEST_TRIAL: '1',
      },
    });
    let out = '';
    ui.stdout!.on('data', (b) => (out += b));
    ui.stderr!.on('data', (b) => (out += b));
    const timer = setTimeout(() => ui.kill('SIGKILL'), 90000);
    const code = await new Promise((resolve) => ui.once('exit', resolve)).finally(() => clearTimeout(timer));
    assert.equal(code, 0, out);
    console.log('PASS 15 验收 9：实际前端 harness 登录→白名单横幅→只读设置→入站引导→真实用量');
  }
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
    const createdOwner = await createUser(platform.db, {
      tenantSlug: 'surface-industrial',
      email: 'owner@settings.example.test',
      name: '合成所有者',
      role: 'owner',
      password: async () => 'synthetic-member-password',
    });
    assert.equal(createdOwner.code, 0);
    ownerId = (await fx.query<{ id: string }>("select id from users where email='owner@settings.example.test'"))[0]!.id;
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
    const hashes = (
      await fx.query("select prompt_hash,tools_hash,prefix_hash,sop_hash from sop_versions where tenant_id=$1 and status='published'", [
        fx.tenantId,
      ])
    )[0];
    assert.deepEqual(hashes, {
      prompt_hash: 'cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900',
      tools_hash: '59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd',
      prefix_hash: '6630127f79d7854ec7d3abe96f1eae65e7acbed09f12a5b1bc22b539fd17e19e',
      sop_hash: '1f850038290b202f66573695faee972bd0b03a3da9ec3e62e665ff5fa6b81ba3',
    });
    console.log('PASS baseline: all four travel hashes unchanged');
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
    console.log('PASS 0.4: prod boot env account belongs only to travel; industrial DB account/key/userId distinct');
    const travelLogin = await login(travelHost, 'surface-travel@erp.example.test');
    assert.equal(travelLogin.status, 200);
    const travelCookie = cookie(travelLogin);
    assert.equal((await travelLogin.json()).sharedTrial, false, '15 验收 9：非白名单租户无共享提示');
    ownerCookie = cookie(await login(industryHost, 'owner@settings.example.test'));
    const beforeUsage = await usage();
    assert.equal(beforeUsage.replies.used, 0);
    assert.equal((await login(industryHost, 'owner@settings.example.test', 'wrong-password')).status, 401);
    assert.equal((await request(industryHost, '/api/console/me', { headers: { cookie: '__Host-sid=invalid' } })).status, 401);
    const industryLogin = await login(industryHost, 'surface-industrial@erp.example.test');
    assert.equal(industryLogin.status, 200);
    const industryCookie = cookie(industryLogin);
    const industryIdentity = (await industryLogin.json()) as { csrf: string; userId: string; sharedTrial: boolean };
    assert.equal(industryIdentity.sharedTrial, true);
    assert.equal(
      industryIdentity.userId,
      (await fx.query<{ id: string }>("select id from users where email='surface-industrial@erp.example.test'"))[0]!.id,
      '15 验收 9：/me userId 必须是认证用户 UUID',
    );
    assert.notEqual(industryIdentity.userId, accountId);
    assert.notEqual(industryIdentity.userId, accountKey);
    // 故意把用户 UUID 当 cookie、把渠道 UUID/用户 UUID 当回调 key，必须由真实授权/路由拒绝。
    assert.equal(
      (await request(industryHost, '/api/console/me', { headers: { cookie: `__Host-sid=${industryIdentity.userId}` } })).status,
      401,
    );
    for (const wrongKey of [accountId, industryIdentity.userId, 'missing-key'])
      assert.equal((await request(industryHost, `/wecom/callback/${wrongKey}`)).status, 404);
    const listed = await request(industryHost, '/api/console/settings/channels', { headers: { cookie: ownerCookie } });
    const configured = (await listed.json()).items.find((a: { accountId: string }) => a.accountId === accountId);
    assert.ok(configured, '15 验收 9：accountId 必须是渠道 UUID');
    assert.equal(configured.key, accountKey, '15 验收 9：key 必须是渠道业务 key');
    assert.notEqual(configured.accountId, configured.key);
    assert.equal((await rpc()).accounts.find((a) => a.id === accountId)?.key, accountKey);
    assert.equal((await request(industryHost, '/api/console/conversations', { headers: { cookie: industryCookie } })).status, 200);
    for (const [url, method] of [
      ['/api/console/sop/draft/check', 'POST'],
      ['/api/console/catalog/part', 'POST'],
    ]) {
      const forbidden = await request(industryHost, url!, {
        method,
        headers: {
          cookie: industryCookie,
          origin: `https://${industryHost}`,
          'content-type': 'application/json',
          'x-csrf': industryIdentity.csrf,
        },
        body: '{}',
      });
      assert.equal(forbidden.status, 403, `15 验收 2：agent 不可修改 ${url}`);
      assert.equal(((await forbidden.json()) as { error: string }).error, 'forbidden', '真实角色拒绝，不能用 CSRF 拒绝代替');
    }
    await message(industryHost, 'wmSurfaceI', '你好，我要询价');
    await until(async () => (await sent('industrial-kf', 'wmSurfaceI')).length > 0, 'industrial engine outbound');
    const counted = await usage();
    assert.equal(counted.replies.used, 1, '15 验收 9：真实回调引擎计数 0→1');
    assert.ok(counted.days.some((d) => d.replies === 1));
    await checkUi();
    await fx.query("update memberships set role='agent' where tenant_id=$1 and user_id=$2", [industryId, ownerId]);
    assert.equal((await request(industryHost, '/api/console/settings/members', { headers: { cookie: ownerCookie } })).status, 403);
    assert.equal((await request(industryHost, '/api/console/usage', { headers: { cookie: ownerCookie } })).status, 403);
    await fx.query("update memberships set role='owner' where tenant_id=$1 and user_id=$2", [industryId, ownerId]);
    console.log('PASS 15 验收 9：accountId/key/userId 错配拒绝、错误登录/失效 cookie/即时降权，真实计数与前端贯穿');
    console.log('PASS 0.2: industrial Host login + authenticated conversations + signed callback/inbox/engine/outbound');
    const paths = [
      '/admin.html',
      '/chat.html',
      '/kf-qr.png',
      '/api/chat',
      '/api/stream',
      '/api/stream/a',
      '/api/sessions',
      '/api/sessions/a',
      '/api/orders',
      '/api/admin',
      '/api/admin/a',
      '/api/usage',
      '/api/insights',
    ];
    for (const url of paths) {
      assert.equal(hostOnlyPath(url), true);
      assert.equal((await request(industryHost, url)).status, 404, url);
    }
    for (const url of ['/try.html', '/api/orders/synthetic/pay', '/pay/synthetic', '/proposal/synthetic'])
      assert.equal(hostOnlyPath(url), false, url);
    assert.equal(
      (await request(industryHost, '/api/orders/synthetic/pay', { method: 'POST' })).status,
      404,
      'anonymous legacy pay hidden by prod',
    );
    const legacyPay = await request(industryHost, '/api/orders/synthetic/pay', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from('admin:synthetic-admin').toString('base64')}` },
    });
    assert.equal(legacyPay.status, 404);
    assert.notEqual(await legacyPay.text(), JSON.stringify({ error: 'order not found' }), '15 验收 7：有效 Basic 也不能到旧支付处理器');
    for (const url of ['/try.html', '/TRY.html/', '/%74ry.html', '/api/orders/synthetic/PAY/', '/api/%6frders/synthetic/pay'])
      for (const method of ['GET', 'POST', 'HEAD'])
        assert.equal((await request(industryHost, url, { method })).status, 404, `15 验收 7 ${method} ${url}`);
    console.log('PASS 15 验收 7: hostOnlyPath matrix + legacy try/pay variants 404, including valid Basic');
    await message(travelHost, 'wmSurfaceT', '你好，想了解行程');
    await until(async () => (await sent('travel-kf', 'wmSurfaceT')).length > 0, 'travel active outbound');
    const changed = Date.now();
    await fx.query("update tenants set status='suspended' where id=$1", [fx.tenantId]);
    await until(
      async () => (await rpc()).tenants.find((t) => t.id === fx.tenantId)?.verdict === 'suspended',
      'real status poll <=30s',
      30_000,
    );
    assert.ok(Date.now() - changed <= 30_000);
    console.log(`PASS 0.1 live poll: suspended effective in ${Date.now() - changed}ms (production timer, no polling hook)`);
    assert.equal((await login(travelHost, 'surface-travel@erp.example.test')).status, 401);
    assert.equal((await request(travelHost, '/api/console/conversations', { headers: { cookie: travelCookie } })).status, 401);
    await message(travelHost, 'wmPaused', '停用后的第一条');
    await until(async () => (await sent('travel-kf', 'wmPaused')).includes(LIMIT_SUSPENDED_REPLY), 'suspended fixed reply');
    await message(travelHost, 'wmPaused', '停用后的第二条');
    await sleep(500);
    assert.deepEqual(await sent('travel-kf', 'wmPaused'), [LIMIT_SUSPENDED_REPLY]);
    await message(travelHost, 'wmEmergency', '我现在被困在山上，找不到路了');
    await until(async () => (await sent('travel-kf', 'wmEmergency')).includes(EMERGENCY_REPLY), 'emergency before suspension');
    await message(travelHost, 'wmWithdraw', '撤回同意，删除我的信息');
    await until(async () => (await sent('travel-kf', 'wmWithdraw')).includes(CONSENT_WITHDRAWN_REPLY), 'withdrawal before suspension');
    await message(industryHost, 'wmSurfaceI', '宿主停用后继续询价');
    await until(async () => (await sent('industrial-kf', 'wmSurfaceI')).length >= 2, 'industrial remains serving');
    // 为既有旅游会话安排到期跟进，再重启预载；没有替换任务 handler 或 limits reader。
    await stop();
    await fx.query(
      `insert into jobs(tenant_id,kind,dedupe_key,payload,run_at,max_attempts) values ($1,'followup','surface-followup',$2,now(),3)`,
      [fx.tenantId, JSON.stringify({ sessionId: 'wecom:wmSurfaceT', stage: 'quote' })],
    );
    await start();
    assert.equal((await rpc()).tenants.find((t) => t.id === fx.tenantId)!.verdict, 'suspended');
    await until(
      async () =>
        (
          await fx.query<{ status: string; last_error: string }>("select status,last_error from jobs where dedupe_key='surface-followup'")
        )[0]?.status === 'cancelled',
      'suspended followup cancelled before eligibility',
    );
    assert.deepEqual(await sent('travel-kf', 'wmSurfaceT'), []);
    assert.equal(
      (await fx.query<{ last_error: string }>("select last_error from jobs where dedupe_key='surface-followup'"))[0]!.last_error,
      'tenant_limit',
    );
    await message(travelHost, 'wmPaused', '重启后的第三条');
    await sleep(500);
    assert.deepEqual(await sent('travel-kf', 'wmPaused'), [], 'fixed reply marker survived restart');
    assert.equal((await login(industryHost, 'surface-industrial@erp.example.test')).status, 200);
    await message(industryHost, 'wmRestartI', '重启后工业询价');
    await until(async () => (await sent('industrial-kf', 'wmRestartI')).length > 0, 'industrial works after suspended-host restart');
    console.log(
      'PASS 0.1/0.3: restart with suspended host, login denied, inbound stored, one fixed reply across restart, emergency/withdrawal priority, no followup',
    );
    const rows = await fx.query<{ tenant_id: string; content: string }>('select tenant_id,content from messages');
    for (const text of ['你好，我要询价', '宿主停用后继续询价', '重启后工业询价'])
      assert.deepEqual(
        rows.filter((r) => r.content === text).map((r) => r.tenant_id),
        [industryId],
      );
    for (const text of ['停用后的第一条', '停用后的第二条', '重启后的第三条'])
      assert.deepEqual(
        rows.filter((r) => r.content === text).map((r) => r.tenant_id),
        [fx.tenantId],
      );
    const freshIndustry = await login(industryHost, 'surface-industrial@erp.example.test');
    const industryView = await request(industryHost, '/api/console/conversations', { headers: { cookie: cookie(freshIndustry) } });
    const viewText = await industryView.text();
    const ownerView = await request(industryHost, '/api/console/conversations', { headers: { cookie: ownerCookie } });
    assert.ok((await ownerView.text()).includes('wmSurfaceI'), '15 验收 9：同租户两个成员共享试用会话');
    assert.ok(viewText.includes('wmSurfaceI'));
    assert.ok(!viewText.includes('wmPaused'));
    await fx.query("update tenants set status='active' where id=$1", [fx.tenantId]);
    await until(async () => (await rpc()).tenants.find((t) => t.id === fx.tenantId)?.verdict === 'ok', 'active restored <=30s', 30_000);
    await message(travelHost, 'wmResume', '恢复后你好');
    await until(async () => (await sent('travel-kf', 'wmResume')).some((s) => s && s !== LIMIT_SUSPENDED_REPLY), 'travel engine restored');
    const resumed = await login(travelHost, 'surface-travel@erp.example.test');
    assert.equal(resumed.status, 200);
    const travelView = await request(travelHost, '/api/console/conversations', { headers: { cookie: cookie(resumed) } });
    assert.ok(!(await travelView.text()).includes('wmSurfaceI'));
    assert.equal((await request(travelHost, '/api/console/conversations', { headers: { cookie: cookie(freshIndustry) } })).status, 401);
    console.log('PASS 0.6: bilateral PG/console/cookie isolation; active restored via real timer and travel replies again');
    await stop();
    await fx.query("update tenants set status='suspended' where id=$1", [fx.tenantId]);
    const { withTenant } = await import('../db/client.js');
    const { updateRetention } = await import('../db/repo/tenants.js');
    const { trialBaseline, trialConversations, trialOrderIds, readTrialBatches } = await import('../db/repo/trial-reset.js');
    await updateRetention(platform.db, industryId, { leadDays: 7, customerDays: 7, traceDays: 7 });
    const trialCtx = { tenantId: industryId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const approval = await withTenant(appDb.db, trialCtx, async (tx) => ({
      allowlist: [{ tenantId: industryId, slug: 'surface-industrial', packId: 'industrial', kind: 'standard', isHost: false }],
      sharedEmail: 'surface-industrial@erp.example.test',
      reviewedConversationRefs: (await trialConversations(tx)).map((r) => r.ref),
      reviewedOrderIds: await trialOrderIds(tx),
      baselineHash: (await trialBaseline(tx)).hash,
    }));
    const approvalFile = path.join(dir, 'trial-approval.json');
    fs.writeFileSync(approvalFile, JSON.stringify(approval));
    async function runReset(batch?: string): Promise<{ code: number | null; log: string }> {
      const reset = fork(
        path.join(root, 'src/cli/trial-reset.ts'),
        [
          '--tenant',
          'surface-industrial',
          '--approval',
          approvalFile,
          '--var',
          path.join(dir, 'server-state'),
          '--password-stdin',
          ...(batch ? ['--batch', batch] : []),
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: fx.urls.app,
            DATABASE_PLATFORM_URL: fx.urls.platform,
            DEFAULT_TENANT_SLUG: 'surface-travel',
          },
          execArgv: ['--import', 'tsx'],
          silent: true,
        },
      );
      reset.stdin!.end('synthetic-reset-password\n');
      let resetLog = '';
      reset.stdout!.on('data', (b) => (resetLog += b));
      reset.stderr!.on('data', (b) => (resetLog += b));
      const resetTimer = setTimeout(() => reset.kill('SIGKILL'), 30_000);
      const resetCode = await new Promise<number | null>((resolve, reject) => {
        reset.once('error', reject);
        reset.once('exit', resolve);
      }).finally(() => clearTimeout(resetTimer));
      return { code: resetCode, log: resetLog };
    }
    await fx.query(
      "create function surface_trial_pause() returns trigger language plpgsql as $$ begin if NEW.action='trial_reset.checkpoint' and NEW.diff->>'phase'='complete' then raise exception 'synthetic_complete_failure'; end if; return NEW; end $$",
    );
    await fx.query('create trigger surface_trial_failure before insert on audit_log for each row execute function surface_trial_pause()');
    const failedReset = await runReset();
    assert.equal(failedReset.code, 1, failedReset.log);
    await assert.rejects(start(), /prod startup failed/);
    await stop();
    assert.match(logs, /trial_reset_incomplete/);
    await fx.query('drop trigger surface_trial_failure on audit_log');
    const pending = await withTenant(appDb.db, trialCtx, readTrialBatches);
    const recovered = await runReset([...pending.keys()][0]!);
    assert.equal(recovered.code, 0, recovered.log);
    const batches = await withTenant(appDb.db, trialCtx, readTrialBatches);
    const seeds = [...batches.values()][0]!.checkpoint.seedIds;
    const staleSpill = path.join(dir, 'server-state', 'store-spill-stale.json');
    const stale = JSON.stringify({ version: 1, tenant: industryId, at: 0, sessions: [{ ref: approval.reviewedConversationRefs[0] }] });
    fs.writeFileSync(staleSpill, stale);
    await assert.rejects(start(), /prod startup failed/);
    await stop();
    assert.match(logs, /trial_reset_replay_unsafe/);
    assert.equal(fs.readFileSync(staleSpill, 'utf8'), stale, '15 验收 6：拒绝前没有回放/改名/删除旧 spill');
    fs.unlinkSync(staleSpill); // 只移除本自测构造的探针；生产恢复材料绝不清文件绕过。
    console.log('PASS 15 验收 6：真实 prod 在 HTTP/任务/渠道前拒绝未完成批次和旧 spill，CLI 同批恢复后才开放');
    await start();
    assert.equal(
      (await request(industryHost, '/api/console/conversations', { headers: { cookie: industryCookie } })).status,
      401,
      '15 验收 6 旧 cookie 失效',
    );
    const newLogin = await login(industryHost, 'surface-industrial@erp.example.test', 'synthetic-reset-password');
    assert.equal(newLogin.status, 200);
    const newIdentity = (await newLogin.json()) as { csrf: string };
    const seedView = await request(industryHost, '/api/console/conversations', { headers: { cookie: cookie(newLogin) } });
    const seedText = await seedView.text();
    for (const seed of seeds) assert.ok(seedText.includes(seed.sessionId), '15 验收 6 重启重建 identity map');
    const handoff = seeds.find((s) => s.key === 'handoff')!.sessionId;
    const replied = await request(industryHost, `/api/console/conversations/${handoff}/reply`, {
      method: 'POST',
      headers: {
        cookie: cookie(newLogin),
        origin: `https://${industryHost}`,
        'content-type': 'application/json',
        'x-csrf': newIdentity.csrf,
      },
      body: JSON.stringify({ text: '合成人工回复', clientId: randomUUID() }),
    });
    assert.equal(replied.status, 200, await replied.text());
    const approved = seeds.find((s) => s.key === 'quote-approved')!.orderId!;
    assert.equal((await request(industryHost, `/quote/${approved}`)).status, 200);
    assert.equal((await request(industryHost, `/api/quotes/${approved}`)).status, 200);
    assert.equal((await request(travelHost, `/quote/${approved}`)).status, 404);
    assert.equal(
      (
        await request(industryHost, `/api/orders/${approved}/pay`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from('admin:synthetic-admin').toString('base64')}` },
        })
      ).status,
      404,
    );
    assert.deepEqual((await rpc()).sent, [], '15 验收 6 PG 种子启动后零客户外发');
    console.log('PASS 15 验收 2/6/7：真实 CLI 重置→prod 重启→新密码/旧 cookie/identity map/种子报价链接/跨租户/零外发');
    assert.equal((await fx.query<{ status: string }>('select status from tenants where id=$1', [fx.tenantId]))[0]!.status, 'suspended');
    assert.ok(!seedText.includes('wmSurfaceI'), '15 验收 9：重置后不复活已清试用消息');
    await message(industryHost, 'wmAfterReset', '重置后试用询价');
    await until(async () => (await sent('industrial-kf', 'wmAfterReset')).length > 0, '15 验收 9：CLI 重置重启后真实引擎发送');
    assert.ok(
      (await (await request(industryHost, '/api/console/conversations', { headers: { cookie: cookie(newLogin) } })).text()).includes(
        'wmAfterReset',
      ),
    );
    ownerCookie = cookie(await login(industryHost, 'owner@settings.example.test'));
    await checkUi();
    assert.ok((await usage()).replies.used >= 4, '15 验收 9：重置/重启保留真实用量并继续计数');
    console.log('PASS 15 验收 9：普通认证/设置→CLI 重置→重启→新签名入站/引擎/发送→共享会话/实际前端/引导/用量闭环');
    console.log('PASS 15 验收 9：两段上线后保持旅游 suspended，重置/重试/重启保留用量且不复活消息');
    console.log('PRODUCT SURFACE SELFTEST PASS: 15 step 0 real PG + production boot');
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
if (process.argv.includes('--server')) await child();
else if (process.env.PG_TEST_URL) await parent(process.env.PG_TEST_URL);
else if (process.env.CI === 'true') throw new Error('15 step 0 requires PG_TEST_URL');
else console.log('PRODUCT SURFACE: PG_TEST_URL not set, real PG validation not run');
