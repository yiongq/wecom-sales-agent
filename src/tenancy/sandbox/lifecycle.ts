// 实例级停止闸：锁丢失先同步置停，再由组合根关闭后端、直接非零退出。
let stopped = false;
export function sandboxStopped(): boolean {
  return stopped;
}
export function stopSandboxProcess(): void {
  stopped = true;
}
export function assertSandboxRunning(): void {
  if (stopped) throw new Error('sandbox_process_stopped');
}
