// 进内存之前的文本清洗（docs/architecture/02-conversations-workbench/spec.md「identity map 与写入 · 进内存之前的清洗」、不变量 16）。
// 客户文本、system 消息、转人工的 quote 与 reason 等所有截断都经它：内存里的字符串与库里的相同，
// 不含 U+0000（text 与 jsonb 都不收）与孤立代理项（json / jsonb 不收）。前后端共用，不 import 任何模块。

/** String.prototype.toWellFormed 是 ES2024（Node 20 起有），tsconfig 的 lib 停在 ES2023，这里单独声明 */
const wellFormed = (s: string): string => (s as string & { toWellFormed(): string }).toWellFormed();

/** UTF-16 码元是不是高位代理项 */
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 去掉 U+0000；按码点截断到 maxChars 个（成对的代理项算一个，不切开）；最后 toWellFormed()，孤立代理项换成 U+FFFD。
 * 不给 maxChars 只清洗、不截断
 */
export function cleanText(s: string, maxChars = Number.POSITIVE_INFINITY): string {
  let out = s.replaceAll(String.fromCharCode(0), '');
  // 码元数不超过上限时码点数也不超过：只有更长的才要逐个数
  if (out.length > maxChars) {
    let i = 0;
    for (let n = 0; n < maxChars && i < out.length; n += 1) {
      i += isHigh(out.charCodeAt(i)) && i + 1 < out.length && isLow(out.charCodeAt(i + 1)) ? 2 : 1;
    }
    out = out.slice(0, i);
  }
  return wellFormed(out);
}
