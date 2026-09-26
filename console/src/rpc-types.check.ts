// 类型夹具（01 spec 验收 17）：只参与 typecheck，不被 main.tsx 引用、不进构建产物。
// 对不存在的端点、不合法的参数调用 hc 客户端必须是类型错误；哪天这里的 @ts-expect-error 不再报错，typecheck 就会失败
import { api } from './api.js';

export async function rpcTypeFixture(): Promise<void> {
  // @ts-expect-error 没有这个端点
  await api.nope.$get();
  // @ts-expect-error kind 只能是 route / hotel
  await api.catalog[':kind'].$get({ param: { kind: 'ship' } });
  // @ts-expect-error 发布要带 rev 与 changeNote
  await api.sop.draft.publish.$post({ json: { changeNote: '缺 rev' } });
  const r = await api.sop.$get();
  if (r.status === 200) {
    const body = await r.json();
    // @ts-expect-error 匿名投影与成员视图的联合：没收窄之前拿不到 draft
    void body.draft;
  }
}
