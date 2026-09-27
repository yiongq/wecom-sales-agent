// 总览（spec「逐页设计 · 总览（A 页）」，设计系统 §5.10、§5.11、§6.7、§10.2 A 页）：回答两个问题，现在要处理什么，业务怎么样。
// 从上到下：需要你处理 → 系统状态 → 业务数 → 最近变更 / 客户停在哪一步。
// - 只调现有接口和 spec 新增的两个只读接口；各块自己加载、自己出错，一块失败只有这一块写「没取到 · 重试」，其余照常。
//   会话计数、等人接手的首页、各实体列表与外壳（侧栏徽标、铃铛、条目数）共用同一份缓存，页面可见时一起每 30 秒刷新。
// - 谁看得到什么：等人接手、系统状态、业务数、客户停在哪一步给成员；话术草稿、待上架与最近变更只给所有者、管理员
//   （没有「最近变更」时右栏挪到左栏的位置，宽度不变）；demo 匿名只有页头下的横幅和「在售」一格。
// - 界面不认行业：实体、阶段、话术节、叫法都取自行业包（model.ts）。A2（02 之后的等待时长、接手、待付款）不在这一步
import { type UseQueryResult, useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Alert } from 'antd';
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, SquareTerminal } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import type { CatalogItem, ConversationRow, Status as SystemStatus } from '../../../src/shared/console-api.js';
import { dateWithWeekday, digits } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { catalogListQuery, conversationCountsQuery, waitingConversationsQuery } from '../queries.js';
import { useChangeFlash } from '../shell/hooks.js';
import { Icon, navIcon } from '../shell/icons.js';
import { avatarIndex, firstChar, packEntities, POLL, workbenchHref } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import {
  catalogCounts,
  catalogTodos,
  type EntityList,
  inSaleKpi,
  itemTitle,
  type Kpi,
  memberKpis,
  type Segment,
  sopTodo,
  stageRows,
  systemView,
  timeline,
  type TimelineRow,
  todoOrder,
  type TodoRow,
  waitingTodos,
} from './model.js';
import { draftCheckQuery, latestPaidQuery, recentAuditQuery, sopQuery, statusQuery } from './queries.js';

type AnyQuery = Pick<UseQueryResult<unknown>, 'isPending' | 'isError' | 'error' | 'refetch'>;

/**
 * 与外壳共用的查询（会话计数、等人接手、各实体列表）：外壳启动时刚取过，总览的块晚一步挂上，默认的 staleTime 0 会让它们
 * 各重取一遍。匿名访客的查询按 IP 限流（每分钟 60 次），不该白用。30 秒内的数据直接用，之后照常与外壳一起轮询
 */
const SHARED = { ...POLL, staleTime: POLL.refetchInterval } as const;

/** 一块的几个数据来源：都回来了才画（不跳动）；取失败的只重取失败的那几个 */
function sourcesState(sources: readonly AnyQuery[]) {
  const failed = sources.filter((q) => q.isError);
  return {
    loading: sources.some((q) => q.isPending && !q.isError),
    error: failed[0]?.error ?? null,
    retry: () => failed.forEach((q) => void q.refetch()),
  };
}

/** 成员拿到的产品库列表带状态；匿名投影没有（只有已上架的） */
const memberItems = (items: readonly object[]): CatalogItem[] => items.filter((i): i is CatalogItem => 'status' in i);

/** 各实体的列表：与侧栏的条目数、⌘K 共用缓存 */
function useEntityLists(pack: IndustryPack, enabled: boolean) {
  const entities = packEntities(pack);
  const lists = useQueries({
    queries: entities.map((e) => ({ ...catalogListQuery(catalogKind(e.kind)), staleTime: SHARED.staleTime, enabled })),
  });
  const loaded: EntityList[] = entities.flatMap((entity, i) => {
    const data = lists[i]?.data;
    return data ? [{ entity, items: memberItems(data.items) }] : [];
  });
  return { entities, lists, loaded };
}

