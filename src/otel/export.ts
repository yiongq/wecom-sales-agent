// OpenTelemetry 导出（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警 · OpenTelemetry（默认关闭）」、R24、
// 不变量 49）。只在设了 OTEL_EXPORTER_OTLP_ENDPOINT 时由 boot() 经 src/ops/otel.ts 动态 import：没设端点时这个文件与
// @opentelemetry/* 一个都不加载、不起导出线程、不向外连接（lint 的 check-boundaries 管着：src/otel/ 之外不许静态 import 它们）。
//
// 每轮一条 trace，按轮次里记下的时刻补建（不在热路径上传播上下文）：根 span invoke_agent，下面是每次模型调用的 chat、每次工具
// 调用的 execute_tool、每个护栏事件的 guard。BasicTracerProvider + BatchSpanProcessor + OTLP/HTTP（JSON）导出器；端点、
// 请求头（Langfuse 的 Authorization）、超时、批处理参数照 OpenTelemetry 的标准环境变量（OTEL_EXPORTER_OTLP_*、OTEL_BSP_*）。
// 导出失败只记日志（一分钟至多一行），不影响对话；停机时在 drain 段 flush，受三段停机的总上限约束。
//
// 属性名核对的依据（2026-10-03）：OpenTelemetry semantic-conventions 1.43.0（JS 包 @opentelemetry/semantic-conventions@1.43.0
// 里的 GenAI 属性；这一版起 GenAI 部分标注迁往 open-telemetry/semantic-conventions-genai 仓库，名字没变）的 GenAI agent 与
// model span：gen_ai.operation.name（invoke_agent / chat / execute_tool）、gen_ai.agent.name、gen_ai.conversation.id、
// gen_ai.provider.name、gen_ai.request.model、gen_ai.response.model、gen_ai.usage.input_tokens / output_tokens、gen_ai.tool.name、
// gen_ai.tool.call.arguments、gen_ai.input.messages / gen_ai.output.messages、error.type；span 名照约定写「操作 对象」。
// Langfuse 的 OpenTelemetry 文档（langfuse-docs「Native OpenTelemetry · Attribute Mapping」，同日读取）：langfuse.session.id、
// langfuse.user.id、langfuse.trace.name，文档建议这几个写在 trace 的每个 span 上（按 span 过滤与聚合才准），所以每个 span 都写。
// 缓存命中的 token 照 spec 写 app.llm.cached_tokens：约定里已有 gen_ai.usage.cache_read.input_tokens，换不换等接 Langfuse 时按它
// 的计价口径定（input_tokens 照约定已含缓存命中的部分）。
//
// 原文默认不进 span：没设 OTEL_CAPTURE_CONTENT=1 时不写 gen_ai.input.messages、gen_ai.output.messages 与工具参数；设了才写本轮
// 客户原话、最终回复和工具参数，工具结果任何时候都不写。会话一律用 ref（调用方给的 conversationRef），任何时候不写会话原 id
// （里面是 external_userid）。只经 onTurnEnd 交来的那一轮拿数据，不 import src/db/**。
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { onShutdown } from '../shutdown.js';
import type { FinishedTurn } from '../trace/recorder.js';

/** 一轮之外、由接线（src/ops/otel.ts）给的上下文：都不含客户标识 */
export interface TurnMeta {
  /** 租户 slug；文件配置模式没有租户，为空串（不写） */
  tenant: string;
  /** 会话行的 ref（db 存储的真实会话）；文件存储与 demo 类会话是短码，与日志的 conv 同一口径 */
  conversationRef: string;
  channel: string;
  /** gen_ai.agent.name：行业包 id（行业包没有单独的助手名） */
  agent: string;
  /** gen_ai.provider.name */
  provider: string;
  /** 主对话的模型：对冲答出时 gen_ai.response.model 是对冲模型、request.model 仍是它 */
  requestModel: string;
}

const SERVICE = 'wecom-sales-agent';
const LOG_EVERY_MS = 60_000;

let provider: BasicTracerProvider | null = null;
let tracer: Tracer | null = null;
let breakNext = false;

