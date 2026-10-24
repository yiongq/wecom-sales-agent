// 08 R11：文件模式的配置目录（SOP_PATH 所在目录）里的 pack.json，内容是 { "id": "<包>" }。
// 只做解析，不 import 配置层或行业包：source.ts（装载）与 eval/sim/runtime.ts（--config-dir 的静态检查，
// 要在设环境变量之前就能读）共用。目录里没有这个文件就是旅游，与没有这一步时完全相同。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const PACK_FILE = 'pack.json';

// id 会拼进 data/packs/<id>/sop.md 的路径，字符集与 imageSopFile 的校验一致
const PackFileSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/, '只能含字母、数字、下划线和连字符') });
export type PackFile = z.infer<typeof PackFileSchema>;

/** 严格 UTF-8 解码再按 schema 校验；不合格抛 Error，消息可以直接给人看 */
export function parsePackFile(bytes: Uint8Array): PackFile {
  try {
    return PackFileSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (e) {
    const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；') : String(e);
    throw new Error(`${PACK_FILE} 不合格（要求 { "id": "<包>" }）：${detail}`, { cause: e });
  }
}

/** 目录里有 pack.json 就读出来；没有返回 null（只看一眼文件在不在，不报错、不写盘、不多读） */
export function readPackFile(dir: string): PackFile | null {
  const file = path.join(dir, PACK_FILE);
  return fs.existsSync(file) ? parsePackFile(fs.readFileSync(file)) : null;
}
