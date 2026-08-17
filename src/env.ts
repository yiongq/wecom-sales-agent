// 极简 .env 加载（零依赖）：只填充尚未存在的变量，不覆盖真实环境变量。
// 必须是 server.ts 的第一个 import——ES 模块按 import 顺序执行副作用，
// 这样其余模块（均为调用时读 env）都能看到 .env 的值。
import fs from 'node:fs';
import path from 'node:path';

try {
  const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
} catch {
  /* 无 .env 文件：生产环境经真实环境变量注入，属正常情况 */
}

/**
 * 读数值型环境变量。**显式设 0 就是 0**。
 * 此前各处一律写 `Number(process.env.X) || 默认值`，而 Number('0') 是 falsy，
 * 于是所有注释/文档里写着「0 表示关闭」的开关全都关不掉：运维按文档设
 * LLM_MAX_RETRY=0 想停掉重试放大，实际仍跑满 3 次；DEMO_PRUNE_HOURS 同理。
 */
export function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 今天（本地时区）的 YYYY-MM-DD。全项目共用一个「今天」，避免 UTC/本地混用差一天 */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
