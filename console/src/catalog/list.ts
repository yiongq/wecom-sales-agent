// 产品库列表的纯逻辑（spec「产品库列表（D 页；L 页上半）」，设计系统 §5.5、D 页、L 页上半）。不依赖 React：
// 列、表头、对齐和列宽，筛选的选项与匹配，搜索，页签计数，排序，更新列的写法，都只看行业包的配置和字段类型，不认具体行业。
// - 列来自 list.columns；首列是 titleKey 加 subtitleKeys 两行（titleKey 在 columns 里也只画这一列）；匿名没有状态、更新两列；
// - 筛选按钮来自 list.filters（至多 3 个），选项按字段类型生成：枚举取 options、布尔取 trueLabel / falseLabel、
//   月份区间取 1–12 月，其余取各条已有的值去重；多值的字段（多选枚举、标签、多选引用）按「包含」匹配；
// - 搜索覆盖 list.search 的字段，不分大小写、忽略空白的子串（与 ⌘K 的原文匹配相同）；
// - 页签的数字按搜索与筛选之后的条目算，默认按更新时间倒序（defaultSort 只有 -$updated 一种）
import { clockTime, dateText, dayKey, digits, money, parseMonthRange, quantity } from '../../../src/shared/format.js';
import { type EntityType, type FieldDef, type FieldType, valueAt } from '../../../src/shared/pack.js';
import { actorName } from '../../../src/shared/ui-labels.js';
import { moneyUnit, nounOf, parseStored, type RefItem, resolveRef } from '../fields/model.js';
import { STATUS_LABEL } from '../parts/Status.js';
import { fieldText, type Matcher, plainMatch } from '../shell/search.js';
import { type CatalogSearch, parseFilter } from './params.js';

/** 列表里的一条：成员拿到的有状态、更新时间和更新人；匿名投影只有编号和 payload */
export interface ListRow {
  code: string;
  payload: Record<string, unknown>;
  status?: 'draft' | 'active';
  updatedAt?: string;
  updatedByName?: string | null;
}

/** 产品库一页 50 条，不足一页不显示分页器（设计系统 §5.5） */
export const PAGE_SIZE = 50;
/** 筛选按钮不超过 3 个（spec「产品库列表 · 工具条」） */
export const MAX_FILTERS = 3;
/** 更新人为空时写的名字；命令行写的命令名由 actorName 换成「系统导入」「命令行」（设计系统 §11） */
export const IMPORTED_BY = '系统导入';

/** 按 FieldDef.key 取一条的值：$code 是编号，$status 是状态，其余在 payload 里 */
export function cellValue(row: ListRow, key: string): unknown {
  if (key === '$code') return row.code;
  if (key === '$status') return row.status;
  return valueAt(row.payload, key);
}

const fieldOf = (entity: EntityType, key: string): FieldDef | undefined => entity.fields.find((f) => f.key === key);

/** 字段配置里没写的系统字段也能当列、当筛选：编号是文本，状态是状态 */
function systemField(entity: EntityType, key: string): FieldDef | undefined {
  if (key === '$code') return { key, type: 'text', label: entity.codeLabel, group: '' };
  if (key === '$status') return { key, type: 'status', label: '状态', group: '' };
  return undefined;
}

export const listField = (entity: EntityType, key: string): FieldDef | undefined => fieldOf(entity, key) ?? systemField(entity, key);

// ---------------- 列 ----------------

export type ListColumn = { kind: 'title' } | { kind: 'field'; field: FieldDef } | { kind: 'updated' };

/** 表格的列：首列是名称（titleKey 加 subtitleKeys），其后按 list.columns；匿名没有状态、更新两列 */
export function listColumns(entity: EntityType, anon: boolean): ListColumn[] {
  const out: ListColumn[] = [{ kind: 'title' }];
  for (const key of entity.list.columns) {
    if (key === entity.titleKey) continue;
    if (anon && (key === '$status' || key === '$updated')) continue;
    if (key === '$updated') {
      out.push({ kind: 'updated' });
      continue;
    }
    const field = listField(entity, key);
    if (field) out.push({ kind: 'field', field });
  }
  return out;
}

