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
// - 同步锁只管「拉取 + 推进 cursor + 落盘」，处理不在锁里：按客户排成串行链，
//   同客户保序，跨客户（含跨批次）互不等待；欢迎语不排队（welcome_code 20s 过期）。
// - cursor 推进后还没处理完的消息连同原文落盘（在途表），进程死在半路时启动后重放。
// - 优雅停机：收到 SIGTERM 不再拉新消息，等进行中的回复发完（store.ts 的停机钩子）。
// - 冷启动（没有可用 cursor）时，启动前的历史消息只标记不回复，不会把近 3 天的旧问题全答一遍。
// - 同步互斥期间收到的新触发不丢弃：记 pending，本轮结束立刻补拉。
// - send_msg 失败重试（限流/网络类），超企微 2048 字节上限的长文自动分段。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentReply, ChannelAdapter } from '../types.js';
import { handleMessage } from '../engine.js';
import { getOrder, getSession, onShutdown, saveSession } from '../store.js';
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
async function callApi<T extends { errcode?: number; errmsg?: string }>(cfg: WecomConfig, endpoint: string, body: unknown): Promise<T> {
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
// msgid → 认领时间。持久化防重启后重复回复；企微消息只留 3 天，去重集同寿命
const handled = new Map<string, number>();
const HANDLED_TTL_MS = 3 * 24 * 3600 * 1000;
const HANDLED_MAX = 5000;

// 在途表：已认领（cursor 已推进、sync_msg 不会再返回）但还没处理完的客户消息，连同原文落盘。
// 去重是两阶段的：handled 管「认领过没有」，在途表管「处理完没有」。进程死在处理途中
// （停机等待超时、OOM、宿主机重启）时，启动后按原文重放。
//
// 取舍：宁可极少数情况下重复回一次，也不能丢消息。丢消息 = 客户永远等不到回复，
// 且会话最后一条是客户说的，自动跟进也不会去追；重复 = 客户看到同一句话两遍。
// 重复只发生在上次停在发送途中、而那条其实已经送达时：停机等待超时被强制退出（部署时正好
// 碰上一轮超过 8s 的回复），或被硬杀，重启后按「回复已生成」原样再发一次。只有各客户的队头
// 会这样对齐，排在它后面、还没开始处理的消息按新消息派发（见 replayInflight）。
// 正常停机会等处理完再落盘，不会重复。重放也不会重复建单：create_order 对同参数的
// 待支付订单是幂等复用的（tools.ts），转人工状态已落盘、重放时引擎直接静默。
interface PendingEntry {
  msg: KfMessage;
  /** 已重放次数 */
  tries: number;
}
const inflight = new Map<string, PendingEntry>();
/** 同一条消息最多重放几次。防「毒消息」：若某条消息一处理就把进程带崩，不设上限会变成重启即崩的死循环 */
const MAX_REPLAY = 2;
/** send_msg 只能在客户最后一条消息后 48h 内发，更老的在途消息重放了也发不出去 */
const REPLAY_MAX_AGE_MS = 48 * 3600 * 1000;

// 冷启动：没有可用 cursor（首次部署 / 状态文件缺失或损坏）时 sync_msg 会返回近 3 天的全部消息，
// 而去重集也一起没了——不设防就会把 3 天里每个客户的每条旧消息挨个回一遍，给扫过码的人
// 补发欢迎语。启动前 10 分钟之前的消息只标记已处理、不回复；10 分钟的余量吸收两边时钟偏差，
// 也兜住「刚好在重启空档里发来」的新消息。
const COLD_START_GRACE_MS = 10 * 60 * 1000;
/** 非 0 表示本进程是冷启动，send_time 早于它的消息不回复 */
let coldStartCutoff = 0;

async function loadState(): Promise<void> {
  let text: string | null = null;
  try {
    text = await readFile(STATE_FILE, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[wecom] ⚠️ 状态文件读取失败，按冷启动处理:', e);
    }
  }
  if (text !== null) {
    try {
      const raw = JSON.parse(text) as {
        cursor?: string;
        handled?: [string, number][];
        pending?: PendingEntry[];
      };
      cursor = raw.cursor ?? '';
      const cut = Date.now() - HANDLED_TTL_MS;
      for (const [id, ts] of raw.handled ?? []) {
        if (ts > cut) handled.set(id, ts);
      }
      for (const p of raw.pending ?? []) {
        if (p?.msg?.msgid) inflight.set(p.msg.msgid, { msg: p.msg, tries: Number(p.tries) || 0 });
      }
    } catch (e) {
      // 与 store.ts 一致：损坏文件改名留现场，不能静默当首次启动（下一次落盘就把现场覆盖了）
      const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
      try {
        await rename(STATE_FILE, backup);
        console.error(`[wecom] ⚠️⚠️ ${path.basename(STATE_FILE)} 解析失败，已备份到 ${backup}:`, e);
      } catch {
        console.error(`[wecom] ⚠️⚠️ ${path.basename(STATE_FILE)} 解析失败且无法备份:`, e);
      }
      cursor = '';
      handled.clear();
      inflight.clear();
    }
  }
  // 以「有没有 cursor」为准，而不只看文件在不在：首次同步还没拿到 cursor 就崩了，
  // 文件里只有去重集、cursor 为空，下次启动同样会拉回近 3 天
  if (!cursor) {
    coldStartCutoff = Date.now() - COLD_START_GRACE_MS;
    console.warn(
      `[wecom] 无可用 cursor（首次启动或状态文件缺失/损坏），冷启动：` +
        `${new Date(coldStartCutoff).toLocaleString('zh-CN')} 之前的消息只标记已处理、不回复`,
    );
  }
}

function stateJson(): string {
  // 封顶淘汰：Map 按插入序，删最旧的一批（此前是整体 clear，会连最新的也丢掉）
  while (handled.size > HANDLED_MAX) {
    handled.delete(handled.keys().next().value as string);
  }
  // handled 保持 [msgid, ts][] 旧格式、在途表放新字段 pending：deploy.sh 回滚到旧镜像时旧代码照样读得懂
  return JSON.stringify({ cursor, handled: [...handled], pending: [...inflight.values()] });
}

let saveChain: Promise<void> = Promise.resolve();
/** 落盘排成一条链：拉取、处理完成、停机三处都会写，并发写同一个 .tmp 会互相踩（rename 报 ENOENT） */
function saveState(): Promise<void> {
  saveChain = saveChain.then(async () => {
    try {
      await mkdir(VAR_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      await writeFile(tmp, stateJson(), 'utf8');
      await rename(tmp, STATE_FILE);
    } catch (err) {
      console.error('[wecom] 状态落盘失败:', err);
    }
  });
  return saveChain;
}

/** 标记 msgid 已认领；返回 false 表示此前认领过（跳过）。落盘由调用方在推进 cursor 后统一做 */
function markHandled(msgid: string): boolean {
  if (handled.has(msgid)) return false;
  handled.set(msgid, Date.now());
  return true;
}

let stateSaveTimer: NodeJS.Timeout | null = null;
/** 去抖落盘：同一时段多条消息先后处理完，不必各写一次盘 */
function scheduleStateSave(): void {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    void saveState();
  }, 500);
  stateSaveTimer.unref();
}

