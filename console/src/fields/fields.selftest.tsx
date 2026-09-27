// 字段渲染器的自测（console UX spec「行业包通用架构 · 字段类型渲染器」「表单状态与提交」、不变量 12、16，plan 第 3.2 步）。
// console/src 里唯一可以 import 行业包注册表和假包的文件（scripts/check-boundaries.ts 单开的例外）：拿两个包的真实配置逐字段核对。
// 1. 不变量 12：渲染器表、控件读写表、网格规则表的键正好是全部字段类型；每种三种形态都是组件；
// 2. 不变量 16：data/ 下的全部线路、酒店和假包的样例，打开不改时补丁为空；每个字段（含有序子项的子字段）经控件读出、
//    原样写回，值不变、补丁为空；按 storeAs 存的餐食对现有数据的每种写法 format(parse(x)) === x；
// 3. 写回的规则：选填清空删键、嵌套对象删空连对象一起删、必填清空留空值、编号写进 id、键序不变、不改原对象；
//    showWhen 没显示的字段值留在表单状态里、提交时剔除；多选片写回按选项排（验收 18）；规则之外的旧值原样保留；
//    控件的值到存储值的几个纯函数（分段控件的「不填」、是否的段值、逐条列表的改和删）；
// 4. 锁定与网格：已上架 / 草稿 / 新建 / 没有编辑权限各自的形态；4 列只给整卡锁定、3 个及以上短值的卡片（spec 开放问题 9、
//    设计系统 §6.4），E 页的「基本信息」是 4 列，草稿和没有编辑权限看到的只读卡是两列；
// 5. 两个包的每个字段三种形态都画一遍（renderToStaticMarkup），逐类型核对控件和只读的写法；画的时候不写值；
// 6. 实体图标：两个包的实体图标都画得出来，集合里只有 box 自己落到兜底的 box；
// 7. 在 DOM 里挂载（happy-dom，selftest-dom.ts）：两个包每个字段的表单形态和各分组卡片，挂载、effect 跑完都不写值；
//    再经组件点、敲、删，核对写回表单状态的值和补丁：分段控件的「不填」、是否、标签的锁住成员、多选片、
//    逐条列表的改删移、有序子项按下标经 writeValue 写回、引用的删和自由输入。
// 8. 产品库列表（plan 第 9 步，spec「产品库列表」）：两个包的列、表头与列宽，筛选按字段类型生成的选项与「包含」匹配，
//    搜索、页签计数、排序、更新列，URL 状态的解析与改写；挂进 DOM 画 D 页、L 页、主材、匿名、分页、各种状态，
//    再经组件敲字、点页签、点清除、开筛选菜单，核对写回地址的内容和焦点落在哪；再挂整页（路由、查询缓存），
//    核对行业包里没有的 kind、匿名、非编辑成员、从来没有过、加载与出错时页头的样子。
// 9. 产品库详情（plan 第 10.1 步，spec「产品库详情与编辑」）：锁定组的计数与在哪张卡片头声明（每组只说一次）、状态句、
//    上架前检查每项的写法与指向的字段、「已改」与撤销；再挂整页（路由、查询缓存）：已上架、草稿、没有编辑权限、匿名、
//    新建、假包、不存在、加载与出错，点锁定组、点检查项、撤销一处、有改动时离开被拦下。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/fields/fields.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import { win } from './selftest-dom.js';
import fs from 'node:fs';
import path from 'node:path';
import { Box } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement, type ReactElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { packById } from '../../../src/packs/registry.js';
import { sameValue } from '../../../src/shared/catalog.js';
import { absoluteTime } from '../../../src/shared/format.js';
import { renovation } from '../../../src/shared/pack-fixtures/renovation.js';
import { checkItem, ENTITY_ICONS, type EntityType, type FieldDef, type FieldType, type IndustryPack } from '../../../src/shared/pack.js';
import { CatalogList, type CatalogListProps, FilterButton, MENU_SEARCH_OVER } from '../catalog/CatalogList.js';
import {
  type ActivePick,
  activePicks,
  atomsOf,
  columnWidth,
  filterFields,
  filterName,
  filterOptions,
  fullText,
  headerLabel,
  headerWidth,
  listActions,
  listColumns,
  listField,
  type ListRow,
  listTime,
  matchesPick,
  narrowed,
  numeric,
  pickLabel,
  searchPlaceholder,
  sortRows,
  statusParts,
  tabCounts,
  tableMinWidth,
  textWidth,
  TITLE_MIN_NARROW,
  TITLE_MIN_WIDTH,
  twoLine,
  updatedParts,
  visibleRows,
} from '../catalog/list.js';
import {
  blockOnly,
  cardLocks,
  declaringCard,
  distinctValues,
  fieldOfPath,
  issueText,
  itemTitle,
  lockPhrase,
  lockReason,
  lockRows,
  lockTotal,
  referencedKinds,
  skeletonCardHeight,
  subPathOf,
  updatedOf,
} from '../catalog/detail.js';
import { type CatalogSearch, catalogSearch, cleared, itemSearch, parseFilter, pickOf, withPick } from '../catalog/params.js';
import { CatalogItemPage, CatalogNewPage } from '../pages/CatalogItemPage.js';
import { CatalogPage } from '../pages/CatalogPage.js';
import { entityIcon } from '../shell/icons.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import { type FieldEnv, FieldEnvContext } from './env.js';
import { FieldGrid } from './FieldGrid.js';
import {
  boolFromSegment,
  boolSegment,
  CODECS,
  enumFromSegment,
  fieldChanged,
  fieldMode,
  formatStored,
  formState,
  groupGrid,
  isSingleItem,
  type ItemContext,
  keepLockedMembers,
  LAYOUT,
  lockedMembers,
  locksOnActivate,
  moveItem,
  parseStored,
  type Payload,
  pruneHidden,
  readValue,
  refItemsOf,
  type RefItem,
  removeAt,
  replaceAt,
  restoreField,
  SEG_NONE,
  SEG_UNSET,
  submission,
  togglePick,
  writeValue,
} from './model.js';
import { type FormProps, RENDERERS } from './renderers.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
/** 打出结果并退出：有失败时逐条点名 */
function report(): never {
  if (fails.length) {
    console.error(`fields: ${fails.length} 条失败（${pass} 条通过）：`);
    for (const f of fails) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`fields: ${pass} 条断言全部通过`);
  process.exit(0);
}
/** 数一段 HTML 里某个片段出现几次 */
const count = (html: string, s: string): number => html.split(s).length - 1;
/** 月份条 12 格各自的 class（去掉 ms-cell），按 1–12 月 */
const stripCells = (html: string): string[] => [...html.matchAll(/class="ms-cell([^"]*)"/g)].map((m) => m[1]!.trim());
/** 分段控件里选中的那几段的文字（antd 把选中标在 label 的 class 上） */
const selectedSegments = (html: string): string[] =>
  [
    ...html.matchAll(
      /<label class="ant-segmented-item ant-segmented-item-selected[^"]*">(?:<input[^>]*>)<div class="ant-segmented-item-label" title="([^"]*)"/g,
    ),
  ].map((m) => m[1]!);

// ---------------- 夹具 ----------------

const root = path.join(import.meta.dirname, '..', '..', '..');
const load = (f: string): Payload[] => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8')) as Payload[];
const ROUTES = load('routes.json');
const HOTELS = load('hotels.json');

const travel = packById('travel')!;
const entityOf = (p: IndustryPack, kind: string): EntityType => p.entities.find((e) => e.kind === kind)!;
const fieldOf = (e: EntityType, key: string): FieldDef => e.fields.find((f) => f.key === key)!;
const ROUTE = entityOf(travel, 'route');
const HOTEL = entityOf(travel, 'hotel');
const PKG = entityOf(renovation, 'package');
const MATERIAL = entityOf(renovation, 'material');

const SICHUAN = ROUTES.find((r) => r.id === 'r-sichuan-lux')!;
/** 草稿线路 r-guizhou-5d（设计系统 §10.0）：从 r-guizhou 取第 1、2、3、5、6 天 */
const GUIZHOU = ROUTES.find((r) => r.id === 'r-guizhou')!;
const GUIZHOU_5D: Payload = {
  id: 'r-guizhou-5d',
  title: '贵州 小七孔·西江千户苗寨 5 日',
  destination: '贵州',
  overseas: false,
  days: 5,
  priceFrom: 13800,
  hotelLevel: GUIZHOU.hotelLevel,
  bestSeason: '4月-10月',
  highlights: GUIZHOU.highlights,
  tags: ['国内', '贵州', '非遗手作', '亲子'],
  segments: ['家庭', '亲子', '银发'],
  maxAltitude: 1200,
  aliases: ['黔东南'],
  itinerary: [1, 2, 3, 5, 6].map((d, i) => ({ ...(GUIZHOU.itinerary as Payload[])[d - 1], day: i + 1 })),
  inclusions: GUIZHOU.inclusions,
  exclusions: GUIZHOU.exclusions,
};

// 假包的样例（设计系统 L 页）：4 件主材，5 个套餐（第 5 个是草稿）
const MATERIALS: Payload[] = [
  {
    id: 'm-marcopolo-800',
    name: '马可波罗 800×800 抛釉砖',
    category: '瓷砖',
    brand: '马可波罗',
    priceUnit: '㎡',
    unitPrice: 168,
    warrantyYears: 5,
    ecoGrade: 'E0级',
  },
  {
    id: 'm-daziran-3c',
    name: '大自然 三层实木复合地板',
    category: '地板',
    brand: '大自然',
    priceUnit: '㎡',
    unitPrice: 298,
    warrantyYears: 10,
  },
  {
    id: 'm-oupai-cab',
    name: '欧派 整体橱柜',
    category: '橱柜',
    brand: '欧派',
    priceUnit: '延米',
    unitPrice: 2680,
    warrantyYears: 5,
    ecoGrade: 'ENF级',
  },
  { id: 'm-jianpai-bath', name: '箭牌 卫浴套装', category: '卫浴', brand: '箭牌', priceUnit: '套', unitPrice: 5980, warrantyYears: 3 },
];
const NODES: [string, number][] = [
  ['拆改', 5],
  ['水电', 10],
  ['泥瓦', 15],
  ['木作', 12],
  ['油漆', 10],
  ['安装', 8],
  ['保洁验收', 3],
];
const NUANMU: Payload = {
  id: 'p-nuanmu-2r',
  title: '暖木 · 两居全包经典版',
  pricePerSqm: 1280,
  minArea: 60,
  houseTypes: ['两居', '三居'],
  styles: ['原木', '奶油'],
  startMonths: '3月-6月、9月-11月',
  duration: 75,
  demolition: true,
  materials: ['m-marcopolo-800', 'm-daziran-3c', 'm-oupai-cab', 'm-jianpai-bath'],
  nodes: NODES.map(([name, days], i) => ({
    name,
    days,
    checkpoints: `${name}完工后按验收单逐项签字`,
    ...(i === 2 ? { materials: ['m-marcopolo-800'] } : {}),
  })),
  highlights: ['原木色全屋定制', '水电终身保修'],
};
const PACKAGES: Payload[] = [
  NUANMU,
  {
    ...NUANMU,
    id: 'p-naiyou-3r',
    title: '奶油 · 三居全包进阶版',
    pricePerSqm: 1580,
    minArea: 90,
    houseTypes: ['三居', '四居及以上'],
    startMonths: '3月-5月、9月-11月',
    duration: 90,
  },
  {
    ...NUANMU,
    id: 'p-xinzhongshi-flat',
    title: '新中式 · 大平层定制版',
    pricePerSqm: 2680,
    minArea: 140,
    houseTypes: ['四居及以上', '别墅'],
    startMonths: '全年',
    duration: 120,
  },
  {
    ...NUANMU,
    id: 'p-jijian-1r',
    title: '极简 · 一居焕新版',
    pricePerSqm: 980,
    minArea: 35,
    houseTypes: ['一居'],
    startMonths: '全年',
    duration: 45,
    demolition: false,
  },
  {
    ...NUANMU,
    id: 'p-jiufang-part',
    title: '旧房翻新 · 局部改造包',
    pricePerSqm: 860,
    minArea: 20,
    houseTypes: ['两居', '三居'],
    startMonths: '3月-11月',
    duration: 30,
  },
];

// 样例本身要合规，不然后面的「打开不改」测的是一份坏数据
for (const p of PACKAGES)
  check(`假包样例 ${p.id} 必须项全过`, checkItem(PKG, p).required.length === 0, JSON.stringify(checkItem(PKG, p).required));
for (const m of MATERIALS)
  check(`假包样例 ${m.id} 必须项全过`, checkItem(MATERIAL, m).required.length === 0, JSON.stringify(checkItem(MATERIAL, m).required));
check('r-guizhou-5d 必须项全过', checkItem(ROUTE, GUIZHOU_5D).required.length === 0);

/** 9月26日 14:30（设计系统 §10.0 的场景时刻）：MonthStrip 的当前月是 9 月 */
const NOW = new Date('2026-09-26T14:30:00+08:00').getTime();
/** 酒店库：data/ 里的 23 家都已上架，另加两条草稿（G 页的「贵阳凯宾斯基大酒店」「荔波荔泉宾馆」） */
const HOTEL_REFS: RefItem[] = [
  ...refItemsOf(
    HOTEL,
    HOTELS.map((h) => ({ code: h.id as string, status: 'active' as const, payload: h })),
  ),
  { code: 'h-kempinski-gy', name: '贵阳凯宾斯基大酒店', status: 'draft' },
  { code: 'h-liquan-lb', name: '荔波荔泉宾馆', status: 'draft' },
];
const MATERIAL_REFS = refItemsOf(
  MATERIAL,
  MATERIALS.map((m) => ({ code: m.id as string, status: 'active' as const, payload: m })),
);
const ENV: FieldEnv = {
  now: NOW,
  refItems: (kind) => (kind === 'hotel' ? HOTEL_REFS : kind === 'material' ? MATERIAL_REFS : undefined),
  distinct: (key) => (key === 'destination' ? ['四川', '贵州', '云南'] : []),
};
const html = (el: ReactElement, env: FieldEnv = ENV): string =>
  renderToStaticMarkup(createElement(FieldEnvContext.Provider, { value: env }, el));

const ACTIVE: ItemContext = { status: 'active', canEdit: true };
const DRAFT: ItemContext = { status: 'draft', canEdit: true };
const NEW: ItemContext = { status: 'new', canEdit: true };
const READER: ItemContext = { status: 'active', canEdit: false };

// ---------------- 1. 不变量 12：三张表的键正好是全部字段类型 ----------------

// 这张表 typecheck 时必须写全：FieldType 加一种而这里没加，tsc 报错；下面再拿它比三张表的键
const ALL_TYPES: Record<FieldType, true> = {
  text: true,
  longText: true,
  money: true,
  intUnit: true,
  monthRange: true,
  enum: true,
  tags: true,
  boolean: true,
  subItems: true,
  reference: true,
  status: true,
};
{
  const types = Object.keys(ALL_TYPES).sort();
  eq('渲染器表的键正好是 11 种字段类型', Object.keys(RENDERERS).sort(), types);
  eq('控件读写表的键正好是 11 种字段类型', Object.keys(CODECS).sort(), types);
  eq('网格规则表的键正好是 11 种字段类型', Object.keys(LAYOUT).sort(), types);
  check('11 种', types.length === 11);
  for (const t of types) {
    const r = RENDERERS[t as FieldType] as (typeof RENDERERS)[FieldType] | undefined;
    check(`${t}：列表单元格、只读、表单三种形态都是组件`, !!r && [r.Cell, r.View, r.Form].every((c) => typeof c === 'function'));
  }
  // 两个包用到的类型合起来是全部 11 种：下面「每个字段都画一遍」就覆盖了每种类型
  const used = new Set<string>();
  for (const p of [travel, renovation]) {
    for (const e of p.entities) for (const f of e.fields) for (const x of [f, ...(f.item ?? [])]) used.add(x.type);
  }
  eq('两个包合起来用到了全部 11 种字段类型', [...used].sort(), types);
  // 少了哪种类型的渲染器，后面逐字段画的时候就无从画起：到这里先报
  if (types.some((t) => !RENDERERS[t as FieldType])) report();
}

// ---------------- 2. 不变量 16：打开不改补丁为空；逐字段读出原样写回 ----------------

/** 一个值经控件读出、原样写回（有序子项逐项、逐子字段走一遍） */
function roundTrip(f: FieldDef, stored: unknown): unknown {
  if (f.type !== 'subItems') {
    const codec = CODECS[f.type] as { read(v: unknown, f: FieldDef): unknown; write(c: unknown, f: FieldDef): unknown };
    return codec.write(codec.read(stored, f), f);
  }
  const items = CODECS.subItems.read(stored, f);
  const subs = f.item ?? [];
  const back = items.map((it) => {
    if (isSingleItem(f)) return roundTrip(subs[0]!, it);
    if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
    let obj = it as Payload;
    for (const s of subs) {
      if (!Object.hasOwn(obj, s.key)) continue;
      obj = writeValue(obj, s, roundTrip(s, obj[s.key]));
    }
    return obj;
  });
  return CODECS.subItems.write(back, f);
}

/** 把一条 payload 的每个字段都「碰一遍」：读出原样写回，返回最后的表单状态 */
function touchAll(e: EntityType, payload: Payload, bad: string[]): Payload {
  let state = formState(payload);
  for (const f of e.fields) {
    if (f.type === 'status') continue;
    const stored = readValue(state, f.key);
    if (stored === undefined) continue;
    const back = roundTrip(f, stored);
    if (!sameValue(back, stored)) bad.push(`${String(payload.id)} 的 ${f.key}：${JSON.stringify(stored)} → ${JSON.stringify(back)}`);
    state = writeValue(state, f, back);
  }
  return state;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const SAMPLES: [string, EntityType, Payload[]][] = [
  ['线路（data/routes.json）', ROUTE, [...ROUTES, GUIZHOU_5D]],
  ['酒店（data/hotels.json）', HOTEL, HOTELS],
  ['装修套餐（假包样例）', PKG, PACKAGES],
  ['主材（假包样例）', MATERIAL, MATERIALS],
];
// 条数只打出来不断言：data/ 里正常加一条线路或酒店，这里照样逐条核对
check('data/ 下有线路和酒店', ROUTES.length > 0 && HOTELS.length > 0);
console.log(`fields: data/ 下 ${ROUTES.length} 条线路、${HOTELS.length} 家酒店`);
for (const [name, e, items] of SAMPLES) {
  const notEmpty: string[] = [];
  const changed: string[] = [];
  const reordered: string[] = [];
  for (const p of items) {
    const original = deepFreeze(structuredClone(p));
    const opened = formState(original);
    const s0 = submission(original, opened, e.fields);
    if (Object.keys(s0.set).length || s0.unset.length) notEmpty.push(String(p.id));
    const state = touchAll(e, original, changed);
    const s1 = submission(original, state, e.fields);
    if (Object.keys(s1.set).length || s1.unset.length) {
      notEmpty.push(`${String(p.id)}（碰过每个字段后 set ${Object.keys(s1.set).join(',')} unset ${s1.unset.join(',')}）`);
    }
    if (JSON.stringify(state) !== JSON.stringify(original)) reordered.push(String(p.id));
  }
  check(`${name}：打开不改、碰过每个字段后，补丁的 set 与 unset 都为空（${items.length} 条）`, notEmpty.length === 0, notEmpty.join('；'));
  check(`${name}：每个字段经控件读出再写回，值不变`, changed.length === 0, changed.slice(0, 5).join('；'));
  check(`${name}：写回后序列化逐字节相同（键序不变）`, reordered.length === 0, reordered.join('、'));
}

// 按 storeAs 存的「当天餐食」：现有数据的全部取值 format(parse(x)) === x
{
  const meals = fieldOf(ROUTE, 'itinerary').item!.find((s) => s.key === 'meals')!;
  const values = new Set<string>();
  for (const r of ROUTES) for (const d of r.itinerary as Payload[]) values.add(d.meals as string);
  check('data/ 里有餐食', values.size > 0);
  console.log(`fields: data/ 里的餐食有 ${values.size} 种写法：${[...values].join(' ')}`);
  for (const x of values) {
    const picks = parseStored(meals, x);
    check(`餐食「${x}」认得出`, picks !== null);
    check(`餐食「${x}」：format(parse(x)) === x`, picks !== null && formatStored(meals, picks) === x, JSON.stringify(picks));
  }
  eq('「—」是一项都没选', parseStored(meals, '—'), []);
  eq('多选片点选的先后不影响写回：先点晚再点早，写「早/晚」（验收 18）', CODECS.enum.write(['晚', '早'], meals), '早/晚');
  eq('一项都不选写「—」', CODECS.enum.write([], meals), '—');
  for (const odd of ['午/早', '早/早', '早餐', '早 / 午', '', '早/', '/']) {
    check(`规则之外的「${odd}」认不出（照原文显示）`, parseStored(meals, odd) === null);
    eq(`规则之外的「${odd}」经控件读出原样写回`, CODECS.enum.write(CODECS.enum.read(odd, meals), meals), odd);
  }
}

// ---------------- 3. 写回的规则 ----------------
{
  const original = deepFreeze(structuredClone(SICHUAN));
  const s = formState(original);
  const f = (k: string) => fieldOf(ROUTE, k);
  const patch = (next: Payload) => submission(original, next, ROUTE.fields);

  eq('选填的「客户的其他叫法」清空：删键，进 unset', patch(writeValue(s, f('aliases'), [])), { set: {}, unset: ['aliases'] });
  eq(
    '选填的「全程最高海拔」清空（控件给 null）：删键',
    patch(writeValue(s, f('maxAltitude'), CODECS.intUnit.write(null, f('maxAltitude')))),
    {
      set: {},
      unset: ['maxAltitude'],
    },
  );
  const hardest = (SICHUAN.intensity as Payload).hardest;
  const noLevel = writeValue(s, f('intensity.level'), CODECS.enum.write(undefined, f('intensity.level')));
  eq('体力强度选「不填」：最累的一段不显示也不提交，整个 intensity 进 unset', patch(noLevel), { set: {}, unset: ['intensity'] });
  check(
    '体力强度选「不填」后，最累的一段不显示',
    !groupGrid(ROUTE, 'fit', noLevel, ACTIVE).cells.some((c) => c.field.key === 'intensity.hardest'),
  );
  eq('体力强度选「不填」后，最累的一段的原文还留在表单状态里', noLevel.intensity, { hardest });
  eq('剔除不显示的字段：删空的 intensity 一起删', 'intensity' in pruneHidden(noLevel, ROUTE.fields), false);
  const back = writeValue(noLevel, f('intensity.level'), '较累');
  eq(
    '误点「不填」再选回「较累」：最累的一段原文还在，补丁为空',
    [back.intensity, patch(back)],
    [
      { hardest, level: '较累' },
      { set: {}, unset: [] },
    ],
  );
  const lighter = writeValue(s, f('intensity.level'), '适中');
  eq('改体力强度：intensity 整体进 set，最累的一段原样带上', patch(lighter), {
    set: { intensity: { level: '适中', hardest: (SICHUAN.intensity as Payload).hardest } },
    unset: [],
  });
  const fresh = writeValue(formState(GUIZHOU_5D), f('intensity.level'), '轻松');
  eq('没有 intensity 的条目选了体力强度：建出 { level }', fresh.intensity, { level: '轻松' });
  eq(
    '这时最累的一段显示出来、算必须项，报「没填」',
    checkItem(ROUTE, fresh).required.map((i) => `${i.label}：${i.message}`),
    ['最累的一段：没填'],
  );
  eq('必填的「线路名称」清空：留空串，进 set，上架前检查报「没填」', patch(writeValue(s, f('title'), '')), {
    set: { title: '' },
    unset: [],
  });
  eq('必填的「标签」清空：留 []（tags 可以是空数组）', patch(writeValue(s, f('tags'), [])), { set: { tags: [] }, unset: [] });
  eq('编号写进 id', writeValue(formState(GUIZHOU_5D), f('$code'), 'r-guizhou-6d').id, 'r-guizhou-6d');
  eq('改一个字段，键序不变', Object.keys(writeValue(s, f('hotelLevel'), '奢华')), Object.keys(SICHUAN));
  check('原对象没被改动（深冻结着，写的是拷贝）', JSON.stringify(original) === JSON.stringify(SICHUAN));
  const e = fieldOf(ROUTE, 'itinerary');
  const days = CODECS.subItems.read(s.itinerary, e) as Payload[];
  const meals = e.item!.find((x) => x.key === 'meals')!;
  const edited = days.map((d, i) => (i === 1 ? writeValue(d, meals, CODECS.enum.write(['晚', '早'], meals)) : d));
  const next = writeValue(s, e, CODECS.subItems.write(edited, e));
  eq('改第2天的餐食：逐日行程整体进 set，只有那一天变了', patch(next).unset, []);
  eq('第2天的餐食写成「早/晚」', ((patch(next).set.itinerary as Payload[])[1] as Payload).meals, '早/晚');
  check(
    '其余几天原样',
    (patch(next).set.itinerary as Payload[]).every((d, i) => i === 1 || sameValue(d, days[i])),
  );

  // 控件的值 → 要写回的值（组件只调这几个函数）
  eq('单选分段控件：「不填」写 undefined，别的段写那一项', [enumFromSegment(SEG_NONE), enumFromSegment('较累')], [undefined, '较累']);
  eq(
    '是否分段控件选中哪段：没有值时选填是「不填」、必填一段都不选；有值时是 true / false',
    [boolSegment(undefined, true), boolSegment(undefined, false), boolSegment(true, false), boolSegment(false, true)],
    [SEG_NONE, SEG_UNSET, 'true', 'false'],
  );
  eq(
    '是否分段控件写回：「不填」写 undefined，段值 true / false 写布尔',
    [boolFromSegment(SEG_NONE), boolFromSegment('true'), boolFromSegment('false')],
    [undefined, true, false],
  );
  const list = ['a', 'b', 'c'];
  eq(
    '逐条列表改第 2 条、删第 2 条，别的原样，不改原数组',
    [replaceAt(list, 1, 'x'), removeAt(list, 1), list],
    [
      ['a', 'x', 'c'],
      ['a', 'c'],
      ['a', 'b', 'c'],
    ],
  );
}

// ---------------- 4. 锁定与网格 ----------------
{
  const m = (e: EntityType, k: string, ctx: ItemContext) => fieldMode(fieldOf(e, k), ctx);
  eq(
    '已上架：线路名称锁定、编号锁定、住宿档次可改',
    [m(ROUTE, 'title', ACTIVE), m(ROUTE, '$code', ACTIVE), m(ROUTE, 'hotelLevel', ACTIVE)],
    ['locked', 'locked', 'edit'],
  );
  eq('草稿：编号建好后仍锁（ALWAYS_LOCKED），线路名称可改', [m(ROUTE, '$code', DRAFT), m(ROUTE, 'title', DRAFT)], ['locked', 'edit']);
  eq('新建：编号可填', m(ROUTE, '$code', NEW), 'edit');
  eq('没有编辑权限：一律只读，不算锁定', [m(ROUTE, 'title', READER), m(ROUTE, 'hotelLevel', READER)], ['readonly', 'readonly']);
  eq('状态字段永远不能直接改', m(ROUTE, '$status', ACTIVE), 'readonly');
  eq('标签只锁「国内」：已上架时锁这一项', lockedMembers(fieldOf(ROUTE, 'tags'), ACTIVE), ['国内']);
  eq(
    '草稿、没有编辑权限时标签不锁成员',
    [lockedMembers(fieldOf(ROUTE, 'tags'), DRAFT), lockedMembers(fieldOf(ROUTE, 'tags'), READER)],
    [[], []],
  );
  eq(
    '草稿里上架后会锁的字段标出来；已上架、没有编辑权限时不标',
    [
      locksOnActivate(fieldOf(ROUTE, 'title'), DRAFT),
      locksOnActivate(fieldOf(ROUTE, 'title'), ACTIVE),
      locksOnActivate(fieldOf(ROUTE, 'title'), READER),
    ],
    [true, false, false],
  );

  const g = (e: EntityType, group: string, p: Payload, ctx: ItemContext) => groupGrid(e, group, p, ctx);
  const keys = (x: ReturnType<typeof g>) => x.cells.map((c) => c.field.key);
  const basic = g(ROUTE, 'basic', SICHUAN, ACTIVE);
  eq(
    'E 页「基本信息」：4 列，整卡锁定，编号、名称、目的地、天数（$status 不进表单）',
    [basic.columns, basic.allLocked, keys(basic)],
    [4, true, ['$code', 'title', 'destination', 'days']],
  );
  eq(
    '草稿的「基本信息」有输入框：两列（验收 16）',
    [g(ROUTE, 'basic', GUIZHOU_5D, DRAFT).columns, g(ROUTE, 'basic', GUIZHOU_5D, DRAFT).allLocked],
    [2, false],
  );
  eq('新建的「基本信息」：两列', g(ROUTE, 'basic', {}, NEW).columns, 2);
  eq('没有编辑权限看已上架的「基本信息」：只读但没有锁定，两列（spec 开放问题 9）', g(ROUTE, 'basic', SICHUAN, READER).columns, 2);
  eq(
    '「价格与季节」整卡锁定，但有月份区间：两列',
    [g(ROUTE, 'price', SICHUAN, ACTIVE).columns, g(ROUTE, 'price', SICHUAN, ACTIVE).allLocked],
    [2, true],
  );
  const fit = g(ROUTE, 'fit', SICHUAN, ACTIVE);
  eq('「适合谁去」是混合卡：两列，不算整卡锁定', [fit.columns, fit.allLocked], [2, false]);
  eq(
    '「适合谁去」各字段的形态',
    fit.cells.map((c) => `${c.field.key}:${c.mode}:${c.span}`),
    ['overseas:locked:half', 'segments:locked:half', 'maxAltitude:locked:half', 'intensity.level:edit:half', 'intensity.hardest:edit:half'],
  );
  eq(
    '只读的月份区间与多选 enum 占一格，可改时占满一行（E 页的首屏，第 10.1 步）',
    [
      g(ROUTE, 'price', SICHUAN, ACTIVE).cells.map((c) => c.span),
      g(ROUTE, 'price', SICHUAN, READER).cells.map((c) => c.span),
      g(ROUTE, 'price', GUIZHOU_5D, DRAFT).cells.map((c) => c.span),
      g(ROUTE, 'fit', SICHUAN, READER).cells.find((c) => c.field.key === 'segments')?.span,
      g(ROUTE, 'fit', GUIZHOU_5D, DRAFT).cells.find((c) => c.field.key === 'segments')?.span,
      g(PKG, 'fit', NUANMU, ACTIVE).cells.map((c) => `${c.field.key}:${c.span}`),
    ],
    [['half', 'half'], ['half', 'half'], ['half', 'wide'], 'half', 'wide', ['houseTypes:half', 'styles:wide', 'startMonths:wide']],
  );
  eq('酒店已上架的「基本信息」：星级档次可改，两列', g(HOTEL, 'basic', HOTELS[0]!, ACTIVE).columns, 2);
  eq('只有 2 个短值的整锁卡片（装修套餐「价格」）：两列', g(PKG, 'price', NUANMU, ACTIVE).columns, 2);
  eq(
    '整锁卡片里有是否、多选引用（装修套餐「施工与条款」）：两列',
    [g(PKG, 'terms', NUANMU, ACTIVE).columns, g(PKG, 'terms', NUANMU, ACTIVE).allLocked],
    [2, true],
  );
  eq(
    '没有编辑权限看主材「基本信息」：编号、名称、单选品类、品牌都是只读短值，仍是两列',
    g(MATERIAL, 'basic', MATERIALS[0]!, READER).columns,
    2,
  );
  eq('主材已上架的「基本信息」：名称不锁，两列', g(MATERIAL, 'basic', MATERIALS[0]!, ACTIVE).columns, 2);
  eq(
    '逐日行程自成区块',
    g(ROUTE, 'days', SICHUAN, ACTIVE).cells.map((c) => c.span),
    ['block'],
  );
  eq(
    '网格跨行只看类型（§6.0）',
    ['longText', 'monthRange', 'tags', 'text', 'money', 'intUnit', 'boolean', 'status'].map((t) =>
      LAYOUT[t as FieldType].span({ key: 'x', type: t as FieldType, label: '', group: '' }),
    ),
    ['wide', 'wide', 'wide', 'half', 'half', 'half', 'half', 'half'],
  );
  eq(
    '多选的 enum、reference 占满一行，单选占一格；单字段的有序子项占满一行，多字段的自成区块',
    [
      LAYOUT.enum.span(fieldOf(ROUTE, 'segments')),
      LAYOUT.enum.span(fieldOf(ROUTE, 'intensity.level')),
      LAYOUT.reference.span(fieldOf(PKG, 'materials')),
      LAYOUT.reference.span(fieldOf(ROUTE, 'itinerary').item!.find((s) => s.key === 'hotel')!),
      LAYOUT.subItems.span(fieldOf(ROUTE, 'highlights')),
      LAYOUT.subItems.span(fieldOf(ROUTE, 'itinerary')),
    ],
    ['wide', 'half', 'wide', 'half', 'wide', 'block'],
  );

  // 4 列只认只读的 text、intUnit、money、单选 enum：整锁卡片里多一个是否（或多选 enum）就回到两列
  const synth = (fields: FieldDef[]): EntityType => ({ ...ROUTE, groups: [{ key: 'g', label: '组' }], fields });
  const locked = (key: string, type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
    key,
    type,
    label: key,
    group: 'g',
    lockedWhenActive: true,
    lockGroup: 'id',
    ...extra,
  });
  const shorts = [locked('a', 'text'), locked('b', 'intUnit'), locked('c', 'money')];
  eq('整锁的 text、intUnit、money 三个：4 列', g(synth(shorts), 'g', { a: 'x', b: 1, c: 1 }, ACTIVE).columns, 4);
  eq('再加一个整锁的单选 enum：仍是 4 列', g(synth([...shorts, locked('d', 'enum', { options: ['一'] })]), 'g', {}, ACTIVE).columns, 4);
  eq('再加一个整锁的是否：两列', g(synth([...shorts, locked('d', 'boolean')]), 'g', {}, ACTIVE).columns, 2);
  eq(
    '再加一个整锁的多选 enum：两列',
    g(synth([...shorts, locked('d', 'enum', { options: ['一'], multiple: true })]), 'g', {}, ACTIVE).columns,
    2,
  );
  eq('再加一个整锁的长文本：两列', g(synth([...shorts, locked('d', 'longText')]), 'g', {}, ACTIVE).columns, 2);
  eq('再加一个整锁的单选引用：两列', g(synth([...shorts, locked('d', 'reference', { to: 'hotel' })]), 'g', {}, ACTIVE).columns, 2);
  eq('只有两个整锁短值：两列', g(synth(shorts.slice(0, 2)), 'g', {}, ACTIVE).columns, 2);
  eq(
    '三个短值里有一个可改：两列',
    g(synth([...shorts.slice(0, 2), { ...shorts[2]!, lockedWhenActive: undefined }]), 'g', {}, ACTIVE).columns,
    2,
  );

  // 锁住的标签成员：有无都不能变
  eq('删掉「国内」：整次改动不算', keepLockedMembers(['国内', '贵州'], ['贵州'], ['国内']), null);
  eq('没有「国内」时加不上，其余照加', keepLockedMembers(['贵州'], ['贵州', '国内', '亲子'], ['国内']), ['贵州', '亲子']);
  eq('删别的、加别的照改', keepLockedMembers(['国内', '贵州'], ['国内', '亲子'], ['国内']), ['国内', '亲子']);
  eq('没有锁住的成员时原样', keepLockedMembers(['a'], [], []), []);
  // 多选片点一片
  eq(
    '多选片：点没选的接在后面、点选中的取消',
    [togglePick(['蜜月', '家庭'], '亲子'), togglePick(['蜜月', '家庭'], '蜜月')],
    [['蜜月', '家庭', '亲子'], ['家庭']],
  );
  // 上移下移
  eq('第 2 项上移', moveItem(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  eq('第 2 项下移', moveItem(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  eq('第 1 项上移、最后一项下移：不动', [moveItem(['a', 'b'], 0, -1), moveItem(['a', 'b'], 1, 1)], [null, null]);
  const src = ['a', 'b'];
  moveItem(src, 0, 1);
  eq('上移下移不改原数组', src, ['a', 'b']);

  // 画出来的网格
  const grid = (e: EntityType, group: string, p: Payload, ctx: ItemContext, lockNoteId?: string) =>
    html(<FieldGrid entity={e} group={group} state={formState(p)} ctx={ctx} onChange={() => undefined} lockNoteId={lockNoteId} />);
  const eBasic = grid(ROUTE, 'basic', SICHUAN, ACTIVE, 'lock-basic');
  check('E 页「基本信息」画成 4 列', eBasic.includes('field-grid field-grid-4'));
  check(
    '整卡锁定：字段标签不挂锁，经 aria-describedby 指向卡片头的锁定说明',
    !eBasic.includes('field-lock') && count(eBasic, 'aria-describedby="lock-basic"') === 4,
  );
  check('锁定的值是文本：没有输入框，也没有 disabled（不变量 5）', !eBasic.includes('<input') && !eBasic.includes('disabled'));
  check(
    '线路名称完整写出，悬停也能看全文',
    eBasic.includes('>四川 稻城亚丁·色达秘境 8 日<') && eBasic.includes('title="四川 稻城亚丁·色达秘境 8 日"'),
  );
  check('编号用等宽字', /class="field-text mono"[^>]*>r-sichuan-lux</.test(eBasic));
  check('天数写「8天」', eBasic.includes('>8天<'));
  check('只读值不写帮助', !eBasic.includes('field-help'));

  const eFit = grid(ROUTE, 'fit', SICHUAN, ACTIVE);
  eq('混合卡里锁定的三个字段标签后挂锁，名字是「上架后锁定」', count(eFit, 'class="field-lock" role="img" aria-label="上架后锁定"'), 3);
  eq('混合卡里可改的体力强度是分段控件，选中「较累」', selectedSegments(eFit), ['较累']);
  check(
    '混合卡里可改的最累的一段是输入框，写着原文',
    eFit.includes('<input') && eFit.includes((SICHUAN.intensity as Payload).hardest as string),
  );
  check('可改字段有常驻帮助', eFit.includes('class="field-help"') && eFit.includes('看最累的那天'));
  check('选填字段在可改时标「（选填）」：体力强度', eFit.includes('（选填）'));
  check('没有红色星号', !eFit.includes('*') && !eFit.includes('ant-form-item-required'));

  const dBasic = grid(ROUTE, 'basic', GUIZHOU_5D, DRAFT);
  check('草稿的「基本信息」两列、有输入框', dBasic.includes('field-grid field-grid-2') && count(dBasic, '<input') >= 3);
  eq('草稿里上架后会锁的名称、目的地、天数：标签后写「上架后锁定」', count(dBasic, 'class="field-will-lock"'), 3);
  eq('草稿里编号已锁：混合卡，挂锁', count(dBasic, 'class="field-lock"'), 1);
  check('草稿的输入框有标签：label 的 for 指向输入框', /<label id="[^"]+" for="([^"]+)"[^>]*>线路名称<\/label>/.test(dBasic));

  const mBasic = grid(MATERIAL, 'basic', MATERIALS[0]!, NEW);
  const mPrice = grid(MATERIAL, 'price', MATERIALS[0]!, NEW);
  check('下拉（品类 6 项）：label 的 for 指向控件', /<label id="[^"]+" for="[^"]+" class="field-label">品类<\/label>/.test(mBasic));
  check(
    '分段控件（计价单位 4 项）：标签是 span，控件经 aria-labelledby 连上',
    /<span id="([^"]+)" class="field-label">计价单位<\/span>/.test(mPrice) &&
      mPrice.includes(`aria-labelledby="${/<span id="([^"]+)" class="field-label">计价单位/.exec(mPrice)?.[1]}"`),
  );
  const rFit = grid(ROUTE, 'fit', SICHUAN, READER);
  check(
    '没有编辑权限：不挂锁、不写「上架后锁定」「（选填）」，没有输入框',
    !/field-lock|field-will-lock|（选填）|<input|ant-segmented/.test(rFit),
  );
  const rTags = grid(ROUTE, 'sell', SICHUAN, READER);
  check('没有编辑权限：标签「国内」也不挂锁', !rTags.includes('aria-label="上架后锁定"'));
  const aTags = grid(ROUTE, 'sell', GUIZHOU_5D, ACTIVE);
  check(
    '已上架可改的标签：「国内」前面有锁、没有删除按钮',
    aTags.includes('aria-label="上架后锁定"') && !aTags.includes('aria-label="删除国内"'),
  );
  check('已上架可改的标签：其余的有删除按钮', aTags.includes('aria-label="删除贵州"'));
}

// ---------------- 5. 两个包的每个字段三种形态 ----------------

const covered = new Set<string>();
let renders = 0;
/** 每个字段、子字段第一次画的那组参数：第 7 节在 DOM 里再挂一遍 */
const firstProps = new Map<string, { field: FieldDef; value: unknown; row: Payload; extra: Partial<FormProps> }>();
/** 画一个字段的三种形态；表单形态传的 onChange 记下调用：画的时候不许写值 */
function three(tag: string, f: FieldDef, value: unknown, row: Payload, extra: Partial<FormProps> = {}): [string, string, string] {
  const R = RENDERERS[f.type] as (typeof RENDERERS)[FieldType] | undefined;
  if (!R) {
    check(`${tag}：${f.type} 有渲染器`, false);
    return ['', '', ''];
  }
  let writes = 0;
  const props = { field: f, value, row, ...extra };
  const out: [string, string, string] = [
    html(<R.Cell {...props} />),
    html(<R.View {...props} />),
    html(<R.Form {...props} id="fx" labelId="fx-label" onChange={() => void (writes += 1)} />),
  ];
  // 新建时字段是空的：空的表单也不许自己写值
  html(<R.Form {...props} value={undefined} id="fx" labelId="fx-label" onChange={() => void (writes += 1)} />);
  renders += 4;
  check(`${tag}：画的时候不写值`, writes === 0, `${writes} 次`);
  check(
    `${tag}：三种形态都有内容`,
    out.every((h) => h.length > 0),
  );
  for (const form of ['cell', 'view', 'form']) covered.add(`${tag}|${form}`);
  if (!firstProps.has(tag)) firstProps.set(tag, { field: f, value, row, extra });
  return out;
}

/** 一条样例的每个字段（含有序子项的子字段）都画三种形态 */
function renderItem(pack: IndustryPack, e: EntityType, p: Payload): void {
  for (const f of e.fields) {
    const tag = `${pack.id}.${e.kind}.${f.key}`;
    const v = f.type === 'status' ? 'active' : readValue(p, f.key);
    if (v === undefined) continue;
    three(tag, f, v, p);
    if (f.type !== 'subItems' || !Array.isArray(v)) continue;
    for (const it of v) {
      if (isSingleItem(f)) three(`${tag}.`, f.item![0]!, it, {});
      else
        for (const s of f.item ?? [])
          if (Object.hasOwn(it as Payload, s.key)) three(`${tag}.${s.key}`, s, (it as Payload)[s.key], it as Payload);
    }
  }
}
const t0 = Date.now();
renderItem(travel, ROUTE, SICHUAN);
renderItem(travel, ROUTE, GUIZHOU_5D);
renderItem(travel, HOTEL, HOTELS[0]!);
renderItem(renovation, PKG, NUANMU);
for (const m of MATERIALS) renderItem(renovation, MATERIAL, m);
{
  // 应该画到的：两个包每个实体的每个字段、每个子字段，三种形态
  const want = new Set<string>();
  for (const p of [travel, renovation]) {
    for (const e of p.entities) {
      for (const f of e.fields) {
        const tag = `${p.id}.${e.kind}.${f.key}`;
        for (const form of ['cell', 'view', 'form']) {
          want.add(`${tag}|${form}`);
          for (const s of f.item ?? []) want.add(`${tag}.${s.key}|${form}`);
        }
      }
    }
  }
  const missing = [...want].filter((k) => !covered.has(k));
  check(
    `两个包的每个字段、子字段三种形态都画过（${want.size} 项，画了 ${renders} 次，${Date.now() - t0}ms）`,
    missing.length === 0,
    missing.join('、'),
  );
}

// 列表单元格：两个包每个实体的列，每条样例都画
for (const [, e, items] of SAMPLES) {
  for (const p of items) {
    for (const k of e.list.columns) {
      const f = e.fields.find((x) => x.key === k);
      if (!f) continue;
      const v = k === '$status' ? 'draft' : readValue(p, k);
      const C = RENDERERS[f.type].Cell;
      check(`${e.kind}.${k} 的单元格（${String(p.id)}）`, html(<C field={f} value={v} row={p} />).length > 0);
    }
  }
}

// 逐类型核对写法
{
  const R = RENDERERS;
  const cell = (f: FieldDef, v: unknown, row: Payload = {}) => html(createElement(R[f.type].Cell, { field: f, value: v, row }));
  const view = (f: FieldDef, v: unknown, row: Payload = {}, extra: object = {}) =>
    html(createElement(R[f.type].View, { field: f, value: v, row, ...extra }));
  const form = (f: FieldDef, v: unknown, row: Payload = {}) =>
    html(createElement(R[f.type].Form, { field: f, value: v, row, id: 'fx', labelId: 'fx-label', onChange: () => undefined }));
  const sub = (e: EntityType, k: string, s: string) => fieldOf(e, k).item!.find((x) => x.key === s)!;

  // text
  check(
    '文字：表单是输入框，带占位例子',
    /<input[^>]*placeholder="例：四川 稻城亚丁·色达秘境 8 日"/.test(form(fieldOf(ROUTE, 'title'), '')),
  );
  check('文字：有联想时用 AutoComplete', form(fieldOf(ROUTE, 'destination'), '四川').includes('ant-select-auto-complete'));
  check('文字：空值写「—」', view(fieldOf(ROUTE, 'hotelLevel'), undefined).includes('>—<'));
  // longText
  const detail = sub(ROUTE, 'itinerary', 'detail');
  check('长文本：只读是 16/28 段落', view(detail, '第一天').includes('class="field-reading"'));
  check(
    '长文本：表单是文本域，带字数',
    /<textarea/.test(form(detail, '第一天')) && form(detail, '第一天').includes('ant-input-data-count'),
  );
  check('长文本：文本域起始 3 行', /<textarea[^>]*rows="3"/.test(form(detail, '第一天')));
  {
    // antd 的 autoSize 量高度时 setAttribute('style')，页面 CSP 拦下后隐藏的 textarea 留在页面上（第 3.2 步走查）：渲染器不用它
    const dir = path.join(root, 'console/src/fields');
    const users = fs
      .readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('.selftest.'))
      .filter((f) => /autoSize\s*[={:]/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    check('渲染器不用 antd 的 autoSize（CSP 下量不了高度）', users.length === 0, users.join('、'));
  }
  check('长文本：单元格截成一行，悬停看全文', cell(detail, '很长的安排').includes('class="field-clip" title="很长的安排"'));
  // money
  check('金额：只读「42,800元/人」', view(fieldOf(ROUTE, 'priceFrom'), 42800).includes('42,800元/人'));
  check('金额：单元格只写数（单位在表头）', cell(fieldOf(ROUTE, 'priceFrom'), 42800).includes('>42,800<'));
  check('金额：单位取另一个字段时「168元/㎡」', view(fieldOf(MATERIAL, 'unitPrice'), 168, MATERIALS[0]!).includes('168元/㎡'));
  check('金额：单位取另一个字段时单元格带单位', cell(fieldOf(MATERIAL, 'unitPrice'), 2680, MATERIALS[2]!).includes('2,680元/延米'));
  check('金额：计价单位没填时写「元」', view(fieldOf(MATERIAL, 'unitPrice'), 168, {}).includes('168元<'));
  const priceForm = form(fieldOf(ROUTE, 'priceFrom'), 42800);
  check(
    '金额：表单是数字框，千分位，后缀单位',
    priceForm.includes('ant-input-number') && priceForm.includes('value="42,800"') && priceForm.includes('元/人'),
  );
  check('金额不是数时照原文', view(fieldOf(ROUTE, 'priceFrom'), '42800').includes('>42800<'));
  // intUnit
  check(
    '带单位整数：「4,700米」',
    view(fieldOf(ROUTE, 'maxAltitude'), 4700).includes('4,700米') && cell(fieldOf(ROUTE, 'maxAltitude'), 4700).includes('4,700米'),
  );
  check('带单位整数：表单后缀单位', form(fieldOf(ROUTE, 'days'), 8).includes('>天<'));
  // monthRange
  const season = fieldOf(ROUTE, 'bestSeason');
  const s1 = cell(season, '5月-10月');
  check(
    '月份区间单元格：S 号月份条，读屏「最佳季节：5月到10月」',
    s1.includes('month-strip month-strip-S') && s1.includes('aria-label="最佳季节：5月到10月"'),
  );
  eq('月份区间单元格：12 格，5–10 月连成一段，9 月是当前月', stripCells(s1), [
    '',
    '',
    '',
    '',
    'on start',
    'on',
    'on',
    'on',
    'on now',
    'on end',
    '',
    '',
  ]);
  check('月份区间单元格：右边写「5–10月」', s1.includes('>5–10月<'));
  const wrap = cell(season, '11月-次年4月');
  eq('跨年区间画两段：1–4 月一段，11–12 月一段', stripCells(wrap), [
    'on start',
    'on',
    'on',
    'on end',
    '',
    '',
    '',
    '',
    'now',
    '',
    'on start',
    'on end',
  ]);
  eq('4–6、9–10 月两段', stripCells(cell(season, '4月-6月、9月-10月')), [
    '',
    '',
    '',
    'on start',
    'on',
    'on end',
    '',
    '',
    'on start now',
    'on end',
    '',
    '',
  ]);
  eq(
    '不给当前时刻（非有限数）就不标当前月',
    stripCells(html(createElement(RENDERERS.monthRange.Cell, { field: season, value: '5月-6月', row: {} }), { ...ENV, now: Number.NaN })),
    ['', '', '', '', 'on start', 'on end', '', '', '', '', '', ''],
  );
  check('跨年的文字「11月–次年4月」', wrap.includes('11月–次年4月'));
  const yr = cell(season, '全年');
  check(
    '「全年」：轨道全空，写行业包的「全年（不加价）」',
    yr.includes('is-year-round') && stripCells(yr).every((c) => !c.includes('on')) && yr.includes('class="field-meta">全年（不加价）<'),
  );
  check('「全年」读屏也念「全年（不加价）」', yr.includes('aria-label="最佳季节：全年（不加价）"'));
  check('假包的「全年」没配 yearRoundLabel：写「全年」', cell(fieldOf(PKG, 'startMonths'), '全年').includes('>全年<'));
  const sv = view(season, '5月-10月');
  check(
    '月份区间只读：L 号月份条，下一行「5–10月 · 这些月份出发报价上浮10%…」',
    sv.includes('month-strip-L') && sv.includes('5–10月') && sv.includes('这些月份出发报价上浮10%'),
  );
  check('L 号格里写月份数字', /class="ms-cell">1</.test(sv));
  const sf = form(season, '5月-10月');
  check(
    '月份区间表单：输入框加预览「识别出：5–10月」',
    sf.includes('<input') && sf.includes('识别出：5–10月') && sf.includes('month-strip-L'),
  );
  check('月份区间表单：认不出时报「没认出月份」', form(season, '旺季').includes('没认出月份：写成「5月-10月」「11月-次年4月」或「全年」'));
  {
    // 读屏也要知道认不出：输入框 aria-invalid，报错经 aria-describedby 连上，和字段下方的帮助拼在一起
    const bad = html(
      createElement(R.monthRange.Form, {
        field: season,
        value: '旺季',
        row: {},
        id: 'fx',
        labelId: 'fx-label',
        describedBy: 'fx-help',
        onChange: () => undefined,
      }),
    );
    const errId = /<div id="([^"]+)" class="field-error">/.exec(bad)?.[1];
    check(
      '月份认不出：输入框 aria-invalid，aria-describedby 同时指向帮助和报错',
      !!errId && /<input[^>]*aria-invalid="true"/.test(bad) && bad.includes(`aria-describedby="fx-help ${errId}"`),
      bad.slice(0, 300),
    );
    check('月份认得出时不标 aria-invalid', !form(season, '5月-10月').includes('aria-invalid'));
  }
  check('月份区间表单：空着不报错也不预览', !/没认出|识别出/.test(form(season, '')));
  check('规则之外的旧值在单元格、只读里照原文', cell(season, '旺季').includes('>旺季<') && view(season, '旺季').includes('>旺季<'));
  check(
    '只写越界月份（13月）：月份条不选中，文字写「—」',
    stripCells(cell(season, '13月')).every((c) => !c.includes('on')) && cell(season, '13月').includes('>—<'),
  );
  // enum
  const level = fieldOf(ROUTE, 'intensity.level');
  const lv0 = form(level, undefined);
  check(
    '选填单选（3 项）：分段控件，最前面一段是「不填」',
    lv0.includes('ant-segmented') && lv0.indexOf('title="不填"') < lv0.indexOf('title="轻松"'),
  );
  eq('选填单选没有值：选中「不填」', selectedSegments(lv0), ['不填']);
  eq('选填单选有值：选中那一段', selectedSegments(form(level, '适中')), ['适中']);
  check('分段控件连着字段标签', lv0.includes('aria-labelledby="fx-label"'));
  const priceUnit = fieldOf(MATERIAL, 'priceUnit');
  const pu0 = form(priceUnit, undefined);
  check('必填单选（4 项）没有值：分段控件，没有「不填」', pu0.includes('ant-segmented') && !pu0.includes('不填'));
  eq('必填单选没有值：一段都不选', selectedSegments(pu0), []);
  check(
    '单选超过 5 项（品类 6 项）：下拉',
    form(fieldOf(MATERIAL, 'category'), '瓷砖').includes('ant-select') &&
      !form(fieldOf(MATERIAL, 'category'), '瓷砖').includes('ant-segmented'),
  );
  // 控件按选项数换：单选不超过 5 项分段控件、超过用下拉；多选不超过 6 项多选片、超过用下拉（设计系统 §6）
  const opts = (n: number): string[] => Array.from({ length: n }, (_, i) => `选项${i + 1}`);
  const en = (n: number, multiple = false): FieldDef => ({ key: 'e', type: 'enum', label: '枚举', group: 'g', options: opts(n), multiple });
  eq(
    '单选 5 项分段控件、6 项下拉；多选 6 项多选片、7 项下拉',
    [form(en(5), '选项1'), form(en(6), '选项1'), form(en(6, true), []), form(en(7, true), [])].map((h) =>
      h.includes('ant-segmented') ? 'segmented' : h.includes('field-chips') ? 'chips' : h.includes('ant-select') ? 'select' : '?',
    ),
    ['segmented', 'select', 'chips', 'select'],
  );
  const seg = form(fieldOf(ROUTE, 'segments'), ['蜜月', '家庭']);
  eq(
    '多选（5 项）：多选片，选中的 aria-pressed',
    [count(seg, '<button type="button" class="field-chip'), count(seg, 'aria-pressed="true"')],
    [5, 2],
  );
  check('多选片的组连着标签', seg.includes('role="group" aria-labelledby="fx-label"'));
  check(
    '多选在列表里用「、」连成 text-2 文字，顺序照原样',
    cell(fieldOf(ROUTE, 'segments'), ['蜜月', '家庭']).includes('class="field-meta-14">蜜月、家庭<'),
  );
  check('多选只读用「、」连起来', view(fieldOf(ROUTE, 'segments'), ['蜜月', '家庭']).includes('>蜜月、家庭<'));
  const meals = sub(ROUTE, 'itinerary', 'meals');
  eq('餐食「早/午/晚」：三片都选中', count(form(meals, '早/午/晚'), 'aria-pressed="true"'), 3);
  eq('餐食「—」：一片都不选', count(form(meals, '—'), 'aria-pressed="true"'), 0);
  check('餐食在列表与只读里写「早、午、晚」', cell(meals, '早/午/晚').includes('早、午、晚') && view(meals, '—').includes('>—<'));
  const odd = form(meals, '午/早');
  check(
    '餐食写法不标准：原文输入框加「这里的写法不标准」，不画多选片',
    odd.includes('value="午/早"') && odd.includes('这里的写法不标准') && !odd.includes('field-chip'),
  );
  check('餐食写法不标准：只读照原文', view(meals, '午/早').includes('>午/早<'));
  {
    const hintId = /<div id="([^"]+)" class="field-meta">这里的写法不标准/.exec(odd)?.[1];
    check('「这里的写法不标准」经 aria-describedby 连到输入框', !!hintId && odd.includes(`aria-describedby="${hintId}"`));
  }
  // tags
  const tags = fieldOf(ROUTE, 'tags');
  const tc = cell(tags, ['国内', '贵州', '非遗手作', '亲子', '美食']);
  eq('标签单元格：最多 3 个，其余「+2」', [count(tc, 'class="field-tag"'), tc.includes('>+2<')], [3, true]);
  check('标签表单：tags 模式的下拉', form(tags, ['国内']).includes('ant-select'));
  const lockedView = view(tags, ['国内', '贵州'], {}, { lockedMembers: ['国内'], lockGroup: ROUTE.lockGroups.rec });
  eq('锁住的成员前面放锁，只有一个', count(lockedView, 'aria-label="上架后锁定"'), 1);
  // boolean
  const overseas = fieldOf(ROUTE, 'overseas');
  const ov0 = form(overseas, undefined);
  check('必填是否：两段「境内」「境外」', ov0.includes('title="境内"') && ov0.includes('title="境外"'));
  eq('必填是否没有值：没有默认值，一段都不选', selectedSegments(ov0), []);
  eq(
    '必填是否：false 选中「境内」、true 选中「境外」',
    [selectedSegments(form(overseas, false)), selectedSegments(form(overseas, true))],
    [['境内'], ['境外']],
  );
  check(
    '是否只读写文字：「境内」「含拆旧」',
    view(overseas, false).includes('>境内<') && view(fieldOf(PKG, 'demolition'), true).includes('>含拆旧<'),
  );
  // 选填的是否：三段「不填 / 否 / 是」，和选填的单选 enum 一样（开关表示不了没填，spec 顶部 Revisions）
  const optBool: FieldDef = { ...overseas, required: false };
  eq(
    '选填的是否：没填选中「不填」，true 选中「境外」，没有开关',
    [selectedSegments(form(optBool, undefined)), selectedSegments(form(optBool, true)), form(optBool, true).includes('ant-switch')],
    [['不填'], ['境外'], false],
  );
  check('选填的是否：「不填」在最前面', form(optBool, false).indexOf('title="不填"') < form(optBool, false).indexOf('title="境内"'));
  // subItems
  eq(
    '有序子项单元格：「8天」「4条」「7个节点」',
    [
      cell(fieldOf(ROUTE, 'itinerary'), SICHUAN.itinerary),
      cell(fieldOf(ROUTE, 'highlights'), SICHUAN.highlights),
      cell(fieldOf(PKG, 'nodes'), NUANMU.nodes),
    ].map((h) => h.replace(/<[^>]+>/g, '')),
    ['8天', `${(SICHUAN.highlights as unknown[]).length}条`, '7个节点'],
  );
  const itv = view(fieldOf(ROUTE, 'itinerary'), SICHUAN.itinerary);
  check(
    '逐日行程只读：时间轴，节点里写 D1–D8',
    count(itv, 'class="tl-node"') === 8 && itv.includes('>D1<') && itv.includes('>D8<') && !itv.includes('subitem-label'),
  );
  const nv = view(fieldOf(PKG, 'nodes'), NUANMU.nodes);
  check(
    '施工节点只读：节点里只写序号，卡片第一行写「节点3」',
    nv.includes('aria-hidden="true">3<') && nv.includes('class="subitem-label">节点3<'),
  );
  check('施工节点只读：子项里的引用写主材名称', nv.includes('马可波罗 800×800 抛釉砖'));
  const hl = form(fieldOf(ROUTE, 'highlights'), ['一', '二', '三']);
  eq('单字段的有序子项：逐条一个输入框', count(hl, '<input'), 3);
  check('每条的名字「行程亮点第2条」', hl.includes('aria-label="行程亮点第2条"'));
  eq('第一条的上移、最后一条的下移 aria-disabled', count(hl, 'aria-disabled="true"'), 2);
  check('底部「添加一条」，删除按钮写「删除这条」', hl.includes('添加一条') && hl.includes('aria-label="删除这条"'));
  check(
    '单字段只读写成列表',
    view(fieldOf(ROUTE, 'highlights'), ['一', '二']).includes(
      '<ol class="field-list"><li data-item-index="0">一</li><li data-item-index="1">二</li></ol>',
    ),
  );
  const itf = form(fieldOf(ROUTE, 'itinerary'), GUIZHOU_5D.itinerary);
  eq('逐日行程表单：每天一张卡片，卡片名「D1」…', [count(itf, 'class="subitem-card"'), itf.includes('aria-label="D5"')], [5, true]);
  eq('逐日行程表单：每天的餐食是多选片', count(itf, 'class="field-chips"'), 5);
  check('逐日行程表单：当晚住宿可以写库外的（AutoComplete）', itf.includes('ant-select-auto-complete'));
  // reference
  const hotel = sub(ROUTE, 'itinerary', 'hotel');
  const hotelName = HOTEL_REFS[0]!.name;
  check('引用：库里有的写名称', cell(hotel, hotelName).includes(hotelName) && !cell(hotel, hotelName).includes('status-draft'));
  check('引用：被引用的是草稿时后面跟「草稿」', cell(hotel, '贵阳凯宾斯基大酒店').includes('status status-draft'));
  check('引用：库里没有的照原文', cell(hotel, '云上西江酒店').includes('>云上西江酒店<'));
  const linked = html(createElement(R.reference.Cell, { field: hotel, value: hotelName, row: {} }), {
    ...ENV,
    itemLink: (kind, code, children) => createElement('a', { href: `/catalog/${kind}/${code}` }, children),
  });
  check('引用：页面给了链接时名称是链接', linked.includes(`href="/catalog/hotel/${HOTEL_REFS[0]!.code}"`));
  const mats = view(fieldOf(PKG, 'materials'), NUANMU.materials);
  eq('多个引用只读是芯片，按编号找到名称', [count(mats, 'field-tag field-tag-ref'), mats.includes('欧派 整体橱柜')], [4, true]);
  check(
    '多个引用的单元格用「、」连起来',
    cell(fieldOf(PKG, 'materials'), ['m-oupai-cab', 'm-jianpai-bath']).includes('欧派 整体橱柜</span>、<span'),
  );
  check('多选引用表单：多选下拉', form(fieldOf(PKG, 'materials'), NUANMU.materials).includes('ant-select-multiple'));
  check(
    '引用候选还没取到：下拉显示加载中',
    html(
      createElement(R.reference.Form, {
        field: fieldOf(PKG, 'materials'),
        value: [],
        row: {},
        id: 'fx',
        labelId: 'l',
        onChange: () => undefined,
      }),
      { ...ENV, refItems: () => undefined },
    ).includes('ant-select-loading'),
  );
  // status
  check(
    '状态：已上架、草稿都用 Status',
    cell(fieldOf(ROUTE, '$status'), 'active').includes('已上架') && view(fieldOf(ROUTE, '$status'), 'draft').includes('草稿'),
  );
  check('状态的表单形态也不能改（只有 Status）', !form(fieldOf(ROUTE, '$status'), 'draft').includes('<input'));
  check(
    '状态只认 draft、active：匿名投影里没有状态（undefined）和别的值写「—」，不画成草稿',
    [undefined, 'archived'].every((v) => {
      const h = cell(fieldOf(ROUTE, '$status'), v);
      return h === '—' && !h.includes('status');
    }),
  );
}

// ---------------- 6. 实体图标 ----------------
{
  for (const p of [travel, renovation]) {
    for (const e of p.entities) check(`${p.id} 的「${e.label}」图标 ${e.icon} 画得出来`, entityIcon(e.icon) !== Box);
  }
  const fallback = ENTITY_ICONS.filter((n) => entityIcon(n) === Box);
  eq('实体图标集合里只有 box 落到 Box', fallback, ['box']);
}

// ---------------- 7. 在 DOM 里挂载 ----------------
// renderToStaticMarkup 不跑 effect，也触发不了 onChange：挂载后在 effect 里写值（打开条目就改了表单、发出 PATCH）、
// 组件把控件的值接错（「不填」写成 '$none'、改第 3 条写进第 1 条），上面几节都看不到。这里用 react-dom/client 真挂一遍

/** 挂一个元素，effect 跑完，再等挂载时排下的定时器和 requestAnimationFrame 也跑完；返回容器和卸载 */
async function mount(el: ReactElement, env: FieldEnv = ENV): Promise<{ box: HTMLElement; unmount(): Promise<void> }> {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(createElement(FieldEnvContext.Provider, { value: env }, el)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await win.happyDOM.waitUntilComplete();
  });
  return {
    box,
    async unmount() {
      await act(async () => root.unmount());
      box.remove();
    },
  };
}

