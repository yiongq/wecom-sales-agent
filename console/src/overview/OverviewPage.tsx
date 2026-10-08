// 总览（spec「逐页设计 · 总览（A 页）」与 02 spec「后台页面 · 总览 A2」「可观测性与告警 · 运行数字」，
// 设计系统 §5.10、§5.11、§6.7、§10.2 A 页与「02 后端到位后 · A2」）：回答两个问题，现在要处理什么，业务怎么样。
// 从上到下：需要你处理（含 A2 的等人接手/已成交客户要人工/待付款 + 本月成交额）→ 运行数字 → 系统状态 → 业务数 →
// 最近变更 / 客户停在哪一步。
// - 只调现有接口和 spec 新增的只读接口；各块自己加载、自己出错，一块失败只有这一块写「没取到 · 重试」，其余照常。
//   会话计数、各实体列表与外壳（侧栏徽标、铃铛、条目数）共用同一份缓存，页面可见时一起每 30 秒刷新；等人接手取的是
//   最后动静最早的一页（与铃铛的首页不同），「需要你处理」与「等人接手」格共用它。
// - 谁看得到什么：等人接手、已成交客户要人工、待付款、系统状态、业务数、客户停在哪一步给成员；话术草稿、待上架、
//   最近变更、本月成交额、运行数字只给所有者、管理员（canEdit 同一条件，没有「最近变更」时右栏挪到左栏的位置，
//   宽度不变）；运行数字文件存储下整块不画（503 store_file_mode）；demo 匿名只有页头下的横幅和「在售」一格。
// - 「接手」按钮只给能处理会话的角色画（CAN_HANDLE_ROLES，与 J 页同一套）；viewer 看得到行但没有按钮。
// - 界面不认行业：实体、阶段、话术节、叫法都取自行业包（model.ts）。
import { type UseQueryResult, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Alert, Button } from 'antd';
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, Clock, SquareTerminal, X } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { CatalogItem, ConversationRow, Status as SystemStatus } from '../../../src/shared/console-api.js';
import { shortIdOf } from '../../../src/shared/conversation.js';
import { dateWithWeekday, digits } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, HttpError, unwrap } from '../api.js';
import { CAN_HANDLE_ROLES } from '../conversations/workbench.js';
import { errorLine } from '../parts/ErrorAlert.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { catalogListQuery, conversationCountsQuery, paidNeedsHumanQuery } from '../queries.js';
import { useChangeFlash } from '../shell/hooks.js';
import { Icon, navIcon } from '../shell/icons.js';
import { avatarIndex, firstChar, packEntities, POLL } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import {
  attentionTodos,
  catalogCounts,
  catalogTodos,
  type EntityList,
  inSaleKpi,
  itemTitle,
  type Kpi,
  memberKpis,
  metricsKpis,
  monthlyRevenueKpi,
  type Segment,
  type StaticKpi,
  sopTodo,
  stageRows,
  systemView,
  timeline,
  type TimelineRow,
  todoCount,
  todoOrder,
  type TodoRow,
} from './model.js';
import {
  draftCheckQuery,
  latestPaidQuery,
  metricsQuery,
  oldestWaitingQuery,
  ordersSummaryQuery,
  pendingOrdersQuery,
  recentAuditQuery,
  sopQuery,
  statusQuery,
} from './queries.js';

type AnyQuery = Pick<UseQueryResult<unknown>, 'isPending' | 'isError' | 'error' | 'refetch'>;

/**
 * 与外壳共用的查询（会话计数、各实体列表）：外壳启动时刚取过，总览的块晚一步挂上，默认的 staleTime 0 会让它们
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

/**
 * 上下文或明细的几段，用 Sep 隔开；tone 为 danger/warning 的那段用对应的字色，前面加图标（默认 circle-alert，
 * A2 的等待时长用 clock——设计系统 A2：「都带钟表图标」）
 */
function Segments({ segments }: { segments: readonly Segment[] }) {
  return segments.map((s, i) => (
    <Fragment key={i}>
      {i > 0 && <Sep />}
      {s.tone ? (
        <span className={s.tone === 'danger' ? 'ov-danger' : 'ov-warning'}>
          <Icon of={s.icon === 'clock' ? Clock : CircleAlert} size={14} />
          {cjk(s.text)}
        </span>
      ) : (
        cjk(s.text)
      )}
    </Fragment>
  ));
}

