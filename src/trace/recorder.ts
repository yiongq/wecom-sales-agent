// 逐轮 trace 与护栏事件（docs/architecture/02-conversations-workbench/spec.md「逐轮 trace、护栏事件与用量」、R16）。
// 每处理一条客户消息收集一条轮次记录（确定性路径也记），两种会话存储都收集、只在内存；db 存储下真实会话的那一条在 endTurn 时
// 排进这个会话的下一次落库（写在存档点里，写失败只丢这几行），demo 类会话与文件存储下不入库。
// 数据从四处来：引擎（startTurn / noteGuard / endTurn、模型原稿、前缀）、onToolCall 的订阅者（工具调用）、llm.ts 的 onLlmCall
// （每次模型调用）、usage.ts 的 onUsage（每次调用的 token）。都在这一轮的异步上下文（AsyncLocalStorage）里同步送到。
// 读路径不查库（不变量 9）：这里只读内存（会话、已固定的产品库快照、已发布的 SOP），写入只经 store 的 queueTelemetry。
// trace 里有客户原话与工具参数（个人信息）：只按 spec 的字段存，日志里不打它们。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { catalogVersionKey, configMode, currentCatalog, currentSop } from '../config/source.js';
import { onLlmCall, type CallTrace } from '../llm.js';
import { noteTurnLog, withLogContext } from '../log.js';
import { sentenceUnits } from '../price-guard.js';
import { cleanText } from '../shared/text.js';
import { getSession, isDemoClassId, linkTurn, queueTelemetry, sessionStoreMode, type TelemetryRows } from '../store.js';
import { normalizeForStore } from '../store/project.js';
import type { ChatMessage, SalesStage } from '../types.js';
import type { TurnSignals } from '../handoff/triggers.js';
import { onUsage } from '../usage.js';

