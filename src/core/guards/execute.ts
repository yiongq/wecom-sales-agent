// 04 R7、R8：流水线只执行与记录裁决；存储、trace 和静默出口由调用方接入。
import type { GuardContext, GuardStep, GuardVerdict } from '../pack-api.js';
import { validateGuardSteps } from './validate.js';

export interface GuardRunResult {
  text: string;
  aborted: boolean;
  verdicts: GuardVerdict[];
}

export interface GuardPipeline<Context extends GuardContext> {
  readonly steps: readonly GuardStep<Context>[];
  run(ctx: Context): Promise<GuardRunResult>;
}

/** 装载时拒绝非法注册并捕获表的副本，不能靠事后改数组绕过校验。 */
export function loadGuardPipeline<Context extends GuardContext>(steps: readonly GuardStep<Context>[]): GuardPipeline<Context> {
  const loaded = Object.freeze(
    steps.map((step) =>
      Object.freeze({
        id: step.id,
        after: Object.freeze([...(step.after ?? [])]),
        reads: Object.freeze([...(step.reads ?? [])]),
        writes: Object.freeze([...(step.writes ?? [])]),
        run: step.run,
      }),
    ),
  );
  validateGuardSteps(loaded);

  return Object.freeze({
    steps: loaded,
    async run(ctx: Context): Promise<GuardRunResult> {
      const verdicts: GuardVerdict[] = [];
      for (const step of loaded) {
        const pending = step.run(ctx);
        // 同步步骤之间不插入 await：后置接管检查到失败判定、最终写消息须连续执行。
        const verdict = 'action' in pending ? pending : await pending;
        verdicts.push({ id: step.id, action: verdict.action });
        if (verdict.action === 'abort') return { text: ctx.text, aborted: true, verdicts };
        if (verdict.action !== 'pass') ctx.text = verdict.text;
      }
      return { text: ctx.text, aborted: false, verdicts };
    },
  });
}
