// 产品库详情的保存（spec「产品库详情与编辑」的保存条、报错落到字段、409；设计系统 §5.16、E、G 页；plan 第 10.2 步）的纯逻辑。
// 不依赖 React，只看行业包的配置和字段类型：
// - 保存条左边的「有2处改动」与改动的中文名（「最累的一段、行程亮点第2条」「第3天的当晚住宿」），与提交的补丁同一个口径；
// - 报错落在哪：上架前检查（checkItem）与服务端 422 的 issues[].path 都换成页面上的一个位置（字段、有序子项的一项、
//   一项里的子字段），写成「当晚住宿：没填」；落不到字段上的留给顶部的汇总；
// - 「只显示碰过的字段」：失焦过的位置、点过保存以后全部；
// - 409 之后的对比：你改过的字段，逐个与最新版本并排。
import { sameValue } from '../../../src/shared/catalog.js';
import { parseMonthRange } from '../../../src/shared/format.js';
import { type CheckIssue, checkItem, type EntityType, type FieldDef, valueAt } from '../../../src/shared/pack.js';
import { fieldChanged, fieldMode, isSingleItem, type ItemContext, nounOf, type Payload, pruneHidden, visible } from '../fields/model.js';
import { fieldOfPath, subPathOf } from './detail.js';

const isRecord = (v: unknown): v is Payload => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------- 改动 ----------------

export interface Change {
  /** 改动在页面上的位置：字段 key，有序子项再接下标与子字段（'itinerary.2.hotel'）；点了跳过去 */
  path: string;
  /** 中文名：「最累的一段」「行程亮点第2条」「第3天的当晚住宿」 */
  label: string;
}

/** 一个有序子项里改了哪几处：条数不变时逐项比；单值的一项写「行程亮点第2条」，多字段的逐个子字段写「第3天的当晚住宿」 */
function itemChanges(f: FieldDef, before: readonly unknown[], after: readonly unknown[]): Change[] {
  const out: Change[] = [];
  after.forEach((x, i) => {
    const was = before[i];
    if (sameValue(was, x)) return;
    const at = `第${i + 1}${nounOf(f)}`;
    const subs = isSingleItem(f)
      ? []
      : (f.item ?? []).filter((s) => !sameValue(isRecord(was) ? was[s.key] : undefined, isRecord(x) ? x[s.key] : undefined));
    if (!subs.length) out.push({ path: `${f.key}.${i}`, label: `${f.label}${at}` });
    else for (const s of subs) out.push({ path: `${f.key}.${i}.${s.key}`, label: `${at}的${s.label}` });
  });
  return out;
}

/**
 * 保存条上的改动（设计系统 E、G 页）：和提交的补丁同一个口径，showWhen 没显示出来的字段先剔除（它们会被删掉，也算改动）。
 * 按字段的顺序；有序子项条数没变时逐项、逐个子字段列，条数变了（第 11 步的增删）整个字段算一处
 */
export function changeList(entity: EntityType, original: Payload, state: Payload): Change[] {
  const sent = pruneHidden(state, entity.fields);
  const out: Change[] = [];
  for (const f of entity.fields) {
    if (f.type === 'status' || !fieldChanged(original, sent, f)) continue;
    const a = valueAt(original, f.key);
    const b = valueAt(sent, f.key);
    if (f.type === 'subItems' && Array.isArray(a) && Array.isArray(b) && a.length === b.length) out.push(...itemChanges(f, a, b));
    else out.push({ path: f.key, label: f.label });
  }
  return out;
}

/**
 * 点改动清单的一处要跳去的位置：showWhen 没显示出来的字段（体力强度选了「不填」，最累的一段跟着删掉）页面上没有，
 * 跳到管它显示的那个字段；那个也没显示就再往上找
 */
export function jumpPlace(entity: EntityType, state: Payload, path: string): string {
  const shown = pruneHidden(state, entity.fields);
  const passed = new Set<string>();
  let at = path;
  for (let f = fieldOfPath(entity, at); f?.showWhen && !visible(f, shown) && !passed.has(f.key); f = fieldOfPath(entity, at)) {
    passed.add(f.key);
    at = f.showWhen.key;
  }
  return at;
}

