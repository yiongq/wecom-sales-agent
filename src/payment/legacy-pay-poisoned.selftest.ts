// 旧接口 POST /api/orders/:id/pay 在 poisoned 会话上的行为（第 15 步审查第 2 条）：真超时（仍可能提交）照发付款确认；
// poisoned / 冲突（不会再提交）不调 notifyPaid、回 503 store_lagging，和 markPaidByAdvisor 的 awaitCommit 同一套。
// 独立成一个文件：要装 PG 会话存储（PGlite）才能真的把一个会话写成 poisoned，装完这个进程里所有真实会话都会走 PG 这条路，
// 与 src/payment/orders.selftest.ts 的文件存储场景混在一起跑会相互污染，所以单独一个干净进程。
// 用法：npx tsx src/payment/legacy-pay-poisoned.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-s15-poisoned-'));
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'selftest-pass';
for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[k] = '';

const { app } = await import('../server.js');
const store = await import('../store.js');
const { loadRoutes } = await import('../tools.js');
const { openTestDb, installPgSessionStore, fakeDbError } = await import('../db/testing.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const route = loadRoutes().find((r) => r.itinerary?.length)!;
const t = await openTestDb();
const fx = await installPgSessionStore(t, { slug: 'demo', varDir: process.env.VAR_DIR! });
await store.initSessionStore(fx.deps);

// ---- poisoned：markOrderPaid 已经在内存生效，但那次落库是数据类错误（不会再提交）→ 503，不调 notifyPaid ----
{
  const sid = 'wecom:wmS15Poisoned';
  const s = store.getOrCreateSession(sid, 'wecom');
  const o = store.createOrder({
    sessionId: sid,
    routeId: route.id,
    routeTitle: route.title,
    travelers: 2,
    departDate: '2026-12-10',
    totalPrice: 10000,
  });
  s.orderIds.push(o.id);
  store.saveSession(s);
  await store.flushSession(sid, { timeoutMs: 5000 }); // 先把建单干净地落库，隔离下面要注的故障
  // 下一次落库一律报数据类错误（CHECK 违例的码段，classify() 按前两位 23 判成 data）：
  // markOrderPaid 之后那次落库会失败、会话标 poisoned，之后同一会话的落库都不会再提交
  fx.faults.acquire = fakeDbError('23514');
  try {
    const res = await app.request(`/api/orders/${o.id}/pay`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from('admin:selftest-pass').toString('base64'), 'x-forwarded-for': '198.51.100.11' },
    });
    const body = (await res.json()) as { ok?: boolean; code?: string };
    check(
      '旧接口：poisoned 会话（不会再提交）→ 503 store_lagging，不调 notifyPaid',
      res.status === 503 && body.ok === false && body.code === 'store_lagging',
      `${res.status} ${JSON.stringify(body)}`,
    );
    check('旧接口：poisoned 之后订单在内存里仍是已付（标记已经发生，只是没能通知客户）', store.getOrder(o.id)?.status === 'paid');
  } finally {
    fx.faults.acquire = null;
  }
}

if (fails.length) {
  console.error(`LEGACY PAY POISONED SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`LEGACY PAY POISONED SELFTEST PASS: ${pass} 项断言全通（旧接口 poisoned 会话不调 notifyPaid、回 503）`);
process.exit(0);
