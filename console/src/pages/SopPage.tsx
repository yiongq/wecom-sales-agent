// 销售话术页（spec「销售话术（B、C 页）」）。第 5.1 步做了页头的状态句、额度条和目录（sop/ 下）：
// 状态句「线上v2 · 老板发布于9月25日 18:30 · 草稿改了2节」；额度条按服务端同一口径实时算（含还没保存的改动）；
// 目录保持 prompt 的原顺序，分段筛选、锁与锁定原因、键盘，选中的节写进 URL 的 section；宽 <1280 时目录换成下拉。
// 第 5.2 步做了中栏（sop/SopEditor.tsx）：节标题与说明行、固定规则节的只读说明、按 markdown 显示的编辑器（芯片、图标、改动标记）。
// 第 5.3 步：自动保存（sop/autosave.ts：停止输入 1.5 秒后存、带 rev、失败退避重试、⌘S，输入法组字时不存，409 停住并冻结编辑器，
// 载入最新草稿以后没存上的节以对比形式留着），状态句末尾的保存状态；离开保护管到自动保存还没存上的内容；三栏的布局（右栏是检查清单与
// 「话术里可以点名的工具」，1280–1439 时检查清单挪到目录下面，<1280 时落到编辑器下面，sop.css）。
// 第 6.2 步：检查在每次自动保存以后自动跑（sop/check.ts，打开页面时已有草稿也跑一次），页头不再有「检查」；清单里没过的项
// 点了定位（切到那一节、选中第一处，额度的去额度条）；这一节的问题在编辑器里画波浪线、写错的名字插行内提醒与「改成…」，
// 其余几类的说明写在编辑卡片上方（sop/problems.ts）。
// 第 6.3 步：底部常驻的发布条（sop/PublishParts.tsx：摘要、「发布…」不能点的原因、「查看改动」，发布成功以后写在条里、
// 带「回滚到v2」，不弹 toast）；点「发布…」先存没存上的改动，再打开发布抽屉、检查一次（检查清单、替换说明、逐节改动的
// 行内 / 并排、预填的变更说明）；中栏说明行末尾的「查看本节改动」。草稿跟不上线上版本时（别人在这期间发布过），替换说明、
// 成功那句和「回滚到vN」都按服务端那时的线上版本写，不按页面打开时取的。
// 版本记录（第 7 步）还是 01 的做法：页头右侧是丢弃，版本历史在页面底部。
// 匿名（demo）只拿到已发布版本的节，全部只读。
// 出错就地显示（ErrorAlert，文案取 ERROR_COPY），成功只报 toast；丢弃走 ConfirmDanger；有没保存的改动时拦下离开这一页的跳转
import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Alert, Button, Card, Empty, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AnonSopOverview, DraftCheck, SopOverview, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, HttpError, unwrap } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { errorCopy } from '../parts/errors.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { toast } from '../parts/toast.js';
import { LEAVING_PAGE, useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { useViewport } from '../shell/hooks.js';
import { PageHeader } from '../shell/PageHeader.js';
import { AutosaveTimingContext, type DraftEdit, type SaveStatus, useAutosave } from '../sop/autosave.js';
import { checkKey, useDraftCheck } from '../sop/check.js';
import { Directory, DirectorySelect, type SelectVia } from '../sop/Directory.js';
import { selectFirst } from '../sop/editor.js';
import { composingIn, editorIn, SectionPane, SopEditor } from '../sop/SopEditor.js';
import {
  anonOutline,
  anonStatus,
  bodyWithoutHeading,
  changedSections,
  draftChars,
  memberOutline,
  memberStatus,
  type OutlineFilter,
  type OutlineRow,
  PREAMBLE_NAME,
  quotaModel,
  resolveSection,
  type SectionChange,
  unsavedEdits,
  withSavedDraft,
} from '../sop/outline.js';
import { editorProblems, locateViolations, type ProblemTarget, sectionNotes } from '../sop/problems.js';
import { barBlock, firstProblem, notePrefill, onlineNow, type PublishedResult, publishedNames, replacedIn } from '../sop/publish.js';
import { ChangesDrawer, PublishBar, PublishDrawer } from '../sop/PublishParts.js';
import { QuotaBar } from '../sop/QuotaBar.js';
import { RollbackModal, rollbackNotice } from '../sop/RollbackModal.js';
import { ConflictBanner, LostEdits, type LostSection, SaveState } from '../sop/SaveParts.js';
import { CheckCard, ToolsCard } from '../sop/SideCards.js';
import { SopSkeleton } from '../sop/SopSkeleton.js';
import { cjk } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';

const NL = '\n';
const TITLE = '销售话术';
const SOURCE_LABEL: Record<SopVersion['source'], string> = {
  import: '导入',
  console: '后台发布',
  rollback: '回滚',
  rerender: '启动重渲染',
};
const when = (iso: string | null): string => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—');

/** 节的正文：去掉「## 标题」和它后面的空行；前言没有标题 */
function bodyOf(text: string, heading: string | null): string {
  if (heading === null) return text;
  const head = `## ${heading}${NL}${NL}`;
  return text.startsWith(head) ? text.slice(head.length) : text;
}
/** 一个版本里这一节的原文（带标题行） */
const textOf = (v: Pick<SopVersion, 'sections'>, key: string): string => v.sections.find((s) => s.key === key)?.text ?? '';
const headingOf = (spec: SopOverview['spec'], key: string | null): string =>
  key === null ? '整体' : (spec.find((s) => s.key === key)?.heading ?? PREAMBLE_NAME);

/** 聚焦容器里的 CodeMirror 正文 */
const focusEditorIn = (el: HTMLElement | null): void => el?.querySelector<HTMLElement>('.cm-content')?.focus();

/**
 * 选中的节在 URL 的 section 上：地址、换节（方向键换节不往浏览历史里加记录）、在目录里按 Enter 进编辑器。
 * editor 是包着编辑器的容器
 */
function useSectionNav(rows: readonly OutlineRow[], editor: RefObject<HTMLDivElement | null>) {
  const { section: param } = useSearch({ from: '/sop' });
  const navigate = useNavigate({ from: '/sop' });
  const router = useRouter();
  const section = resolveSection(param, rows);
  const hrefOf = (key: string): string =>
    router.history.createHref(router.buildLocation({ to: '/sop', search: { section: key } }).publicHref);
  // 不随渲染变：窄屏下拉是 memo，逐字重渲时不跟着重渲（sop/Directory.tsx 文件头）
  const select = useCallback(
    (key: string, via: SelectVia = 'click'): void => {
      void navigate({ search: (prev) => ({ ...prev, section: key }), replace: via === 'key' });
    },
    [navigate],
  );
  // Enter 进编辑器。选的就是当前节时编辑器已经在了，直接聚焦；要先换节的，记下这一节，
  // 等地址换好、编辑器按新的节重建以后（子组件的 effect 先跑）再聚焦
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (pending.current === null || pending.current !== section) return;
    pending.current = null;
    focusEditorIn(editor.current);
  }, [section, editor]);
  const enter = (key: string): void => {
    if (key === section) focusEditorIn(editor.current);
    else pending.current = key;
  };
  return { section, hrefOf, select, enter };
}

