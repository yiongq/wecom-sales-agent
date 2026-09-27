// 字段渲染器的纯逻辑（docs/features/console-ux/spec.md「行业包通用架构 · 字段类型渲染器」「表单状态与提交」，
// 设计系统 §6.0、§6.4）。不依赖 React 与 antd：fields.selftest.tsx 直接 import，表单与样张页都走这里。
// - 表单状态是条目 payload 的深拷贝，编辑按 FieldDef.key 的路径写回（writeValue），保存时 submission 算 set / unset；
//   showWhen 没显示出来的字段在表单状态里留着值（选回来原文还在），submission 时才剔除；
// - 按 storeAs 连成字符串的多选（旅游包的「当天餐食」）读写走 parseStored / formatStored：现有写法往返逐字节不变，
//   规则之外的旧值照原文保留，不自动改写；
// - 控件取值与写回走 CODECS（Record<FieldType, …>），不变量 16 的往返测的就是这一对；
// - 字段是可改、上架后锁定还是只读（fieldMode）；表单网格的列数与跨行（groupGrid）只看字段类型和锁定状态，不看是哪个行业包。
import { sameValue } from '../../../src/shared/catalog.js';
import { type EntityType, type FieldDef, type FieldType, filled, valueAt } from '../../../src/shared/pack.js';

export type Payload = Record<string, unknown>;

const isRecord = (v: unknown): v is Payload => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------- 表单状态与提交 ----------------

/** 表单状态：条目 payload 的深拷贝（structuredClone 保留键序：工具把条目原样 JSON.stringify 给模型，键序就是字节） */
export const formState = (payload: Payload): Payload => structuredClone(payload);

/** 按 FieldDef.key 的路径取值，与上架前检查（src/shared/pack.ts 的 checkItem）取的是同一个值 */
export const readValue = (state: Payload, key: string): unknown => valueAt(state, key);

const pathOf = (key: string): string[] => (key === '$code' ? ['id'] : key.split('.'));

/** 写一条路径，返回新对象（沿路复制，别的分支原样共用）。v 为 undefined 时删键；删空了的嵌套对象一起删 */
function setPath(obj: Payload, path: readonly string[], v: unknown): Payload {
  const [k, ...rest] = path;
  const out: Payload = { ...obj };
  if (rest.length === 0) {
    if (v === undefined) delete out[k];
    else out[k] = v;
    return out;
  }
  const child = Object.hasOwn(obj, k) && isRecord(obj[k]) ? obj[k] : {};
  const sub = setPath(child, rest, v);
  if (Object.keys(sub).length === 0) delete out[k];
  else out[k] = sub;
  return out;
}

/** 清空：空串、空数组 */
const cleared = (v: unknown): boolean => v === '' || (Array.isArray(v) && v.length === 0);

/**
 * 把一个字段的新值写回表单状态，返回新的状态，不改原来的（spec「表单状态与提交」）：
 * - 没有值（undefined、null）删键；选填字段清空（空串、空数组）也删键，01 的 schema 要求这些字段出现时不为空。
 *   必填字段清空留下空串或空数组，由上架前检查报「没填」（tags 这类必填数组本来就可以是 []）；
 * - 嵌套字段删空了所在的对象，就连对象一起删。
 * 以它为 showWhen 的字段这时不显示，但值留在表单状态里：体力强度误点「不填」再选回来，「最累的一段」原文还在。
 * 不显示的值由 submission 剔除（intensity 只剩 hardest 时 schema 不收）
 */
export function writeValue(state: Payload, field: FieldDef, value: unknown): Payload {
  const drop = value === undefined || value === null || (field.required === false && cleared(value));
  return setPath(state, pathOf(field.key), drop ? undefined : value);
}

/** showWhen 没显示出来的字段：值从表单状态里删掉，删空的嵌套对象一起删（有序子项的子字段不支持 showWhen） */
export function pruneHidden(state: Payload, fields: readonly FieldDef[]): Payload {
  let next = state;
  for (const f of fields) if (!visible(f, next) && valueAt(next, f.key) !== undefined) next = setPath(next, pathOf(f.key), undefined);
  return next;
}

/**
 * 保存时的补丁（01 的 PATCH：set 里点名的顶层字段整体替换，unset 里的删掉）。先剔除 showWhen 没显示出来的字段，
 * 再比：值变了的顶层键进 set（01 已有的 sameValue 判定，与键序无关），原来有、现在没了的进 unset。
 * 嵌套字段随它所在的顶层对象整体提交：体力强度选「不填」，整个 intensity 进 unset。打开条目不做改动时两者都为空（不变量 16）。
 * fields 是实体的字段
 */
