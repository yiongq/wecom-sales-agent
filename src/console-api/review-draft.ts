import type { RegressionDraft, ReviewReason } from '../shared/console-api.js';

/** 只接受枚举原因和公开包 id；源对话内容无法传入。 */
export function buildRegressionDraft(reason: ReviewReason, pack: string): RegressionDraft {
  return { _draft: true, format: 'review-v2', reason, case: { version: 2, pack, id: '', desc: '', tags: ['regression'], turns: [] } };
}
