// HTTP 服务：静态页面 + 模拟器 API + 管理后台 API + 企微回调。
// 注意路由注册顺序：API 在前，serveStatic 兜底在后。
// 管理 API 走 Basic 鉴权，读写分层见 adminAuth；admin.html 页面本身免密（未登录只看得到演示数据，prod 下什么都看不到）。
// demo 与 prod 的差别只经 profile().flags 的开关体现（00 spec「部署 profile 与开关」），每次用到时现读。
import './env.js'; // 必须第一个 import：加载 .env（此前 .env 从未被读取，README 的跑法照做即挂）
import './profile-boot.js'; // 紧接着解析部署 profile：配置错误时打一行原因退出，必须排在任何会 import store 的模块之前
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import { handleMessage, notifyPaid, promptPrefix, sopFileText } from './engine.js';
import { createQuote, enterHandoff, loadHotels, loadRoutes } from './tools.js';
import {
  getOrder,
  getSession,
  gracefulExit,
  listOrders,
  listSessions,
  markOrderPaid,
  onShutdown,
  saveSession,
  storeEvents,
} from './store.js';
import { getDraftReply, getInsights, getSuggestion } from './insight.js';
import { activeModels, CHEAP_TIER_MODELS, llmCfg, llmStats } from './llm.js';
import { budgetStatus } from './budget.js';
import { usageToday } from './usage.js';
import { gateStatus } from './llm-gate.js';
import { buildIndex } from './retrieval.js';
import { startFollowUpScheduler } from './followup.js';
import { simulatorAdapter, subscribe } from './adapters/simulator.js';
import { startWecom, syncFromCallback, wecomAdapter } from './adapters/wecom.js';
import { computeSignature, decryptWecom, safeEqual } from './wecom-crypto.js';
import { numEnv } from './env.js';
import { clientKey, lookupLimit, makeLimiter, sameOriginOnly } from './http-guards.js';
import { profile } from './profile.js';
import type { ChannelAdapter } from './types.js';
import { boot } from './boot.js';
import { closeConfig, configHealth, configMode, initConfigFromEnv, markConfigShuttingDown, prefixSummary } from './config/source.js';
import { consoleApi, consoleSession } from './console-api/app.js';
import { consolePages } from './console-api/host.js';

const app = new Hono();

// channel 来自落盘的会话 JSON：数据改坏、或加了新渠道漏接这里，都会落到兜底。兜底此前是模拟器，
// 没有 SSE 连接时它的 push 返回 true，后台显示「已回复」，实际什么也没发出去。现在兜底一律推送失败，
// 调用方按「没送达」各自处理（人工回复与付款记备注、跟进退账）。不能 throw：付款路由在 markOrderPaid
// 之后才调它，抛出会让一个已经付款成功的请求返回 500
function adapterFor(channel: string): ChannelAdapter {
  if (channel === 'wecom') return wecomAdapter;
  if (channel === 'simulator') return simulatorAdapter;
  return {
    name: 'unknown',
    push(sessionId) {
      console.error(`[server] ⚠️ 会话 ${sessionId} 的渠道「${channel}」未知，消息未送达`);
      return Promise.resolve(false);
    },
  };
}

// ---------------- 管理面鉴权 ----------------
// 分两层，而不是一个「读写一起开关」的总闸：
//   · 读：免密可看，但服务端只吐演示数据：种子会话 wecom:cust_*，外加请求者**本人**的网页访客会话。
//     真实企微客户与其他访客的会话在未登录时**根本不进入响应体**，不是靠前端隐藏。
//   · 写：接管 / 发消息 / 交还，以及所有走 LLM 计费的端点，一律要 ADMIN_PASS。
//
// 早先的写法是一个「免密公开」开关同时打开读和写。那种设计的问题不在默认值，而在于
// 它把两个风险等级完全不同的能力绑在一个布尔值上：演示只需要「读」，而「写」——以顾问
// 身份给真实微信客户发消息——永远没有免密的正当理由。于是开关被彻底移除：
// 现在没有任何环境变量能放行写操作，配错的最坏结果是「后台不可用」，而不是「全网可写」。
// 未配 ADMIN_PASS 时：读仍是演示模式（可用），写返回 503。
// 免密的那一层读由开关 anon_readonly_admin 决定：prod 下关掉，读也要凭据（prod 没配 ADMIN_PASS 起不来）。

