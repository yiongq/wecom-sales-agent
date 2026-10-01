// 会话状态与短码（docs/features/console-ux/spec.md「接口改动」、不变量 17）：前后端共用，只依赖 src/shared。
// 全站只有这一处判定会话状态：服务端的过滤、计数和 console 的列表、首页、徽标、铃铛都调 conversationState，
// console 里不直接读 handedOver、也不拿 stage 和 'paid' 比（plan 第 3.3 步的检查拦这两种写法）。
// 已成交按租户行业包的终态（stages 里标了 terminal 的阶段）判定：旅游包是「已支付」paid，家装假包是「已付定金」deposit。
// 状态值仍叫 paid（接口的取值名不变），只是判定不再认 'paid' 这个阶段 key。
import type { ConversationRow, ConversationState } from './console-api.js';
import type { IndustryPack, SalesStageDef } from './pack.js';

/** 行业包的终态阶段，按包里的顺序：会话的阶段停在其中之一就算已成交 */
export function terminalStages(pack: Pick<IndustryPack, 'stages'>): SalesStageDef[] {
  return pack.stages.filter((s) => s.terminal === true);
}

/** paid（已成交）：stage 是行业包的终态；human（等人接手）：handedOver 且没成交；ai（AI 接待中）：其余 */
export function conversationState(
  row: Pick<ConversationRow, 'stage' | 'handedOver'>,
  pack: Pick<IndustryPack, 'stages'>,
): ConversationState {
  if (terminalStages(pack).some((s) => s.key === row.stage)) return 'paid';
  if (row.handedOver) return 'human';
  return 'ai';
}

/**
 * 会话的短码，如 wecom:cust_A01 → A01。与 public/admin.html 的 shortIdOf 同一规则，后台和工作台里能对上号：
 * 去掉 wecom:、sim-、cust / cust_ 前缀，只留字母数字，取最后 4 位转大写。没有字母数字时是空串
 */
export function shortIdOf(id: string): string {
  return id
    .replace(/^wecom:/, '')
    .replace(/^sim-/, '')
    .replace(/^cust_?/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
}
