// 一张分组卡片里的表单网格（设计系统 §6.0、§6.4）：两列，列间距 24、字段之间 20；长类型占满一行；多字段的有序子项自成区块，
// 排在网格后面；整卡锁定、3 个及以上短值时排成 4 列，列宽按内容自适应（owner 2026-09-27）。怎么排只看字段类型和锁定状态
// （model.ts 的 groupGrid）。卡片本身（标题、锁定 Tag 与原因）由页面画（catalog/CatalogDetail.tsx），这里只排卡片体。
// 锁怎么挂（§6.4）：卡片头声明了锁定、整卡又都锁着时，字段不挂锁，经 aria-describedby 指向卡片头的原因；混合卡里
// 锁定的字段挂锁；锁定组已经在别的卡片头声明过（原因每组只说一次），这张卡虽然整卡锁着，字段照样挂锁。
// 给了 original（打开时的内容）就标出改过的字段（「已改」），并给「撤销这处」。
import type { EntityType } from '../../../src/shared/pack.js';
import { FormField, type LockMark } from './FormField.js';
import {
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

export interface FieldGridProps {
  entity: EntityType;
  /** EntityType.groups 的 key */
  group: string;
  /** 表单状态（条目 payload 的深拷贝） */
  state: Payload;
  ctx: ItemContext;
  /** 写回后的整个表单状态 */
  onChange(next: Payload): void;
  /** 整卡锁定时卡片头锁定说明的 id：字段不挂锁，经 aria-describedby 指过去 */
  lockNoteId?: string;
  /** 卡片头声明了哪些锁定组（EntityType.lockGroups 的 key）；不给就是整张卡的锁都由卡片头说明 */
  declaredLocks?: readonly string[];
  /** 字段下方的报错，按 FieldDef.key */
  errors?: Readonly<Record<string, string>>;
  /** 打开时的内容：给了就标出改过的字段，并能「撤销这处」 */
  original?: Payload;
}

export function FieldGrid({ entity, group, state, ctx, onChange, lockNoteId, declaredLocks, errors, original }: FieldGridProps) {
  const grid = groupGrid(entity, group, state, ctx);
  /** 这个字段的锁由卡片头说明：整卡都锁着，卡片头又声明了它的锁定组 */
  const noted = (c: GridCell): boolean =>
    grid.allLocked &&
    lockNoteId !== undefined &&
    (declaredLocks === undefined || (c.field.lockGroup !== undefined && declaredLocks.includes(c.field.lockGroup)));
  const field = (c: GridCell) => {
    const f = c.field;
    const mark: LockMark = c.mode === 'locked' && !noted(c) ? 'icon' : locksOnActivate(f, ctx) ? 'will-lock' : null;
    return (
      <FormField
        key={f.key}
        field={f}
        mode={c.mode}
        span={c.span}
        value={readValue(state, f.key)}
        row={state}
        onChange={(v) => onChange(writeValue(state, f, v))}
        lockMark={mark}
        lockNoteId={noted(c) ? lockNoteId : undefined}
        error={errors?.[f.key]}
        changed={original !== undefined && fieldChanged(original, state, f)}
        onUndo={original === undefined ? undefined : () => onChange(restoreField(state, original, f))}
        lockedMembers={lockedMembers(f, ctx)}
        lockGroup={f.lockGroup === undefined ? undefined : entity.lockGroups[f.lockGroup]}
      />
    );
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
