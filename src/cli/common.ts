// 命令行的共用部分（spec「导入、导出与回滚」）。命令行不 import 运行时模块、不读写 var/，一律 --rm 运行；
// 连接串只从环境读，不 import env.ts：免得开发机 .env 里别的连接串混进来。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
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

/**
 * 口令从 stdin 读（--password-stdin），或者生成后只写到 /dev/tty；两者都没有就拒绝执行。
 * 口令因此不会进 docker logs、shell 历史或进程参数。用到时才读：账号已存在时 user-create 根本不要口令
 */
export function passwordSource(fromStdin: boolean): () => Promise<string> {
  return async () => {
    if (fromStdin) {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\r?\n$/, '');
    }
    const generated = randomBytes(18).toString('base64url');
    let fd: number;
    try {
      fd = fs.openSync('/dev/tty', 'w');
    } catch {
      console.error('没有终端可以显示生成的口令：用 --password-stdin 从标准输入传入');
      process.exit(1);
    }
    fs.writeSync(fd, `生成的口令（只显示这一次）：${generated}\n`);
    fs.closeSync(fd);
    return generated;
  };
}
