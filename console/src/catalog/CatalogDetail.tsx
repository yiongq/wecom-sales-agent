// 产品库详情（spec「产品库详情与编辑（E、F 页；L 页下半）」，设计系统 §4.3、§5.9、§5.16、§5.17、§6.4、§6.5、E、F、G、L 页；
// plan 第 10.1、10.2 步）。
// 页头：面包屑「产品库 / 线路 / 条目名」（分组名是纯文本）、标题后跟状态、状态句「13项上架后锁定 · 小林更新于今天10:12」。
// 两栏：主栏按 groups 的顺序排分组卡片，字段按类型渲染（fields/FieldGrid）；副栏吸顶放状态与锁定组、上架前检查、最近更新；
// 宽 <1280 时副栏落到主栏下方（detail.css）。
// 锁定（§6.4）：已上架、可以编辑时，每个锁定组在它第一张整字段锁定的卡片头声明一次：Tag「上架后锁定 · 计价」，下一行写原因；
// 草稿里上架后会锁的字段在标签后提醒；没有编辑权限（非编辑成员、匿名）全是只读文本，不挂锁。
// 改过还没保存的字段标「已改」，可以「撤销这处」；有改动时站内跳转与关页都先确认（不变量 20）。
// 保存（第 10.2 步）：有改动才出现保存条（§5.16），⌘S 同样保存；先按上架前检查的必须项查一遍（与 schema 同判），不合格不发请求，
// 报错落到字段；合格就按打开时的 rev 发补丁（set / unset），存好以后页面换成服务端返回的条目，不弹 toast。服务端 422 的
// issues 落到字段下方、顶部一行汇总；字段下方的报错只给碰过的字段（失焦过，或点过保存）。409 时页头下横幅「这条刚被别人改过」，
// 「载入最新版本」以后你的改动以对比形式留在页头下，逐个「用我的改动」。
// 第 10.3 步：页头「更多」里是「复制为新草稿」，草稿的主按钮是「上架…」（必须项没过时不开确认框，焦点跳到第一处）；
// 页头下是页签「编辑 / 预览」（地址上的 tab，匿名默认预览）；新建的保存就是建草稿，建好以后页面去它的详情。
// 行业包只经 props 进来（/pack 的数据），这里不认具体行业：旅游包与假包走同一套代码。
import { Link } from '@tanstack/react-router';
import { Alert, Button, Dropdown, Tabs } from 'antd';
import { ChevronRight, Clock, Ellipsis, Lock, X } from 'lucide-react';
import { type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { absoluteTime } from '../../../src/shared/format.js';
import { checkItem, type EntityType, valueAt } from '../../../src/shared/pack.js';
import { catalogKind, HttpError } from '../api.js';
import { FieldGrid } from '../fields/FieldGrid.js';
import { formState, type ItemContext, type Payload, pruneHidden, restoreField, submission } from '../fields/model.js';
import { RENDERERS } from '../fields/renderers.js';
import { ActionBar } from '../parts/ActionBar.js';
import { type CheckItem, CheckList } from '../parts/CheckList.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { LEAVING_PAGE, useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
import { blankPayload, copyPayload, inFieldOrder, type ItemTab, withCodeHints } from './actions.js';
import {
  blockOnly,
  cardHasFields,
  cardLocks,
  fieldOfPath,
  issueText,
  itemTitle,
  lockPhrase,
  lockReason,
  lockRows,
  skeletonCardHeight,
  subPathOf,
  type Updated,
  updatedOf,
} from './detail.js';
import { ActivateDialog, CopyDialog } from './ItemDialogs.js';
import { ItemPreview } from './ItemPreview.js';
import {
  type Change,
  changedFields,
  changeList,
  formIssues,
  jumpPlace,
  lockedFieldLabel,
  type Placed,
  placeIssues,
  saveCopy,
  saveSummary,
  touchedPlaces,
  usableChanges,
  visibleErrors,
} from './save.js';

/** 详情页要的一条：成员拿到的有状态与更新人；匿名投影只有编号和内容（都是已上架的） */
export interface DetailItem {
  code: string;
  status?: 'draft' | 'active';
  /** 成员拿到的有：保存的补丁带着它，别人在这之后改过就是 409 */
  rev?: number;
  updatedAt?: string;
  updatedByName?: string | null;
  payload: Payload;
}

export interface CatalogDetailProps {
  /** 产品库分组名（pack.nav.catalogGroup），面包屑的第一段 */
  groupName: string;
  entity: EntityType;
  /** 打开的这一条；新建时 null（空表单） */
  item: DetailItem | null;
  /** 可以编辑（所有者、管理员）：不能时全只读、不挂锁 */
  canEdit: boolean;
  /** demo 匿名：没有状态、更新人，副栏不画 */
  anon: boolean;
  /** 当前时刻：「今天10:12」、月份条的当前月（走查钉住时钟） */
  now: number;
  /** 保存一条已有的：发 PATCH，返回存好的条目（第 10.2 步）。不给就没有保存条 */
  onSave?(body: PatchBody): Promise<DetailItem>;
  /** 409 之后「载入最新版本」：重取这一条 */
  onLoadLatest?(): Promise<DetailItem>;
  /** 新建的保存：POST 建一条草稿（showWhen 没显示的字段已剔除），由页面接着去它的详情（第 10.3 步） */
  onCreate?(payload: Payload): Promise<DetailItem>;
  /** 上架：按眼下条目的 rev 发 activate，返回上架后的条目。给了草稿的页头才有「上架…」 */
  onActivate?(rev: number): Promise<DetailItem>;
  /** 复制为新草稿：用这一条存着的 payload 换掉编号去建，由页面接着去新草稿的详情。给了页头才有「更多」 */
  onCopy?(code: string, payload: Payload): Promise<void>;
  /** 页签「编辑 / 预览」（地址上的 tab）；新建没有页签 */
  tab?: ItemTab;
  onTab?(tab: ItemTab): void;
  /** 本实体已有的编号（列表里取）：复制时撞了提前说 */
  codes?: readonly string[];
  /** 刚建好、刚复制出来的这一条：打开时焦点放在标题上，读屏念这一句（「已建草稿」） */
  arrival?: string;
}

/** 01 的 PATCH /catalog/:kind/:code：set 里的顶层字段整体替换，unset 里的删掉 */
export interface PatchBody {
  rev: number;
  set: Payload;
  unset?: string[];
}

// ---------------- 页头 ----------------

/** 面包屑「产品库 / 线路 / 条目名」（§4.3）：分组名没有自己的页面，是纯文本；实体名链回列表 */
export function Breadcrumb({ group, entity, current }: { group: string; entity: EntityType; current: string }) {
  return (
    <nav className="breadcrumb" aria-label="当前位置">
      <span>{cjk(group)}</span>
      <span className="breadcrumb-sep" aria-hidden="true">
        /
      </span>
      {/* 只在正好是列表页时算「当前」：这里是它下面的一条，不给 aria-current */}
      <Link to="/catalog/$kind" params={{ kind: catalogKind(entity.kind) }} activeOptions={{ exact: true }}>
        {cjk(entity.label)}
      </Link>
      <span className="breadcrumb-sep" aria-hidden="true">
        /
      </span>
      <span className="breadcrumb-current" aria-current="page">
        {cjk(current)}
      </span>
    </nav>
  );
}

/** 「小林更新于今天10:12」，时间悬停看绝对时间 */
function UpdatedPhrase({ u, now }: { u: Updated; now: number }) {
  return (
    <>
      {cjk(`${u.by}更新于`)}
      <span title={absoluteTime(u.iso, now)}>{u.at}</span>
    </>
  );
}

/** 页头的状态句：锁定那一段（能编辑的人才有）与最近更新，中间用 Sep 隔开；两段都没有时不写 */
function statusLine(lock: string | null, u: Updated | null, now: number): ReactNode {
  if (!lock && !u) return undefined;
  return (
    <span>
      {lock ? cjk(lock) : null}
      {lock && u ? <Sep /> : null}
      {u ? <UpdatedPhrase u={u} now={now} /> : null}
    </span>
  );
}

/**
 * 页头的「更多」（§4.3：ellipsis 图标，次要按钮样式 32×32，放在操作区最左）：产品库一条里只有「复制为新草稿」。
 * 菜单开着时按钮的 Tooltip 不压在菜单上。buttonRef 给弹窗关上以后把焦点还回来（打开它的菜单项已经收起了）
 */
function MoreMenu({ onCopy, buttonRef }: { onCopy(): void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items: [{ key: 'copy', label: '复制为新草稿' }],
        onClick: ({ domEvent }) => {
          // 键盘的 Enter 在 keydown 里就点了菜单项，弹窗随即打开、焦点进了弹窗；不拦下默认动作的话，同一次 Enter 的
          // 激活会落到弹窗里有焦点的按钮上（右上角的「关闭」），弹窗刚开就关（真浏览器里才有，happy-dom 不产生这个激活）
          domEvent.preventDefault();
          setOpen(false);
          onCopy();
        },
      }}
    >
      <IconButton
        ref={buttonRef}
        label="更多"
        icon={Ellipsis}
        size={32}
        className="header-more"
        aria-haspopup="menu"
        aria-expanded={open}
        tipOpen={open ? false : undefined}
        placement="bottom"
      />
    </Dropdown>
  );
}

