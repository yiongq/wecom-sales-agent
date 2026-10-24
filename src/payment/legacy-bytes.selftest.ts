// 旅游出口字节自测（docs/architecture/08-pack-generalization/plan.md 第 0.5 步，spec 不变量 4、5）。
// 08 把旅游从核心里搬出去，但旧版旅游单（data 里没有 v）在四类出口上的字节必须与开工时逐字节相同，旅游会话的 state json 里
// 不许出现 packState、moneyLedger。这里把它们钉成一个持久的自测：
//   一、六张固定的旧版旅游单（六个状态各一张），每张渲染四类出口：
//       pay          GET /pay/:id 的完整 HTML（online、advisor 两种收款方式各一遍）
//       api-order    GET /api/orders/:id 的响应体（R22 白名单，原样字节）
//       wecom-card   企微付款卡片的标题与摘要（adapters/wecom.ts 的 extractCard）
//       workbench    后台订单接口 GET /api/console/orders 的响应体，以及会话详情里 orders 一节（orderView；DB 模式，PGlite）
//     与夹具 legacy-bytes.fixture.json 逐字节比对，键是「出口/订单号（或会话号）/收款方式」。
//   二、mock 模型跑一轮旅游对话、落库（PGlite）后读出会话的 state json，断言没有 packState、moneyLedger（不变量 5）。
// 夹具是开工时的字节，生成一次后提交，之后不重写：任何一处比对不上都是旅游变了，不是夹具过期。
// 唯一的重写入口是环境变量 UPDATE_LEGACY_BYTES=1（只在 08 之前的基线上生成时用）。
// 随时间或随机变化的部分靠固定时钟（PARITY_CLOCK_MS，与锁定套件同一个钟）、固定订单号与固定输入消掉，比对前不做任何归一。
// 用法（钟必须钉住，/pay 与企微卡片上的出发日期跨年才带年份，取的是「今天」）：
//   PARITY_CLOCK_MS=1790913600000 npx tsx --import ./src/store/parity-clock.ts src/payment/legacy-bytes.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import type { Order, Session } from '../types.js';

// 钟没钉住就别往下跑：比对的是字节，「今天」不同字节就不同，报错信息要让人一眼看出该怎么跑
const PINNED = Number(process.env.PARITY_CLOCK_MS);
if (!Number.isSafeInteger(PINNED) || Math.abs(Date.now() - PINNED) > 60_000) {
  console.error('LEGACY BYTES SELFTEST FAIL: 时钟没有钉住。照 package.json 里的写法跑：');
  console.error('  PARITY_CLOCK_MS=1790913600000 tsx --import ./src/store/parity-clock.ts src/payment/legacy-bytes.selftest.ts');
  process.exit(1);
}

enterTenantScopeForTest(hostRuntime());
// store.ts 在模块加载时就读 VAR_DIR：先指到临时目录再动态 import
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-legacy-bytes-'));
process.env.VAR_DIR = VAR_DIR;
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微
for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[k] = '';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------- 种子：六张固定的旧版旅游单（没有 data.v），五个会话 ----------------
// 时间一律写死成毫秒；线路用 data/routes.json 里已有的。会话 S1 里一张被替代、一张是替代它的待付款单（同会话改了人数重新下单）
const at = (iso: string): number => Date.parse(iso);
const oid = (n: number): string => `ord_c0ffee${'0'.repeat(17)}${n}`;
const ID = { superseded: oid(1), pending: oid(2), paid: oid(3), cancelled: oid(4), refundPending: oid(5), refunded: oid(6) };
const SID = {
  s1: 'wecom:wmLegacy01',
  s2: 'wecom:wmLegacy02',
  s3: 'wecom:wmLegacy03',
  s4: 'wecom:wmLegacy04',
  s5: 'wecom:wmLegacy05',
};
const ADVISOR = { userId: null, name: '共享工作台' };