/** 目录：宽 ≥1280 在左栏，窄了是编辑器上方的下拉 */
function Toc({
  rows,
  nav,
  filter,
  onFilter,
  showCounts,
}: {
  rows: readonly OutlineRow[];
  nav: ReturnType<typeof useSectionNav>;
  filter?: OutlineFilter;
  onFilter?: (f: OutlineFilter) => void;
  showCounts: boolean;
}) {
  const wide = useViewport() === 'wide';
  if (!wide) return <DirectorySelect rows={rows} current={nav.section} onSelect={nav.select} />;
  return (
    <Directory
      rows={rows}
      current={nav.section}
      filter={filter}
      onFilter={onFilter}
      showCounts={showCounts}
      hrefOf={nav.hrefOf}
      onSelect={nav.select}
      onEnter={nav.enter}
    />
  );
}

/** /sop：页面、载入最新草稿都用这一份（同一个缓存） */
const sopQuery = queryOptions({ queryKey: ['sop'], queryFn: () => unwrap(api.sop.$get()) });

/**
 * 检查结果。草稿跟不上线上版本（rebase.needed：别人在这期间发布过）时另带那时的线上版本：页面上的是打开时取的，
 * 发布抽屉的「将替换线上v3」照这一份写。只取它、不写进 /sop 的缓存：页面上的草稿与逐节改动照旧相对草稿所基于的版本，
 * 发布时三方合并，别人改的节不算你的改动。取不到算这次检查没跑成（抽屉写「没检查上」、能重试）
 */
type SopCheck = DraftCheck & { online: SopVersion | null };
async function checkDraft(): Promise<SopCheck> {
  const r = await unwrap(api.sop.draft.check.$post());
  if (!r.rebase.needed) return { ...r, online: null };
  const o = await unwrap(api.sop.$get());
  return { ...r, online: 'spec' in o ? o.published : null };
}

/**
 * 发布替换下来的版本不在手上（检查之后别人又发布过）：取版本号紧挨着的前一个，核对是发布结果的 basedOn。
 * 取不到不报错（发布已经成功了），只是条里不写改了哪几节、不给回滚
 */
async function fetchReplaced(v: SopVersion): Promise<SopVersion | null> {
  if (v.basedOn === null || v.versionNo === null) return null;
  try {
    const page = await unwrap(api.sop.versions.$get({ query: { limit: '1', before: String(v.versionNo) } }));
    return replacedIn(v.basedOn, page.items);
  } catch {
    return null;
  }
}

