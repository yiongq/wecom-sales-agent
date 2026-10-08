// 会话列表（02 spec「后台页面 · 会话列表（I 页）」，设计系统 §4.4、§5.5、§5.6、§6.7、§10.2 I 页）。
// 从上到下：页头（「打开工作台」在当前标签打开 J 页，选中第一个等人接手的会话）→ 页签（全部 / 等人接手 / 顾问处理中〔有
// 这种会话或地址选了它才出现〕/ AI接待中 / 已成交）→「客户停在哪一步」的阶段条 → 表格。
// 页签与阶段条的数取同一次 GET /conversations/counts（与侧栏软徽标、铃铛共用缓存，断线超过 30 秒退回轮询、
// 重连立刻停，见 shell/live.ts），表格取 GET /conversations?order=waiting_first（服务端排好、先过滤再分页，每页 20 条）。
// 选中的页签（state）、阶段筛选（stage）、页码（page）都写在地址里（conversations-search.ts），刷新、后退、分享都能还原。
// 点一行或「打开工作台」：在当前标签打开 /conversations/$id（J 页，02 第 19 步起；admin.html 的新标签打开已取代）。
// 界面不认行业：阶段名和顺序、客户的叫法都取自行业包；会话状态只经 conversationState 判定（model.ts）。
// 匿名没有入口（01）：直接打开这个地址时不发请求，只写一句说明
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Table } from 'antd';
import { ArrowUpRight, ChevronDown, ChevronRight, MessagesSquare, X } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { ConversationCounts } from '../../../src/shared/console-api.js';
import { digits } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, unwrap } from '../api.js';
import type { ConversationsSearch } from '../conversations-search.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { conversationCountsQuery, waitingConversationsQuery } from '../queries.js';
import { useViewport } from '../shell/hooks.js';
import { Icon } from '../shell/icons.js';
import { useLivePollInterval } from '../shell/live.js';
import { badgeText, POLL } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { usePack, useViewer } from '../viewer.js';
import {
  activeTab,
  clearStage,
  listQuery,
  openAria,
  PAGE_SIZE,
  pageCount,
  pageOf,
  pageSearch,
  rowAria,
  rowView,
  type RowView,
  stageLabel,
  stageSearch,
  type Tab,
  tableAria,
  tabs,
  tabSearch,
} from './model.js';
import { stageRows } from './stages.js';

/**
 * 筛选链接只在地址完全相同时算「当前」：TanStack 默认按子集比 search，取消筛选的链接（?state=ai）在 ?state=ai&stage=quote
 * 上会被标成 aria-current="page"
 */
const EXACT = { exact: true, includeSearch: true } as const;

/**
 * 与外壳共用的计数：外壳启动时刚取过，30 秒内的直接用（匿名不会到这里，但成员也不必白取一次），之后照常与外壳一起轮询
 * （断线超过 30 秒退回，重连立刻停，见 shell/live.ts）
 */
function useSharedPoll() {
  const interval = useLivePollInterval(POLL.refetchInterval);
  return { refetchInterval: interval, refetchIntervalInBackground: false, staleTime: POLL.refetchInterval } as const;
}

/** 相对时间（「8分钟前」）按它算：打开时取一次，之后与计数轮询同一个节奏每 30 秒更新 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL.refetchInterval);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * 页头主按钮「打开工作台」：在当前标签打开 J 页，选中第一个等人接手的会话（02 spec「后台页面」I 页）。
 * firstWaitingId 是 undefined（还没取到）或 null（没有等人接手的会话）时按钮写成 blocked：J 页今天还没有「不选中
 * 任何会话」的入口（第 20.2 步才画三栏），没有等人接手的会话时就没有地方可去，这是第 19 步的最小取舍（见 plan 实施记录）
 */