/** 挂一张分组卡片，写回的表单状态再传回去重画（和页面一样），记下每次写回 */
async function mountGrid(e: EntityType, group: string, payload: Payload, ctx: ItemContext) {
  const writes: Payload[] = [];
  let state = formState(payload);
  function Harness() {
    const [s, setS] = useState(state);
    const onChange = (n: Payload): void => {
      writes.push(n);
      state = n;
      setS(n);
    };
    return <FieldGrid entity={e} group={group} state={s} ctx={ctx} onChange={onChange} />;
  }
  const m = await mount(<Harness />);
  return { ...m, writes, state: () => state, patch: () => submission(payload, state, e.fields) };
}

const all = <T extends Element>(root: ParentNode, sel: string): T[] => [...root.querySelectorAll<T>(sel)];
/** 分段控件里文字是 title 的那一段的 radio */
const segment = (root: ParentNode, title: string): HTMLInputElement | undefined =>
  all<HTMLLabelElement>(root, '.ant-segmented-item')
    .find((l) => l.querySelector(`.ant-segmented-item-label[title="${title}"]`))
    ?.querySelector('input') ?? undefined;
async function click(el: Element | null | undefined): Promise<boolean> {
  if (!el) return false;
  await act(async () => (el as HTMLElement).click());
  return true;
}
/** 像敲字一样改输入框：走原型上的 value setter（React 盯着实例上的那个），再发 input 事件 */
async function typeInto(el: Element | null | undefined, text: string): Promise<boolean> {
  if (!el) return false;
  let proto: object | null = Object.getPrototypeOf(el);
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  await act(async () => {
    desc?.set?.call(el, text);
    el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
  return true;
}
async function press(el: Element | null | undefined, key: string): Promise<boolean> {
  if (!el) return false;
  await act(async () => {
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
  return true;
}

// 7.1 挂载和 effect 都不写值：两个包每个字段、子字段的表单形态（有值、空值各一次），和各分组卡片
{
  const t1 = Date.now();
  const wrote: string[] = [];
  for (const [tag, { field, value, row, extra }] of firstProps) {
    for (const v of [value, undefined]) {
      let writes = 0;
      const R = RENDERERS[field.type];
      const m = await mount(
        <R.Form {...extra} field={field} value={v} row={row} id="fx" labelId="fx-label" onChange={() => void (writes += 1)} />,
      );
      await m.unmount();
      if (writes) wrote.push(`${tag}${v === undefined ? '（空）' : ''}：${writes} 次`);
    }
  }
  check(
    `挂载后 effect 跑完，${firstProps.size} 个字段、子字段的表单形态都不写值（${Date.now() - t1}ms）`,
    wrote.length === 0,
    wrote.join('、'),
  );

  const cards: [EntityType, Payload, ItemContext][] = [
    [ROUTE, SICHUAN, ACTIVE],
    [ROUTE, SICHUAN, READER],
    [ROUTE, GUIZHOU_5D, DRAFT],
    [ROUTE, {}, NEW],
    [HOTEL, HOTELS[0]!, ACTIVE],
    [PKG, NUANMU, ACTIVE],
    [PKG, NUANMU, DRAFT],
    [MATERIAL, MATERIALS[0]!, NEW],
  ];
  const cardWrote: string[] = [];
  for (const [e, p, ctx] of cards) {
    for (const g of e.groups) {
      const m = await mountGrid(e, g.key, p, ctx);
      await m.unmount();
      if (m.writes.length) cardWrote.push(`${e.kind}.${g.key}（${String(p.id ?? '新建')}，${ctx.status}）`);
    }
  }
  check('各分组卡片挂载后都不写值，打开不改补丁为空', cardWrote.length === 0, cardWrote.join('、'));
}

// 7.2 经组件写回
{
  // 体力强度（选填单选，分段控件）：点「不填」写 undefined、最累的一段不显示也不提交；再选回来原文还在
  const hardest = (SICHUAN.intensity as Payload).hardest;
  const fit = await mountGrid(ROUTE, 'fit', SICHUAN, ACTIVE);
  check('体力强度：点「不填」', await click(segment(fit.box, '不填')));
  eq('点「不填」：level 删掉，最累的一段留在表单状态里', fit.state().intensity, { hardest });
  eq('点「不填」：补丁里整个 intensity 进 unset', fit.patch(), { set: {}, unset: ['intensity'] });
  check('点「不填」：最累的一段不显示', !fit.box.textContent?.includes(String(hardest)));
  check('再点「较累」', await click(segment(fit.box, '较累')));
  eq(
    '再点回「较累」：补丁为空，最累的一段原文还在',
    [fit.patch(), (fit.state().intensity as Payload).hardest],
    [{ set: {}, unset: [] }, hardest],
  );
  check('点「适中」', await click(segment(fit.box, '适中')));
  eq('点「适中」：intensity 整体进 set', fit.patch(), { set: { intensity: { hardest, level: '适中' } }, unset: [] });
  await fit.unmount();

  // 境内还是境外（必填是否）：新建时一段都不选，点哪段写哪个布尔
  const ov = await mountGrid(ROUTE, 'fit', {}, NEW);
  check('新建：点「境内」', await click(segment(ov.box, '境内')));
  eq('点「境内」写 false', ov.state().overseas, false);
  check('再点「境外」', await click(segment(ov.box, '境外')));
  eq('点「境外」写 true', ov.state().overseas, true);
  await ov.unmount();

  // 选填的是否：点「不填」删键；从没填点成「是」再点回「不填」，补丁回到空
  const optional: EntityType = {
    ...ROUTE,
    groups: [{ key: 'g', label: '组' }],
    fields: [{ key: 'b', type: 'boolean', label: '是否', group: 'g', required: false }],
  };
  const ob = await mountGrid(optional, 'g', { b: true }, DRAFT);
  check('选填是否：点「不填」', await click(segment(ob.box, '不填')));
  eq('选填是否点「不填」：删键，进 unset', ob.patch(), { set: {}, unset: ['b'] });
  await ob.unmount();
  const ob2 = await mountGrid(optional, 'g', {}, DRAFT);
  await click(segment(ob2.box, '是'));
  eq('选填是否从没填点成「是」', ob2.state().b, true);
  await click(segment(ob2.box, '不填'));
  eq('再点回「不填」：补丁为空', ob2.patch(), { set: {}, unset: [] });
  await ob2.unmount();

  // 标签：已上架时「国内」有无都不能变。先确认退格确实删得掉最后一个不锁的，再看删「国内」不写
  const tagsInput = (box: HTMLElement) => box.querySelector('.ant-select-multiple input');
  const t1 = await mountGrid(ROUTE, 'sell', { ...GUIZHOU_5D, tags: ['国内', '贵州'] }, ACTIVE);
  check('标签：在输入框里按退格', await press(tagsInput(t1.box), 'Backspace'));
  eq('按退格删掉最后一个「贵州」', t1.state().tags, ['国内']);
  await t1.unmount();
  const t2 = await mountGrid(ROUTE, 'sell', { ...GUIZHOU_5D, tags: ['贵州', '国内'] }, ACTIVE);
  await press(tagsInput(t2.box), 'Backspace');
  eq('最后一个是锁住的「国内」：按退格不写回，标签不变', [t2.writes.length, t2.state().tags], [0, ['贵州', '国内']]);
  check('点「删除贵州」', await click(t2.box.querySelector('button[aria-label="删除贵州"]')));
  eq('点「删除贵州」：只剩「国内」', t2.state().tags, ['国内']);
  await t2.unmount();
  const t3 = await mountGrid(ROUTE, 'sell', { ...GUIZHOU_5D, tags: ['贵州'] }, ACTIVE);
  // 敲到分隔符「，」就成一个标签（tokenSeparators），不用等下拉
  await typeInto(tagsInput(t3.box), '国内，');
  await typeInto(tagsInput(t3.box), '亲子，');
  eq('没有「国内」时加不上，别的照加', t3.state().tags, ['贵州', '亲子']);
  await t3.unmount();

  // 行程亮点（单字段的有序子项）：改第 2 条、上移、删第 2 条、添加一条，都按下标写回
  const hl = await mountGrid(ROUTE, 'sell', GUIZHOU_5D, DRAFT);
  const lines = GUIZHOU_5D.highlights as string[];
  const rows = () => all<HTMLElement>(hl.box, '.field-list-row');
  check('行程亮点：改第 2 条', await typeInto(rows()[1]?.querySelector('input'), '改过的第二条'));
  eq('改第 2 条：只有第 2 条变了', hl.state().highlights, replaceAt(lines, 1, '改过的第二条'));
  await click(rows()[1]?.querySelector('button[aria-label="上移"]'));
  eq('第 2 条上移', (hl.state().highlights as string[]).slice(0, 2), ['改过的第二条', lines[0]]);
  await click(rows()[0]?.querySelector('button[aria-label="上移"]'));
  eq('第 1 条的上移不动', (hl.state().highlights as string[])[0], '改过的第二条');
  await click(rows()[1]?.querySelector('button[aria-label="删除这条"]'));
  eq('删第 2 条', hl.state().highlights, ['改过的第二条', ...lines.slice(2)]);
  await click(all<HTMLElement>(hl.box, 'button').find((b) => b.textContent?.includes('添加一条')));
  eq('添加一条：末尾多一个空条', (hl.state().highlights as string[]).at(-1), '');
  await hl.unmount();

  // 逐日行程（多字段的有序子项）：第 2 天的餐食点一片、住宿自由输入，只有第 2 天变了
  const days = await mountGrid(ROUTE, 'days', GUIZHOU_5D, DRAFT);
  const day = (n: number) => days.box.querySelector(`section[aria-label="D${n}"]`);
  const before = GUIZHOU_5D.itinerary as Payload[];
  const mealsField = fieldOf(ROUTE, 'itinerary').item!.find((x) => x.key === 'meals')!;
  const wantMeals = formatStored(mealsField, togglePick(parseStored(mealsField, String(before[1]!.meals)) ?? [], '晚'));
  check('第 2 天：点「晚」这一片', await click(all<HTMLElement>(day(2) ?? document, '.field-chip').find((b) => b.textContent === '晚')));
  eq('点「晚」：第 2 天的餐食按选项排好写回', (days.state().itinerary as Payload[])[1]!.meals, wantMeals);
  check('第 2 天的住宿：自由输入', await typeInto(day(2)?.querySelector('.ant-select-auto-complete input'), '库外的客栈'));
  eq('住宿写进第 2 天', (days.state().itinerary as Payload[])[1]!.hotel, '库外的客栈');
  check(
    '别的几天原样',
    (days.state().itinerary as Payload[]).every((d, i) => i === 1 || sameValue(d, before[i])),
  );
  eq('补丁只有逐日行程', Object.keys(days.patch().set), ['itinerary']);
  await days.unmount();

  // 施工节点：第 3 个节点删掉唯一的主材 → 选填清空，经 writeValue 删键（不留 []）；改第 2 个节点的名称
  const nodes = await mountGrid(PKG, 'nodes', NUANMU, DRAFT);
  const node = (n: number) => nodes.box.querySelector(`section[aria-label="节点${n}"]`);
  check('节点3：点主材芯片的删除', await click(node(3)?.querySelector('.ant-select-selection-item-remove')));
  const after = nodes.state().nodes as Payload[];
  eq('节点3 删掉唯一的主材：materials 键删掉', 'materials' in after[2]!, false);
  check(
    '别的节点原样',
    after.every((d, i) => i === 2 || sameValue(d, (NUANMU.nodes as Payload[])[i])),
  );
  check('节点2：改名称', await typeInto(node(2)?.querySelector('input'), '水电改造'));
  eq(
    '名称写进节点2，节点1 不变',
    [(nodes.state().nodes as Payload[])[1]!.name, (nodes.state().nodes as Payload[])[0]!.name],
    ['水电改造', '拆改'],
  );
  await nodes.unmount();

  // 多选引用（套餐的主材，草稿里可改）：删一个芯片
  const terms = await mountGrid(PKG, 'terms', NUANMU, DRAFT);
  const mats = NUANMU.materials as string[];
  const chip = all<HTMLElement>(terms.box, '.ant-select-selection-item').find((c) => c.textContent?.includes('欧派 整体橱柜'));
  check('主材：点「欧派 整体橱柜」的删除', await click(chip?.querySelector('.ant-select-selection-item-remove')));
  eq(
    '主材删掉欧派，按编号写回',
    terms.state().materials,
    mats.filter((m) => m !== 'm-oupai-cab'),
  );
  await terms.unmount();
}

// ---------------- 8. 产品库列表（plan 第 9 步） ----------------
// spec「产品库列表（D 页；L 页上半）」：两个包的真实配置和样例都在这个文件里，列表的纯逻辑、画出来的样子和交互一起测

const IMPORTED_AT = '2026-09-24T10:02:00+08:00';
const asRow = (p: Payload, extra: Partial<ListRow> = {}): ListRow => ({
  code: p.id as string,
  payload: p,
  status: 'active',
  updatedAt: IMPORTED_AT,
  updatedByName: null,
  ...extra,
});
/** 设计系统 §10.0：20 条已上架（系统导入 · 9月24日），r-sichuan-lux 小林今天 10:12 改过，另有小林 13:40 建的草稿 */
const ROUTE_ROWS: ListRow[] = [
  ...ROUTES.map((r) => asRow(r, r.id === 'r-sichuan-lux' ? { updatedByName: '小林', updatedAt: '2026-09-26T10:12:00+08:00' } : {})),
  asRow(GUIZHOU_5D, { status: 'draft', updatedByName: '小林', updatedAt: '2026-09-26T13:40:00+08:00' }),
];
/** 匿名投影：只有已上架的，没有状态、更新时间和更新人 */
const ANON_ROUTES: ListRow[] = ROUTES.map((r) => ({ code: r.id as string, payload: r }));
const HOTEL_ROWS: ListRow[] = HOTELS.map((h) => asRow(h));
/** L 页：旧房翻新是老周今天 11:05 的草稿，暖木老周 9月25日改过，其余系统导入 */
const PKG_ROWS: ListRow[] = PACKAGES.map((p) =>
  asRow(
    p,
    p.id === 'p-jiufang-part'
      ? { status: 'draft', updatedByName: '老周', updatedAt: '2026-09-26T11:05:00+08:00' }
      : p.id === 'p-nuanmu-2r'
        ? { updatedByName: '老周', updatedAt: '2026-09-25T16:20:00+08:00' }
        : { updatedAt: '2026-09-12T09:00:00+08:00' },
  ),
);
const MATERIAL_ROWS: ListRow[] = MATERIALS.map((m) => asRow(m));
const codes = (rows: readonly ListRow[]): string[] => rows.map((r) => r.code);
const idsWhere = (rows: readonly Payload[], ok: (p: Payload) => boolean): string[] => rows.filter(ok).map((p) => p.id as string);

// 8.1 URL 状态（不变量 22）：只留认得的取值，同一个字段只认第一项
{
  eq('URL：页签、搜索、筛选原样留下', catalogSearch({ status: 'draft', q: '四川', f: ['destination:四川'] }), {
    status: 'draft',
    q: '四川',
    f: ['destination:四川'],
  });
  eq('URL：页签只认 active、draft', catalogSearch({ status: 'all' }), {});
  eq('URL：空白的搜索不写进地址', catalogSearch({ q: '  ' }), {});
  eq('URL：数字的搜索按字符串', catalogSearch({ q: 42 }), { q: '42' });
  eq('URL：手写的 f 可以是一个字符串', catalogSearch({ f: 'overseas:true' }), { f: ['overseas:true'] });
  eq(
    'URL：没有冒号、key 或值为空的不认；同一个字段只认第一项',
    catalogSearch({ f: ['bad', ':x', 'k:', 'destination:四川', 'destination:云南', 'segments:家庭', 7] }),
    { f: ['destination:四川', 'segments:家庭'] },
  );
  eq('URL：值里可以有冒号', parseFilter('note:a:b'), { key: 'note', value: 'a:b' });
  eq('设一项筛选', withPick({ q: 'x' }, 'destination', '四川'), { q: 'x', f: ['destination:四川'] });
  eq('换一项筛选的值，别的字段不动', withPick({ f: ['destination:四川', 'segments:家庭'] }, 'destination', '云南'), {
    f: ['segments:家庭', 'destination:云南'],
  });
  eq('清掉一项筛选，f 空了就不写', withPick({ status: 'draft', f: ['destination:四川'] }, 'destination', undefined), { status: 'draft' });
  eq('清除筛选只去掉 f', cleared({ status: 'draft', q: 'x', f: ['a:b'] }), { status: 'draft', q: 'x' });
  eq('空状态的清除筛选连搜索和页签一起回到默认', cleared({ status: 'draft', q: 'x', f: ['a:b'] }, true), {});
  eq('取一个字段的筛选值', pickOf({ f: ['segments:家庭', 'destination:四川'] }, 'destination'), '四川');
}

// 8.2 列、表头、列宽：列来自 list.columns，首列是名称；单位固定的金额把单位写进表头；匿名没有状态、更新两列
{
  const headers = (e: EntityType, anon: boolean): string[] =>
    listColumns(e, anon).map((c) => (c.kind === 'title' ? e.label : c.kind === 'updated' ? '更新' : headerLabel(c.field)));
  eq('D 页的列', headers(ROUTE, false), ['线路', '天数', '每人起价（元）', '最佳季节', '适合客群', '状态', '更新']);
  eq('匿名没有状态、更新两列', headers(ROUTE, true), ['线路', '天数', '每人起价（元）', '最佳季节', '适合客群']);
  eq('酒店的列', headers(HOTEL, false), ['酒店', '星级档次', '每晚起价（元）', '主推房型', '标签', '状态', '更新']);
  eq('L 页的列（假包）', headers(PKG, false), [
    '装修套餐',
    '适用户型',
    '每平米单价（元）',
    '起装面积',
    '工期',
    '适合开工月份',
    '状态',
    '更新',
  ]);
  eq('主材：单位取计价单位字段的金额，表头不写单位', headers(MATERIAL, false), ['主材', '品类', '品牌', '单价', '质保', '状态', '更新']);
  eq(
    '数字列右对齐（金额、带单位的整数、有序子项的条数）',
    ROUTE.fields.filter(numeric).map((f) => f.key),
    ['days', 'priceFrom', 'maxAltitude', 'itinerary', 'inclusions', 'exclusions', 'highlights'],
  );
  eq('首列两行（有次行）', [twoLine(ROUTE), twoLine(PKG), twoLine({ ...PKG, subtitleKeys: [] })], [true, true, false]);

  const widths = (e: EntityType, rows: readonly ListRow[]): (number | undefined)[] =>
    listColumns(e, false).map((c) => columnWidth(c, rows));
  eq('D 页的列宽与设计系统一致：天数 64、每人起价 120、最佳季节 224、适合客群 180、状态 100、更新 152', widths(ROUTE, ROUTE_ROWS), [
    undefined,
    64,
    120,
    224,
    180,
    100,
    152,
  ]);
  eq(
    'D 页的首列在 1152 里占 312（最长的线路名约 281）',
    1152 - tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS) + TITLE_MIN_WIDTH,
    312,
  );
  const pw = widths(PKG, PKG_ROWS);
  check(
    'L 页：表头放得下（「每平米单价（元）」「起装面积」按表头加宽）',
    pw[2]! >= headerWidth('每平米单价（元）') && pw[3]! >= headerWidth('起装面积') && pw[3]! > 64,
    JSON.stringify(pw),
  );
  check('L 页：「120天」按内容加宽', pw[4]! >= textWidth('120天', 14) + 24 && pw[4]! > 64, JSON.stringify(pw));
  check(
    'L 页：1440 宽里不横向滚动',
    tableMinWidth(listColumns(PKG, false), PKG_ROWS) <= 1152,
    String(tableMinWidth(listColumns(PKG, false), PKG_ROWS)),
  );
  // 1280 宽（侧栏展开、内边距 24）表格只有 1008，1366 宽 1094（preview 实测）：首列先收窄，D 页在 1280、L 页在 1366 都不横滚
  check(
    'D 页：1280 宽里不横向滚动（首列先收窄）',
    tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS) <= 1008,
    String(tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS)),
  );
  check(
    'L 页：1366 宽里不横向滚动',
    tableMinWidth(listColumns(PKG, false), PKG_ROWS) <= 1094,
    String(tableMinWidth(listColumns(PKG, false), PKG_ROWS)),
  );
  eq(
    '窄屏的首列留宽：最小宽度按 240 算',
    tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS, TITLE_MIN_NARROW) - tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS),
    TITLE_MIN_NARROW - TITLE_MIN_WIDTH,
  );
  const long = asRow({ ...ROUTES[0]!, segments: ['家庭', '亲子', '银发', '蜜月', '商务', '朋友', '独自'] });
  eq('多选枚举至多 180，再长截断、悬停看全文', columnWidth({ kind: 'field', field: fieldOf(ROUTE, 'segments') }, [long]), 180);
  eq('多选的单元格悬停写全部取值', fullText(fieldOf(ROUTE, 'segments'), long.payload.segments), '家庭、亲子、银发、蜜月、商务、朋友、独自');
  eq('标签的单元格悬停写全部取值', fullText(fieldOf(HOTEL, 'tags'), ['亲子', '海景', '度假', '网红']), '亲子、海景、度假、网红');
  eq('单值字段不另写悬停', fullText(fieldOf(ROUTE, 'destination'), '四川'), undefined);
  eq('宽度估计：汉字 1em、其余 0.6em', [textWidth('天数', 13), textWidth('10天', 14), textWidth('㎡', 14)], [26, 31, 14]);
}

