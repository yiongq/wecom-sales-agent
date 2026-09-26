// 选中的 CSV 文件按 UTF-8 严格解码（不依赖 React，console.selftest 直接 import）。
// File.text() 遇到坏字节会静默换成替换符：中文 Windows 上 Excel 默认另存的「CSV（逗号分隔）」是 GBK，表头是 ASCII 照样过，
// 中文格子变成一串替换符也「不为空」，整份乱码就被建成草稿，code 从此被占（产品库没有删除）。所以解不开就拒收
export class CsvEncodingError extends Error {}

/** 开头的 BOM 去掉（TextDecoder 默认如此）；不是合法 UTF-8 就抛 CsvEncodingError，说明怎么另存 */
export function decodeCsvFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvEncodingError('这个文件不是 UTF-8 编码（Excel 默认另存的 CSV 是 GBK）：请在 Excel 里另存为「CSV UTF-8（逗号分隔）」再选');
  }
}
