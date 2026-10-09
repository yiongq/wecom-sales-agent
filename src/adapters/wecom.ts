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
// - 发送账本（02 第 12 步，src/quota/ledger.ts）：每个 send_msg 分段带一个我们生成的 msgid、记一行，重试沿用；
//   sync_msg 里的 msg_send_fail 回执按 msgid 记进账本。客户消息按 msgid 去重（五种情况，见 dedupeFor），
//   新拉到的与启动时的在途重放同一套规则；回复已生成而账本里没送出的原样重发、不再跑模型。
//   停机的 normal 段截止之后不再开始新的 send_msg（那时账本行已无处可写）：客户消息留在在途表，重启时按情况 4 恰好补发一次。
//
// 按账号拆开（03 spec R10、R11、R20，不变量 13、18、19）：上面这些状态都在 WecomRuntime 里，进程里每个启用的企微账号一个，
// 按账号 uuid 登记在 runtimes 里——access_token 与它的并发去重、拉取状态（wecom-state.ts 的后端）、同步互斥与补拉标志、按客户的
// 处理链、轮询定时器、停机截止、欢迎语去重表、缩略图缓存、启动是否做完。一个账号取不到 token、拉取出错、被停用，不碰别的账号。
// - env 账号（文件存储，企微状态「未导入」「已导出」）照 02：凭据每次现读 WECOM_*，状态在 var/wecom-cursor.json，会话前缀 wecom:，
//   日志前缀 [wecom]；锁定的 __test 指向它。
// - 企微状态在库里时 env 账号整条不走（不读 WECOM_*、不拉、不写 var/wecom-cursor.json）；库里每个启用的企微账号由 startChannels
//   经 startWecomAccount 起一个运行时：凭据来自 channel_accounts（解密后是 Redacted），拉取状态在 channel_inbox（第 9 步，
//   src/channels/inbox.ts，见下文「03 入站」一节：cursor 与这一页的入站行同一个事务、入站状态机、出队计次；没有内存里的 handled 与
//   在途表），发送走 03 的「先落库、后发送」（第 8 步，见下文「03 先落库、后发送」一节）。
// - 会话 id = 账号前缀 + external_userid（默认账号 wecom:，之后建的 wecom:<key>:）；发往一个会话的消息经 accountForSession 找到账号，
//   只带那个账号的 open_kfid 与 access_token；停用账号名下的会话推送返回 false。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelAdapter, ChatMessage, OutboundKind, PreparedPush, PushOpts, Session } from '../types.js';
import { handleMessage, inboundText, replyMessageOf, trimSessionMessages } from '../engine.js';
import { applyConsentDecision, CONSENT_DECLINED_REPLY, consentMenuButtonId, parseConsentMenuId } from '../handoff/consent.js';
// 接手代次变了（这一轮开始之后顾问接手）：AI 回复不发，记一条说明，与引擎同一句（不变量 28 的适配器部分）
import { TAKEN_OVER_NOTE, takeoverGen } from '../handoff/takeover.js';
import type { SensitiveCategory } from '../handoff/triggers.js';
import { currentPrivacyNotice, privacyLink } from '../privacy/privacy.js';
import {
  cancelInboxIntents,
  cancelIntents,
  commitOutbound,
  markSending,
  maySendAgain,
  noteAttempt,
  noteUnknown,
  noteUnsafeSend,
  onSendFail,
  onSendFailInbox,
  OutboundPlanError,
  payloadProblem,
  pendingIntentsOfInbox,
  planOutbound,
  planRuntimeSegment,
  recordSend,
  recoverAsUnknown,
  replyDelivered,
  settleIntent,
  unmarkSending,
  type OutboundIntent,
  type OutboundPayload,
  type SendResult,
} from '../quota/ledger.js';
import { cleanText } from '../shared/text.js';
import { withAdvisorPrefix } from '../shared/conversation.js';
import { convLabel, logQuote, withConversationLog } from '../log.js';
import {
  getOrCreateSession,
  getOrder,
  getSession,
  onShutdown,
  queueInboxState,
  recentMsgids,
  saveSession,
  writeInboxStateNow,
} from '../store.js';
import { routeForProposal } from '../tools.js';
import { endTurn, startTurn, withTurnScope } from '../trace/recorder.js';
import {
  accountForSession,
  DEFAULT_WECOM_PREFIX,
  ENV_ACCOUNT_ID,
  ENV_ACCOUNT_KEY,
  isEnabled,
  loadedAccounts,
  type ChannelAccount,
} from '../channels/accounts.js';
import { AccountInbox, InboxRowGone, noteInboxAbandoned, type InboxRow } from '../channels/inbox.js';
import {
  RecoveryGate,
  recoverOutbound,
  type InboundRecoveryCtx,
  type OpenInboxLike,
  type OpenOutboundLike,
  type RecoveryPort,
} from '../channels/recovery.js';
import { aiReplyAfter, effectiveInboxState, recordedRecovery, repliedRecovery } from '../channels/recovery-rules.js';
import { Redacted, type WecomSecrets } from '../channels/secrets.js';
import type { InboxAbandonReason } from '../shared/channel-types.js';
import { FileWecomState, markHandled, STATE_FILE, type KfMessage } from './wecom-state.js';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

interface WecomConfig {
  corpId: string;
  secret: string;
  openKfId: string;
  pollIntervalMs: number;
  publicBaseUrl: string;
}

/** 回复里的 /pay/、/proposal/ 拼成完整 URL 用的公网前缀（不是企微凭据，所有账号共用，每次现读） */
const publicBaseUrl = (): string => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

/**
 * 企微状态在库里（03 spec R1）：装上的账号里有库里的企微账号（任何状态）。这时 env 账号整条不走：不读 WECOM_*、不拉、
 * 不写 var/wecom-cursor.json（不变量 13）。还没装载（自测、eval）与文件存储、未导入、已导出时为 false，照 02
 */
function wecomInDb(): boolean {
  return loadedAccounts().some((a) => a.kind === 'wecom_kf' && a.source === 'db');
}

/** env 账号的配置：每次现读 env（而非模块加载时快照），保证 server 先加载 .env 也能生效 */
function readEnvConfig(): WecomConfig | null {
  if (wecomInDb()) return null;
  const corpId = process.env.WECOM_CORP_ID;
  const secret = process.env.WECOM_APP_SECRET;
  const openKfId = process.env.WECOM_KF_OPEN_KFID;
  if (!corpId || !secret || !openKfId) return null;
  return {
    corpId,
    secret,
    openKfId,
    pollIntervalMs: Math.max(1000, Number(process.env.WECOM_POLL_INTERVAL_MS) || 3000),
    publicBaseUrl: publicBaseUrl(),
  };
}

/** env 账号（02 的老路）：WECOM_* 配齐了，企微状态也不在库里 */
export function isWecomEnabled(): boolean {
  return readEnvConfig() !== null;
}

// ---------------- access_token 失败的订阅（进程级） ----------------

/**
 * 取 access_token 失败（02 spec 的 wecom_send 告警：取不到就立即告警，startAlerts 订阅）。收发都要它，sync_msg 拉不到消息时
 * 账本里什么都没有，所以挂在这里而不是账本上。只交企微的错误码（没有就是错误名）与账号 key，不交地址与密钥。
 * 订阅出口是进程级的（03 spec R10：按账号拆开的是运行时，订阅者只有一份），每次回调带上是哪个账号
 */
const tokenErrorListeners = new Set<(code: string, account: string) => void>();
export function onTokenError(cb: (code: string, account: string) => void): () => void {
  tokenErrorListeners.add(cb);
  return () => tokenErrorListeners.delete(cb);
}
function tokenFailed(rt: WecomRuntime, e: unknown): void {
  const code = e instanceof Error ? (/errcode=(-?\d+)/.exec(e.message)?.[1] ?? e.name) : 'unknown';
  for (const cb of tokenErrorListeners) {
    try {
      cb(code, rt.key);
    } catch {
      /* 订阅者出错不影响收发 */
    }
  }
}

// ---------------- 欢迎语 ----------------

// 客户进入会话时的欢迎语（本账号 API 托管，微信自带欢迎语不生效，须由此发）。
// AI 显式标识（00 spec「AI 显式标识」）：第一句写明「AI 旅行顾问」，正文写明人工入口；账号名在企微后台另改。
// 身份只在这里说一次：system prompt 仍是「主动自我介绍不提 AI、被问就承认」，对话中不反复自称
const WELCOME_TEXT =
  '您好呀～欢迎来到云途定制旅行，我是您的 AI 旅行顾问 🌿\n' +
  '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
  '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！需要真人服务时，回复「人工」即可转真人顾问。';

// 老客户（48h 会话窗口内）再次扫码进入时，企微不下发 welcome_code——用普通消息补一条。
// 不承诺「之前聊的都记得」：每轮只带最近 30–39 条历史，长会话会被裁剪，「重置」还会清空
const WELCOME_BACK_TEXT =
  '欢迎回来～我是云途定制旅行的 AI 旅行顾问。\n' +
  '想继续看线路、调整行程，或者换个方向看看，直接说就行～需要真人服务时，回复「人工」即可转真人顾问。';

// 改版前的两段欢迎语。已存的会话里还留着它们：上线当次重启正好是在途重放发生的时候，重放对齐要认得出来
const LEGACY_WELCOME_TEXTS = [
  '您好呀～欢迎来到云途定制旅行，我是您的专属旅行顾问 🌿\n' +
    '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
    '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！',
  '欢迎回来～我是您的专属旅行顾问，咱们之前聊的内容我都记得。\n想继续看线路、调整行程，或者换个方向看看，直接说就行～',
];
const WELCOME_TEXTS = new Set([WELCOME_TEXT, WELCOME_BACK_TEXT, ...LEGACY_WELCOME_TEXTS]);

/**
 * 发布过隐私说明时，欢迎语末尾加一行链接（02 spec「隐私说明…」，不变量 40）；没发布时原样返回——与开工时逐字节相同，
 * demo（文件配置模式）下 currentPrivacyNotice() 恒为 null，这个函数恒等于 identity
 */
function withPrivacyLink(base: string): string {
  const link = privacyLink();
  return link ? `${base}\n隐私说明：${link}` : base;
}
/** 发给模型的历史要把欢迎语过滤掉：base 版本（没发布隐私说明）与带链接版本（发布过）都认；账号自己设的欢迎语（R19）也认 */
function isWelcomeText(rt: WecomRuntime, content: string): boolean {
  if (rt.welcomeTexts.has(content)) return true;
  for (const base of rt.welcomeTexts) if (content.startsWith(`${base}\n隐私说明：`)) return true;
  return false;
}

// 补发欢迎的去重窗口。只用来吸收「同一次进入触发多个 enter_session」这类抖动，
// 不该拦住客户主动的再次扫码——原本设成 30 分钟，结果是第一次扫有招呼语、
// 一分钟后再扫什么都没有，看起来就像系统坏了。60 秒足够挡抖动。
const WELCOME_DEDUPE_MS = Math.max(0, Number(process.env.WELCOME_DEDUPE_SECONDS) || 60) * 1000;

// ---------------- 按账号的运行时 ----------------

/** 建一个运行时要的：账号、配置的取法、欢迎语、拉取状态的后端 */
interface RuntimeSpec {
  id: string;
  key: string;
  tenantId: string;
  prefix: string;
  sessionAccountId?: string;
  tag: string;
  config: () => WecomConfig | null;
  welcomeText?: string;
  welcomeBackText?: string;
  state: RuntimeState;
}

/** 拉取状态：env 账号是 02 的文件后端（cursor 文件、handled、在途表）；库里的账号是 channel_inbox（第 9 步） */
type RuntimeState = FileWecomState | AccountInbox;

/**
 * 一个企微账号的运行时（03 spec R10）。字段就是 02 的模块级状态，每个账号一份；收发与处理的函数都以它为第一个参数。
 * 按账号 uuid 登记在 runtimes 里（R20：没有别的模块级单例，进程级的只有 tokenErrorListeners 这个订阅出口）
 */
class WecomRuntime {
  /** 账号 uuid（env 账号是 ENV_ACCOUNT_ID） */
  readonly id: string;
  /** 账号 key（env 账号是 'env'）：告警与日志里用 */
  readonly key: string;
  /** 库操作都经 withTenant(tenantId)（R20）；env 账号不碰库，为空串 */
  readonly tenantId: string;
  /** 会话 id 前缀（R11）：默认账号与 env 账号 wecom:，之后建的 wecom:<key>: */
  readonly prefix: string;
  /** 非默认的库里账号：它建的会话写 channelAccountId（R11）；默认账号与 env 账号不写，NULL 就是默认账号 */
  readonly sessionAccountId: string | undefined;
  /** 日志前缀：env 账号照 02 是 [wecom]；库里的账号带 key（不带冒号：形如 wecom:<key> 的串会被日志脱敏当成会话 id 换掉） */
  readonly tag: string;
  /** 每次现取：env 账号现读 WECOM_*（企微状态在库里时为 null）；库里的账号是那一行加解密后的凭据 */
  readonly config: () => WecomConfig | null;
  readonly welcomeText: string;
  readonly welcomeBackText: string;
  readonly welcomeTexts: ReadonlySet<string>;
  /** env 账号：cursor、handled、在途表、冷启动（wecom-state.ts）；库里的账号：channel_inbox 与库里的 cursor（channels/inbox.ts） */
  readonly state: RuntimeState;

  // access_token：以 Redacted 存放（R9），过期瞬间多路径只发一次 gettoken
  token: Redacted<string> | null = null;
  tokenExpireAt = 0; // 毫秒时间戳
  tokenInflight: Promise<string> | null = null;

  // 缩略图 media_id（按账号：素材属于这个企业的应用）
  thumbCache: { id: string; at: number } | null = null;
  thumbInflight: Promise<string | null> | null = null;
  /** 失败后的冷却截止时间：没有它，文件缺失/网络故障时每条消息都要再赔上一次
   *  getAccessToken(10s)+upload(20s) 超时，客户等半分钟才收到兜底链接 */
  thumbFailUntil = 0;

  /** 老客户补发欢迎的去重：external_userid → 上次补发的时刻 */
  readonly welcomeBackAt = new Map<string, number>();

  // 停机：normal 段的截止时刻（drainForShutdown 拿到）。过了它不再开始新的 send_msg：drain 段之后账本行已无处可写，
  // 这时才开始、退出时还没回包的一次发送，重启后情况 4 会再发一遍（02 第 12 步审查 once[2]）
  sendsClosedAt = Number.POSITIVE_INFINITY;
  /** 停机中：不再拉取、不再派发新消息 */
  stopping = false;

  // 同步互斥与补拉标志
  syncTask: Promise<void> | null = null;
  pendingRequested = false;
  pendingToken: string | undefined;

  // 按客户串行的处理链；欢迎语不排队，单独跟踪，只为停机时能等它们发完
  readonly userChains = new Map<string, Promise<void>>();
  readonly eventTasks = new Set<Promise<void>>();
  /**
   * 03 入站：停机时队头那一行放下了（计次没写进库）的会话（处理链的键）。之后轮到这个会话的行一律不出队、整段留给重启恢复，
   * 不让排在后面的先处理（不变量 12，第 9 步评审）
   */
  readonly haltedChains = new Set<string>();

  /** 加载状态 + 重放在途消息（幂等）：启动循环与回调都先 await 它，消除「回调早于加载」的竞态 */
  readyPromise: Promise<void> | null = null;
  /**
   * 启动恢复做没做完（R5、R10；src/channels/recovery.ts）。recovering：库里的账号起来之后先按出站恢复表、入站恢复表处理没结果的出站行
   * 与没结束的入站行，这期间不拉取（回调与轮询都不拉：先拉新消息会让同一客户的新消息先于旧的处理，不变量 12），push 在 gate 上排队等待。
   * env 账号没有启动恢复（照 02 的在途重放），恒为 done
   */
  recovery: 'recovering' | 'done';
  /** 恢复做完之前 push（人工回复、跟进、通知）在这里等，至多 30 秒 */
  readonly gate: RecoveryGate;

  // 兜底轮询
  started = false;
  pollTimer: NodeJS.Timeout | null = null;

  constructor(spec: RuntimeSpec) {
    this.id = spec.id;
    this.key = spec.key;
    this.tenantId = spec.tenantId;
    this.prefix = spec.prefix;
    this.sessionAccountId = spec.sessionAccountId;
    this.tag = spec.tag;
    this.config = spec.config;
    this.welcomeText = spec.welcomeText ?? WELCOME_TEXT;
    this.welcomeBackText = spec.welcomeBackText ?? WELCOME_BACK_TEXT;
    this.welcomeTexts =
      spec.welcomeText === undefined && spec.welcomeBackText === undefined
        ? WELCOME_TEXTS
        : new Set([...WELCOME_TEXTS, this.welcomeText, this.welcomeBackText]);
    this.state = spec.state;
    this.recovery = spec.state.kind === 'file' ? 'done' : 'recovering';
    this.gate = new RecoveryGate(this.recovery === 'done');
  }
}

/** 进程里的企微运行时，按账号 uuid（env 账号在 ENV_ACCOUNT_ID 下，模块加载时就在） */
const runtimes = new Map<string, WecomRuntime>();

/** env 账号：02 的老路，状态在 var/wecom-cursor.json */
const envRuntime = new WecomRuntime({
  id: ENV_ACCOUNT_ID,
  key: ENV_ACCOUNT_KEY,
  tenantId: '',
  prefix: DEFAULT_WECOM_PREFIX,
  tag: '[wecom]',
  config: readEnvConfig,
  state: new FileWecomState(),
});
runtimes.set(envRuntime.id, envRuntime);

/** 库里账号的日志前缀 */
const accountTag = (key: string): string => `[wecom acct=${key}]`;

const sendsClosed = (rt: WecomRuntime): boolean => Date.now() >= rt.sendsClosedAt;

/**
 * 这个账号的会话（没有就建，02 的 getOrCreateSession）。非默认的库里账号建的会话带 channelAccountId（R11）：与建会话同一段同步代码，
 * 排出的那次落库里就有，conversations.channel_account_id 是它的投影
 */