// 8.3 筛选：按钮来自 list.filters，选项按字段类型生成，多值的字段按「包含」匹配
{
  eq('D 页的筛选按钮', filterFields(ROUTE).map(filterName), ['目的地', '境内/境外', '适合客群']);
  eq('筛选按钮的名字：是否少了一种写法时用字段标签', filterName({ ...fieldOf(ROUTE, 'overseas'), trueLabel: undefined }), '境内还是境外');
  eq(
    'L 页的筛选按钮',
    filterFields(PKG).map((f) => f.label),
    ['适用户型', '风格'],
  );
  eq(
    '至多 3 个；有序子项没有可筛的值，不画',
    filterFields({ ...ROUTE, list: { ...ROUTE.list, filters: ['itinerary', 'destination', 'overseas', 'segments', 'days'] } }).map(
      (f) => f.key,
    ),
    ['destination', 'overseas'],
  );
  const pick = (e: EntityType, key: string, value: string): ActivePick => ({ field: listField(e, key)!, value });
  const matching = (e: EntityType, rows: readonly ListRow[], key: string, value: string): string[] =>
    codes(rows.filter((r) => matchesPick(r, pick(e, key, value))));

  const dest = filterOptions(fieldOf(ROUTE, 'destination'), ROUTE_ROWS).map((o) => o.value);
  eq('目的地：取已有的值去重', [...dest].sort(), [...new Set(ROUTES.map((r) => r.destination as string))].sort());
  check(
    '目的地：按拼音排（北京在四川前、四川在云南前）',
    dest.indexOf('北京') < dest.indexOf('四川') && dest.indexOf('四川') < dest.indexOf('云南'),
    dest.join(' '),
  );
  eq(
    '目的地：四川',
    matching(ROUTE, ROUTE_ROWS, 'destination', '四川'),
    idsWhere(ROUTES, (r) => r.destination === '四川'),
  );
  eq(
    '境内还是境外：先 falseLabel 后 trueLabel',
    filterOptions(fieldOf(ROUTE, 'overseas'), []).map((o) => `${o.value}=${o.label}`),
    ['false=境内', 'true=境外'],
  );
  eq(
    '境外',
    matching(ROUTE, ROUTE_ROWS, 'overseas', 'true'),
    idsWhere(ROUTES, (r) => r.overseas === true),
  );
  eq(
    '适合客群：枚举取 options',
    filterOptions(fieldOf(ROUTE, 'segments'), []).map((o) => o.value),
    fieldOf(ROUTE, 'segments').options,
  );
  const silver = matching(ROUTE, ROUTE_ROWS, 'segments', '银发');
  eq('适合客群按「包含」匹配', silver, [...idsWhere(ROUTES, (r) => (r.segments as string[]).includes('银发')), 'r-guizhou-5d']);
  check('适合客群：包含银发的不止一条', silver.length > 1, silver.join(' '));
  eq('适用户型（假包，多选枚举）：别墅', matching(PKG, PKG_ROWS, 'houseTypes', '别墅'), ['p-xinzhongshi-flat']);
  eq(
    '风格（假包，标签）：取已有的值，按拼音排',
    filterOptions(fieldOf(PKG, 'styles'), PKG_ROWS).map((o) => o.value),
    ['奶油', '原木'],
  );
  eq('风格：奶油，按「包含」匹配', matching(PKG, PKG_ROWS, 'styles', '奶油').length, PKG_ROWS.length);
  const months = fieldOf(PKG, 'startMonths');
  eq(
    '月份区间：1–12 月',
    filterOptions(months, []).map((o) => o.label),
    ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  );
  eq('月份区间：7 月（「全年」也算）', matching(PKG, PKG_ROWS, 'startMonths', '7'), [
    'p-xinzhongshi-flat',
    'p-jijian-1r',
    'p-jiufang-part',
  ]);
  const meals = ROUTE.fields.find((f) => f.key === 'itinerary')!.item!.find((f) => f.storeAs)!;
  eq('按字符串存的多选：认得出的拆成几项，认不出的照原文', [atomsOf(meals, '早/晚'), atomsOf(meals, '早餐')], [['早', '晚'], ['早餐']]);
  eq(
    '状态：已上架、草稿',
    filterOptions(fieldOf(ROUTE, '$status'), []).map((o) => o.label),
    ['已上架', '草稿'],
  );
  const days = filterOptions(fieldOf(ROUTE, 'days'), ROUTE_ROWS);
  eq(
    '带单位的整数：从小到大，写单位',
    days.map((o) => o.label),
    [...new Set(ROUTES.map((r) => r.days as number))].sort((a, b) => a - b).map((d) => `${d}天`),
  );
  const ref: FieldDef = { key: 'mat', type: 'reference', to: 'material', store: 'code', label: '主材', group: 'basic' };
  // 编号的顺序（中式柜子、m-daziran-3c、m-oupai-cab）与名称的拼音顺序不同，按错了排得出来
  const refRows = [
    asRow({ id: 'p-1', mat: 'm-oupai-cab' }),
    asRow({ id: 'p-2', mat: '中式柜子' }),
    asRow({ id: 'p-3', mat: 'm-daziran-3c' }),
  ];
  eq(
    '引用：写被引用条目的名称，库里找不到写原文，按名称的拼音排',
    filterOptions(ref, refRows, MATERIAL_REFS).map((o) => o.label),
    ['大自然 三层实木复合地板', '欧派 整体橱柜', '中式柜子'],
  );
  eq('有序子项：没有选项', filterOptions(fieldOf(ROUTE, 'itinerary'), ROUTE_ROWS), []);
  eq(
    '生效的筛选只认本实体的筛选字段，同一个字段只认第一项',
    activePicks(ROUTE, { f: ['destination:四川', 'destination:云南', 'days:8', 'nope:x', 'overseas:false'] }).map(
      (p) => `${p.field.key}=${p.value}`,
    ),
    ['destination=四川', 'overseas=false'],
  );
  const opts = filterOptions(fieldOf(ROUTE, 'overseas'), []);
  eq('生效的按钮写选项的写法', pickLabel(pick(ROUTE, 'overseas', 'true'), opts), '境外');
  eq('地址里带来的、选项里没有的值照原文写', pickLabel(pick(ROUTE, 'destination', '火星'), []), '火星');
}

