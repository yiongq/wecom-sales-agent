import { onProcessLeaseChange, processLeaseHeld } from './tenancy/process-lease.js';
import { withoutTenantScope } from './tenancy/runtime.js';

/** 关闭监听立即拒绝新连接；已接受的请求继续收尾，恢复用新监听器，不等旧长连接结束。 */
export function listenWithProcessLease(start: (first: boolean) => { close(): unknown }): () => void {
  let listener: { close(): unknown } | undefined;
  let first = true;
  const reconcile = (): void => {
    if (!processLeaseHeld()) {
      listener?.close();
      listener = undefined;
    } else if (!listener) {
      listener = start(first);
      first = false;
    }
  };
  const unsubscribe = onProcessLeaseChange(() => withoutTenantScope(reconcile));
  withoutTenantScope(reconcile);
  return () => {
    unsubscribe();
    listener?.close();
    listener = undefined;
  };
}
