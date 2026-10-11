// R10 与验收 4/5/11：真实路由、数据库 cookie 解析、租户隔离与工作台闭环。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../db/client.js';
import { createRealPgFixture, fakeLock, openTestDb, testConfigDeps, purgeTestSandbox } from '../../db/testing.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig, initConfig, currentSop, currentCatalog } from '../../config/source.js';
import { expireBrokenSandbox } from '../../db/sandbox-process.js';
import { sandboxSessionResolve } from '../../db/repo/sandbox.js';
import { csrfFor } from '../../auth/session.js';
import { subscribe } from '../../adapters/simulator.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { listSessions, listOrders, flushSession } from '../../store.js';
import { scrubConvIds } from '../../log.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import type { Me, CatalogItem, SopOverview } from '../../shared/console-api.js';
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
import { SandboxProcess, sandboxApp } from './process.js';
import { provisionSandbox } from './provision.js';
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
  const service = {
    health: () => new SandboxProcess({}).health(),
    resolve: (token: string | undefined) => resolveSandboxSession(db, token),
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
  check(() => assert.deepEqual(me.sandbox, { expiresAt: openBody.expiresAt, wechat: 'off', steps: [false, false, false, false] }));
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
  await expect(await request(`/api/sessions/${bId}`), 401, 'sandbox_required');
  const simId = `sim-${randomBytes(12).toString('hex')}`;
  const sbxId = `sbx-${simId.slice(4)}`;
  const send = await post('/api/chat', token, { sessionId: simId, text: '你好' });
  await expect(send, 200);
  const sent = (await send.json()) as { sessionId: string };
  check(() => assert.equal(sent.sessionId, sbxId));
  await withTenantScope(a, () => flushSession(sbxId, { timeoutMs: 5000 }));
  const history = await request(`/api/sessions/${simId}`, token);
  await expect(history, 200);
  const restored = (await history.json()) as { id: string; messages: unknown[] };
  check(() => assert.equal(restored.id, sbxId));
  check(() => assert.ok(restored.messages.length >= 2));
  await expect(await request(`/api/console/conversations/${sbxId}`, token), 200);
  await expect(await request(`/api/sessions/${sbxId}`, bResult.token), 404);
  const html = await (await request(`/chat.html?c=${sbxId}`, token)).text();
  check(() => assert.ok(html.includes(`ssj_session_id:${a.slug}`)));
  check(() => assert.ok(html.includes("new URLSearchParams(location.search).get('c')")));
  check(() => assert.ok(html.includes('(?:sim|sbx)-')));

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
    await expect(await post(`/api/console/conversations/${sbxId}/reply`, token, { text: '体验访客回复', clientId: randomUUID() }), 200);
    check(() => assert.ok(pushes.some((s) => s.includes('【顾问】体验访客回复'))));
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
    await expect(await post('/api/chat', token, { sessionId: sbxId, text: '想去云南' }), 200);
    const order = withTenantScope(a, () => listOrders().find((o) => o.status === 'pending_payment')!);
    assert.ok(order);
    const orderPushes: string[] = [];
    const offOrder = withTenantScope(a, () => subscribe(order.sessionId, (text) => orderPushes.push(text)));
    try {
      await expect(await post(`/api/orders/${order.id}/pay`, token), 200);
      check(() => assert.ok(orderPushes.length));
    } finally {
      offOrder();
    }
    await expect(await request(`/pay/${order.id}`, token), 200);
    await expect(await request(`/api/orders/${order.id}`), 401, 'sandbox_required');
    await expect(await request('/privacy', token), 200);
    const beforeB = withTenantScope(b, () => JSON.stringify(listSessions()));
    await expect(await post('/api/chat', token, { sessionId: sbxId, text: '重置' }), 200);
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
  const afterTemplate = await templateSnapshot();
  check(() => assert.deepEqual(afterTemplate, originalTemplate, '沙箱改价与发布 SOP 不改宿主模板的库行'));

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