/** 一次工具调用：参数是执行时的那份，结果只留前 4,096 字节（按 UTF-8，不切开字符） */
export interface TraceCall {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  prefetch: boolean;
  resultHead: string;
  resultBytes: number;
  /** 开始时刻（毫秒时间戳）：只在内存，给 OpenTelemetry 补建 span 用（第 18 步），不进库、trace 行的形状不变 */
  startedAt: number;
  /** 执行时抛错（noteToolError）：只在内存，同 startedAt；OpenTelemetry 据此标出错 */
  failed?: true;
}
/** error：这次模型调用的失败类别；成功为 null。AI 出错率按它算（R24） */
export type LlmErrorKind = 'timeout' | 'rate_limited' | 'http_5xx' | 'bad_response' | null;
/** llm.ts 的 CallTrace 加用量 */
export interface TraceLlmCall {
  model: string;
  hedged: boolean;
  ms: number;
  tools: string[];
  toolMs: number;
  reused: string[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  error: LlmErrorKind;
  /** 开始时刻（毫秒时间戳，收到 onLlmCall 时减去 ms）：只在内存，同 TraceCall.startedAt */
  startedAt: number;
}
export interface GuardEvent {
  /** 改写点的名字（guard_events.guard 的 CHECK：^[a-z_]{2,40}$） */
  guard: string;
  action: 'drop_sentence' | 'replace' | 'patch' | 'append' | 'strip' | 'handoff';
  /** 按句对比得出，每句 ≤200 字 */
  removed: string[];
  added: string[];
  at: number;
}
export interface TurnContext {
  turnId: string;
  conversationId: string;
  startedAt: number;
  sopVersion: number | null;
  /** DB 配置模式下是已发布 SOP 的前缀哈希；文件配置模式下是这一轮请求的前缀哈希，没调模型的轮次为空串（文件配置模式不入库） */
  prefixHash: string;
  /** 本轮工具结果里出现过的产品库条目与其版本，如 { 'route:r-guizhou': 2 }（DB 配置模式；文件配置模式没有条目版本，为空） */
  catalogVersions: Record<string, number>;
  calls: TraceCall[];
  llm: TraceLlmCall[];
  guards: GuardEvent[];
  /** 模型原稿（chat() 的 raw）；没调模型的轮次为 null */
  draft: string | null;
}
export type TurnOutcome = 'replied' | 'silent' | 'handoff' | 'deterministic' | 'reset' | 'budget' | 'error';

/** endTurn 交给 onTurnEnd 订阅者的一轮 */
export interface FinishedTurn {
  turn: TurnContext;
  outcome: TurnOutcome;
  finalText: string;
  stageBefore: SalesStage | null;
  stageAfter: SalesStage | null;
  durationMs: number;
  /** 这一轮的交互失败信号（noteSignals）；没走到出口护栏的轮次为 null */
  signals: TurnSignals | null;
  /** 本轮客户原话（引擎经 startTurn 给的；企微非文本消息等没给的为空串）。只在内存，只给 OTEL_CAPTURE_CONTENT=1 的导出用（R24） */
  input: string;
}

interface PendingTool {
  call: TraceCall;
  args: Record<string, unknown>;
  t0: number;
}
interface Holder {
  ctx: TurnContext | null;
  ended: boolean;
  /** startTurn 时会话的阶段：出错的轮次没有引擎给的 stageBefore，用它 */
  stageBefore: SalesStage | null;
  /** 还没出结果的工具调用，按 onToolCall 收到的 args 对象认（引擎拿同一个对象去执行） */
  tools: PendingTool[];
  /** 本轮的模型调用（llm.ts 的 CallTrace，之后还会记上工具与复用）、它的用量与开始时刻 */
  llm: { trace: CallTrace; usage: Omit<TraceLlmCall, keyof CallTrace | 'startedAt'> | null; startedAt: number }[];
  /** 交互失败信号（turn_traces.signals） */
  signals: TurnSignals | null;
  /** 本轮客户原话（startTurn 给的），只在内存 */
  input: string;
}

const turns = new AsyncLocalStorage<Holder>();
const RESULT_HEAD_BYTES = 4096;
const SENTENCE_MAX = 200;

/**
 * 一轮的作用域（handleMessage 包在它里面）：开一个空的轮次，handleMessageInner 开头的 startTurn 填上它。
 * 这一轮抛错时记 outcome='error' 再原样抛出
 */
export function withTurnScope<T>(fn: () => Promise<T>): Promise<T> {
  const h: Holder = { ctx: null, ended: false, stageBefore: null, tools: [], llm: [], signals: null, input: '' };
  // 日志的上下文也为这一轮另开一层：startTurn 把 conv 与 turn 记进去（R24），不改外面请求的那一层
  return turns.run(h, () =>
    withLogContext({}, () =>
      fn().then(undefined, (e: unknown) => {
        if (h.ctx && !h.ended) finish(h, 'error', '', h.stageBefore, getSession(h.ctx.conversationId)?.stage ?? null);
        throw e;
      }),
    ),
  );
}

/** 当前这一轮（已 startTurn、还没 endTurn）；不在轮次里为 null */
function live(): Holder | null {
  const h = turns.getStore();
  return h?.ctx && !h.ended ? h : null;
}

/**
 * 引擎在 handleMessageInner 开头调；两种存储都收集（只在内存）。不在 withTurnScope 里（不经 handleMessage）时什么都不做。
 * input 是本轮客户原话：只留在内存、交给 onTurnEnd 的订阅者（OTEL_CAPTURE_CONTENT=1 时导出），不进 trace 行
 */
export function startTurn(conversationId: string, input = ''): void {
  const h = turns.getStore();
  if (!h || h.ctx) return;
  let sopVersion: number | null = null;
  let prefixHash = '';
  if (configMode() === 'db') {
    try {
      const sop = currentSop();
      sopVersion = sop.versionNo;
      prefixHash = sop.prefixHash;
    } catch {
      /* 配置源还没装载（只有自测会这样）：留空，调模型时 notePrefix 补 */
    }
  }
  h.ctx = {
    turnId: randomUUID(),
    conversationId,
    startedAt: Date.now(),
    sopVersion,
    prefixHash,
    catalogVersions: {},
    calls: [],
    llm: [],
    guards: [],
    draft: null,
  };
  h.stageBefore = getSession(conversationId)?.stage ?? null;
  h.input = input;
  // 这一轮的日志带 conv（ref 或短码）与 turn（这一条 trace 的 id），租户由 log.ts 补上
  noteTurnLog(conversationId, h.ctx.turnId);
}

/** 这一轮调模型时实际用的 SOP 版本与前缀哈希（引擎在 turnPrefix 之后调；轮内发布了新版本时以这次为准） */
export function notePrefix(sopVersion: number | null, prefixHash: string): void {
  const h = live();
  if (!h) return;
  h.ctx!.sopVersion = sopVersion;
  h.ctx!.prefixHash = prefixHash;
}

/** 模型原稿（chat() 的 raw，含 <state> 块）：去掉 NUL、修好孤立代理项，不截长度 */
export function noteDraft(raw: string): void {
  const h = live();
  if (h) h.ctx!.draft = cleanText(raw);
}

// 链接空位记号（engine.ts 的 HOLE，U+0001–U+0003）只在出口内部流转、发出前抹掉，按句对比时不算
const HOLE_MARKS = new RegExp(`[${String.fromCharCode(1)}-${String.fromCharCode(3)}]`, 'g');

/** 按句切开（与按句删的护栏同一套边界：price-guard 的 sentenceUnits），每句去掉首尾空白、空句不要 */
function sentencesOf(text: string): string[] {
  const t = text.replace(HOLE_MARKS, '');
  return sentenceUnits(t)
    .map((u) => t.slice(u.start, u.end).trim())
    .filter(Boolean);
}

/** 按句的多重集对比：before 里有、after 里没有的是删去的，反过来是补上的（同一句出现几次就按几次算） */
export function sentenceDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = sentencesOf(before);
  const b = sentencesOf(after);
  const minus = (from: string[], take: string[]): string[] => {
    const left = new Map<string, number>();
    for (const s of take) left.set(s, (left.get(s) ?? 0) + 1);
    const out: string[] = [];
    for (const s of from) {
      const n = left.get(s) ?? 0;
      if (n) left.set(s, n - 1);
      else out.push(cleanText(s, SENTENCE_MAX));
    }
    return out;
  };
  return { removed: minus(a, b), added: minus(b, a) };
}

