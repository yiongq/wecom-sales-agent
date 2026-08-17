// HTTP 服务：静态页面 + 模拟器 API + 管理后台 API + 企微回调。
// 注意路由注册顺序：API 在前，serveStatic 兜底在后。
// 管理面（admin.html 与管理 API）走 Basic 鉴权，见 adminAuth。
import './env.js'; // 必须第一个 import：加载 .env（此前 .env 从未被读取，README 的跑法照做即挂）
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import { handleMessage, notifyPaid } from './engine.js';
import { createQuote, loadHotels, loadRoutes } from './tools.js';
import { getOrder, getSession, listOrders, listSessions, markOrderPaid, saveSession, storeEvents } from './store.js';
import { getDraftReply, getInsights, getSuggestion } from './insight.js';
import { activeModels, CHEAP_TIER_MODEL, llmCfg } from './llm.js';
import { budgetStatus } from './budget.js';
import { usageToday } from './usage.js';
import { gateStatus } from './llm-gate.js';
import { buildIndex } from './retrieval.js';
import { startFollowUpScheduler } from './followup.js';
import { simulatorAdapter, subscribe } from './adapters/simulator.js';
import { startWecom, syncFromCallback, wecomAdapter } from './adapters/wecom.js';
import { computeSignature, decryptWecom, safeEqual } from './wecom-crypto.js';
import { numEnv } from './env.js';
import type { ChannelAdapter } from './types.js';

const app = new Hono();

function adapterFor(channel: string): ChannelAdapter {
  return channel === 'wecom' ? wecomAdapter : simulatorAdapter;
}

// ---------------- 管理面鉴权 ----------------
// 分两层，而不是一个「读写一起开关」的总闸：
//   · 读：免密可看，但服务端只吐演示数据（种子会话 wecom:cust_* 与网页访客 sim-*）。
//     真实企微客户会话在未登录时**根本不进入响应体**，不是靠前端隐藏。
//   · 写：接管 / 发消息 / 交还，以及所有走 LLM 计费的端点，一律要 ADMIN_PASS。
//
// 早先的写法是一个「免密公开」开关同时打开读和写。那种设计的问题不在默认值，而在于
// 它把两个风险等级完全不同的能力绑在一个布尔值上：演示只需要「读」，而「写」——以顾问
// 身份给真实微信客户发消息——永远没有免密的正当理由。于是开关被彻底移除：
// 现在没有任何环境变量能放行写操作，配错的最坏结果是「后台不可用」，而不是「全网可写」。
// 未配 ADMIN_PASS 时：读仍是演示模式（可用），写返回 503。

/** 演示模式下可见的会话：种子演示会话与网页模拟器访客，绝不含真实企微客户。 */
const DEMO_VISIBLE_RE = /^(?:wecom:cust_|sim-)/;

/** 请求是否携带有效管理凭据。只判定、不拒绝——供「免密只读、登录后全量」分层使用。 */
function isAdminReq(c: Context): boolean {
  const pass = process.env.ADMIN_PASS;
  if (!pass) return false;
  const user = process.env.ADMIN_USER || 'admin';
  const header = c.req.header('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  return safeEqual(u ?? '', user) && safeEqual(p ?? '', pass);
}

// 写操作与 LLM 计费端点的硬闸。
// 故意不回 www-authenticate：后台用页面内自建登录框，浏览器原生弹窗会抢在前面，
// 且原生弹窗一旦取消就无法再唤起，用户退不回演示模式。
async function adminAuth(c: Context, next: Next): Promise<Response | void> {
  if (!process.env.ADMIN_PASS) {
    return c.json(
      { error: '管理操作已锁定：服务端未配置 ADMIN_PASS。在 .env 设置 ADMIN_USER/ADMIN_PASS 后重建容器即可。' },
      503,
    );
  }
  if (isAdminReq(c)) return next();
  return c.json({ error: 'unauthorized' }, 401);
}

/** 单会话读取：演示会话（种子/访客）凭自身不可猜的 ID 直读，真实客户会话必须登录。
 *  demo 分支额外走一道限流：ID 是凭据，不限流就等于允许慢速穷举。 */
async function sessionReadAuth(c: Context, next: Next): Promise<Response | void> {
  if (DEMO_VISIBLE_RE.test(c.req.param('id') ?? '')) return lookupLimit(c, next);
  return adminAuth(c, next);
}

/**
 * 跨站写保护。管理面走 HTTP Basic，浏览器会给任何跨站请求自动带上缓存的凭据——
 * 一个自动提交的表单就能让已登录的顾问向真实客户发出任意消息，或把会话永久转人工。
 * 同源 fetch 一定带 Sec-Fetch-Site: same-origin；缺这个头的（curl、老浏览器）放行，
 * 因为真正的跨站攻击载体一定是现代浏览器，它一定会带。
 */
const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return c.json({ error: '跨站请求已拒绝' }, 403);
  }
  return next();
};

