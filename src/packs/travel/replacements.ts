// 声明式替换表（07 R3）：用一份文字生成另一份文字，差异只写在表里，不手抄第二份。
// 每条 { from, to } 必须在当时的文字里恰好命中一次：0 次说明来源改了、表过期；多次说明 from 写得太宽。
// 两种都抛错。调用方在包装载时（模块顶层）调用，所以表和来源对不上时启动失败，而不是悄悄漂移。

export interface Replacement {
  from: string;
  to: string;
}

/** 按顺序逐条替换，每条恰好命中一次，否则抛错；what 写进错误信息，说明是哪一份文字 */
export function applyReplacements(text: string, table: readonly Replacement[], what: string): string {
  let out = text;
  for (const { from, to } of table) {
    const hits = from === '' ? 0 : out.split(from).length - 1;
    if (hits !== 1) throw new Error(`${what}：替换「${from}」应恰好命中一次，实际 ${hits} 次`);
    // 用函数形式：to 里的 $& 之类不当成替换元字符
    out = out.replace(from, () => to);
  }
  return out;
}