/**
 * 演示数据：种子会话与网页访客，绝不含真实企微客户。启动自检不计入真实客户，按它判断；凭 ID 直读见 sessionReadAuth。
 * 它**不是**列表的可见范围：此前列表按它过滤，sim-* 人人可见——演示链接一公开，任何人打开后台就能
 * 翻陌生访客在网页里留的手机号，拿他们的订单号去点「已支付」。列表口径见 anonVisible。
 */
const DEMO_DATA_RE = /^(?:wecom:cust_|sim-)/;
/** 种子演示会话：未登录人人可见，后台演示要有内容 */
const SEED_SESSION_RE = /^wecom:cust_/;

/**
 * 访客「本人」的凭据：chat.html 把会话 id 存在同源 localStorage，admin.html 读出来经 x-sim-session 头带上。
 * 访客一边在网页里聊、一边在作战室里实时看到自己那段对话——这个演示效果靠它保留。
 *
 * 只认满熵的 id（chat.html 与 /api/chat 生成的都是 24 位十六进制 = 96 bit）。列表接口跟着全站 SSE
 * 变更信号高频刷新，挂不了 /api/sessions/:id 那样的查询限流（开着后台的访客会被自己刷到 429）；
 * 能不限流的前提是这个头只接受猜不中的值。旧版 chat.html 的 id 是 Math.random 取 8 位 36 进制
 * （约 41 bit），在这里一律不认——否则这个头就成了不限速的穷举探针。旧 id 照常能聊、能凭 id 直读，
 * 只是后台不显示；chat.html 发现服务端已没有这段会话（404）时自动换成新格式，点「新会话」也会换。
 * 只走请求头、不认查询参数：URL 会进反代访问日志。
 */
const OWN_SIM_RE = /^sim-[0-9a-f]{24,64}$/;

/** 未登录时列表接口对这个请求可见的会话：种子演示会话 + 请求者本人的访客会话（id 完全一致才算）。 */
function anonVisible(c: Context): (sessionId: string) => boolean {
  const cred = c.req.header('x-sim-session') ?? '';
  const own = OWN_SIM_RE.test(cred) ? cred : null;
  return (id) => SEED_SESSION_RE.test(id) || id === own;
}

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
    return c.json({ error: '管理操作已锁定：服务端未配置 ADMIN_PASS。在 .env 设置 ADMIN_USER/ADMIN_PASS 后重建容器即可。' }, 503);
  }
  if (isAdminReq(c)) return next();
  return c.json({ error: 'unauthorized' }, 401);
}

/**
 * 会话列表、订单列表与 /api/usage 的免密读。anon_readonly_admin 关掉（prod）时没有这一层：
 * 不带有效凭据一律按 adminAuth 拒绝，连种子会话也不给。开着时照旧放行，响应体再按 isAdminReq 过滤。
 */
const anonReadable: MiddlewareHandler = async (c, next) => (profile().flags.anon_readonly_admin ? next() : adminAuth(c, next));

/** 单会话读取：演示会话（种子/访客）凭自身不可猜的 ID 直读，真实客户会话必须登录。
 *  demo 分支额外走一道限流：ID 是凭据，不限流就等于允许慢速穷举。
 *  两类演示会话各归一个开关：sim- 直读是网页模拟器的一部分（chat.html 靠它恢复历史），只看 visitor_simulator，
 *  关掉时接口当作不存在，带不带凭据都是 404；种子直读属于后台免密读，anon_readonly_admin 关掉就和真实客户一样要登录。 */
async function sessionReadAuth(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param('id') ?? '';
  if (id.startsWith('sim-')) return profile().flags.visitor_simulator ? lookupLimit(c, next) : c.notFound();
  if (SEED_SESSION_RE.test(id) && profile().flags.anon_readonly_admin) return lookupLimit(c, next);
  return adminAuth(c, next);
}

