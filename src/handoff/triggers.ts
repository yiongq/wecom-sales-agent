// 旧版纯函数入口：算法与词表分开，签名保持不变。
import { handoffVocab } from '../packs/travel/handoff-vocab.js';
import { createHandoffTriggers } from './trigger-rules.js';
export type { EmergencyKind, SensitiveCategory, TurnSignals } from './trigger-rules.js';
export { createHandoffTriggers };
export const {
  emergencyOf,
  isQuestion,
  repeatedQuestion,
  turnFailed,
  FAILURE_WINDOW,
  failureThresholdReached,
  negativeLevel,
  SENTIMENT_WINDOW,
  sentimentThresholdReached,
  pushWindow,
  sensitiveCategoriesOf,
  consentWithdrawalOf,
} = createHandoffTriggers(handoffVocab);