// ---------------- 区块头（§5.11） ----------------

function BlockHead({ id, title, count, link }: { id: string; title: string; count?: string | null; link?: ReactNode }) {
  return (
    <div className="ov-head">
      <h2 id={id} className="ov-title">
        {cjk(title)}
      </h2>
      {count && <span className="ov-count">{cjk(count)}</span>}
      {link}
    </div>
  );
}

/** 区块头右侧的链接（13/500 text-2，后接 chevron-right）：两个区块都链到会话列表，「客户停在哪一步」只看 AI 接待中 */
function ConversationsLink({ children, state }: { children: string; state?: 'ai' }) {
  return (
    <Link to="/conversations" search={state ? { state } : {}} className="ov-head-link">
      {children}
      <Icon of={ChevronRight} size={14} />
    </Link>
  );
}

/** 上下文或明细的几段，用 Sep 隔开；tone 为 danger 的那段用 danger 字，前面加 circle-alert */
function Segments({ segments }: { segments: readonly Segment[] }) {
  return segments.map((s, i) => (
    <Fragment key={i}>
      {i > 0 && <Sep />}
      {s.tone === 'danger' ? (
        <span className="ov-danger">
          <Icon of={CircleAlert} size={14} />
          {cjk(s.text)}
        </span>
      ) : (
        cjk(s.text)
      )}
    </Fragment>
  ));
}

// ---------------- ① 需要你处理 ----------------

