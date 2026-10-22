// AI 记录（07 spec R24）：跨会话按时间倒序列出 AI 的每一轮，能按时间段、结果、触发的护栏、转人工原因、回复是否超长筛选；
// 点一行在右侧抽屉里打开现有的「AI为什么这么回」（conversations/TraceDetail.tsx，不另写一份），里面有「存为回归用例」。
// 从上到下：页头 → 筛选（都写在地址里，traces-search.ts）→ 表格 →「加载更早的记录」（游标翻页，不做滚到底自动加载）。
// 页面状态：加载是 8 行骨架；空是「这段时间没有AI记录」加「清空筛选」；文件存储下 /traces 回 503 store_file_mode，写「AI记录只在会话入库后才有」；
// 取更早的一页失败时只在底部就地说明，已经列出的行保留。只有所有者、管理员看得到（和 trace 详情一个权限）：导航里别的角色没有这一页，
// 直接打开这个地址时不发请求，只写一句说明。界面不认行业：会话标签的客户叫法取自行业包（model.ts）
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button, Drawer, Segmented, Select, Switch, Table } from 'antd';
import { ArrowUpRight, ScrollText, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, HttpError, unwrap } from '../api.js';
import { TraceTab } from '../conversations/TraceDetail.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { popupRegion } from '../parts/popupRegion.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { PageHeader } from '../shell/PageHeader.js';
import { POLL } from '../shell/model.js';
import type { TracesSearch } from '../traces-search.js';
import { cjk } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import type { TracePage } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import {
  emptyLink,
  FILE_STORE_TITLE,
  filtersOf,
  GUARD_OPTIONS,
  HANDOFF_OPTIONS,
  OUTCOME_OPTIONS,
  queryOf,
  RANGES,
  rowAria,
  rowsOfPages,
  rowView,
  type TraceFilters,
  type TraceRowView,
  withFilter,
} from './model.js';

/** 「刚刚」「8分钟前」按它算：打开时取一次，之后与其余页面的轮询同一个节奏每 30 秒更新 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL.refetchInterval);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Header() {
  return <PageHeader title="AI记录" status={<span>{cjk(['每一轮AI回复的记录', '点一行看AI为什么这么回'])}</span>} />;
}

/** /traces 回 503 store_file_mode：文件存储下 trace 不入库，没有可列的东西 */
const isFileMode = (error: unknown): boolean => error instanceof HttpError && error.body.error === 'store_file_mode';

// ---------------- 筛选 ----------------

function Filters({ search }: { search: TracesSearch }) {
  const navigate = useNavigate();
  const f = filtersOf(search);
  const go = (patch: Parameters<typeof withFilter>[1]): void => void navigate({ to: '/traces', search: withFilter(search, patch) });
  return (
    <div className="tr-filters">
      <div className="tr-seg-scroll">
        {/* tabIndex -1：rc-segmented 给整条轨道也放了 tabIndex 0，那一站方向键不起作用，只多一次 Tab；Tab 直接进选中的那一段 */}
        <Segmented
          aria-label="按时间段筛选"
          tabIndex={-1}
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
          value={f.range}
          onChange={(key) => go({ range: key })}
        />
      </div>
      <Select
        className="tr-select"
        aria-label="按结果筛选"
        placeholder="全部结果"
        allowClear
        // 选项不多（最多三十来个），不用虚拟列表：全部选项都在 DOM 里，读屏数得出总数
        virtual={false}
        value={f.outcome}
        options={OUTCOME_OPTIONS.map((o) => ({ ...o }))}
        popupRender={popupRegion('筛选：结果')}
        onChange={(v: string | undefined) => go({ outcome: v })}
      />
      <Select
        className="tr-select tr-select-wide"
        aria-label="按触发的护栏筛选"
        placeholder="触发的护栏"
        allowClear
        // 选项不多（最多三十来个），不用虚拟列表：全部选项都在 DOM 里，读屏数得出总数
        virtual={false}
        value={f.guard}
        options={GUARD_OPTIONS.map((o) => ({ ...o }))}
        popupRender={popupRegion('筛选：触发的护栏')}
        onChange={(v: string | undefined) => go({ guard: v })}
      />
      <Select
        className="tr-select tr-select-wide"
        aria-label="按转人工原因筛选"
        placeholder="转人工原因"
        allowClear
        // 选项不多（最多三十来个），不用虚拟列表：全部选项都在 DOM 里，读屏数得出总数
        virtual={false}
        value={f.handoff}
        options={HANDOFF_OPTIONS.map((o) => ({ ...o }))}
        popupRender={popupRegion('筛选：转人工原因')}
        onChange={(v: string | undefined) => go({ handoff: v })}
      />
      {/* 点文字也能开关：Switch 是 button，放在 label 里就由 label 的文字命名 */}
      <label className="tr-over">
        <Switch checked={f.over} onChange={(on) => go({ over: on ? 1 : undefined })} />
        只看回复超长的
      </label>
    </div>
  );
}

