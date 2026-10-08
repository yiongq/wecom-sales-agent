// 02 第 15 步「收款流程与 SOP 措辞」的自测：advisor 模式新增的对客文案（payNote、价格护栏替换句、重发链接、
// 成单安全网）、/pay 页的服务端注入与状态文案、SOP 锁定节的三处改动。
// 第 13 步已覆盖的（console-api 三个订单接口的权限、409/未确认、审计、付款确认时序）不在本文件重复，
// 见 console.selftest.ts「订单：/orders 的角色限制...」那一段；online 模式逐字节不变由锁定套件守着。
// 用法：npx tsx src/payment/orders.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-s15-selftest-'));
process.env.VAR_DIR = VAR_DIR;
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微轮询
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'selftest-pass';
for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[k] = '';

// ---------------- 假模型：只有「成单安全网」那组场景需要它（模型这轮没调 create_order）；其余路径不经过模型 ----------------
interface Step {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}
const script: Step[] = [];
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const input = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] }).input;
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 0 } }));
      return;
    }
    const step = script.shift();
    const message = step?.toolCalls
      ? {
          role: 'assistant',
          content: null,
          tool_calls: step.toolCalls.map((c, i) => ({
            id: `call_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }
      : { role: 'assistant', content: step?.content ?? '（假模型脚本已耗尽）' };
    res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.LLM_MOCK = '0';
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = fakeUrl;
process.env.LLM_API_KEY = 'selftest-fake-key';
process.env.LLM_MODEL = 'selftest-fake';
process.env.EMBED_BASE_URL = fakeUrl;
process.env.EMBED_API_KEY = 'selftest-fake-key';
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';

const { app } = await import('../server.js');
const store = await import('../store.js');
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));
const { handleMessage } = await import('../engine.js');
const { executeTool, loadRoutes } = await import('../tools.js');
const { dropUnbackedClaims } = await import('../price-rules.js');
const { SOP_KNOWN_FIELDS } = await import('../sop/contract.js');
const { __profileTest } = await import('../profile.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

let seq = 0;
const newSid = (tag: string) => `wecom:s15${tag}${++seq}`;
const route = loadRoutes().find((r) => r.itinerary?.length)!;

/** advisor 模式：mock_pay 关（demo 下也行，只要收款方式是 advisor 就够）；跑完照常还原 */
async function inAdvisor<T>(fn: () => Promise<T> | T): Promise<T> {
  __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
  try {
    return await fn();
  } finally {
    __profileTest.reset();
  }
}

// ---------------- 1. data/sop.md 锁定节的三处改动（spec「收款流程」、R15 精确优先的模型兜底） ----------------
{
  const sop = fs.readFileSync(path.resolve('data/sop.md'), 'utf8');
  check('SOP：能力边界改成两种方式都成立的写法', sop.includes('付款只认 create_order 返回的订单链接，或顾问在微信里发给您的收款方式'));
  check('SOP：旧的「付款只走官方支付链接」那句已经不在了', !sop.includes('付款只走我们发给您的官方支付链接'));
  check('SOP：closing 段加了「工具结果里有 payNote」那一句', sop.includes('工具结果里有 payNote 时，按 payNote 跟客户说怎么付款'));
  check('SOP：转人工条件加了「此刻遇到紧急情况 / 冲我们发火」先安抚再转人工那条', sop.includes('先安抚一句，立刻调用 handoff_to_human'));
  check(
    'SOP：第 8 条的例句不带时态词也要算（审查第 4 条），紧急情况写成具体类别',
    sop.includes('我妈高原反应很严重') && sop.includes('身体不适或受伤、被困或走散'),
  );
  check(
    'SOP：第 8 条证件丢了配具体例句（step15b 措辞补例句）',
    sop.includes('护照丢了，明天就要上飞机') && sop.includes('证件被偷了，人在机场'),
  );
  check(
    'SOP：第 8 条冲我们发火配具体例句（step15b 措辞补例句）',
    sop.includes('什么破服务') && sop.includes('你们这么慢是不是没人管') && sop.includes('太失望了，你们就这服务？'),
  );
  check(
    'SOP：售前反例说明也写了（避免模型在问诊类问题、吐槛目的地上转人工）',
    sop.includes('是在问出行前要注意什么，不是说现在出事了') && sop.includes('不是冲我们发火'),
  );
  check(
    'SOP：嫌贵还价不算第 8 条，按异议处理走（审查第 3 条）',
    sop.includes('嫌贵、还价、觉得不划算（哪怕说「这价格太离谱了」）是在还价，按「异议处理」那节走'),
  );
  check('SOP_KNOWN_FIELDS 加了 payNote', SOP_KNOWN_FIELDS.includes('payNote'));
}

// ---------------- 2. create_order 的 payNote：online 没有，advisor 新建单与复用单都带（spec「收款流程」） ----------------
{
  const depart = '2026-12-10';
  {
    const sid = newSid('-online-order');
    const s = store.getOrCreateSession(sid, 'wecom');
    const out = JSON.parse(await executeTool('create_order', { routeId: route.id, travelers: 2, departDate: depart }, s)) as Record<
      string,
      unknown
    >;
    check('online 模式：create_order 结果没有 payNote（逐字节不变）', !('payNote' in out), JSON.stringify(out));
  }
  await inAdvisor(async () => {
    const sid = newSid('-advisor-order');
    const s = store.getOrCreateSession(sid, 'wecom');
    const out1 = JSON.parse(await executeTool('create_order', { routeId: route.id, travelers: 2, departDate: depart }, s)) as Record<
      string,
      unknown
    >;
    check(
      'advisor 模式：新建订单带 payNote，不说点链接付款',
      typeof out1.payNote === 'string' && out1.payNote.includes('不要说点链接付款'),
      JSON.stringify(out1),
    );
    const out2 = JSON.parse(await executeTool('create_order', { routeId: route.id, travelers: 2, departDate: depart }, s)) as Record<
      string,
      unknown
    >;
    check(
      'advisor 模式：复用同一张待付款单（reused）也带 payNote',
      out2.reused === true && out2.payNote === out1.payNote,
      JSON.stringify(out2),
    );
  });
}

// ---------------- 3. 价格规则护栏的替换句（price-rules.ts「做不到的服务：换成由顾问确认」） ----------------
{
  const sid = newSid('-fundclaim');
  const s = store.getOrCreateSession(sid, 'wecom');
  const text = '资金由第三方监管，您可以完全放心。';
  const online = dropUnbackedClaims(text, s, []);
  check(
    'online 模式：资金说法换成「官方支付链接」那句（逐字不变）',
    online.text.includes('付款只走我们发给您的官方支付链接。'),
    online.text,
  );
  await inAdvisor(() => {
    const out = dropUnbackedClaims(text, s, []);
    check(
      'advisor 模式：资金说法换成「订单链接和顾问发给您的收款方式」那句',
      out.text.includes('付款以订单链接和顾问发给您的收款方式为准。'),
      out.text,
    );
  });
}

// ---------------- 4. 重发支付链接（engine.ts resendPayReply，不经过模型） ----------------
function pendingOrderSession(tag: string): { sid: string; o: import('../types.js').Order } {
  const sid = newSid(tag);
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
  return { sid, o };
}
{
  const { sid } = pendingOrderSession('-resend-online');
  const r = await handleMessage(sid, '支付链接打不开，能再发一下吗', 'wecom');
  check('online 模式：重发支付链接，文案不变（不经过模型）', r.text.startsWith('好的，支付链接给您重新发一次：'), r.text);
}
await inAdvisor(async () => {
  const { sid, o } = pendingOrderSession('-resend-advisor');
  const r = await handleMessage(sid, '支付链接打不开，能再发一下吗', 'wecom');
  check(
    'advisor 模式：重发订单链接，未确认价格时说顾问会核对价格并发收款方式',
    r.text.startsWith('好的，订单链接给您重新发一次：') && r.text.includes('顾问会在微信里跟您核对价格并发收款方式。'),
    r.text,
  );
  const live = store.getOrder(o.id)!;
  live.confirmedAt = Date.now();
  store.saveSession(store.getSession(sid)!);
  const r2 = await handleMessage(sid, '链接再发我一下', 'wecom');
  check('advisor 模式：已确认价格的订单重发，说法是「请按顾问发的方式付款」', r2.text.includes('请按顾问发的方式付款。'), r2.text);
});

// ---------------- 4a. 转人工安全网的 handoffReply（engine.ts，不经过模型；第 15 步审查第 5 条） ----------------
{
  const { sid } = pendingOrderSession('-handoff-online');
  const r = await handleMessage(sid, '转人工', 'wecom');
  check('online 模式：转人工安全网仍说「付款卡片仍然有效」（企微渠道，逐字节不变）', r.text.includes('付款卡片仍然有效'), r.text);
}
await inAdvisor(async () => {
  const { sid } = pendingOrderSession('-handoff-advisor');
  const r = await handleMessage(sid, '转人工', 'wecom');
  check(
    'advisor 模式：转人工安全网说法换成订单链接+顾问核对价格发收款方式，不说付款卡片',
    r.text.includes('之前发您的订单链接仍然有效，顾问会在微信里核对价格、发收款方式。') && !r.text.includes('付款卡片'),
    r.text,
  );
});

// ---------------- 5. 成单安全网：新建单与复用现有单两支（engine.ts，模型这轮没调 create_order） ----------------
/** 先在历史里垫一句带确切出发日期的客户消息（不经过模型），再让模型这轮只回句泛泛的话、不调工具 */
function primeQuoteSession(tag: string): { sid: string } {
  const sid = newSid(tag);
  const s = store.getOrCreateSession(sid, 'wecom');
  s.messages.push({ role: 'customer', content: `去${route.title}，12月10号出发`, at: Date.now() });
  s.lastQuote = { routeId: route.id, routeTitle: route.title, travelers: 2, perPerson: 5000, total: 10000, departDate: '2026-12-10' };
  store.saveSession(s);
  return { sid };
}
{
  const { sid } = primeQuoteSession('-safetynet-new-online');
  script.push({ content: '好的，马上为您处理～' });
  const r = await handleMessage(sid, '就这个，订吧', 'wecom');
  check(
    'online 模式：成单安全网新建单，文案不变（点此完成支付）',
    r.text.includes('请点此完成支付：') && r.text.includes('名额以付款为准，付款后顾问会与您确认行程细节～'),
    r.text,
  );
}
await inAdvisor(async () => {
  const { sid } = primeQuoteSession('-safetynet-new-advisor');
  script.push({ content: '好的，马上为您处理～' });
  const r = await handleMessage(sid, '就这个，订吧', 'wecom');
  check(
    'advisor 模式：成单安全网新建单，说法换成订单链接+顾问核对价格发收款方式',
    r.text.includes('订单链接：') &&
      r.text.includes('顾问会在微信里跟您核对价格并发收款方式，不用点链接付款。') &&
      !r.text.includes('请点此完成支付'),
    r.text,
  );
});
{
  // 已有一张完全同参的待付款单：安全网走「重发原链接」那支（不新建）
  const { sid } = primeQuoteSession('-safetynet-existing-online');
  store.getOrCreateSession(sid, 'wecom').orderIds.push(
    store.createOrder({
      sessionId: sid,
      routeId: route.id,
      routeTitle: route.title,
      travelers: 2,
      departDate: '2026-12-10',
      totalPrice: 10000,
    }).id,
  );
  store.saveSession(store.getSession(sid)!);
  script.push({ content: '好的，马上为您处理～' });
  const r = await handleMessage(sid, '就这个，订吧', 'wecom');
  check('online 模式：成单安全网重发现有单，文案不变（直接点这里完成支付）', r.text.includes('直接点这里完成支付即可：'), r.text);
}
await inAdvisor(async () => {
  const { sid } = primeQuoteSession('-safetynet-existing-advisor');
  store.getOrCreateSession(sid, 'wecom').orderIds.push(
    store.createOrder({
      sessionId: sid,
      routeId: route.id,
      routeTitle: route.title,
      travelers: 2,
      departDate: '2026-12-10',
      totalPrice: 10000,
    }).id,
  );
  store.saveSession(store.getSession(sid)!);
  script.push({ content: '好的，马上为您处理～' });
  const r = await handleMessage(sid, '就这个，订吧', 'wecom');
  check(
    'advisor 模式：成单安全网重发现有单，说法换成订单链接',
    r.text.includes('订单链接：') && !r.text.includes('直接点这里完成支付即可'),
    r.text,
  );
});

// ---------------- 6. /pay 页：服务端注入、标题锁定断言不变、advisor 五种状态文案、?orderId= 客户端跳转 ----------------
{
  const { sid } = pendingOrderSession('-payhtml');
  const o = store.getOrder(store.getSession(sid)!.orderIds[0]!)!;
  const onlineHtml = await (await app.request(`/pay/${o.id}`)).text();
  check('online 模式：/pay 页不注入 payment-mode 标记（逐字节不变）', !onlineHtml.includes('<meta name="payment-mode"'));
  check('/pay 页标题仍是「<线路> · 订单支付」（锁定断言）', onlineHtml.includes(`<title>${route.title} · 订单支付</title>`));
  await inAdvisor(async () => {
    const html = await (await app.request(`/pay/${o.id}`)).text();
    check('advisor 模式：/pay 页注入 payment-mode=advisor 标记', html.includes('<meta name="payment-mode" content="advisor">'));
    check('advisor 模式：标题仍是「<线路> · 订单支付」（锁定断言不受影响）', html.includes(`<title>${route.title} · 订单支付</title>`));
  });
}
{
  const payHtml = fs.readFileSync(path.resolve('public/pay.html'), 'utf8');
  check(
    'pay.html：advisor 五种状态文案都在',
    [
      '订单已提交 · 顾问会在微信里跟您核对价格，并发来收款方式',
      '价格已确认 · 请按顾问在微信里发的方式付款',
      '已收款',
      '已被替代',
      '已取消',
    ].every((t) => payHtml.includes(t)),
  );
  check(
    'pay.html：没有服务端注入时，?orderId= 在客户端跳到 /pay/:orderId',
    /location\.replace\('\/pay\/' \+ encodeURIComponent\(qid\)\)/.test(payHtml),
  );
  {
    const advisorBlock = /<div id="advisorView"[\s\S]*?\n {4}<\/div>/.exec(payHtml)?.[0] ?? '';
    check(
      'pay.html：advisor 视图是独立的一块、不含付款按钮',
      advisorBlock.includes('advisorStatus') && !advisorBlock.includes('payBtn'),
      advisorBlock.slice(0, 80),
    );
  }
}

// ---------------- 7. 种子保鲜（freshenDemoData）把订单的 confirmedAt 跟着 createdAt 一起挪（第 13 步定、本步才真有确认价格） ----------------
{
  const H = 3_600_000;
  const t0 = Date.now() - 4 * H;
  const sid = 'wecom:cust_S15FRESHEN';
  const s = store.getOrCreateSession(sid, 'wecom');
  s.messages.push({ role: 'customer', content: '想去云南看看', at: t0 + 60_000 });
  s.createdAt = t0;
  s.updatedAt = t0 + 120_000;
  const o = store.createOrder({
    sessionId: sid,
    routeId: route.id,
    routeTitle: route.title,
    travelers: 2,
    departDate: '2026-12-10',
    totalPrice: 10000,
  });
  o.createdAt = t0 + 30_000;
  o.confirmedAt = t0 + 90_000;
  s.orderIds.push(o.id);
  store.saveSession(s, false);
  store.freshenDemoData();
  const delta = s.createdAt - t0;
  check(
    '种子保鲜：订单 confirmedAt 跟 createdAt 挪同样的量，相对间隔不变',
    delta > 3 * H && o.createdAt - t0 === 30_000 + delta && o.confirmedAt - t0 === 90_000 + delta,
    JSON.stringify({ delta, createdAt: o.createdAt, confirmedAt: o.confirmedAt }),
  );
}

// ---------------- 8. 旧接口 POST /api/orders/:id/pay：advisor 下不要求先确认（锁定套件已测），新加的审计不炸 ----------------
await inAdvisor(async () => {
  const { sid } = pendingOrderSession('-legacy-pay');
  const o = store.getOrder(store.getSession(sid)!.orderIds[0]!)!;
  const res = await app.request(`/api/orders/${o.id}/pay`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('admin:selftest-pass').toString('base64'), 'x-forwarded-for': '198.51.100.9' },
  });
  check(
    'advisor 模式：旧接口不要求先确认价格，照样能标成已付（新加的审计调用不出错）',
    res.status === 200 && store.getOrder(o.id)?.status === 'paid',
    String(res.status),
  );
});
{
  // 付款确认要在提交之后才发（不变量 20）：文件存储下落库近乎同步，等提交和不等之间跑不出可观察的行为差异，
  // 这里退而求其次按源码顺序核一遍——awaitCommit 的那一句必须排在 notifyPaid 之前，防一次简单的顺序颠倒
  const serverSrc = fs.readFileSync(path.resolve('src/server.ts'), 'utf8');
  const handler = /app\.post\('\/api\/orders\/:id\/pay'[\s\S]*?\n\}\);/.exec(serverSrc)?.[0] ?? '';
  const flushAt = handler.indexOf('awaitCommit(order.sessionId');
  const notifyAt = handler.indexOf('notifyPaid(id)');
  check(
    '旧接口源码顺序：awaitCommit 排在 notifyPaid 之前（付款确认在提交之后才发）',
    flushAt >= 0 && notifyAt >= 0 && flushAt < notifyAt,
    `flushAt=${flushAt} notifyAt=${notifyAt}`,
  );
}

fake.close();
if (fails.length) {
  console.error(`PAYMENT ORDERS SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `PAYMENT ORDERS SELFTEST PASS: ${pass} 项断言全通（SOP 三处改动 / payNote / 价格护栏替换句 / 重发链接 / 成单安全网 / /pay 页 / 种子保鲜挪 confirmedAt / 旧接口）`,
);
process.exit(0);
