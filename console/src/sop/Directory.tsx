// 话术目录（spec「销售话术 · 目录」，设计系统 B 页左栏）：保持 prompt 的原顺序；顶部分段控件「全部 / 可编辑 / 已改」带计数；
// 固定规则节带锁、节名用次要色，悬停或聚焦时说明锁定原因；改过的节带主色圆点，字数写「954（+44）」；当前节用选中底色；
// 检查报了问题的节下一行写「1个问题」。底部说明带锁的节是固定规则。
// 每一节是指向 /sop?section=… 的链接（刷新、后退、分享都能还原）；整个目录只占一个 Tab 位（当前节），上下方向键切换节、
// Home / End 到头尾，Enter 进入编辑器。宽 <1280 时整个目录换成编辑器上方的下拉选择（DirectorySelect）。
// 样式在 sop.css，由 pages/sop.lazy.tsx 引入；这里不 import CSS，自测才能在 Node 里直接 import
import { Segmented, Select, Tooltip } from 'antd';
import { CircleX, Lock } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
function SectionName({ row }: { row: OutlineRow }) {
  return (
    <span className="sop-toc-name">
      {cjk(row.name)}
      {row.changed && <span className="sop-toc-dot" role="img" aria-label="已改" />}
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

export function Directory({ rows, current, filter, onFilter, showCounts, hrefOf, onSelect, onEnter }: DirectoryProps) {
  const list = useRef<HTMLUListElement>(null);
  const f = filter ?? 'all';
  const visible = rows.filter((r) => matchesFilter(r, f));
  const keys = visible.map((r) => r.key);
  // 整个目录只占一个 Tab 位：当前节；当前节被筛掉了就是看得见的第一节
  const tabKey = current !== undefined && keys.includes(current) ? current : keys[0];
  const counts = filterCounts(rows);

  const focusRow = (key: string): void => {
    const el = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []).find((x) => x.dataset.key === key);
    el?.focus();
  };

  const onKeyDown = (row: OutlineRow) => (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (!plainKey(e)) return;
    if (STEP_KEYS.has(e.key)) {
      e.preventDefault();
      const next = stepSection(keys, row.key, e.key as StepKey);
      if (next === null) return;
      focusRow(next);
      onSelect(next, 'key');
    } else if (e.key === 'Enter') {
      // 不跟着链接走：这一节要是还不是当前节先选中，再进编辑器
      e.preventDefault();
      if (row.key !== current) onSelect(row.key, 'key');
      onEnter(row.key);
    }
  };

  const link = (row: OutlineRow): ReactNode => {
    const cur = row.key === current;
    const cls = ['sop-toc-row', row.locked && 'is-locked', row.changed && 'is-changed'].filter(Boolean).join(' ');
    const a = (
      <a
        data-key={row.key}
        className={cls}
        href={hrefOf(row.key)}
        aria-current={cur ? 'page' : undefined}
        tabIndex={row.key === tabKey ? 0 : -1}
        onClick={(e) => {
          // 带修饰键或中键照浏览器的来（新标签打开这一节）
          if (!plainClick(e)) return;
          e.preventDefault();
          if (!cur) onSelect(row.key, 'click');
        }}
        onKeyDown={onKeyDown(row)}
      >
        <span className="sop-toc-lock">{row.locked && <LockMark />}</span>
        <span className="sop-toc-main">
          <SectionName row={row} />
          {row.issues > 0 && (
            <span className="sop-toc-issue">
              <Icon of={CircleX} size={14} />
              {`${row.issues}个问题`}
            </span>
          )}
        </span>
        {showCounts && <span className="sop-toc-count">{countText(row)}</span>}
      </a>
    );
    if (!row.locked) return a;
    return (
      <Tooltip title={cjk(lockTip(row))} placement="right" trigger={['hover', 'focus']}>
        {a}
      </Tooltip>
    );
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
        <ul ref={list} className="sop-toc-list">
          {visible.map((row) => (
            <li key={row.key}>{link(row)}</li>
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

/** 下拉里的一项：锁、节名（改过带圆点）、字数 */
function OptionLabel({ row, showCounts }: { row: OutlineRow; showCounts?: boolean }) {
  return (
    <span className={['sop-toc-option', row.locked && 'is-locked', row.changed && 'is-changed'].filter(Boolean).join(' ')}>
      <span className="sop-toc-lock">{row.locked && <LockMark />}</span>
      <SectionName row={row} />
      {showCounts && <span className="sop-toc-count">{countText(row)}</span>}
    </span>
  );
}

export type DirectorySelectProps = Pick<DirectoryProps, 'rows' | 'current' | 'showCounts'> & {
  onSelect: (key: string) => void;
};

/**
 * 宽 <1280 时的目录：编辑器上方一个下拉，选项照目录的顺序与标记；节多于 7 个时可以搜（设计系统 §5.3），
 * 拼音库在第一次展开时才加载（与 ⌘K 共用同一个懒加载的块）。下拉底部是锁的说明
 */
export function DirectorySelect({ rows, current, showCounts, onSelect }: DirectorySelectProps) {
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
      onChange={onSelect}
      onOpenChange={setOpen}
      showSearch={searchable ? { filterOption: (input, option) => match(names.get(String(option?.value)) ?? '', input) } : false}
      options={rows.map((r) => ({ value: r.key, label: <OptionLabel row={r} showCounts={showCounts} /> }))}
      popupRender={(menu) => (
        <>
          {menu}
          <LockNote rows={rows} />
        </>
      )}
    />
  );
}