// 8.4 搜索：覆盖 list.search 的字段，不分大小写、忽略空白
{
  eq('D 页搜索框的占位', searchPlaceholder(ROUTE), '搜索名称、目的地、客户的其他叫法、编号');
  eq('L 页搜索框的占位', searchPlaceholder(PKG), '搜索名称、风格、编号');
  eq('主材搜索框的占位', searchPlaceholder(MATERIAL), '搜索名称、品牌、编号');
  const q = (e: EntityType, rows: readonly ListRow[], text: string): string[] => codes(narrowed(e, rows, { q: text }));
  eq('搜名称里的字', q(ROUTE, ROUTE_ROWS, '稻城'), ['r-sichuan-lux']);
  eq('搜编号，不分大小写', q(ROUTE, ROUTE_ROWS, 'R-GUIZHOU'), ['r-guizhou', 'r-guizhou-5d']);
  eq('搜客户的其他叫法', q(ROUTE, ROUTE_ROWS, '川西'), ['r-sichuan-lux']);
  eq('忽略空白', q(ROUTE, ROUTE_ROWS, ' 稻 城 '), ['r-sichuan-lux']);
  eq('不在 list.search 里的字段不搜（每人起价）', q(ROUTE, ROUTE_ROWS, '42800'), []);
  eq('假包按标签搜', q(PKG, PKG_ROWS, '原木').length, PKG_ROWS.length);
  eq('假包按编号搜', q(PKG, PKG_ROWS, 'jiufang'), ['p-jiufang-part']);
  eq('搜索与筛选一起', codes(narrowed(ROUTE, ROUTE_ROWS, { q: '贵州', f: ['segments:银发'] })), ['r-guizhou', 'r-guizhou-5d']);
}