function Header({ pack, member, firstWaitingId }: { pack: IndustryPack; member: boolean; firstWaitingId: string | null | undefined }) {
  const navigate = useNavigate();
  return (
    <PageHeader
      title="会话"
      // 状态句包成一段：页头的状态行是 flex，Sep 拆成单独的项会多出 8 的间隔
      status={<span>{cjk([`企业微信里的${pack.vocabulary.customer}会话`, '在工作台里接手和回复'])}</span>}
      actions={
        member && (
          <PrimaryButton
            blocked={!firstWaitingId}
            onClick={firstWaitingId ? () => void navigate({ to: '/conversations/$id', params: { id: firstWaitingId } }) : undefined}
            icon={<Icon of={ArrowUpRight} />}
            iconPlacement="end"
            aria-label={firstWaitingId ? '打开工作台' : '打开工作台（没有等人接手的会话）'}
            title={firstWaitingId ? undefined : '没有等人接手的会话'}
          >
            打开工作台
          </PrimaryButton>
        )
      }
    />
  );
}

// ---------------- 页签 ----------------

/** 页签与它下面唯一的一块面板：面板的内容不随页签换，换页签只改地址、按新地址取数 */
const TAB_ID = (key: Tab['key']): string => `cv-tab-${key}`;
const PANEL_ID = 'cv-panel';

/** 页签的字：名字后面跟 13 text-3 的数；「等人接手」有数时用软徽标（设计系统 §4.4） */
function TabLabel({ tab }: { tab: Tab }) {
  const soft = tab.soft ? badgeText(tab.count ?? 0) : null;
  return (
    <span className="cv-tab">
      {tab.label}
      {soft ? (
        <span className="badge-soft" aria-label={`${tab.count}个`}>
          {soft}
        </span>
      ) : (
        tab.count !== null && <span className="cv-tab-count">{digits(tab.count)}</span>
      )}
    </span>
  );
}

/**
 * 下划线式页签（设计系统 §4.4），照 I 页画成 role=tab 的按钮，不用 antd Tabs：antd 的每个页签各有一块面板，
 * 换页签就把阶段条和表格整块卸掉重挂，焦点掉到 body、「以表格查看」也被重置；它还在获得焦点的页签里塞一句
 * 英文的「Tab 1 of 4」读屏提示，进了页签的名字。键盘：左右键在页签间移焦点（首尾相接），Home、End 到头尾，
 * 回车或空格才换（换页签要取数，不跟着焦点自动换）；只有选中的页签在 Tab 顺序里
 */
