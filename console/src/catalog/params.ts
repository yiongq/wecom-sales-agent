// 产品库列表的 URL 状态（spec「信息架构、导航与路由」的 /catalog/$kind 一行、不变量 22）：页签 status、搜索 q、筛选 f。
// f 的每一项写成「字段 key:值」（key 里没有冒号，值里可以有）。刷新、后退、分享链接都还原同一个列表。
// 这个文件进入口集合（router.tsx 的 validateSearch 用它），所以不依赖别的模块；按行业包取舍筛选项在 list.ts
export interface CatalogSearch {
  status?: 'active' | 'draft';
  q?: string;
  f?: string[];
}

/** 一项筛选 */
export interface FilterPick {
  key: string;
  value: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** 「字段 key:值」→ 一项筛选；没有冒号、key 或值为空的不认 */
export function parseFilter(s: string): FilterPick | null {
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { key: s.slice(0, i), value: s.slice(i + 1) };
}

export const filterParam = (p: FilterPick): string => `${p.key}:${p.value}`;

/**
 * 路由的 validateSearch：只留认得的取值，空的不写（地址里不出现 q= 这类空参数）。
 * f 可以是一个字符串（手写的地址）或字符串数组；同一个字段只认第一项
 */
export function catalogSearch(raw: Record<string, unknown>): CatalogSearch {
  const out: CatalogSearch = {};
  if (raw.status === 'active' || raw.status === 'draft') out.status = raw.status;
  const q = text(raw.q);
  if (q !== undefined && q.trim() !== '') out.q = q;
  const fs = (Array.isArray(raw.f) ? raw.f : [raw.f]).map(text).filter((s): s is string => s !== undefined);
  const seen = new Set<string>();
  const f: string[] = [];
  for (const s of fs) {
    const p = parseFilter(s);
    if (!p || seen.has(p.key)) continue;
    seen.add(p.key);
    f.push(filterParam(p));
  }
  if (f.length) out.f = f;
  return out;
}

/** 这些筛选项里某个字段的值 */
export const pickOf = (search: CatalogSearch, key: string): string | undefined =>
  (search.f ?? []).map(parseFilter).find((p) => p?.key === key)?.value;

/** 设一个字段的筛选值（value 为 undefined 时清掉这个字段），其余字段的筛选不动 */
export function withPick(search: CatalogSearch, key: string, value: string | undefined): CatalogSearch {
  const rest = (search.f ?? []).filter((s) => parseFilter(s)?.key !== key);
  const f = value === undefined || value === '' ? rest : [...rest, filterParam({ key, value })];
  return catalogSearch({ ...search, f });
}

/** 清除筛选：去掉 f；all 为真时连搜索和页签一起回到默认（筛选无结果的空状态用） */
export function cleared(search: CatalogSearch, all = false): CatalogSearch {
  return all ? {} : catalogSearch({ ...search, f: [] });
}

/** 条目详情的 URL 状态（路由表 /catalog/$kind/$code 一行）：页签「编辑 / 预览」。页签本身在第 10.3 步，这里只认取值 */
export interface ItemSearch {
  tab?: 'edit' | 'preview';
}

export const itemSearch = (raw: Record<string, unknown>): ItemSearch =>
  raw.tab === 'edit' || raw.tab === 'preview' ? { tab: raw.tab } : {};