// ---------------- 表格 ----------------

function TraceTable({
  rows,
  selected,
  onOpen,
}: {
  rows: TraceRowView[];
  selected: string | null;
  onOpen: (row: TraceRowView, trigger: HTMLElement | null) => void;
}) {
  return (
    <Table<TraceRowView>
      className="tr-table"
      rowKey="key"
      dataSource={rows}
      tableLayout="fixed"
      pagination={false}
      aria-label={`AI记录，共${rows.length}条`}
      scroll={{ x: 980, scrollToFirstRowOnChange: false }}
      onRow={(r) => ({
        className: r.key === selected ? 'tr-row is-selected' : 'tr-row',
        'aria-current': r.key === selected ? 'true' : undefined,
        // 点在行上（不在按钮和链接上、也不是在选字）就是点那一行的时间按钮
        onClick: (e: MouseEvent<HTMLElement>) => {
          if (e.target instanceof Element && e.target.closest('button, a')) return;
          if ((window.getSelection?.()?.toString() ?? '') !== '') return;
          onOpen(r, e.currentTarget.querySelector<HTMLElement>('.tr-when'));
        },
      })}
      columns={[
        {
          key: 'when',
          title: '时间',
          width: 132,
          fixed: 'left',
          render: (_, r) => (
            <button
              type="button"
              className="tr-when"
              aria-haspopup="dialog"
              aria-label={rowAria(r)}
              onClick={(e) => onOpen(r, e.currentTarget)}
            >
              <time dateTime={r.at} title={r.whenFull}>
                {r.when}
              </time>
            </button>
          ),
        },
        {
          key: 'conversation',
          title: '会话',
          width: 168,
          render: (_, r) => (
            <Link to="/conversations/$id" params={{ id: r.conversationId }} className="tr-conv">
              {cjk(r.label)}
            </Link>
          ),
        },
        { key: 'outcome', title: '结果', width: 100, render: (_, r) => r.outcome },
        {
          key: 'guards',
          title: '触发的护栏',
          width: 220,
          render: (_, r) => (
            <span className={r.guardsFull ? 'tr-text' : 'tr-dim'} title={r.guardsFull || undefined}>
              {cjk(r.guards)}
            </span>
          ),
        },
        {
          key: 'handoff',
          title: '转人工原因',
          width: 200,
          render: (_, r) => <span className={r.handoff ? 'tr-text' : 'tr-dim'}>{r.handoff ? cjk(r.handoff) : '—'}</span>,
        },
        {
          key: 'over',
          title: '回复',
          width: 80,
          render: (_, r) => <span className={r.overLimit ? 'tr-text' : 'tr-dim'}>{r.overLimit ? '超长' : '—'}</span>,
        },
        { key: 'took', title: '耗时', width: 96, align: 'right', render: (_, r) => <span className="tr-num">{r.took}</span> },
      ]}
    />
  );
}

// ---------------- 页面 ----------------

/** 列表的查询（游标翻页）：since 在取数的那一刻按现在往前推，所以取数函数在组件外面 */
const listQuery = (filters: TraceFilters) => ({
  queryKey: ['traces', 'list', filters] as const,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    unwrap(api.traces.$get({ query: queryOf(filters, Date.now(), pageParam) })),
  getNextPageParam: (last: TracePage) => last.next ?? undefined,
});