// 8.5 页签与排序：页签的数字按搜索与筛选之后算；默认按更新时间倒序，同一时刻照接口的顺序；匿名不认页签
{
  eq('页签计数', tabCounts(ROUTE_ROWS), { all: 21, active: 20, draft: 1 });
  eq('页签计数按筛选之后算', tabCounts(narrowed(ROUTE, ROUTE_ROWS, { f: ['destination:贵州'] })), { all: 2, active: 1, draft: 1 });
  const rest = ROUTES.map((r) => r.id as string).filter((id) => id !== 'r-sichuan-lux');
  eq('默认按更新时间倒序，同一时刻照接口的顺序', codes(visibleRows(ROUTE, ROUTE_ROWS, {}, false)), [
    'r-guizhou-5d',
    'r-sichuan-lux',
    ...rest,
  ]);
  eq('草稿页签', codes(visibleRows(ROUTE, ROUTE_ROWS, { status: 'draft' }, false)), ['r-guizhou-5d']);
  eq('已上架页签', visibleRows(ROUTE, ROUTE_ROWS, { status: 'active' }, false).length, 20);
  eq(
    '匿名不认页签，照接口的顺序',
    codes(visibleRows(ROUTE, ANON_ROUTES, { status: 'draft' }, true)),
    ROUTES.map((r) => r.id as string),
  );
  eq('L 页的顺序', codes(visibleRows(PKG, PKG_ROWS, {}, false)), [
    'p-jiufang-part',
    'p-nuanmu-2r',
    'p-naiyou-3r',
    'p-xinzhongshi-flat',
    'p-jijian-1r',
  ]);
  eq('没有更新时间的排在后面', codes(sortRows([{ code: 'a', payload: {} }, ROUTE_ROWS[0]!])), [ROUTE_ROWS[0]!.code, 'a']);
}

