// 渠道账号（docs/architecture/03-channels-v2/spec.md「接口与数据流 · 渠道账号与凭据」、R1、R8、R11、R15、R19）：
// 账号的进程内形状、从库里读出与解密、env 账号的拼法、按 key 与按会话找账号、欢迎语的 AI 显式标识检查。
// 启动装载（src/channels/registry.ts 的 initChannels）判完企微状态之后经 installAccounts 把这一份账号装上；命令行（第 14、15 步）
// 只用这里的读法、解密与 checkWelcomeText，不经注册表。
// ChannelAccount 里有 corp_id、open_kfid（标识，不是密钥，仍不进日志）：调用方不整个打印账号对象；凭据不在账号对象里，
// 解密的结果是 Redacted，打印只有「[已遮盖]」（R9、不变量 16）。
import type { ChannelAccountStatus, ChannelKind } from '../shared/channel-types.js';
import type { Session } from '../types.js';
import { withTenant, type Db } from '../db/client.js';
import { listChannelAccounts, type ChannelAccountRow } from '../db/repo/channel-accounts.js';
import { ChannelSecretError, openSecrets, type KeyRing, type Redacted, type WecomSecrets } from './secrets.js';

export interface WecomSettings {
  /** 兜底轮询间隔，缺省同 WECOM_POLL_INTERVAL_MS 的规则（实际生效 ≥30 秒） */
  pollIntervalMs?: number;
  /** 不设就是现在的 WELCOME_TEXT（R19） */
  welcomeText?: string;
  welcomeBackText?: string;
}

export interface WebSettings {
  /** 页面标题与顶栏 */
  title: string;
  /** 不设就是 chat.html 的开场 */
  welcomeText?: string;
  /** 每天新会话上限（开放问题 3），缺省 500 */
  dailyNewConversations: number;
  /** 每天调模型的轮次上限，缺省 3000 */
  dailyTurns: number;
}

export interface ChannelAccount {
  /** uuid；进程内所有按账号的 Map 都用它做键 */
  id: string;
  /** 文件存储下没有租户，为空串 */
  tenantId: string;
  /** ^[a-z][a-z0-9-]{1,30}$，路由、日志、告警里用；env 账号固定为 'env' */
  key: string;
  kind: ChannelKind;
  name: string;
  status: ChannelAccountStatus;
  /** env：文件存储或还没导入时由 WECOM_* 拼出（id 固定为 ENV_ACCOUNT_ID、key 固定为 'env'，永不落库）；db：库里的一行 */
  source: 'env' | 'db';
  wecom: { corpId: string; openKfId: string; idPrefix: string; recordOnlyUntil: number | null; settings: WecomSettings } | null;
  web: WebSettings | null;
  /** 启动时判定这个账号不能启用的原因（web_channel 开关关着），给 /status 看；null 表示照常。欢迎语不合格不在这里：按没设处理、账号照常 */
  inactiveReason: string | null;
}

export const ENV_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
export const ENV_ACCOUNT_KEY = 'env';
/** 租户的第一个企微账号（导入 env 的那个）与 env 账号的会话 id 前缀：02 的会话 id 一个都不变（R11） */
export const DEFAULT_WECOM_PREFIX = 'wecom:';

export const WEB_DEFAULT_DAILY_NEW = 500;
export const WEB_DEFAULT_DAILY_TURNS = 3000;

/** 启用的账号：状态是 active，启动时也没判出不能启用的原因 */
export function isEnabled(a: ChannelAccount): boolean {
  return a.status === 'active' && a.inactiveReason === null;
}

// ---------------- 欢迎语的 AI 显式标识（R19） ----------------

/** 第一句：到第一个句末标点或换行为止（与 00 的欢迎语自测同一个切法，另认半角的 ! 与 ?） */
const SENTENCE_END = /[。！？!?\n]/;
/** 转人工的说法：「人工」（不算「人工智能」）或「真人」，如现在的「回复「人工」即可转真人顾问」 */
const HANDOFF_PHRASE = /人工(?!智能)|真人/;

/**
 * R19：账号设置里的欢迎语（企微的 welcomeText、welcomeBackText，网页的 welcomeText）设了就要过 AI 显式标识的检查——第一句含「AI」、
 * 正文含转人工的说法。合格返回 null，不合格返回一句原因（不带原文）。启动装载不合格按没设处理并告警；第 15 步的命令行写入时以 1 拒绝
 */
