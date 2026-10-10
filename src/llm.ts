// 04 R1：旧模型入口只转发与接线；客户端进 core，旅游离线脚本进包。
import { chat as coreChat } from './core/llm/client.js';
import type { ChatOptions, Session } from './core/pack-api.js';
import { travelMock } from './packs/travel/mock.js';
import { getToolSpec } from './tools.js';

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

export async function chat(opts: ChatOptions): Promise<string> {
  return coreChat(opts, { mock: travelMock, getToolSpec });
}

/** 旧引擎的 onReuse 签名适配；展示状态的业务判断由 ToolSpec 提供。 */
export function reuseToolResult(name: string, result: string, session: Session): void {
  getToolSpec(name)?.onReuse?.(result, { session, hints: {} });
}