export function SopPage() {
  const viewer = useViewer();
  const pack = usePack();
  const q = useQuery(sopQuery);
  const { section: param } = useSearch({ from: '/sop' });
  // 已经有数据时重取失败（发布、丢弃、回滚以后刷新）不换成整块出错：页面卸下来，编辑中的内容就丢了。错误在页头下就地显示
  if (q.data === undefined) {
    // 匿名没有额度条和分段控件；节标题下那一行，成员总有，匿名只在打开固定规则节时有（节表先取行业包的）
    const member = viewer.data?.kind !== 'anon';
    const packRows = pack?.sopSections ?? [];
    const locked = packRows.find((s) => s.key === resolveSection(param, packRows))?.locked ?? false;
    return (
      <>
        {/* 加载时状态句那一行先占着（看不见），骨架与成品的位置一致 */}
        <PageHeader title={TITLE} status={q.isPending ? <span className="sop-status-pending" aria-hidden="true" /> : undefined} />
        <StateView
          pending={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          skeleton={<SopSkeleton sections={pack?.sopSections.length ?? 11} quota={member} filter={member} meta={member || locked} />}
        />
      </>
    );
  }
  const refetchError = q.isRefetchError ? <ErrorAlert error={q.error} onRetry={() => void q.refetch()} /> : null;
  return 'spec' in q.data ? (
    <MemberSop data={q.data} pack={pack} editable={canEdit(viewer.data)} now={q.dataUpdatedAt} refetchError={refetchError} />
  ) : (
    <AnonSop data={q.data} pack={pack} now={q.dataUpdatedAt} refetchError={refetchError} />
  );
}

/**
 * 三栏（设计系统 B 页）：目录、中栏、检查清单、工具卡片各是网格里的一格，放在哪一栏由 sop.css 按宽度定（容器查询），
 * DOM 的顺序固定是目录 → 中栏 → 检查清单 → 工具，Tab 顺序与 spec「页头操作 → 目录 → 编辑器」一致
 */
function Columns({
  toc,
  main,
  check,
  tools,
  editor,
  checkRef,
}: {
  toc: ReactNode;
  main: ReactNode;
  check?: ReactNode;
  tools?: ReactNode;
  editor: RefObject<HTMLDivElement | null>;
  checkRef?: RefObject<HTMLDivElement | null>;
}) {
  const wide = useViewport() === 'wide';
  return (
    <div className="sop-layout">
      <div className={`sop-body${wide ? '' : ' is-narrow'}`}>
        <div className="sop-col-toc">{toc}</div>
        <div ref={editor} className="sop-col-main sop-editor">
          {main}
        </div>
        {check && (
          <div ref={checkRef} className="sop-col-check">
            {check}
          </div>
        )}
        {tools && <div className="sop-col-tools">{tools}</div>}
      </div>
    </div>
  );
}

/**
 * 匿名：目录（带锁）加只读正文；页头只有「线上v2 · 9月25日」；没有额度条、按钮、技术详情。
 * now：状态句里的日期按它判断要不要写年份（取数据取回来的时刻，渲染时不读时钟）
 */
function AnonSop({
  data,
  pack,
  now,
  refetchError,
}: {
  data: AnonSopOverview;
  pack: IndustryPack | undefined;
  now: number;
  refetchError: ReactNode;
}) {
  const { published } = data;
  const rows = anonOutline(published.sections, pack?.sopSections);
  const editor = useRef<HTMLDivElement>(null);
  const nav = useSectionNav(rows, editor);
  const shown = published.sections.find((s) => s.key === nav.section);
  const row = rows.find((r) => r.key === nav.section);
  return (
    <>
      <PageHeader title={TITLE} status={<span>{cjk(anonStatus(published, now))}</span>} />
      {refetchError && <div className="sop-banners">{refetchError}</div>}
      <Columns
        editor={editor}
        toc={<Toc rows={rows} nav={nav} showCounts={false} />}
        main={
          shown &&
          row && <SectionPane key={shown.key} row={row} who="anon" value={bodyWithoutHeading(shown.text)} vocabulary={pack?.vocabulary} />
        }
      />
    </>
  );
}

/**
 * 409 以后没存上的节。edits 是这一次没存上的（编辑器还冻着、显示你写的），载入最新草稿以后变成对比接在 loaded 后面；
 * loaded 是已经载入过的对比，一次 409 一批，关掉之前一直留着：别人接着在存，再来一次 409 也不能把上一批冲掉
 */
interface Lost {
  edits: DraftEdit[];
  loaded: LostSection[];
}

/** 这一批没存上的节接在已有的对比后面：左边是载入时草稿里的这一节；同一节第几次没存上（nth）按已有的数 */
function withLoaded(prev: readonly LostSection[], edits: readonly DraftEdit[], fresh: SopOverview): LostSection[] {
  const latest = fresh.draft ?? fresh.published;
  const out = [...prev];
  for (const e of edits) {
    const s = fresh.spec.find((x) => x.key === e.key);
    out.push({
      key: e.key,
      nth: out.filter((x) => x.key === e.key).length + 1,
      name: s?.heading ?? PREAMBLE_NAME,
      latest: bodyOf(latest.sections.find((x) => x.key === e.key)?.text ?? '', s?.heading ?? null),
      mine: e.body,
    });
  }
  return out;
}

function MemberSop({
  data,
  pack,
  editable,
  now,
  refetchError,
}: {
  data: SopOverview;
  pack: IndustryPack | undefined;
  editable: boolean;
  now: number;
  refetchError: ReactNode;
}) {
  const qc = useQueryClient();
  const { published, draft, spec, budget } = data;
  const current = draft ?? published;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejected, setRejected] = useState<HttpError | null>(null);
  const [conflict, setConflict] = useState<{ keys: string[]; current: SopSectionText[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  // 发布：点了「发布…」、正在先存没存上的改动（from 是点的时候的保存状态：那之后的失败才算这次没存上）；抽屉开着；
  // 变更说明与它的预填；发布请求在路上；发布没成功（422、409 以外的，写在抽屉里）；成功以后条里的那句
  const [opening, setOpening] = useState<{ key: string | null; from: SaveStatus } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [note, setNote] = useState('');
  const [prefill, setPrefill] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown>(null);
  const [result, setResult] = useState<PublishedResult | null>(null);
  // 抽屉关上以后要等收起动画放完才卸下，里面的内容留到那时（mounted、changesOf 在 afterClose 里清）
  const [publishMounted, setPublishMounted] = useState(false);
  // 「查看改动」「查看本节改动」：section 是只看的那一节，null 是全部
  const [changesOf, setChangesOf] = useState<{ section: string | null; open: boolean } | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<SopVersion | null>(null);
  const [rolledBackNote, setRolledBackNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<OutlineFilter>('all');
  const [lost, setLost] = useState<Lost | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<unknown>(null);
  const editor = useRef<HTMLDivElement>(null);
  /** 载入最新草稿、关掉对比以后焦点去哪（见下面的 effect） */
  const refocus = useRef<'lost' | 'next' | null>(null);
  const lostTitle = useRef<HTMLHeadingElement>(null);

  const originalBody = (k: string): string => {
    const s = spec.find((x) => x.key === k)!;
    return bodyOf(current.sections.find((x) => x.key === k)?.text ?? '', s.heading);
  };
  // 本地改过、还没存进草稿的节（规范化以后比，改回原样不算）：自动保存要发的就是它们
  const unsaved = useMemo(() => unsavedEdits(spec, current.sections, edits), [spec, current.sections, edits]);
  // 发布被拒、冲突都是对某一份草稿说的：草稿存了、丢了、发布了或者回滚过，就都作废。检查结果不在这里清：
  // 草稿一变就重跑（useDraftCheck 按 key），跑完之前先留着上一次的。引用不变，版本历史（memo）才不会每敲一个字跟着重渲
  const clearResults = useCallback((): void => {
    setRejected(null);
    setConflict(null);
  }, []);
  const timing = useContext(AutosaveTimingContext);
  // 每次自动保存成功（草稿的 rev 变了）以后检查一次；打开页面时已经有草稿、载入最新草稿、回滚以后线上换了也跑
  const check = useDraftCheck<SopCheck>({
    enabled: editable,
    key: checkKey(draft, published.id),
    post: checkDraft,
    now: timing.now,
  });
  const saver = useAutosave({
    enabled: editable,
    unsaved,
    composing: () => composingIn(editor.current),
    base: { rev: draft?.rev ?? null, basedOn: draft?.basedOn ?? published.id },
    send: (list, base) => unwrap(api.sop.draft.$put({ json: { basedOn: base.basedOn, rev: base.rev, edits: list } })),
    onSaved: (v) => {
      qc.setQueryData<SopOverview | AnonSopOverview>(sopQuery.queryKey, (old) => (old && 'spec' in old ? withSavedDraft(old, v) : old));
      clearResults();
    },
    onConflict: (list) => setLost((prev) => ({ edits: list, loaded: prev?.loaded ?? [] })),
  });
  const frozen = saver.status.kind === 'conflict';
  const saving = saver.status.kind === 'saving';
  // 自动保存还没存上（在等、在路上、失败、409 停住），以及载入以后还留着的对比，都算没保存的内容；换节不算离开
  const guard = useUnsavedGuard(unsaved.length > 0 || lost !== null, LEAVING_PAGE);
  // 先等新数据回来再清掉本地改动，免得编辑器先闪回旧正文
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: sopQuery.queryKey });
    await qc.invalidateQueries({ queryKey: ['sop-versions'] });
    setEdits({});
  };
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // 409 以后：重取 /sop，编辑器换成最新草稿，没存上的节连同载入时草稿里的写法接在已有的对比后面，自动保存接着来
  const reloadLatest = async (): Promise<void> => {
    setReloading(true);
    setReloadError(null);
    try {
      const fresh = await qc.fetchQuery({ ...sopQuery, staleTime: 0 });
      if (!('spec' in fresh)) return;
      setEdits({});
      clearResults();
      setLost((prev) => {
        const loaded = withLoaded(prev?.loaded ?? [], prev?.edits ?? [], fresh);
        return loaded.length ? { edits: [], loaded } : null;
      });
      saver.resume();
      refocus.current = 'lost';
    } catch (e) {
      setReloadError(e);
    } finally {
      setReloading(false);
    }
  };
  // 只关掉对比；409 停住时这一次没存上的节还要留着，载入以后照样变成对比
  const closeLost = useCallback(() => {
    refocus.current = 'next';
    setLost((prev) => (prev?.edits.length ? { ...prev, loaded: [] } : null));
  }, []);

  // 发布成功：条里写「已发布v3（改了…）」、带「回滚到v2」（被替换下来的那一版），不弹 toast；抽屉关上，焦点回到「发布…」。
  // 被替换下来的是服务端那时的线上版本（发布结果的 basedOn），不一定是页面打开时的：别人在这期间发布过，就是他发布的那一版，
  // 改了哪几节也相对它算。422（检查没过）时抽屉开着，清单换成被拒的问题；409（在你编辑期间别人发布过、合并有冲突）关上抽屉，
  // 由页面上的提示说；别的失败写在抽屉里，写好的说明不丢
  const publish = async (): Promise<void> => {
    if (!draft) return;
    const known = [published, check.result?.online];
    setPublishing(true);
    setPublishError(null);
    setRejected(null);
    setConflict(null);
    try {
      const v = await unwrap(api.sop.draft.publish.$post({ json: { rev: draft.rev, changeNote: note } }));
      const previous = replacedIn(v.basedOn, known) ?? (await fetchReplaced(v));
      setResult({ versionNo: v.versionNo, names: publishedNames(spec, previous, v), previous });
      setPublishOpen(false);
      setNote('');
      setPrefill('');
      clearResults();
      // 存上的那份草稿已经发布出去了：「已自动保存14:30」不再对应什么
      saver.resume();
      await refresh();
    } catch (e) {
      if (e instanceof HttpError && e.body.error === 'contract') setRejected(e);
      else if (e instanceof HttpError && e.body.error === 'sop_conflict') {
        setConflict({ keys: e.body.keys ?? [], current: e.body.current ?? [] });
        setPublishOpen(false);
      } else setPublishError(e);
    } finally {
      setPublishing(false);
    }
  };
  // 失败时也关掉确认框，错误在页面顶上就地显示
  const discard = () =>
    run(async () => {
      try {
        await unwrap(api.sop.draft.discard.$post({ json: { rev: draft!.rev } }));
      } finally {
        setDiscarding(false);
      }
      clearResults();
      saver.resume();
      toast('草稿已丢弃');
      await refresh();
    });

  const checked = check.result;
  const violations = useMemo(() => (rejected ? (rejected.body.violations ?? []) : (checked?.violations ?? null)), [rejected, checked]);
  // 每条问题落在哪一节、点了去哪（phrase_missing 取线上版本里含这句的节）；只随检查结果变，右栏的清单（memo）不逐字重渲
  const located = useMemo(() => (violations ? locateViolations(violations, published.sections) : null), [violations, published.sections]);
  const rows = memberOutline({
    spec,
    packSections: pack?.sopSections,
    published: published.sections,
    current: current.sections,
    edits,
    violations: located?.map((v) => ({ sectionKey: v.section })),
  });
  const nav = useSectionNav(rows, editor);
  const tools = pack?.vocabulary.tools;
  const vocabulary = pack?.vocabulary;
  // 这一节正文里要标出来的问题：引用只随检查结果、换节、换包变，编辑器不逐字重派
  const problems = useMemo(
    () => (located ? editorProblems(located, nav.section ?? '', vocabulary) : undefined),
    [located, nav.section, vocabulary],
  );
  const notes = located && nav.section !== undefined ? sectionNotes(located, nav.section) : undefined;
  const section = spec.find((s) => s.key === nav.section);
  const row = rows.find((r) => r.key === nav.section);
  const quota = quotaModel(rows, draftChars(spec, current.sections, edits), budget.limit);
  const changed = rows.filter((r) => r.changed);
  const draftChanged = draft ? spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key)) : [];
  // 丢弃是对存下来的草稿做的：还有没存上的改动、请求在路上、409 停住时不能点（发布条的「发布…」点了先存，见下面）
  const settled = !!draft && unsaved.length === 0 && !saving && !frozen;
  const saveError = saver.status.kind === 'failed' && errorCopy(saver.status.error).place !== 'inline' ? saver.status.error : null;
  const lostLoaded = lost?.loaded.length ? lost.loaded : null;
  const hasBanners = refetchError !== null || saveError !== null || frozen || lostLoaded !== null || reloadError !== null;

  // 409 停住的那一刻，在一节长正文的下半截打字时横幅在视口外、状态句跟着页头缩没了，编辑器只是不再接受输入：
  // 把横幅滚进视口；焦点原来在编辑器里的，移到横幅上（读屏念出来，下一个 Tab 就到「载入最新草稿」；
  // 不直接落在按钮上，免得接着敲的空格、回车把它按下去）。焦点在别处（目录、弹窗）的不抢。
  // 用 layout effect：编辑器变只读时是整个重建的（SopEditor 的 effect），旧的正文一拿掉焦点就掉到 body 上，
  // 得赶在那之前看焦点在不在编辑器里
  const conflictRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = conflictRef.current;
    if (!frozen || !el) return;
    const typing = editor.current?.contains(document.activeElement) ?? false;
    // 按底边对齐：横幅紧挨着页头，视口放得下时就一直滚到顶，页头连同状态句「没保存上」也整个露出来
    el.scrollIntoView({ block: 'end' });
    if (typing) el.focus({ preventScroll: true });
  }, [frozen]);
  // 载入最新草稿、关掉对比以后，按过的按钮随横幅、对比一起卸下，焦点掉到 body 上，读屏什么也不念：
  // 载入以后有对比的，移到对比的标题上；没有对比、关掉对比以后回到编辑器，还冻着时回到横幅。焦点已经在别处（目录）的不抢
  useEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    refocus.current = null;
    if (document.activeElement !== document.body) return;
    if (want === 'lost' && lostTitle.current) lostTitle.current.focus();
    else if (frozen) conflictRef.current?.focus();
    else focusEditorIn(editor.current);
  });

  // 点清单里没过的一项：切到那一节（点击进浏览历史，同目录），等编辑器按这一节建好以后选中第一处、滚过去、聚焦；
  // 没有 match 可选的（结构、固定规则、必需说法，或者已经改掉了）聚焦正文、把卡片上方的说明滚进视口。额度的去额度条
  const quotaRef = useRef<HTMLElement>(null);
  const notesRef = useRef<HTMLUListElement>(null);
  const pendingLocate = useRef<NonNullable<ProblemTarget> | null>(null);
  const [, setLocateTick] = useState(0);
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  const locate = useCallback((t: NonNullable<ProblemTarget>): void => {
    if (t.kind === 'quota') {
      quotaRef.current?.scrollIntoView({ block: 'nearest' });
      quotaRef.current?.focus({ preventScroll: true });
      return;
    }
    pendingLocate.current = t;
    if (t.section !== navRef.current.section) navRef.current.select(t.section, 'click');
    setLocateTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const t = pendingLocate.current;
    if (t === null || t.kind === 'quota' || t.section !== nav.section) return;
    const view = editorIn(editor.current);
    if (!view) return;
    pendingLocate.current = null;
    view.focus();
    if (t.kind === 'match' && selectFirst(view, t.match, t.name)) return;
    (notesRef.current ?? editor.current)?.scrollIntoView({ block: 'nearest' });
  });

  // 点了行内提醒的「改成…」：替换已经进了 edits，等这次渲染把最新的改动交给自动保存以后（useAutosave 的 effect 在前面），马上存
  const fixed = useRef(false);
  const onFix = useCallback((): void => {
    fixed.current = true;
  }, []);
  useEffect(() => {
    if (!fixed.current) return;
    fixed.current = false;
    saver.flush();
  });

  // ---------------- 发布（第 6.3 步） ----------------
  const block = barBlock({ frozen, changed: changed.length, problems: located?.length ?? 0 });
  // 发布成功的那句只在线上还是刚发布的那一版时留着：之后从版本历史回滚过、别人又发布过，它和「回滚到v2」都不再对
  const shownResult = result !== null && result.versionNo === published.versionNo ? result : null;
  const draftKey = checkKey(draft, published.id);
  // 抽屉与「查看改动」里的逐节改动（含本地还没保存的改动，与目录的「改过」同一口径）；只在开着时算
  const changes = publishMounted || changesOf ? changedSections(spec, published.sections, current.sections, edits) : NO_CHANGES;
  // 抽屉关上以后焦点回到打开它的按钮：关上之后的 effect 里还（抽屉的焦点陷阱这时已经放开），不等收起动画。
  // 点清单里的一项定位时不还（清掉 publishBack），焦点由定位放到正文里
  const publishBack = useRef<HTMLElement | null>(null);
  const changesBack = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = publishBack.current;
    if (publishOpen || !el) return;
    publishBack.current = null;
    if (el.isConnected) el.focus();
  }, [publishOpen]);
  const changesShown = changesOf?.open ?? false;
  useEffect(() => {
    const el = changesBack.current;
    if (changesShown || !el) return;
    changesBack.current = null;
    if (el.isConnected) el.focus();
  }, [changesShown]);

  // 点「发布…」：先把没存上的改动存了（⌘S 同一条路），存上以后再打开抽屉、检查一次。这一次存上了（草稿的 rev 变了）时
  // 自动检查已经在跑，不另发；没有要存的就检查一次。点了以后又存失败了、或者 409 停住，就不打开（状态句与横幅说明原因）。
  // 存没存上在渲染时看（按上一次渲染的值调整 state），检查在 effect 里发
  const startPublish = (trigger: HTMLElement): void => {
    publishBack.current = trigger;
    setOpening({ key: draftKey, from: saver.status });
    saver.flush();
  };
  const [checkOnOpen, setCheckOnOpen] = useState(0);
  if (opening !== null) {
    const st = saver.status;
    if (frozen || (st.kind === 'failed' && st !== opening.from)) setOpening(null);
    else if (unsaved.length === 0 && !saving) {
      setOpening(null);
      if (draftKey !== null) {
        // 预填改了哪几节；自己写过的说明留着，只剩上一次的预填（或空着）时换成这一次的
        const fill = notePrefill(changed.map((r) => r.name));
        setNote((n) => (n.trim() === '' || n === prefill ? fill : n));
        setPrefill(fill);
        setPublishError(null);
        setPublishOpen(true);
        setPublishMounted(true);
        if (draftKey === opening.key) setCheckOnOpen((n) => n + 1);
      }
    }
  }
  const retryCheck = check.retry;
  useEffect(() => {
    if (checkOnOpen > 0) retryCheck();
  }, [checkOnOpen, retryCheck]);
  // 发布条上有问题时点「发布…」：跳到第一个问题（清单的顺序）；没有去处的，把检查清单滚进视口
  const checkRef = useRef<HTMLDivElement>(null);
  const jumpToProblem = (): void => {
    const t = located ? firstProblem(located) : null;
    if (t) locate(t);
    else checkRef.current?.scrollIntoView({ block: 'nearest' });
  };
  // 抽屉里点清单的一项：关抽屉并定位
  const locateFromDrawer = useCallback(
    (t: NonNullable<ProblemTarget>): void => {
      publishBack.current = null;
      setPublishOpen(false);
      locate(t);
    },
    [locate],
  );
  const viewSection = useCallback((key: string, trigger: HTMLElement): void => {
    changesBack.current = trigger;
    setChangesOf({ section: key, open: true });
  }, []);

  // 草稿跟不上线上版本只提示一条：/sop 的 draft.stale 与检查的 rebase.needed 是服务端同一个条件（basedOn 不是线上版本），
  // 检查打开页面就跑，两条会一起出来。检查报了冲突的节时是出错色、写发布不了，不然是 info（检查回来之前、回滚以后
  // 重查回来之前按 draft.stale）。发布撞上冲突（409）时由那一条说，这一条不出；发布被拒（422）是合并以后的事，没有冲突的节
  const rebase = check.result?.rebase;
  const rebaseConflicts = rebase?.needed ? rebase.conflicts : [];
  const rebaseNote = conflict ? null : rebaseConflicts.length ? 'conflict' : draft?.stale || rebase?.needed ? 'merge' : null;
  const hasNotices = error !== null || rebaseNote !== null || !!rejected || !!conflict || rolledBackNote !== null;

  return (
    <>
      <PageHeader
        title={TITLE}
        status={
          <span className={editable ? 'sop-status-line' : undefined}>
            {cjk(memberStatus(published, changed.length, now))}
            {editable && <SaveState status={saver.status} onRetry={saver.flush} />}
          </span>
        }
        actions={
          editable && (
            <>
              <Button disabled={!settled} loading={busy} onClick={() => setDiscarding(true)}>
                丢弃
              </Button>
            </>
          )
        }
      />
      {guard}
      {hasBanners && (
        <div className="sop-banners">
          {/* 409 停住时重取失败由下面「载入最新草稿」自己的报错说（重试要接着走完载入），这里不重复 */}
          {!frozen && refetchError}
          {saveError !== null && <ErrorAlert error={saveError} onRetry={saver.flush} />}
          {frozen && (
            <div ref={conflictRef} tabIndex={-1} className="sop-conflict">
              <ConflictBanner
                error={saver.status.kind === 'conflict' ? saver.status.error : null}
                names={(lost?.edits ?? []).map((e) => headingOf(spec, e.key))}
                loading={reloading}
                onReload={() => void reloadLatest()}
              />
            </div>
          )}
          {reloadError !== null && <ErrorAlert error={reloadError} onRetry={() => void reloadLatest()} />}
          {/* 又一次 409 时上一批对比照样留着（这时编辑器冻着，这一批要载入以后才接上来） */}
          {lostLoaded && <LostEdits items={lostLoaded} onClose={closeLost} titleRef={lostTitle} />}
        </div>
      )}
      <QuotaBar model={quota} ref={editable ? quotaRef : undefined} />
      {hasNotices && (
        <Space orientation="vertical" size="middle" className="sop-notices">
          {error !== null && <ErrorAlert error={error} />}
          {rolledBackNote !== null && (
            <Alert type="warning" showIcon closable={{ onClose: () => setRolledBackNote(null) }} title={cjk(rolledBackNote)} />
          )}
          {rebaseNote === 'merge' && <Alert type="info" showIcon title="草稿打开之后发布过新版本，发布时自动合并" />}
          {rebaseNote === 'conflict' && (
            <Alert
              type="error"
              showIcon
              title={
                `这几节在你编辑期间被别人改过：${rebaseConflicts.map((k) => headingOf(spec, k)).join('、')}。` +
                '这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在当前版本上重做。'
              }
            />
          )}
          {rejected && <ErrorAlert error={rejected} />}
          {conflict && (
            <Alert
              type="error"
              showIcon
              title={`发布被拒：这几节在你编辑期间被别人改过——${conflict.keys.map((k) => headingOf(spec, k)).join('、')}`}
              description={
                <Space orientation="vertical" style={{ width: '100%' }}>
                  {conflict.current
                    .filter((s) => conflict.keys.includes(s.key))
                    .map((s) => (
                      <div key={s.key}>
                        <Typography.Text type="secondary">当前发布版本的「{headingOf(spec, s.key)}」：</Typography.Text>
                        <SopEditor value={s.text} name={headingOf(spec, s.key)} readOnly vocabulary={pack?.vocabulary} />
                      </div>
                    ))}
                  <span>这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在上面这份当前版本上重做。</span>
                </Space>
              }
            />
          )}
        </Space>
      )}

      <Columns
        editor={editor}
        checkRef={checkRef}
        toc={<Toc rows={rows} nav={nav} filter={filter} onFilter={setFilter} showCounts />}
        main={
          section &&
          row && (
            <SectionPane
              key={section.key}
              row={row}
              who={editable ? 'editor' : 'reader'}
              frozen={frozen}
              value={edits[section.key] ?? originalBody(section.key)}
              baseline={bodyOf(textOf(published, section.key), section.heading)}
              vocabulary={vocabulary}
              problems={problems}
              notes={notes}
              notesRef={notesRef}
              onFix={onFix}
              onViewDiff={viewSection}
              onChange={(v) => {
                setEdits((e) => ({ ...e, [section.key]: v }));
                // 发布成功的那句保留到下一次改动
                if (result !== null) setResult(null);
                saver.edited();
              }}
            />
          )
        }
        check={
          editable && (
            <CheckCard
              spec={spec}
              located={located}
              violations={violations}
              check={check.result}
              budget={check.result ?? budget}
              at={check.at}
              failed={check.error !== null}
              onRetry={check.retry}
              onLocate={locate}
            />
          )
        }
        tools={tools && Object.keys(tools).length > 0 && <ToolsCard tools={tools} />}
      />

      <div className="sop-after">
        <History editable={editable} currentId={published.id} onRolledBack={clearResults} />
      </div>

      {editable && (
        <PublishBar
          result={shownResult}
          changed={changed.map((r) => r.name)}
          problems={located?.length ?? 0}
          chars={quota.chars}
          limit={quota.limit}
          block={block}
          opening={opening !== null}
          onPublish={startPublish}
          onJump={jumpToProblem}
          onChanges={(trigger) => {
            changesBack.current = trigger;
            setChangesOf({ section: null, open: true });
          }}
          onRollback={() => result?.previous && setRollbackTarget(result.previous)}
        />
      )}
      <PublishDrawer
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        afterClose={() => setPublishMounted(false)}
        spec={spec}
        published={published}
        replacing={onlineNow(published, check.result?.online)}
        now={now}
        changes={changes}
        located={located}
        budget={check.result ?? budget}
        check={{ running: check.running, failed: check.error !== null, at: check.at, retry: check.retry }}
        conflicts={rebaseConflicts.map((k) => headingOf(spec, k))}
        note={note}
        prefill={prefill}
        onNote={setNote}
        publishing={publishing}
        error={publishError}
        onPublish={() => void publish()}
        onLocate={locateFromDrawer}
      />
      <ChangesDrawer
        open={changesShown}
        section={changesOf?.section ? headingOf(spec, changesOf.section) : null}
        changes={changesOf?.section ? changes.filter((c) => c.key === changesOf.section) : changes}
        published={published}
        onClose={() => setChangesOf((c) => c && { ...c, open: false })}
        afterClose={() => setChangesOf(null)}
      />
      <RollbackModal
        target={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onDone={(v, target) => {
          setRollbackTarget(null);
          setResult(null);
          clearResults();
          setRolledBackNote(rollbackNotice(v, target));
        }}
      />
      <ConfirmDanger
        open={discarding}
        title="丢弃草稿？"
        confirmText="丢弃草稿"
        cancelText="保留"
        onConfirm={discard}
        onCancel={() => setDiscarding(false)}
      >
        {draftChanged.length
          ? `草稿里${draftChanged.length}节改动（${draftChanged.map((s) => s.heading ?? PREAMBLE_NAME).join('、')}）会丢掉，线上v${published.versionNo}不受影响。这一步撤销不了。`
          : `草稿会丢掉，线上v${published.versionNo}不受影响。这一步撤销不了。`}
      </ConfirmDanger>
    </>
  );
}

