// 产品库 CSV 导入用的解析（01 spec「后台 API 与页面 · 产品库」：只建 draft，只收平铺字段，数组用「、」分隔）。
// RFC 4180：逗号分隔，双引号包住的字段里可以有逗号、换行，"" 表示一个引号；行尾 \r\n 或 \n 都认；开头的 BOM 去掉。
// 全空的行跳过（Excel 导出常在末尾多一行）。引号没闭合就抛
export class CsvSyntaxError extends Error {}

export function parseCsv(text: string): string[][] {
  const s = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (row.some((f) => f !== '')) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (s[i + 1] !== '\n') endRow();
    } else field += ch;
    i++;
  }
  if (quoted) throw new CsvSyntaxError('有一个双引号没有闭合');
  if (field !== '' || row.length) endRow();
  return rows;
}
