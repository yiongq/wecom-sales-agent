/** 公开编号写法的归一，不用于生成条目 code。 */
export function normalizePartNo(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toUpperCase()
    .trim()
    .replace(/^(?:型号|型)\s*/u, '')
    .replace(/[X*✕]/g, '×')
    .replace(/[\s\-_/]/g, '');
}