/** 抽屉都关着时逐节改动不算 */
const NO_CHANGES: readonly SectionChange[] = [];

const VERSIONS_PAGE = 50;

const History = memo(function History({
  editable,
  currentId,
  onRolledBack,
}: {
  editable: boolean;
  currentId: string;
  onRolledBack: () => void;
}) {
  // 每一个已发布或归档的版本都要能回滚，所以按版本号倒序往前翻（before 游标）；
  // 接口不给下一页的游标：满一页就以这一页最小的版本号接着翻，不满一页就是到头了
  const q = useInfiniteQuery({
    queryKey: ['sop-versions'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(api.sop.versions.$get({ query: { limit: String(VERSIONS_PAGE), ...(pageParam ? { before: String(pageParam) } : {}) } })),
    getNextPageParam: (last) => (last.items.length < VERSIONS_PAGE ? undefined : (last.items.at(-1)?.versionNo ?? undefined)),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [target, setTarget] = useState<SopVersion | null>(null);
  /** 回滚后的新版本与目标版本的固定规则不同（sameHashAsTarget 为 false）时的说明 */
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card size="small" title="版本历史">
      {notice && (
        <Alert type="warning" showIcon closable={{ onClose: () => setNotice(null) }} style={{ marginBottom: 12 }} title={notice} />
      )}
      <StateView pending={q.isPending} error={q.data ? null : q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={3} />}>
        <Table<SopVersion>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: <Empty description="没有版本" /> }}
          columns={[
            { title: '版本', dataIndex: 'versionNo', render: (n: number) => `v${n}` },
            { title: '来源', dataIndex: 'source', render: (s: SopVersion['source']) => SOURCE_LABEL[s] },
            { title: '发布人', render: (_: unknown, v) => v.publishedByName ?? v.createdByName ?? '系统' },
            { title: '时间', dataIndex: 'publishedAt', render: when },
            {
              title: 'prompt',
              dataIndex: 'promptHash',
              render: (h: string | null) => <Typography.Text code>{h?.slice(0, 12)}</Typography.Text>,
            },
            { title: '变更说明', dataIndex: 'changeNote' },
            {
              title: '',
              render: (_: unknown, v) =>
                editable && v.id !== currentId ? (
                  <Button size="small" onClick={() => setTarget(v)}>
                    以此版本回滚
                  </Button>
                ) : v.id === currentId ? (
                  <Status kind="live" />
                ) : null,
            },
          ]}
        />
      </StateView>
      {q.data && q.isFetchNextPageError && <ErrorAlert error={q.error} onRetry={() => void q.fetchNextPage()} />}
      {q.hasNextPage && (
        <Button style={{ marginTop: 12 }} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          更早的
        </Button>
      )}
      <RollbackModal
        target={target}
        onClose={() => setTarget(null)}
        onDone={(v, t) => {
          setTarget(null);
          onRolledBack();
          setNotice(rollbackNotice(v, t));
        }}
      />
    </Card>
  );
});
