// 会话列表的 search 参数（spec 路由表）：总览的业务数与阶段条带着 state、stage 跳过来（验收 10：点「报价」那一行，
// 只列报价阶段 AI 接待中的会话）。router.tsx 与总览自测都用它，所以单放一个文件：router.tsx 读 import.meta.env，
// 自测在 Node 里 import 不了它。页签、阶段条与 page 随第 13 步。
// 只 import 类型：src/shared/console-api.ts 的值会把它模块顶层的 zod schema 全带进入口集合
import type { ConversationState } from '../../src/shared/console-api.js';

/** 会话状态的取值；ConversationState 加减一种时这里不跟着改，typecheck 就失败 */
const CONVERSATION_STATE: Readonly<Record<ConversationState, true>> = { ai: true, human: true, paid: true };

export interface ConversationsSearch {
  state?: ConversationState;
  stage?: string;
}

/**
 * 取值不合规的参数丢掉：state 取 ConvQuery.state 的取值，stage 的写法与 ConvQuery.stage 相同。
 * 两个键总是写出来（不合规时是 undefined）：TanStack Router 把地址里原样的参数和这里的结果合在一起给 useSearch，
 * 不写出来的键会原样留着，「?state=bogus」就发给了接口
 */
export const conversationsSearch = (s: Record<string, unknown>): ConversationsSearch => ({
  state: typeof s.state === 'string' && Object.hasOwn(CONVERSATION_STATE, s.state) ? (s.state as ConversationState) : undefined,
  stage: typeof s.stage === 'string' && /^[a-z_]{1,32}$/.test(s.stage) ? s.stage : undefined,
});
