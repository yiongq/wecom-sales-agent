// 话术页的发布（spec「销售话术 · 发布条」「发布抽屉」，设计系统 §5.13、§5.16 与 B 页）：
// - PublishBar：常驻的发布条（ActionBar，吸在面板底部）。左边是摘要「草稿改了2节（话术原则、异议处理）· 1个问题要改 · 字数2,303 / 2,658」，
//   发布成功以后是「已发布v3（改了…）· 客户下一句就用新话术」和文字按钮「回滚到v2」，保留到下一次改动（由页面清掉），不弹 toast。
//   条窄了放不下时省略的是前面那句，「回滚到v2」不跟着省略（它在 Tab 顺序里，不能被裁到看不见）。
//   自动保存没保存上（连不上、别的 4xx；409 另有横幅）时左边先写 danger 的「没保存上 · 重试」，后面接着原来的摘要：
//   页头吸顶时状态句藏起来，在一节长正文的下半截打字也看得见、点得到。读屏由页面上看不见的那一处念（SaveParts 的 SaveLive），这里不另设 status。
//   右边是「发布…」不能点的原因、次要按钮「查看改动」、主按钮「发布…」：不能点时 aria-disabled（PrimaryButton 的 blocked），
//   有问题时点它跳到第一个问题。
// - PublishDrawer：640 宽的发布抽屉，从上到下是冲突（检查报了在你编辑期间被别人改过的节、发布答 409 时：
//   「有2节在你改的同时被改了：话术原则」和「去合并」，第 8 步）、检查清单（没过的项点了关抽屉并定位）、替换说明、逐节改动（行内 / 并排）、
//   变更说明（预填改了哪几节，要在预填之外再写至少一个字），底部「取消」「发布」，「发布」不能点时旁边写原因。
//   发布没成功（422、409 以外的）时错误写在最上面，出来时滚进视口，它的「重试」与「发布」同样先看能不能发布。
//   发布请求在路上时关不掉（「取消」、关闭按钮不能点，旁边写「正在发布…」；Esc、点遮罩也不管用）：关上并不撤回请求，
//   没成功时错误也没处写。
//   别人在这期间发布过（线上已是更新的一版）时，逐节改动左边那一版不叫「线上」（publish.ts 的 baseName）。
// - ChangesDrawer：「查看改动」与中栏的「查看本节改动」打开的逐节改动，只看。
// 抽屉关着时不挂（destroyOnHidden）：话术页每敲一个字整页重渲，关着的弹层不能跟着重渲（第 5.1 步 #185 的教训）
import { Alert, Button, Drawer, type GetRef, Input } from 'antd';
import { CircleCheck, CircleX, Info, PencilLine, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
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
import { SAVE_FAILED } from './SaveParts.js';
import type { PublishedHead, SectionChange } from './outline.js';
import type { LocatedViolation, ProblemTarget } from './problems.js';
import { conflictTitle } from './merge.js';
import {
  baseName,
  changedText,
  diffAgainst,
  drawerBlock,
  noteReady,
  type PublishedResult,
  publishedText,
  replaceLine,
  sameAs,
} from './publish.js';
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
  /** 草稿没有改动时左边的摘要：「草稿和线上一样」；比较的那一版不是线上版本时「草稿和v2一样（线上已是v3）」（sameAs） */
  unchanged?: string;
  /** 自动保存没保存上（不含 409）：左边先写「没保存上 · 重试」，「重试」马上存（同状态句的「重试」） */
  saveFailed?: boolean;
  onRetrySave?: () => void;
  onPublish: (trigger: HTMLElement) => void;
  /** 有问题时点「发布…」：跳到第一个问题 */
  onJump: () => void;
  onChanges: (trigger: HTMLElement) => void;
  /** 「回滚到v2」：点的那个按钮（回滚确认关上以后焦点还给它） */
  onRollback: (trigger: HTMLElement) => void;
  /** 「发布…」：完成合并以后回到发布抽屉，抽屉关上时焦点还给它 */
  publishRef?: Ref<HTMLButtonElement>;
}