// 导览页只为网页模拟器和扫码体验而设；visitor_simulator 关掉（prod）时没有它，首页直接进后台
app.get('/', (c) => c.redirect(profile().flags.visitor_simulator ? '/guide.html' : '/admin.html'));
// 健康检查顺带暴露访客 LLM 预算用量，方便随时查「今天被刷了多少」；
// llm 一栏看强制思考档位、1210 自愈次数、对冲触发/胜出次数——这几样出问题时不报错，只会变慢或变贵。
// revision 是部署时的 git tag（deploy.sh 经 Dockerfile 的 APP_REVISION 写进镜像）：回滚到 :prev 后报的是上一版的 tag，
// 线上跑的是哪一版一眼可查；本地 pnpm start 没有这个变量，报 dev
/**
 * 配置源的摘要（01 spec「两种模式与启动装载」）：哈希都取前 12 位。DB 模式取缓存；文件模式按当前文件现算，
 * sopVersion 与 lock 为 null。文件读不到时哈希为 null，不让 /healthz 因此 500
 */
function configSummary(): Record<string, unknown> {
  const mode = configMode();
  const health = mode === 'db' ? configHealth() : null;
  let hashes: Record<string, unknown> = { sopVersion: null, promptHash: null, toolsHash: null, prefixHash: null, sopHash: null };
  try {
    const p = prefixSummary(() => ({ ...promptPrefix(), sop: sopFileText() }));
    hashes = {
      sopVersion: p.sopVersion,
      promptHash: p.promptHash.slice(0, 12),
      toolsHash: p.toolsHash.slice(0, 12),
      prefixHash: p.prefixHash.slice(0, 12),
      sopHash: p.sopHash.slice(0, 12),
    };
  } catch {
    /* 文件模式下 SOP 读不到：启动预检另有告警 */
  }
  return { mode, ...hashes, lock: health?.lock ?? null, sopStale: health?.sopStale ?? false, catalogStale: health?.catalogStale ?? false };
}

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    revision: process.env.APP_REVISION || 'dev',
    models: activeModels(),
    visitorLLM: budgetStatus(),
    llmGate: gateStatus(),
    llm: llmStats(),
    config: configSummary(),
  }),
);

// 模型用量与成本（JD 明确要求的「模型调用成本」指标）
// 用量与成本：聚合数字，不含任何客户信息，演示模式下也放行（这正是要展示的指标之一）
app.get('/api/usage', anonReadable, (c) => c.json(usageToday()));

// ---------------- 模拟器聊天 ----------------

const SIM_SESSION_RE = /^sim-[A-Za-z0-9_-]{1,64}$/;

/** 网页模拟器的入口：visitor_simulator 关掉（prod）时当作不存在，一律 404。访客清理不归它管，照常运行（store.ts） */
const simulatorOnly: MiddlewareHandler = async (c, next) => (profile().flags.visitor_simulator ? next() : c.notFound());

// /api/chat 是公网匿名端点且每次调真实 LLM——不加限流等于把 LLM 账单和
// sessions.json 的增长交给任何写脚本的人。滑动窗口按 IP 计数，内存实现够用。
const CHAT_RATE_PER_MIN = Math.max(1, numEnv('CHAT_RATE_PER_MIN', 20));
const chatRateLimited = makeLimiter(CHAT_RATE_PER_MIN);
// 全站请求体上限。验签/限流都发生在读 body 之后，没有上限时几条慢速大 body 请求
// 就能把容器内存吃满（docker run 未设 -m）。企微回调和聊天请求都只有几 KB 量级。
const MAX_BODY_BYTES = Math.max(1024, numEnv('MAX_BODY_BYTES', 64 * 1024));
app.use('/*', async (c, next) => {
  const declared = c.req.header('content-length');
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    return c.text('payload too large', 413);
  }
  // 缺 Content-Length 就是 chunked 编码，上面那行按「声明值」判断对它完全无效：
  // 实测 8MB / 32MB 的 chunked body 能直达应用并被整个读进内存。此前把这层
  // 兜底口头委托给了 Caddy 的 request_body，但线上并没有配，于是两层皆空。
  // 这里的客户端只有企微服务器和浏览器 fetch，两者必然带 Content-Length，
  // 所以直接拒掉「有 body 却不声明长度」的请求——比事后截断简单，也更难写错。
  if (declared === undefined && c.req.raw.body !== null) {
    return c.text('length required', 411);
  }
  return next();
});

