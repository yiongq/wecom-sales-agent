// 一张分组卡片里的表单网格（设计系统 §6.0、§6.4）：两列，列间距 24、字段之间 20；长类型占满一行；多字段的有序子项自成区块，
// 排在网格后面；整卡锁定、3 个及以上短值时排成 4 列，列宽按内容自适应（owner 2026-09-27）。怎么排只看字段类型和锁定状态
// （model.ts 的 groupGrid）。卡片本身（标题、锁定 Tag 与原因）由页面画（catalog/CatalogDetail.tsx），这里只排卡片体。
// 锁怎么挂（§6.4）：卡片头声明了锁定、整卡又都锁着时，字段不挂锁，经 aria-describedby 指向卡片头的原因；混合卡里
// 锁定的字段挂锁；锁定组已经在别的卡片头声明过（原因每组只说一次），这张卡虽然整卡锁着，字段照样挂锁。
// 给了 original（打开时的内容）就标出改过的字段（「已改」），并给「撤销这处」；有序子项另按它给子字段标「已改」。
// 有序子项的区块头右侧写条数提醒或「条数随天数锁定，文字可改」（model.ts 的 countNote，第 11 步）。
// 给了 onUpdate（按函数改表单状态）时，每个字段只在自己的值（和它读的单位字段）变了才重画：详情页逐字重渲，
// 下拉、联想、Tooltip 打开过一次以后弹层还挂着，@rc-component/portal 每次重画都在 effect 里 setState，
// 快速连按时 React 报 #185（Maximum update depth exceeded，话术页第 5 步遇到过同一个问题）。
import { memo } from 'react';
import { type FieldDef, type EntityType, valueAt } from '../../../src/shared/pack.js';
import { FormField, type FormFieldProps, type LockMark } from './FormField.js';
import {
  countLocked,
  countNote,
  fieldChanged,
  type GridCell,
  groupGrid,
  type ItemContext,
  lockedMembers,
  locksOnActivate,
  type Payload,
  readValue,
  restoreField,
  writeValue,
} from './model.js';

interface GridBase {
  entity: EntityType;
  /** EntityType.groups 的 key */
  group: string;
  /** 表单状态（条目 payload 的深拷贝） */
  state: Payload;
  ctx: ItemContext;
  /** 整卡锁定时卡片头锁定说明的 id：字段不挂锁，经 aria-describedby 指过去 */
  lockNoteId?: string;
  /** 卡片头声明了哪些锁定组（EntityType.lockGroups 的 key）；不给就是整张卡的锁都由卡片头说明 */
  declaredLocks?: readonly string[];
  /**
   * 字段下方的报错，按位置：字段的 FieldDef.key；有序子项里的一项或一项里的子字段接下标与子字段 key
   * （'itinerary.2'、'itinerary.2.hotel'，catalog/save.ts 的 placeOf）
   */
  errors?: Readonly<Record<string, string>>;
  /** 打开时的内容：给了就标出改过的字段，并能「撤销这处」 */
  original?: Payload;
}

/**
 * 写回表单状态，两种给法取其一：onChange 收写回后的整个表单状态；onUpdate 收一个函数（React 的 setState 写法），
 * 这时字段不因为别的字段改了而重画，没重画的字段手里的表单状态是旧的，按函数改才不会盖掉别处的改动
 */
export type FieldGridProps = GridBase &
  ({ onChange(next: Payload): void; onUpdate?: never } | { onUpdate(fn: (state: Payload) => Payload): void; onChange?: never });

/**
 * 字段读的别的字段：它们变了这个字段也要重画。金额的单位取自 unitFrom；引用按 filterBy 筛候选（目的地换了，
 * 「酒店库 · 贵州」跟着换），有序子项里的引用子字段同样。条数提醒不在这里：它是字符串 prop（countNote），本身就比
 */
const depsOf = (f: FieldDef, state: Payload): readonly unknown[] => {
  const keys = [f.unitFrom, f.filterBy, ...(f.item ?? []).map((s) => s.filterBy)].filter((k): k is string => k !== undefined);
  return keys.map((k) => valueAt(state, k));
};

export type MemoProps = FormFieldProps & { deps: readonly unknown[] };

const sameList = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

