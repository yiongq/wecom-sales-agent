import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

// 相对路径以仓库根目录为准；拒绝 var 本身、路径穿越、符号链接和覆盖已有文件。
export async function prepareDrillLogPath(root: string, value: string): Promise<string> {
  const base = path.resolve(root, 'var');
  const target = path.resolve(root, value);
  const relative = path.relative(base, target);
  if (!value || value.includes('\0') || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('DRILL_DUMP_LOGS 必须是仓库 var/ 下的文件路径');
  let current = path.resolve(root);
  const pieces = ['var', ...relative.split(path.sep)];
  for (const [index, piece] of pieces.entries()) {
    current = path.join(current, piece);
    const last = index === pieces.length - 1;
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error('DRILL_DUMP_LOGS 路径不能经过符号链接');
    if (last) {
      if (stat) throw new Error('DRILL_DUMP_LOGS 文件已存在，请选择新文件名');
    } else if (stat && !stat.isDirectory()) throw new Error('DRILL_DUMP_LOGS 的父路径必须是目录');
    else if (!stat) await mkdir(current, { mode: 0o700 });
  }
  return target;
}

export function redactDrillLogs(logs: string, password: string): string {
  if (!password) throw new Error('drill_log_redaction_missing_password');
  return logs.split(password).join('[REDACTED]');
}

export async function writeDrillLogs(root: string, target: string, logs: string, password: string): Promise<void> {
  const checked = await prepareDrillLogPath(root, target);
  const redacted = redactDrillLogs(logs, password);
  // wx 防止最终文件在检查后被换成符号链接/硬链接，也不覆盖上一次演练的证据。
  const file = await open(checked, 'wx', 0o600);
  try {
    await file.writeFile(redacted);
  } finally {
    await file.close();
  }
}