/** 首列两行：有次行时行高 56，没有时 44（设计系统 §5.5） */
export const twoLine = (entity: EntityType): boolean => entity.subtitleKeys.length > 0;

/**
 * 表头：字段标签；单位固定的金额把单位写进表头，单元格只写数（「每人起价（元）」）。
 * 单位写的是「元/人」「元/㎡」这种时只取斜线前面的：「每人」「每平米」已经在标签里了。单位取另一个字段（unitFrom）的金额
 * 每行单位不同，表头写不了，单元格自己带单位；带单位的整数把单位写进单元格（「8天」）
 */
export function headerLabel(f: FieldDef): string {
  if (f.type === 'money' && f.unit) return `${f.label}（${f.unit.split('/')[0]}）`;
  return f.label;
}

/** 数字列右对齐（金额、带单位的整数、有序子项的条数） */
export const numeric = (f: FieldDef): boolean => f.type === 'money' || f.type === 'intUnit' || f.type === 'subItems';

/**
 * 列宽（固定布局，与设计系统 D、L 页的网格一致：首列占掉剩下的，其余列定宽）。按字段类型算：
 * - 数字列（金额、带单位的整数、条数）、单选、是否、文字：表头和各条的内容放得下，不窄于基准；
 *   D 页的天数 64、每人起价 120 就是基准，L 页的「起装面积」「每平米单价（元）」按表头加宽，「120天」按内容加宽；
 * - 多选枚举按内容，至多 180（D 页的适合客群），再长截断、悬停看全文；月份区间 224、标签 200、引用 180、状态 100、更新 152 定宽。
 * 宽度按全部条目算（不按筛选后的），筛选时列宽不跳
 */
interface WidthRule {
  base: number;
  /** 按内容加宽时的上限；不给就是定宽 */
  max?: number;
}
const WIDTH: { readonly [T in FieldType]: (f: FieldDef) => WidthRule } = {
  text: () => ({ base: 100, max: 240 }),
  longText: () => ({ base: 240 }),
  money: () => ({ base: 120, max: 200 }),
  intUnit: () => ({ base: 64, max: 160 }),
  monthRange: () => ({ base: 224 }),
  enum: (f) => (f.multiple ? { base: 80, max: 180 } : { base: 80, max: 160 }),
  tags: () => ({ base: 200 }),
  boolean: () => ({ base: 80, max: 160 }),
  subItems: () => ({ base: 64, max: 120 }),
  reference: () => ({ base: 180 }),
  status: () => ({ base: 100 }),
};
export const UPDATED_WIDTH = 152;
/**
 * 首列至少这么宽，表格比容器宽时在自己的容器里横向滚动（首列固定）。侧栏展开、收成图标栏时先让首列收窄：
 * 1280 宽（侧栏展开、内边距 24）表格只有约 1008，D 页其余列要 840，首列按 240 算的话「更新」列被裁掉一截
 */
export const TITLE_MIN_WIDTH = 160;
/** 窄屏（<992，侧栏隐藏）：首列固定、其余列横滚，首列留宽一点，名称少截一些 */
export const TITLE_MIN_NARROW = 240;
/** 单元格左右内边距各 12，再留 4 给中西文之间的自动间距（text-autospace）和取整 */
const CELL_PADDING = 28;

/** 汉字、CJK 标点与全角字符 */
const wide = (cp: number): boolean => (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);

/** 一段文字的宽度估计：汉字与全角字符按 1em，其余按 0.6em（Geist 的等宽数字约 0.6em），宁宽勿窄 */
export function textWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text) w += wide(ch.codePointAt(0) ?? 0) ? px : px * 0.6;
  return Math.ceil(w);
}

/** 表头（13px）加内边距 */
export const headerWidth = (text: string): number => textWidth(text, 13) + CELL_PADDING;

