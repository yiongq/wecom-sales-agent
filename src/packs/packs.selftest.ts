// 行业包的自测（docs/features/console-ux/spec.md「行业包通用架构」「校验」，不变量 13–15）。挂在 `pnpm test` 里。
// 用法：pnpm exec tsx src/packs/packs.selftest.ts
//
// 四块：
// 1. ENTITY_ICONS 等于设计系统 §7「实体图标集合」那一行（从文档里读，不照抄实现）；
// 2. 不变量 13：每个注册的包和假包都过 checkPack；把旅游包逐处改坏，checkPack 都点得出来；
// 3. 不变量 14：旅游包与代码逐项一致：工具名、话术字段、节表、锁定表、销售阶段，schema 的属性路径、枚举取值与选填；
// 4. 不变量 15：data/ 下每条线路和酒店，加上一组按字段配置生成的变异，checkItem 的必须项全过当且仅当 schema 的 safeParse 成功；
//    再用草稿线路 r-guizhou-5d（设计系统 §10.0）钉住计数口径，逐类型核对报错的说法，最后在假包上走一遍旅游包没有的类型。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ALWAYS_LOCKED, CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, type CatalogKind } from '../shared/catalog.js';
import { UNSTORABLE_TEXT } from '../shared/console-api.js';
import { renovationLPage } from '../shared/pack-fixtures/renovation-l-page.js';
import { renovation } from '../shared/pack-fixtures/renovation.js';
import {
  checkItem,
  checkPack,
  ENTITY_ICONS,
  type CheckIssue,
  type EntityType,
  type FieldDef,
  type IndustryPack,
  type ItemCheck,
} from '../shared/pack.js';
import { SOP_KNOWN_FIELDS } from '../sop/contract.js';
import { TRAVEL_SOP_SECTIONS } from '../sop/sections.js';
import { toolDefs } from '../tool-defs.js';
import type { SalesStage } from '../types.js';
import { PACK_IDS, packById } from './registry.js';

const root = path.join(import.meta.dirname, '..', '..');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(detail ? `${name}：${detail}` : name);
}
const json = (v: unknown): string => JSON.stringify(v);
function checkSame(name: string, got: unknown, want: unknown): void {
  check(name, json(got) === json(want), `得到 ${json(got)}，期望 ${json(want)}`);
}
const sorted = (xs: Iterable<string>): string[] => [...xs].toSorted();

type Payload = Record<string, unknown>;
/** 变异要往 payload 里任意写，自测里放开类型 */
type Loose = Record<string, any>;

const travel = packById('travel');
if (!travel) {
  console.error('PACKS SELFTEST FAIL: 注册表里没有 travel');
  process.exit(1);
}
const entityOf = (p: IndustryPack, kind: string): EntityType => {
  const e = p.entities.find((x) => x.kind === kind);
  if (!e) throw new Error(`${p.id} 没有实体 ${kind}`);
  return e;
};
const fieldOf = (e: EntityType, key: string): FieldDef => {
  const f = e.fields.find((x) => x.key === key);
  if (!f) throw new Error(`${e.kind} 没有字段 ${key}`);
  return f;
};
const subOf = (e: EntityType, key: string, sub: string): FieldDef => {
  const s = fieldOf(e, key).item?.find((x) => x.key === sub);
  if (!s) throw new Error(`${e.kind}.${key} 没有子字段 ${sub}`);
  return s;
};
const ROUTE = entityOf(travel, 'route');
const HOTEL = entityOf(travel, 'hotel');

// ── 1. 实体图标集合 ──

