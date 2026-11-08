// 两种演练共用的验收数字；未观测到的值必须保持 null。report 子命令合并四次执行的结果。
export const metricNames = {
  containerKill: ['sent', 'replied', 'maxWaitMs', 'lockAcquiredMs', 'lockToServingMs', 'watchBeforeNormal', 'watchAfterNormal'],
  containerRolling: [
    'sent',
    'replied',
    'maxWaitMs',
    'lockAcquiredMs',
    'lockToServingMs',
    'rollbackRecovered',
    'watchBeforeNormal',
    'watchAfterNormal',
  ],
  processKill: [
    'sent',
    'replied',
    'maxWaitMs',
    'lockAcquiredMs',
    'lockToServingMs',
    'missingOutsideBoundary',
    'duplicateReplies',
    'unknownSegments',
    'boundarySegments',
  ],
  processTerminate: [
    'sent',
    'replied',
    'maxWaitMs',
    'lockAcquiredMs',
    'lockToServingMs',
    'pollStoppedMs',
    'listenerClosedMs',
    'dualProcessSentSegments',
    'spillEvents',
    'inFlightAtLoss',
    'oldProcessExited',
    'observationMs',
  ],
} as const;
export type Scope = keyof typeof metricNames;
export type Metrics = Record<string, number | null>;
export function emptyMetrics(scope: Scope): Metrics {
  return Object.fromEntries(metricNames[scope].map((key) => [key, null]));
}
export function metricsPass(scope: Scope, m: Metrics): boolean {
  if (!metricNames[scope].every((key) => typeof m[key] === 'number' && Number.isFinite(m[key]) && m[key]! >= 0)) return false;
  if (!m.sent || m.replied! > m.sent || m.lockToServingMs! > 5000) return false;
  if (scope === 'processKill')
    return (
      m.lockAcquiredMs! <= 1000 && m.missingOutsideBoundary === 0 && m.duplicateReplies === 0 && m.boundarySegments! <= m.unknownSegments!
    );
  if (m.replied !== m.sent) return false;
  if (scope === 'processTerminate')
    return (
      m.pollStoppedMs! <= 1000 &&
      m.listenerClosedMs! <= 1000 &&
      m.dualProcessSentSegments === 0 &&
      m.spillEvents === 0 &&
      m.oldProcessExited === 1 &&
      m.observationMs! >= 3000
    );
  if (m.watchBeforeNormal !== 1 || m.watchAfterNormal !== 1) return false;
  return scope === 'containerKill' ? m.lockAcquiredMs! <= 1000 : m.maxWaitMs! <= 15000 && m.rollbackRecovered === 1;
}
export interface DrillResult {
  scope: Scope;
  metrics: Metrics;
  scopeComplete: boolean;
  cleanupComplete: boolean;
}
export function acceptanceReport(results: DrillResult[]) {
  const scopes = Object.keys(metricNames) as Scope[];
  const metrics = Object.fromEntries(
    scopes.map((scope) => [scope, results.find((r) => r.scope === scope)?.metrics ?? emptyMetrics(scope)]),
  );
  return {
    metrics,
    acceptance10to12Complete: scopes.every((scope) => {
      const found = results.filter((r) => r.scope === scope);
      return (
        found.length === 1 &&
        found[0]!.scopeComplete === true &&
        found[0]!.cleanupComplete === true &&
        metricsPass(scope, found[0]!.metrics)
      );
    }),
  };
}