app.get('/', (c) => c.redirect('/guide.html'));
// 健康检查顺带暴露访客 LLM 预算用量，方便随时查「今天被刷了多少」
app.get('/healthz', (c) =>
  c.json({ ok: true, models: activeModels(), visitorLLM: budgetStatus(), llmGate: gateStatus() }),
);

// 模型用量与成本（JD 明确要求的「模型调用成本」指标）
// 用量与成本：聚合数字，不含任何客户信息，演示模式下也放行（这正是要展示的指标之一）
app.get('/api/usage', (c) => c.json(usageToday()));

// ---------------- 模拟器聊天 ----------------

const SIM_SESSION_RE = /^sim-[A-Za-z0-9_-]{1,64}$/;

// /api/chat 是公网匿名端点且每次调真实 LLM——不加限流等于把 LLM 账单和
// sessions.json 的增长交给任何写脚本的人。滑动窗口按 IP 计数，内存实现够用。
const CHAT_RATE_PER_MIN = Math.max(1, numEnv('CHAT_RATE_PER_MIN', 20));
// 靠 ID 访问的公开端点（订单、访客会话、SSE）也要限流，否则 ID 可以被慢慢穷举
const LOOKUP_RATE_PER_MIN = Math.max(1, numEnv('LOOKUP_RATE_PER_MIN', 60));
// 键的总量上限，防止「每请求换一个 IP」把内存打爆；
// 超过上限就退化成全局限流（宁可误伤也不能被打挂）。
const RATE_MAX_KEYS = 10_000;

/**
 * 限流键 = 客户端真实来源地址。
 *
 * 两条都要卡住，少一条限流就形同虚设：
 * 1. 不能取 XFF 的**第一段**——那一段完全由客户端写，换一个假 IP 就是换一个新桶
 *    （实测放行量约 20 万/分钟）。反代（Caddy）是把真实对端**追加**到 XFF 末尾的，
 *    所以真实地址在从右往左数第 TRUST_PROXY_HOPS 跳。
 * 2. XFF 本身也只在「直连对端确实是我们的反代」时才可信。否则把服务直接暴露出去
 *    （或本地 pnpm dev）时，攻击者自己捏一个 XFF 就又绕过去了——线上 Caddy 反代到
 *    127.0.0.1，容器看到的对端是内网地址，据此判定。公网直连的请求一律按 socket 地址算。
 */
const TRUST_PROXY_HOPS = Math.max(0, numEnv('TRUST_PROXY_HOPS', 1));
// peer 已剥掉 ::ffff: 前缀，这里只需匹配裸 IPv4 与真 IPv6 私网
const PRIVATE_PEER = /^(?:127\.|::1$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd])/i;

function clientKey(c: Context): string {
  let peer = '';
  try {
    // 双栈监听（serve() 不传 hostname → Node 绑 ::）下，IPv4 对端会以
    // ::ffff:172.17.0.1 这种形式出现。不剥掉前缀，下面的私网判定就只认裸 IPv4——
    // 线上正是 Docker 网关 172.17.0.1，结果 XFF 永不被采信、全站退化成一个限流桶。
    peer = (getConnInfo(c).remote.address ?? '').replace(/^::ffff:/i, '');
  } catch { /* 拿不到对端地址就退回 XFF 末段 */ }
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const viaProxy = peer === '' || PRIVATE_PEER.test(peer);
  if (viaProxy && TRUST_PROXY_HOPS > 0 && chain.length) {
    return chain[Math.max(0, chain.length - TRUST_PROXY_HOPS)];
  }
  return peer || chain[chain.length - 1] || 'direct';
}

