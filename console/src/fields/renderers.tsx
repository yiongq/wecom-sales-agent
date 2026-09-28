// 字段类型渲染器（docs/features/console-ux/spec.md「行业包通用架构 · 字段类型渲染器」，设计系统 §6，ADR-004）。
// 每种 FieldType 三种形态：列表单元格（Cell）、表单（Form）、只读（View）。只读同时用于上架后锁定、没有编辑权限、匿名演示。
// 表是 Record<FieldType, FieldRenderer>：少写一种类型 typecheck 就报错（不变量 12）。新增字段类型要改这里，这是有意的：
// 字段类型是界面和行业包之间的契约。
// 表单控件只经 model.ts 的 CODECS 读写（不变量 16 的往返），不在挂载时写值：打开一条不做改动，表单状态一个字节也不变。
// 产品库文本只以文本节点渲染（不变量 28）；值为空写「—」。
import { AutoComplete, Button, type GetRef, Input, InputNumber, Segmented, Select, Tooltip } from 'antd';
import { ArrowDown, ArrowUp, Check, CircleX, Lock, Plus, Trash2, X } from 'lucide-react';
import { type ComponentType, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { digits, money, monthRangeText, parseMonthRange, quantity } from '../../../src/shared/format.js';
import type { FieldDef, FieldType } from '../../../src/shared/pack.js';
import { Status } from '../parts/Status.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import { useFieldEnv } from './env.js';
import { FormField } from './FormField.js';
import {
  boolFromSegment,
  boolSegment,
  CODECS,
  enumControl,
  enumFromSegment,
  indexLabel,
  isSingleItem,
  keepLockedMembers,
  LAYOUT,
  labelFitsNode,
  moneyUnit,
  moveItem,
  nounOf,
  type Payload,
  type RefItem,
  removeAt,
  replaceAt,
  resolveRef,
  SEG_NONE,
  SEG_UNSET,
  togglePick,
  writeValue,
} from './model.js';
import { MonthStrip } from './MonthStrip.js';

export interface CellProps {
  field: FieldDef;
  value: unknown;
  /** 这个值所在的对象（整条 payload，或有序子项的一项）：unitFrom 从这里取另一个字段 */
  row: Payload;
}

export interface ViewProps extends CellProps {
  /** 已上架时锁住的标签成员（旅游包的「国内」）：画锁，悬停说原因。没有编辑权限时不给 */
  lockedMembers?: readonly string[];
  /** 字段所在的锁定组（卡片头的 Tag 与原因）：锁住的标签成员的 Tooltip 用 */
  lockGroup?: { tag: string; reason: string };
}

export interface FormProps extends ViewProps {
  /** 控件的 id：标签的 htmlFor 指向它 */
  id: string;
  /** 标签元素的 id：分段控件、多选片这类没有单个输入框的控件用 aria-labelledby 指向它 */
  labelId: string;
  /** 没有可见标签时（行程亮点的某一条）的名字 */
  ariaLabel?: string;
  /** 帮助或报错的 id */
  describedBy?: string;
  /** 字段下方有报错：控件画出错色 */
  invalid?: boolean;
  /** 有序子项里各处的报错（键是下标，或下标接子字段 key），写在那一项、那个子字段下方（FormField 的 itemErrors） */
  itemErrors?: Readonly<Record<string, string>>;
  onChange(next: unknown): void;
}

export interface FieldRenderer {
  Cell: ComponentType<CellProps>;
  View: ComponentType<ViewProps>;
  Form: ComponentType<FormProps>;
}

/** 空值 */
const NONE = '—';

const shown = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : NONE);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isRecord = (v: unknown): v is Payload => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 控件共用的无障碍属性。own 是控件自己在下方写的提示或报错（月份认不出、写法不标准）：它的 id 拼进 aria-describedby，
 * 报错时另设 aria-invalid。读屏读得到它，和字段下方的帮助、报错一样
 */
function a11y(p: FormProps, own?: { noteId: string; invalid?: boolean }) {
  const describedBy = [p.describedBy, own?.noteId].filter(Boolean).join(' ');
  return {
    'aria-describedby': describedBy || undefined,
    'aria-invalid': p.invalid || own?.invalid || undefined,
    ...(p.ariaLabel ? { 'aria-label': p.ariaLabel } : { 'aria-labelledby': p.labelId }),
  };
}