function TodoLine({ row }: { row: TodoRow }) {
  const external = row.target.kind === 'workbench';
  const body = (
    <>
      <span className="ov-todo-icon" aria-hidden="true">
        <Icon of={navIcon(row.icon)} />
      </span>
      <span className="ov-todo-type">{'status' in row.type ? <Status kind={row.type.status} /> : row.type.text}</span>
      <span className="ov-todo-main">
        <span className="ov-todo-title">{cjk(row.title)}</span>
        {row.context.length > 0 && (
          <span className="ov-todo-context">
            <Segments segments={row.context} />
          </span>
        )}
      </span>
      <span className="ov-todo-action">
        {row.action}
        <Icon of={external ? ArrowUpRight : ChevronRight} size={14} />
      </span>
    </>
  );
  const t = row.target;
  if (t.kind === 'workbench') {
    return (
      <a className="ov-todo" href={t.href} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }
  if (t.kind === 'sop') {
    return (
      <Link to="/sop" className="ov-todo">
        {body}
      </Link>
    );
  }
  // 条目详情（/catalog/$kind/$code）在第 10 步；在那之前「去上架」「逐条检查」都打开这个实体的列表
  return (
    <Link to="/catalog/$kind" params={{ kind: catalogKind(t.entity) }} className="ov-todo">
      {body}
    </Link>
  );
}

function TodoSkeleton() {
  return (
    <div className="state-skeleton" role="status" aria-label="正在载入">
      {[64, 48, 56].map((w, i) => (
        <div key={i} className="ov-todo ov-todo-skeleton">
          <span className="ov-todo-icon" />
          <span className="skeleton-bar" />
          <span className="ov-todo-main">
            <span className="skeleton-bar" style={{ width: `${w}%` }} />
            <span className="skeleton-bar" style={{ width: `${w - 16}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function TodoBlock({ pack, editor, now }: { pack: IndustryPack; editor: boolean; now: number }) {
  const waiting = useQuery({ ...waitingConversationsQuery, ...SHARED });
  const sop = useQuery({ ...sopQuery, enabled: editor });
  const overview = sop.data && 'spec' in sop.data ? sop.data : null;
  const draft = overview?.draft ?? null;
  const check = useQuery({ ...draftCheckQuery(draft?.id ?? '', draft?.rev ?? 0), enabled: editor && draft !== null });
  const { lists, loaded } = useEntityLists(pack, editor);
  const { loading, error, retry } = sourcesState([waiting, ...(editor ? [sop, ...(draft ? [check] : []), ...lists] : [])]);

  const rows = todoOrder(
    waitingTodos(waiting.data?.items ?? [], pack, now, workbenchHref),
    editor && overview ? sopTodo(overview, check.data, pack) : null,
    editor ? catalogTodos(loaded, now) : [],
  );
  return (
    <section className="ov-block" aria-labelledby="ov-todos">
      <BlockHead
        id="ov-todos"
        title="需要你处理"
        count={loading ? null : `${rows.length}项`}
        link={<ConversationsLink>全部会话</ConversationsLink>}
      />
      {loading ? (
        <TodoSkeleton />
      ) : (
        <>
          {error !== null && <StateView error={error} onRetry={retry} />}
          {rows.length > 0 ? (
            <ul className="ov-todos">
              {rows.map((row) => (
                <li key={row.key}>
                  <TodoLine row={row} />
                </li>
              ))}
            </ul>
          ) : (
            error === null && (
              <EmptyBlock
                title="没有要处理的事"
                description={
                  editor ? '有等人接手的会话、没发布的话术草稿或待上架的草稿时，会列在这里。' : '有等人接手的会话时，会列在这里。'
                }
              />
            )
          )}
        </>
      )}
    </section>
  );
}

// ---------------- ② 系统状态 ----------------

function SystemBlock({ pack }: { pack: IndustryPack }) {
  const q = useQuery(statusQuery);
  // 成员拿到完整的状态；匿名投影只有 mode（接口客户端推出的类型只剩匿名那一种，这里按键判断）
  const status = q.data && 'tenantSlug' in q.data ? (q.data as unknown as SystemStatus) : null;
  const view = status ? systemView(status, pack) : null;
  return (
    <section className="ov-block ov-system" aria-label="系统状态">
      {q.isError ? (
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      ) : !view ? (
        <div className="state-skeleton ov-system-line" role="status" aria-label="正在载入">
          <span className="skeleton-bar ov-system-skeleton" />
        </div>
      ) : view.ok ? (
        <p className="ov-system-line">
          <Icon of={CircleCheck} className="ov-system-ok" />
          <span className="ov-system-lead">{cjk(view.lead)}</span>
          <span className="ov-system-rest">
            {view.rest.map((s) => (
              <Fragment key={s}>
                <Sep />
                {cjk(s)}
              </Fragment>
            ))}
          </span>
        </p>
      ) : (
        <div className="ov-alerts">
          {view.alerts.map((a) => (
            <Alert
              key={a.text}
              type={a.tone === 'danger' ? 'error' : 'warning'}
              showIcon
              title={cjk(a.text)}
              description={a.tech ? <TechDetails rows={a.tech} /> : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- ③ 业务数 ----------------

function KpiTile({ kpi }: { kpi: Kpi }) {
  const flash = useChangeFlash(kpi.value);
  const body = (
    <>
      <span className="ov-kpi-label">{kpi.label}</span>
      <span key={flash} className={flash ? 'ov-kpi-value count-flash' : 'ov-kpi-value'}>
        {digits(kpi.value)}
      </span>
      <span className="ov-kpi-caption">{cjk(kpi.caption)}</span>
      {kpi.breakdown && <span className="ov-kpi-detail">{cjk(kpi.breakdown)}</span>}
      {/* 在售数为 0：明细是「新建{实体名}」（只给编辑者）。新建路由在第 10 步，在那之前和整格一样打开这个实体的列表 */}
      {kpi.create && <span className="ov-kpi-detail ov-kpi-create">{kpi.create.label}</span>}
      <Icon of={ArrowUpRight} size={14} className="ov-kpi-arrow" />
    </>
  );
  const t = kpi.target;
  if (t.kind === 'catalog') {
    return (
      <Link to="/catalog/$kind" params={{ kind: catalogKind(t.entity) }} className="ov-kpi">
        {body}
      </Link>
    );
  }
  return (
    <Link to="/conversations" search={t.state ? { state: t.state } : {}} className="ov-kpi">
      {body}
    </Link>
  );
}

function KpiSkeleton({ n }: { n: number }) {
  return (
    <div className="ov-kpis state-skeleton" role="status" aria-label="正在载入">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="ov-kpi ov-kpi-skeleton">
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

function KpiGrid({ kpis }: { kpis: readonly Kpi[] }) {
  return (
    <div className="ov-kpis">
      {kpis.map((k) => (
        <KpiTile key={k.key} kpi={k} />
      ))}
    </div>
  );
}

function MemberKpis({ pack, editor, now }: { pack: IndustryPack; editor: boolean; now: number }) {
  const counts = useQuery({ ...conversationCountsQuery, ...SHARED });
  const waiting = useQuery({ ...waitingConversationsQuery, ...SHARED });
  const paid = useQuery({ ...latestPaidQuery, ...POLL });
  const { lists, loaded } = useEntityLists(pack, true);
  const { loading, error, retry } = sourcesState([counts, waiting, paid, ...lists]);
  return (
    <section className="ov-block ov-kpi-block" aria-label="业务数">
      {error !== null ? (
        <StateView error={error} onRetry={retry} />
      ) : loading || !counts.data ? (
        <KpiSkeleton n={4} />
      ) : (
        <KpiGrid
          kpis={memberKpis({
            counts: counts.data,
            waiting: waiting.data?.items ?? [],
            latestPaid: (paid.data?.items[0] as ConversationRow | undefined) ?? null,
            catalog: catalogCounts(loaded),
            pack,
            editor,
            now,
          })}
        />
      )}
    </section>
  );
}

/** demo 匿名：只有在售数这一格（匿名投影只列已上架的条目） */
function AnonKpis({ pack }: { pack: IndustryPack }) {
  const { entities, lists } = useEntityLists(pack, true);
  const { loading, error, retry } = sourcesState(lists);
  const counts = entities.map((entity, i) => ({ entity, active: lists[i]?.data?.items.length ?? 0, drafts: 0 }));
  return (
    <section className="ov-block ov-kpi-block" aria-label="业务数">
      {error !== null ? (
        <StateView error={error} onRetry={retry} />
      ) : loading ? (
        <KpiSkeleton n={1} />
      ) : (
        <KpiGrid kpis={[inSaleKpi(counts, pack, { anon: true, editor: false })]} />
      )}
    </section>
  );
}

// ---------------- ④ 客户停在哪一步 ----------------

function StagesBlock({ pack }: { pack: IndustryPack }) {
  const counts = useQuery({ ...conversationCountsQuery, ...SHARED });
  const rows = counts.data ? stageRows(pack, counts.data.aiByStage) : [];
  return (
    <section className="ov-block ov-stages-block" aria-labelledby="ov-stages">
      <BlockHead
        id="ov-stages"
        title="客户停在哪一步"
        count={counts.data ? `AI接待中的${counts.data.byState.ai}个` : null}
        link={<ConversationsLink state="ai">会话</ConversationsLink>}
      />
      {counts.isError ? (
        <StateView error={counts.error} onRetry={() => void counts.refetch()} />
      ) : !counts.data ? (
        <div className="state-skeleton" role="status" aria-label="正在载入">
          {Array.from({ length: Math.max(1, pack.stages.filter((s) => !s.terminal).length) }, (_, i) => (
            <div key={i} className="ov-stage">
              <span className="skeleton-bar" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <ul className="ov-stages">
            {rows.map((r) => {
              const cls = ['ov-stage', r.branch && 'is-branch', r.count === 0 && 'is-zero'].filter(Boolean).join(' ');
              const body = (
                <>
                  <span className="ov-stage-label">{r.label}</span>
                  <span className="ov-stage-track">
                    {r.count > 0 && <span className="ov-stage-bar" style={{ width: `${r.ratio * 100}%` }} />}
                  </span>
                  <span className="ov-stage-count">{digits(r.count)}</span>
                </>
              );
              return (
                <li key={r.key ?? '$other'}>
                  {r.key === null ? (
                    <span className={cls}>{body}</span>
                  ) : (
                    <Link to="/conversations" search={{ state: 'ai', stage: r.key }} className={cls}>
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="ov-note">按每个会话现在所处的阶段统计</p>
        </>
      )}
    </section>
  );
}

// ---------------- ④ 最近变更 ----------------

function TimelineLine({ row }: { row: TimelineRow }) {
  const { name, human } = row.actor;
  return (
    <li className="ov-tl-row">
      <time className="ov-tl-time" dateTime={row.at} title={row.fullTime}>
        {row.time}
      </time>
      {human ? (
        <span className={`avatar avatar-${avatarIndex(name)}`} aria-hidden="true">
          {firstChar(name)}
        </span>
      ) : (
        <span className="ov-tl-bot" aria-hidden="true">
          <Icon of={SquareTerminal} />
        </span>
      )}
      <span className="ov-tl-text">
        <strong>{cjk(name)}</strong>{' '}
        {row.parts.map((p, i) => (p.strong ? <strong key={i}>{cjk(p.text)}</strong> : <Fragment key={i}>{cjk(p.text)}</Fragment>))}
        {row.tail && cjk(row.tail)}
      </span>
    </li>
  );
}

function RecentBlock({ pack, now }: { pack: IndustryPack; now: number }) {
  const q = useQuery(recentAuditQuery);
  // 对象名先取 diff 里的名字，再取产品库缓存（与侧栏共用），都没有时写编号
  const { loaded } = useEntityLists(pack, true);
  const itemName = (kind: string, code: string): string | undefined => {
    const list = loaded.find((l) => l.entity.kind === kind);
    const item = list?.items.find((i) => i.code === code);
    return list && item ? itemTitle(list.entity, item) : undefined;
  };
  const rows = q.data ? timeline(q.data, pack, { itemName }, now) : [];
  return (
    <section className="ov-block ov-recent" aria-labelledby="ov-recent">
      <BlockHead id="ov-recent" title="最近变更" />
      {q.isError ? (
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="state-skeleton" role="status" aria-label="正在载入">
          {[72, 48, 80, 56, 64].map((w, i) => (
            <div key={i} className="ov-tl-row">
              <span className="skeleton-bar" />
              <span className="skeleton-bar ov-tl-skeleton-avatar" />
              <span className="skeleton-bar" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="ov-note">还没有变更记录</p>
      ) : (
        <>
          <ol className="ov-timeline">
            {rows.map((r) => (
              <TimelineLine key={r.key} row={r} />
            ))}
          </ol>
          <Link to="/audit" className="ov-all">
            查看全部
          </Link>
        </>
      )}
    </section>
  );
}

// ---------------- 页面 ----------------

/** 相对时间（「26分钟前」）与「今天」按它算：打开时取一次，之后与外壳的轮询同一个节奏每 30 秒更新 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL.refetchInterval);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function OverviewPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  const now = useNow();
  // 外壳只在成员或 demo 匿名时渲染路由，两种都带着行业包
  if (!pack || (viewer?.kind !== 'member' && viewer?.kind !== 'anon')) return null;
  const date = dateWithWeekday(now, now);
  if (viewer.kind === 'anon') {
    return (
      <>
        <PageHeader title="总览" status={<span>{cjk(date)}</span>} />
        <AnonKpis pack={pack} />
      </>
    );
  }
  const editor = canEdit(viewer);
  return (
    <>
      {/* 状态句包成一段：页头的状态行是 flex，Sep 拆成单独的项会多出 8 的间隔 */}
      <PageHeader title="总览" status={<span>{cjk([viewer.me.tenantName, date])}</span>} />
      <TodoBlock pack={pack} editor={editor} now={now} />
      <SystemBlock pack={pack} />
      <MemberKpis pack={pack} editor={editor} now={now} />
      <div className={editor ? 'ov-bottom' : 'ov-bottom is-single'}>
        {editor && <RecentBlock pack={pack} now={now} />}
        <StagesBlock pack={pack} />
      </div>
    </>
  );
}
