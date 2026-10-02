// 产品库详情的纯逻辑（spec「产品库详情与编辑（E、F 页；L 页下半）」，设计系统 §6.4、E、F、L 页）。只看行业包的配置和字段类型，
// 不依赖 React：锁定组的计数与在哪张卡片头声明、卡片头要不要声明、页头的状态句、上架前检查每一项的写法、检查项指向哪个字段。
import { type CheckIssue, type EntityType, type FieldDef, valueAt } from '../../../src/shared/pack.js';
import { actorName } from '../../../src/shared/ui-labels.js';
import { isSingleItem, type ItemContext, LAYOUT, type Payload, visible } from '../fields/model.js';
import { IMPORTED_BY, listTime } from './list.js';

/** 锁定原因的统一结尾（spec「锁定」：原因来自 lockGroups，结尾统一加这一句） */
export const LOCK_REASON_TAIL = '急需修正请联系技术。';

/** 卡片头与锁定组那一行的原因：包里的原因加句号，再接统一的结尾 */
export const lockReason = (reason: string): string => `${reason.replace(/[。.]$/, '')}。${LOCK_REASON_TAIL}`;

/**
 * 上架后锁定的字段：lockedWhenActive（整个字段，或只锁几个成员的标签）与编号（建好后永远只读）。
 * 「9项上架后锁定」数的就是这些：旅游包的线路是识别 5（含编号）、推荐 4（含只锁「国内」的标签）；计价与条款两组 02 有了条目版本之后不再锁
 */
export const locksOnActive = (f: FieldDef): boolean => f.type !== 'status' && (f.key === '$code' || f.lockedWhenActive !== undefined);

/** 整个字段都锁（不是只锁几个成员）：卡片头的声明只算这些 */
const wholeLock = (f: FieldDef): boolean => f.key === '$code' || f.lockedWhenActive === true;

export interface LockRow {
  /** EntityType.lockGroups 的 key */
  key: string;
  tag: string;
  reason: string;
  /** 这一组上架后锁定几项 */
  count: number;
  /** 在哪张卡片头声明（EntityType.groups 的 key）；点了滚到这张卡 */
  card: string;
  cardLabel: string;
}

/**
 * 在哪张卡片头声明这个锁定组：按 groups 的顺序，第一张有这一组整字段锁定的卡片（原因每组只说一次，spec「锁定」）。
 * 旅游包的「识别」在基本信息里声明，「客户怎么叫」里的其他叫法同属识别，那张卡不再写一遍
 */
export function declaringCard(entity: EntityType, lockGroup: string): string | undefined {
  const inGroup = entity.fields.filter((f) => f.lockGroup === lockGroup && locksOnActive(f));
  const pick = (fs: readonly FieldDef[]) => entity.groups.find((g) => fs.some((f) => f.group === g.key))?.key;
  return pick(inGroup.filter(wholeLock)) ?? pick(inGroup);
}

/** 副栏状态卡的锁定组各一行（「识别 5项」），按 lockGroups 的顺序；这一组没有锁定的字段就不列 */
export function lockRows(entity: EntityType): LockRow[] {
  return Object.entries(entity.lockGroups).flatMap(([key, g]): LockRow[] => {
    const count = entity.fields.filter((f) => f.lockGroup === key && locksOnActive(f)).length;
    const card = declaringCard(entity, key);
    if (!count || card === undefined) return [];
    const cardLabel = entity.groups.find((x) => x.key === card)?.label ?? card;
    return [{ key, tag: g.tag, reason: g.reason, count, card, cardLabel }];
  });
}

/** 上架后锁定的项数（「13项上架后锁定」「上架后13项会锁定」）：没有锁定组的也算（如假包主材的编号） */
export const lockTotal = (entity: EntityType): number => entity.fields.filter(locksOnActive).length;

/**
 * 这张卡片头要声明的锁定组：只在已上架、可以编辑时（草稿里只是提醒「上架后锁定」，没有编辑权限的只读不挂锁，§6.4），
 * 并且这张卡就是这一组声明的地方
 */
export function cardLocks(entity: EntityType, group: string, ctx: ItemContext): LockRow[] {
  if (ctx.status !== 'active' || !ctx.canEdit) return [];
  return lockRows(entity).filter((r) => r.card === group);
}

/** 一张卡片里有没有要画的字段（$status 不进表单；showWhen 没显示的不算）。整张卡都没有就不画这张卡 */
export const cardHasFields = (entity: EntityType, group: string, state: Payload): boolean =>
  entity.fields.some((f) => f.group === group && f.type !== 'status' && visible(f, state));

/** 只有多字段有序子项的分组（逐日行程、施工节点）：不套卡片，区块头就是标题（设计系统 §6.0、E、L 页） */
export const blockOnly = (entity: EntityType, group: string): boolean => {
  const fs = entity.fields.filter((f) => f.group === group && f.type !== 'status');
  return fs.length > 0 && fs.every((f) => f.type === 'subItems' && !isSingleItem(f));
};