// ---------------- text ----------------

function TextCell({ field, value }: CellProps) {
  // 编号用等宽字（设计系统 §2.3 的 code 字阶）
  return field.key === '$code' ? <span className="mono">{shown(value)}</span> : <>{cjk(shown(value))}</>;
}

function TextView({ field, value }: ViewProps) {
  const s = shown(value);
  return (
    <span className={field.key === '$code' ? 'field-text mono' : 'field-text'} title={s}>
      {field.key === '$code' ? s : cjk(s)}
    </span>
  );
}

function TextForm(p: FormProps) {
  const { field, value, onChange, id, invalid } = p;
  const env = useFieldEnv();
  const v = CODECS.text.read(value, field);
  const set = (c: string): void => onChange(CODECS.text.write(c, field));
  const common = { id, value: v, placeholder: field.placeholder, status: invalid ? ('error' as const) : undefined, ...a11y(p) };
  if (field.suggest) {
    // 联想：'distinct' 取本实体已有的值，数组就是给定的几项；只列包含当前输入、又不等于它的
    const pool = field.suggest === 'distinct' ? env.distinct(field.key) : field.suggest;
    const options = pool.filter((s) => s !== v && s.includes(v)).map((s) => ({ value: s }));
    return <AutoComplete {...common} options={options} onChange={(c: string) => set(c ?? '')} />;
  }
  return <Input {...common} onChange={(e) => set(e.target.value)} />;
}

// ---------------- longText ----------------

function LongTextCell({ value }: CellProps) {
  // 截成一行，悬停看全文
  const s = shown(value);
  return (
    <span className="field-clip" title={s}>
      {s}
    </span>
  );
}

function LongTextView({ value }: ViewProps) {
  return <p className="field-reading">{cjk(shown(value))}</p>;
}

/**
 * 文本域 3–12 行自动增高（设计系统 §5.2）。不用 antd 的 autoSize：它量高度时对一个隐藏的 textarea 调
 * setAttribute('style', …)，页面 CSP（style-src 没有 unsafe-inline）拦下这一步，隐藏的 textarea 就留在页面底上、量出来的高度也不对。
 * 这里按 scrollHeight 算，经 CSSOM 写 style.height（CSP 不管 CSSOM，也不是不变量 28 禁的 cssText / setAttribute）
 */
type TextAreaRef = GetRef<typeof Input.TextArea>;

function fitHeight(el: HTMLTextAreaElement): void {
  const s = getComputedStyle(el);
  const line = parseFloat(s.lineHeight) || 22;
  const border = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
  const chrome = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + border;
  el.style.height = 'auto';
  const want = el.scrollHeight + border;
  const h = Math.min(Math.max(want, line * 3 + chrome), line * 12 + chrome);
  el.style.height = `${h}px`;
  el.style.overflowY = want > h ? 'auto' : 'hidden';
}

function useAutoGrow(value: string): RefObject<TextAreaRef | null> {
  const ref = useRef<TextAreaRef>(null);
  // 文字变了时量：别的字段改动也会让整张表单重画，不必每次都强制重排
  const measured = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.resizableTextArea?.textArea;
    if (!el || measured.current === value) return;
    measured.current = value;
    fitHeight(el);
  }, [value]);
  // 文字没变、折行变了也要重量：容器变宽变窄、挂载时还看不见（宽 0）、字体换完。只看宽度，自己改高度不会再触发
  useLayoutEffect(() => {
    const el = ref.current?.resizableTextArea?.textArea;
    if (!el) return;
    let width = el.clientWidth;
    let live = true;
    let frame = 0;
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            // 下一帧再改高度：在回调里直接改，同一帧里又多出一次观察，WebKit 报「ResizeObserver loop」错误
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => fitHeight(el));
          });
    ro?.observe(el);
    void document.fonts?.ready.then(() => {
      if (live && el.isConnected) fitHeight(el);
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, []);
  return ref;
}

function LongTextForm(p: FormProps) {
  const { field, value, onChange, id, invalid } = p;
  const v = CODECS.longText.read(value, field);
  const ref = useAutoGrow(v);
  // 字数在右下角；超过 softMax 的提示在第 11 步
  return (
    <Input.TextArea
      ref={ref}
      id={id}
      className="field-textarea"
      value={v}
      rows={3}
      placeholder={field.placeholder}
      showCount
      status={invalid ? 'error' : undefined}
      onChange={(e) => onChange(CODECS.longText.write(e.target.value, field))}
      {...a11y(p)}
    />
  );
}

