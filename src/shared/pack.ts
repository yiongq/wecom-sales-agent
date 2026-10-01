// 行业包的界面配置（docs/features/console-ux/spec.md「行业包通用架构」，设计系统 §9，ADR-004）。前后端共用，只依赖 src/shared。
// 行业包只提供配置：实体、字段、销售阶段、话术节表、词汇和导航；界面按字段类型渲染，不认具体行业。
// 各包的取值放在 src/packs/<包>/console-pack.ts，经 src/packs/registry.ts 注册，由 GET /api/console/pack 下发；
// console/src 不 import 任何包模块，只读接口返回的这份结构。
// 本文件另有三样：实体图标集合 ENTITY_ICONS、结构自检 checkPack（不变量 13）、上架前检查 checkItem（spec「校验」、不变量 15），
// 由 src/packs/packs.selftest.ts 核对。
import { CATALOG_CODE } from './catalog.js';
import { storableText, UNSTORABLE_TEXT } from './console-api.js';
import { monthsReadable } from './season.js';

/** 字段类型是界面和行业包之间的契约：新增一种要改 console 的渲染器表（Record<FieldType, …>） */
export type FieldType =
  | 'text'
  | 'longText'
  | 'money'
  | 'intUnit'
  | 'monthRange'
  | 'enum'
  | 'tags'
  | 'boolean'
  | 'subItems'
  | 'reference'
  | 'status';

export interface FieldDef {
  /** payload 路径，如 'priceFrom'、'intensity.level'；'$code'、'$status'、'$updated' 是系统字段 */
  key: string;
  type: FieldType;
  /** 中文标签，不带冒号 */
  label: string;
  /** 表单分组，指向 EntityType.groups 的 key；有序子项里的子字段写空串 */
  group: string;
  /** 常驻在字段下方 */
  help?: string;
  /** 只放示例，以「例：」开头 */
  placeholder?: string;
  /** 默认 true；false 时标签后加「（选填）」。数组类型的必填只要求键存在，可以是空数组，要至少几项用 min */
  required?: boolean;
  /** 上架后锁定；tags 可以只锁其中几项 */
  lockedWhenActive?: true | { members: string[] };
  /** 指向 EntityType.lockGroups 的 key */
  lockGroup?: string;
  /** 条件显示；显示出来就必填 */
  showWhen?: { key: string; filled: true };
  unit?: string;
  /** 单位取另一个 enum 字段的值 */
  unitFrom?: string;
  /** intUnit、money 是数值上下限；数组类型（tags、多选 enum、subItems）的 min 是至少几项，拦上架 */
  min?: number;
  max?: number;
  /** longText：超过时提示，不拦 */
  softMax?: number;
  options?: string[];
  /** enum 多选 */
  multiple?: boolean;
  /** enum 多选存成字符串：按 join 连起来，一项都没选时存 empty */
  storeAs?: { join: string; empty: string };
  /** text / tags 的联想来源：'distinct' 取已有值 */
  suggest?: 'distinct' | string[];
  /** boolean 的两种文字 */
  trueLabel?: string;
  falseLabel?: string;
  /** monthRange 高亮月份的含义 */
  monthMeaning?: string;
  /** monthRange 解析成「全年」时显示的文字，默认「全年」 */
  yearRoundLabel?: string;
  /** 不拦上架的建议项 */
  recommend?: true | { min?: number; max?: number };
  /** reference：引用哪个实体的 kind */
  to?: string;
  /** reference：存编号还是名称 */
  store?: 'code' | 'label';
  /** reference：可以写库外的文本 */
  allowFree?: boolean;
  /** reference：按本条目的哪个字段筛候选 */
  filterBy?: string;
  /** subItems：子字段；只有一个 key 为空串的 text 子字段时存 string[] */
  item?: FieldDef[];
  /** subItems：量词，如「天」「条」 */
  itemNoun?: string;
  /** subItems：序号的写法，{n} 换成序号，如「D{n}」 */
  indexLabel?: string;
  /** subItems：条数要等于这个字段的值 */
  countFrom?: string;
  /** subItems：自动编号、只读的子字段 */
  autoIndexKey?: string;
}

