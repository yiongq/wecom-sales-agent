// 表单里的一个字段（设计系统 §5.2、§6.4）：标签在上（13/20/500 text，不加冒号、不加星，选填加「（选填）」），下面是控件或只读值，
// 再下面常驻帮助（13/20 text-2）；有报错时报错（13 danger，前置 circle-x）顶替帮助。
// 只读（上架后锁定、没有编辑权限）画成正文色的文本，不画输入框、不用禁用样式，可以选中复制；只读时不写帮助和「（选填）」。
// 锁怎么挂（§6.4）：整卡都锁时字段不挂锁，aria-describedby 指向卡片头的锁定说明；混合卡里锁定字段的标签后挂 12 的 lock；
// 草稿里上架后会锁的字段，标签后写「上架后锁定」加 lock；没有编辑权限的只读不挂锁。
// 多字段的有序子项自成区块：标签换成区块头「逐日行程 · 5天」，右侧是条数提醒（「还差1天」，warning）或
// 「条数随天数锁定，文字可改」（text-2，前置锁）。
// 长文本超过 softMax（§5.2、§6 表）：帮助换成 warning 色的「手机上会很长（建议120字以内）」，不拦；报错仍然优先。
// 有序子项里的引用字段（spec「有序子项与引用」）：标签行右侧是文字按钮「复制上一{itemNoun}的{字段名}」，
// 点了以后焦点放进这个字段的控件（按钮随即可能消失：两项一样了就不再画）。
// 改过还没保存的字段（§6.5）：标签后 6 处一个 6px 主色圆点加「已改」；悬停或焦点在这个字段里时，同一行右侧出现「撤销这处」。
// 外层带 data-field-key（FieldDef.key）：上架前检查点一项时，页面按它找到字段、把焦点放进去。
import { CircleX, Lock, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { FieldDef } from '../../../src/shared/pack.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import type { FieldMode, Payload, Span } from './model.js';
import { enumControl, nounOf, overSoftMax, type Written } from './model.js';
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
  /** 字段外面、也说的是它的报错的 id（有序子项一项本身的报错，写在序号下面）：拼进控件的 aria-describedby */
  describedBy?: string;
  /** 有序子项里各处的报错：键是下标（'2'）或下标接子字段 key（'2.hotel'），写在那一项、那个子字段下方 */
  itemErrors?: Readonly<Record<string, string>>;
  /** 有序子项的条数随另一个字段锁定（model.ts 的 countLocked）：不画增删和移动 */
  countLocked?: boolean;
  /** 区块头右侧的说明（model.ts 的 countNote）：条数锁定时是锁定说明，不然是条数提醒；没有就不画 */
  countNote?: string;
  /** 打开时这个字段的值：有序子项按它给子字段标「已改」（model.ts 的 subChanged）；新建不给 */
  original?: unknown;
  /** 本条目的内容：有序子项里的字段要它（引用按 filterBy 筛候选，filterBy 是顶层字段）；顶层字段不给，用 row */
  scope?: Payload;
  /** 「本条写过的」：有序子项里的引用字段，别的项写过的值 */
  written?: readonly Written[];
  /** 「复制上一{itemNoun}的{字段名}」：text 是按钮的字，点了 onCopy 写回，焦点随后放进这个字段的控件 */
  copyPrev?: { text: string; onCopy(): void };
  /** 加在字段外层的 class（有序子项卡片里右上角让出操作按钮的那一格） */
  className?: string;
  lockedMembers?: readonly string[];
  lockGroup?: { tag: string; reason: string };
  /** 改过、还没保存：标签后写「已改」（只在可改时画） */
  changed?: boolean;
  /** 「撤销这处」：把这个字段放回打开时的值；不给就没有这个链接 */
  onUndo?(): void;
}