// 8.6 更新列：「小林 · 今天13:40」；更新人为空写「系统导入」；更早的写日期
{
  eq('今天的写时刻', updatedParts(ROUTE_ROWS.at(-1)!, NOW), ['小林', '今天13:40']);
  eq('更新人为空写系统导入，更早的写日期', updatedParts(ROUTE_ROWS[1]!, NOW), ['系统导入', '9月24日']);
  eq('昨天也写日期（L 页的「9月25日」）', listTime('2026-09-25T16:20:00+08:00', NOW), '9月25日');
  eq('今天 0 点', listTime('2026-09-26T00:00:00+08:00', NOW), '今天00:00');
  eq('跨年加年份', listTime('2025-12-31T10:00:00+08:00', NOW), '2025年12月31日');
  eq('匿名投影没有更新时间', updatedParts(ANON_ROUTES[0]!, NOW), null);
}

// 页头：编辑角色才有新建；能导入的实体另有导入CSV；非编辑成员和匿名都没有（canEdit 只给所有者、管理员）
{
  eq('编辑角色：线路只有新建（不能导入的不放灰按钮）', listActions(true, ROUTE), { create: true, csv: false });
  eq('编辑角色：酒店另有导入CSV', listActions(true, HOTEL), { create: true, csv: true });
  eq('编辑角色：假包的主材能导入', listActions(true, MATERIAL), { create: true, csv: true });
  eq(
    '非编辑成员与匿名：没有新建和导入',
    [listActions(false, HOTEL), listActions(false, ROUTE)],
    [
      { create: false, csv: false },
      { create: false, csv: false },
    ],
  );
  eq('状态句', statusParts(ROUTE_ROWS), ['共21条', '销售助手只推荐已上架的']);
  eq('状态句：还没取到、一条都没有时不写', [statusParts(undefined), statusParts([])], [null, null]);
}

// 8.7 画出来的列表（挂进 DOM）：页签、表头、首列两行、各列的写法、各种状态
const listProps = (over: Partial<CatalogListProps> = {}): CatalogListProps => ({
  entity: ROUTE,
  rows: ROUTE_ROWS,
  error: null,
  onRetry: () => undefined,
  anon: false,
  search: {},
  onSearch: () => undefined,
  now: NOW,
  titleLink: (_row, children) => (
    <button type="button" className="cell-link">
      {children}
    </button>
  ),
  refItems: ENV.refItems,
  ...over,
});
const texts = (root: ParentNode, sel: string): string[] => all<HTMLElement>(root, sel).map((e) => (e.textContent ?? '').trim());
const bodyRows = (root: ParentNode): HTMLTableRowElement[] => all<HTMLTableRowElement>(root, '.list-table tbody tr.ant-table-row');
const cellsOf = (tr: Element): string[] => all<HTMLElement>(tr, 'td').map((td) => (td.textContent ?? '').trim());
{
  const d = await mount(<CatalogList {...listProps()} />);
  eq('D 页：页签带数量', texts(d.box, '.list-tabs .ant-tabs-tab'), ['全部21', '已上架20', '草稿1']);
  eq('D 页：表头', texts(d.box, '.list-table thead th'), ['线路', '天数', '每人起价（元）', '最佳季节', '适合客群', '状态', '更新']);
  eq('D 页：更新列是当前的排序列', d.box.querySelector('.list-table thead th[aria-sort="descending"]')?.textContent, '更新');
  const rows = bodyRows(d.box);
  eq('D 页：21 行，不足一页不画分页器', [rows.length, d.box.querySelectorAll('.ant-pagination').length], [21, 0]);
  const first = rows[0]!;
  eq('首列：名称是能点的', first.querySelector('.cell-link')?.textContent, '贵州 小七孔·西江千户苗寨 5 日');
  eq(
    '首列次行：目的地 · 编号，编号用等宽字',
    [first.querySelector('.cell-sub')?.textContent, first.querySelector('.cell-sub .mono')?.textContent],
    ['贵州·r-guizhou-5d', 'r-guizhou-5d'],
  );
  check('首列两行的行 56 高（is-two-line）', first.classList.contains('is-two-line'));
  eq('D 页第一行（草稿 r-guizhou-5d）', cellsOf(first).slice(1), ['5天', '13,800', '4–10月', '家庭、亲子、银发', '草稿', '小林·今天13:40']);
  eq('第二行：r-sichuan-lux 小林今天 10:12 改过', cellsOf(rows[1]!).at(-1), '小林·今天10:12');
  eq('第三行起：系统导入 · 9月24日', cellsOf(rows[2]!).at(-1), '系统导入·9月24日');
  check(
    '状态用 Status：草稿是空心圆点',
    !!first.querySelector('.status.status-draft') && !!rows[1]!.querySelector('.status.status-active'),
  );
  eq('更新列悬停看绝对时间', first.querySelector('.cell-updated')?.getAttribute('title'), '9月26日 13:40');
  eq('多选的单元格悬停看全文', (first.querySelectorAll('td')[4] as HTMLElement).getAttribute('title'), '家庭、亲子、银发');
  check('月份区间是月份条加文字', !!first.querySelector('td .month-strip-S'));
  check(
    '数字列右对齐',
    [1, 2].every(
      (i) =>
        (first.querySelectorAll('td')[i] as HTMLElement).className.includes('align-right') ||
        (first.querySelectorAll('td')[i] as HTMLElement).style.textAlign === 'right',
    ),
  );
  eq(
    '工具条：搜索框的占位与名字',
    [
      d.box.querySelector('.list-search input')?.getAttribute('placeholder'),
      d.box.querySelector('.list-search input')?.getAttribute('aria-label'),
    ],
    ['搜索名称、目的地、客户的其他叫法、编号', '搜索线路'],
  );
  eq(
    '工具条：筛选按钮与右侧的条数',
    [texts(d.box, '.filter-trigger'), d.box.querySelector('.list-count')?.textContent],
    [['目的地', '境内/境外', '适合客群'], '21条'],
  );
  eq('没有生效的筛选时不画「清除筛选」', d.box.querySelectorAll('.list-toolbar .list-link').length, 0);
  const tableWidth = (root: ParentNode): string | undefined => root.querySelector<HTMLElement>('.list-table table')?.style.width;
  eq(
    '侧栏展开时表格的最小宽度按首列 160 算（更窄的容器里首列先收窄）',
    tableWidth(d.box),
    `${tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS)}px`,
  );
  await d.unmount();
  win.happyDOM.setViewport({ width: 375, height: 800 });
  const narrow = await mount(<CatalogList {...listProps()} />);
  eq(
    '窄屏（<992）时首列按 240 算，其余列横滚',
    tableWidth(narrow.box),
    `${tableMinWidth(listColumns(ROUTE, false), ROUTE_ROWS, TITLE_MIN_NARROW)}px`,
  );
  await narrow.unmount();
  win.happyDOM.setViewport({ width: 1440, height: 1100 });

  const f = await mount(<CatalogList {...listProps({ search: { f: ['destination:四川', 'overseas:false'], status: 'active' } })} />);
  eq(
    '生效的筛选写成「目的地：四川」，各带一个清除',
    [texts(f.box, '.filter-btn.is-active .filter-trigger'), all(f.box, '.filter-clear').map((b) => b.getAttribute('aria-label'))],
    [
      ['目的地：四川', '境内/境外：境内'],
      ['清除「目的地」筛选', '清除「境内/境外」筛选'],
    ],
  );
  eq(
    '筛选之后的页签数字与条数',
    [texts(f.box, '.list-tabs .ant-tabs-tab'), f.box.querySelector('.list-count')?.textContent],
    [['全部2', '已上架2', '草稿0'], '2条'],
  );
  eq('另有「清除筛选」', texts(f.box, '.list-toolbar .list-link'), ['清除筛选']);
  await f.unmount();

  const anon = await mount(<CatalogList {...listProps({ rows: ANON_ROUTES, anon: true, search: { status: 'draft' } })} />);
  eq('匿名：只有「全部」页签', texts(anon.box, '.list-tabs .ant-tabs-tab'), ['全部20']);
  eq('匿名：没有状态、更新两列', texts(anon.box, '.list-table thead th'), ['线路', '天数', '每人起价（元）', '最佳季节', '适合客群']);
  eq('匿名：地址里的页签不生效', bodyRows(anon.box).length, 20);
  eq('匿名：没有状态', anon.box.querySelectorAll('.status').length, 0);
  await anon.unmount();

  const l = await mount(<CatalogList {...listProps({ entity: PKG, rows: PKG_ROWS })} />);
  eq('L 页：表头', texts(l.box, '.list-table thead th'), [
    '装修套餐',
    '适用户型',
    '每平米单价（元）',
    '起装面积',
    '工期',
    '适合开工月份',
    '状态',
    '更新',
  ]);
  eq('L 页：页签', texts(l.box, '.list-tabs .ant-tabs-tab'), ['全部5', '已上架4', '草稿1']);
  eq('L 页：第一行', cellsOf(bodyRows(l.box)[0]!), [
    '旧房翻新 · 局部改造包p-jiufang-part',
    '两居、三居',
    '860',
    '20㎡',
    '30天',
    '3–11月',
    '草稿',
    '老周·今天11:05',
  ]);
  eq('L 页：「全年」只写「全年」', cellsOf(bodyRows(l.box)[3]!)[5], '全年');
  const lsub = bodyRows(l.box)[0]!.querySelector('.cell-sub');
  eq(
    'L 页：次行只有编号（等宽字）',
    [lsub?.children.length, lsub?.firstElementChild?.className, lsub?.textContent],
    [1, 'mono', 'p-jiufang-part'],
  );
  eq('L 页：筛选按钮', texts(l.box, '.filter-trigger'), ['适用户型', '风格']);
  await l.unmount();

  const m = await mount(<CatalogList {...listProps({ entity: MATERIAL, rows: MATERIAL_ROWS })} />);
  eq('主材：单价的单位跟着计价单位写在单元格里', cellsOf(bodyRows(m.box)[0]!).slice(1, 5), ['瓷砖', '马可波罗', '168元/㎡', '5年']);
  eq('主材：次行是品类 · 编号', bodyRows(m.box)[0]!.querySelector('.cell-sub')?.textContent, '瓷砖·m-marcopolo-800');
  await m.unmount();

  const h = await mount(<CatalogList {...listProps({ entity: HOTEL, rows: HOTEL_ROWS })} />);
  const withTags = bodyRows(h.box).find((tr) => (tr.querySelectorAll('td')[4] as HTMLElement).getAttribute('title'));
  check('酒店：标签列悬停列出全部标签', !!withTags, '没有带 title 的标签格');
  await h.unmount();

  const many = Array.from({ length: 60 }, (_, i) => asRow({ ...ROUTES[i % 20]!, id: `r-many-${i}` }));
  const p = await mount(<CatalogList {...listProps({ rows: many })} />);
  eq(
    '超过 50 条再分页：第一页 50 行，左侧写「共60条」',
    [bodyRows(p.box).length, p.box.querySelector('.ant-pagination-total-text')?.textContent],
    [50, '共60条'],
  );
  check('到第二页', await click(p.box.querySelector('.ant-pagination-item-2')));
  eq('第二页 10 行', bodyRows(p.box).length, 10);
  await p.unmount();

  const empty = await mount(<CatalogList {...listProps({ rows: [], emptyActions: <button type="button">新建线路</button> })} />);
  eq(
    '从来没有过：替换整块内容，不留页签和表头',
    [empty.box.querySelectorAll('.list-tabs').length, empty.box.querySelectorAll('.list-table').length],
    [0, 0],
  );
  eq(
    '从来没有过：标题、说明和操作',
    [texts(empty.box, '.state-empty-title'), texts(empty.box, '.state-empty-desc'), texts(empty.box, '.state-empty-actions button')],
    [['从第一条线路开始'], ['上架后，销售助手会向客户推荐它'], ['新建线路']],
  );
  await empty.unmount();

  const none = await mount(<CatalogList {...listProps({ search: { q: 'zzzz' } })} />);
  eq(
    '筛选无结果：页签、工具条还在，表格换成说明加「看全部」（连搜索和页签一起回到默认，与只清筛选的「清除筛选」不同名）',
    [none.box.querySelectorAll('.list-toolbar').length, texts(none.box, '.state-empty-title'), texts(none.box, '.state-empty .list-link')],
    [1, ['没有符合条件的线路'], ['看全部']],
  );
  eq(
    '筛选无结果：没有主按钮，也没有表格',
    [none.box.querySelectorAll('.state-empty .ant-btn').length, none.box.querySelectorAll('.list-table').length],
    [0, 0],
  );
  await none.unmount();

  const pending = await mount(<CatalogList {...listProps({ rows: undefined })} />);
  eq(
    '加载：8 行表格骨架，行高 56；页签没有数字',
    [
      pending.box.querySelectorAll('.state-skeleton .skeleton-row').length,
      (pending.box.querySelector('.skeleton-row') as HTMLElement | null)?.style.height,
      texts(pending.box, '.list-tabs .ant-tabs-tab'),
    ],
    [8, '56px', ['全部', '已上架', '草稿']],
  );
  eq(
    '加载：筛选按钮都在；取已有值的（目的地）还没有选项，不能点；选项来自行业包的照常能点',
    all<HTMLButtonElement>(pending.box, '.filter-trigger').map((b) => b.disabled),
    [true, false, false],
  );
  await pending.unmount();

  const failed = await mount(<CatalogList {...listProps({ rows: undefined, error: new TypeError('Failed to fetch') })} />);
  eq(
    '出错：表格的位置写「没取到」加重试',
    [texts(failed.box, '.list-tabs .ant-alert-title'), failed.box.querySelectorAll('.list-table').length],
    [['没取到'], 0],
  );
  await failed.unmount();
}

// 8.8 交互：搜索、页签、筛选、清除都经 onSearch 改地址（搜索边敲边改，用 replace）
{
  const calls: { next: CatalogSearch; replace?: boolean }[] = [];
  function Harness({ initial }: { initial: CatalogSearch }) {
    const [search, setSearch] = useState(initial);
    return (
      <CatalogList
        {...listProps({
          search,
          onSearch: (next, replace) => {
            calls.push({ next, replace });
            setSearch(next);
          },
        })}
      />
    );
  }
  const x = await mount(<Harness initial={{ f: ['destination:四川'] }} />);
  const input = x.box.querySelector('.list-search input');
  check('敲字', await typeInto(input, '稻城'));
  eq('搜索写进地址，用 replace', calls.at(-1), { next: { f: ['destination:四川'], q: '稻城' }, replace: true });
  eq(
    '边敲边筛',
    bodyRows(x.box).map((tr) => tr.querySelector('.cell-link')?.textContent),
    ['四川 稻城亚丁·色达秘境 8 日'],
  );
  check('删光', await typeInto(input, ''));
  eq('搜索删光就不写 q', calls.at(-1)?.next, { f: ['destination:四川'] });
  check('点「草稿」页签', await click(all(x.box, '.list-tabs .ant-tabs-tab-btn').find((b) => b.textContent?.startsWith('草稿'))));
  eq('页签写进地址，记一步历史', calls.at(-1), { next: { f: ['destination:四川'], status: 'draft' }, replace: undefined });
  const clear = x.box.querySelector<HTMLElement>('.filter-clear');
  clear?.focus();
  check('点目的地的清除', await click(clear));
  eq('清掉这一项筛选', calls.at(-1)?.next, { status: 'draft' });
  check('清除按钮没了，焦点回到目的地按钮上（不掉到 body）', document.activeElement === x.box.querySelector('.filter-trigger'));
  await x.unmount();

  calls.length = 0;
  const y = await mount(<Harness initial={{ q: 'zzzz', f: ['destination:四川'] }} />);
  const yInput = (): HTMLInputElement => y.box.querySelector('.list-search input')!;
  const toolbarClear = y.box.querySelector<HTMLElement>('.list-toolbar .list-link');
  toolbarClear?.focus();
  check('工具条的「清除筛选」', await click(toolbarClear));
  eq('工具条的「清除筛选」只去掉筛选', calls.at(-1)?.next, { q: 'zzzz' });
  check('「清除筛选」没了，焦点落到搜索框（不掉到 body）', document.activeElement === yInput());
  check('空状态的「看全部」', await click(y.box.querySelector('.state-empty .list-link')));
  eq('「看全部」连搜索和页签一起回到默认', calls.at(-1)?.next, {});
  // 焦点还在搜索框里（Safari 点按钮不挪焦点）时地址变了，搜索框也跟着变
  eq('地址变了，焦点在框里时搜索框也跟着变', yInput().value, '');
  await y.unmount();

  calls.length = 0;
  const z = await mount(<Harness initial={{ status: 'draft', q: 'zzzz' }} />);
  const seeAll = z.box.querySelector<HTMLElement>('.state-empty .list-link');
  seeAll?.focus();
  check('只有搜索和页签时也能「看全部」', await click(seeAll));
  eq('「看全部」回到默认', calls.at(-1)?.next, {});
  check(
    '「看全部」没了，焦点落到清空了的搜索框',
    document.activeElement === z.box.querySelector('.list-search input') &&
      (z.box.querySelector('.list-search input') as HTMLInputElement).value === '',
    `焦点在 ${document.activeElement?.tagName}.${document.activeElement?.className}，框里「${(z.box.querySelector('.list-search input') as HTMLInputElement | null)?.value}」`,
  );
  await z.unmount();

  // 地址比输入晚一拍：敲出去的值回来之前又敲了字，回来的旧值不能把框里的字改回去（吞字）
  const queued: CatalogSearch[] = [];
  let applySearch: (s: CatalogSearch) => void = () => undefined;
  const expose = (set: (s: CatalogSearch) => void): void => void (applySearch = set);
  function LagHarness() {
    const [search, setSearch] = useState<CatalogSearch>({});
    useEffect(() => expose(setSearch), []);
    return <CatalogList {...listProps({ search, onSearch: (next) => void queued.push(next) })} />;
  }
  const lag = await mount(<LagHarness />);
  const lagInput = lag.box.querySelector<HTMLInputElement>('.list-search input')!;
  await typeInto(lagInput, '稻');
  await typeInto(lagInput, '稻城');
  await act(async () => applySearch(queued.shift()!));
  eq('地址回来的是自己敲出去的旧值：框里的字不变', lagInput.value, '稻城');
  await typeInto(lagInput, '稻城亚');
  while (queued.length) {
    const next = queued.shift()!;
    await act(async () => applySearch(next));
  }
  eq('地址追上以后框里是最后敲的字', lagInput.value, '稻城亚');
  await act(async () => applySearch({}));
  eq('不是自己敲出去的（后退、「看全部」）：跟着地址走', lagInput.value, '');
  await lag.unmount();

  // 筛选菜单：选一项、再点同一项清除；多于 7 项时顶部有搜索框
  const picks: (string | undefined)[] = [];
  const destField = fieldOf(ROUTE, 'destination');
  const destOptions = filterOptions(destField, ROUTE_ROWS);
  check('目的地的选项多于 7 个', destOptions.length > MENU_SEARCH_OVER, String(destOptions.length));
  const fb = await mount(<FilterButton field={destField} options={destOptions} pick={undefined} onPick={(v) => void picks.push(v)} />);
  check('点开目的地', await click(fb.box.querySelector('.filter-trigger')));
  await act(async () => win.happyDOM.waitUntilComplete());
  const items = (): HTMLElement[] => all<HTMLElement>(document, '.filter-menu [role="menuitemradio"]');
  eq(
    '菜单列出全部选项',
    items().map((i) => i.textContent),
    destOptions.map((o) => o.label),
  );
  check('多于 7 项时有搜索框', !!document.querySelector('.filter-menu-search input'));
  check('在菜单里搜', await typeInto(document.querySelector('.filter-menu-search input'), '四'));
  eq(
    '菜单只剩含「四」的',
    items().map((i) => i.textContent),
    ['四川'],
  );
  check('选四川', await click(items()[0]));
  eq('选中写回', picks, ['四川']);
  await act(async () => win.happyDOM.waitUntilComplete());
  check('选了以后焦点回到按钮上（菜单项没了，不掉到 body）', document.activeElement === fb.box.querySelector('.filter-trigger'));
  await fb.unmount();
  const fb2 = await mount(
    <FilterButton field={destField} options={destOptions} pick={{ field: destField, value: '四川' }} onPick={(v) => void picks.push(v)} />,
  );
  eq(
    '生效后按钮写「目的地：四川」，没有下拉箭头',
    [fb2.box.querySelector('.filter-trigger')?.textContent, fb2.box.querySelectorAll('.filter-chevron').length],
    ['目的地：四川', 0],
  );
  check('再点开', await click(fb2.box.querySelector('.filter-trigger')));
  await act(async () => win.happyDOM.waitUntilComplete());
  const on = items().find((i) => i.getAttribute('aria-checked') === 'true');
  eq('当前项标 aria-checked', on?.textContent, '四川');
  check('再点同一项', await click(on));
  eq('再点同一项就是清除', picks, ['四川', undefined]);
  await act(async () => win.happyDOM.waitUntilComplete());
  check('清除以后焦点同样回到按钮上', document.activeElement === fb2.box.querySelector('.filter-trigger'));
  const x2 = fb2.box.querySelector<HTMLElement>('.filter-clear');
  x2?.focus();
  check('点 x', await click(x2));
  eq('x 清除这一项', picks, ['四川', undefined, undefined]);
  check('点了 x 焦点回到按钮上', document.activeElement === fb2.box.querySelector('.filter-trigger'));
  await fb2.unmount();
  for (const el of all(document, '.ant-dropdown')) el.remove();

  // 没有搜索框的菜单（7 项以内）：打开后焦点进到菜单里，键盘才能选（antd 的 autoFocus 在包了一层的弹层上聚焦不上）
  const overseas = fieldOf(ROUTE, 'overseas');
  const osOptions = filterOptions(overseas, ROUTE_ROWS);
  for (const [pick, want] of [
    [undefined, '境内'],
    [{ field: overseas, value: 'true' }, '境外'],
  ] as const) {
    const fb3 = await mount(<FilterButton field={overseas} options={osOptions} pick={pick} onPick={(v) => void picks.push(v)} />);
    check(`点开境内/境外（${want}）`, await click(fb3.box.querySelector('.filter-trigger')));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
      await win.happyDOM.waitUntilComplete();
    });
    eq(
      pick ? '打开后焦点在选中的那一项上' : '打开后焦点在第一项上',
      (document.activeElement as HTMLElement | null)?.getAttribute('role') === 'menuitemradio' ? document.activeElement?.textContent : null,
      want,
    );
    // 浏览器里不可聚焦的元素 focus() 不起作用（happy-dom 里都能聚焦，只好看属性）：外壳要可聚焦，antd 才聚焦得上它
    eq('弹层外壳可聚焦（antd 打开时聚焦它，再转给菜单项）', document.querySelector('.filter-menu')?.getAttribute('tabindex'), '-1');
    check('在菜单项上按 Esc', await press(document.activeElement, 'Escape'));
    await act(async () => win.happyDOM.waitUntilComplete());
    check('Esc 关菜单，焦点回到按钮上', document.activeElement === fb3.box.querySelector('.filter-trigger'));
    await fb3.unmount();
    for (const el of all(document, '.ant-dropdown')) el.remove();
  }
  for (const el of all(document, '.ant-dropdown')) el.remove();
}

