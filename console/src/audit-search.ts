// 审计日志的 search 参数（spec 路由表：cat、login）：分段控件选的类别与「显示登录记录」开关都写在地址里，
// 刷新、后退、分享链接都能还原（不变量 22）。router.tsx 与自测都用它，所以单放一个文件：router.tsx 读 import.meta.env，
// 自测在 Node 里 import 不了它。只 import 类型，入口集合里不带 ui-labels 的表
import type { AuditGroup } from '../../src/shared/ui-labels.js';

/** 类别的取值；AuditGroup 加减一种时这里不跟着改，typecheck 就失败 */
const GROUP: Readonly<Record<AuditGroup, true>> = { sop: true, catalog: true, conversation: true, account: true, platform: true };

export interface AuditSearch {
  /** 分段控件选的类别；「全部」不写 */
  cat?: AuditGroup;
  /** 显示登录记录；默认关，关着不写 */
  login?: 1;
}

/**
 * 取值不合规的参数丢掉。键总是写出来（不合规时是 undefined）：TanStack Router 把地址里原样的参数和这里的结果合在一起
 * 给 useSearch，不写出来的键会原样留着（第 4 步的记录）
 */
export const auditSearch = (s: Record<string, unknown>): AuditSearch => ({
  cat: typeof s.cat === 'string' && Object.hasOwn(GROUP, s.cat) ? (s.cat as AuditGroup) : undefined,
  login: s.login === 1 || s.login === '1' ? 1 : undefined,
});
