// 话术页的版本记录（spec「销售话术 · 版本记录」「查看改动」「丢弃草稿」，设计系统 §5.13 S 420 与 C 页）：
// - SopActions：页头右侧的「更多」（里面是「丢弃草稿」，菜单项不加 danger）与次要按钮「版本记录」（前置 history）。
//   只读成员只有「版本记录」，匿名都没有。memo：话术页每敲一个字整页重渲，打开过的下拉与 Tooltip 不跟着重渲（第 5.1 步 #185）。
// - HistoryDrawer：右侧 420 的抽屉，地址上是 view=history。最新的在上：草稿一行「未发布 · 改了2节」和「继续编辑」；
//   每个版本先写变更说明，再写「作者 · 时间 · 改了N节（节名）」，线上版本带「线上」状态；操作「查看改动」「回滚到这版…」
//   「载入到草稿再改」（文字按钮，用 Sep 隔开；线上版本只有查看改动，最早的版本没有可比的、不给查看改动；只读成员只有查看改动）；
//   每行最后是折叠的技术详情（四个哈希的前 12 位）。底部「更早的版本」按 before 翻页，到头写「没有更早的版本了」。
//   打开时抽屉体是 3 行骨架；取失败时抽屉体里放「没取到 · 重试」；翻页失败只在底部按钮的位置写「没取到 · 重试」，已列出的保留。
// - VersionView：「查看改动」以后主区换成只读对比「v2相对v1改了什么」（只列变化的节，固定规则节也列），地址上是 v=2；
//   页头下横幅「正在查看v2 · 回到编辑」由页面画。
import { type QueryClient, type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dropdown, type MenuProps, Tooltip } from 'antd';
import { Ellipsis, History } from 'lucide-react';
import { memo, type ReactNode, type Ref, useId, useState } from 'react';
import type { SectionSpecView, SopVersion } from '../../../src/shared/console-api.js';
import { api, unwrap } from '../api.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { Icon } from '../shell/icons.js';
import { cjk, Sep } from '../typography.js';
import { DiffList, DiffModeToggle, useDiffMode } from './DiffView.js';
import {
  draftLine,
  HISTORY_FETCH,
  type HistoryPage,
  historyRows,
  nextBefore,
  previousOf,
  versionChanges,
  versionLine,
  versionTech,
  versionTitle,
} from './history.js';

// ---------------- 数据 ----------------

/** 版本记录的缓存（回滚、发布以后整个前缀作废重取） */
export const VERSIONS_KEY = ['sop-versions'] as const;

/** 版本记录里已经取到的版本 */
function cachedVersions(qc: QueryClient): SopVersion[] {
  const d = qc.getQueryData<InfiniteData<HistoryPage>>(VERSIONS_KEY);
  return d ? historyRows(d.pages).known : [];
}

/**
 * 按 id 取一个版本（回滚的目标「回到v1」、草稿的基线）：版本记录里已经有的不再取；版本不会变，取到了就一直用。
 * id 为 null 时不取
 */
export function useKnownVersion(id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...VERSIONS_KEY, 'id', id],
    queryFn: () => unwrap(api.sop.versions[':id'].$get({ param: { id: id! } })),
    enabled: id !== null,
    staleTime: Infinity,
    initialData: () => (id === null ? undefined : cachedVersions(qc).find((v) => v.id === id)),
  });
}

/**
 * 「查看改动」的一对版本：vN 与它的前一版。版本记录里两个都有就不再取；不然按版本号取（before = N + 1，取 2 个），
 * 第一个不是 vN（地址写错了、没有这一版）时 version 为 null
 */
export function useVersionPair(no: number | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...VERSIONS_KEY, 'pair', no],
    queryFn: async (): Promise<{ version: SopVersion | null; prev: SopVersion | null }> => {
      const page = await unwrap(api.sop.versions.$get({ query: { limit: '2', before: String(no! + 1) } }));
      const [v, p] = page.items;
      if (!v || v.versionNo !== no) return { version: null, prev: null };
      return { version: v, prev: p && p.versionNo === no! - 1 ? p : null };
    },
    enabled: no !== undefined,
    staleTime: Infinity,
    initialData: () => {
      const known = cachedVersions(qc);
      const v = known.find((k) => k.versionNo === no);
      const prev = v ? previousOf(v, known) : null;
      return v && (prev || no === 1) ? { version: v, prev } : undefined;
    },
  });
}

// ---------------- 页头的操作 ----------------

/**
 * 「更多」打开时焦点进菜单（autoFocus），方向键、Enter 直接能用，Esc 关上、焦点回到「更多」。
 * 丢弃的确认框关上以后，页面经 moreRef 把焦点放回「更多」（打开确认框的菜单项那时已经卸下了）
 */