// ---------------- money / intUnit ----------------

/** 输入框里的千分位：显示「42,800」，读回时去掉逗号 */
const withCommas = (v: string | number | undefined): string =>
  v === undefined || v === '' ? '' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const withoutCommas = (s: string | undefined): string => (s ?? '').replace(/,/g, '');

function NumberForm(p: FormProps & { unit: string; min?: number; max?: number; kind: 'money' | 'intUnit' }) {
  const { field, value, onChange, id, invalid, unit, min, max, kind } = p;
  return (
    <InputNumber
      id={id}
      className="field-number"
      value={CODECS[kind].read(value, field)}
      min={min}
      max={max}
      precision={0}
      controls={false}
      formatter={withCommas}
      parser={withoutCommas}
      suffix={unit ? <span className="field-unit">{unit}</span> : undefined}
      status={invalid ? 'error' : undefined}
      onChange={(c) => onChange(CODECS[kind].write(typeof c === 'number' ? c : null, field))}
      {...a11y(p)}
    />
  );
}

function MoneyCell({ field, value, row }: CellProps) {
  if (typeof value !== 'number') return <>{shown(value)}</>;
  // 单位写在表头，单元格只写数；单位随另一个字段变（unitFrom）时表头写不了，跟在数后面
  return <span className="field-num">{field.unit ? digits(value) : money(value, moneyUnit(field, row))}</span>;
}

function MoneyView({ field, value, row }: ViewProps) {
  return <span className="field-text">{typeof value === 'number' ? money(value, moneyUnit(field, row)) : shown(value)}</span>;
}

function MoneyForm(p: FormProps) {
  return <NumberForm {...p} kind="money" unit={moneyUnit(p.field, p.row)} min={p.field.min} />;
}

function IntUnitCell({ field, value }: CellProps) {
  return <span className="field-num">{typeof value === 'number' ? quantity(value, field.unit ?? '') : shown(value)}</span>;
}

function IntUnitView({ field, value }: ViewProps) {
  return <span className="field-text">{typeof value === 'number' ? quantity(value, field.unit ?? '') : shown(value)}</span>;
}

function IntUnitForm(p: FormProps) {
  return <NumberForm {...p} kind="intUnit" unit={p.field.unit ?? ''} min={p.field.min} max={p.field.max} />;
}

// ---------------- monthRange ----------------

const currentMonth = (now: number): number | undefined => {
  const d = new Date(now);
  return Number.isFinite(d.getTime()) ? d.getMonth() + 1 : undefined;
};

function MonthRangeCell({ field, value }: CellProps) {
  const env = useFieldEnv();
  const range = typeof value === 'string' ? parseMonthRange(value) : null;
  // 规则之外的旧值（schema 也不收）照原文写
  if (!range) return <span className="field-meta">{shown(value)}</span>;
  return (
    <span className="field-months">
      <MonthStrip range={range} size="S" label={field.label} yearRoundLabel={field.yearRoundLabel} current={currentMonth(env.now)} />
      <span className="field-meta">{monthRangeText(range, field.yearRoundLabel)}</span>
    </span>
  );
}

/** L 号月份条加一行字：「5–10月 · 这些月份出发报价上浮10%」；表单预览在前面加「识别出：」 */
function MonthPreview({ field, text, recognized }: { field: FieldDef; text: string; recognized?: boolean }) {
  const env = useFieldEnv();
  const range = parseMonthRange(text);
  if (!range) return null;
  const words = monthRangeText(range, field.yearRoundLabel);
  const line = range.kind === 'months' && field.monthMeaning ? [words, field.monthMeaning] : [words];
  if (recognized) line[0] = `识别出：${line[0]}`;
  return (
    <div className="field-months-l">
      <MonthStrip range={range} size="L" label={field.label} yearRoundLabel={field.yearRoundLabel} current={currentMonth(env.now)} />
      <div className="field-meta">{cjk(line)}</div>
    </div>
  );
}

function MonthRangeView({ field, value }: ViewProps) {
  if (typeof value !== 'string' || !parseMonthRange(value)) return <span className="field-text">{shown(value)}</span>;
  return <MonthPreview field={field} text={value} />;
}

