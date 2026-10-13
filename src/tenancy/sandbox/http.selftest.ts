// R10 与验收 4/5/11：真实路由、数据库 cookie 解析、租户隔离与工作台闭环。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomFillSync, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAudit } from '../../db/repo/audit.js';
import { readSandboxSteps } from '../../db/repo/sandbox-steps.js';
import { openDb, withTenant, type Db } from '../../db/client.js';
import { createRealPgFixture, fakeLock, openTestDb, testConfigDeps, purgeTestSandbox } from '../../db/testing.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig, initConfig, currentSop, currentCatalog, currentTenant } from '../../config/source.js';
import { expireBrokenSandbox } from '../../db/sandbox-process.js';
import { sandboxSessionResolve } from '../../db/repo/sandbox.js';
import { csrfFor, __authTest } from '../../auth/session.js';
import { subscribe } from '../../adapters/simulator.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { listSessions, listOrders, getOrCreateSession, flushSession, createOrder, getSession, saveSession } from '../../store.js';
import { scrubConvIds } from '../../log.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import type { Me, CatalogItem, SopOverview, ConversationPage } from '../../shared/console-api.js';
import {
  configureTenancy,
  createTenantRuntime,
  registerRuntime,
  runtimeOf,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { sandboxWechatIndex } from './outbound.js';
import { sandboxOwnedFirst, byRecent, waitingFirst, conversationRow, sandboxOwnConversationId } from '../../console-api/workbench.js';
import { SandboxProcess, sandboxApp } from './process.js';
import { provisionSandbox } from './provision.js';
import { __sandboxLimitsTest } from './limits.js';
import { resolveSandboxSession, sandboxCookie } from './session.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-http-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app: routes } = await import('../../server.js');
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}

async function cleanup(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
}