/** 这些控件是一组按钮（分段控件、多选片、开关、逐条列表、子项卡片），没有单个输入框可以挂 label，标签经 aria-labelledby 连上 */
function isGroupControl(f: FieldDef): boolean {
  if (f.type === 'boolean' || f.type === 'subItems') return true;
  return f.type === 'enum' && enumControl(f) !== 'select';
}

/** 长文本超过 softMax 时顶替帮助的提示 */
export const softMaxNote = (f: FieldDef): string => `手机上会很长（建议${f.softMax ?? 0}字以内）`;

export function FormField(p: FormFieldProps) {
  const { field, mode, span, value, row, error } = p;
  const uid = useId();
  const id = `${uid}c`;
  const labelId = `${uid}l`;
  const noteId = `${uid}n`;
  const countId = `${uid}k`;
  const R = RENDERERS[field.type];
  const editing = mode === 'edit' && p.onChange !== undefined;
  // 字段下方一行：报错优先；长文本超过 softMax 时是 warning 色的提示；其余是帮助
  const long = editing && error === undefined && overSoftMax(field, value);
  const note = error ?? (long ? softMaxNote(field) : editing ? field.help : undefined);
  const countNote = span === 'block' && editing ? p.countNote : undefined;
  const describedBy = [p.describedBy, note ? noteId : undefined, countNote ? countId : undefined].filter(Boolean).join(' ') || undefined;
  // 点了「复制上一天的…」以后，等写回的这一轮画完，把焦点放进这个字段的控件
  const focusAfterCopy = useRef(false);
  useEffect(() => {
    if (!focusAfterCopy.current) return;
    focusAfterCopy.current = false;
    document.getElementById(id)?.focus();
  });
  const copy =
    editing && p.copyPrev ? (
      <button
        type="button"
        className="field-copy"
        onClick={() => {
          focusAfterCopy.current = true;
          p.copyPrev?.onCopy();
        }}
      >
        {cjk(p.copyPrev.text)}
      </button>
    ) : null;
  const labelText = cjk(field.label);
  const changed = editing && p.changed === true;
  const undo =
    changed && p.onUndo ? (
      <button type="button" className="field-undo" aria-label={`撤销这处：${field.label}`} onClick={p.onUndo}>
        撤销这处
      </button>
    ) : null;
  const changedMark = changed ? (
    <span className="field-changed">
      <span className="field-changed-dot" aria-hidden="true" />
      已改
    </span>
  ) : null;

  const head =
    span === 'block' ? (
      <div className="field-block-row">
        <div id={labelId} className="field-block-head">
          {cjk([field.label, `${Array.isArray(value) ? value.length : 0}${nounOf(field)}`])}
        </div>
        {changedMark}
        {undo}
        {countNote ? (
          <span id={countId} className={p.countLocked ? 'count-note is-locked' : 'count-note'}>
            {p.countLocked ? <Icon of={Lock} size={12} /> : null}
            {cjk(countNote)}
          </span>
        ) : null}
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
        {changedMark}
        {undo}
        {copy}
      </div>
    );

  const cls = ['field', `field-${span}`, editing ? '' : 'is-static', changed ? 'is-changed' : '', p.className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      data-field-key={field.key}
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
          describedBy={describedBy}
          invalid={error !== undefined}
          lockedMembers={p.lockedMembers}
          lockGroup={p.lockGroup}
          itemErrors={p.itemErrors}
          countLocked={p.countLocked}
          original={p.original}
          scope={p.scope}
          written={p.written}
          onChange={p.onChange!}
        />
      ) : (
        <div className="field-value">
          <R.View field={field} value={value} row={row} lockedMembers={p.lockedMembers} lockGroup={p.lockGroup} />
        </div>
      )}
      {note ? (
        <div id={noteId} className={error !== undefined ? 'field-error' : long ? 'field-soft' : 'field-help'}>
          {error !== undefined ? <Icon of={CircleX} size={14} /> : long ? <Icon of={TriangleAlert} size={14} /> : null}
          {cjk(note)}
        </div>
      ) : null}
    </div>
  );
}
