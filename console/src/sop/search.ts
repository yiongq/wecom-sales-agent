// 话术页地址上的查询参数（spec 的路由表、「版本记录」「查看改动」，不变量 22）：
// - section：选中的节，不认识的 key 由页面退回默认节；
// - view=history：版本记录抽屉开着；
// - v=2：主区在看 v2 相对前一版改了什么（正整数，别的写法当没给）。
// 路由表（router.tsx）与话术自测共用这一份；不 import 别的模块，进入口集合也不带别的东西
export interface SopSearch {
  section?: string;
  view?: 'history';
  v?: number;
}

/** v 的写法：路由把 ?v=2 解析成数字 2，手写成字符串的也认 */
function versionParam(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d{1,9}$/.test(x) ? Number(x) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function sopSearch(s: Record<string, unknown>): SopSearch {
  const v = versionParam(s.v);
  return {
    ...(typeof s.section === 'string' ? { section: s.section } : {}),
    ...(s.view === 'history' ? { view: 'history' as const } : {}),
    ...(v === undefined ? {} : { v }),
  };
}
