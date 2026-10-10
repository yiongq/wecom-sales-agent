// 本步裁决与旧改写事件分开：旗标/会话变化也可以裁决，旧事件仍只记文字变化。
import type { GuardStep, ReplyGuardContext, StepVerdict } from '../pack-api.js';

export function replyStep<Context extends ReplyGuardContext>(
  id: string,
  after: string,
  reads: readonly string[],
  writes: readonly string[],
  run: (ctx: Context) => void | StepVerdict | Promise<void | StepVerdict>,
  changedAction: 'strip' | 'replace' = 'strip',
): GuardStep<Context> {
  return {
    id,
    after: after ? [after] : [],
    reads,
    writes,
    run(ctx) {
      const before = ctx.text;
      let action: Exclude<StepVerdict['action'], 'pass' | 'abort'> | undefined;
      // 包/通用步骤不写 trace；兼容事件经 context 发出，保留基础标识与原有动作。
      const scoped = Object.create(ctx) as Context;
      Object.defineProperty(scoped, 'text', {
        get: () => ctx.text,
        set: (text: string) => {
          ctx.text = text;
        },
      });
      scoped.recordGuard = (guard, previous, text, next) => {
        if (previous !== text) action = next;
        ctx.recordGuard(guard, previous, text, next);
      };
      const finish = (explicit: void | StepVerdict): StepVerdict => {
        if (explicit) return explicit;
        if (!action && ctx.text !== before) action = changedAction;
        if (!action) return { action: 'pass' };
        if (action === 'handoff') return { action, text: ctx.text, reason: id };
        return { action, text: ctx.text };
      };
      const pending = run(scoped);
      return pending && 'then' in pending ? pending.then(finish) : finish(pending);
    },
  };
}