/** 单元格里写出来的字（估宽用，与渲染器的列表形态一致） */
function cellText(f: FieldDef, row: ListRow): string {
  const v = cellValue(row, f.key);
  switch (f.type) {
    case 'money':
      return typeof v === 'number' ? (f.unit ? digits(v) : money(v, moneyUnit(f, row.payload))) : '';
    case 'intUnit':
      return typeof v === 'number' ? quantity(v, f.unit ?? '') : '';
    case 'subItems':
      return Array.isArray(v) ? `${v.length}${nounOf(f)}` : '';
    case 'boolean':
      return v === true ? (f.trueLabel ?? '是') : v === false ? (f.falseLabel ?? '否') : '';
    case 'enum':
      return typeof v === 'string' ? v : strings(v).join('、');
    default:
      return typeof v === 'string' ? v : '';
  }
}

export function columnWidth(c: ListColumn, rows: readonly ListRow[]): number | undefined {
  if (c.kind === 'title') return undefined;
  if (c.kind === 'updated') return UPDATED_WIDTH;
  const rule = WIDTH[c.field.type](c.field);
  const head = headerWidth(headerLabel(c.field));
  if (rule.max === undefined) return Math.max(rule.base, head);
  let content = 0;
  for (const r of rows) content = Math.max(content, textWidth(cellText(c.field, r), 14) + CELL_PADDING);
  return Math.max(rule.base, head, Math.min(content, rule.max));
}

/** 表格的最小宽度：比容器窄时铺满容器（首列变宽），比容器宽时横向滚动。titleMin 是首列的最小宽度 */
export const tableMinWidth = (cols: readonly ListColumn[], rows: readonly ListRow[], titleMin = TITLE_MIN_WIDTH): number =>
  cols.reduce((sum, c) => sum + (columnWidth(c, rows) ?? titleMin), 0);

/** 悬停看全文的列（多选枚举「一行放不下就省略」、标签「+2 悬停列出全部」）：单元格的 title 写全部取值 */
export function fullText(f: FieldDef, v: unknown): string | undefined {
  if (f.type === 'tags' || (f.type === 'enum' && f.multiple)) {
    const all = f.storeAs && typeof v === 'string' ? [v] : strings(v);
    return all.length ? all.join('、') : undefined;
  }
  return undefined;
}

// ---------------- 页头 ----------------

/**
 * 页头与空状态里的入口（spec「产品库列表」的页头和状态表）：编辑角色（所有者、管理员）才有「新建{实体名}」；
 * csvImport 为 true 的实体另有「导入CSV」，不能导入的实体不渲染这个入口，也不放一个灰按钮。非编辑成员和匿名都没有
 */
export const listActions = (editable: boolean, entity: EntityType): { create: boolean; csv: boolean } => ({
  create: editable,
  csv: editable && entity.csvImport,
});

/** 状态句「共21条 · 销售助手只推荐已上架的」的两段；还没取到或一条都没有时不写（空状态自己说明） */
export const statusParts = (rows: readonly ListRow[] | undefined): [string, string] | null =>
  rows?.length ? [`共${digits(rows.length)}条`, '销售助手只推荐已上架的'] : null;

// ---------------- 更新列 ----------------

/** 更新时间：今天的写「今天13:40」，更早的写日期「9月25日」（跨年加年份），与设计系统 D、L 页相同 */
export function listTime(at: string | number, now: number): string {
  return dayKey(at) === dayKey(now) ? `今天${clockTime(at)}` : dateText(at, now);
}

/** 「小林 · 今天13:40」的两段；更新人为空或是 import-config 写「系统导入」；匿名投影没有更新时间，返回 null */
export function updatedParts(row: ListRow, now: number): [string, string] | null {
  if (!row.updatedAt) return null;
  return [actorName(row.updatedByName) ?? IMPORTED_BY, listTime(row.updatedAt, now)];
}

// ---------------- 搜索 ----------------

/** 搜索框的占位：「搜索名称、目的地、客户的其他叫法、编号」。名称字段写「名称」，编号写「编号」，其余写字段标签 */
export function searchPlaceholder(entity: EntityType): string {
  const names = entity.list.search.map((k) =>
    k === '$code' ? '编号' : k === entity.titleKey ? '名称' : (listField(entity, k)?.label ?? k),
  );
  return `搜索${names.join('、')}`;
}