{
  const lines = fs.readFileSync(path.join(root, 'docs/features/console-ux/design-system.md'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('**实体图标集合**'));
  const setLine = at < 0 ? '' : (lines.slice(at + 1).find((l) => l.trim() !== '') ?? '');
  const docIcons = [...setLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  check('设计系统 §7 里找得到实体图标集合', docIcons.length > 0);
  checkSame('ENTITY_ICONS 等于设计系统 §7 的实体图标集合（名字与顺序）', [...ENTITY_ICONS], docIcons);
  check('ENTITY_ICONS 冻结', Object.isFrozen(ENTITY_ICONS));
}

// ── 2. 不变量 13：checkPack ──

const packs: [string, IndustryPack][] = [
  ...PACK_IDS.map((id): [string, IndustryPack] => [id, packById(id)!]),
  ['renovation（假包）', renovation],
  ['renovation（假包冻结的 L 页版）', renovationLPage],
];
for (const [name, p] of packs) checkSame(`${name} 过 checkPack`, checkPack(p), []);
check('假包不进注册表', packById('renovation') === null && !PACK_IDS.includes('renovation'));

/** 把一份包的副本改坏一处，checkPack 要有一条含 want 的问题 */
const BREAKS: [string, IndustryPack, (p: IndustryPack) => void, string][] = [
  ['字段的分组不存在', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'title').group = 'nope'), 'fields[title].group「nope」'],
  [
    '锁定组不存在',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'priceFrom').lockGroup = 'nope'),
    'fields[priceFrom].lockGroup「nope」',
  ],
  [
    '上架后锁定却没有锁定组',
    travel,
    (p) => void delete fieldOf(entityOf(p, 'route'), 'title').lockGroup,
    'fields[title]：上架后锁定的字段要有 lockGroup',
  ],
  ['countFrom 指向不存在的字段', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'itinerary').countFrom = 'nope'), 'countFrom「nope」'],
  [
    'countFrom 指向非 intUnit 字段',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'itinerary').countFrom = 'title'),
    'countFrom「title」',
  ],
  [
    'countFrom 写在非 subItems 上',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'tags').countFrom = 'days'),
    'fields[tags].countFrom 只能用在 subItems 上',
  ],
  ['reference.to 不是本包的实体', travel, (p) => void (subOf(entityOf(p, 'route'), 'itinerary', 'hotel').to = 'inn'), '.to「inn」'],
  ['reference 没写 to', travel, (p) => void delete subOf(entityOf(p, 'route'), 'itinerary', 'hotel').to, '.to「」'],
  [
    'filterBy 对方没有这个字段',
    travel,
    (p) => void (subOf(entityOf(p, 'route'), 'itinerary', 'hotel').filterBy = 'days'),
    'filterBy「days」',
  ],
  [
    'filterBy 本实体没有这个字段',
    travel,
    (p) => void (subOf(entityOf(p, 'route'), 'itinerary', 'hotel').filterBy = 'stars'),
    'filterBy「stars」',
  ],
  [
    'showWhen 指向不存在的字段',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'intensity.hardest').showWhen = { key: 'intensity.levl', filled: true }),
    'showWhen.key「intensity.levl」',
  ],
  [
    'showWhen 指向自己',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'intensity.hardest').showWhen = { key: 'intensity.hardest', filled: true }),
    'showWhen.key「intensity.hardest」',
  ],
  [
    'unitFrom 指向不存在的字段',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'priceFrom').unitFrom = 'currency'),
    'unitFrom「currency」',
  ],
  [
    'unitFrom 指向多选 enum',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'priceFrom').unitFrom = 'segments'),
    'unitFrom「segments」',
  ],
  [
    'unitFrom 指向文字字段',
    renovation,
    (p) => void (fieldOf(entityOf(p, 'material'), 'unitPrice').unitFrom = 'brand'),
    'unitFrom「brand」',
  ],
  ['nav.entities 不是本包的实体', travel, (p) => void p.nav.entities.push('flight'), 'nav.entities「flight」'],
  ['nav.entities 重复', travel, (p) => void p.nav.entities.push('route'), 'nav.entities：「route」重复'],
  ['实体图标不在集合里', travel, (p) => void (entityOf(p, 'route').icon = 'bus'), 'icon「bus」'],
  ['实体图标大小写不对', renovation, (p) => void (entityOf(p, 'package').icon = 'Package'), 'icon「Package」'],
  [
    '字段 key 重复',
    travel,
    (p) => void entityOf(p, 'route').fields.push({ ...fieldOf(entityOf(p, 'route'), 'title') }),
    'fields：key「title」重复',
  ],
  ['实体 kind 重复', travel, (p) => void p.entities.push({ ...entityOf(p, 'hotel') }), 'kind「hotel」重复'],
  ['分组 key 重复', travel, (p) => void entityOf(p, 'hotel').groups.push({ key: 'basic', label: '又一个' }), 'groups：key「basic」重复'],
  ['锁定组没写原因', travel, (p) => void (entityOf(p, 'hotel').lockGroups.price.reason = ''), 'lockGroups[price]：tag 和 reason 都要写'],
  ['锁定组没写标签', travel, (p) => void (entityOf(p, 'hotel').lockGroups.price.tag = ''), 'lockGroups[price]：tag 和 reason 都要写'],
  ['列表列不是本实体的字段', travel, (p) => void entityOf(p, 'route').list.columns.push('rating'), 'list.columns「rating」'],
  ['筛选不是本实体的字段', travel, (p) => void entityOf(p, 'hotel').list.filters.push('stars2'), 'list.filters「stars2」'],
  ['搜索不是本实体的字段', travel, (p) => void entityOf(p, 'hotel').list.search.push('city'), 'list.search「city」'],
  ['副标题不是本实体的字段', travel, (p) => void entityOf(p, 'hotel').subtitleKeys.push('city'), 'subtitleKeys「city」'],
  ['titleKey 不是本实体的字段', travel, (p) => void (entityOf(p, 'route').titleKey = 'name'), 'titleKey「name」'],
  ['上架确认句的占位不是字段', travel, (p) => void (entityOf(p, 'route').activateLine += '，{price}'), '「{price}」'],
  ['enum 没有 options', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'segments').options = []), 'fields[segments].options 是空的'],
  [
    'enum 的 options 重复',
    travel,
    (p) => void fieldOf(entityOf(p, 'route'), 'segments').options?.push('家庭'),
    'fields[segments].options 有重复',
  ],
  [
    'storeAs 写在单选 enum 上',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'intensity.level').storeAs = { join: '/', empty: '—' }),
    'fields[intensity.level].storeAs',
  ],
  ['multiple 写在 text 上', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'title').multiple = true), 'fields[title].multiple'],
  ['subItems 没有 item', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'highlights').item = []), 'fields[highlights].item 是空的'],
  [
    '空 key 的子字段不是唯一的一个',
    travel,
    (p) => void fieldOf(entityOf(p, 'route'), 'highlights').item?.push({ key: 'note', type: 'text', label: '备注', group: '' }),
    'fields[highlights].item：key 为空时只能有这一个字段',
  ],
  [
    '子字段 key 重复',
    travel,
    (p) => void fieldOf(entityOf(p, 'route'), 'itinerary').item?.push({ ...subOf(entityOf(p, 'route'), 'itinerary', 'title') }),
    'fields[itinerary].item：key「title」重复',
  ],
  [
    'autoIndexKey 写在单值的有序子项上',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'highlights').autoIndexKey = 'n'),
    'fields[highlights].autoIndexKey 只能用在子字段是对象的有序子项上',
  ],
  [
    'autoIndexKey 与子字段重复',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'itinerary').autoIndexKey = 'title'),
    'autoIndexKey「title」与子字段重复',
  ],
  [
    '子字段是 status 类型',
    renovation,
    (p) => void (subOf(entityOf(p, 'package'), 'nodes', 'checkpoints').type = 'status'),
    'item[checkpoints]：有序子项里的字段不支持 status 类型',
  ],
  [
    '子字段又是有序子项',
    renovation,
    (p) => void (subOf(entityOf(p, 'package'), 'nodes', 'checkpoints').type = 'subItems'),
    'item[checkpoints]：有序子项里的字段不支持 subItems 类型',
  ],
  ['子字段写了分组', travel, (p) => void (subOf(entityOf(p, 'route'), 'itinerary', 'hotel').group = 'basic'), 'item[hotel].group 要是空串'],
  [
    'recommend 的条数写在非数组字段上',
    travel,
    (p) => void (fieldOf(entityOf(p, 'route'), 'title').recommend = { min: 1 }),
    'fields[title].recommend 的 min、max',
  ],
  [
    'recommend 的条数写在按字符串存的多选 enum 上',
    travel,
    (p) => void Object.assign(fieldOf(entityOf(p, 'route'), 'segments'), { storeAs: { join: '/', empty: '—' }, recommend: { min: 1 } }),
    'fields[segments].recommend 的 min、max',
  ],
  [
    '未知的系统字段',
    travel,
    (p) => void entityOf(p, 'hotel').fields.push({ key: '$price', type: 'money', label: '价', group: 'price' }),
    'fields[$price]：系统字段只有',
  ],
  ['status 类型用在别的字段上', travel, (p) => void (fieldOf(entityOf(p, 'hotel'), 'stars').type = 'status'), 'fields[stars]：status 类型'],
  [
    '$status 不是 status 类型',
    travel,
    (p) => void (fieldOf(entityOf(p, 'hotel'), '$status').type = 'text'),
    'fields[$status]：$status 只能是',
  ],
  ['阶段的 branchOf 不是本包的阶段', travel, (p) => void (p.stages.at(-1)!.branchOf = 'price'), 'branchOf「price」'],
  [
    '阶段的 branchOf 指向自己',
    travel,
    (p) => void p.stages.push({ key: 'self', label: '自己', branchOf: 'self' }),
    'stages[self].branchOf「self」',
  ],
  [
    '阶段 key 重复',
    renovation,
    (p) => void p.stages.push({ key: 'dup', label: '甲' }, { key: 'dup', label: '乙' }),
    'stages：key「dup」重复',
  ],
  [
    '锁定的话术节没写原因',
    travel,
    (p) => void p.sopSections.push({ key: 'extra', heading: '多一节', locked: true }),
    'sopSections[extra]：锁定的节要写 lockReason',
  ],
  [
    '话术节 key 重复',
    travel,
    (p) => void p.sopSections.push({ key: 'dup', heading: '甲', locked: false }, { key: 'dup', heading: '乙', locked: false }),
    'sopSections：key「dup」重复',
  ],
  [
    '前言以外的节没有标题',
    travel,
    (p) => void p.sopSections.push({ key: 'nohead', heading: null, locked: false }),
    'sopSections[nohead]：只有第一节（前言）可以没有 heading',
  ],
];
// 有序子项里的字段不支持的配置，逐个写到「逐日行程 · 标题」上（上架前检查与锁定都按顶层字段算）
const IN_ITEM: Partial<FieldDef> = {
  showWhen: { key: 'title', filled: true },
  countFrom: 'days',
  recommend: true,
  lockedWhenActive: true,
  lockGroup: 'id',
  unitFrom: 'overseas',
};
for (const [prop, value] of Object.entries(IN_ITEM)) {
  BREAKS.push([
    `子字段用了 ${prop}`,
    travel,
    (p) => void Object.assign(subOf(entityOf(p, 'route'), 'itinerary', 'title'), { [prop]: value }),
    `item[title]：有序子项里的字段不支持 ${prop}`,
  ]);
}
for (const [name, base, breakIt, want] of BREAKS) {
  const p = structuredClone(base);
  breakIt(p);
  const got = checkPack(p);
  check(
    `checkPack 点得出：${name}`,
    got.some((m) => m.includes(want)),
    `期望有一条含「${want}」，得到 ${json(got)}`,
  );
}