export function checkWelcomeText(text: unknown): string | null {
  if (typeof text !== 'string') return '不是文字';
  const t = text.trim();
  if (!t) return '是空的';
  if (!(t.split(SENTENCE_END)[0] ?? '').includes('AI')) return '第一句没有写明「AI」';
  if (!HANDOFF_PHRASE.test(t)) return '正文没有转人工的说法';
  return null;
}

// ---------------- 账号的拼法 ----------------

const positiveInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** 设置里的一段欢迎语：没设返回 undefined；设了不合格也返回 undefined（按没设处理），并经 warn 记一句（只有账号 key 与设置名） */
function welcomeOf(raw: Record<string, unknown>, name: string, key: string, warn: (w: string) => void): string | undefined {
  const v = raw[name];
  if (v === undefined || v === null) return undefined;
  const bad = checkWelcomeText(v);
  if (bad === null) return v as string;
  warn(`账号 ${key} 的 ${name} 不合格（${bad}），按没设处理`);
  return undefined;
}

function wecomSettingsOf(raw: Record<string, unknown>, key: string, warn: (w: string) => void): WecomSettings {
  const out: WecomSettings = {};
  const poll = positiveInt(raw.pollIntervalMs);
  if (poll !== undefined) out.pollIntervalMs = poll;
  const welcome = welcomeOf(raw, 'welcomeText', key, warn);
  if (welcome !== undefined) out.welcomeText = welcome;
  const back = welcomeOf(raw, 'welcomeBackText', key, warn);
  if (back !== undefined) out.welcomeBackText = back;
  return out;
}

function webSettingsOf(raw: Record<string, unknown>, name: string, key: string, warn: (w: string) => void): WebSettings {
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name;
  const out: WebSettings = {
    title,
    dailyNewConversations: positiveInt(raw.dailyNewConversations) ?? WEB_DEFAULT_DAILY_NEW,
    dailyTurns: positiveInt(raw.dailyTurns) ?? WEB_DEFAULT_DAILY_TURNS,
  };
  const welcome = welcomeOf(raw, 'welcomeText', key, warn);
  if (welcome !== undefined) out.welcomeText = welcome;
  return out;
}

/** web_channel 关着时网页账号的 inactiveReason（R15）：/status 与命令行的 list 照这一句显示 */
export const WEB_CHANNEL_OFF_REASON = '开关 web_channel 关着（本阶段 prod 不开放网页渠道）';

/**
 * 库里的一行 → 进程内的账号。opts.webChannel 是 profile().flags.web_channel（R15）：关着时启用的网页账号带 inactiveReason。
 * 欢迎语不合格按没设处理，经 warn 记一句（R19）。不解密：凭据另经 openAccountSecrets
 */
export function accountFromRow(
  tenantId: string,
  row: ChannelAccountRow,
  opts: { webChannel: boolean; warn?: (w: string) => void },
): ChannelAccount {
  const warn = opts.warn ?? (() => {});
  const raw = (row.settings ?? {}) as Record<string, unknown>;
  const wecom =
    row.kind === 'wecom_kf'
      ? {
          corpId: row.corpId ?? '',
          openKfId: row.openKfid ?? '',
          idPrefix: row.idPrefix ?? '',
          recordOnlyUntil: row.recordOnlyUntil ? row.recordOnlyUntil.getTime() : null,
          settings: wecomSettingsOf(raw, row.key, warn),
        }
      : null;
  const web = row.kind === 'web' ? webSettingsOf(raw, row.name, row.key, warn) : null;
  const inactiveReason = row.kind === 'web' && row.status === 'active' && !opts.webChannel ? WEB_CHANNEL_OFF_REASON : null;
  return {
    id: row.id,
    tenantId,
    key: row.key,
    kind: row.kind,
    name: row.name,
    status: row.status,
    source: 'db',
    wecom,
    web,
    inactiveReason,
  };
}

/**
 * env 账号（R1）：文件存储，以及 db 存储下企微状态是「未导入」「已导出」时，由 WECOM_* 拼出。与 02 的企微适配器同一条件：
 * WECOM_CORP_ID、WECOM_APP_SECRET、WECOM_KF_OPEN_KFID 都有才有，否则 null。凭据不进账号对象（02 的适配器照旧每次现读 env）
 */
