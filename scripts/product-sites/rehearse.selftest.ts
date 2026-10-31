// 15 验收 10–11：仅本机一次性镜像演练；绝不加载工作目录的 env，绝不连接已有容器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
fs.mkdirSync(path.join(root, 'var'), { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'var/wsa15-rehearse-'));
const prefix = `wsa15-rehearse-${randomBytes(4).toString('hex')}`;
const names = { pg: `${prefix}-pg`, app: `${prefix}-app`, proxy: `${prefix}-proxy` };
const current = process.env.PRODUCT_CURRENT_IMAGE;
const previous = process.env.PRODUCT_R6_IMAGE;
if (!current || !previous) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('15 验收 10–11 IMAGE SKIP: PRODUCT_CURRENT_IMAGE / PRODUCT_R6_IMAGE required');
} else {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: `unix://${process.env.HOME}/.colima/default/docker.sock`,
    DOCKER_CONFIG: path.join(dir, 'docker-config'),
  };
  fs.mkdirSync(env.DOCKER_CONFIG);
  async function run(args: string[], input?: string, deadline = 120000): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out: out.trim() });
      });
    });
  }
  async function docker(args: string[], input?: string) {
    const r = await run(args, input);
    assert.equal(r.code, 0, r.out);
    return r.out;
  }
  async function until(check: () => Promise<boolean>, label: string, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(200);
    }
    throw new Error(label);
  }
  let fx: Awaited<ReturnType<(typeof import('../../src/db/testing.js'))['createRealPgFixture']>> | undefined;
  let ca: string | undefined;
  let proxyPort = 0;
  const host = {
    app: 'app.example.test',
    www: 'www.example.test',
    docs: 'docs.example.test',
    old: 'old.example.test',
    travel: 'travel.example.test',
  };
  async function http(h: string, p: string, method = 'GET', body = '', cookie = '', trusted = true) {
    return new Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          servername: h,
          ca: trusted ? ca : undefined,
          path: p,
          method,
          headers: { host: h, origin: `https://${h}`, 'content-type': 'application/json', cookie, 'x-forwarded-host': host.travel },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('HTTPS deadline')));
      req.end(body);
    });
  }
  try {
    await docker(['network', 'create', prefix]);
    await docker([
      'run',
      '-d',
      '--name',
      names.pg,
      '--network',
      prefix,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:pg17',
    ]);
    await until(async () => (await run(['exec', names.pg, 'pg_isready', '-U', 'postgres'])).code === 0, 'PG not ready');
    const pgPort = Number((await docker(['port', names.pg, '5432/tcp'])).split(':').at(-1));
    for (const name of ['data', 'public', 'console']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
    process.chdir(dir);
    await import('../../src/selftest-env.js');
    const { createRealPgFixture } = await import('../../src/db/testing.js');
    fx = await createRealPgFixture(`postgres://postgres@127.0.0.1:${pgPort}/postgres`);
    await fx.query('delete from tenants where id=$1', [fx.tenantId]);
    const accounts = {
      owner: { email: 'owner@rehearsal.example.test', password: randomBytes(20).toString('hex') },
      agent: { email: 'agent@rehearsal.example.test', password: randomBytes(20).toString('hex') },
    };
    await (await import('./preview-data.js')).seedPreview(fx.urls, accounts);
    const ids = await fx.query<{ id: string; slug: string }>('select id,slug from tenants');
    const industrial = ids.find((t) => t.slug === 'preview-industrial')!.id,
      travel = ids.find((t) => t.slug === 'preview-travel')!.id;
    await fx.query("update tenants set public_host=case when id=$1 then $2 else $3 end,status='active'", [
      industrial,
      host.app,
      host.travel,
    ]);
    await fx.query('update tenants set retention_lead_days=7,retention_customer_days=7,retention_trace_days=7 where id=$1', [industrial]);
    const appUrl = new URL(fx.urls.app);
    appUrl.hostname = names.pg;
    appUrl.port = '5432';
    const key = randomBytes(32),
      aes = randomBytes(32),
      token = 'synthetic-rehearsal-token';
    const ringName = (await import('../../src/channels/secrets.js')).CHANNEL_KEY_ENV;
    const secrets = path.join(dir, 'channel.json');
    fs.writeFileSync(
      secrets,
      JSON.stringify({
        corpId: 'synthetic-rehearsal-corp',
        openKfId: 'rehearsal-kf',
        appSecret: 'synthetic-rehearsal-secret',
        callbackToken: token,
        callbackAesKey: aes.toString('base64').replace(/=$/, ''),
      }),
      { mode: 0o600 },
    );
    const { runChannelAccount } = await import('../../src/cli/channel-account.js');
    const { openDb, holdTenantLock } = await import('../../src/db/client.js');
    process.env[ringName] = `fixture:${key.toString('base64')}`;
    assert.equal(
      await runChannelAccount(
        ['add-wecom', '--tenant', 'preview-industrial', '--key', 'image-main', '--name', '合成渠道', '--secrets-file', secrets],
        {
          connect: async () => {
            const db = await openDb(fx!.urls.app);
            return { db: db.db, close: db.close, lock: (id) => holdTenantLock(fx!.urls.app, id) };
          },
        },
      ),
      0,
    );
    const account = (await fx.query<{ id: string }>('select id from channel_accounts where tenant_id=$1', [industrial]))[0]!;
    const state = path.join(dir, 'state');
    fs.mkdirSync(state, { mode: 0o777 });
    fs.chmodSync(state, 0o777);
    fs.writeFileSync(
      path.join(dir, 'transport.mjs'),
      `import fs from 'node:fs';
const file='/fixture/incoming.json';
globalThis.fetch=async(input,init)=>{const url=String(input),body=JSON.parse(String(init?.body??'{}'));
if(url.includes('/gettoken'))return Response.json({access_token:'synthetic',expires_in:7200});
if(url.includes('/kf/sync_msg')){const messages=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];fs.writeFileSync(file,'[]');return Response.json({next_cursor:messages.length?'image-'+Date.now():(body.cursor||'image-initial'),has_more:0,msg_list:messages});}
if(url.includes('/kf/send_msg')){fs.appendFileSync('/fixture/sent.jsonl',JSON.stringify(body)+'\\n');return Response.json({errcode:0,msgid:body.msgid});}
if(url.includes('/kf/customer/batchget'))return Response.json({customer_list:[]});throw new Error('unexpected external request');};`,
    );
    fs.writeFileSync(path.join(dir, 'incoming.json'), '[]', { mode: 0o666 });
    fs.chmodSync(path.join(dir, 'incoming.json'), 0o666);
    fs.writeFileSync(path.join(dir, 'sent.jsonl'), '', { mode: 0o666 });
    fs.chmodSync(path.join(dir, 'sent.jsonl'), 0o666);
    fs.chmodSync(dir, 0o755);
    const baseEnv = {
      DEPLOY_PROFILE: 'prod',
      APP_ROLE: 'host',
      CONFIG_SOURCE: 'db',
      SESSION_STORE: 'db',
      DATABASE_URL: appUrl.href,
      DEFAULT_TENANT_SLUG: 'preview-travel',
      PUBLIC_BASE_URL: `https://${host.travel}`,
      ADMIN_PASS: randomBytes(16).toString('hex'),
      LLM_MOCK: '1',
      LLM_API_KEY: 'synthetic',
      FOLLOWUP_ENABLED: '0',
      VAR_DIR: '/fixture/state',
      [ringName]: process.env[ringName]!,
      TRIAL_TENANT_ALLOWLIST: JSON.stringify([
        { tenantId: industrial, slug: 'preview-industrial', packId: 'industrial', kind: 'standard', isHost: false },
      ]),
    };
    const approved = await docker(['image', 'inspect', '--format', '{{.Id}}', previous]);
    async function verifyRollback(image: string) {
      assert.equal(await docker(['image', 'inspect', '--format', '{{.Id}}', image]), approved, 'rollback_target_not_verified_R6');
    }
    async function start(image: string, extra: Record<string, string> = {}) {
      await run(['rm', '-fv', names.app]);
      await docker([
        'run',
        '-d',
        '--name',
        names.app,
        '--network',
        prefix,
        '-v',
        `${dir}:/fixture`,
        ...Object.entries({ ...baseEnv, ...extra }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        image,
        'node',
        '--import',
        'tsx',
        '--import',
        '/fixture/transport.mjs',
        'src/server.ts',
      ]);
    }
    async function ready() {
      await until(async () => {
        try {
          return (await http(host.app, '/api/console/auth/login', 'POST', JSON.stringify(accounts.owner))).status === 200;
        } catch {
          return false;
        }
      }, 'industrial login readiness');
    }
    async function login() {
      const r = await http(host.app, '/api/console/auth/login', 'POST', JSON.stringify(accounts.owner));
      assert.equal(r.status, 200, r.text);
      const c = r.headers['set-cookie']![0]!;
      assert.match(c, /^__Host-sid=/);
      for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(c.includes(a));
      assert.ok(!/Domain=/i.test(c));
      return c.split(';')[0]!;
    }
    for (const [name, source] of [
      ['www', 'site/dist'],
      ['docs', 'docs-site/dist'],
    ]) {
      assert.ok(fs.existsSync(path.join(root, source)));
      fs.cpSync(path.join(root, source), path.join(dir, name), { recursive: true });
    }
    const config =
      '{\n admin 0.0.0.0:2019\n auto_https disable_redirects\n local_certs\n}\n' +
      fs.readFileSync(path.join(root, 'deploy/product-surface/Caddyfile'), 'utf8');
    fs.writeFileSync(path.join(dir, 'Caddyfile'), config);
    const caddyEnv = {
      PRODUCT_WWW_HOST: host.www,
      PRODUCT_DOCS_HOST: host.docs,
      PRODUCT_APP_HOST: host.app,
      PRODUCT_OLD_INDUSTRIAL_HOST: host.old,
      PRODUCT_TRAVEL_HOST: host.travel,
      PRODUCT_TRAVEL_CALLBACK_KEY: 'travel-main',
      PRODUCT_UPSTREAM: `${names.app}:3200`,
      PRODUCT_WWW_ROOT: '/fixture/www',
      PRODUCT_DOCS_ROOT: '/fixture/docs',
    };
    await start(previous);
    await docker([
      'run',
      '--rm',
      '--name',
      `${prefix}-validate`,
      '--network',
      prefix,
      '-v',
      `${dir}:/fixture:ro`,
      ...Object.entries(caddyEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'caddy:2.11.2',
      'caddy',
      'adapt',
      '--validate',
      '--config',
      '/fixture/Caddyfile',
      '--adapter',
      'caddyfile',
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      names.proxy,
      '--network',
      prefix,
      '-p',
      '127.0.0.1::443',
      '-v',
      `${dir}:/fixture:ro`,
      ...Object.entries(caddyEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'caddy:2.11.2',
      'caddy',
      'run',
      '--config',
      '/fixture/Caddyfile',
      '--adapter',
      'caddyfile',
    ]);
    proxyPort = Number((await docker(['port', names.proxy, '443/tcp'])).split(':').at(-1));
    await until(async () => {
      const r = await run(['exec', names.proxy, 'cat', '/data/caddy/pki/authorities/local/root.crt']);
      if (r.code !== 0) return false;
      ca = r.out;
      return true;
    }, 'local CA not ready');
    await ready();
    let cookie = await login();
    assert.equal(
      JSON.parse((await http(host.app, '/api/console/me', 'GET', '', cookie)).text).sharedTrial,
      undefined,
      'baseline image is the previously verified R6 release',
    );
    assert.equal((await fx.query<{ status: string }>('select status from tenants where id=$1', [travel]))[0]!.status, 'active');
    console.log('PASS 15 验收 10–11：先发布真实 R6 镜像，旅游 active，工业独立 HTTPS 普通登录和正式 cookie');
    await start(current);
    await ready();
    cookie = await login();
    assert.equal(JSON.parse((await http(host.app, '/api/console/me', 'GET', '', cookie)).text).sharedTrial, true);
    await fx.query("update tenants set status='suspended' where id=$1", [travel]);
    await until(async () => {
      await run(['stop', '-t', '10', names.app]);
      await start(current);
      await ready();
      return true;
    }, 'suspended restart');
    cookie = await login();
    for (const h of [host.www, host.docs]) assert.equal((await http(h, '/')).status, 200);
    const homepage = await http(host.www, '/');
    assert.ok(homepage.text.includes(`https://${host.app}/`));
    assert.ok(homepage.text.includes(`https://${host.docs}`));
    for (const p of ['/pay/old', '/api/orders/old', '/console/', '/PAY/old/', '/api/%6frders/old/pay'])
      assert.equal((await http(host.travel, p)).status, 410);
    assert.equal((await http(host.old, '/console/')).status, 200);
    const quote = (
      await fx.query<{ id: string }>("select id from orders where tenant_id=$1 and data->'approval'->>'state'='approved'", [industrial])
    )[0];
    assert.ok(quote);
    assert.equal((await http(host.old, `/quote/${quote.id}?version=1`)).status, 200);
    await assert.rejects(http(host.app, '/', 'GET', '', '', false));
    const unknown = await assert.rejects(http('unknown.example.test', '/'));
    void unknown;
    console.log('PASS 15 验收 10：www/app/docs TLS、CA 不信任/未知 SNI 拒绝、旧工业报价、旅游支付/客户页 410');
    const { computeSignature } = await import('../../src/wecom-crypto.js');
    let messageNo = 0;
    async function message(text: string) {
      const sendsBefore = fs.readFileSync(path.join(dir, 'sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
      const msg = {
        msgid: `image-${++messageNo}`,
        open_kfid: 'rehearsal-kf',
        external_userid: 'wmImageTrial',
        send_time: Math.floor(Date.now() / 1000),
        origin: 3,
        msgtype: 'text',
        text: { content: text },
      };
      fs.writeFileSync(path.join(dir, 'incoming.json'), JSON.stringify([msg]));
      const plain = Buffer.from('<xml><Token>synthetic</Token><OpenKfId>rehearsal-kf</OpenKfId></xml>'),
        len = Buffer.alloc(4);
      len.writeUInt32BE(plain.length);
      const raw = Buffer.concat([randomBytes(16), len, plain, Buffer.from('synthetic-rehearsal-corp')]),
        padding = 32 - (raw.length % 32);
      const cipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16));
      cipher.setAutoPadding(false);
      const encrypt = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString(
        'base64',
      );
      const q = new URLSearchParams({ timestamp: String(Math.floor(Date.now() / 1000)), nonce: 'synthetic' });
      q.set('msg_signature', computeSignature(token, q.get('timestamp')!, 'synthetic', encrypt));
      const r = await http(host.old, `/wecom/callback/image-main?${q}`, 'POST', `<xml><Encrypt>${encrypt}</Encrypt></xml>`);
      assert.equal(r.status, 200);
      assert.ok(!r.headers.location);
      await until(
        async () => (await fx!.query('select 1 from messages where tenant_id=$1 and content=$2', [industrial, text])).length === 1,
        'image inbound persisted',
      );
      await until(
        async () => fs.readFileSync(path.join(dir, 'sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length > sendsBefore,
        'image outbound',
      );
    }
    await message('镜像切换后的询价');
    await docker(['stop', '-t', '10', names.app]);
    const snapshot = await fx.query('select id,cursor from channel_accounts where tenant_id=$1', [industrial]);
    const persisted = await fx.query('select content from messages where tenant_id=$1 order by conversation_id,seq', [industrial]);
    const audits = await fx.query('select id from audit_log where tenant_id=$1 order by id', [industrial]);
    // 私有签收后运行真实双身份 CLI；删除两类消息，随后在回退镜像检查不复活。
    const { withTenant } = await import('../../src/db/client.js');
    const repo = await import('../../src/db/repo/trial-reset.js');
    const db = await openDb(fx.urls.app);
    const ctx = { tenantId: industrial, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const approval = await withTenant(db.db, ctx, async (tx) => ({
      allowlist: JSON.parse(baseEnv.TRIAL_TENANT_ALLOWLIST),
      sharedEmail: accounts.agent.email,
      reviewedConversationRefs: (await repo.trialConversations(tx)).map((r) => r.ref),
      reviewedOrderIds: await repo.trialOrderIds(tx),
      baselineHash: (await repo.trialBaseline(tx)).hash,
    }));
    await db.close();
    fs.writeFileSync(path.join(dir, 'approval.json'), JSON.stringify(approval), { mode: 0o600 });
    const platformUrl = new URL(fx.urls.platform);
    platformUrl.hostname = names.pg;
    platformUrl.port = '5432';
    const reset = await run(
      [
        'run',
        '--rm',
        '--user',
        '0',
        '--name',
        `${prefix}-reset`,
        '--network',
        prefix,
        '-i',
        '-v',
        `${dir}:/fixture`,
        ...Object.entries({
          DATABASE_URL: appUrl.href,
          DATABASE_PLATFORM_URL: platformUrl.href,
          DEFAULT_TENANT_SLUG: 'preview-travel',
        }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        current,
        'node',
        '--import',
        'tsx',
        'src/cli/trial-reset.ts',
        '--tenant',
        'preview-industrial',
        '--approval',
        '/fixture/approval.json',
        '--var',
        '/fixture/state',
        '--password-stdin',
      ],
      `${accounts.agent.password}\n`,
    );
    assert.equal(reset.code, 0, reset.out);
    await start(current);
    await ready();
    await message('重置后的新消息');
    await docker(['stop', '-t', '10', names.app]);
    const latest = await fx.query('select id,cursor from channel_accounts where tenant_id=$1', [industrial]);
    const latestMessages = await fx.query('select content from messages where tenant_id=$1 order by conversation_id,seq', [industrial]);
    const latestAudit = await fx.query('select id from audit_log where tenant_id=$1 order by id', [industrial]);
    const latestUsage = await fx.query('select * from usage_daily where tenant_id=$1 order by day,model,purpose', [industrial]);
    const latestSends = fs.readFileSync(path.join(dir, 'sent.jsonl'), 'utf8');
    assert.ok(latestMessages.length > 0);
    assert.ok(!JSON.stringify(latestMessages).includes('镜像切换后的询价'));
    assert.notDeepEqual(latest, snapshot);
    assert.notDeepEqual(latestMessages, persisted);
    assert.ok(latestAudit.length > audits.length);
    // 配置错误与服务切换失败：坏实例启动必须失败，恢复已验证镜像后数据保持。
    await start(current, { FLAG_WEB_CHANNEL: 'on' });
    await until(
      async () => (await docker(['inspect', '--format', '{{.State.Running}}', names.app])) === 'false',
      'bad config failed closed',
    );
    assert.equal((await http(host.app, '/api/console/me')).status, 502);
    // 旧镜像仅接受已动态验证 R6 的不可变镜像 ID；基础镜像不在签收中。
    await assert.rejects(verifyRollback('node:22-alpine'), /rollback_target_not_verified_R6/);
    await verifyRollback(previous);
    await start(previous);
    await ready();
    cookie = await login();
    assert.deepEqual(await fx.query('select id,cursor from channel_accounts where tenant_id=$1', [industrial]), latest);
    assert.deepEqual(
      await fx.query('select content from messages where tenant_id=$1 order by conversation_id,seq', [industrial]),
      latestMessages,
    );
    assert.deepEqual(await fx.query('select * from usage_daily where tenant_id=$1 order by day,model,purpose', [industrial]), latestUsage);
    assert.equal(fs.readFileSync(path.join(dir, 'sent.jsonl'), 'utf8'), latestSends, 'restart and rollback must not resend');
    assert.equal((await http(host.old, `/quote/${quote.id}`)).status, 404, 'reset historical link remains unavailable after rollback');
    assert.equal((await fx.query<{ status: string }>('select status from tenants where id=$1', [travel]))[0]!.status, 'suspended');
    assert.deepEqual(
      (await fx.query<{ id: number }>('select id from audit_log where tenant_id=$1 order by id', [industrial])).slice(
        0,
        latestAudit.length,
      ),
      latestAudit,
    );
    assert.equal((await http(host.travel, '/pay/old')).status, 410);
    await message('回退后继续询价');
    const sendIds = fs
      .readFileSync(path.join(dir, 'sent.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).msgid);
    assert.equal(new Set(sendIds).size, sendIds.length, 'external send IDs are unique across restart and rollback');
    console.log(
      'PASS 15 验收 11：配置/服务切换失败 502，回退已签收 R6 镜像；旅游 suspended、prod、无沙箱，保留新消息/cursor/审计，不复活重置前消息，回退后继续收发',
    );
    const index = path.join(dir, 'www/index.html');
    fs.renameSync(index, `${index}.off`);
    assert.equal((await http(host.www, '/index.html')).status, 404);
    fs.renameSync(`${index}.off`, index);
    assert.equal((await http(host.www, '/')).status, 200);
    fs.writeFileSync(path.join(dir, 'broken.Caddyfile'), 'invalid_directive\n');
    const rejected = await run(['exec', names.proxy, 'caddy', 'reload', '--config', '/fixture/broken.Caddyfile', '--adapter', 'caddyfile']);
    assert.notEqual(rejected.code, 0);
    assert.equal((await http(host.www, '/')).status, 200);
    console.log(
      'PASS 15 验收 10–11：静态资源 404→恢复 200；无效代理配置 reload 拒绝且旧站继续服务；全部真实镜像/PG/HTTPS，无浏览器/真实模型',
    );
    assert.equal(account.id, latest[0] && (latest[0] as { id: string }).id);
  } finally {
    for (const name of [names.app, names.proxy, `${prefix}-reset`, `${prefix}-validate`]) await run(['rm', '-fv', name]);
    await fx?.drop();
    await run(['rm', '-fv', names.pg]);
    await run(['network', 'rm', prefix]);
    process.chdir(root);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
