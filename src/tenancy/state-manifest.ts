// 05 R5：键是「仓库相对文件路径:标识符」，例如 src/store.ts:sessions。
// tenant 的 state 对应 registerTenantState 的 name；instance 必须写保留理由。
// 第 11 步在状态迁移完成后填清单并接入 lint；第 5 步只建立空清单与格式。
export const STATE_MANIFEST: Record<
  string,
  { kind: 'tenant'; state: string } | { kind: 'instance'; why: string } | { kind: 'object-keyed' }
> = Object.freeze({});