// ---------------- 主栏：分组卡片 ----------------

/** 卡片头的锁定 Tag：前置 12 的 lock（text-3），13/20 text-2，--subtle 底 */
export function LockTag({ text }: { text: string | readonly string[] }) {
  return (
    <span className="lock-tag">
      <Icon of={Lock} size={12} />
      {cjk(text)}
    </span>
  );
}

interface CardProps {
  entity: EntityType;
  group: { key: string; label: string };
  state: Payload;
  /** 打开时的内容，「已改」与撤销的比较基准；新建时不给（没有可以撤回的原文，不标「已改」） */
  original: Payload | undefined;
  ctx: ItemContext;
  onUpdate(fn: (s: Payload) => Payload): void;
  /** 字段下方的报错，按位置（catalog/save.ts 的 placeOf） */
  errors: Readonly<Record<string, string>>;
}

/**
 * 一张分组卡片（§5.9）：卡片头是标题，这张卡声明的锁定组各一个 Tag，下一行各写原因（每组只说一次）；卡片体是表单网格。
 * 标题可以被程序聚焦：副栏点锁定组那一行时滚到这里、焦点放在卡片头
 */
function GroupCard({ entity, group, state, original, ctx, onUpdate, errors }: CardProps) {
  const uid = useId();
  const locks = cardLocks(entity, group.key, ctx);
  const titleId = `${uid}t`;
  const reasonIds = locks.map((_, i) => `${uid}r${i}`);
  const noteIds = reasonIds.join(' ') || undefined;
  return (
    <section className="detail-card" data-group={group.key} aria-labelledby={titleId} aria-describedby={noteIds}>
      <div className="detail-card-head">
        <div className="detail-card-title-row">
          <h2 id={titleId} className="detail-card-title" tabIndex={-1}>
            {cjk(group.label)}
          </h2>
          {locks.map((l) => (
            <LockTag key={l.key} text={['上架后锁定', l.tag]} />
          ))}
        </div>
        {locks.map((l, i) => (
          <p key={l.key} id={reasonIds[i]} className="detail-card-reason">
            {cjk(lockReason(l.reason))}
          </p>
        ))}
      </div>
      <div className="detail-card-body">
        <FieldGrid
          entity={entity}
          group={group.key}
          state={state}
          ctx={ctx}
          onUpdate={onUpdate}
          lockNoteId={noteIds}
          declaredLocks={locks.map((l) => l.key)}
          original={original}
          errors={errors}
        />
      </div>
    </section>
  );
}

/** 只有多字段有序子项的分组（逐日行程）：不套卡片，区块头「逐日行程 · 8天」就是标题（E、L 页） */
function GroupBlock({ entity, group, state, original, ctx, onUpdate, errors }: CardProps) {
  return (
    <section className="detail-block" data-group={group.key} aria-label={group.label} tabIndex={-1}>
      <FieldGrid entity={entity} group={group.key} state={state} ctx={ctx} onUpdate={onUpdate} original={original} errors={errors} />
    </section>
  );
}

// ---------------- 跳转：副栏点一行，滚到卡片或字段 ----------------

const byData = (root: ParentNode, attr: string, value: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.getAttribute(attr) === value);

/** 总画焦点环：focusVisible 是 lib.dom 还没有的键（Chromium、Firefox、Safari 都认） */
const VISIBLE: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: true };

/**
 * 滚到这个元素并把焦点放上去（不可聚焦的先设 tabindex=-1）；外壳的滚动区留了吸顶条的位置（scroll-padding）。
 * visible：总画焦点环（浏览器按上一次操作猜，⌘S 这种带修饰键的按键之后常常不画）
 */
function land(el: HTMLElement, block: ScrollLogicalPosition, visible = false): void {
  el.scrollIntoView?.({ block });
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus(visible ? VISIBLE : { preventScroll: true });
}

/** 点锁定组那一行：滚到声明它的卡片，焦点放在卡片头（spec「副栏」第 1 条） */
export function jumpToCard(root: HTMLElement | null, group: string): void {
  const sec = root ? byData(root, 'data-group', group) : undefined;
  if (!sec) return;
  // 滚的是整张卡（卡片上沿停在吸顶条下面），焦点给卡片头
  sec.scrollIntoView?.({ block: 'start' });
  land(sec.querySelector<HTMLElement>('.detail-card-title') ?? sec, 'nearest');
}

/** 字段里第一个能填的控件；「撤销这处」不算 */
const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), button:not([disabled]):not([aria-disabled="true"]):not(.field-undo), [tabindex]:not([tabindex="-1"])';