// 8.9 整页（pages/CatalogPage.tsx）：路由的 kind 按行业包取，身份决定页头的入口、列和页签。查询缓存里先放好身份和列表
{
  const me = (role: 'owner' | 'agent') =>
    ({ userId: 'u1', displayName: '小林', role, csrf: 'c', tenantSlug: 't', tenantName: '云途定制旅行' }) as const;
  const owner = (pack: IndustryPack): Viewer => ({ kind: 'member', me: me('owner'), pack });
  const agent = (pack: IndustryPack): Viewer => ({ kind: 'member', me: me('agent'), pack });
  const anonOf = (pack: IndustryPack): Viewer => ({ kind: 'anon', pack });
  async function mountPage(path: string, viewer: Viewer, lists: Readonly<Record<string, readonly ListRow[]>>) {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(VIEWER_KEY, viewer);
    for (const [kind, items] of Object.entries(lists)) qc.setQueryData(['catalog', kind], { items });
    const root = createRootRoute({ component: Outlet });
    const tree = root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/catalog/$kind', validateSearch: catalogSearch, component: CatalogPage }),
      createRoute({ getParentRoute: () => root, path: '/sop', component: () => null }),
    ]);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
    await router.load();
    return mount(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }
  const header = (root: ParentNode) => ({
    title: root.querySelector('.page-title')?.textContent,
    status: root.querySelector('.page-status > span:not(.page-status-pending)')?.textContent ?? null,
    actions: texts(root, '.page-actions button'),
  });
  const notFound = (root: ParentNode): boolean => texts(root, '.state-empty-title').includes('没有这个页面');

  const r = await mountPage('/catalog/route', owner(travel), { route: ROUTE_ROWS });
  eq('编辑角色：页头有状态句和「新建线路」（线路不能导入，没有导入CSV）', header(r.box), {
    title: '线路',
    status: '共21条·销售助手只推荐已上架的',
    actions: ['新建线路'],
  });
  eq('编辑角色：三个页签', texts(r.box, '.list-tabs .ant-tabs-tab'), ['全部21', '已上架20', '草稿1']);
  eq(
    '名称是链到详情页的链接（第 10.1 步）',
    [r.box.querySelector('.cell-link')?.tagName, r.box.querySelector('.cell-link')?.getAttribute('href')],
    ['A', '/catalog/route/r-guizhou-5d'],
  );
  await r.unmount();

  const h = await mountPage('/catalog/hotel', owner(travel), { hotel: HOTEL_ROWS });
  eq('编辑角色：能导入的酒店另有「导入CSV」', header(h.box).actions, ['导入CSV', '新建酒店']);
  await h.unmount();

  const ag = await mountPage('/catalog/hotel', agent(travel), { hotel: HOTEL_ROWS });
  eq(
    '非编辑成员：没有新建和导入，状态句后面是「只读」',
    [header(ag.box).actions, ag.box.querySelectorAll('.page-actions').length, ag.box.querySelectorAll('.readonly-pill').length],
    [[], 0, 1],
  );
  eq('非编辑成员：照样有三个页签和状态、更新两列', texts(ag.box, '.list-tabs .ant-tabs-tab').length, 3);
  await ag.unmount();

  const an = await mountPage('/catalog/route', anonOf(travel), { route: ANON_ROUTES });
  eq(
    '匿名：没有新建入口，只有「全部」页签，没有状态、更新两列',
    [header(an.box).actions, texts(an.box, '.list-tabs .ant-tabs-tab'), texts(an.box, '.list-table thead th')],
    [[], ['全部20'], ['线路', '天数', '每人起价（元）', '最佳季节', '适合客群']],
  );
  await an.unmount();

  const e = await mountPage('/catalog/hotel', owner(travel), { hotel: [] });
  eq(
    '从来没有过：页头不放按钮、不写状态句，新建和导入只在空状态里',
    [header(e.box), texts(e.box, '.state-empty-actions button')],
    [{ title: '酒店', status: null, actions: [] }, ['导入CSV', '新建酒店']],
  );
  await e.unmount();
  const ea = await mountPage('/catalog/hotel', agent(travel), { hotel: [] });
  eq('从来没有过、非编辑成员：空状态里也没有入口', ea.box.querySelectorAll('.state-empty-actions button').length, 0);
  await ea.unmount();

  const nf = await mountPage('/catalog/package', owner(travel), {});
  check('旅游包里没有 package：「没有这个页面」', notFound(nf.box) && !nf.box.querySelector('.list-tabs'));
  await nf.unmount();
  const nf2 = await mountPage('/catalog/route', owner(renovation), { route: ROUTE_ROWS });
  check('假包里没有 route：「没有这个页面」（不拿包里的第一个实体顶上）', notFound(nf2.box) && !nf2.box.querySelector('.list-tabs'));
  await nf2.unmount();

  const pk = await mountPage('/catalog/package', owner(renovation), { package: PKG_ROWS });
  eq('假包：页头按装修套餐的配置', header(pk.box), {
    title: '装修套餐',
    status: '共5条·销售助手只推荐已上架的',
    actions: listActions(true, PKG).csv ? ['导入CSV', '新建装修套餐'] : ['新建装修套餐'],
  });
  eq('假包：列按 L 页', texts(pk.box, '.list-table thead th'), [
    '装修套餐',
    '适用户型',
    '每平米单价（元）',
    '起装面积',
    '工期',
    '适合开工月份',
    '状态',
    '更新',
  ]);
  eq(
    '假包的名称同样链到详情页（第 10.1 步之前是纯文字）',
    [pk.box.querySelector('.cell-link')?.tagName, pk.box.querySelector('.cell-link')?.getAttribute('href')],
    ['A', '/catalog/package/p-jiufang-part'],
  );
  await pk.unmount();

  // 加载、出错：状态句还没有，先占一行（取到以后下面不跳）；fetch 换成不回来的、连不上的
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  const ld = await mountPage('/catalog/route', owner(travel), {});
  eq(
    '加载：状态句的位置先占一行，表格是骨架',
    [ld.box.querySelectorAll('.page-status .page-status-pending').length, ld.box.querySelectorAll('.state-skeleton').length],
    [1, 1],
  );
  await ld.unmount();
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const er = await mountPage('/catalog/route', owner(travel), {});
  eq(
    '出错：状态句的位置照样占着，表格的位置写「没取到」',
    [er.box.querySelectorAll('.page-status .page-status-pending').length, texts(er.box, '.list-tabs .ant-alert-title')],
    [1, ['没取到']],
  );
  await er.unmount();
  globalThis.fetch = realFetch;
}

// ---------------- 9. 产品库详情（plan 第 10.1 步） ----------------
// spec「产品库详情与编辑（E、F 页；L 页下半）」：纯逻辑在 catalog/detail.ts，整页在 pages/CatalogItemPage.tsx

// 9.1 锁定组：计数、在哪张卡片头声明（每组只说一次）、什么时候声明；状态句的锁定那一段
{
  const rows = (e: EntityType) => lockRows(e).map((r) => `${r.tag}${r.count}@${r.card}`);
  eq('线路的锁定组：识别5（含编号）、计价2、条款2、推荐4（含只锁「国内」的标签），按 lockGroups 的顺序', rows(ROUTE), [
    '识别5@basic',
    '计价2@price',
    '条款2@terms',
    '推荐4@fit',
  ]);
  eq('线路上架后锁定 13 项（设计系统 E 页），酒店 4 项', [lockTotal(ROUTE), lockTotal(HOTEL)], [13, 4]);
  eq(
    '假包装修套餐：识别2、计价2、条款3、推荐1，共 8 项（L 页）',
    [rows(PKG), lockTotal(PKG)],
    [['识别2@basic', '计价2@price', '条款3@terms', '推荐1@fit'], 8],
  );
  eq('主材的编号没有锁定组：算进总数，不单列一行', [rows(MATERIAL).length, lockTotal(MATERIAL)], [1, lockRows(MATERIAL)[0]!.count + 1]);
  eq(
    '识别组在基本信息里声明，同组的「客户的其他叫法」那张卡不再写一遍',
    [declaringCard(ROUTE, 'id'), cardLocks(ROUTE, 'alias', ACTIVE), cardLocks(ROUTE, 'basic', ACTIVE).map((r) => r.key)],
    ['basic', [], ['id']],
  );
  eq(
    '只在已上架、可以编辑时声明：草稿、新建、没有编辑权限都不声明',
    [DRAFT, NEW, READER].map((c) => ROUTE.groups.flatMap((g) => cardLocks(ROUTE, g.key, c)).length),
    [0, 0, 0],
  );
  eq('只锁几个成员的标签不让它所在的卡片声明锁定（§6.4）', cardLocks(ROUTE, 'sell', ACTIVE), []);
  eq(
    '原因加统一的结尾',
    [lockReason('已发给客户的方案书按这些数算价，改了会变价'), lockReason('写好了。')],
    ['已发给客户的方案书按这些数算价，改了会变价。急需修正请联系技术。', '写好了。急需修正请联系技术。'],
  );
  eq(
    '状态句的锁定那一段：已上架、草稿、新建；没有编辑权限不提',
    [lockPhrase(ROUTE, ACTIVE), lockPhrase(ROUTE, DRAFT), lockPhrase(ROUTE, NEW), lockPhrase(ROUTE, READER)],
    ['13项上架后锁定', '上架后13项会锁定', '上架后13项会锁定', null],
  );
  const noLocks: EntityType = {
    ...MATERIAL,
    lockGroups: {},
    fields: MATERIAL.fields.filter((f) => f.key !== '$code' && !f.lockedWhenActive),
  };
  eq('实体里没有锁定的字段：状态句不提锁定', lockPhrase(noLocks, ACTIVE), null);
}

// 9.2 上架前检查每项的写法、指向的字段；卡片与区块；骨架高度；条目名与更新；引用与联想
{
  const noHotel = {
    ...GUIZHOU_5D,
    itinerary: (GUIZHOU_5D.itinerary as Payload[]).map((d, i) => (i === 2 ? { ...d, hotel: undefined } : d)),
  };
  delete ((noHotel.itinerary as Payload[])[2] as Payload).hotel;
  const c = checkItem(ROUTE, noHotel);
  eq('有序子项里的一处写成「第3天：当晚住宿没填」', c.required.map(issueText), ['第3天：当晚住宿没填']);
  eq('建议项跟在字段名后面：「体力强度没填」', c.recommended.map(issueText), ['体力强度没填']);
  eq('条数不一致：「逐日行程还差1天」', checkItem(ROUTE, { ...GUIZHOU_5D, days: 6 }).required.map(issueText), ['逐日行程还差1天']);
  eq(
    '单值的有序子项：「行程亮点第2条没填」',
    issueText({ path: 'highlights.1', label: '行程亮点 · 第2条', message: '没填' }),
    '行程亮点第2条没填',
  );
  eq(
    '检查项指向的字段：取最长的 key，有序子项再接下标与子字段',
    [
      fieldOfPath(ROUTE, 'itinerary.2.hotel')?.key,
      fieldOfPath(ROUTE, 'intensity.hardest')?.key,
      fieldOfPath(ROUTE, 'intensity')?.key,
      fieldOfPath(ROUTE, '$code')?.key,
      fieldOfPath(ROUTE, 'itineraryx')?.key,
    ],
    ['itinerary', 'intensity.hardest', undefined, '$code', undefined],
  );
  eq(
    '有序子项里的下标与子字段',
    [
      subPathOf(fieldOf(ROUTE, 'itinerary'), 'itinerary.2.hotel'),
      subPathOf(fieldOf(ROUTE, 'highlights'), 'highlights.1'),
      subPathOf(fieldOf(ROUTE, 'itinerary'), 'itinerary'),
      subPathOf(fieldOf(ROUTE, 'title'), 'title.1'),
      subPathOf(fieldOf(ROUTE, 'itinerary'), 'itinerary.x.hotel'),
    ],
    [{ index: 2, sub: 'hotel' }, { index: 1 }, null, null, null],
  );
  eq(
    '只有多字段有序子项的分组不套卡片（逐日行程、施工节点）；单字段的逐条列表照常在卡片里',
    [blockOnly(ROUTE, 'days'), blockOnly(ROUTE, 'sell'), blockOnly(ROUTE, 'terms'), blockOnly(PKG, 'nodes'), blockOnly(ROUTE, 'nope')],
    [true, false, false, true, false],
  );
  eq(
    '骨架卡片的高度按两列网格估：基本信息 2 行、卖点 3 行（一格、两个占满一行）、区块按一项估',
    [skeletonCardHeight(ROUTE, 'basic'), skeletonCardHeight(ROUTE, 'sell'), skeletonCardHeight(ROUTE, 'days')],
    [16 + 22 + 12 + 2 * 58 + 20 + 20, 16 + 22 + 12 + 3 * 58 + 2 * 20 + 20, 24 + 12 + 160],
  );
  eq('条目名取 titleKey，没有时写编号', [itemTitle(ROUTE, SICHUAN, 'r-sichuan-lux'), itemTitle(ROUTE, {}, 'r-x')], [SICHUAN.title, 'r-x']);
  eq(
    '更新：更新人为空写「系统导入」；匿名没有更新时间',
    [updatedOf({ updatedAt: '2026-09-24T10:02:00+08:00', updatedByName: null }, NOW)?.by, updatedOf({}, NOW)],
    ['系统导入', null],
  );
  eq(
    '引用指向的实体（含有序子项里的引用），去重',
    [referencedKinds(ROUTE), referencedKinds(PKG), referencedKinds(HOTEL)],
    [['hotel'], ['material'], []],
  );
  eq(
    '联想：已有的值，数组展开、去重、按出现的先后',
    distinctValues([{ payload: { a: 'x' } }, { payload: { a: ['y', 'x'] } }, { payload: { a: '' } }, { payload: {} }], 'a'),
    ['x', 'y'],
  );
}

// 9.3 「已改」按字段比，撤销一处只放回这一处；撤销了每一处以后补丁为空（不变量 16）
{
  const hardest = fieldOf(ROUTE, 'intensity.hardest');
  const level = fieldOf(ROUTE, 'intensity.level');
  const orig = formState(SICHUAN);
  let st = writeValue(orig, hardest, `${String(readValue(orig, 'intensity.hardest'))}；返程日早起`);
  st = writeValue(st, fieldOf(ROUTE, 'hotelLevel'), '奢华');
  eq('只改最累的一段：它改过，体力强度没改', [fieldChanged(orig, st, hardest), fieldChanged(orig, st, level)], [true, false]);
  const back = restoreField(st, orig, hardest);
  eq(
    '撤销最累的一段：它回到原文，住宿档次的改动还在',
    [fieldChanged(orig, back, hardest), readValue(back, 'hotelLevel'), Object.keys(submission(orig, back, ROUTE.fields).set)],
    [false, '奢华', ['hotelLevel']],
  );
  const all2 = restoreField(back, orig, fieldOf(ROUTE, 'hotelLevel'));
  eq('撤销了每一处：补丁为空', submission(orig, all2, ROUTE.fields), { set: {}, unset: [] });
  // 原来没有的（草稿没填体力强度），填了再撤销：删掉，删空的对象一起删
  const d0 = formState(GUIZHOU_5D);
  const d1 = writeValue(d0, level, '较累');
  const d2 = restoreField(d1, d0, level);
  eq(
    '原来没有的字段填了再撤销：键删掉、删空的对象一起删，补丁为空',
    [Object.hasOwn(d2, 'intensity'), submission(d0, d2, ROUTE.fields)],
    [false, { set: {}, unset: [] }],
  );
  // 选填的空值原样放回（不经 writeValue 的删键）
  const withEmpty: Payload = { ...SICHUAN, aliases: [] };
  const e1 = writeValue(withEmpty, fieldOf(ROUTE, 'aliases'), ['川西']);
  eq('撤销时照原样放回，选填的空数组也放回', restoreField(e1, withEmpty, fieldOf(ROUTE, 'aliases')).aliases, []);
  const r = restoreField(st, orig, hardest);
  check('撤销放回的是拷贝，改它不动打开时的内容', r.intensity !== orig.intensity && sameValue(r.intensity, orig.intensity));
}