// ---------------- ① 需要你处理 ----------------

/** 待办行共用的内容（图标、类型、标题与上下文）；操作一侧由调用方给（链接行用幽灵箭头，接手行是真的按钮） */
function TodoBody({ row, action }: { row: TodoRow; action: ReactNode }) {
  return (
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
      {action}
    </>
  );
}

/** 幽灵小按钮的操作（§5.1）：站内跳转用 chevron-right，没有「新标签打开」的情况了（原来的 admin.html 入口已经改走路由） */
const GhostAction = ({ text }: { text: string }) => (
  <span className="ov-todo-action">
    {text}
    <Icon of={ChevronRight} size={14} />
  </span>
);

/**
 * 整行是链接的待办：话术草稿、待上架、待付款（「打开会话」）、等人接手列不全时的「还有N个」。target 不是 takeover——
 * 那一种由 TakeoverTodoLine 处理，TodoRowView 已经分好
 */
function TodoLine({ row }: { row: TodoRow }) {
  const body = <TodoBody row={row} action={<GhostAction text={row.action} />} />;
  const t = row.target;
  if (t.kind === 'takeover') return null;
  if (t.kind === 'sop') {
    return (
      <Link to="/sop" className="ov-todo">
        {body}
      </Link>
    );
  }
  if (t.kind === 'conversations') {
    return (
      <Link to="/conversations" search={{ state: t.state }} className="ov-todo">
        {body}
      </Link>
    );
  }
  if (t.kind === 'open') {
    return (
      <Link to="/conversations/$id" params={{ id: t.id }} className="ov-todo">
        {body}
      </Link>
    );
  }
  // 待上架：1 条草稿「去上架」到这一条的详情；多条「逐条检查」到这个实体列表的草稿页签
  if (t.code !== undefined) {
    return (
      <Link to="/catalog/$kind/$code" params={{ kind: catalogKind(t.entity), code: t.code }} className="ov-todo">
        {body}
      </Link>
    );
  }
  return (
    <Link to="/catalog/$kind" params={{ kind: catalogKind(t.entity) }} search={{ status: 'draft' }} className="ov-todo">
      {body}
    </Link>
  );
}

/** 服务端错误就地显示（WorkbenchPage.tsx 同名私有组件的同一份写法：标题 · 下一步，没有对应回调时只写标题） */
function InlineError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const { text } = errorLine(error, {});
  return <p className="ov-todo-error">{text}</p>;
}

/**
 * 等人接手、已成交客户要人工：次要小按钮「接手」（设计系统 A2），不是整行链接——点击真的调用接手接口，
 * 成功后才打开 J 页；409（如 assigned_to_other）就地说明，不丢弹窗（brief「范围」：接手 409 时就地说明）。
 * 只给能处理会话的角色画按钮（CAN_HANDLE_ROLES 同一套权限，J 页也是这样判断要不要画「接手会话」）；
 * viewer 看得到这一行，但没有按钮——403 真发生不了，不用等服务端拒绝才知道。
 * 接手的请求与它的错误状态提到 TodoBlock 一级（见那边的注释）：两个成员停在同一行时，A 接手成功、B 这边的事件流
 * 几十毫秒内就会让列表重取、这一行从 DOM 里卸载，B 随后收到的 409 不能跟着这一行一起消失（审查 major）
 */
function TakeoverTodoLine({
  row,
  canHandle,
  pending,
  error,
  onTakeover,
}: {
  row: TodoRow;
  canHandle: boolean;
  pending: boolean;
  error: unknown;
  onTakeover(id: string): void;
}) {
  if (row.target.kind !== 'takeover') return null;
  const id = row.target.id;
  return (
    <>
      <div className="ov-todo ov-todo-static">
        <TodoBody
          row={row}
          action={
            canHandle ? (
              <span className="ov-todo-action-btn">
                <Button size="small" onClick={() => onTakeover(id)} loading={pending}>
                  {row.action}
                </Button>
              </span>
            ) : null
          }
        />
      </div>
      <InlineError error={error} />
    </>
  );
}

