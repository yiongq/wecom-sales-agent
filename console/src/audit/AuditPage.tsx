// 审计日志（spec「逐页设计 · 审计日志（K 页）」，设计系统 §5.4、§5.13、§6.5、§6.8、§10.2 K 页）。
// 从上到下：页头 → 筛选（分段控件选类别、开关「显示登录记录」，都写在地址里）→ 按天分组的时间线（连续的同类记录合成一句，
// 「展开N条」逐条列出）→「加载更早的记录」（按 before 翻页，不做滚到底自动加载）。点一句打开右侧 480 宽的详情抽屉。
// 类别与开关换算成 AuditQuery.actions，由服务端过滤，翻页不出空页；句子由 describeAudit 生成，界面不认行业（model.ts）。
// 只有所有者、管理员看得到（01）：别的角色和匿名直接打开这个地址时不发请求，只写一句说明。这一页没有失败类事件，不出现红色
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Alert, Button, Drawer, Segmented, Switch } from 'antd';
import { ChevronDown, ChevronRight, History, SquareTerminal, X } from 'lucide-react';
import { Fragment, type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import type { AuditLookups, AuditPart } from '../../../src/shared/audit-text.js';
import type { AuditEntryView } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, unwrap } from '../api.js';
import type { AuditSearch } from '../audit-search.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { TechDetails } from '../parts/TechDetails.js';
import { catalogListQuery } from '../queries.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { avatarIndex, firstChar, packEntities, POLL } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import {
  actionsOf,
  activeGroup,
  AUDIT_PAGE,
  type Cell,
  type DrawerView,
  drawerView,
  expandLabel,
  FIRST_CURSOR,
  groupOptions,
  groupSearch,
  lineOf,
  loadAuditChunk,
  loginSearch,
  showLogin,
  type TimelineLine,
  timelineGroups,
  valueAtPath,
} from './model.js';

/** 与外壳共用的产品库列表（对象名的缓存）：30 秒内的直接用 */
const SHARED_STALE = POLL.refetchInterval;

/** 「今天」「昨天」和悬停的绝对时间按它算：打开时取一次，之后每 30 秒更新 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL.refetchInterval);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** 对象名先取 diff 里的名字，再取产品库缓存（与侧栏、⌘K 共用），都没有时写编号 */
function useLookups(pack: IndustryPack): AuditLookups {
  const entities = packEntities(pack);
  const lists = useQueries({
    queries: entities.map((e) => ({ ...catalogListQuery(catalogKind(e.kind)), staleTime: SHARED_STALE })),
  });
  const names = new Map<string, string>();
  entities.forEach((e, i) => {
    for (const item of lists[i]?.data?.items ?? []) {
      const v = valueAtPath(item.payload, e.titleKey);
      if (typeof v === 'string' && v.trim()) names.set(`${e.kind}\0${item.code}`, v);
    }
  });
  return { itemName: (kind: string, code: string) => names.get(`${kind}\0${code}`) };
}

function Header() {
  return <PageHeader title="审计日志" status={<span>谁在什么时候改了什么</span>} />;
}

// ---------------- 筛选 ----------------

function Filters({ pack, search }: { pack: IndustryPack; search: AuditSearch }) {
  const navigate = useNavigate();
  return (
    <div className="au-filters">
      <div className="au-seg-scroll">
        <Segmented
          aria-label="按类别筛选"
          options={groupOptions(pack).map((g) => ({ value: g.key, label: g.label }))}
          value={activeGroup(search)}
          onChange={(key) => void navigate({ to: '/audit', search: groupSearch(key, search) })}
        />
      </div>
      {/* 点文字也能开关：Switch 是 button，放在 label 里就由 label 的文字命名 */}
      <label className="au-login">
        <Switch checked={showLogin(search)} onChange={(on) => void navigate({ to: '/audit', search: loginSearch(on, search) })} />
        显示登录记录
      </label>
    </div>
  );
}

// ---------------- 时间线 ----------------