/** 独立命名的滑动窗口计数桶（聊天与查询各自一套，互不挤占） */
function makeLimiter(perMin: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      const recent = v.filter((t) => now - t < 60_000);
      if (recent.length) hits.set(k, recent);
      else hits.delete(k);
    }
  }, 5 * 60_000).unref();
  return (key: string): boolean => {
    const now = Date.now();
    const k = hits.has(key) || hits.size < RATE_MAX_KEYS ? key : '__overflow__';
    const recent = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMin) {
      hits.set(k, recent);
      return true;
    }
    recent.push(now);
    hits.set(k, recent);
    return false;
  };
}

const chatRateLimited = makeLimiter(CHAT_RATE_PER_MIN);
const lookupRateLimited = makeLimiter(LOOKUP_RATE_PER_MIN);

/** 挂在靠 ID 访问的公开端点前，让穷举 ID 的成本不可承受 */
const lookupLimit: MiddlewareHandler = async (c, next) => {
  if (lookupRateLimited(clientKey(c))) return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  return next();
};

// 全站请求体上限。验签/限流都发生在读 body 之后，没有上限时几条慢速大 body 请求
// 就能把容器内存吃满（docker run 未设 -m）。企微回调和聊天请求都只有几 KB 量级。
// 注：只看 Content-Length，挡不住 chunked 编码——那一层交给 Caddy 的 request_body。
const MAX_BODY_BYTES = Math.max(1024, numEnv('MAX_BODY_BYTES', 64 * 1024));
app.use('/*', async (c, next) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) return c.text('payload too large', 413);
  return next();
});

app.post('/api/chat', async (c) => {
  if (chatRateLimited(clientKey(c))) return c.json({ error: '发送太频繁了，请稍后再试' }, 429);
  const body = await c.req.json<{ sessionId?: string; text?: unknown }>().catch(() => null);
  // typeof 判断不能省：可选链只挡 null/undefined，text 传数字/数组/对象时 .trim 不存在会抛
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text 不能为空' }, 400);
  if (text.length > 1000) return c.json({ error: '消息过长（≤1000 字）' }, 400);
  // 只接受模拟器自己的 sim- 会话 ID：不许网页端指定 wecom: 前缀混入真实客户会话
  if (body?.sessionId && !SIM_SESSION_RE.test(body.sessionId)) {
    return c.json({ error: 'sessionId 非法' }, 400);
  }
  // 会话 ID 就是凭据（chat.html 靠它恢复历史，/api/sessions/:id 靠它放行读取），
  // 必须是完整熵。此前截成 8 个十六进制字符只有 32 bit，配合无限流的读接口可被穷举。
  const sessionId = body?.sessionId || `sim-${randomBytes(12).toString('hex')}`;
  const reply = await handleMessage(sessionId, text, 'simulator');
  return c.json({ sessionId, reply });
});

// SSE 推送通道：服务端主动消息（支付跟进、人工回复）经此下发
app.get('/api/stream/:sessionId', lookupLimit, (c) => {
  const sessionId = c.req.param('sessionId');
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe(sessionId, (text) => {
      // 文本包 JSON，换行符才能安全穿过 SSE 分帧
      void stream.writeSSE({ event: 'push', data: JSON.stringify({ text }) });
    });
    stream.onAbort(() => unsubscribe());
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      await stream.sleep(15000);
    }
  });
});

// ---------------- 管理后台 ----------------
// 读端点免密（响应体按 isAdminReq 过滤），写端点与 LLM 端点经 adminAuth。

// 登录框校验凭据用：200=通过，401=账号密码错，503=服务端没配 ADMIN_PASS
app.get('/api/admin/whoami', adminAuth, (c) => c.json({ ok: true, user: process.env.ADMIN_USER || 'admin' }));