export const SopActions = memo(function SopActions({
  editable,
  discardBlocked,
  moreRef,
  onDiscard,
  onHistory,
}: {
  editable: boolean;
  /** 「丢弃草稿」不能点的原因（history.ts 的 discardBlock） */
  discardBlocked: string | null;
  moreRef?: Ref<HTMLButtonElement>;
  onDiscard: () => void;
  onHistory: (trigger: HTMLElement) => void;
}) {
  const items: MenuProps['items'] = [
    {
      key: 'discard',
      disabled: discardBlocked !== null,
      label: (
        <span className="menu-row">
          <span>丢弃草稿</span>
          {discardBlocked && <span className="menu-value">{cjk(discardBlocked)}</span>}
        </span>
      ),
    },
  ];
  const [open, setOpen] = useState(false);
  return (
    <>
      {editable && (
        <Dropdown
          open={open}
          onOpenChange={setOpen}
          trigger={['click']}
          placement="bottomRight"
          autoFocus
          destroyOnHidden
          rootClassName="sop-more-menu"
          menu={{
            items,
            selectable: false,
            // 键盘的 Enter 也走这里（keydown）：确认框同步打开、焦点被锁进弹窗，这一下 Enter 的默认动作会去按弹窗里
            // 拿到焦点的关闭按钮，确认框一闪就关了。拦下默认动作
            onClick: ({ key, domEvent }) => {
              if (domEvent.type === 'keydown') domEvent.preventDefault();
              setOpen(false);
              if (key === 'discard') onDiscard();
            },
          }}
        >
          <Tooltip title="更多操作" destroyOnHidden open={open ? false : undefined}>
            <Button
              ref={moreRef}
              className="sop-more-btn"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={open}
              icon={<Icon of={Ellipsis} />}
            />
          </Tooltip>
        </Dropdown>
      )}
      <Button className="sop-history-btn" aria-haspopup="dialog" icon={<Icon of={History} />} onClick={(e) => onHistory(e.currentTarget)}>
        版本记录
      </Button>
    </>
  );
});

// ---------------- 版本记录抽屉 ----------------

export interface HistoryListProps {
  spec: readonly SectionSpecView[];
  now: number;
  /** 能回滚、载入（能编辑的成员）；只读成员只能查看改动 */
  editable: boolean;
  /** 409 停住时不能载入（编辑器冻着） */
  frozen: boolean;
  /** 草稿那一行：改了几节；草稿的检查结果里的两个哈希（技术详情）。没有草稿是 null */
  draft: { changed: number; hashes: readonly (readonly [string, string])[] } | null;
  onContinue: () => void;
  onView: (v: SopVersion) => void;
  onRollback: (v: SopVersion, trigger: HTMLElement) => void;
  onLoad: (v: SopVersion, trigger: HTMLElement) => void;
}

/** 抽屉体：只在抽屉开着时挂，开的时候才取 */
export function HistoryList(p: HistoryListProps) {
  const q = useInfiniteQuery({
    queryKey: VERSIONS_KEY,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(api.sop.versions.$get({ query: { limit: String(HISTORY_FETCH), ...(pageParam ? { before: String(pageParam) } : {}) } })),
    getNextPageParam: nextBefore,
  });
  const { rows, known } = historyRows(q.data?.pages ?? []);
  return (
    <StateView
      pending={q.isPending}
      error={q.data ? null : q.error}
      onRetry={() => void q.refetch()}
      skeleton={<Skeleton rows={3} rowHeight={88} />}
    >
      <ol className="sop-history" aria-label="版本">
        {p.draft && (
          <li className="sop-history-row">
            <div className="sop-history-head">
              <Status kind="draft" />
              <span className="sop-history-meta">{cjk(draftLine(p.draft.changed))}</span>
              {p.editable && (
                <button type="button" className="sop-text-btn sop-history-continue" onClick={p.onContinue}>
                  继续编辑
                </button>
              )}
            </div>
            <TechDetails rows={p.draft.hashes} />
          </li>
        )}
        {rows.map((v) => (
          <VersionRow key={v.id} v={v} prev={previousOf(v, known)} known={known} {...p} />
        ))}
      </ol>
      <div className="sop-history-more">
        {q.isFetchNextPageError ? (
          <span className="sop-check-failed">
            没取到
            <Sep />
            <button type="button" className="sop-save-retry" onClick={() => void q.fetchNextPage()}>
              重试
            </button>
          </span>
        ) : q.hasNextPage ? (
          <Button size="small" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            更早的版本
          </Button>
        ) : (
          <span className="sop-history-end">{cjk('没有更早的版本了')}</span>
        )}
      </div>
    </StateView>
  );
}