const ORDERS: Order[] = [
  {
    id: ID.superseded,
    sessionId: SID.s1,
    routeId: 'r-yunnan-mid',
    routeTitle: '云南 丽江大理·洱海古城 6 日',
    travelers: 2,
    departDate: '2026-11-12',
    totalPrice: 33600,
    status: 'superseded',
    createdAt: at('2026-09-28T02:10:00Z'),
    supersededBy: ID.pending,
    catalogVersion: 1,
  },
  {
    id: ID.pending,
    sessionId: SID.s1,
    routeId: 'r-yunnan-mid',
    routeTitle: '云南 丽江大理·洱海古城 6 日',
    travelers: 3,
    departDate: '2026-11-12',
    totalPrice: 50400,
    status: 'pending_payment',
    createdAt: at('2026-09-28T02:40:00Z'),
    catalogVersion: 1,
  },
  {
    // 已确认价格的一张：顾问确认价格、再确认收款（advisor 收款方式），标记已付时会话转过人工
    id: ID.paid,
    sessionId: SID.s2,
    routeId: 'r-sichuan-mid',
    routeTitle: '四川 成都熊猫·九寨黄龙 6 日亲子',
    travelers: 4,
    departDate: '2026-10-24',
    totalPrice: 79200,
    status: 'paid',
    createdAt: at('2026-09-26T06:00:00Z'),
    paidAt: at('2026-09-27T03:30:00Z'),
    handoffBeforePaid: true,
    catalogVersion: 2,
    confirmedAt: at('2026-09-26T08:00:00Z'),
    confirmedBy: ADVISOR,
    paidMarkedBy: ADVISOR,
  },
  {
    // 出发日期跨年：/pay 与企微卡片要带年份
    id: ID.cancelled,
    sessionId: SID.s3,
    routeId: 'r-xian',
    routeTitle: '西安 兵马俑·大唐不夜城 5 日',
    travelers: 2,
    departDate: '2027-01-05',
    totalPrice: 25600,
    status: 'cancelled',
    createdAt: at('2026-09-25T09:00:00Z'),
    cancelReason: '客户改期，重新下单',
  },
  {
    id: ID.refundPending,
    sessionId: SID.s4,
    routeId: 'r-sanya',
    routeTitle: '三亚亲子奢华度假 5 日',
    travelers: 3,
    departDate: '2026-12-20',
    totalPrice: 47400,
    status: 'refund_pending',
    createdAt: at('2026-09-20T01:00:00Z'),
    paidAt: at('2026-09-20T02:00:00Z'),
    handoffBeforePaid: false,
    refund: {
      id: 'rf_c0ffee000005',
      requestedAt: at('2026-09-29T04:00:00Z'),
      daysBefore: 82,
      tierId: 'd30',
      percent: 100,
      amount: 47400,
      policyHash: '0'.repeat(64),
      approval: 'pending',
      settlement: 'advisor',
    },
  },
  {
    id: ID.refunded,
    sessionId: SID.s5,
    routeId: 'r-japan',
    routeTitle: '日本京都东京美学之旅 7 日',
    travelers: 2,
    departDate: '2026-10-30',
    totalPrice: 65600,
    status: 'refunded',
    createdAt: at('2026-09-18T01:00:00Z'),
    paidAt: at('2026-09-18T02:00:00Z'),
    handoffBeforePaid: false,
    refund: {
      id: 'rf_c0ffee000006',
      requestedAt: at('2026-09-22T04:00:00Z'),
      daysBefore: 38,
      tierId: 'd30',
      percent: 100,
      amount: 65600,
      policyHash: '0'.repeat(64),
      approval: 'approved',
      settlement: 'advisor',
      decision: { at: at('2026-09-22T05:00:00Z'), by: ADVISOR },
      settled: { at: at('2026-09-23T05:00:00Z'), by: ADVISOR },
    },
  },
];