export function envAccountFrom(env: Readonly<Record<string, string | undefined>>, tenantId: string): ChannelAccount | null {
  const corpId = env.WECOM_CORP_ID;
  const openKfId = env.WECOM_KF_OPEN_KFID;
  if (!corpId || !env.WECOM_APP_SECRET || !openKfId) return null;
  const settings: WecomSettings = {};
  const poll = Number(env.WECOM_POLL_INTERVAL_MS);
  if (Number.isInteger(poll) && poll > 0) settings.pollIntervalMs = poll;
  return {
    id: ENV_ACCOUNT_ID,
    tenantId,
    key: ENV_ACCOUNT_KEY,
    kind: 'wecom_kf',
    name: '企微客服（env）',
    status: 'active',
    source: 'env',
    wecom: { corpId, openKfId, idPrefix: DEFAULT_WECOM_PREFIX, recordOnlyUntil: null, settings },
    web: null,
    inactiveReason: null,
  };
}

// ---------------- 从库里读出与解密 ----------------

const SYSTEM_ACTOR = { kind: 'system' as const, userId: null, name: null, ip: null };

/** 本租户的全部账号（任何状态），只读事务。行里有密文与标识：不打印整行 */
export function readChannelAccounts(db: Db, tenantId: string): Promise<ChannelAccountRow[]> {
  return withTenant(db, { tenantId, actor: SYSTEM_ACTOR }, (tx) => listChannelAccounts(tx), { readOnly: true });
}

/**
 * 解密一个企微账号的凭据（R9：AAD 绑定租户与账号 id，换到别的行解不开）。解不开抛 ChannelSecretError（message 里只有 key id 与
 * 失败类别）；行上缺密文或 key id（CHECK 本不允许）按「密钥不存在」报
 */
export function openAccountSecrets(ring: KeyRing, tenantId: string, row: ChannelAccountRow): Redacted<WecomSecrets> {
  if (!row.secretsCt || !row.secretsKeyId) throw new ChannelSecretError(row.secretsKeyId ?? '?', '密钥不存在');
  return openSecrets(ring, { tenantId, accountId: row.id }, row.secretsCt, row.secretsKeyId);
}

// ---------------- 装上的账号与查找 ----------------
// 启动装载判完企微状态之后整份换上（不留半装载：装载途中失败时这里还是空的）。企微状态在库里时是本租户全部企微账号
// （含停用的：它们名下的会话照样要按前缀认出来、推送返回 false，而不是落到默认账号上）与网页账号；未导入、已导出与文件存储时
// 是 env 账号（配齐时）与库里的网页账号

let installed: readonly ChannelAccount[] = [];

/** 仅供 src/channels/registry.ts：装载成功之后整份换上；自测的 reset 传空数组 */
export function installAccounts(list: readonly ChannelAccount[]): void {
  installed = Object.freeze([...list]);
}

/** 装上的全部账号（含没启用的） */
export function loadedAccounts(): readonly ChannelAccount[] {
  return installed;
}

/** 按 key 找账号：只返回启用的、种类对得上的（R12：/wecom/callback/:key 只认 wecom_kf，网页的 key 当作不存在） */
export function accountByKey(key: string, kind: ChannelKind): ChannelAccount | undefined {
  return installed.find((a) => a.key === key && a.kind === kind && isEnabled(a));
}

/**
 * 会话所属的账号（R11）：企微按 id 前缀最长匹配（任何状态的账号都参与匹配，停用账号的会话不会落到默认账号上；调用方再看是否启用）；
 * 网页看会话对象上的 channelAccountId。都没有时返回渠道的默认账号——企微是前缀为 wecom: 的那个（文件存储与还没导入时是
 * env 账号）；网页没有默认账号，返回 undefined。别的渠道（sim-）返回 undefined
 */
export function accountForSession(sessionId: string, s?: Pick<Session, 'channelAccountId'>): ChannelAccount | undefined {
  if (sessionId.startsWith('web:')) {
    const id = s?.channelAccountId;
    return id ? installed.find((a) => a.kind === 'web' && a.id === id) : undefined;
  }
  if (!sessionId.startsWith(DEFAULT_WECOM_PREFIX)) return undefined;
  let best: ChannelAccount | undefined;
  for (const a of installed) {
    const prefix = a.wecom?.idPrefix;
    if (!prefix || !sessionId.startsWith(prefix) || sessionId.length === prefix.length) continue;
    if (!best || prefix.length > (best.wecom?.idPrefix.length ?? 0)) best = a;
  }
  return best ?? installed.find((a) => a.wecom?.idPrefix === DEFAULT_WECOM_PREFIX);
}
