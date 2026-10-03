// 接手、交还、人工回复的状态机（docs/architecture/02-conversations-workbench/spec.md「接手、人工回复与交还」）。
// 状态机本身是第 13 步。第 12 步先接桩：只有接手代次的读法 takeoverGen，企微适配器在 sendRich 之前拿它比较（不变量 28 的适配器部分）；
// 第 13 步的 takeover() 每次成为接手人（含改派）把这个会话的代次加 1，并在引擎 push AI 回复之前同步比较一次。
// 接手代次是进程内计数，不进 Session。

const gens = new Map<string, number>();

/** 接手代次：进程内计数，不进 Session。第 13 步之前没有生产者，恒为 0（自测经 __takeoverTest.bump 拨它） */
export function takeoverGen(sessionId: string): number {
  return gens.get(sessionId) ?? 0;
}

/** 仅供自测：模拟一次接手（第 13 步由 takeover() 做同样的事） */
export const __takeoverTest = {
  bump(sessionId: string): void {
    gens.set(sessionId, takeoverGen(sessionId) + 1);
  },
};
