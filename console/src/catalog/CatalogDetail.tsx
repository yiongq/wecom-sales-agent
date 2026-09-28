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
// 上架确认、复制为新草稿、「预览」页签与新建的保存是第 10.3 步。在那之前，草稿要上架时页头有「在旧表单里改」：
// 带着这一页的改动打开 01 的旧抽屉，在那里上架（页面给 onLegacyEdit 才有）。
// 行业包只经 props 进来（/pack 的数据），这里不认具体行业：旅游包与假包走同一套代码。
import { Link } from '@tanstack/react-router';
import { Alert, Button } from 'antd';
import { ChevronRight, Clock, Lock, X } from 'lucide-react';
import { type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
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
import { useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { IconButton } from '../shell/IconButton.js';
import { Icon } from '../shell/icons.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
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
import {
  type Change,
  changedFields,
  changeList,
  formIssues,
  lockedFieldLabel,
  type Placed,
  placeIssues,
  saveCopy,
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
  /** 保存一条已有的：发 PATCH，返回存好的条目（第 10.2 步）。不给就没有保存条（新建的保存在第 10.3 步） */
  onSave?(body: PatchBody): Promise<DetailItem>;
  /** 409 之后「载入最新版本」：重取这一条 */
  onLoadLatest?(): Promise<DetailItem>;
  /**
   * 第 10.3 步的上架确认到之前的过渡：给了，草稿的页头就有「在旧表单里改」，点了交出这一页的表单内容（带着没保存的改动，
   * showWhen 没显示的字段已剔除）和眼下的条目（它的 rev：别人在这之后改过，旧抽屉保存时得到 409），由页面打开 01 的
   * 旧抽屉去上架。已上架的条目用保存条，不再有这个按钮
   */
  onLegacyEdit?(draft: Payload, opened: DetailItem): void;
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

/** 滚到这个元素并把焦点放上去（不可聚焦的先设 tabindex=-1）；外壳的滚动区留了吸顶条的位置（scroll-padding） */
function land(el: HTMLElement, block: ScrollLogicalPosition): void {
  el.scrollIntoView?.({ block });
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
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

/** 点检查清单的一项：跳到对应字段，焦点放进第一个能填的控件；只读的字段把焦点放在字段上（spec「副栏」第 2 条） */
export function jumpToIssue(root: HTMLElement | null, entity: EntityType, path: string): void {
  const el = root ? issueTarget(root, entity, path) : undefined;
  if (!el) return;
  const control = el.querySelector<HTMLElement>(FOCUSABLE);
  el.scrollIntoView?.({ block: 'center' });
  if (control) control.focus({ preventScroll: true });
  else land(el, 'center');
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

/** 「展开改动」打开的清单：每处一行，点了跳到那个字段；Esc 收起，焦点回到「展开改动」 */
function ChangesPanel({
  id,
  changes,
  onJump,
  onClose,
}: {
  id: string;
  changes: readonly Change[];
  onJump(path: string): void;
  onClose(): void;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };
  return (
    <div id={id} className="save-changes" onKeyDown={onKeyDown}>
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
 * 右边说明、幽灵按钮「放弃」、主按钮「保存草稿」或「保存并立即生效」。提交中主按钮 loading，其余时候不禁用
 */
function SaveBar({
  status,
  changes,
  saving,
  onSave,
  onDiscard,
  onJump,
}: {
  status: 'draft' | 'active';
  changes: readonly Change[];
  saving: boolean;
  onSave(): void;
  onDiscard(): void;
  onJump(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const copy = saveCopy(status);
  return (
    <ActionBar
      label="保存改动"
      icon={<Icon of={Clock} size={16} className="save-bar-icon" />}
      // 口径同提交的补丁；万一补丁里有、逐处列不出来的，也不写「有0处」
      summary={changes.length ? `有${changes.length}处改动` : '有改动'}
      hint={
        <span className="save-bar-hint">
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
                onJump(path);
              }}
              onClose={() => {
                setOpen(false);
                toggle.current?.focus();
              }}
            />
          ) : null}
        </span>
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
 * 按字段类型的只读形态画；还能改的字段有「用我的改动」，写回表单（随后照常标「已改」、出现保存条）；上架后锁定了的只能看
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
  const fields = changedFields(entity, compare.before, compare.mine);
  const usable = new Set(usableChanges(entity, compare, state, ctx));
  const view = (f: (typeof fields)[number], row: Payload) => {
    const R = RENDERERS[f.type];
    return <R.View field={f} value={valueAt(row, f.key)} row={row} />;
  };
  return (
    <section className="detail-compare" aria-labelledby={id}>
      <div className="detail-compare-head">
        <h2 id={id} className="detail-compare-title">
          {cjk('你没保存上的改动')}
        </h2>
        <span className="detail-compare-count">{`${fields.length}处`}</span>
        <IconButton label="关闭对比" icon={X} className="detail-compare-close" onClick={onClose} />
      </div>
      <p className="detail-compare-note">{cjk('已载入最新版本。逐处核对，要保留的点「用我的改动」，再保存')}</p>
      <ul className="detail-compare-rows">
        {fields.map((f) => {
          const can = usable.has(f);
          return (
            <li key={f.key} className="detail-compare-row">
              <div className="detail-compare-label">{cjk(f.label)}</div>
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
                <Button size="small" className="detail-compare-use" onClick={() => onUse((s) => restoreField(s, compare.mine, f))}>
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

/** 两栏的主体：主栏的卡片与副栏。表单状态、报错由 CatalogDetail 给 */
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
}) {
  const updated = item ? updatedOf(item, now) : null;
  // 新建没有原文：卡片和有序子项的区块都不标「已改」
  const base = ctx.status === 'new' ? undefined : original;
  const card = (g: { key: string; label: string }) => {
    const props: CardProps = { entity, group: g, state, original: base, ctx, onUpdate: setState, errors };
    return blockOnly(entity, g.key) ? <GroupBlock key={g.key} {...props} /> : <GroupCard key={g.key} {...props} />;
  };
  /** 离开一个字段（焦点去了这个字段以外）：记下碰过的位置 */
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const own = t.closest('[data-field-key]');
    const to = e.relatedTarget as Node | null;
    if (!own || (to && own.contains(to))) return;
    onTouch(placesOf(t, e.currentTarget));
  };
  const cls = ['detail-layout', anon && 'no-side', saveBar && 'has-save-bar'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div ref={mainRef} className="detail-main" onBlur={onBlur} onFocus={(e) => onFocusField(e.target as HTMLElement)}>
        {entity.groups.filter((g) => cardHasFields(entity, g.key, state)).map(card)}
      </div>
      {anon ? null : (
        <aside className="detail-side" aria-label="状态与检查">
          <StatusCard entity={entity} status={item?.status} ctx={ctx} onJump={(g) => jumpToCard(mainRef.current, g)} />
          {ctx.status === 'active' ? null : (
            <CheckCard entity={entity} state={state} onJump={(p) => jumpToIssue(mainRef.current, entity, p)} />
          )}
          {updated ? <UpdatedCard u={updated} now={now} /> : null}
        </aside>
      )}
    </div>
  );
}

/** 新建和匿名没有打开时的内容 */
const NOTHING: Payload = Object.freeze({}) as Payload;

/** 服务端 422 invalid_item：落好位置的报错、提交时的表单（字段改过以后不再显示）和原来的错误（技术详情） */
interface ServerIssues {
  placed: Placed[];
  loose: string[];
  sent: Payload;
  error: unknown;
}

export function CatalogDetail({ groupName, entity, item, canEdit, anon, now, onSave, onLoadLatest, onLegacyEdit }: CatalogDetailProps) {
  const mainRef = useRef<HTMLDivElement>(null);
  // 眼下的条目：打开时的，存好以后换成服务端返回的，载入最新版本以后换成最新的。接口在这之间又取到新的（别人改过）
  // 也不换掉，免得冲掉正在改的：别人改过，保存时按 rev 得到 409
  const [base, setBase] = useState(item);
  const original = base?.payload ?? NOTHING;
  const [state, setState] = useState<Payload>(() => formState(original));
  const ctx: ItemContext = { status: base ? (base.status ?? 'active') : 'new', canEdit };
  const title = base ? itemTitle(entity, base.payload, base.code) : `新建${entity.label}`;
  const updated = base ? updatedOf(base, now) : null;

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
  /** 刚存好：给读屏念一句「已保存」，再改一处就清掉 */
  const [saved, setSaved] = useState(false);
  /** 要跳去的位置（报错的第一处）：等这一轮画完、报错写上以后再跳，读屏在焦点落下时念得到它 */
  const jumpAt = useRef<string | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  /** 保存条消失（存好、放弃）以后焦点回到哪：最后一个待过的字段，没有就是标题 */
  const [refocus, setRefocus] = useState(0);
  const lastField = useRef<HTMLElement | null>(null);

  // 每次改一个字都重算（和副栏的上架前检查一样），条目只有几十个字段
  const pending = submission(original, state, entity.fields);
  const dirty = Object.keys(pending.set).length > 0 || pending.unset.length > 0;
  // 409 之后你的改动还留在对比里、没用回表单的，也是没保存的内容
  const [compare, setCompare] = useState<Compare | null>(null);
  const unapplied = compare !== null && usableChanges(entity, compare, state, ctx).length > 0;
  const guard = useUnsavedGuard(ctx.canEdit && (dirty || unapplied));
  const showBar = !!onSave && ctx.canEdit && ctx.status !== 'new' && dirty;
  const changes = showBar ? changeList(entity, original, state) : [];
  const errors = visibleErrors(entity, state, { touched, all: attempted }, server);

  const jumpTo = (at: string): void => {
    jumpAt.current = at;
    setJumpTick((n) => n + 1);
  };
  useEffect(() => {
    if (!jumpTick || jumpAt.current === null) return;
    jumpToIssue(mainRef.current, entity, jumpAt.current);
    jumpAt.current = null;
  }, [jumpTick, entity]);
  useEffect(() => {
    if (!refocus) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const back = lastField.current?.isConnected ? lastField.current : document.querySelector<HTMLElement>('.page-title');
    if (back) land(back, 'nearest');
  }, [refocus]);

  const save = async (): Promise<void> => {
    if (!onSave || !base || busy.current) return;
    const own = placeIssues(entity, formIssues(entity, state)).placed;
    if (own.length) {
      // 与 schema 同判的必须项没过：不发请求，全部报出来，焦点跳到第一处
      setAttempted(true);
      jumpTo(own[0]!.at);
      return;
    }
    const p = submission(original, state, entity.fields);
    if (!Object.keys(p.set).length && !p.unset.length) return;
    const sent = state;
    busy.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const next = await onSave({ rev: base.rev ?? 0, set: p.set, ...(p.unset.length ? { unset: p.unset } : {}) });
      setBase(next);
      setAttempted(false);
      setServer(null);
      setConflict(false);
      setSaved(true);
      setRefocus((n) => n + 1);
    } catch (e) {
      const code = e instanceof HttpError ? e.body.error : null;
      if (code === 'invalid_item') {
        const got = placeIssues(entity, (e as HttpError).body.issues ?? []);
        setServer({ ...got, sent, error: e });
        setAttempted(true);
        if (got.placed.length) jumpTo(got.placed[0]!.at);
      } else if (code === 'rev_conflict') setConflict(true);
      else setFailure({ error: e, retry: () => void saveRef.current() });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  // 键盘与重试拿到的总是最新的 save（它读的是这一轮的表单状态）
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // ⌘S / Ctrl+S 保存（spec「保存条」）：这一页能保存时总拦下浏览器的「存储网页」；没有改动时什么也不发
  useEffect(() => {
    if (!onSave || !canEdit) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSave, canEdit]);

  const loadLatest = async (): Promise<void> => {
    if (!onLoadLatest || loadingLatest) return;
    setLoadingLatest(true);
    setFailure(null);
    try {
      const latest = await onLoadLatest();
      setCompare({ before: original, mine: pruneHidden(state, entity.fields), latest: latest.payload });
      setBase(latest);
      setState(formState(latest.payload));
      setConflict(false);
      setAttempted(false);
      setServer(null);
      setTouched(new Set());
      setSaved(false);
    } catch (e) {
      setFailure({ error: e, retry: () => void loadLatest() });
    } finally {
      setLoadingLatest(false);
    }
  };

  const update = (fn: (s: Payload) => Payload): void => {
    setSaved(false);
    setState(fn);
  };
  const onTouch = (places: readonly string[]): void =>
    setTouched((prev) => (places.every((p) => prev.has(p)) ? prev : new Set([...prev, ...places])));

  const legacy =
    onLegacyEdit && base && canEdit && ctx.status === 'draft' ? (
      <Button className="detail-legacy-edit" onClick={() => onLegacyEdit(pruneHidden(state, entity.fields), base)}>
        在旧表单里改
      </Button>
    ) : undefined;
  const count = errors.list.length + (server?.loose.length ?? 0);
  return (
    <>
      <PageHeader
        title={title}
        docTitle={base ? [title, entity.label] : [title]}
        breadcrumb={<Breadcrumb group={groupName} entity={entity} current={title} />}
        titleStatus={base?.status ? <Status kind={base.status} /> : undefined}
        status={statusLine(lockPhrase(entity, ctx), updated, now)}
        actions={legacy}
      />
      {canEdit ? <Alert className="detail-narrow-hint" type="info" showIcon title="建议在电脑上编辑" /> : null}
      {conflict || failure || (attempted && count) ? (
        <div className="detail-alerts">
          {conflict ? <ConflictBanner loading={loadingLatest} onLoad={() => void loadLatest()} /> : null}
          {failure ? (
            <ErrorAlert error={failure.error} ctx={{ fieldLabel: (k) => lockedFieldLabel(entity, k) }} onRetry={failure.retry} />
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
        <ConflictCompare entity={entity} compare={compare} state={state} ctx={ctx} onUse={update} onClose={() => setCompare(null)} />
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
      />
      {showBar && base?.status ? (
        <SaveBar
          status={base.status}
          changes={changes}
          saving={saving}
          onSave={() => void save()}
          onDiscard={() => setDiscarding(true)}
          onJump={(path) => jumpToIssue(mainRef.current, entity, path)}
        />
      ) : null}
      <ConfirmDanger
        open={discarding}
        title={changes.length ? `放弃这${changes.length}处改动？` : '放弃改动？'}
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
        表单回到上次保存的内容，这些改动不会保存。
      </ConfirmDanger>
      <div className="save-live" role="status">
        {saved && !dirty ? '已保存' : ''}
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