function Sentence({ actor, parts, tail }: { actor?: string; parts: readonly AuditPart[]; tail?: string | null }) {
  return (
    <>
      {actor !== undefined && (
        <>
          <strong>{cjk(actor)}</strong>{' '}
        </>
      )}
      {parts.map((p, i) => (p.strong ? <strong key={i}>{cjk(p.text)}</strong> : <Fragment key={i}>{cjk(p.text)}</Fragment>))}
      {tail && cjk(tail)}
    </>
  );
}

/** 头像（设计系统 §6.8）：审计里 28；命令行这类非人操作者用方块图标，和真人一眼区分开 */
function Avatar({ actor }: { actor: { name: string; human: boolean } }) {
  return actor.human ? (
    <span className={`avatar au-avatar avatar-${avatarIndex(actor.name)}`} aria-hidden="true">
      {firstChar(actor.name)}
    </span>
  ) : (
    <span className="au-bot" aria-hidden="true">
      <Icon of={SquareTerminal} />
    </span>
  );
}

/** 点在行上（不在按钮上、也不是在选字）：同点句子 */
function rowClick(e: MouseEvent<HTMLElement>, act: (trigger: HTMLElement | null) => void): void {
  if (e.target instanceof Element && e.target.closest('button, a')) return;
  if ((window.getSelection?.()?.toString() ?? '') !== '') return;
  act(e.currentTarget.querySelector<HTMLElement>('.au-sentence'));
}

interface LineProps {
  line: TimelineLine;
  pack: IndustryPack;
  lookups: AuditLookups;
  now: number;
  /** 抽屉里正打开的那一条 */
  selected: number | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (entry: AuditEntryView, trigger: HTMLElement | null) => void;
}

