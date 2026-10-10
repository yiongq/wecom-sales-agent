// 04 R7、R8：执行器的文本、顺序、共享状态、副作用与 abort 契约。
import assert from 'node:assert/strict';
import type { GuardContext, GuardStep, StepVerdict } from '../pack-api.js';
import { loadGuardPipeline } from './execute.js';

function context(): GuardContext {
  return {
    session: {
      id: 'guard-fixture',
      channel: 'web',
      stage: 'greeting',
      profile: {},
      messages: [],
      orderIds: [],
      handedOver: false,
      createdAt: 0,
      updatedAt: 0,
    },
    text: '原文',
    turn: { flags: {} },
    toolSources: [],
    orderSources: [],
    brand: null,
    thresholds: {},
    createOrder: async () => {
      throw new Error('未提供建单能力');
    },
    enterHandoff: () => {
      throw new Error('未提供转人工能力');
    },
    callTool: async () => {
      throw new Error('未提供工具能力');
    },
  };
}

let count = 0;
const actions: StepVerdict[] = [
  { action: 'pass' },
  { action: 'drop_sentence', text: '删句后', removed: ['原文'] },
  { action: 'replace', text: '替换后' },
  { action: 'patch', text: '修补后' },
  { action: 'append', text: '追加后', added: ['补充'] },
  { action: 'strip', text: '' },
  { action: 'handoff', text: '转人工后', reason: '测试原因' },
];
const observed: string[] = [];
const rows: GuardStep[] = actions.map((verdict, index) => ({
  id: `step:${index}`,
  async run(ctx) {
    observed.push(ctx.text);
    await Promise.resolve();
    return verdict;
  },
}));
const result = await loadGuardPipeline(rows).run(context());
assert.deepEqual(observed, ['原文', '原文', '删句后', '替换后', '修补后', '追加后', '']);
assert.equal(result.text, '转人工后');
assert.equal(result.aborted, false);
assert.deepEqual(
  result.verdicts,
  actions.map((verdict, index) => ({ id: `step:${index}`, action: verdict.action })),
);
assert.ok(result.verdicts.every((verdict) => Object.keys(verdict).sort().join(',') === 'action,id'));
count++;

// 转人工裁决只带文本，不代替步骤经 context 转人工；上一组的默认副作用方法一旦调用就报错。
// abort 发生在接管检查；保留该检查的裁决，后续失败计数、消息与副作用均不运行。
for (const check of ['takeover_check:pre', 'takeover_check:post']) {
  const ctx = context();
  let failureRan = false;
  const pipeline = loadGuardPipeline([
    { id: 'before', run: () => ({ action: 'patch', text: '内部候选' }) },
    { id: check, run: () => ({ action: 'abort' }) },
    ...(check.endsWith(':pre') ? [{ id: 'takeover_check:post', run: (): StepVerdict => ({ action: 'pass' }) }] : []),
    {
      id: 'turn_failure',
      run: () => {
        failureRan = true;
        return { action: 'handoff', text: '不该发', reason: '失败' };
      },
    },
  ]);
  const aborted = await pipeline.run(ctx);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.text, '内部候选');
  assert.equal(failureRan, false);
  assert.deepEqual(aborted.verdicts, [
    { id: 'before', action: 'patch' },
    { id: check, action: 'abort' },
  ]);
  count++;
}

// 同一共享状态按声明先写后读；方法绑定本轮会话，由接入方提供确定性的实现。
const ctx = context();
const effects: string[] = [];
ctx.brand = { brandName: '测试品牌', advisorTitle: '顾问', aiTitle: 'AI 顾问', scopeNoun: '服务', identityLine: '我是 AI' };
ctx.thresholds = { minimum: 1000 };
ctx.createOrder = async (args) => {
  effects.push(`order:${args.item}`);
  return '{"orderId":"fixture"}';
};
ctx.enterHandoff = (record) => {
  effects.push(`handoff:${record.kind}`);
  ctx.session.handedOver = true;
};
ctx.callTool = async (name, args) => {
  effects.push(`tool:${name}`);
  const value = '{"ok":true}';
  ctx.toolSources.push({ name, args, result: value });
  return value;
};
const effectsResult = await loadGuardPipeline([
  {
    id: 'capture',
    writes: ['guardHit'],
    run: (c: GuardContext) => {
      c.turn.flags.guardHit = null;
      assert.equal(c.brand?.brandName, '测试品牌');
      assert.equal(c.thresholds, ctx.thresholds);
      return { action: 'pass' };
    },
  },
  {
    id: 'effects',
    after: ['capture'],
    reads: ['guardHit'],
    writes: ['guardHit'],
    async run(c: GuardContext) {
      assert.equal(c.turn.flags.guardHit, null);
      c.turn.flags.guardHit = 'price';
      assert.equal(await c.createOrder({ item: 'fixture' }), '{"orderId":"fixture"}');
      assert.equal(await c.callTool('fixture_lookup', { item: 'fixture' }), '{"ok":true}');
      c.enterHandoff({ kind: 'claimed', at: 0, reason: '测试' });
      return { action: 'handoff', text: '已转顾问', reason: '测试' };
    },
  },
  {
    id: 'after-handoff',
    reads: ['guardHit'],
    run: (c: GuardContext) => {
      assert.equal(c.turn.flags.guardHit, 'price');
      assert.equal(c.toolSources[0].name, 'fixture_lookup');
      assert.equal(c.session.handedOver, true);
      return { action: 'append', text: `${c.text}。补充说明` };
    },
  },
]).run(ctx);
assert.deepEqual(effects, ['order:fixture', 'tool:fixture_lookup', 'handoff:claimed']);
assert.equal(effectsResult.text, '已转顾问。补充说明');
assert.equal(effectsResult.aborted, false);
count++;

