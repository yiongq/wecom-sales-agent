// 一张分组卡片里的表单网格（设计系统 §6.0、§6.4）：两列，列间距 24、字段之间 20；长类型占满一行；多字段的有序子项自成区块，
// 排在网格后面；整卡锁定、3 个及以上短值时排成 4 列，列宽按内容自适应（owner 2026-09-27）。怎么排只看字段类型和锁定状态
// （model.ts 的 groupGrid）。卡片本身（标题、锁定 Tag 与原因）在第 10.1 步，这里只排卡片体。
import type { EntityType } from '../../../src/shared/pack.js';
import { FormField, type LockMark } from './FormField.js';
import {
  type GridCell,
  groupGrid,
  type ItemContext,
  lockedMembers,
  locksOnActivate,
  type Payload,
  readValue,
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
  /** 字段下方的报错，按 FieldDef.key */
  errors?: Readonly<Record<string, string>>;
}

export function FieldGrid({ entity, group, state, ctx, onChange, lockNoteId, errors }: FieldGridProps) {
  const grid = groupGrid(entity, group, state, ctx);
  const field = (c: GridCell) => {
    const f = c.field;
    const mark: LockMark = c.mode === 'locked' && !grid.allLocked ? 'icon' : locksOnActivate(f, ctx) ? 'will-lock' : null;
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
        lockNoteId={grid.allLocked ? lockNoteId : undefined}
        error={errors?.[f.key]}
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