/** 一行待办：接手行用 TakeoverTodoLine（真按钮，状态从 TodoBlock 传下来），其余整行是链接 */
function TodoRowView({
  row,
  canHandle,
  pendingId,
  takeoverErrors,
  onTakeover,
}: {
  row: TodoRow;
  canHandle: boolean;
  pendingId: string | null;
  takeoverErrors: Readonly<Record<string, unknown>>;
  onTakeover(id: string): void;
}) {
  if (row.target.kind === 'takeover') {
    const id = row.target.id;
    return (
      <TakeoverTodoLine
        row={row}
        canHandle={canHandle}
        pending={pendingId === id}
        error={Object.hasOwn(takeoverErrors, id) ? takeoverErrors[id] : null}
        onTakeover={onTakeover}
      />
    );
  }
  return <TodoLine row={row} />;
}

/** 接手的就地说明过了这么久自动清掉（没清掉之前点「关掉」也能清，见 TakeoverErrorBanner） */
const TAKEOVER_ERROR_TTL_MS = 6000;

/**
 * 接手请求结束时这一行已经不在列表里了：说明跟着行一起消失就没地方看了，挪到「需要你处理」区块顶部，写上会话短码
 * 分辨是哪一条（审查 major：行可能已经被别的成员接手走、从列表里刷掉）。几秒后自动清掉，也能手动关掉
 */
function TakeoverErrorBanner({ id, error, onDismiss }: { id: string; error: unknown; onDismiss(): void }) {
  const { text } = errorLine(error, {});
  return (
    <p className="ov-todos-banner-item" role="alert">
      {cjk(`${shortIdOf(id)}：${text}`)}
      <button type="button" className="ov-todos-banner-close" onClick={onDismiss} aria-label="关掉这条说明">
        <Icon of={X} size={14} />
      </button>
    </p>
  );
}

