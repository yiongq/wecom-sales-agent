// 企业微信「微信客服」（kf）适配器：回调驱动 + 兜底轮询。
//
// 接入步骤（真实联调时按此走）：
// 1. 注册企业微信，管理后台开通「微信客服」，建一个客服账号，记下 open_kfid；
// 2. 建自建应用，拿到 corpid + 应用 secret；
// 3. 在「微信客服 → 可调用接口的应用」里绑定该自建应用（不绑则 sync_msg 报 95017）；
// 4. 管理后台配置「企业可信 IP」为部署机出口 IP（不配则 API 报 60020）；
// 5. .env 填 WECOM_CORP_ID / WECOM_APP_SECRET / WECOM_KF_OPEN_KFID，
//    以及 PUBLIC_BASE_URL（回复里的 /pay/ 链接会拼成完整 URL，客户才点得开）。
//
// 可靠性设计：
// - msgid 去重随 cursor 一起持久化（var/wecom-cursor.json）——进程重启/容器重建后
//   重拉的历史消息不会被重复回复；淘汰按插入序删最旧（不整体清空）。
// - 同步互斥期间收到的新触发不丢弃：记 pending，本轮结束立刻补拉。
// - 同一批消息按客户分组并发处理：同客户保序，跨客户不互相拖慢。
// - send_msg 失败重试（限流/网络类），超企微 2048 字节上限的长文自动分段。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelAdapter } from '../types.js';
import { handleMessage } from '../engine.js';
import { getOrder, getSession, saveSession } from '../store.js';
import { loadRoutes } from '../tools.js';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const VAR_DIR = process.env.VAR_DIR ?? path.resolve('var');
const STATE_FILE = path.join(VAR_DIR, 'wecom-cursor.json');
const SESSION_PREFIX = 'wecom:';

interface WecomConfig {
  corpId: string;
  secret: string;
  openKfId: string;
  pollIntervalMs: number;
  publicBaseUrl: string;
}

/** 每次现读 env（而非模块加载时快照），保证 server 先加载 .env 也能生效 */
function readConfig(): WecomConfig | null {
  const corpId = process.env.WECOM_CORP_ID;
  const secret = process.env.WECOM_APP_SECRET;
  const openKfId = process.env.WECOM_KF_OPEN_KFID;
  if (!corpId || !secret || !openKfId) return null;
  return {
    corpId,
    secret,
    openKfId,
    pollIntervalMs: Math.max(1000, Number(process.env.WECOM_POLL_INTERVAL_MS) || 3000),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
  };
}

export function isWecomEnabled(): boolean {
  return readConfig() !== null;
}

// ---------------- access_token 缓存 ----------------

let cachedToken = '';
let tokenExpireAt = 0; // 毫秒时间戳
let tokenInflight: Promise<string> | null = null; // 并发去重：过期瞬间多路径只发一次 gettoken

