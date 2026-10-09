// 渠道层 v2 的共享类型（docs/architecture/03-channels-v2/spec.md「接口与数据流 · 渠道账号与凭据」）。
// 取值与 drizzle/ 里 channel_accounts、channel_inbox、outbound_sends 的 CHECK 一一对应；改这里要同时写新迁移。

export const CHANNEL_KINDS = ['wecom_kf', 'web'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** exported：channel-export 把企微状态交回了文件（R8、R13） */
export const CHANNEL_ACCOUNT_STATUSES = ['active', 'disabled', 'exported'] as const;
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

export const INBOX_KINDS = ['message', 'menu_click', 'enter_session', 'send_fail', 'legacy'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_STATES = ['received', 'recorded', 'replied', 'done', 'abandoned'] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export const INBOX_ABANDON_REASONS = ['too_old', 'poison', 'cold_start', 'restore_cutoff', 'resync'] as const;
export type InboxAbandonReason = (typeof INBOX_ABANDON_REASONS)[number];

export const OUTBOUND_STATUSES = ['pending', 'sending', 'accepted', 'rejected', 'unknown', 'failed', 'cancelled'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** 正式网页渠道的客户侧历史投影，不携带会话与成员标识。 */
export interface WebMessage {
  role: 'customer' | 'agent';
  text: string;
  at: number;
}
