// 05 R5：模块私有状态挂在运行时对象的私有 symbol 上，启动补 tenantId 不会丢失状态。
// 登记名仍由使用模块逐项声明；异步写回核对 owns，防止 drop/reset 后重新落地。
import { currentRuntime, type TenantRuntime } from './runtime.js';

export class TenantLocal<T> {
  private readonly slot = Symbol('tenant-local-state');
  private readonly owners = new Set<TenantRuntime>();
  constructor(
    private readonly create: () => T,
    private readonly dispose: (value: T) => void = () => {},
  ) {}
  get(rt = currentRuntime()): T {
    let value = Reflect.get(rt, this.slot) as T | undefined;
    if (value === undefined) {
      value = this.create();
      Reflect.set(rt, this.slot, value);
      this.owners.add(rt);
    }
    return value;
  }
  owns(rt: TenantRuntime, value: T): boolean {
    return rt.state === 'serving' && Reflect.get(rt, this.slot) === value;
  }
  registration(count: (value: T) => number) {
    const remove = (rt: TenantRuntime): void => {
      const value = Reflect.get(rt, this.slot) as T;
      Reflect.deleteProperty(rt, this.slot);
      this.owners.delete(rt);
      this.dispose(value);
    };
    return {
      keyCount: (id: string): number => {
        let n = 0;
        for (const rt of this.owners) if (rt.id === id) n += count(Reflect.get(rt, this.slot) as T);
        return n;
      },
      drop: (id: string): void => {
        for (const rt of this.owners) if (rt.id === id) remove(rt);
      },
      reset: (): void => {
        for (const rt of this.owners) remove(rt);
      },
    };
  }
}