function MonthRangeForm(p: FormProps) {
  const { field, value, onChange, id, invalid } = p;
  const v = CODECS.monthRange.read(value, field);
  const unreadable = v !== '' && !parseMonthRange(v);
  const errorId = `${id}-unread`;
  return (
    <div className="field-stack">
      <Input
        id={id}
        value={v}
        placeholder={field.placeholder}
        status={invalid || unreadable ? 'error' : undefined}
        onChange={(e) => onChange(CODECS.monthRange.write(e.target.value, field))}
        {...a11y(p, unreadable ? { noteId: errorId, invalid: true } : undefined)}
      />
      {unreadable ? (
        <div id={errorId} className="field-error">
          <Icon of={X} size={14} />
          {cjk('没认出月份：写成「5月-10月」「11月-次年4月」或「全年」')}
        </div>
      ) : (
        <MonthPreview field={field} text={v} recognized />
      )}
    </div>
  );
}

// ---------------- enum ----------------

/** 存的值 → 要显示的几项；按 storeAs 存的认不出时返回原文 */
function enumPicks(field: FieldDef, value: unknown): readonly string[] | string {
  const c = CODECS.enum.read(value, field);
  if (typeof c === 'string') return field.storeAs ? c : [c];
  return c ?? [];
}

function EnumText({ field, value, cell }: { field: FieldDef; value: unknown; cell?: boolean }) {
  const picks = enumPicks(field, value);
  const s = typeof picks === 'string' ? picks : picks.join('、');
  // 多选在列表里是 14 text-2 的纯文字（设计系统 §6）
  return <span className={cell && field.multiple ? 'field-meta-14' : 'field-text'}>{cjk(s || NONE)}</span>;
}

function EnumCell({ field, value }: CellProps) {
  return <EnumText field={field} value={value} cell />;
}

function EnumView({ field, value }: ViewProps) {
  return <EnumText field={field} value={value} />;
}

/** 多选片（设计系统 §5.4）：选中的加 check 图标和 aria-pressed，颜色之外的第二个信号 */
function Chips({
  options,
  picks,
  onToggle,
  labelId,
  p,
}: {
  options: readonly string[];
  picks: readonly string[];
  onToggle(o: string): void;
  labelId: string;
  p: FormProps;
}) {
  return (
    <div className="field-chips" role="group" aria-labelledby={labelId} aria-describedby={p.describedBy}>
      {options.map((o) => {
        const on = picks.includes(o);
        return (
          <button key={o} type="button" className={on ? 'field-chip is-on' : 'field-chip'} aria-pressed={on} onClick={() => onToggle(o)}>
            {on ? <Icon of={Check} size={14} /> : null}
            {o}
          </button>
        );
      })}
    </div>
  );
}

function EnumForm(p: FormProps) {
  const { field, value, onChange, id, labelId, invalid } = p;
  const options = field.options ?? [];
  const c = CODECS.enum.read(value, field);
  const write = (next: string | readonly string[] | undefined): void => onChange(CODECS.enum.write(next, field));

  if (!field.multiple) {
    const one = typeof c === 'string' ? c : undefined;
    if (enumControl(field) === 'segmented') {
      // 单选且不超过 5 项用分段控件；选填时最前面加一段「不填」，必填且没有值时一段都不选
      const segs = [
        ...(field.required === false ? [{ value: SEG_NONE, label: '不填' }] : []),
        ...options.map((o) => ({ value: o, label: o })),
      ];
      const cur = one ?? (field.required === false ? SEG_NONE : SEG_UNSET);
      return (
        <Segmented
          id={id}
          options={segs}
          value={cur}
          onChange={(v) => write(enumFromSegment(v))}
          aria-labelledby={labelId}
          aria-describedby={p.describedBy}
        />
      );
    }
    return (
      <Select
        id={id}
        value={one}
        options={options.map((o) => ({ value: o, label: o }))}
        allowClear={field.required === false}
        status={invalid ? 'error' : undefined}
        onChange={(v: string | undefined) => write(v)}
        {...a11y(p)}
      />
    );
  }

  // 按 storeAs 存的旧值认不出：照原文给一个输入框，提示写法不标准，不自动改写（spec「表单状态与提交」）
  if (typeof c === 'string') {
    const hintId = `${id}-odd`;
    return (
      <div className="field-stack">
        <Input
          id={id}
          value={c}
          status={invalid ? 'error' : undefined}
          onChange={(e) => write(e.target.value)}
          {...a11y(p, { noteId: hintId })}
        />
        <div id={hintId} className="field-meta">
          这里的写法不标准
        </div>
      </div>
    );
  }
  const picks = c ?? [];
  const toggle = (o: string): void => write(togglePick(picks, o));
  if (enumControl(field) === 'chips') return <Chips options={options} picks={picks} onToggle={toggle} labelId={labelId} p={p} />;
  return (
    <Select
      id={id}
      mode="multiple"
      value={[...picks]}
      options={options.map((o) => ({ value: o, label: o }))}
      status={invalid ? 'error' : undefined}
      onChange={(v: string[]) => write(v)}
      {...a11y(p)}
    />
  );
}