/**
 * 检查项指向的元素：按 path 找到字段（外层带 data-field-key 的那个，不在别的字段里面）；有序子项里的一处再找第几项
 * （data-item-index）和那一项里的子字段。找不到更细的就停在找到的那一层
 */
export function issueTarget(root: HTMLElement, entity: EntityType, path: string): HTMLElement | undefined {
  const f = fieldOfPath(entity, path);
  if (!f) return undefined;
  const top = [...root.querySelectorAll<HTMLElement>('[data-field-key]')].find(
    (el) => el.getAttribute('data-field-key') === f.key && !el.parentElement?.closest('[data-field-key]'),
  );
  const sub = top ? subPathOf(f, path) : null;
  if (!top || !sub) return top;
  const item = byData(top, 'data-item-index', String(sub.index));
  if (!item || sub.sub === undefined) return item ?? top;
  return byData(item, 'data-field-key', sub.sub) ?? item;
}

/**
 * 点检查清单的一项：跳到对应字段，焦点放进第一个能填的控件；只读的字段把焦点放在字段上（spec「副栏」第 2 条）。
 * 页面上找不到这个字段时返回 false，焦点不动
 */
export function jumpToIssue(root: HTMLElement | null, entity: EntityType, path: string): boolean {
  const el = root ? issueTarget(root, entity, path) : undefined;
  if (!el) return false;
  const control = el.querySelector<HTMLElement>(FOCUSABLE);
  el.scrollIntoView?.({ block: 'center' });
  if (control) control.focus({ preventScroll: true });
  else land(el, 'center');
  return true;
}

// ---------------- 副栏 ----------------

function SideCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="detail-side-card" aria-labelledby={id}>
      <div className="detail-side-head">
        <h2 id={id} className="detail-side-title">
          {cjk(title)}
        </h2>
        {aside}
      </div>
      <div className="detail-side-body">{children}</div>
    </section>
  );
}

/**
 * 状态卡（E、F 页）：状态；能编辑时写「13项上架后锁定」（草稿「上架后13项会锁定」），下面每个锁定组一行（「识别 5项」），
 * 点了滚到声明它的卡片。没有编辑权限时只写状态的意思，不列锁定（这些字段对他并没有被锁）
 */
