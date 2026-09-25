// 管理面读接口的可见性自测：未登录的人只看得到「种子演示会话 + 自己在网页里聊的会话」。
// 网页访客会在 chat.html 里留手机号、同行人这类个人信息，列表接口一旦放开，任何人打开
// admin.html 就能翻别人的对话全文、拿别人的订单号去点「已支付」。这类泄露不报错、页面照常，
// 没有断言就只能靠人去 devtools 里看。
// 直接 import app 走 app.request，不占端口；数据写进临时 VAR_DIR。
// 用法：npx tsx src/server.selftest.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomFillSync } from 'node:crypto';
import vm from 'node:vm';
import type { Order, Session } from './types.js';

// 外部给了 VAR_DIR 就在它下面建子目录（每次一个新的），否则落系统临时目录
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-server-selftest-'));
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微轮询
process.env.LLM_MOCK = '1';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'selftest-pass';
// 查询类限流调小：若列表接口误挂了限流，下面「反复拉列表」几次内就会撞上
process.env.LOOKUP_RATE_PER_MIN = '5';
// env.js 只填「尚未存在」的变量：显式置空，挡住本机 .env 里可能配着的真实企微与自动跟进
for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[k] = '';

const { app } = await import('./server.js');
const { getOrCreateSession, getSession, saveSession, createOrder } = await import('./store.js');
const { recordUsage } = await import('./usage.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------- 造数据 ----------------
const simId = () => `sim-${randomBytes(12).toString('hex')}`;
function mkSession(id: string, channel: string, text: string): Session {
  const s = getOrCreateSession(id, channel);
  s.stage = 'closing';
  s.messages.push({ role: 'customer', content: text, at: Date.now() });
  saveSession(s);
  return s;
}
function mkOrder(s: Session): Order {
  const o = createOrder({
    sessionId: s.id,
    routeId: 'r-test',
    routeTitle: '测试线路',
    travelers: 2,
    departDate: '2099-01-01',
    totalPrice: 10000,
  });
  s.orderIds.push(o.id);
  saveSession(s);
  return o;
}

const SEED = mkSession('wecom:cust_T01', 'wecom', '种子演示会话');
const REAL = mkSession('wecom:wmREALCUSTOMER01', 'wecom', '真实客户 13800001111');
const A = mkSession(simId(), 'simulator', '访客A 我手机 13911112222');
const B = mkSession(simId(), 'simulator', '访客B 我手机 13933334444');
// 旧版 chat.html 用 Math.random 生成的短 id（8 位 36 进制）
const LEGACY = mkSession('sim-k3x9q2ab', 'simulator', '旧版短 id 访客 13977778888');
const oSeed = mkOrder(SEED);
const oReal = mkOrder(REAL);
const oA = mkOrder(A);
const oB = mkOrder(B);

const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:selftest-pass').toString('base64') };
const WRONG = { authorization: 'Basic ' + Buffer.from('admin:guess').toString('base64') };
// 每组断言换一个来源 IP：限流按 IP 分桶，别让前一组的请求挤占后一组
let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;
const own = (id: string) => ({ 'x-sim-session': id });

async function getJson<T>(url: string, headers: Record<string, string> = {}, ip = freshIp()): Promise<{ status: number; body: T }> {
  const res = await app.request(url, { headers: { 'x-forwarded-for': ip, ...headers } });
  return { status: res.status, body: (await res.json()) as T };
}
const sessionIds = async (h: Record<string, string> = {}, ip?: string) =>
  (await getJson<Session[]>('/api/sessions', h, ip)).body.map((s) => s.id).sort();
const orderIds = async (h: Record<string, string> = {}, ip?: string) =>
  (await getJson<Order[]>('/api/orders', h, ip)).body.map((o) => o.id).sort();
const sorted = (...xs: string[]) => [...xs].sort();
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- 未登录：只看得到种子 + 自己 ----------------
{
  const got = await sessionIds();
  check('未带凭据：会话列表只有种子', same(got, [SEED.id]), JSON.stringify(got));
  const gotO = await orderIds();
  check('未带凭据：订单列表只有种子的订单', same(gotO, [oSeed.id]), JSON.stringify(gotO));

  const gotA = await sessionIds(own(A.id));
  check('访客 A：看得到种子 + 自己', same(gotA, sorted(SEED.id, A.id)), JSON.stringify(gotA));
  const gotAO = await orderIds(own(A.id));
  check('访客 A：订单只有种子 + 自己的', same(gotAO, sorted(oSeed.id, oA.id)), JSON.stringify(gotAO));

  const gotB = await sessionIds(own(B.id));
  check('访客 B：看得到种子 + 自己，看不到 A', same(gotB, sorted(SEED.id, B.id)), JSON.stringify(gotB));
  const gotBO = await orderIds(own(B.id));
  check('访客 B：订单里没有 A 的订单号', same(gotBO, sorted(oSeed.id, oB.id)), JSON.stringify(gotBO));

  // 响应体里连 A 的原文都不能有（不只是 id 过滤）
  const raw = JSON.stringify((await getJson('/api/sessions', own(B.id))).body);
  check('访客 B 的响应体不含别人的原话', !['13911112222', '13800001111', '13977778888'].some((x) => raw.includes(x)));
}

// ---------------- 伪造 / 不存在 / 格式不对的凭据 ----------------
{
  const forged: [string, string][] = [
    ['不存在的访客 id', simId()],
    ['A 的 id 少一位', A.id.slice(0, -1)],
    ['A 的 id 前缀', 'sim-'],
    ['A 的 id 大小写变体', A.id.toUpperCase().replace('SIM-', 'sim-')],
    ['真实客户 id 当凭据', REAL.id],
    ['种子 id 当凭据', SEED.id],
    ['两个 id 用逗号拼', `${A.id},${B.id}`],
  ];
  for (const [name, cred] of forged) {
    const got = await sessionIds(own(cred));
    check(`伪造凭据（${name}）：只有种子`, same(got, [SEED.id]), JSON.stringify(got));
    const gotO = await orderIds(own(cred));
    check(`伪造凭据（${name}）：订单只有种子`, same(gotO, [oSeed.id]), JSON.stringify(gotO));
  }
  // 查询参数不认：凭据只走请求头，免得进反代访问日志
  const viaQuery = (await getJson<Session[]>(`/api/sessions?sim=${A.id}`)).body.map((s) => s.id);
  check('查询参数带凭据不生效', same(viaQuery, [SEED.id]), JSON.stringify(viaQuery));
  const wrongPass = await sessionIds({ ...WRONG, ...own(B.id) });
  check('密码错：按未登录处理（种子 + 自己）', same(wrongPass, sorted(SEED.id, B.id)), JSON.stringify(wrongPass));
}

// ---------------- 列表凭据不能成为绕过限流的穷举口子 ----------------
// /api/sessions/:id 有 lookupLimit；列表接口跟着 SSE 高频刷新、不限流，所以只认猜不中的满熵 id。
// 旧版 chat.html 的 Math.random 短 id（约 41 bit）哪怕会话真实存在也不认，否则换个接口就能无限猜
{
  const legacy = await sessionIds(own(LEGACY.id));
  check('旧版短 id 不被列表认作本人', same(legacy, [SEED.id]), JSON.stringify(legacy));
  const direct = await getJson<Session>(`/api/sessions/${LEGACY.id}`);
  check('旧版短 id 仍可凭 id 直读（照常聊天不受影响）', direct.status === 200 && direct.body.id === LEGACY.id, String(direct.status));

  // 满熵凭据不限流：开着后台看自己对话的访客，SSE 每推一次就拉一次列表，不能被自己拉到 429
  const ip = freshIp();
  let allSeen = true;
  for (let i = 0; i < 12; i++) {
    const r = await getJson<Session[]>('/api/sessions', own(A.id), ip);
    if (r.status !== 200 || !r.body.some((s) => s.id === A.id)) allSeen = false;
  }
  check('自己的凭据反复拉列表不会被限流', allSeen);
}

// ---------------- 登录后：看全部 ----------------
{
  const got = await sessionIds(ADMIN);
  check('登录后会话列表是全量', same(got, sorted(SEED.id, REAL.id, A.id, B.id, LEGACY.id)), JSON.stringify(got));
  const gotO = await orderIds(ADMIN);
  check('登录后订单列表是全量', same(gotO, sorted(oSeed.id, oReal.id, oA.id, oB.id)), JSON.stringify(gotO));
  const withOwn = await sessionIds({ ...ADMIN, ...own(A.id) });
  check('登录后带着访客凭据也仍是全量', withOwn.length === 5, JSON.stringify(withOwn));
}

// ---------------- 靠 id 访问的单点接口：原样（id 即凭据） ----------------
{
  const a = await getJson<Session>(`/api/sessions/${encodeURIComponent(A.id)}`);
  check('访客凭自己的 id 直读会话', a.status === 200 && a.body.id === A.id, String(a.status));
  const r = await getJson(`/api/sessions/${encodeURIComponent(REAL.id)}`);
  check('真实客户会话未登录直读 401', r.status === 401, String(r.status));
  const o = await getJson<Order>(`/api/orders/${oA.id}`);
  check('支付页凭订单号读订单', o.status === 200 && o.body.id === oA.id, String(o.status));
  const ins = await getJson('/api/insights');
  check('AI 洞察未登录 401', ins.status === 401, String(ins.status));
}

// ---------------- 其余未登录可达的出口：只许有计数，不许有 id / 原文 ----------------
{
  recordUsage('glm-4.5-air', 100, 50, A.id);
  const leaks = (raw: string) =>
    [A.id, B.id, LEGACY.id, REAL.id, oA.id, oB.id, '13911112222', '13933334444', '13800001111'].filter((x) => raw.includes(x));
  const usage = JSON.stringify((await getJson('/api/usage')).body);
  check('/api/usage 不含会话 id / 原文', leaks(usage).length === 0, leaks(usage).join(','));
  const health = JSON.stringify((await getJson('/healthz')).body);
  check('/healthz 不含会话 id / 原文', leaks(health).length === 0, leaks(health).join(','));

  // 后台 SSE 免密（EventSource 带不了头）：只能推「变了」这个信号，不能带内容或会话 id
  const res = await app.request('/api/admin/stream', { headers: { 'x-forwarded-for': freshIp() } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = '';
  const readUntil = async (pred: (s: string) => boolean, ms = 3000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!pred(raw)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (!chunk || chunk.done) return pred(raw);
      raw += dec.decode(chunk.value, { stream: true });
    }
    return true;
  };
  const changes = (s: string) => (s.match(/^event: change$/gm) ?? []).length;
  await readUntil((s) => changes(s) >= 1);
  // 另一个访客此刻在网页里说了句带手机号的话 → 落盘 → 后台 SSE 推一次
  B.messages.push({ role: 'customer', content: '访客B 新消息 13955556666', at: Date.now() });
  saveSession(B);
  const got = await readUntil((s) => changes(s) >= 2);
  await reader.cancel();
  check('SSE 在数据变更时推送', got, raw);
  const sseLeaks = [...leaks(raw), ...['13955556666', 'sim-', 'wecom:', 'ord_'].filter((x) => raw.includes(x))];
  check('SSE 不含会话 id / 订单号 / 原文', sseLeaks.length === 0, sseLeaks.join(','));
  const events = [...raw.matchAll(/^event: (.*)$/gm)].map((m) => m[1]);
  const datas = [...raw.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
  check(
    'SSE 只有 change / ping 两种事件',
    events.every((e) => e === 'change' || e === 'ping'),
    events.join(','),
  );
  check(
    'SSE 的 data 只是 init 或时间戳',
    datas.every((d) => d === 'init' || /^\d+$/.test(d)),
    datas.join(','),
  );
}

// ---------------- 页面侧契约 ----------------
// 后台认「自己」全靠读 chat.html 存下的会话 id：键名或请求头名一边改了另一边没改，
// 访客在后台就再也看不到自己，且不会有任何报错。
{
  const chat = fs.readFileSync(path.resolve('public/chat.html'), 'utf8');
  const admin = fs.readFileSync(path.resolve('public/admin.html'), 'utf8');
  const key = /LS_KEY = '([^']+)'/.exec(chat)?.[1];
  check('chat.html 声明了会话 id 的存储键', !!key);
  check('admin.html 读的是同一个存储键', !!key && admin.includes(`'${key}'`));
  check('admin.html 用 x-sim-session 头带凭据', admin.includes("'x-sim-session'"));
  // id 现在是访客会话唯一的凭据：Math.random 取 8 位 36 进制只有约 41 bit，且不是密码学随机
  check('chat.html 会话 id 不用 Math.random', !/Math\.random\(\)\.toString\(36\)/.test(chat));
  // 真跑一遍页面里的生成函数：它产出的 id 必须被后台列表认作本人，否则访客边聊边看的演示效果就断了
  const fnSrc = /function newSessionId\(\) \{[\s\S]*?\n {2}\}/.exec(chat)?.[0];
  check('chat.html 有 newSessionId()', !!fnSrc);
  if (fnSrc) {
    const gen = new Function(`${fnSrc}; return newSessionId;`)() as () => string;
    const ids = new Set(Array.from({ length: 20 }, gen));
    check('newSessionId() 每次都不同', ids.size === 20);
    const fresh = mkSession(gen(), 'simulator', '新版 chat.html 访客');
    const seen = await sessionIds(own(fresh.id));
    check('chat.html 生成的 id 能被后台认作本人', same(seen, sorted(SEED.id, fresh.id)), `${fresh.id} → ${JSON.stringify(seen)}`);
  }
}

// ---------------- chat.html 支付卡片：翻历史时的订单状态 ----------------
// 改单后旧订单被替代（superseded）：pay.html、下单接口、后台都认，网页聊天历史里的旧卡片却还挂着「立即支付」，点进去才报错。
// 真跑一遍页面里的 fillPayCard（桩卡片 + 桩 fetch），看按钮上写的是什么
{
  const chat = fs.readFileSync(path.resolve('public/chat.html'), 'utf8');
  const fnSrc = /async function fillPayCard\(card, pay\) \{[\s\S]*?\n {2}\}/.exec(chat)?.[0];
  check('chat.html 有 fillPayCard()', !!fnSrc);
  if (fnSrc) {
    for (const [status, want] of [
      ['superseded', '已被新订单替代'],
      ['cancelled', '订单已取消'],
      ['paid', '已支付 · 查看订单'],
      ['pending_payment', '立即支付'],
    ]) {
      const els = new Map<string, { textContent: string; hidden: boolean; classList: { add: (c: string) => void } }>();
      const card = {
        querySelector: (sel: string) => {
          if (!els.has(sel)) els.set(sel, { textContent: sel === '.pc-btn' ? '立即支付' : '', hidden: true, classList: { add: () => {} } });
          return els.get(sel)!;
        },
      };
      const fetchStub = async () => ({
        ok: true,
        json: async () => ({ status, totalPrice: 33600, routeTitle: 'x', travelers: 2, departDate: '2026-12-10' }),
      });
      const fill = new Function('fetch', 'cnDate', `${fnSrc}; return fillPayCard;`)(fetchStub, (d: string) => d) as (
        card: unknown,
        pay: { orderId: string },
      ) => Promise<void>;
      await fill(card, { orderId: 'ord_x' });
      const got = card.querySelector('.pc-btn').textContent;
      check(`chat.html 支付卡片：${status} 显示「${want}」`, got === want, got);
    }
  }
}

// ---------------- chat.html 启动：旧版短 id 的升级 ----------------
// 上线前来过的访客，localStorage 里躺着旧版 Math.random 短 id。chat.html 只在键为空时才生成新 id，
// 旧 id 会被无限期沿用：后台列表永远不认，「边聊边在作战室看自己」对老访客就一直是断的。
// 这里在 node:vm 里真跑页面脚本（桩 DOM），fetch 直连真实路由，断言启动流程本身，而不是抠一个函数出来测。
{
  const chat = fs.readFileSync(path.resolve('public/chat.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(chat)?.[1] ?? '';
  const LS_KEY = /LS_KEY = '([^']+)'/.exec(chat)?.[1] ?? '';
  const STRONG = /^sim-[0-9a-f]{24}$/; // 与 newSessionId() 的产出一致

  // 桩元素：读不存在的属性就长出一个子桩，可调用、可赋值；只有 querySelector 返回 null
  // （否则 addMsg 会把「找不到的支付卡片」当成有，去读 null 的订单号）
  type Stub = { [k: string]: any };
  function stubEl(): Stub {
    const own: Record<string, unknown> = {};
    const listeners: Record<string, ((...a: unknown[]) => unknown)[]> = {};
    return new Proxy(function () {}, {
      get(_t, k) {
        if (k === Symbol.toPrimitive) return () => '';
        if (typeof k === 'symbol') return undefined;
        if (k in own) return own[k];
        if (k === 'addEventListener')
          return (t: string, fn: (...a: unknown[]) => unknown) => {
            (listeners[t] ??= []).push(fn);
          };
        if (k === 'listeners') return listeners;
        if (k === 'querySelector') return () => null;
        if (k === 'querySelectorAll') return () => [];
        return (own[k] = stubEl());
      },
      set(_t, k, v) {
        own[k as string] = v;
        return true;
      },
      apply: () => stubEl(),
    }) as unknown as Stub;
  }

  /** 启动一次 chat.html。respond 可以截下某个请求、直接给出响应（模拟限流等） */
  function bootChat(stored: string | null, respond?: (url: string) => Response | undefined) {
    const ls = new Map<string, string>(stored === null ? [] : [[LS_KEY, stored]]);
    const els = new Map<string, Stub>();
    const sse: string[] = [];
    const calls: { url: string; method: string; body?: string }[] = [];
    const pending: Promise<unknown>[] = [];
    const ip = freshIp();
    const ctx = {
      console,
      document: {
        getElementById: (id: string) => els.get(id) ?? (els.set(id, stubEl()), els.get(id)),
        createElement: () => stubEl(),
      },
      localStorage: {
        getItem: (k: string) => ls.get(k) ?? null,
        setItem: (k: string, v: string) => void ls.set(k, String(v)),
        removeItem: (k: string) => void ls.delete(k),
      },
      crypto: { getRandomValues: <T extends NodeJS.ArrayBufferView>(a: T) => randomFillSync(a) },
      fetch: (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
        const canned = respond?.(url);
        // 浏览器会自己带 content-length；app.request 不带，服务端的请求体上限会回 411
        const len: Record<string, string> = typeof init.body === 'string' ? { 'content-length': String(Buffer.byteLength(init.body)) } : {};
        const headers = { ...(init.headers as Record<string, string>), ...len, 'x-forwarded-for': ip };
        const p = canned ? Promise.resolve(canned) : Promise.resolve(app.request(url, { ...init, headers }));
        pending.push(p);
        return p;
      },
      EventSource: class {
        constructor(url: string) {
          sse.push(url);
        }
        addEventListener() {}
      },
      Event: class {
        constructor(public type: string) {}
      },
      location: { reload() {} },
      setInterval: () => 0,
      clearInterval: () => {},
    };
    vm.runInNewContext(script, ctx);
    const settle = async () => {
      for (let n = -1; n !== pending.length;) {
        n = pending.length;
        await Promise.allSettled(pending);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const say = (text: string) => {
      els.get('input')!.value = text;
      els.get('sendBtn')!.disabled = false; // 桩上没赋过值的属性是个（真值的）子桩
      for (const fn of els.get('sendBtn')!.listeners.click ?? []) fn();
    };
    const posted = () => calls.filter((x) => x.method === 'POST').map((x) => JSON.parse(x.body ?? '{}').sessionId as string);
    return { id: () => ls.get(LS_KEY) ?? '', sse, calls, settle, say, posted };
  }

  // 1) 旧 id、服务端没有这段会话（从没聊过 / 闲置被清理）→ 换成满熵新 id，SSE 与发消息都用新 id
  {
    const OLD = 'sim-q7w2e9rz';
    const page = bootChat(OLD);
    await page.settle();
    const id = page.id();
    check('旧版短 id + 服务端 404：换成满熵新 id 并写回存储', STRONG.test(id), id);
    check('旧版短 id + 服务端 404：SSE 订阅的是新 id', page.sse.length === 1 && page.sse[0].endsWith('/' + id), JSON.stringify(page.sse));
    page.say('老访客D 我手机 13577778888');
    await page.settle();
    check('升级后发消息用的是新 id', same(page.posted(), [id]), JSON.stringify(page.posted()));
    check('旧 id 名下没有生出新会话', !getSession(OLD));
    const seen = await sessionIds(own(id));
    check('升级后的老访客在后台看得到自己', same(seen, sorted(SEED.id, id)), JSON.stringify(seen));
  }

  // 2) 抢在历史读回来之前就发（点开场气泡）：第一句也不能落进旧 id，否则对话被劈成两段
  {
    const OLD = 'sim-h4n8m1xk';
    const page = bootChat(OLD);
    page.say('想去西藏，两个人');
    await page.settle();
    const id = page.id();
    check('抢先发的第一句也走新 id', STRONG.test(id) && same(page.posted(), [id]), `${id} ← ${JSON.stringify(page.posted())}`);
    check('抢先发：旧 id 名下没有会话', !getSession(OLD));
  }

  // 3) 旧 id 的会话还在：不换，换了就翻不到历史
  {
    const page = bootChat(LEGACY.id);
    await page.settle();
    check('旧版短 id 会话仍在：不换 id（保住历史）', page.id() === LEGACY.id, page.id());
  }

  // 4) 读历史被限流 / 服务端出错：不是「没有这段会话」，不能换
  for (const status of [429, 500]) {
    const OLD = 'sim-z5c3v7bq';
    const page = bootChat(OLD, (url) => (url.startsWith('/api/sessions/') ? new Response('{}', { status }) : undefined));
    await page.settle();
    check(`旧版短 id + 读历史 ${status}：不换 id`, page.id() === OLD, page.id());
  }

  // 5) 满熵 id 的会话被清理了：照旧沿用（猜不中，没必要换）；空存储照旧生成新 id
  {
    const strong = simId();
    const page = bootChat(strong);
    await page.settle();
    check('满熵 id + 404：沿用不换', page.id() === strong, page.id());
    const blank = bootChat(null);
    await blank.settle();
    check('空存储：生成满熵新 id', STRONG.test(blank.id()), blank.id());
  }
}

// ---------------- 支付页的摘要：出发日期与企微卡片同一写法 ----------------
// 卡片写「10月12日出发」，同一笔订单的支付页 description / og:description 却是「2026-10-12 出发」
{
  const y = new Date().getFullYear();
  const s = mkSession(simId(), 'simulator', '支付页日期');
  for (const [departDate, want] of [
    [`${y}-10-12`, '10月12日出发'],
    [`${y + 1}-01-05`, `${y + 1}年1月5日出发`],
  ] as const) {
    const o = createOrder({
      sessionId: s.id,
      routeId: 'r-sanya',
      routeTitle: '三亚亲子奢华度假 5 日',
      travelers: 2,
      departDate,
      totalPrice: 34760,
    });
    const html = await (await app.request(`/pay/${o.id}`)).text();
    const desc = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '';
    check(`支付页摘要日期写成「${want}」`, desc === `2 位出行 · ${want} · 合计 ¥34,760`, desc);
  }
}

// ---------------- 改单后被替代的旧单：不能再付，支付页说清楚 ----------------
// 此前付款接口只看「是不是已付」，客户翻聊天记录点开改单前那条旧链接照样付款成功，一趟行程收两笔钱
{
  const store = await import('./store.js');
  const s = mkSession(simId(), 'simulator', '改单');
  const mk = (departDate: string) =>
    createOrder({ sessionId: s.id, routeId: 'r-sanya', routeTitle: '三亚亲子奢华度假 5 日', travelers: 2, departDate, totalPrice: 34760 });
  const oldO = mk('2099-01-01');
  const newO = mk('2099-01-02');
  s.orderIds.push(oldO.id, newO.id);
  store.getOrder(oldO.id)!.status = 'superseded';
  store.getOrder(oldO.id)!.supersededBy = newO.id;
  const post = (id: string) => app.request(`/api/orders/${id}/pay`, { method: 'POST', headers: { 'x-forwarded-for': freshIp() } });
  const rejected = await post(oldO.id);
  check('被替代的旧单：付款接口拒绝', rejected.status === 409, String(rejected.status));
  check('被替代的旧单：状态不变成已付', store.getOrder(oldO.id)?.status === 'superseded', String(store.getOrder(oldO.id)?.status));
  const html = await (await app.request(`/pay/${oldO.id}`)).text();
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  check('被替代的旧单：支付页标题写明已被替代', title.includes('已被替代'), title);
  const ok = await post(newO.id);
  check('新单照常付', ok.status === 200 && store.getOrder(newO.id)?.status === 'paid', String(ok.status));
  const supersede = (store as { supersedeOrder?: (id: string, by: string) => boolean }).supersedeOrder;
  check('已付款的单不能被替代', !!supersede && !supersede(newO.id, oldO.id) && store.getOrder(newO.id)?.status === 'paid');
  const payPage = fs.readFileSync(path.resolve('public/pay.html'), 'utf8');
  check('支付页脚本对 superseded 不给付款按钮', /order\.status === 'superseded'[\s\S]{0,200}show\('err'\)/.test(payPage));
  const adminPage = fs.readFileSync(path.resolve('public/admin.html'), 'utf8');
  check('后台把被替代的单标成「已被替代」、金额取仍有效的那张', adminPage.includes("'已被替代'") && adminPage.includes('liveOrder(s)'));
}

if (fails.length) {
  console.error(`SERVER SELFTEST FAIL: ${fails.length} 项未通过`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `SERVER SELFTEST PASS: ${pass} 项断言全通（未登录只见种子 + 自己 / 伪造凭据 / 短 id 不认且本人不被限流 / 登录看全量 / 单点接口不变 / usage·healthz·SSE 不泄露 / 页面契约 / chat.html 升级旧版短 id）`,
);
process.exit(0); // SSE 的 ping 循环还挂着 20s 的 sleep，不等它
