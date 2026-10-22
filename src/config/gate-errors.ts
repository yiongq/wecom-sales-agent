// 07 发布闸的稳定错误码；供配置层、后台与面板共用。
export class GateError extends Error {
  constructor(
    readonly code: 'gate_required' | 'gate_failed' | 'gate_quota' | 'gate_active' | 'override_forbidden',
    readonly runId?: string,
  ) {
    super(code);
  }
}
export class GateSkippedError extends Error {}