/**
 * 出口每个改写点调一次。按句对比之后什么都没删、什么都没补（含 before === after）时什么都不记。
 * 只记事件，不改护栏的顺序与结果
 */
export function noteGuard(guard: string, before: string, after: string, action: GuardEvent['action']): void {
  const h = live();
  if (!h || before === after) return;
  const { removed, added } = sentenceDiff(before, after);
  if (!removed.length && !added.length) return;
  h.ctx!.guards.push({ guard, action, removed, added, at: Date.now() });
}

/**
 * 这一轮的交互失败信号（02 spec「确定性转人工触发」、R15）：引擎在出口护栏之后算好交给这里，trace 的 signals 列存它。
 * 确定性路径（安全网、紧急情况、负面情绪、重发链接）不走到出口护栏，signals 为 null
 */
export function noteSignals(s: TurnSignals): void {
  const h = live();
  if (h) h.signals = { ...s };
}

/** 结果的前 maxBytes 个 UTF-8 字节，不切开字符 */
function utf8Head(s: string, maxBytes: number): string {
  if (s.length * 3 <= maxBytes) return s;
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return s.slice(0, i);
}

/** 结果与参数里点到的条目 id（id、routeId、hotelId 三个键，往下看三层） */
function idsIn(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 3 || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) idsIn(x, out, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === 'id' || k === 'routeId' || k === 'hotelId') && typeof x === 'string') out.add(x);
    else if (x && typeof x === 'object') idsIn(x, out, depth + 1);
  }
}

