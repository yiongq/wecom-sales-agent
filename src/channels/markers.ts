// 标记文件与恢复哨兵（docs/architecture/03-channels-v2/spec.md「导入、导出与切换 · 标记文件」「重启、崩溃与恢复 · 恢复哨兵」、
// R7、R13、R19、不变量 14）。纯文件操作：只 import node:fs、node:path（scripts/check-boundaries.ts 守），启动装载
// （src/channels/registry.ts）与第 12、14 步的命令行共用。
// - var/channels-in-db.json（{ tenant, account, at }）：企微状态在库里。channel-import 写、在库里时启动补写、channel-export 删；
//   决定启动的 channel_state_in_file、channel_state_in_db 两个拒绝和 deploy 的回滚检查。
// - var/restored-from-backup.json（{ backupAt }）：恢复哨兵。只在 backup.sh 的归档里，线上 var/ 没有；企微状态在库里时只由
//   restore-cutoff 删掉。
// 写与删照 02 的写法（src/cli/session-transfer.ts）：先写临时文件、落盘、改名，再对目录 fsync，断电之后先后也成立。
import fs from 'node:fs';
import path from 'node:path';

export const CHANNELS_IN_DB_MARKER = 'channels-in-db.json';
export const RESTORE_SENTINEL = 'restored-from-backup.json';
/** 02 的企微文件状态（env 账号的 cursor、已处理集合、在途表），由 src/adapters/wecom.ts 读写 */
export const WECOM_STATE_FILE = 'wecom-cursor.json';

export interface ChannelsMarker {
  /** 租户 slug */
  tenant: string;
  /** 默认企微账号（前缀 wecom:）的 key */
  account: string;
  /** ISO 时刻 */
  at: string;
}

const exists = (varDir: string, name: string): boolean => fs.existsSync(path.join(varDir, name));

export function hasChannelsMarker(varDir: string): boolean {
  return exists(varDir, CHANNELS_IN_DB_MARKER);
}

export function hasRestoreSentinel(varDir: string): boolean {
  return exists(varDir, RESTORE_SENTINEL);
}

export function hasWecomStateFile(varDir: string): boolean {
  return exists(varDir, WECOM_STATE_FILE);
}

/** 读标记文件；不在返回 null，内容坏了抛错（调用方决定怎么报） */
export function readChannelsMarker(varDir: string): ChannelsMarker | null {
  const file = path.join(varDir, CHANNELS_IN_DB_MARKER);
  if (!fs.existsSync(file)) return null;
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ChannelsMarker> | null;
  if (!v || typeof v.tenant !== 'string' || typeof v.account !== 'string' || typeof v.at !== 'string') {
    throw new Error(`${CHANNELS_IN_DB_MARKER} 的内容不是 { tenant, account, at }`);
  }
  return { tenant: v.tenant, account: v.account, at: v.at };
}

/** 目录本身落到盘上：之前的改名、删除在断电之后也按发生的先后可见 */
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 先写临时文件、落到盘上，再改名，再 fsync 所在目录：崩溃不会留下半截文件 */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/** 删一个文件并 fsync 目录；本来就不在时什么都不做 */
function removeDurably(file: string): void {
  if (!fs.existsSync(file)) return;
  fs.unlinkSync(file);
  fsyncDir(path.dirname(file));
}

/** 写标记文件（目录不在先建）；写不进去抛错，由调用方决定是拒绝还是只记日志 */
export function writeChannelsMarker(varDir: string, m: ChannelsMarker): void {
  fs.mkdirSync(varDir, { recursive: true });
  writeAtomic(path.join(varDir, CHANNELS_IN_DB_MARKER), `${JSON.stringify({ tenant: m.tenant, account: m.account, at: m.at })}\n`);
}

export function removeChannelsMarker(varDir: string): void {
  removeDurably(path.join(varDir, CHANNELS_IN_DB_MARKER));
}

/** 删恢复哨兵：企微状态在库里时只有 restore-cutoff 调；未导入、已导出时启动装载调（渠道状态在文件里，恢复照 02） */
export function removeRestoreSentinel(varDir: string): void {
  removeDurably(path.join(varDir, RESTORE_SENTINEL));
}