type Notes = Readonly<Record<string, string>> | undefined;
const sameNotes = (a: Notes, b: Notes): boolean => a === b || sameList(Object.entries(a ?? {}).flat(), Object.entries(b ?? {}).flat());

/** 有序子项里各处的报错，键去掉字段 key 那一段（'itinerary.2.hotel' → '2.hotel'）；没有时 undefined */
export function itemErrorsOf(errors: Notes, key: string): Notes {
  const pre = `${key}.`;
  const out = Object.entries(errors ?? {}).filter(([k]) => k.startsWith(pre));
  return out.length ? Object.fromEntries(out.map(([k, v]) => [k.slice(pre.length), v])) : undefined;
}

/**
 * 只在画出来的东西变了时重画：回调（onChange、onUndo）按函数改状态，不怕旧；row 只给金额取单位、引用取 filterBy 的值，
 * 这两样在 deps 里比。
 * 值按引用比：writeValue 只复制改动路径上的对象，别的字段的值还是原来那个；有序子项里各处的报错每次是新对象，按内容比
 */
export function sameCell(a: MemoProps, b: MemoProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof MemoProps)[]);
  for (const k of keys) {
    if (k === 'onChange' || k === 'onUndo' || k === 'row') continue;
    if (k === 'deps' || k === 'lockedMembers') {
      if (!sameList(a[k], b[k])) return false;
    } else if (k === 'itemErrors') {
      if (!sameNotes(a[k], b[k])) return false;
    } else if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

const MemoField = memo(function MemoField({ deps: _deps, ...p }: MemoProps) {
  return <FormField {...p} />;
}, sameCell);

export function FieldGrid(p: FieldGridProps) {
  const { entity, group, state, ctx, lockNoteId, declaredLocks, errors, original, onUpdate } = p;
  const grid = groupGrid(entity, group, state, ctx);
  const apply = (fn: (s: Payload) => Payload): void => (onUpdate ? onUpdate(fn) : p.onChange?.(fn(state)));
  /** 这个字段的锁由卡片头说明：整卡都锁着，卡片头又声明了它的锁定组 */
  const noted = (c: GridCell): boolean =>
    grid.allLocked &&
    lockNoteId !== undefined &&
    (declaredLocks === undefined || (c.field.lockGroup !== undefined && declaredLocks.includes(c.field.lockGroup)));
  const field = (c: GridCell) => {
    const f = c.field;
    const mark: LockMark = c.mode === 'locked' && !noted(c) ? 'icon' : locksOnActivate(f, ctx) ? 'will-lock' : null;
    const props: FormFieldProps = {
      field: f,
      mode: c.mode,
      span: c.span,
      value: readValue(state, f.key),
      row: state,
      onChange: (v) => apply((s) => writeValue(s, f, v)),
      lockMark: mark,
      lockNoteId: noted(c) ? lockNoteId : undefined,
      error: errors?.[f.key],
      itemErrors: f.type === 'subItems' ? itemErrorsOf(errors, f.key) : undefined,
      countLocked: f.type === 'subItems' ? countLocked(entity, f, ctx) : undefined,
      countNote: f.type === 'subItems' ? countNote(entity, f, state, ctx) : undefined,
      // 有序子项按打开时的值给子字段标「已改」；值取自打开时的那个对象，引用不变，不妨碍按字段记忆
      original: f.type === 'subItems' && original !== undefined ? valueAt(original, f.key) : undefined,
      changed: original !== undefined && fieldChanged(original, state, f),
      onUndo: original === undefined ? undefined : () => apply((s) => restoreField(s, original, f)),
      lockedMembers: lockedMembers(f, ctx),
      lockGroup: f.lockGroup === undefined ? undefined : entity.lockGroups[f.lockGroup],
    };
    return onUpdate ? <MemoField key={f.key} {...props} deps={depsOf(f, state)} /> : <FormField key={f.key} {...props} />;
  };
  const inGrid = grid.cells.filter((c) => c.span !== 'block');
  const blocks = grid.cells.filter((c) => c.span === 'block');
  return (
    <div className="field-group">
      {inGrid.length ? <div className={`field-grid field-grid-${grid.columns}`}>{inGrid.map(field)}</div> : null}
      {blocks.map(field)}
    </div>
  );
}