/** 这一条在 list.search 的某个字段里含有输入的字（不分大小写、忽略空白）；没有输入时都算 */
export function matchesQuery(entity: EntityType, row: ListRow, q: string | undefined, match: Matcher = plainMatch): boolean {
  if (!q || q.trim() === '') return true;
  return entity.list.search.some((k) => match(fieldText(row, k), q));
}

// ---------------- 筛选 ----------------

export interface FilterOption {
  value: string;
  label: string;
}

/** 生效的一项筛选 */
export interface ActivePick {
  field: FieldDef;
  value: string;
}

/**
 * 筛选按钮对应的字段（list.filters 的前 3 个）：找不到字段的、有序子项（没有可筛的值）跳过。
 * 按钮总是画出来（加载中、出错时也在，位置不跳）；还没有可选的值时按钮不可点
 */
export const filterFields = (entity: EntityType): FieldDef[] =>
  entity.list.filters
    .slice(0, MAX_FILTERS)
    .map((k) => listField(entity, k))
    .filter((f): f is FieldDef => f !== undefined && f.type !== 'subItems');

/**
 * 筛选按钮上的名字：一般是字段标签；两种取值都有写法的是否写成「境内/境外」（设计系统 D 页），
 * 按钮比「境内还是境外」短，生效后也写「境内/境外：境外」
 */
export const filterName = (f: FieldDef): string =>
  f.type === 'boolean' && f.falseLabel && f.trueLabel ? `${f.falseLabel}/${f.trueLabel}` : f.label;

/** URL 里生效的筛选：只认本实体的筛选字段，同一个字段只认第一项 */
export function activePicks(entity: EntityType, search: CatalogSearch): ActivePick[] {
  const fields = filterFields(entity);
  const out: ActivePick[] = [];
  for (const s of search.f ?? []) {
    const p = parseFilter(s);
    const field = p && fields.find((f) => f.key === p.key);
    if (p && field && !out.some((a) => a.field.key === field.key)) out.push({ field, value: p.value });
  }
  return out;
}

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/**
 * 一个值在筛选上的「原子」：筛选值等于其中之一就算命中。多选的字段有几项就是几个原子（按「包含」匹配）；
 * 月份区间是它覆盖的月份（「全年」覆盖 12 个月）；布尔是 'true' / 'false'；数字是它的十进制写法
 */
export function atomsOf(f: FieldDef, v: unknown): string[] {
  switch (f.type) {
    case 'enum':
      if (f.storeAs && typeof v === 'string') return parseStored(f, v) ?? [v];
      return Array.isArray(v) ? strings(v) : typeof v === 'string' && v !== '' ? [v] : [];
    case 'boolean':
      return typeof v === 'boolean' ? [String(v)] : [];
    case 'monthRange': {
      const r = typeof v === 'string' ? parseMonthRange(v) : null;
      if (!r) return [];
      return r.kind === 'yearRound' ? MONTHS : r.months.map(String);
    }
    case 'money':
    case 'intUnit':
      return typeof v === 'number' && Number.isFinite(v) ? [String(v)] : [];
    case 'status':
      return v === 'active' || v === 'draft' ? [v] : [];
    case 'subItems':
      return [];
    default:
      return Array.isArray(v) ? strings(v) : typeof v === 'string' && v !== '' ? [v] : [];
  }
}

export const matchesPick = (row: ListRow, p: ActivePick): boolean => atomsOf(p.field, cellValue(row, p.field.key)).includes(p.value);

/** 按类型写一个取值：数字带单位和千分位，引用写被引用条目的名称（库里找不到写原文） */
function valueLabel(f: FieldDef, value: string, refItems: readonly RefItem[] | undefined): string {
  if (f.type === 'money') return money(Number(value), f.unit ?? (f.unitFrom ? '' : '元'));
  if (f.type === 'intUnit') return quantity(Number(value), f.unit ?? '');
  if (f.type === 'reference') return resolveRef(f, value, refItems)?.name ?? value;
  return value;
}