function Line({ line, pack, lookups, now, selected, expanded, onToggle, onOpen }: LineProps) {
  const merged = line.count > 1;
  const first = line.entries[0]!;
  const isSelected = !merged && selected === line.key;
  const listId = `au-run-${line.key}`;
  return (
    <li
      className={['au-row', isSelected && 'is-selected', merged && 'is-merged'].filter(Boolean).join(' ')}
      aria-current={isSelected ? 'true' : undefined}
      onClick={(e) => rowClick(e, (t) => (merged ? onToggle() : onOpen(first, t)))}
    >
      <Avatar actor={line.actor} />
      <div className="au-body">
        {merged ? (
          <p className="au-sentence">
            <Sentence actor={line.actor.name} parts={line.parts} />
          </p>
        ) : (
          <button type="button" className="au-sentence" aria-haspopup="dialog" onClick={(e) => onOpen(first, e.currentTarget)}>
            <Sentence actor={line.actor.name} parts={line.parts} />
          </button>
        )}
        {line.summary && (
          <p className="au-summary">
            <span className="au-summary-text">{cjk(line.summary.text)}</span>
            {line.summary.code && <span className="au-code">{line.summary.code}</span>}
            {merged && (
              <>
                <Sep />
                <button type="button" className="au-expand" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
                  {expandLabel(line, expanded)}
                  <Icon of={ChevronDown} size={14} className={expanded ? 'au-expand-icon is-open' : 'au-expand-icon'} />
                </button>
              </>
            )}
          </p>
        )}
      </div>
      <time className="au-time" dateTime={line.at} title={line.timeTitle}>
        {line.time}
      </time>
      {merged && expanded && (
        <ul className="au-children" id={listId}>
          {line.entries.map((e) => {
            const child = lineOf([e], pack, lookups, now);
            const on = selected === e.id;
            return (
              <li
                key={e.id}
                className={on ? 'au-child is-selected' : 'au-child'}
                aria-current={on ? 'true' : undefined}
                onClick={(ev) => {
                  // 不再冒泡到外面那一句（点那一句是收起）
                  ev.stopPropagation();
                  rowClick(ev, (t) => onOpen(e, t));
                }}
              >
                <button type="button" className="au-sentence" aria-haspopup="dialog" onClick={(ev) => onOpen(e, ev.currentTarget)}>
                  <Sentence parts={child.parts} />
                </button>
                <time className="au-time" dateTime={child.at} title={child.timeTitle}>
                  {child.time}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** 骨架：一个组标题加 6 行（头像、两行字、时刻），与成品同尺寸 */
function TimelineSkeleton() {
  return (
    <div className="au-timeline">
      <div className="au-day">
        <div className="au-day-title">
          <span className="skeleton-bar" style={{ width: 120, height: 13 }} />
        </div>
        <ul className="au-list">
          {[64, 48, 72, 56, 60, 44].map((w, i) => (
            <li key={i} className="au-row">
              <span className="skeleton-bar au-avatar-skeleton" />
              <div className="au-body">
                <div className="au-skeleton-line">
                  <span className="skeleton-bar" style={{ width: `${w}%` }} />
                </div>
                <div className="au-skeleton-line is-summary">
                  <span className="skeleton-bar" style={{ width: `${w / 2}%` }} />
                </div>
              </div>
              <span className="skeleton-bar au-time-skeleton" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------- 详情抽屉 ----------------

function CellView({ cell }: { cell: Cell }) {
  if ('text' in cell) return <>{cjk(cell.text)}</>;
  return (
    <>
      {cell.segs.map((s, i) =>
        s.mark === 'del' ? (
          <del key={i}>{s.text}</del>
        ) : s.mark === 'ins' ? (
          <ins key={i}>{s.text}</ins>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

function DrawerBody({ view }: { view: DrawerView }) {
  const changes = view.changes;
  return (
    <div className="au-detail">
      <p className="au-detail-sentence">
        <Sentence actor={view.actor.name} parts={view.parts} tail={view.tail} />
      </p>
      <dl className="au-facts">
        {view.facts.map((f) => (
          <Fragment key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              {cjk(f.text)}
              {f.code && (
                <>
                  <Sep />
                  <span className="au-code">{f.code}</span>
                </>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
      {view.warning && <Alert type="warning" showIcon title={cjk(view.warning.title)} description={cjk(view.warning.text)} />}
      {changes && (
        <section className="au-changes" aria-labelledby="au-changes-title">
          <h3 id="au-changes-title" className="au-changes-title">
            {changes.title}
          </h3>
          <table className="au-table" aria-labelledby="au-changes-title">
            <thead>
              <tr>
                <th scope="col">字段</th>
                {!changes.created && <th scope="col">原来</th>}
                <th scope="col">{changes.created ? '内容' : '现在'}</th>
              </tr>
            </thead>
            <tbody>
              {changes.rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{cjk(r.label)}</th>
                  {!changes.created && (
                    <td>
                      <CellView cell={r.before} />
                    </td>
                  )}
                  <td>
                    <CellView cell={r.after} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {changes.notes.length > 0 && <p className="au-notes">{cjk(changes.notes)}</p>}
        </section>
      )}
      {view.link && (
        <Link
          className="au-link"
          {...(view.link.to === 'catalog' ? { to: '/catalog/$kind', params: { kind: catalogKind(view.link.kind) } } : { to: '/sop' })}
        >
          {view.link.label}
          <Icon of={ChevronRight} size={14} />
        </Link>
      )}
      <div className="au-tech">
        <TechDetails rows={view.tech.rows} json={view.tech.json} copy={view.tech.copy} />
      </div>
    </div>
  );
}

// ---------------- 页面 ----------------

function MemberAudit({ pack }: { pack: IndustryPack }) {
  const search = useSearch({ from: '/audit' });
  const now = useNow();
  const lookups = useLookups(pack);
  const actions = actionsOf(search);
  const q = useInfiniteQuery({
    queryKey: ['audit', 'log', actions ?? '*'] as const,
    initialPageParam: FIRST_CURSOR,
    queryFn: ({ pageParam }) =>
      loadAuditChunk(
        (before) =>
          unwrap(
            api.audit.$get({
              query: {
                limit: String(AUDIT_PAGE),
                ...(actions === undefined ? {} : { actions }),
                ...(before === undefined ? {} : { before: String(before) }),
              },
            }),
          ),
        pageParam,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = timelineGroups(entries, pack, lookups, now);

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (key: number): void =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // 抽屉：关上之后内容留到收起动画结束，焦点回到点开它的那一句（设计系统 §5.13）
  const [shown, setShown] = useState<{ entry: AuditEntryView; trigger: HTMLElement | null } | null>(null);
  const [open, setOpen] = useState(false);
  const view = shown ? drawerView(shown.entry, pack, lookups) : null;
  const openEntry = (entry: AuditEntryView, trigger: HTMLElement | null): void => {
    setShown({ entry, trigger });
    setOpen(true);
  };
  const afterOpenChange = (isOpen: boolean): void => {
    if (isOpen) return;
    if (shown?.trigger?.isConnected) shown.trigger.focus();
    setShown(null);
  };

  const filtered = search.cat !== undefined;
  let body: ReactNode;
  // 取「更早的记录」失败时查询也是出错状态，但已经列出的记录还在：只有一页都没取到时才整块换成出错
  if (!q.data) {
    body = <StateView pending={!q.isError} error={q.error} onRetry={() => void q.refetch()} skeleton={<TimelineSkeleton />} />;
  } else if (entries.length === 0) {
    body = filtered ? (
      <EmptyBlock
        title="这个类别下没有记录"
        link={
          <Link to="/audit" search={loginSearch(showLogin(search), {})}>
            看全部
          </Link>
        }
      />
    ) : (
      <EmptyBlock
        icon={<Icon of={History} size={20} />}
        title="改动会记在这里"
        description={`发布话术、修改${pack.vocabulary.productNoun}、建账号这些操作，每次都会记一笔`}
      />
    );
  } else {
    body = (
      <div className="au-timeline">
        {groups.map((g) => (
          <section key={g.key} className="au-day" aria-labelledby={`au-day-${g.key}`}>
            <h2 id={`au-day-${g.key}`} className="au-day-title">
              {cjk(g.heading)}
            </h2>
            <ul className="au-list">
              {g.lines.map((line) => (
                <Line
                  key={line.key}
                  line={line}
                  pack={pack}
                  lookups={lookups}
                  now={now}
                  selected={open && shown ? shown.entry.id : null}
                  expanded={expanded.has(line.key)}
                  onToggle={() => toggle(line.key)}
                  onOpen={openEntry}
                />
              ))}
            </ul>
          </section>
        ))}
        {/* 翻页失败只在底部就地显示，已列出的记录保留 */}
        {q.isFetchNextPageError && <ErrorAlert error={q.error} onRetry={() => void q.fetchNextPage()} />}
        {q.hasNextPage ? (
          <Button className="au-more" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            加载更早的记录
          </Button>
        ) : (
          <p className="au-end">没有更早的记录了</p>
        )}
      </div>
    );
  }

  return (
    <>
      <Header />
      <Filters pack={pack} search={search} />
      {body}
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        afterOpenChange={afterOpenChange}
        size={480}
        closable={false}
        title="改动详情"
        extra={<IconButton icon={X} label="关闭" placement="bottomRight" onClick={() => setOpen(false)} />}
        rootClassName="au-drawer"
      >
        {view && <DrawerBody view={view} />}
      </Drawer>
    </>
  );
}

export function AuditPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  // 外壳只在成员或 demo 匿名时渲染路由，两种都带着行业包
  if (!pack) return null;
  if (canEdit(viewer)) return <MemberAudit pack={pack} />;
  const member = viewer?.kind === 'member';
  return (
    <>
      <Header />
      <EmptyBlock
        level={2}
        icon={<Icon of={History} size={20} />}
        title={member ? '你的角色看不到审计日志' : '登录后才能看审计日志'}
        description="审计日志只给所有者、管理员看"
      />
    </>
  );
}