/** 409 之后的对比：你改过的字段（整字段，「用我的改动」按字段写回）。mine 已剔除 showWhen 没显示的 */
export const changedFields = (entity: EntityType, before: Payload, mine: Payload): FieldDef[] =>
  entity.fields.filter((f) => f.type !== 'status' && fieldChanged(before, mine, f));

/**
 * 对比里还能「用我的改动」的字段：最新版本里还能改（上架后锁定了的只能看），表单里又还不是你改的样子。
 * 还有这样的字段时，你的改动只留在对比里、没进表单，离开页面同样先确认（不变量 20）
 */
export const usableChanges = (
  entity: EntityType,
  compare: { before: Payload; mine: Payload },
  state: Payload,
  ctx: ItemContext,
): FieldDef[] =>
  changedFields(entity, compare.before, compare.mine).filter(
    (f) => fieldMode(f, ctx) === 'edit' && !sameValue(valueAt(state, f.key), valueAt(compare.mine, f.key)),
  );

/** 已上架的条目改了计价或条款（02 spec「报价快照与产品库字段开放」）：保存条换成这一句 */
export const REPRICE_NOTE = '改价只影响之后的报价和方案书，已发出的方案书和订单不变';

/**
 * 保存条右边的说明与主按钮（设计系统 E、G 页）：草稿存了也不推荐；已上架的写接口返回时快照已经更新（01）；
 * 新建存下来就是一条草稿（spec「新建」：保存即建草稿，第 10.3 步）。
 * 已上架、改动里有行业包标了 reprices 的字段（02 开放的计价与条款）时，说明换成 REPRICE_NOTE：存下来是一个新的条目版本，
 * 已发出的方案书按发出时的版本渲染，订单的金额下单时就定了。只看经 /pack 下发的标记，不认字段名（不变量 11）
 */
export function saveCopy(
  status: 'new' | 'draft' | 'active',
  changes: readonly Change[] = [],
  entity?: EntityType,
): { note: string; button: string } {
  if (status === 'active') {
    const repriced = !!entity && changes.some((c) => fieldOfPath(entity, c.path)?.reprices === true);
    return { note: repriced ? REPRICE_NOTE : '销售助手下一条回复就用新内容', button: '保存并立即生效' };
  }
  if (status === 'new') return { note: '保存后是一条草稿，不会推荐给客户', button: '保存草稿' };
  return { note: '草稿保存后仍不会推荐给客户', button: '保存草稿' };
}

/**
 * 保存条左边的摘要：「有2处改动」；新建时每个填过的字段都算改动，说「改动」不对，写「还没保存」（不列改动名）。
 * 口径同提交的补丁，万一补丁里有、逐处列不出来的，也不写「有0处」
 */
export function saveSummary(status: 'new' | 'draft' | 'active', changes: readonly Change[]): string {
  if (status === 'new') return '还没保存';
  return changes.length ? `有${changes.length}处改动` : '有改动';
}

// ---------------- 报错落在哪 ----------------

/** 服务端 issues[].path 是 payload 的路径：条目编号在 payload 里是 id，行业包里是 $code */
const fieldPathOf = (path: string): string => (path === 'id' ? '$code' : path);

/**
 * 一处问题落在页面上的哪个位置（spec「报错落到字段」）：字段本身；有序子项里的一项（'itinerary.2'）或一项里的子字段
 * （'itinerary.2.hotel'）；嵌在别的字段里的更细的路径（标签的第 2 个）落到字段本身。对不上任何字段时 null
 */
export function placeOf(entity: EntityType, path: string): string | null {
  const p = fieldPathOf(path);
  const f = fieldOfPath(entity, p);
  if (!f) return null;
  if (f.type !== 'subItems' || p === f.key) return f.key;
  const sub = subPathOf(f, p);
  if (!sub) return f.key;
  if (isSingleItem(f)) return `${f.key}.${sub.index}`;
  const name = sub.sub?.split('.')[0];
  return (f.item ?? []).some((s) => s.key === name) ? `${f.key}.${sub.index}.${name}` : `${f.key}.${sub.index}`;
}