/** 待办的骨架：行数知道了就画这么多行（每行与真实的行一样高，窄屏也是），不知道时画 3 行 */
function TodoSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="state-skeleton" role="status" aria-label="正在载入">
      {Array.from({ length: rows }, (_, i) => [64, 48, 56][i % 3]!).map((w, i) => (
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

/** 待办迟迟不落定时，下面的块最多等这么久就显示（见 OverviewPage） */
export const TODO_WAIT_MS = 1000;

function TodoBlock({
  pack,
  editor,
  canHandle,
  now,
  onSettled,
}: {
  pack: IndustryPack;
  editor: boolean;
  canHandle: boolean;
  now: number;
  onSettled(): void;
}) {
  const navigate = useNavigate();
  // 接手的请求与错误状态提到这一级（不是每行自己的 useMutation）：行可能在请求结束之前就被事件流触发的重取刷掉
  // （另一个成员先接手成功），这时错误要挪到区块顶部显示，不能跟着卸载的行一起消失（见上面 TakeoverErrorBanner 的注释）
  const [takeoverErrors, setTakeoverErrors] = useState<Record<string, unknown>>({});
  const clearTakeoverError = useCallback((id: string) => {
    setTakeoverErrors((m) => {
      if (!Object.hasOwn(m, id)) return m;
      const next = { ...m };
      delete next[id];
      return next;
    });
  }, []);
  const takeover = useMutation({
    mutationFn: (id: string) => unwrap(api.conversations[':id'].takeover.$post({ param: { id }, json: {} })),
    onSuccess: (_data, id) => {
      clearTakeoverError(id);
      void navigate({ to: '/conversations/$id', params: { id } });
    },
    onError: (error, id) => {
      setTakeoverErrors((m) => ({ ...m, [id]: error }));
      setTimeout(() => clearTakeoverError(id), TAKEOVER_ERROR_TTL_MS);
    },
  });
  const onTakeover = useCallback((id: string) => takeover.mutate(id), [takeover]);
  const pendingId = takeover.isPending ? takeover.variables : null;

  const waiting = useQuery({ ...oldestWaitingQuery, ...POLL });
  const paidNeedsHuman = useQuery({ ...paidNeedsHumanQuery, ...POLL });
  const pendingOrders = useQuery({ ...pendingOrdersQuery, ...POLL });
  const sop = useQuery({ ...sopQuery, enabled: editor });
  const overview = sop.data && 'spec' in sop.data ? sop.data : null;
  const draft = overview?.draft ?? null;
  const check = useQuery({ ...draftCheckQuery(draft?.id ?? '', draft?.rev ?? 0), enabled: editor && draft !== null });
  const { lists, loaded } = useEntityLists(pack, editor);
  // 有几行在等人接手、已成交客户要人工、待付款、话术、各实体列表回来以后就定了；发布前检查要等话术回来才发，
  // 它只往话术那一行里补字，不加行
  const base = [waiting, paidNeedsHuman, pendingOrders];
  const counted = sourcesState([...base, ...(editor ? [sop, ...lists] : [])]);
  const { loading, error, retry } = sourcesState([...base, ...(editor ? [sop, ...(draft ? [check] : []), ...lists] : [])]);
  const known = !counted.loading && counted.error === null;
  // 行数定了（或整块落定、出错）在画出来之前告诉页面，下面的块这一帧出现；还在等检查的话，骨架按真实的行数画，检查回来不挪位
  useLayoutEffect(() => {
    if (known || !loading) onSettled();
  }, [known, loading, onSettled]);

  const rows = todoOrder(
    attentionTodos(
      waiting.data?.items ?? [],
      paidNeedsHuman.data?.items ?? [],
      pendingOrders.data?.items ?? [],
      pendingOrders.data?.paymentMode ?? 'online',
      pack,
      now,
      waiting.data?.total,
    ),
    editor && overview ? sopTodo(overview, check.data, pack) : null,
    editor ? catalogTodos(loaded, now) : [],
  );
  // 还在列表里的接手行 id：不在其中的错误（行已经被重取刷掉）挪到区块顶部显示，见 TakeoverErrorBanner
  const presentTakeoverIds = new Set(rows.flatMap((r) => (r.target.kind === 'takeover' ? [r.target.id] : [])));
  const orphanedErrors = Object.entries(takeoverErrors).filter(([id]) => !presentTakeoverIds.has(id));
  return (
    <section className="ov-block" aria-labelledby="ov-todos">
      <div className="ov-todos-row">
        <div className="ov-todos-col">
          <BlockHead
            id="ov-todos"
            title="需要你处理"
            count={loading ? null : `${todoCount(rows)}项`}
            link={<ConversationsLink>全部会话</ConversationsLink>}
          />
          {orphanedErrors.length > 0 && (
            <div className="ov-todos-banner">
              {orphanedErrors.map(([id, err]) => (
                <TakeoverErrorBanner key={id} id={id} error={err} onDismiss={() => clearTakeoverError(id)} />
              ))}
            </div>
          )}
          {loading ? (
            <TodoSkeleton rows={known ? Math.max(rows.length, 1) : undefined} />
          ) : (
            <>
              {error !== null && <StateView error={error} onRetry={retry} />}
              {rows.length > 0 ? (
                <ul className="ov-todos">
                  {rows.map((row) => (
                    <li key={row.key}>
                      <TodoRowView
                        row={row}
                        canHandle={canHandle}
                        pendingId={pendingId}
                        takeoverErrors={takeoverErrors}
                        onTakeover={onTakeover}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                error === null && (
                  <EmptyBlock
                    title="没有要处理的事"
                    description={
                      editor
                        ? '有等人接手的会话、已成交客户要人工、待付款的订单、没发布的话术草稿或待上架的草稿时，会列在这里。'
                        : '有等人接手的会话、已成交客户要人工或待付款的订单时，会列在这里。'
                    }
                  />
                )
              )}
            </>
          )}
        </div>
        {editor && <MonthlyRevenueTile />}
      </div>
    </section>
  );
}

/** 「本月成交额（元）」KPI 格（02 spec「总览 A2」）：只给所有者、管理员，自己的加载/出错状态，不挡「需要你处理」落定 */
function MonthlyRevenueTile() {
  const q = useQuery({ ...ordersSummaryQuery, ...POLL });
  return (
    <div className="ov-todos-kpi">
      {q.isError ? (
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="ov-kpi ov-kpi-skeleton state-skeleton" role="status" aria-label="正在载入">
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
        </div>
      ) : (
        <StaticKpiTile kpi={monthlyRevenueKpi(q.data)} />
      )}
    </div>
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
      {/* 在售数为 0：明细是「新建{实体名}」（只给编辑者），整格链到新建。链接里不能再套链接，所以它是格里的一行字 */}
      {kpi.create && <span className="ov-kpi-detail ov-kpi-create">{kpi.create.label}</span>}
      <Icon of={ArrowUpRight} size={14} className="ov-kpi-arrow" />
    </>
  );
  const t = kpi.target;
  if (kpi.create) {
    return (
      <Link to="/catalog/new/$kind" params={{ kind: catalogKind(kpi.create.entity) }} className="ov-kpi">
        {body}
      </Link>
    );
  }
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

/**
 * 不点了去哪里的 KPI 格（02 spec：A2「本月成交额」与「可观测性与告警 · 运行数字」都没给「点了去」）：同一套视觉
 * （§5.10），少了链接的悬停箭头。没有数据的格写「—」（StaticKpi.value 已经是格式化好的字符串）
 */
function StaticKpiTile({ kpi }: { kpi: StaticKpi }) {
  return (
    <div className="ov-kpi ov-kpi-static">
      <span className="ov-kpi-label">{kpi.label}</span>
      <span className="ov-kpi-value">{kpi.value}</span>
      <span className="ov-kpi-caption">{cjk(kpi.caption)}</span>
      {kpi.breakdown && <span className="ov-kpi-detail">{cjk(kpi.breakdown)}</span>}
    </div>
  );
}

/**
 * 运行数字四格（02 spec「可观测性与告警 · 运行数字」）：只给所有者、管理员（editor，与 canSeeMoney 同一条件），
 * 文件存储下 /metrics 回 503 store_file_mode，这时整块不画（不是写「没取到」）；其余出错就地重试；加载用格子骨架；
 * 403（坐席等）本来就不该发这个请求，enabled 已经按 editor 挡住
 */
function MetricsBlock({ editor }: { editor: boolean }) {
  const q = useQuery({ ...metricsQuery, ...SHARED, enabled: editor });
  if (!editor) return null;
  const fileMode = q.error instanceof HttpError && q.error.body.error === 'store_file_mode';
  if (fileMode) return null;
  return (
    <section className="ov-block ov-kpi-block ov-metrics-block" aria-label="运行数字">
      {q.isError ? (
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <KpiSkeleton n={4} />
      ) : (
        <div className="ov-kpis">
          {metricsKpis(q.data).map((k) => (
            <StaticKpiTile key={k.key} kpi={k} />
          ))}
        </div>
      )}
    </section>
  );
}

function MemberKpis({ pack, editor, now }: { pack: IndustryPack; editor: boolean; now: number }) {
  const counts = useQuery({ ...conversationCountsQuery, ...SHARED });
  const waiting = useQuery({ ...oldestWaitingQuery, ...POLL });
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
  // 首次加载：「需要你处理」的行数定下来之前，下面各块照常挂上、各自取数（骨架、出错与重试都不变），只是先不显示。待办有几行
  // 要等数据回来才知道（窄屏一行折成两行），先显示下面的块的话，待办一到就把它们整块推下去，375 宽的 CLS 约 0.11（验收 23）。
  // 行数定了就显示（之后不再收起），这时还在等的发布前检查由按行数画的骨架占位；过了 TODO_WAIT_MS 还没定也显示，一块慢不拖住别的块
  const [below, setBelow] = useState(false);
  const showBelow = useCallback(() => setBelow(true), []);
  useEffect(() => {
    const t = setTimeout(showBelow, TODO_WAIT_MS);
    return () => clearTimeout(t);
  }, [showBelow]);
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
  const canHandle = CAN_HANDLE_ROLES.has(viewer.me.role);
  return (
    <>
      {/* 状态句包成一段：页头的状态行是 flex，Sep 拆成单独的项会多出 8 的间隔 */}
      <PageHeader title="总览" status={<span>{cjk([viewer.me.tenantName, date])}</span>} />
      <TodoBlock pack={pack} editor={editor} canHandle={canHandle} now={now} onSettled={showBelow} />
      <MetricsBlock editor={editor} />
      <div className={below ? 'ov-below' : 'ov-below is-waiting'}>
        <SystemBlock pack={pack} />
        <MemberKpis pack={pack} editor={editor} now={now} />
        <div className={editor ? 'ov-bottom' : 'ov-bottom is-single'}>
          {editor && <RecentBlock pack={pack} now={now} />}
          <StagesBlock pack={pack} />
        </div>
      </div>
    </>
  );
}