/** 本轮工具结果里出现过的条目记下版本：取这一轮固定的快照（pinCatalogForTurn），只读内存。文件配置模式没有条目版本 */
function noteCatalogVersions(ctx: TurnContext, args: Record<string, unknown>, result: string): void {
  if (configMode() !== 'db') return;
  let versions: Readonly<Record<string, number>>;
  try {
    versions = currentCatalog().versions;
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return;
  }
  const ids = new Set<string>();
  idsIn(parsed, ids);
  // 参数里的 routeId（报价、方案书、下单的结果里没有 id 字段）只在这次调用没出错时算
  if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed)) idsIn(args, ids);
  for (const id of ids) {
    for (const key of [catalogVersionKey('route', id), catalogVersionKey('hotel', id)]) {
      const v = versions[key];
      if (typeof v === 'number') ctx.catalogVersions[key] = v;
    }
  }
}

/** onToolCall 的订阅者（引擎在模块加载时挂上）：记下这次调用，结果由 noteToolResult 补上 */
export function traceToolCall(name: string, args: Record<string, unknown>, _sessionId: string, meta?: { prefetch?: boolean }): void {
  const h = live();
  if (!h) return;
  const t0 = Date.now();
  const call: TraceCall = { name, args: {}, ms: 0, prefetch: !!meta?.prefetch, resultHead: '', resultBytes: 0, startedAt: t0 };
  h.ctx!.calls.push(call);
  h.tools.push({ call, args, t0 });
}

/** 引擎执行完一次工具（args 是交给 onToolCall 的同一个对象）：耗时、执行时的参数、结果的前 4 KB、条目版本 */
export function noteToolResult(args: Record<string, unknown>, result: string): void {
  const h = live();
  if (!h) return;
  const i = h.tools.findIndex((p) => p.args === args);
  if (i < 0) return;
  const [p] = h.tools.splice(i, 1);
  p!.call.ms = Date.now() - p!.t0;
  p!.call.args = normalizeForStore(args);
  p!.call.resultBytes = Buffer.byteLength(result, 'utf8');
  p!.call.resultHead = cleanText(utf8Head(result, RESULT_HEAD_BYTES));
  noteCatalogVersions(h.ctx!, args, result);
}

/**
 * 引擎执行一次工具时抛错（args 同上）：记下真实耗时、执行时的参数与只在内存的失败标记（不进库，trace 行的形状不变，
 * resultBytes 照旧是 0、没有结果）。不记的话这次调用在 finish 里只补参数，耗时是 0、看起来像成功
 */
export function noteToolError(args: Record<string, unknown>): void {
  const h = live();
  if (!h) return;
  const i = h.tools.findIndex((p) => p.args === args);
  if (i < 0) return;
  const [p] = h.tools.splice(i, 1);
  p!.call.ms = Date.now() - p!.t0;
  p!.call.args = normalizeForStore(args);
  p!.call.failed = true;
}

// llm.ts 在一次调用结束（成功或失败）时通知，带这次的耗时：开始时刻倒推出来
onLlmCall((c) => {
  const h = live();
  if (h) h.llm.push({ trace: c, usage: null, startedAt: Date.now() - c.ms });
});

// 主对话每次调用的 token：llm.ts 先通知 onLlmCall、再记用量，这一笔归最近一次还没有用量、同一模型的成功调用
onUsage((e) => {
  if (e.purpose !== 'chat') return;
  const h = live();
  const slot = h?.llm.findLast((x) => !x.usage && x.trace.error === null && x.trace.model === e.model);
  if (slot) {
    slot.usage = {
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      cachedTokens: e.cachedTokens,
      reasoningTokens: e.reasoningTokens,
    };
  }
});

