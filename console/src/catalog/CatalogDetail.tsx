// 产品库详情（spec「产品库详情与编辑（E、F 页；L 页下半）」，设计系统 §4.3、§5.9、§5.17、§6.4、§6.5、E、F、L 页；plan 第 10.1 步）。
// 页头：面包屑「产品库 / 线路 / 条目名」（分组名是纯文本）、标题后跟状态、状态句「13项上架后锁定 · 小林更新于今天10:12」。
// 两栏：主栏按 groups 的顺序排分组卡片，字段按类型渲染（fields/FieldGrid）；副栏吸顶放状态与锁定组、上架前检查、最近更新；
// 宽 <1280 时副栏落到主栏下方（detail.css）。
// 锁定（§6.4）：已上架、可以编辑时，每个锁定组在它第一张整字段锁定的卡片头声明一次：Tag「上架后锁定 · 计价」，下一行写原因；
// 草稿里上架后会锁的字段在标签后提醒；没有编辑权限（非编辑成员、匿名）全是只读文本，不挂锁。
// 改过还没保存的字段标「已改」，可以「撤销这处」；有改动时站内跳转与关页都先确认（不变量 20）。保存条与提交是第 10.2 步，
// 上架确认、复制为新草稿、「预览」页签与新建的保存是第 10.3 步。
// 行业包只经 props 进来（/pack 的数据），这里不认具体行业：旅游包与假包走同一套代码。
import { Link } from '@tanstack/react-router';
import { Alert } from 'antd';
import { ChevronRight, Lock } from 'lucide-react';
import { type ReactNode, type RefObject, useId, useMemo, useRef, useState } from 'react';
import { absoluteTime } from '../../../src/shared/format.js';
import { checkItem, type EntityType } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { FieldGrid } from '../fields/FieldGrid.js';
import { formState, type ItemContext, type Payload, submission } from '../fields/model.js';
import { type CheckItem, CheckList } from '../parts/CheckList.js';
import { Status } from '../parts/Status.js';
import { useUnsavedGuard } from '../parts/UnsavedGuard.js';
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

/** 详情页要的一条：成员拿到的有状态与更新人；匿名投影只有编号和内容（都是已上架的） */
export interface DetailItem {
  code: string;
  status?: 'draft' | 'active';
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
}

// ---------------- 页头 ----------------

/** 面包屑「产品库 / 线路 / 条目名」（§4.3）：分组名没有自己的页面，是纯文本；实体名链回列表 */
export function Breadcrumb({ group, entity, current }: { group: string; entity: EntityType; current: string }) {
  return (
    <nav className="breadcrumb" aria-label="面包屑">
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
  original: Payload;
  ctx: ItemContext;
  onChange(next: Payload): void;
}

/**
 * 一张分组卡片（§5.9）：卡片头是标题，这张卡声明的锁定组各一个 Tag，下一行各写原因（每组只说一次）；卡片体是表单网格。
 * 标题可以被程序聚焦：副栏点锁定组那一行时滚到这里、焦点放在卡片头
 */
function GroupCard({ entity, group, state, original, ctx, onChange }: CardProps) {
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
          onChange={onChange}
          lockNoteId={noteIds}
          declaredLocks={locks.map((l) => l.key)}
          original={ctx.status === 'new' ? undefined : original}
        />
      </div>
    </section>
  );
}

/** 只有多字段有序子项的分组（逐日行程）：不套卡片，区块头「逐日行程 · 8天」就是标题（E、L 页） */
function GroupBlock({ entity, group, state, original, ctx, onChange }: CardProps) {
  return (
    <section className="detail-block" data-group={group.key} aria-label={group.label} tabIndex={-1}>
      <FieldGrid
        entity={entity}
        group={group.key}
        state={state}
        ctx={ctx}
        onChange={onChange}
        original={ctx.status === 'new' ? undefined : original}
      />
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
    : !ctx.canEdit
      ? '销售助手会向客户推荐它'
      : headline
        ? '其余内容可以直接改，保存后立即生效'
        : '保存后立即生效';
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
      <CheckList title="上架前检查" summary={cjk(summary)} meta={cjk(['改动后立即重算', '建议项不拦上架'])} items={items} />
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

// ---------------- 整页 ----------------

/** 两栏的主体：主栏的卡片与副栏。表单状态在这里，打开时的内容留作「已改」与撤销的比较基准 */
function DetailBody({
  entity,
  item,
  ctx,
  anon,
  now,
  mainRef,
}: {
  entity: EntityType;
  item: DetailItem | null;
  ctx: ItemContext;
  anon: boolean;
  now: number;
  mainRef: RefObject<HTMLDivElement | null>;
}) {
  // 打开时的内容：之后接口再取到新的（别人改过）也不换掉，免得冲掉正在改的（冲突在第 10.2 步按 rev 处理）
  const [original] = useState<Payload>(() => item?.payload ?? {});
  const [state, setState] = useState<Payload>(() => formState(original));
  const dirty = useMemo(() => {
    const p = submission(original, state, entity.fields);
    return Object.keys(p.set).length > 0 || p.unset.length > 0;
  }, [original, state, entity.fields]);
  const guard = useUnsavedGuard(ctx.canEdit && dirty);
  const updated = item ? updatedOf(item, now) : null;
  const card = (g: { key: string; label: string }) => {
    const props: CardProps = { entity, group: g, state, original, ctx, onChange: setState };
    return blockOnly(entity, g.key) ? <GroupBlock key={g.key} {...props} /> : <GroupCard key={g.key} {...props} />;
  };
  return (
    <div className={anon ? 'detail-layout no-side' : 'detail-layout'}>
      <div ref={mainRef} className="detail-main">
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
      {guard}
    </div>
  );
}

export function CatalogDetail({ groupName, entity, item, canEdit, anon, now }: CatalogDetailProps) {
  const mainRef = useRef<HTMLDivElement>(null);
  const ctx: ItemContext = { status: item ? (item.status ?? 'active') : 'new', canEdit };
  const title = item ? itemTitle(entity, item.payload, item.code) : `新建${entity.label}`;
  const updated = item ? updatedOf(item, now) : null;
  return (
    <>
      <PageHeader
        title={title}
        docTitle={item ? [title, entity.label] : [title]}
        breadcrumb={<Breadcrumb group={groupName} entity={entity} current={title} />}
        titleStatus={item?.status ? <Status kind={item.status} /> : undefined}
        status={statusLine(lockPhrase(entity, ctx), updated, now)}
      />
      {canEdit ? <Alert className="detail-narrow-hint" type="info" showIcon title="建议在电脑上编辑" /> : null}
      <DetailBody entity={entity} item={item} ctx={ctx} anon={anon} now={now} mainRef={mainRef} />
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
