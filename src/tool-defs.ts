// function calling 的工具定义（JSON Schema），纯数据、无副作用（01 spec「模块与依赖方向」）。
// 实现在 tools.ts，它再导出这里的 toolDefs。请求前缀里的 tools 就是 JSON.stringify(toolDefs)：
// 这份数据改一个字节，前缀缓存全部失效，tools_hash 也跟着变（启动时会生成一个 rerender 版本）。
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export { toolDefs } from './packs/travel/tool-defs.js';
