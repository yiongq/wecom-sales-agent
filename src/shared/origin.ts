// 看板的来源判定（07 spec R23）：成交、转人工按「真实客户 / 访客 / 种子」分开看，判定只在这一处，别处不许再写一遍前缀判断。
// 只读：不改会话与订单，也不碰种子平移（freshenDemoData）。种子前缀沿用 store 里的约定：会话 wecom:cust_、订单 ord_seed_。
// 本文件只能 import src/shared/（前后端共用）。

/** customer：standard 租户里的真实客户；visitor：宿主里 sim- 的网页访客，以及沙箱租户里自己聊的访客；seed：演示种子 */
export type Origin = 'customer' | 'visitor' | 'seed';

/** 三类来源的固定顺序（界面、接口的键序） */
export const ORIGINS = ['customer', 'visitor', 'seed'] as const satisfies readonly Origin[];

/** 看板的视图：三类来源加「全部」 */
export type OriginView = Origin | 'all';

/**
 * 一条会话或订单属于哪一类来源。
 * 种子：会话 id 以 wecom:cust_ 开头、订单号以 ord_seed_ 开头，或会话带 seed: true（沙箱开通时打标，种子会话在沙箱里也是 sbx- 开头）；
 * 访客：宿主里 sim- 开头的网页会话，以及沙箱租户里的其余会话（沙箱里没有真实客户）；
 * 真实客户：standard 租户里的其余会话。种子优先于访客：沙箱里打了标的种子不算访客。
 */
export function originOf(x: { sessionId: string; orderId?: string; seed?: boolean }, tenantKind: 'standard' | 'sandbox'): Origin {
  if (x.seed === true || x.sessionId.startsWith('wecom:cust_') || x.orderId?.startsWith('ord_seed_')) return 'seed';
  if (x.sessionId.startsWith('sim-') || tenantKind === 'sandbox') return 'visitor';
  return 'customer';
}