/** 条目名：titleKey 的值，没有时写编号 */
export function itemTitle(entity: EntityType, payload: Payload, code: string): string {
  const t = valueAt(payload, entity.titleKey);
  return typeof t === 'string' && t !== '' ? t : code;
}

/** 条目的更新人与更新时间：「小林」「今天10:12」；更新人为空或是 import-config 写「系统导入」（actorName）；匿名没有 */
export interface Updated {
  by: string;
  at: string;
  /** 悬停看的绝对时间，由页面按 absoluteTime 写 */
  iso: string;
}

export function updatedOf(item: { updatedAt?: string; updatedByName?: string | null }, now: number): Updated | null {
  if (!item.updatedAt) return null;
  return { by: actorName(item.updatedByName) ?? IMPORTED_BY, at: listTime(item.updatedAt, now), iso: item.updatedAt };
}

/**
 * 页头状态句的锁定那一段（设计系统 E、F 页）：已上架「13项上架后锁定」，草稿与新建「上架后13项会锁定」。
 * 只给能编辑的人：没有编辑权限时这些字段对他并没有被锁（§6.4），不提；这个实体没有锁定的字段时也不提
 */
export function lockPhrase(entity: EntityType, ctx: ItemContext): string | null {
  const n = lockTotal(entity);
  if (!ctx.canEdit || n === 0) return null;
  return ctx.status === 'active' ? `${n}项上架后锁定` : `上架后${n}项会锁定`;
}

/**
 * 上架前检查里一项的写法：跟在字段名后面的半句接在标签后（「体力强度没填」「逐日行程还差1天」）；
 * 有序子项里的一处写成「第3天：当晚住宿没填」（label 的后两段，spec「校验」，设计系统 G 页）
 */
export function issueText(issue: CheckIssue): string {
  const parts = issue.label.split(' · ');
  if (parts.length >= 3) return `${parts[1]}：${parts.slice(2).join('')}${issue.message}`;
  return `${parts.join('')}${issue.message}`;
}

/**
 * 检查项的 path 指向哪个字段（FieldDef.key）：取 path 本身或以它开头的最长的 key（有序子项再接下标与子字段，
 * 如 'itinerary.2.hotel' 指向逐日行程）。找不到时 undefined
 */
export function fieldOfPath(entity: EntityType, path: string): FieldDef | undefined {
  let best: FieldDef | undefined;
  for (const f of entity.fields) {
    if ((path === f.key || path.startsWith(`${f.key}.`)) && (!best || f.key.length > best.key.length)) best = f;
  }
  return best;
}

/** 有序子项里的一处：path 在字段 key 之后的下标与子字段（'itinerary.2.hotel' → { index: 2, sub: 'hotel' }） */
export function subPathOf(f: FieldDef, path: string): { index: number; sub?: string } | null {
  if (f.type !== 'subItems' || !path.startsWith(`${f.key}.`)) return null;
  const [i, ...rest] = path.slice(f.key.length + 1).split('.');
  const index = Number(i);
  if (!Number.isInteger(index) || index < 0) return null;
  return rest.length ? { index, sub: rest.join('.') } : { index };
}

/**
 * 加载时卡片骨架的高度（spec 状态表「两栏骨架，卡片高度与成品一致」）：按两列网格数这张卡有几行（半格的两两一行，
 * 占满一行的单独一行），每行是可改字段的高度（标签 20、间隔 6、控件 32），行间 20，加卡片头与内边距。
 * 条目还没取到，不知道是不是整卡锁定排 4 列，按两列估；只有有序子项的分组按区块头加一项估
 */
export function skeletonCardHeight(entity: EntityType, group: string): number {
  if (blockOnly(entity, group)) return 24 + 12 + 160;
  let rows = 0;
  let half = 0;
  for (const f of entity.fields) {
    if (f.group !== group || f.type === 'status' || f.showWhen) continue;
    if (LAYOUT[f.type].span(f) === 'half') {
      half += 1;
      if (half === 2) {
        rows += 1;
        half = 0;
      }
    } else {
      rows += half + 1;
      half = 0;
    }
  }
  rows += half;
  return 16 + 22 + 12 + rows * 58 + Math.max(0, rows - 1) * 20 + 20;
}

/** 文字联想（suggest: 'distinct'）：本实体各条目在这个字段上已有的值，数组展开，去重，按出现的先后 */
export function distinctValues(rows: readonly { payload: object }[] | undefined, key: string): string[] {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    const v = valueAt(r.payload as Payload, key);
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) out.add(x);
  }
  return [...out];
}

/** 引用字段指向的实体（含有序子项里的引用），去重：详情页只取这些实体的列表当候选 */
export const referencedKinds = (entity: EntityType): string[] => [
  ...new Set(
    entity.fields.flatMap((f) => [f, ...(f.item ?? [])]).flatMap((f) => (f.type === 'reference' && f.to !== undefined ? [f.to] : [])),
  ),
];