function StateTabs({ items, active, onSelect }: { items: Tab[]; active: Tab['key']; onSelect: (key: Tab['key']) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const i = buttons.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % buttons.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + buttons.length) % buttons.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    buttons[to]?.focus();
  };
  return (
    <div className="cv-tabs-scroll">
      <div role="tablist" aria-label="按接待状态筛选" className="cv-tabs" onKeyDown={onKeyDown}>
        {items.map((t) => {
          const selected = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={TAB_ID(t.key)}
              className={selected ? 'cv-tab-btn is-selected' : 'cv-tab-btn'}
              aria-selected={selected}
              aria-controls={PANEL_ID}
              tabIndex={selected ? 0 : -1}
              // 点已选中的页签不动：「AI接待中」下的阶段筛选留着（清阶段用筛选条）
              onClick={() => !selected && onSelect(t.key)}
            >
              <TabLabel tab={t} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- 客户停在哪一步 ----------------

function StageBlock({
  pack,
  counts,
  search,
}: {
  pack: IndustryPack;
  counts: UseQueryResult<ConversationCounts>;
  search: ConversationsSearch;
}) {
  const [asTable, setAsTable] = useState(false);
  const rows = counts.data ? stageRows(pack, counts.data.aiByStage) : [];
  const liveStages = Math.max(1, pack.stages.filter((s) => !s.terminal).length);
  const filterLink = (key: string, className: string, children: ReactNode, label: string): ReactNode => {
    const selected = search.stage === key;
    return (
      <Link
        to="/conversations"
        search={stageSearch(key, search)}
        activeOptions={EXACT}
        className={selected ? `${className} is-selected` : className}
        // 清掉阶段筛选之后焦点回到这一行（MemberConversations），按它找
        data-stage={key}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${label}，${selected ? '取消阶段筛选' : '只看这个阶段的会话'}`}
      >
        {children}
      </Link>
    );
  };
  return (
    <section className="cv-stages" aria-labelledby="cv-stages-title">
      <div className="cv-head">
        <h2 id="cv-stages-title" className="cv-title">
          {`${pack.vocabulary.customer}停在哪一步`}
        </h2>
        {counts.data && <span className="cv-count">{`AI接待中的${counts.data.byState.ai}个会话`}</span>}
        {counts.data && (
          <button type="button" className="cv-head-btn" onClick={() => setAsTable((t) => !t)}>
            {asTable ? '以条形图查看' : '以表格查看'}
            <Icon of={ChevronRight} size={14} />
          </button>
        )}
      </div>
      {counts.isError ? (
        <StateView error={counts.error} onRetry={() => void counts.refetch()} />
      ) : !counts.data ? (
        <div className="state-skeleton" role="status" aria-label="正在载入">
          {Array.from({ length: liveStages }, (_, i) => (
            <div key={i} className="cv-stage">
              <span className="skeleton-bar" />
            </div>
          ))}
        </div>
      ) : asTable ? (
        <table className="cv-stage-table">
          <thead>
            <tr>
              <th scope="col">阶段</th>
              <th scope="col">会话</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key ?? '$other'}>
                <th scope="row" className={r.branch ? 'is-branch' : undefined}>
                  {r.key === null ? r.label : filterLink(r.key, 'cv-stage-cell', r.label, `${r.label}${r.count}个会话`)}
                </th>
                <td>{digits(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="cv-stage-list">
          {rows.map((r) => {
            const cls = ['cv-stage', r.branch && 'is-branch', r.count === 0 && 'is-zero'].filter(Boolean).join(' ');
            const body = (
              <>
                <span className="cv-stage-label">{r.label}</span>
                <span className="cv-stage-track">
                  {r.count > 0 && <span className="cv-stage-bar" style={{ width: `${r.ratio * 100}%` }} />}
                </span>
                <span className="cv-stage-count">{digits(r.count)}</span>
              </>
            );
            return (
              <li key={r.key ?? '$other'}>
                {r.key === null ? <span className={cls}>{body}</span> : filterLink(r.key, cls, body, `${r.label}${r.count}个会话`)}
              </li>
            );
          })}
        </ul>
      )}
      {counts.data && <p className="cv-note">按每个会话现在所处的阶段统计</p>}
    </section>
  );
}

// ---------------- 表格 ----------------

/** 点一行（不是点在链接上、也不是在选字）：在当前标签打开 J 页（02 第 19 步起，admin.html 的新标签打开已取代） */
function openRow(e: MouseEvent, id: string, navigate: ReturnType<typeof useNavigate>): void {
  if (e.target instanceof Element && e.target.closest('a, button')) return;
  if ((window.getSelection?.()?.toString() ?? '') !== '') return;
  void navigate({ to: '/conversations/$id', params: { id } });
}

/** 首列宽：设计宽度下 300；<992 横滚时首列固定，300 会占满整个视口，收成放得下「企微客户 · F01」的宽度 */
const FIRST_COL = { wide: 300, narrow: 176 } as const;

function ConversationTable({ rows, total, search }: { rows: RowView[]; total: number; search: ConversationsSearch }) {
  const navigate = useNavigate();
  const narrow = useViewport() === 'narrow';
  return (
    <Table<RowView>
      className="cv-table"
      rowKey="id"
      dataSource={rows}
      tableLayout="fixed"
      aria-label={tableAria(total)}
      // 窄屏在自己的容器里横滚，首列固定（spec「可访问性与响应式」375 宽）。翻页时 antd 默认把表格的滚动容器动画滚回顶上，
      // 这个容器只横滚、没有什么可滚的，动画白跑（它按 Date.now 算时长，时钟钉住时停不下来），关掉
      scroll={{ x: 960, scrollToFirstRowOnChange: false }}
      onRow={(r) => ({ onClick: (e) => openRow(e, r.id, navigate), className: 'cv-row' })}
      pagination={
        total > PAGE_SIZE && {
          current: pageOf(search),
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (t) => `共${t}条`,
          onChange: (p) => void navigate({ to: '/conversations', search: pageSearch(search, p) }),
        }
      }
      columns={[
        {
          key: 'conversation',
          title: '会话',
          width: narrow ? FIRST_COL.narrow : FIRST_COL.wide,
          fixed: 'left',
          render: (_, r) => (
            <span className="cv-conv">
              <Icon of={MessagesSquare} className="cv-conv-icon" />
              <Link to="/conversations/$id" params={{ id: r.id }} className="cv-conv-link" aria-label={rowAria(r)}>
                {cjk(r.label)}
              </Link>
            </span>
          ),
        },
        { key: 'state', title: '状态', width: 140, render: (_, r) => <Status kind={r.state} /> },
        {
          key: 'stage',
          title: '阶段',
          width: 120,
          render: (_, r) => <span className={r.stage === '—' ? 'cv-dim' : 'cv-text-2'}>{r.stage}</span>,
        },
        { key: 'messages', title: '消息', width: 88, align: 'right', render: (_, r) => digits(r.messages) },
        {
          key: 'when',
          // 排序是固定的：等人接手的在前，其余按最后动静倒序（服务端排好）；表头只标明，不能点。
          // 「等人接手的在前」这一层写在表格的名字里（tableAria），aria-sort 标的是其下的这一层（设计系统 I 页）。
          // 等人接手的行写等待时长，≥10 分钟 danger（02 第 19 步，与 J 页列表同一条规则）
          title: (
            <span className="cv-sorted">
              最后动静
              <Icon of={ChevronDown} size={12} />
            </span>
          ),
          width: 160,
          onHeaderCell: () => ({ 'aria-sort': 'descending' }),
          render: (_, r) => (
            <time className={r.waitDanger ? 'cv-when is-danger' : 'cv-when'} dateTime={r.at} title={r.whenFull}>
              {r.when}
            </time>
          ),
        },
        {
          key: 'open',
          // 表头看不见，但要有读屏念得出的字（aria-label 不算表头文字，axe empty-table-header）
          title: <span className="cv-sr">操作</span>,
          align: 'right',
          className: 'cv-op-cell',
          render: (_, r) => (
            <Link to="/conversations/$id" params={{ id: r.id }} className="cv-open" aria-label={openAria(r)}>
              打开工作台
              <Icon of={ArrowUpRight} size={14} />
            </Link>
          ),
        },
      ]}
    />
  );
}

function MemberConversations({ pack }: { pack: IndustryPack }) {
  const search = useSearch({ from: '/conversations' });
  const navigate = useNavigate();
  const now = useNow();
  const sharedPoll = useSharedPoll();
  const counts = useQuery({ ...conversationCountsQuery, ...sharedPoll });
  // 页头「打开工作台」选第一个等人接手的会话：与铃铛共用这一个查询（同一次响应）
  const waiting = useQuery({ ...waitingConversationsQuery, ...sharedPoll });
  const firstWaitingId = waiting.data ? (waiting.data.items[0]?.id ?? null) : undefined;
  const params = listQuery(search);
  const list = useQuery({
    queryKey: ['conversations', 'list', params] as const,
    queryFn: () => unwrap(api.conversations.$get({ query: params })),
    ...POLL,
    // 翻页时先留着上一页，不换成骨架；换了页签或阶段就不留（上一类的行不能冒充这一类）
    placeholderData: (prev, prevQuery) => {
      const was = prevQuery?.queryKey[2];
      return was && was.state === params.state && was.stage === params.stage ? prev : undefined;
    },
  });
  const data = list.data;
  const page = pageOf(search);
  // 地址里的页码超过了最后一页（会话变少了、链接是旧的）：换成最后一页，不显示空表。
  // 只看这一页自己的数据：翻页时先留着的上一页（placeholder）不算，不然换页之后还拿旧数据再跳一次，来回跳个不停
  const beyond =
    data !== undefined && !list.isPlaceholderData && data.total > 0 && page > pageCount(data.total) ? pageCount(data.total) : null;
  useEffect(() => {
    if (beyond !== null) void navigate({ to: '/conversations', search: pageSearch(search, beyond), replace: true });
  }, [beyond, search, navigate]);

  // 阶段筛选没了，而焦点所在的元素也跟着没了（点了筛选条「阶段：报价 ×」或「清除筛选」，它们随筛选一起消失；
  // 也可能是后退），焦点会掉到 body：放回刚才筛的那一行阶段（阶段条与小表格里都有），没有这一行（计数没取到）就放回
  // 选中的页签。焦点还在页面上的（点已选中的阶段取消、点页签）不动
  const panel = useRef<HTMLDivElement>(null);
  const lastStage = useRef(search.stage);
  useEffect(() => {
    const was = lastStage.current;
    lastStage.current = search.stage;
    if (was === undefined || search.stage !== undefined) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    const links = [...(panel.current?.querySelectorAll<HTMLElement>('[data-stage]') ?? [])];
    (links.find((e) => e.dataset.stage === was) ?? document.getElementById(TAB_ID(activeTab(search))))?.focus();
  }, [search]);

  const filtered = search.state !== undefined || search.stage !== undefined;
  const customer = pack.vocabulary.customer;
  // 一个会话都没有：空状态替换页签、阶段条和表格（不留空表头）
  if (data && data.total === 0 && !filtered) {
    return (
      <>
        <Header pack={pack} member firstWaitingId={firstWaitingId} />
        <EmptyBlock
          level={2}
          icon={<Icon of={MessagesSquare} size={20} />}
          title={`${customer}的会话会出现在这里`}
          description={`${customer}在企业微信里发来第一句话后就会出现`}
        />
      </>
    );
  }
  const active = activeTab(search);
  const rows = data ? data.items.map((r) => rowView(r, pack, now)) : [];
  return (
    <>
      <Header pack={pack} member firstWaitingId={firstWaitingId} />
      <StateTabs
        items={tabs(counts.data, active)}
        active={active}
        onSelect={(key) => void navigate({ to: '/conversations', search: tabSearch(key) })}
      />
      {/* 只有一块面板：换页签、点阶段条都不卸掉阶段条和表格，焦点和「以表格查看」都留着 */}
      <div ref={panel} role="tabpanel" id={PANEL_ID} aria-labelledby={TAB_ID(active)}>
        <StageBlock pack={pack} counts={counts} search={search} />
        {search.stage !== undefined && (
          <div className="cv-filters">
            <Link
              to="/conversations"
              search={clearStage(search)}
              activeOptions={EXACT}
              className="cv-chip"
              aria-label={`清除阶段筛选：${stageLabel(pack, search.stage)}`}
            >
              {`阶段：${stageLabel(pack, search.stage)}`}
              <Icon of={X} size={14} />
            </Link>
          </div>
        )}
        <div className="cv-list">
          <StateView
            pending={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            skeleton={<Skeleton rows={8} />}
            empty={
              data &&
              data.total === 0 && {
                title: '这个分类下没有会话',
                link:
                  search.stage !== undefined ? (
                    <Link to="/conversations" search={clearStage(search)} activeOptions={EXACT}>
                      清除筛选
                    </Link>
                  ) : undefined,
              }
            }
          >
            <ConversationTable rows={rows} total={data?.total ?? 0} search={search} />
          </StateView>
        </div>
      </div>
    </>
  );
}

export function ConversationsPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  // 外壳只在成员或 demo 匿名时渲染路由，两种都带着行业包
  if (!pack) return null;
  if (viewer?.kind === 'member') return <MemberConversations pack={pack} />;
  return (
    <>
      <Header pack={pack} member={false} firstWaitingId={null} />
      <EmptyBlock
        level={2}
        icon={<Icon of={MessagesSquare} size={20} />}
        title="登录后才能看会话"
        description={`会话里有${pack.vocabulary.customer}的信息，只给成员看`}
      />
    </>
  );
}
