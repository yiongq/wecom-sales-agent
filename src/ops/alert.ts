// 告警（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警 · 告警」、R24、不变量 32、50）。
// 推到 ALERT_WEBHOOK_URL（企微群机器人，text 消息），内容是「[实例名] 中文说明 · 时间」，只有计数、短码、错误码：不含客户原话、
// external_userid、密钥和带凭据的地址（地址只在 env 文件里，日志里也不打它）。
// 同一键在条件持续期间 30 分钟内至多一次；恢复发一条「已恢复」；条件变重（租户锁确认被别的进程持有）不受去重限制。
// 推送只在后台：5 秒超时、至多重试 2 次、失败只记日志，不抛、不阻塞请求与对话；没配地址只写一行 warn。另有一道总限流
// （每分钟至多 10 条，群机器人自己每分钟 20 条，watch.sh 与备份也推这个群）。
// app 侧五个键，触发与恢复逐条照 spec 的表：
//   model_errors  连续 5 次模型调用失败，或最近 50 轮里 AI 出错的轮次超过 20%；连续 10 次成功恢复
//   wecom_send    10 分钟内 3 个分段最终发送失败（账本 settle 的 rejected、unknown）；取不到 access_token 立即；10 分钟没有失败恢复
//   tenant_lock   锁进入 lost；确认被别的进程持有、开始停机时再发一条；锁重新拿到恢复
//   store         store_conflict、会话 poisoned（含 WindowCorruptError）、lagMs 超过 60 秒、停机写了 spill、10 分钟内丢了遥测行、
//                 启动时 spill 回放失败；lagMs 回到 5 秒以内恢复
//   jobs          retention_purge、handoff_notify 用完重试记 failed；没有恢复
//   channel       03 spec「可观测性」：启动装载那一条（网页账号因 web_channel 关着没有启用、欢迎语不合格按没设处理，只有
//                 账号 key 与原因）；10 分钟内有「没落库就发」（R6，03 第 8 步）、一组出站没过发送前的校验（R21 的同步校验）；
//                 拉取失败、入站卡住、sending 转 unknown 等由 03 第 13 步接上
import { onTokenError } from '../adapters/wecom.js';
import { channelStartupWarnings } from '../channels/registry.js';
import { configHealth, onLockEvent, type LockEvent } from '../config/source.js';
import { onJobFailed, type JobFailure } from '../jobs/runner.js';
import { scrubConvIds } from '../log.js';
import { onPlanRejected, onSendSettled, onUnsafeSend, type SendSettled } from '../quota/ledger.js';
import { onShutdown, onStoreIncident, storeCounters, storeHealth, type StoreHealth, type StoreIncident } from '../store.js';
import { onTurnEnd, type FinishedTurn } from '../trace/recorder.js';

export type AlertKey = 'model_errors' | 'wecom_send' | 'tenant_lock' | 'store' | 'jobs' | 'channel';

export interface AlertOpts {
  /** 发一条「已恢复」：这个键没在告警中时什么都不发 */
  resolved?: boolean;
  /** 条件变重（如租户锁确认被别的进程持有、开始停机）：不受 30 分钟去重限制 */
  escalate?: boolean;
}

const DEDUPE_MS = 30 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const TICK_MS = 5_000;

const timing = { timeoutMs: 5_000, retryDelaysMs: [1_000, 3_000] };
/** 至多重试几次（总共发 1 + RETRIES 次） */
const RETRIES = 2;

let clock: () => number = () => Date.now();

interface KeyState {
  active: boolean;
  lastSentAt: number;
}
const states = new Map<AlertKey, KeyState>();
const sentAt: number[] = [];
let lastThrottleLog = 0;
const inflight = new Set<Promise<void>>();

const instanceLabel = (): string => (process.env.INSTANCE_LABEL ?? '').trim() || 'wecom-sales-agent';