export interface EntityType {
  /** URL 用：/catalog/{kind} */
  kind: string;
  /** 导航和页标题用 */
  label: string;
  /** lucide 名称，只能取设计系统 §7 的实体图标集合 */
  icon: string;
  codeLabel: string;
  codeExample: string;
  titleKey: string;
  /** 列表首列的次行 */
  subtitleKeys: string[];
  /** 表单卡片，按顺序 */
  groups: { key: string; label: string }[];
  /** 锁定组：卡片头的 Tag 与原因，每组只说一次 */
  lockGroups: Record<string, { tag: string; reason: string }>;
  fields: FieldDef[];
  list: { columns: string[]; filters: string[]; search: string[]; defaultSort: '-$updated' };
  /** 能否导入 CSV；false 时不渲染入口 */
  csvImport: boolean;
  /** 上架确认的第一句，{字段 key} 会被替换成当前值 */
  activateLine: string;
}

export interface SalesStageDef {
  key: string;
  label: string;
  /** 分支阶段（如异议）排在它的主阶段后面 */
  branchOf?: string;
  /**
   * 终态：停在这里的会话算已成交（conversationState，服务端的 state=paid 过滤、byState 计数、waiting_first
   * 和 console 的列表、首页都按它），转过人工的也算，不进「等人接手」、徽标和铃铛；也不进「客户停在哪一步」
   */
  terminal?: boolean;
}

export interface SopSectionDef {
  key: string;
  heading: string | null;
  locked: boolean;
  /** 固定规则节为什么不能改，写成人话 */
  lockReason?: string;
}

export interface IndustryPack {
  id: string;
  name: string;
  vocabulary: {
    customer: string;
    advisor: string;
    /** 总览上「在售{productNoun}」 */
    productNoun: string;
    /** 工具原名 → 中文名，话术芯片用 */
    tools: Record<string, string>;
    /** 话术可以点名的字段 → 中文名 */
    sopFields: Record<string, string>;
  };
  entities: EntityType[];
  stages: SalesStageDef[];
  sopSections: SopSectionDef[];
  nav: { catalogGroup: string; entities: string[] };
}

/** 上架前检查：必须项与建议项 */
export interface ItemCheck {
  /** 必须项的检查项数，「必须项13/13」的分母（计数口径见 spec「校验」） */
  requiredTotal: number;
  /** 过了的检查项数。一项里可以有几条问题（有序子项的每处缺漏各一条），所以不等于 requiredTotal 减 required 的条数 */
  requiredPassed: number;
  /** 没过的必须项，按字段顺序；空数组就是必须项全过 */
  required: CheckIssue[];
  /** 没做的建议项，不拦上架 */
  recommended: CheckIssue[];
}

/**
 * path 是 FieldDef.key 的路径，有序子项再接下标和子字段，如 'itinerary.2.hotel'；label 是中文路径，例如「逐日行程 · 第4天 · 当天餐食」；
 * message 是跟在字段名后面的那半句，如「没填」「还差1天」「建议3–5条」，界面拼成「当晚住宿：没填」「第3天：当晚住宿没填」
 */
export interface CheckIssue {
  path: string;
  label: string;
  message: string;
}

/** 设计系统 §7 的实体图标集合。EntityType.icon 只能取这些 lucide 名称：console 只为它们打包图标组件，checkPack 校验 */
export const ENTITY_ICONS = Object.freeze([
  'route',
  'bed-double',
  'package',
  'layers',
  'box',
  'boxes',
  'tag',
  'tags',
  'shopping-bag',
  'shopping-cart',
  'store',
  'gift',
  'ticket',
  'file-text',
  'briefcase',
  'building-2',
  'house',
  'car',
  'plane',
  'utensils',
  'shirt',
  'wrench',
  'graduation-cap',
  'stethoscope',
] as const);
export type EntityIcon = (typeof ENTITY_ICONS)[number];