/**
 * 从 XML 里取第一个 `<tag>` 的文本（自动剥 CDATA），索引扫描而非正则。
 *
 * 原先用 `/<Tag><!\[CDATA\[([\s\S]*?)\]\]><\/Tag>/` 这种「惰性通配 + 多字符终止符」的写法，
 * 遇到「大量重复开标签且永不闭合」的构造输入会二次回溯。而它跑在 /wecom/callback 的
 * **验签之前**、作用于未鉴权可达的完整 body 上——实测一条 4MB 构造请求就让整站
 * 不可用约两分钟（Node 单线程，事件循环被同步正则占死，客户端断开也不会停）。
 * 索引扫描是线性的，且这里本来就只需要第一个匹配。
 */
function extractTag(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const s = xml.indexOf(open);
  if (s < 0) return undefined;
  const e = xml.indexOf(close, s + open.length);
  if (e < 0) return undefined;
  const inner = xml.slice(s + open.length, e);
  const CDATA_OPEN = '<![CDATA[';
  const CDATA_CLOSE = ']]>';
  if (inner.startsWith(CDATA_OPEN) && inner.endsWith(CDATA_CLOSE)) {
    return inner.slice(CDATA_OPEN.length, inner.length - CDATA_CLOSE.length);
  }
  return inner;
}

