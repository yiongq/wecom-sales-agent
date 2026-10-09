// 结构化日志（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警 · 结构化日志」、R24、不变量 48）。
// LOG_FORMAT=json：pino 输出 JSON 行（time、level、msg，请求里带 req，轮次里带 tenant、conv、turn），boot() 与 profile-boot
// 把 console.log / info / warn / error 接过来（msg 是原来那一行字符串），现有日志不用逐行改就带上下文。
// LOG_FORMAT 没设：什么都不接，console 照旧打纯文本，一个字节都不变（自测与本机开发）。
// 日志里不出现会话原 id（里面是 external_userid）：会话写成 conv（db 存储的真实会话是会话行的 ref，其余是短码）；打会话的
// 日志行经 convLabel（prod 写 ref 或短码，demo 原样，与 logQuote 同一口径）。JSON 输出另有一道兜底：形如会话原 id 的串
// （wecom:、web:、sim- 开头）换成 ref 或短码，带凭据的查询参数与 Bearer 盖掉，以后新加的日志行漏了也出不去。
// pino 只在这里 import（check-boundaries 管着）。本模块不 import 业务模块：store 与配置源在加载时把会话 ref 与租户交进来。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { format } from 'node:util';
import type { MiddlewareHandler } from 'hono';
import pino from 'pino';
import { profile } from './profile.js';
import { shortIdOf } from './shared/conversation.js';

/** 请求与轮次的上下文（AsyncLocalStorage）：pino 的 mixin 从这里取字段 */
export interface LogContext {
  req: string;
  tenant: string;
  conv: string;
  turn: string;
}

export type LogFields = Record<string, unknown>;
export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** 上下文里另存会话 id：conv 在写日志的那一刻才换成 ref 或短码（新会话第一次落库之前就有 ref，见 store.conversationRef） */
interface Ctx extends Partial<LogContext> {
  conversationId?: string;
}
const ctxStore = new AsyncLocalStorage<Ctx>();

let refOf: (conversationId: string) => string | null = () => null;
let tenantSlug = '';

/** store 在加载时交进来：db 存储的真实会话的 ref（文件存储与 demo 类会话为 null，退回短码） */
export function setConvRefResolver(fn: (conversationId: string) => string | null): void {
  refOf = fn;
}
/** 配置源装上 DB 配置时交进来租户的 slug；文件配置模式没有租户，是空串 */
export function setLogTenant(slug: string): void {
  tenantSlug = slug;
}

/** 日志里的会话：db 存储的真实会话是会话行的 ref，其余是短码（与后台的短码同一规则），都不含会话原 id */
export function convCode(conversationId: string): string {
  let ref: string | null = null;
  try {
    ref = refOf(conversationId);
  } catch {
    ref = null;
  }
  return ref ?? (shortIdOf(conversationId) || '?');
}

/** 打会话的日志行用它：prod 下是 convCode（ref 或短码），demo 下原样（锁定的自测断言 demo 下的原 id），与 logQuote 同一口径 */
export function convLabel(conversationId: string): string {
  return profile().name === 'prod' ? convCode(conversationId) : conversationId;
}

/** prod profile 下返回「«N字»」（N 按字符数），demo 下原样返回 */
export function logQuote(text: string): string {
  return profile().name === 'prod' ? `«${[...text].length}字»` : text;
}

/**
 * 打解析失败之类的异常：JSON.parse 的消息里带着原文片段（可能是客户原话或会话 id）。prod 下只留错误名与位置，
 * demo 下原样交给 console（与原来逐字节相同）
 */
export function logError(e: unknown): unknown {
  if (profile().name !== 'prod') return e;
  if (!(e instanceof Error)) return typeof e;
  const pos = /\bposition (\d+)/.exec(e.message)?.[1];
  return pos ? `${e.name}（位置 ${pos}）` : e.name;
}

// 企微可带账号 key；每个冒号独立允许 URL 编码。web id 只认完整的 32 位小写十六进制，不截取更长 id 的前缀。
const RAW_CONV_ID =
  /\b(?:wecom(?::|%3[Aa])(?:[a-z][a-z0-9-]{1,30}(?::|%3[Aa]))?[A-Za-z0-9_-]+|web(?::|%3[Aa])[0-9a-f]{32}(?![A-Za-z0-9_-])|sim-[A-Za-z0-9_-]+)/g;