function seedSession(
  id: string,
  o: { stage: Session['stage']; orders: Order[]; dest: string; people: string; dates: string; budget: string },
): Session {
  const base = at('2026-09-18T01:00:00Z');
  return {
    id,
    channel: 'wecom',
    stage: o.stage,
    profile: { destinationInterest: o.dest, travelers: o.people, dates: o.dates, budget: o.budget, nickname: '旅客' },
    messages: [
      { role: 'customer', content: `想去${o.dest}，${o.people}，${o.dates}`, at: base, msgid: `mid-${id}-1`, sentAt: base - 1000 },
      { role: 'agent', content: '好的，我先帮您看看合适的线路。', at: base + 5000 },
    ],
    orderIds: o.orders.map((x) => x.id),
    handedOver: false,
    createdAt: base,
    updatedAt: Math.max(...o.orders.map((x) => x.paidAt ?? x.createdAt)),
  };
}
const SESSIONS: Session[] = [
  seedSession(SID.s1, {
    stage: 'closing',
    orders: ORDERS.slice(0, 2),
    dest: '云南',
    people: '3 位',
    dates: '11月12日',
    budget: '每人 1.8 万',
  }),
  seedSession(SID.s2, { stage: 'paid', orders: [ORDERS[2]!], dest: '四川', people: '4 位', dates: '10月24日', budget: '每人 2 万' }),
  seedSession(SID.s3, { stage: 'objection', orders: [ORDERS[3]!], dest: '西安', people: '2 位', dates: '1月5日', budget: '每人 1.3 万' }),
  seedSession(SID.s4, { stage: 'paid', orders: [ORDERS[4]!], dest: '三亚', people: '3 位', dates: '12月20日', budget: '每人 1.6 万' }),
  seedSession(SID.s5, { stage: 'paid', orders: [ORDERS[5]!], dest: '日本', people: '2 位', dates: '10月30日', budget: '每人 3.3 万' }),
];

// ---------------- 装配：DB 模式（配置与会话存储都在 PGlite 上），种子写进库、再经启动预载进内存 ----------------
const { openTestDb, installSeededConfig, installPgSessionStore } = await withoutTenantScope(() => import('../db/testing.js'));
const accounts = await withoutTenantScope(() => import('../auth/accounts.js'));
const authSession = await withoutTenantScope(() => import('../auth/session.js'));
const { withTenant } = await withoutTenantScope(() => import('../db/client.js'));
const { writeSeedSessions } = await withoutTenantScope(() => import('../cli/session-transfer.js'));
const { __profileTest } = await withoutTenantScope(() => import('../profile.js'));

const t = await openTestDb();
await installSeededConfig(t);
const OWNER = { email: 'owner-legacy@example.com', password: 'owner-legacy-password' };
await t.pg.exec('SET ROLE agent_platform');
try {
  const made = await accounts.createUser(t.db, {
    tenantSlug: 'demo',
    email: OWNER.email,
    name: '老板',
    role: 'owner',
    password: async () => OWNER.password,
  });
  check('装配：建后台账号（owner）', made.code === 0, made.message);
} finally {
  await t.pg.exec('SET ROLE agent_app');
}
const fx = await installPgSessionStore(t, { varDir: VAR_DIR });
await withTenant(t.db, { tenantId: fx.deps.tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } }, (tx) =>
  writeSeedSessions(tx, SESSIONS, ORDERS),
);
const store = await withoutTenantScope(() => import('../store.js'));
await store.initSessionStore(fx.deps);
check('装配：会话存储是 db', store.sessionStoreMode() === 'db');
check(
  '装配：六张种子单经预载进了内存，且都是旧版旅游单（没有 data.v）',
  ORDERS.every((o) => store.getOrder(o.id)?.status === o.status && !('v' in (store.getOrder(o.id) as object))),
);

const { app } = await withoutTenantScope(() => import('../server.js'));
const { __test: wecomTest } = await withoutTenantScope(() => import('../adapters/wecom.js'));

