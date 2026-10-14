// 05 第 8 步：Host、重复资源 id / key、登录 cookie 与绝对链接的安全边界。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { publicBase, publicHostMiddleware, installPublicHost, validatePublicHosts } from './hosts.js';
import {
  configureTenancy,
  currentRuntime,
  hostRuntime,
  createTenantRuntime,
  registerRuntime,
  tenantRuntimes,
  withTenantScope,
} from './runtime.js';
import type { ChannelAccount } from '../channels/accounts.js';
import type { Order } from '../types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-public-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.PUBLIC_BASE_URL = 'https://host.example.invalid:8443';
process.env.WECOM_CALLBACK_TOKEN = '';
process.env.WECOM_CALLBACK_AES_KEY = '';
await import('../store.js');
const config = await import('../config/source.js');
const { app } = await import('../server.js');
const { installAccounts, accountByKey } = await import('../channels/accounts.js');
const { accountCallbackGet } = await import('../adapters/wecom-callback.js');
const { openTestDb, installSeededConfig } = await import('../db/testing.js');
const { hashPassword } = await import('../auth/password.js');
const { login, resolveSession, logout } = await import('../auth/session.js');
const { authSessionCreate } = await import('../db/repo/auth.js');
const { createHash, randomBytes } = await import('node:crypto');
const { workbenchLink } = await import('../notify/notifier.js');
const { partsOf } = await import('../core/message-parts.js');
const host = hostRuntime();
const request = (url: string, hostName: string, extra: RequestInit = {}) =>
  app.request(url, { ...extra, headers: { ...Object.fromEntries(new Headers(extra.headers)), host: hostName } });
