// 类型夹具（01 spec 验收 17）：只参与 typecheck，不被 main.tsx 引用、不进构建产物。
// 对不存在的端点、不合法的参数调用 hc 客户端必须是类型错误；哪天这里的 @ts-expect-error 不再报错，typecheck 就会失败
import { api } from './api.js';

export async function rpcTypeFixture(): Promise<void> {
  // @ts-expect-error 没有这个端点
  await api.nope.$get();
  // kind 的格式与包归属现在由运行时的 400 / 422 校验；客户端仍必须传 kind。
  // @ts-expect-error 缺少必填的 kind 参数
  await api.catalog[':kind'].$get({ param: {} });
  // @ts-expect-error 发布要带 rev 与 changeNote
  await api.sop.draft.publish.$post({ json: { changeNote: '缺rev' } });
  const r = await api.sop.$get();
  if (r.status === 200) {
    const body = await r.json();
    // @ts-expect-error 匿名投影与成员视图的联合：没收窄之前拿不到 draft
    void body.draft;
  }
}

/** 14 R9：200 的响应经 RPC 保留完整用量契约，错误响应不能冒充成功。 */
export async function usageTypeFixture(): Promise<void> {
  const response = await api.usage.$get();
  if (response.status === 200) {
    const usage: import('../../src/shared/console-api.js').UsageView = await response.json();
    const inferred = await response.json();
    const replies: number = inferred.replies.used;
    void [usage, replies];
    // @ts-expect-error 用量接口不携带会话内容
    void inferred.messages;
  }
}
