// 08 第 7 步：通用单展示的合成夹具，后续建单与读者自测可复用。
import type { LineOrder } from '../../core/pack-api.js';

export function createFixtureLineOrder(): LineOrder {
  const attrs = Object.freeze({ 交期: '核验后确认' });
  return {
    v: 2,
    id: 'ord_fixture',
    sessionId: 'wecom:wmfixture',
    lines: [
      { kind: 'widget', code: 'w-a', version: 1, title: '合成方盒甲', qty: 200, unit: '件', unitPriceFen: 365, amountFen: 73000, attrs },
      { kind: 'widget', code: 'w-b', title: '合成方盒乙', qty: 50, unit: '件', unitPriceFen: 1200, amountFen: 60000 },
    ],
    totalFen: 133000,
    status: 'pending_payment',
    createdAt: 200,
  };
}