let t: Awaited<ReturnType<typeof openTestDb>> | undefined;
try {
  configureTenancy({ role: 'host', standardCount: 1, strict: true });
  for (const name of ['unknown.invalid', 'HOST.example.invalid.:1234', '[::1]:8080'])
    assert.equal((await request('/', name)).status, 302, '单 standard 任意 Host 都是它，严格模式也一样');
  const other = createTenantRuntime({ id: 'other', slug: 'other', publicBase: 'https://other.example.invalid' });
  registerRuntime(other);
  installPublicHost(host, 'HOST.EXAMPLE.INVALID.');
  installPublicHost(other, 'other.example.invalid');
  configureTenancy({ role: 'host', standardCount: 2 });
  const settings = [
    { isHost: true, publicHost: 'HOST.example.invalid.' },
    { isHost: false, publicHost: 'other.example.invalid' },
  ];
  validatePublicHosts(settings, process.env.PUBLIC_BASE_URL);
  assert.throws(() => validatePublicHosts([{ ...settings[0]!, publicHost: null }, settings[1]!], ''), /tenant_host_missing/);
  assert.throws(() => validatePublicHosts(settings, 'https://wrong.example.invalid'), /tenant_public_base_mismatch/);
  assert.throws(() => validatePublicHosts(settings, ''), /tenant_public_base_mismatch/);
  assert.throws(() => validatePublicHosts(settings, 'https://user@host.example.invalid'), /tenant_public_base_mismatch/);
  assert.throws(() => validatePublicHosts([settings[0]!, settings[0]!], process.env.PUBLIC_BASE_URL ?? ''), /tenant_host_invalid/);
  other.state = 'closing';
  assert.equal((await request('/', 'unknown.invalid')).status, 404, '其他租户暂不服务也不扩大 Host 的兼容范围');
  other.state = 'serving';
  const probe = new Hono().use('*', publicHostMiddleware).get('/probe', async (c) => {
    const before = currentRuntime();
    await new Promise((resolve) => setTimeout(resolve, before.isHost ? 10 : 1));
    assert.equal(currentRuntime(), before, 'await 之后保留同一个 Host 的作用域');
    return c.text(before.id);
  });
  const [a, b] = await Promise.all([
    probe.request('/probe', { headers: { host: 'HOST.example.invalid.:443', 'x-forwarded-host': 'other.example.invalid' } }),
    probe.request('/probe', { headers: { host: 'other.example.invalid:80', 'x-forwarded-host': 'host.example.invalid' } }),
  ]);
  assert.equal(await a.text(), host.id);
  assert.equal(await b.text(), other.id);
  assert.equal(
    await (await withTenantScope(host, () => probe.request('/probe', { headers: { host: 'other.example.invalid' } }))).text(),
    other.id,
    '调用者 ALS 不能替代请求 Host',
  );
  assert.equal((await withTenantScope(host, () => probe.request('/probe', { headers: { host: 'unknown.invalid' } }))).status, 404);
  const nested = new Hono().use('*', publicHostMiddleware).route('/nested', probe);
  assert.equal(
    await (await nested.request('/nested/probe', { headers: { host: 'other.example.invalid' } })).text(),
    other.id,
    '子应用沿用同一请求的外层选择',
  );
  for (const name of ['unknown.invalid', 'host.example.invalid,other.example.invalid', 'host.example.invalid/path']) {
    assert.equal((await request('/api/orders/shared', name)).status, 404);
    assert.equal((await request('/console/', name)).status, 404);
    assert.equal((await request('/wecom/callback', name)).status, 404);
  }
  assert.equal((await probe.request('/probe', { headers: { 'x-forwarded-host': 'host.example.invalid' } })).status, 404);

  t = await openTestDb();
  const { shanhaiBrand } = await import('../packs/travel/brand-fixture.js');
  await t.pg.query("insert into tenants (slug, name, pack_id, brand) values ('other', 'other', 'travel', $1)", [
    JSON.stringify(shanhaiBrand),
  ]);
  await withTenantScope(host, () => installSeededConfig(t!, { slug: 'host' }));
  await withTenantScope(other, () => installSeededConfig(t!, { slug: 'other' }));
  const seed = JSON.parse(fs.readFileSync('data/sandbox-seeds.json', 'utf8')) as { orders: Order[] };
  for (const rt of [host, other]) {
    rt.store.orders.set('shared', { ...seed.orders[0]!, id: 'shared', routeTitle: rt.slug });
    rt.store.orders.set(`only-${rt.slug}`, { ...seed.orders[0]!, id: `only-${rt.slug}`, routeTitle: rt.slug });
  }
  assert.equal((await (await request('/api/orders/shared', 'host.example.invalid')).json()).routeTitle, 'host');
  assert.equal((await (await request('/api/orders/shared', 'other.example.invalid')).json()).routeTitle, 'other');
  assert.equal((await request('/api/orders/only-host', 'other.example.invalid')).status, 404);
  assert.equal((await request('/api/orders/only-other', 'host.example.invalid')).status, 404);
  assert.equal((await request('/api/orders/only-host/pay', 'other.example.invalid', { method: 'POST' })).status, 404);
  assert.match(await (await request('/pay/shared', 'other.example.invalid')).text(), /山海旅行/);
  const route = withTenantScope(other, () => config.currentCatalog().routes[0]!);
  const proposal = await (await request(`/proposal/${route.id}`, 'other.example.invalid')).text();
  assert.match(proposal, /https:\/\/other\.example\.invalid\/share-cover\.png/);
  assert.equal((await request('/api/proposal/not-here', 'other.example.invalid')).status, 404);
  for (const url of [
    '//chat.html',
    '//admin.html',
    '//kf-qr.png',
    '/chat.html',
    '/CHAT.html',
    '/%63hat.html',
    '/admin.html',
    '/%61dmin.html',
    '/kf-qr.png',
    '/api/chat',
    '/api/stream/sim-id',
    '/api/sessions',
    '/api/sessions/sim-id',
    '/api/sessions/shared/reply',
    '/api/orders',
    '/api/admin/status',
    '/api/usage',
    '/api/insights',
  ])
    assert.equal((await request(url, 'other.example.invalid')).status, 404, `${url} 只给宿主`);
  // healthz 不参与 Host 选择，始终在宿主作用域投影。
  assert.equal((await request('/healthz', 'unknown.invalid')).status, 200);
  const healthy = await (await request('/healthz', 'unknown.invalid')).json();
  assert.equal(healthy.role, 'host');
  assert.equal(healthy.ok, true, '只装载配置时健康检查不创建非宿主文件后端');
  const lockState = other.config.lockState;
  try {
    other.config.lockState = 'lost';
    assert.equal((await (await request('/healthz', 'unknown.invalid')).json()).ok, false, '其他 standard 丢锁也使宿主健康为 false');
  } finally {
    other.config.lockState = lockState;
  }

  const web = (tenantId: string, id: string): ChannelAccount => ({
    id,
    tenantId,
    key: 'shared-web',
    kind: 'web',
    name: id,
    status: 'active',
    source: 'db',
    wecom: null,
    web: { title: id, dailyNewConversations: 10, dailyTurns: 10 },
    inactiveReason: null,
  });
  installAccounts([web(host.id, 'web-host'), web(other.id, 'web-other'), { ...web(host.id, 'web-host-only'), key: 'host-only' }]);
  withTenantScope(host, () => assert.equal(accountByKey('shared-web', 'web', host.id)?.id, 'web-host'));
  withTenantScope(other, () => assert.equal(accountByKey('shared-web', 'web', other.id)?.id, 'web-other'));
  assert.match(await (await request('/w/shared-web', 'host.example.invalid')).text(), /web-host/);
  assert.match(await (await request('/w/shared-web', 'other.example.invalid')).text(), /web-other/);
  assert.equal((await request('/w/host-only', 'other.example.invalid')).status, 404);
  assert.equal((await request('/api/web/host-only/messages', 'other.example.invalid', { method: 'POST' })).status, 404);
  // 不带 key 的回调在非宿主也走账号查找，绝不读宿主 env 凭据（env 未配时宿主是 501）。
  assert.equal((await request('/wecom/callback', 'host.example.invalid')).status, 501);
  assert.equal((await request('/wecom/callback', 'other.example.invalid')).status, 404);
  withTenantScope(other, () => assert.equal(accountCallbackGet('shared-web', {}).status, 404));

  await t.pg.exec('RESET ROLE');
  const password = await hashPassword('selftest-member-password');
  const user = (
    await t.pg.query<{ id: string }>(
      "insert into users (email, password_hash, display_name) values ('member@example.invalid', $1, '测试成员') returning id",
      [password],
    )
  ).rows[0]!;
  await t.pg.query("insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')", [host.id, user.id]);
  await t.pg.exec('SET ROLE agent_app');
  const now = Date.now();
  const input = { email: 'member@example.invalid', password: 'selftest-member-password', ip: null, userAgent: null, now };
  assert.equal(await withTenantScope(other, () => login(input)), null, '别的 Host 没有该成员');
  const member = await withTenantScope(host, () => login(input));
  assert.ok(member);
  const cookie = `__Host-sid=${member.token}`;
  assert.equal((await request('/api/console/me', 'other.example.invalid', { headers: { cookie } })).status, 401);
  assert.equal((await request('/api/console/me', 'host.example.invalid', { headers: { cookie } })).status, 200);
  await withTenantScope(other, () => logout(member.token, now));
  assert.ok(await withTenantScope(host, () => resolveSession(member.token, now)), '跨 Host 登出不吊销原租户会话');
  // 同一个人加入另一个租户后，该租户签发的 cookie 也仍不能切到宿主。
  await t.pg.exec('RESET ROLE');
  await t.pg.query("insert into memberships (tenant_id, user_id, role) values ($1, $2, 'viewer')", [other.id, user.id]);
  await t.pg.exec('SET ROLE agent_app');
  const otherToken = randomBytes(32).toString('base64url');
  await authSessionCreate(t.db, {
    tenantId: other.id,
    tokenHash: createHash('sha256').update(otherToken).digest(),
    userId: user.id,
    now: new Date(now),
    ip: null,
    userAgent: null,
  });
  assert.equal(await withTenantScope(host, () => resolveSession(otherToken, now)), null);
  assert.equal((await withTenantScope(other, () => resolveSession(otherToken, now)))?.role, 'viewer');
  await withTenantScope(host, () => logout(member.token, now));
  assert.equal(await withTenantScope(host, () => resolveSession(member.token, now)), null);
  withTenantScope(other, () => {
    assert.equal(publicBase(), 'https://other.example.invalid');
    assert.equal(workbenchLink(), 'https://other.example.invalid/console/conversations?state=human');
    assert.equal(partsOf('https://other.example.invalid/pay/shared').length, 1);
    assert.equal(partsOf('https://host.example.invalid:8443/pay/shared').length, 0);
  });
  withTenantScope(host, () => assert.equal(publicBase(), 'https://host.example.invalid:8443'));
  console.log(
    'PUBLIC ROUTES SELFTEST PASS: 单 standard / 多 Host / 未知 Host / 转发头 / 资源 id 与账号 key / 登录 cookie / 跨 Host 登出 / 绝对链接',
  );
} finally {
  installAccounts([]);
  for (const rt of tenantRuntimes()) await withTenantScope(rt, config.closeConfig);
  await t?.close();
  withTenantScope(host, () => host.store.fileBackend?.reset());
  fs.rmSync(dir, { recursive: true, force: true });
}