const pad = (n: number): string => String(n).padStart(2, '0');
/** 服务器时区的「YYYY-MM-DD HH:mm:ss」 */
function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 告警正文的兜底：形如会话原 id 的换成短码，地址整段去掉，长度封顶（群机器人的 text 至多 2048 字节） */
function safeText(text: string): string {
  return scrubConvIds(text)
    .replace(/\bhttps?:\/\/\S+/gi, '[地址已略]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

/** 只认错误码、错误名一类的短串，别的写「?」：告警里只有计数、短码与错误码 */
const codeOf = (s: string | null | undefined): string => (s && /^[\w.:-]{1,40}$/.test(s) ? s : '?');

/** 错误名与错误码（errno、cause 里的），不取 message：undici 的消息里带着地址与端口 */
function errName(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown';
  const cause = (e as { cause?: unknown }).cause as { code?: unknown } | undefined;
  const code = (e as { code?: unknown }).code ?? cause?.code;
  return typeof code === 'string' && /^[\w.-]{1,40}$/.test(code) ? `${e.name} ${code}` : e.name;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

async function send(url: string, content: string): Promise<void> {
  let last = '';
  for (let i = 0; i <= RETRIES; i++) {
    if (i > 0) await sleep(timing.retryDelaysMs[i - 1] ?? 0);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content } }),
        signal: AbortSignal.timeout(timing.timeoutMs),
      });
      const body = (await res.json().catch(() => null)) as { errcode?: unknown } | null;
      const errcode = typeof body?.errcode === 'number' ? body.errcode : 0;
      if (res.ok && errcode === 0) return;
      last = res.ok ? `errcode ${errcode}` : `HTTP ${res.status}`;
    } catch (e) {
      last = errName(e);
    }
  }
  console.error(`[alert] 告警没推出去（重试 ${RETRIES} 次仍失败：${last}）：${content}`);
}