function StatusCard({
  entity,
  status,
  ctx,
  onJump,
}: {
  entity: EntityType;
  status?: 'draft' | 'active';
  ctx: ItemContext;
  onJump(group: string): void;
}) {
  const headline = lockPhrase(entity, ctx);
  const rows = headline ? lockRows(entity) : [];
  const active = ctx.status === 'active';
  const note = !active
    ? '还没上架，销售助手不会推荐它'
    : ctx.canEdit && headline
      ? '其余内容可以直接改，保存后立即生效'
      : '销售助手会向客户推荐它';
  return (
    <SideCard title="状态" aside={status ? <Status kind={status} /> : undefined}>
      {headline ? <div className="status-headline">{cjk(headline)}</div> : null}
      <div className={headline ? 'status-note' : 'status-note is-first'}>{cjk(note)}</div>
      {rows.length ? (
        <ul className="lock-rows">
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className="lock-row"
                aria-label={active ? `${r.tag}，${r.count}项上架后锁定，跳到${r.cardLabel}` : `${r.tag}，${r.count}项，跳到${r.cardLabel}`}
                onClick={() => onJump(r.card)}
              >
                <LockTag text={r.tag} />
                <span className="lock-row-count">{`${r.count}项`}</span>
                <Icon of={ChevronRight} size={14} className="lock-row-chevron" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </SideCard>
  );
}

/**
 * 上架前检查（F、G 页，§5.17）：必须项与建议项分开计数（「必须项13/13 · 建议1条没做」，口径见 spec「校验」），
 * 改一个字就重算。必须项全过时一行「必须项都填好了」；没过的逐条列出（「第3天：当晚住宿没填」），建议项注「不拦上架」；
 * 每项可以点，点了跳到对应字段
 */
function CheckCard({ entity, state, onJump }: { entity: EntityType; state: Payload; onJump(path: string): void }) {
  const c = checkItem(entity, state);
  const summary = [`必须项${c.requiredPassed}/${c.requiredTotal}`, ...(c.recommended.length ? [`建议${c.recommended.length}条没做`] : [])];
  const items: CheckItem[] = [
    ...(c.required.length === 0
      ? [{ key: 'required', label: '必须项都填好了', state: 'pass' as const, note: `${c.requiredPassed}/${c.requiredTotal}` }]
      : c.required.map((i, k) => ({ key: `r${k}:${i.path}`, label: issueText(i), state: 'fail' as const, onClick: () => onJump(i.path) }))),
    ...c.recommended.map((i, k) => ({
      key: `w${k}:${i.path}`,
      label: issueText(i),
      state: 'warn' as const,
      note: '不拦上架',
      onClick: () => onJump(i.path),
    })),
  ];
  return (
    <div className="detail-side-card detail-check">
      <CheckList
        title="上架前检查"
        headingLevel={2}
        summary={cjk(summary)}
        meta={cjk(['改动后立即重算', '建议项不拦上架'])}
        items={items}
      />
    </div>
  );
}

function UpdatedCard({ u, now }: { u: Updated; now: number }) {
  return (
    <SideCard title="最近更新">
      <dl className="detail-meta">
        <dt>更新人</dt>
        <dd>{cjk(u.by)}</dd>
        <dt>更新时间</dt>
        <dd>
          <span title={absoluteTime(u.iso, now)}>{u.at}</span>
        </dd>
      </dl>
    </SideCard>
  );
}

// ---------------- 保存条（§5.16，E、G 页） ----------------

/** 「展开改动」打开的清单：每处一行，点了跳到那个字段（收起、Esc 与跳不过去时的焦点由保存条管） */
function ChangesPanel({ id, changes, onJump }: { id: string; changes: readonly Change[]; onJump(path: string): void }) {
  return (
    <div id={id} className="save-changes">
      <ul>
        {changes.map((c) => (
          <li key={c.path}>
            <button type="button" className="save-change" onClick={() => onJump(c.path)}>
              <span>{cjk(c.label)}</span>
              <Icon of={ChevronRight} size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 保存条：左边 16 clock（warning-icon）、「有2处改动」、改动的中文名（放不下时省略，「展开改动」看全部）；
 * 右边说明、幽灵按钮「放弃」、主按钮「保存草稿」或「保存并立即生效」。提交中主按钮 loading，其余时候不禁用。
 * 新建时左边只写「还没保存」，不列改动
 */
function SaveBar({
  status,
  changes,
  saving,
  onSave,
  onDiscard,
  onJump,
}: {
  status: 'new' | 'draft' | 'active';
  changes: readonly Change[];
  saving: boolean;
  onSave(): void;
  onDiscard(): void;
  /** 跳到这一处；页面上没有可去的地方时返回 false */
  onJump(path: string): boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const copy = saveCopy(status);
  // 清单是浮层：在它和「展开改动」以外按下就收起（焦点不动）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  /** 焦点在「展开改动」或清单里时按 Esc：收起，焦点回到「展开改动」 */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <ActionBar
      label="保存改动"
      icon={<Icon of={Clock} size={16} className="save-bar-icon" />}
      summary={saveSummary(status, changes)}
      hint={
        status === 'new' ? undefined : (
          <span ref={wrap} className="save-bar-hint" onKeyDown={onKeyDown}>
            <span className="save-bar-names">{cjk(changes.map((c) => c.label).join('、'))}</span>
            {changes.length ? (
              <button
                ref={toggle}
                type="button"
                className="save-bar-toggle"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                onClick={() => setOpen((o) => !o)}
              >
                {open ? '收起改动' : '展开改动'}
              </button>
            ) : null}
            {open ? (
              <ChangesPanel
                id={listId}
                changes={changes}
                onJump={(path) => {
                  setOpen(false);
                  // 跳不过去：清单收起了，焦点别掉到 body，回到「展开改动」
                  if (!onJump(path)) toggle.current?.focus();
                }}
              />
            ) : null}
          </span>
        )
      }
      note={<span className="save-bar-note">{cjk(copy.note)}</span>}
    >
      <Button type="text" className="save-bar-discard" onClick={onDiscard}>
        放弃
      </Button>
      <PrimaryButton loading={saving} title="⌘S" aria-keyshortcuts="Meta+S Control+S" onClick={onSave}>
        {copy.button}
      </PrimaryButton>
    </ActionBar>
  );
}

// ---------------- 报错与冲突（页头下） ----------------

/** 顶部一行汇总「有2处要改」（spec「报错落到字段」）：点「跳到第一处」；落不到字段上的逐条写在下面，服务端的原文在技术详情里 */
function IssueSummary({ count, loose, error, onJump }: { count: number; loose: readonly string[]; error?: unknown; onJump?(): void }) {
  return (
    <Alert
      className="detail-issues"
      type="error"
      showIcon
      title={cjk(`有${count}处要改`)}
      description={
        loose.length || error !== undefined ? (
          <>
            {loose.length ? (
              <ul className="detail-issues-loose">
                {loose.map((m, i) => (
                  <li key={i}>{cjk(m)}</li>
                ))}
              </ul>
            ) : null}
            <TechDetails error={error} />
          </>
        ) : undefined
      }
      action={
        onJump ? (
          <Button size="small" onClick={onJump}>
            跳到第一处
          </Button>
        ) : undefined
      }
    />
  );
}

/** 409 rev_conflict（spec「保存条」）：danger 横幅「这条刚被别人改过」加「载入最新版本」 */
function ConflictBanner({ loading, onLoad }: { loading: boolean; onLoad(): void }) {
  return (
    <Alert
      className="detail-conflict"
      type="error"
      showIcon
      title={cjk('这条刚被别人改过')}
      description={cjk('载入最新版本以后，你没保存上的改动以对比形式留在这里，可以逐处用回')}
      action={
        <Button size="small" loading={loading} onClick={onLoad}>
          载入最新版本
        </Button>
      }
    />
  );
}

interface Compare {
  /** 你改之前的内容（打开时的） */
  before: Payload;
  /** 你没保存上的内容（showWhen 没显示的已剔除） */
  mine: Payload;
  /** 载入的最新版本 */
  latest: Payload;
}

/**
 * 载入最新版本以后，你没保存上的改动以对比形式保留（spec「保存条」的 409）：你改过的每个字段一行，最新版本与你改的并排，
 * 按字段类型的只读形态画；还能改的字段有「用我的改动」，写回表单（随后照常标「已改」、出现保存条）；上架后锁定了的只能看。
 * 焦点：载入以后落在卡片标题上（「载入最新版本」随横幅消失，CatalogDetail 放）；点了「用我的改动」，这个按钮收起，
 * 焦点挪到下一个「用我的改动」，没有了就回到标题
 */
function ConflictCompare({
  entity,
  compare,
  state,
  ctx,
  onUse,
  onClose,
}: {
  entity: EntityType;
  compare: Compare;
  state: Payload;
  ctx: ItemContext;
  onUse(fn: (s: Payload) => Payload): void;
  onClose(): void;
}) {
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const fields = changedFields(entity, compare.before, compare.mine);
  const usable = new Set(usableChanges(entity, compare, state, ctx));
  const view = (f: (typeof fields)[number], row: Payload) => {
    const R = RENDERERS[f.type];
    return <R.View field={f} value={valueAt(row, f.key)} row={row} />;
  };
  const use = (f: (typeof fields)[number], btn: HTMLElement): void => {
    const list = [...(titleRef.current?.closest('.detail-compare')?.querySelectorAll<HTMLElement>('.detail-compare-use') ?? [])];
    const i = list.indexOf(btn);
    const next = list[i + 1] ?? list[i - 1] ?? titleRef.current;
    next?.focus();
    onUse((s) => restoreField(s, compare.mine, f));
  };
  return (
    <section className="detail-compare" aria-labelledby={id}>
      <div className="detail-compare-head">
        <h2 ref={titleRef} id={id} className="detail-compare-title" tabIndex={-1}>
          {cjk('你没保存上的改动')}
        </h2>
        <span className="detail-compare-count">{`${fields.length}处`}</span>
        <IconButton label="关闭对比" icon={X} className="detail-compare-close" onClick={onClose} />
      </div>
      <p className="detail-compare-note">{cjk('已载入最新版本。逐处核对，要保留的点「用我的改动」，再保存')}</p>
      <ul className="detail-compare-rows">
        {fields.map((f, i) => {
          const can = usable.has(f);
          return (
            <li key={f.key} className="detail-compare-row">
              <div id={`${id}l${i}`} className="detail-compare-label">
                {cjk(f.label)}
              </div>
              <div className="detail-compare-cols">
                <div>
                  <div className="detail-compare-side">最新版本</div>
                  <div className="field-value">{view(f, compare.latest)}</div>
                </div>
                <div>
                  <div className="detail-compare-side">你改的</div>
                  <div className="field-value">{view(f, compare.mine)}</div>
                </div>
              </div>
              {can ? (
                // 几个按钮同名：读屏连上这一行的字段名
                <Button
                  size="small"
                  className="detail-compare-use"
                  aria-describedby={`${id}l${i}`}
                  onClick={(e) => use(f, e.currentTarget)}
                >
                  用我的改动
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------- 整页 ----------------

/** 失焦的元素在页面上的位置：沿祖先链取 data-field-key、data-item-index（字段、有序子项的一项、一项里的子字段） */
function placesOf(target: HTMLElement, root: Element): string[] {
  const chain: { field?: string; item?: string }[] = [];
  for (let el: HTMLElement | null = target; el && el !== root; el = el.parentElement) {
    const field = el.getAttribute('data-field-key') ?? undefined;
    const item = el.getAttribute('data-item-index') ?? undefined;
    if (field !== undefined || item !== undefined) chain.push({ field, item });
  }
  return touchedPlaces(chain);
}

/** 两栏的主体：主栏的卡片（「预览」页签是手机宽度的只读预览）与副栏。表单状态、报错由 CatalogDetail 给 */
function DetailBody({
  entity,
  item,
  ctx,
  anon,
  now,
  mainRef,
  original,
  state,
  setState,
  errors,
  saveBar,
  onTouch,
  onFocusField,
  preview,
  onJumpCard,
  onJumpIssue,
}: {
  entity: EntityType;
  item: DetailItem | null;
  ctx: ItemContext;
  anon: boolean;
  now: number;
  mainRef: RefObject<HTMLDivElement | null>;
  /** 打开时的内容：「已改」与撤销的比较基准 */
  original: Payload;
  state: Payload;
  setState(fn: (s: Payload) => Payload): void;
  errors: Readonly<Record<string, string>>;
  /** 保存条出现着：副栏让出它的高度 */
  saveBar: boolean;
  onTouch(places: readonly string[]): void;
  onFocusField(el: HTMLElement): void;
  /** 「预览」页签：主栏换成预览；给的是条目名与有没有没保存的改动 */
  preview: { title: string; dirty: boolean } | null;
  /** 副栏点锁定组、检查项：跳过去（在预览页签时先换回编辑） */
  onJumpCard(group: string): void;
  onJumpIssue(path: string): void;
}) {
  const updated = item ? updatedOf(item, now) : null;
  // 新建没有原文：卡片和有序子项的区块都不标「已改」
  const base = ctx.status === 'new' ? undefined : original;
  const card = (g: { key: string; label: string }) => {
    const props: CardProps = { entity, group: g, state, original: base, ctx, onUpdate: setState, errors };
    return blockOnly(entity, g.key) ? <GroupBlock key={g.key} {...props} /> : <GroupCard key={g.key} {...props} />;
  };
  /**
   * 焦点离开一处：记下离开了的位置。焦点还在里面的不算（在多选片之间 Tab、在行程亮点里从第1条换到第2条，行程亮点还没离开，
   * 第1条已经离开了）
   */
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.closest('[data-field-key]')) return;
    const to = e.relatedTarget as HTMLElement | null;
    const still = to && e.currentTarget.contains(to) ? placesOf(to, e.currentTarget) : [];
    onTouch(placesOf(t, e.currentTarget).filter((p) => !still.includes(p)));
  };
  const cls = ['detail-layout', anon && 'no-side', saveBar && 'has-save-bar'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div ref={mainRef} className="detail-main" onBlur={onBlur} onFocus={(e) => onFocusField(e.target as HTMLElement)}>
        {preview ? (
          <ItemPreview entity={entity} title={preview.title} state={state} status={ctx.status} dirty={preview.dirty} />
        ) : (
          entity.groups.filter((g) => cardHasFields(entity, g.key, state)).map(card)
        )}
      </div>
      {anon ? null : (
        <aside className="detail-side" aria-label="状态与检查">
          <StatusCard entity={entity} status={item?.status} ctx={ctx} onJump={onJumpCard} />
          {ctx.status === 'active' ? null : <CheckCard entity={entity} state={state} onJump={onJumpIssue} />}
          {updated ? <UpdatedCard u={updated} now={now} /> : null}
        </aside>
      )}
    </div>
  );
}

/** 页头下拿焦点的是哪一个：刚出的失败（「重试」或 Alert 本身）、409 横幅（「载入最新版本」）、422 的汇总 */
const ALERT_OF = { failure: '.detail-failure .ant-alert', conflict: '.detail-conflict', issues: '.detail-issues' } as const;

/** 焦点在弹层里（确认框、抽屉、⌘K）：⌘S 不管，焦点回收也不把它当成还在页面上 */
const inOverlay = (el: Element | null): boolean => !!el?.closest('[role="dialog"], .ant-modal-root, .ant-drawer');

/** 服务端 422 invalid_item：落好位置的报错、提交时的表单（那一处改过以后不再显示）和原来的错误（技术详情） */
interface ServerIssues {
  placed: Placed[];
  loose: string[];
  sent: Payload;
  error: unknown;
}

/** 要跳去的地方：检查项、报错指向的字段（issue），或副栏锁定组指向的卡片（card） */
interface Jump {
  to: 'issue' | 'card';
  at: string;
}

export function CatalogDetail(props: CatalogDetailProps) {
  const { groupName, item, canEdit, anon, now, onSave, onLoadLatest, onCreate, onActivate, onCopy, tab, onTab } = props;
  // 编号字段补上格式帮助和示例（新建时画得出来，行业包没写也有）；只加说明，检查与提交照旧
  const entity = useMemo(() => withCodeHints(props.entity), [props.entity]);
  const mainRef = useRef<HTMLDivElement>(null);
  // 眼下的条目：打开时的，存好以后换成服务端返回的，载入最新版本以后换成最新的。接口在这之间又取到新的（别人改过）
  // 也不换掉，免得冲掉正在改的：别人改过，保存时按 rev 得到 409
  const [base, setBase] = useState(item);
  // 新建时的原文是空表单（必填的数组先放空数组）：打开不改没有保存条，放弃回到它
  const blank = useMemo(() => blankPayload(entity), [entity]);
  const original = base?.payload ?? blank;
  const [state, setState] = useState<Payload>(() => formState(original));
  const ctx: ItemContext = { status: base ? (base.status ?? 'active') : 'new', canEdit };
  const title = base ? itemTitle(entity, base.payload, base.code) : `新建${entity.label}`;
  const updated = base ? updatedOf(base, now) : null;
  // 页签只给已有的条目（新建的地址上没有 tab）；「预览」时主栏换成预览，跳到字段之前先换回「编辑」
  const tabbed = tab !== undefined && onTab !== undefined && base !== null;
  const previewing = tabbed && tab === 'preview';

  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  /** 碰过的位置（失焦过）；点过保存以后 attempted 为真，全部显示 */
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<ServerIssues | null>(null);
  /** 别的失败（出错、锁定字段、权限、会话过期…）：页头下就地显示，重试再保存一次 */
  const [failure, setFailure] = useState<{ error: unknown; retry(): void } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  /** 对比里还有没用回的改动时点了「关闭对比」：先确认 */
  const [closingCompare, setClosingCompare] = useState(false);
  /** 上架确认开着；activatingBusy 是提交中（先保存、再上架）；closeBack 为假时关上以后不把焦点还给「上架…」（结果另有去处） */
  const [activating, setActivating] = useState(false);
  const [activatingBusy, setActivatingBusy] = useState(false);
  const [closeBack, setCloseBack] = useState(true);
  const [copying, setCopying] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  /** 复制时这一页有没保存的改动：先问要不要离开（同未保存保护），答了才建；leaving 是等着回答的那一次 */
  const [leaving, setLeaving] = useState<((ok: boolean) => void) | null>(null);
  /**
   * 保存（或载入最新版本、上架）失败、落不到字段上：页头下的横幅、Alert 或 422 的汇总滚进视野，焦点放到它的按钮上
   * （「载入最新版本」「重试」「跳到第一处」），没有按钮就放在它本身。表单多半在首屏以下，不这样做看不见也听不到失败
   */
  const [alertTick, setAlertTick] = useState(0);
  const alertOf = useRef<keyof typeof ALERT_OF>('failure');
  const showAlert = (which: keyof typeof ALERT_OF): void => {
    alertOf.current = which;
    setAlertTick((n) => n + 1);
  };
  const alertsRef = useRef<HTMLDivElement>(null);
  /** 载入最新版本以后：焦点放到对比卡的标题上（「载入最新版本」随横幅没了），读屏从这里接着念 */
  const [compareTick, setCompareTick] = useState(0);
  /** 刚存好、刚上架、刚建好：给读屏念一句（「已保存」），再改一处就清掉 */
  const [said, setSaid] = useState<string | null>(null);
  /** 要跳去的位置（报错的第一处、副栏点的一项）：等这一轮画完、报错写上、换回编辑页签以后再跳，读屏在焦点落下时念得到它 */
  const jumpAt = useRef<Jump | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  /** 保存条消失（存好、放弃）以后焦点回到哪：最后一个待过的字段，没有就是标题 */
  const [refocus, setRefocus] = useState(0);
  const lastField = useRef<HTMLElement | null>(null);
  /**
   * 焦点放到页标题上：上架以后（「上架…」没了，状态从标题后面的「草稿」变成「已上架」）；刚建好、刚复制出来的一条打开时
   * （页面带来 arrival）
   */
  const arrival = props.arrival;
  const [titleTick, setTitleTick] = useState(arrival ? 1 : 0);

  // 每次改一个字都重算（和副栏的上架前检查一样），条目只有几十个字段
  const pending = submission(original, state, entity.fields);
  const dirty = Object.keys(pending.set).length > 0 || pending.unset.length > 0;
  // 409 之后你的改动还留在对比里、没用回表单的，也是没保存的内容
  const [compare, setCompare] = useState<Compare | null>(null);
  const unappliedCount = compare ? usableChanges(entity, compare, state, ctx).length : 0;
  const unapplied = unappliedCount > 0;
  // 切页签只换地址上的 tab，不算离开这一页
  const guard = useUnsavedGuard(ctx.canEdit && (dirty || unapplied), LEAVING_PAGE);
  const canSave = ctx.canEdit && (base ? !!onSave : !!onCreate);
  const showBar = canSave && dirty;
  const changes = showBar && base ? changeList(entity, original, state) : [];
  const errors = visibleErrors(entity, state, { touched, all: attempted }, server);

  const jump = (j: Jump): void => {
    jumpAt.current = j;
    if (previewing) onTab?.('edit');
    setJumpTick((n) => n + 1);
  };
  const jumpTo = (at: string): void => jump({ to: 'issue', at });
  useEffect(() => {
    const j = jumpAt.current;
    if (!jumpTick || !j || previewing) return;
    let frame = 0;
    const go = (tries: number): void => {
      const main = mainRef.current;
      // 刚从「预览」换回来：antd 的页签面板自己再渲染一轮才去掉隐藏（display: none），看不见的控件拿不到焦点，等它显示出来
      if (main && !main.getClientRects().length && tries > 0) {
        frame = requestAnimationFrame(() => go(tries - 1));
        return;
      }
      jumpAt.current = null;
      if (j.to === 'card') jumpToCard(main, j.at);
      else jumpToIssue(main, entity, j.at);
    };
    go(10);
    return () => cancelAnimationFrame(frame);
  }, [jumpTick, previewing, entity]);
  useEffect(() => {
    if (!refocus) return;
    const a = document.activeElement;
    // 焦点还在正要关上的确认框里也算丢了：弹窗关完会把焦点还给打开它的按钮，那个按钮已经随保存条、对比卡没了
    if (a && a !== document.body && a.isConnected && !inOverlay(a)) return;
    const back = lastField.current?.isConnected ? lastField.current : document.querySelector<HTMLElement>('.page-title');
    if (back) land(back, 'nearest');
  }, [refocus]);
  useEffect(() => {
    const t = titleTick ? document.querySelector<HTMLElement>('.page-title') : null;
    if (t) land(t, 'nearest', true);
  }, [titleTick]);
  // 刚建好、刚复制出来（页面带来的一句）：挂上以后再写进读屏区，读屏才当它是新消息（挂上时就有的内容不念）
  useEffect(() => {
    if (!arrival) return;
    const t = setTimeout(() => setSaid(arrival), 0);
    return () => clearTimeout(t);
  }, [arrival]);
  useEffect(() => {
    if (!alertTick) return;
    const box = alertsRef.current;
    // 给刚出的那一个：载入最新版本连不上时横幅还在，焦点给「服务暂时连不上」的「重试」
    const alert = box?.querySelector<HTMLElement>(ALERT_OF[alertOf.current]);
    if (!box || !alert) return;
    box.scrollIntoView?.({ block: 'nearest' });
    const action = alert.querySelector<HTMLElement>('.ant-alert-actions button');
    // 焦点从表单跳到页头下，画出焦点环，看得出下一步在哪
    if (action) action.focus(VISIBLE);
    else land(alert, 'nearest', true);
  }, [alertTick]);
  useEffect(() => {
    const t = compareTick ? document.querySelector<HTMLElement>('.detail-compare-title') : null;
    if (t) land(t, 'nearest');
  }, [compareTick]);

  /**
   * 保存、新建、上架失败时落到哪（spec「报错落到字段」「保存条」）：422 的 issues 落到字段；新建时编号撞了（409 catalog_code_taken）
   * 落到编号字段下；409 rev_conflict 是横幅；其余页头下就地显示，重试再来一次。sent 是提交时的表单（那一处改过以后不再显示）
   */
  const fail = (e: unknown, sent: Payload, retry: () => void): void => {
    const code = e instanceof HttpError ? e.body.error : null;
    if (code === 'invalid_item' || code === 'catalog_code_taken') {
      const issues = code === 'invalid_item' ? ((e as HttpError).body.issues ?? []) : [{ path: 'id', message: '这个编号已经有了，换一个' }];
      const got = placeIssues(entity, issues);
      setServer({ ...got, sent, error: e });
      setAttempted(true);
      // 落到字段上的跳到第一处；全都落不到（路径为空、未知键）时只有页头下的汇总，焦点给它
      if (got.placed.length) jumpTo(got.placed[0]!.at);
      else showAlert('issues');
    } else if (code === 'rev_conflict') {
      setConflict(true);
      showAlert('conflict');
    } else {
      setFailure({ error: e, retry });
      showAlert('failure');
    }
  };

  /**
   * 保存：已有的发补丁，新建的建草稿。返回存好的条目；没发（不合格、没改动、正在提交）或失败时 null（失败已经报在页面上）。
   * forActivate：上架确认里先保存的那一次，存好以后焦点不回表单（确认框还开着、上架还在发，焦点留在「上架，开始推荐」上）
   */
  const save = async (forActivate = false): Promise<DetailItem | null> => {
    if (!canSave || busy.current) return null;
    const own = placeIssues(entity, formIssues(entity, state)).placed;
    if (own.length) {
      // 与 schema 同判的必须项没过：不发请求，全部报出来，焦点跳到第一处
      setAttempted(true);
      jumpTo(own[0]!.at);
      return null;
    }
    const p = submission(original, state, entity.fields);
    if (!Object.keys(p.set).length && !p.unset.length) return base;
    const sent = state;
    busy.current = true;
    setSaving(true);
    setFailure(null);
    try {
      if (!base) {
        // 新建：存下来就是一条草稿（showWhen 没显示的已剔除），页面接着去它的详情
        const created = await onCreate!(inFieldOrder(entity, pruneHidden(state, entity.fields)));
        setSaid('已建草稿');
        return created;
      }
      const next = await onSave!({ rev: base.rev ?? 0, set: p.set, ...(p.unset.length ? { unset: p.unset } : {}) });
      setBase(next);
      setAttempted(false);
      setServer(null);
      setConflict(false);
      setSaid('已保存');
      if (!forActivate) setRefocus((n) => n + 1);
      return next;
    } catch (e) {
      fail(e, sent, () => void saveRef.current());
      return null;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  // 重试拿到的总是最新的 save（它读的是这一轮的表单状态）；⌘S 同样经 ref 取这一轮的处理
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * 点「上架…」（spec「上架」）：必须项没过时不打开确认框，全部报出来，焦点跳到第一个没过的字段（副栏的检查清单照常列着没过的项）；
   * 全过才打开确认框。主按钮不禁用（长表单）
   */
  const startActivate = (): void => {
    const own = placeIssues(entity, formIssues(entity, state)).placed;
    if (own.length) {
      setAttempted(true);
      jumpTo(own[0]!.at);
      return;
    }
    setCloseBack(true);
    setActivating(true);
  };
  // 上架失败的「重试」经 ref 取这一轮的 startActivate：重新检查、重新打开确认框，锁定清单按那时的表单列
  const startActivateRef = useRef(startActivate);
  useEffect(() => {
    startActivateRef.current = startActivate;
  });
  /** 确认上架：有没保存的改动时先保存（锁定的就是确认框里列的这些），再按存好的 rev 上架 */
  const activate = async (): Promise<void> => {
    if (!onActivate || !base || busy.current) return;
    setActivatingBusy(true);
    try {
      const cur = dirty ? await save(true) : base;
      if (!cur) {
        // 没保存上：报错已经在页面上（字段下、页头下），关上确认框去看
        setCloseBack(false);
        setActivating(false);
        return;
      }
      busy.current = true;
      setFailure(null);
      try {
        const next = await onActivate(cur.rev ?? 0);
        setBase(next);
        setAttempted(false);
        setServer(null);
        setConflict(false);
        setCloseBack(false);
        setActivating(false);
        setSaid('已上架');
        setTitleTick((n) => n + 1);
      } catch (e) {
        setCloseBack(false);
        setActivating(false);
        // 重试不直接上架：失败以后表单还能改，改过的内容没人确认过就锁死（上架后无法下架），所以重新走确认框
        fail(e, state, () => startActivateRef.current());
      } finally {
        busy.current = false;
      }
    } finally {
      setActivatingBusy(false);
    }
  };

  // ⌘S / Ctrl+S 保存（spec「保存条」）：这一页能保存时总拦下浏览器的「存储网页」；没有改动时什么也不发。
  // 弹层开着（放弃确认、上架确认、复制、未保存保护、⌘K）时不拦也不保存：存的会是弹层底下这张表单，弹层还开着，
  // 放弃确认里按下去会把正要放弃的改动存上
  const onCmdS = (e: globalThis.KeyboardEvent): void => {
    if (discarding || closingCompare || activating || copying || inOverlay(document.activeElement)) return;
    e.preventDefault();
    void save();
  };
  const cmdSRef = useRef(onCmdS);
  useEffect(() => {
    cmdSRef.current = onCmdS;
  });
  useEffect(() => {
    if (!canSave) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing || e.key.toLowerCase() !== 's') return;
      cmdSRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave]);

  const loadLatest = async (): Promise<void> => {
    if (!onLoadLatest || loadingLatest) return;
    setLoadingLatest(true);
    setFailure(null);
    try {
      const latest = await onLoadLatest();
      setCompare({ before: original, mine: pruneHidden(state, entity.fields), latest: latest.payload });
      setCompareTick((n) => n + 1);
      setBase(latest);
      setState(formState(latest.payload));
      setConflict(false);
      setAttempted(false);
      setServer(null);
      setTouched(new Set());
      setSaid(null);
    } catch (e) {
      setFailure({ error: e, retry: () => void loadLatest() });
      showAlert('failure');
    } finally {
      setLoadingLatest(false);
    }
  };

  /** 关掉对比卡：焦点回到最后待过的字段，没有就是标题 */
  const closeCompare = (): void => {
    setCompare(null);
    setRefocus((n) => n + 1);
  };
  const update = (fn: (s: Payload) => Payload): void => {
    setSaid(null);
    setState(fn);
  };
  const onTouch = (places: readonly string[]): void =>
    setTouched((prev) => (places.every((p) => prev.has(p)) ? prev : new Set([...prev, ...places])));

  // 页头右侧（§4.3）：「更多」在左，主按钮「上架…」在最右；只给已有的条目，能不能编辑由页面决定给不给 onCopy、onActivate
  const more = base && onCopy ? <MoreMenu buttonRef={moreRef} onCopy={() => setCopying(true)} /> : null;
  /** 复制前先过离开保护：有没保存的内容时问一句（和站内跳转弹的同一个），「留下」就什么也不建 */
  const leaveFirst = (): Promise<boolean> => new Promise((resolve) => setLeaving(() => resolve));
  const answerLeave = (ok: boolean): void => {
    leaving?.(ok);
    setLeaving(null);
  };
  const activateButton =
    base && ctx.status === 'draft' && onActivate ? (
      <PrimaryButton className="detail-activate" onClick={startActivate}>
        上架…
      </PrimaryButton>
    ) : null;
  const count = errors.list.length + (server?.loose.length ?? 0);
  const check = ctx.status === 'draft' ? checkItem(entity, pruneHidden(state, entity.fields)) : null;
  const content = (
    <>
      {conflict || failure || (attempted && count) ? (
        <div ref={alertsRef} className="detail-alerts">
          {conflict ? <ConflictBanner loading={loadingLatest} onLoad={() => void loadLatest()} /> : null}
          {failure ? (
            <div className="detail-failure">
              <ErrorAlert error={failure.error} ctx={{ fieldLabel: (k) => lockedFieldLabel(entity, k) }} onRetry={failure.retry} />
            </div>
          ) : null}
          {attempted && count ? (
            <IssueSummary
              count={count}
              loose={server?.loose ?? []}
              error={server?.error}
              onJump={errors.list.length ? () => jumpTo(errors.list[0]!.at) : undefined}
            />
          ) : null}
        </div>
      ) : null}
      {compare ? (
        <ConflictCompare
          entity={entity}
          compare={compare}
          state={state}
          ctx={ctx}
          onUse={update}
          onClose={() => (unapplied ? setClosingCompare(true) : closeCompare())}
        />
      ) : null}
      <DetailBody
        entity={entity}
        item={base}
        ctx={ctx}
        anon={anon}
        now={now}
        mainRef={mainRef}
        original={original}
        state={state}
        setState={update}
        errors={errors.byPlace}
        saveBar={showBar}
        onTouch={onTouch}
        onFocusField={(el) => (lastField.current = el)}
        // 预览的是表单里的内容（含没保存的改动）：条目名也按表单写（同上架确认）
        preview={previewing && base ? { title: itemTitle(entity, state, base.code), dirty } : null}
        onJumpCard={(g) => (previewing ? jump({ to: 'card', at: g }) : jumpToCard(mainRef.current, g))}
        onJumpIssue={(p) => (previewing ? jumpTo(p) : void jumpToIssue(mainRef.current, entity, p))}
      />
    </>
  );
  return (
    <>
      <PageHeader
        title={title}
        docTitle={base ? [title, entity.label] : [title]}
        breadcrumb={<Breadcrumb group={groupName} entity={entity} current={title} />}
        titleStatus={base?.status ? <Status kind={base.status} /> : undefined}
        status={statusLine(lockPhrase(entity, ctx), updated, now)}
        actions={
          more || activateButton ? (
            <>
              {more}
              {activateButton}
            </>
          ) : undefined
        }
      />
      {canEdit ? <Alert className="detail-narrow-hint" type="info" showIcon title="建议在电脑上编辑" /> : null}
      {tabbed ? (
        // 页签（§4.4）：「编辑 / 预览」，地址上的 tab；内容放在选中的那一个页签里
        <Tabs
          className="detail-tabs"
          activeKey={tab}
          onChange={(k) => onTab?.(k === 'preview' ? 'preview' : 'edit')}
          items={(['edit', 'preview'] as const).map((k) => ({
            key: k,
            label: k === 'edit' ? '编辑' : '预览',
            children: k === tab ? content : null,
          }))}
        />
      ) : (
        content
      )}
      {showBar ? (
        <SaveBar
          status={ctx.status}
          changes={changes}
          saving={saving}
          onSave={() => void save()}
          onDiscard={() => setDiscarding(true)}
          onJump={(path) => {
            const at = jumpPlace(entity, state, path);
            if (!previewing) return jumpToIssue(mainRef.current, entity, at);
            jumpTo(at);
            return true;
          }}
        />
      ) : null}
      <ConfirmDanger
        open={discarding}
        title={!base ? '放弃填好的内容？' : changes.length ? `放弃这${changes.length}处改动？` : '放弃改动？'}
        confirmText="放弃改动"
        cancelText="保留"
        onConfirm={() => {
          setDiscarding(false);
          setState(formState(original));
          setAttempted(false);
          setServer(null);
          setTouched(new Set());
          setRefocus((n) => n + 1);
        }}
        onCancel={() => setDiscarding(false)}
      >
        {base ? '表单回到上次保存的内容，这些改动不会保存。' : '表单回到空白，填好的内容不会保存。'}
      </ConfirmDanger>
      <ConfirmDanger
        open={closingCompare}
        title={`放弃这${unappliedCount}处改动？`}
        confirmText="放弃改动"
        cancelText="保留"
        onConfirm={() => {
          setClosingCompare(false);
          closeCompare();
        }}
        onCancel={() => setClosingCompare(false)}
      >
        对比里还没用回表单的改动会丢掉，撤销不了。
      </ConfirmDanger>
      {base && check ? (
        <ActivateDialog
          open={activating}
          entity={entity}
          // 上架的是表单里的内容（有改动时先保存）：标题写它的名称
          title={itemTitle(entity, state, base.code)}
          payload={state}
          recommended={check.recommended}
          pending={dirty ? Math.max(changeList(entity, original, state).length, 1) : 0}
          busy={activatingBusy}
          returnFocus={closeBack}
          onConfirm={() => void activate()}
          // 正在保存、上架时关不掉（「关闭」「再检查一下」点不动，点遮罩、Esc 不关，见 ActivateDialog）：关了上架照样会成
          onCancel={() => {
            setCloseBack(true);
            setActivating(false);
          }}
        />
      ) : null}
      {base && onCopy ? (
        <CopyDialog
          open={copying}
          entity={entity}
          from={{ code: base.code, title }}
          codes={props.codes ?? []}
          pending={dirty ? Math.max(changeList(entity, original, state).length, 1) : 0}
          confirmLeave={ctx.canEdit && (dirty || unapplied) ? leaveFirst : undefined}
          onCopy={async (code) => {
            await onCopy(code, copyPayload(base.payload, code));
            setCopying(false);
          }}
          onCancel={() => setCopying(false)}
          // 没复制成（取消、Esc、关闭）：焦点回到「更多」（§5.14）。复制成了的话页面已经去了新草稿，这一页连同弹窗都卸掉了
          onClosed={() => moreRef.current?.focus()}
        />
      ) : null}
      <ConfirmDanger
        open={leaving !== null}
        title="有改动还没保存"
        confirmText="放弃改动并离开"
        cancelText="留下"
        onConfirm={() => answerLeave(true)}
        onCancel={() => answerLeave(false)}
      >
        离开这一页，没保存的改动会丢掉。
      </ConfirmDanger>
      <div className="save-live" role="status">
        {said && !dirty ? said : ''}
      </div>
      {guard}
    </>
  );
}

// ---------------- 加载 ----------------

/** 两栏骨架（spec 状态表）：页头三行、每张卡片按网格估的高度、副栏两张卡 */
export function DetailSkeleton({ entity }: { entity: EntityType }) {
  return (
    <>
      <div className="detail-skeleton-head" aria-hidden="true">
        <div className="skeleton-bar detail-skeleton-crumb" />
        <div className="skeleton-bar detail-skeleton-title" />
        <div className="skeleton-bar detail-skeleton-status" />
      </div>
      <div className="detail-layout">
        <div className="detail-main">
          {entity.groups.map((g) => (
            <div key={g.key} className="detail-card detail-skeleton-card" style={{ height: skeletonCardHeight(entity, g.key) }}>
              <div className="skeleton-bar" />
            </div>
          ))}
        </div>
        <div className="detail-side">
          <div className="detail-side-card detail-skeleton-card detail-skeleton-status-card">
            <div className="skeleton-bar" />
          </div>
          <div className="detail-side-card detail-skeleton-card detail-skeleton-meta-card">
            <div className="skeleton-bar" />
          </div>
        </div>
      </div>
    </>
  );
}