function VersionRow({
  v,
  prev,
  known,
  spec,
  now,
  editable,
  frozen,
  onView,
  onRollback,
  onLoad,
}: HistoryListProps & { v: SopVersion; prev: SopVersion | null; known: readonly SopVersion[] }) {
  const live = v.status === 'published';
  // 回滚的目标「回到v1」：版本记录里有就直接用，没有另取
  const rollbackOf = v.source === 'rollback' ? v.basedOn : null;
  const inHand = rollbackOf ? known.find((k) => k.id === rollbackOf) : undefined;
  const target = useKnownVersion(rollbackOf && !inHand ? rollbackOf : null);
  const line = versionLine(v, spec, prev, now, (inHand ?? target.data)?.versionNo);
  const titleId = useId();
  const actions: { key: string; node: ReactNode }[] = [];
  // 最早的版本没有前一版可比
  if ((v.versionNo ?? 0) > 1)
    actions.push({
      key: 'view',
      node: (
        <button type="button" className="sop-text-btn" onClick={() => onView(v)}>
          查看改动
        </button>
      ),
    });
  if (editable && !live) {
    actions.push({
      key: 'rollback',
      node: (
        <button type="button" className="sop-text-btn" aria-haspopup="dialog" onClick={(e) => onRollback(v, e.currentTarget)}>
          回滚到这版…
        </button>
      ),
    });
    actions.push({
      key: 'load',
      node: (
        <button type="button" className="sop-text-btn" disabled={frozen} onClick={(e) => onLoad(v, e.currentTarget)}>
          载入到草稿再改
        </button>
      ),
    });
  }
  return (
    <li className="sop-history-row" aria-labelledby={titleId}>
      <div className="sop-history-head">
        <span id={titleId} className="sop-history-no">
          v{v.versionNo}
        </span>
        {live && <Status kind="live" />}
      </div>
      {line.note && <p className="sop-history-note">{cjk(line.note)}</p>}
      <p className="sop-history-meta">{cjk(line.meta)}</p>
      {actions.length > 0 && (
        <div className="sop-history-actions">
          {actions.map((a, i) => (
            <span key={a.key}>
              {i > 0 && <Sep />}
              {a.node}
            </span>
          ))}
        </div>
      )}
      <TechDetails rows={versionTech(v)} />
    </li>
  );
}

// ---------------- 查看改动（主区） ----------------

/** 页头下的横幅：「正在查看v2 · 回到编辑」 */
export function VersionBanner({ no, onBack }: { no: number; onBack: () => void }) {
  return (
    <Alert
      type="info"
      showIcon
      className="sop-version-banner"
      title={cjk(`正在查看v${no}`)}
      action={
        <Button size="small" onClick={onBack}>
          回到编辑
        </Button>
      }
    />
  );
}

export function VersionView({ no, spec, now }: { no: number; spec: readonly SectionSpecView[]; now: number }) {
  const q = useVersionPair(no);
  const [mode, setMode] = useDiffMode();
  const titleId = useId();
  const pair = q.data;
  return (
    <section className="sop-version" aria-labelledby={titleId}>
      <div className="sop-changes-head">
        <h2 id={titleId} className="sop-version-title" tabIndex={-1}>
          {cjk(versionTitle(no))}
        </h2>
        <DiffModeToggle mode={mode} onChange={setMode} />
      </div>
      <StateView pending={q.isPending} error={pair ? null : q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={3} />}>
        {pair && !pair.version && <p className="sop-changes-none">{cjk(`没有v${no}这个版本`)}</p>}
        {pair?.version && !pair.prev && <p className="sop-changes-none">{cjk(`v${no}是最早的版本，没有可比的`)}</p>}
        {pair?.version && pair.prev && <VersionDiff v={pair.version} prev={pair.prev} spec={spec} now={now} mode={mode} />}
      </StateView>
    </section>
  );
}

function VersionDiff({
  v,
  prev,
  spec,
  now,
  mode,
}: {
  v: SopVersion;
  prev: SopVersion;
  spec: readonly SectionSpecView[];
  now: number;
  mode: ReturnType<typeof useDiffMode>[0];
}) {
  const line = versionLine(v, spec, prev, now);
  const changes = versionChanges(spec, prev, v);
  return (
    <>
      <p className="sop-version-meta">{cjk([...(line.note ? [line.note] : []), ...line.meta])}</p>
      {changes.length ? (
        <DiffList items={changes} mode={mode} labels={[`v${prev.versionNo}`, `v${v.versionNo}`]} />
      ) : (
        <p className="sop-changes-none">{cjk('各节的写法都没变')}</p>
      )}
    </>
  );
}
