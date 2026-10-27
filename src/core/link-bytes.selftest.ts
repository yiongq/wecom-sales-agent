// 09 第 0 步：在开工基线上生成一次，之后只比字节，不归一输出、不随实现更新夹具。
// 位于 core：同时守住旅游的企微卡片、网页 message-parts 与沙箱公开资源三条消费路径。
// UPDATE_LINK_BYTES=1 是唯一生成入口；钟与 legacy-bytes 相同，发送 msgid 的随机源也在发送期间固定。
// env 经 wecomAdapter.push → sendRich；DB 经同一公开入口 → pushDb → payloadsFor，捕获完整 send_msg JSON。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Order, Session } from '../types.js';
import { hostRuntime, withoutTenantScope, createTenantRuntime, registerRuntime, unregisterRuntime } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

assert.ok(
  process.env.PARITY_CLOCK_MS === '1790913600000' && Math.abs(Date.now() - 1790913600000) < 60000,
  '必须使用 package.json 中的固定时钟命令',
);
const parent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, 'wecom-link-bytes-'));
const BASE = 'https://shop.example.test';
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SERVER_SELFTEST: '1',
  FOLLOWUP_ENABLED: '',
  ALERT_WEBHOOK_URL: '',
  PUBLIC_BASE_URL: BASE,
  WECOM_CORP_ID: 'selftest-corp',
  WECOM_APP_SECRET: 'selftest-secret',
  WECOM_KF_OPEN_KFID: 'selftest-kf',
});
enterTenantScopeForTest(hostRuntime());
const uid = 'wmLinkBytes';
const sid = `wecom:${uid}`;
const order: Order = {
  id: 'ord_c0ffee000000000000000009',
  sessionId: sid,
  routeId: 'r-yunnan-mid',
  routeTitle: '云南 丽江大理·洱海古城 6 日',
  travelers: 3,
  departDate: '2027-01-05',
  totalPrice: 50400,
  status: 'pending_payment',
  createdAt: Date.now(),
  catalogVersion: 1,
};
const session: Session = {
  id: sid,
  channel: 'wecom',
  stage: 'closing',
  profile: {},
  messages: [],
  orderIds: [order.id],
  handedOver: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify([order]));
fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([session]));

const sent: unknown[] = [];
const realFetch = globalThis.fetch;
// 严格封闭 mock：任何未登记端点都抛错，绝不退回真实网络。
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.hostname, 'qyapi.weixin.qq.com');
  const ep = url.pathname.replace(/^\/cgi-bin\//, '');
  const response = (value: unknown): Response => Response.json(value);
  if (ep === 'gettoken') return response({ errcode: 0, access_token: 'selftest-token', expires_in: 7200 });
  if (ep === 'media/upload') return response({ errcode: 0, media_id: 'selftest-thumb' });
  if (ep === 'kf/sync_msg') return response({ errcode: 0, next_cursor: 'fixed-cursor', has_more: 0, msg_list: [] });
  if (ep === 'kf/send_msg') {
    sent.push(JSON.parse(String(init?.body)));
    return response({ errcode: 0 });
  }
  throw new Error(`未模拟的企微端点：${ep}`);
}) as typeof fetch;

const store = await withoutTenantScope(() => import('../store.js'));
const wecom = await withoutTenantScope(() => import('../adapters/wecom.js'));
const { partsOf } = await import('./message-parts.js');
const { wxPage, wxResource, sandboxWechatIndex } = await import('../tenancy/sandbox/outbound.js');
const { sandboxApp } = await import('../tenancy/sandbox/process.js');
const { Hono } = await import('hono');
// store 的退出写盘钩子之后清理。
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const proposal = '/proposal/r-yunnan-mid/3/2027-01-05';
const texts = {
  order: `您的支付链接：${BASE}/pay/${order.id}`,
  proposal: `详细方案发您看看：${BASE}${proposal}`,
  site: `隐私说明：${BASE}/privacy`,
  'two-links': `方案书：${BASE}${proposal}\n支付链接：${BASE}/pay/${order.id}`,
  'proposal-v1': `方案书：${BASE}${proposal}?v=1`,
  'no-link': '好的，我们按这个时间安排。',
  'card-only-order': `${BASE}/pay/${order.id}`,
  'card-only-proposal': `${BASE}${proposal}`,
  'relative-order': `支付链接：/pay/${order.id}`,
  'relative-proposal': `方案书：${proposal}?v=1`,
  'proposal-missing-version': `方案书：${BASE}${proposal}?v=999`,
  'foreign-link': '请查看 https://other.example.test/privacy',
};
const actual: Record<string, string> = {};
let checks = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  checks++;
};
async function capture(mode: 'env' | 'db'): Promise<void> {
  check(`${mode}：经 routeForProposal 能抽出旅游方案版本 1`, wecom.__test.extractCard(texts['proposal-v1'], BASE) !== null);
  // 只在发送段固定随机源；所有完整载荷字段（包括 msgid、图片）原样进入夹具。
  const randomBytes = crypto.randomBytes;
  let serial = 0;
  crypto.randomBytes = ((size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++serial, size - 4);
    return bytes;
  }) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  try {
    for (const [name, text] of Object.entries(texts)) {
      actual[`${mode}/extract/${name}`] = JSON.stringify(wecom.__test.extractCard(text, BASE));
      actual[`${mode}/parts/${name}`] = JSON.stringify(partsOf(text, BASE));
      for (const kind of ['ai', 'human'] as const) {
        sent.length = 0;
        check(`${mode}/${name}/${kind}：发送成功`, await wecom.wecomAdapter.push(sid, text, { kind }));
        check(`${mode}/${name}/${kind}：有发送载荷`, sent.length > 0);
        actual[`${mode}/send/${kind}/${name}`] = JSON.stringify(sent);
      }
    }
  } finally {
    crypto.randomBytes = randomBytes;
    syncBuiltinESMExports();
  }
}

