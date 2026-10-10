// 跟在 tsx 后面的异步 load hook，清理函数与被加载模块处于同一词法作用域。
let targets;
export function initialize(entries) {
  targets = new Map(entries);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const target = targets.get(url);
  if (!target) return result;
  if (result.source == null) throw new Error(`v2 isolation: ${target.name} 无模块源码`);
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
  const registration = `;globalThis[Symbol.for('wecom.eval.v2.resets')].set(${JSON.stringify(target.name)}, async () => {${target.body}});\n`;
  if (target.name === 'store/pg-backend.ts') {
    // 文件模式不创建 PG 实例，模块加载时登记空回调；factory 创建实例时换成闭包里的实际清理。
    const anchor = /return\s*\{\s*mode:\s*['"]db['"]\s*,\s*install\s*\(/g;
    const matches = [...source.matchAll(anchor)];
    if (matches.length !== 1) throw new Error('v2 isolation: store/pg-backend.ts reset 定位失效；模块搬家后要同步改 eval/v2/isolation.ts');
    const at = matches[0].index;
    const inactive = `;globalThis[Symbol.for('wecom.eval.v2.resets')].set(${JSON.stringify(target.name)}, async () => {});\n`;
    return { ...result, source: source.slice(0, at) + registration + source.slice(at) + '\n' + inactive };
  }
  return { ...result, source: source + '\n' + registration };
}
