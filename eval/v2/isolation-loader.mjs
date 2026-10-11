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
  return { ...result, source: source + '\n' + registration };
}
