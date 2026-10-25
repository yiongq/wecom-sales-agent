// 08 R5 两条依赖方向规则（scripts/check-boundaries.ts）的允许名单。
// 初值是规则写好后在基点上跑出来的违例，08 第 20 步把它们都搬走了：两份名单都必须是空数组。
// scripts/check-boundaries.selftest.ts 断言它们为空，所以以后加违例要同时改这里和自测，评审看得见；
// 要放进来的东西，先想它该经钩子、绑定包的运行时或门面取。

/** 规则 (1)：非包、非门面的 `src/` 代码 import 了 `src/packs/<名>/**`。target 是解析出的仓库内路径 */
export interface PackImportAllow {
  file: string;
  target: string;
}

/** 规则 (2)：非包、非门面、非 `src/types.ts` 的 `src/` 代码读写了 R1 的旅游会话字段 */
export interface SessionFieldAllow {
  file: string;
  field: string;
}

export const PACK_IMPORT_ALLOWLIST: readonly PackImportAllow[] = [];

export const SESSION_FIELD_ALLOWLIST: readonly SessionFieldAllow[] = [];