app.post('/api/chat', simulatorOnly, async (c) => {
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
app.get('/api/stream/:sessionId', simulatorOnly, lookupLimit, (c) => {
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
// 只推「变了」这个信号、不带任何数据（没有会话 id、没有原文），故免密——真正的数据仍由下面的读端点
// 按登录态与本人凭据过滤。它因此也不需要访客凭据，凭据不必进 URL。
// 也必须免密：EventSource 无法自定义请求头，带不了 Authorization。
// anon_readonly_admin 关着时（prod）要求有效的后台会话，同源 EventSource 会带上 cookie；没有就 401，
// admin.html 已有的 30 秒轮询兜底照常（01 spec「鉴权」）
app.get('/api/admin/stream', async (c) => {
  if (!profile().flags.anon_readonly_admin && !(await consoleSession(c))) return c.json({ error: '需要登录后台' }, 401);
  return streamSSE(c, async (stream) => {
    let alive = true;
    const onChange = () => {
      void stream.writeSSE({ event: 'change', data: String(Date.now()) });
    };
    storeEvents.on('change', onChange);
    stream.onAbort(() => {
      alive = false;
      storeEvents.off('change', onChange);
    });
    await stream.writeSSE({ event: 'change', data: 'init' }); // 连上先触发一次首屏加载
    // alive 由上面的 onAbort 回调置 false，不是死循环
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (alive) {
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      await stream.sleep(20000);
    }
  });
});

// AI 洞察（LLM 生成，服务端缓存；失败返回空数组，前端回退规则版）
app.get('/api/insights', adminAuth, async (c) => {
  try {
    return c.json({ insights: await getInsights() });
  } catch {
    return c.json({ insights: [] });
  }
});

// 下一步建议（按会话 LLM 生成，缓存；失败返回空，前端回退规则版）
app.get('/api/sessions/:id/suggestion', adminAuth, async (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ suggestion: '' }, 404);
  try {
    return c.json({ suggestion: await getSuggestion(s) });
  } catch {
    return c.json({ suggestion: '' });
  }
});

// 会话列表：未登录只返回种子会话与本人的访客会话。过滤发生在服务端——真实客户和其他访客的会话
// 不进响应体，而不是前端拿到全量再隐藏（后者用 devtools 一看就穿）。
app.get('/api/sessions', anonReadable, (c) => {
  const all = listSessions();
  if (isAdminReq(c)) return c.json(all);
  const visible = anonVisible(c);
  return c.json(all.filter((s) => visible(s.id)));
});

app.get('/api/sessions/:id', sessionReadAuth, (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json(s);
});

app.post('/api/sessions/:id/handoff', sameOriginOnly, adminAuth, (c) => {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) return c.json({ error: 'session not found' }, 404);
  // 与引擎触发的转人工走同一个入口：记下被「吸」走前的阶段（交还时还原用），重复接管不覆盖
  enterHandoff(s);
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
  // 只在原阶段是 handoff（被转人工"吸"走）时才还原——否则会把 closing 的客户
  // 拉回 quote，成交概率、漏斗计数跟着倒退，且已落盘不可逆。
  if (s.stage === 'handoff') {
    // 优先用接管前记下的真实阶段。反推只是没有该记录时的兜底：它对「阶段已推进、
    // 但推进过程不由本系统记录」的会话必然失真（种子演示会话 stage=quote 却无
    // lastQuote，反推会一路掉到 discovery——现场演一次接管就把客户打回问需）。
    const paid = s.orderIds.map((id) => getOrder(id)).some((o) => o?.status === 'paid');
    const inferred = paid ? 'paid' : s.orderIds.length ? 'closing' : s.lastQuote ? 'quote' : 'discovery';
    // 已支付是既成事实，优先级高于记录值（接管期间完成支付的情况）
    s.stage = paid ? 'paid' : (s.stageBeforeHandoff ?? inferred);
    delete s.stageBeforeHandoff;
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
  try {
    return c.json({ draft: await getDraftReply(s) });
  } catch {
    return c.json({ draft: '' });
  }
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

// 订单列表：同会话列表口径。订单号是 /pay 的凭据、sessionId 是读对话全文的凭据，
// 漏一条别人的订单就等于把这两样都交了出去
app.get('/api/orders', anonReadable, (c) => {
  const all = listOrders();
  if (isAdminReq(c)) return c.json(all);
  const visible = anonVisible(c);
  return c.json(all.filter((o) => visible(o.sessionId)));
});

// 单订单读取对支付页开放：订单号即凭据（不可猜的随机 ID，列表接口只给登录者与订单本人，不可枚举）
app.get('/api/orders/:id', lookupLimit, (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'order not found' }, 404);
  return c.json(o);
});

/**
 * 谁能调模拟支付，由 mock_pay 决定。关掉（prod）时匿名请求永远标不了已付（00 spec「mock_pay 与 prod 的真实客户」）：
 * 不带有效凭据一律 404，像这个接口不存在；带凭据的是顾问手工确认收款（验收、预演用，去留由 02 定），
 * 它是写操作，和管理写接口一样过 sameOriginOnly。开着时照旧人人可付。
 */
const payAuth: MiddlewareHandler = async (c, next) => {
  if (profile().flags.mock_pay) return next();
  if (!isAdminReq(c)) return c.notFound();
  return sameOriginOnly(c, next);
};

// 演示用模拟支付：真实生产必须替换为微信支付服务端回调验签，此端点仅 demo 闭环用
app.post('/api/orders/:id/pay', payAuth, lookupLimit, async (c) => {
  const id = c.req.param('id');
  const order = getOrder(id);
  if (!order) return c.json({ error: 'order not found' }, 404);
  // 改单后被新订单替代的旧单（或已取消的）不能再付：客户翻聊天记录点开旧链接，此前照样付款成功，一趟行程收两笔钱
  if (order.status === 'superseded' || order.status === 'cancelled') {
    return c.json({ error: order.status === 'superseded' ? '这笔订单已被新订单替代' : '订单已取消', order }, 409);
  }
  if (order.status !== 'paid') {
    markOrderPaid(id);
    // 引擎生成跟进话术并更新会话，服务端只负责经渠道推给客户
    const followUp = await notifyPaid(id);
    if (followUp) {
      const s = getSession(followUp.sessionId);
      const sent = await adapterFor(s?.channel ?? 'simulator').push(followUp.sessionId, followUp.text);
      // 同 /reply：会话里记着「已收到您的支付」，客户却没收到，得让顾问在后台看见、去另行告知。
      // 种子会话除外：对应的企微客户是编造的，推送必然失败，公开演示每付一次就会多一条失败备注
      if (!sent && s && !SEED_SESSION_RE.test(s.id)) {
        s.messages.push({
          role: 'system',
          content: '⚠️ 上一条付款确认未能发送到客户（推送失败：可能是 48h 会话窗口已关闭或渠道配置问题），请另行告知客户已收到付款',
          at: Date.now(),
        });
        saveSession(s);
      }
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
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
  // 被替代的旧单：微信里转发出去的卡片标题、摘要也别再写着待支付的金额
  if (o.status === 'superseded') {
    const t = `${o.routeTitle} · 订单已被替代`;
    const d = '这笔订单已被新订单替代，请以最新发给您的支付链接为准';
    return c.html(
      html.replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${esc(t)}</title>\n<meta name="description" content="${esc(d)}">\n` +
          `<meta property="og:title" content="${esc(t)}">\n<meta property="og:description" content="${esc(d)}">`,
      ),
    );
  }
  const title = `${o.routeTitle} · 订单支付`;
  // 出发日期与企微卡片、网页支付卡片同一写法（「10月12日出发」，跨年才带年份），别是「2026-10-12 出发」
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(o.departDate ?? '');
  const when = !o.departDate
    ? '日期待定'
    : !d
      ? `${o.departDate}出发`
      : `${Number(d[1]) === new Date().getFullYear() ? '' : `${d[1]}年`}${Number(d[2])}月${Number(d[3])}日出发`;
  const desc = `${o.travelers} 位出行 · ${when} · 合计 ¥${o.totalPrice.toLocaleString('zh-CN')}`;
  return c.html(
    html.replace(
      /<title>[\s\S]*?<\/title>/,
      `<title>${esc(title)}</title>\n` +
        `<meta name="description" content="${esc(desc)}">\n` +
        `<meta property="og:title" content="${esc(title)}">\n` +
        `<meta property="og:description" content="${esc(desc)}">`,
    ),
  );
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
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
  // 缩略图必须是绝对 URL：微信/各类抓取方不解析相对路径。
  // 微信自带的「发送给朋友」不读 og:image，它是在页面里自己挑一张图当缩略图——
  // 这里只改 head（meta）；那张给微信挑的真实封面图由 proposal.html 在客户端渲染进 body
  // （1px 不行，太小会被跳过）。
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
  const encrypt = extractTag(raw, 'Encrypt');
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
    const syncToken = extractTag(msg, 'Token');
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

// 后台接口与后台前端（01 spec「后台 API 与页面」「构建与部署」）：都注册在 serveStatic 兜底之前。
// 子应用自己兜住没匹配上的 /api/console/*（JSON，不是 index.html）；/console/* 的 SPA 回退只管 /console 下面
app.route('/', consoleApi);
app.route('/', consolePages);

// 静态资源兜底（admin.html / chat.html / pay.html / guide.html）。
// admin.html 页面本身不再鉴权：它进来只会看到演示数据，页面内的登录框负责换取
// 真实客户会话与写权限。页面是空壳，凭据永远由下面的 API 层判定。
// 网页模拟器的两个页面在 visitor_simulator 关掉（prod）时当作不存在，其余页面照常。按文件名比、不分大小写：
// macOS 的文件系统不分大小写，/CHAT.html 也读得到 chat.html。c.req.path 已经解过码（/%63hat.html 在这里就是
// /chat.html）；serveStatic 再解一次只会多出字面的 %xx，拼不回这两个文件名。
const SIMULATOR_PAGE_RE = /\/(?:chat|guide)\.html$/i;
app.use('/*', async (c, next) => (profile().flags.visitor_simulator || !SIMULATOR_PAGE_RE.test(c.req.path) ? next() : c.notFound()));
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

// server.selftest.ts 直接 import app、走 app.request 测路由：自测不能占端口，更不能起企微轮询与
// 自动跟进（本机 .env 若配了企微，自测进程会去拉真实客户消息、以 AI 身份回复）。
export { app };
const SELFTEST = process.env.SERVER_SELFTEST === '1';

const port = Number(process.env.PORT) || 3200;

/** 监听成功后先打的几行配置自检（与配置源无关，原样保留） */
function logStartup(listeningPort: number): void {
  console.log(`[server] 已启动 http://localhost:${listeningPort}`);
  // 配置漂移自检：按「实际数据」喊，而不是只描述配置。
  // 「密码没配」这件事单看配置是察觉不到的——没人会定期去翻 .env，
  // 而一旦真实客户已经进来了，它的含义就从「无所谓」变成「你看不到也接管不了他们」。
  const realSessions = listSessions().filter((s) => !DEMO_DATA_RE.test(s.id)).length;
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
    const { apiKey, baseUrl } = llmCfg();
    if (apiKey) {
      const { main, cheap } = activeModels();
      const { hedgeModel, hedgeMs, hedgeMsFollowup, reasoningEffort, forcedThinkingModels } = llmStats();
      console.log(`[server] LLM: ${process.env.LLM_PROVIDER || 'default'} / 对话=${main} · 后台=${cheap} @ ${baseUrl}`);
      console.log(
        `[server] LLM 对冲=${hedgeModel ? `${hedgeModel}（主模型 ${hedgeMs}ms 未返回时启用 · 工具往返后 ${hedgeMsFollowup}ms）` : '关'}` +
          (forcedThinkingModels.length ? ` · 强制思考 ${forcedThinkingModels.join('/')} 档位=${reasoningEffort}` : ''),
      );
      // 静默降级是最难查的故障：主对话跑到便宜档上，表现只是「话术变差了」，
      // 不报错也不告警。后台跟主模型一致是正常默认，只有主对话本身掉到便宜档才该喊。
      if (CHEAP_TIER_MODELS.has(main)) {
        console.warn(
          `[server] ⚠️ 主对话正在使用便宜档模型（${main}）。实测 glm-4.5-air 在「客户说了目的地就摆线路」` +
            '上只有 4/48 命中（现用 glm-5.3-flashx 带预取是 48/48）。若非有意，请检查 .env 的 ZHIPU_MODEL / LLM_MODEL。',
        );
      }
    } else {
      console.error(
        `[server] ⚠️⚠️ LLM API Key 未配置（provider=${process.env.LLM_PROVIDER || 'default'}）：` +
          '客户每条消息都会失败（收到「系统开小差了」）。请在 .env 配置对应的 API Key，或设 LLM_MOCK=1。',
      );
    }
  }
}

if (!SELFTEST) {
  // 配置源的停机：普通阶段起就忽略锁连接的事件，late 阶段（在途回复都结束后）才释放锁、关连接池
  onShutdown(markConfigShuttingDown);
  onShutdown(closeConfig, { phase: 'late' });
  await boot({
    initConfig: () => initConfigFromEnv(process.env, (code) => gracefulExit(code, '租户锁被另一个进程拿走')),
    serve: (onListening) =>
      void serve({ fetch: app.fetch, port }, (info) => {
        logStartup(info.port);
        onListening();
      }),
    // 数据文件启动预检：boss 手改 routes.json 改坏 JSON 时，问题要在启动日志里就可见
    preflight: () => {
      try {
        loadRoutes();
        loadHotels();
      } catch (e) {
        console.error('[server] ⚠️⚠️ 数据文件损坏，报价/推荐将持续失败：', e instanceof Error ? e.message : e);
      }
    },
    // 语义检索索引异步构建：不阻塞启动，构建完成前 search_routes 自动走关键词匹配
    buildIndex,
    // 沉默唤醒：报价后长时间没动静的客户自动追一条（默认关闭，FOLLOWUP_ENABLED=1 开启）
    startFollowUpScheduler: () =>
      startFollowUpScheduler((sessionId, text) => {
        const s = getSession(sessionId);
        return adapterFor(s?.channel ?? 'wecom').push(sessionId, text);
      }),
    startWecom,
    exit: (code) => process.exit(code),
  });
}
