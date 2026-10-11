// 05 R17：两个 standard 租户同进程，真实 HTTP 假模型交错，公开路由与物理 SSE。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Order, Route } from '../types.js';
import type { TenantRuntime } from './runtime.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-isolation-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SERVER_SELFTEST: '1',
  TENANCY_STRICT: '1',
  LLM_MOCK: '0',
  LLM_API_KEY: 'fixture-model',
  LLM_MODEL: 'fixture-model',
  LLM_MODEL_CHEAP: 'fixture-model',
  LLM_PROVIDER: 'default',
  LLM_MAX_RETRY: '0',
  LLM_HEDGE_MODEL: '',
  EMBED_API_KEY: '',
  ZHIPU_API_KEY: '',
  WECOM_CALLBACK_TOKEN: '',
  WECOM_CALLBACK_AES_KEY: '',
  ALERT_WEBHOOK_URL: '',
  DEMO_PRUNE_HOURS: '0',
  PUBLIC_BASE_URL: 'https://a.example.invalid',
});
const consoleDist = path.join(dir, 'console-dist');
fs.mkdirSync(consoleDist);
fs.writeFileSync(path.join(consoleDist, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
process.env.CONSOLE_DIST = consoleDist;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(5);
  assert.ok(check(), label);
}
let releaseB = (): void => {};
const blockedB = new Promise<void>((resolve) => {
  releaseB = resolve;
});
let delayB = true;
const requests: { owner: 'a' | 'b'; system: string; tools: string; wire: string }[] = [];
const replies: string[] = [];
const model = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[]; tools: unknown };
    const system = body.messages.find((message) => message.role === 'system')!.content;
    const owner = req.headers['x-fixture-tenant'] === a.id ? 'a' : req.headers['x-fixture-tenant'] === b.id ? 'b' : null;
    if (!owner) throw new Error('模型请求缺少有效的租户来源标记');
    requests.push({ owner, system, tools: JSON.stringify(body.tools), wire: JSON.stringify(body) });
    if (owner === 'b' && delayB) await blockedB;
    const brand = owner === 'a' ? '云途旅行' : '山海旅行';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `您好，我是${brand}的顾问。请问您想去哪里旅行？` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
    replies.push(owner);
  } catch {
    res.writeHead(500);
    res.end('{}');
  }
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
process.env.LLM_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
const r = await import('./runtime.js');
const state = await import('./state.js');
const store = await import('../store.js');
const config = await import('../config/source.js');
const { app } = await import('../server.js');
const { handleMessage } = await import('../engine.js');
const tools = await import('../tools.js');
const { shanhaiBrand } = await import('../packs/travel/brand-fixture.js');
const { installPublicHost, validatePublicHosts } = await import('./hosts.js');
const testing = await import('../db/testing.js');
const channels = await import('../channels/registry.js');
const accounts = await import('../channels/accounts.js');
const simulator = await import('../adapters/simulator.js');
const web = await import('../adapters/web.js');
const { onUsage } = await import('../usage.js');
const hub = await import('../console-api/events.js');
const events = await import('../store/events.js');
const ledger = await import('../quota/ledger.js');
const { __privacyTest } = await import('../privacy/privacy.js');
const { __logTest, withConversationLog } = await import('../log.js');
const { sealSecrets } = await import('../channels/secrets.js');
const { login } = await import('../auth/session.js');
const { hashPassword } = await import('../auth/password.js');
const t = await testing.openTestDb();
const a = r.hostRuntime();
const b = r.createTenantRuntime({ id: 'isolation-b', slug: 'isolation-b', publicBase: 'https://b.example.invalid' });
r.registerRuntime(b);
r.configureTenancy({ role: 'host', standardCount: 2 });
const originalFetch = globalThis.fetch;
// 来源取自发起请求的作用域，完全独立于 system/tools 内容；真实 HTTP 服务只认这个头。
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === process.env.LLM_BASE_URL) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-fixture-tenant', r.currentRuntime().id);
    return originalFetch(input, { ...init, headers });
  }
  return originalFetch(input, init);
};
const inside = <T>(rt: TenantRuntime, fn: () => T): T => r.withTenantScope(rt, fn);
const su = async <T>(sql: string, args: unknown[] = []): Promise<T[]> =>
  t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<T>(sql, args)).rows;
  });
