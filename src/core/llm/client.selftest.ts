// 用行业无关工具验证模型循环读取声明，缓存命中绕过执行/钩子，重试不按工具名或副作用数量判断。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatOptions, LlmRuntime, ToolSpec } from '../pack-api.js';
import { createToolRegistry } from '../tools/registry.js';

const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-core-llm-'));
process.env.VAR_DIR = varDir;
for (const name of ['LLM_PROVIDER', 'ZHIPU_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_HEDGE_MODEL']) process.env[name] = '';
process.env.LLM_BASE_URL = 'https://model.invalid/v1';
process.env.LLM_API_KEY = 'fixture';
process.env.LLM_MODEL = 'glm-5.2';
process.env.LLM_MOCK = '0';
process.env.LLM_MAX_RETRY = '0';
const { chat, llmStats, observeRequests } = await import('./client.js');

type Context = { shown: string };
const ctx: Context = { shown: '' };
const events: string[] = [];
const makeTool = (name: string, cacheable: boolean, blocksRetry: boolean): ToolSpec<Context> => ({
  def: { type: 'function', function: { name, description: '夹具', parameters: {} } },
  sideEffects: ['session'],
  cacheable,
  blocksRetry,
  async execute(args, context) {
    events.push('execute');
    return (context.shown = JSON.stringify(args));
  },
  onReuse(result, context) {
    events.push('reuse');
    context.shown = result;
  },
});
const lookup = makeTool('lookup_fixture', true, false);
const save = makeTool('save_fixture', false, true);
const adjust = makeTool('adjust_fixture', false, false);
const registry = createToolRegistry([lookup, save, adjust], {
  beforeTool(_name, args) {
    events.push('before');
    return { args };
  },
  afterTool() {
    events.push('after');
  },
});
const runtime: LlmRuntime = {
  getToolSpec: registry.get,
  mock: { chat: async () => '包的离线回复' },
};
const opts: ChatOptions = {
  system: '固定前缀',
  messages: [{ role: 'user', content: '夹具输入' }],
  tools: registry.defs,
  executeTool: (name, args) => registry.execute(name, args, ctx),
  onReuse: (name, _args, result) => registry.get(name)?.onReuse?.(result, ctx),
};
let requests = 0;
let script: (() => Response)[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  requests++;
  assert.ok(script.length, '不允许脚本之外的请求');
  return script.shift()!();
};
function calls(name: string, args: Record<string, unknown>[]): () => Response {
  return () =>
    Response.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: args.map((a, i) => ({
              id: `call${requests}_${i}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(a) },
            })),
          },
        },
      ],
    });
}
const text = (content: string) => () => Response.json({ choices: [{ message: { role: 'assistant', content } }] });
try {
  // 每次命中计数；同名上次参数不同、命中较早缓存才重放一次展示状态。
  script = [calls('lookup_fixture', [{ item: 'A' }, { item: 'B' }, { item: 'A' }, { item: 'A' }]), text('完成')];
  const reusedBefore = llmStats().toolReused;
  assert.equal(await chat(opts, runtime), '完成');
  assert.deepEqual(events, ['before', 'execute', 'after', 'before', 'execute', 'after', 'reuse']);
  assert.equal(ctx.shown, '{"item":"A"}');
  assert.equal(llmStats().toolReused - reusedBefore, 2);

  // 预取与规范化键也适用于假包自己的工具，命中不经过工具钩子。
  events.length = 0;
  script = [calls('lookup_fixture', [{ second: 2, first: 1 }]), text('预取完成')];
  assert.equal(
    await chat({ ...opts, prefetch: [{ name: 'lookup_fixture', args: { first: 1, second: 2 }, result: '预取结果' }] }, runtime),
    '预取完成',
  );
  assert.deepEqual(events, []);
  assert.equal(llmStats().toolReused - reusedBefore, 3);

  // 不可缓存工具即使同参也执行两次；blocksRetry 为 true 时空文本只有一趟。
  events.length = 0;
  requests = 0;
  script = [calls('save_fixture', [{}, {}]), text('')];
  assert.equal(await chat(opts, runtime), '');
  assert.equal(requests, 2);
  assert.deepEqual(events, ['before', 'execute', 'after', 'before', 'execute', 'after']);

  // session 副作用并不自动禁止重试；声明 blocksRetry=false 时保留旧整轮重试语义。
  events.length = 0;
  requests = 0;
  script = [calls('adjust_fixture', [{}]), text(''), calls('adjust_fixture', [{}]), text('重试完成')];
  assert.equal(await chat(opts, runtime), '重试完成');
  assert.equal(requests, 4);
  assert.deepEqual(events, ['before', 'execute', 'after', 'before', 'execute', 'after']);

  // 被拒绝的 Promise 不缓存，下一次同参仍能真正执行并成功。
  events.length = 0;
  let attempts = 0;
  const failing = createToolRegistry([
    {
      ...lookup,
      async execute(args, context) {
        if (++attempts === 1) throw new Error('临时失败');
        return lookup.execute(args, context);
      },
    },
  ]);
  script = [calls('lookup_fixture', [{}]), calls('lookup_fixture', [{}]), text('恢复完成')];
  assert.equal(await chat({ ...opts, executeTool: (name, args) => failing.execute(name, args, ctx) }, runtime), '恢复完成');
  assert.equal(attempts, 2);

  // 核心直接接受注入的 mock，保留两条路径共同的请求观察，不装载旅游。
  requests = 0;
  let observed: unknown;
  observeRequests((req) => {
    observed = req;
  });
  assert.equal(await chat({ ...opts, forceMock: true }, runtime), '包的离线回复');
  assert.deepEqual(observed, { system: opts.system, tools: JSON.stringify(opts.tools) });
  assert.equal(requests, 0);
  observeRequests(null);
  assert.equal(script.length, 0);
  console.log('core llm selftest: 声明缓存/重试、钩子跳过、复用状态、预取、失败恢复与 mock 注入通过');
} finally {
  globalThis.fetch = originalFetch;
  process.once('exit', () => fs.rmSync(varDir, { recursive: true, force: true }));
}