// 后台实时推送：数据变更时下发 change，前端据此拉取（替代轮询）。
// 只推「变了」这个信号、不带任何数据，故免密——真正的数据仍由下面的读端点按登录态过滤。
// 也必须免密：EventSource 无法自定义请求头，带不了 Authorization。
app.get('/api/admin/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let alive = true;
    const onChange = () => { void stream.writeSSE({ event: 'change', data: String(Date.now()) }); };
    storeEvents.on('change', onChange);
    stream.onAbort(() => { alive = false; storeEvents.off('change', onChange); });
    await stream.writeSSE({ event: 'change', data: 'init' }); // 连上先触发一次首屏加载
    while (alive) { await stream.writeSSE({ event: 'ping', data: String(Date.now()) }); await stream.sleep(20000); }
  });
});

// AI 洞察（LLM 生成，服务端缓存；失败返回空数组，前端回退规则版）
app.get('/api/insights', adminAuth, async (c) => {
  try { return c.json({ insights: await getInsights() }); }
  catch { return c.json({ insights: [] }); }
});

// 下一步建议（按会话 LLM 生成，缓存；失败返回空，前端回退规则版）
app.get('/api/sessions/:id/suggestion', adminAuth, async (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ suggestion: '' }, 404);
  try { return c.json({ suggestion: await getSuggestion(s) }); }
  catch { return c.json({ suggestion: '' }); }
});

// 会话列表：未登录只返回演示会话。过滤发生在服务端——真实客户会话不进响应体，
// 而不是前端拿到全量再隐藏（后者用 devtools 一看就穿）。
app.get('/api/sessions', (c) => {
  const all = listSessions();
  return c.json(isAdminReq(c) ? all : all.filter((s) => DEMO_VISIBLE_RE.test(s.id)));
});

app.get('/api/sessions/:id', sessionReadAuth, (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json(s);
});

app.post('/api/sessions/:id/handoff', sameOriginOnly, adminAuth, (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  s.handedOver = true;
  s.stage = 'handoff';
  s.updatedAt = Date.now();
  saveSession(s);
  return c.json(s);
});

// 接管的反向操作：把会话交还 AI 继续自动应答。没有它，误接管（或正则误伤转人工）
// 的客户就永久沉默——AI 不理、人工忘了跟，线索静默流失。
app.post('/api/sessions/:id/resume', sameOriginOnly, adminAuth, (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  s.handedOver = false;
  // 阶段按事实回推：有已支付订单=paid，有订单=closing，报过价=quote，否则回问需。
  // 只在原阶段是 handoff（被转人工"吸"走）时才回推——否则会把 closing 的客户
  // 拉回 quote，成交概率、漏斗计数跟着倒退，且已落盘不可逆。
  if (s.stage === 'handoff') {
    const paid = s.orderIds.map((id) => getOrder(id)).some((o) => o?.status === 'paid');
    s.stage = paid ? 'paid' : s.orderIds.length ? 'closing' : s.lastQuote ? 'quote' : 'discovery';
  }
  s.messages.push({ role: 'system', content: '顾问已将会话交还 AI，自动应答恢复', at: Date.now() });
  s.updatedAt = Date.now();
  saveSession(s);
  return c.json(s);
});

// AI 代拟回复（起草可直接发给客户的下一条消息，供后台「填入回复框」）。
// 注意与 /suggestion 的区别：那是给顾问看的内部教练建议，不能直接发给客户。
app.get('/api/sessions/:id/draft', adminAuth, async (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ draft: '' }, 404);
  try { return c.json({ draft: await getDraftReply(s) }); }
  catch { return c.json({ draft: '' }); }
});

