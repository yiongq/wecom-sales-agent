// OpenTelemetry 的接线（02 spec「可观测性与告警 · OpenTelemetry（默认关闭）」、R24、不变量 49）：boot() 只在设了
// OTEL_EXPORTER_OTLP_ENDPOINT 时调 startOtelExport。src/otel/export.ts（连同 @opentelemetry/*）只经这里的动态 import() 加载；
// 本文件被 server.ts 静态 import，所以它自己不能静态 import src/otel/**（lint 的 check-boundaries 管着）。
// 每轮的会话引用、渠道、租户在这里取好交给 exportTurn：src/otel/ 只经 onTurnEnd 拿数据，不碰 store 与库。
import { configMode, configRuntime, currentTenant } from '../config/source.js';
import { llmCfg } from '../llm.js';
import { shortIdOf } from '../shared/conversation.js';
import { conversationRef, getSession } from '../store.js';
import { onTurnEnd } from '../trace/recorder.js';

/**
 * gen_ai.provider.name：LLM_PROVIDER 写了就用它（zhipu、deepseek）；没写时是 LLM_BASE_URL 那组通用配置，默认端点是智谱的，
 * 指到别处就是约定里的 _OTHER
 */
function providerName(): string {
  const p = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  if (p) return p;
  const base = process.env.LLM_BASE_URL;
  if (!base) return 'zhipu';
  try {
    return new URL(base).hostname.endsWith('bigmodel.cn') ? 'zhipu' : '_OTHER';
  } catch {
    return '_OTHER';
  }
}

/** 动态加载导出器、startOtel，再订阅 recorder 的 onTurnEnd。失败由 boot() 记日志，进程照常启动、不导出 */
export async function startOtelExport(): Promise<void> {
  const otel = await import('../otel/export.js');
  await otel.startOtel();
  const db = configMode() === 'db';
  const tenant = db ? configRuntime().deps.tenantSlug : '';
  // 文件配置模式读 data/ 下的旅游 demo，没有租户行，行业包就是旅游包
  const agent = db ? currentTenant().pack.id : 'travel';
  const provider = providerName();
  const requestModel = llmCfg().model;
  onTurnEnd((f) => {
    const id = f.turn.conversationId;
    otel.exportTurn(f, {
      tenant,
      // db 存储的真实会话用会话行的 ref；文件存储与 demo 类会话没有 ref，用短码（与日志的 conv 同一口径），都不含会话原 id
      conversationRef: conversationRef(id) ?? (shortIdOf(id) || '-'),
      channel: getSession(id)?.channel ?? '',
      agent,
      provider,
      requestModel,
    });
  });
  console.log(`[otel] 已启用 OpenTelemetry 导出（原文${process.env.OTEL_CAPTURE_CONTENT === '1' ? '照写' : '不导出'}）`);
}
