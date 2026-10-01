// 产品库列表（spec「产品库列表（D 页；L 页上半）」，设计系统 §4.4 页签、§5.5 表格与工具条、D 页、L 页上半）。
// 页签、工具条、表格与各种状态；列、筛选、搜索都按行业包的配置和字段类型生成（list.ts），单元格用字段渲染器的列表形态。
// 状态都在 URL 里（params.ts）：页签、搜索、筛选改了就经 onSearch 写回地址，刷新、后退、分享链接都还原（不变量 22）。
// 这里只画，不取数、不认路由：页面（pages/CatalogPage.tsx）给条目、身份和首列名称的链接
import { Dropdown, Input, type InputRef, type MenuProps, Table, type TableColumnsType, Tabs } from 'antd';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { type HTMLAttributes, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { absoluteTime, digits, quantity } from '../../../src/shared/format.js';
import type { EntityType, FieldDef } from '../../../src/shared/pack.js';
import { type FieldEnv, FieldEnvContext } from '../fields/env.js';
import type { RefItem } from '../fields/model.js';
import { FieldCell } from '../fields/renderers.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { useViewport } from '../shell/hooks.js';
import { Icon, entityIcon } from '../shell/icons.js';
import { type Matcher, type PinyinLib, pinyinMatcher, plainMatch } from '../shell/search.js';
import { cjk, Sep } from '../typography.js';
import {
  activePicks,
  type ActivePick,
  cellValue,
  columnWidth,
  filterFields,
  filterName,
  type FilterOption,
  filterOptions,
  fullText,
  headerLabel,
  type ListColumn,
  listColumns,
  type ListRow,
  narrowed,
  numeric,
  PAGE_SIZE,
  pickLabel,
  searchPlaceholder,
  tabCounts,
  tableMinWidth,
  TITLE_MIN_NARROW,
  TITLE_MIN_WIDTH,
  twoLine,
  updatedParts,
  visibleRows,
} from './list.js';
import { type CatalogSearch, cleared, withPick } from './params.js';

export interface CatalogListProps {
  entity: EntityType;
  /** 接口给的条目；还没取到（放骨架）或出错时 undefined */
  rows: readonly ListRow[] | undefined;
  error: unknown;
  onRetry(): void;
  /** demo 匿名：只有已上架的条目，没有状态、更新两列，只有「全部」页签 */
  anon: boolean;
  search: CatalogSearch;
  /** 改地址：页签和筛选记一步历史，搜索框边敲边改（replace） */
  onSearch(next: CatalogSearch, replace?: boolean): void;
  /** 当前时刻：更新列的「今天」、月份条的当前月（走查钉住时钟） */
  now: number;
  /** 首列的名称画成什么：页面给详情路由的链接 */
  titleLink(row: ListRow, children: ReactNode): ReactNode;
  /** 引用列里被引用条目的名称链到它的详情（渲染器的 FieldEnv.itemLink）；不给时是纯文本 */
  itemLink?: FieldEnv['itemLink'];
  /** 引用字段的候选（引用列与引用筛选写被引用条目的名称）；没有引用列时不用给 */
  refItems?(kind: string): readonly RefItem[] | undefined;
  /** 从来没有过条目时空状态里的操作（新建、导入CSV；非编辑角色和匿名不给） */
  emptyActions?: ReactNode;
}

type Tab = 'all' | 'active' | 'draft';
const TAB_LABEL: Readonly<Record<Tab, string>> = { all: '全部', active: '已上架', draft: '草稿' };
const tabOf = (search: CatalogSearch, anon: boolean): Tab => (anon ? 'all' : (search.status ?? 'all'));
/** 页签、搜索、筛选合起来的签名：变了就回到第 1 页 */
const sigOf = (search: CatalogSearch, anon: boolean): string => JSON.stringify([tabOf(search, anon), search.q ?? '', search.f ?? []]);

let pinyinLoad: Promise<PinyinLib> | null = null;
/** 筛选菜单的搜索支持拼音首字母（设计系统 §5.3）：与 ⌘K 同一个懒加载的拼音块，只在选项多于 7 个的菜单第一次打开时下载 */
const loadPinyin = (): Promise<PinyinLib> => (pinyinLoad ??= import('pinyin-match').then((m) => m.default as PinyinLib));

/** 选项多于这个数时，筛选菜单顶部放一个搜索框（设计系统 §5.3） */
export const MENU_SEARCH_OVER = 7;

// ---------------- 首列与单元格 ----------------

/** 次行里的一段：编号用等宽字，数组用「、」连起来，数字带千分位 */
function subtitleText(f: FieldDef | undefined, v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join('、');
  if (typeof v === 'number') return f?.type === 'intUnit' ? quantity(v, f.unit ?? '') : digits(v);
  if (typeof v === 'boolean') return v ? (f?.trueLabel ?? '是') : (f?.falseLabel ?? '否');
  return '';
}

function TitleCell({ entity, row, link }: { entity: EntityType; row: ListRow; link: CatalogListProps['titleLink'] }) {
  const t = cellValue(row, entity.titleKey);
  const title = typeof t === 'string' && t !== '' ? t : row.code;
  const parts: ReactNode[] = [];
  for (const key of entity.subtitleKeys) {
    const text = subtitleText(
      entity.fields.find((f) => f.key === key),
      cellValue(row, key),
    );
    if (!text) continue;
    if (parts.length) parts.push(<Sep key={`sep-${key}`} />);
    parts.push(
      key === '$code' ? (
        <span key={key} className="mono">
          {text}
        </span>
      ) : (
        <span key={key}>{cjk(text)}</span>
      ),
    );
  }
  return (
    <div className="cell-title">
      <span className="cell-name">{link(row, cjk(title))}</span>
      {parts.length > 0 && <span className="cell-sub">{parts}</span>}
    </div>
  );
}

function tableColumns(
  entity: EntityType,
  cols: readonly ListColumn[],
  rows: readonly ListRow[],
  p: CatalogListProps,
): TableColumnsType<ListRow> {
  return cols.map((c) => {
    if (c.kind === 'title') {
      return {
        key: '$title',
        title: entity.label,
        fixed: 'left' as const,
        className: 'col-title',
        render: (_: unknown, row: ListRow) => <TitleCell entity={entity} row={row} link={p.titleLink} />,
      };
    }
    if (c.kind === 'updated') {
      return {
        key: '$updated',
        width: columnWidth(c, rows),
        // 默认按更新时间倒序：表头是 text-2，后跟 chevron-down（设计系统 §5.5）
        title: (
          <span className="th-sorted">
            更新
            <Icon of={ChevronDown} size={12} />
          </span>
        ),
        onHeaderCell: () => ({ 'aria-sort': 'descending' }) as HTMLAttributes<HTMLElement>,
        render: (_: unknown, row: ListRow) => {
          const parts = updatedParts(row, p.now);
          return parts ? (
            <span className="cell-updated" title={absoluteTime(row.updatedAt!, p.now)}>
              {cjk(parts)}
            </span>
          ) : (
            '—'
          );
        },
      };
    }
    const f = c.field;
    return {
      key: f.key,
      width: columnWidth(c, rows),
      align: numeric(f) ? ('right' as const) : undefined,
      title: cjk(headerLabel(f)),
      // 多选与标签放不下时截断，悬停看全文
      onCell: (row: ListRow) => ({ title: fullText(f, cellValue(row, f.key)) }),
      render: (_: unknown, row: ListRow) => <FieldCell field={f} value={cellValue(row, f.key)} row={row.payload} />,
    };
  });
}

// ---------------- 工具条 ----------------

/**
 * 搜索框：边敲边筛（spec「输入即筛」），地址用 replace 跟着改。框里的字存在自己这里：地址比输入晚一拍，
 * 敲出去还没回来的值记在 echoes 里，地址回来的是其中之一就是自己的回声，不回写（回写会吞掉这之后敲的字）；
 * 不是（后退、「看全部」）就跟着地址走。不按焦点判断：Safari 点按钮不挪焦点，焦点留在框里时「看全部」也要清掉框里的字
 */
function SearchBox({
  value,
  placeholder,
  label,
  focusNow,
  onFocused,
  onChange,
}: {
  value: string;
  placeholder: string;
  label: string;
  /** 该接过焦点了：「清除筛选」「看全部」点了以后自己就不在了，地址改完由搜索框接过焦点 */
  focusNow: boolean;
  onFocused(): void;
  onChange(v: string): void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<InputRef>(null);
  // 同一个页签里是地址改完的这次；换了页签时工具条挪到新页签里重新挂上，是挂上的这次
  // （antd 的页签在下一次提交才画出新页签的内容，列表自己的 effect 那时还拿不到新的搜索框）
  useEffect(() => {
    if (!focusNow) return;
    ref.current?.focus();
    onFocused();
  }, [focusNow, onFocused]);
  const echoes = useRef<string[]>([]);
  useEffect(() => {
    const i = echoes.current.indexOf(value);
    if (i >= 0) {
      echoes.current.splice(0, i + 1);
      return;
    }
    echoes.current = [];
    setText(value);
  }, [value]);
  return (
    <Input
      ref={ref}
      className="list-search"
      prefix={<Icon of={Search} className="list-search-icon" />}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        // 只有空白的不进地址（回来的是空串）
        echoes.current.push(v.trim() === '' ? '' : v);
        onChange(v);
      }}
    />
  );
}