// 9.4 整页：挂真的路由和查询缓存，身份、条目、列表先放进缓存
{
  const me = (role: 'owner' | 'agent') =>
    ({ userId: 'u1', displayName: '小林', role, csrf: 'c', tenantSlug: 't', tenantName: '云途定制旅行' }) as const;
  const owner = (pack: IndustryPack): Viewer => ({ kind: 'member', me: me('owner'), pack });
  const agent = (pack: IndustryPack): Viewer => ({ kind: 'member', me: me('agent'), pack });
  const anonOf = (pack: IndustryPack): Viewer => ({ kind: 'anon', pack });
  type Cache = { items?: Readonly<Record<string, unknown>>; lists?: Readonly<Record<string, readonly unknown[]>> };
  async function mountDetail(path: string, viewer: Viewer, cache: Cache = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(VIEWER_KEY, viewer);
    for (const [kind, items] of Object.entries(cache.lists ?? {})) qc.setQueryData(['catalog', kind], { items });
    for (const [key, item] of Object.entries(cache.items ?? {})) qc.setQueryData(['catalog', ...key.split('/')], item);
    const root = createRootRoute({ component: Outlet });
    const tree = root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/catalog/$kind',
        validateSearch: catalogSearch,
        component: () => <p className="list-stub" />,
      }),
      createRoute({ getParentRoute: () => root, path: '/catalog/$kind/$code', validateSearch: itemSearch, component: CatalogItemPage }),
      createRoute({ getParentRoute: () => root, path: '/catalog/new/$kind', component: CatalogNewPage }),
    ]);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
    await router.load();
    const m = await mount(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return { ...m, router };
  }
  const header = (root: ParentNode) => ({
    crumb: texts(root, '.breadcrumb > :not(.breadcrumb-sep)'),
    title: root.querySelector('.page-title')?.textContent,
    titleStatus: root.querySelector('.page-title-status')?.textContent ?? null,
    status: root.querySelector('.page-status > span:not(.readonly-pill)')?.textContent ?? null,
  });
  const groupsOf = (root: ParentNode) => all<HTMLElement>(root, '.detail-main > [data-group]').map((e) => e.getAttribute('data-group'));
  const card = (root: ParentNode, g: string) => root.querySelector<HTMLElement>(`.detail-main > [data-group="${g}"]`)!;
  const headTags = (root: ParentNode) => texts(root, '.detail-card-head .lock-tag');
  const checkRows = (root: ParentNode) => texts(root, '.check-list .check-item');
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  const itemOf = (rows: readonly ListRow[], code: string) => ({ kind: 'route', ord: 0, rev: 1, ...rows.find((r) => r.code === code)! });
  const SICHUAN_ITEM = itemOf(ROUTE_ROWS, 'r-sichuan-lux');
  const GUIZHOU_ITEM = itemOf(ROUTE_ROWS, 'r-guizhou-5d');
  const lists = { route: ROUTE_ROWS, hotel: HOTEL_ROWS };

  // E 页：已上架、可以编辑
  const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
  const sichuanAt = listTime(SICHUAN_ITEM.updatedAt!, Date.now());
  eq('E 页页头：面包屑、标题后的状态、状态句', header(e.box), {
    crumb: ['产品库', '线路', SICHUAN.title],
    title: SICHUAN.title,
    titleStatus: '已上架',
    status: `13项上架后锁定·小林更新于${sichuanAt}`,
  });
  eq(
    '面包屑：分组名是纯文本，实体名链回列表，当前页 aria-current',
    [
      e.box.querySelector('.breadcrumb > span')?.tagName,
      e.box.querySelector('.breadcrumb a')?.getAttribute('href'),
      texts(e.box, '.breadcrumb [aria-current="page"]'),
    ],
    ['SPAN', '/catalog/route', [SICHUAN.title]],
  );
  eq('标签页标题「条目名 · 实体名 · 租户名」（不变量 23）', document.title, `${String(SICHUAN.title)} · 线路 · 云途定制旅行`);
  eq(
    '卡片按 groups 的顺序',
    groupsOf(e.box),
    ROUTE.groups.map((g) => g.key),
  );
  eq('逐日行程不套卡片，其余是卡片', [card(e.box, 'days').className, card(e.box, 'basic').className], ['detail-block', 'detail-card']);
  const tags = headTags(e.box);
  eq('每个锁定组的 Tag 只出现一次（验收 16）', tags, ['上架后锁定·识别', '上架后锁定·计价', '上架后锁定·推荐', '上架后锁定·条款']);
  check(
    '原因写在各自卡片头的下一行，结尾统一',
    texts(e.box, '.detail-card-reason').length === 4 &&
      texts(e.box, '.detail-card-reason').every((t) => t.endsWith('。急需修正请联系技术。')),
  );
  const basicEl = card(e.box, 'basic');
  const reasonId = basicEl.querySelector('.detail-card-reason')?.id;
  eq(
    '基本信息整卡锁定：4 列，字段不挂锁，经 aria-describedby 指向卡片头的原因，没有输入框',
    [
      basicEl.querySelector('.field-grid')?.className,
      basicEl.querySelectorAll('.field-lock').length,
      all(basicEl, '.field').every((f) => f.getAttribute('aria-describedby') === reasonId),
      basicEl.querySelectorAll('input').length,
      basicEl.getAttribute('aria-describedby') === reasonId,
    ],
    ['field-grid field-grid-4', 0, true, 0, true],
  );
  eq(
    '「适合谁去」混合卡：卡片头声明推荐组，锁定的三个字段仍挂锁，可改的是控件',
    [
      headTags(card(e.box, 'fit')),
      card(e.box, 'fit').querySelectorAll('.field-lock').length,
      card(e.box, 'fit').querySelectorAll('input').length > 0,
    ],
    [['上架后锁定·推荐'], 3, true],
  );
  eq(
    '「客户怎么叫」：识别组已在基本信息里说过，这张卡不再声明，字段自己挂锁',
    [headTags(card(e.box, 'alias')), card(e.box, 'alias').querySelectorAll('.field-lock').length],
    [[], 1],
  );
  eq(
    '副栏：状态卡写「13项上架后锁定」，每个锁定组一行；已上架没有上架前检查；最近更新',
    [
      e.box.querySelector('.detail-side .status-headline')?.textContent,
      texts(e.box, '.lock-row'),
      all(e.box, '.lock-row').map((b) => b.getAttribute('aria-label')),
      e.box.querySelectorAll('.check-list').length,
      texts(e.box, '.detail-meta dd'),
      e.box.querySelector('.detail-meta dd span')?.getAttribute('title'),
    ],
    [
      '13项上架后锁定',
      ['识别5项', '计价2项', '条款2项', '推荐4项'],
      [
        '识别，5项上架后锁定，跳到基本信息',
        '计价，2项上架后锁定，跳到价格与季节',
        '条款，2项上架后锁定，跳到费用包含与不含',
        '推荐，4项上架后锁定，跳到适合谁去',
      ],
      0,
      ['小林', sichuanAt],
      absoluteTime(SICHUAN_ITEM.updatedAt!, Date.now()),
    ],
  );
  check('能编辑的人有「建议在电脑上编辑」（窄屏才显示，CSS 管）', e.box.querySelectorAll('.detail-narrow-hint').length === 1);
  // 点锁定组那一行：焦点落在声明它的卡片头
  await click(all(e.box, '.lock-row').find((b) => b.textContent?.includes('条款')));
  eq('点「条款」那一行：焦点在「费用包含与不含」的卡片头', document.activeElement?.textContent, '费用包含与不含');
  // 改一处：「已改」只标这一处，撤销后回到原文
  const hardestInput = e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input');
  const hardestText = String(readValue(SICHUAN, 'intensity.hardest'));
  await typeInto(hardestInput, `${hardestText}；返程日早起`);
  eq(
    '改了最累的一段：只有它标「已改」，有「撤销这处」',
    [
      all(e.box, '.field.is-changed').map((f) => f.getAttribute('data-field-key')),
      texts(e.box, '.field.is-changed .field-changed'),
      e.box.querySelector('.field.is-changed .field-undo')?.getAttribute('aria-label'),
    ],
    [['intensity.hardest'], ['已改'], '撤销这处：最累的一段'],
  );
  // 有改动时离开：拦下，弹「有改动还没保存」；「留下」回到原处（不变量 20）
  /** 站内跳转到列表（有改动时被拦下，promise 等人选，不等它） */
  const leave = () =>
    act(async () => {
      void e.router.navigate({ to: '/catalog/$kind', params: { kind: 'route' } });
      await new Promise((r) => setTimeout(r, 20));
    });
  await leave();
  eq(
    '有改动时站内跳转被拦下，弹「有改动还没保存」',
    [document.body.textContent?.includes('有改动还没保存'), e.router.state.location.pathname],
    [true, '/catalog/route/r-sichuan-lux'],
  );
  await click(all<HTMLButtonElement>(document.body, 'button').find((b) => b.textContent === '留下'));
  await settle();
  eq(
    '「留下」：还在这一页，改动还在',
    [e.router.state.location.pathname, hardestInput?.value],
    ['/catalog/route/r-sichuan-lux', `${hardestText}；返程日早起`],
  );
  await click(e.box.querySelector('.field.is-changed .field-undo'));
  eq('撤销这处：回到原文，「已改」没了', [hardestInput?.value, e.box.querySelectorAll('.field.is-changed').length], [hardestText, 0]);
  await leave();
  eq('撤销以后没有改动：直接离开，不拦', e.router.state.location.pathname, '/catalog/route');
  await e.unmount();

  // F、G 页：草稿
  const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
  eq(
    '草稿页头：状态「草稿」，状态句「上架后13项会锁定」',
    [header(d.box).titleStatus, header(d.box).status],
    ['草稿', `上架后13项会锁定·小林更新于${listTime(GUIZHOU_ITEM.updatedAt!, Date.now())}`],
  );
  eq(
    '草稿：卡片头不声明锁定；上架后会锁的字段标签后提醒；状态卡照样列锁定组',
    [
      headTags(d.box),
      d.box.querySelectorAll('.field-will-lock').length,
      texts(d.box, '.lock-row'),
      d.box.querySelector('.status-note')?.textContent,
    ],
    [[], 11, ['识别5项', '计价2项', '条款2项', '推荐4项'], '还没上架，销售助手不会推荐它'],
  );
  eq(
    '上架前检查：必须项13/13、建议1条没做；必须项全过时一行，建议项注「不拦上架」',
    [d.box.querySelector('.check-list-summary')?.textContent, checkRows(d.box)],
    ['必须项13/13·建议1条没做', ['必须项都填好了13/13', '体力强度没填不拦上架']],
  );
  const title = d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="title"] input');
  await typeInto(title, '');
  eq(
    '清空线路名称：检查实时重算，没过的逐条列出',
    [d.box.querySelector('.check-list-summary')?.textContent, checkRows(d.box)[0]],
    ['必须项12/13·建议1条没做', '线路名称没填'],
  );
  await click(all(d.box, '.check-list button.check-item')[0]);
  check('点「线路名称没填」：焦点落进线路名称的输入框', document.activeElement === title);
  await typeInto(title, String(GUIZHOU_5D.title));
  const hotel3 = d.box.querySelector<HTMLInputElement>('[data-field-key="itinerary"] [data-item-index="2"] [data-field-key="hotel"] input');
  await typeInto(hotel3, '');
  eq('第3天的住宿清空：「第3天：当晚住宿没填」', checkRows(d.box)[0], '第3天：当晚住宿没填');
  await click(all(d.box, '.check-list button.check-item').find((b) => b.textContent?.includes('第3天')));
  eq(
    '点它：焦点落进第3天的当晚住宿',
    [document.activeElement?.closest('[data-item-index]')?.getAttribute('data-item-index'), document.activeElement === hotel3],
    ['2', true],
  );
  check('逐日行程改过：区块头标「已改」', card(d.box, 'days').querySelector('.field-block-row .field-changed') !== null);
  await click(all(d.box, '.check-list button.check-item').find((b) => b.textContent?.includes('体力强度')));
  check(
    '点建议项「体力强度没填」：焦点落进体力强度的分段控件',
    document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key') === 'intensity.level',
  );
  await d.unmount();

  // 没有编辑权限：全只读、不挂锁、不提锁定
  const a = await mountDetail('/catalog/route/r-sichuan-lux', agent(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
  eq(
    '非编辑成员：没有输入框、不挂锁、卡片头不声明，状态句只写更新、末尾「只读」，状态卡不列锁定组',
    [
      a.box.querySelectorAll('.detail-main input, .detail-main textarea, .detail-main .ant-segmented').length,
      a.box.querySelectorAll('.field-lock, .field-will-lock').length,
      headTags(a.box),
      header(a.box).status,
      a.box.querySelectorAll('.readonly-pill').length,
      a.box.querySelectorAll('.lock-row').length,
      a.box.querySelector('.status-note')?.textContent,
      a.box.querySelectorAll('.detail-narrow-hint').length,
    ],
    [0, 0, [], `小林更新于${sichuanAt}`, 1, 0, '销售助手会向客户推荐它', 0],
  );
  eq(
    '非编辑成员看基本信息：两列（4 列只给整卡锁定）',
    card(a.box, 'basic').querySelector('.field-grid')?.className,
    'field-grid field-grid-2',
  );
  await a.unmount();

  // 匿名：线上快照里的那一条，没有状态、更新人；没有副栏
  const an = await mountDetail('/catalog/route/r-sichuan-lux', anonOf(travel), {
    items: { 'route/r-sichuan-lux': { kind: 'route', code: 'r-sichuan-lux', payload: SICHUAN } },
    lists: { route: ANON_ROUTES },
  });
  eq(
    '匿名：全只读，没有状态、状态句和副栏',
    [header(an.box), an.box.querySelectorAll('.detail-side').length, an.box.querySelectorAll('.detail-main input').length],
    [{ crumb: ['产品库', '线路', SICHUAN.title], title: SICHUAN.title, titleStatus: null, status: null }, 0, 0],
  );
  await an.unmount();

  // 新建：空表单，编号可以填；不标「已改」
  const n = await mountDetail('/catalog/new/route', owner(travel), { lists });
  eq(
    '新建：标题「新建线路」，面包屑末段同名；状态句只有锁定那一段；编号有输入框',
    [header(n.box), document.title, n.box.querySelectorAll('[data-field-key="$code"] input').length],
    [
      { crumb: ['产品库', '线路', '新建线路'], title: '新建线路', titleStatus: null, status: '上架后13项会锁定' },
      '新建线路 · 云途定制旅行',
      1,
    ],
  );
  eq(
    '新建：上架前检查从空表单算起',
    n.box.querySelector('.check-list-summary')?.textContent,
    `必须项${checkItem(ROUTE, {}).requiredPassed}/13·建议${checkItem(ROUTE, {}).recommended.length}条没做`,
  );
  await typeInto(n.box.querySelector('[data-field-key="destination"] input'), '云南');
  eq('新建里填了字不标「已改」（没有可以撤回的原文）', n.box.querySelectorAll('.field.is-changed').length, 0);
  await n.unmount();
  const na = await mountDetail('/catalog/new/route', agent(travel), { lists });
  eq(
    '非编辑成员打开新建：「你的角色无法执行这项操作」，没有表单',
    [texts(na.box, '.state-empty-title'), na.box.querySelectorAll('.detail-main').length],
    [['你的角色无法执行这项操作'], 0],
  );
  await na.unmount();

  // 假包：L 页下半
  const pkItem = { kind: 'package', ord: 0, rev: 1, ...PKG_ROWS.find((r) => r.code === 'p-nuanmu-2r')! };
  const pk = await mountDetail('/catalog/package/p-nuanmu-2r', owner(renovation), {
    items: { 'package/p-nuanmu-2r': pkItem },
    lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
  });
  eq(
    '假包：面包屑、状态句、锁定组、卡片都按装修套餐的配置',
    [header(pk.box).crumb, header(pk.box).status?.split('·')[0], texts(pk.box, '.lock-row'), groupsOf(pk.box), headTags(pk.box)],
    [
      ['产品库', '装修套餐', '暖木 · 两居全包经典版'],
      '8项上架后锁定',
      ['识别2项', '计价2项', '条款3项', '推荐1项'],
      PKG.groups.map((g) => g.key),
      ['上架后锁定·识别', '上架后锁定·计价', '上架后锁定·推荐', '上架后锁定·条款'],
    ],
  );
  eq(
    '包含主材：只读的多选引用写成芯片，名称链到那一件主材的详情',
    all(card(pk.box, 'terms'), 'a.field-ref-link').map((l) => l.getAttribute('href')),
    (NUANMU.materials as string[]).map((c) => `/catalog/material/${c}`),
  );
  await pk.unmount();
  const nk = await mountDetail('/catalog/package/p-nuanmu-2r', owner(travel), { lists });
  check('旅游包里没有 package：「没有这个页面」', texts(nk.box, '.state-empty-title').includes('没有这个页面'));
  await nk.unmount();

  // 不存在、加载、出错：fetch 换成 404、不回来的、连不上的
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
  const nf = await mountDetail('/catalog/route/r-nope', owner(travel), { lists });
  await settle();
  eq(
    '不存在：「没有这条线路」加「回到线路列表」',
    [
      texts(nf.box, '.state-empty-title'),
      nf.box.querySelector('.state-empty a')?.textContent,
      nf.box.querySelector('.state-empty a')?.getAttribute('href'),
    ],
    [['没有这条线路'], '回到线路列表', '/catalog/route'],
  );
  await nf.unmount();
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  const ld = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { lists });
  eq(
    '加载：两栏骨架，每个分组一张卡、副栏两张',
    [ld.box.querySelectorAll('.state-skeleton').length, ld.box.querySelectorAll('.detail-skeleton-card').length],
    [1, ROUTE.groups.length + 2],
  );
  await ld.unmount();
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const er = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { lists });
  await settle();
  eq(
    '出错：面包屑还在，内容位置写「没取到」加重试',
    [header(er.box).crumb, texts(er.box, '.ant-alert-title'), texts(er.box, '.ant-alert button').map((t) => t.replace(/\s/g, ''))],
    [['产品库', '线路', 'r-sichuan-lux'], ['没取到'], ['重试']],
  );
  await er.unmount();
  globalThis.fetch = realFetch;
}

report();
