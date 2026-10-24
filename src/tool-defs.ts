// function calling 的工具定义的类型（JSON Schema），纯类型、无副作用（01 spec「模块与依赖方向」）。
// 旅游的定义数据在 src/packs/travel/tool-defs.ts，旧入口 tools.ts 再导出它的 toolDefs（08 R5：只有包与门面能 import 包）。
// 请求前缀里的 tools 就是 JSON.stringify(toolDefs)：这份数据改一个字节，前缀缓存全部失效，tools_hash 也跟着变（启动时会生成一个 rerender 版本）。
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