const request = (url: string, rt: TenantRuntime, init: RequestInit = {}) =>
  app.request(url, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), host: rt === a ? 'a.example.invalid' : 'b.example.invalid' },
  });
const streams: { text: string; done: boolean; reader: ReadableStreamDefaultReader<Uint8Array>; pump: Promise<void> }[] = [];
function tap(response: Response) {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const stream = { text: '', done: false, reader, pump: Promise.resolve() };
  stream.pump = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stream.text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      stream.done = true;
    }
  })();
  streams.push(stream);
  return stream;
}
const routes = JSON.parse(fs.readFileSync('data/routes.json', 'utf8')) as Route[];
const originalPrice = routes[0]!.priceFrom;
const sharedRoute = routes[0]!.id;
const unique = { ...routes[0]!, id: 'isolation-only-b', title: '山海独有海岛线', destination: '独有海岛', priceFrom: 4321 };
const bData = path.join(dir, 'b-data');
fs.mkdirSync(bData);
for (const name of ['sop.md', 'hotels.json']) fs.copyFileSync(path.join('data', name), path.join(bData, name));
fs.writeFileSync(
  path.join(bData, 'routes.json'),
  JSON.stringify([{ ...routes[0]!, priceFrom: originalPrice + 777 }, ...routes.slice(1), unique]),
);
fs.writeFileSync(path.join(bData, 'brand.json'), JSON.stringify(shanhaiBrand));
const fixture = new Map<TenantRuntime, import('../db/testing.js').PgStoreFixture>();
const accountsByTenant = new Map<TenantRuntime, { web: string; token: string; aes: Buffer; echo: string }>();
const cookies = new Map<TenantRuntime, string>();
const webCookies = new Map<TenantRuntime, string>();
const webIds = new Map<TenantRuntime, string>();
const usageSeen: { subscriber: TenantRuntime; actual: TenantRuntime | undefined; event: import('../usage.js').UsageEvent }[] = [];
const pushesSeen: { subscriber: TenantRuntime; actual: TenantRuntime | undefined; text: string }[] = [];
const expected = new Map<TenantRuntime, { system: string; tools: string }>();
const ringKey = randomBytes(32);
const ring = { current: { id: 'fixture', key: ringKey }, all: new Map([['fixture', ringKey]]) };
const same = 'wecom:wmShared';
let observationNow = Date.now();
channels.__channelsTest.setObservationClock(() => observationNow);
const orderSeed = (JSON.parse(fs.readFileSync('data/sandbox-seeds.json', 'utf8')) as { orders: Order[] }).orders[0]!;
try {
  await su("insert into tenants (slug,name,pack_id,brand) values ('isolation-b','B','travel',$1)", [JSON.stringify(shanhaiBrand)]);
  for (const rt of [a, b]) {
    fs.mkdirSync(path.join(dir, rt === a ? 'isolation-a' : 'isolation-b'));
    await inside(rt, () =>
      testing.installSeededConfig(t, { slug: rt === a ? 'isolation-a' : 'isolation-b', dataDir: rt === a ? 'data' : bData }),
    );
    installPublicHost(rt, rt === a ? 'a.example.invalid' : 'b.example.invalid');
    const fx = await inside(rt, () => testing.installPgSessionStore(t, { slug: rt.slug, varDir: path.join(dir, rt.slug) }));
    fixture.set(rt, fx);
    await inside(rt, () => store.initSessionStore(fx.deps));
    const web = randomUUID(),
      wecom = randomUUID(),
      token = randomBytes(16).toString('hex'),
      aes = randomBytes(32);
    const echo = rt.slug;
    accountsByTenant.set(rt, { web, token, aes, echo });
    const sealed = sealSecrets(
      ring,
      { tenantId: rt.id, accountId: wecom },
      { appSecret: randomBytes(16).toString('hex'), callbackToken: token, callbackAesKey: aes.toString('base64').slice(0, -1) },
    );
    await su(
      `insert into channel_accounts (tenant_id, id, key, name, kind, status, settings) values ($1, $2, 'same-web', $3, 'web', 'active', $4)`,
      [rt.id, web, rt.slug, JSON.stringify({ title: echo, dailyNewConversations: 100, dailyTurns: 100 })],
    );
    await su(
      `insert into channel_accounts (tenant_id, id, key, name, kind, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id, settings)
      values ($1, $2, 'main', $3, 'wecom_kf', 'active', 'wecom:', 'fixture-corp', 'fixture-kf', decode($4, 'hex'), $5, '{}')`,
      [rt.id, wecom, rt.slug, sealed.ct.toString('hex'), sealed.keyId],
    );
    if (rt === b) observationNow += 61_000;
    await inside(rt, () => channels.initChannels({ ...fx.deps, keyRing: ring }));
    if (rt === a) {
      await su(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, received_at, payload)
        values ($1, $2, 'grace-probe', 'message', $3, 'received', $4, '{"text":"fixture"}')`,
        [rt.id, web, same, new Date(observationNow - 400_000)],
      );
      await inside(rt, channels.refreshChannelObservability);
      assert.equal(
        inside(rt, () => channels.channelConditions().find((item) => item.key === 'same-web')!.stuck),
        false,
        'A 启动仍在宽限期',
      );
    } else {
      assert.equal(
        inside(a, () => channels.channelConditions().find((item) => item.key === 'same-web')!.stuck),
        true,
        'B 装载不能重启 A 的 60 秒宽限期',
      );
    }
    inside(rt, () => {
      expected.set(rt, { system: config.currentSop().promptHash, tools: config.currentSop().toolsHash });
      const session = store.getOrCreateSession(same, 'simulator');
      session.profile.nickname = rt.slug;
      store.saveSession(session);
      const order: Order = {
        ...orderSeed,
        id: 'same-order',
        sessionId: same,
        routeId: sharedRoute,
        routeTitle: rt.slug,
        totalPrice: (originalPrice + (rt === b ? 777 : 0)) * orderSeed.travelers,
        status: 'pending_payment',
        createdAt: Date.now(),
        paidAt: undefined,
      };
      rt.store.orders.set(order.id, order);
      session.orderIds.push(order.id);
      store.saveOrder(order);
      const reverse = { ...order, id: 'same-order-reverse' };
      rt.store.orders.set(reverse.id, reverse);
      session.orderIds.push(reverse.id);
      store.saveOrder(reverse);
      store.saveSession(session);
      __privacyTest.set({ version: rt === a ? 101 : 202, body: `${rt.slug} 隐私说明` });
    });
    await inside(rt, () => store.flushSession(same));
  }
  channels.__channelsTest.setObservationClock(null);
  validatePublicHosts(
    [
      { isHost: true, publicHost: 'a.example.invalid' },
      { isHost: false, publicHost: 'b.example.invalid' },
    ],
    process.env.PUBLIC_BASE_URL!,
  );
  assert.notEqual(
    inside(a, () => store.getSession(same)),
    inside(b, () => store.getSession(same)),
  );
  assert.notEqual(
    inside(a, () => store.getOrder('same-order')),
    inside(b, () => store.getOrder('same-order')),
  );
  assert.equal(
    inside(a, () => accounts.accountByKey('same-web', 'web')!.id),
    accountsByTenant.get(a)!.web,
  );
  assert.equal(
    inside(b, () => accounts.accountByKey('same-web', 'web')!.id),
    accountsByTenant.get(b)!.web,
  );
  for (const rt of [a, b])
    await inside(rt, async () => {
      assert.equal(
        tools.loadRoutes().some((route) => route.id === unique.id),
        rt === b,
      );
      assert.equal(
        (await tools.searchRoutes({ destination: unique.destination })).some((route) => route.id === unique.id),
        rt === b,
      );
      assert.equal(tools.createQuote({ routeId: sharedRoute, travelers: 1 }).perPerson, originalPrice + (rt === b ? 777 : 0));
      if (rt === b) assert.equal(tools.createQuote({ routeId: unique.id, travelers: 1 }).perPerson, unique.priceFrom);
      else assert.throws(() => tools.createQuote({ routeId: unique.id, travelers: 1 }), /不存在/);
    });

  for (const rt of [a, b])
    inside(rt, () =>
      onUsage((event) => {
        usageSeen.push({ subscriber: rt, actual: r.scopedRuntime(), event });
      }),
    );
  const observed: string[] = [];
  for (const rt of [a, b])
    inside(rt, () => {
      const logger = __logTest.createJsonLogger({
        write: (line: string) => {
          observed.push(line);
        },
      });
      // 订阅者也要隔离；第 11 步补登记的闭包在 reset/drop 后不得继续被调用。
      inside(rt, () =>
        simulator.subscribe('same-stream', (text) => {
          pushesSeen.push({ subscriber: rt, actual: r.scopedRuntime(), text });
          withConversationLog(same, () => logger.info('isolation-push'));
        }),
      );
    });
  const runB = inside(b, () => handleMessage(same, '您好，介绍一下你们', 'simulator'));
  await until(() => requests.some((req) => req.owner === 'b'), 'B 先发出模型请求');
  const replyA = await inside(a, () => handleMessage(same, '您好，介绍一下你们', 'simulator'));
  assert.deepEqual(replies, ['a'], 'A 完成时 B 仍在途，真实交错');
  releaseB();
  delayB = false;
  const replyB = await runB;
  assert.match(replyA.text, /云途/);
  assert.doesNotMatch(replyA.text, /山海/);
  assert.match(replyB.text, /山海/);
  assert.doesNotMatch(replyB.text, /云途/);
  const second = await Promise.all([
    inside(a, () => handleMessage(same, '请再介绍一下', 'simulator')),
    inside(b, () => handleMessage(same, '请再介绍一下', 'simulator')),
  ]);
  assert.match(second[0]!.text, /云途/);
  assert.doesNotMatch(second[0]!.text, /山海/);
  assert.match(second[1]!.text, /山海/);
  assert.doesNotMatch(second[1]!.text, /云途/);
  for (const owner of ['a', 'b']) assert.equal(requests.filter((req) => req.owner === owner).length, 2, `${owner} 各两轮模型请求`);
  for (const req of requests) {
    const rt = req.owner === 'a' ? a : b;
    assert.equal(sha(req.system), expected.get(rt)!.system);
    assert.equal(sha(req.tools), expected.get(rt)!.tools);
    assert.doesNotMatch(req.wire, rt === a ? /山海/ : /云途/);
  }
  for (const rt of [a, b]) {
    await inside(rt, () => simulator.simulatorAdapter.push('same-stream', rt.slug));
    inside(rt, ledger.noteUnsafeSend);
    assert.equal(inside(rt, ledger.unsafeSendsIn10m), 1, '未落库发送计数按租户隔离');
    const received = usageSeen.filter((record) => record.subscriber === rt);
    assert.equal(received.length, 2, '租户观测回调只收到自己的两轮用量');
    for (const record of received) {
      assert.equal(record.actual, rt);
      assert.equal(record.event.tenantId, rt.id);
      assert.equal(record.event.sessionId, same);
    }
    assert.equal(state.tenantKeys(rt.id)['usage.usageListeners'], 1);
  }
  for (const record of pushesSeen) {
    assert.equal(record.actual, record.subscriber);
    assert.equal(record.text, record.subscriber.slug);
  }
  assert.equal(pushesSeen.length, 2);
  assert.deepEqual(
    observed.map((line) => JSON.parse(line).tenant),
    [a.slug, b.slug],
  );

  const password = 'selftest-password';
  const passwordHash = await hashPassword(password);
  const users = await su<{ id: string }>(
    `insert into users (email, password_hash, display_name) values ('isolation@example.invalid', $1, '隔离自测') returning id`,
    [passwordHash],
  );
  for (const rt of [a, b]) {
    await su(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [rt.id, users[0]!.id]);
    const logged = await inside(rt, () =>
      login({ email: 'isolation@example.invalid', password, ip: null, userAgent: null, now: Date.now() }),
    );
    assert.ok(logged);
    cookies.set(rt, `__Host-sid=${logged.token}`);
    inside(rt, () => hub.__eventsTest.setTiming({ heartbeatMs: 100, recheckMs: 100, countsDebounceMs: 5 }));
  }
  const consoleA = tap(await request('/api/console/events', a, { headers: { cookie: cookies.get(a)! } }));
  const consoleB = tap(await request('/api/console/events', b, { headers: { cookie: cookies.get(b)! } }));
  const adminA = tap(await request('/api/admin/stream', a));
  const simulatorA = tap(await request('/api/stream/same-stream', a));
  assert.equal((await request('/api/stream/same-stream', b)).status, 404, '非宿主模拟器路由照 spec 404');
  await until(() => consoleA.text.includes('counts') && consoleB.text.includes('counts') && simulatorA.text.includes('ping'), 'SSE 已建立');
  for (const rt of [a, b])
    inside(rt, () => events.deliverCommitted([{ type: 'conversation.changed', id: rt === a ? 'only-a' : 'only-b' }]));
  await until(() => consoleA.text.includes('only-a') && consoleB.text.includes('only-b'), 'console 各收到自己的提交');
  assert.doesNotMatch(consoleA.text, /only-b/);
  assert.doesNotMatch(consoleB.text, /only-a/);
  // 客户模拟器连接只属宿主；B 的租户订阅仍不得推到 A 的实际 HTTP 流。
  await inside(b, () => simulator.simulatorAdapter.push('same-stream', b.slug));
  await inside(a, () => simulator.simulatorAdapter.push('same-stream', a.slug));
  await until(() => simulatorA.text.includes(a.slug), '模拟器收到宿主推送');
  assert.doesNotMatch(simulatorA.text, /isolation-b/);

  // 公开路由表的每一行：相同 id / key，数据或品牌来自 Host 所属租户。
  for (const rt of [a, b]) {
    const brand = rt === a ? '云途' : '山海';
    assert.equal((await (await request('/api/orders/same-order', rt)).json()).routeTitle, rt.slug);
    assert.match(await (await request('/pay/same-order', rt)).text(), new RegExp(brand));
    assert.match(await (await request(`/proposal/${sharedRoute}`, rt)).text(), new RegExp(brand));
    const proposal = await request(`/api/proposal/${sharedRoute}?travelers=1`, rt);
    assert.equal(proposal.status, 200);
    const quote = (await proposal.json()).quote;
    assert.equal(quote.perPerson, originalPrice + (rt === b ? 777 : 0));
    assert.equal(quote.total, originalPrice + (rt === b ? 777 : 0));
    assert.match(await (await request('/privacy', rt)).text(), new RegExp(`${rt.slug} 隐私说明`));
    assert.match(await (await request('/w/same-web', rt)).text(), new RegExp(rt.slug));
    assert.equal((await request('/api/web/same-web/history', rt)).status, 200);
    const webReply = await request('/api/web/same-web/messages', rt, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-web-chat': '1',
        'content-length': String(Buffer.byteLength(JSON.stringify({ text: '您好，介绍一下你们', cid: 'same-web-turn' }))),
      },
      body: JSON.stringify({ text: '您好，介绍一下你们', cid: 'same-web-turn' }),
    });
    assert.equal(webReply.status, 200);
    const webBody = await webReply.json();
    assert.match(webBody.reply.text, new RegExp(brand));
    assert.doesNotMatch(webBody.reply.text, rt === a ? /山海/ : /云途/);
    webCookies.set(rt, webReply.headers.get('set-cookie')!.split(';')[0]!);
    const history = await (await request('/api/web/same-web/history', rt, { headers: { cookie: webCookies.get(rt)! } })).json();
    assert.ok(history.messages.some((message: { text: string }) => message.text.includes(brand)));
    webIds.set(
      rt,
      inside(rt, () => [...rt.store.sessions.values()].find((session) => session.channelAccountId === accountsByTenant.get(rt)!.web)!.id),
    );
    assert.equal((await request('/console/', rt)).status, 200);
    assert.equal((await request('/api/console/entry', rt)).status, 200);
    assert.equal((await (await request('/api/console/me', rt, { headers: { cookie: cookies.get(rt)! } })).json()).tenantSlug, rt.slug);
    assert.equal((await request('/api/console/me', rt, { headers: { cookie: cookies.get(rt === a ? b : a)! } })).status, 401);
    assert.equal((await request('/', rt)).headers.get('location'), '/console/');
    for (const url of ['/guide.html', '/try', '/api/sandbox', '/api/sandbox/end', '/api/sandbox/wechat/code', '/wx/fixture/pay/same-order'])
      assert.equal((await request(url, rt, { method: url.startsWith('/api/sandbox') ? 'POST' : 'GET' })).status, 404, url);
    assert.equal((await request('/healthz', rt)).status, 200);
    const secret = accountsByTenant.get(rt)!;
    const message = Buffer.from(secret.echo),
      length = Buffer.alloc(4);
    length.writeUInt32BE(message.length);
    const plain = Buffer.concat([randomBytes(16), length, message, Buffer.from('fixture-corp')]);
    const pad = 32 - (plain.length % 32);
    const cipher = createCipheriv('aes-256-cbc', secret.aes, secret.aes.subarray(0, 16));
    cipher.setAutoPadding(false);
    const echo = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
    const signature = createHash('sha1').update([secret.token, '1', 'nonce', echo].sort().join('')).digest('hex');
    const query = new URLSearchParams({ echostr: echo, msg_signature: signature, timestamp: '1', nonce: 'nonce' });
    for (const callback of ['/wecom/callback/main', '/wecom/callback']) {
      assert.equal(await (await request(`${callback}?${query}`, rt)).text(), secret.echo);
      assert.equal((await request(`${callback}?${query}`, rt === a ? b : a)).status, 404);
    }
  }
  // 两个方向各用一组同 id 订单，先付的一边不能改变另一边的未付款状态。
  for (const [id, first, other] of [
    ['same-order', a, b],
    ['same-order-reverse', b, a],
  ] as const) {
    for (const rt of [a, b]) {
      const pending = await (await request(`/api/orders/${id}`, rt)).json();
      assert.equal(pending.status, 'pending_payment');
      assert.equal(pending.totalPrice, (originalPrice + (rt === b ? 777 : 0)) * orderSeed.travelers);
    }
    const paid = await request(`/api/orders/${id}/pay`, first, { method: 'POST' });
    assert.equal(paid.status, 200);
    const paidOrder = (await paid.json()).order;
    assert.equal(paidOrder.status, 'paid');
    assert.equal(paidOrder.totalPrice, (originalPrice + (first === b ? 777 : 0)) * orderSeed.travelers);
    const untouched = await (await request(`/api/orders/${id}`, other)).json();
    assert.equal(untouched.status, 'pending_payment');
    assert.equal(untouched.paidAt, null);
    const otherPaid = await request(`/api/orders/${id}/pay`, other, { method: 'POST' });
    assert.equal(otherPaid.status, 200);
    assert.equal((await otherPaid.json()).order.status, 'paid');
  }
  assert.equal((await request('/api/chat', b, { method: 'POST' })).status, 404);
  for (const url of [
    '/chat.html',
    `/api/sessions/${same}`,
    '/api/admin/stream',
    '/api/sessions',
    '/api/orders',
    '/api/admin/status',
    '/api/usage',
    '/admin.html',
    '/kf-qr.png',
    '/api/insights',
    `/api/sessions/${same}/suggestions`,
  ])
    assert.equal((await request(url, b)).status, 404, url);
  assert.equal((await request('/chat.html', a)).status, 200);
  assert.equal((await request('/api/sessions', a)).status, 200);
  assert.equal((await request('/api/orders', a)).status, 200);
  assert.equal((await request(`/api/proposal/${unique.id}`, a)).status, 404);
  assert.equal((await request(`/api/proposal/${unique.id}`, b)).status, 200);
  const webA = tap(await request('/api/web/same-web/events', a, { headers: { cookie: webCookies.get(a)! } }));
  const webB = tap(await request('/api/web/same-web/events', b, { headers: { cookie: webCookies.get(b)! } }));
  await inside(a, () => web.webAdapter.push(webIds.get(a)!, 'only-web-a'));
  await inside(b, () => web.webAdapter.push(webIds.get(b)!, 'only-web-b'));
  await until(() => webA.text.includes('only-web-a') && webB.text.includes('only-web-b'), '网页 SSE 各自收到推送');
  assert.doesNotMatch(webA.text, /only-web-b/);
  assert.doesNotMatch(webB.text, /only-web-a/);
  for (const owner of ['a', 'b']) assert.equal(requests.filter((req) => req.owner === owner).length, 3, `${owner} 两轮对话加一轮网页请求`);
  for (const req of requests) {
    const rt = req.owner === 'a' ? a : b;
    assert.equal(sha(req.system), expected.get(rt)!.system);
    assert.equal(sha(req.tools), expected.get(rt)!.tools);
    assert.doesNotMatch(req.wire, rt === a ? /山海/ : /云途/);
  }
  for (const rt of [a, b]) {
    const received = usageSeen.filter((record) => record.subscriber === rt);
    assert.equal(received.length, 3, '各租户用量恰为两轮对话加一轮网页请求');
    for (const record of received) {
      assert.equal(record.actual, rt);
      assert.equal(record.event.tenantId, rt.id);
      assert.ok([same, webIds.get(rt)!].includes(record.event.sessionId!));
    }
  }
  for (const record of pushesSeen) {
    assert.equal(record.actual, record.subscriber);
    assert.equal(record.text, record.subscriber.slug);
  }
  // 真实数据库里的重复 id 同样只经各自的 RLS 可见。
  const persisted = await su<{ tenant_id: string; id: string }>('select tenant_id, id from conversations where id=$1', [same]);
  assert.equal(persisted.length, 2);
  for (const rt of [a, b]) {
    await inside(rt, () => store.flushSession(same));
    const rows = await testing.readStoredConversations(t, rt.id);
    assert.equal(rows.get(same)!.session!.profile.nickname, rt.slug);
  }
  for (const url of [
    '/pay/same-order',
    '/api/orders/same-order',
    `/proposal/${sharedRoute}`,
    '/privacy',
    '/w/same-web',
    '/wecom/callback',
    '/console/',
    '/',
    '/chat.html',
    '/api/console/entry',
  ])
    assert.equal((await app.request(url, { headers: { host: 'unknown.example.invalid' } })).status, 404, url);
  assert.equal((await app.request('/healthz', { headers: { host: 'unknown.example.invalid' } })).status, 200);
  // 删除一边必须物理关闭其流；另一边继续收事件。单个订阅的 drop 覆盖登记表实际接线。
  // 即使调用者带 A 的作用域，B Host 与未知 Host 仍分别选择 B、返回 404。
  assert.equal((await (await inside(a, () => request('/api/orders/same-order', b))).json()).routeTitle, b.slug);
  assert.equal((await inside(a, () => app.request('/', { headers: { host: 'unknown.example.invalid' } }))).status, 404);
  state.dropTenantState(b.id);
  for (const [name, count] of Object.entries(state.tenantKeys(b.id))) assert.equal(count, 0, `${name} 在 drop B 后无残留`);
  await until(() => consoleB.done && webB.done, 'B console 物理连接关闭');
  assert.equal(consoleA.done, false);
  inside(a, () => events.deliverCommitted([{ type: 'conversation.changed', id: 'after-b-drop' }]));
  await until(() => consoleA.text.includes('after-b-drop'), 'A 在 B 删除后照常服务');
  const backendA = a.store.pgBackend!;
  await inside(a, () => store.drainStore(5000));
  assert.ok(backendA.stats().commits > 0);
  state.resetTenantState();
  assert.ok(
    Object.values(backendA.stats()).every((value) => value === 0),
    'PG reset 清掉所有累计统计',
  );
  state.dropTenantState(a.id);
  await until(() => consoleA.done && simulatorA.done && adminA.done && webA.done, 'A console 与 simulator 物理连接关闭');
  for (const rt of [a, b]) assert.equal(state.tenantKeys(rt.id)['channels.accounts'], 0);
  const envAccount = accounts.envAccountFrom(
    { WECOM_CORP_ID: 'fixture-corp', WECOM_APP_SECRET: 'fixture', WECOM_KF_OPEN_KFID: 'fixture-kf' },
    '',
  )!;
  accounts.installAccounts([envAccount]);
  assert.equal(state.tenantKeys(a.id)['channels.accounts'], 1, '空 tenantId 的 env 账号归宿主');
  assert.equal(state.tenantKeys(b.id)['channels.accounts'], 0);
  state.dropTenantState(a.id);
  assert.equal(accounts.loadedAccounts().length, 0, '宿主 drop 必须实际删除 env 账号');
  assert.equal(state.tenantKeys(a.id)['channels.accounts'], 0);
  console.log('TENANT ISOLATION PASS: A/B 同 id / 品牌与价格 / 6 个 HTTP 模型前缀 / 日志 / SSE 物理关闭 / 公开路由表');
} finally {
  globalThis.fetch = originalFetch;
  channels.__channelsTest.setObservationClock(null);
  releaseB();
  for (const rt of [a, b]) state.dropTenantState(rt.id);
  for (const stream of streams) {
    await stream.reader.cancel().catch(() => {});
    await stream.pump.catch(() => {});
  }
  for (const rt of [a, b]) {
    await inside(rt, () => rt.store.pgBackend?.close());
    await inside(rt, config.closeConfig);
    state.dropTenantState(rt.id);
    r.unregisterRuntime(rt.id);
  }
  channels.__channelsTest.stopStatsRefresh();
  await t.close();
  await new Promise<void>((resolve) => {
    model.closeAllConnections();
    model.close(() => resolve());
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// 真 PG 验证重复会话/订单/key 的 RLS；使用协调者提供的一次性集群，在其中建独立测试库。
if (process.env.PG_TEST_URL) {
  const { openDb, withTenant } = await import('../db/client.js');
  const pg = await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: 'isolation-a' });
  const conn = await openDb(pg.urls.app);
  try {
    const second = (
      await pg.query<{ id: string }>("insert into tenants (slug,name,pack_id) values ('isolation-b','B','travel') returning id")
    )[0]!;
    const ids = [pg.tenantId, second.id];
    for (const id of ids) {
      await pg.query(
        "insert into conversations (tenant_id,id,channel,stage,handed_over,state,ref,created_at,updated_at) values ($1,$2,'wecom','greeting',false,$3,$4,now(),now())",
        [id, same, JSON.stringify({ id: same, profile: { nickname: id } }), randomUUID()],
      );
      await pg.query(
        "insert into orders (tenant_id,id,session_id,route_id,status,total_price,created_at,data) values ($1,'same-order',$2,'fixture-route','pending_payment',100,now(),$3)",
        [id, same, JSON.stringify({ id: 'same-order', routeTitle: id })],
      );
      await pg.query(
        "insert into channel_accounts (tenant_id,key,name,kind,status,settings) values ($1,'same-web',$2,'web','disabled','{}')",
        [id, id],
      );
    }
    const { readSessionBatch } = await import('../db/repo/conversations.js');
    const { listChannelAccounts } = await import('../db/repo/channel-accounts.js');
    for (const id of ids) {
      const ctx = { tenantId: id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
      await withTenant(conn.db, ctx, async (tx) => {
        const batch = await readSessionBatch(tx, null, 10);
        assert.equal(batch.rows.length, 1);
        assert.deepEqual(batch.rows[0]!.state.profile, { nickname: id });
        assert.equal(batch.orders.length, 1);
        assert.equal(batch.orders[0]!.data.routeTitle, id);
        const web = await listChannelAccounts(tx);
        assert.equal(web.length, 1);
        assert.equal(web[0]!.name, id);
      });
    }
    console.log('TENANT ISOLATION REAL PG PASS: 重复 id/key 的 FORCE RLS');
  } finally {
    await conn.close();
    await pg.drop();
  }
} else console.log('TENANT ISOLATION REAL PG: 未设 PG_TEST_URL，跳过');