/** 位置的中文名：字段写标签，有序子项的一项写「第3天」，一项里的子字段写子字段的标签（上面已经是这一天的卡片） */
export function placeLabel(entity: EntityType, at: string): string {
  const f = fieldOfPath(entity, at)!;
  if (at === f.key) return f.label;
  const sub = subPathOf(f, at)!;
  const s = sub.sub === undefined ? undefined : f.item?.find((x) => x.key === sub.sub);
  return s ? s.label : `第${sub.index + 1}${nounOf(f)}`;
}

/** 服务端的说明不是中文时（zod 自带的英文说明），不照原样给人看，写成「格式不对」；原文在技术详情里 */
export const readable = (message: string): string => (/\p{Script=Han}/u.test(message) ? message : '格式不对');

/** 字段下方的一句：「当晚住宿：没填」「境内还是境外：没选」；说明本身已经以中文名开头时不再重复 */
export function issueLine(entity: EntityType, at: string, message: string): string {
  const label = placeLabel(entity, at);
  const m = readable(message);
  return m.startsWith(label) ? m : `${label}：${m}`;
}

export interface Issue {
  path: string;
  message: string;
}

export interface Placed {
  /** 位置（placeOf） */
  at: string;
  /** 它所在的字段（FieldDef.key）：汇总按字段的顺序排 */
  field: string;
  text: string;
}

/** 按页面上的位置放好：落得到字段的按字段的顺序（有序子项再按第几项），落不到的单独给出，只写说明 */
export function placeIssues(entity: EntityType, issues: readonly Issue[]): { placed: Placed[]; loose: string[] } {
  const placed: Placed[] = [];
  const loose: string[] = [];
  for (const i of issues) {
    const at = placeOf(entity, i.path);
    if (at === null) loose.push(readable(i.message));
    else placed.push({ at, field: fieldOfPath(entity, at)!.key, text: issueLine(entity, at, i.message) });
  }
  const order = (p: Placed): number => entity.fields.findIndex((f) => f.key === p.field);
  const index = (p: Placed): number => subPathOf(fieldOfPath(entity, p.at)!, p.at)?.index ?? -1;
  return { placed: [...placed].sort((a, b) => order(a) - order(b) || index(a) - index(b)), loose };
}

/** 表单里眼下的问题：上架前检查的必须项（与 schema 同判，不变量 15），保存前先查，不合格不发请求 */
export const formIssues = (entity: EntityType, state: Payload): CheckIssue[] =>
  checkItem(entity, pruneHidden(state, entity.fields)).required;

/** 位置上的字段定义与值：字段本身，或有序子项一项里的子字段；有序子项的一项本身（'itinerary.2'）没有 */
function slotAt(entity: EntityType, state: Payload, at: string): { def: FieldDef; value: unknown } | null {
  const f = fieldOfPath(entity, at);
  if (!f) return null;
  if (at === f.key) return { def: f, value: valueAt(state, f.key) };
  const sub = subPathOf(f, at);
  const def = sub?.sub === undefined ? undefined : f.item?.find((x) => x.key === sub.sub);
  if (!sub || !def) return null;
  const items = valueAt(state, f.key);
  const item = Array.isArray(items) ? (items[sub.index] as unknown) : undefined;
  return { def, value: isRecord(item) ? item[def.key] : undefined };
}

/**
 * 位置上的值：字段的值；有序子项的一项（'itinerary.2'、'highlights.1'）；一项里的子字段（'itinerary.2.hotel'）。
 * 服务端的报错按它判断那一处改过没有
 */
function placeValue(entity: EntityType, state: Payload, at: string): unknown {
  const f = fieldOfPath(entity, at);
  if (!f) return undefined;
  const value = valueAt(state, f.key);
  const sub = at === f.key ? null : subPathOf(f, at);
  if (!sub) return value;
  const item: unknown = Array.isArray(value) ? value[sub.index] : undefined;
  if (sub.sub === undefined) return item;
  return isRecord(item) ? item[sub.sub] : undefined;
}

