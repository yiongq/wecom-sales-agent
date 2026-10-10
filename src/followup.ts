// R1：旧跟进入口保留签名与测试出口，调度和执行在 core。
export {
  FOLLOWUP_RETRY_MS,
  inQuietHours,
  deferQuiet,
  followupEnabled,
  followupStage,
  shouldFollowUp,
  followUpText,
  runFollowUpScan,
  startFollowUpScheduler,
  __followupTest,
  type FollowupMeta,
  type SessionWithFollowup,
} from './core/followup.js';
import { followupTemplates } from './packs/travel/followup.js';
import type { SalesStage } from './types.js';
export const FOLLOWUP_STAGES = Object.keys(followupTemplates.idleMinutes) as SalesStage[];
