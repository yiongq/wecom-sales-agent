// 17 验收 13：真实 PG、完整 prod server 启动、HTTP Host/登录/签名回调；只有外部传输与模型替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { DailyOpsPoint, MetricsTrendsView, RegressionDraft, TurnTraceDetailView, TracePage } from '../shared/console-api.js';
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

async function child(): Promise<void> {
  const incoming = new Map<string, KfMessage[]>();
  const sent: Sent[] = [];
  let cursor = 0;
  const networkFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === process.env.ALERT_WEBHOOK_URL) return networkFetch(input, init);
    if (url === 'https://model.example.test/v1/chat/completions')
      return Response.json({
        choices: [{ message: { role: 'assistant', content: '您好，请提供询价型号。合成回复青瓷河流' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    if (url === 'https://open.bigmodel.cn/api/paas/v4/embeddings') {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: texts.map(() => ({ embedding: [1, ...Array<number>(2047).fill(0)] })), usage: { prompt_tokens: 0 } });
    }
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
    throw new Error(`observability selftest: unexpected external transport ${new URL(url).pathname}`);
  };
  // SERVER_SELFTEST 不设置：执行 server.ts 的 profile/preflight/boot/监听/渠道/任务全部生产路径。
  await import('../server.js');
  const { tenantRuntimes, withTenantScope } = await import('../tenancy/runtime.js');
  const { limitVerdict } = await import('../tenancy/limits.js');
  const { loadedAccounts } = await import('../channels/accounts.js');
  process.on(
    'message',
    async (message: { id: number; op: string; kf?: string; messages?: KfMessage[]; minute?: boolean; clock?: number }) => {
      if (message.op === 'clock') {
        process.env.PARITY_CLOCK_MS = String(message.clock);
        await import(`../store/parity-clock.js?at=${message.clock}`);
      }
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
    },
  );
  process.send?.({ ready: true });
}

async function parent(superUrl: string): Promise<void> {
  const began = performance.now();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  process.env.TZ = 'Asia/Shanghai';
  const now = new Date();
  const early = Math.min(now.getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 2).getTime());
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 2).getTime();
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = `${yesterdayStart.getFullYear()}-${String(yesterdayStart.getMonth() + 1).padStart(2, '0')}-${String(yesterdayStart.getDate()).padStart(2, '0')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa17-observability-'));
  // env.ts 只会看到本次空目录；不读取开发机 .env。镜像内容仍使用仓库原文件。
  for (const name of ['data', 'public', 'console', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
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
  const notifications: string[] = [];
  const receiver = (await import('node:http')).createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    notifications.push(JSON.parse(Buffer.concat(chunks).toString()).text.content);
    res.end(JSON.stringify({ errcode: 0 }));
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const webhookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  // 预加载脚本仅驱动生产 startOpsMinute 创建的那个计时器；不调用 tick/checkLatency。
  const preload = path.join(dir, 'minute-preload.mjs');
  fs.writeFileSync(
    preload,
    `
    let enabled = false;
    process.on('message', (m) => { if (m.op === 'minute') enabled = m.minute; });
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => {
      if (ms === 60000 && new Error().stack.includes('/ops/minute.'))
        return interval(() => { if (enabled) fn(...args); }, 200);
      return interval(fn, ms, ...args);
    };
  `,
  );
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
  async function start(includeTravelDigest = false): Promise<void> {
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
      LLM_MOCK: '',
      TZ: 'Asia/Shanghai',
      PARITY_CLOCK_MS: String(early),
      ALERT_WEBHOOK_URL: webhookUrl,
      OPS_DIGEST_TENANTS: includeTravelDigest ? 'surface-industrial,surface-travel' : 'surface-industrial',
      OPS_LATENCY_TENANTS: 'surface-industrial',
      SOP_GATE: '',
      LLM_API_KEY: 'synthetic-model',
      LLM_BASE_URL: 'https://model.example.test/v1',
      EMBED_API_KEY: '',
      EMBED_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
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
    proc = fork(fileURLToPath(new URL('./observability-e2e.selftest.ts', import.meta.url)), ['--server'], {
      cwd: dir,
      env,
      execArgv: [
        '--import',
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
        '--import',
        fileURLToPath(new URL('../store/parity-clock.ts', import.meta.url)),
        '--import',
        preload,
      ],
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
    assert.equal(r.status, 200, 'step1: signed callback accepted');
    await until(
      async () =>
        (await fx.query('select 1 from messages where tenant_id=$1 and content=$2', [industrial ? industryId : fx.tenantId, text])).length >
        0,
      `inbound persisted: ${text}`,
    );
  }
  const sent = async (kf: string, uid: string) =>
    (await rpc()).sent.filter((s) => s.open_kfid === kf && s.touser === uid).map((s) => s.text?.content);
  let phase = 'setup';
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
        role: 'owner',
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

    await fx.query('update tenants set created_at=$1', [new Date(yesterdayStart.getTime() - 7 * 86400_000)]);
    phase = 'step1';
    await start();
    const snapshot = await rpc();
    assert.deepEqual(
      snapshot.tenants.map((t) => [t.slug, t.isHost, t.verdict]).sort(),
      [
        ['surface-industrial', false, 'ok'],
        ['surface-travel', true, 'ok'],
      ],
      'step1: complete prod boot loads two standard tenants',
    );
    const industryLogin = await login(industryHost, 'surface-industrial@erp.example.test');
    assert.equal(industryLogin.status, 200, 'step1: owner login');
    const industryCookie = cookie(industryLogin);
    const csrf = (await industryLogin.json()).csrf as string;
    const api = (url: string, method = 'GET', body?: object, host = industryHost, auth = industryCookie, token = csrf) =>
      request(host, `/api/console${url}`, {
        method,
        headers: { cookie: auth, 'x-csrf': token, origin: `https://${host}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    async function json<T>(res: Response, label: string): Promise<T> {
      assert.equal(res.status, 200, `${label}: ${await res.clone().text()}`);
      return res.json() as Promise<T>;
    }
    const marker = 'OBS_CUSTOMER_7193';
    for (let i = 1; i <= 2; i++) {
      await message(industryHost, 'wmObsI', `你好，需要询价 ${marker} 第${i}轮`);
      await until(async () => (await sent('industrial-kf', 'wmObsI')).length === i, `step1: engine outbound ${i}`);
      await until(
        async () => (await fx.query('select 1 from turn_traces where tenant_id=$1', [industryId])).length === i,
        `step1: persisted trace ${i}`,
      );
    }
    const turns = await fx.query<{ id: string; conversation_id: string; duration_ms: number; final_text: string }>(
      'select id,conversation_id,duration_ms,final_text from turn_traces where tenant_id=$1 order by started_at,id',
      [industryId],
    );
    assert.equal(turns.length, 2, 'step1: exactly two real turns');
    assert.ok(
      turns.every((t) => t.final_text.includes('合成回复青瓷河流')),
      'step1: synthetic model reaches final reply',
    );
    const turnId = turns[0]!.id;
    const conversation = turns[0]!.conversation_id;
    assert.ok(
      turns.every((t) => t.conversation_id === conversation),
      'step1: two turns share customer conversation',
    );
    const persisted = await fx.query<{ role: string; content: string; turn_id: string | null }>(
      'select role,content,turn_id from messages where tenant_id=$1 and conversation_id=$2 order by seq',
      [industryId, conversation],
    );
    assert.equal(persisted.filter((m) => m.role === 'customer' && m.content.includes(marker)).length, 2, 'step1: inbound persisted');
    assert.equal(
      persisted.filter((m) => m.role === 'agent' && turns.some((t) => t.id === m.turn_id)).length,
      2,
      'step1: AI messages linked',
    );
    console.log('STEP 1 PASS: prod Host/login/cookie/csrf → signed callbacks → engine → messages/turn_traces');

    phase = 'step2';
    const listed = await json<TracePage>(await api('/traces'), 'step2: trace list');
    const unreviewed = await json<TracePage>(await api('/traces?review=none'), 'step2: unreviewed list');
    for (const t of turns) {
      assert.ok(
        listed.items.some((r) => r.turnId === t.id),
        'step2: real turn listed',
      );
      assert.ok(
        unreviewed.items.some((r) => r.turnId === t.id && r.reviewable),
        'step2: real turn reviewable and unreviewed',
      );
    }
    await json(
      await api(`/traces/${turnId}/review`, 'PUT', { expectedRevision: 0, rating: 'bad', reason: 'incorrect' }),
      'step2: review write',
    );
    const detail = await json<TurnTraceDetailView>(await api(`/traces/${turnId}`), 'step2: detail');
    assert.equal(detail.review?.rating, 'bad', 'step2: persistent detail review');
    const bad = await json<TracePage>(await api('/traces?review=bad'), 'step2: bad list');
    assert.deepEqual(
      bad.items.map((r) => r.turnId),
      [turnId],
      'step2: bad filter',
    );
    const remaining = await json<TracePage>(await api('/traces?review=none'), 'step2: remaining unreviewed');
    assert.deepEqual(
      remaining.items.map((r) => r.turnId),
      [turns[1]!.id],
      'step2: reviewed turn removed from none',
    );
    console.log('STEP 2 PASS: list/none → bad review → detail/bad/none');

    phase = 'step3';
    const draftResponse = await api(`/traces/${turnId}/regression-draft`, 'POST');
    assert.equal(draftResponse.status, 200, 'step3: draft download');
    assert.equal(draftResponse.headers.get('cache-control'), 'no-store', 'step3: no-store');
    assert.match(draftResponse.headers.get('content-disposition') ?? '', /attachment/, 'step3: attachment');
    const draftText = await draftResponse.text();
    for (const forbidden of [marker, '合成回复青瓷河流', turnId, conversation, ...persisted.map((m) => m.content)])
      assert.ok(!draftText.includes(forbidden), 'step3: draft excludes source identity/input/reply');
    const draft = JSON.parse(draftText) as RegressionDraft;
    assert.equal(draft._draft, true, 'step3: nonexecutable draft');
    assert.equal(draft.case.pack, 'industrial', 'step3: industrial v2');
    assert.deepEqual(draft.case.turns, [], 'step3: empty turns');
    const { validateCase } = await import('../../eval/v2/schema.js');
    assert.throws(() => validateCase(draft.case), 'step3: unedited draft rejected');
    const executable = {
      ...draft.case,
      id: 'observability-synthetic',
      desc: '独立合成工业回归',
      turns: [{ say: '您好', script: [{ content: '您好，请提供型号。' }], expect: { replyMatches: ['型号'] } }],
    };
    const caseFile = path.join(dir, 'synthetic-v2.json');
    const runCase = () =>
      spawnSync(
        process.execPath,
        ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'eval/run.ts'), '--cases-v2', caseFile],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DEPLOY_PROFILE: 'demo',
            CONFIG_SOURCE: 'file',
            LLM_MOCK: '1',
            EVAL_V2_BASELINE: 'off',
            VAR_DIR: path.join(dir, 'eval'),
          },
          encoding: 'utf8',
          timeout: 25_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    fs.writeFileSync(caseFile, JSON.stringify([executable]));
    const positive = runCase();
    assert.equal(positive.status, 0, `step3: external v2 positive ${positive.stdout}${positive.stderr}`);
    executable.turns[0]!.expect.replyMatches = ['IMPOSSIBLE_EXPECTATION_7193'];
    fs.writeFileSync(caseFile, JSON.stringify([executable]));
    const negative = runCase();
    assert.equal(negative.status, 1, `step3: external v2 negative ${negative.stdout}${negative.stderr}`);
    assert.match(negative.stdout, /IMPOSSIBLE_EXPECTATION_7193/, 'step3: failure is behavior assertion');
    console.log('STEP 3 PASS: content-free draft → external synthetic v2 passes → wrong expectation fails');

    phase = 'step4';
    // 只改真实轮次的时间列；耗时仍为真实引擎测量值，预期独立计算，不调用聚合函数。
    const durations = turns.map((t) => t.duration_ms).sort((a, b) => a - b);
    const expectedP90 = Math.round(durations[0]! * 0.1 + durations[1]! * 0.9);
    await fx.query('update turn_traces set started_at=$2 where tenant_id=$1', [
      industryId,
      new Date(yesterdayStart.getTime() + 12 * 3600_000),
    ]);
    async function syntheticTurn(tenant: string, id: string, at: Date, duration: number, seed = false): Promise<string> {
      await fx.query(
        `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
        values($1,$2,'wecom','new',false,$3,now(),now()) on conflict do nothing`,
        [
          tenant,
          id,
          JSON.stringify({
            id,
            seed,
            channel: 'wecom',
            stage: 'new',
            profile: {},
            orderIds: [],
            handedOver: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        ],
      );
      const trace = randomUUID();
      await fx.query(
        `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm,final_text)
        values($1,$2,$3,$4,$5,'replied',$6,'{}','[]','[]','合成慢回复')`,
        [tenant, trace, id, at, duration, 'a'.repeat(64)],
      );
      await fx.query(
        `insert into messages(tenant_id,conversation_id,seq,role,content,at,turn_id)
        select $1,$2,coalesce(max(seq),0)+1,'agent','合成慢回复',$3,$4 from messages where tenant_id=$1 and conversation_id=$2`,
        [tenant, id, at, trace],
      );
      // 合成消息也维护存储的序号投影，完整 prod 重启可按真实追加窗口重新装载。
      await fx.query(
        `update conversations set last_seq=(select max(seq) from messages where tenant_id=$1 and conversation_id=$2)
        where tenant_id=$1 and id=$2`,
        [tenant, id],
      );
      return trace;
    }
    const yesterdayMid = new Date(yesterdayStart.getTime() + 12 * 3600_000);
    // 种子与另一租户的高耗时对照，让错误来源 SQL 无法凑巧通过；DB 约束禁止访客/旧种子前缀入库。
    await syntheticTurn(industryId, 'synthetic-seed', yesterdayMid, 80000, true);
    await syntheticTurn(fx.tenantId, 'synthetic-travel-customer', yesterdayMid, 110000);
    await fx.query(
      `insert into ops_metric_coverage(tenant_id,day,first_seen_at,last_seen_at,has_gap,has_deletion)
      values($1,$2,$3,$4,false,false)`,
      [industryId, day, yesterdayStart, new Date(yesterdayEnd.getTime() - 60_000)],
    );
    await rpc('clock', { clock: noon });
    await until(
      async () =>
        (await fx.query("select 1 from ops_daily_reports where tenant_id=$1 and day=$2 and status='sent'", [industryId, day])).length === 1,
      'step4: real runner claims yesterday digest',
      15_000,
    );
    const digests = notifications.filter((s) => s.includes('每日摘要'));
    assert.equal(digests.length, 1, 'step4: one actual digest delivery');
    const report = (
      await fx.query<{ snapshot: DailyOpsPoint }>('select snapshot from ops_daily_reports where tenant_id=$1 and day=$2', [industryId, day])
    )[0]!.snapshot;
    assert.equal(report.receptions, 1, 'step4: customer receptions');
    assert.equal(report.turns, 2, 'step4: customer turns, no seeds/foreign tenant');
    assert.equal(report.replySamples, 2, 'step4: linked AI samples');
    assert.equal(report.replyP90Ms, expectedP90, 'step4: independently calculated engine p90');
    assert.equal(report.coverage, 'complete', 'step4: complete coverage');
    assert.ok(digests[0]!.includes(`接待 1；轮次 2`), 'step4: digest counts match');
    assert.ok(digests[0]!.includes(`p90 ${expectedP90}ms，样本 2`), 'step4: digest p90 matches');
    for (const forbidden of ['surface-industrial', 'surface-travel', '合成工业', 'wmObsI', conversation, marker, '合成回复青瓷河流'])
      assert.ok(!digests[0]!.includes(forbidden), 'step4: digest has no tenant/customer identity/content');
    const firstTrends = await json<MetricsTrendsView>(await api('/metrics/trends?days=7'), 'step4: trends');
    assert.deepEqual(
      firstTrends.points.find((p) => p.day === day),
      report,
      'step4: same-day digest equals trends',
    );
    console.log('STEP 4 PASS: yesterday clock/time columns + coverage → actual runner/job/ledger/webhook → exact SQL/trends');

    phase = 'step5';
    // 将当前钟固定在完整窗之后两分钟，避免真实分钟边界抖动；只预置前两个慢窗的持久状态。
    const windowEnd = Math.floor((noon - 60_000) / 300_000) * 300_000;
    const slowIds: string[] = [];
    for (let i = 0; i < 20; i++) slowIds.push(await syntheticTurn(industryId, conversation, new Date(windowEnd - 150_000), 9000 + i * 100));
    await fx.query(
      `insert into ops_latency_state(tenant_id,last_window_end,bad_streak,good_streak,active,paused)
      values($1,$2,2,0,false,false) on conflict(tenant_id) do update set last_window_end=excluded.last_window_end,
      bad_streak=2,good_streak=0,active=false,paused=false,last_sent_at=null`,
      [industryId, new Date(windowEnd - 300_000)],
    );
    await rpc('minute', { minute: true });
    await until(async () => notifications.some((s) => s.includes('回复延迟持续偏高')), 'step5: real minute entry sends reply_latency');
    await rpc('minute', { minute: false });
    const latency = notifications.filter((s) => s.includes('回复延迟持续偏高'));
    assert.equal(latency.length, 1, 'step5: one latency notification');
    assert.match(latency[0]!, /P2/, 'step5: severity');
    assert.match(latency[0]!, /样本 20，p90 10710ms/, 'step5: complete slow-window metrics');
    // 只取定位行，不能误开正文里的手册链接。
    const location = latency[0]!.split('\n').find((s) => s.startsWith('定位 '));
    assert.ok(location, 'step5: alert provides location line');
    const link = new URL(location.slice('定位 '.length));
    assert.equal(link.origin, `https://${industryHost}`, 'step5: industrial public host, never travel host');
    const linkedId = link.pathname.split('/').at(-1)!;
    assert.ok(slowIds.includes(linkedId), 'step5: link targets sampled turn');
    assert.equal(link.pathname, `/console/traces/${linkedId}`, 'step5: fixed trace page');
    // HTTP request() 换成本机端口，Host 仍来自告警链接；详情 API 仍经全站中间件。
    const linkedApi = `/api${link.pathname}`;
    assert.equal((await request(link.host, linkedApi)).status, 401, 'step5: anonymous link detail denied');
    const linked = await json<TurnTraceDetailView>(
      await request(link.host, linkedApi, { headers: { cookie: industryCookie } }),
      'step5: authenticated location detail',
    );
    assert.equal(linked.turnId, linkedId, 'step5: exact turn detail');
    assert.equal(linked.conversationId, conversation, 'step5: real step1 customer conversation');
    assert.equal(
      (await fx.query('select 1 from conversations where tenant_id=$1 and id=$2', [industryId, linked.conversationId])).length,
      1,
      'step5: linked conversation belongs to industrial tenant',
    );
    for (const forbidden of [marker, '合成回复青瓷河流', conversation, 'wmObsI'])
      assert.ok(!latency[0]!.includes(forbidden), 'step5: latency body excludes customer data');
    console.log('STEP 5 PASS: persisted two-window streak + 20 linked replies → real minute/alert/webhook → location Host/auth/turn');

    phase = 'step6';
    const finalTrends = await json<MetricsTrendsView>(await api('/metrics/trends?days=7'), 'step6: seven-day trends');
    assert.equal(finalTrends.timezone, 'Asia/Shanghai', 'step6: deployment timezone');
    assert.deepEqual(
      finalTrends.points.find((p) => p.day === day),
      report,
      'step6: yesterday unchanged by current slow window, seeds or foreign turns',
    );
    console.log('STEP 6 PASS: 7-day trends contains exact same customer/day counts and p90, excluding other sources');

    phase = 'step7';
    const travelLogin = await login(travelHost, 'surface-travel@erp.example.test');
    assert.equal(travelLogin.status, 200, 'step7: travel owner login');
    const travelCookie = cookie(travelLogin);
    const travelCsrf = (await travelLogin.json()).csrf as string;
    assert.equal(
      (await api(`/traces/${turnId}`, 'GET', undefined, travelHost, travelCookie, travelCsrf)).status,
      404,
      'step7: foreign detail 404',
    );
    assert.equal(
      (
        await api(
          `/traces/${turnId}/review`,
          'PUT',
          { expectedRevision: 0, rating: 'bad', reason: 'other' },
          travelHost,
          travelCookie,
          travelCsrf,
        )
      ).status,
      404,
      'step7: foreign review write 404',
    );
    assert.equal(
      (await api(`/traces/${turnId}/review`, 'GET', undefined, travelHost, travelCookie, travelCsrf)).status,
      404,
      'step7: foreign review read 404',
    );
    await fx.query("update tenants set status='suspended' where id=$1", [fx.tenantId]);
    // 启用旅游摘要以证明 suspended 是阻止投递的原因；重启走真正 prod 引导及初次认领。
    await stop();
    // 模拟停用前已经排好的摘要；由真实 ops lane 认领，再因 suspended 归 skipped。
    await fx.query('insert into ops_daily_reports(tenant_id,day) values($1,$2)', [fx.tenantId, day]);
    await fx.query(
      `insert into jobs(tenant_id,kind,dedupe_key,payload,run_at,max_attempts)
      values($1,'ops_daily_digest',$2,$3,$4,10)`,
      [fx.tenantId, `ops_daily_digest:${day}`, JSON.stringify({ day }), new Date(early)],
    );
    await start(true);
    // 客户服务恢复真实时钟，保持 PG 对 updated_at 的未来时间约束。
    // 必须先于登录：重启后钟回到 early，晚上 20:02 后再拨到真实时间会跨过 12 小时空闲时限。
    await rpc('clock', { clock: Date.now() });
    const renewed = await login(industryHost, 'surface-industrial@erp.example.test');
    assert.equal(renewed.status, 200, 'step7: industrial login with suspended host after restart');
    const renewedCookie = cookie(renewed);
    await message(industryHost, 'wmObsI', '您好，继续询价 OBS_AFTER_SUSPEND');
    await until(
      async () => (await sent('industrial-kf', 'wmObsI')).length > 0,
      'step7: real engine serves industrial after host suspended',
    );
    await json(
      await request(industryHost, `/api/console/traces/${turnId}`, { headers: { cookie: renewedCookie } }),
      'step7: industrial trace still accessible',
    );
    await until(
      async () =>
        (await fx.query("select 1 from jobs where tenant_id=$1 and kind='ops_daily_digest' and status='done'", [industryId])).length === 1,
      'step7: digest job completed',
    );
    await until(
      async () =>
        (await fx.query("select 1 from jobs where tenant_id=$1 and kind='ops_daily_digest' and status='done'", [fx.tenantId])).length === 1,
      'step7: real runner consumes suspended travel job',
    );
    assert.equal(notifications.filter((s) => s.includes('每日摘要')).length, 1, 'step7: no duplicate digest after restart');
    assert.equal(
      (await fx.query("select 1 from ops_daily_reports where tenant_id=$1 and status='skipped' and error_code='suspended'", [fx.tenantId]))
        .length,
      1,
      'step7: suspended travel skips queued report',
    );
    assert.ok(!notifications.some((s) => s.includes(`T-${fx.tenantId.slice(0, 6)}`)), 'step7: travel sends no digest');
    console.log(
      'STEP 7 PASS: travel cross-tenant 404 → suspended host/restart → industrial engine/API still serve; no travel/duplicate digest',
    );
    console.log(`17 OBSERVABILITY E2E PASS: ${((performance.now() - began) / 1000).toFixed(2)}s`);
  } catch (error) {
    console.error(logs);
    throw new Error(`17 observability ${phase} failed`, { cause: error });
  } finally {
    await stop();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await platform.close();
    await appDb.close();
    await fx.drop();
    process.chdir(oldCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv.includes('--server')) await child();
else if (process.env.PG_TEST_URL) await parent(process.env.PG_TEST_URL);
else if (process.env.CI === 'true') throw new Error('17 observability e2e requires PG_TEST_URL');
else console.log('17 OBSERVABILITY E2E SKIP: PG_TEST_URL missing');