function accountSession(rt: WecomRuntime, sessionId: string): Session {
  const s = getOrCreateSession(sessionId, 'wecom');
  if (rt.sessionAccountId && s.channelAccountId !== rt.sessionAccountId) s.channelAccountId = rt.sessionAccountId;
  return s;
}

// ---------------- access_token ----------------

async function getAccessToken(rt: WecomRuntime, cfg: WecomConfig, force = false): Promise<string> {
  if (!force && rt.token && Date.now() < rt.tokenExpireAt) return rt.token.reveal();
  rt.tokenInflight ??= (async () => {
    try {
      const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
      if (data.errcode || !data.access_token) {
        throw new Error(`gettoken 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
      }
      rt.token = new Redacted(data.access_token);
      // 官方 7200s，提前 300s 刷新，避开边界失效
      rt.tokenExpireAt = Date.now() + ((data.expires_in ?? 7200) - 300) * 1000;
      return data.access_token;
    } catch (e) {
      tokenFailed(rt, e);
      throw e;
    } finally {
      rt.tokenInflight = null;
    }
  })();
  return rt.tokenInflight;
}

/**
 * 取 access_token 失败：请求根本没发出去（发送账本里这一段不记，02 第 12 步）。token 过期后强刷失败也是它：
 * 那一次 send_msg 已被企微以 42001 / 40014 拒掉，同样没送达
 */
class TokenError extends Error {
  override readonly name = 'TokenError';
  constructor(cause: unknown) {
    super(`取 access_token 失败（${cause instanceof Error ? cause.message : String(cause)}）`, { cause });
  }
}

async function tokenOrThrow(rt: WecomRuntime, cfg: WecomConfig, force = false): Promise<string> {
  try {
    return await getAccessToken(rt, cfg, force);
  } catch (e) {
    throw new TokenError(e);
  }
}

/** 带 token 的 POST；token 过期（42001/40014）自动强刷重试一次。取 token 失败抛 TokenError */
async function callApi<T extends { errcode?: number; errmsg?: string }>(
  rt: WecomRuntime,
  cfg: WecomConfig,
  endpoint: string,
  body: unknown,
): Promise<T> {
  let token = await tokenOrThrow(rt, cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API_BASE}/${endpoint}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json()) as T;
    if ((data.errcode === 42001 || data.errcode === 40014) && attempt === 0) {
      token = await tokenOrThrow(rt, cfg, true);
      continue;
    }
    return data;
  }
  throw new Error('unreachable');
}

// ---------------- 在途重放的上限 ----------------

/** 同一条消息最多重放几次。防「毒消息」：若某条消息一处理就把进程带崩，不设上限会变成重启即崩的死循环 */
const MAX_REPLAY = 2;
/** send_msg 只能在客户最后一条消息后 48h 内发，更老的在途消息重放了也发不出去 */
const REPLAY_MAX_AGE_MS = 48 * 3600 * 1000;

// ---------------- 收发消息 ----------------

/** 发送账本要的：这一次发送记哪一类、对应会话里的哪条消息（02 第 12 步） */
interface SendCtx {
  kind: OutboundKind;
  message: ChatMessage | null;
  /**
   * 这一轮 AI 回复还算不算数（审查第 7 条，concurrency[3]）：只有 kind='ai' 的客户对话主链路才带它。
   * sendRich 调 uploadThumb 之后、sendText 每段第一次 send_msg 之前、每次重试之前都再调一次——
   * uploadThumb 的网络请求、send_msg 的退避重试都是真实的 I/O 等待，HTTP 发起的接手能插进来，不是只有 microtask 的那一段
   */
  stillCurrent?: () => boolean;
}

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
const THUMB_FAIL_COOLDOWN = 60_000;

async function uploadThumb(rt: WecomRuntime, cfg: WecomConfig): Promise<string | null> {
  if (rt.thumbCache && Date.now() - rt.thumbCache.at < THUMB_TTL) return rt.thumbCache.id;
  if (Date.now() < rt.thumbFailUntil) return null;
  if (rt.thumbInflight) return rt.thumbInflight;
  // 先存局部再赋运行时字段：若 IIFE 在首个 await 之前同步抛出，finally 的置空会先于
  // 外层赋值执行，thumbInflight 会被永久钉在一个已结束的 promise 上，卡片从此彻底失效
  const task = (async () => {
    try {
      const file = path.resolve('assets/proposal-thumb.png');
      const buf = await readFile(file);
      const token = await getAccessToken(rt, cfg);
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'proposal-thumb.png');
      const res = await fetch(`${API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20000),
      });
      const d = (await res.json()) as { errcode?: number; errmsg?: string; media_id?: string };
      if (d.errcode || !d.media_id) {
        console.error(`${rt.tag} 缩略图上传失败，链接将以纯文本发送:`, d.errcode, d.errmsg);
        rt.thumbFailUntil = Date.now() + THUMB_FAIL_COOLDOWN;
        return null;
      }
      rt.thumbCache = { id: d.media_id, at: Date.now() };
      console.log(`${rt.tag} 链接卡片缩略图已上传`);
      return d.media_id;
    } catch (e) {
      console.error(`${rt.tag} 缩略图上传异常:`, e instanceof Error ? e.message : e);
      rt.thumbFailUntil = Date.now() + THUMB_FAIL_COOLDOWN;
      return null;
    } finally {
      rt.thumbInflight = null;
    }
  })();
  rt.thumbInflight = task;
  return task;
}

