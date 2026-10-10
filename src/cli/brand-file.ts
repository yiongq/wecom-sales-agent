// 品牌不是密钥；只接受完整 JSON 档案，错误不回显文件内容、路径或未知字段。
import fs from 'node:fs';
import { BrandProfileSchema, type BrandProfile } from '../core/pack-api.js';

export function readBrandFile(file: string): BrandProfile {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('品牌文件读不到或不是合法 JSON');
  }
  const parsed = BrandProfileSchema.safeParse(input);
  if (!parsed.success) throw new Error('品牌文件须且只能含 brandName、advisorTitle、aiTitle、scopeNoun、identityLine 五个非空字符串');
  return parsed.data;
}
