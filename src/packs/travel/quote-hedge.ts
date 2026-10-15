// 06 R19：报价轮的出口兜底。报价是工具算出的确定价，模型照旧写的「（起价，）按（最终）行程（和出发日期）微调」
// 那半句让价格不作数，也和代码模板（quote-template.ts）矛盾，所以只在报价轮里删掉。
//
//   · 报价轮 = 本轮有 create_quote 的结果（没报错的）。非报价轮（答已发链接的提问等）一个字都不动。
//   · 只删「微调」那半句，「这是起价」照留（锁定的 V2、V5 要它）。
//   · 删完只剩「起价」的项目符号行（如「· 起价」）整行删；括号里只剩「（起价）」的，括号一起删。
// 纯函数，没有模块级状态。

/** 「（，）（最终）按（最终）行程（和出发日期）微调」，带前面的逗号类分隔符 */
const HEDGE = '[，,；;、]?[ \\t]*(?:最终)?按(?:最终)?行程(?:和出发日期)?微调';

/** 一行里只剩「起价」（可带项目符号与句末标点）：整行没有信息量 */
const BARE_FLOOR = /^\s*(?:[·•\-*]\s*)?起价[。.！!～~]*\s*$/;
/** 一行里除了标点、符号和空白什么都没有 */
const NO_CONTENT = /^[\s·•\-*，,；;、。.！!？?～~（）()]*$/;

/** 本轮有没有 create_quote 的结果（报错的不算） */
export function isQuoteRound(calls: readonly { name: string; result?: string }[]): boolean {
  return calls.some((c) => c.name === 'create_quote' && !!c.result && !/"error"/.test(c.result));
}

function stripLine(line: string): string | null {
  const hedge = new RegExp(HEDGE, 'g');
  if (!hedge.test(line)) return line;
  let t = line.replace(new RegExp(HEDGE, 'g'), '');
  // 「（起价，按最终行程微调）」删完剩「（起价）」：括号和它前面的逗号一起删
  t = t.replace(/[，,]?[ \t]*[（(]\s*起价\s*[）)]/g, '');
  // 删空之后留下的悬空标点：「，。」「。。」、句号后面紧跟的逗号、行首的标点
  t = t.replace(/[，,；;、]+([。！!？?～~])/g, '$1');
  t = t.replace(/([。！!？?～~])[，,；;、]+/g, '$1');
  t = t.replace(/([。！!～~])\1+/g, '$1');
  t = t.replace(/^(\s*(?:[·•\-*]\s*)?)[，,；;、。]+\s*/, '$1');
  if (BARE_FLOOR.test(t) || NO_CONTENT.test(t)) return null;
  return t;
}

/** 删掉「按（最终）行程微调」那半句；没有这半句时原样返回同一个字符串 */
export function dropQuoteHedge(text: string): string {
  const lines = text.split('\n');
  let touched = false;
  const out: string[] = [];
  for (const line of lines) {
    const next = stripLine(line);
    if (next !== line) touched = true;
    if (next !== null) out.push(next);
  }
  if (!touched) return text;
  // 整行删掉后，前后各留的空行并成一个
  const joined = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return joined || text;
}