async function getAccessToken(cfg: WecomConfig, force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpireAt) return cachedToken;
  tokenInflight ??= (async () => {
    try {
      const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
      if (data.errcode || !data.access_token) {
        throw new Error(`gettoken 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
      }
      cachedToken = data.access_token;
      // 官方 7200s，提前 300s 刷新，避开边界失效
      tokenExpireAt = Date.now() + ((data.expires_in ?? 7200) - 300) * 1000;
      return cachedToken;
    } finally {
      tokenInflight = null;
    }
  })();
  return tokenInflight;
}

/** 带 token 的 POST；token 过期（42001/40014）自动强刷重试一次 */
async function callApi<T extends { errcode?: number; errmsg?: string }>(
  cfg: WecomConfig,
  endpoint: string,
  body: unknown,
): Promise<T> {
  let token = await getAccessToken(cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API_BASE}/${endpoint}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json()) as T;
    if ((data.errcode === 42001 || data.errcode === 40014) && attempt === 0) {
      token = await getAccessToken(cfg, true);
      continue;
    }
    return data;
  }
  throw new Error('unreachable');
}

// ---------------- cursor + 已处理 msgid 持久化 ----------------

let cursor = '';
// msgid → 处理时间。持久化防重启后重复回复；企微消息只留 3 天，去重集同寿命
const handled = new Map<string, number>();
const HANDLED_TTL_MS = 3 * 24 * 3600 * 1000;
const HANDLED_MAX = 5000;

let statePromise: Promise<void> | null = null;

/** 幂等加载：启动循环与回调都先 await 它，消除「回调早于 loadCursor」的竞态 */
function ensureStateLoaded(): Promise<void> {
  return (statePromise ??= loadState());
}

async function loadState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8')) as {
      cursor?: string;
      handled?: [string, number][];
    };
    cursor = raw.cursor ?? '';
    const cut = Date.now() - HANDLED_TTL_MS;
    for (const [id, ts] of raw.handled ?? []) {
      if (ts > cut) handled.set(id, ts);
    }
  } catch {
    cursor = ''; // 首次启动无文件，按官方默认（近 3 天）拉取
  }
}

async function saveState(): Promise<void> {
  try {
    // 封顶淘汰：Map 按插入序，删最旧的一批（此前是整体 clear，会连最新的也丢掉）
    while (handled.size > HANDLED_MAX) {
      handled.delete(handled.keys().next().value as string);
    }
    await mkdir(VAR_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify({ cursor, handled: [...handled] }), 'utf8');
    await rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('[wecom] 状态落盘失败:', err);
  }
}

/** 标记 msgid 已处理；返回 false 表示此前处理过（跳过） */
function markHandled(msgid: string): boolean {
  if (handled.has(msgid)) return false;
  handled.set(msgid, Date.now());
  // 去重集必须先于 cursor 落盘：此前只在整批处理完（可能几十秒后）才写一次，
  // 中途被 SIGKILL（deploy.sh 的 docker rm -f）就会丢掉「已回过」的记录，
  // 重启后按旧 cursor 重拉同一批，客户收到一模一样的第二条 AI 回复。
  scheduleStateSave();
  return true;
}

let stateSaveTimer: NodeJS.Timeout | null = null;
/** 去抖落盘：一批消息里逐条 markHandled 不必各写一次盘 */
function scheduleStateSave(): void {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    void saveState();
  }, 500);
  stateSaveTimer.unref();
}

/** 进程退出前把去抖窗口里的状态同步写出去。
 *  挂 'exit' 而不是 SIGTERM：store.ts 先注册的 SIGTERM 处理器会直接 process.exit()，
 *  排在它后面的 SIGTERM 监听器根本轮不到；而 'exit' 阶段只能跑同步代码，
 *  所以这里用 writeFileSync 而不是 saveState()。 */
function flushStateSync(): void {
  if (!stateSaveTimer) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  try {
    fs.mkdirSync(VAR_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ cursor, handled: [...handled] }), 'utf8');
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (err) {
    console.error('[wecom] 退出前状态落盘失败:', err);
  }
}
process.on('exit', flushStateSync);

// ---------------- 收发消息 ----------------

interface KfMessage {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number; // 3=客户发来，4=系统，5=客服人员/接口发出
  msgtype: string;
  text?: { content: string };
  event?: {
    event_type?: string; // 如 enter_session（客户进入会话）
    welcome_code?: string; // 进入会话事件专用，20s 内单次有效，用于 send_msg_on_event 发欢迎语
    external_userid?: string;
  };
}

// 客户进入会话时的欢迎语（本账号 API 托管，微信自带欢迎语不生效，须由此发）
const WELCOME_TEXT =
  '您好呀～欢迎来到云途定制旅行，我是您的专属旅行顾问 🌿\n' +
  '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
  '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！';

// 老客户（48h 会话窗口内）再次扫码进入时，企微不下发 welcome_code——用普通消息补一条
const WELCOME_BACK_TEXT =
  '欢迎回来～我是您的专属旅行顾问，咱们之前聊的内容我都记得。\n' +
  '想继续看线路、调整行程，或者换个方向看看，直接说就行～';

// 补发欢迎的去重窗口。只用来吸收「同一次进入触发多个 enter_session」这类抖动，
// 不该拦住客户主动的再次扫码——原本设成 30 分钟，结果是第一次扫有招呼语、
// 一分钟后再扫什么都没有，看起来就像系统坏了。60 秒足够挡抖动。
const WELCOME_DEDUPE_MS = Math.max(0, Number(process.env.WELCOME_DEDUPE_SECONDS) || 60) * 1000;
const welcomeBackAt = new Map<string, number>();

interface SyncMsgResp {
  errcode?: number;
  errmsg?: string;
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMessage[];
}

// 企微 text.content 上限 2048 字节（UTF-8），留余量分段
const WECOM_TEXT_LIMIT = 2000;

/** 超限长文按字节上限分段，优先在换行处断开。
 *  两个不能踩的坑：切点落在 URL 中间会得到两条都点不开的残缺网址；
 *  切点落在代理对中间会切出孤立的高位码元，客户端显示成乱码方块。 */
function splitForWecom(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, 'utf8') > WECOM_TEXT_LIMIT) {
    let cut = rest.length;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > WECOM_TEXT_LIMIT) {
      cut = Math.floor(cut * 0.9);
    }
    const nl = rest.lastIndexOf('\n', cut);
    if (nl > cut / 2) cut = nl;
    // 切点若落在某条 URL 内部，前移到该 URL 起点，让整条 URL 进下一段
    for (const m of rest.matchAll(/https?:\/\/\S+|\/(?:proposal|pay)\/\S+/g)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (cut > start && cut < end) { cut = start; break; }
    }
    // 不要从代理对中间切开（emoji 等增补平面字符）
    const hi = rest.charCodeAt(cut - 1);
    if (cut > 0 && hi >= 0xd800 && hi <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = 1; // 兜底：任何情况下都要推进，否则死循环
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---------------- 链接卡片 ----------------
// 方案书/支付页发成纯文本链接时，客户看到的是一条秃 URL，转发出去更是只有网址。
// 企微客服原生支持 msgtype=link 卡片（标题+摘要+缩略图），观感完全不同。
// 注意：微信不会去抓页面的 og 标签生成卡片——那需要认证公众号 + JS-SDK，
// 这里用的是企微客服自己的消息类型，不需要公众号。

/** 缩略图 media_id 有效期 3 天，提前到 2 天就重传 */
const THUMB_TTL = 2 * 24 * 3600 * 1000;
let thumbCache: { id: string; at: number } | null = null;
let thumbInflight: Promise<string | null> | null = null;
/** 失败后的冷却截止时间：没有它，文件缺失/网络故障时每条消息都要再赔上一次
 *  getAccessToken(10s)+upload(20s) 超时，客户等半分钟才收到兜底链接 */
let thumbFailUntil = 0;
const THUMB_FAIL_COOLDOWN = 60_000;

async function uploadThumb(cfg: WecomConfig): Promise<string | null> {
  if (thumbCache && Date.now() - thumbCache.at < THUMB_TTL) return thumbCache.id;
  if (Date.now() < thumbFailUntil) return null;
  if (thumbInflight) return thumbInflight;
  // 先存局部再赋模块变量：若 IIFE 在首个 await 之前同步抛出，finally 的置空会先于
  // 外层赋值执行，thumbInflight 会被永久钉在一个已结束的 promise 上，卡片从此彻底失效
  const task = (async () => {
    try {
      const file = path.resolve('assets/proposal-thumb.png');
      const buf = await readFile(file);
      const token = await getAccessToken(cfg);
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'proposal-thumb.png');
      const res = await fetch(`${API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(20000),
      });
      const d = (await res.json()) as { errcode?: number; errmsg?: string; media_id?: string };
      if (d.errcode || !d.media_id) {
        console.error('[wecom] 缩略图上传失败，链接将以纯文本发送:', d.errcode, d.errmsg);
        thumbFailUntil = Date.now() + THUMB_FAIL_COOLDOWN;
        return null;
      }
      thumbCache = { id: d.media_id, at: Date.now() };
      console.log('[wecom] 链接卡片缩略图已上传');
      return d.media_id;
    } catch (e) {
      console.error('[wecom] 缩略图上传异常:', e instanceof Error ? e.message : e);
      thumbFailUntil = Date.now() + THUMB_FAIL_COOLDOWN;
      return null;
    } finally {
      thumbInflight = null;
    }
  })();
  thumbInflight = task;
  return task;
}

