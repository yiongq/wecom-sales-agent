// 07 R12：真实 Postgres 测试库里的 vector 扩展。它不是 trusted 扩展，agent_owner 建不了，迁移 0016 又要求应用库里已经有它：
// 测试以超级用户连着新建的应用库，先执行 deploy/db-init/extensions.sql 里的语句（与新库初始化、线上补建是同一个文件），再以 agent_owner 跑迁移。
// 只给自测夹具用，不 import pg（调用方把查询函数传进来）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** extensions.sql 里的语句，一行一条（那个文件的约定：每条语句占一行，不用 psql 变量） */
export function extensionStatements(): string[] {
  return fs
    .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'db-init', 'extensions.sql'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('--'));
}

/**
 * 在超级用户连着的应用库里装 extensions.sql 的扩展。集群的镜像里根本没有 vector（不是 pgvector 镜像）时什么都不做并返回 false：
 * 迁移 0016 对「扩展不可用」的库照 PGlite 一样跳过 kb_vectors
 */
export async function installVectorExtension(run: (text: string) => Promise<{ rowCount: number | null }>): Promise<boolean> {
  const available = (await run("select 1 from pg_available_extensions where name = 'vector'")).rowCount === 1;
  if (!available) return false;
  for (const stmt of extensionStatements()) await run(stmt);
  return true;
}