function MemberTraces({ pack }: { pack: IndustryPack }) {
  const search = useSearch({ from: '/traces' });
  const now = useNow();
  const filters = filtersOf(search);
  const q = useInfiniteQuery(listQuery(filters));
  const rows = rowsOfPages(q.data?.pages).map((r) => rowView(r, pack, now));

  // 抽屉：关上之后内容留到收起动画结束，焦点回到点开它的那一格（同审计日志页）
  const [shown, setShown] = useState<{ row: TraceRowView; trigger: HTMLElement | null } | null>(null);
  const [open, setOpen] = useState(false);
  const openRow = (row: TraceRowView, trigger: HTMLElement | null): void => {
    setShown({ row, trigger });
    setOpen(true);
  };
  const trigger = shown?.trigger ?? null;
  useEffect(() => {
    if (!open && trigger?.isConnected) trigger.focus();
  }, [open, trigger]);

  // 「加载更早的记录」：取到底时按钮换成「没有更早的记录了」；取完后焦点丢了（原在按钮上）就放回按钮或那一句上
  const moreRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLParagraphElement>(null);
  const refocus = useRef<{ pages: number; errorAt: number } | null>(null);
  const pageCount = q.data?.pages.length ?? 0;
  const errorAt = q.errorUpdatedAt;
  const loadMore = (): void => {
    refocus.current = { pages: pageCount, errorAt };
    void q.fetchNextPage();
  };
  const fetchingMore = q.isFetchingNextPage;
  const hasMore = q.hasNextPage;
  useEffect(() => {
    const r = refocus.current;
    if (!r || fetchingMore || (r.pages === pageCount && r.errorAt === errorAt)) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (hasMore ? moreRef.current : endRef.current)?.focus();
  }, [fetchingMore, hasMore, pageCount, errorAt]);

  let body: ReactNode;
  const fileMode = !q.data && isFileMode(q.error);
  if (fileMode) {
    body = (
      <EmptyBlock
        level={2}
        icon={<Icon of={ScrollText} size={20} />}
        title={FILE_STORE_TITLE}
        description="会话存进数据库以后，AI的每一轮才会记在这里"
      />
    );
  } else if (!q.data) {
    body = <StateView pending={!q.isError} error={q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={8} />} />;
  } else if (rows.length === 0) {
    const link = emptyLink(filters);
    body = (
      <EmptyBlock
        level={2}
        icon={<Icon of={ScrollText} size={20} />}
        title="这段时间没有AI记录"
        link={
          link && (
            <Link to="/traces" search={link.search}>
              {link.label}
            </Link>
          )
        }
      />
    );
  } else {
    body = (
      <div className="tr-list">
        <TraceTable rows={rows} selected={open && shown ? shown.row.key : null} onOpen={openRow} />
        {q.isFetchNextPageError && <ErrorAlert error={q.error} onRetry={loadMore} />}
        {hasMore ? (
          <Button ref={moreRef} className="tr-more" loading={fetchingMore} onClick={loadMore}>
            加载更早的记录
          </Button>
        ) : (
          <p ref={endRef} className="tr-end" tabIndex={-1}>
            没有更早的记录了
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <Header />
      {/* 文件存储下没有可筛的东西，整行筛选不画 */}
      {!fileMode && <Filters search={search} />}
      {body}
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        afterOpenChange={(isOpen) => {
          if (!isOpen) setShown(null);
        }}
        focusable={{ focusTriggerAfterClose: false }}
        size={480}
        closable={false}
        title="AI为什么这么回"
        extra={<IconButton icon={X} label="关闭" placement="bottomRight" onClick={() => setOpen(false)} />}
        rootClassName="tr-drawer"
      >
        {shown && (
          <div className="tr-drawer-body">
            <p className="tr-drawer-meta">
              <Link to="/conversations/$id" params={{ id: shown.row.conversationId }} className="tr-conv">
                {cjk(shown.row.label)}
                <Icon of={ArrowUpRight} size={14} />
              </Link>
              <span title={shown.row.whenFull}>{shown.row.when}</span>
            </p>
            <TraceTab id={shown.row.conversationId} turnId={shown.row.key} />
          </div>
        )}
      </Drawer>
    </>
  );
}

export function TracesPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  // 外壳只在成员或 demo 匿名时渲染路由，两种都带着行业包
  if (!pack) return null;
  if (canEdit(viewer)) return <MemberTraces pack={pack} />;
  const member = viewer?.kind === 'member';
  return (
    <>
      <Header />
      <EmptyBlock
        level={2}
        icon={<Icon of={ScrollText} size={20} />}
        title={member ? '你的角色看不到AI记录' : '登录后才能看AI记录'}
        description="AI记录只给所有者、管理员看"
      />
    </>
  );
}