/**
 * 控件自己已经在下方报了的问题（plan 第 3.2 步的交接）：月份区间写了认不出的字，表单控件自己写「没认出月份：写成…」
 * （设计系统 §6 表，与 renderers.tsx 的 MonthRangeForm 同一个条件）。这个字段下方不再写一遍，汇总照样算它一处
 */
export const reportsItself = (def: FieldDef, value: unknown): boolean =>
  def.type === 'monthRange' && typeof value === 'string' && value !== '' && !parseMonthRange(value);

/**
 * 字段下方显示哪些报错（spec「失焦时只显示碰过的字段的错误」）：
 * - 表单自己查出来的，只显示碰过的位置（失焦过；点过保存以后 all 为真，全部显示）；
 * - 服务端 422 的，显示到那一处改过为止（与提交时的内容比；有序子项里的一项、一个子字段各自比，改了第2天不收第5天的）。
 * 同一个位置有几条时用「；」连起来；控件自己报了的（reportsItself）不写进 byPlace。返回按位置取的报错，
 * 和按顺序排好的全部（汇总的条数与「跳到第一处」用）
 */
export function visibleErrors(
  entity: EntityType,
  state: Payload,
  seen: { touched: ReadonlySet<string>; all: boolean },
  server: { placed: readonly Placed[]; sent: Payload } | null,
): { byPlace: Record<string, string>; list: Placed[] } {
  const own = placeIssues(entity, formIssues(entity, state)).placed.filter((p) => seen.all || seen.touched.has(p.at));
  const theirs = (server?.placed ?? []).filter(
    (p) => !own.some((o) => o.at === p.at) && sameValue(placeValue(entity, server!.sent, p.at), placeValue(entity, state, p.at)),
  );
  const list = [...own, ...theirs];
  const byPlace: Record<string, string> = {};
  for (const p of list) {
    const slot = slotAt(entity, state, p.at);
    if (slot && reportsItself(slot.def, slot.value)) continue;
    byPlace[p.at] = byPlace[p.at] ? `${byPlace[p.at]}；${p.text}` : p.text;
  }
  const order = (p: Placed): number => entity.fields.findIndex((f) => f.key === p.field);
  return { byPlace, list: [...list].sort((a, b) => order(a) - order(b)) };
}

/**
 * 失焦的元素在页面上的位置，由外到里：字段、有序子项的一项、一项里的子字段（元素带 data-field-key、data-item-index）。
 * 纯函数：传进来的是由里到外的祖先链上这两个属性的值
 */
export function touchedPlaces(chain: readonly { field?: string; item?: string }[]): string[] {
  const outer = [...chain].reverse();
  const top = outer.find((x) => x.field !== undefined)?.field;
  if (top === undefined) return [];
  const rest = outer.slice(outer.findIndex((x) => x.field !== undefined) + 1);
  const item = rest.find((x) => x.item !== undefined)?.item;
  if (item === undefined) return [top];
  const inner = rest.slice(rest.findIndex((x) => x.item !== undefined) + 1).find((x) => x.field !== undefined)?.field;
  return inner === undefined ? [top, `${top}.${item}`] : [top, `${top}.${item}`, `${top}.${item}.${inner}`];
}

/**
 * 422 locked_field 的 fields 换成中文名（ERROR_COPY 的「这些内容上架后锁定了：{中文字段名}」）：
 * 'tags:国内' 写「标签里的「国内」」；id 是编号；找不到的写「其他内容」，不把键名给人看
 */
export function lockedFieldLabel(entity: EntityType, key: string): string {
  const [name, member] = key.split(':') as [string, string | undefined];
  const f = fieldOfPath(entity, fieldPathOf(name)) ?? entity.fields.find((x) => x.key.startsWith(`${name}.`));
  const label = f?.label ?? '其他内容';
  return member === undefined ? label : `${label}里的「${member}」`;
}
