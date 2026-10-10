// 通用句子单元：保留原文偏移、区间波浪号和方案书链接的版本查询串。
/** 把回复切成句子——成交措辞只作用于它所在那一句，不该让整段的其他金额跟着作废 */
export function sentences(text: string): string[] {
  return text
    .split(/[。！!？?\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 按句号、问叹号、换行、分号、冒号切开的分句（带在原文里的起止位置）。库外目的地和金额 / 线路名在同一个分句里，
 * 才算说的是一回事：「南极我们暂时没有现成线路。\n最接近的是芬兰极光玻璃屋 8 日，人均 46,800 起」两句各说各的
 */
export function clauses(text: string): { s: string; start: number; end: number }[] {
  const out: { s: string; start: number; end: number }[] = [];
  const re = /[^。！!？?\n；;：:]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * 按句读切开（句号问叹号、句末波浪号、换行都算一句的结尾），每段带着自己的结尾符。半角「?」后面紧跟「v=数字」的是方案书链接的
 * 版本后缀（/proposal/…/2?v=2，02「报价快照」），不断句：断在这儿，删句会把「v=2」连着后半句删掉，链接退化成版本 1
 */
export function sentenceUnits(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let end = -1;
    if (c === '\n') end = i + 1;
    else if ('。！!？?'.includes(c) && !(c === '?' && /^v=\d/.test(text.slice(i + 1, i + 4)))) {
      end = i + 1;
      while (end < text.length && '。！!？?」”’）)'.includes(text[end])) end += 1;
    } else if (
      (c === '～' || c === '~') &&
      !/[\d一二两三四五六七八九十万千]/.test(text[i - 1] ?? '') &&
      !/^\s*[\d一二两三四五六七八九十]/.test(text.slice(i + 1))
    ) {
      // 「好的～您几位」的波浪号是句末语气；「2~3 万」「五万～六万」里的是区间，不断句
      end = i + 1;
      while (end < text.length && '～~'.includes(text[end])) end += 1;
    }
    if (end > 0) {
      out.push({ start, end });
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}