const reg = await withoutTenantScope(() => import('../channels/registry.js'));
let closeDb: (() => Promise<void>) | undefined;
try {
  await capture('env');
  await store.drainStore(5000);
  await wecom.__test.resetForTest();
  // env 已排空；下方 DB 从同一组合成种子导入，不把文件内存会话当作未迁移数据带过去。
  store.forgetSession(sid);
  const testing = await withoutTenantScope(() => import('../db/testing.js'));
  const t = await testing.openTestDb();
  closeDb = () => t.close();
  await testing.installSeededConfig(t);
  const dbDir = path.join(dir, 'db');
  fs.mkdirSync(dbDir);
  const fx = await testing.installPgSessionStore(t, { varDir: dbDir });
  const { withTenant } = await import('../db/client.js');
  const { writeSeedSessions } = await import('../cli/session-transfer.js');
  await withTenant(t.db, { tenantId: fx.deps.tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } }, (tx) =>
    writeSeedSessions(tx, [session], [order]),
  );
  await store.initSessionStore(fx.deps);
  const { sealSecrets } = await import('../channels/secrets.js');
  const key = Buffer.alloc(32, 9);
  const keyRing = { current: { id: 'link-test', key }, all: new Map([['link-test', key]]) };
  const accountId = crypto.randomUUID();
  const { ct, keyId } = sealSecrets(
    keyRing,
    { tenantId: fx.deps.tenantId, accountId },
    {
      appSecret: 'selftest-secret',
      callbackToken: 'selftest-callback',
      callbackAesKey: Buffer.alloc(32, 7).toString('base64').slice(0, 43),
    },
  );
  await t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    await tx.query(
      `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
      values ($1, $2, 'link', 'wecom_kf', '字节基准', 'active', 'wecom:', 'selftest-corp', 'selftest-kf', decode($3, 'hex'), $4)`,
      [fx.deps.tenantId, accountId, ct.toString('hex'), keyId],
    );
  });
  await reg.initChannels({ ...fx.deps, keyRing });
  reg.startChannels();
  await capture('db');
  await store.drainStore(5000);
  reg.__channelsTest.reset();

  // 用真实 process.ts 中间件核验资源放行：只有链接 cookie，resolve 永远 invalid，哨兵路由只会在白名单路径到达。
  const rt = createTenantRuntime({
    id: 'link-byte-sandbox',
    slug: 'link-byte-sandbox',
    kind: 'sandbox',
    publicBase: BASE,
    expiresAt: Date.now() + 3600000,
  });
  rt.pack = hostRuntime().pack;
  registerRuntime(rt);
  const token = 'L'.repeat(43);
  sandboxWechatIndex.publishLink(rt, token);
  const routes = new Hono().all('*', (c) => c.json({ allowed: true }));
  const app = sandboxApp(
    {
      health: async () => {
        throw new Error('不检查健康状态');
      },
      resolve: async () => ({ status: 'invalid' as const }),
      provision: async () => {
        throw new Error('不创建沙箱');
      },
      end: async () => {},
    },
    'shop.example.test',
    routes,
  );
  const paths = [
    '/privacy',
    `/pay/${order.id}`,
    proposal,
    '/proposal/r-yunnan-mid',
    `/api/orders/${order.id}`,
    '/api/proposal/r-yunnan-mid',
    `/api/orders/${order.id}/pay`,
    '/quote/ord_fixture',
    '/api/quotes/ord_fixture',
    '/api/orders',
    '/api/proposal/r-yunnan-mid/extra',
    '/privacy/extra',
    `/pay/${order.id}/extra`,
    '/proposal',
    '/unknown',
    '/pay/bad.id',
    '/pay/a%2Fb',
  ];
  try {
    for (const p of paths) {
      actual[`sandbox/page/${p}`] = JSON.stringify(wxPage(p));
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const allowed = wxResource(p, method);
        actual[`sandbox/outbound/${method} ${p}`] = JSON.stringify(allowed);
        const res = await app.request(`https://shop.example.test${p}`, {
          method,
          headers: { host: 'shop.example.test', cookie: `__Host-sbxw=${token}` },
        });
        actual[`sandbox/process/${method} ${p}`] = JSON.stringify({ status: res.status, location: res.headers.get('location') });
        check(`沙箱 ${method} ${p}：两条路径判定相同`, (res.status === 200) === allowed);
      }
    }
  } finally {
    sandboxWechatIndex.drop(rt.id);
    unregisterRuntime(rt.id);
  }

  const fixturePath = fileURLToPath(new URL('./link-bytes.fixture.json', import.meta.url));
  if (process.env.UPDATE_LINK_BYTES === '1') {
    fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n');
    console.log(`LINK BYTES FIXTURE WRITTEN: ${Object.keys(actual).length} 条（仅在 09 开工基线生成一次）`);
  } else {
    const expected = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(actual), Object.keys(expected), '具名基准集合必须相同');
    for (const [name, bytes] of Object.entries(actual)) {
      assert.equal(bytes, expected[name], `字节：${name}`);
      checks++;
    }
    console.log(`LINK BYTES SELFTEST PASS: ${Object.keys(actual).length} 条字节基准，${checks} 项断言`);
  }
} finally {
  reg.__channelsTest.reset();
  await wecom.__test.resetForTest();
  await store.drainStore(5000);
  await closeDb?.();
  globalThis.fetch = realFetch;
}
