// 命令行的共用部分（spec「导入、导出与回滚」）。命令行不 import 运行时模块、不读写 var/，一律 --rm 运行；
// 连接串只从环境读，不 import env.ts：免得开发机 .env 里别的连接串混进来。
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { openDb, redactUrl, type Db } from '../db/client.js';

export function args<T extends NonNullable<ParseArgsConfig['options']>>(options: T, usage: string) {
  try {
    return parseArgs({ options, strict: true, allowPositionals: false }).values;
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n用法：${usage}`);
    process.exit(1);
  }
}

/** 必填参数缺了就打印用法、退出码 1 */
export function need(value: string | undefined, name: string, usage: string): string {
  if (value) return value;
  console.error(`缺少 ${name}\n用法：${usage}`);
  process.exit(1);
}

/** 从环境取连接串并打开连接池；缺了或连不上都以退出码 1 结束，连接串脱敏 */
export async function dbFromEnv(
  envName: 'DATABASE_URL' | 'DATABASE_PLATFORM_URL',
): Promise<{ db: Db; url: string; close(): Promise<void> }> {
  const url = process.env[envName];
  if (!url) {
    console.error(`缺少环境变量 ${envName}`);
    process.exit(1);
  }
  try {
    return { url, ...(await openDb(url)) };
  } catch (e) {
    console.error(`连不上数据库（${redactUrl(url)}）：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

/** 跑主函数并以它返回的退出码结束；未预料的异常退出码 1 */
export function main(fn: () => Promise<number>): void {
  fn().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    },
  );
}