// ---------------- tags ----------------

/** Tag（设计系统 §5.8）：22 高、--subtle 底、13 text-2。锁住的成员前面放锁、没有删除按钮 */
function FieldTag({ text, locked, lockTip, onClose }: { text: string; locked?: boolean; lockTip?: string; onClose?: () => void }) {
  const tag = (
    <span className="field-tag">
      {locked ? (
        <span className="field-tag-lock" role="img" aria-label="上架后锁定">
          <Icon of={Lock} size={12} />
        </span>
      ) : null}
      {text}
      {onClose && !locked ? (
        <button
          type="button"
          className="field-tag-close"
          aria-label={`删除${text}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          <Icon of={X} size={12} />
        </button>
      ) : null}
    </span>
  );
  return locked && lockTip ? <Tooltip title={lockTip}>{tag}</Tooltip> : tag;
}

const lockTipOf = (g: ViewProps['lockGroup']): string | undefined => (g ? `上架后锁定 · ${g.tag}：${g.reason}` : undefined);

function TagsCell({ value }: CellProps) {
  const all = texts(value);
  if (!all.length) return <>{NONE}</>;
  return (
    <span className="field-tags">
      {all.slice(0, 3).map((t, i) => (
        <FieldTag key={`${i}-${t}`} text={t} />
      ))}
      {all.length > 3 ? <span className="field-more">+{all.length - 3}</span> : null}
    </span>
  );
}

function TagsView({ value, lockedMembers = [], lockGroup }: ViewProps) {
  const all = texts(value);
  if (!all.length) return <span className="field-text">{NONE}</span>;
  return (
    <span className="field-tags">
      {all.map((t, i) => (
        <FieldTag key={`${i}-${t}`} text={t} locked={lockedMembers.includes(t)} lockTip={lockTipOf(lockGroup)} />
      ))}
    </span>
  );
}

function TagsForm(p: FormProps) {
  const { field, value, onChange, id, invalid, lockedMembers = [], lockGroup } = p;
  const env = useFieldEnv();
  const cur = CODECS.tags.read(value, field);
  const pool = field.suggest === 'distinct' ? env.distinct(field.key) : (field.suggest ?? []);
  // 锁住的成员有无都不能变：已有的删不掉，没有的加不上（01 的 'tags:国内'）
  const frozen = (t: string): boolean => lockedMembers.includes(t);
  const change = (next: string[]): void => {
    const kept = keepLockedMembers(cur, next, lockedMembers);
    if (kept) onChange(CODECS.tags.write(kept, field));
  };
  return (
    <Select
      id={id}
      mode="tags"
      value={[...cur]}
      options={pool.filter((t) => !frozen(t) || cur.includes(t)).map((t) => ({ value: t, label: t }))}
      status={invalid ? 'error' : undefined}
      tokenSeparators={['，', ',']}
      tagRender={({ value: t, onClose }) => (
        <FieldTag text={String(t)} locked={frozen(String(t))} lockTip={lockTipOf(lockGroup)} onClose={onClose} />
      )}
      onChange={change}
      {...a11y(p)}
    />
  );
}

// ---------------- boolean ----------------

const boolText = (f: FieldDef, v: unknown): string => (v === true ? (f.trueLabel ?? '是') : v === false ? (f.falseLabel ?? '否') : NONE);

function BooleanCell({ field, value }: CellProps) {
  return <>{cjk(boolText(field, value))}</>;
}

function BooleanView({ field, value }: ViewProps) {
  return <span className="field-text">{cjk(boolText(field, value))}</span>;
}

/**
 * 分段控件（设计系统 §6 表）：必填两段，没有默认值，逼人明确选一次（上架后锁定的字段选错了只能停机修）；
 * 选填最前面加一段「不填」，和选填的单选 enum 一样。选填原先是开关，可开关只有开、关两种，
 * 表示不了「没填」：打开再关上就写成 false，回不到没填（spec 顶部 Revisions，第 3.2 步评审之后）
 */
function BooleanForm(p: FormProps) {
  const { field, value, onChange, id, labelId } = p;
  const v = CODECS.boolean.read(value, field);
  const optional = field.required === false;
  const segs = [
    ...(optional ? [{ value: SEG_NONE, label: '不填' }] : []),
    { value: 'false', label: field.falseLabel ?? '否' },
    { value: 'true', label: field.trueLabel ?? '是' },
  ];
  return (
    <Segmented
      id={id}
      options={segs}
      value={boolSegment(v, optional)}
      onChange={(s) => onChange(CODECS.boolean.write(boolFromSegment(s), field))}
      aria-labelledby={labelId}
      aria-describedby={p.describedBy}
    />
  );
}

// ---------------- subItems ----------------

function SubItemsCell({ field, value }: CellProps) {
  // 「8天」「7个节点」「4条」
  return <span className="field-num">{Array.isArray(value) ? `${value.length}${nounOf(field)}` : NONE}</span>;
}

/** 多字段有序子项的一项里各子字段的只读值，两列 */
function ItemFields({ field, item, mode }: { field: FieldDef; item: Payload; mode: 'readonly' }) {
  return (
    <div className="field-grid field-grid-2">
      {(field.item ?? []).map((sub) => (
        <FormField
          key={sub.key}
          field={sub}
          mode={mode}
          span={LAYOUT[sub.type].span(sub)}
          value={Object.hasOwn(item, sub.key) ? item[sub.key] : undefined}
          row={item}
        />
      ))}
    </div>
  );
}

/** 只读：单字段写成列表；多字段写成只读时间轴（竖轴加节点，节点里写得下序号标签就写，写不下只写序号） */
function SubItemsView({ field, value }: ViewProps) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return <span className="field-text">{NONE}</span>;
  if (isSingleItem(field)) {
    return (
      <ol className="field-list">
        {items.map((it, i) => (
          <li key={i} data-item-index={i}>
            {cjk(shown(it))}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol className="subitems-timeline">
      {items.map((it, i) => {
        const full = indexLabel(field, i + 1);
        const fits = labelFitsNode(full);
        return (
          <li key={i} className="tl-item" data-item-index={i}>
            <span className="tl-node" aria-hidden={fits ? undefined : true}>
              {fits ? full : i + 1}
            </span>
            <div className="subitem-card">
              {fits ? null : <div className="subitem-label">{cjk(full)}</div>}
              <ItemFields field={field} item={isRecord(it) ? it : {}} mode="readonly" />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** 有序子项里一项的报错（字段下方报错的同一个样子：13 danger，前置 circle-x） */
function ItemError({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} className="field-error">
      <Icon of={CircleX} size={14} />
      {cjk(text)}
    </div>
  );
}

/** 单字段的有序子项（行程亮点、费用包含）：逐条一个输入框，上移、下移、删除，底部「添加一条」（设计系统 §6） */
function SingleListForm(p: FormProps) {
  const { field, value, onChange, id, labelId } = p;
  const items = CODECS.subItems.read(value, field);
  const sub = field.item![0]!;
  const R = RENDERERS[sub.type];
  const noun = nounOf(field);
  const set = (next: readonly unknown[]): void => onChange(CODECS.subItems.write(next, field));
  const move = (i: number, d: -1 | 1): void => {
    const next = moveItem(items, i, d);
    if (next) set(next);
  };
  return (
    <div className="field-list-edit" role="group" aria-labelledby={labelId} aria-describedby={p.describedBy}>
      {items.map((it, i) => {
        const error = p.itemErrors?.[String(i)];
        const errorId = `${id}-${i}e`;
        return (
          <div key={i} className="field-list-item" data-item-index={i}>
            <div className="field-list-row">
              <R.Form
                field={sub}
                value={it}
                row={{}}
                id={`${id}-${i}`}
                labelId={labelId}
                ariaLabel={`${field.label}第${i + 1}${noun}`}
                describedBy={error === undefined ? undefined : errorId}
                invalid={error !== undefined}
                onChange={(v) => set(replaceAt(items, i, v))}
              />
              <IconButton label="上移" icon={ArrowUp} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)} />
              <IconButton label="下移" icon={ArrowDown} aria-disabled={i === items.length - 1 || undefined} onClick={() => move(i, 1)} />
              <IconButton label={`删除这${noun}`} icon={Trash2} onClick={() => set(removeAt(items, i))} />
            </div>
            {error === undefined ? null : <ItemError id={errorId} text={error} />}
          </div>
        );
      })}
      <Button className="field-add" icon={<Icon of={Plus} />} onClick={() => set([...items, ''])}>
        {`添加一${noun}`}
      </Button>
    </div>
  );
}

/**
 * 多字段的有序子项（逐日行程、施工节点）：每项一张卡片，按子字段的类型渲染，可以改文字。
 * 每一项带 data-item-index（单字段的逐条列表、只读的列表与时间轴也带）：详情页的上架前检查按它找到「第3天」那一项。
 * 竖轴与节点状态、条数提醒、增删与上移下移、自动编号、条数锁定是通用有序子项编辑器（第 11 步）
 */
function ItemCardsForm(p: FormProps) {
  const { field, value, onChange, id } = p;
  const items = CODECS.subItems.read(value, field);
  const subs = field.item ?? [];
  return (
    <div className="subitems-edit">
      {items.map((it, i) => {
        const item = isRecord(it) ? it : {};
        const label = indexLabel(field, i + 1);
        const error = p.itemErrors?.[String(i)];
        return (
          <section key={i} className="subitem-card" aria-label={label} data-item-index={i}>
            <div className="subitem-label">{cjk(label)}</div>
            {error === undefined ? null : <ItemError id={`${id}-${i}e`} text={error} />}
            <div className="field-grid field-grid-2">
              {subs.map((sub) => (
                <FormField
                  key={sub.key}
                  field={sub}
                  mode="edit"
                  span={LAYOUT[sub.type].span(sub)}
                  value={Object.hasOwn(item, sub.key) ? item[sub.key] : undefined}
                  row={item}
                  error={p.itemErrors?.[`${i}.${sub.key}`]}
                  onChange={(v) => onChange(CODECS.subItems.write(replaceAt(items, i, writeValue(item, sub, v)), field))}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SubItemsForm(p: FormProps) {
  return isSingleItem(p.field) ? <SingleListForm {...p} /> : <ItemCardsForm {...p} />;
}

// ---------------- reference ----------------

/** 引用的名称：库里找得到就写名称（给了 itemLink 时是链接），被引用的是草稿时后面跟「草稿」；找不到写原文 */
function RefName({ field, value, items }: { field: FieldDef; value: string; items: readonly RefItem[] | undefined }) {
  const env = useFieldEnv();
  const hit = resolveRef(field, value, items);
  if (!hit) return <span className="field-ref">{cjk(value)}</span>;
  const name = cjk(hit.name);
  return (
    <span className="field-ref">
      {env.itemLink && field.to ? env.itemLink(field.to, hit.code, name) : name}
      {hit.status === 'draft' ? <Status kind="draft" /> : null}
    </span>
  );
}

function refValues(field: FieldDef, value: unknown): string[] {
  const c = CODECS.reference.read(value, field);
  return typeof c === 'string' ? [c] : c ? [...c] : [];
}

function ReferenceCell({ field, value }: CellProps) {
  const env = useFieldEnv();
  const items = field.to ? env.refItems(field.to) : undefined;
  const vs = refValues(field, value);
  if (!vs.length) return <>{NONE}</>;
  const parts: ReactNode[] = [];
  vs.forEach((v, i) => {
    if (i > 0) parts.push('、');
    parts.push(<RefName key={`${i}-${v}`} field={field} value={v} items={items} />);
  });
  return <span className="field-refs">{parts}</span>;
}

function ReferenceView({ field, value }: ViewProps) {
  const env = useFieldEnv();
  const items = field.to ? env.refItems(field.to) : undefined;
  const vs = refValues(field, value);
  if (!vs.length) return <span className="field-text">{NONE}</span>;
  if (!field.multiple) return <RefName field={field} value={vs[0]!} items={items} />;
  // 多个时显示成芯片
  return (
    <span className="field-tags">
      {vs.map((v, i) => (
        <span key={`${i}-${v}`} className="field-tag field-tag-ref">
          <RefName field={field} value={v} items={items} />
        </span>
      ))}
    </span>
  );
}

/** 下拉里的一项：名称、13 text-3 的编号、草稿状态 */
function RefOption({ item }: { item: RefItem }) {
  return (
    <span className="ref-option">
      <span className="ref-option-name">{item.name}</span>
      <span className="ref-option-code mono">{item.code}</span>
      {item.status === 'draft' ? <Status kind="draft" /> : null}
    </span>
  );
}

function ReferenceForm(p: FormProps) {
  const { field, value, onChange, id, invalid } = p;
  const env = useFieldEnv();
  const items = field.to ? env.refItems(field.to) : undefined;
  const keyOf = (it: RefItem): string => (field.store === 'label' ? it.name : it.code);
  const options = (items ?? []).map((it) => ({ value: keyOf(it), label: it.name, item: it }));
  const c = CODECS.reference.read(value, field);
  const write = (next: string | readonly string[] | undefined): void => onChange(CODECS.reference.write(next, field));
  const match = (input: string, o?: { label: string; item: RefItem }): boolean =>
    !!o && (o.label.includes(input) || o.item.code.includes(input.toLowerCase()));
  const common = { id, status: invalid ? ('error' as const) : undefined, loading: items === undefined, ...a11y(p) };

  if (field.allowFree && !field.multiple) {
    // 可以写库外的文本：AutoComplete，联想来自目标实体的列表（分组与「库里没有这个」的提示在第 11 步）
    const v = typeof c === 'string' ? c : '';
    return (
      <AutoComplete
        {...common}
        value={v}
        options={options.filter((o) => o.value !== v && match(v, o))}
        optionRender={(o) => <RefOption item={(o.data as { item: RefItem }).item} />}
        onChange={(s: string) => write(s ?? '')}
      />
    );
  }
  return (
    <Select
      {...common}
      mode={field.multiple ? 'multiple' : undefined}
      value={field.multiple ? [...refValues(field, value)] : typeof c === 'string' ? c : undefined}
      options={options}
      showSearch={{ filterOption: (input, o) => match(input, o) }}
      optionRender={(o) => <RefOption item={(o.data as { item: RefItem }).item} />}
      allowClear={field.required === false}
      onChange={(v: string | string[] | undefined) => write(v)}
    />
  );
}

// ---------------- status ----------------

/** 只认 draft、active；别的值（匿名投影里没有状态，是 undefined）写「—」，不猜 */
function StatusShow({ value }: CellProps) {
  return value === 'active' || value === 'draft' ? <Status kind={value} /> : <>{NONE}</>;
}

// ---------------- 表 ----------------

/** 渲染器表（不变量 12）：每种字段类型三种形态 */
export const RENDERERS: Readonly<Record<FieldType, FieldRenderer>> = {
  text: { Cell: TextCell, View: TextView, Form: TextForm },
  longText: { Cell: LongTextCell, View: LongTextView, Form: LongTextForm },
  money: { Cell: MoneyCell, View: MoneyView, Form: MoneyForm },
  intUnit: { Cell: IntUnitCell, View: IntUnitView, Form: IntUnitForm },
  monthRange: { Cell: MonthRangeCell, View: MonthRangeView, Form: MonthRangeForm },
  enum: { Cell: EnumCell, View: EnumView, Form: EnumForm },
  tags: { Cell: TagsCell, View: TagsView, Form: TagsForm },
  boolean: { Cell: BooleanCell, View: BooleanView, Form: BooleanForm },
  subItems: { Cell: SubItemsCell, View: SubItemsView, Form: SubItemsForm },
  reference: { Cell: ReferenceCell, View: ReferenceView, Form: ReferenceForm },
  // 状态不能直接编辑，要通过「上架…」这类操作改：表单形态也是 Status（$status 不进表单网格）
  status: { Cell: StatusShow, View: StatusShow, Form: StatusShow },
};

/** 在 JSX 里用：<FieldCell field value row /> */
export function FieldCell(p: CellProps) {
  const C = RENDERERS[p.field.type].Cell;
  return <C {...p} />;
}