/** 一分钟至多一行，其余计数，下一行带上「另有 N 次」 */
function throttled(): (line: string) => void {
  let last = 0;
  let suppressed = 0;
  return (line) => {
    const now = Date.now();
    if (now - last < LOG_EVERY_MS) {
      suppressed += 1;
      return;
    }
    console.warn(suppressed ? `${line}（之前一分钟里另有 ${suppressed} 次）` : line);
    last = now;
    suppressed = 0;
  };
}
const warnExport = throttled();
const warnBuild = throttled();
const warnFlush = throttled();

/** 错误只记类别：名字与码（ECONNREFUSED、HTTP 状态），不记原文（里面可能有端点地址） */
function errorLabel(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return code === undefined || code === null || code === '' ? e.name : `${e.name} ${String(code)}`;
}

/** 包一层导出器：失败只记日志，结果原样交回 BatchSpanProcessor（它丢掉这一批，不重放） */
class LoggedExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans, (r) => {
      // ExportResultCode.SUCCESS 是 0（@opentelemetry/core，不为一个常量多加一个直接依赖）
      if (r.code !== 0) warnExport(`[otel] 导出 ${spans.length} 个 span 失败（${errorLabel(r.error)}），这一批丢掉；对话不受影响`);
      done(r);
    });
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** BasicTracerProvider + BatchSpanProcessor + OTLP/HTTP 导出器；resource：service.name、service.version=APP_REVISION。重复调用什么都不做 */
export async function startOtel(): Promise<void> {
  if (provider) return;
  const exporter = new LoggedExporter(new OTLPTraceExporter());
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE, 'service.version': process.env.APP_REVISION || 'dev' }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  tracer = provider.getTracer(SERVICE, process.env.APP_REVISION || 'dev');
  // drain 段：normal 段等完在途的轮次之后，这时每一轮都已交给导出器；超出这一段的预算由 runShutdownHooks 截断
  onShutdown(() => shutdownOtel(), { phase: 'drain' });
}

/**
 * 把排着的 span 立刻导出（停机与自测用）；没起来时什么都不做。不 reject：导出失败（BatchSpanProcessor 这时会 reject）
 * 由导出器那一层记过日志了，别的原因（超时）在这里记
 */
export async function flushOtel(): Promise<void> {
  await provider?.forceFlush().catch((e: unknown) => warnFlush(`[otel] flush 没完成（${failLabel(e)}）；对话不受影响`));
}

/** 停机：flush 并关掉导出器，之后的轮次不再导出。不 reject，同 flushOtel */
async function shutdownOtel(): Promise<void> {
  const p = provider;
  provider = null;
  tracer = null;
  await p?.shutdown().catch((e: unknown) => warnFlush(`[otel] 停机时 flush 没完成（${failLabel(e)}）`));
}

/** forceFlush 的 reject 可能是一组错误（各个 processor 的） */
const failLabel = (e: unknown): string => (Array.isArray(e) ? e.map(errorLabel).join('、') : errorLabel(e));

const capture = (): boolean => process.env.OTEL_CAPTURE_CONTENT === '1';

/** gen_ai.input.messages / gen_ai.output.messages 的 JSON（约定的 parts 写法） */
const messages = (role: 'user' | 'assistant', text: string): string =>
  JSON.stringify([{ role, parts: [{ type: 'text', content: text }], ...(role === 'assistant' ? { finish_reason: 'stop' } : {}) }]);

/**
 * 由 onTurnEnd 的订阅者调（src/ops/otel.ts）：按这一轮记下的时刻补建一棵 span 树。spec 写的是 (TurnContext, outcome, meta)，
 * 这里收 onTurnEnd 交来的整轮（TurnContext 与 outcome 都在里面，另有根 span 要的耗时与 OTEL_CAPTURE_CONTENT 要的原话、回复）。
 * 不抛：出错只记日志
 */
