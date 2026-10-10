// 工具分派契约：包钩子相对调用/结果记录的顺序、拒绝与错误边界、定义字节。
import assert from 'node:assert/strict';
import { createToolRegistry } from './registry.js';
import type { ToolCallRecorder, ToolSpec } from '../pack-api.js';

const events: unknown[] = [];
const ctx = { value: 0 };
const tool: ToolSpec<typeof ctx> = {
  def: { type: 'function', function: { name: 'fixture', description: '夹具', parameters: {} } },
  sideEffects: ['session'],
  cacheable: false,
  blocksRetry: false,
  async execute(args, context) {
    events.push(['execute', args, context === ctx]);
    context.value++;
    return JSON.stringify(args);
  },
};
const recorder: ToolCallRecorder = {
  recordCall: (name, args) => events.push(['call', name, args]),
  recordResult: (name, result) => events.push(['result', name, result]),
};
const registry = createToolRegistry([tool], {
  beforeTool(name, args, context) {
    events.push(['before', name, args, context === ctx]);
    return { args: { corrected: true } };
  },
  afterTool(name, result, context) {
    events.push(['after', name, result, context === ctx]);
  },
});
const result = await registry.execute('fixture', { original: true }, ctx, recorder);
assert.equal(result, '{"corrected":true}');
assert.deepEqual(
  [...events],
  [
    ['before', 'fixture', { original: true }, true],
    ['call', 'fixture', { corrected: true }],
    ['execute', { corrected: true }, true],
    ['result', 'fixture', result],
    ['after', 'fixture', result, true],
  ],
);
assert.equal(ctx.value, 1);
assert.equal(registry.get('fixture'), tool);
assert.equal(registry.get('missing'), undefined);
assert.equal(JSON.stringify(registry.defs), JSON.stringify([tool.def]));

// 拒绝仍是可回填给模型的工具结果，完整记录，但不执行工具。
events.length = 0;
const rejected = createToolRegistry([tool], {
  beforeTool: () => {
    events.push('before');
    return { reject: '参数不能用于下单' };
  },
  afterTool: () => {
    events.push('after');
  },
});
const error = await rejected.execute('fixture', {}, ctx, recorder);
assert.deepEqual(JSON.parse(error), { error: '参数不能用于下单' });
assert.deepEqual([...events], ['before', ['call', 'fixture', {}], ['result', 'fixture', error], 'after']);
assert.equal(ctx.value, 1);

// 无钩子时原参数对象直接传入，工具的原有参数补齐也保留。
const original = { corrected: false };
const mutating = createToolRegistry([
  {
    ...tool,
    async execute(args) {
      assert.equal(args, original);
      (args as typeof original).corrected = true;
      return 'ok';
    },
  },
]);
assert.equal(await mutating.execute('fixture', original, ctx), 'ok');
assert.equal(original.corrected, true);
assert.deepEqual(JSON.parse(await registry.execute('missing', {}, ctx)), { error: '未知工具: missing' });

// 抛错由现有调用方处理：有调用记录，没有伪造结果或 afterTool。
events.length = 0;
const failure = new Error('执行失败');
const failing = createToolRegistry(
  [
    {
      ...tool,
      async execute() {
        throw failure;
      },
    },
  ],
  {
    afterTool: () => {
      events.push('after');
    },
  },
);
await assert.rejects(failing.execute('fixture', {}, ctx, recorder), (e) => e === failure);
assert.deepEqual([...events], [['call', 'fixture', {}]]);
assert.throws(() => createToolRegistry([tool, tool]), /重复工具: fixture/);
console.log('tools registry selftest: 钩子顺序、参数修正、拒绝、异常与定义字节通过');
