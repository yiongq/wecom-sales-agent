// OpenTelemetry 的接线（02 spec「可观测性与告警 · OpenTelemetry（默认关闭）」、R24、不变量 49）：boot() 只在设了
// OTEL_EXPORTER_OTLP_ENDPOINT 时调 startOtelExport。src/otel/export.ts（连同 @opentelemetry/*）只经这里的动态 import() 加载；
// 本文件被 server.ts 静态 import，所以它自己不能静态 import src/otel/**（lint 的 check-boundaries 管着）。
// 每轮的会话引用、渠道、租户在这里取好交给 exportTurn：src/otel/ 只经 onTurnEnd 拿数据，不碰 store 与库。
import { createHmac, randomBytes } from 'node:crypto';
import { configMode, configRuntime, currentTenant } from '../config/source.js';
import { llmCfg } from '../llm.js';
import { conversationRef, getSession } from '../store.js';
import { onTurnEnd } from '../trace/recorder.js';

/**
 * gen_ai.provider.name（semantic-conventions-genai 的已知值表：已知值适用时必须用它，否则可以用自定义值）：LLM_PROVIDER 写了
 * 就用它（deepseek 是已知值；zhipu 是自定义值，表里没有智谱）；没写时按 LLM_BASE_URL 的主机名推：deepseek.com → deepseek，
 * bigmodel.cn 与没设（默认端点是智谱的）→ zhipu，其余是自定义值 openai_compatible（这个属性标识的是遥测格式的流派，
 * 别的地址都是按 OpenAI 兼容协议调的）
 */
export function providerName(): string {
  const p = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  if (p) return p;
  const base = process.env.LLM_BASE_URL;
  if (!base) return 'zhipu';
  let host = '';
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    /* 不是合法地址：按其余处理 */
  }
  const under = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
  if (under('deepseek.com')) return 'deepseek';
  if (under('bigmodel.cn')) return 'zhipu';
  return 'openai_compatible';
}

/**
 * 没有 ref 的会话（文件存储、demo 类会话）的匿名引用：HMAC-SHA256(进程启动导出时随机生成的密钥, 会话 id) 的前 16 个十六进制字符。
 * 不含客户标识（推不回会话 id 的任何一段），不同会话不会撞（短码只有末 4 位），同一进程里同一会话每轮相同；不用 Map 存，
 * 重启后会变。密钥只在开了导出时生成（没设端点的进程什么都不多做）
 */
function anonRefMaker(): (conversationId: string) => string {
  const key = randomBytes(32);
  return (id) => `anon-${createHmac('sha256', key).update(id).digest('hex').slice(0, 16)}`;
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
  const anonRef = anonRefMaker();
  onTurnEnd((f) => {
    const id = f.turn.conversationId;
    otel.exportTurn(f, {
      tenant,
      // db 存储的真实会话用会话行的 ref；文件存储与 demo 类会话没有 ref，用匿名引用：都不含会话原 id
      conversationRef: conversationRef(id) ?? anonRef(id),
      channel: getSession(id)?.channel ?? '',
      agent,
      provider,
      requestModel,
    });
  });
  console.log(`[otel] 已启用 OpenTelemetry 导出（原文${process.env.OTEL_CAPTURE_CONTENT === '1' ? '照写' : '不导出'}）`);
}
