// 04 R2/R3：核心只认工具声明与钩子；缓存命中与是否重试由第 11 步模型循环决定。
import type { ToolCallRecorder, ToolContext, ToolHooks, ToolResult, ToolSpec } from '../pack-api.js';

export function createToolRegistry<Context = ToolContext>(tools: readonly ToolSpec<Context>[], hooks: ToolHooks<Context> = {}) {
  const byName = new Map<string, ToolSpec<Context>>();
  for (const tool of tools) {
    const name = tool.def.function.name;
    if (byName.has(name)) throw new Error(`重复工具: ${name}`);
    byName.set(name, tool);
  }
  // 只序列化 def，声明与钩子不进入模型前缀；顺序取自包传入的数组。
  const defs = tools.map((tool) => tool.def);
  return {
    defs,
    get: (name: string): ToolSpec<Context> | undefined => byName.get(name),
    async execute(name: string, args: unknown, ctx: Context, recorder?: ToolCallRecorder): Promise<ToolResult> {
      const tool = byName.get(name);
      const prepared = tool ? hooks.beforeTool?.(name, args, ctx) : undefined;
      // 被钩子拒绝的调用不记调用与结果、不调 afterTool：与原引擎一致，没执行的工具不能推动阶段与画像
      if (prepared && 'reject' in prepared) return JSON.stringify({ error: prepared.reject });
      const actualArgs = prepared && 'args' in prepared ? prepared.args : args;
      recorder?.recordCall(name, actualArgs);
      const result = !tool ? JSON.stringify({ error: `未知工具: ${name}` }) : await tool.execute(actualArgs, ctx);
      recorder?.recordResult(name, result);
      if (tool) hooks.afterTool?.(name, result, ctx);
      return result;
    },
  };
}