/** 正文里出现的所有站内链接（方案书/支付）。方案书链接可能带版本后缀 ?v=（02「报价快照」），算在同一条里 */
const ALL_LINKS_RE = /(?:https?:\/\/[^\s]*)?\/(?:proposal|pay)\/[A-Za-z0-9_-]+(?:\/[\d-]+)*(?:\?v=\d+)?/g;

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
  const prop = text.match(/(?:https?:\/\/[^\s]*)?\/proposal\/([A-Za-z0-9_-]+)\/(\d+)(?:\/([\d-]+))?(?:\?v=(\d+))?/);
  if (prop) {
    // 卡片上的线路取链接指的那个版本（不带 v 是版本 1），与点开的方案书同一份；版本不存在就不做卡片，原样发纯文本
    const route = routeForProposal(prop[1]!, prop[4]);
    if (!route) return null;
    const travelers = Number(prop[2]);
    return {
      title: `${route.title} · 行程方案书`,
      desc: `${route.days} 天 · ${travelers} 位出行 · ${route.hotelLevel}｜含逐日行程与费用说明`,
      url: `${baseUrl}/proposal/${route.id}/${travelers}${prop[3] ? '/' + prop[3] : ''}${prop[4] ? `?v=${prop[4]}` : ''}`,
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

/**
 * 发链接卡片（缩略图由调用方先备好，见 sendRich）。接口报错或网络异常时返回 false，调用方退回纯文本。
 * 卡片也是一次 send_msg：带 msgid、记一行账（kind='card'，对应的是这条回复），不重试
 */
async function sendLinkCard(
  rt: WecomRuntime,
  cfg: WecomConfig,
  externalUserId: string,
  card: { title: string; desc: string; url: string },
  thumb: string,
  message: ChatMessage | null,
): Promise<boolean> {
  const entry = recordSend(rt.prefix + externalUserId, 'card', message);
  // 整体包 try/catch：callApi 用 AbortSignal.timeout，网络抖动会 reject 而不是返回 errcode。
  // 漏掉会让异常冲出 push()，调用方的纯文本兜底永不执行——正文已经发出去了、链接却没了。
  try {
    entry.attempt();
    const data = await callApi<{ errcode?: number; errmsg?: string }>(rt, cfg, 'kf/send_msg', {
      touser: externalUserId,
      open_kfid: cfg.openKfId,
      msgid: entry.msgid,
      msgtype: 'link',
      link: { title: card.title.slice(0, 128), desc: card.desc.slice(0, 512), url: card.url, thumb_media_id: thumb },
    });
    if (data.errcode) {
      entry.settle('rejected', data.errcode);
      console.error(`${rt.tag} 链接卡片发送失败(errcode=${data.errcode} ${data.errmsg ?? ''})，退回纯文本`);
      return false;
    }
    entry.settle('accepted');
    return true;
  } catch (e) {
    if (e instanceof TokenError) entry.discard();
    else entry.settle('unknown');
    console.error(`${rt.tag} 链接卡片发送异常，退回纯文本:`, e instanceof Error ? e.message : e);
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
async function sendRich(rt: WecomRuntime, cfg: WecomConfig, uid: string, body: string, ctx: SendCtx): Promise<boolean> {
  // 人工回复（kind='human'）的客户侧正文前加「【顾问】」（不变量 18）：加在拆完卡片之后，只加在客户读到的正文上——
  // 加在整条前面的话，只贴了一条链接时会单独发一条只有「【顾问】」的消息、多占一条额度，「方案书：<链接>」的标签也认不出来
  const advisor = ctx.kind === 'human' ? withAdvisorPrefix : (t: string): string => t;
  const card = cfg.publicBaseUrl ? extractCard(body, cfg.publicBaseUrl) : null;
  if (!card) return sendText(rt, cfg, uid, advisor(body), ctx);
  // 先把缩略图备好再动正文。stripLink 会把「方案书在这儿」改成「见下方卡片」，
  // 此前先发了改过的正文才去传缩略图，缩略图一失败（接口报错、之后 60 秒冷却期内每一张都算），
  // 客户读到「见下方卡片」，下方却是一条纯文本链接。拿不到缩略图就原样发正文，链接留在原处
  const thumb = await uploadThumb(rt, cfg).catch(() => null);
  // 缩略图上传是真实网络请求（2 天内第一张最长等 20 秒）：这期间被接手，还没发出任何一段就整条不发
  if (ctx.stillCurrent && !ctx.stillCurrent()) return false;
  if (!thumb) return sendText(rt, cfg, uid, advisor(body), ctx);
  const prose = stripLink(body, card.raw);
  // 只有卡片、没有正文的人工回复：前缀加在卡片标题上（客户仍看得出是顾问发的，也不多发一条）
  if (!prose && ctx.kind === 'human') card.title = withAdvisorPrefix(card.title);
  const textOk = prose ? await sendText(rt, cfg, uid, advisor(prose), ctx) : true;
  if (await sendLinkCard(rt, cfg, uid, card, thumb, ctx.message)) return textOk;
  // 缩略图就绪、卡片本身却发送失败（接口报错、网络异常，少见）：正文已按「见下方卡片」发出，收不回来了。
  // 把链接补发在正文下方——「下方」来的是一条带标题的链接而不是卡片，措辞差一点，但链接一定送达
  return (
    (await sendText(rt, cfg, uid, `${card.title}\n${card.url}`, {
      kind: 'card',
      message: ctx.message,
      stillCurrent: ctx.stillCurrent,
    })) && textOk
  );
}

/**
 * 发文本：自动分段；限流/网络类失败退避重试（最多 3 次），其余错误打日志放弃。
 * 返回是否全部分段都发送成功——调用方（如后台人工回复）据此提示操作者。
 * 每个分段在发送账本里记一行、带一个 msgid，同一分段的重试沿用这一行与这个 msgid（不变量 33）。一段的结果：有一次成功是 accepted；
 * 否则有一次超时或网络异常（可能已经送达）是 unknown；否则是 rejected（接口明确报错）；取 access_token 失败、一次都没发出去的不记。
 * 返回 false 时分不清「明确没送达」与「结果不明」，要分的调用方看账本的 mayHaveDelivered
 */
async function sendText(rt: WecomRuntime, cfg: WecomConfig, externalUserId: string, text: string, ctx: SendCtx): Promise<boolean> {
  let allOk = true;
  let anyAccepted = false;
  for (const chunk of splitForWecom(text)) {
    // 被接手（审查第 7 条，concurrency[3]）：还没发出过任何一段就整条不发；已经发出过的不再补发剩下的分段，
    // 但剩下的没发出去，不能算 allOk（调用方据此与接手代次再核一次，写 TAKEN_OVER_NOTE 而不是通用的发送失败说明）
    if (ctx.stillCurrent && !ctx.stillCurrent()) {
      if (!anyAccepted) return false;
      allOk = false;
      break;
    }
    const entry = recordSend(rt.prefix + externalUserId, ctx.kind, ctx.message);
    let lastErr = '';
    let outcome: SendResult | null = null;
    let errcode: number | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      // 退避重试不再继续：接手可能恰好发生在上一次尝试与这一次之间
      if (ctx.stillCurrent && !ctx.stillCurrent()) break;
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        if (ctx.stillCurrent && !ctx.stillCurrent()) break;
      }
      entry.attempt();
      try {
        const data = await callApi<{ errcode?: number; errmsg?: string }>(rt, cfg, 'kf/send_msg', {
          touser: externalUserId,
          open_kfid: cfg.openKfId,
          msgid: entry.msgid,
          msgtype: 'text',
          text: { content: chunk },
        });
        if (!data.errcode) {
          lastErr = '';
          outcome = 'accepted';
          anyAccepted = true;
          break;
        }
        lastErr = `errcode=${data.errcode} ${data.errmsg ?? ''}`;
        errcode = data.errcode;
        if (outcome !== 'unknown') outcome = 'rejected';
        // 45009=接口限流、-1=系统繁忙 值得重试；其余（参数错/无权限）重试无意义
        if (data.errcode !== 45009 && data.errcode !== -1) break;
      } catch (e) {
        lastErr = String(e); // 网络异常/超时，重试
        // 超时与网络异常：请求可能已经到了企微、消息可能已经送达，结果不明（计入额度）；取 token 失败是根本没发。
        // 立刻记 unknown 并排进落库，不等重试跑完：重试途中进程被杀或停机，重启后情况 4 看到 unknown 就不再重发
        if (!(e instanceof TokenError)) {
          outcome = 'unknown';
          entry.unknown();
        }
      }
    }
    // 分段最终的结果（第 17 步的 wecom_send 告警也挂在这里）
    if (outcome === null) entry.discard();
    else entry.settle(outcome, outcome === 'accepted' ? undefined : errcode);
    if (lastErr) {
      console.error(`${rt.tag} send_msg 最终失败（已重试）: ${lastErr}`);
      allOk = false;
    } else if (outcome === null && ctx.stillCurrent && !ctx.stillCurrent()) {
      // 这一段在重试之间被接手拦下（没有报错，所以 lastErr 是空的）：同样不算 allOk
      allOk = false;
    }
  }
  return allOk;
}

/**
 * 发同意菜单（02 第 16 步，R23）：msgtype=msgmenu，head_content 是问句正文，两个按钮「同意」「不同意」，
 * id 按 consentMenuButtonId 编码 category:decision，企微回传的 msgmenu_click 事件据它认出点的是哪个类别、哪个决定。
 * 退避重试与账本记账同 sendText，只是单条、不分段（问句远小于 2048 字节上限）
 */
async function sendMenu(
  rt: WecomRuntime,
  cfg: WecomConfig,
  externalUserId: string,
  headContent: string,
  category: SensitiveCategory,
): Promise<boolean> {
  const entry = recordSend(rt.prefix + externalUserId, 'menu', null);
  let outcome: SendResult | null = null;
  let errcode: number | undefined;
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    entry.attempt();
    try {
      const data = await callApi<{ errcode?: number; errmsg?: string }>(rt, cfg, 'kf/send_msg', {
        touser: externalUserId,
        open_kfid: cfg.openKfId,
        msgid: entry.msgid,
        msgtype: 'msgmenu',
        msgmenu: {
          head_content: headContent,
          list: [
            { type: 'click', click: { id: consentMenuButtonId(category, 'granted'), content: '同意' } },
            { type: 'click', click: { id: consentMenuButtonId(category, 'declined'), content: '不同意' } },
          ],
        },
      });
      if (!data.errcode) {
        outcome = 'accepted';
        lastErr = '';
        break;
      }
      lastErr = `errcode=${data.errcode} ${data.errmsg ?? ''}`;
      errcode = data.errcode;
      if (outcome !== 'unknown') outcome = 'rejected';
      if (data.errcode !== 45009 && data.errcode !== -1) break;
    } catch (e) {
      lastErr = String(e);
      if (!(e instanceof TokenError)) {
        outcome = 'unknown';
        entry.unknown();
      }
    }
  }
  if (outcome === null) entry.discard();
  else entry.settle(outcome, outcome === 'accepted' ? undefined : errcode);
  if (lastErr) console.error(`${rt.tag} 同意菜单 send_msg 最终失败（已重试）: ${lastErr}`);
  return outcome === 'accepted';
}

// ---------------- 03 先落库、后发送（库里的企微账号） ----------------
// docs/architecture/03-channels-v2/spec.md「出站：投递状态」、R4、R6、R21，不变量 4、6、7、10。env 账号照 02 走上面的 sendRich /
// sendText / sendMenu（锁定的 wecom.selftest.ts 与 02 的自测守它们）；库里的企微账号的每一类出站都走这里：
//   切分段 → planOutbound（每段一行 pending，排进会话的落库）→ commitOutbound（至多 5 秒）→ 每段：比停机截止、比接手代次 →
//   取 access_token（卡片再取缩略图）→ markSending → 再比一次接手代次与停机截止 → send_msg（这次比较与发请求之间没有 await）→
//   settleIntent。卡片发失败补的「标题 + 链接」是运行时才补的段（planRuntimeSegment）。
// 人工回复、跟进、通知、同意菜单经 prepare 在写会话的同一段同步代码里先排 pending，push 时只做后半段。
// 接手代次只对 AI 回复、跟进、同意菜单、欢迎语比；通知与人工回复只比停机截止（见 OutGroup.checksTakeover）

/** 库里的企微账号走 03 的发送；env 账号照 02 */
const isDbAccount = (rt: WecomRuntime): boolean => rt !== envRuntime;

/** 一组分段与发它要的：运行时、这一组开始时的接手代次、卡片原样的标题与地址、每段的 pending 落没落库 */
interface OutGroup {
  rt: WecomRuntime;
  cfg: WecomConfig;
  uid: string;
  sessionId: string;
  intents: OutboundIntent[];
  /** 第 3、4 步比的接手代次：AI 回复是这一轮开始时的（02 的写法），先落库的几类是 prepare 那一刻的 */
  gen: number;
  /**
   * 这一组比不比接手代次：AI 回复、跟进、同意菜单、欢迎语比（不让 AI 抢顾问的话，不变量 28）；通知（付款确认、顾问确认收款、
   * 不同意之后的确认）与人工回复不比、只比停机截止（协调者 2026-10-09 裁决：出站恢复表对通知本来就不看接手直接补发，02 发通知也
   * 不看接手；照字面比的话客户付了款却收不到确认）
   */
  checksTakeover: boolean;
  /** 卡片段的 msgid → 原样的标题与地址（卡片发失败补「标题 + 链接」用，02 的写法） */
  cards: Map<string, { title: string; url: string }>;
  /** 每段的 pending 落没落库（commitOutbound 的结果；运行时补的段各自的）：markSending 返回 absent 时据它判照不照发 */
  commit: Map<string, 'committed' | 'timeout'>;
  /**
   * 回的是哪条入站（03 第 9 步）：客户消息的回复、非文本的引导提示。planOutbound 把入站行改 replied（与 pending 同一次落库）；
   * 这一组全部分段有了结果（cancelled 也算）时记 done，停在 pending 的（停机截止）不记、留给重启恢复。其余各类为 null
   */
  inboxId: string | null;
  /**
   * 启动恢复（RESEND_UNKNOWN 为真）补发的 sending 段：库里已是 sending，不再 markSending，直接发（spec「直接走第 5 步」）；
   * 过了停机截止就不发、留在 sending（下次启动再按表处理）
   */
  alreadySending?: ReadonlySet<string>;
  /**
   * 启动恢复补发的人工回复（开放问题 6）：每次真正发请求之前再复核一次资格（建这一行起仍在 10 分钟内、会话的接手人仍是作者），
   * 不符合就不发、记 cancelled。等 token、markSending 都要时间，会话可能在这期间被交还或改派。普通的人工发送没有它（第 8 步：不比接手）
   */
  stillEligible?: () => boolean;
}

/** 一组发完（或停下）的结果：ok 是每段都送出（卡片发失败而补的文字送出了也算）；stop 是停在哪一步 */
interface GroupOutcome {
  ok: boolean;
  stop: 'taken_over' | 'deferred' | null;
}

/** planOutbound 的校验没过：这一组什么都没排，按发送失败处理（会话加说明；告警经账本的 onPlanRejected） */
const PLAN_FAILED_NOTE = '⚠️ 一条要发给客户的消息没有排进发送（没过发送前的检查），客户没有收到，请人工跟进';

const textPayloads = (text: string): OutboundPayload[] =>
  splitForWecom(text).map((content): OutboundPayload => ({ msgtype: 'text', text: { content } }));

/** 同意菜单（02 第 16 步）：问句正文与「同意」「不同意」两个按钮，按钮 id 按 consentMenuButtonId 编码 */
const menuPayload = (headContent: string, category: SensitiveCategory): OutboundPayload => ({
  msgtype: 'msgmenu',
  msgmenu: {
    head_content: headContent,
    list: [
      { type: 'click', click: { id: consentMenuButtonId(category, 'granted'), content: '同意' } },
      { type: 'click', click: { id: consentMenuButtonId(category, 'declined'), content: '不同意' } },
    ],
  },
});

/**
 * 一条回复的分段（02 sendRich 的切法）：human 的客户侧正文加「【顾问】」；有单条站内链接、而且 withCard（缩略图拿得到）时是
 * 去掉链接的正文分段加一张卡片（kind 是这一组的种类，是不是卡片看 payload.msgtype），否则整段原文分段
 */
function payloadsFor(
  cfg: WecomConfig,
  body: string,
  kind: OutboundKind,
  withCard: boolean,
): { payloads: OutboundPayload[]; card: { title: string; url: string } | null } {
  const advisor = kind === 'human' ? withAdvisorPrefix : (t: string): string => t;
  const card = withCard && cfg.publicBaseUrl ? extractCard(body, cfg.publicBaseUrl) : null;
  if (!card) return { payloads: textPayloads(advisor(body)), card: null };
  const prose = stripLink(body, card.raw);
  // 只有卡片、没有正文的人工回复：前缀加在卡片标题上（客户仍看得出是顾问发的，也不多发一条）
  if (!prose && kind === 'human') card.title = withAdvisorPrefix(card.title);
  const link: OutboundPayload = {
    msgtype: 'link',
    link: { title: cleanText(card.title, 128), desc: cleanText(card.desc, 512), url: card.url },
  };
  return { payloads: [...(prose ? textPayloads(advisor(prose)) : []), link], card: { title: card.title, url: card.url } };
}

/** 运行时的账号对象（planOutbound 要它校验会话与账号一致） */
const accountOf = (rt: WecomRuntime): ChannelAccount | undefined => loadedAccounts().find((a) => a.id === rt.id);

/**
 * planOutbound：每段一行 pending，排进这个会话的落库（没有会话的单独短事务）。校验没过抛 OutboundPlanError，调用方按发送失败处理
 */
function planGroup(
  rt: WecomRuntime,
  cfg: WecomConfig,
  sessionId: string,
  kind: OutboundKind,
  message: ChatMessage | null,
  payloads: readonly OutboundPayload[],
  card: { title: string; url: string } | null,
  gen: number,
  inboxId: string | null = null,
): OutGroup {
  const account = accountOf(rt);
  if (!account) throw new OutboundPlanError('运行时的账号不在装上的账号里');
  const intents = planOutbound(account, { sessionId, hasSession: getSession(sessionId) !== undefined }, kind, message, inboxId, payloads);
  const cards = new Map<string, { title: string; url: string }>();
  const link = intents.find((i) => i.payload.msgtype === 'link');
  if (card && link) cards.set(link.msgid, card);
  const checksTakeover = kind !== 'notice' && kind !== 'human';
  return { rt, cfg, uid: sessionId.slice(rt.prefix.length), sessionId, intents, gen, checksTakeover, cards, commit: new Map(), inboxId };
}

/** 这一组没排进发送：日志一行（只有原因），会话加一条说明（告警由账本的 onPlanRejected 推） */
function planFailed(rt: WecomRuntime, sessionId: string, e: unknown): void {
  console.error(
    `${rt.tag} ⚠️ 一组出站没排进发送（${e instanceof OutboundPlanError ? e.reason : e instanceof Error ? e.name : 'unknown'}）:`,
    convLabel(sessionId),
  );
  const s = getSession(sessionId);
  if (s) {
    s.messages.push({ role: 'system', content: PLAN_FAILED_NOTE, at: Date.now() });
    saveSession(s, false);
  }
}

/** send_msg 的请求体：payload 原样加收件人、客服账号与 msgid；卡片补上发送时现取的缩略图 */
function sendBody(g: OutGroup, intent: OutboundIntent, thumb: string | null): Record<string, unknown> {
  const p = intent.payload;
  const base = { touser: g.uid, open_kfid: g.cfg.openKfId, msgid: intent.msgid };
  if (p.msgtype === 'link') return { ...base, msgtype: 'link', link: { ...p.link, thumb_media_id: thumb } };
  return { ...base, ...p };
}

/** 发一次 send_msg：调用时同步发起请求（之前不 await 任何东西，第 4 步「比较与发请求之间没有 await」） */
function postSendMsg(token: string, body: Record<string, unknown>): Promise<{ errcode?: number; errmsg?: string }> {
  return fetch(`${API_BASE}/kf/send_msg?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then((res) => res.json() as Promise<{ errcode?: number; errmsg?: string }>);
}

/**
 * 这一组还算不算数：接手代次没变（通知与人工回复不比接手，见 OutGroup.checksTakeover），而且恢复补发的人工回复仍有资格
 * （OutGroup.stillEligible）
 */
const stillCurrent = (g: OutGroup): boolean =>
  (!g.checksTakeover || takeoverGen(g.sessionId) === g.gen) && (!g.stillEligible || g.stillEligible());

/**
 * 这一组不再算数（被接手，或恢复补发的人工回复不再有资格）：没发的段不发。启动恢复补发的历史 sending 段（alreadySending）可能在
 * 上一个进程里发出去过，记 unknown（工作台「可能没送达」）；其余记 cancelled（本进程标了 sending、还没发请求的也是）
 */
function dropRest(g: OutGroup, intents: readonly OutboundIntent[]): void {
  const sent = intents.filter((i) => g.alreadySending?.has(i.msgid));
  for (const i of sent) recoverAsUnknown(i);
  if (sent.length) console.log(`${g.rt.tag} 补发之前会话被接手：${sent.length} 段停在发送中的不补发，记 unknown`);
  cancelIntents(
    intents.filter((i) => !sent.includes(i)),
    g.stillEligible && !g.stillEligible() ? 'restore' : 'taken_over',
  );
}

/** 卡片发失败补的「标题 + 链接」的 msgid：由卡片段的 msgid 定死（第几块），重启后再补同一块还是这一行，库里认得出这一组已经有补文了 */
const fallbackMsgid = (cardMsgid: string, chunk: number): string =>
  createHash('sha256').update(`card-fallback:${cardMsgid}:${chunk}`).digest('hex').slice(0, 32);

/**
 * 一段的第 4–5 步。返回：accepted；failed（rejected 或 unknown）；skipped（not_pending，或 absent 而 pending 提交过）；
 * taken_over（这一段与 rest 已取消）；deferred（过了停机截止，这一段与 rest 留在 pending）
 */
async function sendSegment(
  g: OutGroup,
  intent: OutboundIntent,
  rest: readonly OutboundIntent[],
): Promise<'accepted' | 'failed' | 'skipped' | 'taken_over' | 'deferred'> {
  const { rt, cfg } = g;
  const isLink = intent.payload.msgtype === 'link';
  // 发之前要等的（access_token、卡片的缩略图）先等完：markSending 之后到发请求之间不再等别的
  let token: string;
  try {
    token = await tokenOrThrow(rt, cfg);
  } catch (e) {
    // 请求根本没发出去：这一段明确没送达（rejected、不计条数；没发过请求，不进 wecom_send 的计数，token 另有告警）
    console.error(`${rt.tag} send_msg 没发出去（${e instanceof Error ? e.message : 'unknown'}）`);
    settleIntent(intent, 'rejected', { attempts: 0 });
    return 'failed';
  }
  let thumb: string | null = null;
  if (isLink) {
    thumb = await uploadThumb(rt, cfg).catch(() => null);
    if (!thumb) {
      // 缩略图这时拿不到（先落库的几类在切分时只看了冷却期）：卡片发不了，按卡片发失败处理（调用方补「标题 + 链接」）
      console.error(`${rt.tag} 链接卡片的缩略图拿不到，退回纯文本`);
      settleIntent(intent, 'rejected', { attempts: 0 });
      return 'failed';
    }
  }
  // 4 markSending（启动恢复补发的 sending 段已是 sending，直接发）
  const already = g.alreadySending?.has(intent.msgid) ?? false;
  const mark = already ? 'marked' : await markSending(intent);
  if (mark === 'not_pending') return 'skipped';
  if (mark === 'absent' && g.commit.get(intent.msgid) !== 'timeout') {
    // pending 提交过、行又没了：只会是被清除（保留期清理、行权删除）。不发
    console.error(`${rt.tag} ⚠️ 出站行提交过又不在库里了（会话被清除？），这一段不发`);
    cancelIntents([intent], 'aborted');
    return 'skipped';
  }
  // 4 返回之后、发请求之前再比一次接手代次与停机截止（markSending 期间可能有人接手或到了截止）
  if (!stillCurrent(g)) {
    dropRest(g, [intent, ...rest]);
    return 'taken_over';
  }
  if (sendsClosed(rt)) {
    if (mark === 'marked' && !already) await unmarkSending(intent);
    return 'deferred';
  }
  // R6：这一段的 sending 没在发请求之前提交（pending 等不到提交、库不可用），照发、计数
  if (mark !== 'marked') noteUnsafeSend();
  // 5 send_msg：同一段的重试沿用 msgid；文本与菜单照 02 退避重试（45009、-1、网络异常），卡片不重试
  const body = sendBody(g, intent, thumb);
  let outcome: SendResult | null = null;
  let errcode: number | undefined;
  let lastErr = '';
  let attempts = 0;
  for (let attempt = 0; attempt < (isLink ? 1 : 3); attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      // 退避期间被接手、过了截止，或这一段已是终态（退避期间收到失败回执记了 failed 等，不变量 5）：不再开始新的请求，
      // 这一段的结果以已有的为准。比较与发请求之间没有 await
      if (!stillCurrent(g) || sendsClosed(rt) || !maySendAgain(intent)) break;
      try {
        token = await tokenOrThrow(rt, cfg);
      } catch {
        break;
      }
      if (!stillCurrent(g) || sendsClosed(rt) || !maySendAgain(intent)) break;
    }
    noteAttempt(intent);
    attempts++;
    try {
      let data = await postSendMsg(token, body);
      if (data.errcode === 42001 || data.errcode === 40014) {
        // token 过期：强刷一次、同一 msgid 再发（02 callApi 的规则）。强刷是真实的网络等待，之后再比一次
        lastErr = `errcode=${data.errcode} ${data.errmsg ?? ''}`;
        errcode = data.errcode;
        if (outcome !== 'unknown') outcome = 'rejected';
        try {
          token = await tokenOrThrow(rt, cfg, true);
        } catch {
          break;
        }
        if (!stillCurrent(g) || sendsClosed(rt) || !maySendAgain(intent)) break;
        noteAttempt(intent);
        attempts++;
        data = await postSendMsg(token, body);
      }
      if (!data.errcode) {
        outcome = 'accepted';
        lastErr = '';
        break;
      }
      lastErr = `errcode=${data.errcode} ${data.errmsg ?? ''}`;
      errcode = data.errcode;
      if (outcome !== 'unknown') outcome = 'rejected';
      if (data.errcode !== 45009 && data.errcode !== -1) break;
    } catch (e) {
      // 超时与网络异常：请求可能已经到了企微，结果不明（计入额度）；立刻记 unknown 排进落库，不等重试跑完（02）
      lastErr = e instanceof Error ? e.name : 'unknown';
      outcome = 'unknown';
      noteUnknown(intent);
    }
  }
  const result: SendResult = outcome ?? 'rejected';
  settleIntent(intent, result, { ...(result === 'accepted' ? {} : errcode !== undefined ? { errcode } : {}), attempts });
  if (lastErr) console.error(`${rt.tag} send_msg 最终失败（${isLink ? '链接卡片' : '已重试'}）: ${lastErr}`);
  return result === 'accepted' ? 'accepted' : 'failed';
}

/**
 * 发一组（第 2 步之后的 commitOutbound 与第 3–5 步），见 sendGroup。回一条入站的组（inboxId）发完之后：全部分段有了结果
 * （accepted、rejected、unknown、failed，被接手打断而 cancelled 的也算——那一组不会再发）→ 入站 done；停在停机截止（deferred）的
 * 不记，分段留在 pending、入站留在 replied，重启后按出站恢复表处理（第 10 步）
 */
async function runGroup(g: OutGroup): Promise<GroupOutcome> {
  const out = await sendGroup(g);
  if (g.inboxId !== null && out.stop !== 'deferred') finishInboxRow(g.sessionId, g.inboxId, 'done');
  return out;
}

/**
 * 每段先比停机截止（过了就停，这一段与之后的留在 pending，重启后按出站恢复表处理），再比接手代次（变了就把这一组没发的段 cancelled），
 * 再走 sendSegment。卡片发失败补「标题 + 链接」（运行时才补的段）
 */
async function sendGroup(g: OutGroup): Promise<GroupOutcome> {
  const committed = await commitOutbound(g.intents);
  for (const i of g.intents) if (!g.commit.has(i.msgid)) g.commit.set(i.msgid, committed);
  const queue = [...g.intents];
  let ok = true;
  for (let n = 0; n < queue.length; n++) {
    const intent = queue[n]!;
    // 3 停机截止：这一段与之后的段都不发、留在 pending（不取消）
    if (sendsClosed(g.rt)) return { ok: false, stop: 'deferred' };
    // 3 接手代次：这一组没发的段 cancelled
    if (!stillCurrent(g)) {
      dropRest(g, queue.slice(n));
      return { ok: false, stop: 'taken_over' };
    }
    const r = await sendSegment(g, intent, queue.slice(n + 1));
    if (r === 'taken_over' || r === 'deferred') return { ok: false, stop: r };
    if (r === 'accepted') continue;
    const card = intent.payload.msgtype === 'link' ? g.cards.get(intent.msgid) : undefined;
    if (r === 'failed' && card) {
      // 卡片发失败：正文已按「见下方卡片」发出，收不回来了。把链接补发在正文下方（02 的做法）：运行时才补的段，段号接在这一组之后，
      // 单独一个短事务写成 pending 之后照样走第 4–5 步；补的这几段送出了，这一组就算送出。补文的 msgid 由卡片段定死：启动恢复再补
      // 同一张卡片时还是那几行（已经有的、已有结果的都认得出，不会换个 msgid 再发一遍）
      for (const [k, chunk] of splitForWecom(`${card.title}\n${card.url}`).entries()) {
        try {
          const extra = await planRuntimeSegment(queue, { msgtype: 'text', text: { content: chunk } }, fallbackMsgid(intent.msgid, k));
          // null：这一块补文已经有结果（启动恢复之前就发过）；队列里已经有这一行（同一组里排着）的不再排一遍
          if (!extra || queue.some((q) => q.msgid === extra.intent.msgid)) continue;
          g.commit.set(extra.intent.msgid, extra.commit);
          queue.push(extra.intent);
        } catch (e) {
          planFailed(g.rt, g.sessionId, e);
          ok = false;
        }
      }
      continue;
    }
    ok = false;
  }
  return { ok, stop: null };
}

/**
 * 启动恢复补发的一组（同一会话、同一类，按段号）：库里已有的行（pending 已提交），卡片段的标题与地址从 payload 取（卡片发失败照样补
 * 「标题 + 链接」，补文复用这一组已有的那几行）。接手代次取此刻的（恢复判定的那一刻，调用方判定之后同一段同步代码里建组）；通知与
 * 人工回复不比接手。alreadySending（RESEND_UNKNOWN 为真时的 sending 段）只是不再 markSending：AI 产生的照样比接手，等待期间被接手
 * 记 unknown、不补发。stillEligible：恢复补发的人工回复每次发请求之前的资格复核
 */
function groupOfIntents(
  rt: WecomRuntime,
  cfg: WecomConfig,
  intents: readonly OutboundIntent[],
  o: { inboxId: string | null; alreadySending?: boolean; stillEligible?: () => boolean },
): OutGroup {
  const first = intents[0]!;
  const sessionId = first.sessionId;
  const cards = new Map<string, { title: string; url: string }>();
  for (const i of intents) if (i.payload.msgtype === 'link') cards.set(i.msgid, { title: i.payload.link.title, url: i.payload.link.url });
  return {
    rt,
    cfg,
    uid: sessionId.slice(rt.prefix.length),
    sessionId,
    intents: [...intents],
    gen: takeoverGen(sessionId),
    checksTakeover: first.kind !== 'notice' && first.kind !== 'human',
    cards,
    commit: new Map(intents.map((i) => [i.msgid, 'committed' as const])),
    inboxId: o.inboxId,
    ...(o.alreadySending ? { alreadySending: new Set(intents.map((i) => i.msgid)) } : {}),
    ...(o.stillEligible ? { stillEligible: o.stillEligible } : {}),
  };
}

/** 先落库的几类（prepare 排的）与 push 自己排的：句柄 → 那一组（null：没排进去，push 直接返回 false） */
const preparedGroups = new WeakMap<PreparedPush, OutGroup | null>();

/**
 * 切一组的分段：同意菜单是一张 msgmenu；其余照 02 sendRich（withCard：缩略图拿不拿得到）。body 已经过 formatForWecom
 */
function payloadsOf(
  cfg: WecomConfig,
  body: string,
  opts: PushOpts | undefined,
  withCard: boolean,
): { payloads: OutboundPayload[]; card: { title: string; url: string } | null } {
  if (opts?.kind === 'menu' && opts.category) return { payloads: [menuPayload(body, opts.category)], card: null };
  return payloadsFor(cfg, body, opts?.kind ?? 'notice', withCard);
}

/**
 * prepare（同步，写会话的同一段同步代码里）：分段的 pending 排进这个会话的同一次落库。卡片要不要只能看缩略图在不在冷却期
 * （取缩略图要等网络）：不在冷却期就按卡片切，发送时缩略图还是拿不到再补「标题 + 链接」
 */
function prepareDb(rt: WecomRuntime, cfg: WecomConfig, sessionId: string, text: string, opts: PushOpts): PreparedPush {
  const handle: PreparedPush = { sessionId, kind: opts.kind };
  const { payloads, card } = payloadsOf(cfg, formatForWecom(cfg, text), opts, Date.now() >= rt.thumbFailUntil);
  try {
    preparedGroups.set(handle, planGroup(rt, cfg, sessionId, opts.kind, opts.message ?? null, payloads, card, takeoverGen(sessionId)));
  } catch (e) {
    planFailed(rt, sessionId, e);
    preparedGroups.set(handle, null);
  }
  return handle;
}

/** push（库里的企微账号）：给了 prepare 的句柄就发那一组；否则先取缩略图、切分、排 pending（第 2 步），再发 */
async function pushDb(rt: WecomRuntime, cfg: WecomConfig, sessionId: string, text: string, opts: PushOpts | undefined): Promise<boolean> {
  const kind = opts?.kind ?? 'notice';
  const body = formatForWecom(cfg, text);
  const wantsCard = kind !== 'menu' && !!cfg.publicBaseUrl && extractCard(body, cfg.publicBaseUrl) !== null;
  const thumb = wantsCard ? await uploadThumb(rt, cfg).catch(() => null) : null;
  const { payloads, card } = payloadsOf(cfg, body, opts, thumb !== null);
  let g: OutGroup;
  try {
    g = planGroup(rt, cfg, sessionId, kind, opts?.message ?? null, payloads, card, takeoverGen(sessionId));
  } catch (e) {
    planFailed(rt, sessionId, e);
    return false;
  }
  const out = await runGroup(g);
  if (out.stop === 'deferred') console.error(`${rt.tag} 停机中、发送已截止，这次推送留在 pending（重启后按出站恢复处理）`);
  return out.ok && out.stop === null;
}

/**
 * 发一组文本（适配器自己发的：引导提示、异常兜底、欢迎语），返回结果。inboxId（引导提示回的那条非文本入站）：排进去的组由 runGroup
 * 记 done；没过校验、什么都没排的这里记 done（这条入站处理完了，只是提示没发出去）
 */
async function sendTextDb(
  rt: WecomRuntime,
  cfg: WecomConfig,
  sessionId: string,
  text: string,
  kind: OutboundKind,
  message: ChatMessage | null,
  gen = takeoverGen(sessionId),
  inboxId: string | null = null,
): Promise<GroupOutcome> {
  let g: OutGroup;
  try {
    g = planGroup(rt, cfg, sessionId, kind, message, textPayloads(text), null, gen, inboxId);
  } catch (e) {
    planFailed(rt, sessionId, e);
    if (inboxId !== null) finishInboxRow(sessionId, inboxId, 'done');
    return { ok: false, stop: null };
  }
  return runGroup(g);
}

/**
 * 客户进入会话、尚未发消息时（send_msg 的 48h 窗口未开），用事件的 welcome_code
 * 经 send_msg_on_event 发欢迎语。code 20 秒内单次有效，须尽快调用。
 */
async function sendWelcomeOnEvent(rt: WecomRuntime, cfg: WecomConfig, code: string): Promise<void> {
  const data = await callApi<{ errcode?: number; errmsg?: string }>(rt, cfg, 'kf/send_msg_on_event', {
    code,
    msgtype: 'text',
    text: { content: withPrivacyLink(rt.welcomeText) },
  });
  if (data.errcode) {
    console.error(`${rt.tag} send_msg_on_event 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
  }
}

/** 拉客户微信昵称/头像存进画像（后台展示真实昵称用）；失败静默，不阻塞主流程 */
async function enrichCustomerProfile(rt: WecomRuntime, cfg: WecomConfig, externalUserId: string): Promise<void> {
  // 只在会话已存在时补昵称——绝不为「仅进入未发言」的客户凭空建会话，
  // 否则空「访客」会话会灌进后台列表并稀释转化率分母。首条消息建好会话后再补。
  const session = getSession(rt.prefix + externalUserId);
  if (!session || session.profile.nickname) return;
  try {
    const data = await callApi<{
      errcode?: number;
      errmsg?: string;
      customer_list?: { external_userid: string; nickname?: string; avatar?: string }[];
    }>(rt, cfg, 'kf/customer/batchget', {
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

/** sync_msg 里 origin=4 的 msg_send_fail：我们发出去的某条没送达（fail_msgid 是随 send_msg 下发的 msgid） */
function isSendFail(msg: KfMessage): boolean {
  return msg.origin === 4 && msg.msgtype === 'event' && msg.event?.event_type === 'msg_send_fail';
}

/**
 * 客户点了同意菜单（02 第 16 步，R23）：企微发来的是一条普通文本消息，按钮 id 在 text.menu_id（官方文档「接收消息」，
 * 没有单独的 msgmenu_click 事件——此前按事件类型判是按文档标题猜的，没有真实测试号核对，这次照原文改正）
 */
function isMenuClick(msg: KfMessage): boolean {
  return msg.msgtype === 'text' && msg.text?.menu_id != null;
}

/**
 * 客户点了同意菜单：按 text.menu_id 解析出类别与决定，记一条同意记录（已经有结论的类别忽略，防止旧菜单被重复点）。
 * 「不同意」转人工且发一句确认（kind='notice'，不占 AI 回复的身份）；「同意」不转人工、不用额外回一句。
 * 这条点击消息本身不是客户话语，不进会话记录、不进引擎——menu_id 已经是结构化的决定，没有要模型理解的内容；
 * 只有「不同意」时才追加一条 agent 消息（下面的确认回复），客户这次点击在会话里的留痕就是那条确认回复本身（最小做法）。
 * 没有会话（客户只点过菜单、从没发过消息，几乎不会发生）时什么都不做。env 账号（02）用；库里的账号见 processMenuRow
 */
async function handleMenuClick(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage): Promise<void> {
  const notice = currentPrivacyNotice();
  if (!notice) return;
  const parsed = parseConsentMenuId(msg.text?.menu_id);
  if (!parsed) return;
  const uid = msg.external_userid;
  const s = uid ? getSession(rt.prefix + uid) : undefined;
  if (!s) return;
  const evidence = msg.text?.content || msg.text?.menu_id || '';
  const applied = applyConsentDecision(s, parsed.category, parsed.decision, evidence, notice.version);
  if (!applied) return;
  saveSession(s);
  if (parsed.decision !== 'declined') return;
  const ok = await sendText(rt, cfg, uid!, CONSENT_DECLINED_REPLY, { kind: 'notice', message: null });
  if (ok) {
    s.messages.push({ role: 'agent', content: CONSENT_DECLINED_REPLY, at: Date.now() });
    saveSession(s);
  } else {
    console.warn(`${rt.tag} 不同意的确认没送达（会话 ${convLabel(s.id)}）`);
  }
}

/** 客户进入会话事件：发欢迎语（本账号 API 托管，微信自带欢迎语不生效）。调用方已去重 */
async function handleEnterSession(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage): Promise<void> {
  if (!msg.event) return;
  const uid = msg.event.external_userid || msg.external_userid;
  // 已转人工：两条路径都不发。欢迎语邀请客户跟 AI 聊，而 AI 此时不会再回复，客户照做了只会没人应
  if (uid && getSession(rt.prefix + uid)?.handedOver) {
    console.log(`${rt.tag} enter_session：会话已转人工，不发欢迎语（由顾问接待）`);
    return;
  }
  const code = msg.event.welcome_code;
  if (code) {
    await sendWelcomeOnEvent(rt, cfg, code);
    console.log(`${rt.tag} 已发欢迎语（enter_session, welcome_code）`);
  } else {
    // 企微只给「新客户 / 超 48h 未聊」下发 welcome_code；老客户再次扫码进入没有 code，
    // 会话窗口是开着的，直接 send_msg 补发一条轻量欢迎，让"扫码即有回应"始终成立
    if (uid) {
      const last = rt.welcomeBackAt.get(uid) ?? 0;
      if (Date.now() - last > WELCOME_DEDUPE_MS) {
        rt.welcomeBackAt.set(uid, Date.now());
        const sess = getSession(rt.prefix + uid);
        const text = withPrivacyLink(sess?.messages?.length ? rt.welcomeBackText : rt.welcomeText);
        // 账本里记 welcome、message_seq 为空（spec）；还没有会话时这一行单独一个短事务（db 存储）
        const ok = isDbAccount(rt)
          ? (await sendTextDb(rt, cfg, rt.prefix + uid, text, 'welcome', null)).ok
          : await sendText(rt, cfg, uid, text, { kind: 'welcome', message: null });
        console.log(`${rt.tag} enter_session 无 welcome_code，已补发欢迎（send_msg，${ok ? '成功' : '失败'}）`);
        // 记进会话：否则后台看不到 AI 对客户说过的开场白，顾问介入时不知道客户收到过什么。
        // 只写已存在的会话，不新建——避免只扫码没说话的人也计进「会话数」KPI
        if (ok && sess) {
          sess.messages.push({ role: 'agent', content: text, at: Date.now() });
          saveSession(sess);
        }
      } else {
        console.log(`${rt.tag} enter_session 无 welcome_code，${WELCOME_DEDUPE_MS / 1000}s 内已发过欢迎，跳过`);
      }
    }
  }
  // 昵称回填留到客户首条消息（会话建好后）再做，此处不为未发言客户建空会话
}

/**
 * 去重与重放对齐的结果（02 spec「企微：发送账本、回执与去重」五种情况，R7）：
 *   fresh 照常处理（情况 1）；recorded 这句已记下、回复还没生成，以 alreadyRecorded 重跑、引擎不再记一遍（情况 3）；
 *   resend 回复已生成、账本里那条回复没有 accepted 或 unknown 的行，原样重发、不再跑模型（情况 4）；skip 跳过（情况 2、5）
 */
type Dedupe = { kind: 'fresh' } | { kind: 'recorded' } | { kind: 'resend'; message: ChatMessage } | { kind: 'skip'; why: string };

/**
 * 处理一条客户文本消息之前（handled 集合之外），按 msgid 看这句有没有处理过。新拉到的消息与启动时的在途重放同一套规则：
 *   1. 会话里没有这条 msgid，7 天集合里也没有 → 照常处理；
 *   2. 只在 7 天集合里（已被重置或裁剪出窗口）→ 跳过；
 *   3. 窗口里有这条，后面没有 AI 回复，会话也没转人工 → 以 alreadyRecorded 重跑（不再记一遍，消息只追加，R5）；
 *   4. 窗口里有这条，后面有 AI 回复，而账本里那条回复没有 accepted 或 unknown 的行 → 原样重发那条回复，不再跑一轮模型；
 *   5. 其余（回复已送出或可能已送出，或会话已转人工）→ 跳过。
 * 这句之后客户又说过话的，这一轮早就处理完了（同一客户串行），也跳过（属于情况 5）。
 * 欢迎语不排队（handleEnterSession 直接写进会话），可能正好插在这一轮中间。它不是任何一句话的回复：不算 AI 回复。
 * 02 之前记下的消息没有 msgid（锁定的 W1）：重放时照旧按原文对齐最后一条（同一个 inboundText，否则长消息永远对不上）
 */
function dedupeFor(rt: WecomRuntime, sessionId: string, msg: KfMessage, replay: boolean): Dedupe {
  const s = getSession(sessionId);
  if (!s) return { kind: 'fresh' };
  const talk = s.messages.filter((m) => m.role !== 'system' && !(m.role === 'agent' && isWelcomeText(rt, m.content)));
  const isAiReply = (m: ChatMessage | undefined): m is ChatMessage => m?.role === 'agent' && (m.author === undefined || m.author === 'ai');
  // 情况 4 的补发不看转人工（安全网那一轮的回复照样补发），但顾问已经接手的不补：接手代次只在进程内，上一个进程里适配器因为接手
  // 没发的那条，重启之后会被当成「没送出」再发一遍（02 第 13 步，不变量 28）
  const sentOrSkip = (reply: ChatMessage): Dedupe =>
    replyDelivered(sessionId, reply)
      ? { kind: 'skip', why: '回复已送出' }
      : s.handedOver && s.assignee
        ? { kind: 'skip', why: '顾问已接手' }
        : { kind: 'resend', message: reply };
  const at = talk.findIndex((m) => m.role === 'customer' && m.msgid === msg.msgid);
  if (at < 0) {
    if (recentMsgids(sessionId).has(msg.msgid)) return { kind: 'skip', why: '已不在会话窗口里' };
    if (!replay) return { kind: 'fresh' };
    const said = inboundText(msg.text?.content ?? '');
    const legacy = (m: ChatMessage | undefined): boolean => m?.role === 'customer' && m.msgid === undefined && m.content === said;
    const last = talk.at(-1);
    if (legacy(last)) return { kind: 'recorded' };
    if (isAiReply(last) && legacy(talk.at(-2))) return sentOrSkip(last);
    return { kind: 'fresh' };
  }
  const after = talk.slice(at + 1);
  if (after.some((m) => m.role === 'customer')) return { kind: 'skip', why: '之后客户又说过话' };
  const reply = after.find(isAiReply);
  if (!reply) return s.handedOver ? { kind: 'skip', why: '会话已转人工' } : { kind: 'recorded' };
  return sentOrSkip(reply);
}

// 小红书来的客户第一条常是笔记截图、行程截图或语音。一句「只能处理文字」是把
// 首响这个唯一能碾压人工的环节浪费掉——收不到内容也要接住话头、把人拉回文字。
const NON_TEXT_HINT: Record<string, string> = {
  image: '图我收到了～不过我这边暂时看不了图片内容，您用文字说一下想去哪、几位出行，我马上给您找线路。',
  voice: '语音我这边暂时听不了，您打几个字给我就行～想去哪儿、几位出行、大概什么时候走？',
  video: '视频收到啦～您用文字说说想要什么样的行程，我这就帮您安排。',
  file: '文件我这边暂时打不开，方便的话把关键需求打字发我：目的地、几位、大概日期。',
  link: '链接收到～您想找类似的行程吗？跟我说下目的地和人数，我帮您对一条。',
  location: '位置收到～您是想从这边出发，还是想去这附近玩？跟我说下大概日期和人数。',
};
const NON_TEXT_HINT_OTHER = '这条消息我这边暂时处理不了，您用文字说说想去哪儿、几位出行，我马上帮您安排～';
const NON_TEXT_PLACEHOLDER: Record<string, string> = {
  image: '[图片]',
  voice: '[语音]',
  video: '[视频]',
  file: '[文件]',
  link: '[链接]',
  location: '[位置]',
};
/** 非文本消息记进会话的占位 */
const placeholderOf = (msgtype: string): string => NON_TEXT_PLACEHOLDER[msgtype] ?? `[其他消息：${msgtype}]`;
/** 处理消息抛错时的兜底回复（AI 回复的身份、不挂入站：spec 出站恢复表里「没有 inbox_id 的 ai（异常道歉）」） */
const SORRY_TEXT = '抱歉，系统开小差了，请稍后再发一次，或直接联系人工顾问。';

/**
 * env 账号（02 的老路）处理一条客户消息（调用方已去重）。replay=true 表示上个进程没处理完、启动时按原文重放。
 * 返回 'deferred'：停机的 normal 段已截止、回复没开始发，这条留在在途表里，重启后重放（情况 4 原样补发、情况 3 重跑）。
 * 库里的账号不走这里：入站行的处理见下文「03 入站」一节的 processInboxRow
 */
function handleCustomerMessage(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage, replay = false): Promise<'deferred' | void> {
  // 这条消息的日志（含引擎这一轮结束之后的几行）都带 conv（R24）
  return withConversationLog(rt.prefix + msg.external_userid, () => handleCustomerMessageInner(rt, cfg, msg, replay));
}
async function handleCustomerMessageInner(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage, replay: boolean): Promise<'deferred' | void> {
  const sessionId = rt.prefix + msg.external_userid;
  if (msg.msgtype !== 'text' || !msg.text?.content) {
    // 这一条不经引擎，同样是一轮（02 R16「每处理一条客户消息收集一条轮次记录」）：口径同引擎的确定性路径，
    // 回了固定提示记 deterministic、已转人工不回话记 silent；重放时提示已经发过、什么都不做的不算一轮（同重发已生成的回复）。
    // 只记轮次、关联提示消息的 turnId，客户收到的与会话里记下的都不变
    return withTurnScope(async () => {
      // 客户发了内容就算开口了：一律记一条占位（没有会话就建一个），后台和接管的顾问才看得到客户发过图片。
      // 记没记过按 msgid 判断，不比文本：连着发的两张图片，占位一模一样。新拉到的与重放同一套（02 第 12 步）：
      // 已被重置或裁剪出窗口、只在 7 天集合里的，什么都不做（去重情况 2）
      const session = accountSession(rt, sessionId);
      const seen = session.messages.findIndex((m) => m.msgid === msg.msgid);
      if (seen < 0 && recentMsgids(sessionId).has(msg.msgid)) return;
      startTurn(sessionId);
      const stageBefore = session.stage;
      if (seen < 0) {
        const content = placeholderOf(msg.msgtype);
        session.messages.push({ role: 'customer', content, at: Date.now(), msgid: msg.msgid, sentAt: msg.send_time * 1000 });
        // 与引擎同一道封顶：这条路不经引擎，转人工后只发图片的客户也不能让会话无限膨胀
        if (session.messages.length > 400) session.messages.splice(0, session.messages.length - 300);
        saveSession(session);
      }
      if (session.handedOver) {
        console.log(`${rt.tag} 静默（${msg.msgtype} 消息，转人工后不自动回复）`);
        endTurn('silent', '', stageBefore, session.stage);
        return; // 与文本消息一致：只入库，交给真人
      }
      const hint = NON_TEXT_HINT[msg.msgtype] ?? NON_TEXT_HINT_OTHER;
      // 提示发成功才记进会话（同老客户欢迎语），所以重放时占位之后已经有这条提示，就是客户收到过了，不再发
      if (seen >= 0 && session.messages.slice(seen + 1).some((m) => m.role === 'agent' && m.content === hint)) return;
      // 消息对象先建好交给账本（发成功才写进会话，写进去的是同一个对象，账本行据它取 seq）
      const sent: ChatMessage = { role: 'agent', content: hint, at: Date.now() };
      // 停机的 normal 段已截止：不开始发，留给重启时重放（占位已记下，那时补发提示；这一轮也那时再记）
      if (sendsClosed(rt)) {
        console.log(`${rt.tag} 停机中、发送已截止，引导提示留到重启后补发`);
        return 'deferred';
      }
      const delivered = await sendText(rt, cfg, msg.external_userid, hint, { kind: 'ai', message: sent });
      if (delivered) {
        const s = getSession(sessionId);
        if (s) {
          sent.at = Date.now();
          s.messages.push(sent);
          saveSession(s);
          // 与写进提示、saveSession 同一段同步代码：排出的那次落库里提示已关联上这一轮
          endTurn('deterministic', hint, stageBefore, s.stage, sent);
          return;
        }
      }
      // 没发出去（或会话已不在）：照样是回固定提示的一轮，只是没有记进会话的那条消息可关联
      endTurn('deterministic', hint, stageBefore, getSession(sessionId)?.stage ?? session.stage);
    });
  }
  const t0 = Date.now();
  console.log(`${rt.tag} ${replay ? '重放' : '收到'}客户消息: "${logQuote(msg.text.content)}"`);
  // 不发「稍等」占位：几秒延迟本就像真人顾问在查资料，逐条占位反而更显机械。
  // 接手代次在这一轮开始时记下，调 sendRich 之前再比一次（不变量 28 的适配器部分）；留到 catch 里的兜底道歉也用它：
  // 模型等待期间顾问接手、随后模型报错时，兜底不能拿接手之后的新代次去比（那样比较全过，「系统开小差」照发给客户）
  const gen = takeoverGen(sessionId);
  try {
    const dedupe = dedupeFor(rt, sessionId, msg, replay);
    if (dedupe.kind === 'skip') {
      console.log(`${rt.tag} 跳过已处理过的客户消息（${dedupe.why}）`);
      return;
    }
    if (dedupe.kind === 'resend') console.log(`${rt.tag} 这句的回复已生成、没有送出，原样重发（不再跑模型）`);
    let reply: { text: string; stage: string; silent?: boolean; message: ChatMessage | null };
    if (dedupe.kind === 'resend') {
      reply = { text: dedupe.message.content, stage: getSession(sessionId)?.stage ?? 'discovery', message: dedupe.message };
    } else {
      // 非默认账号：会话先带着 channelAccountId 建好，引擎拿到的就是它（默认账号与 env 账号照 02 由引擎建）
      if (rt.sessionAccountId) accountSession(rt, sessionId);
      const r = await handleMessage(sessionId, msg.text.content, 'wecom', {
        msgid: msg.msgid,
        sentAt: msg.send_time * 1000,
        ...(dedupe.kind === 'recorded' ? { alreadyRecorded: true } : {}),
      });
      reply = { text: r.text, stage: r.stage, silent: r.silent, message: replyMessageOf(r) ?? null };
    }
    void enrichCustomerProfile(rt, cfg, msg.external_userid); // 会话已建，异步补昵称回填后台展示
    if (reply.silent || !reply.text.trim()) {
      console.log(`${rt.tag} 静默（阶段=${reply.stage}，转人工后不自动回复）`);
      return; // 转人工后 AI 沉默，交给真人
    }
    if (sendsClosed(rt)) {
      // 停机的 normal 段已截止（回复在 drain、late 段才生成好）：这时开始发，账本行已无处可写，退出时还没回包的话重启后会再发一遍。
      // 不发，留在在途表里：回复已写进会话，重启后按情况 4 原样补发一次
      console.log(`${rt.tag} 停机中、发送已截止，回复留到重启后补发`);
      return 'deferred';
    }
    if (takeoverGen(sessionId) !== gen) {
      console.log(`${rt.tag} 生成期间顾问接手，本轮 AI 回复不发`);
      const s = getSession(sessionId);
      if (s) {
        s.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
        saveSession(s, false);
      }
      return;
    }
    // 走 sendRich 而不是 sendText：方案书/支付链接要发成原生卡片，客户转发出去才是一张卡。
    // stillCurrent 覆盖 sendRich 内部的 await（uploadThumb、send_msg 的退避重试）：这些是真实的网络等待，
    // HTTP 发起的接手插得进来，不能只在调 sendRich 之前比一次代次（审查第 7 条，concurrency[3]）
    const sent = await sendRich(rt, cfg, msg.external_userid, formatForWecom(cfg, reply.text), {
      kind: 'ai',
      message: reply.message,
      stillCurrent: () => takeoverGen(sessionId) === gen,
    });
    if (!sent) {
      const s = getSession(sessionId);
      if (takeoverGen(sessionId) !== gen) {
        // 没发完全是因为中途被接手，不是发送失败：记「本轮未发送」而不是通用的发送失败说明
        console.log(`${rt.tag} 发送期间顾问接手，本轮 AI 回复剩下的部分不发`);
        if (s) {
          s.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
          saveSession(s, false);
        }
        return;
      }
      // 发送失败不能静默：会话里已经存了这条 agent 回复，后台看着像"已跟进"，
      // 实际客户什么都没收到（48h 会话窗口关闭、企微限流等），顾问会以为已经聊过了
      console.error(`${rt.tag} ⚠️ 回复未送达客户（阶段=${reply.stage}）:`, convLabel(sessionId));
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
    console.log(`${rt.tag} 已回复（阶段=${reply.stage}，耗时 ${Date.now() - t0}ms）`);
  } catch (err) {
    console.error(`${rt.tag} 处理消息失败:`, err);
    await sendText(rt, cfg, msg.external_userid, SORRY_TEXT, { kind: 'ai', message: null });
  }
}

/**
 * 库里的企微账号发一条 AI 回复（03 spec「出站 · 发一条 AI 回复」第 2–6 步）：先确定要不要卡片（要的话先取缩略图：传不上去就按 02 的
 * 规则整段原文发，所以切分在取缩略图之后），切分段，planOutbound，commitOutbound，再逐段比截止与接手、markSending、发。
 * 生成期间被接手、停机截止之后才回包的，也先把分段排进库：前者记 cancelled（工作台「未发送」）、后者留在 pending（重启后补发）。
 * inboxId：这条回复回的入站行。replied 与分段的 pending 同一次落库（planOutbound），全部分段有了结果记 done（runGroup）；
 * 没过校验、什么都没排的这里记 done
 */
async function replyDb(
  rt: WecomRuntime,
  cfg: WecomConfig,
  sessionId: string,
  reply: { text: string; stage: string; message: ChatMessage | null },
  gen: number,
  t0: number,
  inboxId: string,
): Promise<'deferred' | void> {
  const body = formatForWecom(cfg, reply.text);
  const wantsCard = !!cfg.publicBaseUrl && extractCard(body, cfg.publicBaseUrl) !== null;
  const thumb = wantsCard ? await uploadThumb(rt, cfg).catch(() => null) : null;
  const { payloads, card } = payloadsFor(cfg, body, 'ai', thumb !== null);
  let g: OutGroup;
  try {
    g = planGroup(rt, cfg, sessionId, 'ai', reply.message, payloads, card, gen, inboxId);
  } catch (e) {
    planFailed(rt, sessionId, e);
    finishInboxRow(sessionId, inboxId, 'done');
    return;
  }
  return afterAiGroup(rt, sessionId, await runGroup(g), reply.stage, t0);
}

/**
 * 一组 AI 回复发完（或停下）之后（replyDb 与启动恢复补发 replied 的分段共用）：停机截止留在 pending（重启后按同一 msgid 补发）；
 * 被接手记「本轮未发送」（没发的分段已记 cancelled）；没送达记一条说明
 */
function afterAiGroup(rt: WecomRuntime, sessionId: string, out: GroupOutcome, stage: string, t0: number): 'deferred' | void {
  if (out.stop === 'deferred') {
    console.log(`${rt.tag} 停机中、发送已截止，回复的分段留在 pending（重启后按同一 msgid 补发）`);
    return 'deferred';
  }
  const s = getSession(sessionId);
  if (out.stop === 'taken_over') {
    // 没发完是因为被接手，不是发送失败：记「本轮未发送」（没发的分段已记 cancelled）
    console.log(`${rt.tag} 顾问已接手，本轮 AI 回复没发的分段不发`);
    if (s) {
      s.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
      saveSession(s, false);
    }
    return;
  }
  if (!out.ok) {
    console.error(`${rt.tag} ⚠️ 回复未送达客户（阶段=${stage}）:`, convLabel(sessionId));
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
  console.log(`${rt.tag} 已回复（阶段=${stage}，耗时 ${Date.now() - t0}ms）`);
}

// ---------------- 03 入站（库里的企微账号） ----------------
// docs/architecture/03-channels-v2/spec.md「入站：channel_inbox」、R2、R3、R7 的恢复截止、R21，不变量 1、2、3、8、11、12。
// 一页 → acceptPage（插入与推进 cursor 同一个事务）→ 提交之后，新插入的行按会话排进处理链（同一会话串行、按 ord，跨会话并发）。
// 出队时依次判：attempts 已到 3 → abandoned（poison）；sent_at 早于 48 小时 → abandoned（too_old）；sent_at 不晚于账号的恢复截止点
// → 只补记（message、menu_click）；其余先 beginAttempt（加 1 并提交），再按种类处理：
//   message      文本：handleMessage 带 inboxId，引擎在写进客户消息的那一段同步代码里排 recorded；静默 → done；有回复 → planOutbound
//                带 inboxId（replied 与 pending 同一次落库），全部分段有了结果 → done（runGroup）。非文本：适配器写占位，占位与 recorded
//                同一次落库，引导提示同样带 inboxId 走 planOutbound
//   menu_click   applyConsentDecision 改了会话，同一次落库记 done；已有结论的照 02 忽略，同样记 done
//   enter_session acceptPage 里直接记 done（只为去重），欢迎语照 02 不排队
// 发送失败回执（send_fail）照 02 不排进处理链、马上处理：出站行迁 failed 与入站行 done 同一个短事务（onSendFailInbox），会话里的说明
// 照 02 经会话落库（排在正在退避重试的那一句后面的话，那一段看不到自己已是 failed，第 8 步审查的 maySendAgain 就落空了）
// 没有会话可挂的状态变化走 writeInboxStateNow（短事务）。启动时没结束的行由启动恢复（runRecovery，第 10 步）按 ord 派发进同一条
// 处理链：出队时同样计次、判过期与截止，再按入站恢复表处理 recorded、replied 与保底（processOpenMessageRow）

/** 出队时 attempts 已到这个数就记 poison：处理过三次都没走完（即第三次重启时停下，与 02 的「重放两次」同一口径） */
const MAX_INBOX_ATTEMPTS = 3;
/** beginAttempt 写不进库时这一行在处理链里等着重试（不跳过：同一会话排在它后面的不能先处理，不变量 12）；停机时放下，留给下次启动 */
const ATTEMPT_RETRY_MS = [1_000, 5_000, 30_000, 120_000];
/** 恢复截止点之前的消息只补记（R7），会话里加这一句（spec 原话；同一会话一次恢复只加一条） */
const RESTORE_CUTOFF_NOTE = '恢复备份之后补记的客户消息，AI 没有回复：备份之后的处理记录已丢失，请人工确认是否已回复';

/** 库里账号的运行时的入站状态 */
function inboxOf(rt: WecomRuntime): AccountInbox {
  if (rt.state.kind !== 'channel_inbox') throw new Error(`${rt.tag} 不是库里的账号，没有 channel_inbox`);
  return rt.state;
}

/**
 * 一行入站记 done / abandoned：会话在内存里就随它的下一次落库（主事务，与调用方同一段同步代码里排的会话改动同一次提交）；
 * 没有会话可挂的单独一个短事务（写不进去只记一行，入站行停在之前的状态、重启时由启动恢复处理）
 */
function finishInboxRow(
  sessionId: string | null,
  inboxId: string,
  state: 'done' | 'abandoned',
  reason?: InboxAbandonReason,
): Promise<void> {
  if (sessionId && getSession(sessionId)) {
    queueInboxState(sessionId, { inboxId, state, ...(reason ? { reason } : {}) });
    return Promise.resolve();
  }
  return writeInboxStateNow({ inboxId, state, ...(reason ? { reason } : {}) }).then((ok) => {
    if (!ok) console.error(`[wecom] 入站行没记成 ${state}（库写不进去），重启时由启动恢复处理`);
  });
}

/**
 * 派发一批入站行（acceptPage 新插入的，按 ord；第 10 步的启动恢复也从这里派发没结束的行）：进入会话事件（done）照 02 直接发欢迎语、
 * 不排队；已结束的（冷启动的 abandoned）不派发；发送失败回执照 02 不排队、马上处理（排在这个会话正在处理的那一句后面的话，退避中的
 * 那一段看不到自己已是 failed，会再发一次请求，不变量 5）；其余按会话排进处理链。page：这一页的原样消息（欢迎语要事件里的
 * welcome_code，进入会话事件的入站行不存原文）
 */
function dispatchInboxRows(
  rt: WecomRuntime,
  cfg: WecomConfig,
  rows: readonly InboxRow[],
  page?: ReadonlyMap<string, KfMessage>,
  rec: InboundRecoveryCtx | null = null,
): void {
  for (const row of rows.toSorted((a, b) => a.ord - b.ord)) {
    if (row.kind === 'enter_session') {
      const msg = page?.get(row.msgid);
      if (row.state === 'done' && msg) dispatchWelcome(rt, cfg, msg);
      continue;
    }
    if (row.state === 'done' || row.state === 'abandoned') continue;
    if (row.kind === 'send_fail' && row.state === 'received') {
      const t = processReceiptRow(row).catch((err) => console.error(`${rt.tag} 回执处理异常:`, err));
      rt.eventTasks.add(t);
      void t.finally(() => rt.eventTasks.delete(t));
      continue;
    }
    enqueueForUser(rt, chainKeyOf(row), () => processInboxRow(rt, cfg, row, rec));
  }
}

/** 处理链的键：同一会话的入站行排在同一条链上 */
const chainKeyOf = (row: InboxRow): string => row.conversationId ?? row.msgid;

/**
 * 处理链轮到一行：出队判定、计次，再按种类与状态处理。rec 不为空的是启动恢复派发的没结束的行（spec 入站恢复表，含 recorded、replied
 * 与保底）；为空的是这个进程新收的（received）。replied 的行（只补发分段、不调模型）同样计次，一组分段反复把进程带崩也会停下来
 */
async function processInboxRow(rt: WecomRuntime, cfg: WecomConfig, row: InboxRow, rec: InboundRecoveryCtx | null = null): Promise<void> {
  const inbox = inboxOf(rt);
  // 停机时这个会话排在前面的那一行放下了：它后面的也都不出队，按 ord 整段留给重启恢复
  if (rt.haltedChains.has(chainKeyOf(row))) return;
  if (row.attempts >= MAX_INBOX_ATTEMPTS) return abandonInboxRow(rt, row, 'poison');
  if (row.sentAt !== null && row.sentAt < Date.now() - REPLAY_MAX_AGE_MS) return abandonInboxRow(rt, row, 'too_old');
  const cutoff = inbox.recordOnlyUntil;
  if (cutoff !== null && row.sentAt !== null && row.sentAt <= cutoff && (row.kind === 'message' || row.kind === 'menu_click')) {
    return recordOnlyInboxRow(rt, row, cutoff);
  }
  const attempts = await beginInboxAttempt(rt, inbox, row);
  if (attempts === null) return;
  const r: InboxRow = { ...row, attempts };
  if (r.kind === 'message') return processOpenMessageRow(rt, cfg, r, rec);
  if (r.kind === 'menu_click') return processMenuRow(rt, cfg, r);
  console.error(`${rt.tag} ⚠️ 不认识的入站种类 ${r.kind}，记 done`);
  return finishInboxRow(r.conversationId, r.id, 'done');
}

/**
 * 一条客户消息按入站恢复表处理（spec「重启、崩溃与恢复」）：先过保底（R21：received 而名下已有出站行的按 replied、会话里已有这句的按
 * recorded；recorded 而会话里找不到这句的先用 payload 补进会话），再按状态——received 照新消息处理；recorded 按「这句之后有没有
 * AI 回复」切分段照常发、done 或以 alreadyRecorded 重跑；replied 按同一 msgid 补发名下 pending 的段（有接手人就取消）
 */
function processOpenMessageRow(rt: WecomRuntime, cfg: WecomConfig, row: InboxRow, rec: InboundRecoveryCtx | null): Promise<void> {
  if (row.state === 'received' && rec === null) return processMessageRow(rt, cfg, row);
  const msg = row.payload as KfMessage | null;
  const sessionId = row.conversationId ?? (msg?.external_userid ? rt.prefix + msg.external_userid : null);
  if (!msg || !sessionId) {
    console.error(`${rt.tag} ⚠️ 一行没结束的入站没有原文或会话（${row.state}），记 done`);
    return finishInboxRow(row.conversationId, row.id, 'done');
  }
  const s = getSession(sessionId);
  const at = s ? s.messages.findIndex((m) => m.role === 'customer' && m.msgid === row.msgid) : -1;
  const eff = effectiveInboxState({
    kind: row.kind,
    state: row.state as 'received' | 'recorded' | 'replied',
    inSession: at >= 0,
    known: recentMsgids(sessionId).has(row.msgid),
    hasOutbound: rec ? rec.withOutbound.has(row.id) : pendingIntentsOfInbox(row.id).length > 0,
  });
  if (eff.state === 'received') return processMessageRow(rt, cfg, row);
  if (eff.state === 'replied') return resumeRepliedRow(rt, cfg, row, sessionId);
  return resumeRecordedRow(rt, cfg, row, msg, sessionId, { restore: eff.restore, upgrade: row.state === 'received' });
}

/**
 * recorded（含保底按 recorded 处理的 received）：restore 时先用 payload 把这句补进会话（会话部分没写进库：R6、poisoned、spill 回放失败）；
 * upgrade（入站行还是 received、会话里已有这句）时随这次落库把入站行记 recorded（之后的 replied 才接得上迁移表）
 */
function resumeRecordedRow(
  rt: WecomRuntime,
  cfg: WecomConfig,
  row: InboxRow,
  msg: KfMessage,
  sessionId: string,
  o: { restore: boolean; upgrade: boolean },
): Promise<void> {
  return withConversationLog(sessionId, async () => {
    const isText = msg.msgtype === 'text' && !!msg.text?.content;
    if (o.restore) {
      const s = accountSession(rt, sessionId);
      const content = isText ? inboundText(msg.text!.content) : placeholderOf(msg.msgtype);
      s.messages.push({ role: 'customer', content, at: Date.now(), msgid: row.msgid, ...(row.sentAt ? { sentAt: row.sentAt } : {}) });
      trimSessionMessages(s);
      saveSession(s);
      console.warn(`${rt.tag} 启动恢复：入站行已是 recorded、会话里却没有这句（会话部分没写进库），用原文补进会话`);
    }
    const s = getSession(sessionId);
    const at = s ? s.messages.findIndex((m) => m.role === 'customer' && m.msgid === row.msgid) : -1;
    if (o.upgrade && s && at >= 0) queueInboxState(sessionId, { inboxId: row.id, state: 'recorded', message: s.messages[at]! });
    const reply = s && at >= 0 ? aiReplyAfter(s.messages, at, (c) => isWelcomeText(rt, c)) : -1;
    const action = recordedRecovery({
      inWindow: at >= 0,
      aiReplyAfter: reply >= 0,
      handedOver: !!s?.handedOver,
      hasAssignee: !!(s?.handedOver && s.assignee),
    });
    if (action.do === 'done') {
      console.log(
        `${rt.tag} 启动恢复：这句${action.why === 'handed_over' ? '已转人工、没有 AI 回复' : '已不在会话窗口里（被重置或裁剪）'}，记 done`,
      );
      return finishInboxRow(sessionId, row.id, 'done');
    }
    if (action.do === 'rerun') {
      console.log(`${rt.tag} 启动恢复：这句已记下、回复还没生成，以 alreadyRecorded 重跑`);
      return isText ? processMessageRow(rt, cfg, row, true) : processNonTextRow(rt, cfg, row, msg, sessionId, true);
    }
    const m = s!.messages[reply]!;
    if (action.do === 'cancel_reply') {
      // 不变量 10：有接手人的会话里不补发 AI 回复的分段。排进去随即取消（与 replied 一行同一口径，工作台这条回复「未发送」）
      console.log(`${rt.tag} 启动恢复：这句的回复已生成、会话已有人接手，AI 回复不发`);
      const { payloads } = payloadsFor(cfg, formatForWecom(cfg, m.content), 'ai', false);
      try {
        cancelIntents(planGroup(rt, cfg, sessionId, 'ai', m, payloads, null, takeoverGen(sessionId), row.id).intents, 'taken_over');
      } catch (e) {
        planFailed(rt, sessionId, e);
      }
      s!.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
      saveSession(s!, false);
      return finishInboxRow(sessionId, row.id, 'done');
    }
    // 这条回复没进过 replied，说明一段都没发过：按它切分段、planOutbound、照常发，不调模型
    console.log(`${rt.tag} 启动恢复：这句的回复已生成、一段都没发过，照常发（不调模型）`);
    await replyDb(rt, cfg, sessionId, { text: m.content, stage: s!.stage, message: m }, takeoverGen(sessionId), Date.now(), row.id);
  });
}

/**
 * replied（含保底按 replied 处理的 received）：会话有接手人 → 名下 pending 的段 cancelled、记「本轮未发送」；否则按同一 msgid、同一内容
 * 发名下 pending 的段，不调模型；都有结果之后 done（停机截止停下的不记，留在 replied）
 */
function resumeRepliedRow(rt: WecomRuntime, cfg: WecomConfig, row: InboxRow, sessionId: string): Promise<void> {
  return withConversationLog(sessionId, async () => {
    const s = getSession(sessionId);
    const pending = pendingIntentsOfInbox(row.id);
    const action = repliedRecovery({ hasAssignee: !!(s?.handedOver && s.assignee), pending: pending.length });
    if (action.do === 'done') {
      console.log(`${rt.tag} 启动恢复：这句的回复已经都有结果，记 done`);
      return finishInboxRow(sessionId, row.id, 'done');
    }
    if (action.do === 'cancel_pending') {
      console.log(`${rt.tag} 启动恢复：会话已有人接手，这句的回复没发的 ${pending.length} 段不发`);
      cancelIntents(pending, 'taken_over');
      if (s) {
        s.messages.push({ role: 'system', content: TAKEN_OVER_NOTE, at: Date.now() });
        saveSession(s, false);
      }
      return finishInboxRow(sessionId, row.id, 'done');
    }
    const bad = pending.filter((i) => payloadProblem(i.payload) !== null);
    if (bad.length) {
      console.error(`${rt.tag} ⚠️ 启动恢复：${bad.length} 段出站的 payload 不合格，不补发、记 cancelled`);
      cancelIntents(bad, 'restore');
    }
    const todo = pending.filter((i) => !bad.includes(i));
    if (!todo.length) return finishInboxRow(sessionId, row.id, 'done');
    console.log(`${rt.tag} 启动恢复：这句的回复有 ${todo.length} 段没发，按同一 msgid 补发（不调模型）`);
    const t0 = Date.now();
    afterAiGroup(rt, sessionId, await runGroup(groupOfIntents(rt, cfg, todo, { inboxId: row.id })), s?.stage ?? '?', t0);
  });
}

/**
 * 出队计次（单独一个短事务，提交之后才处理）。写不进库、提交结果不明就带同一个 row 在处理链里等着重试（计次以出队时的 attempts
 * 为条件，重试不会多加）；行已结束或已不在库里返回 null（后面的照常出队）；停机中放下时返回 null，并把这个会话的链停下
 * （haltedChains：后面的行不出队，整段留给重启恢复）
 */
async function beginInboxAttempt(rt: WecomRuntime, inbox: AccountInbox, row: InboxRow): Promise<number | null> {
  for (let i = 0; ; i++) {
    try {
      return await inbox.beginAttempt(row);
    } catch (e) {
      if (e instanceof InboxRowGone) {
        console.warn(`${rt.tag} 一行入站出队时已结束或已被清除，不再处理`);
        return null;
      }
      if (rt.stopping) {
        rt.haltedChains.add(chainKeyOf(row));
        console.error(`${rt.tag} 停机中，一行入站计次没写进库：这一行与同一会话排在后面的都留给下次启动`);
        return null;
      }
      const delay = ATTEMPT_RETRY_MS[Math.min(i, ATTEMPT_RETRY_MS.length - 1)]!;
      const code = (e as { code?: unknown } | null)?.code;
      console.error(
        `${rt.tag} 一行入站计次没写进库（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}），${delay / 1000} 秒后再试`,
      );
      // 分成一秒一秒等：停机时不必等满整段退避
      for (let waited = 0; waited < delay && !rt.stopping; waited += 1_000) await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/**
 * poison、too_old：记 abandoned（带原因），名下没发的段取消，会话加一条说明让顾问看见（02 的同一句），告警（channel）。
 * 说明与告警只对客户的话（消息、菜单点击）；回执不是客户的话，只记 abandoned 与一行日志。没有会话的不建会话，入站行单独一个短事务
 */
async function abandonInboxRow(rt: WecomRuntime, row: InboxRow, reason: 'poison' | 'too_old'): Promise<void> {
  const why = reason === 'poison' ? `已重放 ${row.attempts - 1} 次仍未处理完` : '已超过 48h 发送窗口';
  const customer = row.kind === 'message' || row.kind === 'menu_click';
  console.error(
    `${rt.tag} ⚠️ 放弃一条未处理完的${customer ? '客户消息' : '回执'}（${why}）:`,
    row.conversationId ? convLabel(row.conversationId) : '?',
  );
  const s = row.conversationId ? getSession(row.conversationId) : undefined;
  cancelInboxIntents(row.id);
  if (s && customer) {
    s.messages.push({ role: 'system', content: `⚠️ 客户有一条消息 AI 未能处理（${why}），请人工回复`, at: Date.now() });
    saveSession(s, false);
  }
  // 与上面的说明同一段同步代码：同一次落库
  const done = finishInboxRow(row.conversationId, row.id, 'abandoned', reason);
  if (customer) noteInboxAbandoned({ reason, account: rt.key });
  await done;
}

/**
 * 恢复截止点之前的消息（R7、不变量 9）：不调引擎、不发送。客户消息不在会话里时照常写进会话（非文本写占位），追加一条说明（同一会话
 * 一次恢复只加一条：截止点之后加过就不再加），入站行记 abandoned（restore_cutoff），同一次落库；菜单点击不补记
 */
function recordOnlyInboxRow(rt: WecomRuntime, row: InboxRow, cutoff: number): Promise<void> {
  const sessionId = row.conversationId;
  const msg = row.kind === 'message' ? (row.payload as KfMessage | null) : null;
  let noted = false;
  if (sessionId && msg) {
    const s = accountSession(rt, sessionId);
    const known = s.messages.some((m) => m.msgid === row.msgid) || recentMsgids(sessionId).has(row.msgid);
    if (!known) {
      const content = msg.msgtype === 'text' && msg.text?.content ? inboundText(msg.text.content) : placeholderOf(msg.msgtype);
      s.messages.push({ role: 'customer', content, at: Date.now(), msgid: row.msgid, ...(row.sentAt ? { sentAt: row.sentAt } : {}) });
      trimSessionMessages(s);
    }
    if (!s.messages.some((m) => m.role === 'system' && m.content === RESTORE_CUTOFF_NOTE && m.at > cutoff)) {
      s.messages.push({ role: 'system', content: RESTORE_CUTOFF_NOTE, at: Date.now() });
      noted = true;
    }
    saveSession(s);
  }
  console.log(`${rt.tag} 恢复截止点之前的${row.kind === 'message' ? '客户消息只补记' : '菜单点击不补记'}，不回复`);
  cancelInboxIntents(row.id);
  const done = finishInboxRow(sessionId, row.id, 'abandoned', 'restore_cutoff');
  noteInboxAbandoned({ reason: 'restore_cutoff', account: rt.key, noted });
  return done;
}

/** 客户消息（文本与非文本）。alreadyRecorded：启动恢复时这句已经记进会话、回复还没生成（入站恢复表的 recorded），不再记一遍 */
function processMessageRow(rt: WecomRuntime, cfg: WecomConfig, row: InboxRow, alreadyRecorded = false): Promise<void> {
  const msg = row.payload as KfMessage;
  const sessionId = row.conversationId ?? rt.prefix + msg.external_userid;
  // 这条消息的日志（含引擎这一轮结束之后的几行）都带 conv（R24）
  return withConversationLog(sessionId, async () => {
    if (msg.msgtype !== 'text' || !msg.text?.content) return processNonTextRow(rt, cfg, row, msg, sessionId, alreadyRecorded);
    const t0 = Date.now();
    console.log(`${rt.tag} ${alreadyRecorded ? '重跑' : '收到'}客户消息: "${logQuote(msg.text.content)}"`);
    // 接手代次在这一轮开始时记下，发之前再比（不变量 28 的适配器部分）；catch 里的兜底道歉也用它（模型等待期间被接手、随后模型
    // 报错时，拿接手之后的新代次去比会全过，道歉照发给客户——第 8 步审查）
    const gen = takeoverGen(sessionId);
    try {
      // 非默认账号：会话先带着 channelAccountId 建好，引擎拿到的就是它（默认账号由引擎建）
      if (rt.sessionAccountId) accountSession(rt, sessionId);
      const r = await handleMessage(sessionId, msg.text.content, 'wecom', {
        msgid: msg.msgid,
        sentAt: msg.send_time * 1000,
        inboxId: row.id,
        ...(alreadyRecorded ? { alreadyRecorded: true } : {}),
      });
      void enrichCustomerProfile(rt, cfg, msg.external_userid); // 会话已建，异步补昵称回填后台展示
      if (r.silent || !r.text.trim()) {
        console.log(`${rt.tag} 静默（阶段=${r.stage}，转人工后不自动回复）`);
        await finishInboxRow(sessionId, row.id, 'done');
        return;
      }
      const out = await replyDb(rt, cfg, sessionId, { text: r.text, stage: r.stage, message: replyMessageOf(r) ?? null }, gen, t0, row.id);
      if (out === 'deferred') console.log(`${rt.tag} 入站停在 replied（重启后按出站恢复补发）`);
    } catch (err) {
      // 与 02 一样算处理完：回一句道歉（不挂入站），入站记 done
      console.error(`${rt.tag} 处理消息失败:`, err);
      await sendTextDb(rt, cfg, sessionId, SORRY_TEXT, 'ai', null, gen);
      await finishInboxRow(sessionId, row.id, 'done');
    }
  });
}

/**
 * 非文本消息：适配器自己写占位（不经引擎，同样算一轮），占位与 recorded 同一次落库；已转人工只记不回（done）；否则引导提示带 inboxId
 * 走 planOutbound（replied 与它的 pending 同一次落库，同一次落库里先 recorded 再 replied）。提示发成功才记进会话（02 的口径）
 */
function processNonTextRow(
  rt: WecomRuntime,
  cfg: WecomConfig,
  row: InboxRow,
  msg: KfMessage,
  sessionId: string,
  alreadyRecorded = false,
): Promise<void> {
  return withTurnScope(async () => {
    const session = accountSession(rt, sessionId);
    startTurn(sessionId);
    const stageBefore = session.stage;
    if (!alreadyRecorded) {
      const placeholder: ChatMessage = {
        role: 'customer',
        content: placeholderOf(msg.msgtype),
        at: Date.now(),
        msgid: msg.msgid,
        sentAt: msg.send_time * 1000,
      };
      session.messages.push(placeholder);
      // 与引擎同一道封顶：这条路不经引擎，转人工后只发图片的客户也不能让会话无限膨胀
      trimSessionMessages(session);
      saveSession(session);
      queueInboxState(sessionId, { inboxId: row.id, state: 'recorded', message: placeholder });
    }
    if (session.handedOver) {
      console.log(`${rt.tag} 静默（${msg.msgtype} 消息，转人工后不自动回复）`);
      endTurn('silent', '', stageBefore, session.stage);
      await finishInboxRow(sessionId, row.id, 'done');
      return;
    }
    const hint = NON_TEXT_HINT[msg.msgtype] ?? NON_TEXT_HINT_OTHER;
    // 消息对象先建好交给账本（发成功才写进会话，写进去的是同一个对象，账本行据它取 seq）
    const sent: ChatMessage = { role: 'agent', content: hint, at: Date.now() };
    const out = await sendTextDb(rt, cfg, sessionId, hint, 'ai', sent, takeoverGen(sessionId), row.id);
    if (out.stop === 'deferred') {
      // 停机截止之后不开始发：分段留在 pending、入站留在 replied（重启后按出站恢复补发），这一轮也那时再记
      console.log(`${rt.tag} 停机中、发送已截止，引导提示留在 pending（重启后补发）`);
      return;
    }
    if (out.ok) {
      const s = getSession(sessionId);
      if (s) {
        sent.at = Date.now();
        s.messages.push(sent);
        saveSession(s);
        // 与写进提示、saveSession 同一段同步代码：排出的那次落库里提示已关联上这一轮
        endTurn('deterministic', hint, stageBefore, s.stage, sent);
        return;
      }
    }
    // 没发出去（或会话已不在）：照样是回固定提示的一轮，只是没有记进会话的那条消息可关联
    endTurn('deterministic', hint, stageBefore, getSession(sessionId)?.stage ?? session.stage);
  });
}

/**
 * 同意菜单的点击（02 第 16 步的规则）：applyConsentDecision 改了会话，同一次落库记 done；没发布隐私说明、认不出按钮、没有会话、
 * 这个类别已有结论的照 02 忽略，同样记 done。「不同意」的确认（notice，不挂入站）的 pending 与同意记录同一次落库，提交之后才发
 */
async function processMenuRow(rt: WecomRuntime, cfg: WecomConfig, row: InboxRow): Promise<void> {
  const msg = row.payload as KfMessage;
  const sessionId = row.conversationId ?? rt.prefix + msg.external_userid;
  const notice = currentPrivacyNotice();
  const parsed = notice ? parseConsentMenuId(msg.text?.menu_id) : null;
  const s = getSession(sessionId);
  if (!notice || !parsed || !s) return finishInboxRow(sessionId, row.id, 'done');
  const evidence = msg.text?.content || msg.text?.menu_id || '';
  if (!applyConsentDecision(s, parsed.category, parsed.decision, evidence, notice.version))
    return finishInboxRow(sessionId, row.id, 'done');
  saveSession(s);
  queueInboxState(sessionId, { inboxId: row.id, state: 'done' });
  if (parsed.decision !== 'declined') return;
  let g: OutGroup | null = null;
  try {
    g = planGroup(rt, cfg, s.id, 'notice', null, textPayloads(CONSENT_DECLINED_REPLY), null, takeoverGen(s.id));
  } catch (e) {
    planFailed(rt, s.id, e);
  }
  const ok = g ? (await runGroup(g)).ok : false;
  if (ok) {
    s.messages.push({ role: 'agent', content: CONSENT_DECLINED_REPLY, at: Date.now() });
    saveSession(s);
  } else {
    console.warn(`${rt.tag} 不同意的确认没送达（会话 ${convLabel(s.id)}）`);
  }
}

/**
 * 发送失败回执：出站行迁 failed 与入站行 done 同一个短事务（账本的 onSendFailInbox），会话里的说明照 02 经会话落库。
 * 不经处理链、不计次（见 dispatchInboxRows）：一个短事务做完，迁移表让重做无害
 */
function processReceiptRow(row: InboxRow): Promise<void> {
  const p = row.payload as { fail_msgid?: string; fail_type?: number } | null;
  if (!p?.fail_msgid) return finishInboxRow(row.conversationId, row.id, 'done');
  return onSendFailInbox(p.fail_msgid, Number(p.fail_type ?? 0), row.id);
}

/**
 * 拉取（库里的账号）：has_more 时连续拉到拉空。每一页 acceptPage（插入与推进 cursor 同一个事务），提交之后才派发；拉取途中收到停机
 * 信号，这一页不提交（cursor 不动、不插入），新进程补拉时再拿到；acceptPage 失败（库写不进去）这一页不派发，下一次拉取重来
 */
async function drainInbox(rt: WecomRuntime, inbox: AccountInbox, cfg: WecomConfig, syncToken?: string): Promise<void> {
  for (;;) {
    const body: Record<string, unknown> = { open_kfid: cfg.openKfId, limit: 100 };
    if (inbox.cursor) body.cursor = inbox.cursor;
    if (syncToken) body.token = syncToken;
    const data = await callApi<SyncMsgResp>(rt, cfg, 'kf/sync_msg', body);
    if (data.errcode) {
      console.error(`${rt.tag} sync_msg 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
      return;
    }
    if (rt.stopping) return;
    const page = data.msg_list ?? [];
    let rows: InboxRow[];
    try {
      rows = await inbox.acceptPage(rt.id, page, data.next_cursor ?? '');
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      console.error(
        `${rt.tag} ⚠️ 这一页入站没写进库（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}）：` +
          '不派发、cursor 不动，下一次拉取重来',
      );
      return;
    }
    dispatchInboxRows(rt, cfg, rows, new Map(page.map((m) => [m.msgid, m])));
    if (!data.has_more || rt.stopping) return;
  }
}

// ---------------- 按客户串行的处理链 ----------------
// 处理不在同步锁里 await：此前锁一直持有到整批 LLM 回复发完，A 客户一轮 4~10s，
// 期间 B 的回调只能记 pending，首响被整整推迟 A 的处理时长；新客户的 welcome_code
// 只有 20s，排在别人后面就过期了，扫码后什么都收不到。
// 现在按 external_userid 排链（写法同 engine.ts 的 serialize）：同客户保序，跨客户、跨批次都互不等待。
// 链按账号分开：同一个 external_userid 在两个客服账号上是两段会话，互不排队

function enqueueForUser(rt: WecomRuntime, uid: string, task: () => Promise<void>): void {
  const prev = rt.userChains.get(uid) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error(`${rt.tag} 单条消息处理异常（继续后续消息）:`, err));
  rt.userChains.set(uid, next);
  void next.finally(() => {
    if (rt.userChains.get(uid) === next) rt.userChains.delete(uid);
  });
}

/** 欢迎语不排队（welcome_code 20 秒就过期），单独跟踪，只为停机时能等它们发完 */
function dispatchWelcome(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage): void {
  const t = handleEnterSession(rt, cfg, msg).catch((err) => console.error(`${rt.tag} 欢迎语处理异常:`, err));
  rt.eventTasks.add(t);
  void t.finally(() => rt.eventTasks.delete(t));
}

/** env 账号的拉取状态（02 的文件后端） */
function fileState(rt: WecomRuntime): FileWecomState {
  if (rt.state.kind !== 'file') throw new Error(`${rt.tag} 不是 env 账号，没有文件状态`);
  return rt.state;
}

/** env 账号（02）：一条认领了的消息派发出去 */
function dispatch(rt: WecomRuntime, cfg: WecomConfig, msg: KfMessage, replay = false): void {
  if (isEnterSession(msg)) {
    dispatchWelcome(rt, cfg, msg);
    return;
  }
  const state = fileState(rt);
  enqueueForUser(rt, msg.external_userid || msg.msgid, async () => {
    let deferred = false;
    try {
      deferred = (await handleCustomerMessage(rt, cfg, msg, replay)) === 'deferred';
    } finally {
      // 回复成功、静默、发送失败、异常兜底都算「处理完」；只有进程死在半路、或停机截止后没开始发的（deferred）才留在在途表里
      if (!deferred) state.inflight.delete(msg.msgid);
      state.scheduleSave();
    }
  });
}

// ---------------- 同步循环 ----------------
// syncToken 由回调事件带来：带 token 调用不受严格限频（不带 token 的纯轮询会 45009）。
// 互斥期间的新触发不再丢弃（此前直接 return，消息要等 30-60s 兜底轮询）：
// 记 pending，本轮拉完立刻补拉。

function syncOnce(rt: WecomRuntime, cfg: WecomConfig, syncToken?: string): Promise<void> {
  if (rt.stopping || rt.recovery !== 'done') return Promise.resolve();
  if (rt.syncTask) {
    rt.pendingRequested = true;
    if (syncToken) rt.pendingToken = syncToken;
    return Promise.resolve();
  }
  rt.syncTask = (async () => {
    try {
      let token = syncToken;
      do {
        rt.pendingRequested = false;
        if (rt.state.kind === 'file') await drainMessages(rt, rt.state, cfg, token);
        else await drainInbox(rt, rt.state, cfg, token);
        token = rt.pendingToken;
        rt.pendingToken = undefined;
        // 两个标志都在 await 期间由别的调用改（syncOnce 记 pending、停机置 stopping），不是死循环
        // oxlint-disable-next-line no-unmodified-loop-condition
      } while (rt.pendingRequested && !rt.stopping);
    } finally {
      rt.syncTask = null;
    }
  })();
  return rt.syncTask;
}

/** env 账号（02）的拉取：认领、在途表、cursor 文件 */
async function drainMessages(rt: WecomRuntime, state: FileWecomState, cfg: WecomConfig, syncToken?: string): Promise<void> {
  // has_more 时连续拉直到拉空，避免消息积压跨轮询周期
  for (;;) {
    const body: Record<string, unknown> = { open_kfid: cfg.openKfId, limit: 100 };
    if (state.cursor) body.cursor = state.cursor;
    if (syncToken) body.token = syncToken;
    const data = await callApi<SyncMsgResp>(rt, cfg, 'kf/sync_msg', body);
    if (data.errcode) {
      console.error(`${rt.tag} sync_msg 失败: errcode=${data.errcode} ${data.errmsg ?? ''}`);
      return;
    }
    // 拉取途中收到停机信号：这一页不认领（cursor 不推进、不标记），新进程启动补拉时会再拿到
    if (rt.stopping) return;
    const accepted: KfMessage[] = [];
    let skippedOld = 0;
    for (const msg of data.msg_list ?? []) {
      // 发送失败的回执（02 第 12 步）：按 fail_msgid 记进发送账本、给会话加说明。在这里单独拦下（认领过的不再处理），
      // 不进在途表：它不是客户消息，放进去会被当成非文本客户消息、给客户发一条引导
      if (isSendFail(msg)) {
        if (markHandled(state, msg.msgid) && msg.event?.fail_msgid) onSendFail(msg.event.fail_msgid, Number(msg.event.fail_type ?? 0));
        continue;
      }
      // 同意菜单的点击（02 第 16 步）：普通文本消息但带 menu_id，不当成客户话语处理、不进在途表
      // （丢了至多少记一次同意，不影响对话主链路）
      if (isMenuClick(msg)) {
        if (markHandled(state, msg.msgid)) {
          const uid = msg.external_userid || msg.msgid;
          enqueueForUser(rt, uid, () => handleMenuClick(rt, cfg, msg));
        }
        continue;
      }
      const welcome = isEnterSession(msg);
      if (!welcome && msg.origin !== 3) continue; // 只处理客户发来的，跳过别的系统事件与自己发出的回声
      if (!markHandled(state, msg.msgid)) continue; // 幂等：同一 msgid 只处理一次（含重启后）
      if (state.coldStartCutoff && msg.send_time * 1000 < state.coldStartCutoff) {
        skippedOld += 1;
        continue;
      }
      // 只有客户消息进在途表：欢迎语的 welcome_code 20s 就过期，重启后重放也发不出去
      if (!welcome) state.inflight.set(msg.msgid, { msg, tries: 0 });
      accepted.push(msg);
    }
    if (skippedOld) {
      console.warn(`${rt.tag} 冷启动：跳过 ${skippedOld} 条启动前的历史消息（已标记处理，不回复）`);
    }
    if (data.next_cursor) state.cursor = data.next_cursor;
    // 先把 cursor、去重集、在途消息（含原文）一起原子落盘，再开始处理：从这一刻起
    // sync_msg 不会再返回这批消息，进程若死在处理途中，只能靠落盘的原文重放
    await state.save();
    for (const msg of accepted) dispatch(rt, cfg, msg);
    if (!data.has_more || rt.stopping) return;
  }
}

/** 启动时重放上个进程没处理完的客户消息。须在任何新拉取之前派发，同客户的新消息才会排在它后面 */
async function replayInflight(rt: WecomRuntime, state: FileWecomState, cfg: WecomConfig): Promise<void> {
  const inflight = state.inflight;
  // 刚启动就收到停机信号：不重放，原样留在在途表里给下一个进程（重放计数也不加）
  if (!inflight.size || rt.stopping) return;
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
      console.error(`${rt.tag} ⚠️ 放弃一条未处理完的客户消息（${why}）:`, convLabel(rt.prefix + p.msg.external_userid));
      // 放弃必须让顾问看见：会话最后一条是客户说的，自动跟进不会去追，不标出来就没人知道要回
      const s = getSession(rt.prefix + p.msg.external_userid);
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
  await state.save();
  if (todo.length) console.warn(`${rt.tag} 重放上次停机时未处理完的 ${todo.length} 条客户消息`);
  for (const { msg, replay } of todo) dispatch(rt, cfg, msg, replay);
}

/**
 * 幂等：加载状态（env 账号再重放在途消息）。启动循环与回调都先 await 它，消除「回调早于加载」的竞态。
 * 库里的账号：启动恢复（runRecovery）已经 load 过（库里的 cursor、恢复截止点，没结束的行已派发），这里是它之后读不到时的兜底；
 * 读不到（库不可用）下次再试
 */
function ensureReady(rt: WecomRuntime, cfg: WecomConfig): Promise<void> {
  const state = rt.state;
  if (state.kind === 'file') return (rt.readyPromise ??= state.load().then(() => replayInflight(rt, state, cfg)));
  return (rt.readyPromise ??= state.load(rt.id).then(
    () => undefined,
    (e: unknown) => {
      rt.readyPromise = null;
      throw e;
    },
  ));
}

/** 回调带来的 token 立即拉一次（两种账号共用） */
async function pullFromCallback(rt: WecomRuntime, cfg: WecomConfig, syncToken: string): Promise<void> {
  if (rt.stopping) {
    // 回调照样回 success（server.ts），只是不拉：消息还在 cursor 之后，新进程启动补拉时会拿到
    console.log(`${rt.tag} 停机中，回调不再拉取（新进程启动后补拉）`);
    return;
  }
  if (rt.recovery !== 'done') {
    // 回调照样回 success：消息还在 cursor 之后，恢复做完开始拉取时第一拍就补拉（startRuntime）
    console.log(`${rt.tag} 启动恢复还没做完，回调这次不拉取（做完之后补拉）`);
    return;
  }
  try {
    await ensureReady(rt, cfg);
    await syncOnce(rt, cfg, syncToken);
  } catch (err) {
    console.error(`${rt.tag} 回调拉取异常:`, err); // server.ts 是 void 调用，漏到外面就是未捕获 rejection
  }
}

/**
 * env 账号：回调收到 kf_msg_or_event 事件时调用，用事件携带的 token 立即拉取（实时且不限频）。
 * 未配置 wecom 时（含企微状态在库里）静默忽略
 */
export async function syncFromCallback(syncToken: string): Promise<void> {
  const cfg = envRuntime.config();
  if (!cfg) return;
  await pullFromCallback(envRuntime, cfg, syncToken);
}

/** 库里的企微账号：按账号的回调（adapters/wecom-callback.ts）验签、按 OpenKfId 找到账号之后调用 */
export async function syncAccountFromCallback(accountId: string, syncToken: string): Promise<void> {
  const rt = accountId === ENV_ACCOUNT_ID ? undefined : runtimes.get(accountId);
  const cfg = rt?.config();
  if (!rt || !cfg) {
    console.error('[wecom] 回调指向的企微账号没有运行时（没启用或没起来），这次不拉');
    return;
  }
  await pullFromCallback(rt, cfg, syncToken);
}

// ---------------- 启动与停机 ----------------

/** 起轮询循环（不阻塞调用方）：先加载、重放，再补拉一次，之后兜底慢轮询 */
function startRuntime(rt: WecomRuntime): void {
  const cfg = rt.config();
  if (!cfg || rt.started) return;
  rt.started = true;
  if (!cfg.publicBaseUrl) {
    console.error(
      `${rt.tag} ⚠️⚠️ PUBLIC_BASE_URL 未配置：发给微信客户的支付链接将是不可点击的相对路径，` +
        '成单流程会断在付款一步！请在 env 配置公网地址（如 https://travel.example.com）。',
    );
  }
  void (async () => {
    // 库里的账号读不到拉取位置（库不可用）也照样起轮询：每次拉取之前再读（ensureReady 失败时下次重来）
    if (rt.state.kind === 'file') await ensureReady(rt, cfg);
    else await ensureReady(rt, cfg).catch(() => console.error(`${rt.tag} 启动时读不到库里的拉取位置，之后每次拉取之前再读`));
    // 主通道是回调驱动（syncFromCallback）。这里只做兜底慢轮询，兜住回调偶发丢失；
    // 间隔取较大值（默认 60s），不带 token 的纯轮询频率太高会 45009。
    const fallbackMs = Math.max(30000, cfg.pollIntervalMs);
    console.log(`${rt.tag} kf 已就绪：回调驱动 + ${fallbackMs}ms 兜底轮询`);
    const tick = async (): Promise<void> => {
      rt.pollTimer = null;
      try {
        if (rt.state.kind !== 'file') await ensureReady(rt, cfg);
        await syncOnce(rt, cfg);
      } catch (err) {
        console.error(`${rt.tag} 兜底轮询异常（下轮重试）:`, err);
      }
      if (!rt.stopping) rt.pollTimer = setTimeout(() => void tick(), fallbackMs);
    };
    // 启动先补拉一次，不等第一个轮询周期：上个进程停机收尾时回调只回了 success 没拉，
    // 重启空档里的回调也可能已经丢了，这些消息都还在 cursor 之后
    void tick();
  })().catch((err) => console.error(`${rt.tag} 启动失败，仅靠回调拉取:`, err));
}

/** env 账号：未配齐 env 时静默不启动；配齐则起轮询循环（不阻塞调用方） */
export function startWecom(): void {
  startRuntime(envRuntime);
}

/** startChannels 交进来的一个库里启用的企微账号 */
export interface WecomAccountStart {
  account: ChannelAccount;
  /** 解密后的凭据（只在内存里，打印是「[已遮盖]」） */
  secrets: Redacted<WecomSecrets>;
  /** initChannels 那一刻读到的这个账号没结束的入站行与没结果的出站行（启动恢复按它们做，spec「重启、崩溃与恢复」） */
  open: { inbox: readonly OpenInboxLike[]; outbound: readonly OpenOutboundLike[] };
}

/** 启动恢复读库（load、入站名下的出站行）失败时的退避：与出队计次同一套，停机时放下 */
async function retryUntilStopped<T>(rt: WecomRuntime, what: string, fn: () => Promise<T>): Promise<T | null> {
  for (let i = 0; ; i++) {
    if (rt.stopping) return null;
    try {
      return await fn();
    } catch (e) {
      const delay = ATTEMPT_RETRY_MS[Math.min(i, ATTEMPT_RETRY_MS.length - 1)]!;
      const code = (e as { code?: unknown } | null)?.code;
      console.error(
        `${rt.tag} ⚠️ 启动恢复${what}没读成（${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}），` +
          `${delay / 1000} 秒后再试（这之前不拉取）`,
      );
      for (let waited = 0; waited < delay && !rt.stopping; waited += 1_000) await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/**
 * 启动恢复（03 spec「重启、崩溃与恢复」，src/channels/recovery.ts）：先按出站恢复表处理 initChannels 读到的没结果的出站行（补发一段一段
 * 等完），再读这个账号的拉取位置与没结束的入站行（load）、按 ord 派发进各自会话的处理链（入站恢复表在 processInboxRow 里，出队时照常
 * 计次、判过期与截止）。派发完就算做完：recovery 改 done、gate 打开（排队的 push 放行）、开始拉取（同一客户的新消息排在恢复的行后面）。
 * 停机了就停下：没做完，不拉取
 */
async function runRecovery(rt: WecomRuntime, cfg: WecomConfig, start: WecomAccountStart): Promise<void> {
  const port: RecoveryPort = {
    accountId: rt.id,
    tag: rt.tag,
    recordOnlyUntil: start.account.wecom?.recordOnlyUntil ?? null,
    resend: async (intent, alreadySending, stillEligible) => {
      const out = await sendGroup(
        groupOfIntents(rt, cfg, [intent], { inboxId: null, alreadySending, ...(stillEligible ? { stillEligible } : {}) }),
      );
      if (out.stop === 'deferred') console.log(`${rt.tag} 停机中、发送已截止，恢复要补发的一段留在库里（下次启动再按出站恢复表处理）`);
    },
    stopping: () => rt.stopping,
  };
  try {
    await recoverOutbound(port, start.open.outbound, start.open.inbox);
  } catch (err) {
    // 出站恢复中途出错：没处理到的行留在库里原样（下次启动再按表处理），入站恢复与拉取照常，不让这个账号停在这里
    console.error(`${rt.tag} ⚠️ 启动恢复（出站）中途出错，没处理到的行留到下次启动:`, err);
  }
  const loaded = await retryUntilStopped(rt, '读入站', () => inboxOf(rt).loadForRecovery(rt.id));
  if (!loaded || rt.stopping) return;
  rt.readyPromise = Promise.resolve();
  if (loaded.open.length) console.log(`${rt.tag} 启动恢复（入站）：${loaded.open.length} 行没结束，按 ord 派发进各自会话的处理链`);
  dispatchInboxRows(rt, cfg, loaded.open, undefined, { withOutbound: loaded.withOutbound });
  rt.recovery = 'done';
  rt.gate.open();
  startRuntime(rt);
}

/**
 * 起一个库里企微账号的运行时（03 spec R10），按账号 uuid 登记。配置来自账号行与解密的凭据，不读 WECOM_*；
 * 拉取状态在 channel_inbox（第 9 步：cursor 与入站行同一个事务，load 时读库里的 cursor 与恢复截止点）；发送先落库后发送（第 8 步）。
 * 先做启动恢复（第 10 步，runRecovery），做完才开始拉取；恢复做完之前这个账号的 push 排队等待（至多 30 秒）
 */
export function startWecomAccount(s: WecomAccountStart): void {
  const { account } = s;
  const w = account.wecom;
  if (account.source !== 'db' || account.kind !== 'wecom_kf' || !w) throw new Error('startWecomAccount 只收库里的企微账号');
  if (runtimes.has(account.id)) throw new Error(`企微账号 ${account.key} 的运行时已经起过了`);
  const tag = accountTag(account.key);
  // 兜底轮询间隔同 WECOM_POLL_INTERVAL_MS 的规则（实际生效 ≥30 秒），取账号设置，不读 env
  const pollIntervalMs = Math.max(1000, w.settings.pollIntervalMs || 3000);
  const rt = new WecomRuntime({
    id: account.id,
    key: account.key,
    tenantId: account.tenantId,
    prefix: w.idPrefix,
    ...(w.idPrefix === DEFAULT_WECOM_PREFIX ? {} : { sessionAccountId: account.id }),
    tag,
    config: () => ({
      corpId: w.corpId,
      secret: s.secrets.reveal().appSecret,
      openKfId: w.openKfId,
      pollIntervalMs,
      publicBaseUrl: publicBaseUrl(),
    }),
    ...(w.settings.welcomeText !== undefined ? { welcomeText: w.settings.welcomeText } : {}),
    ...(w.settings.welcomeBackText !== undefined ? { welcomeBackText: w.settings.welcomeBackText } : {}),
    state: new AccountInbox({ id: account.id, idPrefix: w.idPrefix, tag }),
  });
  runtimes.set(rt.id, rt);
  const cfg = rt.config()!;
  // 恢复与它补发的那几段按 eventTasks 跟踪：停机时等它（它自己看 stopping 停下），自测的 idle 也等它
  const task = runRecovery(rt, cfg, s).catch((err) => console.error(`${rt.tag} 启动恢复异常（不拉取，重启之后再按表处理）:`, err));
  rt.eventTasks.add(task);
  void task.finally(() => rt.eventTasks.delete(task));
}

/** 停掉并注销库里账号的运行时（自测的 __channelsTest.reset 用）：不再拉取、轮询定时器清掉；env 账号不动 */
export function stopWecomAccounts(): void {
  for (const [id, rt] of runtimes) {
    if (rt === envRuntime) continue;
    rt.stopping = true;
    if (rt.pollTimer) {
      clearTimeout(rt.pollTimer);
      rt.pollTimer = null;
    }
    runtimes.delete(id);
  }
}

/**
 * 停机钩子（一个账号）：停止拉新消息，等进行中的拉取与各客户的处理链跑完，再把状态落盘。normal 段截止（ctx.deadline）之后不再开始
 * 新的 send_msg（见 sendsClosed）
 */
async function drainForShutdown(rt: WecomRuntime, ctx?: { deadline: number }): Promise<void> {
  rt.stopping = true;
  if (ctx) rt.sendsClosedAt = ctx.deadline;
  if (rt.pollTimer) {
    clearTimeout(rt.pollTimer);
    rt.pollTimer = null;
  }
  // 先等启动重放派发完，再看处理链：replayInflight 过了开头的 stopping 检查后要先 await 落盘才派发，
  // 停机信号落在这个窗口里时，先查处理链会看到空的直接跳过，重放出去的回复没人等就退出了——
  // 回复可能已送达、完成标记却没落盘，下次启动又重发一遍，还白白耗掉一次重放名额
  const loaded = rt.readyPromise
    ? await rt.readyPromise.then(
        () => true,
        () => false,
      )
    : false;
  await rt.syncTask?.catch(() => undefined); // 拉取失败不能让后面的「等处理链」被跳过
  // 刚拉到的一页可能在上面等待期间才派发出去，循环到链全部清空
  while (rt.userChains.size || rt.eventTasks.size) {
    await Promise.all([...rt.userChains.values(), ...rt.eventTasks]);
  }
  // 状态从没加载成功过（企微未启用）就不写，免得凭空生成一个空 cursor 的状态文件。库里的账号没有要收尾写的：cursor 与入站行
  // 每一页都随 acceptPage 的事务提交了，没处理完的行留在 channel_inbox 里给下次启动
  if (!loaded || rt.state.kind !== 'file') return;
  await rt.state.close();
}
/** 每个账号的运行时一起收尾，一个账号出错不耽误别的账号 */
onShutdown(async (ctx) => {
  const results = await Promise.allSettled([...runtimes.values()].map((rt) => drainForShutdown(rt, ctx)));
  for (const r of results) if (r.status === 'rejected') console.error('[wecom] 停机收尾异常:', r.reason);
});
/** 进程退出前把每个账号去抖窗口里的状态同步写出去（文件后端；库里的账号都在库里，没有要写的） */
process.on('exit', () => {
  for (const rt of runtimes.values()) if (rt.state.kind === 'file') rt.state.flushSync();
});

/**
 * 发往一个企微会话的推送走哪个账号：企微状态在库里时经 accountForSession（前缀最长匹配，停用账号的会话不会落到默认账号上），
 * 账号停用、没有运行时都返回 null（推送记一行、返回 false，人工回复照 02 记「未能发送」）；其余照 02 走 env 账号
 */
function pushRoute(sessionId: string, quiet = false): { rt: WecomRuntime; cfg: WecomConfig } | null {
  // quiet：prepare 先问一次，找不到时不记日志（随后的 push 会再问一次、照常记）
  const err = (...args: unknown[]): void => {
    if (!quiet) console.error(...args);
  };
  if (!wecomInDb()) {
    const cfg = envRuntime.config();
    if (!cfg) {
      // 历史 wecom 会话存在但企微 env 未配（如换服务器漏配）：必须出声，否则回复凭空消失
      err('[wecom] ⚠️ 收到发往 wecom 会话的消息但企微未配置（WECOM_* env 缺失），消息未送达:', convLabel(sessionId));
      return null;
    }
    if (!sessionId.startsWith(envRuntime.prefix)) return null;
    return { rt: envRuntime, cfg };
  }
  const account = accountForSession(sessionId, getSession(sessionId));
  if (account?.kind !== 'wecom_kf') {
    err('[wecom] ⚠️ 会话找不到所属的企微账号，消息未送达:', convLabel(sessionId));
    return null;
  }
  const tag = accountTag(account.key);
  if (!isEnabled(account)) {
    err(`${tag} ⚠️ 账号已停用，发往它名下会话的消息未送达:`, convLabel(sessionId));
    return null;
  }
  const rt = runtimes.get(account.id);
  const cfg = rt?.config();
  if (!rt || !cfg) {
    err(`${tag} ⚠️ 账号的运行时没有起来，消息未送达:`, convLabel(sessionId));
    return null;
  }
  return { rt, cfg };
}

/**
 * 库里账号的启动恢复做完之前，push（人工回复、跟进、通知）排队等待，至多 30 秒（spec「重启、崩溃与恢复」）：做完了 true；
 * 超时 false（调用方按没发出去处理：跟进按 02 的明确失败、人工回复记「未能发送」）
 */
async function recovered(rt: WecomRuntime): Promise<boolean> {
  if (rt.gate.isOpen) return true;
  console.log(`${rt.tag} 启动恢复还没做完，这次推送排队等待`);
  if (await rt.gate.wait()) return true;
  console.error(`${rt.tag} ⚠️ 启动恢复在等待上限之内没做完，这次推送不发（按没发出去处理）`);
  return false;
}

export const wecomAdapter: ChannelAdapter = {
  name: 'wecom',
  /**
   * opts 不给时按 notice 记账（付款确认等）；人工回复（kind='human'）的客户侧正文前加「【顾问】」（不变量 18）。
   * 库里的企微账号走 03 的先落库后发送：给了 prepare 的句柄就发那一组，否则在这里切分、排 pending、等提交再发
   */
  async push(sessionId: string, text: string, opts?: PushOpts): Promise<boolean> {
    if (opts?.prepared) {
      const g = preparedGroups.get(opts.prepared);
      if (g !== undefined) {
        preparedGroups.delete(opts.prepared);
        if (!g) return false;
        if (!(await recovered(g.rt))) {
          // 已排进库的 pending 取消（工作台「未发送」；跟进据此按明确失败处理，不当成结果不明）
          cancelIntents(g.intents, 'aborted');
          return false;
        }
        const out = await runGroup(g);
        if (out.stop === 'deferred') console.error(`${g.rt.tag} 停机中、发送已截止，这次推送留在 pending（重启后按出站恢复处理）`);
        return out.ok && out.stop === null;
      }
    }
    const route = pushRoute(sessionId);
    if (!route) return false;
    const { rt, cfg } = route;
    if (isDbAccount(rt)) return (await recovered(rt)) && pushDb(rt, cfg, sessionId, text, opts);
    if (sendsClosed(rt)) {
      // 停机的 normal 段已截止：不再开始新的 send_msg（账本行已无处可写），按没发出去返回（跟进退账、之后再排）
      console.error(`${rt.tag} 停机中、发送已截止，这次推送不发`);
      return false;
    }
    const uid = sessionId.slice(rt.prefix.length);
    // 同意菜单（02 第 16 步）：原生 msgmenu，带「同意」「不同意」两个按钮；没有 category 时退化成普通文本（不该发生）
    if (opts?.kind === 'menu' && opts.category) return sendMenu(rt, cfg, uid, formatForWecom(cfg, text), opts.category);
    return sendRich(rt, cfg, uid, formatForWecom(cfg, text), { kind: opts?.kind ?? 'notice', message: opts?.message ?? null });
  },
  /** 03：库里的企微账号把分段的 pending 排进调用方这一次落库（同步）；env 账号与找不到账号的返回 null（push 照 02 或照常报错） */
  prepare(sessionId: string, text: string, opts: PushOpts): PreparedPush | null {
    const route = pushRoute(sessionId, true);
    if (!route || !isDbAccount(route.rt)) return null;
    return prepareDb(route.rt, route.cfg, sessionId, text, opts);
  },
  /** 拿了句柄、不发了：这一组没发的段记 cancelled */
  release(prepared: PreparedPush, reason: 'taken_over' | 'aborted'): void {
    const g = preparedGroups.get(prepared);
    preparedGroups.delete(prepared);
    if (g) cancelIntents(g.intents, reason);
  },
};

// ---------------- 自测出口 ----------------

/** 模拟「进程退出再启动」：先像 exit 阶段那样把去抖窗口里的状态写出去、等排队的写完，再把运行时内存清回刚启动的样子
 *  （写下来的状态保留，下次拉取时重新加载）。不清 token、缩略图、started、pollTimer 与监听器（02 原样） */
async function resetRuntime(rt: WecomRuntime): Promise<void> {
  if (rt.state.kind === 'file') await rt.state.resetForTest();
  else rt.state.resetForTest();
  rt.readyPromise = null;
  rt.syncTask = null;
  rt.pendingRequested = false;
  rt.pendingToken = undefined;
  rt.stopping = false;
  rt.sendsClosedAt = Number.POSITIVE_INFINITY;
  rt.userChains.clear();
  rt.eventTasks.clear();
  rt.welcomeBackAt.clear();
  rt.haltedChains.clear();
}

function inspectRuntime(rt: WecomRuntime): { cursor: string; coldStart: boolean; handled: string[]; inflight: string[]; busy: boolean } {
  const file = rt.state.kind === 'file' ? rt.state : null;
  return {
    cursor: rt.state.cursor,
    coldStart: rt.state.coldStartCutoff > 0,
    // 库里的账号没有内存里的 handled 与在途表（不变量 13；去重在 channel_inbox 上）
    handled: file ? [...file.handled.keys()] : [],
    inflight: file ? [...file.inflight.keys()] : [],
    busy: rt.syncTask !== null || rt.userChains.size > 0 || rt.eventTasks.size > 0,
  };
}

/** 仅供自测使用的内部函数出口（src/adapters/wecom.selftest.ts，锁定）：状态与重置都作用于 env 账号 */
export const __test = {
  splitForWecom,
  extractCard,
  stripLink,
  wechatify,
  resetForTest: (): Promise<void> => resetRuntime(envRuntime),
  inspectForTest: () => inspectRuntime(envRuntime),
  STATE_FILE,
  WELCOME_TEXT,
  WELCOME_BACK_TEXT,
  LEGACY_WELCOME_TEXTS,
};

/** 仅供自测：RESEND_UNKNOWN 与 push 等恢复的上限（spec「RESEND_UNKNOWN 经适配器的 __channelTest 在子进程里设」；实现在 recovery.ts） */
export { __channelTest } from '../channels/recovery.js';

/** 仅供自测（src/adapters/wecom-03.selftest.ts）：按账号看运行时 */
export const __wecomTest = {
  /** 这个账号的运行时（没有为 null）：拉取状态、是否忙、启动恢复、后端种类、恢复截止点 */
  inspect(accountId: string) {
    const rt = runtimes.get(accountId);
    return rt
      ? {
          ...inspectRuntime(rt),
          recovery: rt.recovery,
          backend: rt.state.kind,
          started: rt.started,
          recordOnlyUntil: rt.state.kind === 'channel_inbox' ? rt.state.recordOnlyUntil : null,
        }
      : null;
  },
  /**
   * 启动恢复的入站那一半（自测用）：重新 load 这个账号（库里的 cursor、恢复截止点、没结束的行），把没结束的行按 ord 派发进处理链
   * （出队时照常判 poison、too_old、恢复截止与计次，再按入站恢复表处理）。返回派发了几行；没有这个账号的运行时为 -1
   */
  async dispatchOpen(accountId: string): Promise<number> {
    const rt = runtimes.get(accountId);
    const cfg = rt?.config();
    if (!rt || !cfg || rt.state.kind !== 'channel_inbox') return -1;
    const { open, withOutbound } = await rt.state.loadForRecovery(rt.id);
    dispatchInboxRows(rt, cfg, open, undefined, { withOutbound });
    return open.length;
  },
  /** 进程里所有运行时都闲下来（没有拉取、处理链与欢迎语） */
  idle(): boolean {
    return [...runtimes.values()].every((rt) => !inspectRuntime(rt).busy);
  },
  /** 运行时的账号 uuid（含 env 账号） */
  ids(): string[] {
    return [...runtimes.keys()];
  },
  /**
   * 模拟停机中（drainForShutdown 置的 stopping）：只改这个标志（不截止发送、不收尾）。置回 false 时清掉停机时停下的处理链，
   * 像新进程那样可以重新派发
   */
  setStopping(accountId: string, on: boolean): void {
    const rt = runtimes.get(accountId);
    if (!rt) return;
    rt.stopping = on;
    if (!on) rt.haltedChains.clear();
  },
  /** 模拟停机的 normal 段截止（drainForShutdown 设的那个时刻）：at 为 null 换回不截止。只改截止，不停拉取 */
  closeSends(accountId: string, at: number | null): void {
    const rt = runtimes.get(accountId);
    if (rt) rt.sendsClosedAt = at ?? Number.POSITIVE_INFINITY;
  },
};