async function suite(db: Db, q: Query, real: boolean): Promise<void> {
  __authTest.reset();
  __sandboxLimitsTest.resetProvisioned();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>("select id from tenants where slug='template'");
  const host = createTenantRuntime({ id: template!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  await q('update tenants set brand=$2::json where id=$1', [host.id, JSON.stringify(shanhaiBrand)]);
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: 'template', dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  check(() => assert.equal(imported.code, 0, imported.message));
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'体验隐私说明')", [host.id]);
  const templateSnapshot = async () => ({
    catalog: await q('select to_jsonb(c) as row from catalog_items c where tenant_id=$1 order by id', [host.id]),
    sop: await q('select to_jsonb(s) as row from sop_versions s where tenant_id=$1 order by id', [host.id]),
  });
  const originalTemplate = await templateSnapshot();
  let resolutions = 0;
  const service = {
    health: () => new SandboxProcess({}).health(),
    resolve: (token: string | undefined) => {
      resolutions++;
      return resolveSandboxSession(db, token);
    },
    provision: (input: { ip: string | null; userAgent: string | null }) =>
      provisionSandbox({
        ...input,
        deps,
        templateSlug: 'template',
        host: 'sandbox.example.invalid',
        epoch: '0',
        acquireTenant: async () => fakeLock(),
      }),
    end: (tenantId: string) => expireBrokenSandbox(db, tenantId),
  };
  const app = sandboxApp(service, 'sandbox.example.invalid', routes);
  const request = (url: string, token?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', 'SANDBOX.example.invalid.:443');
    if (token) headers.set('cookie', `__Host-sbx=${token}`);
    if (init.body) headers.set('content-length', String(Buffer.byteLength(String(init.body))));
    return app.request(url, { ...init, headers });
  };
  const post = (url: string, token?: string, body: unknown = {}, extra: Record<string, string> = {}) =>
    request(url, token, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        ...(token ? { 'x-csrf': csrfFor(token) } : {}),
        ...extra,
      },
    });
  const expect = async (r: Response, status: number, error?: string) => {
    check(() => assert.equal(r.status, status));
    if (error) {
      const body = (await r.json()) as { error: string };
      check(() => assert.equal(body.error, error));
    }
  };
  const localResources = (html: string, url: string) => {
    for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const attr = new RegExp(`\\b${tag[1]!.toLowerCase() === 'script' ? 'src' : 'href'}=["']([^"']*)["']`, 'i').exec(tag[0]);
      if (!attr) continue;
      const resource = attr[1]!;
      check(() =>
        assert.ok(
          resource.startsWith('data:') || new URL(resource, 'https://sandbox.example.invalid').origin === 'https://sandbox.example.invalid',
          `${url}：沙箱 script/link 只使用同源资源`,
        ),
      );
    }
    check(() =>
      assert.doesNotMatch(html, /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?(?:https?:)?\/\//i, `${url}：沙箱页面没有外部 CSS import/url`),
    );
  };
  const page = async (url: string, token: string, status = 200): Promise<string> => {
    const response = await request(url, token);
    await expect(response, status);
    const html = await response.text();
    localResources(html, url);
    const csp = response.headers.get('content-security-policy')!;
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (match) => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`,
    );
    check(() => assert.deepEqual(/(?:^|; )script-src ([^;]*)/.exec(csp)![1]!.split(' '), ["'self'", ...hashes]));
    check(() => assert.equal((html.match(/<script src="\/sandbox-ui\.js"><\/script>/g) ?? []).length, 1));
    return html;
  };
  // 走真实 HTTP 与访客 cookie；持续读流，避免未读缓冲把串台藏起来。
  const openStream = async (url: string, visitorToken: string) => {
    const abort = new AbortController();
    const response = await request(url, visitorToken, { signal: abort.signal });
    await expect(response, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value, { stream: true });
    const pumping = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    })();
    return {
      text: () => received,
      async until(predicate: (text: string) => boolean, name: string, deadline = Date.now() + 1000) {
        while (!predicate(received) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        check(() => assert.ok(predicate(received) && Date.now() <= deadline, name));
      },
      async close() {
        abort.abort();
        await reader.cancel();
        await pumping;
      },
    };
  };
  // 无 cookie、跨 cookie、未知 Host、禁止的宿主入口。
  await expect(await request('/try'), 200);
  check(() => assert.equal(tenantRuntimes().length, 0, 'GET /try 不开通'));
  for (const url of ['/console/', '/chat.html', '/pay/test', '/proposal/test', '/privacy', '/']) {
    const r = await request(url);
    check(() => assert.equal(r.status, 302));
    check(() => assert.equal(r.headers.get('location'), '/try'));
    check(() => assert.match(r.headers.get('set-cookie')!, /__Host-sbx=;.*Max-Age=0/));
  }
  await expect(await request('/api/console/me'), 401, 'sandbox_required');
  await expect(
    await request('/api/console/me', undefined, { headers: { cookie: `__Host-sid=${randomBytes(32).toString('base64url')}` } }),
    401,
    'sandbox_required',
  );
  await expect(
    await request('/api/console/me', undefined, { headers: { cookie: `__Host-sbxw=${randomBytes(32).toString('base64url')}` } }),
    401,
    'sandbox_required',
  );
  await expect(
    await request('/api/console/me', undefined, {
      headers: { host: 'other.example.invalid', 'x-forwarded-host': 'sandbox.example.invalid' },
    }),
    404,
  );
  await expect(await request('/healthz', undefined, { headers: { host: 'other.example.invalid' } }), 200);
  for (const url of ['/api/console/auth/login', '/api/console/auth/logout']) await expect(await post(url), 404);
  await expect(
    await post('/api/sandbox', undefined, {}, { 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' }),
    403,
    'cross_site',
  );
  await expect(await post('/api/sandbox', undefined, {}, { 'content-type': 'text/plain' }), 415);
  await expect(await request('/share-cover.png'), 200);
  await expect(await request('/console/assets/missing.js'), 404);

  const opened = await post('/api/sandbox');
  await expect(opened, 201);
  const cookie = opened.headers.get('set-cookie')!;
  const token = cookie.match(/^__Host-sbx=([^;]+)/)![1]!;
  check(() => assert.match(token, /^[A-Za-z0-9_-]{43}$/));
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=']) check(() => assert.ok(cookie.includes(flag)));
  const openBody = (await opened.json()) as { url: string; expiresAt: string };
  check(() => assert.equal(openBody.url, '/console/'));
  const resolved = await service.resolve(token);
  assert.equal(resolved.status, 'ok');
  if (resolved.status !== 'ok') throw new Error('session_invalid');
  const a = resolved.runtime;
  check(() => assert.equal(resolved.expiresAt, openBody.expiresAt));
  check(() => assert.equal(Buffer.from(token, 'base64url').length, 32));
  check(() => assert.match(sandboxCookie(token, openBody.expiresAt, Date.parse(openBody.expiresAt) - 7000), /Max-Age=7$/));
  const again = await post('/api/sandbox', token);
  await expect(again, 200);
  check(() => assert.equal(again.headers.get('set-cookie'), null));
  check(() => assert.equal(tenantRuntimes().length, 1));
  const againBody = await again.json();
  check(() => assert.deepEqual(againBody, openBody));
  const root = await request('/', token);
  check(() => assert.equal(root.headers.get('location'), '/console/'));
  const me = (await (await request('/api/console/me', token)).json()) as Me;
  check(() => assert.equal(me.role, 'owner'));
  check(() => assert.equal(me.displayName, '体验访客'));
  check(() => assert.equal(me.csrf, csrfFor(token)));
  check(() => assert.equal(me.tenantSlug, a.slug));
  check(() =>
    assert.deepEqual(me.sandbox, {
      ownConversationId: null,
      expiresAt: openBody.expiresAt,
      wechat: 'off',
      steps: [false, false, false, false],
    }),
  );
  withTenantScope(a, () => {
    check(() => assert.equal(listSessions().length, 5));
    check(() => assert.equal(listOrders().length, 2));
  });
  // 与宿主相同的 IP 桶：有效会话退回名额；无效 cookie 并发也最多查 60 次。
  const goodIp = { 'x-forwarded-for': '198.51.100.151' };
  for (let i = 0; i < 70; i++) await expect(await request('/api/console/me', token, { headers: goodIp }), 200);
  const randomToken = randomBytes(32).toString('base64url');
  const invalidIp = { 'x-forwarded-for': '198.51.100.152' };
  const beforeBurst = resolutions;
  const burst = await Promise.all(Array.from({ length: 70 }, () => request('/api/console/me', randomToken, { headers: invalidIp })));
  check(() => assert.equal(resolutions - beforeBurst, 60, '并发请求在查库前占名额'));
  for (const response of burst) await expect(response, 401, 'sandbox_required');
  await expect(await request('/api/console/me', randomToken, { headers: invalidIp }), 401, 'sandbox_required');
  check(() => assert.equal(resolutions - beforeBurst, 60, '第 61 次起不查库'));
  await expect(await request('/api/console/me', randomToken, { headers: goodIp }), 401, 'sandbox_required');
  check(() => assert.equal(resolutions - beforeBurst, 61, 'IP 桶相互独立且有效会话不耗额度'));
  // 数据库认得会话，进程却没装载租户：暂不可用，保留 cookie，也不能再开通一个。
  unregisterRuntime(a.id);
  try {
    for (let i = 0; i < 70; i++) {
      const unavailable = await request(i === 0 ? '/api/sandbox' : '/console/', token, {
        method: i === 0 ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...goodIp },
      });
      await expect(unavailable, 503, 'sandbox_unavailable');
      check(() => assert.equal(unavailable.headers.get('set-cookie'), null));
    }
    check(() => assert.equal(tenantRuntimes().length, 0, '暂不可用时不另开沙箱'));
  } finally {
    registerRuntime(a);
  }
  await expect(await request('/api/console/me', token, { headers: goodIp }), 200);
  const progress = async (cookieToken = token): Promise<boolean[]> => {
    const r = await request('/api/console/me', cookieToken);
    await expect(r, 200);
    return ((await r.json()) as Me).sandbox!.steps;
  };
  const status = (await (await request('/api/console/status', token)).json()) as { channels: unknown[]; tenantSlug: string };
  check(() => assert.deepEqual(status.channels, []));
  check(() => assert.equal(status.tenantSlug, a.slug));
  await expect(
    await post('/api/console/quick-replies', token, {}, { 'x-csrf': csrfFor(randomBytes(32).toString('base64url')) }),
    403,
    'csrf',
  );
  // 包含 PUT/DELETE/PATCH，所有非安全方法在解析/读 body/改状态之前拒绝。
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const url of ['/api/chat', '/api/orders/test/pay', '/api/sandbox/end', '/api/console/sop/draft']) {
      await expect(
        await request(url, token, { method, headers: { 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' }, body: 'x' }),
        403,
        'cross_site',
      );
    }
  }
  for (const url of [
    '/admin.html',
    '/kf-qr.png',
    '/api/admin/whoami',
    '/api/sessions',
    '/api/orders',
    '/api/usage',
    '/api/insights',
    '/w/test',
    '/wecom/callback',
    '/wecom/callback/test',
    '/guide.html',
  ])
    await expect(await request(url, token), 404);

  // B 的会话/公开页面与 A 隔离；没有 cookie 时资源 id 也不是凭据。
  const bResult = await service.provision({ ip: null, userAgent: null });
  const b = runtimeOf(bResult.tenantId)!;
  const bId = withTenantScope(b, () => listSessions()[0]!.id);
  for (const url of [`/api/sessions/${bId}`, `/api/stream/${bId}`, `/api/console/conversations/${bId}`])
    await expect(await request(url, token), 404);
  await expect(await post('/api/chat', token, { sessionId: bId, text: '你好' }), 404);
  const wecomId = 'wecom:wmSbxTest';
  await expect(await post('/api/chat', token, { sessionId: wecomId, text: '你好' }), 400);
  for (const url of [`/api/sessions/${wecomId}`, `/api/stream/${wecomId}`]) await expect(await request(url, token), 404);
  await expect(await request(`/api/sessions/${bId}`), 401, 'sandbox_required');
  const simId = `sim-${randomBytes(12).toString('hex')}`;
  const sbxId = `sbx-${simId.slice(4)}`;
  const consoleStream = await openStream('/api/console/events', token);
  try {
    const send = await post('/api/chat', token, { sessionId: simId, text: '你好' });
    await expect(send, 200);
    const sent = (await send.json()) as { sessionId: string };
    check(() => assert.equal(sent.sessionId, sbxId));
    await withTenantScope(a, () => flushSession(sbxId, { timeoutMs: 5000 }));
    await consoleStream.until(
      (text) => text.split('\n\n').some((frame) => frame.includes('event: conversation\n') && frame.includes(`"id":"${sbxId}"`)),
      '模拟器新会话提交后在 console HTTP 事件流出现对应会话事件',
    );
  } finally {
    await consoleStream.close();
  }
  const history = await request(`/api/sessions/${simId}`, token);
  await expect(history, 200);
  const restored = (await history.json()) as { id: string; messages: unknown[] };
  check(() => assert.equal(restored.id, sbxId));
  check(() => assert.ok(restored.messages.length >= 2));
  await expect(await request(`/api/console/conversations/${sbxId}`, token), 200);
  await expect(await request(`/api/sessions/${sbxId}`, bResult.token), 404);
  // 第一个自己的模拟器会话出现，不能把更晚更新的种子当作自己的会话。
  const ownId = async () => ((await (await request('/api/console/me', token)).json()) as Me).sandbox!.ownConversationId;
  const firstOwn = await ownId();
  check(() => assert.equal(firstOwn, sbxId));
  const newerId = `sbx-${randomBytes(12).toString('hex')}`;
  withTenantScope(a, () => {
    const newer = getOrCreateSession(newerId, 'simulator');
    newer.createdAt = a.expiresAt! - 86_400_000 + 1;
    newer.updatedAt = Date.now() + 1000;
    for (const seed of listSessions().filter((s) => s.createdAt < a.expiresAt! - 86_400_000)) seed.updatedAt = Date.now() + 10_000;
  });
  const newestOwn = await ownId();
  check(() => assert.equal(newestOwn, newerId));
  for (const order of ['', '&order=waiting_first']) {
    const rows = (await (await request('/api/console/conversations?limit=2' + order, token)).json()) as ConversationPage;
    check(() =>
      assert.deepEqual(
        rows.items.map((s) => s.id),
        [newerId, sbxId],
        '分页之前置顶自己的会话，超过更新时间更晚的种子',
      ),
    );
    check(() => assert.ok(rows.items.every((s) => s.sandboxOwner === 'simulator')));
  }
  sandboxWechatIndex.publishBinding(a, 'wmOwn');
  // 只有绑定、还没有会话时继续指向模拟器。
  const beforeWechat = await ownId();
  check(() => assert.equal(beforeWechat, newerId));
  withTenantScope(a, () => {
    const own = getOrCreateSession('wecom:wmOwn', 'wecom');
    own.createdAt = a.expiresAt! - 86_400_000 + 1;
    own.updatedAt = Date.now() - 2000;
    getOrCreateSession('wecom:wmOld', 'wecom');
  });
  const boundOwn = await ownId();
  check(() => assert.equal(boundOwn, 'wecom:wmOwn', '绑定会话优先于最近模拟器'));
  const boundRows = (await (await request('/api/console/conversations?order=waiting_first', token)).json()) as ConversationPage;
  check(() =>
    assert.deepEqual(
      boundRows.items.slice(0, 3).map((s) => s.sandboxOwner),
      ['simulator', 'simulator', 'wechat'],
    ),
  );
  check(() =>
    assert.ok(
      boundRows.items.slice(3).every((s) => !s.sandboxOwner),
      '种子与非当前绑定微信均不标记',
    ),
  );
  sandboxWechatIndex.withdraw(a.id);
  const unboundOwn = await ownId();
  check(() => assert.equal(unboundOwn, newerId, '解绑后回退最近模拟器'));
  // 宿主比较器和投影保持原样，即使有同名 sbx/wecom 会话也不视为沙箱访客。
  const sandboxPack = withTenantScope(a, () => currentTenant().pack);
  withTenantScope(host, () => {
    const samples = withTenantScope(a, listSessions);
    const pack = sandboxPack;
    for (const compare of [byRecent, waitingFirst(pack)])
      check(() =>
        assert.deepEqual(
          [...samples].sort(sandboxOwnedFirst(compare)).map((s) => s.id),
          [...samples].sort(compare).map((s) => s.id),
        ),
      );
    check(() =>
      assert.ok(
        samples.every((s) => !('sandboxOwner' in conversationRow({ ...s, orderIds: [] }, { destinations: [], segments: {} }, false))),
      ),
    );
    check(() => assert.equal(sandboxOwnConversationId(), null));
  });
  const html = await page(`/chat.html?c=${sbxId}`, token);
  check(() => assert.ok(html.includes(`ssj_session_id:${a.slug}`)));
  check(() => assert.ok(html.includes("new URLSearchParams(location.search).get('c')")));
  check(() => assert.ok(html.includes('(?:sim|sbx)-')));
  // 租户品牌与会话键会改变脚本，不能用 public 源文件的固定 hash。
  const originalScript = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync('public/chat.html', 'utf8'))![1]!;
  check(() => assert.notEqual(/<script>([\s\S]*?)<\/script>/.exec(html)![1], originalScript));
  for (const url of ['/pay.html', '/proposal.html', '/proposal/r-xian/2']) await page(url, token);
  for (const query of ['', '?start=1', '?ended=1']) {
    const existing = await request('/try' + query, token);
    await expect(existing, 302);
    check(() => assert.equal(existing.headers.get('location'), '/console/'));
  }
  await page('/proposal/r-xian/2?v=999', token, 404);
  // 执行真实页面的启动代码和按钮回调：?c 优先；新会话删 c、保留其余 URL，再启动产生新 id。
  const key = /LS_KEY = '([^']+)'/.exec(html)![1]!;
  const storage = new Map([[key, simId]]);
  const location = {
    href: `https://sandbox.example.invalid/chat.html?c=${sbxId}&from=console#messages`,
    search: '',
    reloads: 0,
    reload() {
      this.reloads++;
    },
  };
  location.search = new URL(location.href).search;
  let click = () => {};
  const startup = /  const STRONG_ID_RE[\s\S]*?(?=  let lastTs)/.exec(html)![0];
  const button = /  document.getElementById\('newBtn'\)[\s\S]*?\n  \}\);/.exec(html)![0];
  const boot = () => {
    const context = vm.createContext({
      URL,
      URLSearchParams,
      location,
      crypto: { getRandomValues: randomFillSync },
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: URL) => {
          location.href = String(url);
          location.search = new URL(location.href).search;
        },
      },
      document: {
        getElementById: () => ({
          addEventListener: (_event: string, handler: () => void) => {
            click = handler;
          },
        }),
      },
    });
    vm.runInContext(`const LS_KEY = ${JSON.stringify(key)};\n${startup}\n${button}`, context);
    return vm.runInContext('sessionId', context) as string;
  };
  check(() => assert.equal(boot(), sbxId));
  click();
  check(() => assert.equal(storage.has(key), false));
  check(() => assert.equal(location.href, 'https://sandbox.example.invalid/chat.html?from=console#messages'));
  check(() => assert.equal(location.reloads, 1));
  const newId = boot();
  check(() => assert.match(newId, /^sim-[0-9a-f]{24}$/));
  check(() => assert.notEqual(newId, simId));
  const newChat = await post('/api/chat', token, { sessionId: newId, text: '你好' });
  await expect(newChat, 200);
  const newChatBody = (await newChat.json()) as { sessionId: string };
  check(() => assert.equal(newChatBody.sessionId, `sbx-${newId.slice(4)}`));
  await withTenantScope(a, () => flushSession(`sbx-${newId.slice(4)}`, { timeoutMs: 5000 }));

  const awaitedChatSteps = await progress();
  check(() => assert.deepEqual(awaitedChatSteps, [true, false, false, false]));
  // 接手、回复、交还、模拟器继续、标已付与 reset 的耐久后端回归。
  const pushes: string[] = [];
  const off = withTenantScope(a, () => subscribe(sbxId, (text) => pushes.push(text)));
  const abort = new AbortController();
  const streamResponse = await request(`/api/stream/${simId}`, token, { signal: abort.signal });
  await expect(streamResponse, 200);
  const reader = streamResponse.body!.getReader();
  await reader.read(); // 首个 ping：已经订阅。
  try {
    await expect(await post(`/api/console/conversations/${sbxId}/takeover`, token), 200);
    const afterTakeover = await progress();
    check(() => assert.equal(afterTakeover[2], false, '接手但未回复不算完成'));
    await expect(await post(`/api/console/conversations/${sbxId}/reply`, token, { text: '体验访客回复', clientId: randomUUID() }), 200);
    check(() => assert.ok(pushes.some((s) => s.includes('【顾问】体验访客回复'))));
    const afterReply = await progress();
    check(() => assert.equal(afterReply[2], true, '人工接管后的回复算完成'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pushed = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('模拟器 SSE 超过 1 秒')), 1000);
        }),
      ]);
      check(() => assert.ok(new TextDecoder().decode(pushed.value).includes('体验访客回复')));
    } finally {
      clearTimeout(timer);
    }
    await expect(await post(`/api/console/conversations/${sbxId}/release`, token), 200);
    const messageCount = withTenantScope(a, () => getSession(sbxId)!.messages.length);
    await expect(await post('/api/chat', token, { sessionId: sbxId, text: '想去云南' }), 200);
    check(() =>
      assert.ok(
        withTenantScope(a, () =>
          getSession(sbxId)!
            .messages.slice(messageCount)
            .some((m) => m.role === 'agent' && m.author !== 'human' && m.content.trim() && !m.content.startsWith('【顾问】')),
        ),
        '交还后模拟器客户消息新增非空 AI agent 回复',
      ),
    );
    const order = withTenantScope(a, () => listOrders().find((o) => o.status === 'pending_payment')!);
    assert.ok(order);
    const orderPushes: string[] = [];
    const offOrder = withTenantScope(a, () => subscribe(order.sessionId, (text) => orderPushes.push(text)));
    try {
      await expect(await post(`/api/orders/${order.id}/pay`, token), 200);
      check(() => assert.ok(orderPushes.length));
      const advisorOrder = withTenantScope(a, () =>
        createOrder({
          sessionId: order.sessionId,
          routeId: order.routeId,
          routeTitle: order.routeTitle,
          travelers: order.travelers,
          departDate: order.departDate,
          totalPrice: order.totalPrice,
        }),
      );
      await withTenantScope(a, () => flushSession(order.sessionId, { timeoutMs: 5000 }));
      // 新建一条 HTTP 流，排除前一次模拟支付的确认充当「标已付」的推送。
      const advisorPaymentStream = await openStream(`/api/stream/${order.sessionId}`, token);
      try {
        await expect(await post(`/api/console/orders/${advisorOrder.id}/mark-paid`, token), 200);
        await advisorPaymentStream.until(
          (text) => text.includes('已收到您的支付') && text.includes(advisorOrder.routeTitle),
          '工作台标已付后模拟器 HTTP SSE 收到对应产品付款确认',
        );
        check(() =>
          assert.equal(
            withTenantScope(a, () => listOrders().find((o) => o.id === advisorOrder.id)!.status),
            'paid',
            '付款确认对应订单已付事实',
          ),
        );
      } finally {
        await advisorPaymentStream.close();
      }
    } finally {
      offOrder();
    }
    await expect(await request(`/pay/${order.id}`, token), 200);
    await expect(await request(`/api/orders/${order.id}`), 401, 'sandbox_required');
    for (const url of ['/privacy', '/console/']) {
      const response = await request(url, token);
      await expect(response, 200);
      localResources(await response.text(), url);
    }
    const beforeB = withTenantScope(b, () => JSON.stringify(listSessions()));
    const siblingId = withTenantScope(a, () => listSessions().find((s) => s.id !== sbxId)!.id);
    const beforeSibling = withTenantScope(a, () => JSON.stringify(getSession(siblingId)));
    await expect(await post('/api/chat', token, { sessionId: sbxId, text: '重置' }), 200);
    check(() => {
      const reset = withTenantScope(a, () => getSession(sbxId)!);
      assert.equal(reset.messages.length, 1, '重置目标会话只保留重置回复');
      assert.equal(reset.messages[0]!.role, 'agent', '重置目标会话保留 agent 回复');
      assert.ok(reset.messages[0]!.content.trim(), '重置目标会话回复非空');
      assert.deepEqual(reset.profile, {}, '重置目标会话清空客户画像');
      assert.deepEqual(reset.orderIds, [], '重置目标会话清空订单引用');
      assert.equal(reset.handedOver, false, '重置目标会话解除转人工');
    });
    check(() =>
      assert.equal(
        withTenantScope(a, () => JSON.stringify(getSession(siblingId))),
        beforeSibling,
        '重置不改变同沙箱另一个会话',
      ),
    );
    check(() =>
      assert.equal(
        withTenantScope(b, () => JSON.stringify(listSessions())),
        beforeB,
      ),
    );
  } finally {
    off();
    abort.abort();
    await reader.cancel();
  }

  const seedId = withTenantScope(a, () => listSessions().find((s) => s.createdAt < a.expiresAt! - 86_400_000)!.id);
  const seedStream = await openStream(`/api/stream/${seedId}`, token);
  try {
    await expect(await post(`/api/console/conversations/${seedId}/takeover`, token), 200);
    const seedDeadline = Date.now() + 1000;
    await expect(await post(`/api/console/conversations/${seedId}/reply`, token, { text: '种子闭环回复', clientId: randomUUID() }), 200);
    await seedStream.until(
      (text) => text.split('\n').some((line) => line.startsWith('data: {') && JSON.parse(line.slice(6)).text === '【顾问】种子闭环回复'),
      '种子会话接手回复后模拟器 HTTP SSE 一秒内收到顾问前缀推送',
      seedDeadline,
    );
  } finally {
    await seedStream.close();
  }

  // 改价和发布 SOP 只改 A：模板与 B 的已发布快照不变。
  const listing = (await (await request('/api/console/catalog/route', token)).json()) as { items: CatalogItem[] };
  const item = listing.items.find((row) => row.code === 'r-xian')!;
  assert.ok(item);
  const hostPrice = withTenantScope(b, () => currentCatalog().routes.find((r) => r.id === item.code)!.priceFrom);
  const patch = await request(`/api/console/catalog/route/${item.code}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ rev: item.rev, set: { priceFrom: hostPrice + 100 } }),
    headers: { 'content-type': 'application/json', 'x-csrf': csrfFor(token) },
  });
  await expect(patch, 200);
  const afterPrice = await progress();
  check(() => assert.equal(afterPrice[3], true, '修改价格完成第四步'));
  check(() =>
    assert.equal(
      withTenantScope(a, () => currentCatalog().routes.find((r) => r.id === item.code)!.priceFrom),
      hostPrice + 100,
    ),
  );
  check(() =>
    assert.equal(
      withTenantScope(b, () => currentCatalog().routes.find((r) => r.id === item.code)!.priceFrom),
      hostPrice,
    ),
  );
  const routeId = item.code;
  const freshQuote = await post('/api/chat', token, { text: '西安2人，报价多少钱' });
  await expect(freshQuote, 200);
  const quoteBody = (await freshQuote.json()) as { sessionId: string; reply: { text: string } };
  await withTenantScope(a, () => flushSession(quoteBody.sessionId, { timeoutMs: 5000 }));
  check(() => assert.ok(quoteBody.reply.text.includes(`¥${(hostPrice + 100).toLocaleString('zh-CN')}`), quoteBody.reply.text));
  const proposal = await request(`/api/proposal/${routeId}?v=2`, token);
  await expect(proposal, 200);
  const proposalBody = await proposal.text();
  check(() =>
    assert.ok(proposalBody.includes(String(hostPrice + 100)) || proposalBody.includes((hostPrice + 100).toLocaleString('zh-CN'))),
  );
  // 验收 11：访客写的产品标题通过真实 API 到三类页面，只能成为文本。
  const xss = '<img src=x onerror=alert(1)>';
  // 已上架线路的标题锁定，所以走访客可用的新建草稿、上架流程。
  const xssRouteId = 'r-xss';
  const created = await post('/api/console/catalog/route', token, { payload: { ...item.payload, id: xssRouteId, title: xss } });
  await expect(created, 200);
  const createdItem = (await created.json()) as CatalogItem;
  await expect(await post(`/api/console/catalog/route/${xssRouteId}/activate`, token, { rev: createdItem.rev }), 200);
  const proposalHtml = await page(`/proposal/${xssRouteId}/2?v=1`, token);
  check(() => assert.ok(proposalHtml.includes('&lt;img src=x onerror=alert(1)&gt;')));
  check(() => assert.equal(proposalHtml.includes(xss), false));
  const proposalApp = { innerHTML: '' };
  const proposalContext = vm.createContext({
    document: { getElementById: () => proposalApp, title: '行程方案书' },
    location: { pathname: `/proposal/${xssRouteId}/2`, search: '?v=1' },
    URLSearchParams,
    fetch: (url: string) => request(url, token),
  });
  vm.runInContext(
    /<script>([\s\S]*?)<\/script>/.exec(proposalHtml)![1]!.replace('(async () => {', 'globalThis.loaded = (async () => {'),
    proposalContext,
  );
  await proposalContext.loaded;
  check(() => assert.ok(proposalApp.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;')));
  check(() => assert.equal(proposalApp.innerHTML.includes(xss), false));

  const order = withTenantScope(a, () => {
    const route = currentCatalog().routes.find((r) => r.id === xssRouteId)!;
    const session = getSession(quoteBody.sessionId)!;
    const order = createOrder({
      sessionId: session.id,
      routeId: route.id,
      routeTitle: route.title,
      travelers: 2,
      departDate: '2099-01-01',
      totalPrice: route.priceFrom * 2,
      catalogVersion: 1,
    });
    session.orderIds.push(order.id);
    saveSession(session);
    return order;
  });
  await withTenantScope(a, () => flushSession(order.sessionId, { timeoutMs: 5000 }));
  {
    const payHtml = await page(`/pay/${order.id}`, token);
    check(() => assert.ok(payHtml.includes('&lt;img src=x onerror=alert(1)&gt;')));
    check(() => assert.equal(payHtml.includes(xss), false));
    const orderBody = await (await request(`/api/orders/${order.id}`, token)).json();
    const fields = new Map<
      string,
      { textContent: string; hidden: boolean; style: Record<string, string>; classList: { add: () => void }; addEventListener: () => void }
    >();
    const field = (id: string) => {
      if (!fields.has(id))
        fields.set(id, { textContent: '', hidden: false, style: {}, classList: { add: () => {} }, addEventListener: () => {} });
      return fields.get(id)!;
    };
    const payContext = vm.createContext({
      document: { getElementById: field, querySelector: () => null },
      location: { pathname: `/pay/${order.id}`, search: '' },
      URLSearchParams,
      navigator: { userAgent: '' },
      window: {},
      fetch: (url: string) => request(url, token),
      setInterval: () => 0,
      clearInterval: () => {},
    });
    vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(payHtml)![1]!.replace('  load();', '  globalThis.loaded = load();'), payContext);
    await payContext.loaded;
    check(() => assert.equal(field('routeTitle').textContent, xss));
    const renderAdvisor = /  function renderAdvisor\(\) \{[\s\S]*?\n  \}/.exec(payHtml)![0];
    vm.runInNewContext(`${renderAdvisor}; renderAdvisor();`, {
      $: field,
      order: orderBody,
      fmt: String,
      advisorStatusText: () => '',
      show: () => {},
    });
    check(() => assert.equal(field('aRouteTitle').textContent, xss));
    const fillPayCard = /  async function fillPayCard\(card, pay\) \{[\s\S]*?\n  \}/.exec(html)![0];
    const cardContext = vm.createContext({
      card: { querySelector: field },
      pay: { orderId: order.id },
      fetch: (url: string) => request(url, token),
      cnDate: String,
    });
    await vm.runInContext(`${fillPayCard}; fillPayCard(card, pay);`, cardContext);
    check(() => assert.equal(field('.pc-title').textContent, xss));
  }
  const sop = (await (await request('/api/console/sop', token)).json()) as SopOverview;
  const beforeHash = withTenantScope(a, () => currentSop().promptHash);
  const saved = await request('/api/console/sop/draft', token, {
    method: 'PUT',
    body: JSON.stringify({
      basedOn: sop.published.id,
      rev: null,
      edits: [{ key: 'preamble', body: sop.published.sections.find((s) => s.key === 'preamble')!.text + '\n本次体验的服务说明。' }],
    }),
    headers: { 'content-type': 'application/json', 'x-csrf': csrfFor(token) },
  });
  await expect(saved, 200);
  const draft = (await saved.json()) as { rev: number };
  await expect(await post('/api/console/sop/draft/publish', token, { rev: draft.rev, changeNote: '体验发布' }), 200);
  check(() =>
    assert.notEqual(
      withTenantScope(a, () => currentSop().promptHash),
      beforeHash,
    ),
  );
  check(() =>
    assert.equal(
      withTenantScope(b, () => currentSop().promptHash),
      beforeHash,
    ),
  );
  const allSteps = await progress();
  check(() => assert.deepEqual(allSteps, [true, true, true, true]));
  const untouchedSteps = await progress(bResult.token);
  check(() => assert.deepEqual(untouchedSteps, [false, false, false, false], 'A 的进度不进入 B'));
  // 第四步的三个独立分支；事务回滚保留 B 的初始状态，不删除审计。
  const bMe = (await (await request('/api/console/me', bResult.token)).json()) as Me;
  for (const [action, targetType, diff, done] of [
    ['catalog.update', 'route', { title: ['旧标题', '新标题'] }, false],
    ['catalog.update', 'route', { priceFrom: [100, 100] }, false],
    ['catalog.update', 'route', { priceFrom: [100, 200] }, true],
    ['order.mark_paid', 'order', {}, true],
    ['sop.publish', 'sop_version', {}, true],
  ] as const) {
    const rollback = new Error('rollback_probe');
    await assert.rejects(
      withTenantScope(b, () =>
        withTenant(db, { tenantId: b.id, actor: { kind: 'user', userId: bMe.userId, name: bMe.displayName, ip: null } }, async (tx) => {
          await writeAudit(tx, { action, targetType, diff });
          const steps = await readSandboxSteps(
            tx,
            withTenantScope(b, () => currentTenant().pack),
          );
          check(() => assert.deepEqual(steps, [false, false, false, done], action));
          throw rollback;
        }),
      ),
      (e: unknown) => e === rollback,
    );
  }
  const afterTemplate = await templateSnapshot();
  check(() => assert.deepEqual(afterTemplate, originalTemplate, '沙箱改价与发布 SOP 不改宿主模板的库行'));

  // 同进程两个沙箱故意使用相同模拟器 id，两条 HTTP SSE 均有正向推送对照。
  const sharedSimId = `sim-${randomBytes(12).toString('hex')}`;
  const sharedSbxId = `sbx-${sharedSimId.slice(4)}`;
  for (const visitorToken of [token, bResult.token])
    await expect(await post('/api/chat', visitorToken, { sessionId: sharedSimId, text: '你好' }), 200);
  const aStream = await openStream(`/api/stream/${sharedSimId}`, token);
  const bStream = await openStream(`/api/stream/${sharedSimId}`, bResult.token);
  try {
    for (const [visitorToken, marker] of [
      [token, '仅沙箱A的消息'],
      [bResult.token, '仅沙箱B的消息'],
    ] as const) {
      await expect(await post(`/api/console/conversations/${sharedSbxId}/takeover`, visitorToken), 200);
      await expect(
        await post(`/api/console/conversations/${sharedSbxId}/reply`, visitorToken, { text: marker, clientId: randomUUID() }),
        200,
      );
    }
    await aStream.until((text) => text.includes('仅沙箱A的消息'), '沙箱 A 的 HTTP 模拟器 SSE 收到 A 的推送');
    await bStream.until((text) => text.includes('仅沙箱B的消息'), '沙箱 B 的 HTTP 模拟器 SSE 收到 B 的推送');
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(() => assert.ok(!aStream.text().includes('仅沙箱B的消息'), '同进程沙箱 A 的 HTTP 模拟器 SSE 收不到 B 的推送'));
    check(() => assert.ok(!bStream.text().includes('仅沙箱A的消息'), '同进程沙箱 B 的 HTTP 模拟器 SSE 收不到 A 的推送'));
  } finally {
    await aStream.close();
    await bStream.close();
  }

  // 13 小时空闲仍有效；受限函数只用数据库 now，更新 last_seen_at。
  const hash = createHash('sha256').update(token).digest();
  await q("update auth_sessions set last_seen_at=now()-interval '13 hours' where token_hash=$1", [hash]);
  await expect(await request('/api/console/me', token), 200);
  const [seen] = await q<{ ok: boolean }>("select last_seen_at > now()-interval '1 minute' as ok from auth_sessions where token_hash=$1", [
    hash,
  ]);
  check(() => assert.ok(seen!.ok));
  const random = randomBytes(32).toString('base64url');
  assert.deepEqual(await sandboxSessionResolve(db, createHash('sha256').update(random).digest()), { status: 'invalid' });
  checks++;
  await expect(await request('/api/console/me', random), 401, 'sandbox_required');
  // standard token 被库层拒绝，解析层归一为 invalid；宿主也不读取 sbx。
  const standardToken = randomBytes(32).toString('base64url');
  await q("insert into memberships(tenant_id,user_id,role) values($1,$2,'owner')", [host.id, me.userId]);
  await q(
    "insert into auth_sessions(token_hash,tenant_id,user_id,created_at,last_seen_at,expires_at) values($1,$2,$3,now(),now(),now()+interval '24 hours')",
    [createHash('sha256').update(standardToken).digest(), host.id, me.userId],
  );
  assert.deepEqual(await sandboxSessionResolve(db, createHash('sha256').update(standardToken).digest()), { status: 'invalid' });
  checks++;
  await expect(await request('/api/console/me', standardToken), 401, 'sandbox_required');
  registerRuntime(host);
  await withTenantScope(host, () => initConfig({ ...deps, lock: async () => fakeLock() }));
  await expect(
    await routes.request('/api/console/me', { headers: { host: 'host.example.invalid', cookie: `__Host-sbx=${token}` } }),
    401,
    'unauthorized',
  );
  await q('delete from auth_sessions where tenant_id=$1', [host.id]);
  await q('delete from memberships where tenant_id=$1 and user_id=$2', [host.id, me.userId]);
  check(() => assert.notEqual(scrubConvIds(`path=${sbxId}`), `path=${sbxId}`));
  check(() => assert.equal(scrubConvIds(`tenant=${a.slug}`), `tenant=${a.slug}`, '日志保留非凭据的租户 slug，只遮盖会话 id'));
  a.state = 'closing';
  const closing = await request('/console/', token);
  check(() => assert.equal(closing.headers.get('location'), '/try?ended=1'));
  await expect(await request('/api/console/me', token), 410, 'sandbox_expired');
  a.state = 'serving';
  await expect(await post('/api/sandbox/end', token), 200);
  assert.deepEqual(await sandboxSessionResolve(db, hash), { status: 'expired' });
  checks++;
  const expired = await request('/api/console/me', token);
  check(() => assert.match(expired.headers.get('set-cookie')!, /Max-Age=0/));
  await expect(expired, 410, 'sandbox_expired');
  const pageExpired = await request('/chat.html', token);
  check(() => assert.equal(pageExpired.headers.get('location'), '/try?ended=1'));
  await withTenantScope(a, () => flushSession(sbxId, { timeoutMs: 5000 }));
  tenantStoreIfLoaded(a)?.pgBackend?.close();
  await purgeTestSandbox(db, a.id);
  assert.deepEqual(await sandboxSessionResolve(db, hash), { status: 'invalid' });
  checks++;
  const deleted = await request('/api/console/me', token);
  check(() => assert.match(deleted.headers.get('set-cookie')!, /Max-Age=0/));
  await expect(deleted, 401, 'sandbox_required');
  console.log(`SELFTEST ${real ? '真实 PG' : 'PGlite'}: cookie 隔离、复用、三状态、13 小时、跨源写保护与工作台闭环通过`);
}

try {
  await cleanup();
  const t = await openTestDb();
  try {
    await t.pg.query("insert into tenants(slug,name,pack_id) values('template','模板','travel')");
    const q: Query = async (text, params = []) => {
      await t.pg.exec('RESET ROLE');
      try {
        return (await t.pg.query(text, params)).rows as never;
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    };
    await t.pg.exec('SET ROLE agent_app');
    await suite(t.db, q, false);
  } finally {
    await cleanup();
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const f = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    const app = await openDb(f.urls.app);
    try {
      await suite(app.db, f.query, true);
    } finally {
      await cleanup();
      await app.close();
      await f.drop();
    }
  } else console.log('SKIP: 真实 PG HTTP 安全验收需要 PG_TEST_URL');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`SELFTEST PASS: 沙箱 HTTP ${checks} 项`);
