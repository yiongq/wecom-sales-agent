// 选中的 CSV 文件怎么解码（不依赖 React，自测直接 import）。
// File.text() 遇到坏字节会静默换成替换符：中文 Windows 上 Excel 默认另存的「CSV（逗号分隔）」是 GBK，表头是 ASCII 照样过，
// 中文格子变成一串替换符也「不为空」，整份乱码就被建成草稿，code 从此被占（产品库没有删除）。所以只按严格的解码器读：
// - decodeCsvFile：01 的写法，只认 UTF-8（console.selftest 里 01 的回归用例还在用）；
// - readCsvBytes：后台 UX spec「CSV 导入」的写法，先按 UTF-8 严格解码，不成再按 gb18030（GBK 的超集）严格解码，
//   两种都解不开才拒收。导入弹窗的文件行据 encoding 写「按UTF-8读取」「按GBK读取」
export class CsvEncodingError extends Error {}

/** 开头的 BOM 去掉（TextDecoder 默认如此）；不是合法 UTF-8 就抛 CsvEncodingError，说明怎么另存 */
export function decodeCsvFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvEncodingError('这个文件不是UTF-8编码（Excel默认另存的CSV是GBK）：请在Excel里另存为「CSV UTF-8（逗号分隔）」再选');
  }
}

export type CsvEncoding = 'utf-8' | 'gbk';

/** 按哪种编码读的：文件行上的写法 */
export const ENCODING_NAME: Readonly<Record<CsvEncoding, string>> = { 'utf-8': 'UTF-8', gbk: 'GBK' };

/**
 * 先 UTF-8（开头的 BOM 去掉），不成再 gb18030；都有解不开的字节就抛 CsvEncodingError。
 * 为什么兜底 GBK：中文 Windows 上 Excel 的「CSV（逗号分隔）」按系统的 ANSI 代码页保存，简体中文就是 GBK（spec「CSV 导入」）
 */
export function readCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // 不是 UTF-8，往下试 GBK
  }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gbk' };
  } catch {
    throw new CsvEncodingError('无法读取这个文件：它既不是UTF-8也不是GBK编码。请在Excel里另存为「CSV UTF-8（逗号分隔）」再选');
  }
}
