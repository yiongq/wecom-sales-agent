// 04 R7：组合根装载已排好序的步骤表时调用；校验不排序、不运行步骤。
import type { GuardContext, GuardStep } from '../pack-api.js';

export class GuardStepValidationError extends Error {
  constructor(
    readonly stepId: string,
    readonly conflictingStepId: string,
    reason: string,
  ) {
    super(`护栏步骤表冲突：${stepId} / ${conflictingStepId} — ${reason}`);
    this.name = 'GuardStepValidationError';
  }
}

export function validateGuardSteps<Context extends GuardContext>(steps: readonly GuardStep<Context>[]): void {
  const positions = new Map<string, number>();
  const writers = new Map<string, string>();
  for (const [index, step] of steps.entries()) {
    if (!step.id.trim()) throw new GuardStepValidationError(step.id, step.id, '步骤标识不能为空');
    if (positions.has(step.id)) throw new GuardStepValidationError(step.id, step.id, '步骤标识重复');
    positions.set(step.id, index);
    for (const key of step.writes ?? []) {
      if (!writers.has(key)) writers.set(key, step.id);
    }
  }

  const written = new Set<string>();
  for (const [index, step] of steps.entries()) {
    for (const dependency of step.after ?? []) {
      const position = positions.get(dependency);
      if (position === undefined || position >= index) {
        throw new GuardStepValidationError(step.id, dependency, 'after 指向缺失、自身或排在后面的步骤');
      }
    }
    // 只需已有一个先前的写者；同一键后面再次更新合法（如 injection → price 的 guardHit）。
    // 当前步骤的写声明不能为它自己的读声明提供初始化。
    for (const key of step.reads ?? []) {
      if (!written.has(key)) {
        throw new GuardStepValidationError(step.id, writers.get(key) ?? '<无写者>', `读取 flags.${key} 之前没有步骤写入`);
      }
    }
    for (const key of step.writes ?? []) written.add(key);
  }

  // 跟进表没有 turn_failure；主回复只要带失败计数，就必须先经过后置接管检查。
  const failure = positions.get('turn_failure');
  const takeover = positions.get('takeover_check:post');
  if (failure !== undefined && (takeover === undefined || takeover >= failure)) {
    throw new GuardStepValidationError('turn_failure', 'takeover_check:post', '后置接管检查必须排在交互失败判定之前');
  }
}