const zhOrder = (a: string, b: string): number => a.localeCompare(b, 'zh-Hans-CN');

/**
 * 筛选按钮的选项（spec「产品库列表 · 工具条」）：枚举取 options，布尔取 trueLabel / falseLabel，月份区间取 1–12 月，
 * 状态取已上架、草稿；其余类型取各条已有的值去重（数字从小到大，文字按写出来的拼音排，引用按名称）。有序子项没有可筛的值，返回空
 */
export function filterOptions(f: FieldDef, rows: readonly ListRow[], refItems?: readonly RefItem[]): FilterOption[] {
  switch (f.type) {
    case 'enum':
      return (f.options ?? []).map((o) => ({ value: o, label: o }));
    case 'boolean':
      // 先 falseLabel 后 trueLabel，与表单的分段控件同一个顺序（「境内 / 境外」）
      return [
        { value: 'false', label: f.falseLabel ?? '否' },
        { value: 'true', label: f.trueLabel ?? '是' },
      ];
    case 'monthRange':
      return MONTHS.map((m) => ({ value: m, label: `${m}月` }));
    case 'status':
      return (['active', 'draft'] as const).map((s) => ({ value: s, label: STATUS_LABEL[s] }));
    case 'subItems':
      return [];
    default: {
      const seen = new Set<string>();
      for (const r of rows) for (const a of atomsOf(f, cellValue(r, f.key))) seen.add(a);
      const out = [...seen].map((value) => ({ value, label: valueLabel(f, value, refItems) }));
      out.sort(
        f.type === 'money' || f.type === 'intUnit' ? (a, b) => Number(a.value) - Number(b.value) : (a, b) => zhOrder(a.label, b.label),
      );
      return out;
    }
  }
}

/** 生效的筛选按钮上写的值：选项里有就用选项的写法，没有（地址里带来的、数据里已经没有的值）按类型写 */
export function pickLabel(p: ActivePick, options: readonly FilterOption[], refItems?: readonly RefItem[]): string {
  return options.find((o) => o.value === p.value)?.label ?? valueLabel(p.field, p.value, refItems);
}

// ---------------- 页签、排序 ----------------

/** 搜索与筛选之后的条目（页签在这之上再按状态分） */
export function narrowed(entity: EntityType, rows: readonly ListRow[], search: CatalogSearch, match: Matcher = plainMatch): ListRow[] {
  const picks = activePicks(entity, search);
  return rows.filter((r) => matchesQuery(entity, r, search.q, match) && picks.every((p) => matchesPick(r, p)));
}

export interface TabCounts {
  all: number;
  active: number;
  draft: number;
}

/** 页签上的数字：前端按列表计数 */
export function tabCounts(rows: readonly ListRow[]): TabCounts {
  let active = 0;
  let draft = 0;
  for (const r of rows) {
    if (r.status === 'active') active += 1;
    else if (r.status === 'draft') draft += 1;
  }
  return { all: rows.length, active, draft };
}

const time = (r: ListRow): number => (r.updatedAt ? Date.parse(r.updatedAt) : Number.NaN);

/** 默认按更新时间倒序；同一时刻的（一次导入的）照接口给的顺序。匿名投影没有更新时间，照接口的顺序 */
export function sortRows(rows: readonly ListRow[]): ListRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) === Number.isNaN(tb) ? 0 : Number.isNaN(ta) ? 1 : -1;
    return tb - ta;
  });
  return out;
}

/** 表格里的条目：搜索、筛选、页签（匿名没有页签），再排序 */
export function visibleRows(
  entity: EntityType,
  rows: readonly ListRow[],
  search: CatalogSearch,
  anon: boolean,
  match: Matcher = plainMatch,
): ListRow[] {
  const base = narrowed(entity, rows, search, match);
  const status = anon ? undefined : search.status;
  return sortRows(status ? base.filter((r) => r.status === status) : base);
}