/** 进程退出前把去抖窗口里的状态同步写出去。
 *  停机钩子等待超时被强制 process.exit 时，异步的 saveState 来不及跑；
 *  'exit' 阶段只能跑同步代码，所以这里用 writeFileSync。 */
function flushStateSync(): void {
  if (!stateSaveTimer) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  try {
    fs.mkdirSync(VAR_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', stateJson(), 'utf8');
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
  '欢迎回来～我是您的专属旅行顾问，咱们之前聊的内容我都记得。\n' + '想继续看线路、调整行程，或者换个方向看看，直接说就行～';

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
      if (cut > start && cut < end) {
        cut = start;
        break;
      }
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
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20000),
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

/** 卡片上的出发日期写成正文里的样子（「10月12日」），跨年才带年份。
 *  此前直接拼 YYYY-MM-DD：正文刚说完「10月12日出发」，紧跟着的卡片却是「2026-10-12 出发」，像系统单据 */
function cnDate(iso: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso);
  if (!m) return iso;
  const md = `${Number(m[2])}月${Number(m[3])}日`;
  return Number(m[1]) === now.getFullYear() ? md : `${m[1]}年${md}`;
}

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
      desc: `${o.travelers} 位出行 · ${o.departDate ? cnDate(o.departDate) + '出发' : '日期待定'} · 合计 ¥${o.totalPrice.toLocaleString('zh-CN')}`,
      url: `${baseUrl}/pay/${o.id}`,
      raw: pay[0],
    };
  }
  return null;
}

