// 业务观测订阅可以属于一个租户，也可以由组合根在空作用域安装为实例订阅。
// 发出方提供作用域；租户订阅只接收本租户事件，drop/reset 释放捕获的闭包。
import { scopedRuntime, type TenantRuntime } from './runtime.js';

export class TenantObservers<F> {
  private readonly entries = new Set<{ fn: F; owner: TenantRuntime | undefined }>();
  get size(): number {
    return [...this].length;
  }
  subscribe(fn: F): () => void {
    const entry = { fn, owner: scopedRuntime() };
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }
  *[Symbol.iterator](): IterableIterator<F> {
    const owner = scopedRuntime();
    for (const entry of this.entries) if (!entry.owner || entry.owner === owner) yield entry.fn;
  }
  registration() {
    return {
      keyCount: (id: string) => [...this.entries].filter((entry) => entry.owner?.id === id).length,
      drop: (id: string) => {
        for (const entry of this.entries) if (entry.owner?.id === id) this.entries.delete(entry);
      },
      reset: () => {
        for (const entry of this.entries) if (entry.owner) this.entries.delete(entry);
      },
    };
  }
}