/** 菜单项上的读屏属性：rc-menu 把条目上多余的键原样放到 li 上（与用户菜单同一种写法） */
const radio = (checked: boolean): object => ({ role: 'menuitemradio', 'aria-checked': checked });

/**
 * 一个筛选按钮（设计系统 §5.5 工具条、§5.3 下拉菜单）。没生效时是「目的地」加 chevron-down；
 * 生效后改成 accent 底的「目的地：四川」，后面的 x 单独是一个按钮，点了清除这一项。选中的项再点一次也是清除。
 * 选了一项、点了 x、按了 Esc 之后焦点回到按钮上（spec「可访问性 · 键盘」）：菜单项和 x 随之消失，不接住的话焦点掉到 body，
 * 键盘用户得从跳转链接重新 Tab 过来
 */
export function FilterButton(props: {
  field: FieldDef;
  options: readonly FilterOption[];
  pick: ActivePick | undefined;
  refItems?: readonly RefItem[];
  onPick(value: string | undefined): void;
}) {
  const { field, options, pick, onPick } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pinyin, setPinyin] = useState<PinyinLib | null>(null);
  const popup = useRef<HTMLElement>(null);
  // 按钮经外层的 span 找：Dropdown 的子元素上不另挂 ref，免得和 antd 自己挂的 ref 抢
  const box = useRef<HTMLSpanElement>(null);
  const focusTrigger = (): void => box.current?.querySelector<HTMLButtonElement>('.filter-trigger')?.focus();
  const close = (): void => {
    setOpen(false);
    setQuery('');
    // 等这一下按键结束再挪焦点：Enter 选中时按下就挪的话，随后的按键落到按钮上，又把菜单打开
    requestAnimationFrame(focusTrigger);
  };
  const searchable = options.length > MENU_SEARCH_OVER;
  useEffect(() => {
    if (!open || !searchable || pinyin) return;
    let live = true;
    loadPinyin().then(
      (lib) => live && setPinyin(() => lib),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, searchable, pinyin]);

  const match: Matcher = pinyin ? pinyinMatcher(pinyin) : plainMatch;
  const shown = searchable && query.trim() ? options.filter((o) => match(o.label, query)) : options;
  const items: MenuProps['items'] = shown.map((o) => ({
    key: o.value,
    ...radio(o.value === pick?.value),
    label: (
      <span className="menu-row">
        <span>{cjk(o.label)}</span>
        {o.value === pick?.value && <Icon of={Check} className="menu-check" />}
      </span>
    ),
  }));
  const name = filterName(field);
  const text = pick ? `${name}：${pickLabel(pick, options, props.refItems)}` : name;

  return (
    <span ref={box} className={pick ? 'filter-btn is-active' : 'filter-btn'}>
      <Dropdown
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
        trigger={['click']}
        placement="bottomLeft"
        autoFocus={!searchable}
        menu={{
          items,
          selectable: false,
          onClick: ({ key }) => {
            onPick(key === pick?.value ? undefined : key);
            close();
          },
        }}
        popupRender={(menu) => (
          // 打开后 antd（autoFocus）聚焦的是这层外壳：它本来不可聚焦，焦点留在按钮上，键盘选不了。
          // 让它可聚焦，再把焦点转给选中的那一项（没有就第一项），方向键和 Enter 才用得上（spec「可访问性 · 键盘」）。
          // 它挂在 body 下、在页面的地标外面，是一块有名字的区域（parts/popupRegion.tsx）
          <section
            ref={popup}
            className="filter-menu"
            aria-label={`筛选：${name}`}
            tabIndex={-1}
            onFocus={(e) => {
              if (e.target !== e.currentTarget) return;
              const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
              (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
            }}
            // Esc 关菜单、焦点回到按钮（焦点在菜单项上时 antd 自己的处理接不回来）
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          >
            {searchable && (
              <Input
                autoFocus
                className="filter-menu-search"
                prefix={<Icon of={Search} className="list-search-icon" />}
                value={query}
                aria-label={`搜索${name}`}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // ↓ 进到菜单里，之后照 antd 菜单的方向键走
                  if (e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  popup.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
                }}
              />
            )}
            {shown.length ? menu : <div className="filter-menu-empty">{cjk(`没有找到「${query.trim()}」`)}</div>}
          </section>
        )}
      >
        <button type="button" className="filter-trigger" aria-haspopup="menu" aria-expanded={open} disabled={!options.length}>
          {cjk(text)}
          {!pick && <Icon of={ChevronDown} size={14} className="filter-chevron" />}
        </button>
      </Dropdown>
      {pick && (
        <button
          type="button"
          className="filter-clear"
          aria-label={`清除「${name}」筛选`}
          onClick={() => {
            focusTrigger();
            onPick(undefined);
          }}
        >
          <Icon of={X} size={14} />
        </button>
      )}
    </span>
  );
}

