// 04 R7：隔离的注册表夹具，不加载引擎、包或存储。
import assert from 'node:assert/strict';
import type { GuardStep } from '../pack-api.js';
import { loadGuardPipeline } from './execute.js';
import { GuardStepValidationError, validateGuardSteps } from './validate.js';

// plan「实施记录 · 第 1 步」主回复 28 行，标识与顺序逐行保留。
// reads/writes 仅登记跨步骤的 flags；visible → ctx.text，calls → toolSources，
// 会话与订单不算 flags；raw、客户原话、turnGen 等为捕获的输入。
// customHandoff → customPromise，beforeGuards → preDropSnapshot。
const replyTable: GuardStep[] = [
  { id: 'pre_clean', writes: ['emptyModelReply'] },
  { id: 'takeover_check:pre' },
  { id: 'stage_advance' },
  { id: 'other_order', writes: ['wantsOrder', 'friendsOwn'] },
  { id: 'order_net', reads: ['wantsOrder', 'friendsOwn'] },
  { id: 'link_whitelist' },
  { id: 'markdown' },
  { id: 'repair_links:mark' },
  { id: 'dejargon' },
  { id: 'custom_promise-a', writes: ['customPromise'] },
  { id: 'repair_links:fill', reads: ['customPromise'] },
  { id: 'handoff_claims', reads: ['customPromise'], writes: ['handedOverSelfDecided'] },
  { id: 'injection', reads: ['customPromise'], writes: ['guardHit'] },
  { id: 'encyclopedia', reads: ['customPromise'] },
  { id: 'unbacked_claims', reads: ['customPromise'], writes: ['preDropSnapshot', 'saidAll'] },
  { id: 'price', reads: ['customPromise', 'guardHit'], writes: ['guardHit'] },
  { id: 'stranded', reads: ['preDropSnapshot', 'customPromise'] },
  { id: 'adults', reads: ['saidAll'] },
  { id: 'dangling' },
  { id: 'advisor_prefix' },
  { id: 'identity' },
  { id: 'custom_promise-b', reads: ['customPromise'] },
  { id: 'post_handoff' },
  { id: 'proposal_suffix' },
  { id: 'takeover_check:post', reads: ['handedOverSelfDecided'] },
  { id: 'turn_failure', reads: ['emptyModelReply', 'guardHit'] },
  { id: 'final_clean' },
  { id: 'system_note' },
].map((row, index, rows) => ({
  ...row,
  after: index ? [rows[index - 1].id] : [],
  run: () => ({ action: 'pass' }),
}));

let count = 0;
function accepts(steps: GuardStep[]): void {
  assert.doesNotThrow(() => loadGuardPipeline(steps));
  count++;
}
function rejects(steps: GuardStep[], reader: string, conflict: string, reason: string): void {
  // 验证装载入口，拒绝发生在任何 run 之前；诊断里包含两个冲突标识。
  let ran = false;
  assert.throws(
    () =>
      loadGuardPipeline(
        steps.map((step) => ({
          ...step,
          run: () => {
            ran = true;
            return { action: 'pass' };
          },
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof GuardStepValidationError);
      assert.equal(error.stepId, reader);
      assert.equal(error.conflictingStepId, conflict);
      assert.ok(error.message.includes(reader));
      assert.ok(error.message.includes(conflict));
      assert.ok(error.message.includes(reason));
      return true;
    },
  );
  assert.equal(ran, false);
  count++;
}
const step = (id: string, declarations: Partial<GuardStep> = {}): GuardStep => ({ id, run: () => ({ action: 'pass' }), ...declarations });

assert.equal(replyTable.length, 28);
validateGuardSteps(replyTable);
accepts(replyTable);
accepts([]);
accepts([step('write', { writes: ['key'] }), step('read', { reads: ['key'] })]);
accepts([step('initial', { writes: ['key'] }), step('update', { reads: ['key'], writes: ['key'] }), step('read', { reads: ['key'] })]);
accepts([step('a'), step('b'), step('c', { after: ['a', 'b'] })]);
rejects([step('first', { after: ['later'] }), step('later')], 'first', 'later', 'after');
rejects([step('first', { after: ['missing'] })], 'first', 'missing', 'after');
rejects([step('self', { after: ['self'] })], 'self', 'self', 'after');
rejects([step('reader', { reads: ['late'] }), step('writer', { writes: ['late'] })], 'reader', 'writer', 'flags.late');
rejects([step('reader', { reads: ['missing'] })], 'reader', '<无写者>', 'flags.missing');
rejects([step('self', { reads: ['key'], writes: ['key'] })], 'self', 'self', 'flags.key');
rejects([step('same'), step('same')], 'same', 'same', '重复');
rejects([step(' ')], ' ', ' ', '不能为空');
rejects([step('turn_failure'), step('takeover_check:post')], 'turn_failure', 'takeover_check:post', '后置接管');
rejects([step('turn_failure')], 'turn_failure', 'takeover_check:post', '后置接管');
accepts([step('takeover_check:post'), step('turn_failure')]);

// 完整表的负例；只改夹具，不改开工表，也不靠 after 掩盖读写冲突。
rejects(
  replyTable.map((row) => (row.id === 'markdown' ? { ...row, after: ['identity'] } : row)),
  'markdown',
  'identity',
  'after',
);
rejects(
  replyTable.map((row) => (row.id === 'markdown' ? { ...row, reads: ['preDropSnapshot'] } : row)),
  'markdown',
  'unbacked_claims',
  'flags.preDropSnapshot',
);

console.log(`guard validation selftest: ${count} 项通过（含开工主回复 28 行夹具）`);