export function PublishBar(p: PublishBarProps) {
  const reasonId = useId();
  const quota = `字数${digits(p.chars)} / ${digits(p.limit)}`;
  const unchanged = p.unchanged ?? '草稿和线上一样';
  let icon: ReactNode;
  let summary: ReactNode;
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
            <button type="button" className="sop-text-btn" onClick={(e) => p.onRollback(e.currentTarget)}>
              回滚到v{p.result.previous.versionNo}
            </button>
          </span>
        )}
      </>
    );
  } else if (p.changed.length === 0) {
    icon = <Icon of={CircleCheck} className="sop-bar-icon" />;
    summary = unchanged;
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
  if (p.saveFailed) {
    // 没保存上排在最前：摘要换成「没保存上 · 重试」，原来的摘要降成补充接在后面（窄了先省略它）
    const rest = p.changed.length ? changedText(p.changed) : unchanged;
    icon = <Icon of={CircleX} className="sop-bar-icon is-danger" />;
    summary = (
      <span className="sop-bar-failed">
        {SAVE_FAILED}
        <Sep />
        <button type="button" className="sop-save-retry" onClick={p.onRetrySave}>
          重试
        </button>
      </span>
    );
    hint = (
      <span className="sop-bar-hint-text">
        <Sep />
        {cjk(rest)}
        {p.changed.length > 0 && p.problems > 0 && (
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
  const { block, publishRef } = p;
  return (
    // display: contents：发布条照样吸在面板底部（sticky 的范围是面板，不是这一层）
    <div className={p.saveFailed ? 'sop-publish-bar is-save-failed' : 'sop-publish-bar'}>
      <ActionBar label="发布" icon={icon} summary={summary} hint={hint} note={block && <span id={reasonId}>{cjk(block.reason)}</span>}>
        <Button disabled={p.changed.length === 0} onClick={(e) => p.onChanges(e.currentTarget)}>
          查看改动
        </Button>
        <PrimaryButton
          ref={publishRef}
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
 * 话术页的抽屉（§5.13：L 640 发布、查看改动，S 420 版本记录）：头 56，标题 16/24/600 后面可以跟一句 13 text-2 的状态，
 * 右边 28 的关闭按钮；头下没有分隔线，内容滚动以后才出现；体自己滚动。焦点由页面还给打开它的按钮（focusTriggerAfterClose 关掉，
 * antd 还的是打开时的 activeElement，Safari 点按钮不给按钮焦点）。busy 时关不掉：关闭按钮不能点，Esc、点遮罩不调 onClose
 */
export function SopDrawer({
  open,
  title,
  status,
  footer,
  busy = false,
  size = 640,
  closeLabel = '关闭',
  onClose,
  afterClose,
  children,
}: {
  open: boolean;
  title: string;
  /** 标题后面的状态，数组时各段用 Sep 隔开 */
  status?: string | readonly string[];
  footer?: ReactNode;
  busy?: boolean;
  size?: 420 | 640;
  closeLabel?: string;
  onClose: () => void;
  afterClose?: () => void;
  children: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <Drawer
      open={open}
      onClose={busy ? undefined : onClose}
      afterOpenChange={(visible) => {
        if (visible) return;
        setScrolled(false);
        afterClose?.();
      }}
      destroyOnHidden
      focusable={{ focusTriggerAfterClose: false }}
      size={size}
      closable={false}
      title={
        <>
          {cjk(title)}
          {status && <span className="sop-drawer-status">{cjk(status)}</span>}
        </>
      }
      extra={<IconButton icon={X} label={closeLabel} tip="关闭" placement="bottomRight" disabled={busy} onClick={onClose} />}
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

/**
 * 逐节改动的一块：标题行（左边标题或计数，右边行内 / 并排），下面是各节的差异；base 是改动相对的那一版、online 是现在的
 * 线上版本（左边那一版的名字 baseName、没有改动时的那句 sameAs 照它们写）
 */
function ChangesBlock({
  head,
  changes,
  base,
  online,
  level,
}: {
  head: ReactNode;
  changes: readonly SectionChange[];
  base: Pick<SopVersion, 'versionNo'>;
  online: Pick<SopVersion, 'versionNo'>;
  /** 节名的标题层级（DiffList） */
  level?: 3 | 4;
}) {
  const [mode, setMode] = useDiffMode();
  return (
    <>
      <div className="sop-changes-head">
        {head}
        <DiffModeToggle mode={mode} onChange={setMode} />
      </div>
      {changes.length ? (
        <DiffList items={changes} mode={mode} labels={[baseName(base, online), '草稿']} level={level} />
      ) : (
        <p className="sop-changes-none">{cjk(`草稿${sameAs(base, online)}`)}</p>
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
  online,
  onClose,
  afterClose,
}: {
  open: boolean;
  /** 只看这一节时是节名 */
  section: string | null;
  changes: readonly SectionChange[];
  /** 改动相对的那一版：页面上的线上版本；草稿跟不上线上版本时是草稿所基于的那一版 */
  published: SopVersion;
  /** 现在的线上版本（同发布抽屉的 replacing） */
  online: PublishedHead;
  onClose: () => void;
  afterClose?: () => void;
}) {
  return (
    <SopDrawer
      open={open}
      title={section === null ? '草稿的改动' : `「${section}」的改动`}
      status={diffAgainst(published, online)}
      onClose={onClose}
      afterClose={afterClose}
    >
      <ChangesBlock
        head={<span className="sop-changes-count">{changes.length ? `改了${digits(changes.length)}节` : ''}</span>}
        changes={changes}
        base={published}
        online={online}
        level={3}
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
  /** 逐节改动相对的那一版：页面上的线上版本；草稿跟不上线上版本时是草稿所基于的那一版 */
  published: SopVersion;
  /** 将被替换的线上版本：多半就是 published；检查发现别人在这期间发布过时是那时的线上版本 */
  replacing: PublishedHead;
  now: number;
  changes: readonly SectionChange[];
  /** 最近一次检查（或发布被拒）的问题，没跑过是 null */
  located: readonly LocatedViolation[] | null;
  budget: CheckBudget | null;
  check: DrawerCheck;
  /** 检查报了（或发布答 409）在你编辑期间被别人改过的节（节名） */
  conflicts: readonly string[];
  /** 「去合并」：先存、重查，进了合并模式（第 8 步）才关上抽屉；mergeBusy 是在等的时候（按钮转圈） */
  onMerge: () => void;
  mergeBusy: boolean;
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
  const mergeRef = useRef<HTMLButtonElement>(null);
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
  // 按钮旁边写的原因：请求在路上时说「取消」为什么不能点
  const reason = p.publishing ? '正在发布…' : block?.reason;
  // 点「发布」（或发布没成功时错误里的「重试」）：不能发布时不发，去原因所在的地方（没过的第一项、没检查上的「重试」、说明框）
  const submit = (): void => {
    if (!block) p.onPublish();
    else if (block.focus === 'note') noteRef.current?.focus({ cursor: 'end' });
    else if (block.focus === 'checks') checksRef.current?.querySelector<HTMLElement>('button')?.focus();
    else if (block.focus === 'merge') mergeRef.current?.focus();
  };
  return (
    <SopDrawer
      open={p.open}
      title="发布草稿"
      busy={p.publishing}
      onClose={p.onClose}
      afterClose={p.afterClose}
      footer={
        <>
          {reason && (
            <span id={reasonId} className="sop-drawer-reason">
              {cjk(reason)}
            </span>
          )}
          <Button disabled={p.publishing} onClick={p.onClose}>
            取消
          </Button>
          <PrimaryButton blocked={!!block} loading={p.publishing} aria-describedby={block ? reasonId : undefined} onClick={submit}>
            发布
          </PrimaryButton>
        </>
      }
    >
      <div className="sop-publish">
        {error !== null && error !== undefined && (
          <div ref={errorRef} className="sop-publish-error">
            <ErrorAlert error={error} onRetry={submit} />
          </div>
        )}
        {p.conflicts.length > 0 && (
          <Alert
            className="sop-publish-conflict"
            type="error"
            showIcon
            title={cjk(conflictTitle(p.conflicts))}
            action={
              <Button ref={mergeRef} size="small" loading={p.mergeBusy} onClick={p.onMerge}>
                去合并
              </Button>
            }
          />
        )}
        <div ref={checksRef}>
          <CheckList
            landmark={false}
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
            base={p.published}
            online={p.replacing}
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
