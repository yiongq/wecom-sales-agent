// 优雅停机（docs/architecture/02-conversations-workbench/spec.md「两种会话存储与启动」）：信号接线与三段停机钩子。
// 从 store.ts 搬来，store.ts 原样再导出 onShutdown、runShutdownHooks、gracefulExit；两种会话存储下都在导入期注册。
//
// 此前收到 SIGTERM 立刻 process.exit：deploy.sh 给的 `docker stop -t 10` 宽限期一秒都没用上，
// 正在跑 LLM 的客户消息被拦腰截断——企微那条消息已记为「处理过」，重启后不会再回，客户永远等不到。
// 现在先跑各模块注册的收尾钩子，再退出。钩子分三段依次跑，段内并发：
//   normal：停企微拉取、等处理链、停任务认领（现有的钩子默认在这一段）
//   drain：排空会话写队列、写用量
//   late：关连接池、放租户锁（在途的回复还要读配置，最后才能关）

export type ShutdownPhase = 'normal' | 'drain' | 'late';
const PHASES: readonly ShutdownPhase[] = ['normal', 'drain', 'late'];

/** 钩子收到这一段的截止时刻（毫秒时间戳），要排空写队列的钩子按它算剩余预算 */
export type ShutdownHook = (ctx: { deadline: number }) => unknown;

const hooks: Record<ShutdownPhase, ShutdownHook[]> = { normal: [], drain: [], late: [] };

/** 注册停机收尾钩子，默认进 normal 段 */
export function onShutdown(fn: ShutdownHook, opts: { phase?: ShutdownPhase } = {}): void {
  hooks[opts.phase ?? 'normal'].push(fn);
}

// 必须小于 deploy.sh 的 `docker stop -t 10`：超过宽限期 docker 直接 SIGKILL，
// 连 'exit' 阶段的同步落盘都跑不到。留约 2s 给落盘和进程退出。
const SHUTDOWN_TIMEOUT_MS = 8000;

/** 各段占总上限的份额：normal 最多到第 6 秒，drain 最多 1.5 秒，late 最多 0.5 秒（总上限 8 秒时） */
const SHARE: Record<ShutdownPhase, number> = { normal: 6 / 8, drain: 1.5 / 8, late: 0.5 / 8 };

async function runPhase(phase: ShutdownPhase, deadline: number): Promise<boolean> {
  const list = [...hooks[phase]];
  if (!list.length) return true;
  let timer: NodeJS.Timeout | undefined;
  const all = Promise.allSettled(list.map((fn) => Promise.resolve().then(() => fn({ deadline })))).then((rs) => {
    for (const r of rs) if (r.status === 'rejected') console.error(`[shutdown] ${phase} 段的停机钩子异常:`, r.reason);
    return true;
  });
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  try {
    const ok = await Promise.race([all, timeout]);
    if (!ok) console.error(`[shutdown] ${phase} 段超时，进入下一段`);
    return ok;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 依次跑三段停机钩子，总共最多等 timeoutMs，各段按 SHARE 分；某段超时就进下一段（超时那段的钩子仍在后台跑）。
 * 返回 false 表示有一段超时（仍有钩子没结束）
 */
export async function runShutdownHooks(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  let ok = true;
  for (const phase of PHASES) {
    // normal 的截止从开始算；drain、late 各自从上一段结束时算，早结束的段把余下的时间留给进程退出
    const deadline = (phase === 'normal' ? start : Date.now()) + timeoutMs * SHARE[phase];
    if (!(await runPhase(phase, deadline))) ok = false;
  }
  return ok;
}

let shuttingDown = false;

/**
 * 优雅退出：跑完全部停机钩子（有上限）再以 code 退出。SIGTERM 走的就是这条路；配置源发现租户锁被别的进程拿走时也调它。
 * 已在退出中时再调直接退出（终端里连按 Ctrl+C 就是想马上退）
 */
export function gracefulExit(code: number, why = `退出码 ${code}`): void {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  console.log(`[shutdown] ${why}，等待进行中的任务收尾（最多 ${SHUTDOWN_TIMEOUT_MS / 1000}s）`);
  void runShutdownHooks().then((ok) => {
    if (!ok) console.error('[shutdown] 停机等待超时，强制退出（未完成的企微消息已落盘，重启后补处理）');
    process.exit(code);
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => gracefulExit(sig === 'SIGINT' ? 130 : 143, `收到 ${sig}`));
}
