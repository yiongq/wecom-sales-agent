// 06 第 1 步：旅游包的主回复步骤顺序、新增放行步骤的锚点，以及 shape_check 必须在 takeover_check:post 之前的装载校验。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipelines-'));
process.env.VAR_DIR = dir;
process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { legacyTravelRuntime } = await import('../packs/registry.js');
const { packSources } = await import('../core/engine/sources.js');
const { packPipelines } = await import('../core/engine/pipelines.js');
const { GuardStepValidationError } = await import('../core/guards/validate.js');

const runtime = legacyTravelRuntime(packSources()).runtime;
const ids = (r: typeof runtime) => packPipelines(r).reply.steps.map((s) => s.id);

// 1) 完整顺序：spec「主回复步骤」的 32 项
const expected = [
  'pre_clean',
  'takeover_check:pre',
  'stage_advance',
  'other_order',
  'order_net',
  'link_whitelist',
  'markdown',
  'repair_links:mark',
  'dejargon',
  'custom_promise-a',
  'repair_links:fill',
  'handoff_claims',
  'injection',
  'encyclopedia',
  'unbacked_claims',
  'claim_words',
  'price',
  'stranded',
  'adults',
  'dangling',
  'advisor_prefix',
  'identity',
  'custom_promise-b',
  'post_handoff',
  'proposal_suffix',
  'closing',
  'shape_check',
  'takeover_check:post',
  'turn_failure',
  'final_clean',
  'system_note',
  'note_reply',
];
assert.deepEqual(ids(runtime), expected);

// 2) 新步骤的锚点
const steps = new Map(packPipelines(runtime).reply.steps.map((s) => [s.id, s]));
assert.deepEqual(steps.get('claim_words')!.after, ['unbacked_claims']);
assert.deepEqual(steps.get('price')!.after, ['claim_words']);
assert.deepEqual(steps.get('closing')!.after, ['proposal_suffix']);
assert.deepEqual(steps.get('shape_check')!.after, ['closing']);
assert.deepEqual(steps.get('takeover_check:post')!.after, ['shape_check']);
assert.deepEqual(steps.get('note_reply')!.after, ['system_note']);

// 3) 没设 shape_check 锚点的包：核心默认 shape_check 在 identity 之后、takeover_check:post 之前
const bare = ids({ ...runtime, replyAnchors: { markdown: 'link_whitelist', dangling: 'adults' } });
assert.ok(bare.indexOf('identity') < bare.indexOf('shape_check'));
assert.ok(bare.indexOf('shape_check') < bare.indexOf('takeover_check:post'));

// 4) 装载校验反例：shape_check 挪到 takeover_check:post 之后，启动失败
const swapped = {
  ...runtime,
  replyAnchors: { ...runtime.replyAnchors, 'takeover_check:post': 'closing', shape_check: 'takeover_check:post' },
};
assert.throws(
  () => packPipelines(swapped),
  (error: unknown) => {
    assert.ok(error instanceof GuardStepValidationError);
    assert.equal(error.stepId, 'shape_check');
    assert.equal(error.conflictingStepId, 'takeover_check:post');
    assert.match(error.message, /形状检查必须排在后置接管检查之前/);
    return true;
  },
);

// 5) 新增步骤本步不改文本（行为不变）
const ctx = { text: '原文', recordGuard() {} } as never;
for (const id of ['claim_words', 'closing', 'shape_check', 'note_reply']) {
  const verdict = await steps.get(id)!.run(ctx);
  assert.deepEqual(verdict, { action: 'pass' }, id);
}

console.log('pipelines 自测：32 步顺序、新步骤锚点、shape_check 装载校验通过');
