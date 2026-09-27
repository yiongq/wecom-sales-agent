// 话术目录（spec「销售话术 · 目录」，设计系统 B 页左栏）：保持 prompt 的原顺序；顶部分段控件「全部 / 可编辑 / 已改」带计数；
// 固定规则节带锁、节名用次要色，悬停或聚焦时说明锁定原因；改过的节带主色圆点，字数写「954（+44）」；当前节用选中底色；
// 检查报了问题的节下一行写「1个问题」。底部说明带锁的节是固定规则。
// 每一节是指向 /sop?section=… 的链接（刷新、后退、分享都能还原）；整个目录只占一个 Tab 位（当前节），上下方向键切换节、
// Home / End 到头尾，Enter 进入编辑器。宽 <1280 时整个目录换成编辑器上方的下拉选择（DirectorySelect）。
// 编辑器每敲一个字，页面都按新的字数重渲一次；这里只让字数变了的那一行跟着重渲（TocRow、DirectorySelect 都是 memo，
// 行上不挂回调：点击和按键由列表统一接住，按行的 data-key 认是哪一节）。
// 原因：Tooltip、下拉打开过一次以后，弹层的 Portal 一直挂着，它（@rc-component/portal 2.2.1）每次重渲都在 effect 里
// setState，排一个 Default 优先级的更新；逐字的同步提交接连遇上没做完的 Default 更新，快速连按 50 下 React 就报 #185。
// 样式在 sop.css，由 pages/sop.lazy.tsx 引入；这里不 import CSS，自测才能在 Node 里直接 import
import { Segmented, Select, Tooltip } from 'antd';
import { CircleX, Lock } from 'lucide-react';
import { type KeyboardEvent, memo, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
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

/** 目录的一行。属性全是原始值，别的节在打字时不重渲 */
const TocRow = memo(function TocRow(p: TocRowProps) {
  const cls = ['sop-toc-row', p.locked && 'is-locked', p.changed && 'is-changed'].filter(Boolean).join(' ');
  const a = (
    <a data-key={p.rowKey} className={cls} href={p.href} aria-current={p.current ? 'page' : undefined} tabIndex={p.tabbable ? 0 : -1}>
      <span className="sop-toc-lock">{p.locked && <LockMark />}</span>
      <span className="sop-toc-main">
        <SectionName name={p.name} changed={p.changed} />
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
 * 下拉里的一项：锁、节名（改过带圆点）、问题数。不写字数：字数逐字在变，写了下拉就得逐字重渲（见文件头）；
 * 问题数只在检查或发布之后变
 */
function OptionLabel({ row }: { row: OutlineRow }) {
  return (
    <span className={['sop-toc-option', row.locked && 'is-locked', row.changed && 'is-changed'].filter(Boolean).join(' ')}>
      <span className="sop-toc-lock">{row.locked && <LockMark />}</span>
      <SectionName name={row.name} changed={row.changed} />
      {row.issues > 0 && <IssueCount n={row.issues} />}
    </span>
  );
}

export type DirectorySelectProps = Pick<DirectoryProps, 'rows' | 'current'> & {
  /** 要不变的函数：下拉只在节表、锁、改没改、问题数、当前节变了时重渲 */
  onSelect: (key: string) => void;
};

/** 下拉画出来的部分相同：节的顺序、名字、锁、改没改、问题数 */
const sameOptions = (a: readonly OutlineRow[], b: readonly OutlineRow[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i]!;
    return r.key === o.key && r.name === o.name && r.locked === o.locked && r.changed === o.changed && r.issues === o.issues;
  });

export const DirectorySelect = memo(
  function DirectorySelect({ rows, current, onSelect }: DirectorySelectProps) {
    const [pinyin, setPinyin] = useState<PinyinLib | null>(null);
    const [open, setOpen] = useState(false);
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
    return (
      <Select<string>
        className="sop-toc-select"
        aria-label="选择节"
        // 节不多（旅游包 11 节），不用虚拟列表：全部选项都在 DOM 里，读屏数得出总数
        virtual={false}
        value={current}
        onChange={(k) => onSelect(k)}
        onOpenChange={setOpen}
        showSearch={searchable ? { filterOption: (input, option) => match(names.get(String(option?.value)) ?? '', input) } : false}
        options={rows.map((r) => ({ value: r.key, label: <OptionLabel row={r} /> }))}
        popupRender={(menu) => (
          <>
            {menu}
            <LockNote rows={rows} />
          </>
        )}
      />
    );
  },
  (a, b) => a.current === b.current && a.onSelect === b.onSelect && sameOptions(a.rows, b.rows),
);
