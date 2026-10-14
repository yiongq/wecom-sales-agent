// 05 第 29 步：HTTP 开通 / 签码 / 加密回调，出站只观察本地假企微实际收到的请求。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createServer, request as nodeRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { createCipheriv, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { openTestDb, testConfigDeps, fakeLock } from '../../db/testing.js';
import { openOutboundTestPg } from '../../db/sandbox-outbound-testing.js';
import { withTenant, rowsOf, type Db } from '../../db/client.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig } from '../../config/source.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import {
  readSandboxWecomState,
  commitSandboxWecomCursor,
  markSandboxWecomFull,
  resetSandboxWecomFull,
} from '../../db/repo/sandbox-wecom.js';
import { SandboxWechatBinding } from './binding.js';
import { SandboxWecom, type KfMessage } from './wecom.js';
import { sandboxApp, SandboxProcess } from './process.js';
import { provisionSandbox } from './provision.js';
import { resolveSandboxSession } from './session.js';
import { SandboxReaper } from './reaper.js';
import { loadSandboxRuntime } from './load.js';
import { __sandboxLimitsTest } from './limits.js';
import { sandboxWechatIndex, SandboxSendRefused } from './outbound.js';
import { SandboxWecomRuntime } from '../../adapters/wecom.js';
import { computeSignature } from '../../wecom-crypto.js';
import {
  configureTenancy,
  createTenantRuntime,
  runtimeOf,
  tenantRuntimes,
  unregisterRuntime,
  withTenantScope,
  withoutTenantScope,
  scopedRuntime,
  type TenantRuntime,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { drainStore, listSessions, listOrders } from '../../store.js';
import { alert, startAlerts, __alertTest } from '../../ops/alert.js';
import { __profileTest } from '../../profile.js';
import { resolveRole } from './role.js';
import { CHANNEL_KEY_ENV } from '../../channels/secrets.js';
import { checkSandboxStartup } from '../../db/sandbox-process.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-e2e-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app: routes } = await import('../../server.js');
const originalFetch = globalThis.fetch;
const originalAlert = process.env.ALERT_WEBHOOK_URL;
const env = {
  SANDBOX_HOST: 'sandbox.example.invalid',
  SANDBOX_WECOM_CORP_ID: 'fake-e2e-corp',
  SANDBOX_WECOM_SECRET: 'fake-e2e-secret', // gitleaks:allow
  SANDBOX_WECOM_TOKEN: 'fake-e2e-callback-token', // gitleaks:allow
  SANDBOX_WECOM_AES_KEY: Buffer.alloc(32, 7).toString('base64').slice(0, -1),
  SANDBOX_WECOM_OPEN_KFID: 'fake-e2e-kf',
};
const base = `https://${env.SANDBOX_HOST}`;
const departDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
type Body = {
  touser?: string;
  open_kfid?: string;
  code?: string;
  msgid?: string;
  msgtype?: string;
  text?: { content: string };
  link?: { url: string };
};
type Recorded = {
  endpoint: string;
  body: Body;
  bytes: string;
  tenant?: string;
  expectedUser?: string;
  welcomeOwner?: string | null;
  expectedWelcomeUser?: string;
};
let checks = 0;
async function reportScenario(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`E2E PASS: ${name}`);
}
async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('e2e_wait_timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
async function cleanup() {
  for (const rt of tenantRuntimes()) {
    await withTenantScope(rt, () => drainStore(5000));
    rt.state = 'closed';
    rt.store.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
  sandboxWechatIndex.reset();
}

async function suite(db: Db, q: Query, backend: string) {
  __alertTest.reset();
  __sandboxLimitsTest.resetProvisioned();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('template','模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: template!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: host.slug, usePackRuntime: true });
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: host.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  assert.equal(imported.code, 0, imported.message);
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'假隐私说明')", [host.id]);
  const records: Recorded[] = [];
  // 测试自己记录签码、消费与绑定事实；不从生产授权索引推导期望收件人。
  const expectedBindings = new Map<string, string>();
  const expectedCodes = new Map<string, { tenant: string; expiresAt: number; used: boolean }>();
  const expectedWelcomes = new Map<string, { tenant: string | null; user: string }>();
  const attempts = new Map<string, number>();
  const fixedTexts = [`这是体验客服，去 ${base}/try 开一个体验，扫页面上的码就能连上`, '这个码过期了，回工作台换一个'];
  const normalize = (text: string) => text.replace(/[\s-]/g, '').toUpperCase();
  const assertRecorded = (record: Recorded) => {
    if (record.endpoint === 'kf/send_msg') {
      assert.equal(record.body.open_kfid, env.SANDBOX_WECOM_OPEN_KFID);
      if (record.tenant) assert.equal(record.body.touser, record.expectedUser, 'HTTP 文本收件人必须等于独立绑定事实');
      else assert.ok(fixedTexts.includes(record.body.text?.content ?? ''), '无租户文本只能是固定话术');
    } else if (record.endpoint === 'kf/send_msg_on_event') {
      assert.ok(record.expectedWelcomeUser, '每条欢迎请求必须有测试登记的入站事件');
      assert.equal(record.tenant ?? null, record.welcomeOwner, 'HTTP 欢迎码归属必须等于发送方沙箱');
      if (!record.tenant) assert.ok(fixedTexts.includes(record.body.text?.content ?? ''));
    }
  };
  const warnings: string[] = [];
  const warnBefore = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
    warnBefore(...args);
  };
  const pages: KfMessage[][] = [];
  let serial = 0;
  let sendHook: ((r: Recorded) => Promise<number>) | undefined;
  let tokenHook: (() => Promise<void>) | undefined;
  // 记录器和错误注入都在真的 HTTP 服务端，客户端只改目的地址，不制造 Response。
  const fake = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://fake');
      const endpoint = url.pathname.replace('/cgi-bin/', '');
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const body: Body = bytes && req.headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : {};
      const tenant = typeof req.headers['x-fake-tenant'] === 'string' ? req.headers['x-fake-tenant'] : undefined;
      const welcome = body.code ? expectedWelcomes.get(body.code) : undefined;
      const record: Recorded = {
        endpoint,
        body,
        bytes,
        tenant,
        expectedUser: typeof req.headers['x-fake-expected-user'] === 'string' ? req.headers['x-fake-expected-user'] : undefined,
        welcomeOwner: welcome?.tenant,
        expectedWelcomeUser: welcome?.user,
      };
      records.push(record);
      assertRecorded(record);
      let response: unknown;
      if (endpoint === 'gettoken') {
        const hook = tokenHook;
        tokenHook = undefined;
        await hook?.();
        response = { access_token: 'fake-e2e-access', expires_in: 7200 };
      } else if (endpoint === 'kf/add_contact_way') response = { errcode: 0, url: 'https://contact.example.invalid/fake-e2e' };
      else if (endpoint === 'kf/sync_msg')
        response = { errcode: 0, next_cursor: `fake-cursor-${++serial}`, has_more: 0, msg_list: pages.shift() ?? [] };
      else if (endpoint === 'media/upload') response = { errcode: 0, media_id: 'fake-e2e-media' };
      else if (endpoint.startsWith('kf/send_msg')) response = { errcode: (await sendHook?.(record)) ?? 0 };
      else if (endpoint === '/alert' || endpoint === '/notify' || endpoint === '/otlp') response = { errcode: 0 };
      else throw new Error(`unexpected_endpoint:${endpoint}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  process.env.ALERT_WEBHOOK_URL = `${fakeBase}/alert`;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === fakeBase) return originalFetch(input, init);
    if (url.hostname === 'qyapi.weixin.qq.com') {
      const headers = new Headers(init?.headers);
      const sender = scopedRuntime();
      if (sender) {
        headers.set('x-fake-tenant', sender.id);
        const bound = expectedBindings.get(sender.id);
        if (bound) headers.set('x-fake-expected-user', bound);
      }
      return originalFetch(`${fakeBase}${url.pathname}${url.search}`, { ...init, headers });
    }
    throw new Error('禁止非本地网络');
  };
  let service: SandboxWecom;
  const start = async () => {
    service = new SandboxWecom(env, {
      binding: new SandboxWechatBinding(db, '0'),
      request: globalThis.fetch,
      read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID),
      commit: (cursor) => commitSandboxWecomCursor(db, '0', env.SANDBOX_WECOM_OPEN_KFID, cursor),
      markFull: () => markSandboxWecomFull(db, '0', env.SANDBOX_WECOM_OPEN_KFID),
      notifyFull: () => alert('sandbox_wecom_full', '微信体验名额已满，已退回模拟器', { instance: true }),
      schedule: () => () => {},
      touch: (rt) => reaper.touch(rt),
    });
    await service.start();
    await service.drain();
  };
  await start();
  const reaper = new SandboxReaper({
    db,
    acquireTenant: async () => fakeLock(),
    idleMs: 99999999,
  });
  let configured = true;
  const app = sandboxApp(
    {
      health: async () => ({ ...(await new SandboxProcess({}).health()), ...(configured ? { wecom: service.health() } : {}) }),
      resolve: (token) => resolveSandboxSession(db, token),
      provision: (input) =>
        provisionSandbox({
          ...input,
          deps,
          templateSlug: host.slug,
          host: env.SANDBOX_HOST,
          epoch: '0',
          env: { SANDBOX_PER_IP_DAY: '20' },
          acquireTenant: async () => fakeLock(),
        }),
      end: (id) => {
        expectedBindings.delete(id);
        return reaper.end(id);
      },
      wechatCode: (rt) => service.issueCode(rt),
      wecomRoutes: () => (configured ? service.routes : null),
    },
    env.SANDBOX_HOST,
    routes,
  );
  const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(http, 'listening');
  const httpBase = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const network = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
    new Promise<Response>((resolve, reject) => {
      const outgoing = nodeRequest(url, { method: init.method, headers: init.headers }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
            else if (value !== undefined) headers.set(key, value);
          }
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
        });
      });
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('http_timeout')));
      outgoing.on('error', reject);
      outgoing.end(init.body);
    });
  const req = (p: string, cookie = '', method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
    network(httpBase + p, {
      method,
      headers: {
        host: env.SANDBOX_HOST,
        origin: base,
        'sec-fetch-site': 'same-origin',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  type Visitor = { cookie: string; id: string; csrf: string; rt: TenantRuntime };
  const open = async (): Promise<Visitor> => {
    const res = await req('/api/sandbox', '', 'POST', {});
    assert.equal(res.status, 201, await res.clone().text());
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await req('/api/console/me', cookie)).json();
    const token = cookie.split('=')[1]!;
    const session = await resolveSandboxSession(db, token);
    assert.equal(session.status, 'ok');
    if (session.status !== 'ok') throw new Error('open_failed');
    return { cookie, id: session.runtime.id, csrf: me.csrf, rt: session.runtime };
  };
  const sign = async (v: Visitor) => {
    const res = await req('/api/sandbox/wechat/code', v.cookie, 'POST');
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const value = await res.json();
    assert.match(value.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    for (const row of expectedCodes.values()) if (row.tenant === v.id) row.used = true;
    expectedCodes.set(normalize(value.code), { tenant: v.id, expiresAt: Date.parse(value.expiresAt), used: false });
    return value.code as string;
  };
  const message = (user: string, content: string): KfMessage => ({
    msgid: `fake-msg-${++serial}`,
    open_kfid: env.SANDBOX_WECOM_OPEN_KFID,
    external_userid: user,
    send_time: Date.now() / 1000,
    origin: 3,
    msgtype: 'text',
    text: { content },
  });
  // 企微事件消息顶层没有 open_kfid、external_userid，2026-10-12 线上 sync_msg 实测。
  const enter = (user: string, code: string): KfMessage =>
    ({
      msgid: `fake-msg-${++serial}`,
      send_time: Date.now() / 1000,
      origin: 4,
      msgtype: 'event',
      event: {
        event_type: 'enter_session',
        open_kfid: env.SANDBOX_WECOM_OPEN_KFID,
        external_userid: user,
        scene_param: code.replace('-', ''),
        welcome_code: `fake-welcome-${++serial}`,
      },
    }) as KfMessage; // 保留宿主共用类型，事件按真实 wire 布局构造。
  const callback = async (...messages: KfMessage[]) => {
    for (const incoming of messages) {
      const entered = incoming.event?.event_type === 'enter_session';
      const user = entered ? incoming.event!.external_userid! : incoming.external_userid;
      const text = entered ? incoming.event?.scene_param : incoming.text?.content;
      const row = text ? expectedCodes.get(normalize(text)) : undefined;
      const old = [...expectedBindings].find(([, bound]) => bound === user)?.[0];
      let welcomeOwner: string | null = old ?? null;
      if (row && !row.used && row.expiresAt > Date.now() && (attempts.get(user) ?? 0) < 10) {
        for (const [tenant, bound] of expectedBindings) if (tenant === row.tenant || bound === user) expectedBindings.delete(tenant);
        expectedBindings.set(row.tenant, user);
        row.used = true;
        welcomeOwner = row.tenant;
      } else if ((entered && text !== undefined) || (!old && text && /^[0-9a-z]{8}$/i.test(normalize(text)))) {
        if (!old) {
          attempts.set(user, (attempts.get(user) ?? 0) + 1);
          welcomeOwner = null;
        }
      }
      if (incoming.event?.welcome_code) expectedWelcomes.set(incoming.event.welcome_code, { tenant: welcomeOwner, user });
    }
    pages.push(messages);
    const xml = `<xml><OpenKfId>${env.SANDBOX_WECOM_OPEN_KFID}</OpenKfId><Token>fake-sync-token</Token></xml>`;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(xml));
    const plain = Buffer.concat([Buffer.alloc(16, 3), length, Buffer.from(xml), Buffer.from(env.SANDBOX_WECOM_CORP_ID)]);
    const pad = 32 - (plain.length % 32);
    const key = Buffer.from(`${env.SANDBOX_WECOM_AES_KEY}=`, 'base64');
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
    const timestamp = 'fake-timestamp',
      nonce = 'fake-nonce';
    const params = new URLSearchParams({
      timestamp,
      nonce,
      msg_signature: computeSignature(env.SANDBOX_WECOM_TOKEN, timestamp, nonce, encrypted),
    });
    const res = await network(`${httpBase}/wecom/callback?${params}`, {
      method: 'POST',
      headers: { host: env.SANDBOX_HOST },
      body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'success');
  };
  const deliver = async (...messages: KfMessage[]) => {
    await callback(...messages);
    await service.drain();
  };
  const sends = (from = 0) => records.slice(from).filter((r) => r.endpoint.startsWith('kf/send_msg'));
  const events = async (v: Visitor) => {
    let text = '';
    const outgoing = nodeRequest(httpBase + '/api/console/events', { headers: { host: env.SANDBOX_HOST, cookie: v.cookie } });
    outgoing.on('response', (incoming) => {
      assert.equal(incoming.statusCode, 200);
      incoming.on('data', (chunk) => {
        text += chunk;
      });
      incoming.on('error', () => {});
    });
    outgoing.on('error', () => {});
    outgoing.end();
    try {
      await until(() => text.includes('event: counts'));
    } catch (error) {
      outgoing.destroy();
      throw error;
    }
    return { text: () => text, close: () => outgoing.destroy() };
  };
  const detail = async (v: Visitor, user: string) => {
    const res = await req(`/api/console/conversations/wecom:${user}`, v.cookie);
    assert.equal(res.status, 200);
    return res.json();
  };
  const reply = (v: Visitor, user: string, text: string) =>
    req(`/api/console/conversations/wecom:${user}/reply`, v.cookie, 'POST', { text, clientId: randomUUID() }, { 'x-csrf': v.csrf });
  const bind = async (v: Visitor, user: string, typed = false) => {
    const code = await sign(v);
    await deliver(typed ? message(user, ` ${code.toLowerCase()} `) : enter(user, code));
    assert.equal(sandboxWechatIndex.forUser(user)?.id, v.id);
    const row = await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [v.id]);
    assert.equal(row[0]!.external_userid, user);
    return code;
  };
  const flush = async (v: Visitor) => withTenantScope(v.rt, () => drainStore(5000));
  const ledger = async (v: Visitor, user: string) => {
    await flush(v);
    return q<{ status: string; channel_msgid: string }>(
      'select status,channel_msgid from outbound_sends where tenant_id=$1 and conversation_id=$2 order by sent_at,channel_msgid',
      [v.id, `wecom:${user}`],
    );
  };
  let tokenA = '',
    tokenB = '';
  try {
    const A = await open(),
      B = await open();
    withoutTenantScope(startAlerts);
    __alertTest.stopTimer();
    const scenario = (name: string, work: () => Promise<void>) =>
      reportScenario(name, async () => {
        await work();
        // 每段流程同时核落库内容、解析授权和账本；不是只看记录器的成功响应。
        for (const rt of tenantRuntimes().filter((r) => r.kind === 'sandbox' && r.state === 'serving')) {
          await withTenantScope(rt, () => drainStore(5000));
          const binding = await q<{ external_userid: string | null }>('select external_userid from sandbox_wechat where tenant_id=$1', [
            rt.id,
          ]);
          assert.equal(binding[0]?.external_userid ?? null, sandboxWechatIndex.boundUser(rt) ?? null);
          const rows = await q<{ channel_msgid: string; status: string }>(
            'select channel_msgid,status from outbound_sends where tenant_id=$1',
            [rt.id],
          );
          assert.ok(rows.every((r) => !['pending', 'sending'].includes(r.status)));
          for (const recorded of sends().filter((r) => r.tenant === rt.id && r.body.msgid))
            assert.ok(
              rows.some((r) => r.channel_msgid === recorded.body.msgid),
              '实际发送必须有持久账本',
            );
          assert.ok(withTenantScope(rt, listSessions).every((s) => !rt.store.pgBackend!.isPoisoned(s.id)));
        }
      });
    await scenario(`${backend} 验收6 启动凭据边界与账号触发器`, async () => {
      const startup = {
        ...env,
        APP_ROLE: 'sandbox',
        DEPLOY_PROFILE: 'demo',
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        SANDBOX_TEMPLATE_SLUG: 'template',
      };
      for (const key of ['WECOM_CORP_ID', CHANNEL_KEY_ENV, 'NOTIFY_WEBHOOK_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'LLM_HEDGE_MODEL'])
        assert.throws(() => resolveRole({ ...startup, [key]: 'fake-forbidden' }), /sandbox_env_forbidden/);
      assert.throws(() => resolveRole({ APP_ROLE: 'host', ...env }), /sandbox_env_forbidden/);
      assert.throws(() => resolveRole({ ...startup, SANDBOX_WECOM_SECRET: undefined }), /sandbox_wecom_partial/);
      await assert.rejects(
        withTenantScope(A.rt, () =>
          withTenant(db, { tenantId: A.id, actor: { kind: 'system', userId: null, name: null, ip: null } }, (tx) =>
            tx.execute(`insert into channel_accounts(tenant_id,key,kind,name) values ('${A.id}','fake','web','假渠道')`),
          ),
        ),
        (error: Error) => /沙箱租户不可建渠道账号/.test(String(error.cause)),
      );
      await q(
        "insert into channel_accounts(tenant_id,key,kind,name,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id) values($1,'fake','wecom_kf','假账号','wecom:','fake-corp',$2,decode('00','hex'),'fake-key')",
        [host.id, env.SANDBOX_WECOM_OPEN_KFID],
      );
      await assert.rejects(checkSandboxStartup(db, host.slug, env.SANDBOX_WECOM_OPEN_KFID), /sandbox_wecom_conflict/);
      await q('delete from channel_accounts where tenant_id=$1', [host.id]);
      assert.equal(sends().length, 0);
    });
    await scenario(`${backend} 16① 开通、扫码、AI、接手、付款、五条额度`, async () => {
      const used = await bind(A, 'wm1');
      const welcome = sends().at(-1)!;
      assert.equal(welcome.endpoint, 'kf/send_msg_on_event');
      assert.match(welcome.body.text!.content, /AI/);
      tokenA = /\/wx\/([A-Za-z0-9_-]{43})\//.exec(welcome.body.text!.content)![1]!;
      const stream = await events(A);
      try {
        await deliver(message('wm1', '你好'));
        await until(() => stream.text().includes('wecom:wm1'));
        assert.ok(stream.text().includes('event: conversation'));
      } finally {
        stream.close();
      }
      const d = await detail(A, 'wm1');
      assert.ok(d.messages.some((m: { role: string }) => m.role === 'agent'));
      assert.ok(d.sendWindow.closesAt > Date.now());
      assert.ok(d.sendWindow.remaining > 0 && d.sendWindow.remaining < 5);
      assert.equal(sends().at(-1)!.body.touser, 'wm1');
      // 订单由收件 -> 引擎 -> 确定性工具创建，测试不直接造订单。
      await deliver(message('wm1', `西藏，2个人，${departDate}出发，报价`));
      await deliver(message('wm1', `就订西藏这个，2个人，${departDate}出发`));
      const order = withTenantScope(A.rt, () => listOrders().find((o) => o.sessionId === 'wecom:wm1'))!;
      assert.ok(order, JSON.stringify(await q('select calls from turn_traces where tenant_id=$1', [A.id])));
      const paid = await req(`/api/console/orders/${order.id}/mark-paid`, A.cookie, 'POST', {}, { 'x-csrf': A.csrf });
      assert.equal(paid.status, 200);
      assert.match(sends().at(-1)!.body.text!.content, /支付|付款|行程/);
      const began = Date.now();
      assert.equal((await reply(A, 'wm1', '顾问全程回复')).status, 200);
      assert.ok(Date.now() - began < 1000);
      assert.match(sends().at(-1)!.body.text!.content, /【顾问】/);
      const humanDetail = await detail(A, 'wm1');
      for (let n = 0; n < humanDetail.sendWindow.remaining; n++) assert.equal((await reply(A, 'wm1', `额度回复${n}`)).status, 200);
      const before = records.length;
      assert.equal((await reply(A, 'wm1', '第六条')).status, 409);
      assert.equal(sends(before).length, 0);
      assert.equal((await detail(A, 'wm1')).sendWindow.remaining, 0);
      assert.ok((await ledger(A, 'wm1')).every((r) => r.status === 'accepted'));
      await deliver(enter('wm2', used));
      assert.equal(sends().at(-1)!.body.text!.content, sandboxWechatIndex.fixedTexts(env.SANDBOX_HOST)[0]);
      assert.equal(sandboxWechatIndex.forUser('wm2'), undefined);
    });
    await scenario(`${backend} 16② 卡片成功、降级补文、wx cookie 与支付`, async () => {
      assert.equal((await req('/api/console/conversations/wecom:wm1/release', A.cookie, 'POST', {}, { 'x-csrf': A.csrf })).status, 200);
      await deliver(message('wm1', `就订西藏这个，2个人，${departDate}出发`));
      const order = withTenantScope(A.rt, () => listOrders().find((o) => o.sessionId === 'wecom:wm1'))!;
      assert.equal(order.status, 'pending_payment');
      const url = `${base}/pay/${order.id}`;
      for (const failCard of [false, true]) {
        sendHook = async (r) => (failCard && r.body.msgtype === 'link' ? 40008 : 0);
        const before = records.length;
        assert.equal((await reply(A, 'wm1', `付款说明\n支付链接：${url}`)).status, 200);
        const received = sends(before);
        assert.equal(received.find((r) => r.body.msgtype === 'link')!.body.link!.url, `${base}/wx/${tokenA}/pay/${order.id}`);
        if (failCard) assert.ok(received.some((r) => r.body.text?.content.includes(`/wx/${tokenA}/pay/`)));
      }
      sendHook = undefined;
      const jump = await req(`/wx/${tokenA}/pay/${order.id}`);
      assert.equal(jump.status, 302);
      assert.equal(jump.headers.get('location'), `/pay/${order.id}`);
      assert.equal(jump.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(jump.headers.get('cache-control'), 'no-store');
      const cookie = jump.headers.get('set-cookie')!.split(';')[0]!;
      assert.equal((await req(`/pay/${order.id}`, cookie)).status, 200);
      assert.equal((await req(`/api/orders/${order.id}/pay`, cookie, 'POST')).status, 200);
      assert.equal(withTenantScope(A.rt, () => listOrders().find((o) => o.id === order.id))!.status, 'paid');
      for (const p of ['/console/', '/chat.html']) {
        const res = await req(p, cookie);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/try');
      }
      assert.equal((await req('/api/sandbox/end', cookie, 'POST')).status, 401);
      // 正文的方案与隐私链接也在最终 HTTP 请求体里检查。
      await deliver(message('wm1', '客户再次开窗口'));
      const linksBefore = records.length;
      await reply(A, 'wm1', `${base}/privacy\n${base}/proposal/${order.routeId}/2`);
      assert.ok(JSON.stringify(sends(linksBefore)).includes(`/wx/${tokenA}/privacy`));
      assert.ok(JSON.stringify(sends(linksBefore)).includes(`/wx/${tokenA}/proposal/`));
    });
    await scenario(`${backend} 16③ 过期码、手打改绑、旧会话拒发`, async () => {
      const stale = await sign(A);
      await q("update sandbox_wechat set code_expires_at=now()-interval '1 second' where tenant_id=$1", [A.id]);
      expectedCodes.get(normalize(stale))!.expiresAt = Date.now() - 1000;
      await deliver(enter('wmExpired', stale));
      assert.equal(sends().at(-1)!.body.text!.content, sandboxWechatIndex.fixedTexts(env.SANDBOX_HOST)[1]);
      assert.equal(sandboxWechatIndex.forUser('wmExpired'), undefined);
      await bind(A, 'wm2', true);
      const before = records.length;
      const res = await reply(A, 'wm1', '历史会话的回复');
      assert.equal(res.status, 200);
      assert.equal((await res.json()).sent, false);
      assert.equal(sends(before).length, 0);
      assert.ok((await detail(A, 'wm1')).messages.some((m: { text: string }) => m.text === '这个微信已不再连着这次体验'));
      assert.ok((await ledger(A, 'wm1')).some((r) => r.status === 'rejected'));
    });
    await scenario(`${backend} 16④ 跨沙箱改绑与交错对话`, async () => {
      await bind(B, 'wm2');
      await bind(A, 'wm1');
      assert.equal(
        (await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [B.id]))[0]!.external_userid,
        'wm2',
      );
      assert.equal((await req('/api/console/conversations/wecom:wm1/release', A.cookie, 'POST', {}, { 'x-csrf': A.csrf })).status, 200);
      const before = records.length;
      await deliver(message('wm1', '你好'), message('wm2', '你好'));
      assert.ok(sends(before).some((r) => r.body.touser === 'wm1'));
      assert.ok(sends(before).some((r) => r.body.touser === 'wm2'));
      sends(before).forEach(assertRecorded);
      tokenB = (await q<{ link_token: string }>('select link_token from sandbox_wechat where tenant_id=$1', [B.id]))[0]!.link_token;
      assert.notEqual(tokenA, tokenB);
    });
    await scenario(`${backend} 16⑤ 未绑定限频与十次错码`, async () => {
      const before = records.length;
      const turns = await q('select id from turn_traces order by id');
      await deliver(message('wm3', '你好'), message('wm3', '你好'), message('wm3', '你好'));
      assert.equal(sends(before).length, 1);
      for (let n = 0; n < 10; n++) await deliver(message('wm3', 'ZZZZ-ZZZZ'));
      await deliver(message('wm3', await sign(A)));
      assert.equal(sandboxWechatIndex.forUser('wm3'), undefined);
      assert.deepEqual(await q('select id from turn_traces order by id'), turns);
      assert.equal((await q("select id from conversations where id='wecom:wm3'")).length, 0);
      assert.equal(records.filter((r) => /model|embedding/.test(r.endpoint)).length, 0);
    });
    await scenario(`${backend} 16⑦ 同码扫码/手打与同微信两码并发`, async () => {
      const code = await sign(A);
      const before = records.length;
      await callback(enter('wmRace1', code), message('wmRace3', code));
      await service.drain();
      const rows = await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [A.id]);
      assert.ok(['wmRace1', 'wmRace3'].includes(rows[0]!.external_userid));
      assert.equal(sends(before).filter((r) => /AI/.test(r.body.text?.content ?? '')).length, 1);
      const ac = await sign(A),
        bc = await sign(B);
      await callback(enter('wmDual', ac), enter('wmDual', bc));
      await service.drain();
      assert.equal(sandboxWechatIndex.forUser('wmDual')?.id, B.id);
      assert.equal(
        (await q<{ external_userid: string | null }>('select external_userid from sandbox_wechat where tenant_id=$1', [A.id]))[0]!
          .external_userid,
        null,
      );
      await bind(A, 'wm1');
      await bind(B, 'wm2');
    });
    await scenario(`${backend} 验收6 第一段已收到后改绑`, async () => {
      await deliver(message('wm1', '开三段窗口'));
      const code = await sign(A);
      const ledgerBefore = new Set((await ledger(A, 'wm1')).map((r) => r.channel_msgid));
      const held = barrier();
      let first = false;
      sendHook = async (r) => {
        if (r.body.touser === 'wm1') {
          first = true;
          await held.promise;
        }
        return 0;
      };
      const before = records.length;
      const refusedBefore = warnings.filter((line) => line === '[sandbox-wecom] sandbox_send_refused').length;
      const pending = reply(A, 'wm1', '一'.repeat(1700));
      try {
        await until(() => first);
        await callback(enter('wmNew', code));
        await until(() => sandboxWechatIndex.forUser('wmNew')?.id === A.id);
      } finally {
        held.release();
      }
      const res = await pending;
      assert.equal((await res.json()).sent, false);
      await service.drain();
      sendHook = undefined;
      assert.ok(warnings.filter((line) => line === '[sandbox-wecom] sandbox_send_refused').length > refusedBefore);
      assert.equal(sends(before).filter((r) => r.body.touser === 'wm1').length, 1);
      const rows = await ledger(A, 'wm1');
      const segments = rows.filter((r) => !ledgerBefore.has(r.channel_msgid));
      assert.equal(segments.filter((r) => r.status === 'accepted').length, 1);
      assert.equal(segments.filter((r) => r.status === 'rejected').length, 2);
      assert.ok((await detail(A, 'wm1')).messages.some((m: { text: string }) => m.text === '这个微信已不再连着这次体验'));
    });
    await scenario(`${backend} 验收6 42001 强刷 token 期间改绑`, async () => {
      await deliver(message('wmNew', '开刷新窗口'));
      const code = await sign(A);
      const ledgerBefore = new Set((await ledger(A, 'wmNew')).map((r) => r.channel_msgid));
      const held = barrier();
      let refreshing = false;
      tokenHook = async () => {
        refreshing = true;
        await held.promise;
      };
      sendHook = async (r) => (r.body.touser === 'wmNew' ? 42001 : 0);
      const before = records.length;
      const refusedBefore = warnings.filter((line) => line === '[sandbox-wecom] sandbox_send_refused').length;
      const pending = reply(A, 'wmNew', '强刷期间的回复');
      try {
        await until(() => refreshing);
        await callback(enter('wm1', code));
        await until(() => sandboxWechatIndex.forUser('wm1')?.id === A.id);
      } finally {
        held.release();
      }
      assert.equal((await (await pending).json()).sent, false);
      await service.drain();
      sendHook = undefined;
      assert.ok(warnings.filter((line) => line === '[sandbox-wecom] sandbox_send_refused').length > refusedBefore);
      assert.equal(sends(before).filter((r) => r.body.touser === 'wmNew').length, 1);
      assert.equal(records.slice(before).filter((r) => r.endpoint === 'gettoken').length, 1);
      const refreshedRows = (await ledger(A, 'wmNew')).filter((r) => !ledgerBefore.has(r.channel_msgid));
      assert.equal(refreshedRows.length, 1);
      assert.equal(refreshedRows[0]!.status, 'rejected');
      assert.ok((await detail(A, 'wmNew')).messages.some((m: { text: string }) => m.text === '这个微信已不再连着这次体验'));
    });
    await scenario(`${backend} 验收6 A 作用域发 B、错误账号与欢迎码`, async () => {
      // 故意绕调用端保护，真实共同发送路径仍需拒绝；绑定全部来自 HTTP 签码和回调。
      const api = new SandboxWecomRuntime(
        {
          corpId: env.SANDBOX_WECOM_CORP_ID,
          secret: env.SANDBOX_WECOM_SECRET,
          openKfid: env.SANDBOX_WECOM_OPEN_KFID,
          host: env.SANDBOX_HOST,
        },
        globalThis.fetch,
      );
      const before = records.length;
      try {
        assert.equal(await withTenantScope(A.rt, () => api.push('wecom:wm2', '越租户回复')), false);
        const text = { touser: 'wm1', open_kfid: 'fake-other-kf', msgtype: 'text', text: { content: '错误账号' } };
        await assert.rejects(
          withTenantScope(A.rt, () => api.callApi('kf/send_msg', text)),
          SandboxSendRefused,
        );
        await assert.rejects(
          withoutTenantScope(() => api.callApi('kf/send_msg', { ...text, open_kfid: env.SANDBOX_WECOM_OPEN_KFID })),
          SandboxSendRefused,
        );
        await assert.rejects(
          withTenantScope(A.rt, () =>
            api.callApi('kf/send_msg_on_event', { code: 'fake-unknown-welcome', msgtype: 'text', text: { content: '越权欢迎' } }),
          ),
          SandboxSendRefused,
        );
        assert.equal(sends(before).length, 0);
        const held = barrier();
        let welcome: Recorded | undefined;
        sendHook = async (r) => {
          if (r.endpoint === 'kf/send_msg_on_event' && !welcome) {
            welcome = r;
            await held.promise;
            return 42001;
          }
          return 0;
        };
        try {
          await callback(enter('wm2', await sign(B)));
          await until(() => !!welcome);
          const captured = records.length;
          await assert.rejects(
            withTenantScope(A.rt, () =>
              api.callApi('kf/send_msg_on_event', { code: welcome!.body.code, msgtype: 'text', text: { content: '另一个沙箱的欢迎码' } }),
            ),
            SandboxSendRefused,
          );
          assert.equal(sends(captured).length, 0);
        } finally {
          held.release();
          await service.drain();
          sendHook = undefined;
        }
        assert.equal(
          sends(before).filter((r) => r.body.code === welcome!.body.code).length,
          2,
          'A 的拒发不能消费 B 的欢迎码，B 强刷之后仍能重发',
        );
        assert.ok((await ledger(A, 'wm2')).some((r) => r.status === 'rejected'));
        await __alertTest.settle();
        assert.ok(records.some((r) => r.endpoint === '/alert' && r.bytes.includes('发送边界拒绝')));
        assert.equal(__alertTest.isActive('sandbox_send_refused'), true);
      } finally {
        api.stop();
      }
    });
    await scenario(`${backend} 16⑧ 重启保留绑定、链接与未使用码，RLS`, async () => {
      const code = await sign(B);
      const hidden = await db.transaction(async (tx) => rowsOf(await tx.execute('select * from sandbox_wechat')));
      assert.equal(hidden.length, 0);
      await service.close();
      await cleanup();
      A.rt = (await loadSandboxRuntime(
        deps,
        { id: A.id, slug: A.rt.slug, expiresAt: new Date(A.rt.expiresAt!) },
        env.SANDBOX_HOST,
        async () => fakeLock(),
      ))!;
      B.rt = (await loadSandboxRuntime(
        deps,
        { id: B.id, slug: B.rt.slug, expiresAt: new Date(B.rt.expiresAt!) },
        env.SANDBOX_HOST,
        async () => fakeLock(),
      ))!;
      await start();
      assert.equal((await req(`/wx/${tokenA}/privacy`)).status, 302);
      assert.equal(sandboxWechatIndex.forUser('wm2')?.id, B.id);
      await deliver(enter('wmRestore', code));
      assert.equal(sandboxWechatIndex.forUser('wmRestore')?.id, B.id);
      assert.equal((await req(`/wx/${tokenB}/privacy`)).status, 302);
    });
    await scenario(`${backend} 16⑨ 两个 profile 异常日志遮盖链接令牌`, async () => {
      const saved = sandboxWechatIndex.forToken;
      const savedError = console.error;
      const logs: string[] = [];
      console.error = (...args) => logs.push(args.map(String).join(' '));
      try {
        for (const profile of ['demo', 'prod']) {
          __profileTest.use({ DEPLOY_PROFILE: profile, ADMIN_PASS: 'fake-admin' });
          sandboxWechatIndex.forToken = () => {
            throw new Error(`/wx/${tokenA}/privacy`);
          };
          const res = await req(`/wx/${tokenA}/privacy`);
          assert.equal(res.status, 503);
          assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
          assert.equal(res.headers.get('cache-control'), 'no-store');
        }
        assert.ok(logs.join('\n').includes('/wx/[已遮盖]'));
        assert.ok(!logs.join('\n').includes(tokenA));
      } finally {
        sandboxWechatIndex.forToken = saved;
        console.error = savedError;
        __profileTest.reset();
      }
      await __alertTest.settle();
      assert.ok(!records.filter((r) => r.endpoint === '/alert').some((r) => r.bytes.includes(tokenA) || r.bytes.includes(tokenB)));
      assert.ok(!JSON.stringify(await q('select * from audit_log')).includes(tokenA));
    });
    await scenario(`${backend} 16⑩ 95003 持久化、告警、已绑继续与复位`, async () => {
      const C = await open();
      await deliver(message('wmRestore', '开名额窗口'));
      sendHook = async () => 95003;
      const res = await reply(B, 'wmRestore', '名额满时回复');
      assert.equal((await res.json()).sent, false);
      await service.drain();
      sendHook = undefined;
      assert.equal((await (await req('/healthz')).json()).wecom.full, true);
      assert.ok((await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID)).fullSince);
      const full = await req('/api/sandbox/wechat/code', C.cookie, 'POST');
      assert.equal(full.status, 409);
      assert.equal((await full.json()).error, 'sandbox_wecom_full');
      assert.equal((await (await req('/api/console/me', C.cookie)).json()).sandbox.wechat, 'full');
      const before = records.length;
      await deliver(message('wmFull', '你好'));
      assert.equal(sends(before).length, 0);
      assert.equal(
        (await req('/api/console/conversations/wecom:wmRestore/release', B.cookie, 'POST', {}, { 'x-csrf': B.csrf })).status,
        200,
      );
      const continuing = records.length;
      await deliver(message('wmRestore', '已绑定继续'));
      assert.ok(sends(continuing).some((r) => r.body.touser === 'wmRestore'));
      await __alertTest.settle();
      assert.equal(records.filter((r) => r.endpoint === '/alert' && r.bytes.includes('微信体验名额已满')).length, 1);
      await service.close();
      await start();
      assert.equal(service.health().full, true);
      await resetSandboxWecomFull(db);
      await service.refreshFull();
      assert.equal(service.health().full, false);
      await sign(C);
      assert.equal((await req('/api/sandbox/end', C.cookie, 'POST')).status, 200);
      await reaper.tick();
    });
    await scenario(`${backend} 验收6 种子/无SSE模拟器、转人工、任务与遥测挡板`, async () => {
      const before = records.length;
      const seed = withTenantScope(
        A.rt,
        () =>
          listSessions()
            .filter((s) => s.id.startsWith('sbx-'))
            .sort((a, b) => a.createdAt - b.createdAt)[0],
      )!;
      const res = await req(
        `/api/console/conversations/${seed.id}/reply`,
        A.cookie,
        'POST',
        { text: '种子接手回复', clientId: randomUUID() },
        { 'x-csrf': A.csrf },
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).sent, true);
      assert.equal(sends(before).length, 0);
      const chat = await req('/api/chat', A.cookie, 'POST', { text: '你好' });
      assert.equal(chat.status, 200);
      const simulator = await chat.json();
      const simulatorReply = await req(
        `/api/console/conversations/${simulator.sessionId}/reply`,
        A.cookie,
        'POST',
        { text: '无 SSE 坐席回复', clientId: randomUUID() },
        { 'x-csrf': A.csrf },
      );
      assert.equal(simulatorReply.status, 200);
      assert.equal((await simulatorReply.json()).sent, true);
      assert.equal(sends(before).length, 0);
      assert.equal((await req('/api/console/conversations/wecom:wm1/release', A.cookie, 'POST', {}, { 'x-csrf': A.csrf })).status, 200);
      await deliver(message('wm1', '我要人工客服'));
      assert.ok((await detail(A, 'wm1')).handoffCard);
      await withoutTenantScope(() => alert('jobs', '全程测试进程级告警', { instance: true }));
      await __alertTest.settle();
      assert.ok(records.some((r) => r.endpoint === '/alert' && r.bytes.includes('进程级告警')));
      assert.equal(records.filter((r) => r.endpoint === '/notify' || r.endpoint === '/otlp').length, 0);
      assert.equal((await q('select id from jobs')).length, 0);
      assert.equal((await q('select id from channel_accounts')).length, 0);
      for (const v of [A, B]) assert.equal(v.rt.store.pgBackend!.isPoisoned(`wecom:${v === A ? 'wm1' : 'wmRestore'}`), false);
    });
    await scenario(`${backend} 验收6 会话落库失败恢复与 advisor 下单`, async () => {
      const D = await open();
      await bind(D, 'wmAdvisor');
      const before = records.length;
      await q('create sequence fake_write_attempt');
      await q('grant usage,select on sequence fake_write_attempt to agent_app');
      await q(
        `create function fake_write_failure() returns trigger language plpgsql as $$ begin if NEW.conversation_id = 'wecom:wmAdvisor' and nextval('fake_write_attempt') = 1 then raise exception 'fake_retry' using errcode='40001'; end if; return NEW; end $$`,
      );
      await q('create trigger fake_write_failure before insert on messages for each row execute function fake_write_failure()');
      try {
        await deliver(message('wmAdvisor', '你好'));
        await flush(D);
        assert.ok(Number((await q<{ last_value: string }>('select last_value from fake_write_attempt'))[0]!.last_value) >= 2);
        assert.ok(sends(before).some((r) => r.body.touser === 'wmAdvisor'));
        assert.ok((await detail(D, 'wmAdvisor')).messages.some((m: { text: string }) => m.text === '你好'));
        assert.equal(D.rt.store.pgBackend!.isPoisoned('wecom:wmAdvisor'), false);
      } finally {
        await q('drop trigger fake_write_failure on messages');
        await q('drop function fake_write_failure()');
        await q('drop sequence fake_write_attempt');
      }
      __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
      try {
        await deliver(message('wmAdvisor', `就订西藏这个，2个人，${departDate}出发`));
        const order = withTenantScope(D.rt, () => listOrders().find((o) => o.sessionId === 'wecom:wmAdvisor'))!;
        assert.ok(order);
        assert.equal((await detail(D, 'wmAdvisor')).paymentMode, 'advisor');
        assert.equal((await req(`/api/console/orders/${order.id}/mark-paid`, D.cookie, 'POST', {}, { 'x-csrf': D.csrf })).status, 409);
        assert.equal((await req(`/api/console/orders/${order.id}/confirm`, D.cookie, 'POST', {}, { 'x-csrf': D.csrf })).status, 200);
        assert.equal((await req(`/api/console/orders/${order.id}/mark-paid`, D.cookie, 'POST', {}, { 'x-csrf': D.csrf })).status, 200);
        assert.ok((await ledger(D, 'wmAdvisor')).every((r) => !['pending', 'sending', 'unknown'].includes(r.status)));
      } finally {
        __profileTest.reset();
      }
      assert.equal((await req('/api/sandbox/end', D.cookie, 'POST')).status, 200);
      await reaper.tick();
    });
    await scenario(`${backend} 16⑥ 结束A不影响B、B到期清除全部授权`, async () => {
      assert.equal((await req('/api/sandbox/end', A.cookie, 'POST')).status, 200);
      assert.equal((await req(`/wx/${tokenA}/privacy`)).status, 404);
      await reaper.tick();
      assert.equal(runtimeOf(A.id), undefined);
      assert.equal((await q('select * from sandbox_wechat where tenant_id=$1', [A.id])).length, 0);
      const before = records.length;
      await deliver(message('wmRestore', '你好'));
      assert.ok(sends(before).some((r) => r.body.touser === 'wmRestore'));
      assert.equal((await req(`/wx/${tokenB}/privacy`)).status, 302);
      await flush(B);
      await q("update tenants set expires_at=now()-interval '1 second' where id=$1", [B.id]);
      expectedBindings.delete(B.id);
      await reaper.tick();
      assert.equal(runtimeOf(B.id), undefined);
      assert.equal((await q('select * from sandbox_wechat where tenant_id=$1', [B.id])).length, 0);
      assert.equal(sandboxWechatIndex.forUser('wmRestore'), undefined);
      assert.equal((await req(`/wx/${tokenB}/privacy`)).status, 404);
      await deliver(message('wmRestore', '已删除后的消息'));
      assert.equal(sends().at(-1)!.body.text!.content, sandboxWechatIndex.fixedTexts(env.SANDBOX_HOST)[0]);
      assert.equal((await q('select * from messages where tenant_id=$1', [B.id])).length, 0);
    });
    await scenario(`${backend} 16⑩ 未配客服的HTTP入口与模拟器投影`, async () => {
      await service.close();
      configured = false;
      const C = await open();
      assert.equal((await req('/wecom/callback')).status, 404);
      assert.equal((await (await req('/api/console/me', C.cookie)).json()).sandbox.wechat, 'off');
      assert.equal((await req('/chat.html', C.cookie)).status, 200);
      assert.equal((await req('/api/sandbox/end', C.cookie, 'POST')).status, 200);
      await reaper.tick();
    });
    sends().forEach(assertRecorded);
    console.log(`ASSERT PASS: ALL_TEXT_AND_WELCOME_HTTP_REQUESTS_MATCH_INDEPENDENT_BINDINGS ${sends().length}`);
    assert.equal(records.filter((r) => r.endpoint === 'kf/customer/batchget').length, 0);
    await __alertTest.settle();
    assert.ok(records.filter((r) => r.endpoint === '/alert').every((r) => /发送边界拒绝|进程级告警|微信体验名额已满/.test(r.bytes)));
    assert.ok(!fs.readdirSync(temp).some((name) => /spill/.test(name)));
  } finally {
    sendHook = undefined;
    tokenHook = undefined;
    reaper.stop();
    __alertTest.stopTimer();
    await service!.close();
    await __alertTest.settle();
    await closeServer(http as Server);
    await closeServer(fake);
    globalThis.fetch = originalFetch;
    console.warn = warnBefore;
  }
}

const began = performance.now();
try {
  const lite = await openTestDb();
  try {
    await lite.pg.exec('SET ROLE agent_app');
    const q: Query = (text, params = []) =>
      lite.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query(text, params)).rows as never;
      });
    await suite(lite.db, q, 'PGlite');
  } finally {
    await cleanup();
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await openOutboundTestPg(process.env.PG_TEST_URL);
    try {
      await suite(pg.db, pg.query, 'PG');
    } finally {
      await cleanup();
      await pg.close();
    }
  } else console.log('SKIP: 真实 PG 需要 PG_TEST_URL');
  console.log(`SELFTEST PASS: 微信全程 ${checks} 场景 ${(performance.now() - began).toFixed(0)}ms`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalAlert === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = originalAlert;
  await cleanup();
  fs.rmSync(temp, { recursive: true, force: true });
}