/** 反过来：这些改法仍是合规的包，checkPack 不该报 */
const FINE: [string, IndustryPack, (p: IndustryPack) => void][] = [
  ['recommend 的条数写在多选引用上', renovation, (p) => void (fieldOf(entityOf(p, 'package'), 'materials').recommend = { max: 8 })],
  ['recommend 的条数写在多选 enum 上', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'segments').recommend = { min: 2 })],
  ['recommend 的条数写在标签上', travel, (p) => void (fieldOf(entityOf(p, 'route'), 'tags').recommend = { max: 6 })],
];
for (const [name, base, change] of FINE) {
  const p = structuredClone(base);
  change(p);
  checkSame(`checkPack 放过：${name}`, checkPack(p), []);
}

// ── 3. 不变量 14：旅游包与代码一致 ──

checkSame(
  'vocabulary.tools 的键等于 toolDefs 的工具名',
  sorted(Object.keys(travel.vocabulary.tools)),
  sorted(toolDefs.map((t) => t.function.name)),
);
checkSame('vocabulary.sopFields 的键等于 SOP_KNOWN_FIELDS', sorted(Object.keys(travel.vocabulary.sopFields)), sorted(SOP_KNOWN_FIELDS));
checkSame(
  'sopSections 的 key、heading、locked 与顺序等于 TRAVEL_SOP_SECTIONS',
  travel.sopSections.map((s) => [s.key, s.heading, s.locked]),
  TRAVEL_SOP_SECTIONS.map((s) => [s.key, s.heading, s.locked]),
);

/** SalesStage 的全部取值。写成 Record：类型里加减一个值，这里不跟着改 typecheck 就失败 */
const SALES_STAGES: Record<SalesStage, true> = {
  greeting: true,
  discovery: true,
  recommend: true,
  quote: true,
  objection: true,
  closing: true,
  paid: true,
  handoff: true,
};
{
  const keys = travel.stages.map((s) => s.key);
  check('stages 不含 handoff（它对应会话状态「等人接手」，不算阶段）', !keys.includes('handoff'));
  // 集合相等而不只是「都是」：阶段条按包里的 stages 画，少一个阶段，停在那一步的会话就不进阶段条，合计对不上「AI接待中」（验收 6）
  checkSame('stages 的 key 正好是 SalesStage 除去 handoff', sorted(keys), sorted(Object.keys(SALES_STAGES).filter((k) => k !== 'handoff')));
}

checkSame('旅游包的实体正好是产品库的两类', sorted(travel.entities.map((e) => e.kind)), sorted(Object.keys(CATALOG_SCHEMAS)));