// ---------------- 整个列表 ----------------

export function CatalogList(p: CatalogListProps) {
  const { entity, rows, anon, search } = p;
  const cols = listColumns(entity, anon);
  const two = twoLine(entity);
  const picks = activePicks(entity, search);
  const base = rows ? narrowed(entity, rows, search) : undefined;
  const counts = base ? tabCounts(base) : undefined;
  const shown = rows ? visibleRows(entity, rows, search, anon) : undefined;
  const tab = tabOf(search, anon);
  // 换了页签、搜索或筛选就回到第 1 页（页码不进地址：spec 的路由表里列表只有这三个参数）
  const sig = sigOf(search, anon);
  const [page, setPage] = useState({ sig, n: 1 });
  const current = page.sig === sig ? page.n : 1;
  // 首列的最小宽度：侧栏展开、收成图标栏时让首列先收窄，窄屏（首列固定、其余列横滚）时留宽一点
  const titleMin = useViewport() === 'narrow' ? TITLE_MIN_NARROW : TITLE_MIN_WIDTH;

  // 「清除筛选」「看全部」点了以后自己就不在了：记下清除之后的签名，地址改到这里时由搜索框接过焦点，
  // 不然焦点掉到 body（spec「可访问性 · 键盘」）
  const [refocusAt, setRefocusAt] = useState<string | null>(null);
  const focused = useCallback(() => setRefocusAt(null), []);
  const clearTo = (next: CatalogSearch): void => {
    const to = sigOf(next, anon);
    if (to !== sig) setRefocusAt(to);
    p.onSearch(next);
  };

  const env: FieldEnv = { now: p.now, refItems: (k) => p.refItems?.(k), distinct: () => [], itemLink: p.itemLink };
  const refsOf = (f: FieldDef): readonly RefItem[] | undefined => (f.type === 'reference' && f.to ? p.refItems?.(f.to) : undefined);

  // 从来没有过：替换整块内容，不留空表头（spec「产品库列表」的状态表）
  if (rows && rows.length === 0) {
    return (
      <EmptyBlock
        icon={<Icon of={entityIcon(entity.icon)} size={20} />}
        title={`从第一条${entity.label}开始`}
        description="上架后，销售助手会向客户推荐它"
        action={p.emptyActions}
      />
    );
  }

  const toolbar = (
    <div className="list-toolbar" role="search" aria-label={`筛选${entity.label}`}>
      <SearchBox
        value={search.q ?? ''}
        placeholder={searchPlaceholder(entity)}
        label={`搜索${entity.label}`}
        focusNow={refocusAt === sig}
        onFocused={focused}
        onChange={(q) => p.onSearch({ ...search, q: q.trim() === '' ? undefined : q }, true)}
      />
      {filterFields(entity).map((f) => {
        const options = filterOptions(f, rows ?? [], refsOf(f));
        return (
          <FilterButton
            key={f.key}
            field={f}
            options={options}
            pick={picks.find((x) => x.field.key === f.key)}
            refItems={refsOf(f)}
            onPick={(v) => p.onSearch(withPick(search, f.key, v))}
          />
        );
      })}
      {picks.length > 0 && (
        <button type="button" className="list-link" onClick={() => clearTo(cleared(search))}>
          清除筛选
        </button>
      )}
      {shown && <span className="list-count">{`${digits(shown.length)}条`}</span>}
    </div>
  );

  let body: ReactNode;
  if (p.error !== undefined && p.error !== null) {
    body = <StateView error={p.error} onRetry={p.onRetry} />;
  } else if (!shown) {
    body = <StateView pending skeleton={<Skeleton rows={8} rowHeight={two ? 56 : 44} />} />;
  } else if (shown.length === 0) {
    body = (
      <EmptyBlock
        icon={<Icon of={Search} size={20} />}
        title={`没有符合条件的${entity.label}`}
        // 这里连搜索和页签一起回到默认（只有搜索、只有页签时也要能出去），与工具条上只清筛选按钮的「清除筛选」
        // 做的事不同，所以不叫同一个名字（spec 顶部第 9 步评审之后的 Revisions）
        link={
          <button type="button" className="list-link" onClick={() => clearTo(cleared(search, true))}>
            看全部
          </button>
        }
      />
    );
  } else {
    body = (
      <FieldEnvContext.Provider value={env}>
        <Table<ListRow>
          className="list-table"
          rowKey="code"
          dataSource={shown}
          columns={tableColumns(entity, cols, rows ?? [], p)}
          tableLayout="fixed"
          scroll={{ x: tableMinWidth(cols, rows ?? [], titleMin) }}
          rowClassName={two ? 'is-two-line' : undefined}
          pagination={{
            current,
            pageSize: PAGE_SIZE,
            hideOnSinglePage: true,
            showSizeChanger: false,
            showTotal: (total) => `共${digits(total)}条`,
            onChange: (n) => setPage({ sig, n }),
          }}
        />
      </FieldEnvContext.Provider>
    );
  }

  const tabs: Tab[] = anon ? ['all'] : ['all', 'active', 'draft'];
  return (
    <Tabs
      className="list-tabs"
      activeKey={tab}
      onChange={(k) => p.onSearch({ ...search, status: k === 'active' || k === 'draft' ? k : undefined })}
      items={tabs.map((t) => ({
        key: t,
        label: (
          <span className="tab-label">
            {TAB_LABEL[t]}
            {counts && <span className="tab-count">{digits(counts[t])}</span>}
          </span>
        ),
        children:
          t === tab ? (
            <>
              {toolbar}
              {body}
            </>
          ) : null,
      }))}
    />
  );
}