/** 发链接卡片（缩略图由调用方先备好，见 sendRich）。接口报错或网络异常时返回 false，调用方退回纯文本 */
async function sendLinkCard(
  cfg: WecomConfig,
  externalUserId: string,
  card: { title: string; desc: string; url: string },
  thumb: string,
): Promise<boolean> {
  // 整体包 try/catch：callApi 用 AbortSignal.timeout，网络抖动会 reject 而不是返回 errcode。
  // 漏掉会让异常冲出 push()，调用方的纯文本兜底永不执行——正文已经发出去了、链接却没了。
  try {
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

/** 挖掉链接后只剩的标签（「· 支付链接」「方案书」「2. 付款入口」「这是您的专属支付链接」「👉 立即支付」）。
 *  标签本是给链接起的名字，链接改走卡片后它独占一行、后面什么都没有——卡片要等整段正文发完才到，
 *  客户读到这里会以为链接漏发了。前面可以带列表序号和「这是您的专属」这类修饰 */
const LINK_LABEL_RE = new RegExp(
  '^(?:\\d{1,2}\\s*[.、．)）]\\s*|[①-⑩]\\s*)?(?:这是|这里是)?(?:您|你)?的?(?:专属)?的?(?:本单|订单)?的?' +
    '(?:(?:支付|付款|订单|下单)(?:链接|入口|页面|地址)?|(?:立即|马上|去|点击)(?:支付|付款)' +
    '|(?:详细|完整)?的?(?:行程)?(?:方案书?|计划书|行程单)(?:链接|地址)?|(?:详细|完整)?的?行程|(?:方案|行程)?链接)$',
);
/** 列表序号开头的：整行删掉会让「1. 2. 3.」断号，改成「2. 支付链接见下方卡片」 */
const NUMBERED_RE = /^(?:\d{1,2}\s*[.、．)）]|[①-⑩])/;
const linkLabelCore = (s: string): string => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
/** 标签后面跟着的括注（「支付链接（名额以付款为准）」「方案书（含逐日行程）。」）：只是说明，不改变这一行是个标签。
 *  此前带括注的认不出是标签，链接改走卡片后留下一行「支付链接（名额以付款为准）。」，指向空气（A09/C03） */
const LABEL_NOTE_RE = /\s*[（(][^（）()\n]{1,24}[）)][\s。.！!～~]*$/;
const isLinkLabel = (s: string): boolean =>
  LINK_LABEL_RE.test(linkLabelCore(s)) || LINK_LABEL_RE.test(linkLabelCore(s.replace(LABEL_NOTE_RE, '')));
/** 标签带着括注：括注是要留给客户的话（「24 小时内有效」「名额以付款为准」），不能整行删，改成指着卡片 */
const notedLabel = (s: string): boolean => LABEL_NOTE_RE.test(s) && !LINK_LABEL_RE.test(linkLabelCore(s)) && isLinkLabel(s);
/** 标签改成指着卡片，括注挪到后面：「2. 支付链接（24 小时内有效）」→「2. 支付链接见下方卡片（24 小时内有效）」 */
function labelToCard(s: string): string {
  const note = LABEL_NOTE_RE.exec(s)?.[0] ?? '';
  return `${s.slice(0, s.length - note.length)}见下方卡片${note.trim().replace(/[。.！!～~]+$/, '')}`;
}
/** 紧挨着链接、指着它的符号（「点这里付款 👉 <url>」「<url> 👈」）：链接挖走后一并拿掉，留着就是指向空气 */
const POINTER_BEFORE_RE = /(?:\s*(?:👉|👈|👇|➡️?|⬇️?|→|↓))+\s*$/u;
const POINTER_AFTER_RE = /^\s*(?:(?:👉|👈|👇|➡️?|⬇️?|→|↓)\s*)+/u;

/** 把指着链接的说法改成指着卡片。「在这儿」「如下」「点这里」原本指的是紧跟着的那串网址，
 *  网址挖走后就指向了空气；「发您」「做好了」收尾的补一句「见下方卡片」，客户知道东西在后面 */
function pointToCard(s: string): string {
  if (!s || /下方|卡片/.test(s)) return s; // 模型已经这么写了，别再补一遍
  // 「支付链接：<url>（24 小时内有效）」：标签后面还跟着话，整行删不得，标签改成指着卡片
  if (isLinkLabel(s)) return labelToCard(s);
  const tap = s.replace(/(?:点击|点|戳)(?:这里|这儿|此处)/, '点下方卡片');
  if (tap !== s) return tap;
  // 「付款请点：<url>」：只认付款/请 + 点，「景点」「重点」这类收尾不能接「下方卡片」
  if (/(?:请|烦请|麻烦|支付|付款)点击?$/.test(s)) return `${s}下方卡片`;
  // 只认「方案/链接…在这儿」这种名词带指代的说法：「我放在这里」这类动词短语换掉会变成病句
  const here = s.replace(
    /(方案书?|计划书?|行程单?|链接|入口|明细|详情)(?:就|都)?(?:在这里|在这儿|在这|如下)(?=$|[，,。！!～~；;])/,
    '$1见下方卡片',
  );
  if (here !== s) return here;
  if (/(?:发(?:给)?您|给您|(?:做|生成|准备|整理|出)好了?|已生成)(?:看看|过目)?(?:了|啦)?$/.test(s)) return `${s}，见下方卡片`;
  return s;
}

/** 从正文里挖掉那条 URL，保留同一行的其余内容。
 *  不能按整行删——链接常和报价写在一起（「方案书在这 <url> 人均 15,800」），
 *  整行删会把报价一起删掉，客户只收到一张卡片、正文凭空少一句。 */
function stripLink(body: string, raw: string): string {
  const tidy = (s: string) => s.replace(/[ \t]{2,}/g, ' ').replace(/^[\s，,：:、]+|[\s，,：:、]+$/g, '');
  const lines: (string | null)[] = body.split('\n'); // null = 整行拿掉（与原文里的空行区分开，段落间距照旧）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null || !line.includes(raw)) continue;
    const at = line.indexOf(raw);
    const beforeRaw = line.slice(0, at).replace(POINTER_BEFORE_RE, (m) => (/^\s/.test(m) ? ' ' : ''));
    const afterRaw = line.slice(at + raw.length).replace(POINTER_AFTER_RE, (m) => (/\s$/.test(m) ? ' ' : ''));
    // 冒号原本指着链接，后面紧跟逗号或括号时就悬空了（「总价：，30 分钟内有效」）
    const rest = tidy(beforeRaw + afterRaw)
      .replace(/[：:][ \t]*([，,、；;])/, '$1')
      .replace(/[：:][ \t]*(?=[（(])/, '');
    const core = linkLabelCore(rest);
    // 「支付链接（名额以付款为准）：<url>」「· 支付链接：<url>（24 小时内有效）」：剩下的是标签加括注，标签改成指着卡片，括注留着
    if (notedLabel(rest)) {
      lines[i] = labelToCard(rest);
      continue;
    }
    if (core && !isLinkLabel(rest)) {
      const before = tidy(beforeRaw);
      const after = tidy(afterRaw);
      const pointed = pointToCard(before);
      if (pointed === before) lines[i] = rest;
      // 后面只剩表情（「😊」）不加逗号；句读、括号开头的直接接
      else if (!after) lines[i] = pointed;
      else if (!/[\p{L}\p{N}]/u.test(after)) lines[i] = `${pointed} ${after}`;
      else lines[i] = pointed + (/^[。！!？?～~（(]/.test(after) ? '' : '，') + after;
      continue;
    }
    if (core && NUMBERED_RE.test(core)) {
      lines[i] = labelToCard(rest);
      continue;
    }
    // 链接独占一行、或只剩「👉」「·」这类符号、或只剩「支付链接」这类标签：整行拿掉，再看上一行：
    //  · 上一行也只是个标签（「· 支付链接：」换行接链接）：同样整行拿掉，此前留下「· 支付链接。」；
    //    带序号、带括注的（「支付链接（名额以付款为准）：」）不删，改成指着卡片；
    //  · 上一行以冒号收尾：冒号原本指着这条链接，链接改走卡片后就指向了空气（「费用明细：」后面接一句不相干的话），
    //    换成句号，「详细方案书在这儿，…：」「方案给您做好了：」这种再改成指着卡片；
    //  · 紧挨着的上一行没冒号、但在指着链接（「详细方案书发您」换行接链接）：同样改成指着卡片
    lines[i] = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j];
      if (prev === null || !prev.trim()) continue;
      const colon = /[：:]\s*$/.test(prev);
      const p = prev.replace(/[：:]?\s*$/, '');
      if ((colon || j === i - 1) && isLinkLabel(p)) lines[j] = NUMBERED_RE.test(linkLabelCore(p)) || notedLabel(p) ? labelToCard(p) : null;
      else if (colon) lines[j] = `${pointToCard(p)}。`;
      else if (j === i - 1) lines[j] = pointToCard(p);
      break;
    }
  }
  return lines
    .filter((l): l is string => l !== null)
    .map((l) => (l.trim() ? l : ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 发一条回复：含单条站内链接时走「正文 + 原生卡片」，否则纯文本。
 *  客户对话主链路与后台推送共用这一条路径——此前卡片逻辑只写在 push() 里，
 *  而客户消息的回复走的是 handleCustomerMessage → sendText，卡片代码对客户而言是死代码。 */
async function sendRich(cfg: WecomConfig, uid: string, body: string): Promise<boolean> {
  const card = cfg.publicBaseUrl ? extractCard(body, cfg.publicBaseUrl) : null;
  if (!card) return sendText(cfg, uid, body);
  // 先把缩略图备好再动正文。stripLink 会把「方案书在这儿」改成「见下方卡片」，
  // 此前先发了改过的正文才去传缩略图，缩略图一失败（接口报错、之后 60 秒冷却期内每一张都算），
  // 客户读到「见下方卡片」，下方却是一条纯文本链接。拿不到缩略图就原样发正文，链接留在原处
  const thumb = await uploadThumb(cfg).catch(() => null);
  if (!thumb) return sendText(cfg, uid, body);
  const prose = stripLink(body, card.raw);
  const textOk = prose ? await sendText(cfg, uid, prose) : true;
  if (await sendLinkCard(cfg, uid, card, thumb)) return textOk;
  // 缩略图就绪、卡片本身却发送失败（接口报错、网络异常，少见）：正文已按「见下方卡片」发出，收不回来了。
  // 把链接补发在正文下方——「下方」来的是一条带标题的链接而不是卡片，措辞差一点，但链接一定送达
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
const LEADING_EMOJI_BULLET = /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2000}-\u{206F}]️?)\s+/gmu;

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

function isEnterSession(msg: KfMessage): boolean {
  return msg.msgtype === 'event' && msg.event?.event_type === 'enter_session';
}

/** 客户进入会话事件：发欢迎语（本账号 API 托管，微信自带欢迎语不生效）。调用方已去重 */
async function handleEnterSession(cfg: WecomConfig, msg: KfMessage): Promise<void> {
  if (!msg.event) return;
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
}

/**
 * 重放前把会话历史对齐到「这条消息从没处理过」，返回非 null 表示上次已生成回复、只差发送。
 * 上次进程可能停在三个位置：
 *   1. 还没进引擎（会话里没有这句）→ 照常重跑；
 *   2. 引擎已记下客户这句、回复还没生成 → 摘掉这句再重跑，否则客户同一句话在历史里出现两次，
 *      模型和后台顾问都会看到重复；
 *   3. 回复已生成入库、发送没完成（或发了没来得及记完成）→ 原样重发那条，不再跑一轮 LLM：
 *      万一其实发过，客户看到的也只是同一句话两遍，而不是两条说法不一的回复。
 */
function alignSessionForReplay(sessionId: string, text: string): string | null {
  const s = getSession(sessionId);
  if (!s) return null;
  const said = text.slice(0, 2000); // 与引擎入库前的截断一致，否则长消息永远对不上
  // 欢迎语不排队（handleEnterSession 直接写进会话），可能正好插在这一轮中间。它不是任何一句话的回复：
  // 算进来的话，「客户这句 + 欢迎回来」会被当成情况 3，把欢迎语当回复重发，客户问的事就没人答了
  const talk = s.messages.filter(
    (m) => m.role !== 'system' && !(m.role === 'agent' && (m.content === WELCOME_TEXT || m.content === WELCOME_BACK_TEXT)),
  );
  const last = talk.at(-1);
  if (last?.role === 'customer' && last.content === said) {
    s.messages.splice(s.messages.lastIndexOf(last), 1);
    saveSession(s, false);
    return null;
  }
  const prev = talk.at(-2);
  if (last?.role === 'agent' && prev?.role === 'customer' && prev.content === said) return last.content;
  return null;
}

/** 处理一条客户消息（调用方已去重）。replay=true 表示上个进程没处理完、启动时按原文重放 */
async function handleCustomerMessage(cfg: WecomConfig, msg: KfMessage, replay = false): Promise<void> {
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
  console.log(`[wecom] ${replay ? '重放' : '收到'}客户消息: "${msg.text.content.slice(0, 40)}"`);
  // 不发「稍等」占位：几秒延迟本就像真人顾问在查资料，逐条占位反而更显机械。
  try {
    const generated = replay ? alignSessionForReplay(sessionId, msg.text.content) : null;
    if (generated !== null) console.log('[wecom] 重放：上次回复已生成，原样重发');
    const reply: AgentReply =
      generated !== null
        ? { text: generated, stage: getSession(sessionId)?.stage ?? 'discovery' }
        : await handleMessage(sessionId, msg.text.content, 'wecom');
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

// ---------------- 按客户串行的处理链 ----------------
// 处理不在同步锁里 await：此前锁一直持有到整批 LLM 回复发完，A 客户一轮 4~10s，
// 期间 B 的回调只能记 pending，首响被整整推迟 A 的处理时长；新客户的 welcome_code
// 只有 20s，排在别人后面就过期了，扫码后什么都收不到。
// 现在按 external_userid 排链（写法同 engine.ts 的 serialize）：同客户保序，跨客户、跨批次都互不等待。

const userChains = new Map<string, Promise<void>>();
/** 欢迎语不排队，单独跟踪，只为停机时能等它们发完 */
const eventTasks = new Set<Promise<void>>();

function enqueueForUser(uid: string, task: () => Promise<void>): void {
  const prev = userChains.get(uid) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error('[wecom] 单条消息处理异常（继续后续消息）:', err));
  userChains.set(uid, next);
  void next.finally(() => {
    if (userChains.get(uid) === next) userChains.delete(uid);
  });
}

function dispatch(cfg: WecomConfig, msg: KfMessage, replay = false): void {
  if (isEnterSession(msg)) {
    const t = handleEnterSession(cfg, msg).catch((err) => console.error('[wecom] 欢迎语处理异常:', err));
    eventTasks.add(t);
    void t.finally(() => eventTasks.delete(t));
    return;
  }
  enqueueForUser(msg.external_userid || msg.msgid, async () => {
    try {
      await handleCustomerMessage(cfg, msg, replay);
    } finally {
      // 回复成功、静默、发送失败、异常兜底都算「处理完」；只有进程死在半路才会留在在途表里
      inflight.delete(msg.msgid);
      scheduleStateSave();
    }
  });
}

// ---------------- 同步循环 ----------------
// syncToken 由回调事件带来：带 token 调用不受严格限频（不带 token 的纯轮询会 45009）。
// 互斥期间的新触发不再丢弃（此前直接 return，消息要等 30-60s 兜底轮询）：
// 记 pending，本轮拉完立刻补拉。

let syncTask: Promise<void> | null = null;
let pendingRequested = false;
let pendingToken: string | undefined;
/** 停机中：不再拉取、不再派发新消息 */
let stopping = false;

function syncOnce(cfg: WecomConfig, syncToken?: string): Promise<void> {
  if (stopping) return Promise.resolve();
  if (syncTask) {
    pendingRequested = true;
    if (syncToken) pendingToken = syncToken;
    return Promise.resolve();
  }
  syncTask = (async () => {
    try {
      let token = syncToken;
      do {
        pendingRequested = false;
        await drainMessages(cfg, token);
        token = pendingToken;
        pendingToken = undefined;
      } while (pendingRequested && !stopping);
    } finally {
      syncTask = null;
    }
  })();
  return syncTask;
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
    // 拉取途中收到停机信号：这一页不认领（cursor 不推进、不标记），新进程启动补拉时会再拿到
    if (stopping) return;
    const accepted: KfMessage[] = [];
    let skippedOld = 0;
    for (const msg of data.msg_list ?? []) {
      const welcome = isEnterSession(msg);
      if (!welcome && msg.origin !== 3) continue; // 只处理客户发来的，跳过系统/自己发出的回声
      if (!markHandled(msg.msgid)) continue; // 幂等：同一 msgid 只处理一次（含重启后）
      if (coldStartCutoff && msg.send_time * 1000 < coldStartCutoff) {
        skippedOld += 1;
        continue;
      }
      // 只有客户消息进在途表：欢迎语的 welcome_code 20s 就过期，重启后重放也发不出去
      if (!welcome) inflight.set(msg.msgid, { msg, tries: 0 });
      accepted.push(msg);
    }
    if (skippedOld) {
      console.warn(`[wecom] 冷启动：跳过 ${skippedOld} 条启动前的历史消息（已标记处理，不回复）`);
    }
    if (data.next_cursor) cursor = data.next_cursor;
    // 先把 cursor、去重集、在途消息（含原文）一起原子落盘，再开始处理：从这一刻起
    // sync_msg 不会再返回这批消息，进程若死在处理途中，只能靠落盘的原文重放
    await saveState();
    for (const msg of accepted) dispatch(cfg, msg);
    if (!data.has_more || stopping) return;
  }
}

/** 启动时重放上个进程没处理完的客户消息。须在任何新拉取之前派发，同客户的新消息才会排在它后面 */
async function replayInflight(cfg: WecomConfig): Promise<void> {
  // 刚启动就收到停机信号：不重放，原样留在在途表里给下一个进程（重放计数也不加）
  if (!inflight.size || stopping) return;
  const todo: { msg: KfMessage; replay: boolean }[] = [];
  // 按客户串行：同一客户任何时刻只有队头那条真正进过引擎，排在后面的都还在链上等、从没开始处理。
  // 所以只有队头可能「处理到一半」，才计重放次数、按原文对齐会话；后面的当新消息派发。
  // 此前一视同仁：客户连发两条相同的「在吗」，第二条对齐时撞上第一条的回复，被当成「回复已生成」
  // 原样重发，自己却从没入库；队头是毒消息时，排在后面的无辜消息也跟着攒满次数一起被放弃。
  // 在途表是按认领顺序插入的 Map，与各客户链上的顺序一致，第一次见到的就是队头。
  const heads = new Set<string>();
  for (const [id, p] of inflight) {
    const key = p.msg.external_userid || p.msg.msgid; // 与 dispatch 排链的 key 一致
    const head = !heads.has(key);
    heads.add(key);
    const tooOld = p.msg.send_time * 1000 < Date.now() - REPLAY_MAX_AGE_MS;
    if ((head && p.tries >= MAX_REPLAY) || tooOld) {
      inflight.delete(id);
      const why = tooOld ? '已超过 48h 发送窗口' : `已重放 ${p.tries} 次仍未处理完`;
      console.error(`[wecom] ⚠️ 放弃一条未处理完的客户消息（${why}）:`, SESSION_PREFIX + p.msg.external_userid);
      // 放弃必须让顾问看见：会话最后一条是客户说的，自动跟进不会去追，不标出来就没人知道要回
      const s = getSession(SESSION_PREFIX + p.msg.external_userid);
      if (s) {
        s.messages.push({ role: 'system', content: `⚠️ 客户有一条消息 AI 未能处理（${why}），请人工回复`, at: Date.now() });
        saveSession(s, false);
      }
      continue;
    }
    if (head) p.tries += 1;
    todo.push({ msg: p.msg, replay: head });
  }
  // 重放计数先落盘再重放：重放本身若把进程带崩，下次启动能看到计数，不会无限循环
  await saveState();
  if (todo.length) console.warn(`[wecom] 重放上次停机时未处理完的 ${todo.length} 条客户消息`);
  for (const { msg, replay } of todo) dispatch(cfg, msg, replay);
}

let readyPromise: Promise<void> | null = null;
/** 幂等：加载状态 + 重放在途消息。启动循环与回调都先 await 它，消除「回调早于加载」的竞态 */
function ensureReady(cfg: WecomConfig): Promise<void> {
  return (readyPromise ??= loadState().then(() => replayInflight(cfg)));
}

/**
 * 回调收到 kf_msg_or_event 事件时调用：用事件携带的 token 立即拉取（实时且不限频）。
 * 未配置 wecom 时静默忽略。
 */
export async function syncFromCallback(syncToken: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  if (stopping) {
    // 回调照样回 success（server.ts），只是不拉：消息还在 cursor 之后，新进程启动补拉时会拿到
    console.log('[wecom] 停机中，回调不再拉取（新进程启动后补拉）');
    return;
  }
  try {
    await ensureReady(cfg);
    await syncOnce(cfg, syncToken);
  } catch (err) {
    console.error('[wecom] 回调拉取异常:', err); // server.ts 是 void 调用，漏到外面就是未捕获 rejection
  }
}

// ---------------- 启动与停机 ----------------

let started = false;
let pollTimer: NodeJS.Timeout | null = null;

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
    await ensureReady(cfg);
    // 主通道是回调驱动（syncFromCallback）。这里只做兜底慢轮询，兜住回调偶发丢失；
    // 间隔取较大值（默认 60s），不带 token 的纯轮询频率太高会 45009。
    const fallbackMs = Math.max(30000, cfg.pollIntervalMs);
    console.log(`[wecom] kf 已就绪：回调驱动 + ${fallbackMs}ms 兜底轮询`);
    const tick = async (): Promise<void> => {
      pollTimer = null;
      try {
        await syncOnce(cfg);
      } catch (err) {
        console.error('[wecom] 兜底轮询异常（下轮重试）:', err);
      }
      if (!stopping) pollTimer = setTimeout(() => void tick(), fallbackMs);
    };
    // 启动先补拉一次，不等第一个轮询周期：上个进程停机收尾时回调只回了 success 没拉，
    // 重启空档里的回调也可能已经丢了，这些消息都还在 cursor 之后
    void tick();
  })().catch((err) => console.error('[wecom] 启动失败，仅靠回调拉取:', err));
}

