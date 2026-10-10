// 组合根按 after 合并包步骤与核心步骤；校验仍由原执行器负责。
import type { PackRuntime, GuardStep, ReplyGuardContext } from '../pack-api.js';
import { coreReplySteps } from '../guards/reply.js';
import { loadGuardPipeline } from '../guards/execute.js';

export function packPipelines(runtime: PackRuntime) {
  const pending: GuardStep<ReplyGuardContext>[] = [
    ...coreReplySteps().map((step) => (runtime.replyAnchors?.[step.id] ? { ...step, after: [runtime.replyAnchors[step.id]!] } : step)),
    ...runtime.replySteps,
  ];
  const steps: GuardStep<ReplyGuardContext>[] = [];
  while (pending.length) {
    const index = pending.findIndex((step) => (step.after ?? []).every((id) => steps.some((s) => s.id === id)));
    if (index < 0) {
      // 让校验器报告缺失或循环依赖涉及的标识。
      return { reply: loadGuardPipeline([...steps, ...pending]), followup: loadGuardPipeline(runtime.followupSteps) };
    }
    steps.push(pending.splice(index, 1)[0]!);
  }
  return { reply: loadGuardPipeline(steps), followup: loadGuardPipeline(runtime.followupSteps) };
}