/** 正文里出现的所有站内链接（方案书/支付） */
const ALL_LINKS_RE = /(?:https?:\/\/[^\s]*)?\/(?:proposal|pay)\/[A-Za-z0-9_-]+(?:\/[\d-]+)*/g;

/** 从回复正文里认出方案书/支付链接，并取出用于卡片的标题与摘要。
 *  正文里出现多条链接时返回 null——卡片一次只能带一条 URL，硬做卡片会让第二条链接
 *  （尤其是支付链接）在剥离正文时被一起吞掉，客户永远拿不到付款入口。 */
function extractCard(text: string, baseUrl: string): { title: string; desc: string; url: string; raw: string } | null {
  if ((text.match(ALL_LINKS_RE) ?? []).length !== 1) return null;
  const prop = text.match(/(?:https?:\/\/[^\s]*)?\/proposal\/([A-Za-z0-9_-]+)\/(\d+)(?:\/([\d-]+))?/);
  if (prop) {
    const route = loadRoutes().find((r) => r.id === prop[1]);
    if (!route) return null;
    const travelers = Number(prop[2]);
    return {
      title: `${route.title} · 行程方案书`,
      desc: `${route.days} 天 · ${travelers} 位出行 · ${route.hotelLevel}｜含逐日行程与费用说明`,
      url: `${baseUrl}/proposal/${route.id}/${travelers}${prop[3] ? '/' + prop[3] : ''}`,
      raw: prop[0],
    };
  }
  const pay = text.match(/(?:https?:\/\/[^\s]*)?\/pay\/([A-Za-z0-9_-]+)/);
  if (pay) {
    const o = getOrder(pay[1]);
    if (!o) return null;
    return {
      title: `${o.routeTitle} · 待支付`,
      desc: `${o.travelers} 位出行 · ${o.departDate} 出发 · 合计 ¥${o.totalPrice.toLocaleString('zh-CN')}`,
      url: `${baseUrl}/pay/${o.id}`,
      raw: pay[0],
    };
  }
  return null;
}