/** 停机钩子：停止拉新消息，等进行中的拉取与各客户的处理链跑完，再把状态落盘 */
async function drainForShutdown(): Promise<void> {
  stopping = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  // 先等启动重放派发完，再看处理链：replayInflight 过了开头的 stopping 检查后要先 await 落盘才派发，
  // 停机信号落在这个窗口里时，先查处理链会看到空的直接跳过，重放出去的回复没人等就退出了——
  // 回复可能已送达、完成标记却没落盘，下次启动又重发一遍，还白白耗掉一次重放名额
  const loaded = readyPromise
    ? await readyPromise.then(
        () => true,
        () => false,
      )
    : false;
  await syncTask?.catch(() => undefined); // 拉取失败不能让后面的「等处理链」被跳过
  // 刚拉到的一页可能在上面等待期间才派发出去，循环到链全部清空
  while (userChains.size || eventTasks.size) {
    await Promise.all([...userChains.values(), ...eventTasks]);
  }
  // 状态从没加载成功过（企微未启用）就不写，免得凭空生成一个空 cursor 的状态文件
  if (!loaded) return;
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  await saveState();
}
onShutdown(drainForShutdown);

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

/** 仅供自测：模拟「进程退出再启动」。先像 exit 阶段那样把去抖窗口里的状态落盘、等排队的写完，
 *  再把模块内存清回刚启动的样子（盘上的状态文件保留，下次拉取时重新加载） */
async function resetForTest(): Promise<void> {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
    void saveState();
  }
  await saveChain;
  cursor = '';
  handled.clear();
  inflight.clear();
  coldStartCutoff = 0;
  readyPromise = null;
  syncTask = null;
  pendingRequested = false;
  pendingToken = undefined;
  stopping = false;
  userChains.clear();
  eventTasks.clear();
  welcomeBackAt.clear();
}

function inspectForTest(): { cursor: string; coldStart: boolean; handled: string[]; inflight: string[]; busy: boolean } {
  return {
    cursor,
    coldStart: coldStartCutoff > 0,
    handled: [...handled.keys()],
    inflight: [...inflight.keys()],
    busy: syncTask !== null || userChains.size > 0 || eventTasks.size > 0,
  };
}

/** 仅供自测使用的内部函数出口（src/adapters/wecom.selftest.ts） */
export const __test = { splitForWecom, extractCard, stripLink, wechatify, resetForTest, inspectForTest, STATE_FILE, WELCOME_BACK_TEXT };