/** schema 的叶子：对象往下走，对象数组记成 `key[].子键`；ownOptional 是这一层自己是不是 optional */
function schemaLeaves(s: z.ZodType, prefix: string, out: Map<string, { leaf: z.ZodType; ownOptional: boolean }>, opt = false): void {
  if (s instanceof z.ZodOptional) return schemaLeaves(s.unwrap() as z.ZodType, prefix, out, true);
  if (s instanceof z.ZodObject) {
    for (const [k, v] of Object.entries(s.shape)) schemaLeaves(v as z.ZodType, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  if (s instanceof z.ZodArray && s.element instanceof z.ZodObject) return schemaLeaves(s.element, `${prefix}[]`, out);
  out.set(prefix, { leaf: s, ownOptional: opt });
}

/** 字段配置的叶子：`$code` 是 id；多字段的有序子项记成 `key[].子键`，autoIndexKey 也是一个子键 */
function packLeaves(e: EntityType): Map<string, FieldDef | 'autoIndex'> {
  const out = new Map<string, FieldDef | 'autoIndex'>();
  for (const f of e.fields) {
    if (f.type === 'status') continue;
    const key = f.key === '$code' ? 'id' : f.key;
    const items = f.item ?? [];
    if (f.type === 'subItems' && !(items.length === 1 && items[0].key === '')) {
      for (const s of items) out.set(`${key}[].${s.key}`, s);
      if (f.autoIndexKey) out.set(`${key}[].${f.autoIndexKey}`, 'autoIndex');
    } else out.set(key, f);
  }
  return out;
}

for (const e of travel.entities) {
  const kind = e.kind as CatalogKind;
  const locked = e.fields.flatMap((f) =>
    f.lockedWhenActive === true ? [f.key] : f.lockedWhenActive ? f.lockedWhenActive.members.map((m) => `${f.key}:${m}`) : [],
  );
  checkSame(
    `${kind}：带 lockedWhenActive 的字段（加上永远只读的编号）等于 LOCKED_WHEN_ACTIVE`,
    sorted([...locked, ...ALWAYS_LOCKED]),
    sorted(LOCKED_WHEN_ACTIVE[kind]),
  );

  const fromSchema = new Map<string, { leaf: z.ZodType; ownOptional: boolean }>();
  schemaLeaves(CATALOG_SCHEMAS[kind] as z.ZodType, '', fromSchema);
  const fromPack = packLeaves(e);
  checkSame(`${kind}：schema 的属性路径与 FieldDef 一一对应`, sorted(fromSchema.keys()), sorted(fromPack.keys()));
  for (const [p, { leaf, ownOptional }] of fromSchema) {
    const f = fromPack.get(p);
    if (!f || f === 'autoIndex') continue;
    const inner = leaf instanceof z.ZodArray ? (leaf.element as z.ZodType) : leaf;
    if (inner instanceof z.ZodEnum) {
      checkSame(`${kind}.${p}：options 等于 schema 的枚举取值`, sorted(f.options ?? []), sorted(inner.options as string[]));
    } else {
      check(`${kind}.${p}：schema 不是枚举，字段就不是按 options 校验的 enum`, f.type !== 'enum' || f.storeAs !== undefined);
    }
    // 选填与否：顶层键与有序子项的子键逐个比。'intensity.level' 这类嵌套键跟着父对象（整个 intensity 是选填的），不比
    if (!/^\w+$|^\w+\[\]\.\w+$/.test(p)) continue;
    check(`${kind}.${p}：FieldDef 的 required 与 schema 的 optional 一致`, (f.required === false) === ownOptional);
  }
}

// ── 4. 不变量 15：checkItem 的必须项全过当且仅当 schema 通过 ──

const DATA: Record<CatalogKind, Payload[]> = {
  route: JSON.parse(fs.readFileSync(path.join(root, 'data/routes.json'), 'utf8')) as Payload[],
  hotel: JSON.parse(fs.readFileSync(path.join(root, 'data/hotels.json'), 'utf8')) as Payload[],
};

interface Case {
  name: string;
  payload: Payload;
  /** 两边都该给的结论；undefined 只比两边相同 */
  want?: boolean;
}

/** 'a.b' 路径的读写（变异用） */
const getAt = (p: Loose, key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o as Loose | undefined)?.[k], p);
function setAt(p: Loose, key: string, v: unknown): void {
  const ks = key.split('.');
  const last = ks.pop()!;
  (ks.reduce((o, k) => o[k] as Loose, p) as Loose)[last] = v;
}
function deleteAt(p: Loose, key: string): void {
  const ks = key.split('.');
  const last = ks.pop()!;
  delete (ks.reduce((o, k) => o[k] as Loose, p) as Loose)[last];
}

/**
 * 按字段配置生成变异：spec 列的五类（逐个删掉必填字段、条数与天数不符、最佳季节写不出月份、金额写成字符串、必填数组写成空数组），
 * 外加各类型的格式要求。选填字段不造「写成空值」：表单把清空的选填字段删键（spec「表单状态与提交」），这种 payload 只能由
 * 服务端 schema 拦，不在 checkItem 的定义域里
 */
function cases(e: EntityType, item: Payload): Case[] {
  const out: Case[] = [{ name: '原样', payload: item, want: true }];
  const add = (name: string, want: boolean | undefined, change: (p: Loose) => void): void => {
    const p = structuredClone(item) as Loose;
    change(p);
    out.push({ name, payload: p, want });
  };
  const byKey = new Map(e.fields.map((f) => [f.key === '$code' ? 'id' : f.key, f]));
  // 逐个删掉顶层键：必填的两边都不过，选填的两边都过；intensity 这类整个对象只比两边相同
  for (const k of Object.keys(item)) add(`删掉 ${k}`, byKey.has(k) ? byKey.get(k)!.required === false : undefined, (p) => delete p[k]);

  for (const [key, f] of byKey) {
    if (f.type === 'status') continue;
    const v = getAt(item, key);
    if (v === undefined) continue;
    const req = f.required !== false;
    const set = (name: string, want: boolean | undefined, value: unknown): void => add(`${key} ${name}`, want, (p) => setAt(p, key, value));
    if (key.includes('.') && req) add(`删掉 ${key}`, false, (p) => deleteAt(p, key));
    const countedBy = e.fields.find((x) => x.countFrom === f.key);
    switch (f.type) {
      case 'text':
      case 'longText':
        set('写成数字', false, 123);
        if (req) set('写成空串', false, '');
        set('带 NUL 字符', false, `a${String.fromCharCode(0)}b`);
        if (key === 'id') {
          set('写成大写和下划线', false, 'R_Bad');
          set('长65位', false, 'a'.repeat(65));
          set('长64位', true, 'a'.repeat(64));
        }
        break;
      case 'money':
        set('写成字符串', false, String(v));
        set('为0', false, 0);
        set('为负数', false, -1);
        set('带小数', false, 1.5);
        set('为1', true, 1);
        set('超出安全整数', false, 2 ** 53);
        set('等于最大安全整数', true, Number.MAX_SAFE_INTEGER);
        break;
      case 'intUnit':
        set('写成字符串', false, String(v));
        set('带小数', false, 1.5);
        set('为负数', false, -1);
        if (f.min !== undefined) set('小于下限', false, f.min - 1);
        if (!countedBy) set('等于下限', true, f.min ?? 0);
        set('超出安全整数', false, 2 ** 53);
        if (!countedBy) set('等于最大安全整数', true, Number.MAX_SAFE_INTEGER);
        break;
      case 'monthRange':
        set('写不出月份', false, '四季皆宜');
        set('写成「全年」', true, '全年');
        set('写成跨年区间', true, '11月-次年4月');
        if (req) set('写成空串', false, '');
        break;
      case 'boolean':
        set('写成字符串', false, String(v));
        set('取反', true, !v);
        break;
      case 'enum':
        if (f.multiple) {
          set('多一项不在选项里的', false, [...(v as unknown[]), '不在选项里']);
          if (req) set('写成空数组', (f.min ?? 0) === 0, []);
          set('写成字符串', false, (v as string[]).join('、'));
        } else {
          set('不在选项里', false, '不在选项里');
          if (req) set('写成空串', false, '');
          for (const o of f.options ?? []) set(`取「${o}」`, true, o);
        }
        break;
      case 'tags':
        if (req) set('写成空数组', (f.min ?? 0) === 0, []);
        set('多一项空串', false, [...(v as unknown[]), '']);
        set('多一项', true, [...(v as unknown[]), '多一项']);
        set('写成字符串', false, 'x');
        break;
      case 'subItems': {
        const arr = v as Loose[];
        if (req) set('写成空数组', f.min === undefined && f.countFrom === undefined, []);
        set('写成字符串', false, 'x');
        const items = f.item ?? [];
        if (items.length === 1 && items[0].key === '') {
          set('第1项是空串', false, ['', ...arr.slice(1)]);
          set('多一项数字', false, [...arr, 1]);
          if (!f.countFrom) set('多一项', true, [...arr, '多一项']);
          break;
        }
        add(`${key} 第1项写成字符串`, false, (p) => void (p[key][0] = 'x'));
        for (const s of items) {
          const sreq = s.required !== false;
          for (const i of new Set([0, arr.length - 1])) {
            const at = `${key} 第${i + 1}项的 ${s.key}`;
            add(`删掉${at}`, !sreq, (p) => delete p[key][i][s.key]);
            if (sreq) add(`${at} 写成空串`, false, (p) => void (p[key][i][s.key] = ''));
            add(`${at} 写成数字`, false, (p) => void (p[key][i][s.key] = 7));
            if (s.storeAs) add(`${at} 写成规则之外的旧值`, true, (p) => void (p[key][i][s.key] = '早餐自理'));
          }
        }
        if (f.autoIndexKey) add(`${key} 第1项的序号写错`, false, (p) => void (p[key][0][f.autoIndexKey!] = 2));
        if (f.countFrom) {
          const n = arr.length;
          const extra = (p: Loose): void => void p[key].push({ ...p[key][n - 1], ...(f.autoIndexKey ? { [f.autoIndexKey]: n + 1 } : {}) });
          add(`${key} 少一项`, false, (p) => void p[key].pop());
          add(`${key} 多一项`, false, extra);
          add(`${f.countFrom} 加一`, false, (p) => setAt(p, f.countFrom!, n + 1));
          add(`${key} 多一项，${f.countFrom} 也加一`, true, (p) => {
            extra(p);
            setAt(p, f.countFrom!, n + 1);
          });
        }
        break;
      }
      case 'reference': // 旅游包的引用都在有序子项里（当晚住宿），按子字段变异
        break;
    }
  }
  return out;
}

let total = 0;
let valid = 0;
{
  const mismatches: string[] = [];
  const wrongWant: string[] = [];
  const bad: string[] = [];
  for (const e of travel.entities) {
    const schema = CATALOG_SCHEMAS[e.kind as CatalogKind];
    for (const item of DATA[e.kind as CatalogKind]) {
      for (const c of cases(e, item)) {
        const r = checkItem(e, c.payload);
        const ok = r.required.length === 0;
        const parsed = schema.safeParse(c.payload).success;
        total += 1;
        if (parsed) valid += 1;
        const name = `${e.kind} ${String(item.id)} ${c.name}`;
        if (ok !== parsed)
          mismatches.push(`${name}：checkItem ${ok ? '全过' : `没过 ${json(r.required)}`}，schema ${parsed ? '通过' : '不通过'}`);
        if (c.want !== undefined && (parsed !== c.want || ok !== c.want)) wrongWant.push(`${name}：应${c.want ? '通过' : '不通过'}`);
        if (ok !== (r.requiredPassed === r.requiredTotal) || r.requiredPassed < 0) bad.push(`${name}：${json(r)}`);
      }
    }
  }
  check('不变量 15：checkItem 的必须项全过，当且仅当 schema 的 safeParse 成功', mismatches.length === 0, mismatches.slice(0, 8).join('；'));
  check('变异的结论与预期相同（两边都对）', wrongWant.length === 0, wrongWant.slice(0, 8).join('；'));
  check('required 为空当且仅当 requiredPassed 等于 requiredTotal', bad.length === 0, bad.slice(0, 3).join('；'));
  check(`变异两种结论都有（共 ${total} 例，schema 通过 ${valid} 例）`, valid > DATA.route.length + DATA.hotel.length && valid < total);
  for (const kind of ['route', 'hotel'] as const) {
    check(
      `data/ 下的全部 ${kind} 都过 schema（变异的起点）`,
      DATA[kind].every((x) => CATALOG_SCHEMAS[kind].safeParse(x).success),
    );
  }
}

// spec 点名的两例：tags: [] 应通过，highlights: [] 应不过
for (const [e, item] of [
  [ROUTE, DATA.route[0]],
  [HOTEL, DATA.hotel[0]],
] as const) {
  const schema = CATALOG_SCHEMAS[e.kind as CatalogKind];
  const tagsEmpty = { ...item, tags: [] };
  const highlightsEmpty = { ...item, highlights: [] };
  check(`${e.kind}：tags 写成 [] 两边都过`, checkItem(e, tagsEmpty).required.length === 0 && schema.safeParse(tagsEmpty).success);
  checkSame(`${e.kind}：highlights 写成 [] 报「至少1条」`, checkItem(e, highlightsEmpty).required, [
    { path: 'highlights', label: e.kind === 'route' ? '行程亮点' : '酒店亮点', message: '至少1条' },
  ]);
  check(`${e.kind}：highlights 写成 [] schema 也不过`, !schema.safeParse(highlightsEmpty).success);
}

// ── 计数口径：草稿线路 r-guizhou-5d（设计系统 §10.0：12 个必填字段加条数一致，共 13 项；建议 1 条没做：体力强度没填） ──

const issue = (path: string, label: string, message: string): CheckIssue => ({ path, label, message });
{
  const src = DATA.route.find((r) => r.id === 'r-guizhou') as Loose;
  const draft: Loose = {
    id: 'r-guizhou-5d',
    title: '贵州 小七孔·西江千户苗寨 5 日',
    destination: '贵州',
    overseas: false,
    days: 5,
    priceFrom: 13800,
    hotelLevel: src.hotelLevel,
    bestSeason: '4月-10月',
    highlights: src.highlights,
    tags: ['国内', '贵州', '非遗手作', '亲子'],
    segments: ['家庭', '亲子', '银发'],
    maxAltitude: 1200,
    aliases: ['黔东南'],
    // 取 r-guizhou 的第 1、2、3、5、6 天，天号重排
    itinerary: [1, 2, 3, 5, 6].map((d, i) => ({ ...(src.itinerary as Loose[])[d - 1], day: i + 1 })),
    inclusions: src.inclusions,
    exclusions: src.exclusions,
  };
  const variant = (change: (p: Loose) => void): Loose => {
    const p = structuredClone(draft);
    change(p);
    return p;
  };
  const counts = (p: Loose): [number, number] => {
    const r = checkItem(ROUTE, p);
    return [r.requiredPassed, r.requiredTotal];
  };
  check('r-guizhou-5d 过 schema', CATALOG_SCHEMAS.route.safeParse(draft).success);
  checkSame('r-guizhou-5d：必须项13/13，建议1条没做：体力强度没填', checkItem(ROUTE, draft), {
    requiredTotal: 13,
    requiredPassed: 13,
    required: [],
    recommended: [issue('intensity.level', '体力强度', '没填')],
  });

  const noHotel = variant((p) => void delete p.itinerary[2].hotel);
  checkSame('第3天没写住宿：12/13', counts(noHotel), [12, 13]);
  checkSame('第3天没写住宿：挂在逐日行程这一项下，标签是中文路径', checkItem(ROUTE, noHotel).required, [
    issue('itinerary.2.hotel', '逐日行程 · 第3天 · 当晚住宿', '没填'),
  ]);
  const twoGaps = variant((p) => {
    delete p.itinerary[2].hotel;
    p.itinerary[3].detail = '';
  });
  checkSame('逐日行程里两处缺漏：两条问题，仍只算一项没过', [checkItem(ROUTE, twoGaps).required.length, ...counts(twoGaps)], [2, 12, 13]);

  const sixDays = variant((p) => void (p.days = 6));
  checkSame(
    '天数改成6：还差1天，12/13',
    [checkItem(ROUTE, sixDays).required, ...counts(sixDays)],
    [[issue('itinerary', '逐日行程', '还差1天')], 12, 13],
  );
  checkSame(
    '天数改成4：多了1天',
    checkItem(
      ROUTE,
      variant((p) => void (p.days = 4)),
    ).required,
    [issue('itinerary', '逐日行程', '多了1天')],
  );
  checkSame(
    '天数没填：只报天数，条数一致这一项不重复报',
    checkItem(
      ROUTE,
      variant((p) => void delete p.days),
    ).required,
    [issue('days', '天数', '没填')],
  );

  const levelOnly = variant((p) => void (p.intensity = { level: '适中' }));
  checkSame('填了体力强度：「最累的一段」显示出来、算一项，13/14', counts(levelOnly), [13, 14]);
  checkSame('填了体力强度、没写最累的一段', checkItem(ROUTE, levelOnly), {
    requiredTotal: 14,
    requiredPassed: 13,
    required: [issue('intensity.hardest', '最累的一段', '没填')],
    recommended: [],
  });
  checkSame(
    '体力强度与最累的一段都填了：14/14',
    counts(variant((p) => void (p.intensity = { level: '适中', hardest: '第3天走步道' }))),
    [14, 14],
  );

  checkSame(
    '去掉三个选填字段：计数不变，多三条建议',
    checkItem(
      ROUTE,
      variant((p) => {
        delete p.maxAltitude;
        delete p.aliases;
        delete p.inclusions;
      }),
    ),
    {
      requiredTotal: 13,
      requiredPassed: 13,
      required: [],
      recommended: [
        issue('maxAltitude', '全程最高海拔', '没填'),
        issue('intensity.level', '体力强度', '没填'),
        issue('inclusions', '费用包含', '没填'),
        issue('aliases', '客户的其他叫法', '没填'),
      ],
    },
  );
  const altitudeText = variant((p) => void (p.maxAltitude = '1200'));
  checkSame('选填字段填了却写得不对：算一项、拦上架，13/14', counts(altitudeText), [13, 14]);
  checkSame('最高海拔写成字符串', checkItem(ROUTE, altitudeText).required, [issue('maxAltitude', '全程最高海拔', '要是整数')]);

  const recOf = (change: (p: Loose) => void): CheckIssue[] => checkItem(ROUTE, variant(change)).recommended;
  checkSame(
    '行程亮点2条：建议3–5条',
    recOf((p) => void (p.highlights = p.highlights.slice(0, 2)))[1],
    issue('highlights', '行程亮点', '建议3–5条'),
  );
  checkSame(
    '行程亮点6条：建议3–5条',
    recOf((p) => void (p.highlights = [...p.highlights, 'a', 'b']))[1],
    issue('highlights', '行程亮点', '建议3–5条'),
  );
  checkSame('行程亮点5条：不提建议', recOf((p) => void (p.highlights = [...p.highlights, 'a'])).length, 1);
  checkSame('行程亮点0条：只报必须项「至少1条」，不再提建议', recOf((p) => void (p.highlights = [])).length, 1);

  const req = (change: (p: Loose) => void): CheckIssue[] => checkItem(ROUTE, variant(change)).required;
  checkSame(
    '没选境内还是境外：「没选」',
    req((p) => void delete p.overseas),
    [issue('overseas', '境内还是境外', '没选')],
  );
  checkSame(
    '境内还是境外写成字符串',
    req((p) => void (p.overseas = 'false')),
    [issue('overseas', '境内还是境外', '格式不对')],
  );
  checkSame(
    '没填线路名称：「没填」',
    req((p) => void (p.title = '')),
    [issue('title', '线路名称', '没填')],
  );
  checkSame(
    '线路名称写成数字',
    req((p) => void (p.title = 8)),
    [issue('title', '线路名称', '格式不对')],
  );
  checkSame(
    '线路名称带 NUL',
    req((p) => void (p.title = `a${String.fromCharCode(0)}`)),
    [issue('title', '线路名称', UNSTORABLE_TEXT)],
  );
  checkSame(
    '编号不合规',
    req((p) => void (p.id = 'R_5d')),
    [issue('$code', '线路编号', '只能是小写字母、数字和连字符，以字母或数字开头，最长64位')],
  );
  checkSame(
    '编号长65位：说法里有长度的限制',
    req((p) => void (p.id = 'a'.repeat(65))),
    [issue('$code', '线路编号', '只能是小写字母、数字和连字符，以字母或数字开头，最长64位')],
  );
  checkSame(
    '没有编号',
    req((p) => void delete p.id),
    [issue('$code', '线路编号', '没填')],
  );
  checkSame(
    '起价写成字符串',
    req((p) => void (p.priceFrom = '13800')),
    [issue('priceFrom', '每人起价', '要是大于0的整数')],
  );
  checkSame(
    '起价超出安全整数：数字太大',
    req((p) => void (p.priceFrom = 2 ** 53)),
    [issue('priceFrom', '每人起价', '数字太大')],
  );
  checkSame(
    '最高海拔超出安全整数：数字太大',
    req((p) => void (p.maxAltitude = 2 ** 53)),
    [issue('maxAltitude', '全程最高海拔', '数字太大')],
  );
  const zeroDays = variant((p) => void (p.days = 0));
  checkSame(
    '天数为0：只报天数「至少1天」，条数一致这一项不重复报，12/13',
    [checkItem(ROUTE, zeroDays).required, ...counts(zeroDays)],
    [[issue('days', '天数', '至少1天')], 12, 13],
  );
  checkSame(
    '天数超出安全整数：只报天数',
    req((p) => void (p.days = 2 ** 53)),
    [issue('days', '天数', '数字太大')],
  );
  checkSame(
    '天数带小数',
    req((p) => void (p.days = 5.5)),
    [issue('days', '天数', '要是整数')],
  );
  checkSame(
    '天数超过 max：max 只是输入框的上限，不拦',
    req((p) => void (p.days = 31)).map((i) => i.path),
    ['itinerary'],
  );
  checkSame(
    '最佳季节写不出月份',
    req((p) => void (p.bestSeason = '四季皆宜')),
    [issue('bestSeason', '最佳季节', '要写出月份（如「6-9月」「11月-次年4月」）或「全年」')],
  );
  checkSame(
    '适合客群有一项不在选项里',
    req((p) => void (p.segments = ['家庭', '学生'])),
    [issue('segments', '适合客群', '「学生」不在可选项里')],
  );
  checkSame(
    '适合客群为空：至少选1项',
    req((p) => void (p.segments = [])),
    [issue('segments', '适合客群', '至少选1项')],
  );
  checkSame(
    '适合客群写成字符串',
    req((p) => void (p.segments = '家庭')),
    [issue('segments', '适合客群', '格式不对')],
  );
  checkSame(
    '体力强度不在选项里：选填的填了也要对',
    req((p) => void (p.intensity = { level: '很累', hardest: 'x' })),
    [issue('intensity.level', '体力强度', '不在可选项里')],
  );
  checkSame(
    '标签有一项是空串',
    req((p) => void (p.tags = ['国内', ''])),
    [issue('tags', '标签', '有一项是空的')],
  );
  checkSame(
    '标签写成字符串',
    req((p) => void (p.tags = '国内')),
    [issue('tags', '标签', '格式不对')],
  );
  checkSame(
    '行程亮点第1条是空串',
    req((p) => void (p.highlights = ['', ...p.highlights.slice(1)])),
    [issue('highlights.0', '行程亮点 · 第1条', '没填')],
  );
  checkSame(
    '第1天的序号写错',
    req((p) => void (p.itinerary[0].day = 2)),
    [issue('itinerary.0.day', '逐日行程 · 第1天', '序号应为1')],
  );
  checkSame(
    '第2天写成字符串',
    req((p) => void (p.itinerary[1] = 'x')),
    [issue('itinerary.1', '逐日行程 · 第2天', '格式不对')],
  );
  checkSame(
    '第1天没写餐食：「没选」',
    req((p) => void delete p.itinerary[0].meals),
    [issue('itinerary.0.meals', '逐日行程 · 第1天 · 当天餐食', '没选')],
  );
  checkSame(
    '第1天的餐食是空串：「没选」',
    req((p) => void (p.itinerary[0].meals = '')),
    [issue('itinerary.0.meals', '逐日行程 · 第1天 · 当天餐食', '没选')],
  );
  checkSame(
    '第1天的餐食是规则之外的旧值：照原文保留，不拦',
    req((p) => void (p.itinerary[0].meals = '早餐自理')),
    [],
  );
  checkSame(
    '第5天的住宿写「—（返程）」：不拦',
    req((p) => void (p.itinerary[4].hotel = '—（返程）')),
    [],
  );
  checkSame(
    '逐日行程写成字符串',
    req((p) => void (p.itinerary = 'x')),
    [issue('itinerary', '逐日行程', '格式不对')],
  );
  // 原型上的名字不当字段值：payload 没有自有的 overseas 时就是没填
  checkSame(
    '只认自有属性',
    req((p) => {
      delete p.overseas;
      Object.setPrototypeOf(p, { overseas: true });
    }),
    [issue('overseas', '境内还是境外', '没选')],
  );

  // 建议项的另外两种说法：只给下限、只给上限
  const rec = structuredClone(ROUTE) as EntityType;
  fieldOf(rec, 'highlights').recommend = { min: 5 };
  fieldOf(rec, 'tags').recommend = { max: 2 };
  checkSame('建议项只给下限、只给上限', checkItem(rec, draft).recommended.slice(1), [
    issue('highlights', '行程亮点', '建议至少5条'),
    issue('tags', '标签', '建议不超过2个'),
  ]);

  // 金额的 min：两个包都没用到，在副本上配一个
  const priced = structuredClone(ROUTE) as EntityType;
  fieldOf(priced, 'priceFrom').min = 1000;
  checkSame('金额低于 min：至少1000元/人', checkItem(priced, { ...draft, priceFrom: 999 }).required, [
    issue('priceFrom', '每人起价', '至少1000元/人'),
  ]);
  checkSame('金额等于 min：不拦', checkItem(priced, { ...draft, priceFrom: 1000 }).required, []);
}

// 酒店：8 个必填字段，没有建议项
{
  const h = DATA.hotel[0];
  checkSame(`酒店 ${String(h.id)}：必须项8/8`, checkItem(HOTEL, h), { requiredTotal: 8, requiredPassed: 8, required: [], recommended: [] });
  checkSame('酒店每晚起价为0', checkItem(HOTEL, { ...h, nightlyFrom: 0 }).required, [issue('nightlyFrom', '每晚起价', '要是大于0的整数')]);
}

// ── 假包：旅游包没有的配置（多选引用、单选 enum 做计价单位、多字段的有序子项不带 countFrom、选填的子字段） ──

{
  const pkg = entityOf(renovation, 'package');
  const material = entityOf(renovation, 'material');
  const item: Loose = {
    id: 'p-nuanmu-2r',
    title: '暖木 · 两居全包经典版',
    pricePerSqm: 1280,
    minArea: 60,
    houseTypes: ['两居'],
    styles: ['原木'],
    startMonths: '3月-5月',
    duration: 75,
    demolition: true,
    materials: ['m-marcopolo-800'],
    nodes: [
      { name: '水电', days: 10, checkpoints: '打压测试', materials: ['m-marcopolo-800'] },
      { name: '泥瓦', days: 15, checkpoints: '空鼓率' },
    ],
    highlights: ['一口价'],
  };
  const variant = (change: (p: Loose) => void): Loose => {
    const p = structuredClone(item);
    change(p);
    return p;
  };
  const req = (change: (p: Loose) => void): CheckIssue[] => checkItem(pkg, variant(change)).required;
  checkSame('装修套餐：必须项12/12', checkItem(pkg, item), { requiredTotal: 12, requiredPassed: 12, required: [], recommended: [] });
  checkSame(
    '没选拆旧：「没选」',
    req((p) => void delete p.demolition),
    [issue('demolition', '拆旧', '没选')],
  );
  checkSame(
    '拆旧写成字符串',
    req((p) => void (p.demolition = 'true')),
    [issue('demolition', '拆旧', '格式不对')],
  );
  checkSame(
    '包含主材有一项是空串',
    req((p) => void (p.materials = [''])),
    [issue('materials', '包含主材', '有一项是空的')],
  );
  checkSame(
    '包含主材写成字符串',
    req((p) => void (p.materials = 'm-x')),
    [issue('materials', '包含主材', '格式不对')],
  );
  checkSame(
    '包含主材为空：必填数组只要求键在',
    req((p) => void (p.materials = [])),
    [],
  );
  checkSame(
    '适用户型有一项不在选项里',
    req((p) => void (p.houseTypes = ['别墅', '城堡'])),
    [issue('houseTypes', '适用户型', '「城堡」不在可选项里')],
  );
  checkSame(
    '第2个节点的工期为负数',
    req((p) => void (p.nodes[1].days = -1)),
    [issue('nodes.1.days', '施工节点 · 第2个节点 · 工期', '至少0天')],
  );
  checkSame(
    '第1个节点没写名称',
    req((p) => void delete p.nodes[0].name),
    [issue('nodes.0.name', '施工节点 · 第1个节点 · 节点名称', '没填')],
  );
  checkSame(
    '第1个节点的选填主材删掉：不拦',
    req((p) => void delete p.nodes[0].materials),
    [],
  );
  checkSame(
    '第1个节点的选填主材写成字符串：填了就要对',
    req((p) => void (p.nodes[0].materials = 'm-x')),
    [issue('nodes.0.materials', '施工节点 · 第1个节点 · 用到的主材', '格式不对')],
  );
  checkSame(
    '没有 countFrom 的有序子项：空数组不拦',
    req((p) => void (p.nodes = [])),
    [],
  );
  checkSame(
    '开工月份写「全年」',
    req((p) => void (p.startMonths = '全年')),
    [],
  );
  // 第 17.1 步后加的选填是否：没填不查也不计，填对了也不计，填错了单独算一项
  const counted = (c: ItemCheck): unknown[] => [c.requiredPassed, c.requiredTotal, c.required];
  checkSame('含软装填了「是」：仍是12/12', counted(checkItem(pkg, { ...item, softFurnishing: true })), [12, 12, []]);
  checkSame('含软装写成字符串：算一项，12/13', counted(checkItem(pkg, { ...item, softFurnishing: 'true' })), [
    12,
    13,
    [issue('softFurnishing', '含软装', '格式不对')],
  ]);

  const m: Loose = {
    id: 'm-marcopolo-800',
    name: '马可波罗 800×800 抛釉砖',
    category: '瓷砖',
    brand: '马可波罗',
    origin: '广东东莞',
    specs: ['800×800'],
    priceUnit: '㎡',
    unitPrice: 189,
    warrantyYears: 10,
  };
  checkSame('主材：必须项9/9，环保等级选填', checkItem(material, m), {
    requiredTotal: 9,
    requiredPassed: 9,
    required: [],
    recommended: [],
  });
  checkSame('主材没选计价单位', checkItem(material, { ...m, priceUnit: undefined }).required, [issue('priceUnit', '计价单位', '没选')]);
  checkSame(
    '主材的环保等级填了不在选项里：算一项，9/10',
    [checkItem(material, { ...m, ecoGrade: 'E2级' }).requiredPassed, checkItem(material, { ...m, ecoGrade: 'E2级' }).requiredTotal],
    [9, 10],
  );
  // 第 17.1 步后加的产地（文字）与规格（单字段的有序子项）：都是必填，后加之前建的主材没有这两个键，上架前检查报出来
  checkSame('后加之前建的主材：产地没填、规格没填，7/9', counted(checkItem(material, { ...m, origin: undefined, specs: undefined })), [
    7,
    9,
    [issue('origin', '产地', '没填'), issue('specs', '规格', '没填')],
  ]);
  checkSame('规格为空数组：必填数组只要求键在', checkItem(material, { ...m, specs: [] }).required, []);
  checkSame('规格有一项是空的：写到第几种', checkItem(material, { ...m, specs: ['800×800', ''] }).required, [
    issue('specs.1', '规格 · 第2种', '没填'),
  ]);
}

if (fails.length) {
  console.error(`PACKS SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 20)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `PACKS SELFTEST PASS: ${pass} 项断言全通（${packs.length} 个包过 checkPack，${BREAKS.length} 种改坏都点得出；旅游包与代码一致；` +
    `${DATA.route.length} 条线路、${DATA.hotel.length} 家酒店的 ${total} 例变异（schema 通过 ${valid} 例）上 checkItem 与 schema 同判；` +
    '计数口径与逐类型说法）',
);