export function exportTurn(f: FinishedTurn, meta: TurnMeta): void {
  if (!tracer) return;
  try {
    if (breakNext) {
      breakNext = false;
      throw new Error('模拟的构建失败');
    }
    build(tracer, f, meta);
  } catch (e) {
    warnBuild(`[otel] 这一轮没导出（${errorLabel(e)}）；对话不受影响`);
  }
}

function build(tr: Tracer, f: FinishedTurn, meta: TurnMeta): void {
  const t = f.turn;
  const content = capture();
  // Langfuse 的会话、用户与 trace 名：每个 span 都写（见文件头）
  const langfuse: Attributes = {
    'langfuse.session.id': meta.conversationRef,
    'langfuse.user.id': meta.conversationRef,
    'langfuse.trace.name': 'turn',
  };
  const rootAttrs: Attributes = {
    ...langfuse,
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': meta.agent,
    'gen_ai.provider.name': meta.provider,
    'gen_ai.conversation.id': meta.conversationRef,
    'app.turn.id': t.turnId,
    'app.turn.outcome': f.outcome,
    'app.channel': meta.channel,
  };
  if (meta.tenant) rootAttrs['app.tenant'] = meta.tenant;
  if (t.sopVersion !== null) rootAttrs['app.sop.version'] = t.sopVersion;
  if (t.prefixHash) rootAttrs['app.prefix.hash'] = t.prefixHash;
  if (content) {
    if (f.input) rootAttrs['gen_ai.input.messages'] = messages('user', f.input);
    if (f.finalText) rootAttrs['gen_ai.output.messages'] = messages('assistant', f.finalText);
  }
  const end = t.startedAt + f.durationMs;
  const root = tr.startSpan(
    `invoke_agent ${meta.agent}`,
    { kind: SpanKind.INTERNAL, startTime: t.startedAt, attributes: rootAttrs },
    ROOT_CONTEXT,
  );
  const parent = trace.setSpan(ROOT_CONTEXT, root);

  for (const c of t.llm) {
    const requestModel = c.hedged ? meta.requestModel : c.model;
    const attrs: Attributes = {
      ...langfuse,
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': meta.provider,
      'gen_ai.request.model': requestModel,
      'app.llm.hedged': c.hedged,
    };
    if (c.error) attrs['error.type'] = c.error;
    else {
      attrs['gen_ai.response.model'] = c.model;
      attrs['gen_ai.usage.input_tokens'] = c.promptTokens;
      attrs['gen_ai.usage.output_tokens'] = c.completionTokens;
      attrs['app.llm.cached_tokens'] = c.cachedTokens;
    }
    const span = tr.startSpan(`chat ${requestModel}`, { kind: SpanKind.CLIENT, startTime: c.startedAt, attributes: attrs }, parent);
    if (c.error) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(c.startedAt + c.ms);
  }

  for (const c of t.calls) {
    const attrs: Attributes = {
      ...langfuse,
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': c.name,
      'app.tool.prefetch': c.prefetch,
    };
    if (content) attrs['gen_ai.tool.call.arguments'] = JSON.stringify(c.args);
    tr.startSpan(`execute_tool ${c.name}`, { kind: SpanKind.INTERNAL, startTime: c.startedAt, attributes: attrs }, parent).end(
      c.startedAt + c.ms,
    );
  }

  // 护栏是出口上的同步改写，没有耗时：起止都是记下事件的那一刻
  for (const g of t.guards) {
    const attrs: Attributes = {
      ...langfuse,
      'app.guard.action': g.action,
      'app.guard.removed': g.removed.length,
      'app.guard.added': g.added.length,
    };
    tr.startSpan(`guard ${g.guard}`, { kind: SpanKind.INTERNAL, startTime: g.at, attributes: attrs }, parent).end(g.at);
  }

  if (f.outcome === 'error') root.setStatus({ code: SpanStatusCode.ERROR });
  root.end(end);
}

/** 仅供自测：让下一轮补建 span 时抛错（exportTurn 要兜住：这一轮不导出、只记日志，对话照常） */
export const __otelTest = {
  breakNextBuild(): void {
    breakNext = true;
  },
};
