// 04 R1：旧模型入口只转发与接线；客户端进 core，旅游离线脚本进包。
import { chat as coreChat } from './core/llm/client.js';
import type { ChatOptions, Session } from './core/pack-api.js';
import { travelMock } from './packs/travel/mock.js';

export type { ChatTurn, PrefetchedCall, ChatOptions } from './core/pack-api.js';
export {
  observeRequests,
  llmCfg,
  CHEAP_TIER_MODELS,
  activeModels,
  llmStats,
  completeText,
  onLlmCall,
  __llmTest,
  type ObservedRequest,
  type CallTrace,
} from './core/llm/client.js';
export { findDepartDate } from './packs/travel/mock.js';

// 工具声明在第一次 chat 时才装载：静态引 tools 会连带提前初始化检索模块（EMBED_MODEL 等的读取时机提前）
let toolsModule: typeof import('./tools.js') | undefined;
const loadTools = async (): Promise<typeof import('./tools.js')> => (toolsModule ??= await import('./tools.js'));

export async function chat(opts: ChatOptions): Promise<string> {
  const { getToolSpec } = await loadTools();
  return coreChat(opts, { mock: travelMock, getToolSpec });
}

/** 旧引擎的 onReuse 签名适配；展示状态的业务判断由 ToolSpec 提供。只在 chat 的工具循环里回调，此时声明已装载。 */
export function reuseToolResult(name: string, result: string, session: Session): void {
  if (!toolsModule) throw new Error('reuseToolResult 只能在 chat 的工具循环里调用');
  toolsModule.getToolSpec(name)?.onReuse?.(result, { session, hints: {} });
}