/** 文本里形如会话原 id 的串换成 convCode（JSON 输出的兜底与 prod 下的请求路径都用它） */
export function scrubConvIds(text: string): string {
  return text.replace(RAW_CONV_ID, (m) => convCode(m.replace(/%3[Aa]/g, ':')));
}

/** 文本里的会话原 id：prod 下换成 ref 或短码，demo 下原样（请求路径之类整段打出来的地方用） */
export function convLabelsIn(text: string): string {
  return profile().name === 'prod' ? scrubConvIds(text) : text;
}

const CENSOR = '[已遮盖]';
// 带凭据的查询参数（webhook 的 key、企微的 access_token / corpsecret）与 Authorization 的 Bearer（大小写不分；
// 分隔符允许真实空白或 JSON 转义之后的 \t、\n 两个字符——审查第 3 条）
const SECRET_PARAM = /([?&](?:key|access_token|corpsecret|secret|token|password)=)[^&\s"'\\]+/gi;
const BEARER = /\b(Bearer(?:\s|\\[tn])+)[A-Za-z0-9._~+/=-]+/gi;
// scheme://user:password@host 这类连接串（数据库、消息队列常见）：盖掉 user 与 host 之间的密码段（审查第 4 条）
const CONN_PASSWORD = /(:\/\/[^:/\s@"]+:)[^@\s"]+(@)/g;
// 自由文本里的 Cookie 请求头（不是 JSON 字段，是「Cookie: a=1; b=2」这种整段）：盖到这个 JSON 字符串片段结束为止（审查第 4 条）
const COOKIE_HEADER = /(\bCookie:\s*)[^"\\\r\n]*/gi;

/** pino 的 redact：凭据字段在顶层、往下一层、往下两层都盖住（字段名不分大小写的写法各列一个） */
const REDACT_KEYS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'x-api-key',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'token',
  'accessToken',
  'access_token',
  'webhook',
  'webhookUrl',
  'ALERT_WEBHOOK_URL',
  'NOTIFY_WEBHOOK_URL',
];
const keyPath = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`);
const REDACT_PATHS = REDACT_KEYS.flatMap((k) => {
  const p = keyPath(k);
  const dot = p.startsWith('[') ? '' : '.';
  return [p, `*${dot}${p}`, `*.*${dot}${p}`];
});
const REDACT_SET = new Set(REDACT_KEYS.map((k) => k.toLowerCase()));
// JSON 输出的兜底（审查第 2 条）：pino 的 redact 只接深度 0–2（见上面 REDACT_PATHS），再深一层就原样输出——这里不看深度，
// 直接在序列化之后的文本里找形如 "password":"…" 的片段（字段名同一张表，大小写不分），把值整段盖掉
const REDACT_KEY_ALT = [...REDACT_SET].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const REDACT_JSON_FIELD = new RegExp(`"(${REDACT_KEY_ALT})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, 'gi');

/** JSON 行写出之前的兜底：会话原 id 换成 ref 或短码，凭据（查询参数、Bearer、连接串密码、Cookie 头、任意深度的敏感字段）
 * 都盖掉。只在 LOG_FORMAT=json 时用，纯文本一个字节不动 */
function scrubLine(line: string): string {
  return scrubConvIds(line)
    .replace(SECRET_PARAM, `$1${CENSOR}`)
    .replace(BEARER, `$1${CENSOR}`)
    .replace(CONN_PASSWORD, `$1${CENSOR}$2`)
    .replace(COOKIE_HEADER, `$1${CENSOR}`)
    .replace(REDACT_JSON_FIELD, (_m, key: string) => `"${key}":"${CENSOR}"`);
}

/** mixin：请求里带 req；有会话的（轮次里，或包在 withConversationLog 里）带 tenant、conv，轮次里再带 turn */
function contextFields(): Record<string, string> {
  const c = ctxStore.getStore();
  if (!c) return {};
  const out: Record<string, string> = {};
  if (c.req) out.req = c.req;
  const conv = c.conv ?? (c.conversationId ? convCode(c.conversationId) : undefined);
  if (conv !== undefined || c.turn) {
    out.tenant = c.tenant ?? tenantSlug;
    if (conv !== undefined) out.conv = conv;
    if (c.turn) out.turn = c.turn;
  }
  return out;
}

/** 生产用的 pino：time（ISO）、level（名字）、msg，不带 pid 与主机名；写到给定的流（生产是 fd 1，同步写） */
function createJsonLogger(dest: pino.DestinationStream): pino.Logger {
  return pino(
    {
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: contextFields,
      redact: { paths: REDACT_PATHS, censor: CENSOR },
      hooks: { streamWrite: scrubLine },
    },
    dest,
  );
}

let jsonLogger: pino.Logger | null = null;
/** LOG_FORMAT=json 时第一次用到才建（同步写 fd 1：进程退出前的最后几行不丢）；没设时为 null */
function json(): pino.Logger | null {
  if (!jsonLogger && process.env.LOG_FORMAT === 'json') jsonLogger = createJsonLogger(pino.destination({ dest: 1, sync: true }));
  return jsonLogger;
}

let consoleHooked = false;
/**
 * LOG_FORMAT=json 时把 console.log / info / warn / error 接到 pino（同一行 JSON，msg 是 console 原本会打出的那一行），返回 true；
 * 没设时什么都不做、返回 false。可以调多次：profile-boot 在导入期就调（导入期的日志也是 JSON），boot() 照 spec 再调一次
 */
export function installJsonConsole(): boolean {
  const j = json();
  if (!j) return false;
  if (consoleHooked) return true;
  consoleHooked = true;
  console.log = (...a: unknown[]) => j.info(format(...a));
  console.info = (...a: unknown[]) => j.info(format(...a));
  console.warn = (...a: unknown[]) => j.warn(format(...a));
  console.error = (...a: unknown[]) => j.error(format(...a));
  return true;
}

/** 纯文本下的附带字段：凭据字段同样盖掉 */
function textFields(fields: LogFields): string {
  try {
    return JSON.stringify(fields, (k, v: unknown) => (k && REDACT_SET.has(k.toLowerCase()) ? CENSOR : v));
  } catch {
    return '[fields]';
  }
}

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields): void {
  const j = json();
  if (j) {
    if (fields) j[level](fields, msg);
    else j[level](msg);
    return;
  }
  const line = fields ? `${msg} ${textFields(fields)}` : msg;
  if (level === 'info') console.log(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}

/** LOG_FORMAT=json：pino 输出 JSON 行；未设：照旧打纯文本（经 console，自测照样收得到） */
export const log: Logger = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/** 请求与轮次的上下文（AsyncLocalStorage）：pino 的 mixin 从这里取字段。在已有的上下文上叠加 */
export function withLogContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  return ctxStore.run({ ...ctxStore.getStore(), ...ctx }, fn);
}

/** 这段代码在处理某个会话（企微的一条客户消息）：其中的日志带 tenant 与 conv（写日志时才按会话 id 取 ref 或短码） */
export function withConversationLog<T>(conversationId: string, fn: () => T): T {
  return ctxStore.run({ ...ctxStore.getStore(), conversationId }, fn);
}

/**
 * 轮次开始（recorder 的 startTurn 调）：把 conv 与 turn 记进当前上下文。recorder 的 withTurnScope 已为这一轮开了一层新的上下文，
 * 改它不影响外面的请求；不在任何上下文里时什么都不做
 */
export function noteTurnLog(conversationId: string, turnId: string): void {
  const c = ctxStore.getStore();
  if (!c) return;
  c.conversationId = conversationId;
  delete c.conv;
  c.turn = turnId;
}

/** 新的请求 id：16 个十六进制字符 */
function newRequestId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * 请求中间件（server.ts 与 console 的 Hono 应用都挂）：生成 req、写进响应头 x-request-id，这个请求里的日志都带它。
 * console 挂在 server.ts 下面时外层已经生成过，里层沿用同一个
 */
export const requestLogContext: MiddlewareHandler = async (c, next) => {
  const outer = ctxStore.getStore()?.req;
  const req = outer ?? newRequestId();
  c.header('x-request-id', req);
  if (outer) return next();
  await withLogContext({ req }, () => next());
  // 处理函数自己造了 Response（没经 c.header）时补上
  if (c.res.headers.get('x-request-id') !== req) {
    try {
      c.res.headers.set('x-request-id', req);
    } catch {
      /* 不可改的响应头：只有 fetch 拿回来的原样转发才会这样，这里没有 */
    }
  }
};

/** 仅供自测 */
export const __logTest = {
  createJsonLogger,
  contextFields,
  scrubLine,
  REDACT_PATHS,
};