// 后台登录：与 console.selftest.ts 的 db 子进程同一套（走真实的登录接口，拿会话 cookie）
const loginBody = JSON.stringify({ email: OWNER.email, password: OWNER.password });
const login = await app.request('/api/console/auth/login', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(loginBody)),
    'x-forwarded-for': '203.0.113.201',
  },
  body: loginBody,
});
const loginText = await login.text();
const token = new RegExp(`^${authSession.SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
check('装配：后台登录成功', login.status === 200 && token !== '', `${login.status} ${loginText.slice(0, 120)}`);
const consoleGet = async (url: string): Promise<{ status: number; text: string }> => {
  const res = await app.request(`/api/console${url}`, {
    headers: { cookie: `${authSession.SESSION_COOKIE}=${token}`, 'x-forwarded-for': '203.0.113.250' },
  });
  return { status: res.status, text: await res.text() };
};

// ---------------- 渲染四类出口 ----------------
type Mode = 'online' | 'advisor';
const MODES: readonly Mode[] = ['online', 'advisor'];
/** online 是 demo profile 的默认（mock_pay 开）；advisor 关掉 mock_pay。跑完照常还原 */
async function inMode<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  if (mode === 'advisor') __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
  else __profileTest.reset();
  try {
    return await fn();
  } finally {
    __profileTest.reset();
  }
}

const actual: Record<string, string> = {};
const BASE = 'https://shop.example.test';
let ipN = 0;
for (const mode of MODES) {
  await inMode(mode, async () => {
    for (const o of ORDERS) {
      const key = (exit: string): string => `${exit}/${o.id}/${mode}`;
      // /pay/<id>：整页 HTML
      const pay = await app.request(`/pay/${o.id}`);
      check(`${key('pay')}：200`, pay.status === 200, String(pay.status));
      actual[key('pay')] = await pay.text();
      // /api/orders/:id：原样字节。每次换一个来源地址，不碰查询限流
      ipN += 1;
      const api = await app.request(`/api/orders/${o.id}`, { headers: { 'x-forwarded-for': `198.51.100.${ipN}` } });
      check(`${key('api-order')}：200`, api.status === 200, String(api.status));
      actual[key('api-order')] = await api.text();
      // 企微付款卡片：正文里一条支付链接，取标题与摘要
      const card = wecomTest.extractCard(`您的专属支付链接：${BASE}/pay/${o.id}`, BASE);
      check(`${key('wecom-card')}：认得出支付链接`, card !== null);
      actual[key('wecom-card')] = JSON.stringify({ title: card?.title, desc: card?.desc });
      // 后台订单接口：按状态过滤，每个状态只有这一张
      const wb = await consoleGet(`/orders?status=${o.status}`);
      check(`${key('workbench-orders')}：200`, wb.status === 200, `${wb.status} ${wb.text.slice(0, 120)}`);
      actual[key('workbench-orders')] = wb.text;
    }
    const all = await consoleGet('/orders?limit=100');
    check(`workbench-orders/all/${mode}：200`, all.status === 200, `${all.status} ${all.text.slice(0, 120)}`);
    actual[`workbench-orders/all/${mode}`] = all.text;
    // 会话详情（工作台 J 页）里的订单卡：取 orders 一节。JSON.parse 再 stringify 键序不变、无多余空白，与响应体里那一段逐字节相同
    for (const s of SESSIONS) {
      const d = await consoleGet(`/conversations/${encodeURIComponent(s.id)}`);
      check(`workbench-session-orders/${s.id}/${mode}：200`, d.status === 200, `${d.status} ${d.text.slice(0, 120)}`);
      const orders = (JSON.parse(d.text) as { orders?: unknown }).orders;
      check(`workbench-session-orders/${s.id}/${mode}：详情里有 orders`, Array.isArray(orders));
      actual[`workbench-session-orders/${s.id}/${mode}`] = JSON.stringify(orders);
    }
  });
}

// ---------------- 与夹具比对（或重写夹具） ----------------
const FIXTURE = fileURLToPath(new URL('./legacy-bytes.fixture.json', import.meta.url));

/** 两段文本第一处不同的位置：行、列与两边各一小段（JSON 转义后打印，换行、空白都看得见） */
function firstDiff(expected: string, got: string): string {
  const n = Math.min(expected.length, got.length);
  let i = 0;
  while (i < n && expected[i] === got[i]) i += 1;
  const before = expected.slice(0, i);
  const line = before.split('\n').length;
  const col = i - (before.lastIndexOf('\n') + 1) + 1;
  const show = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `第 ${line} 行第 ${col} 列（字符偏移 ${i}；夹具 ${expected.length} 字符、实际 ${got.length} 字符）夹具 ${show(expected)} ≠ 实际 ${show(got)}`;
}

if (process.env.UPDATE_LEGACY_BYTES === '1') {
  fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
  console.log(
    `LEGACY BYTES FIXTURE WRITTEN: ${Object.keys(actual).length} 条（UPDATE_LEGACY_BYTES=1）。夹具只在 08 开工基线上生成一次，别的时候不要重写`,
  );
} else {
  let fixture: Record<string, string> = {};
  try {
    fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
  } catch (e) {
    check('夹具：能读到 legacy-bytes.fixture.json', false, e instanceof Error ? e.message : String(e));
  }
  const want = Object.keys(fixture);
  const got = Object.keys(actual);
  check('夹具：键的个数', want.length === got.length, `夹具 ${want.length} 条、实际 ${got.length} 条`);
  for (const k of want) {
    if (!(k in actual)) check(`夹具：${k}`, false, '实际没有渲染出这一条');
  }
  for (const k of got) {
    if (!(k in fixture)) check(`夹具：${k}`, false, '夹具里没有这一条');
    else check(`字节：${k}`, fixture[k] === actual[k], firstDiff(fixture[k]!, actual[k]!));
  }
}

// ---------------- 不变量 5：旅游会话落库后的 state json 里没有 packState、moneyLedger ----------------
// 放在出口渲染之后：mock 一轮对话可能下单，不能混进上面按状态过滤的订单列表
{
  const { handleMessage } = await withoutTenantScope(() => import('../engine.js'));
  const sid = 'wecom:wmLegacyTurn';
  const r1 = await handleMessage(sid, '你好，想带爸妈去云南玩，3个人，预算每人2万', 'wecom');
  const r2 = await handleMessage(sid, '十一月十二号出发，帮我报个价', 'wecom');
  check('state：mock 对话有回复', r1.text.length > 0 && r2.text.length > 0);
  await store.flushSession(sid, { timeoutMs: 10_000 });
  const rows = await t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE'); // 以超级用户读，绕开 RLS；角色只在这个事务里换
    return (
      await tx.query<{ state: Record<string, unknown> }>('select state from conversations where tenant_id = $1 and id = $2', [
        fx.deps.tenantId,
        sid,
      ])
    ).rows;
  });
  const state = rows[0]?.state;
  check('state：会话落库了', state !== undefined && state.id === sid);
  if (state) {
    check(
      'state：确是旅游会话的 state（有阶段、画像、订单号列表）',
      typeof state.stage === 'string' && typeof state.profile === 'object' && Array.isArray(state.orderIds),
    );
    check('state：没有 packState', !('packState' in state), Object.keys(state).join(','));
    check('state：没有 moneyLedger', !('moneyLedger' in state), Object.keys(state).join(','));
  }
}

if (fails.length) {
  console.error(`LEGACY BYTES SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `LEGACY BYTES SELFTEST PASS: ${pass} 项断言全通（${Object.keys(actual).length} 条出口字节与夹具逐字节相同；旅游会话 state json 无 packState、moneyLedger）`,
);
