import type { ToolDef } from '../../tool-defs.js';
import type { BrandProfile, ToolSpec } from '../pack-api.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 引擎已经替模型执行过的一次只读工具调用 */
export interface PrefetchedCall {
  name: string;
  args: Record<string, unknown>;
  /** 工具返回的 JSON 字符串，原样作为 tool 消息内容 */
  result: string;
}

export interface ChatOptions {
  system: string;
  /** 本轮已发布版本的品牌快照，仅供包 mock 使用，不额外进入 wire。 */
  brand?: BrandProfile | null;
  messages: ChatTurn[];
  tools: ToolDef[];
  /** 本轮强制走离线脚本（日预算耗尽时的降级，见 budget.ts） */
  forceMock?: boolean;
  /** 归属会话，用于按会话核算模型成本 */
  sessionId?: string;
  /** 执行工具并返回 JSON 字符串结果；副作用（建单/转人工）由调用方闭包处理 */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /**
   * 引擎已替模型执行过的只读工具调用。realChat 把它们还原成
   * 一条 assistant tool_calls 消息（id 为 prefetch_0、prefetch_1…）加对应的 tool 消息，
   * 接在最新 user 消息之后，模型「以为自己已经查过」，直接据结果回复——省掉一次往返。
   * 这些调用不经过 executeTool、不计副作用，所以**只能放只读工具**。mock 忽略。
   */
  prefetch?: PrefetchedCall[];
  /**
   * 同一轮里复用了之前同参数的查询结果、而这个工具中间又用别的参数查过时调用：executeTool 的展示状态副作用由调用方按复用的结果重放一遍，会话里记着的才是模型最后看的那次
   */
  onReuse?: (name: string, args: Record<string, unknown>, result: string) => void;
  /**
   * 每轮都会变的会话状态（阶段、画像、最近展示过的线路等）。**不要放进 system**：
   * system 在最前面，它一变，后面整段历史都吃不到前缀缓存。realChat 把它作为一条
   * 独立的 system 消息插在最新 user 消息之前。mock 忽略。
   */
  contextNote?: string;
}

/** 行业包提供离线对话；核心保留事务检查与请求观察。 */
export interface MockPolicy {
  chat(opts: ChatOptions): Promise<string>;
}

/** 由组合根/旧门面提供声明，核心不按行业工具名判断缓存与重试。 */
export interface LlmRuntime {
  mock: MockPolicy;
  getToolSpec(name: string): Pick<ToolSpec, 'cacheable' | 'blocksRetry'> | undefined;
}
