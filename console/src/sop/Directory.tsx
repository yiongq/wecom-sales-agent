// 话术目录（spec「销售话术 · 目录」，设计系统 B 页左栏）：保持 prompt 的原顺序；顶部分段控件「全部 / 可编辑 / 已改」带计数；
// 固定规则节带锁、节名用次要色，悬停或聚焦时说明锁定原因；改过的节带主色圆点，字数写「954（+44）」；当前节用选中底色；
// 检查报了问题的节下一行写「1个问题」；合并模式里要合并的节下一行写「需合并」，处理好了写「已处理」。底部说明带锁的节是固定规则。
// 每一节是指向 /sop?section=… 的链接（刷新、后退、分享都能还原）；整个目录只占一个 Tab 位（当前节），上下方向键切换节、
// Home / End 到头尾，Enter 进入编辑器。宽 <1280 时整个目录换成编辑器上方的下拉选择（DirectorySelect）。
// 编辑器每敲一个字，页面都按新的字数重渲一次；这里只让字数变了的那一行跟着重渲（TocRow、DirectorySelect 都是 memo，
// 行上不挂回调：点击和按键由列表统一接住，按行的 data-key 认是哪一节）。
// 原因：Tooltip、下拉打开过一次以后，弹层的 Portal 一直挂着，它（@rc-component/portal 2.2.1）每次重渲都在 effect 里
// setState，排一个 Default 优先级的更新；逐字的同步提交接连遇上没做完的 Default 更新，快速连按 50 下 React 就报 #185。
// 样式在 sop.css，由 pages/sop.lazy.tsx 引入；这里不 import CSS，自测才能在 Node 里直接 import
import { type RefSelectProps, Segmented, Select, Tooltip } from 'antd';
import { CircleAlert, CircleCheck, CircleX, Lock } from 'lucide-react';
import { type KeyboardEvent, memo, type MouseEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../shell/icons.js';
import { type Matcher, type PinyinLib, pinyinMatcher, plainMatch } from '../shell/search.js';
import { cjk } from '../typography.js';
import {
  countText,
  FILTER_EMPTY,
  filterCounts,
  lockNote,
  lockTip,
  matchesFilter,
  OUTLINE_FILTERS,
  type OutlineFilter,
  type OutlineRow,
  STEP_KEYS,
  type StepKey,
  stepSection,
} from './outline.js';

/** 怎么选中的：点了（或下拉里选了）、方向键。方向键换节不往浏览历史里加记录 */
export type SelectVia = 'click' | 'key';

export interface DirectoryProps {
  rows: readonly OutlineRow[];
  /** 当前节 */
  current: string | undefined;
  /** 分段筛选；不给就不画分段控件（匿名没有草稿，也没有能编辑的节） */
  filter?: OutlineFilter;
  onFilter?: (f: OutlineFilter) => void;
  /** 右侧字数（匿名不写） */
  showCounts?: boolean;
  /** 这一节的地址 */
  hrefOf: (key: string) => string;
  onSelect: (key: string, via: SelectVia) => void;
  /** 在某一节上按 Enter：进入这一节的编辑器 */
  onEnter: (key: string) => void;
}

const LOCK_ICON_LABEL = '固定规则节';

function LockMark() {
  return <Lock size={14} strokeWidth={1.5} absoluteStrokeWidth role="img" aria-label={LOCK_ICON_LABEL} focusable="false" />;
}

/** 节名：带锁的节次要色；改过的节后面一个主色圆点（读屏念「已改」） */
function SectionName({ name, changed }: { name: string; changed: boolean }) {
  return (
    <span className="sop-toc-name">
      {cjk(name)}
      {changed && <span className="sop-toc-dot" role="img" aria-label="已改" />}
    </span>
  );
}

function LockNote({ rows }: { rows: readonly OutlineRow[] }) {
  const note = lockNote(rows);
  if (!note) return null;
  return (
    <p className="sop-toc-note">
      <Icon of={Lock} size={14} />
      <span>{cjk(note)}</span>
    </p>
  );
}

const plainClick = (e: MouseEvent): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const plainKey = (e: KeyboardEvent): boolean => !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

interface TocRowProps {
  rowKey: string;
  name: string;
  locked: boolean;
  lockReason: string | null;
  changed: boolean;
  issues: number;
  merge: OutlineRow['merge'];
  /** 右侧字数；不写字数时是 null */
  count: string | null;
  current: boolean;
  /** 整个目录只有这一行在 Tab 顺序里 */
  tabbable: boolean;
  href: string;
}

/** 检查报的问题数：「1个问题」，danger，前置 circle-x */
function IssueCount({ n }: { n: number }) {
  return (
    <span className="sop-toc-issue">
      <Icon of={CircleX} size={14} />
      {`${n}个问题`}
    </span>
  );
}

/** 合并模式里的标记：要合并的节「需合并」（danger，前置 circle-alert），点过「这一节处理好了」的「已处理」（text-2，前置 success 的勾） */
function MergeMark({ mark }: { mark: NonNullable<OutlineRow['merge']> }) {
  return mark === 'todo' ? (
    <span className="sop-toc-merge">
      <Icon of={CircleAlert} size={14} />
      需合并
    </span>
  ) : (
    <span className="sop-toc-merge is-done">
      <Icon of={CircleCheck} size={14} />
      已处理
    </span>
  );
}

/** 目录的一行。属性全是原始值，别的节在打字时不重渲 */
const TocRow = memo(function TocRow(p: TocRowProps) {
  const cls = ['sop-toc-row', p.locked && 'is-locked', p.changed && 'is-changed'].filter(Boolean).join(' ');
  const a = (
    <a data-key={p.rowKey} className={cls} href={p.href} aria-current={p.current ? 'page' : undefined} tabIndex={p.tabbable ? 0 : -1}>
      <span className="sop-toc-lock">{p.locked && <LockMark />}</span>
      <span className="sop-toc-main">
        <SectionName name={p.name} changed={p.changed} />
        {p.merge && <MergeMark mark={p.merge} />}
        {p.issues > 0 && <IssueCount n={p.issues} />}
      </span>
      {p.count !== null && <span className="sop-toc-count">{p.count}</span>}
    </a>
  );
  if (!p.locked) return a;
  return (
    <Tooltip title={cjk(lockTip({ lockReason: p.lockReason }))} placement="right" trigger={['hover', 'focus']}>
      {a}
    </Tooltip>
  );
});

export function Directory({ rows, current, filter, onFilter, showCounts, hrefOf, onSelect, onEnter }: DirectoryProps) {
  const list = useRef<HTMLUListElement>(null);
  const f = filter ?? 'all';
  const visible = rows.filter((r) => matchesFilter(r, f));
  const keys = visible.map((r) => r.key);
  // 整个目录只占一个 Tab 位：当前节；当前节被筛掉了就是看得见的第一节
  const tabKey = current !== undefined && keys.includes(current) ? current : keys[0];
  const counts = filterCounts(rows);

  /** 事件落在哪一行（点在行里的图标、文字上也算） */
  const rowOf = (target: EventTarget): string | undefined =>
    (target instanceof Element ? target.closest<HTMLElement>('a[data-key]') : null)?.dataset.key;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const key = rowOf(e.target);
    if (key === undefined || !plainKey(e)) return;
    if (STEP_KEYS.has(e.key)) {
      e.preventDefault();
      const next = stepSection(keys, key, e.key as StepKey);
      if (next === null) return;
      Array.from(list.current?.querySelectorAll<HTMLElement>('a[data-key]') ?? [])
        .find((x) => x.dataset.key === next)
        ?.focus();
      onSelect(next, 'key');
    } else if (e.key === 'Enter') {
      // 不跟着链接走：这一节要是还不是当前节先选中，再进编辑器
      e.preventDefault();
      if (key !== current) onSelect(key, 'key');
      onEnter(key);
    }
  };

  const onClick = (e: MouseEvent<HTMLUListElement>): void => {
    const key = rowOf(e.target);
    // 带修饰键或中键照浏览器的来（新标签打开这一节）
    if (key === undefined || !plainClick(e)) return;
    e.preventDefault();
    if (key !== current) onSelect(key, 'click');
  };

  return (
    <nav className="sop-toc" aria-label="话术目录">
      {filter !== undefined && onFilter && (
        <Segmented<OutlineFilter>
          block
          tabIndex={-1}
          className="sop-toc-filter"
          aria-label="显示哪些节"
          value={filter}
          onChange={onFilter}
          options={OUTLINE_FILTERS.map(([value, label]) => ({
            value,
            label: (
              <span className="sop-toc-filter-label">
                {label}
                <span className="sop-toc-filter-n">{counts[value]}</span>
              </span>
            ),
          }))}
        />
      )}
      {visible.length ? (
        // 列表只接住行里冒上来的点击和按键；可聚焦、可点的是每一行的链接
        <ul ref={list} className="sop-toc-list" onClick={onClick} onKeyDown={onKeyDown}>
          {visible.map((row) => (
            <li key={row.key}>
              <TocRow
                rowKey={row.key}
                name={row.name}
                locked={row.locked}
                lockReason={row.lockReason}
                changed={row.changed}
                issues={row.issues}
                merge={row.merge}
                count={showCounts ? countText(row) : null}
                current={row.key === current}
                tabbable={row.key === tabKey}
                href={hrefOf(row.key)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="sop-toc-empty">{cjk(FILTER_EMPTY[f])}</p>
      )}
      <LockNote rows={rows} />
    </nav>
  );
}

// ---------------- 窄屏（<1280）：下拉选择 ----------------

let pinyinLoad: Promise<PinyinLib> | null = null;
const loadPinyin = (): Promise<PinyinLib> => (pinyinLoad ??= import('pinyin-match').then((m) => m.default as PinyinLib));

/**
 * 下拉里的一项：锁、节名（改过带圆点）、合并的标记、问题数。不写字数：字数逐字在变，写了下拉就得逐字重渲（见文件头）；
 * 问题数只在检查或发布之后变
 */
function OptionLabel({ row }: { row: OutlineRow }) {
  return (
    <span className={['sop-toc-option', row.locked && 'is-locked', row.changed && 'is-changed'].filter(Boolean).join(' ')}>
      <span className="sop-toc-lock">{row.locked && <LockMark />}</span>
      <SectionName name={row.name} changed={row.changed} />
      {row.merge && <MergeMark mark={row.merge} />}
      {row.issues > 0 && <IssueCount n={row.issues} />}
    </span>
  );
}

/** 下拉里每项高 32（§8 的 optionHeight） */
const OPTION_H = 32;

/**
 * 下拉列表的高（room 是选择框上方、下方到视口边的距离）：放得下就按节数给足、不在下拉里滚（节不多时全部看得见，键盘也不用滚）；
 * 放不下（节多的行业包、矮窗口）按上下较大的那一边封顶，超出的在列表里滚（方向键走 activedescendant，rc-select 把当前项滚进视野），
 * 至少露出 4 项。扣掉的是列表以外的：弹层离选择框 4、上下内边距各 4、离视口边留 12；有锁的说明时再扣它（分隔线、内边距、至多两行）
 */
export function tocListHeight(count: number, room: { above: number; below: number }, note: boolean): number {
  const space = Math.max(room.above, room.below) - 24 - (note ? 56 : 0);
  return Math.min(count * OPTION_H, Math.max(4 * OPTION_H, Math.floor(space)));
}

/**
 * 下拉开着、焦点在输入框里按 Home / End：光标已经在那一头（空着、或者字打完了）时 Chromium 不把这一下当移光标，
 * 交给外面滚动，整个内容面板滚到底或顶，下拉跟着选择框滚出视口。只在这种时候拦下；光标还能动时照常移光标
 */
export function swallowEdgeKey(
  e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  input: unknown,
): boolean {
  if ((e.key !== 'Home' && e.key !== 'End') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (!(input instanceof HTMLInputElement)) return false;
  const at = e.key === 'Home' ? 0 : input.value.length;
  return input.selectionStart === at && input.selectionEnd === at;
}

/** 选择框上方、下方到视口边的距离；还没挂上时当作放得下 */
function roomAround(el: HTMLElement | null | undefined): { above: number; below: number } {
  if (!el) return { above: Infinity, below: Infinity };
  const r = el.getBoundingClientRect();
  return { above: r.top, below: window.innerHeight - r.bottom };
}

export type DirectorySelectProps = Pick<DirectoryProps, 'rows' | 'current'> & {
  /** 要不变的函数：下拉只在节表、锁、改没改、问题数、当前节变了时重渲 */
  onSelect: (key: string) => void;
};

/** 下拉画出来的部分相同：节的顺序、名字、锁、改没改、问题数、合并的标记 */
const sameOptions = (a: readonly OutlineRow[], b: readonly OutlineRow[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i]!;
    return (
      r.key === o.key &&
      r.name === o.name &&
      r.locked === o.locked &&
      r.changed === o.changed &&
      r.issues === o.issues &&
      r.merge === o.merge
    );
  });

export const DirectorySelect = memo(
  function DirectorySelect({ rows, current, onSelect }: DirectorySelectProps) {
    const [pinyin, setPinyin] = useState<PinyinLib | null>(null);
    const [open, setOpen] = useState(false);
    // 打开的那一刻量选择框上下的空间（页面滚过、窗口矮时都不同），列表的高按它封顶
    const selectRef = useRef<RefSelectProps>(null);
    const [room, setRoom] = useState(() => roomAround(null));
    const searchable = rows.length > 7;
    useEffect(() => {
      if (!open || !searchable || pinyin) return;
      let live = true;
      loadPinyin()
        .then((lib) => live && setPinyin(() => lib))
        .catch(() => undefined); // 没加载成就只按原文匹配
      return () => {
        live = false;
      };
    }, [open, searchable, pinyin]);
    const match: Matcher = useMemo(() => (pinyin ? pinyinMatcher(pinyin) : plainMatch), [pinyin]);
    const names = useMemo(() => new Map(rows.map((r) => [r.key, r.name])), [rows]);
    // 下拉里的 listbox 要有名字（axe aria-input-field-name）：rc-select 1.10.1 不给它名字，也没有传名字的属性，
    // 打开以后按它的 id（`${id}_list`）补上。弹层可能晚几帧才画出来，没找到就下一帧再找（至多 30 帧）
    const selectId = useId();
    useEffect(() => {
      if (!open) return;
      let frame = 0;
      let raf = 0;
      const label = (): void => {
        const list = document.getElementById(`${selectId}_list`);
        if (list) list.setAttribute('aria-label', '话术的节');
        else if (frame++ < 30) raf = requestAnimationFrame(label);
      };
      label();
      return () => cancelAnimationFrame(raf);
    }, [open, selectId]);
    return (
      <Select<string>
        ref={selectRef}
        id={selectId}
        className="sop-toc-select"
        aria-label="选择节"
        // 节不多（旅游包 11 节），不用虚拟列表：全部选项都在 DOM 里，读屏数得出总数。
        // 列表的高度按节数给足，视口放不下时封顶（tocListHeight）。只有封顶、列表在滚的时候 axe 报 scrollable-region-focusable
        // （会滚的那一层里没有能聚焦的东西）：焦点一直在输入框上，方向键走 activedescendant，当前项由 rc-select 滚进视野
        virtual={false}
        listHeight={tocListHeight(rows.length, room, lockNote(rows) !== null)}
        value={current}
        onChange={(k) => onSelect(k)}
        onOpenChange={(o) => {
          if (o) setRoom(roomAround(selectRef.current?.nativeElement));
          setOpen(o);
        }}
        onKeyDown={(e) => {
          if (open && swallowEdgeKey(e, e.target)) e.preventDefault();
        }}
        showSearch={searchable ? { filterOption: (input, option) => match(names.get(String(option?.value)) ?? '', input) } : false}
        options={rows.map((r) => ({ value: r.key, label: <OptionLabel row={r} /> }))}
        // 弹层挂在 body 下、在地标外面：包成有名字的区域（parts/popupRegion.tsx）
        popupRender={(menu) => (
          <section aria-label="选择节">
            {menu}
            <LockNote rows={rows} />
          </section>
        )}
      />
    );
  },
  (a, b) => a.current === b.current && a.onSelect === b.onSelect && sameOptions(a.rows, b.rows),
);