// 裁决每轮独立：可复用同一已装载流水线，不能把上轮数组或 abort 状态带过来。
const reused = loadGuardPipeline([{ id: 'check', run: (c: GuardContext) => ({ action: c.session.handedOver ? 'abort' : 'pass' }) }]);
const firstContext = context();
firstContext.session.handedOver = true;
const first = await reused.run(firstContext);
const second = await reused.run(context());
assert.equal(first.aborted, true);
assert.equal(second.aborted, false);
assert.notEqual(first.verdicts, second.verdicts);
assert.deepEqual(second.verdicts, [{ id: 'check', action: 'pass' }]);
count++;

// 注册后改原数组、声明与 run 不能使非法顺序混进已经校验的流水线。
const mutableRows: GuardStep[] = [{ id: 'original', after: [], run: () => ({ action: 'pass' }) }];
const captured = loadGuardPipeline(mutableRows);
mutableRows[0].id = 'changed';
mutableRows[0].after = ['missing'];
mutableRows[0].run = () => ({ action: 'abort' });
mutableRows.push({ id: 'late', run: () => ({ action: 'abort' }) });
assert.deepEqual((await captured.run(context())).verdicts, [{ id: 'original', action: 'pass' }]);
assert.ok(Object.isFrozen(captured.steps));
assert.ok(Object.isFrozen(captured.steps[0]));
assert.ok(Object.isFrozen(captured.steps[0].after));
count++;

// 步骤失败原样向外抛，禁止把异常记成放行或继续运行有副作用的步骤。
const error = new Error('步骤失败');
let laterRan = false;
await assert.rejects(
  loadGuardPipeline([
    {
      id: 'throw',
      run: async () => {
        throw error;
      },
    },
    {
      id: 'later',
      run: () => {
        laterRan = true;
        return { action: 'pass' };
      },
    },
  ]).run(context()),
  (caught) => caught === error,
);
assert.equal(laterRan, false);
count++;

// 后置接管检查之后原来是同步尾部；不能因执行器 await 同步裁决而引入接手竞态。
const tailContext = context();
const tailEvents: string[] = [];
await loadGuardPipeline([
  {
    id: 'async-business',
    async run() {
      await Promise.resolve();
      return { action: 'pass' };
    },
  },
  {
    id: 'takeover_check:post',
    run(c: GuardContext) {
      assert.equal(c.session.handedOver, false);
      tailEvents.push('check');
      queueMicrotask(() => {
        c.session.handedOver = true;
        tailEvents.push('external');
      });
      return { action: 'pass' };
    },
  },
  {
    id: 'turn_failure',
    run(c: GuardContext) {
      assert.equal(c.session.handedOver, false);
      tailEvents.push('failure');
      return { action: 'pass' };
    },
  },
  {
    id: 'final_clean',
    run(c: GuardContext) {
      assert.equal(c.session.handedOver, false);
      c.session.messages.push({ role: 'agent', content: c.text, at: 0 });
      tailEvents.push('save');
      return { action: 'pass' };
    },
  },
]).run(tailContext, {
  onVerdict(verdict) {
    tailEvents.push(verdict.id);
  },
  onComplete(result) {
    assert.equal(tailContext.session.handedOver, false);
    assert.equal(result.verdicts.length, 4);
    tailEvents.push('finish');
  },
});
assert.deepEqual(tailEvents, [
  'async-business',
  'check',
  'takeover_check:post',
  'failure',
  'turn_failure',
  'save',
  'final_clean',
  'finish',
  'external',
]);
assert.equal(tailContext.session.messages.length, 1);
count++;

assert.deepEqual(await loadGuardPipeline([]).run(context()), { text: '原文', aborted: false, verdicts: [] });
count++;
console.log(`guard execution selftest: ${count} 组通过（七种非 abort 裁决、两次接管 abort 与同步尾部）`);