app.post('/api/sessions/:id/reply', sameOriginOnly, adminAuth, async (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = await c.req.json<{ text?: unknown }>().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text 不能为空' }, 400);
  s.messages.push({ role: 'agent', content: text, at: Date.now() });
  s.updatedAt = Date.now();
  saveSession(s);
  const sent = await adapterFor(s.channel).push(s.id, text);
  if (!sent) {
    // 发送失败必须让操作者知道：否则后台显示"已回复"、客户实际什么都没收到
    s.messages.push({
      role: 'system',
      content: '⚠️ 上一条人工回复未能发送到客户（企微发送失败：可能是 48h 会话窗口已关闭或企微配置问题）',
      at: Date.now(),
    });
    saveSession(s);
    return c.json({ ok: false, error: '发送失败：消息未送达客户（已在会话中标记）' });
  }
  return c.json({ ok: true });
});

// ---------------- 订单与支付 ----------------

// 订单列表：同会话列表，未登录只返回演示会话名下的订单
app.get('/api/orders', (c) => {
  const all = listOrders();
  return c.json(isAdminReq(c) ? all : all.filter((o) => DEMO_VISIBLE_RE.test(o.sessionId)));
});

// 单订单读取对支付页开放：订单号即凭据（不可猜的随机 ID，且列表接口已加鉴权不可枚举）
app.get('/api/orders/:id', lookupLimit, (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'order not found' }, 404);
  return c.json(o);
});

// 演示用模拟支付：真实生产必须替换为微信支付服务端回调验签，此端点仅 demo 闭环用
app.post('/api/orders/:id/pay', lookupLimit, async (c) => {
  const id = c.req.param('id');
  const order = getOrder(id);
  if (!order) return c.json({ error: 'order not found' }, 404);
  if (order.status !== 'paid') {
    markOrderPaid(id);
    // 引擎生成跟进话术并更新会话，服务端只负责经渠道推给客户
    const followUp = await notifyPaid(id);
    if (followUp) {
      const s = getSession(followUp.sessionId);
      await adapterFor(s?.channel ?? 'simulator').push(followUp.sessionId, followUp.text);
    }
  }
  return c.json({ ok: true, order: getOrder(id) });
});

// 支付页：/pay/:orderId 直接回 pay.html，页面 JS 从路径取 orderId
app.get('/pay/:orderId', async (c) => {
  const html = await readFile(path.resolve('public/pay.html'), 'utf8');
  // 同方案页：标题服务端注入，避免微信里先闪一下网址再变标题
  const o = getOrder(c.req.param('orderId'));
  if (!o) return c.html(html);
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
  const title = `${o.routeTitle} · 订单支付`;
  const desc = `${o.travelers} 位出行 · ${o.departDate} 出发 · 合计 ¥${o.totalPrice.toLocaleString('zh-CN')}`;
  return c.html(html.replace(/<title>[\s\S]*?<\/title>/,
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(desc)}">\n` +
    `<meta property="og:title" content="${esc(title)}">\n` +
    `<meta property="og:description" content="${esc(desc)}">`));
});

/** 出发日期是否合理：真实存在的日历日 + 今天到三年内（2099 年那种也别放行） */
function isSaneDepartDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const maxDate = `${now.getFullYear() + 3}-12-31`;
  return s >= today && s <= maxDate;
}

// ---------------- 行程方案书 ----------------
// 无状态：参数在 URL 里，页面按与报价工具同一套规则重算，不引入新的持久化与清理负担。
// 客户拿到的链接长期有效，也不会因为演示数据清理而失效。
app.get('/api/proposal/:routeId', (c) => {
  const route = loadRoutes().find((r) => r.id === c.req.param('routeId'));
  if (!route?.itinerary?.length) return c.json({ error: 'proposal not available' }, 404);
  const travelers = Math.min(50, Math.max(1, Math.floor(Number(c.req.query('travelers')) || 2)));
  // 这个端点是公开可拼的，不能只靠工具层校验：手拼 2027-02-30 会生成一份写着
  // 不存在日期的正式方案书发出去。日期不合法就当没传，按标准价出方案。
  const raw = c.req.query('departDate');
  const departDate = raw && isSaneDepartDate(raw) ? raw : undefined;
  const quote = createQuote({ routeId: route.id, travelers, departDate });
  return c.json({ route, travelers, departDate, quote });
});

