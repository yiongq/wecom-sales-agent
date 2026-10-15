// 06 R19：出口兜底。模型照旧写的「（起价，）按（最终）行程（和出发日期）微调」那半句让价格不作数，
// 也和代码模板（quote-template.ts）矛盾；报价轮里连「这是起价」一起不要（owner 已授权，第 17 步）。
//
//   · 报价轮 = 本轮有 create_quote 的结果（没报错的）：删「这是起价」（连它自己的标点）和「微调」那半句。
//   · 非报价轮（答已发链接的提问等）：只删「微调」那半句，其余原样（「链接里的价格是起价，大头不会变」照发）。
//   · 删完的残句要通顺：不留孤立的逗号，不留空括号，也不留只剩「起价」的项目符号行。
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

/** 「这是起价」连它后面紧跟的逗号类分隔符 */
const THIS_IS_FLOOR = '这是起价(?!格)[，,；;、]?';

function stripLine(line: string, quoteRound: boolean): string | null {
  const hedge = new RegExp(HEDGE);
  const floor = new RegExp(THIS_IS_FLOOR);
  if (!hedge.test(line) && !(quoteRound && floor.test(line))) return line;
  let t = line;
  // 报价轮：「这是起价」不要了（先删，后面的「最终按行程微调」才能当整句删）
  if (quoteRound) t = t.replace(new RegExp(THIS_IS_FLOOR, 'g'), '');
  t = t.replace(new RegExp(HEDGE, 'g'), '');
  // 「（起价，按最终行程微调）」删完剩「（起价）」：报价轮里括号和它前面的逗号一起删；非报价轮留着（起价这个说法本身没删）
  if (quoteRound) t = t.replace(/[，,]?[ \t]*[（(]\s*起价\s*[）)]/g, '');
  // 删空之后留下的悬空标点：「，。」「。。」、句号后面紧跟的逗号、重复的逗号、行首与行尾的标点、空括号
  t = t.replace(/[（(]\s*[）)]/g, '');
  t = t.replace(/[，,；;、]+([。！!？?～~）)])/g, '$1');
  t = t.replace(/([。！!？?～~])[，,；;、]+/g, '$1');
  t = t.replace(/([，,；;、])[，,；;、]+/g, '$1');
  t = t.replace(/([。！!～~])\1+/g, '$1');
  t = t.replace(/^(\s*(?:[·•\-*]\s*)?)[，,；;、。]+\s*/, '$1');
  t = t.replace(/[，,；;、]+[ \t]*$/, '');
  if (BARE_FLOOR.test(t) || NO_CONTENT.test(t)) return null;
  return t;
}

/**
 * 删出口里的对冲话：「按（最终）行程（和出发日期）微调」那半句；报价轮（quoteRound）还删「这是起价」。
 * 没有可删的时原样返回同一个字符串。
 */
export function dropQuoteHedge(text: string, quoteRound = true): string {
  const lines = text.split('\n');
  let touched = false;
  const out: string[] = [];
  for (const line of lines) {
    const next = stripLine(line, quoteRound);
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
