// 表单里的一个字段（设计系统 §5.2、§6.4）：标签在上（13/20/500 text，不加冒号、不加星，选填加「（选填）」），下面是控件或只读值，
// 再下面常驻帮助（13/20 text-2）；有报错时报错（13 danger，前置 circle-x）顶替帮助。
// 只读（上架后锁定、没有编辑权限）画成正文色的文本，不画输入框、不用禁用样式，可以选中复制；只读时不写帮助和「（选填）」。
// 锁怎么挂（§6.4）：整卡都锁时字段不挂锁，aria-describedby 指向卡片头的锁定说明；混合卡里锁定字段的标签后挂 12 的 lock；
// 草稿里上架后会锁的字段，标签后写「上架后锁定」加 lock；没有编辑权限的只读不挂锁。
// 多字段的有序子项自成区块：标签换成区块头「逐日行程 · 5天」。
import { CircleX, Lock } from 'lucide-react';
import { useId } from 'react';
import type { FieldDef } from '../../../src/shared/pack.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import type { FieldMode, Payload, Span } from './model.js';
import { enumControl, nounOf } from './model.js';
import { RENDERERS } from './renderers.js';

/** icon：混合卡里上架后锁定的字段；will-lock：草稿里上架后会锁的字段 */
export type LockMark = 'icon' | 'will-lock' | null;

export interface FormFieldProps {
  field: FieldDef;
  mode: FieldMode;
  span: Span;
  value: unknown;
  /** 值所在的对象（整条 payload，或有序子项的一项） */
  row: Payload;
  /** 可改时必须给 */
  onChange?(next: unknown): void;
  lockMark?: LockMark;
  /** 整卡锁定时卡片头锁定说明的 id（卡片头在第 10.1 步） */
  lockNoteId?: string;
  /** 字段下方的报错（第 10.2 步按「碰过的字段」给） */
  error?: string;
  lockedMembers?: readonly string[];
  lockGroup?: { tag: string; reason: string };
}

/** 这些控件是一组按钮（分段控件、多选片、开关、逐条列表、子项卡片），没有单个输入框可以挂 label，标签经 aria-labelledby 连上 */
function isGroupControl(f: FieldDef): boolean {
  if (f.type === 'boolean' || f.type === 'subItems') return true;
  return f.type === 'enum' && enumControl(f) !== 'select';
}

export function FormField(p: FormFieldProps) {
  const { field, mode, span, value, row, error } = p;
  const uid = useId();
  const id = `${uid}c`;
  const labelId = `${uid}l`;
  const noteId = `${uid}n`;
  const R = RENDERERS[field.type];
  const editing = mode === 'edit' && p.onChange !== undefined;
  const note = error ?? (editing ? field.help : undefined);
  const labelText = cjk(field.label);

  const head =
    span === 'block' ? (
      <div id={labelId} className="field-block-head">
        {cjk([field.label, `${Array.isArray(value) ? value.length : 0}${nounOf(field)}`])}
      </div>
    ) : (
      <div className="field-label-row">
        {editing && !isGroupControl(field) ? (
          <label id={labelId} htmlFor={id} className="field-label">
            {labelText}
          </label>
        ) : (
          <span id={labelId} className="field-label">
            {labelText}
          </span>
        )}
        {editing && field.required === false ? <span className="optional-mark">（选填）</span> : null}
        {p.lockMark === 'icon' ? (
          <span className="field-lock" role="img" aria-label="上架后锁定">
            <Icon of={Lock} size={12} />
          </span>
        ) : null}
        {p.lockMark === 'will-lock' ? (
          <span className="field-will-lock">
            上架后锁定
            <Icon of={Lock} size={12} />
          </span>
        ) : null}
      </div>
    );

  return (
    <div
      className={`field field-${span}${editing ? '' : ' is-static'}`}
      role={editing ? undefined : 'group'}
      aria-labelledby={editing ? undefined : labelId}
      aria-describedby={editing ? undefined : p.lockNoteId}
    >
      {head}
      {editing ? (
        <R.Form
          field={field}
          value={value}
          row={row}
          id={id}
          labelId={labelId}
          describedBy={note ? noteId : undefined}
          invalid={error !== undefined}
          lockedMembers={p.lockedMembers}
          lockGroup={p.lockGroup}
          onChange={p.onChange!}
        />
      ) : (
        <div className="field-value">
          <R.View field={field} value={value} row={row} lockedMembers={p.lockedMembers} lockGroup={p.lockGroup} />
        </div>
      )}
      {note ? (
        <div id={noteId} className={error === undefined ? 'field-help' : 'field-error'}>
          {error === undefined ? null : <Icon of={CircleX} size={14} />}
          {cjk(note)}
        </div>
      ) : null}
    </div>
  );
}