// 路径写宽松些：客户从微信/邮件复制链接常会多带一个尾斜杠或丢掉日期段，
// 落到裸 404 白页很难看。人数段非法时也交给页面显示优雅的错误态。
/**
 * 方案页服务端注入标题与分享卡片。
 * 页面本身是客户端渲染，标题只能等 fetch 回来才改——微信里表现为「先显示网址、
 * 再闪成标题」，很掉价。这里在发出 HTML 前就把真实标题写进去，第一个字节就是对的。
 * 顺带写 og:*，客户在微信里转发方案书时卡片才有线路名和摘要，而不是一条秃链接。
 */
function renderProposalHtml(html: string, routeId: string, travelers: number): string {
  const route = loadRoutes().find((r) => r.id === routeId);
  if (!route) return html;
  const title = `${route.title} · 行程方案书`;
  const desc = `${route.days} 天 · ${travelers} 位出行 · ${route.hotelLevel}｜${(route.highlights?.[0] ?? '').slice(0, 40)}`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
  // 缩略图必须是绝对 URL：微信/各类抓取方不解析相对路径。
  // 微信自带的「发送给朋友」不读 og:image，它是在页面里自己挑一张图当缩略图——
  // 所以下面除了 meta，还往 body 里插了一张真实 <img>（1px 不行，太小会被跳过）。
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const cover = base ? `${base}/share-cover.png` : '/share-cover.png';
  const withHead = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${esc(title)}</title>\n` +
      `<meta name="description" content="${esc(desc)}">\n` +
      `<meta property="og:title" content="${esc(title)}">\n` +
      `<meta property="og:description" content="${esc(desc)}">\n` +
      `<meta property="og:image" content="${esc(cover)}">\n` +
      `<meta property="og:type" content="website">\n` +
      `<link rel="image_src" href="${esc(cover)}">`,
  );
  return withHead;
}

async function serveProposal(c: Context): Promise<Response> {
  const html = await readFile(path.resolve('public/proposal.html'), 'utf8');
  const routeId = c.req.param('routeId') ?? '';
  // 人数在路径第二段（/proposal/<id>/<人数>[/<日期]），取不到按 2 人
  const travelers = Math.min(50, Math.max(1, Math.floor(Number((c.req.param('rest') ?? '').split('/')[0]) || 2)));
  return c.html(renderProposalHtml(html, routeId, travelers));
}

app.get('/proposal/:routeId/:rest{.*}', serveProposal);
app.get('/proposal/:routeId', serveProposal);

// ---------------- 企微回调（URL 验证握手 + 事件接收） ----------------
// kf 消息靠轮询拉取（见 adapters/wecom.ts）；此回调的作用是通过后台的
// 「接收消息服务器 URL」验证——那是配置「企业可信 IP」的前置条件。
// 需要 env：WECOM_CALLBACK_TOKEN / WECOM_CALLBACK_AES_KEY（后台设置回调时生成的那对）。

/** 解密后校验 receiveid 与本企业 corpid 一致（官方方案要求的纵深防御） */
function receiveIdOk(receiveId: string): boolean {
  const corpId = process.env.WECOM_CORP_ID;
  return !corpId || !receiveId || receiveId === corpId;
}

app.get('/wecom/callback', (c) => {
  const token = process.env.WECOM_CALLBACK_TOKEN;
  const aesKey = process.env.WECOM_CALLBACK_AES_KEY;
  if (!token || !aesKey) return c.text('wecom callback not configured', 501);
  const q = c.req.query();
  const { msg_signature: sig, timestamp, nonce, echostr } = q;
  if (!sig || !timestamp || !nonce || !echostr) return c.text('bad request', 400);
  if (!safeEqual(computeSignature(token, timestamp, nonce, echostr), sig)) return c.text('signature mismatch', 403);
  try {
    const { msg, receiveId } = decryptWecom(aesKey, echostr);
    if (!receiveIdOk(receiveId)) return c.text('receiveid mismatch', 403);
    return c.text(msg);
  } catch (err) {
    console.error('[wecom] echostr 解密失败:', err);
    return c.text('decrypt failed', 400);
  }
});

// kf 事件回调：企微 POST 加密的 kf_msg_or_event 事件 → 解密取 Token → 用它拉消息。
// 必须尽快回 success（拉取异步做），否则企微超时重推。
app.post('/wecom/callback', async (c) => {
  const token = process.env.WECOM_CALLBACK_TOKEN;
  const aesKey = process.env.WECOM_CALLBACK_AES_KEY;
  // 下面三条都必须回 success（否则企微会重推），但**绝不能连日志都不打**：
  // WECOM_CALLBACK_TOKEN 抄错一位时，每条客户消息的回调都在这里被静默丢弃，
  // 服务端零输出，表现只是首响从 ~2s 退化到 60s 兜底轮询，没有任何线索指向配错的 token。
  if (!token || !aesKey) {
    console.error('[wecom] 收到回调但 WECOM_CALLBACK_TOKEN / WECOM_CALLBACK_AES_KEY 未配置，已丢弃');
    return c.text('success');
  }
  const { msg_signature: sig, timestamp, nonce } = c.req.query();
  const raw = await c.req.text();
  const encrypt = raw.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/)?.[1] ?? raw.match(/<Encrypt>([\s\S]*?)<\/Encrypt>/)?.[1];
  if (!sig || !timestamp || !nonce || !encrypt) {
    console.error('[wecom] 回调参数不完整（缺 msg_signature/timestamp/nonce/Encrypt），已丢弃');
    return c.text('success');
  }
  if (!safeEqual(computeSignature(token, timestamp, nonce, encrypt), sig)) {
    console.error(
      `[wecom] ⚠️ 回调验签失败（sig=${sig.slice(0, 8)}… timestamp=${timestamp}）：` +
        'WECOM_CALLBACK_TOKEN 与企微后台配置的不一致，消息只能靠兜底轮询，首响会明显变慢',
    );
    return c.text('success');
  }
  try {
    const { msg, receiveId } = decryptWecom(aesKey, encrypt);
    if (!receiveIdOk(receiveId)) return c.text('success');
    // kf 事件明文里带 <Token>，用它调 sync_msg 才不限频
    const syncToken = msg.match(/<Token><!\[CDATA\[([\s\S]*?)\]\]><\/Token>/)?.[1] ?? msg.match(/<Token>([\s\S]*?)<\/Token>/)?.[1];
    console.log(`[wecom] 收到回调事件${syncToken ? '（含 token，立即拉取）' : '（无 token）'}`);
    if (syncToken) void syncFromCallback(syncToken);
  } catch (err) {
    console.error('[wecom] 回调事件解析失败:', err);
  }
  return c.text('success');
});

// 客服二维码从 var/ 读、不入库：它编码的是真实 open_kfid，等同凭据——扫到的人能直接
// 消耗企微未认证主体那 100 个「不可回收」的接待名额，并烧掉真实 LLM 预算。
// 没放图就 404，guide.html 据此自动退回网页模拟器入口（克隆下来零配置也能跑通）。
app.get('/kf-qr.png', async (c) => {
  const dir = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
  try {
    const buf = await readFile(path.join(dir, 'kf-qr.png'));
    return c.body(buf, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' });
  } catch {
    return c.notFound();
  }
});

// 静态资源兜底（admin.html / chat.html / pay.html / guide.html）。
// admin.html 页面本身不再鉴权：它进来只会看到演示数据，页面内的登录框负责换取
// 真实客户会话与写权限。页面是空壳，凭据永远由下面的 API 层判定。
app.use('/*', serveStatic({ root: './public' }));

// 全局兜底：此前 /api/chat 没有任何 catch，上游 LLM 抖动（超时/5xx/返回缺 choices）
// 会直接冒成 500 纯文本——压测实测约 3% 的请求命中，而这正是公开演示链接被点的那条路径。
// 企微渠道早有 catch（adapters/wecom.ts），网页端一直漏着。
app.onError((err, c) => {
  console.error(`[server] 未捕获异常 ${c.req.method} ${c.req.path}:`, err instanceof Error ? err.message : err);
  // 聊天接口返回可直接展示给客户的话术，前端拿到的始终是合法 JSON
  if (c.req.path === '/api/chat') {
    return c.json({ reply: { text: '抱歉，我这边卡了一下，麻烦您再发一次～', stage: 'discovery' } }, 200);
  }
  return c.json({ error: '服务暂时不可用，请稍后重试' }, 500);
});

const port = Number(process.env.PORT) || 3200;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] 已启动 http://localhost:${info.port}`);
  // 配置漂移自检：按「实际数据」喊，而不是只描述配置。
  // 「密码没配」这件事单看配置是察觉不到的——没人会定期去翻 .env，
  // 而一旦真实客户已经进来了，它的含义就从「无所谓」变成「你看不到也接管不了他们」。
  const realSessions = listSessions().filter((s) => !DEMO_VISIBLE_RE.test(s.id)).length;
  if (!process.env.ADMIN_PASS) {
    console.warn('[server] ADMIN_PASS 未配置：后台为演示模式（免密只读、仅演示数据），接管与发消息一律 503。');
    if (realSessions > 0) {
      console.warn(`[server] ⚠️ 已有 ${realSessions} 个真实客户会话，但没配密码——你无法在后台查看或接管它们。`);
    }
  } else if (realSessions > 0) {
    console.log(`[server] 管理面已启用鉴权；${realSessions} 个真实客户会话仅登录后可见。`);
  }
  // 交付场景最常见的"看着正常、其实全坏"：key 没配。启动就喊，别等客户发消息才发现。
  // 必须复用 llmCfg()——直接查 LLM_API_KEY 会与多供应商解析对不上，既误报又漏报。
  if (process.env.LLM_MOCK === '1') {
    console.log('[server] LLM_MOCK=1：走离线脚本回复，不调用真实模型');
  } else {
    const { apiKey, model, baseUrl } = llmCfg();
    if (apiKey) {
      const { main, cheap } = activeModels();
      console.log(`[server] LLM: ${process.env.LLM_PROVIDER || 'default'} / 对话=${main} · 后台=${cheap} @ ${baseUrl}`);
      // 静默降级是最难查的故障：主对话跑到便宜档上，表现只是「话术变差了」，
      // 不报错也不告警。后台跟主模型一致是正常默认，只有主对话本身掉到便宜档才该喊。
      if (main === CHEAP_TIER_MODEL) {
        console.warn(
          `[server] ⚠️ 主对话正在使用便宜档模型（${main}）。实测它在「客户说了目的地就摆线路」` +
            '上只有 4/12 命中（glm-5.2 是 12/12）。若非有意，请检查 .env 的 ZHIPU_MODEL / LLM_MODEL。',
        );
      }
    } else {
      console.error(
        `[server] ⚠️⚠️ LLM API Key 未配置（provider=${process.env.LLM_PROVIDER || 'default'}）：` +
          '客户每条消息都会失败（收到「系统开小差了」）。请在 .env 配置对应的 API Key，或设 LLM_MOCK=1。',
      );
    }
  }
  // 数据文件启动预检：boss 手改 routes.json 改坏 JSON 时，问题要在启动日志里就可见
  try {
    loadRoutes();
    loadHotels();
  } catch (e) {
    console.error('[server] ⚠️⚠️ 数据文件损坏，报价/推荐将持续失败：', e instanceof Error ? e.message : e);
  }
  // 语义检索索引异步构建：不阻塞启动，构建完成前 search_routes 自动走关键词匹配。
  // buildIndex 内部已兜住异常，这里再补一道 catch——`void` 掉的 promise 一旦 reject
  // 就是未捕获 rejection，Node 会直接退出，容器随之进入无限重启。
  buildIndex().catch((e) => console.error('[server] 语义索引构建异常（已降级为关键词匹配）:', e));
  // 沉默唤醒：报价后长时间没动静的客户自动追一条（默认关闭，FOLLOWUP_ENABLED=1 开启）
  startFollowUpScheduler((sessionId, text) => {
    const s = getSession(sessionId);
    return adapterFor(s?.channel ?? 'wecom').push(sessionId, text);
  });
});
startWecom();