/** 发链接卡片。缩略图拿不到或接口报错时返回 false，调用方退回纯文本 */
async function sendLinkCard(cfg: WecomConfig, externalUserId: string, card: { title: string; desc: string; url: string }): Promise<boolean> {
  // 整体包 try/catch：callApi 用 AbortSignal.timeout，网络抖动会 reject 而不是返回 errcode。
  // 漏掉会让异常冲出 push()，调用方的纯文本兜底永不执行——正文已经发出去了、链接却没了。
  try {
    const thumb = await uploadThumb(cfg);
    if (!thumb) return false;
    const data = await callApi<{ errcode?: number; errmsg?: string }>(cfg, 'kf/send_msg', {
      touser: externalUserId,
      open_kfid: cfg.openKfId,
      msgtype: 'link',
      link: { title: card.title.slice(0, 128), desc: card.desc.slice(0, 512), url: card.url, thumb_media_id: thumb },
    });
    if (data.errcode) {
      console.error(`[wecom] 链接卡片发送失败(errcode=${data.errcode} ${data.errmsg ?? ''})，退回纯文本`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[wecom] 链接卡片发送异常，退回纯文本:', e instanceof Error ? e.message : e);
    return false;
  }
}

/** 从正文里挖掉那条 URL，保留同一行的其余内容。
 *  不能按整行删——链接常和报价写在一起（「方案书在这 <url> 人均 15,800」），
 *  整行删会把报价一起删掉，客户只收到一张卡片、正文凭空少一句。 */
function stripLink(body: string, raw: string): string {
  return body
    .split('\n')
    .map((l) =>
      l.includes(raw)
        ? l.replace(raw, '').replace(/[ \t]{2,}/g, ' ').replace(/^[\s，,：:、]+|[\s，,：:、]+$/g, '')
        : l,
    )
    .filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1 && arr[i - 1].trim() && arr[i + 1].trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 发一条回复：含单条站内链接时走「正文 + 原生卡片」，否则纯文本。
 *  客户对话主链路与后台推送共用这一条路径——此前卡片逻辑只写在 push() 里，
 *  而客户消息的回复走的是 handleIncoming → sendText，卡片代码对客户而言是死代码。 */
async function sendRich(cfg: WecomConfig, uid: string, body: string): Promise<boolean> {
  const card = cfg.publicBaseUrl ? extractCard(body, cfg.publicBaseUrl) : null;
  if (!card) return sendText(cfg, uid, body);
  const prose = stripLink(body, card.raw);
  const textOk = prose ? await sendText(cfg, uid, prose) : true;
  if (await sendLinkCard(cfg, uid, card)) return textOk;
  // 卡片发不出去（缩略图缺失、接口报错、网络异常）：把链接补发成文本，绝不能让客户拿不到链接
  return (await sendText(cfg, uid, `${card.title}\n${card.url}`)) && textOk;
}

/** 发文本：自动分段；限流/网络类失败退避重试（最多 3 次），其余错误打日志放弃。
 *  返回是否全部分段都发送成功——调用方（如后台人工回复）据此提示操作者。 */
async function sendText(cfg: WecomConfig, externalUserId: string, text: string): Promise<boolean> {
  let allOk = true;
  for (const chunk of splitForWecom(text)) {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
      try {
        const data = await callApi<{ errcode?: number; errmsg?: string }>(cfg, 'kf/send_msg', {
          touser: externalUserId,
          open_kfid: cfg.openKfId,
          msgtype: 'text',
          text: { content: chunk },
        });
        if (!data.errcode) {
          lastErr = '';
          break;
        }
        lastErr = `errcode=${data.errcode} ${data.errmsg ?? ''}`;
        // 45009=接口限流、-1=系统繁忙 值得重试；其余（参数错/无权限）重试无意义
        if (data.errcode !== 45009 && data.errcode !== -1) break;
      } catch (e) {
        lastErr = String(e); // 网络异常/超时，重试
      }
    }
    if (lastErr) {
      console.error(`[wecom] send_msg 最终失败（已重试）: ${lastErr}`);
      allOk = false;
    }
  }
  return allOk;
}

/**
 * 客户进入会话、尚未发消息时（send_msg 的 48h 窗口未开），用事件的 welcome_code
 * 经 send_msg_on_event 发欢迎语。code 20 秒内单次有效，须尽快调用。
 */
async function sendWelcomeOnEvent(cfg: WecomConfig, code: string): Promise<void> {
  const data = await callApi<{ errcode?: number; errmsg?: string }>(cfg, 'kf/send_msg_on_event', {
    code,
    msgtype: 'text',
    text: { content: WELCOME_TEXT },
  });
  if (data.errcode) {
    console.error(`[wecom] send_msg_on_event 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
  }
}

/** 拉客户微信昵称/头像存进画像（后台展示真实昵称用）；失败静默，不阻塞主流程 */
async function enrichCustomerProfile(cfg: WecomConfig, externalUserId: string): Promise<void> {
  // 只在会话已存在时补昵称——绝不为「仅进入未发言」的客户凭空建会话，
  // 否则空「访客」会话会灌进后台列表并稀释转化率分母。首条消息建好会话后再补。
  const session = getSession(SESSION_PREFIX + externalUserId);
  if (!session || session.profile.nickname) return;
  try {
    const data = await callApi<{
      errcode?: number;
      errmsg?: string;
      customer_list?: { external_userid: string; nickname?: string; avatar?: string }[];
    }>(cfg, 'kf/customer/batchget', {
      external_userid_list: [externalUserId],
      need_enter_session_context: 0,
    });
    const cust = data.customer_list?.[0];
    if (!data.errcode && cust?.nickname) {
      session.profile.nickname = cust.nickname;
      if (cust.avatar) session.profile.avatar = cust.avatar;
      saveSession(session);
    }
  } catch {
    /* 昵称拿不到不影响对话 */
  }
}

/** 相对支付链接拼上公网前缀，企微里才是可点的完整 URL */
function absolutizePayLinks(cfg: WecomConfig, text: string): string {
  if (!cfg.publicBaseUrl) {
    if (text.includes('/pay/') || text.includes('/proposal/')) {
      console.error('[wecom] ⚠️ 回复含支付链接但 PUBLIC_BASE_URL 未配置，客户将收到不可点击的相对路径！');
    }
    return text;
  }
  return text
    .replace(/(^|[^a-zA-Z0-9/])(\/pay\/[A-Za-z0-9_-]+)/g, `$1${cfg.publicBaseUrl}$2`)
    .replace(/(^|[^a-zA-Z0-9/])(\/proposal\/[A-Za-z0-9_\-/]+)/g, `$1${cfg.publicBaseUrl}$2`);
}

/**
 * 微信客服消息是纯文本、不渲染 markdown，直接发会露出 ** 和 # 等符号。
 * 这里把常见 markdown 转成微信里干净的样子（emoji 保留，结构靠换行）。
 */
// 行首用作项目符号的 emoji（含可选变体选择符 + 空格），兜底换成「·」
const LEADING_EMOJI_BULLET =
  /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2000}-\u{206F}]️?)\s+/gmu;

function wechatify(text: string): string {
  return text
    .replace(/^\s*```.*$/gm, '') // 只去掉围栏行本身，保留代码块内容（此前整块删除会吞内容）
    .replace(/^#{1,6}\s*/gm, '') // 标题符号
    .replace(/\*\*(.+?)\*\*/g, '$1') // 加粗
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // 斜体
    .replace(/^\s*[-*]\s+/gm, '· ') // 无序列表 → 中点
    .replace(LEADING_EMOJI_BULLET, '· ') // 拿 emoji 当项目符号 → 中点（保留句中 emoji）
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/\n{3,}/g, '\n\n') // 折叠多余空行
    .trim();
}

/** 发给微信客户前统一处理：markdown→纯文本 + 相对支付链接补全 */
function formatForWecom(cfg: WecomConfig, text: string): string {
  return absolutizePayLinks(cfg, wechatify(text));
}

async function handleIncoming(cfg: WecomConfig, msg: KfMessage): Promise<void> {
  // 客户进入会话事件：发欢迎语（本账号 API 托管，微信自带欢迎语不生效）
  if (msg.msgtype === 'event' && msg.event?.event_type === 'enter_session') {
    if (!markHandled(msg.msgid)) return;
    const code = msg.event.welcome_code;
    if (code) {
      await sendWelcomeOnEvent(cfg, code);
      console.log('[wecom] 已发欢迎语（enter_session, welcome_code）');
    } else {
      // 企微只给「新客户 / 超 48h 未聊」下发 welcome_code；老客户再次扫码进入没有 code，
      // 会话窗口是开着的，直接 send_msg 补发一条轻量欢迎，让"扫码即有回应"始终成立
      const uid = msg.event.external_userid || msg.external_userid;
      if (uid) {
        const last = welcomeBackAt.get(uid) ?? 0;
        if (Date.now() - last > WELCOME_DEDUPE_MS) {
          welcomeBackAt.set(uid, Date.now());
          const sess = getSession(SESSION_PREFIX + uid);
          const text = sess?.messages?.length ? WELCOME_BACK_TEXT : WELCOME_TEXT;
          const ok = await sendText(cfg, uid, text);
          console.log(`[wecom] enter_session 无 welcome_code，已补发欢迎（send_msg，${ok ? '成功' : '失败'}）`);
          // 记进会话：否则后台看不到 AI 对客户说过的开场白，顾问介入时不知道客户收到过什么。
          // 只写已存在的会话，不新建——避免只扫码没说话的人也计进「会话数」KPI
          if (ok && sess) {
            sess.messages.push({ role: 'agent', content: text, at: Date.now() });
            saveSession(sess);
          }
        } else {
          console.log(`[wecom] enter_session 无 welcome_code，${WELCOME_DEDUPE_MS / 1000}s 内已发过欢迎，跳过`);
        }
      }
    }
    // 昵称回填留到客户首条消息（会话建好后）再做，此处不为未发言客户建空会话
    return;
  }

  if (msg.origin !== 3) return; // 只处理客户发来的，跳过系统/自己发出的回声
  if (!markHandled(msg.msgid)) return; // 幂等：同一 msgid 只处理一次（含重启后）

  const sessionId = SESSION_PREFIX + msg.external_userid;
  if (msg.msgtype !== 'text' || !msg.text?.content) {
    // 小红书来的客户第一条常是笔记截图、行程截图或语音。一句「只能处理文字」是把
    // 首响这个唯一能碾压人工的环节浪费掉——收不到内容也要接住话头、把人拉回文字。
    const HINT: Record<string, string> = {
      image: '图我收到了～不过我这边暂时看不了图片内容，您用文字说一下想去哪、几位出行，我马上给您找线路。',
      voice: '语音我这边暂时听不了，您打几个字给我就行～想去哪儿、几位出行、大概什么时候走？',
      video: '视频收到啦～您用文字说说想要什么样的行程，我这就帮您安排。',
      file: '文件我这边暂时打不开，方便的话把关键需求打字发我：目的地、几位、大概日期。',
      link: '链接收到～您想找类似的行程吗？跟我说下目的地和人数，我帮您对一条。',
      location: '位置收到～您是想从这边出发，还是想去这附近玩？跟我说下大概日期和人数。',
    };
    await sendText(
      cfg,
      msg.external_userid,
      HINT[msg.msgtype] ?? '这条消息我这边暂时处理不了，您用文字说说想去哪儿、几位出行，我马上帮您安排～',
    );
    return;
  }
  const t0 = Date.now();
  console.log(`[wecom] 收到客户消息: "${msg.text.content.slice(0, 40)}"`);
  // 不发「稍等」占位：几秒延迟本就像真人顾问在查资料，逐条占位反而更显机械。
  try {
    const reply = await handleMessage(sessionId, msg.text.content, 'wecom');
    void enrichCustomerProfile(cfg, msg.external_userid); // 会话已建，异步补昵称回填后台展示
    if (reply.silent || !reply.text.trim()) {
      console.log(`[wecom] 静默（阶段=${reply.stage}，转人工后不自动回复）`);
      return; // 转人工后 AI 沉默，交给真人
    }
    // 走 sendRich 而不是 sendText：方案书/支付链接要发成原生卡片，客户转发出去才是一张卡
    const sent = await sendRich(cfg, msg.external_userid, formatForWecom(cfg, reply.text));
    if (!sent) {
      // 发送失败不能静默：会话里已经存了这条 agent 回复，后台看着像"已跟进"，
      // 实际客户什么都没收到（48h 会话窗口关闭、企微限流等），顾问会以为已经聊过了
      console.error(`[wecom] ⚠️ 回复未送达客户（阶段=${reply.stage}）:`, sessionId);
      const s = getSession(sessionId);
      if (s) {
        s.messages.push({
          role: 'system',
          content: '⚠️ 上一条 AI 回复未能发送到客户（企微发送失败：可能是 48h 会话窗口已关闭或企微配置问题）',
          at: Date.now(),
        });
        saveSession(s, false);
      }
      return;
    }
    console.log(`[wecom] 已回复（阶段=${reply.stage}，耗时 ${Date.now() - t0}ms）`);
  } catch (err) {
    console.error('[wecom] 处理消息失败:', err);
    await sendText(cfg, msg.external_userid, '抱歉，系统开小差了，请稍后再发一次，或直接联系人工顾问。');
  }
}

// ---------------- 同步循环 ----------------
// syncToken 由回调事件带来：带 token 调用不受严格限频（不带 token 的纯轮询会 45009）。
// 互斥期间的新触发不再丢弃（此前直接 return，消息要等 30-60s 兜底轮询）：
// 记 pending，本轮 drain 完立刻补拉。

let syncing = false;
let pendingRequested = false;
let pendingToken: string | undefined;

async function syncOnce(cfg: WecomConfig, syncToken?: string): Promise<void> {
  if (syncing) {
    pendingRequested = true;
    if (syncToken) pendingToken = syncToken;
    return;
  }
  syncing = true;
  try {
    let token = syncToken;
    do {
      pendingRequested = false;
      await drainMessages(cfg, token);
      token = pendingToken;
      pendingToken = undefined;
    } while (pendingRequested);
  } finally {
    syncing = false;
  }
}

async function drainMessages(cfg: WecomConfig, syncToken?: string): Promise<void> {
  // has_more 时连续拉直到拉空，避免消息积压跨轮询周期
  for (;;) {
    const body: Record<string, unknown> = { open_kfid: cfg.openKfId, limit: 100 };
    if (cursor) body.cursor = cursor;
    if (syncToken) body.token = syncToken;
    const data = await callApi<SyncMsgResp>(cfg, 'kf/sync_msg', body);
    if (data.errcode) {
      console.error(`[wecom] sync_msg 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
      return;
    }
    // 按客户分组并发处理：同客户保序（组内串行），跨客户互不拖慢
    // （此前全局串行，一个客户的慢 LLM 会拖住所有客户的回复）
    const groups = new Map<string, KfMessage[]>();
    for (const msg of data.msg_list ?? []) {
      const key = msg.external_userid || msg.event?.external_userid || msg.msgid;
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }
    await Promise.all(
      [...groups.values()].map(async (list) => {
        for (const msg of list) {
          try {
            await handleIncoming(cfg, msg);
          } catch (err) {
            console.error('[wecom] 单条消息处理异常（继续后续消息）:', err);
          }
        }
      }),
    );
    if (data.next_cursor) cursor = data.next_cursor;
    await saveState(); // cursor + 已处理 msgid 一起原子落盘
    if (!data.has_more) return;
  }
}

/**
 * 回调收到 kf_msg_or_event 事件时调用：用事件携带的 token 立即拉取（实时且不限频）。
 * 未配置 wecom 时静默忽略。
 */
export async function syncFromCallback(syncToken: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  await ensureStateLoaded();
  try {
    await syncOnce(cfg, syncToken);
  } catch (err) {
    console.error('[wecom] 回调拉取异常:', err);
  }
}

// ---------------- 启动 ----------------

let started = false;

/** 未配齐 env 时静默不启动；配齐则起轮询循环（不阻塞调用方） */
export function startWecom(): void {
  const cfg = readConfig();
  if (!cfg || started) return;
  started = true;
  if (!cfg.publicBaseUrl) {
    console.error(
      '[wecom] ⚠️⚠️ PUBLIC_BASE_URL 未配置：发给微信客户的支付链接将是不可点击的相对路径，' +
        '成单流程会断在付款一步！请在 env 配置公网地址（如 https://travel.example.com）。',
    );
  }
  void (async () => {
    await ensureStateLoaded();
    // 主通道是回调驱动（syncFromCallback）。这里只做兜底慢轮询，兜住回调偶发丢失；
    // 间隔取较大值（默认 60s），不带 token 的纯轮询频率太高会 45009。
    const fallbackMs = Math.max(30000, cfg.pollIntervalMs);
    console.log(`[wecom] kf 已就绪：回调驱动 + ${fallbackMs}ms 兜底轮询`);
    for (;;) {
      await new Promise((r) => setTimeout(r, fallbackMs));
      try {
        await syncOnce(cfg);
      } catch (err) {
        console.error('[wecom] 兜底轮询异常（下轮重试）:', err);
      }
    }
  })();
}

export const wecomAdapter: ChannelAdapter = {
  name: 'wecom',
  async push(sessionId: string, text: string): Promise<boolean> {
    const cfg = readConfig();
    if (!cfg) {
      // 历史 wecom 会话存在但企微 env 未配（如换服务器漏配）：必须出声，否则回复凭空消失
      console.error('[wecom] ⚠️ 收到发往 wecom 会话的消息但企微未配置（WECOM_* env 缺失），消息未送达:', sessionId);
      return false;
    }
    if (!sessionId.startsWith(SESSION_PREFIX)) return false;
    const uid = sessionId.slice(SESSION_PREFIX.length);
    return sendRich(cfg, uid, formatForWecom(cfg, text));
  },
};

/** 仅供自测使用的内部函数出口（src/adapters/wecom.selftest.ts） */
export const __test = { splitForWecom, extractCard, stripLink };