export function submission(original: Payload, state: Payload, fields: readonly FieldDef[]): { set: Payload; unset: string[] } {
  const sent = pruneHidden(state, fields);
  const set: Payload = {};
  for (const [k, v] of Object.entries(sent)) if (!Object.hasOwn(original, k) || !sameValue(original[k], v)) set[k] = v;
  const unset = Object.keys(original).filter((k) => !Object.hasOwn(sent, k));
  return { set, unset };
}

// ---------------- 按 storeAs 存的多选 ----------------

/**
 * 选中的几项 → 存的字符串：按 options 的顺序、用 join 连起来，一项都没选时写 empty（「早/午/晚」「—」）。
 * 顺序跟选项走，不跟点选的先后：写回的字符串总是规则之内的写法（验收 18）
 */
export function formatStored(f: FieldDef, picks: readonly string[]): string {
  const s = f.storeAs ?? { join: '/', empty: '' };
  const on = (f.options ?? []).filter((o) => picks.includes(o));
  return on.length ? on.join(s.join) : s.empty;
}

/**
 * 存的字符串 → 选中的几项。只认 formatStored 写得出来的写法，所以 formatStored(f, parseStored(f, x)) === x（不变量 16）；
 * 顺序不对、有重复、不在选项里、带空格这些规则之外的旧值返回 null，界面照原文显示、提示写法不标准，不自动改写
 */
export function parseStored(f: FieldDef, text: string): string[] | null {
  if (!f.storeAs) return null;
  if (text === f.storeAs.empty) return [];
  const picks = text.split(f.storeAs.join);
  return formatStored(f, picks) === text ? picks : null;
}

// ---------------- 控件取值与写回 ----------------

/** 单选 enum 与引用是一个字符串；多选是字符串数组；按 storeAs 存的多选认得出时是数组，规则之外的旧值是原文字符串 */
export type EnumControl = string | readonly string[] | undefined;

export interface Codec<C> {
  /** 存的值 → 控件的值 */
  read(stored: unknown, f: FieldDef): C;
  /** 控件的值 → 要写回的值（再经 writeValue 写进表单状态） */
  write(control: C, f: FieldDef): unknown;
}