const endObservers = new Set<(t: FinishedTurn) => void>();
/**
 * 轮次结束的订阅（自测用；OpenTelemetry 导出也挂在这里：设了 OTEL_EXPORTER_OTLP_ENDPOINT 时 boot() 经 src/ops/otel.ts
 * 动态 import src/otel/export.ts 再订阅，见第 18 步）。没人订阅时 endTurn 里只有一次判断
 */
export function onTurnEnd(fn: (t: FinishedTurn) => void): () => void {
  endObservers.add(fn);
  return () => endObservers.delete(fn);
}

type TraceRow = NonNullable<TelemetryRows['traces']>[number];
type GuardRow = NonNullable<TelemetryRows['guards']>[number];

function finish(
  h: Holder,
  outcome: TurnOutcome,
  finalText: string,
  stageBefore: SalesStage | null,
  stageAfter: SalesStage | null,
  reply?: ChatMessage,
): void {
  h.ended = true;
  const t = h.ctx!;
  const durationMs = Math.max(0, Date.now() - t.startedAt);
  // 没等到结果、也没记过失败的工具调用（还在执行，或成单安全网那处抛错，引擎那里没接 noteToolError）：参数照记
  for (const p of h.tools) p.call.args = normalizeForStore(p.args);
  h.tools = [];
  t.llm = h.llm.map(({ trace: c, usage, startedAt }) => ({
    model: c.model,
    hedged: c.hedged,
    ms: c.ms,
    tools: [...c.tools],
    toolMs: c.toolMs,
    reused: [...c.reused],
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    error: c.error,
    startedAt,
  }));
  // AI 回复消息经 WeakMap 关联 turnId（落库进 messages.turn_id）：与回复同一段同步代码里调，排出的那次落库取快照时已经关联上
  if (reply) linkTurn(reply, t.turnId);
  if (endObservers.size) {
    const done: FinishedTurn = {
      turn: t,
      outcome,
      finalText,
      stageBefore,
      stageAfter,
      durationMs,
      signals: h.signals,
      input: h.input,
    };
    for (const fn of endObservers) {
      try {
        fn(done);
      } catch {
        /* 订阅者出错不影响对话 */
      }
    }
  }
  // 文件存储与 demo 类会话：只在内存（R6、R16）
  if (sessionStoreMode() !== 'db' || isDemoClassId(t.conversationId)) return;
  const row: TraceRow = {
    id: t.turnId,
    conversationId: t.conversationId,
    startedAt: new Date(t.startedAt),
    durationMs,
    outcome,
    sopVersion: t.sopVersion,
    prefixHash: t.prefixHash,
    catalogVersions: { ...t.catalogVersions },
    stageBefore,
    stageAfter,
    draft: t.draft,
    finalText: finalText ? cleanText(finalText) : null,
    // 开始时刻与失败标记只在内存（OpenTelemetry 用），不进库：trace 行的 calls、llm 与第 9 步的形状相同
    calls: t.calls.map(({ startedAt: _s, failed: _f, ...c }) => c),
    llm: t.llm.map(({ startedAt: _s, ...c }) => c),
    signals: h.signals ? { ...h.signals } : null,
  };
  const guards: GuardRow[] = t.guards.map((g, ord) => ({
    turnId: t.turnId,
    ord,
    guard: g.guard,
    action: g.action,
    removed: [...g.removed],
    added: [...g.added],
  }));
  queueTelemetry(t.conversationId, { traces: [row], guards });
}

/**
 * 轮次结束：db 存储下把 trace 排进这个会话的下一次落库（demo 类会话不入库）；AI 回复消息经 WeakMap 关联 turnId。
 * reply 是这一轮写进会话的那条回复（确定性回复也算），没有回复（沉默）就不给。要在写进回复、saveSession 的同一段同步代码里调
 */
export function endTurn(
  outcome: TurnOutcome,
  finalText: string,
  stageBefore: SalesStage,
  stageAfter: SalesStage,
  reply?: ChatMessage,
): void {
  const h = live();
  if (h) finish(h, outcome, finalText, stageBefore, stageAfter, reply);
}
