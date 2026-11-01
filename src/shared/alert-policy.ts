// 17 R9：前后端共用固定白名单；不依赖服务端模块。
export type AlertSeverity = 'P1' | 'P2' | 'P3';

export type AlertKey =
  | 'reply_latency'
  | 'usage_limit'
  | 'erp'
  | 'attachment_limit'
  | 'model_errors'
  | 'wecom_send'
  | 'tenant_lock'
  | 'store'
  | 'jobs'
  | 'channel'
  | 'tenant_scope_missing'
  | 'sandbox_pool'
  | 'sandbox_purge'
  | 'sandbox_send_refused'
  | 'sandbox_wecom_full';

export const RUNBOOKS = {
  tenant_lock: { key: 'tenant_lock', code: 'RB-01', title: '租户锁丢失' },
  store: { key: 'store', code: 'RB-02', title: '写库冲突、积压与回放' },
  model_errors: { key: 'model_errors', code: 'RB-03', title: '模型调用失败' },
  wecom_send: { key: 'wecom_send', code: 'RB-04', title: '企微发送失败' },
  channel: { key: 'channel', code: 'RB-05', title: '渠道收发异常' },
  jobs: { key: 'jobs', code: 'RB-06', title: '后台任务失败' },
  reply_latency: { key: 'reply_latency', code: 'RB-07', title: '回复延迟升高' },
  erp: { key: 'erp', code: 'RB-08', title: '业务系统连接异常' },
  tenant_scope_missing: { key: 'tenant_scope_missing', code: 'RB-09', title: '租户作用域缺失' },
  sandbox_send_refused: { key: 'sandbox_send_refused', code: 'RB-10', title: '体验发送边界拒绝' },
  sandbox_purge: { key: 'sandbox_purge', code: 'RB-11', title: '体验清理积压' },
  usage_limit: { key: 'usage_limit', code: 'RB-12', title: '模型用量提醒' },
  attachment_limit: { key: 'attachment_limit', code: 'RB-13', title: '附件额度提醒' },
  sandbox_pool: { key: 'sandbox_pool', code: 'RB-14', title: '体验资源池提醒' },
  sandbox_wecom_full: { key: 'sandbox_wecom_full', code: 'RB-15', title: '微信体验名额已满' },
  host_restart: { key: 'host_restart', code: 'RB-16', title: '主机服务反复重启' },
  host_health: { key: 'host_health', code: 'RB-17', title: '主机健康检查失败' },
  host_disk: { key: 'host_disk', code: 'RB-18', title: '磁盘空间不足' },
  host_backup: { key: 'host_backup', code: 'RB-19', title: '备份失败或过期' },
  host_probe: { key: 'host_probe', code: 'RB-20', title: '业务拨测失败' },
  daily_digest: { key: 'daily_digest', code: 'RB-21', title: '每日摘要发送异常' },
} as const;
export type RunbookKey = keyof typeof RUNBOOKS;
export function isRunbookKey(key: string): key is RunbookKey {
  return Object.hasOwn(RUNBOOKS, key);
}

export const ALERT_POLICY = {
  reply_latency: { severity: 'P2', runbook: 'reply_latency' },
  usage_limit: { severity: 'P3', runbook: 'usage_limit' },
  erp: { severity: 'P2', runbook: 'erp' },
  attachment_limit: { severity: 'P3', runbook: 'attachment_limit' },
  model_errors: { severity: 'P2', runbook: 'model_errors' },
  wecom_send: { severity: 'P2', runbook: 'wecom_send' },
  tenant_lock: { severity: 'P1', runbook: 'tenant_lock' },
  store: { severity: 'P2', runbook: 'store' },
  jobs: { severity: 'P2', runbook: 'jobs' },
  channel: { severity: 'P2', runbook: 'channel' },
  tenant_scope_missing: { severity: 'P1', runbook: 'tenant_scope_missing' },
  sandbox_pool: { severity: 'P3', runbook: 'sandbox_pool' },
  sandbox_purge: { severity: 'P2', runbook: 'sandbox_purge' },
  sandbox_send_refused: { severity: 'P1', runbook: 'sandbox_send_refused' },
  sandbox_wecom_full: { severity: 'P3', runbook: 'sandbox_wecom_full' },
} as const satisfies Record<AlertKey, { severity: AlertSeverity; runbook: RunbookKey }>;
