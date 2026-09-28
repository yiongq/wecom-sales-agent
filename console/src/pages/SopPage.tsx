// 销售话术页（spec「销售话术（B、C 页）」）。第 5.1 步做了页头的状态句、额度条和目录（sop/ 下）：
// 状态句「线上v2 · 老板发布于9月25日 18:30 · 草稿改了2节」；额度条按服务端同一口径实时算（含还没保存的改动）；
// 目录保持 prompt 的原顺序，分段筛选、锁与锁定原因、键盘，选中的节写进 URL 的 section；宽 <1280 时目录换成下拉。
// 第 5.2 步做了中栏（sop/SopEditor.tsx）：节标题与说明行、固定规则节的只读说明、按 markdown 显示的编辑器（芯片、图标、改动标记）。
// 第 5.3 步：自动保存（sop/autosave.ts：停止输入 1.5 秒后存、带 rev、失败退避重试、⌘S，409 停住并冻结编辑器，载入最新草稿以后
// 没存上的节以对比形式留着），状态句末尾的保存状态；离开保护管到自动保存还没存上的内容；三栏的布局（右栏是检查清单与
// 「话术里可以点名的工具」，1280–1439 时检查清单挪到目录下面，<1280 时落到编辑器下面，sop.css）。
// 检查与发布（第 6 步）、版本记录（第 7 步）还是 01 的做法：页头右侧是检查、发布、丢弃，检查结果在右栏的清单里，
// 逐节对比和版本历史在页面底部。
// 匿名（demo）只拿到已发布版本的节，全部只读。
// 出错就地显示（ErrorAlert，文案取 ERROR_COPY），成功只报 toast；丢弃走 ConfirmDanger；有没保存的改动时拦下离开这一页的跳转
import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Alert, Button, Card, Collapse, Descriptions, Empty, Input, Modal, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { memo, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnonSopOverview,
  DraftCheck,
  SectionSpecView,
  SopOverview,
  SopSectionText,
  SopVersion,
} from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, HttpError, unwrap } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { errorCopy } from '../parts/errors.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { toast } from '../parts/toast.js';
import { LEAVING_PAGE, useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { SectionDiff } from '../SectionDiff.js';
import { useViewport } from '../shell/hooks.js';
import { PageHeader } from '../shell/PageHeader.js';
import { type DraftEdit, useAutosave } from '../sop/autosave.js';
import { Directory, DirectorySelect, type SelectVia } from '../sop/Directory.js';
import { SectionPane, SopEditor } from '../sop/SopEditor.js';
import {
  anonOutline,
  anonStatus,
  bodyWithoutHeading,
  draftChars,
  memberOutline,
  memberStatus,
  type OutlineFilter,
  type OutlineRow,
  PREAMBLE_NAME,
  quotaModel,
  resolveSection,
  unsavedEdits,
  withSavedDraft,
} from '../sop/outline.js';
import { QuotaBar } from '../sop/QuotaBar.js';
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
const headingOf = (spec: readonly SectionSpecView[], key: string | null): string =>
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
}: {
  toc: ReactNode;
  main: ReactNode;
  check?: ReactNode;
  tools?: ReactNode;
  editor: RefObject<HTMLDivElement | null>;
}) {
  const wide = useViewport() === 'wide';
  return (
    <div className="sop-layout">
      <div className={`sop-body${wide ? '' : ' is-narrow'}`}>
        <div className="sop-col-toc">{toc}</div>
        <div ref={editor} className="sop-col-main sop-editor">
          {main}
        </div>
        {check && <div className="sop-col-check">{check}</div>}
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

/** 409 以后没存上的节：载入最新草稿之前 loaded 为 false（编辑器还冻着、显示你写的）；载入以后有左右对比 */
interface Lost {
  edits: DraftEdit[];
  error: unknown;
  loaded: LostSection[] | null;
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
  const [check, setCheck] = useState<DraftCheck | null>(null);
  const [rejected, setRejected] = useState<HttpError | null>(null);
  const [conflict, setConflict] = useState<{ keys: string[]; current: SopSectionText[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<OutlineFilter>('all');
  const [lost, setLost] = useState<Lost | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<unknown>(null);

  const originalBody = (k: string): string => {
    const s = spec.find((x) => x.key === k)!;
    return bodyOf(current.sections.find((x) => x.key === k)?.text ?? '', s.heading);
  };
  // 本地改过、还没存进草稿的节（规范化以后比，改回原样不算）：自动保存要发的就是它们
  const unsaved = useMemo(() => unsavedEdits(spec, current.sections, edits), [spec, current.sections, edits]);
  // 检查结果、发布被拒、冲突都是对某一份草稿说的：草稿存了、丢了、发布了或者回滚过，就都作废。
  // 引用不变，版本历史（memo）才不会每敲一个字跟着重渲
  const clearResults = useCallback((): void => {
    setCheck(null);
    setRejected(null);
    setConflict(null);
  }, []);
  const saver = useAutosave({
    enabled: editable,
    unsaved,
    base: { rev: draft?.rev ?? null, basedOn: draft?.basedOn ?? published.id },
    send: (list, base) => unwrap(api.sop.draft.$put({ json: { basedOn: base.basedOn, rev: base.rev, edits: list } })),
    onSaved: (v) => {
      qc.setQueryData<SopOverview | AnonSopOverview>(sopQuery.queryKey, (old) => (old && 'spec' in old ? withSavedDraft(old, v) : old));
      clearResults();
    },
    onConflict: (list, e) => setLost({ edits: list, error: e, loaded: null }),
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

  // 409 以后：重取 /sop，编辑器换成最新草稿，没存上的节连同载入时草稿里的写法留着对比，自动保存接着来
  const reloadLatest = async (): Promise<void> => {
    setReloading(true);
    setReloadError(null);
    try {
      const fresh = await qc.fetchQuery({ ...sopQuery, staleTime: 0 });
      if (!('spec' in fresh)) return;
      const latest = fresh.draft ?? fresh.published;
      const loaded = (lost?.edits ?? []).map((e): LostSection => {
        const s = fresh.spec.find((x) => x.key === e.key);
        return {
          key: e.key,
          name: s?.heading ?? PREAMBLE_NAME,
          latest: bodyOf(latest.sections.find((x) => x.key === e.key)?.text ?? '', s?.heading ?? null),
          mine: e.body,
        };
      });
      setEdits({});
      clearResults();
      setLost(loaded.length ? { edits: [], error: null, loaded } : null);
      saver.resume();
    } catch (e) {
      setReloadError(e);
    } finally {
      setReloading(false);
    }
  };
  const closeLost = useCallback(() => setLost(null), []);

  const runCheck = () =>
    run(async () => {
      setRejected(null);
      setConflict(null);
      setCheck(await unwrap(api.sop.draft.check.$post()));
    });
  const publish = () =>
    run(async () => {
      setRejected(null);
      setConflict(null);
      try {
        const v = await unwrap(api.sop.draft.publish.$post({ json: { rev: draft!.rev, changeNote: note } }));
        toast(`已发布v${v.versionNo}`);
        setPublishing(false);
        setNote('');
        clearResults();
        await refresh();
      } catch (e) {
        setPublishing(false);
        if (e instanceof HttpError && e.body.error === 'contract') setRejected(e);
        else if (e instanceof HttpError && e.body.error === 'sop_conflict')
          setConflict({ keys: e.body.keys ?? [], current: e.body.current ?? [] });
        else throw e;
      }
    });
  // 失败时也关掉确认框，错误在页面顶上就地显示
  const discard = () =>
    run(async () => {
      try {
        await unwrap(api.sop.draft.discard.$post({ json: { rev: draft!.rev } }));
      } finally {
        setDiscarding(false);
      }
      clearResults();
      toast('草稿已丢弃');
      await refresh();
    });

  const violations = rejected ? (rejected.body.violations ?? []) : (check?.violations ?? null);
  const rows = memberOutline({
    spec,
    packSections: pack?.sopSections,
    published: published.sections,
    current: current.sections,
    edits,
    violations,
  });
  const editor = useRef<HTMLDivElement>(null);
  const nav = useSectionNav(rows, editor);
  const tools = pack?.vocabulary.tools;
  const section = spec.find((s) => s.key === nav.section);
  const row = rows.find((r) => r.key === nav.section);
  const quota = quotaModel(rows, draftChars(spec, current.sections, edits), budget.limit);
  const changed = rows.filter((r) => r.changed);
  const textOf = (v: SopVersion, k: string): string => v.sections.find((s) => s.key === k)?.text ?? '';
  const draftChanged = draft ? spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key)) : [];
  // 检查、发布、丢弃都是对存下来的草稿做的：还有没存上的改动、请求在路上、409 停住时不能点
  const settled = !!draft && unsaved.length === 0 && !saving && !frozen;
  const saveError = saver.status.kind === 'failed' && errorCopy(saver.status.error).place !== 'inline' ? saver.status.error : null;
  const hasBanners = refetchError !== null || saveError !== null || frozen || lost?.loaded != null || reloadError !== null;
  const hasNotices = error !== null || !!draft?.stale || !!rejected || !!check?.rebase.needed || !!conflict;

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
              <Button disabled={!settled} loading={busy} onClick={() => void runCheck()}>
                检查
              </Button>
              <Button disabled={!settled} loading={busy} onClick={() => setPublishing(true)}>
                发布
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
            <ConflictBanner
              error={saver.status.kind === 'conflict' ? saver.status.error : null}
              names={(lost?.edits ?? []).map((e) => headingOf(spec, e.key))}
              loading={reloading}
              onReload={() => void reloadLatest()}
            />
          )}
          {reloadError !== null && <ErrorAlert error={reloadError} onRetry={() => void reloadLatest()} />}
          {lost?.loaded && <LostEdits items={lost.loaded} onClose={closeLost} />}
        </div>
      )}
      <QuotaBar model={quota} />
      {hasNotices && (
        <Space orientation="vertical" size="middle" className="sop-notices">
          {error !== null && <ErrorAlert error={error} />}
          {draft?.stale && <Alert type="info" showIcon title="草稿打开之后发布过新版本，发布时自动合并" />}
          {rejected && <ErrorAlert error={rejected} />}
          {check?.rebase.needed && !rejected && (
            <Alert
              type={check.rebase.conflicts.length ? 'error' : 'info'}
              title={
                check.rebase.conflicts.length
                  ? `这几节在你编辑期间被别人改过：${check.rebase.conflicts.map((k) => headingOf(spec, k)).join('、')}。` +
                    '这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在当前版本上重做。'
                  : '草稿基于的版本已过期，发布时会自动合并别人的改动'
              }
            />
          )}
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
              vocabulary={pack?.vocabulary}
              onChange={(v) => {
                setEdits((e) => ({ ...e, [section.key]: v }));
                saver.edited();
              }}
            />
          )
        }
        check={editable && <CheckCard spec={spec} violations={violations} check={check} />}
        tools={tools && Object.keys(tools).length > 0 && <ToolsCard tools={tools} />}
      />

      <Space orientation="vertical" size="middle" className="sop-after">
        {draft && <DraftDiff spec={spec} published={published} draft={draft} />}
        <History editable={editable} currentId={published.id} onRolledBack={clearResults} />
      </Space>

      <Modal
        destroyOnHidden
        open={publishing}
        title="发布草稿"
        onCancel={() => setPublishing(false)}
        footer={
          <>
            <Button onClick={() => setPublishing(false)}>取消</Button>
            <PrimaryButton disabled={!note.trim()} loading={busy} onClick={() => void publish()}>
              发布
            </PrimaryButton>
          </>
        }
      >
        <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
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

/**
 * 草稿与已发布版本的逐节对比：只列改过的可编辑节，展开才建编辑器。
 * 它和版本历史都用 memo 包着：编辑器每敲一个字 MemberSop 都重渲，antd 的 Table、Collapse 跟着重渲时会在提交后
 * 再排一次更新，每个字提交两次；自动连按（走查脚本）时这些接连的更新偶尔被 React 当成死循环（#185）
 */
const DraftDiff = memo(function DraftDiff({
  spec,
  published,
  draft,
}: {
  spec: readonly SectionSpecView[];
  published: SopVersion;
  draft: SopVersion;
}) {
  const textOf = (v: SopVersion, key: string): string => v.sections.find((s) => s.key === key)?.text ?? '';
  const changed = spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key));
  return (
    <Card size="small" title={`与已发布v${published.versionNo}的逐节对比`}>
      {changed.length === 0 ? (
        <Typography.Text type="secondary">草稿里的可编辑节与已发布版本相同</Typography.Text>
      ) : (
        <Collapse
          items={changed.map((s) => ({
            key: s.key,
            label: s.heading ?? PREAMBLE_NAME,
            children: (
              <SectionDiff
                before={bodyOf(textOf(published, s.key), s.heading)}
                after={bodyOf(textOf(draft, s.key), s.heading)}
                beforeLabel={`已发布v${published.versionNo}`}
                afterLabel="草稿"
              />
            ),
          }))}
        />
      )}
    </Card>
  );
});

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
  const qc = useQueryClient();
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
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** 回滚后的新版本与目标版本的固定规则不同（sameHashAsTarget 为 false）时的说明 */
  const [notice, setNotice] = useState<string | null>(null);

  const rollback = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const v = await unwrap(api.sop.versions[':id'].rollback.$post({ param: { id: target.id }, json: { changeNote: note } }));
      setTarget(null);
      setNote('');
      onRolledBack();
      await qc.invalidateQueries({ queryKey: ['sop'] });
      await qc.invalidateQueries({ queryKey: ['sop-versions'] });
      toast(`已回滚到v${target.versionNo}：新版本v${v.versionNo}`);
      setNotice(
        v.sameHashAsTarget
          ? null
          : `v${target.versionNo}之后代码里的固定规则改过，固定规则节用的是现在的写法，所以v${v.versionNo}不会和v${target.versionNo}完全一样。`,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    setTarget(null);
    setError(null);
  };

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
      <Modal
        destroyOnHidden
        open={!!target}
        title={`回滚到v${target?.versionNo ?? ''}`}
        onCancel={close}
        footer={
          <>
            <Button onClick={close}>再看看</Button>
            <PrimaryButton disabled={!note.trim()} loading={busy} onClick={() => void rollback()}>
              回滚到v{target?.versionNo ?? ''}
            </PrimaryButton>
          </>
        }
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Descriptions
            size="small"
            column={1}
            items={[{ label: '说明', children: '取这个版本的可编辑节、现在的固定规则节，生成并发布一个新版本；已有的草稿不动。' }]}
          />
          <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
          {error !== null && <ErrorAlert error={error} />}
        </Space>
      </Modal>
    </Card>
  );
});
