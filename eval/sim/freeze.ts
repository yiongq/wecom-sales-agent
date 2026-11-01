// 16 R5：冻结的是 git 树；账本提交本身不改变这四棵树。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Freeze, Trees } from './report-types.js';

const exec = promisify(execFile);
export async function gitText(args: string[], cwd = process.cwd()): Promise<string> {
  return (await exec('git', args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
}
export async function treeHashes(rev = 'HEAD', cwd = process.cwd()): Promise<Trees> {
  const entries = await Promise.all(
    Object.entries({ evalSim: 'eval/sim', fixtures: 'eval/fixtures/attachments', packData: 'data/packs/industrial', src: 'src' }).map(
      async ([key, dir]) => [key, await gitText(['rev-parse', '--verify', '--end-of-options', `${rev}:${dir}`], cwd)],
    ),
  );
  return Object.fromEntries(entries) as unknown as Trees;
}
export async function writeFreeze(file: string, cwd = process.cwd()): Promise<Freeze> {
  if (await gitText(['status', '--porcelain'], cwd)) throw new Error('freeze_dirty_worktree');
  const freeze = { commit: await gitText(['rev-parse', 'HEAD'], cwd), trees: await treeHashes('HEAD', cwd) };
  await fs.mkdir(path.dirname(path.resolve(cwd, file)), { recursive: true });
  await fs.writeFile(path.resolve(cwd, file), JSON.stringify(freeze, null, 2) + '\n');
  return freeze;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 2 || args[0] !== '--write') throw new Error('用法：freeze.ts --write <文件>');
    await writeFreeze(args[1]);
    console.log('冻结文件已写入；请提交。');
  })().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'freeze_failed');
    process.exitCode = 1;
  });
}