/** 系统字段：`$code` 是条目编号，也就是 payload 的 id；`$status`、`$updated` 取自 CatalogItem，不在 payload 里 */
const SYSTEM_KEYS: readonly string[] = ['$code', '$status', '$updated'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 按 FieldDef.key 的路径取值（'$code' 取 id）。只认自有属性，'toString' 这类原型上的名字取不到。
 * 后台的表单按同一个函数取值（console/src/fields/model.ts），上架前检查与表单看到的是同一个值
 */
export function valueAt(payload: Record<string, unknown>, key: string): unknown {
  let cur: unknown = payload;
  for (const k of (key === '$code' ? 'id' : key).split('.')) {
    if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 缺键、null、空串、空数组都算没填 */
export const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

function dupes(xs: readonly string[]): string[] {
  return [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
}

// ── 结构自检（不变量 13）：返回问题列表，空数组表示通过。只给开发者看（自测），界面不显示 ──
// 但 src/shared 的字符串都算界面用字（scripts/fonts/ui-text.ts），会进每次预载的 UI 优先片，所以这里的话只用界面已有的字。

/** 有序子项里的字段不支持的配置：上架前检查与锁定都按顶层字段算，子字段里写了也不生效 */
const ITEM_UNSUPPORTED = ['showWhen', 'countFrom', 'recommend', 'lockedWhenActive', 'lockGroup', 'unitFrom'] as const;

export function checkPack(pack: IndustryPack): string[] {
  const out: string[] = [];
  const kinds = pack.entities.map((e) => e.kind);
  for (const k of dupes(kinds)) out.push(`entities：kind「${k}」重复`);
  for (const k of dupes(pack.nav.entities)) out.push(`nav.entities：「${k}」重复`);
  for (const k of pack.nav.entities) if (!kinds.includes(k)) out.push(`nav.entities「${k}」不是本包的实体`);

  const stageKeys = pack.stages.map((s) => s.key);
  for (const k of dupes(stageKeys)) out.push(`stages：key「${k}」重复`);
  for (const s of pack.stages) {
    if (s.branchOf !== undefined && (s.branchOf === s.key || !stageKeys.includes(s.branchOf))) {
      out.push(`stages[${s.key}].branchOf「${s.branchOf}」不是本包的阶段`);
    }
  }
  for (const k of dupes(pack.sopSections.map((s) => s.key))) out.push(`sopSections：key「${k}」重复`);
  pack.sopSections.forEach((s, i) => {
    if (s.locked && !s.lockReason) out.push(`sopSections[${s.key}]：锁定的节要写 lockReason`);
    if (s.heading === null && i > 0) out.push(`sopSections[${s.key}]：只有第一节（前言）可以没有 heading`);
  });

  for (const e of pack.entities) checkEntity(pack, e, out);
  return out;
}

function checkEntity(pack: IndustryPack, e: EntityType, out: string[]): void {
  const at = `entities[${e.kind}]`;
  if (!(ENTITY_ICONS as readonly string[]).includes(e.icon)) out.push(`${at}.icon「${e.icon}」不在 ENTITY_ICONS 里`);
  const groupKeys = e.groups.map((g) => g.key);
  for (const k of dupes(groupKeys)) out.push(`${at}.groups：key「${k}」重复`);
  for (const [k, g] of Object.entries(e.lockGroups)) if (!g.tag || !g.reason) out.push(`${at}.lockGroups[${k}]：tag 和 reason 都要写`);
  for (const k of dupes(e.fields.map((f) => f.key))) out.push(`${at}.fields：key「${k}」重复`);

  const byKey = new Map(e.fields.map((f) => [f.key, f]));
  const isField = (k: string): boolean => byKey.has(k) || SYSTEM_KEYS.includes(k);
  if (!byKey.has(e.titleKey)) out.push(`${at}.titleKey「${e.titleKey}」不是本实体的字段`);
  const refs: [string, readonly string[]][] = [
    ['subtitleKeys', e.subtitleKeys],
    ['list.columns', e.list.columns],
    ['list.filters', e.list.filters],
    ['list.search', e.list.search],
  ];
  for (const [where, keys] of refs) for (const k of keys) if (!isField(k)) out.push(`${at}.${where}「${k}」不是本实体的字段`);
  for (const m of e.activateLine.matchAll(/\{([^}]*)\}/g)) {
    if (!byKey.has(m[1])) out.push(`${at}.activateLine 的「{${m[1]}}」不是本实体的字段`);
  }

  for (const f of e.fields) {
    const fat = `${at}.fields[${f.key}]`;
    if (f.key.startsWith('$') && !SYSTEM_KEYS.includes(f.key)) out.push(`${fat}：系统字段只有 $code、$status、$updated`);
    if (f.type === 'status' && f.key !== '$status') out.push(`${fat}：status 类型只能用在 $status 上`);
    if (f.key === '$status' && f.type !== 'status') out.push(`${fat}：$status 只能是 status 类型`);
    if (!groupKeys.includes(f.group)) out.push(`${fat}.group「${f.group}」不在 groups 里`);
    if (f.lockGroup !== undefined && !Object.hasOwn(e.lockGroups, f.lockGroup)) {
      out.push(`${fat}.lockGroup「${f.lockGroup}」不在 lockGroups 里`);
    }
    if (f.lockedWhenActive && f.lockGroup === undefined) out.push(`${fat}：上架后锁定的字段要有 lockGroup`);
    if (f.showWhen && (f.showWhen.key === f.key || !byKey.has(f.showWhen.key))) {
      out.push(`${fat}.showWhen.key「${f.showWhen.key}」不是本实体的字段`);
    }
    if (f.countFrom !== undefined) {
      if (f.type !== 'subItems') out.push(`${fat}.countFrom 只能用在 subItems 上`);
      if (byKey.get(f.countFrom)?.type !== 'intUnit') out.push(`${fat}.countFrom「${f.countFrom}」不是本实体的 intUnit 字段`);
    }
    if (f.unitFrom !== undefined) {
      const u = byKey.get(f.unitFrom);
      if (u?.type !== 'enum' || u.multiple) out.push(`${fat}.unitFrom「${f.unitFrom}」不是本实体的单选 enum 字段`);
    }
    checkFieldShape(pack, e, f, fat, out);

    if (f.type !== 'subItems' || !f.item?.length) continue;
    const single = f.item.some((s) => s.key === '');
    if (single && f.item.length !== 1) out.push(`${fat}.item：key 为空时只能有这一个字段`);
    for (const k of dupes(f.item.map((s) => s.key))) out.push(`${fat}.item：key「${k}」重复`);
    if (f.autoIndexKey !== undefined) {
      if (single) out.push(`${fat}.autoIndexKey 只能用在子字段是对象的有序子项上`);
      if (f.item.some((s) => s.key === f.autoIndexKey)) out.push(`${fat}.autoIndexKey「${f.autoIndexKey}」与子字段重复`);
    }
    for (const s of f.item) {
      const sat = `${fat}.item[${s.key}]`;
      const unsupported: string[] = ITEM_UNSUPPORTED.filter((p) => s[p] !== undefined);
      if (s.type === 'subItems' || s.type === 'status') unsupported.push(`${s.type} 类型`);
      if (unsupported.length) out.push(`${sat}：有序子项里的字段不支持 ${unsupported.join('、')}`);
      if (s.group !== '') out.push(`${sat}.group 要是空串（有序子项里的字段不分组）`);
      checkFieldShape(pack, e, s, sat, out);
    }
  }
}

/** 顶层字段与有序子项里的字段共用的检查：按类型的配置项 */
function checkFieldShape(pack: IndustryPack, e: EntityType, f: FieldDef, fat: string, out: string[]): void {
  if (f.type === 'enum') {
    if (!f.options?.length) out.push(`${fat}.options 是空的`);
    else if (dupes(f.options).length) out.push(`${fat}.options 有重复`);
  }
  if (f.multiple && f.type !== 'enum' && f.type !== 'reference') out.push(`${fat}.multiple 只能用在 enum 和 reference 上`);
  if (f.storeAs && !(f.type === 'enum' && f.multiple)) out.push(`${fat}.storeAs 只能用在多选 enum 上`);
  if (f.type === 'subItems' && !f.item?.length) out.push(`${fat}.item 是空的`);
  if (typeof f.recommend === 'object' && !isArrayField(f)) out.push(`${fat}.recommend 的 min、max 只能用在数组字段上`);
  if (f.type !== 'reference') return;
  const target = pack.entities.find((t) => t.kind === f.to);
  if (!target) {
    out.push(`${fat}.to「${f.to ?? ''}」不是本包的实体`);
    return;
  }
  // filterBy 是本条目的顶层字段，候选按对方同名的字段筛（线路的目的地 → 酒店的目的地）
  if (f.filterBy !== undefined && !(e.fields.some((x) => x.key === f.filterBy) && target.fields.some((x) => x.key === f.filterBy))) {
    out.push(`${fat}.filterBy「${f.filterBy}」要是本实体和「${target.kind}」都有的字段`);
  }
}

/** 值是数组的字段：tags、有序子项、多选引用、不按字符串存的多选 enum */
const isArrayField = (f: FieldDef): boolean =>
  f.type === 'tags' || f.type === 'subItems' || (f.multiple === true && (f.type === 'reference' || (f.type === 'enum' && !f.storeAs)));

// ── 上架前检查（spec「校验」）：界面实时算，必须项全过当且仅当产品库 schema 的 safeParse 成功（不变量 15） ──
// 输入是表单状态：选填字段清空就是删键（spec「表单状态与提交」），所以选填字段没填不查；填了就按类型查，写得不对一样拦上架。
// 这里不查的两种由服务端 schema 兜底（保存时 422）：payload 里没有对应 FieldDef 的键；showWhen 没显示出来的字段却带着值。
// 数值的 max 只是输入框的上限，不算检查项：spec 列的必须项来源是 required、min、showWhen、countFrom 和各类型的格式要求。

const EMPTY = '没填';
const UNPICKED = '没选';
const BAD_SHAPE = '格式不对';
const NOT_OPTION = '不在可选项里';
/** 编号的格式说明（上架前检查、复制为新草稿的新编号都用这句） */
export const CODE_RULE = '只能是小写字母、数字和连字符，以字母或数字开头，最长64位';
/** zod 的 int() 只收安全整数（绝对值不超过 2^53-1），17 位的数字在输入框里敲得出来 */
const TOO_BIG = '数字太大';
const MONTHS_RULE = '要写出月份（如「6-9月」「11月-次年4月」）或「全年」';

/** 条数的量词：有序子项取 itemNoun，其余按「项」「个」 */
const nounOf = (f: FieldDef): string => (f.type === 'subItems' ? (f.itemNoun ?? '项') : f.type === 'tags' ? '个' : '项');

/** 文字：非空、存得下（与 schema 的 text 相同） */
function textProblem(v: unknown): string | null {
  if (typeof v !== 'string') return BAD_SHAPE;
  if (v === '') return EMPTY;
  return storableText(v) ? null : UNSTORABLE_TEXT;
}

/** 一串文字（tags、多选引用）：每项都是非空文字 */
function textsProblem(v: unknown[]): string | null {
  const bad = v.map(textProblem).find((m) => m !== null);
  return bad === undefined ? null : bad === EMPTY ? '有一项是空的' : bad;
}

/** 多选 enum：每项都在 options 里 */
function optionsProblem(f: FieldDef, v: unknown[]): string | null {
  const bad = v.find((x) => typeof x !== 'string' || !f.options?.includes(x));
  return bad === undefined ? null : `「${String(bad)}」${NOT_OPTION}`;
}

/** 数组类型的 min：至少几项，拦上架 */
function minProblem(f: FieldDef, n: number): string | null {
  if (f.min === undefined || n >= f.min) return null;
  return f.type === 'subItems' ? `至少${f.min}${nounOf(f)}` : f.type === 'tags' ? `至少${f.min}个` : `至少选${f.min}项`;
}

/** 字段有值时按类型查；返回的问题都挂在这个字段上（有序子项的逐项缺漏挂在子路径上） */
function problems(f: FieldDef, v: unknown, path: string, label: string): CheckIssue[] {
  const one = (message: string | null): CheckIssue[] => (message === null ? [] : [{ path, label, message }]);
  switch (f.type) {
    case 'text':
    case 'longText':
      return one(textProblem(v) ?? (f.key === '$code' && !CATALOG_CODE.test(v as string) ? CODE_RULE : null));
    case 'monthRange':
      return one(textProblem(v) ?? (monthsReadable(v as string) ? null : MONTHS_RULE));
    case 'money':
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return one('要是大于0的整数');
      if (!Number.isSafeInteger(v)) return one(TOO_BIG);
      return one(f.min !== undefined && v < f.min ? `至少${f.min}${f.unit ?? ''}` : null);
    case 'intUnit':
      if (typeof v !== 'number' || !Number.isInteger(v)) return one('要是整数');
      if (v < (f.min ?? 0)) return one(`至少${f.min ?? 0}${f.unit ?? ''}`);
      return one(Number.isSafeInteger(v) ? null : TOO_BIG);
    case 'boolean':
      return one(typeof v === 'boolean' ? null : BAD_SHAPE);
    case 'enum':
      // 按字符串存的多选（旅游包的「当天餐食」）：规则之外的旧值照原文保留（spec「表单状态与提交」），只要求非空
      if (f.storeAs) return one(v === '' ? UNPICKED : textProblem(v));
      if (!f.multiple) return one(v === '' ? UNPICKED : typeof v === 'string' && f.options?.includes(v) ? null : NOT_OPTION);
      return one(Array.isArray(v) ? (optionsProblem(f, v) ?? minProblem(f, v.length)) : BAD_SHAPE);
    case 'tags':
      return one(Array.isArray(v) ? (textsProblem(v) ?? minProblem(f, v.length)) : BAD_SHAPE);
    case 'reference':
      if (!f.multiple) return one(textProblem(v));
      return one(Array.isArray(v) ? (textsProblem(v) ?? minProblem(f, v.length)) : BAD_SHAPE);
    case 'subItems':
      return Array.isArray(v) ? [...one(minProblem(f, v.length)), ...itemProblems(f, v, path, label)] : one(BAD_SHAPE);
    case 'status':
      return [];
  }
}

/** 有序子项的逐项检查：每处缺漏一条，标签写到第几项，如「逐日行程 · 第3天 · 当晚住宿」 */
function itemProblems(f: FieldDef, items: unknown[], path: string, label: string): CheckIssue[] {
  const subs = f.item ?? [];
  const out: CheckIssue[] = [];
  items.forEach((el, i) => {
    const p = `${path}.${i}`;
    const l = `${label} · 第${i + 1}${nounOf(f)}`;
    // 只有一个 key 为空的子字段：每项就是一个值（行程亮点这类 string[]）
    if (subs.length === 1 && subs[0].key === '') {
      out.push(...fieldIssues(subs[0], el, p, l));
      return;
    }
    if (!isRecord(el)) {
      out.push({ path: p, label: l, message: BAD_SHAPE });
      return;
    }
    if (f.autoIndexKey !== undefined && el[f.autoIndexKey] !== i + 1) {
      out.push({ path: `${p}.${f.autoIndexKey}`, label: l, message: `序号应为${i + 1}` });
    }
    for (const s of subs) {
      out.push(...fieldIssues(s, Object.hasOwn(el, s.key) ? el[s.key] : undefined, `${p}.${s.key}`, `${l} · ${s.label}`));
    }
  });
  return out;
}

/** 一个字段的问题：必填的缺了报「没填」或「没选」；选填的没填不查 */
function fieldIssues(f: FieldDef, v: unknown, path: string, label: string): CheckIssue[] {
  if (f.required === false && !filled(v)) return [];
  if (v === undefined || v === null) return [{ path, label, message: f.type === 'enum' || f.type === 'boolean' ? UNPICKED : EMPTY }];
  return problems(f, v, path, label);
}

/** 建议项的说法：recommend 为 true 写「没填」；给了条数写「建议3–5条」 */
function rangeText(r: { min?: number; max?: number }, noun: string): string {
  if (r.min !== undefined && r.max !== undefined) return `建议${r.min}–${r.max}${noun}`;
  return r.min !== undefined ? `建议至少${r.min}${noun}` : `建议不超过${r.max ?? 0}${noun}`;
}

/**
 * 上架前检查。计数口径（spec「校验」）：每个必填的顶层字段算一项，有序子项算一项、子项里的缺漏都列在这一项下；
 * countFrom 的条数一致算一项；showWhen 显示出来的字段各算一项，没显示出来的不查也不计。
 * 选填字段只在填了却写得不对时算一项（这时它一样拦上架）。status 字段不查
 */
export function checkItem(entity: EntityType, payload: Record<string, unknown>): ItemCheck {
  const required: CheckIssue[] = [];
  const recommended: CheckIssue[] = [];
  let total = 0;
  let failed = 0;
  const count = (issues: CheckIssue[]): void => {
    total += 1;
    if (issues.length === 0) return;
    failed += 1;
    required.push(...issues);
  };
  for (const f of entity.fields) {
    if (f.type === 'status') continue;
    if (f.showWhen && !filled(valueAt(payload, f.showWhen.key))) continue;
    const v = valueAt(payload, f.key);
    const issues = fieldIssues(f, v, f.key, f.label);
    if (f.required !== false || issues.length > 0) count(issues);

    if (f.type === 'subItems' && f.countFrom !== undefined) {
      // 条数由另一个字段定（逐日行程随天数）：那个字段没填或没填对（天数为0、带小数）时由它自己报，这一项不重复报
      const by = entity.fields.find((x) => x.key === f.countFrom);
      const want = valueAt(payload, f.countFrom);
      const wantOk = by !== undefined && typeof want === 'number' && fieldIssues(by, want, by.key, by.label).length === 0;
      const diff = Array.isArray(v) && wantOk ? want - v.length : 0;
      const noun = nounOf(f);
      count(diff === 0 ? [] : [{ path: f.key, label: f.label, message: diff > 0 ? `还差${diff}${noun}` : `多了${-diff}${noun}` }]);
    }

    if (f.recommend === undefined || issues.length > 0) continue;
    if (f.recommend === true) {
      if (!filled(v)) recommended.push({ path: f.key, label: f.label, message: EMPTY });
    } else {
      const n = Array.isArray(v) ? v.length : 0;
      const { min, max } = f.recommend;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        recommended.push({ path: f.key, label: f.label, message: rangeText(f.recommend, nounOf(f)) });
      }
    }
  }
  return { requiredTotal: total, requiredPassed: total - failed, required, recommended };
}
