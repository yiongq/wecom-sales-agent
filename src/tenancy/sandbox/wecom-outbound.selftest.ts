// R11/R21：假企微覆盖每次发送、受限 cookie、令牌保密与 02 结果账本。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openTestDb, testConfigDeps, fakeLock } from '../../db/testing.js';
import { openOutboundTestPg } from '../../db/sandbox-outbound-testing.js';
import { type Db, type Tx } from '../../db/client.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig } from '../../config/source.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import { SandboxWecomRuntime, installSandboxWecomOutbound, wecomAdapter } from '../../adapters/wecom.js';
import { getOrCreateSession, saveSession, flushSession, drainStore, listOrders } from '../../store.js';
import { __alertTest } from '../../ops/alert.js';
import { __ledgerTest } from '../../quota/ledger.js';
import { SandboxWecom, type KfMessage } from './wecom.js';
import { sandboxWechatIndex, SandboxSendRefused } from './outbound.js';
import { sandboxApp, SandboxProcess } from './process.js';
import { provisionSandbox } from './provision.js';
import { resolveSandboxSession } from './session.js';
import { __sandboxLimitsTest } from './limits.js';
import { readSandboxLink } from '../../db/repo/sandbox.js';
import { loadSandboxRuntime } from './load.js';
import {
  createTenantRuntime,
  configureTenancy,
  runtimeOf,
  tenantRuntimes,
  unregisterRuntime,
  withTenantScope,
  withoutTenantScope,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { __logTest, convLabelsIn } from '../../log.js';
import { __profileTest } from '../../profile.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-wx-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app: routes } = await import('../../server.js');
const originalFetch = globalThis.fetch;
const otherRequests: { url: string; body: string }[] = [];
const previousAlertUrl = process.env.ALERT_WEBHOOK_URL;
process.env.ALERT_WEBHOOK_URL = 'https://alert.example.invalid/record';
globalThis.fetch = async (input, init) => {
  const url = String(input);
  otherRequests.push({ url, body: String(init?.body ?? '') });
  if (url === process.env.ALERT_WEBHOOK_URL) return Response.json({ errcode: 0 });
  throw new Error('禁止真实网络');
};
const originalWarn = console.warn;
const logs: string[] = [];
console.warn = (...args) => logs.push(args.map(String).join(' '));
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const cfg = { corpId: 'fake-corp', secret: 'fake-secret', openKfid: 'fake-kf', host: 'sandbox.example.invalid' }; // gitleaks:allow
const base = `https://${cfg.host}`;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
async function review(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  checks++;
  console.log(`REVIEW PASS: ${name}`);
}
// 企微事件消息顶层没有 open_kfid、external_userid，2026-10-12 线上 sync_msg 实测。
function eventMessage(id: string, user: string, event: NonNullable<KfMessage['event']>): KfMessage {
  return {
    msgid: id,
    send_time: Date.now() / 1000,
    origin: 4,
    msgtype: 'event',
    event: { open_kfid: cfg.openKfid, external_userid: user, ...event },
  } as KfMessage; // 保留宿主共用类型的顶层必填字段；假事件按真实 wire 布局构造。
}

async function cleanup(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    await withTenantScope(rt, () => drainStore(5000));
    rt.state = 'closed';
    rt.store.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
}

async function suite(db: Db, q: Query): Promise<void> {
  __alertTest.reset();
  otherRequests.length = 0;
  __sandboxLimitsTest.resetProvisioned();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('template','模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: template!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: host.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  assert.equal(imported.code, 0, imported.message);
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'假隐私说明')", [host.id]);
  const create = () =>
    provisionSandbox({
      deps,
      templateSlug: host.slug,
      host: cfg.host,
      epoch: '0',
      acquireTenant: async () => fakeLock(),
      ip: null,
      userAgent: null,
    });
  const a = await create(),
    b = await create();
  let A = runtimeOf(a.tenantId)!;
  const B = runtimeOf(b.tenantId)!;
  const tokenOf = async (id: string) =>
    (await q<{ link_token: string }>('select link_token from sandbox_wechat where tenant_id=$1', [id]))[0]!.link_token;
  const tokenA = await tokenOf(A.id),
    tokenB = await tokenOf(B.id);
  check(() => {
    assert.match(tokenA, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(tokenA, tokenB);
    assert.notEqual(tokenA, a.slug);
  });
  // RLS 的读仍在 withTenant；空 GUC 看不见令牌。
  check(() => assert.equal(sandboxWechatIndex.forToken(tokenA), A));
  const hiddenLink = await readSandboxLink(db as unknown as Tx);
  check(() => assert.equal(hiddenLink, null));
  sandboxWechatIndex.publishBinding(A, 'wmA');
  sandboxWechatIndex.publishBinding(B, 'wmB');
  let sends: { endpoint: string; body: Record<string, any> }[] = [];
  let mode = 'ok';
  let refresh: (() => void) | null = null;
  let duringSend: (() => void) | null = null;
  let tokenCalls = 0;
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split('/cgi-bin/')[1]!;
    requests.push(endpoint);
    if (endpoint === 'gettoken') {
      tokenCalls++;
      refresh?.();
      refresh = null;
      return Response.json({ access_token: 'fake-access', expires_in: 7200 });
    }
    if (endpoint === 'media/upload') return Response.json({ media_id: 'fake-thumb' });
    const body = JSON.parse(String(init?.body));
    sends.push({ endpoint, body });
    duringSend?.();
    duringSend = null;
    if (mode === 'expired' || mode === 'invalid-token') {
      const errcode = mode === 'expired' ? 42001 : 40014;
      mode = 'ok';
      return Response.json({ errcode });
    }
    if (mode === 'busy') {
      mode = 'ok';
      return Response.json({ errcode: 45009 });
    }
    if (mode === 'card-fail' && body.msgtype === 'link') return Response.json({ errcode: 40058 });
    if (mode === 'timeout') {
      mode = 'ok';
      throw new DOMException('fake-timeout', 'TimeoutError');
    }
    if (mode === 'http-error') {
      mode = 'ok';
      return Response.json({}, { status: 503 });
    }
    if (mode === 'http-api-refused') {
      mode = 'ok';
      return Response.json({ errcode: 40058 }, { status: 503 });
    }
    if (mode === 'api-refused') {
      mode = 'ok';
      return Response.json({ errcode: 40058 });
    }
    if (mode === 'network') {
      mode = 'ok';
      throw new Error('fake-network');
    }
    if (mode === 'hang')
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new Error('fake-aborted')), { once: true }),
      );
    return Response.json({ errcode: 0 });
  };
  const api = new SandboxWecomRuntime(cfg, request);
  installSandboxWecomOutbound(api);
  const raw = (body: Record<string, unknown>, endpoint = 'kf/send_msg') => api.callApi(endpoint, body);
  const text = (user = 'wmA', open = cfg.openKfid, content = '测试') => ({
    touser: user,
    open_kfid: open,
    msgtype: 'text',
    text: { content },
  });
  const refused = async (fn: () => Promise<unknown>) => {
    const n = sends.length,
      warnings = logs.filter((s) => s.includes('[sandbox-wecom] sandbox_send_refused')).length;
    await assert.rejects(fn, SandboxSendRefused);
    check(() => {
      assert.equal(sends.length, n);
      assert.equal(logs.filter((s) => s.includes('[sandbox-wecom] sandbox_send_refused')).length, warnings + 1);
    });
  };
  await review('runtime-private-request-no-network', async () => {
    const before = requests.length;
    assert.equal(api['request' as keyof SandboxWecomRuntime], undefined);
    assert.equal(Reflect.get(api, 'request'), undefined);
    assert.equal(Reflect.get(api, '#request'), undefined);
    assert.throws(() => (api as any)['request'](`${base}/fake`, { body: JSON.stringify(text('wmB')) }), TypeError);
    assert.throws(() => Reflect.get(api, 'request')(`${base}/fake`, { body: JSON.stringify(text('wmB')) }), TypeError);
    assert.equal(requests.length, before);
  });
  await review('request-parameters-before-guard-no-network', async () => {
    let conversions = 0;
    const hostile = {
      toString() {
        conversions++;
        sandboxWechatIndex.publishBinding(A, 'wmNew');
        return 'fake-access';
      },
    };
    const before = requests.length;
    for (const token of [hostile, new String('fake-access'), null, 1]) {
      assert.throws(() => withTenantScope(A, () => api.requestMessage(token as string, 'kf/send_msg', text())), SandboxSendRefused);
      assert.throws(() => withTenantScope(A, () => api.upload(token as string, new FormData(), 'wmA')), SandboxSendRefused);
    }
    assert.throws(
      () => withTenantScope(A, () => api.requestMessage('fake-access', hostile as unknown as string, text())),
      SandboxSendRefused,
    );
    assert.throws(
      () => withTenantScope(A, () => api.upload('fake-access', new FormData(), hostile as unknown as string)),
      SandboxSendRefused,
    );
    assert.equal(conversions, 0, '非字符串参数拒绝，不执行 toString，也不允许它改绑');
    assert.equal(sandboxWechatIndex.forUser('wmA'), A);
    assert.equal(requests.length, before, '消息与上传均没有请求');
  });
  await review('final-json-getter-recipient', async () => {
    for (const direct of [false, true]) {
      let reads = 0;
      const body = {
        ...text(),
        get touser() {
          return ++reads === 1 ? 'wmA' : 'wmB';
        },
      };
      const before = sends.length;
      await withTenantScope(A, () => (direct ? api.requestMessage('fake-access', 'kf/send_msg', body) : raw(body)));
      assert.equal(reads, 1, '核对前固化一次，之后不再调用原对象 getter');
      assert.equal(sends.length, before + 1);
      assert.equal(sends.at(-1)!.body.touser, 'wmA', '假企微只收到核对过的收件人');
    }
    const body = {
      ...text(),
      get touser() {
        return 'wmB';
      },
    };
    await withTenantScope(A, () => refused(() => raw(body)));
  });
  await review('final-json-tojson-recipient-and-content', async () => {
    for (const replacement of [text('wmB'), text('wmA', 'fake-other'), text('wmC', cfg.openKfid, '任意正文')]) {
      const body = { ...text(), toJSON: () => replacement };
      await withTenantScope(A, () => refused(() => raw(body)));
      const before = sends.length;
      assert.throws(() => withTenantScope(A, () => api.requestMessage('fake-access', 'kf/send_msg', body)), SandboxSendRefused);
      assert.equal(sends.length, before);
    }
    const body = { ...text('wmC', cfg.openKfid, sandboxWechatIndex.fixedTexts(cfg.host)[0]), toJSON: () => text('wmC') };
    await withoutTenantScope(() => refused(() => raw(body)));
    let calls = 0;
    const once = {
      ...text(),
      toJSON() {
        calls++;
        return calls === 1 ? text() : text('wmB', 'fake-other', '换正文');
      },
    };
    await withTenantScope(A, () => raw(once));
    assert.equal(calls, 1);
    assert.deepEqual(sends.at(-1)!.body, text());
  });
  await review('final-wire-json-identical', async () => {
    let wire: unknown;
    const fresh = new SandboxWecomRuntime(cfg, async (input, init) => {
      wire = init?.body;
      return request(input, init);
    });
    const original = {
      ...text(),
      toJSON() {
        const snapshot = text('wmA', cfg.openKfid, `${base}/privacy`);
        this.touser = 'wmB';
        this.open_kfid = 'fake-other';
        this.text.content = '序列化以后换正文';
        return snapshot;
      },
    };
    try {
      await withTenantScope(A, () => fresh.requestMessage('fake-access', 'kf/send_msg', original));
      assert.equal(typeof wire, 'string');
      assert.equal(wire, JSON.stringify(text('wmA', cfg.openKfid, `${base}/wx/${tokenA}/privacy`)));
      assert.deepEqual(sends.at(-1)!.body, JSON.parse(wire as string));
      assert.equal(original.touser, 'wmB', '原对象已变，核对和发出仍只用固化副本');
    } finally {
      fresh.stop();
    }
  });
  await review('endpoint-whitelist-no-network', async () => {
    const fresh = new SandboxWecomRuntime(cfg, request);
    try {
      for (const endpoint of ['kf/../kf/send_msg', 'kf/send_msg/', 'KF/send_msg', 'kf/Send_Msg', 'kf/unknown', 'kf/%2e%2e/kf/send_msg']) {
        const before = requests.length;
        await withoutTenantScope(() => refused(() => fresh.callApi(endpoint, text('wmB', 'fake-other', '任意正文'))));
        assert.equal(requests.length, before, '未知或非规范 endpoint 连 gettoken 都不能发');
        assert.throws(() => fresh.requestMessage('fake-access', endpoint, text()), SandboxSendRefused);
        assert.equal(requests.length, before);
      }
    } finally {
      fresh.stop();
    }
  });
  await withTenantScope(A, () => refused(() => raw(text('wmB'))));
  await withTenantScope(A, () => refused(() => raw(text('wmA', 'fake-other'))));
  await withoutTenantScope(() => refused(() => raw(text())));
  await withoutTenantScope(() => api.replyUnbound('wmC'));
  await withTenantScope(A, () =>
    refused(() => raw({ code: 'fake-missing', msgtype: 'text', text: { content: '测试' } }, 'kf/send_msg_on_event')),
  );
  sandboxWechatIndex.rememberWelcome('fake-other-code', 'wmB');
  sandboxWechatIndex.assignWelcome('fake-other-code', B);
  await withTenantScope(A, () =>
    refused(() => raw({ code: 'fake-other-code', msgtype: 'text', text: { content: '测试' } }, 'kf/send_msg_on_event')),
  );
  // 每次强刷都重核：两种企微失效码都不漏。
  for (const expired of ['expired', 'invalid-token']) {
    mode = expired;
    refresh = () => sandboxWechatIndex.publishBinding(A, 'wmNew');
    await withTenantScope(A, () => refusedAfterFirst(() => raw(text())));
    sandboxWechatIndex.publishBinding(A, 'wmA');
  }
  async function refusedAfterFirst(fn: () => Promise<unknown>) {
    const n = sends.length;
    await assert.rejects(fn, SandboxSendRefused);
    check(() => assert.equal(sends.length, n + 1));
  }
  sandboxWechatIndex.rememberWelcome('fake-rebind-code', 'wmA');
  sandboxWechatIndex.assignWelcome('fake-rebind-code', A);
  mode = 'expired';
  refresh = () => sandboxWechatIndex.withdraw(A.id);
  await withTenantScope(A, () => refusedAfterFirst(() => api.welcome('fake-rebind-code')));
  sandboxWechatIndex.publishBinding(A, 'wmA');
  // welcome_code 沿用一次强刷，随后消费；重发和超时均不能再用。
  sandboxWechatIndex.rememberWelcome('fake-welcome', 'wmA');
  sandboxWechatIndex.assignWelcome('fake-welcome', A);
  mode = 'expired';
  await withTenantScope(A, () => api.welcome('fake-welcome'));
  check(() => assert.ok(JSON.stringify(sends.at(-1)!.body).includes(`/wx/${tokenA}/privacy`)));
  await withTenantScope(A, () =>
    refused(() => raw({ code: 'fake-welcome', msgtype: 'text', text: { content: '测试' } }, 'kf/send_msg_on_event')),
  );
  sandboxWechatIndex.rememberWelcome('fake-old', 'wmA', Date.now() - 20_001);
  sandboxWechatIndex.assignWelcome('fake-old', A);
  await withTenantScope(A, () => refused(() => api.welcome('fake-old')));
  sandboxWechatIndex.rememberWelcome('fake-network-code', 'wmC');
  mode = 'network';
  await assert.rejects(() => withoutTenantScope(() => api.replyUnbound('wmC', 'fake-network-code')));
  await withoutTenantScope(() =>
    refused(() =>
      raw(
        { code: 'fake-network-code', msgtype: 'text', text: { content: sandboxWechatIndex.fixedTexts(cfg.host)[0] } },
        'kf/send_msg_on_event',
      ),
    ),
  );
  await review('welcome-delivery-outcome', async () => {
    for (const [failure, expected] of [
      ['network', 'unknown'],
      ['timeout', 'unknown'],
      ['http-error', 'unknown'],
      ['api-refused', 'rejected'],
      ['http-api-refused', 'rejected'],
    ]) {
      const code = `fake-welcome-${failure}`;
      sandboxWechatIndex.rememberWelcome(code, 'wmA');
      sandboxWechatIndex.assignWelcome(code, A);
      mode = failure!;
      const before = sends.length;
      await assert.rejects(() => withTenantScope(A, () => api.welcome(code)));
      assert.equal(sends.length, before + 1, '欢迎语失败不重发');
      assert.equal(
        withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
        expected,
      );
    }
  });
  const [order] = withTenantScope(A, listOrders);
  const url = `${base}/pay/${order!.id}`;
  await review('link-punctuation-and-human-text', async () => {
    mode = 'ok';
    for (const source of [
      ...['；', '、', '：', '】', '」', '～', '。', '，', '.', ',', ')', ';'].map((p) => `${url}${p}`),
      `(${url})`,
      `（${url}）`,
      `【${base}/privacy】`,
      `「${base}/privacy.」`,
      `(${url})；（${base}/privacy），${base}/proposal/route/2?v=1。`,
    ]) {
      await withTenantScope(A, () => raw(text('wmA', cfg.openKfid, source)));
      assert.equal(sends.at(-1)!.body.text.content, source.replaceAll(base, `${base}/wx/${tokenA}`));
    }
    // 上传失败，顾问手打链接仍从原正文发出；尾部括号和前缀不能丢。
    const noThumb = new SandboxWecomRuntime(cfg, async (input, init) => {
      if (String(input).includes('media/upload')) {
        requests.push('media/upload');
        return Response.json({ errcode: 0 });
      }
      return request(input, init);
    });
    try {
      const source = `顾问手打：(${url})；`;
      assert.equal(await withTenantScope(A, () => noThumb.push('wecom:wmA', source, { kind: 'human' })), true);
      assert.equal(sends.at(-1)!.body.text.content, `【顾问】${source.replaceAll(base, `${base}/wx/${tokenA}`)}`);
    } finally {
      noThumb.stop();
    }
  });
  await review('unrewritable-local-link-rejected', async () => {
    for (const source of [
      `${base}/console/`,
      `${base}/privacy/extra`,
      `https://${cfg.host}./privacy`,
      `${base}/pay/a%2fb`,
      `http://${cfg.host}/privacy`,
      `https://${cfg.host}:bad/privacy`,
      `${url}\n${base}/console/`,
    ]) {
      const before = requests.length;
      assert.equal(await withTenantScope(A, () => api.push('wecom:wmA', source, { kind: 'human' })), false);
      assert.equal(requests.length, before, '整条拒绝，卡片与上传也不能发');
      assert.equal(
        withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
        'rejected',
      );
      await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, source))));
    }
  });
  await review('final-host-guard-aliases-all-message-fields', async () => {
    const encodedHost = [...cfg.host].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
    const escapedHost = [...cfg.host].map((c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const aliases = [
      `https://u;s@${cfg.host}/privacy`,
      `https://u,s@${cfg.host}/privacy`,
      `https://u(s)@${cfg.host}/privacy`,
      `https://${cfg.host}:443/privacy`,
      `https://${cfg.host}:8443/privacy`,
      `https://${cfg.host.toUpperCase()}/privacy`,
      `https://${encodedHost}/privacy`,
      `https://${encodedHost.replaceAll('%', '%25')}/privacy`,
      `https://${cfg.host}./privacy`,
      `https://[${cfg.host}]/privacy`,
      `https://%5b${encodedHost}%5d/privacy`,
      `https://${escapedHost}/privacy`,
      String.raw`https:\/\/${escapedHost}\/privacy`,
      `本站：${cfg.host}`,
      `${base}/try?extra=1`,
      `${base}/wx/${tokenB}/privacy`,
      `${base}/wx/${tokenA}/console/`,
      `${base}/wx/${tokenA}/privacy?next=${encodedHost}`,
    ];
    for (const source of aliases) {
      await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, source))));
      await withTenantScope(A, () => refused(() => raw({ ...text(), msgtype: 'link', link: { url: source } })));
      const before = requests.length;
      assert.equal(await withTenantScope(A, () => api.push('wecom:wmA', source, { kind: 'human' })), false);
      assert.equal(requests.length, before, '正文/补文预检拒绝，不能先上传或发卡片');
      assert.equal(
        withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
        'rejected',
      );
    }
    // 最终序列化副本也检查字段名和 toJSON 临时换入的内容。
    await withTenantScope(A, () => refused(() => raw({ ...text(), [encodedHost]: '附加字段' })));
    await withTenantScope(A, () => refused(() => raw({ ...text(), toJSON: () => text('wmA', cfg.openKfid, aliases[0]) })));
    // 真正的 JSON \u 转义解析后也不能藏住 Host。
    const escapedJson = JSON.stringify(text('wmA', cfg.openKfid, `${base}/console/`)).replace(cfg.host, escapedHost);
    await withTenantScope(A, () => refused(() => raw(JSON.parse(escapedJson))));
    const code = 'fake-host-code';
    sandboxWechatIndex.rememberWelcome(code, 'wmA');
    sandboxWechatIndex.assignWelcome(code, A);
    await withTenantScope(A, () => refused(() => raw({ code, msgtype: 'text', text: { content: aliases[0] } }, 'kf/send_msg_on_event')));
    sandboxWechatIndex.rememberWelcome('fake-welcome-host', 'wmA');
    sandboxWechatIndex.assignWelcome('fake-welcome-host', A);
    Object.defineProperty(api, 'welcomeText', { configurable: true, value: aliases[0] });
    try {
      await withTenantScope(A, () => refused(() => api.welcome('fake-welcome-host')));
      assert.equal(
        withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
        'rejected',
      );
    } finally {
      Reflect.deleteProperty(api, 'welcomeText');
    }
    await __alertTest.settle();
    assert.equal(__alertTest.isActive('sandbox_send_refused'), true);
    assert.ok(otherRequests.length > 0, '推实例级拒绝告警');
  });
  await review('final-host-guard-unicode-host-variants', async () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://main.example.invalid';
    const fullwidth = (host: string) => host.replace(/[A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    try {
      for (const host of [cfg.host, 'main.example.invalid']) {
        const variants = [
          fullwidth(host),
          ...['。', '．', '｡'].flatMap((dot) => [host.replaceAll('.', dot), fullwidth(host.toUpperCase()).replaceAll('.', dot)]),
        ];
        for (const variant of variants) {
          for (const authority of [
            variant,
            `${variant}:8443`,
            `u;s@${variant}`,
            `u;s@${variant}:8443`,
            `u;s@${encodeURIComponent(variant)}:8443`,
          ]) {
            const source = `https://${authority}/privacy`;
            await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, source))));
            const before = requests.length;
            assert.equal(await withTenantScope(A, () => api.push('wecom:wmA', source, { kind: 'human' })), false);
            assert.equal(requests.length, before, 'Unicode 主机变体整条拒绝，不先上传或发卡片');
            assert.equal(
              withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
              'rejected',
            );
          }
          // 正文里字面 JSON 转义也要先解码，再按主机规则规范化。
          const escaped = [...variant].map((c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
          await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, `https://u;s@${escaped}/privacy`))));
        }
      }
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
    }
  });
  await review('final-host-guard-chinese-period-preserved', async () => {
    for (const source of ['已收到，我稍后回复您。', `请看隐私说明：${base}/privacy。`, '参考：https://other.example.invalid/privacy。']) {
      await withTenantScope(A, () => raw(text('wmA', cfg.openKfid, source)));
      assert.equal(sends.at(-1)!.body.text.content, source.replaceAll(base, `${base}/wx/${tokenA}`));
    }
  });
  await review('final-host-guard-fixed-text-and-third-party', async () => {
    for (const content of sandboxWechatIndex.fixedTexts(cfg.host)) {
      await withoutTenantScope(() => raw(text('wmC', cfg.openKfid, content)));
      assert.equal(sends.at(-1)!.body.text.content, content);
    }
    for (const content of [
      sandboxWechatIndex.fixedTexts(cfg.host)[0] + '附加正文',
      sandboxWechatIndex.fixedTexts(cfg.host)[0].replace('/try', '/try?x=1'),
      sandboxWechatIndex.fixedTexts(cfg.host)[0].replace('/try', '/try/'),
    ])
      await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, content))));
    const thirdParty = 'https://u;s@other.example.invalid:8443/privacy?x=1； https://OTHER.EXAMPLE.INVALID/pay/o';
    await withTenantScope(A, () => raw(text('wmA', cfg.openKfid, thirdParty)));
    assert.equal(sends.at(-1)!.body.text.content, thirdParty);
    // 当前令牌的三个精确路径照常发出；其他令牌与页面不放行。
    const valid = `${base}/wx/${tokenA}/privacy ${base}/wx/${tokenA}/pay/o1 ${base}/wx/${tokenA}/proposal/route/2?v=1`;
    await withTenantScope(A, () => raw(text('wmA', cfg.openKfid, valid.replaceAll(`/wx/${tokenA}`, ''))));
    assert.equal(sends.at(-1)!.body.text.content, valid);
  });
  await review('final-host-guard-main-site-no-outbound-allowlist', async () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://main.example.invalid';
    try {
      for (const content of [
        'https://main.example.invalid/privacy',
        'https://u;s@MAIN.EXAMPLE.INVALID/try',
        'https://%6dain.example.invalid/pay/o1',
      ]) {
        await withTenantScope(A, () => refused(() => raw(text('wmA', cfg.openKfid, content))));
        const before = requests.length;
        assert.equal(await withTenantScope(A, () => api.push('wecom:wmA', content)), false);
        assert.equal(requests.length, before);
        assert.equal(
          withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
          'rejected',
        );
      }
      await withoutTenantScope(() => api.replyUnbound('wmC'));
      await withTenantScope(A, () => raw(text('wmA', cfg.openKfid, `${base}/privacy https://other.example.invalid/try`)));
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
    }
  });
  await review('rebind-before-upload', async () => {
    const fresh = new SandboxWecomRuntime(cfg, request);
    const before = requests.length;
    refresh = () => sandboxWechatIndex.withdraw(A.id);
    try {
      assert.equal(await withTenantScope(A, () => fresh.push('wecom:wmA', url)), false);
      assert.deepEqual(requests.slice(before), ['gettoken'], '取 token 时撤绑定，上传和发送均不发');
      assert.equal(
        withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
        'rejected',
      );
    } finally {
      fresh.stop();
      sandboxWechatIndex.publishBinding(A, 'wmA');
    }
  });
  for (const cardMode of ['ok', 'card-fail']) {
    sends = [];
    mode = cardMode;
    const original = `付款说明\n支付链接：${url}`;
    await withTenantScope(A, async () => {
      const s = getOrCreateSession('wecom:wmA', 'wecom');
      const message = { role: 'agent' as const, content: original, at: Date.now() };
      s.messages.push(message);
      saveSession(s);
      check(() => assert.equal(s.messages.at(-1)!.content, original));
      check(() => assert.equal(wecomAdapter.prepare?.(s.id, original, { kind: 'human', message }), null));
      check(() => assert.equal(sandboxWechatIndex.forUser('wmA'), A));
      assert.equal(await api.push(s.id, original, { kind: 'human', message }), true);
      await flushSession(s.id);
      check(() => assert.equal(s.messages.at(-1)!.content, original));
    });
    const card = sends.find((s) => s.body.msgtype === 'link')!;
    check(() => assert.equal(card.body.link.url, `${base}/wx/${tokenA}/pay/${order!.id}`));
    if (cardMode === 'card-fail') check(() => assert.ok(sends.at(-1)!.body.text.content.includes(`/wx/${tokenA}/pay/`)));
  }
  // 普通正文和方案书、隐私链接也经过共同边界，外站链接不改。
  sends = [];
  mode = 'ok';
  await withTenantScope(A, () =>
    raw(text('wmA', cfg.openKfid, `${url}\n${base}/proposal/route/2?v=1\n${base}/privacy\nhttps://other.example.invalid/pay/o`)),
  );
  check(() => {
    const body = sends[0]!.body.text.content;
    assert.ok(body.includes(`/wx/${tokenA}/proposal/route/2?v=1`));
    assert.ok(body.includes(`/wx/${tokenA}/privacy`));
    assert.ok(body.includes('https://other.example.invalid/pay/o'));
  });
  sends = [];
  mode = 'ok';
  const manyLinks = `${'文'.repeat(590)}\n${url}\n${base}/privacy\n${base}/proposal/route/2?v=1`;
  await withTenantScope(A, () => api.push('wecom:wmA', manyLinks));
  check(() => {
    assert.ok(sends.length >= 2);
    assert.ok(sends.every((s) => Buffer.byteLength(s.body.text.content, 'utf8') <= 2048));
  });
  const normalized = new SandboxWecomRuntime({ ...cfg, host: 'SANDBOX.EXAMPLE.INVALID.' }, request);
  await withTenantScope(A, () => normalized.callApi('kf/send_msg', text('wmA', cfg.openKfid, `${base}/privacy`)));
  check(() => assert.ok(sends.at(-1)!.body.text.content.includes(`/wx/${tokenA}/privacy`)));
  normalized.stop();
  // 第一段已发后改绑，剩下两段全拒；一条被限流后的重试也重新核。
  for (const testMode of ['ok', 'busy']) {
    sends = [];
    mode = testMode;
    duringSend = () => sandboxWechatIndex.publishBinding(A, 'wmNew');
    await withTenantScope(A, async () => {
      assert.equal(await api.push('wecom:wmA', '一'.repeat(1700)), false);
      check(() => assert.equal(sends.length, 1));
      check(() => assert.equal(__ledgerTest.rows('wecom:wmA').at(-1)!.status, 'rejected'));
    });
    sandboxWechatIndex.publishBinding(A, 'wmA');
  }
  // 核对与实际 fetch 不存在异步空窗：安排下一 microtask 改绑仍先发出本次请求。
  sends = [];
  queueMicrotask(() => sandboxWechatIndex.publishBinding(A, 'wmNew'));
  const immediate = withTenantScope(A, () => api.requestMessage('fake-access', 'kf/send_msg', text()));
  check(() => assert.equal(sends.length, 1));
  await immediate;
  sandboxWechatIndex.publishBinding(A, 'wmA');
  // 发送回执按 msgid 找回租户，不能借当前绑定或调用方作用域找。
  const receiptId = sends[0]!.body.msgid;
  assert.equal(receiptId, undefined); // 直接边界测试不创建账本；下面经真实 push 记账。
  sends = [];
  await withTenantScope(A, () => api.push('wecom:wmA', '回执测试'));
  const sentId = sends[0]!.body.msgid;
  check(() => assert.equal(sandboxWechatIndex.forReceipt(sentId), A));
  let page = true;
  const inbox = new SandboxWecom(
    {
      SANDBOX_HOST: cfg.host,
      SANDBOX_WECOM_CORP_ID: cfg.corpId,
      SANDBOX_WECOM_SECRET: cfg.secret,
      SANDBOX_WECOM_TOKEN: 'fake-callback',
      SANDBOX_WECOM_AES_KEY: 'fake-aes',
      SANDBOX_WECOM_OPEN_KFID: cfg.openKfid,
    },
    {
      read: async () => ({ cursor: 'fake-cursor', fullSince: null }),
      commit: async () => {},
      request: async (input) =>
        String(input).includes('gettoken')
          ? Response.json({ access_token: 'fake-token' })
          : Response.json({
              errcode: 0,
              next_cursor: 'fake-next',
              has_more: 0,
              msg_list: page
                ? ((page = false), [eventMessage('fake-receipt', 'wmA', { event_type: 'msg_send_fail', fail_msgid: sentId, fail_type: 4 })])
                : [],
            }),
    },
  );
  await inbox.sync();
  await withTenantScope(A, () => drainStore(5000));
  await inbox.close();
  check(() =>
    assert.equal(
      withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').find((r) => r.msgid === sentId)?.status),
      'failed',
      '事件回执按 event.open_kfid 路由并将账本置为 failed',
    ),
  );
  // 提交游标的等待也计入 welcome_code 的 20 秒；超时后不会因为派发才开始而延长。
  let lateNow = Date.now(),
    lateSends = 0;
  const lateInbox = new SandboxWecom(
    {
      SANDBOX_HOST: cfg.host,
      SANDBOX_WECOM_CORP_ID: cfg.corpId,
      SANDBOX_WECOM_SECRET: cfg.secret,
      SANDBOX_WECOM_TOKEN: 'fake-callback',
      SANDBOX_WECOM_AES_KEY: 'fake-aes',
      SANDBOX_WECOM_OPEN_KFID: cfg.openKfid,
    },
    {
      now: () => lateNow,
      read: async () => ({ cursor: 'fake-cursor', fullSince: null }),
      commit: async () => {
        lateNow += 20_001;
      },
      request: async (input) => {
        const url = String(input);
        if (url.includes('gettoken')) return Response.json({ access_token: 'fake-token' });
        if (!url.includes('sync_msg')) {
          lateSends++;
          return Response.json({ errcode: 0 });
        }
        return Response.json({
          errcode: 0,
          next_cursor: 'fake-late',
          has_more: 0,
          msg_list: [
            {
              ...eventMessage('fake-late-event', 'wmLate', { event_type: 'enter_session', welcome_code: 'fake-late-code' }),
              send_time: lateNow / 1000,
            },
          ],
        });
      },
    },
  );
  await lateInbox.sync();
  await lateInbox.drain();
  await lateInbox.close();
  check(() => assert.equal(lateSends, 0));
  // 受限链接 cookie 从真实路由走支付；两个 cookie 同时存在时登录 cookie 赢。
  const service = {
    health: () => new SandboxProcess({}).health(),
    resolve: (token: string | undefined) => resolveSandboxSession(db, token),
    provision: create,
    end: async () => {},
  };
  const http = sandboxApp(service, cfg.host, routes);
  const req = (p: string, cookie?: string, method = 'GET', extra: Record<string, string> = {}) =>
    http.request(base + p, { method, headers: { host: cfg.host, ...(cookie ? { cookie } : {}), ...extra } });
  const jump = await req(`/wx/${tokenA}/pay/${order!.id}`);
  check(() => {
    assert.equal(jump.status, 302);
    assert.equal(jump.headers.get('location'), `/pay/${order!.id}`);
    assert.equal(jump.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(jump.headers.get('cache-control'), 'no-store');
    assert.match(jump.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax; Max-Age=\d+/);
  });
  const cookie = `__Host-sbxw=${tokenA}`;
  for (const p of [
    `/pay/${order!.id}`,
    `/api/orders/${order!.id}`,
    '/privacy',
    `/proposal/${order!.routeId}/2`,
    `/api/proposal/${order!.routeId}`,
  ]) {
    const response = await req(p, cookie);
    check(() => assert.equal(response.status, 200));
  }
  for (const p of ['/console/', '/chat.html']) {
    const r = await req(p, cookie);
    check(() => {
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/try');
    });
  }
  for (const p of ['/api/console/me', '/api/chat', '/api/sandbox/end']) {
    const r = await req(p, cookie, p === '/api/console/me' ? 'GET' : 'POST', { origin: base });
    check(() => assert.equal(r.status, 401));
  }
  const csrf = await req(`/api/orders/${order!.id}/pay`, cookie, 'POST', {
    origin: 'https://other.example.invalid',
    'sec-fetch-site': 'cross-site',
  });
  check(() => assert.equal(csrf.status, 403));
  installSandboxWecomOutbound(api);
  const paid = await req(`/api/orders/${order!.id}/pay`, cookie, 'POST', { origin: base });
  check(() => assert.equal(paid.status, 200));
  const priority = await req(`/api/orders/${order!.id}`, `__Host-sbx=${b.token}; ${cookie}`);
  check(() => assert.equal(priority.status, 200));
  const invalidPriority = await req(`/pay/${order!.id}`, `__Host-sbx=bad; ${cookie}`);
  check(() => assert.equal(invalidPriority.status, 302));
  for (const p of [
    `/wx/${tokenA}/console/`,
    `/wx/${tokenA}/api/orders/o/pay`,
    `/wx/${tokenA}/privacy/extra`,
    `/wx/${tokenA}/pay/a%2fb`,
    `/wx/${randomBytes(32).toString('base64url')}/privacy`,
  ]) {
    const r = await req(p);
    check(() => assert.equal(r.status, 404));
  }
  await review('wx-refusal-headers', async () => {
    const wrongHost = await req(`/wx/${tokenA}/privacy`, undefined, 'GET', { host: 'wrong.example.invalid' });
    assert.equal(wrongHost.status, 404);
    for (const response of [wrongHost, await req(`/wx/${tokenA}/console/`)]) {
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
  // 两种 profile 的真实异常请求日志、结构化输出和纯文本都不能泄露路径令牌。
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const tokenResolver = sandboxWechatIndex.forToken;
    for (const name of ['demo', 'prod']) {
      __profileTest.use({ DEPLOY_PROFILE: name, ADMIN_PASS: 'fake-admin' });
      sandboxWechatIndex.forToken = () => {
        throw new Error(`/wx/${tokenA}/privacy`);
      };
      try {
        const r = await http.request(base + `/wx/${tokenA}/privacy`, { headers: { host: cfg.host } });
        check(() => assert.equal(r.status, 503));
      } finally {
        sandboxWechatIndex.forToken = tokenResolver;
      }
      check(() => {
        assert.ok(!errors.join('\n').includes(tokenA));
        assert.ok(errors.join('\n').includes('/wx/[已遮盖]'));
        assert.ok(!__logTest.scrubLine(JSON.stringify({ path: `/wx/${tokenA}/privacy`, nested: { link_token: tokenA } })).includes(tokenA));
        assert.ok(!convLabelsIn(`/wx/${tokenA}/privacy`).includes(tokenA));
      });
    }
  } finally {
    console.error = originalError;
    __profileTest.reset();
  }
  const health = await service.health();
  check(() => assert.ok(!JSON.stringify(health).includes(tokenA)));
  await withTenantScope(A, () => drainStore(5000));
  const audit = await q('select * from audit_log where tenant_id=$1', [A.id]);
  check(() => assert.ok(!JSON.stringify(audit).includes(tokenA)));
  await __alertTest.settle();
  check(() => {
    assert.equal(__alertTest.isActive('sandbox_send_refused'), true);
    assert.ok(otherRequests.length > 0);
    assert.ok(otherRequests.every((r) => r.url === process.env.ALERT_WEBHOOK_URL));
    assert.ok(!JSON.stringify(otherRequests).includes(tokenA));
  });
  const rows = await q<{ account_id: unknown; status: string }>('select account_id,status from outbound_sends where tenant_id=$1', [A.id]);
  check(() => {
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.account_id === null));
    assert.ok(rows.every((r) => !['pending', 'sending'].includes(r.status)));
  });
  // 停机的未决段落为 unknown，无 pending、无恢复补发。
  mode = 'hang';
  sends = [];
  const pending = withTenantScope(A, () => api.push('wecom:wmA', '停机测试'));
  while (!sends.length) await new Promise((r) => setTimeout(r, 1));
  api.stop();
  check(() =>
    assert.equal(
      withTenantScope(A, () => __ledgerTest.rows('wecom:wmA').at(-1)!.status),
      'unknown',
    ),
  );
  await pending;
  // 重启重新从同一行读令牌，旧消息里的链接仍然可用；结束后立即失效。
  await withTenantScope(A, () => drainStore(5000));
  const shutdownRow = await q<{ status: string }>('select status from outbound_sends where tenant_id=$1 and channel_msgid=$2', [
    A.id,
    sends[0]!.body.msgid,
  ]);
  check(() => assert.equal(shutdownRow[0]?.status, 'unknown'));
  A.state = 'closed';
  A.store.pgBackend!.close();
  await withTenantScope(A, closeConfig);
  dropShutdownHooks(A);
  dropTenantState(A.id);
  unregisterRuntime(A.id);
  A = (await loadSandboxRuntime(deps, { id: a.tenantId, slug: a.slug, expiresAt: a.expiresAt }, cfg.host, async () => fakeLock()))!;
  check(() => assert.equal(sandboxWechatIndex.forToken(tokenA), A));
  const reopened = await req(`/wx/${tokenA}/privacy`);
  check(() => assert.equal(reopened.status, 302));
  A.state = 'closing';
  sandboxWechatIndex.publishBinding(A, 'wmB');
  check(() => assert.equal(sandboxWechatIndex.forUser('wmB'), B));
  check(() => assert.equal(sandboxWechatIndex.forToken(tokenA), undefined));
  const ended = await req(`/wx/${tokenA}/privacy`);
  check(() => {
    assert.equal(ended.status, 404);
    assert.match(ended.headers.get('set-cookie')!, /__Host-sbxw=;.*Max-Age=0/);
  });
  await review('link-cookie-ignored-for-provision', async () => {
    await q('update tenants set expires_at=now() where id=$1', [A.id]);
    const opened = await req('/api/sandbox', cookie, 'POST', {
      origin: base,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(opened.status, 201);
    assert.match(opened.headers.get('set-cookie')!, /__Host-sbx=[A-Za-z0-9_-]{43}/);
    assert.ok(!opened.headers.get('set-cookie')!.includes(a.token));
  });
  check(() => assert.equal(sandboxWechatIndex.forToken(tokenB), B));
  sandboxWechatIndex.drop(A.id);
  check(() => assert.equal(sandboxWechatIndex.keyCount(A.id), 0));
  A.state = 'serving';
  assert.ok(tokenCalls >= 4);
}

try {
  const lite = await openTestDb();
  try {
    await lite.pg.exec('SET ROLE agent_app');
    const q: Query = (sql, params = []) =>
      lite.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query(sql, params)).rows as never;
      });
    await suite(lite.db, q);
  } finally {
    await cleanup();
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const pg = await openOutboundTestPg(process.env.PG_TEST_URL);
    try {
      await suite(pg.db, pg.query);
    } finally {
      await cleanup();
      await pg.close();
    }
  } else console.log('SKIP: 真实 PG 需要 PG_TEST_URL');
  await review('wx-stopped-response-headers', async () => {
    const code = `import assert from 'node:assert/strict'; import {sandboxApp} from './src/tenancy/sandbox/process.ts'; import {stopSandboxProcess} from './src/tenancy/sandbox/lifecycle.ts'; const noop=async()=>{throw new Error('unexpected');}; const app=sandboxApp({health:noop,resolve:noop,provision:noop,end:noop},'sandbox.example.invalid'); stopSandboxProcess(); const res=await app.request('https://sandbox.example.invalid/wx/fake/privacy',{headers:{host:'sandbox.example.invalid'}}); assert.equal(res.status,503); assert.equal(res.headers.get('referrer-policy'),'no-referrer'); assert.equal(res.headers.get('cache-control'),'no-store');`;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      timeout: 20_000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
  // 新进程安装生产 console 接线，覆盖两种 profile 与两种日志格式。
  for (const profile of ['demo', 'prod'])
    for (const format of ['', 'json']) {
      const token = randomBytes(32).toString('base64url');
      const code = `import { installJsonConsole, log } from './src/log.ts'; installJsonConsole(); console.log(new Error('/wx/${token}/privacy')); log.info('链接', {path:'/wx/${token}/pay/o', nested:{link_token:'${token}'}}); console.error('Cookie: __Host-sbxw=${token}'); console.log({nested:{link_token:'${token}'}});`;
      const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, DEPLOY_PROFILE: profile, LOG_FORMAT: format },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      check(() => {
        assert.ok(!output.includes(token));
        assert.ok(output.includes('/wx/[已遮盖]'));
      });
    }
  console.log(`SELFTEST PASS: 沙箱发送与微信链接 ${checks} 项`);
} finally {
  await __alertTest.settle();
  globalThis.fetch = originalFetch;
  if (previousAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = previousAlertUrl;
  console.warn = originalWarn;
  await cleanup();
  fs.rmSync(temp, { recursive: true, force: true });
}