/** 交给后台推送；没配地址只写一行 warn；超过总限流丢掉并记一行（一分钟至多一行） */
function deliver(content: string, t: number): void {
  const url = (process.env.ALERT_WEBHOOK_URL ?? '').trim();
  if (!url) {
    console.warn(`[alert] 没配 ALERT_WEBHOOK_URL，这条告警只记在日志里：${content}`);
    return;
  }
  while (sentAt.length && t - sentAt[0]! >= RATE_WINDOW_MS) sentAt.shift();
  if (sentAt.length >= RATE_MAX) {
    if (t - lastThrottleLog >= RATE_WINDOW_MS) {
      lastThrottleLog = t;
      console.warn(`[alert] 一分钟内已推了 ${RATE_MAX} 条告警，这条只记在日志里：${content}`);
    }
    return;
  }
  sentAt.push(t);
  const p: Promise<void> = send(url, content)
    .catch(() => undefined)
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

/**
 * 发到 ALERT_WEBHOOK_URL（企微群机器人，text 消息）。同一键在条件持续期间 30 分钟内至多一次；resolved 发一条「已恢复」。
 * 只发生在后台：5 秒超时、至多重试 2 次、失败只记日志，不抛、不阻塞请求与对话。没配 URL 时只写一行 warn 日志
 */
export function alert(key: AlertKey, text: string, opts: AlertOpts = {}): void {
  try {
    const t = clock();
    const st = states.get(key) ?? { active: false, lastSentAt: 0 };
    if (opts.resolved) {
      if (!st.active) return;
      st.active = false;
    } else {
      if (st.active && t - st.lastSentAt < DEDUPE_MS && !opts.escalate) return;
      st.active = true;
      st.lastSentAt = t;
    }
    states.set(key, st);
    deliver(`[${instanceLabel()}] ${opts.resolved ? '已恢复：' : ''}${safeText(text)} · ${stamp(t)}`, t);
  } catch (e) {
    console.error(`[alert] 告警处理出错（${errName(e)}），已忽略`);
  }
}

const isActive = (key: AlertKey): boolean => states.get(key)?.active ?? false;

// ---------------- model_errors ----------------

const MODEL_FAIL_STREAK = 5;
const MODEL_OK_STREAK = 10;
const MODEL_WINDOW = 50;
let failStreak = 0;
let okStreak = 0;
let streakKinds: string[] = [];
/** 最近 50 轮：这一轮 AI 出错了没有（llm 里有出错的调用，或 outcome 是 error；与运行数字的 AI 出错率同一口径） */
let recentTurns: boolean[] = [];

function onTurn(f: FinishedTurn): void {
  for (const c of f.turn.llm) {
    if (c.error) {
      failStreak++;
      okStreak = 0;
      streakKinds = [...streakKinds, c.error].slice(-MODEL_FAIL_STREAK);
    } else {
      okStreak++;
      failStreak = 0;
      streakKinds = [];
    }
  }
  recentTurns.push(f.outcome === 'error' || f.turn.llm.some((c) => c.error !== null));
  if (recentTurns.length > MODEL_WINDOW) recentTurns.shift();
  if (okStreak >= MODEL_OK_STREAK && isActive('model_errors')) {
    alert('model_errors', `AI 模型调用连续 ${okStreak} 次成功`, { resolved: true });
    // 窗口重新攒：恢复之后不因为窗口里还留着的旧错误马上又报
    recentTurns = [];
    return;
  }
  const bad = recentTurns.filter(Boolean).length;
  if (failStreak >= MODEL_FAIL_STREAK) {
    alert('model_errors', `AI 模型调用连续 ${failStreak} 次失败（${[...new Set(streakKinds)].join('、')}）`);
  } else if (recentTurns.length >= MODEL_WINDOW && bad * 5 > recentTurns.length) {
    alert('model_errors', `最近 ${recentTurns.length} 轮里 ${bad} 轮 AI 出错（${Math.round((bad / recentTurns.length) * 100)}%）`);
  }
}

// ---------------- wecom_send ----------------

const WECOM_WINDOW_MS = 10 * 60_000;
const WECOM_FAILS = 3;
let wecomFails: { at: number; result: 'rejected' | 'unknown'; errcode: number | null }[] = [];
let lastWecomFailAt = 0;

function onSettled(s: SendSettled): void {
  if (s.result === 'accepted') return;
  const t = clock();
  lastWecomFailAt = t;
  wecomFails = wecomFails.filter((f) => t - f.at < WECOM_WINDOW_MS);
  wecomFails.push({ at: t, result: s.result, errcode: s.errcode });
  if (wecomFails.length < WECOM_FAILS) return;
  const rejected = wecomFails.filter((f) => f.result === 'rejected').length;
  const codes = [...new Set(wecomFails.flatMap((f) => (f.errcode === null ? [] : [String(f.errcode)])))];
  alert(
    'wecom_send',
    `企微发送 10 分钟内 ${wecomFails.length} 个分段最终失败（rejected ${rejected}、unknown ${wecomFails.length - rejected}` +
      `${codes.length ? `，错误码 ${codes.map(codeOf).join('、')}` : ''}）`,
  );
}

function onToken(code: string): void {
  lastWecomFailAt = clock();
  alert('wecom_send', `取不到企微 access_token（${codeOf(code)}），收发消息都停了`);
}

// ---------------- channel（03 第 8 步：没落库就发、出站没过校验） ----------------

/** 「没落库就发」的告警至多 10 分钟一条（channel 键与启动装载那一条共用，那一条的 30 分钟去重不该把它压掉，所以这里自己限频） */
const UNSAFE_ALERT_MS = 10 * 60_000;
let lastUnsafeAlertAt = 0;

function onUnsafe(countIn10m: number): void {
  const t = clock();
  if (lastUnsafeAlertAt && t - lastUnsafeAlertAt < UNSAFE_ALERT_MS) return;
  lastUnsafeAlertAt = t;
  alert(
    'channel',
    `最近 10 分钟有 ${countIn10m} 段企微消息在发送状态没落库时照发（库写不进去，R6）：这期间进程崩溃的话这几段可能再发一次`,
    { escalate: true },
  );
}

function onRejected(reason: string): void {
  alert('channel', `一组企微出站没过发送前的检查（${safeCodes(reason)}），这一组没发，会话里已加说明`, { escalate: true });
}

// ---------------- tenant_lock ----------------

function onLock(ev: LockEvent): void {
  if (ev === 'lost') alert('tenant_lock', '租户锁连接断开：配置写入暂停、对话照常，正在重取');
  else if (ev === 'held') alert('tenant_lock', '租户锁重新取得，配置写入恢复', { resolved: true });
  else alert('tenant_lock', '租户锁已被另一个进程持有，本进程开始停机', { escalate: true });
}

// ---------------- store ----------------

const LAG_ALERT_MS = 60_000;
const LAG_OK_MS = 5_000;
const DROP_WINDOW_MS = 10 * 60_000;
let lagAlerted = false;
let poisonedSeen = new Set<string>();
let dropSamples: { at: number; n: number }[] = [];
let replayFailedSeen = 0;

/** 自测可以换掉读写库健康与计数的地方（积压要 60 秒才造得出来） */
let probe: { health: () => StoreHealth; counters: () => ReturnType<typeof storeCounters> } = {
  health: storeHealth,
  counters: storeCounters,
};

function onIncident(i: StoreIncident): void {
  if (i.kind === 'conflict')
    alert('store', `store_conflict：落库撞上另一写者（${safeCodes(i.detail)}），本进程优雅停机，没落库的写进 spill`);
  else alert('store', `停机时 ${i.sessions} 个会话没落库，退出时写进 spill 文件（下次启动先回放）`);
}

/** 短码与错误码之外的字一概不要（detail 是「会话 <短码>」） */
const safeCodes = (s: string): string => s.replace(/[^\w\s·:\-\p{Script=Han}]/gu, '').slice(0, 60);

function checkStore(t: number): void {
  const h = probe.health();
  if (h.conflict) alert('store', 'store_conflict：落库撞上另一写者，本进程优雅停机');
  const fresh = h.poisoned.filter((c) => !poisonedSeen.has(c));
  if (fresh.length) {
    for (const c of fresh) poisonedSeen.add(c);
    alert(
      'store',
      `会话 ${fresh.map(codeOf).join('、')} 停止落库（poisoned，${safeCodes(h.lastError ?? '原因见日志')}），内存照旧服务客户`,
    );
  }
  if (h.lagMs > LAG_ALERT_MS) {
    lagAlerted = true;
    alert('store', `写库积压 ${Math.round(h.lagMs / 1000)} 秒（${h.dirty} 个会话有没落库的改动）`);
  } else if (lagAlerted && h.lagMs <= LAG_OK_MS) {
    lagAlerted = false;
    if (!h.conflict && h.poisoned.length === 0) alert('store', '写库积压回到 5 秒以内', { resolved: true });
  }
  const c = probe.counters();
  if (!c) return;
  if (c.replayFailedFiles > replayFailedSeen) {
    replayFailedSeen = c.replayFailedFiles;
    alert('store', `启动时 ${c.replayFailedFiles} 个 spill 文件回放失败，已改名 .failed，需要人工处理`);
  }
  // 丢掉的遥测批次：第一次读到的是基线（startAlerts 时就读一次），之后比上一次多了就报，报的是最近 10 分钟里的批数
  const prev = dropSamples.at(-1)?.n;
  dropSamples = dropSamples.filter((s) => t - s.at <= DROP_WINDOW_MS);
  const before = dropSamples[0]?.n ?? prev ?? c.telemetryDropped;
  dropSamples.push({ at: t, n: c.telemetryDropped });
  if (prev !== undefined && c.telemetryDropped > prev) {
    alert('store', `最近 10 分钟有 ${c.telemetryDropped - before} 批遥测行（trace、护栏事件、发送账本）没写进库，已丢弃`);
  }
}

// ---------------- jobs ----------------

function onJob(f: JobFailure): void {
  if (f.kind) alert('jobs', `任务 ${f.kind} 用完重试次数，记 failed（${codeOf(f.lastError)}）`);
  else alert('jobs', `启动归位：${f.count} 个任务用完重试次数，记 failed`);
}

// ---------------- 接线 ----------------

function tick(): void {
  try {
    const t = clock();
    checkStore(t);
    if (lastWecomFailAt && t - lastWecomFailAt >= WECOM_WINDOW_MS) {
      lastWecomFailAt = 0;
      wecomFails = [];
      alert('wecom_send', '企微发送 10 分钟没有失败', { resolved: true });
    }
  } catch (e) {
    console.error(`[alert] 巡检出错（${errName(e)}），已忽略`);
  }
}

let started = false;
let timer: NodeJS.Timeout | null = null;

/** 挂上各处的订阅（模型、企微、租户锁、写库、任务）与每 5 秒一次的巡检。两种存储都挂，文件存储下与库相关的键自然不触发。可以调多次 */
export function startAlerts(): void {
  if (started) return;
  started = true;
  onTurnEnd(onTurn);
  onSendSettled(onSettled);
  onUnsafeSend(onUnsafe);
  onPlanRejected(onRejected);
  onTokenError(onToken);
  onLockEvent(onLock);
  onStoreIncident(onIncident);
  onJobFailed(onJob);
  // 停机：在途的推送（store_conflict、锁被拿走、drain 段末尾的 spill）等到 late 段的截止时刻，再退出
  onShutdown(
    async ({ deadline }) => {
      if (!inflight.size) return;
      await Promise.race([Promise.allSettled(inflight), sleep(Math.max(0, deadline - Date.now()))]);
    },
    { phase: 'late' },
  );
  // 启动之前就成立的：锁在装载途中就断了；回放失败的 spill 在第一次巡检里报
  if (configHealth().lock === 'lost') onLock('lost');
  // 03：渠道装载时判出的（R15 的网页账号没启用、R19 的欢迎语按没设处理），合成一条
  const channelWarnings = channelStartupWarnings();
  if (channelWarnings.length) alert('channel', `渠道账号启动检查：${channelWarnings.join('；')}`);
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

/** 仅供自测 */
export const __alertTest = {
  setClock(fn: (() => number) | null): void {
    clock = fn ?? (() => Date.now());
  },
  setTimings(t: { timeoutMs?: number; retryDelaysMs?: number[] }): void {
    if (t.timeoutMs !== undefined) timing.timeoutMs = t.timeoutMs;
    if (t.retryDelaysMs) timing.retryDelaysMs = t.retryDelaysMs;
  },
  timings: () => ({ ...timing, retries: RETRIES, dedupeMs: DEDUPE_MS, rateMax: RATE_MAX }),
  setProbe(p: { health: () => StoreHealth; counters: () => ReturnType<typeof storeCounters> } | null): void {
    probe = p ?? { health: storeHealth, counters: storeCounters };
  },
  /** 停掉每 5 秒的巡检（自测手动调 tick） */
  stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
  tick,
  /** 等在途的推送都结束 */
  async settle(): Promise<void> {
    while (inflight.size) await Promise.allSettled(inflight);
  },
  inflight: () => inflight.size,
  /** 清掉去重、限流与各键的计数（订阅不动） */
  reset(): void {
    states.clear();
    sentAt.length = 0;
    lastThrottleLog = 0;
    failStreak = 0;
    okStreak = 0;
    streakKinds = [];
    recentTurns = [];
    wecomFails = [];
    lastWecomFailAt = 0;
    lastUnsafeAlertAt = 0;
    lagAlerted = false;
    poisonedSeen = new Set();
    dropSamples = [];
    replayFailedSeen = 0;
  },
  isActive,
};
