// 15 第 1 步共享输入：静态构建与试用运维共用。这里只有契约，不执行发布、重置或发送。
export const PRODUCT_NAME = '单来';
export const PRODUCT_FOCUS = '工业询价';
export const PUBLIC_SITE_PAGES = ['/', '/product/', '/privacy/', '/terms/'] as const;
/** 尚未建的指南也要显式列名；构建不得回落为复制整个 docs。 */
export const PUBLIC_GUIDES = ['quick-start.md', 'bind-wecom.md', 'catalog.md', 'sales-sop.md', 'faq.md', 'changelog.md'] as const;
export interface ProductPublishInput {
  /** 由私有构建输入提供完整 HTTPS 基地址；公开源码不内置实际地址。 */
  bases: { www: string; app: string; docs: string };
  logoFile: string;
  faviconFile: string;
  legal: { privacyFile: string; termsFile: string; version: string; effectiveDate: string };
  applicationInstructions: string;
  sourceRepositoryUrl: string;
}
export const TRIAL_SEED_VERSION = 1;
export const TRIAL_SEED_ID_PATTERN = /^trialseed-[0-9a-f]{16}-[0-9a-f]{24}$/;
/** 订单 ≤64 字符；复用 originOf 的 ord_seed_ 来源识别，不是 isDemoClassId 的文件前缀。 */
export const TRIAL_ORDER_ID_PATTERN = /^ord_seed_[0-9a-f]{16}-[0-9a-f]{24}$/;
export const TRIAL_SEED_POLICY = {
  channel: 'simulator',
  seed: true,
  channelAccountId: null,
  retentionEligible: false,
  resetEligible: true,
  customerSend: false,
  advisorNotify: false,
} as const;
export interface TrialTenantAllowlistEntry {
  tenantId: string;
  slug: string;
  packId: 'industrial';
  kind: 'standard';
  isHost: false;
}
/** 全部合成，素材由 C 路建立；不存个人信息、不接 ERP，不携带实际报价金额。 */
export const TRIAL_SEED_MANIFEST = [
  { key: 'inquiry', scenario: '规格不完整，等待补充型号或数量', order: 'none' },
  { key: 'matching', scenario: '候选产品匹配与替代型号比较', order: 'none' },
  { key: 'quote-pending', scenario: '报价待人工审批', order: 'pending' },
  { key: 'quote-approved', scenario: '已批准报价与客户只读链接', order: 'approved' },
  { key: 'handoff', scenario: '询价转人工并由顾问接手', order: 'none' },
] as const;
export type TrialResetPhase = 'planned' | 'revoked' | 'erased' | 'seeded' | 'verified' | 'complete';
export const TRIAL_RESET_PHASES = [
  'planned',
  'revoked',
  'erased',
  'seeded',
  'verified',
  'complete',
] as const satisfies readonly TrialResetPhase[];
/** audit_log 追加事件的 diff：只有合成 id、内部 UUID 与进度；不存原始客户 id/内容/令牌。 */
export interface TrialResetCheckpoint {
  version: 1;
  batch: string; // 随机 8 字节的 16 位 hex；一次恢复必须沿用原批次。
  phase: TrialResetPhase;
  seedVersion: typeof TRIAL_SEED_VERSION;
  targetConversationRefs: string[];
  erasedConversationRefs: string[];
  seedIds: { key: (typeof TRIAL_SEED_MANIFEST)[number]['key']; sessionId: string; orderId: string | null }[];
}
export const TRIAL_RESET_AUDIT = { action: 'trial_reset.checkpoint', targetType: 'trial_reset' } as const;
