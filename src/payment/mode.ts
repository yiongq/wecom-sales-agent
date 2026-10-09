// 收款方式（docs/architecture/02-conversations-workbench/spec.md「收款流程（价格确认闸）」、R19）。PaymentMode 定义在 conversation-types.ts
import { profile } from '../profile.js';
import type { PaymentMode } from '../shared/conversation-types.js';

/** mock_pay 开 → online（今天的模拟支付）；关 → advisor（顾问确认收款）。每次现读开关 */
export function paymentMode(): PaymentMode {
  return profile().flags.mock_pay ? 'online' : 'advisor';
}