interface ControlOf {
  text: string;
  longText: string;
  money: number | null;
  intUnit: number | null;
  monthRange: string;
  enum: EnumControl;
  tags: readonly string[];
  boolean: boolean | undefined;
  subItems: readonly unknown[];
  reference: string | readonly string[] | undefined;
  status: unknown;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const asTexts = (v: unknown): readonly string[] => (Array.isArray(v) ? (v as string[]) : []);
const asNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const same = <C>(c: C): unknown => c;

const textCodec: Codec<string> = { read: asText, write: same };
const numberCodec: Codec<number | null> = { read: asNumber, write: (c) => c ?? undefined };

/**
 * 每种字段类型的控件取值与写回（不变量 12 的表之一：少一种类型 typecheck 就报错）。
 * 表单组件只经这一对读写，所以「读出来原样写回，表单状态不变」由自测对两个包的每个字段、每条现有数据逐一核对（不变量 16）
 */
export const CODECS: { readonly [T in FieldType]: Codec<ControlOf[T]> } = {
  text: textCodec,
  longText: textCodec,
  monthRange: textCodec,
  money: numberCodec,
  intUnit: numberCodec,
  enum: {
    read: (v, f) => {
      if (f.storeAs) return typeof v === 'string' ? (parseStored(f, v) ?? v) : [];
      if (f.multiple) return asTexts(v);
      return typeof v === 'string' ? v : undefined;
    },
    write: (c, f) => (f.storeAs && Array.isArray(c) ? formatStored(f, c) : c),
  },
  tags: { read: asTexts, write: same },
  boolean: { read: (v) => (typeof v === 'boolean' ? v : undefined), write: same },
  subItems: { read: (v) => (Array.isArray(v) ? v : []), write: same },
  reference: { read: (v, f) => (f.multiple ? asTexts(v) : typeof v === 'string' ? v : undefined), write: same },
  status: { read: same, write: same },
};

// ---------------- 锁定与只读 ----------------

/** 枚举用哪种控件（设计系统 §6、§5.4）：单选不超过 5 项用分段控件，多选不超过 6 项用多选片，超过的用下拉 */
export function enumControl(f: FieldDef): 'segmented' | 'chips' | 'select' {
  const n = f.options?.length ?? 0;
  if (f.multiple) return n <= 6 ? 'chips' : 'select';
  return n <= 5 ? 'segmented' : 'select';
}

/** 有序子项只有一个 key 为空的子字段时，每项就是一个值（行程亮点这类 string[]） */
export const isSingleItem = (f: FieldDef): boolean => f.item?.length === 1 && f.item[0].key === '';

export interface ItemContext {
  /** 新建（还没有编号）、草稿、已上架 */
  status: 'new' | 'draft' | 'active';
  /** 没有编辑权限（非编辑角色、匿名演示）：全只读，不挂锁（这些字段并没有被锁） */
  canEdit: boolean;
}

/** edit 画输入框；locked 是上架后锁定（编号建好后永远只读）；readonly 是没有编辑权限。后两种都画成正文色的文本（设计系统 §6.4） */
export type FieldMode = 'edit' | 'locked' | 'readonly';

export function fieldMode(f: FieldDef, ctx: ItemContext): FieldMode {
  if (!ctx.canEdit || f.type === 'status') return 'readonly';
  if (f.key === '$code') return ctx.status === 'new' ? 'edit' : 'locked';
  return f.lockedWhenActive === true && ctx.status === 'active' ? 'locked' : 'edit';
}

/** 只锁其中几项的标签字段（旅游包的「国内」）：已上架时这几项的有无不能改，可改的人才看得到锁 */
export const lockedMembers = (f: FieldDef, ctx: ItemContext): readonly string[] =>
  ctx.canEdit && ctx.status === 'active' && typeof f.lockedWhenActive === 'object' ? f.lockedWhenActive.members : [];

/**
 * 标签字段改了以后要写回的值：锁住的成员有无都不能变（01 的 'tags:国内'），已有的删不掉、没有的加不上。
 * 删掉了锁住的成员时整次改动不算（返回 null）；加上的锁住成员拿掉，其余照改
 */
export function keepLockedMembers(cur: readonly string[], next: readonly string[], locked: readonly string[]): string[] | null {
  if (cur.some((t) => locked.includes(t) && !next.includes(t))) return null;
  return next.filter((t) => !locked.includes(t) || cur.includes(t));
}

// ---------------- 控件的值 → 要写回的值 ----------------
// 组件只调这几个函数，自测逐个断言；组件接线另由自测在 DOM 里挂载、点击核对

/** 分段控件里「不填」一段的值，和「必填还没选」时给的值（不在选项里，所以一段都不选中）。选项是中文，撞不上 */
export const SEG_NONE = '$none';
export const SEG_UNSET = '$unset';

/** 单选 enum 的分段控件：选中「不填」写 undefined（删键），别的段写那一项 */
export const enumFromSegment = (seg: string | number): string | undefined => (seg === SEG_NONE ? undefined : String(seg));

/** 是否的分段控件当前选中哪一段：没有值时，选填选「不填」，必填一段都不选 */
export const boolSegment = (v: boolean | undefined, optional: boolean): string =>
  v === undefined ? (optional ? SEG_NONE : SEG_UNSET) : String(v);

/** 是否的分段控件：「不填」写 undefined，其余按段值写 true / false */
export const boolFromSegment = (seg: string | number): boolean | undefined => (seg === SEG_NONE ? undefined : seg === 'true');

/** 逐条列表改第 i 条：返回新数组，别的条原样 */
export const replaceAt = <T>(items: readonly T[], i: number, v: T): T[] => items.map((x, k) => (k === i ? v : x));

/** 逐条列表删第 i 条 */
export const removeAt = <T>(items: readonly T[], i: number): T[] => items.filter((_, k) => k !== i);

/** 多选片点一片：选中的取消，没选的接在后面；原有几项的顺序不变（按 storeAs 存的写回时再由 formatStored 按选项排） */
export const togglePick = (picks: readonly string[], o: string): string[] =>
  picks.includes(o) ? picks.filter((x) => x !== o) : [...picks, o];

/** 有序子项里第 i 项上移（-1）或下移（1）；到头了原样返回 null（按钮是 aria-disabled，点了不动） */
export function moveItem<T>(items: readonly T[], i: number, d: -1 | 1): T[] | null {
  const j = i + d;
  if (i < 0 || i >= items.length || j < 0 || j >= items.length) return null;
  const next = [...items];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** 草稿（含新建）里上架后会锁的字段：标签后提醒「上架后锁定」 */
export const locksOnActivate = (f: FieldDef, ctx: ItemContext): boolean =>
  ctx.canEdit && ctx.status !== 'active' && f.lockedWhenActive === true;

// ---------------- 表单网格 ----------------

/** half 占一格；wide 占满一行；block 不进网格、自成区块（多字段的有序子项） */
export type Span = 'half' | 'wide' | 'block';

interface Layout {
  /** 在表单网格里占多宽（设计系统 §6.0） */
  span(f: FieldDef): Span;
  /** 锁定时能不能挤进 4 列（§6.4：text、intUnit、money、单选 enum） */
  short(f: FieldDef): boolean;
}

const half: Layout = { span: () => 'half', short: () => true };
const wide: Layout = { span: () => 'wide', short: () => false };

/** 每种字段类型的网格规则（不变量 12 的表之一） */
export const LAYOUT: { readonly [T in FieldType]: Layout } = {
  text: half,
  intUnit: half,
  money: half,
  longText: wide,
  monthRange: wide,
  tags: wide,
  enum: { span: (f) => (f.multiple ? 'wide' : 'half'), short: (f) => !f.multiple },
  boolean: { span: () => 'half', short: () => false },
  reference: { span: (f) => (f.multiple ? 'wide' : 'half'), short: () => false },
  subItems: { span: (f) => (isSingleItem(f) ? 'wide' : 'block'), short: () => false },
  status: { span: () => 'half', short: () => false },
};

export interface GridCell {
  field: FieldDef;
  mode: FieldMode;
  span: Span;
}

export interface GroupGrid {
  /** 2 列；整卡锁定、3 个及以上短值时 4 列（§6.4，owner 2026-09-27；没有编辑权限的只读卡不算，spec 开放问题 9） */
  columns: 2 | 4;
  /** 整卡都是上架后锁定：锁只在卡片头挂一次，字段标签不挂锁 */
  allLocked: boolean;
  /** 按字段顺序；block 的不进网格，排在网格后面 */
  cells: GridCell[];
}

/** showWhen 没显示出来的字段不画 */
export const visible = (f: FieldDef, state: Payload): boolean => !f.showWhen || filled(valueAt(state, f.showWhen.key));

/**
 * 一张分组卡片里的字段怎么排（设计系统 §6.0、§6.4）。$status 不进表单（它在页头和副栏里）。
 * 4 列只给整卡锁定、全是短值、至少 3 个的卡片（spec「字段类型渲染器」、开放问题 9，owner 2026-09-27 已定）：
 * 有输入框的卡片（草稿、新建）和没有编辑权限看到的只读卡片都是两列
 */
export function groupGrid(entity: EntityType, group: string, state: Payload, ctx: ItemContext): GroupGrid {
  const cells = entity.fields
    .filter((f) => f.group === group && f.type !== 'status' && visible(f, state))
    .map((f): GridCell => ({ field: f, mode: fieldMode(f, ctx), span: LAYOUT[f.type].span(f) }));
  const four = cells.length >= 3 && cells.every((c) => c.mode === 'locked' && LAYOUT[c.field.type].short(c.field));
  return { columns: four ? 4 : 2, allLocked: cells.length > 0 && cells.every((c) => c.mode === 'locked'), cells };
}

// ---------------- 显示用的小函数 ----------------

/**
 * 金额的单位：写了 unit 就是它（「元/人」）；unitFrom 时取另一个 enum 字段的值拼成「元/㎡」，那个字段没填时写「元」
 */
export function moneyUnit(f: FieldDef, row: Payload): string {
  if (f.unit) return f.unit;
  const u = f.unitFrom === undefined ? undefined : valueAt(row, f.unitFrom);
  return typeof u === 'string' && u ? `元/${u}` : '元';
}

/** 有序子项的量词（「天」「条」「个节点」），没写时「项」 */
export const nounOf = (f: FieldDef): string => f.itemNoun ?? '项';

/** 第 n 项的序号标签：indexLabel 里的 {n} 换成序号（「D3」「节点3」）；没写 indexLabel 时就是序号 */
export const indexLabel = (f: FieldDef, n: number): string => (f.indexLabel ?? '{n}').replaceAll('{n}', String(n));

/**
 * 序号标签能不能写进竖轴的节点（设计系统 §6.3）：只有字母和数字、不超过 3 个字符（「D1」「D12」）。
 * 带汉字的（「节点3」）节点里只写序号，完整标签写在卡片第一行
 */
export const labelFitsNode = (label: string): boolean => /^[A-Za-z0-9]{1,3}$/.test(label);

/** 引用字段的候选：目标实体的一条。name 取目标实体 titleKey 的值 */
export interface RefItem {
  code: string;
  name: string;
  /** 匿名的列表没有状态 */
  status?: 'draft' | 'active';
}

/** 把目标实体的列表换成引用候选。payload 里取不到名称的写编号 */
export function refItemsOf(
  target: EntityType,
  items: readonly { code: string; status?: 'draft' | 'active'; payload: object }[],
): RefItem[] {
  return items.map((it) => {
    const name = valueAt(it.payload as Payload, target.titleKey);
    return { code: it.code, name: typeof name === 'string' && name ? name : it.code, status: it.status };
  });
}

/** 引用的值指向哪一条：store 为 label 时按名称找，否则按编号找；库里找不到（allowFree 写的库外文本、被删的条目）返回 null */
export function resolveRef(f: FieldDef, value: string, items: readonly RefItem[] | undefined): RefItem | null {
  return items?.find((it) => (f.store === 'label' ? it.name === value : it.code === value)) ?? null;
}
