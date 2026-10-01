// 话术页的发布（spec「销售话术 · 发布条」「发布抽屉」，设计系统 §5.13、§5.16 与 B 页）：
// - PublishBar：常驻的发布条（ActionBar，吸在面板底部）。左边是摘要「草稿改了2节（话术原则、异议处理）· 1个问题要改 · 字数2,303 / 2,658」，
//   发布成功以后是「已发布v3（改了…）· 客户下一句就用新话术」和文字按钮「回滚到v2」，保留到下一次改动（由页面清掉），不弹 toast。
//   条窄了放不下时省略的是前面那句，「回滚到v2」不跟着省略（它在 Tab 顺序里，不能被裁到看不见）。
//   右边是「发布…」不能点的原因、次要按钮「查看改动」、主按钮「发布…」：不能点时 aria-disabled（PrimaryButton 的 blocked），
//   有问题时点它跳到第一个问题。
// - PublishDrawer：640 宽的发布抽屉，从上到下是检查清单（没过的项点了关抽屉并定位）、替换说明、逐节改动（行内 / 并排）、
//   变更说明（预填改了哪几节，要在预填之外再写至少一个字），底部「取消」「发布」，「发布」不能点时旁边写原因。
//   发布没成功（422、409 以外的）时错误写在最上面，出来时滚进视口。
// - ChangesDrawer：「查看改动」与中栏的「查看本节改动」打开的逐节改动，只看。
// 抽屉关着时不挂（destroyOnHidden）：话术页每敲一个字整页重渲，关着的弹层不能跟着重渲（第 5.1 步 #185 的教训）
import { Alert, Button, Drawer, type GetRef, Input } from 'antd';
import { CircleCheck, Info, PencilLine, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { SectionSpecView, SopVersion } from '../../../src/shared/console-api.js';
import { clockTime, digits } from '../../../src/shared/format.js';
import { ActionBar } from '../parts/ActionBar.js';
import { CheckList } from '../parts/CheckList.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { cjk, Sep } from '../typography.js';
import { DiffList, DiffModeToggle, useDiffMode } from './DiffView.js';
import type { PublishedHead, SectionChange } from './outline.js';
import type { LocatedViolation, ProblemTarget } from './problems.js';
import { changedText, drawerBlock, noteReady, type PublishedResult, publishedText, replaceLine } from './publish.js';
import { type CheckBudget, checkItems } from './SideCards.js';

// ---------------- 发布条 ----------------

export interface PublishBarProps {
  /** 发布成功以后的那句；有了新的改动由页面清掉 */
  result: PublishedResult | null;
  /** 相对线上改过的节名（含本地还没保存的改动） */
  changed: readonly string[];
  /** 最近一次检查（或发布被拒）的问题数 */
  problems: number;
  chars: number;
  limit: number;
  /** 「发布…」不能点的原因（publish.ts 的 barBlock） */
  block: { reason: string; jump: boolean } | null;
  /** 点了「发布…」，正在先存没存上的改动 */
  opening: boolean;
  onPublish: (trigger: HTMLElement) => void;
  /** 有问题时点「发布…」：跳到第一个问题 */
  onJump: () => void;
  onChanges: (trigger: HTMLElement) => void;
  onRollback: () => void;
}

export function PublishBar(p: PublishBarProps) {
  const reasonId = useId();
  const quota = `字数${digits(p.chars)} / ${digits(p.limit)}`;
  let icon: ReactNode;
  let summary: string;
  let hint: ReactNode;
  if (p.result && p.changed.length === 0) {
    icon = <Icon of={CircleCheck} className="sop-bar-icon is-success" />;
    summary = publishedText(p.result);
    hint = (
      <>
        <span className="sop-bar-hint-text">
          <Sep />
          {cjk('客户下一句就用新话术')}
        </span>
        {p.result.previous && (
          <span className="sop-bar-hint-action">
            <Sep />
            <button type="button" className="sop-text-btn" onClick={p.onRollback}>
              回滚到v{p.result.previous.versionNo}
            </button>
          </span>
        )}
      </>
    );
  } else if (p.changed.length === 0) {
    icon = <Icon of={CircleCheck} className="sop-bar-icon" />;
    summary = '草稿和线上一样';
    hint = (
      <span className="sop-bar-hint-text">
        <Sep />
        {quota}
      </span>
    );
  } else {
    icon =
      p.problems > 0 ? <Icon of={TriangleAlert} className="sop-bar-icon is-warning" /> : <Icon of={PencilLine} className="sop-bar-icon" />;
    summary = changedText(p.changed);
    hint = (
      <span className="sop-bar-hint-text">
        {p.problems > 0 && (
          <>
            <Sep />
            <span className="sop-bar-problems">{digits(p.problems)}个问题要改</span>
          </>
        )}
        <Sep />
        {quota}
      </span>
    );
  }
  const { block } = p;
  return (
    // display: contents：发布条照样吸在面板底部（sticky 的范围是面板，不是这一层）
    <div className="sop-publish-bar">
      <ActionBar label="发布" icon={icon} summary={summary} hint={hint} note={block && <span id={reasonId}>{cjk(block.reason)}</span>}>
        <Button disabled={p.changed.length === 0} onClick={(e) => p.onChanges(e.currentTarget)}>
          查看改动
        </Button>
        <PrimaryButton
          blocked={!!block}
          loading={p.opening}
          aria-describedby={block ? reasonId : undefined}
          onClick={(e) => {
            if (!block) p.onPublish(e.currentTarget);
            else if (block.jump) p.onJump();
          }}
        >
          发布…
        </PrimaryButton>
      </ActionBar>
    </div>
  );
}

// ---------------- 抽屉 ----------------

/**
 * 话术页的抽屉（§5.13 L 640）：头 56，标题 16/24/600 后面可以跟一句 13 text-2 的状态，右边 28 的关闭按钮；头下没有分隔线，
 * 内容滚动以后才出现；体自己滚动。焦点由页面还给打开它的按钮（focusTriggerAfterClose 关掉，antd 还的是打开时的 activeElement，
 * Safari 点按钮不给按钮焦点）
 */
function SopDrawer({
  open,
  title,
  status,
  footer,
  onClose,
  afterClose,
  children,
}: {
  open: boolean;
  title: string;
  status?: string;
  footer?: ReactNode;
  onClose: () => void;
  afterClose?: () => void;
  children: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      afterOpenChange={(visible) => {
        if (visible) return;
        setScrolled(false);
        afterClose?.();
      }}
      destroyOnHidden
      focusable={{ focusTriggerAfterClose: false }}
      size={640}
      closable={false}
      title={
        <>
          {cjk(title)}
          {status && <span className="sop-drawer-status">{cjk(status)}</span>}
        </>
      }
      extra={<IconButton icon={X} label="关闭" placement="bottomRight" onClick={onClose} />}
      rootClassName="sop-drawer"
      classNames={{ header: scrolled ? 'is-scrolled' : undefined }}
      footer={footer}
    >
      <div className="sop-drawer-scroll" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
        {children}
      </div>
    </Drawer>
  );
}

/** 逐节改动的一块：标题行（左边标题或计数，右边行内 / 并排），下面是各节的差异 */
function ChangesBlock({ head, changes, published }: { head: ReactNode; changes: readonly SectionChange[]; published: SopVersion }) {
  const [mode, setMode] = useDiffMode();
  return (
    <>
      <div className="sop-changes-head">
        {head}
        <DiffModeToggle mode={mode} onChange={setMode} />
      </div>
      {changes.length ? (
        <DiffList items={changes} mode={mode} labels={[`线上v${published.versionNo ?? '—'}`, '草稿']} />
      ) : (
        <p className="sop-changes-none">{cjk('草稿和线上一样')}</p>
      )}
    </>
  );
}

/** 「查看改动」（全部改过的节）与「查看本节改动」（只有这一节） */
export function ChangesDrawer({
  open,
  section,
  changes,
  published,
  onClose,
  afterClose,
}: {
  open: boolean;
  /** 只看这一节时是节名 */
  section: string | null;
  changes: readonly SectionChange[];
  published: SopVersion;
  onClose: () => void;
  afterClose?: () => void;
}) {
  return (
    <SopDrawer
      open={open}
      title={section === null ? '草稿的改动' : `「${section}」的改动`}
      status={`相对线上v${published.versionNo ?? '—'}`}
      onClose={onClose}
      afterClose={afterClose}
    >
      <ChangesBlock
        head={<span className="sop-changes-count">{changes.length ? `改了${digits(changes.length)}节` : ''}</span>}
        changes={changes}
        published={published}
      />
    </SopDrawer>
  );
}

/** 抽屉里的检查：打开时跑的那一次 */
export interface DrawerCheck {
  running: boolean;
  failed: boolean;
  at: number | null;
  retry: () => void;
}

function CheckMeta({ check }: { check: DrawerCheck }) {
  if (check.running) return <>{cjk('正在检查…')}</>;
  if (check.failed)
    return (
      <span className="sop-check-failed">
        没检查上
        <Sep />
        <button type="button" className="sop-save-retry" onClick={check.retry}>
          重试
        </button>
      </span>
    );
  return check.at === null ? null : <>{`检查于${clockTime(check.at)}`}</>;
}

export interface PublishDrawerProps {
  open: boolean;
  onClose: () => void;
  afterClose?: () => void;
  spec: readonly SectionSpecView[];
  /** 页面上的线上版本：逐节改动相对它 */
  published: SopVersion;
  /** 将被替换的线上版本：多半就是 published；检查发现别人在这期间发布过时是那时的线上版本 */
  replacing: PublishedHead;
  now: number;
  changes: readonly SectionChange[];
  /** 最近一次检查（或发布被拒）的问题，没跑过是 null */
  located: readonly LocatedViolation[] | null;
  budget: CheckBudget | null;
  check: DrawerCheck;
  /** 检查报了在你编辑期间被别人改过的节（节名） */
  conflicts: readonly string[];
  note: string;
  prefill: string;
  onNote: (v: string) => void;
  publishing: boolean;
  /** 发布没成功（422、409 以外的） */
  error: unknown;
  onPublish: () => void;
  /** 清单里没过的一项：关抽屉并定位 */
  onLocate: (t: NonNullable<ProblemTarget>) => void;
}

/**
 * 抽屉关上以后要放完收起动画才卸下，这期间照关上那一刻的样子画：发布成功以后线上已经换成新版本，
 * 跟着重画的话收起的那一下会闪成「将替换线上v3」「草稿和线上一样」
 */
export function useShownWhileClosing<T extends { open: boolean }>(props: T): T {
  const [last, setLast] = useState(props);
  // 开着时记下这一次的属性（在渲染时按上一次渲染的值调整）
  if (props.open && last !== props) setLast(props);
  return props.open ? props : { ...last, open: false };
}

export function PublishDrawer(props: PublishDrawerProps) {
  const p = useShownWhileClosing(props);
  const noteId = useId();
  const helpId = useId();
  const reasonId = useId();
  const noteRef = useRef<GetRef<typeof Input.TextArea>>(null);
  const checksRef = useRef<HTMLDivElement>(null);
  // 发布没成功：错误写在抽屉体的最上面，出来的那一刻滚进视口（点「发布」时多半滚到了底下写说明）
  const errorRef = useRef<HTMLDivElement>(null);
  const { error } = p;
  useEffect(() => {
    if (error !== null && error !== undefined) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  const items = checkItems(p.spec, p.located, p.budget, p.onLocate);
  const problems = p.located?.length ?? 0;
  const block = drawerBlock({
    running: p.check.running,
    failed: p.check.failed,
    conflicts: p.conflicts.length,
    problems,
    noteReady: noteReady(p.note, p.prefill),
  });
  // 不能发布时点「发布」：去原因所在的地方（没过的第一项、没检查上的「重试」、说明框）
  const toReason = (): void => {
    if (block?.focus === 'note') noteRef.current?.focus({ cursor: 'end' });
    else if (block?.focus === 'checks') checksRef.current?.querySelector<HTMLElement>('button')?.focus();
  };
  return (
    <SopDrawer
      open={p.open}
      title="发布草稿"
      onClose={p.onClose}
      afterClose={p.afterClose}
      footer={
        <>
          {block && (
            <span id={reasonId} className="sop-drawer-reason">
              {cjk(block.reason)}
            </span>
          )}
          <Button onClick={p.onClose}>取消</Button>
          <PrimaryButton
            blocked={!!block}
            loading={p.publishing}
            aria-describedby={block ? reasonId : undefined}
            onClick={() => (block ? toReason() : p.onPublish())}
          >
            发布
          </PrimaryButton>
        </>
      }
    >
      <div className="sop-publish">
        {error !== null && error !== undefined && (
          <div ref={errorRef} className="sop-publish-error">
            <ErrorAlert error={error} onRetry={p.onPublish} />
          </div>
        )}
        {p.conflicts.length > 0 && (
          <Alert
            type="error"
            showIcon
            title={cjk(`有${p.conflicts.length}节在你改的同时被改了：${p.conflicts.join('、')}`)}
            description={cjk('这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在当前版本上重做。')}
          />
        )}
        <div ref={checksRef}>
          <CheckList
            title="发布前检查"
            summary={p.located ? `${items.filter((i) => i.state === 'pass').length}/${items.length}通过` : undefined}
            meta={<CheckMeta check={p.check} />}
            items={items}
          />
        </div>
        <p className="sop-publish-replace">
          <Icon of={Info} />
          <span>{cjk(replaceLine(p.replacing, p.now))}</span>
        </p>
        <section className="sop-publish-changes" aria-labelledby={`${noteId}-changes`}>
          <ChangesBlock
            head={
              <h3 id={`${noteId}-changes`} className="sop-publish-title">
                {cjk('逐节改动')}
              </h3>
            }
            changes={p.changes}
            published={p.published}
          />
        </section>
        <div className="sop-publish-note">
          <label htmlFor={noteId} className="sop-publish-label">
            {cjk('这次改了什么、为什么')}
          </label>
          <Input.TextArea
            ref={noteRef}
            id={noteId}
            value={p.note}
            onChange={(e) => p.onNote(e.target.value)}
            placeholder="例：客户嫌贵时先问预算上限"
            // 不用 autoSize：它给量高度的影子文本框 setAttribute('style')，页面 CSP 不许内联样式
            rows={4}
            maxLength={500}
            aria-describedby={helpId}
          />
          <p id={helpId} className="sop-publish-help">
            {cjk('预填的是改了哪几节，在后面写上为什么改；会写进版本记录')}
          </p>
        </div>
      </div>
    </SopDrawer>
  );
}
