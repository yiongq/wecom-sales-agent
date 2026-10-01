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
//    逐条列表的改删移、有序子项按下标经 writeValue 写回、引用的删和自由输入；两个包每个字段、子字段在可改与只读形态里
//    看得见的标签和可访问名都是 field.label（验收 3）。
// 8. 产品库列表（plan 第 9 步，spec「产品库列表」）：两个包的列、表头与列宽，筛选按字段类型生成的选项与「包含」匹配，
//    搜索、页签计数、排序、更新列，URL 状态的解析与改写；挂进 DOM 画 D 页、L 页、主材、匿名、分页、各种状态，
//    再经组件敲字、点页签、点清除、开筛选菜单，核对写回地址的内容和焦点落在哪；再挂整页（路由、查询缓存），
//    核对行业包里没有的 kind、匿名、非编辑成员、从来没有过、加载与出错时页头的样子。
// 9. 产品库详情（plan 第 10.1 步，spec「产品库详情与编辑」）：锁定组的计数与在哪张卡片头声明（每组只说一次）、状态句、
//    上架前检查每项的写法与指向的字段、「已改」与撤销；再挂整页（路由、查询缓存）：已上架、草稿、没有编辑权限、匿名、
//    新建、假包、不存在、加载与出错，点锁定组、点检查项、撤销一处、有改动时离开被拦下、金额的单位跟着计价单位变。
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
import {
  catalogCsvColumns,
  CSV_MAX_BODY_BYTES,
  CSV_MAX_CHARS,
  csvBodyBytes,
  csvLabelsOf,
  csvLongRows,
  csvParts,
  entityCsvShape,
  guardCell,
  toCsv,
  unguardCell,
} from '../../../src/shared/catalog-csv.js';
import { ImportCsvBody } from '../../../src/shared/console-api.js';
import { parseCsv } from '../../../src/shared/csv.js';
import { absoluteTime } from '../../../src/shared/format.js';
import { renovationLPage } from '../../../src/shared/pack-fixtures/renovation-l-page.js';
import { renovation } from '../../../src/shared/pack-fixtures/renovation.js';
import {
  checkItem,
  CODE_RULE,
  ENTITY_ICONS,
  type EntityType,
  type FieldDef,
  type FieldType,
  type IndustryPack,
} from '../../../src/shared/pack.js';
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
import {
  activateSentence,
  blankPayload,
  CODE_HELP,
  codeProblem,
  copyPayload,
  defaultTab,
  inFieldOrder,
  type LockLine,
  lockLines,
  type RefName,
  recommendLine,
  tabOf,
  tabSearch,
  valueText,
  withCodeHints,
} from '../catalog/actions.js';
import { issueTarget } from '../catalog/CatalogDetail.js';
import {
  changedFields,
  changeList,
  issueLine,
  jumpPlace,
  lockedFieldLabel,
  placeIssues,
  placeOf,
  saveCopy,
  saveSummary,
  touchedPlaces,
  usableChanges,
  visibleErrors,
} from '../catalog/save.js';
import {
  cellText,
  checkCsv,
  type CsvTable,
  csvRules,
  csvSummary,
  downloadLabel,
  failedCsv,
  failedName,
  importLabel,
  longNote,
  longTitle,
  lookalikeParts,
  resultWidths,
  submission as csvSubmission,
  tableFields,
  tableHeader,
  templateCsv,
  templateName,
  withServerIssues,
} from '../catalog/csv-import.js';
import { CsvEncodingError, decodeCsvFile, readCsvBytes } from '../csvFile.js';
import { CatalogItemPage, CatalogNewPage } from '../pages/CatalogItemPage.js';
import { CatalogPage } from '../pages/CatalogPage.js';
import { entityIcon } from '../shell/icons.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import { type FieldEnv, FieldEnvContext } from './env.js';
import { FieldGrid, itemErrorsOf, type MemoProps, sameCell } from './FieldGrid.js';
import { FormField, softMaxNote } from './FormField.js';
import {
  blankItem,
  boolFromSegment,
  boolSegment,
  charCount,
  CODECS,
  copyFromPrev,
  countGap,
  countLocked,
  countNote,
  enumFromSegment,
  fieldChanged,
  fieldMode,
  formatStored,
  formState,
  freeText,
  groupGrid,
  isSingleItem,
  type ItemContext,
  itemGaps,
  itemInOrder,
  itemRows,
  itemState,
  keepLockedMembers,
  LAYOUT,
  lockedMembers,
  locksOnActivate,
  moveItem,
  overSoftMax,
  parseStored,
  type Payload,
  pruneHidden,
  readValue,
  refItemsOf,
  type RefItem,
  refLibrary,
  removeAt,
  renumber,
  replaceAt,
  resolveRef,
  restoreField,
  SEG_NONE,
  SEG_UNSET,
  subChanged,
  submission,
  togglePick,
  writeValue,
  writtenValues,
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
// 假包两份：钉 L 页写法的断言（PKG、MATERIAL 和挂整页时的 renovationLPage）用冻结的 L 页版；逐字段画三种形态、样例打开不改
// 这些通用检查用活的 renovation（LIVE_PKG、LIVE_MATERIAL），它比 L 页多出来的字段照样逐个画到
const PKG = entityOf(renovationLPage, 'package');
const MATERIAL = entityOf(renovationLPage, 'material');
const LIVE_PKG = entityOf(renovation, 'package');
const LIVE_MATERIAL = entityOf(renovation, 'material');

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

// 假包的样例（设计系统 L 页）：4 件主材，5 个套餐（第 5 个是草稿）。放在假包旁边（src/shared/pack-fixtures/），
// 往假包里加字段时样例在那里跟着补，这份自测不用改（验收 5 第一条）
const RENO_SAMPLES = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/pack-fixtures/renovation-samples.json'), 'utf8')) as {
  materials: Payload[];
  packages: Payload[];
};
const MATERIALS = RENO_SAMPLES.materials;
const PACKAGES = RENO_SAMPLES.packages;
const NUANMU = PACKAGES.find((p) => p.id === 'p-nuanmu-2r')!;

// 样例本身要合规，不然后面的「打开不改」测的是一份坏数据
for (const p of PACKAGES)
  check(`假包样例 ${p.id} 必须项全过`, checkItem(LIVE_PKG, p).required.length === 0, JSON.stringify(checkItem(LIVE_PKG, p).required));
for (const m of MATERIALS)
  check(
    `假包样例 ${m.id} 必须项全过`,
    checkItem(LIVE_MATERIAL, m).required.length === 0,
    JSON.stringify(checkItem(LIVE_MATERIAL, m).required),
  );
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
  entityLabel: (kind) => [...travel.entities, ...renovation.entities].find((e) => e.kind === kind)?.label,
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
  ['装修套餐（假包样例）', LIVE_PKG, PACKAGES],
  ['主材（假包样例）', LIVE_MATERIAL, MATERIALS],
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
renderItem(renovation, LIVE_PKG, NUANMU);
for (const m of MATERIALS) renderItem(renovation, LIVE_MATERIAL, m);
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
    count(itv, 'class="tl-node is-done"') === 8 && itv.includes('>D1<') && itv.includes('>D8<') && !itv.includes('subitem-label'),
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
  eq(
    '逐日行程表单：每天一张卡片，组名「第5天」，节点里写「D1」…',
    [
      count(itf, 'class="subitem-card has-tools"'),
      itf.includes('aria-label="第5天"'),
      count(itf, '<span class="tl-node is-done" aria-hidden="true">D'),
    ],
    [5, true, 5],
  );
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
  const tool = (i: number, name: string): HTMLElement | null | undefined =>
    rows()[i]?.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
  await click(tool(1, '上移'));
  eq('第 2 条上移', (hl.state().highlights as string[]).slice(0, 2), ['改过的第二条', lines[0]]);
  // 焦点跟着那一条走（第 16 步）：逐条列表按位置渲染，不挪的话焦点留在原位置的按钮上，那里已经是另一条了
  const upFocus = document.activeElement === tool(0, '上移');
  await click(tool(0, '下移'));
  const down = [(hl.state().highlights as string[]).slice(0, 2), document.activeElement === tool(1, '下移')];
  await click(tool(1, '上移'));
  eq(
    '单字段的逐条列表：移动以后焦点跟着那一条，停在它的同一个按钮上（上移到第 1 条，上移是 aria-disabled 也留着焦点）',
    [upFocus, tool(0, '上移')?.getAttribute('aria-disabled'), down],
    [true, 'true', [[lines[0], '改过的第二条'], true]],
  );
  await click(tool(0, '上移'));
  eq('第 1 条的上移不动', (hl.state().highlights as string[])[0], '改过的第二条');
  await click(tool(1, '删除这条'));
  eq('删第 2 条', hl.state().highlights, ['改过的第二条', ...lines.slice(2)]);
  const removeFocus = document.activeElement === tool(1, '删除这条');
  const addBtn = (): HTMLElement | undefined => all<HTMLElement>(hl.box, 'button').find((b) => b.textContent?.includes('添加一条'));
  await click(addBtn());
  eq('添加一条：末尾多一个空条', (hl.state().highlights as string[]).at(-1), '');
  const n = (hl.state().highlights as string[]).length;
  const addFocus = document.activeElement === rows()[n - 1]?.querySelector('input');
  await click(tool(n - 1, '删除这条'));
  eq(
    '焦点：删一条给接替它位置的那一条的「删除这条」，删的是最后一条给上一条的；添加一条进新的那一条的输入框',
    [removeFocus, addFocus, document.activeElement === tool(n - 2, '删除这条')],
    [true, true, true],
  );
  await hl.unmount();
  // 删光了：焦点在「添加一条」
  const one = await mountGrid(ROUTE, 'sell', { ...GUIZHOU_5D, highlights: ['只有一条'] }, DRAFT);
  await click(one.box.querySelector('.field-list-row button[aria-label="删除这条"]'));
  eq(
    '单字段的逐条列表删光了：焦点在「添加一条」',
    [
      one.state().highlights,
      document.activeElement === all<HTMLElement>(one.box, 'button').find((b) => b.textContent?.includes('添加一条')),
    ],
    [[], true],
  );
  await one.unmount();

  // 逐日行程（多字段的有序子项）：第 2 天的餐食点一片、住宿自由输入，只有第 2 天变了
  const days = await mountGrid(ROUTE, 'days', GUIZHOU_5D, DRAFT);
  const day = (n: number) => days.box.querySelector(`[data-item-index="${n - 1}"]`);
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
  const node = (n: number) => nodes.box.querySelector(`[data-item-index="${n - 1}"]`);
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

// 7.3 标签（验收 3「表单与只读形态里没有它的标签」）：两个包的每个字段、子字段，在可改与两种只读（上架后锁定、没有编辑权限）
// 形态里各挂一次 FormField。看得见的标签就是 field.label，控件（只读时是字段那一组）的可访问名也是它；有序子项的区块头以它开头，
// 每一项里子字段的标签再逐个核对。可访问名按 aria-labelledby、aria-label、label[for] 的顺序取
{
  const t3 = Date.now();
  const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').trim();
  const nameOf = (el: Element): string => {
    const by = el.getAttribute('aria-labelledby');
    if (by)
      return by
        .split(/\s+/)
        .map((ref) => textOf(document.getElementById(ref)))
        .join(' ');
    const label = el.getAttribute('aria-label');
    if (label !== null) return label.trim();
    const id = el.getAttribute('id');
    return textOf(id ? document.querySelector(`label[for="${id}"]`) : el.closest('label'));
  };
  /** 可改时承载名字的元素：输入框、下拉、一组按钮；不算有序子项里各项的子字段 */
  const CONTROL =
    'input:not([type="hidden"]), textarea, [role="combobox"], [role="group"], [role="radiogroup"], [aria-labelledby], [aria-label]';
  const bad: string[] = [];
  let checked = 0;
  let statusOnly = 0;
  function labelOf(tag: string, el: Element, f: FieldDef, editing: boolean): void {
    checked += 1;
    const block = el.classList.contains('field-block');
    const same = (s: string): boolean => (block ? s.startsWith(f.label) : s === f.label);
    const head = el.querySelector(block ? '.field-block-head' : '.field-label');
    if (!head || head.closest('.field') !== el || !same(textOf(head))) bad.push(`${tag}：看得见的标签是「${textOf(head)}」`);
    if (!editing) {
      if (!same(nameOf(el))) bad.push(`${tag}：只读那一组的名字是「${nameOf(el)}」`);
      return;
    }
    const controls = all(el, CONTROL).filter((c) => c.closest('.field') === el);
    // 状态字段三种形态都是只显示的 StatusShow，没有控件；别的类型可改时一定有
    if (!controls.length) {
      if (f.type === 'status') statusOnly += 1;
      else bad.push(`${tag}：可改时没有控件`);
      return;
    }
    if (!controls.some((c) => same(nameOf(c))))
      bad.push(`${tag}：控件的名字是 ${controls.map((c) => `「${nameOf(c)}」`).join('')}，没有一个是「${f.label}」`);
  }
  for (const [tag, { field, value, row }] of firstProps) {
    for (const mode of ['edit', 'locked', 'readonly'] as const) {
      const editing = mode === 'edit';
      const m = await mount(
        <FormField
          field={field}
          mode={mode}
          span={LAYOUT[field.type].span(field, mode)}
          value={value}
          row={row}
          onChange={editing ? () => undefined : undefined}
        />,
      );
      const el = m.box.querySelector('.field');
      if (!el) bad.push(`${tag}（${mode}）：没画出字段`);
      else {
        labelOf(`${tag}（${mode}）`, el, field, editing);
        // 有序子项每一项里的子字段（FormField 套在有序子项里）
        for (const sub of all(el, '.field').filter((s) => s !== el)) {
          const def = field.item?.find((s) => s.key === sub.getAttribute('data-field-key'));
          if (def) labelOf(`${tag}.${def.key}（${mode}，项里）`, sub, def, editing);
          else bad.push(`${tag}（${mode}）：项里有个认不出的字段 ${String(sub.getAttribute('data-field-key'))}`);
        }
      }
      await m.unmount();
    }
  }
  check(
    `两个包每个字段、子字段在可改与只读形态里都有标签，就是 field.label（${firstProps.size} 个 × 3 种形态，连项里的子字段共 ${checked} 处，` +
      `其中 ${statusOnly} 处是状态字段，可改时也只显示；${Date.now() - t3}ms）`,
    bad.length === 0 && checked > firstProps.size * 3,
    bad.join('\n'),
  );
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
  // 第 17.1 步往活的假包里后加的字段（验收 5 第一条），console/src 没为它们改：主材的产地、规格照字段配置跟在品牌后面成列；
  // 套餐的含软装只当筛选（成列还是只当筛选待 owner 定，plan「Open」），列仍是 L 页的 8 列
  eq(
    '后加的产地、规格：主材照字段配置多两列；套餐的列不变',
    [headers(LIVE_MATERIAL, false), headers(LIVE_PKG, false)],
    [['主材', '品类', '品牌', '产地', '规格', '单价', '质保', '状态', '更新'], headers(PKG, false)],
  );
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
  check(
    '主材多了后加的产地、规格两列：1366 宽里照样不横向滚动',
    tableMinWidth(listColumns(LIVE_MATERIAL, false), MATERIAL_ROWS) <= 1094,
    String(tableMinWidth(listColumns(LIVE_MATERIAL, false), MATERIAL_ROWS)),
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
  // 后加的两个筛选（活的假包）：没配两种文字的是否，按钮写字段标签、选项用默认的「否」「是」；没填的条目哪一项都不中
  const soft = fieldOf(LIVE_PKG, 'softFurnishing');
  eq(
    '后加的含软装（是否）：套餐的第 3 个筛选，按钮写标签，选项「否」「是」；草稿「旧房翻新」没填，两边都不中',
    [
      filterFields(LIVE_PKG).map(filterName),
      filterOptions(soft, PKG_ROWS).map((o) => `${o.value}=${o.label}`),
      matching(LIVE_PKG, PKG_ROWS, 'softFurnishing', 'true'),
      matching(LIVE_PKG, PKG_ROWS, 'softFurnishing', 'false'),
    ],
    [
      ['适用户型', '风格', '含软装'],
      ['false=否', 'true=是'],
      ['p-naiyou-3r', 'p-xinzhongshi-flat'],
      ['p-nuanmu-2r', 'p-jijian-1r'],
    ],
  );
  eq(
    '后加的产地（文字）：主材的第二个筛选，取已有的值去重、按拼音排',
    [filterFields(LIVE_MATERIAL).map(filterName), filterOptions(fieldOf(LIVE_MATERIAL, 'origin'), MATERIAL_ROWS).map((o) => o.label)],
    [
      ['品类', '产地'],
      ['广东东莞', '广东佛山', '广东广州'],
    ],
  );
  eq('产地：广东佛山', matching(LIVE_MATERIAL, MATERIAL_ROWS, 'origin', '广东佛山'), ['m-daziran-3c', 'm-jianpai-bath']);
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
  // 后加的字段在列表里（活的假包）：主材的产地写原文、规格写条数，产地是第二个筛选；套餐的含软装是第三个筛选，表头不变
  const lm = await mount(<CatalogList {...listProps({ entity: LIVE_MATERIAL, rows: MATERIAL_ROWS })} />);
  eq(
    '后加的产地写原文、规格写条数（欧派的规格是空的），产地是主材的第二个筛选',
    [cellsOf(bodyRows(lm.box)[0]!).slice(1, 7), bodyRows(lm.box).map((tr) => cellsOf(tr)[4]), texts(lm.box, '.filter-trigger')],
    [
      ['瓷砖', '马可波罗', '广东东莞', '1种', '168元/㎡', '5年'],
      ['1种', '2种', '0种', '3种'],
      ['品类', '产地'],
    ],
  );
  await lm.unmount();
  const lp = await mount(<CatalogList {...listProps({ entity: LIVE_PKG, rows: PKG_ROWS })} />);
  eq(
    '后加的含软装：套餐列表的第 3 个筛选，表头仍是 L 页的 8 列',
    [texts(lp.box, '.filter-trigger'), texts(lp.box, '.list-table thead th').length],
    [['适用户型', '风格', '含软装'], 8],
  );
  await lp.unmount();

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
  const nf2 = await mountPage('/catalog/route', owner(renovationLPage), { route: ROUTE_ROWS });
  check('假包里没有 route：「没有这个页面」（不拿包里的第一个实体顶上）', notFound(nf2.box) && !nf2.box.querySelector('.list-tabs'));
  await nf2.unmount();

  const pk = await mountPage('/catalog/package', owner(renovationLPage), { package: PKG_ROWS });
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
  eq(
    '后加的含软装随条款组锁（活的假包）：条款4、共 9 项',
    [rows(LIVE_PKG), lockTotal(LIVE_PKG)],
    [['识别2@basic', '计价2@price', '条款4@terms', '推荐1@fit'], 9],
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
  const sellFirst: EntityType = { ...ROUTE, groups: [...ROUTE.groups].sort((a, b) => (a.key === 'sell' ? -1 : b.key === 'sell' ? 1 : 0)) };
  eq(
    '卖点排在适合谁去前面时，推荐组照样在适合谁去声明：只锁「国内」的标签那张卡不算',
    [declaringCard(sellFirst, 'rec'), cardLocks(sellFirst, 'sell', ACTIVE)],
    ['fit', []],
  );
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
  const nested: EntityType = {
    ...ROUTE,
    fields: [
      { key: 'x', type: 'subItems', label: 'X', group: 'basic', item: [{ key: 'y', type: 'text', label: 'Y', group: '' }] },
      { key: 'x.y', type: 'text', label: 'XY', group: 'basic' },
    ],
  };
  eq('两个 key 都对得上时取长的那个', [fieldOfPath(nested, 'x.y')?.key, fieldOfPath(nested, 'x.1.y')?.key], ['x.y', 'x']);
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
    '详情地址的页签只认 edit、preview（路由表 /catalog/$kind/$code 一行）',
    [itemSearch({ tab: 'preview' }), itemSearch({ tab: 'edit' }), itemSearch({ tab: 'x' }), itemSearch({})],
    [{ tab: 'preview' }, { tab: 'edit' }, {}, {}],
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
  check('撤销不改打开时的内容', sameValue(orig, formState(SICHUAN)) && sameValue(r.intensity, orig.intensity));

  // 卡片头声明了一个锁定组、卡里另一组的锁在别处声明过：那一组的字段照样挂锁，只有声明了的指向卡片头
  const two: EntityType = {
    ...ROUTE,
    groups: [{ key: 'g', label: '组' }],
    fields: [
      { key: 'a', type: 'text', label: 'A', group: 'g', lockedWhenActive: true, lockGroup: 'id' },
      { key: 'b', type: 'text', label: 'B', group: 'g', lockedWhenActive: true, lockGroup: 'price' },
    ],
  };
  const twoHtml = html(
    <FieldGrid
      entity={two}
      group="g"
      state={{ a: '1', b: '2' }}
      ctx={ACTIVE}
      onChange={() => undefined}
      lockNoteId="n"
      declaredLocks={['id']}
    />,
  );
  eq(
    '整卡锁定、卡片头只声明识别：识别的字段不挂锁、指向卡片头，计价的字段挂锁',
    [count(twoHtml, 'class="field-lock"'), count(twoHtml, 'aria-describedby="n"')],
    [1, 1],
  );
  const lockedChanged = html(
    <FormField field={fieldOf(ROUTE, 'title')} mode="locked" span="half" value="x" row={{}} changed onUndo={() => undefined} />,
  );
  check('锁定、只读的字段不标「已改」，也没有撤销', !lockedChanged.includes('field-changed') && !lockedChanged.includes('field-undo'));

  // 按函数改状态时字段只在画出来的东西变了才重画（逐字重渲时弹层不跟着重画，React #185）
  const base: MemoProps = {
    field: fieldOf(PKG, 'pricePerSqm'),
    mode: 'edit',
    span: 'half',
    value: 1280,
    row: NUANMU,
    onChange: () => undefined,
    lockedMembers: [],
    deps: ['㎡'],
  };
  eq(
    '字段重画的判定：回调、整条 row 和内容相同的新数组换了不算，值、单位、锁住的成员、已改、报错变了才算',
    [
      sameCell(base, { ...base, onChange: () => 1, onUndo: () => 2, row: { ...NUANMU }, lockedMembers: [], deps: ['㎡'] }),
      sameCell(base, { ...base, value: 1290 }),
      sameCell(base, { ...base, deps: ['延米'] }),
      sameCell(base, { ...base, lockedMembers: ['国内'] }),
      sameCell(base, { ...base, changed: true }),
      sameCell(base, { ...base, error: '没填' }),
      sameCell(base, { ...base, mode: 'locked' }),
    ],
    [true, false, false, false, false, false, false],
  );
}

// 9.4 与第 10 节共用：挂真的路由和查询缓存，身份、条目、列表先放进缓存
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
  return { ...m, router, qc };
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

// 9.4 整页
{
  // 检查项找字段：外层字段优先于同名的子字段，哪怕子字段排在前面
  {
    /** 一个元素：属性、子元素 */
    const el = (tag: string, attrs: Record<string, string>, ...kids: HTMLElement[]): HTMLElement => {
      const x = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
      x.append(...kids);
      return x;
    };
    const sub = el(
      'div',
      { 'data-field-key': 'x' },
      el('div', { 'data-item-index': '0' }, el('div', { 'data-field-key': 'y' }, el('input', { class: 'in-sub' }))),
    );
    const top = el('div', { 'data-field-key': 'y' }, el('input', { class: 'in-top' }));
    const box = el('div', {}, sub, top);
    const ent: EntityType = {
      ...ROUTE,
      fields: [
        { key: 'x', type: 'subItems', label: 'X', group: 'basic', item: [{ key: 'y', type: 'text', label: 'Y', group: '' }] },
        { key: 'y', type: 'text', label: 'Y', group: 'basic' },
      ],
    };
    eq(
      '检查项指向外层的字段 y，不是排在前面的子项里的 y；子项里的一处找得到那一项的 y',
      [issueTarget(box, ent, 'y') === top, issueTarget(box, ent, 'x.0.y')?.querySelector('input')?.className],
      [true, 'in-sub'],
    );
  }

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
  eq(
    '已上架：页头只有「更多」（里面是复制为新草稿），没有「上架…」',
    all(e.box, '.page-actions button').map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ['更多'],
  );
  eq(
    '状态卡的说明：已上架、能编辑时写「其余内容可以直接改，保存后立即生效」',
    e.box.querySelector('.detail-side .status-note')?.textContent,
    '其余内容可以直接改，保存后立即生效',
  );
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
  // 两张卡先后各改一处：后一处按函数改，不盖掉前一处（没重画的卡片手里的表单状态是旧的）
  await typeInto(hardestInput, `${hardestText}；返程日早起`);
  await typeInto(e.box.querySelector('[data-field-key="hotelLevel"] input'), '奢华');
  eq(
    '两张卡各改一处：两处都标「已改」',
    all(e.box, '.field.is-changed').map((f) => f.getAttribute('data-field-key')),
    ['intensity.hardest', 'hotelLevel'],
  );
  await typeInto(hardestInput, `${hardestText}；返程`);
  eq('再改第一处：第二处的改动还在', e.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input')?.value, '奢华');
  await click(e.box.querySelector('[data-field-key="hotelLevel"] .field-undo'));
  await click(e.box.querySelector('[data-field-key="intensity.hardest"] .field-undo'));
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
  eq(
    '副栏三张卡的标题同级（h2），读屏不把「上架前检查」放到「状态」下面',
    all(d.box, '.detail-side h2, .detail-side h3, .detail-side h4').map((h) => `${h.tagName}${h.textContent}`),
    ['H2状态', 'H2上架前检查', 'H2最近更新'],
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
  eq('非编辑成员：页头没有「更多」「上架…」', a.box.querySelectorAll('.page-actions').length, 0);
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
    `必须项${checkItem(ROUTE, blankPayload(ROUTE)).requiredPassed}/13·建议${checkItem(ROUTE, blankPayload(ROUTE)).recommended.length}条没做`,
  );
  await typeInto(n.box.querySelector('[data-field-key="destination"] input'), '云南');
  eq('新建里填了字不标「已改」（没有可以撤回的原文）', n.box.querySelectorAll('.field.is-changed').length, 0);
  eq(
    '新建：页头没有「更多」「上架…」，也没有页签',
    [n.box.querySelectorAll('.page-actions').length, n.box.querySelectorAll('.detail-tabs').length],
    [0, 0],
  );
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
  const pk = await mountDetail('/catalog/package/p-nuanmu-2r', owner(renovationLPage), {
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
  eq(
    '假包的已上架套餐：页头同样有「更多」',
    all(pk.box, '.page-actions button').map((b) => b.getAttribute('aria-label')),
    ['更多'],
  );
  await pk.unmount();
  // 金额的单位取自另一个字段（unitFrom）：只改计价单位，单价的单位跟着变（字段按值记忆，它读的单位字段也算在里面）
  const nm = await mountDetail('/catalog/new/material', owner(renovationLPage), { lists: { package: PKG_ROWS, material: MATERIAL_ROWS } });
  const priceUnitEl = nm.box.querySelector<HTMLElement>('[data-field-key="priceUnit"]');
  const unitText = () => nm.box.querySelector('[data-field-key="unitPrice"] .field-unit')?.textContent;
  const unit0 = unitText();
  await click(priceUnitEl ? segment(priceUnitEl, '延米') : null);
  const unit1 = unitText();
  await click(priceUnitEl ? segment(priceUnitEl, '套') : null);
  eq('新建主材：计价单位没选时单价写「元」，选「延米」「套」以后跟着变', [unit0, unit1, unitText()], ['元', '元/延米', '元/套']);
  await nm.unmount();
  // 第 17.1 步往活的假包里后加的字段（验收 5 第一条）：详情、只读、新建都照字段配置画出来，console/src 的代码没为它们改
  const lpk = await mountDetail('/catalog/package/p-nuanmu-2r', owner(renovation), {
    items: { 'package/p-nuanmu-2r': pkItem },
    lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
  });
  const lpkSoft = card(lpk.box, 'terms').querySelector<HTMLElement>('[data-field-key="softFurnishing"]');
  eq(
    '后加的含软装：状态句与锁定组多算一项；在施工与条款卡里随条款组锁住，只读写默认的「否」（没配 trueLabel / falseLabel）',
    [
      header(lpk.box).status?.split('·')[0],
      texts(lpk.box, '.lock-row'),
      lpkSoft?.classList.contains('is-static'),
      lpkSoft?.querySelector('.field-label')?.textContent,
      lpkSoft?.querySelector('.field-value')?.textContent,
    ],
    ['9项上架后锁定', ['识别2项', '计价2项', '条款4项', '推荐1项'], true, '含软装', '否'],
  );
  await lpk.unmount();
  const lnp = await mountDetail('/catalog/new/package', owner(renovation), { lists: { package: PKG_ROWS, material: MATERIAL_ROWS } });
  const lnpSoft = lnp.box.querySelector<HTMLElement>('[data-field-key="softFurnishing"]');
  eq(
    '新建套餐：后加的含软装是分段控件，选填的「不填」在最前，标签后写「（选填）」和「上架后锁定」',
    [
      lnpSoft ? texts(lnpSoft, '.ant-segmented-item-label') : null,
      lnpSoft?.querySelector('.optional-mark')?.textContent,
      lnpSoft?.querySelector('.field-will-lock') !== null,
    ],
    [['不填', '否', '是'], '（选填）', true],
  );
  await lnp.unmount();
  const daziran = MATERIAL_ROWS.find((r) => r.code === 'm-daziran-3c')!;
  const lma = await mountDetail('/catalog/material/m-daziran-3c', agent(renovation), {
    items: { 'material/m-daziran-3c': { kind: 'material', ord: 0, rev: 1, ...daziran } },
    lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
  });
  const lmaField = (k: string) => card(lma.box, 'basic').querySelector<HTMLElement>(`[data-field-key="${k}"]`);
  eq(
    '非编辑成员看主材：后加的产地写原文，规格逐条写成列表',
    [
      lmaField('origin')?.querySelector('.field-value')?.textContent,
      texts(lmaField('specs') ?? document.createElement('i'), '.field-value li'),
    ],
    ['广东佛山', ['1210×165×15', '910×125×15']],
  );
  await lma.unmount();
  const lnm = await mountDetail('/catalog/new/material', owner(renovation), { lists: { package: PKG_ROWS, material: MATERIAL_ROWS } });
  const lnmField = (k: string) => card(lnm.box, 'basic').querySelector<HTMLElement>(`[data-field-key="${k}"]`);
  const addSpec = () => all<HTMLButtonElement>(lnmField('specs') ?? lnm.box, 'button').find((b) => b.textContent?.trim() === '添加一种');
  const specs0 = lnmField('specs')?.querySelectorAll('input').length;
  await click(addSpec());
  eq(
    '新建主材：后加的产地是带例子的联想输入框（suggest 取已有值）；规格是逐条列表，空的时候没有输入框，点「添加一种」多一个带例子的输入框',
    [
      lnmField('origin')?.querySelector('.ant-select-auto-complete .ant-select-placeholder')?.textContent,
      specs0,
      [...(lnmField('specs')?.querySelectorAll('input') ?? [])].map((i) => i.getAttribute('placeholder')),
    ],
    ['例：广东佛山', 0, ['例：800×800']],
  );
  await lnm.unmount();
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

// ---------------- 10. 保存条与提交（plan 第 10.2 步） ----------------
// spec「产品库详情与编辑」的保存条、报错落到字段、409：纯逻辑在 catalog/save.ts，整页照第 9.4 节挂真的路由和查询缓存，
// fetch 换成按方法与地址回应的假接口，核对发出的请求

// 10.1 改动的口径与写法（设计系统 E、G 页）、保存条的说明与按钮
{
  const hardest = fieldOf(ROUTE, 'intensity.hardest');
  const e1 = writeValue(formState(SICHUAN), hardest, `${String(readValue(SICHUAN, 'intensity.hardest'))}；返程日早起`);
  const lines = SICHUAN.highlights as string[];
  const e2 = writeValue(e1, fieldOf(ROUTE, 'highlights'), replaceAt(lines, 1, `${lines[1]}（改）`));
  eq('E 页：「最累的一段、行程亮点第2条」，按字段的顺序', changeList(ROUTE, SICHUAN, e2), [
    { path: 'intensity.hardest', label: '最累的一段' },
    { path: 'highlights.1', label: '行程亮点第2条' },
  ]);
  const days = GUIZHOU_5D.itinerary as Payload[];
  const dayDetail = fieldOf(ROUTE, 'itinerary').item!.find((x) => x.key === 'detail')!;
  const g = {
    ...GUIZHOU_5D,
    itinerary: days.map((d, i) =>
      i === 2 ? { ...d, hotel: '茂兰小寨客栈' } : i === 3 ? writeValue(d, dayDetail, `${String(readValue(d, dayDetail.key))}（改）`) : d,
    ),
  };
  eq('G 页：多字段的有序子项逐个子字段写「第3天的当晚住宿、第4天的当天安排」', changeList(ROUTE, GUIZHOU_5D, g), [
    { path: 'itinerary.2.hotel', label: '第3天的当晚住宿' },
    { path: 'itinerary.3.detail', label: '第4天的当天安排' },
  ]);
  eq(
    '条数变了：整个字段算一处；子项里改了不认得的键（天号）写到那一项',
    [
      changeList(ROUTE, GUIZHOU_5D, { ...GUIZHOU_5D, itinerary: days.slice(1) }),
      changeList(ROUTE, GUIZHOU_5D, { ...GUIZHOU_5D, itinerary: days.map((d, i) => (i === 1 ? { ...d, day: 9 } : d)) }),
    ],
    [[{ path: 'itinerary', label: '逐日行程' }], [{ path: 'itinerary.1', label: '逐日行程第2天' }]],
  );
  // 体力强度选「不填」：最累的一段不显示了，提交时一起删掉，也算一处
  const off = writeValue(formState(SICHUAN), fieldOf(ROUTE, 'intensity.level'), undefined);
  eq(
    '体力强度选「不填」：体力强度与最累的一段两处（最累的一段不显示，提交时删掉）',
    changeList(ROUTE, SICHUAN, off).map((c) => c.label),
    ['体力强度', '最累的一段'],
  );
  eq(
    '点改动清单的一处：不显示的最累的一段跳到管它显示的体力强度；显示着的跳到自己',
    [jumpPlace(ROUTE, off, 'intensity.hardest'), jumpPlace(ROUTE, e2, 'intensity.hardest'), jumpPlace(ROUTE, g, 'itinerary.2.hotel')],
    ['intensity.level', 'intensity.hardest', 'itinerary.2.hotel'],
  );
  eq('打开不改：没有改动', changeList(ROUTE, SICHUAN, formState(SICHUAN)), []);
  const nodes = NUANMU.nodes as Payload[];
  eq(
    '假包：施工节点的量词「个节点」，写「第3个节点的验收要点」',
    changeList(PKG, NUANMU, { ...NUANMU, nodes: nodes.map((n, i) => (i === 2 ? { ...n, checkpoints: '改过' } : n)) }),
    [{ path: 'nodes.2.checkpoints', label: '第3个节点的验收要点' }],
  );
  // 与补丁同一个口径：有改动当且仅当补丁不空
  const cases: Payload[] = [e2, g, off, formState(SICHUAN), { ...GUIZHOU_5D, itinerary: days.slice(1) }];
  const origs: Payload[] = [SICHUAN, GUIZHOU_5D, SICHUAN, SICHUAN, GUIZHOU_5D];
  eq(
    '有改动当且仅当补丁不空（同一个口径）',
    cases.map((c, i) => {
      const p = submission(origs[i]!, c, ROUTE.fields);
      return changeList(ROUTE, origs[i]!, c).length > 0 === (Object.keys(p.set).length > 0 || p.unset.length > 0);
    }),
    cases.map(() => true),
  );
  eq(
    '409 之后的对比按整字段：最累的一段、行程亮点',
    changedFields(ROUTE, SICHUAN, e2).map((f) => f.key),
    ['intensity.hardest', 'highlights'],
  );
  // 还能用回的：已上架时锁定的线路名称不算；表单里已经是你改的样子的不算；没有编辑权限的都不算
  const mineWithTitle = writeValue(e2, fieldOf(ROUTE, 'title'), '别的名字');
  const act1 = { status: 'active' as const, canEdit: true };
  eq(
    '对比里还能「用我的改动」的：锁定的不算，已经用回的不算，没有编辑权限的不算',
    [
      usableChanges(ROUTE, { before: SICHUAN, mine: mineWithTitle }, SICHUAN, act1).map((f) => f.key),
      usableChanges(ROUTE, { before: SICHUAN, mine: mineWithTitle }, e1, act1).map((f) => f.key),
      usableChanges(ROUTE, { before: SICHUAN, mine: mineWithTitle }, SICHUAN, { ...act1, canEdit: false }).length,
    ],
    [['intensity.hardest', 'highlights'], ['highlights'], 0],
  );
  eq(
    '保存条的说明与主按钮：草稿、已上架（设计系统 E、G 页）',
    [saveCopy('draft'), saveCopy('active')],
    [
      { note: '草稿保存后仍不会推荐给客户', button: '保存草稿' },
      { note: '销售助手下一条回复就用新内容', button: '保存并立即生效' },
    ],
  );
}

// 10.2 报错落在哪、怎么写；只显示碰过的
{
  eq(
    '位置：编号是 id；有序子项接下标与子字段；认不得的子字段落到那一项；更细的路径落到字段；对不上的是 null',
    [
      'id',
      'itinerary.2.hotel',
      'itinerary.2.day',
      'itinerary.2',
      'itinerary',
      'highlights.1',
      'tags.2',
      'intensity.level',
      'intensity',
      'nope',
      '',
    ].map((p) => placeOf(ROUTE, p)),
    ['$code', 'itinerary.2.hotel', 'itinerary.2', 'itinerary.2', 'itinerary', 'highlights.1', 'tags', 'intensity.level', null, null, null],
  );
  eq(
    '写法：「境内还是境外：没选」「当晚住宿：没填」「第3天：序号应为3」；已经以字段名开头的不重复；英文说明写成「格式不对」',
    [
      issueLine(ROUTE, 'overseas', '没选'),
      issueLine(ROUTE, 'itinerary.2.hotel', '没填'),
      issueLine(ROUTE, 'itinerary.2', '序号应为3'),
      issueLine(ROUTE, 'highlights.1', '没填'),
      issueLine(ROUTE, 'itinerary', '逐日行程有7天，要和天数（8）相同'),
      issueLine(ROUTE, 'intensity.hardest', 'Too big: expected string to have <=100 characters'),
      issueLine(ROUTE, '$code', '编号只能是小写字母、数字和连字符，以字母或数字开头，最长64位'),
    ],
    [
      '境内还是境外：没选',
      '当晚住宿：没填',
      '第3天：序号应为3',
      '第2条：没填',
      '逐日行程有7天，要和天数（8）相同',
      '最累的一段：格式不对',
      '线路编号：编号只能是小写字母、数字和连字符，以字母或数字开头，最长64位',
    ],
  );
  const got = placeIssues(ROUTE, [
    { path: 'itinerary.3.hotel', message: '不能为空' },
    { path: 'title', message: '不能为空' },
    { path: '', message: 'Unrecognized key: "nope"' },
    { path: 'itinerary.1.hotel', message: '不能为空' },
  ]);
  eq(
    '按字段的顺序、有序子项再按第几项；落不到字段上的单独给出，只写说明',
    [got.placed.map((p) => `${p.at}|${p.field}|${p.text}`), got.loose],
    [
      [
        'title|title|线路名称：不能为空',
        'itinerary.1.hotel|itinerary|当晚住宿：不能为空',
        'itinerary.3.hotel|itinerary|当晚住宿：不能为空',
      ],
      ['格式不对'],
    ],
  );
  // 新建：空表单，只碰过编号
  const seen = (touched: string[], all = false) => ({ touched: new Set(touched), all });
  const one = visibleErrors(ROUTE, {}, seen(['$code']), null);
  eq('新建时只碰过编号：只有编号报错（验收 16）', [Object.keys(one.byPlace), one.byPlace.$code], [['$code'], '线路编号：没填']);
  const every = visibleErrors(ROUTE, {}, seen([], true), null);
  eq(
    '点过保存：全部必须项都报，含「境内还是境外：没选」',
    [every.list.length, every.byPlace.overseas],
    [checkItem(ROUTE, {}).required.length, '境内还是境外：没选'],
  );
  const noHotel: Payload = {
    ...GUIZHOU_5D,
    itinerary: (GUIZHOU_5D.itinerary as Payload[]).map((d, i) => (i === 2 ? { ...d, hotel: '' } : d)),
  };
  eq(
    '有序子项：碰过第3天的住宿才报在那里；碰过别的子字段不算',
    [
      visibleErrors(ROUTE, noHotel, seen(['itinerary', 'itinerary.2', 'itinerary.2.title']), null).byPlace,
      visibleErrors(ROUTE, noHotel, seen(['itinerary', 'itinerary.2', 'itinerary.2.hotel']), null).byPlace,
    ],
    [{}, { 'itinerary.2.hotel': '当晚住宿：没填' }],
  );
  // 服务端的：显示到那个字段改过为止；同一个位置表单自己也查出来的，只写一遍（表单的）
  const server = {
    ...placeIssues(ROUTE, [
      { path: 'intensity.hardest', message: '太长' },
      { path: 'title', message: '不能为空' },
    ]),
    sent: SICHUAN,
  };
  const edited = writeValue(SICHUAN, fieldOf(ROUTE, 'intensity.hardest'), '改短了');
  eq(
    '服务端的报错显示到字段改过为止',
    [
      visibleErrors(ROUTE, SICHUAN, seen([]), server).byPlace['intensity.hardest'],
      visibleErrors(ROUTE, edited, seen([]), server).byPlace['intensity.hardest'],
    ],
    ['最累的一段：太长', undefined],
  );
  // 有序子项里按那一处比：改了第2天的标题，第3天、第5天的报错还在；一项本身的（天号）在这一项里改了哪处都收
  const trip = SICHUAN.itinerary as Payload[];
  const inDays = {
    ...placeIssues(ROUTE, [
      { path: 'itinerary.1.title', message: '太长了' },
      { path: 'itinerary.2.day', message: '第3天的天号应为3' },
      { path: 'itinerary.4.detail', message: '含有存不下的字符' },
    ]),
    sent: SICHUAN,
  };
  const dayEdit = (i: number, key: string): Payload => ({
    ...SICHUAN,
    itinerary: trip.map((d, k) => (k === i ? { ...d, [key]: '改过' } : d)),
  });
  eq(
    '服务端的报错按位置比：改第2天的标题只收它那一条，改第2天的住宿不收；改第3天的住宿收第3天本身的那一条；别的天的都还在',
    [
      Object.keys(visibleErrors(ROUTE, SICHUAN, seen([]), inDays).byPlace),
      Object.keys(visibleErrors(ROUTE, dayEdit(1, 'title'), seen([]), inDays).byPlace),
      Object.keys(visibleErrors(ROUTE, dayEdit(1, 'hotel'), seen([]), inDays).byPlace),
      Object.keys(visibleErrors(ROUTE, dayEdit(2, 'hotel'), seen([]), inDays).byPlace),
    ],
    [
      ['itinerary.1.title', 'itinerary.2', 'itinerary.4.detail'],
      ['itinerary.2', 'itinerary.4.detail'],
      ['itinerary.1.title', 'itinerary.2', 'itinerary.4.detail'],
      ['itinerary.1.title', 'itinerary.4.detail'],
    ],
  );
  const cleared = writeValue(SICHUAN, fieldOf(ROUTE, 'title'), '');
  eq(
    '同一个位置两边都有：只写表单的一条（服务端的这一条随字段改过也就不显示了）',
    visibleErrors(ROUTE, cleared, seen([], true), { ...server, sent: cleared }).byPlace.title,
    '线路名称：没填',
  );
  eq(
    '汇总按字段的顺序排，表单的与服务端的混在一起（「跳到第一处」跳到最前面的字段）',
    visibleErrors(ROUTE, cleared, seen([], true), {
      ...placeIssues(ROUTE, [{ path: 'intensity.hardest', message: '太长' }]),
      sent: cleared,
    }).list.map((p) => p.at),
    ['title', 'intensity.hardest'],
  );
  // 月份区间认不出：控件自己写「没认出月份」，字段下方不再写一遍，汇总照样算一处（plan 第 3.2 步的交接）
  const summer = writeValue(SICHUAN, fieldOf(ROUTE, 'bestSeason'), '夏天');
  const sv = visibleErrors(ROUTE, summer, seen([], true), null);
  eq(
    '月份区间认不出：byPlace 里没有它，list 里有它；清空时照常写「最佳季节：没填」',
    [
      Object.hasOwn(sv.byPlace, 'bestSeason'),
      sv.list.map((p) => p.at),
      visibleErrors(ROUTE, writeValue(SICHUAN, fieldOf(ROUTE, 'bestSeason'), undefined), seen([], true), null).byPlace.bestSeason,
    ],
    [false, ['bestSeason'], '最佳季节：没填'],
  );
  eq(
    '失焦的位置：由里到外的祖先链换成由外到里的几层',
    [
      touchedPlaces([{ field: 'hotel' }, { item: '2' }, { field: 'itinerary' }]),
      touchedPlaces([{ item: '1' }, { field: 'highlights' }]),
      touchedPlaces([{ field: 'overseas' }]),
      touchedPlaces([]),
    ],
    [['itinerary', 'itinerary.2', 'itinerary.2.hotel'], ['highlights', 'highlights.1'], ['overseas'], []],
  );
  eq(
    '锁定字段的中文名：键名、标签里的一项、编号；认不得的不把键名给人看',
    ['title', 'tags:国内', 'id', 'intensity', 'zzz'].map((k) => lockedFieldLabel(ROUTE, k)),
    ['线路名称', '标签里的「国内」', '线路编号', '体力强度', '其他内容'],
  );
  eq(
    '有序子项里各处的报错：去掉字段 key 那一段；没有时 undefined',
    [itemErrorsOf({ 'itinerary.2.hotel': 'a', itinerary: 'b', itineraryx: 'c' }, 'itinerary'), itemErrorsOf({ title: 'x' }, 'itinerary')],
    [{ '2.hotel': 'a' }, undefined],
  );
  const base: MemoProps = { field: fieldOf(ROUTE, 'itinerary'), mode: 'edit', span: 'block', value: [], row: {}, deps: [] };
  eq(
    '字段重画：子项报错内容相同的新对象不算变，内容变了才算',
    [
      sameCell({ ...base, itemErrors: { '2.hotel': 'a' } }, { ...base, itemErrors: { '2.hotel': 'a' } }),
      sameCell({ ...base, itemErrors: { '2.hotel': 'a' } }, { ...base, itemErrors: { '2.hotel': 'b' } }),
      sameCell({ ...base, itemErrors: { '2.hotel': 'a' } }, base),
    ],
    [true, false, false],
  );
}

// 10.3 整页
{
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  type Sent = { method: string; url: string; body: unknown };
  /** 换掉 fetch：reply 返回 undefined 的按列表回应；记下每个请求 */
  function fakeApi(reply: (s: Sent) => Response | Promise<Response> | undefined) {
    const sent: Sent[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const s = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      sent.push(s);
      const r = reply(s);
      if (r) return Promise.resolve(r);
      const items = url.endsWith('/catalog/hotel')
        ? HOTEL_ROWS
        : url.endsWith('/catalog/material')
          ? MATERIAL_ROWS
          : url.endsWith('/catalog/package')
            ? PKG_ROWS
            : ROUTE_ROWS;
      return Promise.resolve(json({ items }));
    };
    return { sent, patches: () => sent.filter((x) => x.method === 'PATCH'), restore: () => void (globalThis.fetch = real) };
  }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
  };
  const bar = (root: ParentNode) => root.querySelector<HTMLElement>('.action-bar');
  const barText = (root: ParentNode) => {
    const b = bar(root);
    return b
      ? {
          summary: b.querySelector('.action-bar-summary')?.textContent,
          names: b.querySelector('.save-bar-names')?.textContent,
          note: b.querySelector('.action-bar-note')?.textContent,
          buttons: texts(b, '.action-bar-side button').map((t) => t.replace(/\s/g, '')),
        }
      : null;
  };
  const primary = (root: ParentNode) => bar(root)?.querySelector<HTMLButtonElement>('.action-bar-side button:last-child');
  const cmdS = () =>
    act(async () => {
      const ev = new win.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
      win.dispatchEvent(ev);
      cmdSPrevented = ev.defaultPrevented;
    });
  let cmdSPrevented = false;
  /** 页面上看得见的字：折叠的技术详情不算 */
  const visibleText = (root: HTMLElement) => {
    const c = root.cloneNode(true) as HTMLElement;
    for (const t of c.querySelectorAll('.tech-details-body')) t.remove();
    return c.textContent ?? '';
  };
  const errorAt = (root: ParentNode, sel: string) => root.querySelector(`${sel} .field-error`)?.textContent ?? null;
  const hardestText = String(readValue(SICHUAN, 'intensity.hardest'));
  const hl = SICHUAN.highlights as string[];

  // E 页：打开不改没有保存条；改两处出现，写法照设计系统 E 页；展开改动；⌘S 按打开时的 rev 发补丁；存好以后页面换成返回的条目
  {
    let release: (() => void) | null = null;
    // 假接口按补丁累积：第二次保存返回的条目带着第一次存上的内容
    let stored: Payload = SICHUAN;
    const api = fakeApi((s) => {
      if (s.method !== 'PATCH') return undefined;
      const b = s.body as { rev: number; set: Payload };
      stored = { ...stored, ...b.set };
      const item = {
        ...SICHUAN_ITEM,
        rev: b.rev + 1,
        updatedByName: '小周',
        updatedAt: new Date(Date.now()).toISOString(),
        payload: stored,
      };
      return new Promise<Response>((r) => (release = () => r(json(item))));
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    check('打开不改：没有保存条（验收 16）', bar(e.box) === null);
    await cmdS();
    eq('打开不改按 ⌘S：拦下浏览器的「存储网页」，不发请求', [cmdSPrevented, api.patches().length], [true, 0]);
    const hardestIn = e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input');
    await typeInto(hardestIn, `${hardestText}；返程日早起`);
    await typeInto(e.box.querySelector('[data-field-key="highlights"] [data-item-index="1"] input'), `${hl[1]}（改）`);
    eq('改两处：保存条照设计系统 E 页', barText(e.box), {
      summary: '有2处改动',
      names: '最累的一段、行程亮点第2条',
      note: '销售助手下一条回复就用新内容',
      buttons: ['放弃', '保存并立即生效'],
    });
    eq(
      '保存条：图标是 clock，主按钮提示 ⌘S；副栏让出保存条的高度',
      [
        bar(e.box)?.querySelector('.save-bar-icon') !== null,
        primary(e.box)?.getAttribute('title'),
        e.box.querySelector('.detail-layout')?.classList.contains('has-save-bar'),
      ],
      [true, '⌘S', true],
    );
    const toggle = e.box.querySelector<HTMLButtonElement>('.save-bar-toggle');
    await click(toggle);
    eq(
      '展开改动：aria-expanded，清单每处一行',
      [toggle?.getAttribute('aria-expanded'), texts(e.box, '.save-changes .save-change'), toggle?.textContent],
      ['true', ['最累的一段', '行程亮点第2条'], '收起改动'],
    );
    await press(e.box.querySelector('.save-changes .save-change'), 'Escape');
    eq(
      '清单里按 Esc：收起，焦点回到「展开改动」',
      [e.box.querySelectorAll('.save-changes').length, document.activeElement === toggle],
      [0, true],
    );
    await click(toggle);
    await press(toggle, 'Escape');
    eq(
      '焦点在「展开改动」上按 Esc：同样收起',
      [e.box.querySelectorAll('.save-changes').length, toggle?.getAttribute('aria-expanded')],
      [0, 'false'],
    );
    await click(toggle);
    await act(async () => {
      e.box
        .querySelector('[data-field-key="hotelLevel"]')
        ?.dispatchEvent(new win.Event('pointerdown', { bubbles: true }) as unknown as Event);
    });
    const afterOutside = e.box.querySelectorAll('.save-changes').length;
    await click(toggle);
    await act(async () => {
      e.box.querySelector('.save-changes')?.dispatchEvent(new win.Event('pointerdown', { bubbles: true }) as unknown as Event);
    });
    eq('在清单以外按下：收起；在清单里按下不收', [afterOutside, e.box.querySelectorAll('.save-changes').length], [0, 1]);
    await click(toggle);
    await click(toggle);
    await click(all(e.box, '.save-changes .save-change')[1]);
    eq(
      '点「行程亮点第2条」：清单收起，焦点落进行程亮点的第2条',
      [
        e.box.querySelectorAll('.save-changes').length,
        document.activeElement?.closest('[data-item-index]')?.getAttribute('data-item-index'),
        document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key'),
      ],
      [0, '1', 'highlights'],
    );
    await cmdS();
    await until(() => api.patches().length > 0);
    const want = submission(
      SICHUAN,
      e.box
        ? writeValue(
            writeValue(formState(SICHUAN), fieldOf(ROUTE, 'intensity.hardest'), `${hardestText}；返程日早起`),
            fieldOf(ROUTE, 'highlights'),
            replaceAt(hl, 1, `${hl[1]}（改）`),
          )
        : {},
      ROUTE.fields,
    );
    eq(
      '⌘S：PATCH 到这一条，带打开时的 rev，set 是改了的顶层字段，没有 unset 键',
      [api.patches().length, api.patches()[0]?.url.endsWith('/api/console/catalog/route/r-sichuan-lux'), api.patches()[0]?.body],
      [1, true, { rev: 1, set: want.set }],
    );
    eq('提交中：主按钮 loading，不禁用', [primary(e.box)?.classList.contains('ant-btn-loading'), primary(e.box)?.disabled], [true, false]);
    await cmdS();
    await click(primary(e.box));
    eq('提交中再按 ⌘S、再点：不重发', api.patches().length, 1);
    // 提交中又改了一处：存好以后这一处还在，保存条只剩它
    await typeInto(e.box.querySelector('[data-field-key="hotelLevel"] input'), '奢华');
    await act(async () => release?.());
    await until(() => !primary(e.box)?.classList.contains('ant-btn-loading'));
    eq(
      '存好以后：页头换成返回的条目，提交前的两处不再是改动，提交中改的一处还在，读屏不念「已保存」',
      [
        header(e.box).status?.split('·')[1]?.startsWith('小周更新于今天'),
        all(e.box, '.field.is-changed').map((f) => f.getAttribute('data-field-key')),
        barText(e.box)?.summary,
        e.box.querySelector('.save-live')?.textContent,
      ],
      [true, ['hotelLevel'], '有1处改动', ''],
    );
    eq('缓存里这一条换成返回的（rev 2）', (e.qc.getQueryData(['catalog', 'route', 'r-sichuan-lux']) as { rev: number }).rev, 2);
    const firstPatch = api.sent.findIndex((x) => x.method === 'PATCH');
    await until(() => api.sent.slice(firstPatch).some((x) => x.method === 'GET' && x.url.endsWith('/api/console/catalog/route')));
    check(
      '存好以后线路列表失效、重新取（名称、更新时间、联想跟着变）',
      api.sent.slice(firstPatch).some((x) => x.method === 'GET' && x.url.endsWith('/api/console/catalog/route')),
    );
    // 这次用 Tab 到主按钮再点：存好以后按钮随保存条消失，焦点回到最后待过的字段（住宿档次）
    const levelIn = e.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input');
    await act(async () => levelIn?.focus());
    await act(async () => primary(e.box)?.focus());
    await click(primary(e.box));
    await until(() => api.patches().length > 1);
    eq('再存一次：带上一次返回的 rev 2', api.patches()[1]?.body, { rev: 2, set: { hotelLevel: '奢华' } });
    await act(async () => release?.());
    await until(() => bar(e.box) === null);
    await settle();
    eq(
      '都存好：保存条消失，没有「已改」，读屏念「已保存」，没有 toast；焦点回到住宿档次',
      [
        bar(e.box) === null,
        e.box.querySelectorAll('.field.is-changed').length,
        e.box.querySelector('.save-live')?.textContent,
        document.querySelectorAll('.ant-message-notice').length,
        document.activeElement === levelIn,
      ],
      [true, 0, '已保存', 0, true],
    );
    await typeInto(hardestIn, '再改');
    eq('再改一处：「已保存」清掉', e.box.querySelector('.save-live')?.textContent, '');
    await click(e.box.querySelector('[data-field-key="intensity.hardest"] .field-undo'));
    eq('撤销回到存好的内容：不再念「已保存」', [bar(e.box) === null, e.box.querySelector('.save-live')?.textContent], [true, '']);
    await e.unmount();
    api.restore();
  }

  // 体力强度选「不填」：清单里的「最累的一段」页面上没有了，点它跳到体力强度；页面上找不到可去的地方时焦点回到「展开改动」
  {
    const api = fakeApi(() => undefined);
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const level = () => e.box.querySelector('[data-field-key="intensity.level"]');
    await click(segment(level() ?? e.box, '不填'));
    const toggle = () => e.box.querySelector<HTMLButtonElement>('.save-bar-toggle');
    const rows = () => all(e.box, '.save-changes .save-change');
    await click(toggle());
    const names = texts(e.box, '.save-changes .save-change');
    await click(rows()[1]);
    const landed = document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key');
    // 模拟页面上找不到：摘掉体力强度的 data-field-key（字段不重画，摘了就一直没有）
    level()?.removeAttribute('data-field-key');
    await click(toggle());
    await click(rows()[1]);
    eq(
      '清单「体力强度、最累的一段」：点不显示的最累的一段，焦点落进体力强度；找不到时清单收起、焦点回到「展开改动」',
      [names, landed, e.box.querySelectorAll('.save-changes').length, document.activeElement === toggle()],
      [['体力强度', '最累的一段'], 'intensity.level', 0, true],
    );
    await e.unmount();
    api.restore();
  }

  // 点过保存以后存上了：「点过保存」随之清掉，再清空一个必填字段，没离开它就不报、也没有汇总
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH' ? json({ ...GUIZHOU_ITEM, rev: 2, payload: { ...GUIZHOU_5D, ...(s.body as { set: Payload }).set } }) : undefined,
    );
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const titleIn = d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="title"] input');
    await typeInto(titleIn, '');
    await click(primary(d.box));
    await settle();
    const blocked = [api.patches().length, texts(d.box, '.detail-issues .ant-alert-title')];
    await typeInto(titleIn, '新名字');
    await click(primary(d.box));
    await until(() => bar(d.box) === null);
    await settle();
    await typeInto(titleIn, '');
    eq(
      '存上以后清空线路名称（没离开）：不报错、没有汇总；之前那次没过的保存照常拦下',
      [blocked, texts(d.box, '.detail-main .field-error'), d.box.querySelectorAll('.detail-issues').length],
      [[0, ['有1处要改']], [], 0],
    );
    await d.unmount();
    api.restore();
  }

  // 草稿：先按上架前检查查一遍，不合格不发请求，报错落到字段、顶部汇总、焦点到第一处；改好以后报错和汇总都消失
  {
    const api = fakeApi((s) => (s.method === 'PATCH' ? json({ ...GUIZHOU_ITEM, rev: 2, payload: GUIZHOU_5D }) : undefined));
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const titleIn = d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="title"] input');
    await typeInto(titleIn, '');
    const hotel3 = d.box.querySelector<HTMLInputElement>(
      '[data-field-key="itinerary"] [data-item-index="2"] [data-field-key="hotel"] input',
    );
    await typeInto(hotel3, '');
    eq(
      '草稿的保存条：说明与「保存草稿」（设计系统 G 页）',
      [barText(d.box)?.note, barText(d.box)?.buttons, barText(d.box)?.names],
      ['草稿保存后仍不会推荐给客户', ['放弃', '保存草稿'], '线路名称、第3天的当晚住宿'],
    );
    check('还没失焦、没点保存：字段下方不报错', d.box.querySelectorAll('.detail-main .field-error').length === 0);
    await click(primary(d.box));
    await settle();
    eq(
      '点「保存草稿」：不发请求；两处都报在字段下方，顶部「有2处要改」，焦点到第一处（线路名称）',
      [
        api.patches().length,
        errorAt(d.box, '[data-group="basic"] [data-field-key="title"]'),
        errorAt(d.box, '[data-field-key="itinerary"] [data-item-index="2"] [data-field-key="hotel"]'),
        texts(d.box, '.detail-issues .ant-alert-title'),
        document.activeElement === titleIn,
        titleIn?.getAttribute('aria-invalid'),
      ],
      [0, '线路名称：没填', '当晚住宿：没填', ['有2处要改'], true, 'true'],
    );
    await typeInto(titleIn, String(GUIZHOU_5D.title));
    eq(
      '填好线路名称：它的报错没了，汇总变成「有1处要改」',
      [errorAt(d.box, '[data-group="basic"] [data-field-key="title"]'), texts(d.box, '.detail-issues .ant-alert-title')],
      [null, ['有1处要改']],
    );
    await click(all(d.box, '.detail-issues button').find((b) => b.textContent?.replace(/\s/g, '') === '跳到第一处'));
    await settle();
    check('汇总的「跳到第一处」：焦点落进第3天的当晚住宿', document.activeElement === hotel3);
    await typeInto(hotel3, String((GUIZHOU_5D.itinerary as Payload[])[2]!.hotel));
    eq(
      '都改好：没有报错，也没有汇总',
      [d.box.querySelectorAll('.detail-main .field-error').length, d.box.querySelectorAll('.detail-issues').length],
      [0, 0],
    );
    await d.unmount();
    api.restore();
  }

  // 月份区间写了认不出的字再保存：控件自己的「没认出月份」只出现一次，汇总「有1处要改」，焦点进这个输入框，不发请求
  {
    const api = fakeApi(() => undefined);
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const seasonIn = d.box.querySelector<HTMLInputElement>('[data-field-key="bestSeason"] input');
    await typeInto(seasonIn, '夏天');
    await click(primary(d.box));
    await settle();
    eq(
      '月份区间认不出：字段下方只有「没认出月份…」一条，汇总「有1处要改」，焦点在输入框，没发请求',
      [
        texts(d.box, '[data-field-key="bestSeason"] .field-error'),
        texts(d.box, '.detail-issues .ant-alert-title'),
        document.activeElement === seasonIn,
        api.patches().length,
      ],
      [['没认出月份：写成「5月-10月」「11月-次年4月」或「全年」'], ['有1处要改'], true, 0],
    );
    await d.unmount();
    api.restore();
  }

  // 失焦记的是离开了的位置：行程亮点里离开第1条就报第1条；在一个字段的几个控件之间换焦点，这个字段不算离开
  {
    const api = fakeApi(() => undefined);
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const line = (i: number) => d.box.querySelector<HTMLInputElement>(`[data-field-key="highlights"] [data-item-index="${i}"] input`);
    await act(async () => line(0)?.focus());
    await typeInto(line(0), '');
    await act(async () => line(1)?.focus());
    const moved = texts(d.box, '[data-field-key="highlights"] .field-error');
    await typeInto(line(1), '');
    await act(async () => line(2)?.focus());
    await act(async () => line(1)?.focus());
    const back = texts(d.box, '[data-field-key="highlights"] .field-error');
    eq(
      '行程亮点里换一条：离开的那一条算碰过、报在它下面；回到第2条时它的报错不收',
      [moved, back],
      [['第1条：没填'], ['第1条：没填', '第2条：没填']],
    );
    // 多选片之间 Tab：焦点还在「适合客群」里，这个字段不算离开（清空了也先不报）
    const chips = all<HTMLButtonElement>(d.box, '[data-field-key="segments"] button');
    for (const c of chips.filter((b) => b.getAttribute('aria-pressed') === 'true')) await click(c);
    await act(async () => chips[0]?.focus());
    await act(async () => chips[1]?.focus());
    const within = texts(d.box, '[data-field-key="segments"] .field-error');
    await act(async () => d.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input')?.focus());
    eq(
      '多选片之间换焦点不算离开适合客群；离开以后才报',
      [within, texts(d.box, '[data-field-key="segments"] .field-error').length],
      [[], 1],
    );
    await d.unmount();
    api.restore();
  }

  // 只显示碰过的字段（验收 16）：新建里离开第一个字段，只有它报错；填了字出现保存条（第 10.3 步），必须项没填全时不发请求
  {
    const api = fakeApi(() => undefined);
    const n = await mountDetail('/catalog/new/route', owner(travel), { lists });
    const code = n.box.querySelector<HTMLInputElement>('[data-field-key="$code"] input');
    const dest = n.box.querySelector<HTMLInputElement>('[data-field-key="destination"] input');
    await act(async () => code?.focus());
    await act(async () => dest?.focus());
    eq(
      '新建：只碰过编号就离开，只有编号报错，别的空着的必填字段不报',
      [texts(n.box, '.detail-main .field-error'), code?.getAttribute('aria-invalid')],
      [['线路编号：没填'], 'true'],
    );
    await typeInto(dest, '云南');
    eq('新建里填了字：保存条写「还没保存」，不列改动', barText(n.box), {
      summary: '还没保存',
      names: undefined,
      note: '保存后是一条草稿，不会推荐给客户',
      buttons: ['放弃', '保存草稿'],
    });
    await cmdS();
    await settle();
    eq(
      '新建按 ⌘S、没选境内还是境外：不发请求，字段下方报「境内还是境外：没选」（验收 16）',
      [api.sent.filter((x) => x.method === 'POST').length, errorAt(n.box, '[data-field-key="overseas"]')],
      [0, '境内还是境外：没选'],
    );
    await n.unmount();
    api.restore();
  }

  // 服务端 422：issues 落到字段（有序子项里的子字段也是）、英文说明不照原样、落不到的进汇总；字段改过以后它的报错消失
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH'
        ? json(
            {
              error: 'invalid_item',
              detail: '条目不合格',
              issues: [
                { path: 'itinerary.1.hotel', message: '不能为空' },
                { path: 'intensity.hardest', message: 'Too big: expected string to have <=100 characters' },
                { path: '', message: 'Unrecognized key: "nope"' },
              ],
            },
            422,
          )
        : undefined,
    );
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const hardestIn = e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input');
    await typeInto(hardestIn, `${hardestText}；返程日早起`);
    await click(primary(e.box));
    await until(() => e.box.querySelector('.detail-issues') !== null);
    await settle();
    eq(
      '422：报在字段下方（第2天的当晚住宿、最累的一段），顶部「有3处要改」、落不到字段的一条、技术详情；焦点到第一处',
      [
        errorAt(e.box, '[data-field-key="intensity.hardest"]'),
        errorAt(e.box, '[data-field-key="itinerary"] [data-item-index="1"] [data-field-key="hotel"]'),
        texts(e.box, '.detail-issues .ant-alert-title'),
        texts(e.box, '.detail-issues-loose li'),
        e.box.querySelectorAll('.detail-issues .tech-details, .detail-issues details').length > 0,
        document.activeElement === hardestIn,
        // 服务端的英文原文只在折叠的技术详情里
        visibleText(e.box).includes('Too big') || visibleText(e.box).includes('Unrecognized'),
      ],
      ['最累的一段：格式不对', '当晚住宿：不能为空', ['有3处要改'], ['格式不对'], true, true, false],
    );
    await typeInto(hardestIn, `${hardestText}；返程`);
    eq(
      '改了最累的一段：它的报错消失，第2天的还在，汇总「有2处要改」',
      [
        errorAt(e.box, '[data-field-key="intensity.hardest"]'),
        errorAt(e.box, '[data-field-key="itinerary"] [data-item-index="1"] [data-field-key="hotel"]'),
        texts(e.box, '.detail-issues .ant-alert-title'),
      ],
      [null, '当晚住宿：不能为空', ['有2处要改']],
    );
    await e.unmount();
    api.restore();
  }

  // 422 里的问题全都落不到字段（路径为空）：只有页头下的汇总，焦点给它；409 横幅还在时再来一次 422，焦点同样给汇总
  {
    let reply: '422' | '409' = '422';
    const api = fakeApi((s) => {
      if (s.method !== 'PATCH') return undefined;
      if (reply === '409') return json({ error: 'rev_conflict', detail: '条目已被别人改过' }, 409);
      return json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: '', message: 'Unrecognized key: "legacyNote"' }] }, 422);
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const hardestIn = e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input');
    await typeInto(hardestIn, `${hardestText}；返程日早起`);
    await act(async () => hardestIn?.focus());
    await cmdS();
    await until(() => e.box.querySelector('.detail-issues') !== null);
    await settle();
    const summary = () => e.box.querySelector('.detail-issues');
    eq(
      '422 只有路径为空的一条：汇总「有1处要改」「格式不对」，焦点从输入框挪到汇总上；主按钮不再 loading',
      [
        texts(e.box, '.detail-issues .ant-alert-title'),
        texts(e.box, '.detail-issues-loose li'),
        document.activeElement === summary(),
        primary(e.box)?.classList.contains('ant-btn-loading'),
      ],
      [['有1处要改'], ['格式不对'], true, false],
    );
    reply = '409';
    await cmdS();
    await until(() => e.box.querySelector('.detail-conflict') !== null);
    await settle();
    const onBanner = document.activeElement === e.box.querySelector('.detail-conflict button');
    reply = '422';
    await cmdS();
    await until(() => api.patches().length === 3);
    await settle();
    eq(
      '409 之后又是这样的 422：横幅还在，焦点从「载入最新版本」挪到汇总上',
      [onBanner, document.activeElement === summary()],
      [true, true],
    );
    await e.unmount();
    api.restore();
  }

  // 422 落到有序子项里：单字段的逐条列表写在那一条下面并连到输入框；多字段的一项本身（天号）写在序号下面
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH'
        ? json(
            {
              error: 'invalid_item',
              detail: '条目不合格',
              issues: [
                { path: 'highlights.1', message: '不能为空' },
                { path: 'itinerary.2.day', message: '第3天的天号应为3' },
              ],
            },
            422,
          )
        : undefined,
    );
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), `${hardestText}；返程日早起`);
    await click(primary(e.box));
    await until(() => e.box.querySelector('.detail-issues') !== null);
    await settle();
    const line = e.box.querySelector('[data-field-key="highlights"] [data-item-index="1"]');
    const lineError = line?.querySelector('.field-error');
    const day3 = e.box.querySelector('[data-field-key="itinerary"] [data-item-index="2"]');
    const dayErrId = day3?.querySelector('.subitem-card > .field-error')?.id ?? '';
    const linked = all(day3 ?? e.box, '[data-field-key]').map((f) =>
      all(f, '[aria-describedby]').some((el) => el.getAttribute('aria-describedby')?.split(' ').includes(dayErrId)),
    );
    eq(
      '第3天本身的报错：第3天的每个子字段（当天标题、当天安排、当晚住宿、当天餐食）读屏都连上它',
      [dayErrId !== '', linked],
      [true, [true, true, true, true]],
    );
    eq(
      '422：「第2条：不能为空」写在行程亮点第2条下面、读屏连到那个输入框；「第3天的天号应为3」写在第3天的卡片顶上',
      [
        lineError?.textContent,
        !!lineError?.id && line?.querySelector('input')?.getAttribute('aria-describedby') === lineError.id,
        line?.querySelector('input')?.getAttribute('aria-invalid'),
        e.box.querySelectorAll('[data-field-key="highlights"] .field-error').length,
        day3?.querySelector('.subitem-card > .field-error')?.textContent,
        texts(e.box, '.detail-issues .ant-alert-title'),
      ],
      ['第2条：不能为空', true, 'true', 1, '第3天的天号应为3', ['有2处要改']],
    );
    await e.unmount();
    api.restore();
  }

  // 409：横幅「这条刚被别人改过」、「载入最新版本」；载入以后表单是最新的，你的改动以对比形式保留，「用我的改动」写回
  {
    const latest = {
      ...SICHUAN_ITEM,
      rev: 3,
      updatedByName: '老周',
      payload: { ...SICHUAN, hotelLevel: '别人改的档次', intensity: { ...(SICHUAN.intensity as Payload), hardest: '别人改的最累的一段' } },
    };
    let conflict = true;
    const api = fakeApi((s) => {
      if (s.method === 'PATCH')
        return conflict ? json({ error: 'rev_conflict', detail: '条目已被别人改过' }, 409) : json({ ...latest, rev: 4 });
      if (s.url.endsWith('/catalog/route/r-sichuan-lux')) return json(latest);
      return undefined;
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const mine = `${hardestText}；返程日早起`;
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), mine);
    // 后台重取把别人存的 rev 3 放进了缓存：表单不换，补丁仍带打开时的 rev 1，得到 409，不会拿旧内容盖掉别人的
    await act(async () => void e.qc.setQueryData(['catalog', 'route', 'r-sichuan-lux'], latest));
    await settle();
    await cmdS();
    await until(() => e.box.querySelector('.detail-conflict') !== null);
    await settle();
    eq('缓存里换成别人存的新版本以后保存：补丁仍带打开时的 rev 1', (api.patches()[0]?.body as { rev?: number } | undefined)?.rev, 1);
    check(
      '409：焦点从输入框挪到横幅的「载入最新版本」（表单多在首屏以下，横幅在页头下）',
      document.activeElement === e.box.querySelector('.detail-conflict button'),
    );
    eq(
      '409：danger 横幅「这条刚被别人改过」加「载入最新版本」；改动还在，保存条还在',
      [
        texts(e.box, '.detail-conflict .ant-alert-title'),
        texts(e.box, '.detail-conflict button').map((t) => t.replace(/\s/g, '')),
        e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input')?.value,
        barText(e.box)?.summary,
      ],
      [['这条刚被别人改过'], ['载入最新版本'], mine, '有1处改动'],
    );
    await click(e.box.querySelector('.detail-conflict button'));
    await until(() => e.box.querySelector('.detail-compare') !== null);
    await settle();
    check('载入最新版本：按钮随横幅没了，焦点落在对比卡的标题上', document.activeElement === e.box.querySelector('.detail-compare-title'));
    const hardestNow = () => e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input')?.value;
    eq(
      '载入最新版本：横幅没了，表单是最新的（别人改的两处），没有保存条；页头是最新的更新人',
      [
        e.box.querySelectorAll('.detail-conflict').length,
        hardestNow(),
        e.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input')?.value,
        bar(e.box) === null,
        header(e.box).status?.includes('老周更新于'),
      ],
      [0, '别人改的最累的一段', '别人改的档次', true, true],
    );
    eq(
      '对比：你改过的一个字段，最新版本与你改的并排，有「用我的改动」',
      [
        texts(e.box, '.detail-compare-label'),
        texts(e.box, '.detail-compare-cols .field-value'),
        texts(e.box, '.detail-compare-use').map((t) => t.replace(/\s/g, '')),
      ],
      [['最累的一段'], ['别人改的最累的一段', mine], ['用我的改动']],
    );
    // 你的改动这时只在对比里、不在表单里：离开照样先确认（不变量 20）
    await act(async () => {
      void e.router.navigate({ to: '/catalog/$kind', params: { kind: 'route' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    eq(
      '载入最新版本以后，改动只留在对比里：站内跳转照样被拦下',
      [document.body.textContent?.includes('有改动还没保存'), e.router.state.location.pathname],
      [true, '/catalog/route/r-sichuan-lux'],
    );
    await click(all<HTMLButtonElement>(document.body, 'button').find((b) => b.textContent === '留下'));
    await settle();
    await click(e.box.querySelector('.detail-compare-use'));
    eq(
      '用我的改动：写回表单，标「已改」，出现保存条，按钮收起；这是最后一个，焦点回到对比卡的标题',
      [
        hardestNow(),
        all(e.box, '.field.is-changed').map((f) => f.getAttribute('data-field-key')),
        barText(e.box)?.summary,
        e.box.querySelectorAll('.detail-compare-use').length,
        document.activeElement === e.box.querySelector('.detail-compare-title'),
      ],
      [mine, ['intensity.hardest'], '有1处改动', 0, true],
    );
    conflict = false;
    await click(primary(e.box));
    await until(() => api.patches().length > 1);
    eq('再保存：带最新的 rev 3，只提交你的改动', api.patches()[1]?.body, {
      rev: 3,
      set: { intensity: { ...(latest.payload.intensity as Payload), hardest: mine } },
    });
    await click(e.box.querySelector('.detail-compare-close'));
    await settle();
    eq(
      '关闭对比（改动都用回了）：不用确认；焦点不掉到 body',
      [
        e.box.querySelectorAll('.detail-compare').length,
        texts(document.body, '.ant-modal-title').filter((t) => t.startsWith('放弃')),
        document.activeElement !== document.body,
      ],
      [0, [], true],
    );
    await e.unmount();
    api.restore();
  }

  // 409 之后的对比卡：两处改动时「用我的改动」把焦点交给下一个；还有没用回的改动时「关闭对比」先确认，
  // 确认框开着按 ⌘S 不存；放弃以后对比卡没了、离开不再拦，焦点不掉到 body
  {
    const latest = {
      ...SICHUAN_ITEM,
      rev: 3,
      updatedByName: '老周',
      payload: { ...SICHUAN, hotelLevel: '别人改的档次', intensity: { ...(SICHUAN.intensity as Payload), hardest: '别人改的最累的一段' } },
    };
    const api = fakeApi((s) => {
      if (s.method === 'PATCH') return json({ error: 'rev_conflict', detail: '条目已被别人改过' }, 409);
      if (s.url.endsWith('/catalog/route/r-sichuan-lux')) return json(latest);
      return undefined;
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), `${hardestText}；返程日早起`);
    await typeInto(e.box.querySelector('[data-field-key="hotelLevel"] input'), '我改的档次');
    await click(primary(e.box));
    await until(() => e.box.querySelector('.detail-conflict') !== null);
    await click(e.box.querySelector('.detail-conflict button'));
    await until(() => e.box.querySelector('.detail-compare') !== null);
    await settle();
    const uses = () => all<HTMLButtonElement>(e.box, '.detail-compare-use');
    const second = uses()[1];
    const labelOf = (b: Element | undefined) => document.getElementById(b?.getAttribute('aria-describedby') ?? '')?.textContent;
    eq(
      '对比两处：每个「用我的改动」读屏连上这一行的字段名',
      [uses().length, labelOf(uses()[0]), labelOf(second)],
      [2, ...texts(e.box, '.detail-compare-label')],
    );
    await click(uses()[0]);
    eq('用了第一处：按钮收起，焦点挪到下一个「用我的改动」', [uses().length, document.activeElement === second], [1, true]);
    await click(e.box.querySelector('.detail-compare-close'));
    await settle();
    const modalTitle = () => texts(document.body, '.ant-modal-title');
    eq('还有1处没用回时关闭对比：先确认「放弃这1处改动？」', modalTitle(), ['放弃这1处改动？']);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await cmdS();
    eq('关闭对比的确认开着时按 ⌘S：不拦、不发 PATCH', [cmdSPrevented, api.patches().length], [false, 1]);
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '保留'));
    await settle();
    eq('「保留」：对比卡还在，那一处还能用回', [e.box.querySelectorAll('.detail-compare').length, uses().length], [1, 1]);
    // 撤销用回的那一处：表单回到最新版本，没用回的改动只剩对比里的两处
    await click(e.box.querySelector('.field.is-changed .field-undo'));
    await click(e.box.querySelector('.detail-compare-close'));
    await settle();
    eq('撤销以后再关：确认「放弃这2处改动？」', modalTitle(), ['放弃这2处改动？']);
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃改动'));
    await settle();
    eq(
      '「放弃改动」：对比卡没了，焦点不掉到 body',
      [e.box.querySelectorAll('.detail-compare').length, document.activeElement !== document.body && document.activeElement?.isConnected],
      [0, true],
    );
    await act(async () => {
      void e.router.navigate({ to: '/catalog/$kind', params: { kind: 'route' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    eq('放弃了对比里的改动、表单没改：离开不再拦', e.router.state.location.pathname, '/catalog/route');
    await e.unmount();
    api.restore();
  }

  // 载入最新版本也会失败：详情页不换成整页的出错态（查询带上了错误，可这一条已经有了），改动还在；
  // Alert「服务暂时连不上」加重试，焦点落在「重试」上；重试载入以后照常是对比卡、焦点在它的标题
  {
    let down = true;
    const latest = { ...SICHUAN_ITEM, rev: 3, payload: { ...SICHUAN, hotelLevel: '别人改的档次' } };
    const api = fakeApi((s) => {
      if (s.method === 'PATCH') return json({ error: 'rev_conflict', detail: '条目已被别人改过' }, 409);
      if (s.url.endsWith('/catalog/route/r-sichuan-lux'))
        return down ? (Promise.reject(new TypeError('Failed to fetch')) as unknown as Response) : json(latest);
      return undefined;
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="hotelLevel"] input'), '我改的档次');
    await cmdS();
    await until(() => e.box.querySelector('.detail-conflict') !== null);
    await click(e.box.querySelector('.detail-conflict button'));
    await until(() => texts(e.box, '.detail-failure .ant-alert-title').some((t) => t.startsWith('服务暂时连不上')));
    await settle();
    const retry = all<HTMLButtonElement>(e.box, '.detail-failure button').find((b) => b.textContent?.replace(/\s/g, '') === '重试');
    eq(
      '载入最新版本连不上：详情页还在（不换成整页出错），改动与保存条都在，横幅还在；焦点落在「重试」上',
      [
        e.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input')?.value,
        barText(e.box)?.summary,
        e.box.querySelectorAll('.detail-conflict').length,
        retry !== undefined && document.activeElement === retry,
      ],
      ['我改的档次', '有1处改动', 1, true],
    );
    down = false;
    await click(retry);
    await until(() => e.box.querySelector('.detail-compare') !== null);
    await settle();
    eq(
      '重试载入：Alert 没了，对比卡出现，焦点在它的标题上',
      [e.box.querySelectorAll('.detail-failure').length, document.activeElement === e.box.querySelector('.detail-compare-title')],
      [0, true],
    );
    await e.unmount();
    api.restore();
  }

  // 422 locked_field：页内 Alert 用中文字段名；连不上：「服务暂时连不上」加重试，重试再发一次
  {
    let reply: 'locked' | 'down' | 'ok' = 'locked';
    const api = fakeApi((s) => {
      if (s.method !== 'PATCH') return undefined;
      if (reply === 'down') return Promise.reject(new TypeError('Failed to fetch')) as unknown as Response;
      if (reply === 'ok') return json({ ...SICHUAN_ITEM, rev: 2, payload: { ...SICHUAN, ...(s.body as { set: Payload }).set } });
      return json({ error: 'locked_field', detail: '这些字段已锁定，不能改：title、tags:国内', fields: ['title', 'tags:国内'] }, 422);
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), `${hardestText}；返程日早起`);
    await click(primary(e.box));
    await until(() => e.box.querySelector('.detail-alerts .ant-alert') !== null);
    await settle();
    eq(
      'locked_field：「这些内容上架后锁定了：线路名称、标签里的「国内」」；Alert 没有按钮，焦点落在它上面',
      [texts(e.box, '.detail-alerts .ant-alert-title'), document.activeElement === e.box.querySelector('.detail-failure .ant-alert')],
      [['这些内容上架后锁定了：线路名称、标签里的「国内」'], true],
    );
    reply = 'down';
    await click(primary(e.box));
    await until(() => texts(e.box, '.detail-alerts .ant-alert-title').some((t) => t.startsWith('服务暂时连不上')));
    await settle();
    const retry = all<HTMLButtonElement>(e.box, '.detail-alerts button').find((b) => b.textContent?.replace(/\s/g, '') === '重试');
    check('连不上：焦点落在「重试」上', retry !== undefined && document.activeElement === retry);
    const before = api.patches().length;
    await click(retry);
    await until(() => api.patches().length > before);
    eq('连不上：「服务暂时连不上」加重试，重试再发一次 PATCH', [retry !== undefined, api.patches().length - before], [true, 1]);
    await settle();
    reply = 'ok';
    await click(all<HTMLButtonElement>(e.box, '.detail-alerts button').find((b) => b.textContent?.replace(/\s/g, '') === '重试'));
    await until(() => bar(e.box) === null);
    await settle();
    eq(
      '再重试存上了：「服务暂时连不上」收起，页头下什么也没有，保存条消失',
      [e.box.querySelectorAll('.detail-failure').length, e.box.querySelectorAll('.detail-alerts').length, bar(e.box) === null],
      [0, 0, true],
    );
    await e.unmount();
    api.restore();
  }

  // 放弃：先确认（默认焦点「保留」）；放弃以后回到上次保存的内容，保存条消失，焦点不掉到 body
  {
    const api = fakeApi(() => undefined);
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const hardestIn = e.box.querySelector<HTMLInputElement>('[data-field-key="intensity.hardest"] input');
    await typeInto(hardestIn, `${hardestText}；返程日早起`);
    await act(async () => hardestIn?.focus());
    await click(all(e.box, '.action-bar button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃'));
    await settle();
    const dialog = () => document.querySelector('.ant-modal');
    eq('放弃：先确认「放弃这1处改动？」', dialog()?.querySelector('.ant-modal-title')?.textContent, '放弃这1处改动？');
    // 确认框开着时按 ⌘S（焦点哪怕不在框里）：不把正要放弃的改动存上，确认框还在
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await cmdS();
    eq(
      '放弃确认开着时按 ⌘S：不拦、不发 PATCH，确认框还是「放弃这1处改动？」',
      [cmdSPrevented, api.patches().length, dialog()?.querySelector('.ant-modal-title')?.textContent],
      [false, 0, '放弃这1处改动？'],
    );
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '保留'));
    await settle();
    eq('「保留」：改动还在', [hardestIn?.value, barText(e.box)?.summary], [`${hardestText}；返程日早起`, '有1处改动']);
    await click(all(e.box, '.action-bar button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃'));
    await settle();
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃改动'));
    await settle();
    eq(
      '「放弃改动」：回到原文，没有保存条、没有「已改」，焦点回到刚才的字段，没发请求',
      [
        hardestIn?.value,
        bar(e.box) === null,
        e.box.querySelectorAll('.field.is-changed').length,
        document.activeElement === hardestIn,
        api.patches().length,
      ],
      [hardestText, true, 0, true, 0],
    );
    await e.unmount();
    api.restore();
  }

  // 422 之后放弃：服务端报在没改过的住宿档次下的那一条随之收起，「点过保存」也清掉：再清空住宿档次，没离开就不报
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH'
        ? json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: 'hotelLevel', message: '含有存不下的字符' }] }, 422)
        : undefined,
    );
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), `${hardestText}；返程日早起`);
    await click(primary(e.box));
    await until(() => e.box.querySelector('.detail-issues') !== null);
    await settle();
    const shown = errorAt(e.box, '[data-field-key="hotelLevel"]');
    await click(all(e.box, '.action-bar button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃'));
    await settle();
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃改动'));
    await settle();
    const afterDiscard = [errorAt(e.box, '[data-field-key="hotelLevel"]'), e.box.querySelectorAll('.detail-issues').length];
    await typeInto(e.box.querySelector('[data-field-key="hotelLevel"] input'), '');
    eq(
      '422 报在住宿档次下；放弃以后它收起、没有汇总；再清空住宿档次（没离开）也不报',
      [shown, afterDiscard, texts(e.box, '.detail-main .field-error'), e.box.querySelectorAll('.detail-issues').length],
      ['住宿档次：含有存不下的字符', [null, 0], [], 0],
    );
    await e.unmount();
    api.restore();
  }

  // 非编辑成员：改不了，没有保存条，⌘S 不拦也不发
  {
    const api = fakeApi(() => undefined);
    const a = await mountDetail('/catalog/route/r-sichuan-lux', agent(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await cmdS();
    eq('非编辑成员：没有保存条，⌘S 不拦浏览器、不发请求', [bar(a.box) === null, cmdSPrevented, api.patches().length], [true, false, 0]);
    await a.unmount();
    api.restore();
  }

  // 假包：保存条的名字来自装修套餐的配置，补丁发到 /catalog/package/…
  {
    const pkItem = { kind: 'package', ord: 0, rev: 1, ...PKG_ROWS.find((r) => r.code === 'p-nuanmu-2r')! };
    const api = fakeApi((s) => (s.method === 'PATCH' ? json({ ...pkItem, rev: 2 }) : undefined));
    const pk = await mountDetail('/catalog/package/p-nuanmu-2r', owner(renovationLPage), {
      items: { 'package/p-nuanmu-2r': pkItem },
      lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
    });
    await typeInto(
      pk.box.querySelector('[data-field-key="nodes"] [data-item-index="2"] [data-field-key="checkpoints"] textarea'),
      '改过的验收要点',
    );
    eq(
      '假包：「有1处改动」「第3个节点的验收要点」',
      [barText(pk.box)?.summary, barText(pk.box)?.names],
      ['有1处改动', '第3个节点的验收要点'],
    );
    await click(primary(pk.box));
    await until(() => api.patches().length > 0);
    check(
      '假包：PATCH 发到 /catalog/package/p-nuanmu-2r',
      api.patches()[0]?.url.endsWith('/api/console/catalog/package/p-nuanmu-2r') === true,
    );
    await pk.unmount();
    api.restore();
  }

  // 验收 16：20 条线路、23 家酒店逐一打开、不做改动：保存条不出现，没有 PATCH
  {
    const api = fakeApi(() => undefined);
    const opened: string[] = [];
    for (const [kind, rows] of [
      ['route', ROUTE_ROWS.filter((r) => ROUTES.some((x) => x.id === r.code))],
      ['hotel', HOTEL_ROWS],
    ] as const) {
      for (const r of rows) {
        const it = { kind, ord: 0, rev: 1, status: 'active', ...r };
        const m = await mountDetail(`/catalog/${kind}/${r.code}`, owner(travel), { items: { [`${kind}/${r.code}`]: it }, lists });
        await cmdS();
        if (bar(m.box) !== null) opened.push(r.code);
        await m.unmount();
      }
    }
    eq('逐一打开 20 条线路、23 家酒店不改：没有保存条，⌘S 也不发 PATCH', [opened, api.patches().length], [[], 0]);
    api.restore();
  }
  // ---------------- 11. 上架、复制为新草稿、预览、新建（plan 第 10.3 步） ----------------
  // spec「产品库详情与编辑」的上架、复制为新草稿、「预览」页签、新建（验收 16 第四条、验收 17），设计系统 §5.14、F 页。
  // 纯逻辑在 catalog/actions.ts；整页照上面挂真的路由、查询缓存和按方法与地址回应的假接口

  // 11.1 纯逻辑
  {
    const byName: RefName = (f, v) =>
      f.store === 'label' ? v : (resolveRef(f, v, f.to === 'material' ? MATERIAL_REFS : HOTEL_REFS)?.name ?? v);
    eq(
      '页签：匿名默认「预览」，别人默认「编辑」；地址上只写不是默认的那一个',
      [
        defaultTab(true),
        defaultTab(false),
        tabOf({}, true),
        tabOf({}, false),
        tabOf({ tab: 'edit' }, true),
        tabOf({ tab: 'preview' }, false),
        tabSearch('preview', true),
        tabSearch('edit', true),
        tabSearch('preview', false),
        tabSearch('edit', false),
      ],
      ['preview', 'edit', 'preview', 'edit', 'edit', 'preview', {}, { tab: 'edit' }, { tab: 'preview' }, {}],
    );
    const vt = (e: EntityType, key: string, p: Payload) => valueText(fieldOf(e, key), readValue(p, key), p, byName);
    const inc = (GUIZHOU_5D.inclusions as unknown[]).length;
    const exc = (GUIZHOU_5D.exclusions as unknown[]).length;
    eq(
      '值写成一段字：金额带单位（单位取另一个字段的照写）、整数带单位、月份区间加含义、「全年」写 yearRoundLabel、多选与标签用「、」、是否写两种文字、有序子项写条数、引用写名称、没填是 null',
      [
        vt(ROUTE, 'priceFrom', GUIZHOU_5D),
        vt(MATERIAL, 'unitPrice', MATERIALS[2]!),
        vt(ROUTE, 'days', GUIZHOU_5D),
        vt(ROUTE, 'maxAltitude', GUIZHOU_5D),
        vt(ROUTE, 'bestSeason', GUIZHOU_5D),
        vt(ROUTE, 'bestSeason', { bestSeason: '全年' }),
        vt(ROUTE, 'bestSeason', { bestSeason: '夏天' }),
        vt(PKG, 'startMonths', { startMonths: '全年' }),
        vt(ROUTE, 'segments', GUIZHOU_5D),
        vt(ROUTE, 'aliases', GUIZHOU_5D),
        vt(ROUTE, 'overseas', GUIZHOU_5D),
        vt(ROUTE, 'overseas', { overseas: true }),
        vt(ROUTE, 'inclusions', GUIZHOU_5D),
        vt(PKG, 'materials', NUANMU),
        vt(ROUTE, 'intensity.level', { intensity: { level: '适中' } }),
        vt(MATERIAL, 'category', MATERIALS[0]!),
        vt(ROUTE, 'maxAltitude', {}),
        vt(ROUTE, 'tags', { tags: [] }),
        vt(ROUTE, '$code', GUIZHOU_5D),
      ],
      [
        '13,800元/人',
        '2,680元/延米',
        '5天',
        '1,200米',
        '4月-10月（这些月份出发报价上浮10%，「全年」不加价）',
        '全年（不加价）',
        '夏天',
        '全年',
        '家庭、亲子、银发',
        '黔东南',
        '境内',
        '境外',
        `${inc}条`,
        '马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装',
        '适中',
        '瓷砖',
        null,
        null,
        'r-guizhou-5d',
      ],
    );
    const days = fieldOf(ROUTE, 'itinerary').item!;
    const sub = (k: string) => days.find((s) => s.key === k)!;
    eq(
      '有序子项里的字段：按字符串存的餐食写原文，按名称存的住宿写原文',
      [valueText(sub('meals'), '早/午/晚', {}, byName), valueText(sub('hotel'), '松赞梅里', {}, byName)],
      ['早/午/晚', '松赞梅里'],
    );
    eq(
      '上架确认的第一句：值按类型写，单位固定的金额只写斜线前面的，占位两侧的空格去掉，句末补句号（设计系统 F 页）',
      [
        activateSentence(ROUTE, GUIZHOU_5D, byName),
        activateSentence(PKG, NUANMU, byName),
        activateSentence(MATERIAL, MATERIALS[0]!, byName),
        activateSentence({ ...ROUTE, activateLine: '上架后按 {priceFrom} 报价。' }, GUIZHOU_5D, byName),
        activateSentence(ROUTE, {}, byName),
      ],
      [
        '上架后，销售助手会立即向客户推荐这条线路，并按每人13,800元起报价。',
        '上架后，销售助手会向业主推荐这个套餐，并按每平米1,280元估价。',
        '上架后，套餐和销售助手可以引用这件主材，按168元/㎡计价。',
        '上架后按13,800元报价。',
        '上架后，销售助手会立即向客户推荐这条线路，并按每人—起报价。',
      ],
    );
    /** 一行写成「Tag：字段 值 · 字段 值」 */
    const lineText = (l: LockLine) =>
      `${l.tag}：${l.pairs.map((p) => `${p.label === null ? '' : `${p.label} `}${p.value}${p.empty ? '（空）' : ''}${p.mono ? '（等宽）' : ''}`).join(' · ')}`;
    eq(
      '锁定清单：按锁定组分行，行里按字段顺序；编号等宽；是否只写值；只锁几个成员的标签写这几个有没有（设计系统 F 页）',
      lockLines(ROUTE, GUIZHOU_5D, byName).map(lineText),
      [
        '识别：线路编号 r-guizhou-5d（等宽） · 线路名称 贵州 小七孔·西江千户苗寨 5 日 · 目的地 贵州 · 天数 5天 · 客户的其他叫法 黔东南',
        '计价：每人起价 13,800元/人 · 最佳季节 4月-10月（这些月份出发报价上浮10%，「全年」不加价）',
        `条款：费用包含 ${inc}条 · 费用不含 ${exc}条`,
        '推荐：境内 · 适合客群 家庭、亲子、银发 · 全程最高海拔 1,200米 · 标签 「国内」',
      ],
    );
    const bare = { ...GUIZHOU_5D, tags: ['贵州'] } as Payload;
    delete bare.aliases;
    delete bare.maxAltitude;
    eq(
      '锁定清单：没填的写「没填」（上架以后补不上了），标签里没有锁住的成员写「没有「国内」」',
      lockLines(ROUTE, bare, byName)
        .map(lineText)
        .filter((t) => t.startsWith('识别') || t.startsWith('推荐')),
      [
        '识别：线路编号 r-guizhou-5d（等宽） · 线路名称 贵州 小七孔·西江千户苗寨 5 日 · 目的地 贵州 · 天数 5天 · 客户的其他叫法 没填（空）',
        '推荐：境内 · 适合客群 家庭、亲子、银发 · 全程最高海拔 没填（空） · 标签 没有「国内」',
      ],
    );
    eq(
      '假包：套餐的锁定清单按它的锁定组；主材的编号没有锁定组，归到最后一行「其他」',
      [lockLines(PKG, NUANMU, byName).map(lineText), lockLines(MATERIAL, MATERIALS[0]!, byName).map(lineText)],
      [
        [
          '识别：套餐编号 p-nuanmu-2r（等宽） · 套餐名称 暖木 · 两居全包经典版',
          '计价：每平米单价 1,280元/㎡ · 起装面积 60㎡',
          '条款：工期 75天 · 含拆旧 · 包含主材 马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装',
          '推荐：适用户型 两居、三居',
        ],
        ['计价：计价单位 ㎡ · 单价 168元/㎡', '其他：主材编号 m-marcopolo-800（等宽）'],
      ],
    );
    eq(
      '后加的含软装（活的假包）：随条款组进锁定清单，填了「否」写「含软装 否」',
      lockLines(LIVE_PKG, NUANMU, byName).map(lineText)[2],
      '条款：工期 75天 · 含拆旧 · 含软装 否 · 包含主材 马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装',
    );
    // showWhen 没显示出来的锁定字段不在清单里（上架时它会被删掉）
    const toy: EntityType = {
      ...MATERIAL,
      lockGroups: { x: { tag: '甲组', reason: '原因' } },
      fields: [
        { key: '$code', type: 'text', label: '编号', group: 'basic', lockGroup: 'x' },
        { key: 'a', type: 'enum', options: ['有'], required: false, label: '开关', group: 'basic' },
        {
          key: 'b',
          type: 'text',
          label: '跟着开关',
          group: 'basic',
          lockedWhenActive: true,
          lockGroup: 'x',
          showWhen: { key: 'a', filled: true },
        },
      ],
    };
    eq(
      '锁定清单：showWhen 没显示出来的字段不列',
      [lockLines(toy, { id: 'c1', b: '值' }, byName).map(lineText), lockLines(toy, { id: 'c1', a: '有', b: '值' }, byName).map(lineText)],
      [['甲组：编号 c1（等宽）'], ['甲组：编号 c1（等宽） · 跟着开关 值']],
    );
    eq(
      '没做的建议一句：「有1条建议没做：体力强度没填（不拦上架）」；都做了没有这一句',
      [recommendLine(checkItem(ROUTE, GUIZHOU_5D).recommended), recommendLine([])],
      ['有1条建议没做：体力强度没填（不拦上架）', null],
    );
    eq(
      '复制的新编号：没填、格式不对、和原来的一样、列表里已经有了；都没有是 null',
      [
        codeProblem('', 'r-a', []),
        codeProblem('R_A', 'r-a', []),
        codeProblem(`r${'a'.repeat(64)}`, 'r-a', []),
        codeProblem('r-a', 'r-a', []),
        codeProblem('r-b', 'r-a', ['r-c', 'r-b']),
        codeProblem('r-b', 'r-a', ['r-c']),
      ],
      ['没填', CODE_RULE, CODE_RULE, '和原来的编号一样，换一个', '这个编号已经有了，换一个', null],
    );
    const copied = copyPayload(SICHUAN, 'r-sichuan-lux-kids');
    eq(
      '复制出来的 payload：只换编号，键序与其余内容一个字节不动，原条目不改',
      [
        JSON.stringify(copied) === JSON.stringify({ ...SICHUAN, id: 'r-sichuan-lux-kids' }),
        JSON.stringify(Object.keys(copied)) === JSON.stringify(Object.keys(SICHUAN)),
        SICHUAN.id,
      ],
      [true, true, 'r-sichuan-lux'],
    );
    const pkgCode = fieldOf(withCodeHints(PKG), '$code');
    eq(
      '新建的编号：行业包没写帮助、示例时补上格式说明与 codeExample；写了的原样；什么都不缺时就是原来的实体',
      [
        [pkgCode.help, pkgCode.placeholder],
        fieldOf(withCodeHints(HOTEL), '$code').placeholder,
        withCodeHints(ROUTE) === ROUTE,
        withCodeHints(PKG)
          .fields.filter((f, i) => f !== PKG.fields[i])
          .map((f) => f.key),
      ],
      [[CODE_HELP, '例：p-nuanmu-2r'], '例：h-songtsam-meili', true, ['$code']],
    );
    eq(
      '新建的空表单：只有必填的数组字段先放空数组（数组的必填只要求键存在）；选填的、按字符串存的、showWhen 管着的不放',
      [blankPayload(ROUTE), blankPayload(HOTEL), Object.keys(blankPayload(PKG)), blankPayload(MATERIAL)],
      [
        { segments: [], itinerary: [], highlights: [], tags: [] },
        { highlights: [], tags: [] },
        ['houseTypes', 'styles', 'materials', 'nodes', 'highlights'],
        {},
      ],
    );
    eq(
      '后加的规格是必填的数组：新建主材的空表单先放空数组；选填的含软装不放',
      [blankPayload(LIVE_MATERIAL), Object.keys(blankPayload(LIVE_PKG))],
      [{ specs: [] }, ['houseTypes', 'styles', 'materials', 'nodes', 'highlights']],
    );
    eq(
      '新建的空表单：showWhen 管着的数组字段不放（它随条件出现）',
      blankPayload({
        ...MATERIAL,
        fields: [
          ...MATERIAL.fields,
          { key: 'extras', type: 'tags', label: '附加', group: 'basic', showWhen: { key: 'ecoGrade', filled: true } },
        ],
      }),
      {},
    );
    eq(
      '一个标签都没有的新酒店：空表单里标签不报「没填」',
      checkItem(HOTEL, blankPayload(HOTEL)).required.some((i) => i.path === 'tags'),
      false,
    );
    eq(
      '新建提交的键按字段顺序（编号在最前），行业包里没有的排最后',
      Object.keys(inFieldOrder(HOTEL, { tags: [], extra: 1, name: '某酒店', highlights: ['好'], id: 'h-new' })),
      ['id', 'name', 'highlights', 'tags', 'extra'],
    );
    eq(
      '新建的保存条：「还没保存」「保存后是一条草稿，不会推荐给客户」「保存草稿」；别的照旧',
      [saveSummary('new', []), saveCopy('new'), saveSummary('draft', []), saveSummary('active', [{ path: 'a', label: '甲' }])],
      ['还没保存', { note: '保存后是一条草稿，不会推荐给客户', button: '保存草稿' }, '有改动', '有1处改动'],
    );
    eq(
      '没做的建议有两条：一句里用「、」连起来',
      recommendLine([
        { path: 'intensity.level', label: '体力强度', message: '没填' },
        { path: 'highlights', label: '行程亮点', message: '建议3–5条' },
      ]),
      '有2条建议没做：体力强度没填、行程亮点建议3–5条（不拦上架）',
    );
    // 有序子项的增删（评审之后从第 11 步提前：旧抽屉删了，新建线路要能加逐日行程才存得上）
    const itin = fieldOf(ROUTE, 'itinerary');
    const nodes = fieldOf(PKG, 'nodes');
    eq(
      '「添加一{itemNoun}」加的一项：自动编号写上序号；必填的数组子字段先放空数组，选填的不放；单字段的是空串',
      [
        blankItem(itin, 3),
        blankItem(nodes, 1),
        blankItem({ ...nodes, item: nodes.item!.map((x) => ({ ...x, required: undefined })) }, 1),
        blankItem(fieldOf(ROUTE, 'highlights'), 2),
      ],
      [{ day: 3 }, {}, { materials: [] }, ''],
    );
    const four = (GUIZHOU_5D.itinerary as Payload[]).filter((_, i) => i !== 1);
    const re = renumber(itin, four);
    eq(
      '删掉第2天以后重排天号：按位置 1–4，别的子字段不动，编号本来就对的一项原样共用；没有自动编号的一项都不动',
      [
        re.map((x) => (x as Payload).day),
        re.map((x) => (x as Payload).title),
        re[0] === four[0],
        re[1] === four[1],
        Object.keys(re[1] as Payload),
        renumber(nodes, [{ name: '乙' }, { name: '甲' }]),
      ],
      [[1, 2, 3, 4], four.map((x) => x.title), true, false, ['day', 'title', 'detail', 'hotel', 'meals'], [{ name: '乙' }, { name: '甲' }]],
    );
    eq(
      '一项按行业包的顺序排键：自动编号在前，子字段按 item 的顺序，行业包里没有的排最后',
      Object.keys(itemInOrder(itin, { meals: '早', extra: 1, title: '到达', day: 1, hotel: '某酒店' })),
      ['day', 'title', 'hotel', 'meals', 'extra'],
    );
    eq(
      '条数随天数锁定：只在天数上架后锁定时（已上架、能编辑）；草稿、新建、没有编辑权限、没有 countFrom 的都不算',
      [
        countLocked(ROUTE, itin, { status: 'active', canEdit: true }),
        countLocked(ROUTE, itin, { status: 'draft', canEdit: true }),
        countLocked(ROUTE, itin, { status: 'new', canEdit: true }),
        countLocked(ROUTE, itin, { status: 'active', canEdit: false }),
        countLocked(PKG, nodes, { status: 'active', canEdit: true }),
        countLocked({ ...ROUTE, fields: ROUTE.fields.filter((f) => f.key !== 'days') }, itin, { status: 'active', canEdit: true }),
      ],
      [true, false, false, false, false, false],
    );
  }

  // 11.2 整页要的几样
  const actionsOf = (root: ParentNode) =>
    all<HTMLElement>(root, '.page-actions button').map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').replace(/\s/g, ''));
  const activateButton = (root: ParentNode) =>
    all<HTMLButtonElement>(root, '.page-actions button').find((b) => b.textContent?.replace(/\s/g, '') === '上架…');
  const dialogTitled = (start: string) =>
    all<HTMLElement>(document.body, '.ant-modal').find((m) => m.querySelector('.ant-modal-title')?.textContent?.startsWith(start));
  const buttonIn = (root: ParentNode | undefined, text: string) =>
    root ? all<HTMLButtonElement>(root, 'button').find((b) => b.textContent?.replace(/\s/g, '') === text) : undefined;
  const live = (root: ParentNode) => root.querySelector('.save-live')?.textContent;
  const posts = (sent: readonly { method: string; url: string; body: unknown }[], tail: string) =>
    sent.filter((x) => x.method === 'POST' && x.url.endsWith(tail));
  const writes = (sent: readonly { method: string; url: string; body: unknown }[]) => sent.filter((x) => x.method !== 'GET');
  const activeGuizhou = (rev: number, payload: Payload = GUIZHOU_5D) => ({
    ...GUIZHOU_ITEM,
    status: 'active',
    rev,
    updatedByName: '小林',
    updatedAt: new Date(Date.now()).toISOString(),
    payload,
  });
  const onTitle = () => document.activeElement?.classList.contains('page-title') === true;
  const tabClick = (root: ParentNode, name: string) =>
    click(all<HTMLElement>(root, '.detail-tabs .ant-tabs-tab-btn').find((t) => t.textContent === name));
  /**
   * 弹窗的进出场动画走完：happy-dom 不跑动画，rc-motion 一直等着。先让 requestAnimationFrame 跑到动画开始，再发结束事件：
   * 打开时 afterOpenChange 才会调（默认焦点），关上时弹窗才卸掉（destroyOnHidden）
   */
  const motion = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await win.happyDOM.waitUntilComplete();
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    await act(async () => {
      for (const el of document.querySelectorAll('.ant-modal, .ant-modal-mask')) {
        for (const t of ['animationend', 'transitionend']) el.dispatchEvent(new win.Event(t) as unknown as Event);
      }
    });
  };

  // 11.3 上架（验收 17）：草稿的页头、确认框的内容、取消、确认以后的页面
  {
    // 上架以后列表再取，这一条就是已上架
    let activated = false;
    const api = fakeApi((s) => {
      if (s.method === 'POST' && s.url.endsWith('/activate')) {
        activated = true;
        return json(activeGuizhou((s.body as { rev: number }).rev + 1));
      }
      if (s.method === 'GET' && s.url.endsWith('/catalog/route') && activated)
        return json({ items: ROUTE_ROWS.map((r) => (r.code === 'r-guizhou-5d' ? { ...r, status: 'active' } : r)) });
      return undefined;
    });
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    eq(
      '草稿页头：「更多」在左、主按钮「上架…」在最右；页签「编辑 / 预览」，选中「编辑」',
      [actionsOf(d.box), texts(d.box, '.detail-tabs .ant-tabs-tab'), d.box.querySelector('.detail-tabs .ant-tabs-tab-active')?.textContent],
      [['更多', '上架…'], ['编辑', '预览'], '编辑'],
    );
    // 浏览器里点按钮会把焦点放上去（happy-dom 的 click() 不会）：关上以后焦点回到打开它的元素
    await act(async () => activateButton(d.box)?.focus());
    await click(activateButton(d.box));
    await motion();
    const dlg = dialogTitled('上架');
    const inc = (GUIZHOU_5D.inclusions as unknown[]).length;
    const exc = (GUIZHOU_5D.exclusions as unknown[]).length;
    eq(
      '上架确认（设计系统 F 页）：640 宽，标题写出对象；第一句、「下面这些内容会锁定」按锁定组分行、没做的建议、不能下架；两个按钮',
      dlg
        ? {
            width: dlg.style.width,
            title: dlg.querySelector('.ant-modal-title')?.textContent,
            first: texts(dlg, '.consequence-info .consequence-body'),
            lockHead: texts(dlg, '.consequence-lock .consequence-strong'),
            tags: texts(dlg, '.activate-lock-line .lock-tag'),
            lines: texts(dlg, '.activate-lock-line .activate-pairs'),
            warn: texts(dlg, '.consequence-warn .consequence-body'),
            noUndo: texts(dlg, '.consequence-danger .consequence-body'),
            buttons: texts(dlg, '.ant-modal-footer button').map((t) => t.replace(/\s/g, '')),
            mono: texts(dlg, '.activate-pair-value.mono'),
          }
        : null,
      {
        width: '640px',
        title: `上架「${GUIZHOU_5D.title}」`,
        first: ['上架后，销售助手会立即向客户推荐这条线路，并按每人13,800元起报价。'],
        lockHead: ['下面这些内容会锁定'],
        tags: ['识别', '计价', '条款', '推荐'],
        lines: [
          `线路编号r-guizhou-5d·线路名称${GUIZHOU_5D.title}·目的地贵州·天数5天·客户的其他叫法黔东南`,
          '每人起价13,800元/人·最佳季节4月-10月（这些月份出发报价上浮10%，「全年」不加价）',
          `费用包含${inc}条·费用不含${exc}条`,
          '境内·适合客群家庭、亲子、银发·全程最高海拔1,200米·标签「国内」',
        ],
        warn: ['有1条建议没做：体力强度没填（不拦上架）'],
        noUndo: ['上架后无法下架，锁定的内容只能由技术修正。'],
        buttons: ['再检查一下', '上架，开始推荐'],
        mono: ['r-guizhou-5d'],
      },
    );
    check('上架确认：默认焦点在「再检查一下」', document.activeElement === buttonIn(dlg, '再检查一下'));
    // 间隔号跟在一段的末尾、在这一段里面：换行只发生在它后面，不会落到行首
    check(
      '锁定清单：每段「字段 值」整体一个盒子，间隔号在段尾',
      !!dlg &&
        all(dlg, '.activate-pair').every(
          (p, i, ps) => (p.querySelector('.sep') !== null) === (ps[i + 1]?.parentElement === p.parentElement),
        ),
    );
    await click(buttonIn(dlg, '再检查一下'));
    await motion();
    eq(
      '「再检查一下」：确认框关上，焦点回到「上架…」，没发请求',
      [dialogTitled('上架') === undefined, document.activeElement === activateButton(d.box), writes(api.sent).length],
      [true, true, 0],
    );
    await click(activateButton(d.box));
    await motion();
    await click(buttonIn(dialogTitled('上架'), '上架，开始推荐'));
    await until(() => header(d.box).titleStatus === '已上架');
    await motion();
    eq(
      '「上架，开始推荐」：按眼下的 rev 发 activate，不发 PATCH；页面换成已上架（状态、状态句、页头只剩「更多」、没有上架前检查），焦点在标题上，读屏念「已上架」',
      [
        writes(api.sent).map((x) => [x.method, x.url.replace(/^.*\/api\/console/, ''), x.body]),
        header(d.box).titleStatus,
        header(d.box).status?.split('·')[0],
        actionsOf(d.box),
        d.box.querySelectorAll('.detail-side .check-list').length,
        onTitle(),
        live(d.box),
        dialogTitled('上架') === undefined,
      ],
      [[['POST', '/catalog/route/r-guizhou-5d/activate', { rev: 1 }]], '已上架', '13项上架后锁定', ['更多'], 0, true, '已上架', true],
    );
    const listed = () =>
      (d.qc.getQueryData(['catalog', 'route']) as { items: { code: string; status?: string }[] } | undefined)?.items.find(
        (r) => r.code === 'r-guizhou-5d',
      )?.status;
    await until(() => listed() === 'active');
    const cached = d.qc.getQueryData(['catalog', 'route', 'r-guizhou-5d']) as { status?: string; rev?: number } | undefined;
    eq(
      '上架以后：这一条的缓存换成上架后的条目（rev 2），列表重新取过（名称、状态从库里来），列表里是已上架',
      [cached?.status, cached?.rev, api.sent.filter((x) => x.method === 'GET' && x.url.endsWith('/catalog/route')).length > 0, listed()],
      ['active', 2, true, 'active'],
    );
    await d.unmount();
    api.restore();
  }

  // 验收 17：清空一个必填字段再点「上架…」：不打开确认框，焦点跳到那个字段；在「预览」页签点也一样（先换回编辑）
  {
    const api = fakeApi(() => undefined);
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const titleIn = () => d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="title"] input');
    // 两处没过：一处在最前面的卡片，一处在后面的卡片；焦点跳到第一处
    await typeInto(titleIn(), '');
    await typeInto(d.box.querySelector('[data-field-key="hotelLevel"] input'), '');
    await click(activateButton(d.box));
    await motion();
    eq(
      '必须项没过点「上架…」：不打开确认框，焦点跳到第一处（线路名称），两处的字段下方都写「没填」，检查清单列着它们，没发请求（验收 17）',
      [
        dialogTitled('上架') === undefined,
        document.activeElement === titleIn(),
        errorAt(d.box, '[data-group="basic"] [data-field-key="title"]'),
        errorAt(d.box, '[data-field-key="hotelLevel"]'),
        checkRows(d.box).slice(0, 2),
        writes(api.sent).length,
      ],
      [true, true, '线路名称：没填', '住宿档次：没填', ['线路名称没填', '住宿档次没填'], 0],
    );
    await typeInto(d.box.querySelector('[data-field-key="hotelLevel"] input'), '精品');
    await tabClick(d.box, '预览');
    await until(() => d.box.querySelector('.detail-preview') !== null);
    await click(activateButton(d.box));
    await until(() => document.activeElement === titleIn());
    eq(
      '在「预览」页签点「上架…」：换回编辑（地址上没有 tab），焦点落进线路名称，不打开确认框',
      [d.router.state.location.search, document.activeElement === titleIn(), dialogTitled('上架') === undefined],
      [{}, true, true],
    );
    await d.unmount();
    api.restore();
  }

  // 有没保存的改动时上架：确认框说先保存、列的是表单里的内容；确认以后先 PATCH，再按存好的 rev 上架
  {
    const edited = '贵州 小七孔·西江千户苗寨 5 日（亲子版）';
    const api = fakeApi((s) => {
      if (s.method === 'PATCH') {
        const b = s.body as { rev: number; set: Payload };
        return json({ ...GUIZHOU_ITEM, rev: b.rev + 1, payload: { ...GUIZHOU_5D, ...b.set } });
      }
      if (s.method === 'POST' && s.url.endsWith('/activate'))
        return json(activeGuizhou((s.body as { rev: number }).rev + 1, { ...GUIZHOU_5D, title: edited, hotelLevel: '精品民宿' }));
      return undefined;
    });
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    await typeInto(d.box.querySelector('[data-group="basic"] [data-field-key="title"] input'), edited);
    await typeInto(d.box.querySelector('[data-field-key="hotelLevel"] input'), '精品民宿');
    await click(activateButton(d.box));
    await motion();
    const dlg = dialogTitled('上架');
    eq(
      '有没保存的改动：确认框标题与锁定清单是表单里的内容，另说「先保存这2处改动，再上架」',
      [
        dlg?.querySelector('.ant-modal-title')?.textContent,
        dlg ? texts(dlg, '.consequence-info .consequence-body')[1] : null,
        dlg ? texts(dlg, '.activate-lock-line .activate-pairs')[0]?.includes(edited) : null,
      ],
      [`上架「${edited}」`, '先保存这2处改动，再上架', true],
    );
    // 确认框开着时按 ⌘S：不拿底下的表单去存
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await cmdS();
    eq('确认框开着时按 ⌘S：不拦、不发请求', [cmdSPrevented, writes(api.sent).length], [false, 0]);
    await click(buttonIn(dialogTitled('上架'), '上架，开始推荐'));
    await until(() => header(d.box).titleStatus === '已上架');
    await motion();
    eq(
      '确认：先 PATCH（rev 1，线路名称与住宿档次），再按存好的 rev 2 上架；以后没有保存条，标题是改过的',
      [writes(api.sent).map((x) => [x.method, x.body]), bar(d.box), header(d.box).title],
      [
        [
          ['PATCH', { rev: 1, set: { title: edited, hotelLevel: '精品民宿' } }],
          ['POST', { rev: 2 }],
        ],
        null,
        edited,
      ],
    );
    await d.unmount();
    api.restore();
  }

  // 有改动时上架、上架请求还没回来：先保存的那一次不把焦点拉回表单（确认框还开着），焦点留在「上架，开始推荐」上；
  // 这时确认框关不掉（「关闭」「再检查一下」点不动，Esc 不关）：关了上架照样会成
  {
    let release: (r: Response) => void = () => undefined;
    const api = fakeApi((s) => {
      if (s.method === 'PATCH') {
        const b = s.body as { rev: number; set: Payload };
        return json({ ...GUIZHOU_ITEM, rev: b.rev + 1, payload: { ...GUIZHOU_5D, ...b.set } });
      }
      if (s.method === 'POST' && s.url.endsWith('/activate')) return new Promise<Response>((r) => (release = r));
      return undefined;
    });
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const level = d.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input');
    await act(async () => level?.focus());
    await typeInto(level, '精品民宿');
    await click(activateButton(d.box));
    await motion();
    const dlg = dialogTitled('上架');
    const go = buttonIn(dlg, '上架，开始推荐');
    await act(async () => go?.focus());
    await click(go);
    await until(() => posts(api.sent, '/activate').length === 1);
    await motion();
    const closeBtn = dlg?.querySelector<HTMLButtonElement>('.ant-modal-close');
    const busy = [
      writes(api.sent).map((x) => x.method),
      document.activeElement === go,
      closeBtn?.disabled,
      buttonIn(dlg, '再检查一下')?.disabled,
    ];
    await click(closeBtn);
    await click(buttonIn(dlg, '再检查一下'));
    await press(document.activeElement, 'Escape');
    // 点遮罩（在弹窗外按下、松开）
    const wrap = dlg?.closest<HTMLElement>('.ant-modal-wrap');
    await act(async () => void wrap?.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }) as unknown as Event));
    await click(wrap);
    await motion();
    eq(
      '先保存、再上架，上架还在发：焦点留在「上架，开始推荐」上；「关闭」「再检查一下」点不动，点了、按 Esc、点遮罩确认框都还开着',
      [busy, dialogTitled('上架') !== undefined],
      [[['PATCH', 'POST'], true, true, true], true],
    );
    await act(async () => release(json(activeGuizhou(3, { ...GUIZHOU_5D, hotelLevel: '精品民宿' }))));
    await until(() => header(d.box).titleStatus === '已上架');
    await motion();
    eq('上架回来以后：确认框关上，焦点在标题上', [dialogTitled('上架') === undefined, onTitle()], [true, true]);
    await d.unmount();
    api.restore();
  }

  // 上架失败：先保存时 422 不再上架；上架时 409 是横幅；422 落到字段；连不上的就地重试
  {
    const cases: { name: string; reply(s: { method: string; url: string }): Response | Promise<Response> | undefined; edit?: boolean }[] = [
      {
        name: '先保存时 422',
        edit: true,
        reply: (s) =>
          s.method === 'PATCH'
            ? json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: 'hotelLevel', message: '含有存不下的字符' }] }, 422)
            : undefined,
      },
      { name: '409', reply: (s) => (s.url.endsWith('/activate') ? json({ error: 'rev_conflict', detail: '改过' }, 409) : undefined) },
      {
        name: '422',
        reply: (s) =>
          s.url.endsWith('/activate')
            ? json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: 'itinerary.2.hotel', message: '不能为空' }] }, 422)
            : undefined,
      },
    ];
    const seen: unknown[] = [];
    for (const c of cases) {
      const api = fakeApi(c.reply);
      const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
      if (c.edit) await typeInto(d.box.querySelector('[data-field-key="hotelLevel"] input'), '精品');
      await click(activateButton(d.box));
      await motion();
      await click(buttonIn(dialogTitled('上架'), '上架，开始推荐'));
      await until(() => writes(api.sent).length > 0);
      await motion();
      await settle();
      seen.push({
        case: c.name,
        writes: writes(api.sent).map((x) => x.method),
        dialog: dialogTitled('上架') !== undefined,
        status: header(d.box).titleStatus,
        conflict: texts(d.box, '.detail-conflict .ant-alert-title'),
        focus:
          document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key') ??
          document.activeElement?.textContent?.replace(/\s/g, ''),
        error: errorAt(d.box, '[data-field-key="hotelLevel"]') ?? errorAt(d.box, '[data-item-index="2"] [data-field-key="hotel"]'),
      });
      await d.unmount();
      api.restore();
    }
    eq('上架失败：确认框关上、还是草稿；错误落到页头下或字段，焦点跟过去', seen, [
      {
        case: '先保存时 422',
        writes: ['PATCH'],
        dialog: false,
        status: '草稿',
        conflict: [],
        focus: 'hotelLevel',
        error: '住宿档次：含有存不下的字符',
      },
      { case: '409', writes: ['POST'], dialog: false, status: '草稿', conflict: ['这条刚被别人改过'], focus: '载入最新版本', error: null },
      { case: '422', writes: ['POST'], dialog: false, status: '草稿', conflict: [], focus: 'hotel', error: '当晚住宿：不能为空' },
    ]);
    // 连不上：页头下「服务暂时连不上」，焦点在「重试」；失败以后表单还能改，重试重新打开确认框，列的是那时的表单
    const edited = '贵州 小七孔·西江千户苗寨 5 日（改）';
    let n = 0;
    const api = fakeApi((s) => {
      if (s.method === 'PATCH') {
        const b = s.body as { rev: number; set: Payload };
        return json({ ...GUIZHOU_ITEM, rev: b.rev + 1, payload: { ...GUIZHOU_5D, ...b.set } });
      }
      if (!s.url.endsWith('/activate')) return undefined;
      n += 1;
      return n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : json(activeGuizhou(3, { ...GUIZHOU_5D, title: edited }));
    });
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    await click(activateButton(d.box));
    await motion();
    await click(buttonIn(dialogTitled('上架'), '上架，开始推荐'));
    await until(() => d.box.querySelector('.detail-failure') !== null);
    await motion();
    const retry = buttonIn(d.box.querySelector('.detail-failure') ?? undefined, '重试');
    eq(
      '上架时连不上：确认框关上，页头下「服务暂时连不上」，焦点在「重试」',
      [
        dialogTitled('上架') === undefined,
        texts(d.box, '.detail-failure .ant-alert-title')[0]?.startsWith('服务暂时连不上'),
        document.activeElement === retry,
      ],
      [true, true, true],
    );
    // 失败以后改了锁定的线路名称（横幅还在），再点「重试」
    await typeInto(d.box.querySelector('[data-group="basic"] [data-field-key="title"] input'), edited);
    await click(retry);
    await motion();
    const again = dialogTitled('上架');
    eq(
      '「重试」：不直接上架，重新打开确认框，标题与锁定清单是改过的表单，另说先保存；这时没有再发请求',
      [
        again?.querySelector('.ant-modal-title')?.textContent,
        again ? texts(again, '.consequence-info .consequence-body')[1] : null,
        again ? texts(again, '.activate-lock-line .activate-pairs')[0]?.includes(edited) : null,
        writes(api.sent).map((x) => x.method),
      ],
      [`上架「${edited}」`, '先保存这1处改动，再上架', true, ['POST']],
    );
    await click(buttonIn(again, '上架，开始推荐'));
    await until(() => header(d.box).titleStatus === '已上架');
    eq(
      '确认以后先 PATCH 改过的名称，再按存好的 rev 上架；成功以后失败收起',
      [
        writes(api.sent).map((x) => [x.method, x.body]),
        header(d.box).title,
        dialogTitled('上架') === undefined,
        d.box.querySelectorAll('.detail-failure').length,
      ],
      [
        [
          ['POST', { rev: 1 }],
          ['PATCH', { rev: 1, set: { title: edited } }],
          ['POST', { rev: 2 }],
        ],
        edited,
        true,
        0,
      ],
    );
    await d.unmount();
    api.restore();
  }
  // 失败以后必须项没过时点「重试」：同「上架…」，不开确认框，焦点跳到那个字段
  {
    const api = fakeApi((s) => (s.url.endsWith('/activate') ? Promise.reject(new TypeError('Failed to fetch')) : undefined));
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    await click(activateButton(d.box));
    await motion();
    await click(buttonIn(dialogTitled('上架'), '上架，开始推荐'));
    await until(() => d.box.querySelector('.detail-failure') !== null);
    await motion();
    const titleIn = () => d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="title"] input');
    await typeInto(titleIn(), '');
    await click(buttonIn(d.box.querySelector('.detail-failure') ?? undefined, '重试'));
    await motion();
    eq(
      '失败以后清空线路名称再「重试」：不开确认框，焦点在线路名称，只发过第一次的 activate',
      [dialogTitled('上架') === undefined, document.activeElement === titleIn(), writes(api.sent).length],
      [true, true, 1],
    );
    await d.unmount();
    api.restore();
  }

  // 假包的上架确认：第一句按套餐的 activateLine；引用字段（包含主材）写名称，不写编号
  {
    const api = fakeApi(() => undefined);
    const row = PKG_ROWS.find((r) => r.code === 'p-jiufang-part')!;
    const d = await mountDetail('/catalog/package/p-jiufang-part', owner(renovationLPage), {
      items: { 'package/p-jiufang-part': { kind: 'package', ord: 0, rev: 1, ...row } },
      lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
    });
    await click(activateButton(d.box));
    await motion();
    const dlg = dialogTitled('上架');
    eq(
      '假包「旧房翻新」的上架确认：第一句按每平米单价估价；条款一行的包含主材写名称',
      dlg
        ? [
            dlg.querySelector('.ant-modal-title')?.textContent,
            texts(dlg, '.consequence-info .consequence-body')[0],
            texts(dlg, '.activate-lock-line .lock-tag'),
            texts(dlg, '.activate-lock-line .activate-pairs')[2],
          ]
        : null,
      [
        '上架「旧房翻新 · 局部改造包」',
        '上架后，销售助手会向业主推荐这个套餐，并按每平米860元估价。',
        ['识别', '计价', '条款', '推荐'],
        '工期30天·含拆旧·包含主材马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装',
      ],
    );
    await d.unmount();
    api.restore();
  }

  // 后加的含软装（活的假包）：草稿「旧房翻新」没填这一项，上架确认的条款一行写「含软装没填」
  {
    const api = fakeApi(() => undefined);
    const row = PKG_ROWS.find((r) => r.code === 'p-jiufang-part')!;
    const d = await mountDetail('/catalog/package/p-jiufang-part', owner(renovation), {
      items: { 'package/p-jiufang-part': { kind: 'package', ord: 0, rev: 1, ...row } },
      lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
    });
    await click(activateButton(d.box));
    await motion();
    const dlg = dialogTitled('上架');
    eq(
      '后加的含软装：草稿「旧房翻新」没填，上架确认的条款一行写「含软装没填」',
      dlg ? texts(dlg, '.activate-lock-line .activate-pairs')[2] : null,
      '工期30天·含拆旧·含软装没填·包含主材马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装',
    );
    await d.unmount();
    api.restore();
  }

  // 11.4 复制为新草稿：「更多」里点开；新编号的检查；用存着的 payload 换掉编号去建；建好以后去新草稿
  const draftOf = (kind: string, payload: Payload) => ({
    kind,
    code: payload.id,
    status: 'draft',
    rev: 1,
    ord: 99,
    updatedByName: '小林',
    updatedAt: new Date(Date.now()).toISOString(),
    payload,
  });
  /** 「更多」开着菜单时报的 aria-expanded（openCopy 每次记下） */
  let moreExpanded: string | null | undefined;
  const openCopy = async (root: ParentNode) => {
    await click(root.querySelector('.page-actions .header-more'));
    await settle();
    moreExpanded = root.querySelector('.page-actions .header-more')?.getAttribute('aria-expanded');
    const items = all<HTMLElement>(document.body, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item');
    const names = items.map((x) => x.textContent);
    await click(items.find((x) => x.textContent === '复制为新草稿'));
    await motion();
    return names;
  };
  const copyDialog = () => dialogTitled('复制');
  const codeInput = () => copyDialog()?.querySelector<HTMLInputElement>('.copy-code input') ?? null;
  const codeNote = () => copyDialog()?.querySelector('.copy-code .field-error, .copy-code .field-help')?.textContent ?? null;
  {
    const api = fakeApi((s) => {
      if (s.method !== 'POST' || !s.url.endsWith('/catalog/route')) return undefined;
      const p = (s.body as { payload: Payload }).payload;
      return p.id === 'r-race' ? json({ error: 'catalog_code_taken', detail: '这个 code 已经有了' }, 409) : json(draftOf('route', p));
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const moreBtn = () => e.box.querySelector('.page-actions .header-more');
    const moreAria = [moreBtn()?.getAttribute('aria-haspopup'), moreBtn()?.getAttribute('aria-expanded')];
    const menu = await openCopy(e.box);
    eq(
      '「更多」告诉读屏它打开一个菜单、开着没有（同用户菜单）：收着 false，开着 true，点了菜单项以后又是 false',
      [moreAria, moreExpanded, moreBtn()?.getAttribute('aria-expanded')],
      [['menu', 'false'], 'true', 'false'],
    );
    const dlg = copyDialog();
    eq(
      '「更多」里只有「复制为新草稿」；弹窗 480 宽，标题写出对象，先说后果与提醒，再是新编号（帮助写格式、示例取编号的例子），焦点在输入框里',
      [
        menu,
        dlg?.style.width,
        dlg?.querySelector('.ant-modal-title')?.textContent,
        dlg ? texts(dlg, '.consequence-body') : null,
        dlg?.querySelector('.copy-code label')?.textContent,
        codeInput()?.getAttribute('placeholder'),
        codeNote(),
        document.activeElement === codeInput(),
        dlg ? texts(dlg, '.ant-modal-footer button').map((t) => t.replace(/\s/g, '')) : null,
      ],
      [
        ['复制为新草稿'],
        '480px',
        `复制「${SICHUAN.title}」为新草稿`,
        ['新草稿的内容与这一条存着的相同，只换编号', '两条都上架会同时被推荐，请区分名称和适用对象'],
        '新的线路编号',
        '例：r-sichuan-lux',
        CODE_HELP,
        true,
        ['取消', '复制为新草稿'],
      ],
    );
    // 浏览器里点按钮会把焦点放到按钮上（happy-dom 的 click() 不会）：先放上去，焦点回到输入框才测得出来
    const submitByClick = async () => {
      const b = buttonIn(copyDialog(), '复制为新草稿');
      await act(async () => b?.focus());
      await click(b);
    };
    const tries: (string | null)[] = [];
    const focusBack: boolean[] = [];
    for (const c of ['', 'R_X', 'r-sichuan-lux', 'r-guizhou-5d']) {
      await typeInto(codeInput(), c);
      await submitByClick();
      await settle();
      tries.push(codeNote());
      focusBack.push(document.activeElement === codeInput());
    }
    const noteEl = () => copyDialog()?.querySelector('.copy-code .field-error, .copy-code .field-help') ?? null;
    eq(
      '新编号有问题：不发请求，写在输入框下（没填、格式、和原来的一样、列表里已经有了），输入框标出错，报错经 aria-describedby 连上，焦点回到输入框',
      [
        tries,
        posts(api.sent, '/catalog/route').length,
        codeInput()?.getAttribute('aria-invalid'),
        !!noteEl()?.id && codeInput()?.getAttribute('aria-describedby') === noteEl()?.id,
        focusBack,
      ],
      [
        ['线路编号：没填', `线路编号：${CODE_RULE}`, '线路编号：和原来的编号一样，换一个', '线路编号：这个编号已经有了，换一个'],
        0,
        'true',
        true,
        [true, true, true, true],
      ],
    );
    await typeInto(codeInput(), 'r-race');
    eq('改了编号：报错收起，回到帮助', codeNote(), CODE_HELP);
    await submitByClick();
    await until(() => codeNote() !== CODE_HELP);
    eq(
      '服务端说编号撞了（409）：写在输入框下，焦点回到输入框，弹窗还开着',
      [codeNote(), document.activeElement === codeInput(), copyDialog() !== undefined],
      ['线路编号：这个编号已经有了，换一个', true, true],
    );
    await typeInto(codeInput(), ' r-sichuan-lux-kids ');
    await press(codeInput(), 'Enter');
    await until(() => e.router.state.location.pathname === '/catalog/route/r-sichuan-lux-kids');
    await motion();
    await settle();
    const body = posts(api.sent, '/catalog/route').at(-1)?.body as { payload: Payload } | undefined;
    eq(
      '回车就是复制：用这一条存着的 payload 只换编号（首尾空格去掉），键序不变',
      JSON.stringify(body?.payload),
      JSON.stringify(copyPayload(SICHUAN, 'r-sichuan-lux-kids')),
    );
    eq(
      '建好以后去新草稿的详情：原名、状态草稿、页头有「上架…」；焦点在标题上，读屏念「已复制为新草稿」；弹窗关上',
      [header(e.box).title, header(e.box).titleStatus, actionsOf(e.box), onTitle(), live(e.box), copyDialog() === undefined],
      [SICHUAN.title, '草稿', ['更多', '上架…'], true, '已复制为新草稿', true],
    );
    await e.unmount();
    api.restore();
  }

  // 有没保存的改动时复制：弹窗说不会带过去；建之前先问要不要离开（同未保存保护），「留下」什么也不建；
  // 「放弃改动并离开」才 POST 存着的内容，建好以后直接去新草稿，不再拦一次
  {
    const api = fakeApi((s) => (s.method === 'POST' ? json(draftOf('route', (s.body as { payload: Payload }).payload)) : undefined));
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), `${hardestText}；返程日早起`);
    await openCopy(e.box);
    eq(
      '有没保存的改动：复制弹窗说「这一页还有1处改动没保存，不会带过去」',
      copyDialog() ? texts(copyDialog()!, '.consequence-body')[1] : null,
      '这一页还有1处改动没保存，不会带过去',
    );
    // 复制弹窗开着、焦点不在弹窗里（打开的动画还没走完时就是这样）按 ⌘S：不拿底下的表单去存
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await cmdS();
    eq('复制弹窗开着时按 ⌘S（焦点不在弹窗里）：不拦、不发请求', [cmdSPrevented, writes(api.sent).length], [false, 0]);
    const leave = () => dialogTitled('有改动还没保存');
    await typeInto(codeInput(), 'r-sichuan-copy');
    await act(async () => buttonIn(copyDialog(), '复制为新草稿')?.focus());
    await click(buttonIn(copyDialog(), '复制为新草稿'));
    await until(() => leave() !== undefined);
    await motion();
    eq(
      '建之前先问：「有改动还没保存」，默认焦点「留下」；还没发 POST，复制弹窗还开着',
      [posts(api.sent, '/catalog/route').length, copyDialog() !== undefined, document.activeElement === buttonIn(leave(), '留下')],
      [0, true, true],
    );
    await click(buttonIn(leave(), '留下'));
    await motion();
    eq(
      '「留下」：什么也不建，复制弹窗还开着、编号还在；还在原来的地址，改动还在',
      [
        posts(api.sent, '/catalog/route').length,
        leave() === undefined,
        copyDialog() !== undefined,
        codeInput()?.value,
        e.router.state.location.pathname,
        barText(e.box)?.summary,
      ],
      [0, true, true, 'r-sichuan-copy', '/catalog/route/r-sichuan-lux', '有1处改动'],
    );
    await press(codeInput(), 'Enter');
    await until(() => leave() !== undefined);
    await motion();
    await click(buttonIn(leave(), '放弃改动并离开'));
    await until(() => e.router.state.location.pathname === '/catalog/route/r-sichuan-copy');
    await motion();
    await settle();
    const sentPayload = (posts(api.sent, '/catalog/route')[0]?.body as { payload: Payload } | undefined)?.payload;
    eq(
      '「放弃改动并离开」：POST 一次存着的内容（不带没保存的改动），直接去新草稿，不再弹离开保护；读屏念「已复制为新草稿」',
      [
        posts(api.sent, '/catalog/route').length,
        JSON.stringify(sentPayload?.intensity) === JSON.stringify(SICHUAN.intensity),
        e.router.state.location.pathname,
        leave() === undefined,
        header(e.box).titleStatus,
        live(e.box),
      ],
      [1, true, '/catalog/route/r-sichuan-copy', true, '草稿', '已复制为新草稿'],
    );
    await e.unmount();
    api.restore();
  }

  // 键盘打开：菜单项上按 Enter 打开弹窗，这次 Enter 的默认动作拦下（真浏览器里它会点到弹窗里有焦点的按钮，弹窗刚开就关）；
  // 没复制成（取消、右上角关闭、Esc）时焦点回到「更多」（打开它的菜单项已经收起）
  {
    const api = fakeApi(() => undefined);
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const more = e.box.querySelector<HTMLButtonElement>('.page-actions .header-more');
    await click(more);
    await settle();
    const item = all<HTMLElement>(document.body, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').find(
      (x) => x.textContent === '复制为新草稿',
    );
    let prevented: boolean | null = null;
    await act(async () => {
      const ev = new win.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
      item?.dispatchEvent(ev as unknown as Event);
      prevented = ev.defaultPrevented;
    });
    await motion();
    eq(
      '菜单项上按 Enter：弹窗打开，焦点在输入框里；这次 Enter 的默认动作拦下了',
      [copyDialog() !== undefined, document.activeElement === codeInput(), prevented],
      [true, true, true],
    );
    const back: string[] = [];
    for (const how of ['取消', '关闭', 'Esc']) {
      if (!copyDialog()) await openCopy(e.box);
      if (how === '取消') await click(buttonIn(copyDialog(), '取消'));
      else if (how === '关闭') await click(copyDialog()?.querySelector('.ant-modal-close'));
      else await press(codeInput(), 'Escape');
      await motion();
      back.push(
        `${how}：${copyDialog() === undefined ? '关上' : '还开着'}，焦点${document.activeElement === more ? '在「更多」' : '丢了'}`,
      );
    }
    eq('没复制成：弹窗关上，焦点回到「更多」', back, [
      '取消：关上，焦点在「更多」',
      '关闭：关上，焦点在「更多」',
      'Esc：关上，焦点在「更多」',
    ]);
    await e.unmount();
    api.restore();
  }

  // 提交中再按回车只建一次；服务端 422 说编号不对（path 是 id）写在输入框下；关上再打开没有上一次的编号与报错
  {
    let release: (() => void) | null = null;
    let posted = 0;
    const api = fakeApi((s) => {
      if (s.method !== 'POST') return undefined;
      posted += 1;
      if (posted > 1) return Promise.reject(new TypeError('Failed to fetch'));
      return new Promise<Response>((r) => {
        release = () => r(json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: 'id', message: 'Invalid string' }] }, 422));
      });
    });
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await openCopy(e.box);
    await typeInto(codeInput(), 'r-sichuan-copy');
    // 按下、松开再按下：输入框自己只拦按住不放时的连发（松开才解锁），提交中的第二次回车要靠弹窗自己拦
    const enterUp = () =>
      act(async () => {
        codeInput()?.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event);
      });
    await press(codeInput(), 'Enter');
    await enterUp();
    await press(codeInput(), 'Enter');
    await enterUp();
    await settle();
    eq('提交中再按回车：只发一次 POST', posts(api.sent, '/catalog/route').length, 1);
    await act(async () => release?.());
    await until(() => codeNote() !== CODE_HELP);
    eq(
      '服务端 422 的 path 是 id：写在输入框下（格式说明），不是弹窗里的整句',
      [codeNote(), copyDialog()?.querySelector('.copy-failure') != null, codeInput()?.getAttribute('aria-invalid')],
      [`线路编号：${CODE_RULE}`, false, 'true'],
    );
    await press(codeInput(), 'Enter');
    await until(() => copyDialog()?.querySelector('.copy-failure') != null);
    await click(buttonIn(copyDialog(), '取消'));
    await motion();
    await openCopy(e.box);
    eq(
      '关上再打开：编号清空，输入框下是帮助，没有上一次的报错',
      [codeInput()?.value, codeNote(), copyDialog()?.querySelector('.copy-failure') != null, codeInput()?.getAttribute('aria-invalid')],
      ['', CODE_HELP, false, null],
    );
    await e.unmount();
    api.restore();
  }

  // 复制时连不上：错误写在弹窗里（可以重试），弹窗还开着
  {
    const api = fakeApi((s) => (s.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : undefined));
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    await openCopy(e.box);
    await typeInto(codeInput(), 'r-sichuan-copy');
    await click(buttonIn(copyDialog(), '复制为新草稿'));
    await until(() => copyDialog()?.querySelector('.copy-failure') != null);
    eq(
      '复制时连不上：弹窗里「服务暂时连不上」加「重试」，弹窗还开着，还在原来的地址',
      [
        texts(copyDialog()!, '.copy-failure .ant-alert-title')[0]?.startsWith('服务暂时连不上'),
        buttonIn(copyDialog()!.querySelector('.copy-failure') ?? undefined, '重试') !== undefined,
        e.router.state.location.pathname,
      ],
      [true, true, '/catalog/route/r-sichuan-lux'],
    );
    await e.unmount();
    api.restore();
  }

  // 11.5 「预览」页签：375 宽、单栏、只读、含没保存的改动、只以文本显示；切页签不算离开；从预览跳到字段先换回编辑
  {
    const api = fakeApi(() => undefined);
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    await typeInto(d.box.querySelector('[data-field-key="hotelLevel"] input'), '精品<b>民宿</b>');
    const renamed = '贵州 亲子五日（改过的名字）';
    await typeInto(d.box.querySelector('[data-group="basic"] [data-field-key="title"] input'), renamed);
    await tabClick(d.box, '预览');
    await until(() => d.box.querySelector('.detail-preview') !== null);
    const frame = d.box.querySelector<HTMLElement>('.detail-preview-frame');
    eq(
      '点「预览」：地址 tab=preview，主栏换成手机宽度的只读预览，没有输入框；含没保存的改动、按文本显示；保存条和副栏还在，没被拦下',
      [
        d.router.state.location.search,
        d.box.querySelector('.detail-tabs .ant-tabs-tab-active')?.textContent,
        d.box.querySelectorAll('.detail-main input, .detail-main textarea, .detail-main .ant-segmented').length,
        texts(d.box, '.detail-preview-note'),
        frame?.getAttribute('aria-label'),
        frame?.textContent?.includes('精品<b>民宿</b>'),
        frame?.querySelectorAll('b').length,
        barText(d.box)?.summary,
        d.box.querySelectorAll('.detail-side .check-list').length,
        document.body.textContent?.includes('有改动还没保存'),
      ],
      [{ tab: 'preview' }, '预览', 0, ['手机宽度·含没保存的改动'], '手机宽度预览', true, 0, '有2处改动', 1, false],
    );
    eq(
      '预览里：条目名是表单里改过的（含没保存的改动，页头还是存着的）、各分组（逐日行程以区块头为标题），字段是只读形态',
      [
        d.box.querySelector('.detail-preview-title')?.textContent,
        header(d.box).title,
        all(d.box, '.preview-group').map((g) => g.getAttribute('data-group')),
        texts(d.box, '.preview-group-title'),
        d.box.querySelectorAll('.detail-preview .field.is-static').length > 10,
      ],
      [
        renamed,
        GUIZHOU_5D.title,
        ROUTE.groups.map((g) => g.key),
        ROUTE.groups.filter((g) => !blockOnly(ROUTE, g.key)).map((g) => g.label),
        true,
      ],
    );
    await click(all(d.box, '.check-list button.check-item').find((b) => b.textContent?.includes('体力强度')));
    await until(() => document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key') === 'intensity.level');
    eq(
      '预览时点副栏的检查项：换回「编辑」（地址上没有 tab），焦点落进体力强度；改动还在',
      [
        d.router.state.location.search,
        document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key'),
        d.box.querySelector<HTMLInputElement>('[data-field-key="hotelLevel"] input')?.value,
      ],
      [{}, 'intensity.level', '精品<b>民宿</b>'],
    );
    await tabClick(d.box, '预览');
    await until(() => d.box.querySelector('.detail-preview') !== null);
    await click(all(d.box, '.lock-row').find((b) => b.textContent?.includes('条款')));
    await until(() => document.activeElement?.textContent === '费用包含与不含');
    eq(
      '预览时点副栏的锁定组：换回编辑，焦点在那张卡片头',
      [d.router.state.location.search, document.activeElement?.textContent],
      [{}, '费用包含与不含'],
    );
    await act(async () => d.router.history.back());
    await until(() => d.box.querySelector('.detail-preview') !== null);
    eq('后退：回到「预览」页签（页签记一步浏览历史）', d.router.state.location.search, { tab: 'preview' });
    await d.unmount();
    api.restore();
  }
  // 身份与地址：匿名默认预览，点「编辑」写 tab=edit、全只读；地址带 tab=preview 时直接是预览；非编辑成员默认编辑
  {
    const an = await mountDetail('/catalog/route/r-sichuan-lux', anonOf(travel), {
      items: { 'route/r-sichuan-lux': { kind: 'route', code: 'r-sichuan-lux', payload: SICHUAN } },
      lists: { route: ANON_ROUTES },
    });
    const anonFirst = [
      an.router.state.location.search,
      an.box.querySelector('.detail-tabs .ant-tabs-tab-active')?.textContent,
      an.box.querySelectorAll('.detail-preview-frame').length,
      texts(an.box, '.detail-preview-note'),
      actionsOf(an.box),
    ];
    await tabClick(an.box, '编辑');
    await until(() => an.box.querySelector('.detail-preview') === null);
    eq(
      '匿名：默认「预览」（地址上没有 tab，没有改动不提），页头没有操作；点「编辑」写 tab=edit，全只读',
      [
        anonFirst,
        an.router.state.location.search,
        an.box.querySelectorAll('.detail-main input').length,
        an.box.querySelectorAll('.detail-main .field.is-static').length > 10,
      ],
      [[{}, '预览', 1, ['手机宽度'], []], { tab: 'edit' }, 0, true],
    );
    await an.unmount();
    const pv = await mountDetail('/catalog/route/r-sichuan-lux?tab=preview', owner(travel), {
      items: { 'route/r-sichuan-lux': SICHUAN_ITEM },
      lists,
    });
    const ag = await mountDetail('/catalog/route/r-sichuan-lux', agent(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    eq(
      '地址带 tab=preview：打开就是预览；非编辑成员默认「编辑」（全只读），有页签',
      [
        pv.box.querySelectorAll('.detail-preview').length,
        ag.box.querySelector('.detail-tabs .ant-tabs-tab-active')?.textContent,
        ag.box.querySelectorAll('.detail-preview').length,
      ],
      [1, '编辑', 0],
    );
    await pv.unmount();
    await ag.unmount();
    const agDraft = await mountDetail('/catalog/route/r-guizhou-5d', agent(travel), {
      items: { 'route/r-guizhou-5d': GUIZHOU_ITEM },
      lists,
    });
    eq('非编辑成员打开草稿：页头没有「上架…」「更多」', agDraft.box.querySelectorAll('.page-actions').length, 0);
    await agDraft.unmount();
  }

  // 11.6 新建：空表单不出保存条；编号的帮助按实体补；保存即建草稿（编号撞了报在编号下），建好以后换成它的详情
  {
    const api = fakeApi((s) => {
      if (s.method !== 'POST' || !s.url.endsWith('/catalog/hotel')) return undefined;
      const p = (s.body as { payload: Payload }).payload;
      return p.id === 'h-taken' ? json({ error: 'catalog_code_taken', detail: '这个 code 已经有了' }, 409) : json(draftOf('hotel', p));
    });
    const n = await mountDetail('/catalog/new/hotel', owner(travel), { lists });
    const input = (k: string) => n.box.querySelector<HTMLInputElement>(`[data-field-key="${k}"] input`);
    eq(
      '新建酒店：打开不填没有保存条；编号的帮助与示例（酒店没写，按实体补上）；页头没有操作',
      [bar(n.box), n.box.querySelector('[data-field-key="$code"] .field-help')?.textContent, input('$code')?.placeholder, actionsOf(n.box)],
      [null, CODE_HELP, '例：h-songtsam-meili', []],
    );
    await typeInto(input('$code'), 'h-taken');
    await typeInto(input('name'), '洱海某某酒店');
    await typeInto(input('destination'), '云南');
    await typeInto(input('stars'), '五星');
    await typeInto(input('nightlyFrom'), '1200');
    await typeInto(input('roomType'), '湖景房');
    await click(n.box.querySelector('[data-field-key="highlights"] .field-add'));
    await typeInto(n.box.querySelector('[data-field-key="highlights"] [data-item-index="0"] input'), '湖景');
    await click(primary(n.box));
    await until(() => errorAt(n.box, '[data-field-key="$code"]') !== null);
    await settle();
    eq(
      '编号撞了（409）：报在编号下，焦点回到编号，汇总「有1处要改」，还在新建页',
      [
        errorAt(n.box, '[data-field-key="$code"]'),
        document.activeElement === input('$code'),
        texts(n.box, '.detail-issues .ant-alert-title'),
        n.router.state.location.pathname,
      ],
      ['酒店编号：这个编号已经有了，换一个', true, ['有1处要改'], '/catalog/new/hotel'],
    );
    await typeInto(input('$code'), 'h-erhai-lake');
    eq('改了编号：它的报错收起', errorAt(n.box, '[data-field-key="$code"]'), null);
    await cmdS();
    await until(() => n.router.state.location.pathname === '/catalog/hotel/h-erhai-lake');
    await settle();
    await settle();
    eq(
      '⌘S 建草稿：payload 按字段顺序，标签是空数组（一个都不要也能建）',
      (posts(api.sent, '/catalog/hotel').at(-1)?.body as { payload: Payload } | undefined)?.payload,
      {
        id: 'h-erhai-lake',
        name: '洱海某某酒店',
        destination: '云南',
        stars: '五星',
        nightlyFrom: 1200,
        roomType: '湖景房',
        highlights: ['湖景'],
        tags: [],
      },
    );
    eq(
      '建好以后换成它的详情（replace，没被离开保护拦下）：草稿、页头有「更多」「上架…」、焦点在标题上、读屏念「已建草稿」',
      [
        n.router.history.length,
        header(n.box).title,
        header(n.box).titleStatus,
        actionsOf(n.box),
        onTitle(),
        live(n.box),
        document.body.textContent?.includes('有改动还没保存'),
      ],
      [1, '洱海某某酒店', '草稿', ['更多', '上架…'], true, '已建草稿', false],
    );
    await n.unmount();
    api.restore();
  }
  // 新建的放弃：确认「放弃填好的内容？」，回到空白；假包的编号帮助同样按实体补
  {
    const n = await mountDetail('/catalog/new/package', owner(renovationLPage), { lists: { package: PKG_ROWS, material: MATERIAL_ROWS } });
    const code = n.box.querySelector<HTMLInputElement>('[data-field-key="$code"] input');
    const hints = [n.box.querySelector('[data-field-key="$code"] .field-help')?.textContent, code?.placeholder];
    await typeInto(code, 'p-new');
    await click(all(n.box, '.action-bar button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃'));
    await settle();
    const title = document.querySelector('.ant-modal .ant-modal-title')?.textContent;
    await click(all(document.body, '.ant-modal button').find((b) => b.textContent?.replace(/\s/g, '') === '放弃改动'));
    await settle();
    eq(
      '假包新建：编号帮助与示例按装修套餐补；放弃先确认「放弃填好的内容？」，放弃以后回到空白、没有保存条',
      [hints, title, n.box.querySelector<HTMLInputElement>('[data-field-key="$code"] input')?.value, bar(n.box)],
      [[CODE_HELP, '例：p-nuanmu-2r'], '放弃填好的内容？', '', null],
    );
    await n.unmount();
  }

  // 11.7 列表页的「新建」：两个包都去新建页（旧抽屉删了）
  {
    const went: string[] = [];
    for (const [pack, kind, label, rows] of [
      [travel, 'route', '新建线路', { route: ROUTE_ROWS }],
      [renovationLPage, 'package', '新建装修套餐', { package: PKG_ROWS, material: MATERIAL_ROWS }],
    ] as const) {
      const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
      qc.setQueryData(VIEWER_KEY, owner(pack));
      for (const [k, items] of Object.entries(rows)) qc.setQueryData(['catalog', k], { items });
      const root = createRootRoute({ component: Outlet });
      const tree = root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/catalog/$kind', validateSearch: catalogSearch, component: CatalogPage }),
        createRoute({ getParentRoute: () => root, path: '/catalog/new/$kind', component: () => <p className="new-stub" /> }),
      ]);
      const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [`/catalog/${kind}`] }) });
      await router.load();
      const m = await mount(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await click(all(m.box, '.page-actions button').find((b) => b.textContent?.replace(/\s/g, '') === label));
      await until(() => m.box.querySelector('.new-stub') !== null);
      went.push(router.state.location.pathname);
      await m.unmount();
    }
    eq('列表页的「新建」：线路和假包的装修套餐都去 /catalog/new/{kind}', went, ['/catalog/new/route', '/catalog/new/package']);
  }

  // 11.8 多字段有序子项的增删（评审之后从第 11 步提前：旧抽屉删了，新建线路要能加逐日行程才存得上）。
  // 卡片右上角「删除这{itemNoun}」、底部「添加一{itemNoun}」；自动编号随增删重排；条数随天数锁定时两个都不画
  const subEdit = (root: ParentNode, key: string) => {
    const block = root.querySelector<HTMLElement>(`[data-field-key="${key}"]`) ?? undefined;
    // 每一项是竖轴上的一个 li（节点加卡片）；序号标签写得下就在节点里（「D1」），写不下在卡片第一行（「节点1」）
    const cards = block ? all<HTMLElement>(block, ':scope .tl-item') : [];
    return {
      block,
      cards,
      head: block?.querySelector('.field-block-head')?.textContent,
      labels: cards.map((c) => c.querySelector('.subitem-label')?.textContent ?? c.querySelector('.tl-node')?.textContent),
      buttons: block
        ? all<HTMLElement>(block, '.subitem-remove, .field-add').map(
            (b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').replace(/\s/g, ''),
          )
        : [],
      remove: (i: number) => cards[i]?.querySelector<HTMLElement>('.subitem-remove') ?? undefined,
      add: block?.querySelector<HTMLElement>(':scope .field-add') ?? undefined,
    };
  };
  {
    const n = await mountDetail('/catalog/new/route', owner(travel), { lists });
    const it = () => subEdit(n.box, 'itinerary');
    const dayTitle = (i: number) =>
      n.box.querySelector<HTMLInputElement>(`[data-field-key="itinerary"] [data-item-index="${i}"] [data-field-key="title"] input`);
    const empty = [it().head, it().cards.length, it().buttons];
    await click(it().add);
    const focus1 = document.activeElement === dayTitle(0);
    await click(it().add);
    eq(
      '新建线路：「逐日行程·0天」只有「添加一天」；加两天：D1、D2，每张卡片右上角「删除这天」，焦点进新加那一天的当天标题',
      [empty, it().head, it().labels, it().buttons, focus1, document.activeElement === dayTitle(1)],
      [['逐日行程·0天', 0, ['添加一天']], '逐日行程·2天', ['D1', 'D2'], ['删除这天', '删除这天', '添加一天'], true, true],
    );
    await typeInto(dayTitle(0), '抵达贵阳');
    await typeInto(dayTitle(1), '小七孔');
    eq(
      '新建里改子项不标「已改」（没有可以撤回的原文），保存条是「还没保存」',
      [n.box.querySelectorAll('.field-changed, .field-undo').length, barText(n.box)?.summary],
      [0, '还没保存'],
    );
    await click(it().remove(1));
    const afterLast = [it().labels, document.activeElement === it().remove(0)];
    await click(it().add);
    await typeInto(dayTitle(1), '西江千户苗寨');
    await click(it().remove(0));
    const afterFirst = [it().labels, dayTitle(0)?.value, document.activeElement === it().remove(0)];
    await click(it().remove(0));
    eq(
      '删最后一天：焦点给上一天的「删除这天」；删第一天：后面的一天成了 D1（文字跟着走），焦点给接替它的那一天的「删除这天」；删光了焦点在「添加一天」',
      [afterLast, afterFirst, it().cards.length, document.activeElement === it().add],
      [[['D1'], true], [['D1'], '西江千户苗寨', true], 0, true],
    );
    await n.unmount();
  }
  // 草稿线路：删掉第2天、再加一天（条数不变），新的一天先填当天安排、再填标题，保存的补丁里天号按位置重排、
  // 新的一天按行业包的顺序排键；已上架线路天数锁定，没有增删（验收 18）
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH' ? json({ ...GUIZHOU_ITEM, rev: 2, payload: { ...GUIZHOU_5D, ...(s.body as { set: Payload }).set } }) : undefined,
    );
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), { items: { 'route/r-guizhou-5d': GUIZHOU_ITEM }, lists });
    const day = (i: number, k: string) =>
      d.box.querySelector(`[data-field-key="itinerary"] [data-item-index="${i}"] [data-field-key="${k}"]`);
    await click(subEdit(d.box, 'itinerary').remove(1));
    // 条数变了：整个逐日行程算一处改动（第 10.2 步的口径）
    const marks = [texts(d.box, '[data-field-key="itinerary"] .field-changed'), barText(d.box)?.names];
    const short = checkRows(d.box).filter((r) => r.startsWith('逐日行程'));
    await click(subEdit(d.box, 'itinerary').add);
    const newFocus = document.activeElement === day(4, 'title')?.querySelector('input');
    await typeInto(day(4, 'detail')?.querySelector('textarea'), '上午游湖，下午返程');
    await typeInto(day(4, 'title')?.querySelector('input'), '返程');
    await typeInto(day(4, 'hotel')?.querySelector('input'), '—（返程）');
    await click(all(day(4, 'meals') ?? document.body, '.field-chip').find((b) => b.textContent === '早'));
    await cmdS();
    await until(() => api.patches().length === 1);
    const orig = GUIZHOU_5D.itinerary as Payload[];
    const sent = (api.patches()[0]?.body as { set: { itinerary: Payload[] } } | undefined)?.set.itinerary;
    eq(
      '草稿线路删掉第2天：逐日行程标「已改」，检查清单说还差1天；加一天，焦点进新的一天的当天标题；补丁里天号按位置重排 1–5，别的原样，新的一天的键按行业包的顺序',
      [marks, short, newFocus, sent?.slice(0, 4), sent?.[4] ? Object.entries(sent[4]) : null],
      [
        [['已改'], '逐日行程'],
        ['逐日行程还差1天'],
        true,
        [orig[0], { ...orig[2], day: 2 }, { ...orig[3], day: 3 }, { ...orig[4], day: 4 }],
        [
          ['day', 5],
          ['title', '返程'],
          ['detail', '上午游湖，下午返程'],
          ['hotel', '—（返程）'],
          ['meals', '早'],
        ],
      ],
    );
    await d.unmount();
    api.restore();
    const a = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    eq(
      '已上架线路：天数上架后锁定，逐日行程没有「删除这天」「添加一天」，各天的文字照样能改（验收 18）',
      [subEdit(a.box, 'itinerary').buttons, a.box.querySelectorAll('[data-field-key="itinerary"] .subitem-card input').length > 0],
      [[], true],
    );
    await a.unmount();
  }
  // 假包：施工节点没有 countFrom，新建、已上架都能增删；量词是「个节点」
  {
    const p = await mountDetail('/catalog/new/package', owner(renovationLPage), { lists: { package: PKG_ROWS, material: MATERIAL_ROWS } });
    const empty = subEdit(p.box, 'nodes').buttons;
    await click(subEdit(p.box, 'nodes').add);
    const node = subEdit(p.box, 'nodes');
    eq(
      '假包新建套餐：「添加一个节点」加一项：卡片「节点1」、右上角「删除这个节点」，焦点进节点名称',
      [
        empty,
        node.labels,
        node.buttons,
        document.activeElement?.closest('[data-field-key]')?.getAttribute('data-field-key'),
        document.activeElement?.tagName,
      ],
      [['添加一个节点'], ['节点1'], ['删除这个节点', '添加一个节点'], 'name', 'INPUT'],
    );
    await p.unmount();
    const row = PKG_ROWS.find((r) => r.status === 'active')!;
    const ap = await mountDetail(`/catalog/package/${row.code}`, owner(renovationLPage), {
      items: { [`package/${row.code}`]: { kind: 'package', ord: 0, rev: 1, ...row } },
      lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
    });
    const nodes = (row.payload.nodes as unknown[]).length;
    eq('假包已上架的套餐：施工节点能增删（条数不随别的字段锁定）', subEdit(ap.box, 'nodes').buttons, [
      ...Array.from({ length: nodes }, () => '删除这个节点'),
      '添加一个节点',
    ]);
    await ap.unmount();
  }
  // ---------------- 12. 有序子项与引用（plan 第 11 步） ----------------
  // spec「有序子项与引用（G 页）」、设计系统 §6.3 与 G 页：竖轴与节点（填全、缺项、有报错）、「缺：当晚住宿」、上移下移与自动编号、
  // 条数提醒与条数锁定、子字段半格两两成行、子字段的「已改」；引用的分组联想（「酒店库 · 贵州」「本条写过的」）、
  // 库外文本的提示、「复制上一天的当晚住宿」；长文本 softMax 的提示。旅游包与假包走同一套代码
  const IT = fieldOf(ROUTE, 'itinerary');
  const NODES_F = fieldOf(PKG, 'nodes');
  const subOf = (f: FieldDef, k: string): FieldDef => f.item!.find((s) => s.key === k)!;
  const HOTEL_F = subOf(IT, 'hotel');
  const DETAIL_F = subOf(IT, 'detail');
  const ITS = GUIZHOU_5D.itinerary as Payload[];
  /** G 页的酒店库：data/ 的 23 家（只有贵阳安纳塔拉在贵州），另加两家贵州的草稿 */
  const G_HOTELS: ListRow[] = [
    ...HOTEL_ROWS,
    asRow({ id: 'h-kempinski-guiyang', name: '贵阳凯宾斯基大酒店', destination: '贵州' }, { status: 'draft' }),
    asRow({ id: 'h-liquan-libo', name: '荔波荔泉宾馆', destination: '贵州' }, { status: 'draft' }),
  ];
  const G_REFS = refItemsOf(HOTEL, G_HOTELS);

  // 12.1 纯逻辑
  {
    // 缺项与上架前检查同一个口径：逐个子字段删键、写空串、写 null，缺项正好是上架前检查报「没填」「没选」的那几个子字段
    const gapLabels = (e: EntityType, f: FieldDef, payload: Payload, i: number): string[] =>
      checkItem(e, payload)
        .required.filter((x) => x.path.startsWith(`${f.key}.${i}.`) && (x.message === '没填' || x.message === '没选'))
        .map((x) => x.label.split(' · ').at(-1)!);
    const off: string[] = [];
    let tried = 0;
    for (const [e, f, base] of [
      [ROUTE, IT, GUIZHOU_5D],
      [PKG, NODES_F, NUANMU],
    ] as const) {
      const items = base[f.key] as Payload[];
      for (const s of f.item ?? []) {
        for (const mut of ['delete', '', null] as const) {
          const item: Payload = { ...items[1]! };
          if (mut === 'delete') delete item[s.key];
          else item[s.key] = mut;
          const got = itemGaps(f, item);
          const want = gapLabels(e, f, { ...base, [f.key]: replaceAt(items, 1, item) }, 1);
          tried += 1;
          if (JSON.stringify(got) !== JSON.stringify(want))
            off.push(`${f.key}.${s.key}=${String(mut)}：${got.join('、')} / ${want.join('、')}`);
        }
      }
      items.forEach((it, i) => {
        if (itemGaps(f, it).length) off.push(`${f.key}.${i} 本来是全的`);
      });
    }
    // 空串在数字子字段上是写法不对（「要是整数」），不是缺项；必填的数组子字段 [] 也算填了
    const typed: FieldDef = {
      key: 'xs',
      type: 'subItems',
      label: 'X',
      group: 'g',
      item: [
        { key: 'n', type: 'intUnit', unit: '天', label: '天数', group: '' },
        { key: 'm', type: 'enum', multiple: true, options: ['甲', '乙'], label: '多选', group: '' },
      ],
    };
    const typedEntity = { ...ROUTE, fields: [typed] } as EntityType;
    for (const item of [{ n: '', m: [] }, { m: '' }, { n: null, m: null }, { n: 3, m: ['甲'] }] as Payload[]) {
      tried += 1;
      const want = gapLabels(typedEntity, typed, { xs: [{}, item] }, 1);
      if (JSON.stringify(itemGaps(typed, item)) !== JSON.stringify(want)) off.push(`数字与多选：${JSON.stringify(item)}`);
    }
    eq(`缺项与上架前检查的「没填」「没选」一致（两个包与一个夹具，${tried} 种改法），现有数据每一项都是全的`, off, []);
    eq(
      '缺项按包里的顺序写标签；单字段的有序子项没有缺项',
      [itemGaps(IT, { day: 1, detail: '安排' }), itemGaps(fieldOf(ROUTE, 'highlights'), '')],
      [['当天标题', '当晚住宿', '当天餐食'], []],
    );
    eq(
      '节点：这一项本身的报错、写了却不对的子字段的报错是 error；没填的子字段离开以后报「没填」，节点仍是缺项（gap）；' +
        '别的项的报错不算（「20.hotel」「12」不是第 3 项的）；没报错时看缺项',
      [
        itemState(IT, {}, 2, { '2': '第3天的天号应为3' }),
        itemState(IT, ITS[2], 2, { '2.hotel': '当晚住宿：不能为空' }),
        itemState(IT, { ...ITS[2]!, hotel: '' }, 2, { '2.hotel': '当晚住宿：没填' }),
        itemState(IT, { ...ITS[2]!, hotel: '' }, 2, { '2.hotel': '当晚住宿：没填', '2.title': '当天标题：格式不对' }),
        itemState(IT, ITS[2], 2, { '20.hotel': 'x', '12': 'y', '1.hotel': 'z' }),
        itemState(IT, { day: 3, title: '茂兰' }, 2),
        itemState(IT, ITS[2], 2),
      ],
      ['error', 'error', 'gap', 'error', 'done', 'gap', 'done'],
    );

    // 条数提醒与上架前检查的那一项同一个口径：天数各种写法（含没填、小数、负数、字符串、超出安全整数）乘以几种条数
    const daysOf = (n: number): Payload[] => Array.from({ length: n }, (_, i) => ({ ...ITS[i % ITS.length]!, day: i + 1 }));
    const sweep: string[] = [];
    let swept = 0;
    for (const days of [0, 1, 3, 5, 8, 1.5, -1, '5', undefined, Number.MAX_SAFE_INTEGER + 2]) {
      for (const n of [0, 1, 4, 5, 6, 9]) {
        const p: Payload = { ...GUIZHOU_5D, itinerary: daysOf(n) };
        if (days === undefined) delete p.days;
        else p.days = days;
        const want = checkItem(ROUTE, p).required.find((x) => x.path === 'itinerary' && /^(还差|多了)/.test(x.message))?.message;
        swept += 1;
        if (countGap(ROUTE, IT, p) !== want) sweep.push(`天数 ${String(days)}、${n} 天：${countGap(ROUTE, IT, p)} / ${want}`);
      }
    }
    eq(`条数提醒与上架前检查一致（${swept} 种组合）`, sweep, []);
    eq(
      '区块头右侧：已上架、能编辑时「条数随天数锁定，文字可改」；草稿写条数提醒；对上了不写；假包的施工节点没有 countFrom',
      [
        countNote(ROUTE, IT, SICHUAN, ACTIVE),
        countNote(ROUTE, IT, { ...GUIZHOU_5D, days: 6 }, DRAFT),
        countNote(ROUTE, IT, { ...GUIZHOU_5D, days: 4 }, DRAFT),
        countNote(ROUTE, IT, GUIZHOU_5D, DRAFT),
        countNote(ROUTE, IT, { ...SICHUAN, days: 9 }, READER),
        countNote(PKG, NODES_F, NUANMU, ACTIVE),
      ],
      ['条数随天数锁定，文字可改', '还差1天', '多了1天', undefined, '还差1天', undefined],
    );

    const rowKeys = (rows: { field: FieldDef; span: string }[][]) => rows.map((r) => r.map((c) => `${c.field.key}:${c.span}`));
    const half = (key: string): FieldDef => ({ key, type: 'text', label: key, group: '' });
    const wide = (key: string): FieldDef => ({ key, type: 'longText', label: key, group: '' });
    eq(
      '子字段两两成行：一天是「当天标题、当晚住宿」一行，再是当天安排、当天餐食；只读时当天餐食只占一格；假包是「节点名称、工期」；' +
        '半格先占左边，后面第一个半格补到右边，中间占满一行的往后排',
      [
        rowKeys(itemRows(IT)),
        rowKeys(itemRows(IT, 'readonly')),
        rowKeys(itemRows(NODES_F)),
        rowKeys(itemRows({ ...IT, item: [half('a'), wide('b'), wide('c'), half('d'), half('e'), half('f'), half('g')] })),
      ],
      [
        [['title:half', 'hotel:half'], ['detail:wide'], ['meals:wide']],
        [['title:half', 'hotel:half'], ['detail:wide'], ['meals:half']],
        [['name:half', 'days:half'], ['checkpoints:wide'], ['materials:wide']],
        [['a:half', 'd:half'], ['b:wide'], ['c:wide'], ['e:half', 'f:half'], ['g:half']],
      ],
    );

    const cleared3 = replaceAt(ITS, 2, { ...ITS[2]!, hotel: '' });
    const nodes = NUANMU.nodes as Payload[];
    eq(
      '复制上一天：第一天没有；上一天和这一天一样、上一天空着都不画；上一天填了、这一天不同时是上一天的值（多选按值比）',
      [
        copyFromPrev(ITS, 0, 'hotel'),
        copyFromPrev(ITS, 1, 'hotel'),
        copyFromPrev(ITS, 2, 'hotel'),
        copyFromPrev(cleared3, 2, 'hotel'),
        copyFromPrev(cleared3, 3, 'hotel'),
        copyFromPrev(nodes, 3, 'materials'),
        copyFromPrev(replaceAt(nodes, 3, { ...nodes[3]!, materials: ['m-marcopolo-800'] }), 3, 'materials'),
        copyFromPrev(ITS, 9, 'hotel'),
      ],
      [undefined, '贵阳凯宾斯基大酒店', undefined, '荔波荔泉宾馆', undefined, ['m-marcopolo-800'], undefined, undefined],
    );
    eq(
      '本条写过的：别的项写过的值，按出现的先后去重，跳过自己和空的；多选的展开；at 写第一次出现在哪一项',
      [
        writtenValues(IT, cleared3, 2, 'hotel'),
        writtenValues(IT, ITS, 4, 'hotel').map((w) => `${w.value}@${w.at}`),
        writtenValues(NODES_F, nodes, 0, 'materials'),
        writtenValues(NODES_F, nodes, 2, 'materials'),
      ],
      [
        [
          { value: '贵阳凯宾斯基大酒店', at: '第1天' },
          { value: '荔波荔泉宾馆', at: '第2天' },
          { value: '云上西江酒店', at: '第4天' },
          { value: '—（返程）', at: '第5天' },
        ],
        ['贵阳凯宾斯基大酒店@第1天', '荔波荔泉宾馆@第2天', '云上西江酒店@第4天'],
        [{ value: 'm-marcopolo-800', at: '第3个节点' }],
        [],
      ],
    );

    const lib = refLibrary(HOTEL_F, G_REFS, GUIZHOU_5D);
    const all = refLibrary(HOTEL_F, G_REFS, { ...GUIZHOU_5D, destination: '' });
    eq(
      '引用的第一组：按目的地只留贵州的三家（G 页）；目的地没填不筛、标题不写取值；已选上的即使不在这个目的地也留着；' +
        '候选没带内容的筛不出来；没有 filterBy 的不筛',
      [
        lib.filter,
        lib.items.map((x) => x.name),
        [all.filter, all.items.length],
        refLibrary(HOTEL_F, G_REFS, GUIZHOU_5D, ['成都博舍']).items.map((x) => x.name),
        refLibrary(HOTEL_F, [{ code: 'h-x', name: '没带内容的', status: 'active' }], GUIZHOU_5D).items.length,
        refLibrary(subOf(NODES_F, 'materials'), MATERIAL_REFS, NUANMU).items.length,
      ],
      [
        '贵州',
        ['贵阳安纳塔拉度假酒店', '贵阳凯宾斯基大酒店', '荔波荔泉宾馆'],
        [undefined, G_REFS.length],
        ['成都博舍', '贵阳安纳塔拉度假酒店', '贵阳凯宾斯基大酒店', '荔波荔泉宾馆'],
        0,
        MATERIAL_REFS.length,
      ],
    );
    eq(
      '库外文本的提示：allowFree 写了库里没有的才提示；空的、库里有的、候选还没取到的、不能写库外的都不提示',
      [
        freeText(HOTEL_F, '云上西江酒店', G_REFS),
        freeText(HOTEL_F, '荔波荔泉宾馆', G_REFS),
        freeText(HOTEL_F, '', G_REFS),
        freeText(HOTEL_F, '云上西江酒店', undefined),
        freeText(subOf(NODES_F, 'materials'), 'm-none', MATERIAL_REFS),
      ],
      [true, false, false, false, false],
    );
    eq(
      '长文本：字数按字符数（表情也算一个）；超过 softMax 才提示，等于不提示；别的类型、没写 softMax 的不提示；假包的验收要点是 80',
      [
        charCount('😀一a'),
        overSoftMax(DETAIL_F, '一'.repeat(120)),
        overSoftMax(DETAIL_F, '一'.repeat(121)),
        overSoftMax(DETAIL_F, '😀'.repeat(120)),
        overSoftMax(fieldOf(ROUTE, 'title'), '一'.repeat(500)),
        overSoftMax({ ...DETAIL_F, softMax: undefined }, '一'.repeat(500)),
        overSoftMax(subOf(NODES_F, 'checkpoints'), '一'.repeat(81)),
        softMaxNote(DETAIL_F),
      ],
      [3, false, true, false, false, false, true, '手机上会很长（建议120字以内）'],
    );
    const edited = replaceAt(ITS, 3, { ...ITS[3]!, detail: '改过的安排' });
    eq(
      '子字段「已改」：条数没变时按位置和打开时的比；条数变了不标（区块头标）；新建没有原文不标',
      [
        subChanged(ITS, edited, 3, 'detail'),
        subChanged(ITS, edited, 3, 'title'),
        subChanged(ITS, edited, 2, 'detail'),
        subChanged(ITS, removeAt(ITS, 0), 0, 'title'),
        subChanged(undefined, ITS, 0, 'title'),
      ],
      [true, false, false, false, false],
    );
  }

  // 12.2 画出来的样子（renderToStaticMarkup）：节点、缺项、按钮、行的顺序；条数锁定时没有按钮；只读时间轴同样两两成行
  {
    const formOf = (f: FieldDef, v: unknown, extra: Partial<FormProps> = {}) =>
      html(
        createElement(RENDERERS[f.type].Form, {
          field: f,
          value: v,
          row: GUIZHOU_5D,
          id: 'fx',
          labelId: 'fx-label',
          onChange: () => undefined,
          ...extra,
        }),
      );
    const g = formOf(IT, replaceAt(ITS, 2, { ...ITS[2]!, hotel: '' }), { itemErrors: { '3.title': '当天标题：没填' } });
    const nodeStates = [...g.matchAll(/class="tl-node is-(\w+)" aria-hidden="true">([^<]*)</g)].map((m) => `${m[2]}:${m[1]}`);
    const keyOrder = [
      ...(g.split('data-item-index="1"')[1] ?? '').split('data-item-index="2"')[0]!.matchAll(/data-field-key="(\w+)"/g),
    ].map((m) => m[1]);
    eq(
      'G 页：节点 D1–D5，第3天空心（缺当晚住宿）、第4天有报错；「缺：当晚住宿」；每天上移、下移、删除，D1 上移与 D5 下移 aria-disabled；' +
        '一天里是当天标题、当晚住宿、当天安排、当天餐食；底部「添加一天」；组名「第3天」；没有第一行（缺项）的四天，' +
        '第一行右边那一格（当晚住宿）标 under-tools，标签行给右上角的按钮让位',
      [
        nodeStates,
        count(g, '缺：当晚住宿'),
        count(g, 'aria-label="上移"'),
        count(g, 'aria-label="下移"'),
        count(g, 'aria-label="删除这天"'),
        count(g, 'aria-disabled="true"'),
        keyOrder,
        g.includes('添加一天'),
        g.includes('role="group" aria-label="第3天"'),
        count(g, 'class="field field-half under-tools" data-field-key="hotel"'),
      ],
      [['D1:done', 'D2:done', 'D3:gap', 'D4:error', 'D5:done'], 1, 5, 5, 5, 2, ['title', 'hotel', 'detail', 'meals'], true, true, 4],
    );
    const locked = formOf(IT, SICHUAN.itinerary, { countLocked: true, row: SICHUAN });
    eq(
      '条数随天数锁定：没有上移、下移、删除、添加，节点照样画',
      [count(locked, 'subitem-tools'), locked.includes('添加一天'), count(locked, 'class="tl-node is-done"'), count(locked, 'has-tools')],
      [0, false, 8, 0],
    );
    const pkg = formOf(NODES_F, NUANMU.nodes, { row: NUANMU });
    eq(
      '假包：节点里只写序号，「节点3」写在卡片第一行；「删除这个节点」「添加一个节点」',
      [
        count(pkg, '<span class="tl-node is-done" aria-hidden="true">3</span>'),
        count(pkg, '<span class="subitem-label">节点3</span>'),
        count(pkg, 'aria-label="删除这个节点"'),
        pkg.includes('添加一个节点'),
      ],
      [1, 1, 7, true],
    );
    const v = html(createElement(RENDERERS.subItems.View, { field: IT, value: ITS, row: GUIZHOU_5D }));
    const viewOrder = [
      ...(v.split('data-item-index="0"')[1] ?? '').split('data-item-index="1"')[0]!.matchAll(/data-field-key="(\w+)"/g),
    ].map((m) => m[1]);
    eq('只读时间轴：一天里同样是当天标题、当晚住宿一行在前', viewOrder, ['title', 'hotel', 'detail', 'meals']);
    const groupNames = (s: string) => [...s.matchAll(/class="subitem-card" role="group" aria-label="([^"]*)"/g)].map((m) => m[1]);
    const pkgView = html(createElement(RENDERERS.subItems.View, { field: NODES_F, value: NUANMU.nodes, row: NUANMU }));
    eq(
      '只读时间轴：节点对读屏隐藏，每项的卡片和编辑时一样是名为「第1天」的组（读屏念得到第几天）；假包是「第3个节点」',
      [
        groupNames(v),
        groupNames(pkgView)[2],
        count(pkgView, 'role="group" aria-label="第'),
        count(v, 'tl-node is-done" aria-hidden="true"'),
      ],
      [['第1天', '第2天', '第3天', '第4天', '第5天'], '第3个节点', (NUANMU.nodes as unknown[]).length, 5],
    );
    // aria-disabled 的按钮（到头的上移、下移）自己不降透明度、只降图标：移动以后焦点留在到头的按钮上，
    // 整个按钮降到 40% 会把焦点环一起压淡（评审实测 1.8:1，§1 要求 3:1）
    const cssRoot = path.join(root, 'console/src');
    const dimmed: string[] = [];
    for (const f of fs.readdirSync(cssRoot, { recursive: true, encoding: 'utf8' }).filter((x) => x.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(cssRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(^|[;\s])opacity\s*:/.test(body!)) continue;
        for (const one of sel!.split(',')) {
          const tail = one.trim().split(/\[aria-disabled=['"]?true['"]?\]/);
          if (tail.length > 1 && !/[\s>+~]/.test(tail.at(-1)!)) dimmed.push(`${f}：${one.trim()}`);
        }
      }
    }
    eq('aria-disabled 的按钮自己不降透明度，只降图标（焦点环保持对比度）', dimmed, []);
  }

  // 12.3 整页：G 页（草稿 r-guizhou-5d）
  const gLists = { route: ROUTE_ROWS, hotel: G_HOTELS };
  const itemEl = (root: ParentNode, key: string, i: number) =>
    root.querySelector<HTMLElement>(`[data-field-key="${key}"] [data-item-index="${i}"]`) ?? undefined;
  const subEl = (root: ParentNode, key: string, i: number, sub: string) =>
    itemEl(root, key, i)?.querySelector<HTMLElement>(`[data-field-key="${sub}"]`) ?? undefined;
  const nodeOf = (root: ParentNode, key: string, i: number) => {
    const n = itemEl(root, key, i)?.querySelector('.tl-node');
    return n ? `${n.textContent}:${n.className.replace('tl-node is-', '')}` : null;
  };
  const tool = (root: ParentNode, key: string, i: number, cls: 'up' | 'down' | 'remove') =>
    itemEl(root, key, i)?.querySelector<HTMLElement>(`.subitem-${cls}`) ?? undefined;
  const dropdownGroups = () =>
    all<HTMLElement>(document.body, '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item').map((el) =>
      el.classList.contains('ant-select-item-group')
        ? `#${(el.textContent ?? '').trim()}`
        : (el.querySelector('.ref-option')?.textContent ?? el.textContent ?? '').trim(),
    );
  /** 控件的下拉开着时（aria-expanded）读出各组；没有可列的项时 rc-select 不开下拉，这时是空 */
  const openedGroups = (input: Element | null | undefined) => (input?.getAttribute('aria-expanded') === 'true' ? dropdownGroups() : []);
  /** 打开下拉：焦点放进控件按 Enter（rc-select 的键盘打开） */
  const openDropdown = async (input: Element | null | undefined) => {
    await act(async () => (input as HTMLElement | null)?.focus());
    await press(input, 'Enter');
    await settle();
  };
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH' ? json({ ...GUIZHOU_ITEM, rev: 2, payload: { ...GUIZHOU_5D, ...(s.body as { set: Payload }).set } }) : undefined,
    );
    const d = await mountDetail('/catalog/route/r-guizhou-5d', owner(travel), {
      items: { 'route/r-guizhou-5d': GUIZHOU_ITEM },
      lists: gLists,
    });
    const hotelInput = (i: number) => subEl(d.box, 'itinerary', i, 'hotel')?.querySelector<HTMLInputElement>('input');
    const copyBtn = (i: number) => subEl(d.box, 'itinerary', i, 'hotel')?.querySelector<HTMLElement>('.field-copy') ?? undefined;
    const head = () => d.box.querySelector('[data-field-key="itinerary"] > .field-block-row')?.textContent;
    const nodes = () => [0, 1, 2, 3, 4].map((i) => nodeOf(d.box, 'itinerary', i));
    const opened = [head(), nodes(), [0, 1, 2].map((i) => copyBtn(i)?.textContent ?? null)];
    // 整个逐日行程里的「复制上一天的…」：只有引用子字段（当晚住宿）有，标题、安排、餐食每天都不同也不画
    const copies = all<HTMLElement>(d.box, '[data-field-key="itinerary"] .field-copy').map(
      (b) =>
        `${b.closest('[data-item-index]')?.getAttribute('data-item-index')}:${b.closest('[data-field-key]')?.getAttribute('data-field-key')}`,
    );
    const editBox = d.box.querySelector('[data-field-key="itinerary"] .subitems-edit');
    const labelledBy = document.getElementById(editBox?.getAttribute('aria-labelledby') || '-');
    eq(
      '「复制上一天的…」只在引用子字段（当晚住宿）上：第2、4、5天（和上一天不同）；逐日行程这一组的名字是区块头「逐日行程·5天」',
      [copies, editBox?.getAttribute('role'), labelledBy?.className, labelledBy?.textContent],
      [['1:hotel', '3:hotel', '4:hotel'], 'group', 'field-block-head', '逐日行程·5天'],
    );

    // 清空第3天的住宿：节点空心、「缺：当晚住宿」，组的说明连上它；第3天出「复制上一天的当晚住宿」
    await act(async () => hotelInput(2)?.focus());
    await typeInto(hotelInput(2), '');
    const card3 = itemEl(d.box, 'itinerary', 2)?.querySelector('.subitem-card');
    const gap = card3?.querySelector('.subitem-gap');
    eq(
      'G 页：区块头「逐日行程·5天」、条数对上了不写提醒；节点 D1–D5 实心；第1天没有「复制上一天的…」，第2天有（和第1天不同），' +
        '第3天和第2天一样所以没有；清空第3天的住宿：节点空心、卡片第一行「缺：当晚住宿」、组的读屏说明连上它、出现复制按钮',
      [
        opened,
        nodeOf(d.box, 'itinerary', 2),
        gap?.textContent,
        !!gap?.id && card3?.getAttribute('aria-describedby') === gap.id,
        copyBtn(2)?.textContent,
      ],
      [
        ['逐日行程·5天', ['D1:done', 'D2:done', 'D3:done', 'D4:done', 'D5:done'], [null, '复制上一天的当晚住宿', null]],
        'D3:gap',
        '缺：当晚住宿',
        true,
        '复制上一天的当晚住宿',
      ],
    );

    // 离开空着的住宿：字段下方报「当晚住宿：没填」，节点仍是缺项（空心、不是红色），「缺：当晚住宿」还在
    await act(async () => subEl(d.box, 'itinerary', 2, 'title')?.querySelector('input')?.focus());
    await settle();
    eq(
      '离开空着的第3天住宿：字段下方「当晚住宿：没填」，节点仍是缺项（gap，红色只给写错的），「缺：当晚住宿」还在',
      [
        subEl(d.box, 'itinerary', 2, 'hotel')?.querySelector('.field-error')?.textContent,
        nodeOf(d.box, 'itinerary', 2),
        card3?.querySelector('.subitem-gap')?.textContent,
      ],
      ['当晚住宿：没填', 'D3:gap', '缺：当晚住宿'],
    );
    // 联想：第3天的住宿按 Enter 打开，两组：「酒店库·贵州」三家（两家草稿），「本条写过的」写第几天；下拉带 ref-popup（至少 384 宽）
    await openDropdown(hotelInput(2));
    const groups = dropdownGroups();
    check('联想的下拉带 ref-popup', document.querySelector('.ant-select-dropdown.ref-popup:not(.ant-select-dropdown-hidden)') !== null);
    eq('第3天的住宿：联想分两组，「酒店库·贵州」只有贵州的三家（草稿跟「草稿」），「本条写过的」是别的几天写过的、写第几天', groups, [
      '#酒店库·贵州',
      '贵阳安纳塔拉度假酒店h-anantara-guiyang',
      '贵阳凯宾斯基大酒店h-kempinski-guiyang草稿',
      '荔波荔泉宾馆h-liquan-libo草稿',
      '#本条写过的',
      '贵阳凯宾斯基大酒店第1天',
      '荔波荔泉宾馆第2天',
      '云上西江酒店第4天',
      '—（返程）第5天',
    ]);
    const popupWidth = document.querySelector<HTMLElement>('.ant-select-dropdown.ref-popup:not(.ant-select-dropdown-hidden)')?.style.width;
    await press(hotelInput(2), 'Escape');
    // 敲字筛：两组都按名称筛；和输入一模一样的那项不列
    // 库外提示：下拉列着候选时不注（才敲「荔」、下拉里就是荔波荔泉宾馆），收起、没有候选、离开以后照注
    const freeNote = () => {
      const n = subEl(d.box, 'itinerary', 2, 'hotel')?.querySelector('.field-free');
      return n ? [n.textContent, (hotelInput(2)?.getAttribute('aria-describedby') ?? '').split(' ').includes(n.id)] : null;
    };
    await typeInto(hotelInput(2), '荔');
    await settle();
    const typed = openedGroups(hotelInput(2));
    const typedFree = freeNote();
    // rc-select 的下拉按 which 认 Esc（React 取自 keyCode；press 只带 key），合上要等一个宏任务（MessageChannel）
    await act(async () => {
      const esc = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      Object.defineProperty(esc, 'keyCode', { value: 27 });
      hotelInput(2)?.dispatchEvent(esc as unknown as Event);
    });
    await until(() => hotelInput(2)?.getAttribute('aria-expanded') === 'false');
    const escFree = [hotelInput(2)?.getAttribute('aria-expanded'), freeNote()];
    await typeInto(hotelInput(2), '云上西江酒店');
    await settle();
    const exact = openedGroups(hotelInput(2));
    const exactFree = freeNote();
    await typeInto(hotelInput(2), '荔');
    await settle();
    await act(async () => subEl(d.box, 'itinerary', 2, 'title')?.querySelector('input')?.focus());
    await until(() => hotelInput(2)?.getAttribute('aria-expanded') === 'false');
    const leftFree = freeNote();
    await act(async () => hotelInput(2)?.focus());
    await press(hotelInput(2), 'Escape');
    await typeInto(hotelInput(2), '');
    const FREE = ['酒店库里没有这个，按原文保存', true];
    eq(
      '库外提示：敲「荔」、下拉列着荔波荔泉宾馆时不注；Esc 收起以后注（「荔」按原文保存）；敲全「云上西江酒店」、没有候选时注；' +
        '敲着「荔」离开以后注，读屏说明都连上',
      [typedFree, escFree, exactFree, leftFree],
      [null, ['false', FREE], FREE, FREE],
    );
    eq(
      '联想的下拉宽 384（窗口不窄时）；敲「荔」两组都只剩荔波荔泉宾馆；敲全「云上西江酒店」，和输入一样的那项不列',
      [popupWidth, typed, exact],
      ['384px', ['#酒店库·贵州', '荔波荔泉宾馆h-liquan-libo草稿', '#本条写过的', '荔波荔泉宾馆第2天'], []],
    );
    // 复制上一天：住宿写成第2天的，焦点进第3天的住宿，按钮随即没了，节点回到实心
    // 焦点先放在按钮上（happy-dom 的 click() 不挪焦点，不先放的话焦点本来就在住宿里）
    await act(async () => copyBtn(2)?.focus());
    const onButton = document.activeElement === copyBtn(2);
    await click(copyBtn(2));
    await settle();
    check('复制前焦点在「复制上一天的当晚住宿」上', onButton);
    eq(
      '点「复制上一天的当晚住宿」：第3天的住宿是第2天的「荔波荔泉宾馆」，焦点进第3天的住宿，复制按钮没了，节点实心，没有缺项',
      [
        hotelInput(2)?.value,
        document.activeElement === hotelInput(2),
        copyBtn(2) !== undefined,
        nodeOf(d.box, 'itinerary', 2),
        card3?.querySelector('.subitem-gap') !== null,
      ],
      ['荔波荔泉宾馆', true, false, 'D3:done', false],
    );

    // 目的地改成四川：逐日行程跟着重画，第3天住宿的第一组换成「酒店库·四川」的两家（引用按 filterBy 取本条的目的地）
    const dest = d.box.querySelector<HTMLInputElement>('[data-group="basic"] [data-field-key="destination"] input');
    // 先清空住宿、再改目的地：逐日行程的值不变，只靠 filterBy 的取值进按字段记忆的 deps 才重画
    await typeInto(hotelInput(2), '');
    await typeInto(dest, '四川');
    await openDropdown(hotelInput(2));
    const sichuan = openedGroups(hotelInput(2)).filter((x) => !x.endsWith('天'));
    await press(hotelInput(2), 'Escape');
    await typeInto(hotelInput(2), '荔波荔泉宾馆');
    await typeInto(dest, '贵州');
    eq('目的地改成四川：第一组换成「酒店库·四川」的两家', sichuan, [
      '#酒店库·四川',
      '既下山·稻城h-xiaji-sichuan',
      '成都博舍h-temple-house-chengdu',
      '#本条写过的',
    ]);
    // 库外文本：第4天的「云上西江酒店」不在酒店库里，下方注「酒店库里没有这个，按原文保存」，读屏连上；库里有的不注
    const free4 = subEl(d.box, 'itinerary', 3, 'hotel')?.querySelector('.field-free');
    eq(
      '第4天的住宿写的是库外的「云上西江酒店」：下方 13 text-3「酒店库里没有这个，按原文保存」，输入框的读屏说明连上它；第1天（库里的草稿）不注',
      [
        free4?.textContent,
        !!free4?.id && (hotelInput(3)?.getAttribute('aria-describedby') ?? '').split(' ').includes(free4.id),
        subEl(d.box, 'itinerary', 0, 'hotel')?.querySelector('.field-free') !== null,
      ],
      ['酒店库里没有这个，按原文保存', true, false],
    );

    // 长文本：第4天的当天安排改到 131 字，字数 warning、帮助换成提示；改回 75 字，提示收起、帮助回来
    const detail4 = () => subEl(d.box, 'itinerary', 3, 'detail');
    const longState = () => {
      const f = detail4();
      const note = f?.querySelector('.field-soft, .field-help');
      return [
        f?.querySelector('.ant-input-data-count')?.textContent,
        f?.querySelector('.field-textarea')?.classList.contains('is-long'),
        note?.className,
        note?.textContent,
        !!note?.id && (f?.querySelector('textarea')?.getAttribute('aria-describedby') ?? '').split(' ').includes(note.id),
      ];
    };
    await typeInto(detail4()?.querySelector('textarea'), '一'.repeat(131));
    const over = longState();
    const changed4 = [
      !!detail4()?.querySelector('.field-changed'),
      !!subEl(d.box, 'itinerary', 3, 'title')?.querySelector('.field-changed'),
      !!d.box.querySelector('[data-field-key="itinerary"] > .field-block-row .field-changed'),
    ];
    await typeInto(detail4()?.querySelector('textarea'), '一'.repeat(75));
    eq(
      '当天安排 131 字：字数「131/120」变 warning，下方「手机上会很长（建议120字以内）」顶替帮助、连到文本域；75 字：「75/120」，帮助回来；' +
        '改过的当天安排标「已改」，同一天的当天标题不标，区块头也标',
      [over, longState(), changed4],
      [
        ['131/120', true, 'field-soft', '手机上会很长（建议120字以内）', true],
        ['75/120', false, 'field-help', '客户在手机上看，写清距离和用时', true],
        [true, false, true],
      ],
    );
    await typeInto(detail4()?.querySelector('textarea'), String(readValue(ITS[3]!, DETAIL_F.key)));

    // 上移下移：第1天的上移、第5天的下移 aria-disabled，点了不动；第1天下移：内容换到第2天、天号按位置重排，焦点跟着它到第2天的「下移」
    const titleOf = (i: number) => subEl(d.box, 'itinerary', i, 'title')?.querySelector('input')?.value;
    await click(tool(d.box, 'itinerary', 0, 'up'));
    await click(tool(d.box, 'itinerary', 4, 'down'));
    const still = [0, 1, 2, 3, 4].map(titleOf);
    const disabled = [
      tool(d.box, 'itinerary', 0, 'up')?.getAttribute('aria-disabled'),
      tool(d.box, 'itinerary', 4, 'down')?.getAttribute('aria-disabled'),
    ];
    await act(async () => tool(d.box, 'itinerary', 0, 'down')?.focus());
    await click(tool(d.box, 'itinerary', 0, 'down'));
    await settle();
    const moved = [titleOf(0), titleOf(1), document.activeElement === tool(d.box, 'itinerary', 1, 'down'), barText(d.box)?.names];
    await click(tool(d.box, 'itinerary', 1, 'up'));
    await settle();
    const back = [titleOf(0), titleOf(1), document.activeElement === tool(d.box, 'itinerary', 0, 'up'), barText(d.box)];
    eq(
      '第1天的上移、第5天的下移 aria-disabled，点了不动；第1天下移：第1、2天换位，焦点跟到第2天的「下移」，保存条逐个子字段列；' +
        '再上移回来：焦点在第1天的「上移」（aria-disabled 也留着焦点），没有改动、保存条收起',
      [disabled, still, moved, back],
      [
        ['true', 'true'],
        ITS.map((x) => x.title),
        [
          ITS[1]!.title,
          ITS[0]!.title,
          true,
          '第1天的当天标题、第1天的当天安排、第1天的当晚住宿、第1天的当天餐食、第2天的当天标题、第2天的当天安排、第2天的当晚住宿、第2天的当天餐食',
        ],
        [ITS[0]!.title, ITS[1]!.title, true, null],
      ],
    );
    // 第4天上移到第3天、保存：补丁里天号按位置 1–5，第3、4天的内容换了位置，别的原样
    await click(tool(d.box, 'itinerary', 3, 'up'));
    await cmdS();
    await until(() => api.patches().length === 1);
    const sent = (api.patches()[0]?.body as { set: { itinerary: Payload[] } } | undefined)?.set.itinerary;
    eq(
      '第4天上移以后保存：补丁里天号按位置 1–5，第3、4天的内容换了位置，键序不变',
      [sent?.map((x) => x.day), sent?.map((x) => x.title), sent ? Object.keys(sent[2]!) : null],
      [[1, 2, 3, 4, 5], [ITS[0]!.title, ITS[1]!.title, ITS[3]!.title, ITS[2]!.title, ITS[4]!.title], Object.keys(ITS[3]!)],
    );
    await until(() => barText(d.box) === null);
    // 条数提醒：删一天「还差1天」，再加两天「多了1天」（warning，不是锁定说明）；子字段条数变了不标「已改」
    await click(tool(d.box, 'itinerary', 4, 'remove'));
    const noteEl = d.box.querySelector('.count-note');
    const short = [
      noteEl?.textContent,
      noteEl?.classList.contains('is-locked'),
      !!noteEl?.id && (d.box.querySelector('.subitems-edit')?.getAttribute('aria-describedby') ?? '').split(' ').includes(noteEl.id),
    ];
    await click(d.box.querySelector('[data-field-key="itinerary"] .field-add'));
    await click(d.box.querySelector('[data-field-key="itinerary"] .field-add'));
    eq(
      '删一天：区块头右侧「还差1天」，逐日行程这一组的读屏说明连上它；加两天：「多了1天」，新加的两天节点空心；条数变了，子字段不标「已改」',
      [
        short,
        d.box.querySelector('.count-note')?.textContent,
        nodeOf(d.box, 'itinerary', 5),
        d.box.querySelectorAll('[data-field-key="itinerary"] .subitem-card .field-changed').length,
      ],
      [['还差1天', false, true], '多了1天', 'D6:gap', 0],
    );
    await d.unmount();
    api.restore();
  }

  // 12.4 已上架线路：条数随天数锁定（区块头写明，没有增删移动）；422 落在第2天的住宿下，第2天的节点有报错
  {
    const api = fakeApi((s) =>
      s.method === 'PATCH'
        ? json({ error: 'invalid_item', detail: '条目不合格', issues: [{ path: 'itinerary.1.hotel', message: '不能为空' }] }, 422)
        : undefined,
    );
    const e = await mountDetail('/catalog/route/r-sichuan-lux', owner(travel), { items: { 'route/r-sichuan-lux': SICHUAN_ITEM }, lists });
    const note = e.box.querySelector('[data-field-key="itinerary"] > .field-block-row .count-note');
    const before = [
      note?.textContent,
      note?.classList.contains('is-locked'),
      !!note?.querySelector('svg'),
      e.box.querySelectorAll('[data-field-key="itinerary"] .subitem-tools, [data-field-key="itinerary"] .field-add').length,
      [0, 1, 7].map((i) => nodeOf(e.box, 'itinerary', i)),
    ];
    await typeInto(e.box.querySelector('[data-field-key="intensity.hardest"] input'), '改一处');
    await cmdS();
    await until(() => e.box.querySelector('.detail-issues') !== null);
    await settle();
    eq(
      '已上架线路：区块头右侧「条数随天数锁定，文字可改」（text-2，前置锁），没有上移下移、删除、添加；422 报在第2天的住宿下：第2天的节点有报错',
      [before, nodeOf(e.box, 'itinerary', 1), nodeOf(e.box, 'itinerary', 0)],
      [['条数随天数锁定，文字可改', true, true, 0, ['D1:done', 'D2:done', 'D8:done']], 'D2:error', 'D1:done'],
    );
    await e.unmount();
    api.restore();
    const r = await mountDetail('/catalog/route/r-guizhou-5d', agent(travel), {
      items: { 'route/r-guizhou-5d': { ...GUIZHOU_ITEM, payload: { ...GUIZHOU_5D, days: 6 } } },
      lists: gLists,
    });
    eq(
      '非编辑成员（天数写成 6、行程 5 天）：逐日行程是只读时间轴，没有条数提醒、按钮和复制；每天的卡片是名为「第1天」的组',
      [
        r.box.querySelectorAll('.count-note, .subitem-tools, .field-copy, .field-add').length,
        r.box.querySelectorAll('[data-field-key="itinerary"] .tl-node').length,
        all(r.box, '[data-field-key="itinerary"] .subitem-card').map((c) => `${c.getAttribute('role')}:${c.getAttribute('aria-label')}`),
      ],
      [0, 5, ['group:第1天', 'group:第2天', 'group:第3天', 'group:第4天', 'group:第5天']],
    );
    await r.unmount();
  }

  // 12.5 假包：施工节点（节点里只写序号、卡片第一行「节点3」）、移动、主材的分组联想与复制上一个节点、验收要点的 softMax（80）
  {
    const draft = PKG_ROWS.find((x) => x.status === 'draft')!;
    const p = await mountDetail(`/catalog/package/${draft.code}`, owner(renovationLPage), {
      items: { [`package/${draft.code}`]: { kind: 'package', ord: 0, rev: 1, ...draft } },
      lists: { package: PKG_ROWS, material: MATERIAL_ROWS },
    });
    const name = (i: number) => subEl(p.box, 'nodes', i, 'name')?.querySelector('input')?.value;
    const head3 = itemEl(p.box, 'nodes', 2)?.querySelector('.subitem-head')?.textContent;
    await click(tool(p.box, 'nodes', 0, 'down'));
    const moved = [name(0), name(1)];
    await click(tool(p.box, 'nodes', 1, 'up'));
    // 第4个节点的主材：上一个节点（第3个）用了马可波罗，复制以后一样，按钮没了
    const copy4 = subEl(p.box, 'nodes', 3, 'materials')?.querySelector<HTMLElement>('.field-copy');
    const copyText = copy4?.textContent;
    await click(copy4);
    await settle();
    const mats4 = texts(subEl(p.box, 'nodes', 3, 'materials') ?? p.box, '.ant-select-selection-item');
    // 第1个节点的主材下拉：「主材库」四件、「本条写过的」写第几个节点（第3、4个节点都是马可波罗，只列一次）
    const matInput = () => subEl(p.box, 'nodes', 0, 'materials')?.querySelector('input');
    await openDropdown(matInput());
    const groups = dropdownGroups();
    // 下拉（不能写库外的）同样两组都按输入筛：敲分组标题里的字（「写」「库」）不列整组，敲「马可」两组各剩一项
    const searched: string[][] = [];
    for (const q of ['写', '库', '马可']) {
      await typeInto(matInput(), q);
      await settle();
      searched.push(dropdownGroups());
    }
    await typeInto(matInput(), '');
    await press(matInput(), 'Escape');
    eq('主材的下拉按输入筛：敲「写」「库」（只在分组标题里）什么也不列；敲「马可」两组各剩马可波罗', searched, [
      [],
      [],
      ['#主材库', '马可波罗 800×800 抛釉砖m-marcopolo-800', '#本条写过的', '马可波罗 800×800 抛釉砖第3个节点'],
    ]);
    await typeInto(subEl(p.box, 'nodes', 0, 'checkpoints')?.querySelector('textarea'), '一'.repeat(81));
    const soft = subEl(p.box, 'nodes', 0, 'checkpoints')?.querySelector('.field-soft')?.textContent;
    eq(
      '假包：节点里只写序号、卡片第一行「节点3」；第1个节点下移以后名称换位；「复制上一个节点的用到的主材」写进第4个节点；' +
        '主材联想两组「主材库」「本条写过的」；验收要点超过 80 字提示「手机上会很长（建议80字以内）」',
      [
        [nodeOf(p.box, 'nodes', 2), head3],
        moved,
        [copyText, mats4, subEl(p.box, 'nodes', 3, 'materials')?.querySelector('.field-copy') !== null],
        groups,
        soft,
      ],
      [
        ['3:done', '节点3'],
        ['水电', '拆改'],
        ['复制上一个节点的用到的主材', ['马可波罗 800×800 抛釉砖'], false],
        [
          '#主材库',
          '马可波罗 800×800 抛釉砖m-marcopolo-800',
          '大自然 三层实木复合地板m-daziran-3c',
          '欧派 整体橱柜m-oupai-cab',
          '箭牌 卫浴套装m-jianpai-bath',
          '#本条写过的',
          '马可波罗 800×800 抛釉砖第3个节点',
        ],
        '手机上会很长（建议80字以内）',
      ],
    );
    await p.unmount();
  }

  // 12.6 联想下拉的宽度：宽屏至少 384（G 页）；窄屏（<992）跟输入框一样宽，375 宽的窗口放不下 384
  {
    const popupAt = async (w: number) => {
      win.happyDOM.setViewport({ width: w, height: 800 });
      const m = await mount(
        createElement(RENDERERS.reference.Form, {
          field: HOTEL_F,
          value: '',
          row: GUIZHOU_5D,
          id: 'pw',
          labelId: 'pw-label',
          onChange: () => undefined,
        }),
      );
      const input = m.box.querySelector('input');
      await openDropdown(input);
      const pop = document.querySelector<HTMLElement>('.ant-select-dropdown.ref-popup:not(.ant-select-dropdown-hidden)');
      const got = [pop !== null, pop?.style.width === '384px'];
      await press(input, 'Escape');
      await m.unmount();
      return got;
    };
    const narrowPopup = await popupAt(375);
    const widePopup = await popupAt(1440);
    win.happyDOM.setViewport({ width: 1440, height: 1100 });
    eq(
      '联想的下拉：375 宽时开着、不是 384 宽（跟输入框一样宽）；1440 宽时 384',
      [narrowPopup, widePopup],
      [
        [true, false],
        [true, true],
      ],
    );
  }
  // ---------------- 13. CSV 导入（plan 第 12 步） ----------------
  // spec「CSV 导入（H 页）」、验收 15 第 9 条与验收 19，设计系统 §5.14、§5.5 与 H 页。列、表头别名、防公式前缀与三条上限在
  // src/shared/catalog-csv.ts（前后端共用），弹窗的纯逻辑在 catalog/csv-import.ts，弹窗在 catalog/CsvImportDialog.tsx；
  // 旅游包的酒店与假包的主材走同一套代码
  const CSV_BOM = String.fromCharCode(0xfeff);
  const TAB = String.fromCharCode(9);
  const H_HEAD = '酒店编号,酒店名称,目的地,星级档次,每晚起价,主推房型,酒店亮点,标签';
  const EN_HEAD = 'id,name,destination,stars,nightlyFrom,roomType,highlights,tags';
  /** 设计系统 H 页的 8 行：第 3 行的编号已经有了（data/ 里的松赞梅里），第 6 行的每晚起价把 0 写成了字母 O */
  const H_ROWS = [
    'h-sixsenses-qingcheng,青城山六善酒店,四川,顶奢,3400,山景套房,私汤院落、青城后山徒步,养生',
    'h-jinjiang-chengdu,成都锦江宾馆,四川,五星,900,行政房,老成都地标,城市',
    'h-songtsam-meili,松赞梅里山居,云南,顶奢,4800,雪山景观套房,日照金山,雪山',
    'h-amandayan,大研安缦,云南,顶奢,5200,纳西庭院套房,古城旁的安缦,古城',
    'h-kempinski-guiyang,贵阳凯宾斯基大酒店,贵州,五星,1100,城景房,市中心,城市',
    'h-yunshang-xijiang,云上西江酒店,贵州,精品,"2,6OO",观景吊脚楼房,千户苗寨夜景,苗寨',
    'h-liquan-libo,荔波荔泉宾馆,贵州,五星,800,园景房,小七孔旁,山水',
    'h-songtsam-lhasa,松赞拉萨林卡,西藏,顶奢,3600,布达拉宫景观套房,远眺布达拉宫,藏地',
  ];
  const H_CSV = [H_HEAD, ...H_ROWS].join('\r\n');
  const cellsOfLine = (line: string): string[] => parseCsv(line)[0]!;
  const NO_TABLE: CsvTable = { header: [], keys: [], rows: [] };
  /** 逐行的结果；不是逐行的（整份的问题、空、太大）时记一条具名的失败、给空表，后面的断言照常点名，自测不崩 */
  const tableOf = (c: ReturnType<typeof checkCsv>): CsvTable => {
    check('预检给出逐行的结果', c.kind === 'rows', JSON.stringify(c).slice(0, 200));
    return c.kind === 'rows' ? c.table : NO_TABLE;
  };
  /** 中文 Windows 上 Excel 另存的 GBK 文件（字节由 Python 的 gbk 编码器算出，不经本仓库的代码） */
  const GBK_TEXT = `${H_HEAD}\r\nh-gbk-one,三亚湾酒店,三亚,五星,1680,海景房,私人沙滩,海岛\r\n`;
  const GBK_FILE = Uint8Array.from(
    'bec6b5eab1e0bac52cbec6b5eac3fbb3c62cc4bfb5c4b5d82cd0c7bcb6b5b5b4ce2cc3bfcdedc6f0bcdb2cd6f7cdc6b7bfd0cd2cbec6b5eac1c1b5e32cb1eac7a90d0a682d67626b2d6f6e652cc8fdd1c7cde5bec6b5ea2cc8fdd1c72ccee5d0c72c313638302cbaa3beb0b7bf2ccbbdc8cbc9b3ccb22cbaa3b5ba0d0a'
      .match(/../g)!
      .map((x) => parseInt(x, 16)),
  );

  // 13.1 列与标签：按行业包推出的列与按共用 schema 推出的相同；不能平铺的必填字段让这一类导入不了
  try {
    const hotel = entityCsvShape(HOTEL);
    eq(
      '酒店：按行业包推出的列与按 schema 推出的相同（服务端与前端的列一致）',
      hotel.columns.map((c) => c.key),
      catalogCsvColumns('hotel').columns,
    );
    eq(
      '酒店：每列的写法与必填（数组用「、」分隔，金额是整数）',
      [[...hotel.flat.entries()], [...hotel.required]],
      [
        [
          ['id', 'string'],
          ['name', 'string'],
          ['destination', 'string'],
          ['stars', 'string'],
          ['nightlyFrom', 'integer'],
          ['roomType', 'string'],
          ['highlights', 'strings'],
          ['tags', 'strings'],
        ],
        ['id', 'name', 'destination', 'stars', 'nightlyFrom', 'roomType', 'highlights', 'tags'],
      ],
    );
    eq('酒店：中文标签是表头的别名（服务端要的标签表）', csvLabelsOf(HOTEL), {
      酒店编号: 'id',
      酒店名称: 'name',
      目的地: 'destination',
      星级档次: 'stars',
      每晚起价: 'nightlyFrom',
      主推房型: 'roomType',
      酒店亮点: 'highlights',
      标签: 'tags',
    });
    check(
      '线路：逐日行程必填又不能平铺，和 schema 推出的一样导入不了',
      entityCsvShape(ROUTE).nestedRequired.includes('itinerary') && !catalogCsvColumns('route').importable,
    );
    const pkg = entityCsvShape(PKG);
    eq(
      '假包套餐：每种字段类型的写法（多字段的有序子项不成列，只有一个子字段的按「、」分隔）',
      [[...pkg.flat.entries()], pkg.nestedRequired],
      [
        [
          ['id', 'string'],
          ['title', 'string'],
          ['pricePerSqm', 'integer'],
          ['minArea', 'integer'],
          ['houseTypes', 'strings'],
          ['styles', 'strings'],
          ['startMonths', 'string'],
          ['duration', 'integer'],
          ['demolition', 'boolean'],
          ['materials', 'strings'],
          ['highlights', 'strings'],
        ],
        ['nodes'],
      ],
    );
    const m = entityCsvShape(MATERIAL);
    eq(
      '假包主材：列、必填（环保等级选填）',
      [m.columns.map((c) => c.key), [...m.required]],
      [
        ['id', 'name', 'category', 'brand', 'priceUnit', 'unitPrice', 'warrantyYears', 'ecoGrade'],
        ['id', 'name', 'category', 'brand', 'priceUnit', 'unitPrice', 'warrantyYears'],
      ],
    );
    const liveM = entityCsvShape(LIVE_MATERIAL);
    eq(
      '后加的字段（活的假包）：含软装是一列是否；主材多产地、规格两列，都必填，规格只有一个子字段，按「、」分隔成一列',
      [entityCsvShape(LIVE_PKG).flat.get('softFurnishing'), liveM.columns.map((c) => c.key), [...liveM.required], liveM.flat.get('specs')],
      [
        'boolean',
        ['id', 'name', 'category', 'brand', 'origin', 'specs', 'priceUnit', 'unitPrice', 'warrantyYears', 'ecoGrade'],
        ['id', 'name', 'category', 'brand', 'origin', 'specs', 'priceUnit', 'unitPrice', 'warrantyYears'],
        'strings',
      ],
    );
    const noCode = entityCsvShape({ ...MATERIAL, fields: MATERIAL.fields.filter((f) => f.key !== '$code') });
    eq(
      '字段配置里没写 $code 的实体：编号列照样有，标签取 codeLabel',
      [noCode.columns[0]?.key, noCode.columns[0]?.label, noCode.labels['主材编号'], [...noCode.required][0]],
      ['id', '主材编号', 'id', 'id'],
    );
    const odd = entityCsvShape({
      ...MATERIAL,
      fields: [
        ...MATERIAL.fields,
        { key: 'note', type: 'text', label: '备注', group: 'basic', showWhen: { key: 'ecoGrade', filled: true } },
        {
          key: 'sizes',
          type: 'enum',
          multiple: true,
          storeAs: { join: '/', empty: '—' },
          options: ['大', '小'],
          label: '规格',
          group: 'basic',
        },
        { key: 'parts', type: 'subItems', item: [{ key: '', type: 'intUnit', label: '', group: '' }], label: '件数', group: 'basic' },
      ],
    });
    eq(
      '列的细则：showWhen 管着的按选填算；按字符串存的多选是一格文字；子字段不是文字的单值有序子项不成列',
      [odd.required.has('note'), odd.flat.get('note'), odd.flat.get('sizes'), odd.flat.has('parts'), odd.nestedRequired],
      [false, 'string', 'string', false, ['parts']],
    );
  } catch (e) {
    check('第 13.1 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.2 防公式注入：危险字符开头的格子加一个制表符；导入时只去「制表符 + 危险字符」开头的那一个
  try {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const danger = ['=1+1', '+86', '-1', '@SUM(A1)', `${TAB}x`, `${CR}x`, `${LF}x`, '＝1', '＋1', '－1', '＠a'];
    const safe = ['abc', '1-2', 'a=b', '', ' =1', '五星', '（=）'];
    eq(
      '防公式：= + - @、制表符、回车、换行与全角的 ＝＋－＠ 开头的格子，前面加一个制表符',
      danger.map(guardCell),
      danger.map((x) => `${TAB}${x}`),
    );
    eq('防公式：其余的格子不动', safe.map(guardCell), safe);
    eq(
      '去前缀：guardCell 加的那个去掉，往返不变',
      [...danger, ...safe].map((x) => unguardCell(guardCell(x))),
      [...danger, ...safe],
    );
    eq(
      '去前缀：只去「制表符 + 危险字符」开头的一个制表符；制表符后面不是危险字符的、不在开头的都不动',
      [
        unguardCell(`${TAB}abc`),
        unguardCell(`${TAB}${TAB}=1`),
        unguardCell(`${TAB}=1`),
        unguardCell(`${TAB}＠1`),
        unguardCell(`x${TAB}=1`),
      ],
      [`${TAB}abc`, `${TAB}=1`, '=1', '＠1', `x${TAB}=1`],
    );
  } catch (e) {
    check('第 13.2 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.3 写 CSV 与三条上限
  try {
    const rows = [
      ['a', 'b,c', '说"好"'],
      ['"开头', '第一行\n第二行', ''],
      ['x\r\ny', ' 空格 ', '=1'],
    ];
    eq('写 CSV：含逗号、引号、换行的格子加引号，解析回来逐格相同', parseCsv(toCsv(rows)), rows);
    eq(
      '写 CSV：quoteAll 每格都加引号；默认 \\r\\n 结尾，可以换成 \\n',
      [toCsv([['a', '']], { quoteAll: true }), toCsv([['a'], ['b']], { eol: '\n' })],
      ['"a",""\r\n', 'a\nb\n'],
    );
    const head = ['id', 'name'];
    const many = (n: number, name = '名'): string[][] => Array.from({ length: n }, (_, i) => [`h-${i}`, name]);
    const sent = (n: number, name = '名'): string => toCsv([head, ...many(n, name)], { eol: '\n' });
    eq(
      '上限：200 行一份，201 行两份，401 行三份',
      [csvParts(head, many(200)), csvParts(head, many(201)), csvParts(head, many(401))],
      [1, 2, 3],
    );
    /** 一份放得下的最多行数 */
    const most = (name: string): number => {
      let n = 1;
      while (csvParts(head, many(n + 1, name)) === 1) n += 1;
      return n;
    };
    const long = 'a'.repeat(400);
    const han = '汉'.repeat(300);
    const nChars = most(long);
    const nBytes = most(han);
    eq(
      '上限：按字符数（ASCII 的长行）与按 UTF-8 字节数（中文每字 3 字节）算出的边界正好卡在服务端的闸上',
      [
        sent(nChars, long).length <= CSV_MAX_CHARS,
        sent(nChars + 1, long).length > CSV_MAX_CHARS,
        sent(nBytes, han).length < CSV_MAX_CHARS,
        csvBodyBytes(sent(nBytes, han)) <= CSV_MAX_BODY_BYTES,
        csvBodyBytes(sent(nBytes + 1, han)) > CSV_MAX_BODY_BYTES,
      ],
      [true, true, true, true, true],
    );
    check(
      '上限：请求体的字节数就是 {"csv":…} 的 UTF-8 字节数；放得下的那份 ImportCsvBody 也收',
      csvBodyBytes(sent(nBytes, han)) === Buffer.byteLength(JSON.stringify({ csv: sent(nBytes, han) })) &&
        ImportCsvBody.safeParse({ csv: sent(nChars, long) }).success,
    );
    check(
      '上限：字符数与服务端的 ImportCsvBody 相同',
      ImportCsvBody.safeParse({ csv: 'x'.repeat(CSV_MAX_CHARS) }).success &&
        !ImportCsvBody.safeParse({ csv: 'x'.repeat(CSV_MAX_CHARS + 1) }).success,
    );
    // 一行连同表头单独一份也超上限：分成几份也不行。边界与提交的写法相同（表头加这一行，\n 结尾）
    const alone = (cell: string): string => toCsv([head, ['h', cell]], { eol: '\n' });
    const fitC = 'a'.repeat(CSV_MAX_CHARS - alone('').length);
    // 中文每字 3 字节，再补两个 ASCII：请求体正好 64KB
    const fitB = `${'汉'.repeat(21_837)}ab`;
    eq(
      '一行太长：按字符数、按字节数，正好卡在上限上的不算，多一个字就算；点名的是这些行',
      [
        csvLongRows(head, [
          ['h', fitC],
          ['h', `${fitC}a`],
          ['h', fitB],
          ['h', `${fitB}a`],
        ]),
        alone(fitC).length,
        csvBodyBytes(alone(fitB)),
        csvLongRows(head, many(250)),
      ],
      [[2, 4], CSV_MAX_CHARS, CSV_MAX_BODY_BYTES, []],
    );
    eq(
      '一行太长：要分几份是 Infinity（以前它独占一份，算出来是「1份」），放得下的照旧',
      [csvParts(head, [...many(3), ['h', `${fitB}汉`], ...many(2)]), csvParts(head, [['h', fitC]]), csvParts(head, [['h', fitB]])],
      [Infinity, 1, 1],
    );
  } catch (e) {
    check('第 13.3 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.4 解码：先 UTF-8 严格解码，不成再 GBK；都解不开才拒收
  try {
    // 解不开时不崩：记成一种编码写着抛了什么，下面的断言照常点名
    const safeRead = (b: Uint8Array) => {
      try {
        return readCsvBytes(b);
      } catch (e) {
        return { encoding: `抛了 ${String(e)}`, text: '' };
      }
    };
    const utf = safeRead(new TextEncoder().encode(`${CSV_BOM}${GBK_TEXT}`));
    eq('解码：UTF-8（带 BOM）按 UTF-8 读，BOM 去掉', [utf.encoding, utf.text === GBK_TEXT], ['utf-8', true]);
    const gbk = safeRead(GBK_FILE);
    eq('解码：Excel 在中文 Windows 上另存的 GBK 按 GBK 读，中文不乱码', [gbk.encoding, gbk.text === GBK_TEXT], ['gbk', true]);
    const thrown = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return null;
    };
    const bad = thrown(() => readCsvBytes(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])));
    check(
      '解码：UTF-8 和 GBK 都解不开 → CsvEncodingError，说明怎么另存',
      bad instanceof CsvEncodingError && bad.message.includes('GBK') && bad.message.includes('CSV UTF-8'),
    );
    check('01 的 decodeCsvFile 不变：GBK 照旧拒收', thrown(() => decodeCsvFile(GBK_FILE)) instanceof CsvEncodingError);
  } catch (e) {
    check('第 13.4 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.5 预检：H 页的 8 行（编号已经有了、数写错）；英文表头与中文表头相同；只导入合格的行；下载不合格的行
  try {
    const t = tableOf(checkCsv(HOTEL, H_CSV, HOTEL_ROWS))!;
    eq(
      'H 页：第3行编号已经有了，写出名称和状态；第6行每晚起价写错，记下原样的格子；其余合格',
      t.rows.map((r) => r.issues),
      [
        [],
        [],
        [{ col: 'id', text: '酒店编号：这个编号已经有了（松赞梅里山居，已上架）' }],
        [],
        [],
        [{ col: 'nightlyFrom', text: '每晚起价：要写整数，写的是「2,6OO」', raw: '2,6OO' }],
        [],
        [],
      ],
    );
    eq(
      'H 页：汇总与两个按钮（不放禁用的「全部导入」）',
      [csvSummary(t), importLabel(t), downloadLabel(t)],
      [
        { tone: 'warning', title: '6行可以导入，2行要改', note: '要改的格子已标出，原因写在最后一列。导入的都是草稿，逐条检查后再上架' },
        '只导入合格的6行',
        '下载不合格的2行（带原因）',
      ],
    );
    const allGood = tableOf(checkCsv(HOTEL, [H_HEAD, H_ROWS[0], H_ROWS[1]].join('\n'), HOTEL_ROWS));
    const allBad = tableOf(checkCsv(HOTEL, [H_HEAD, H_ROWS[2], H_ROWS[5]].join('\n'), HOTEL_ROWS));
    eq(
      '汇总：全部合格是 info「2行都可以导入」、主按钮「导入2条草稿」；全部要改是 warning「2行都要改」，说改好后换一个文件',
      [csvSummary(allGood), importLabel(allGood), csvSummary(allBad)],
      [
        { tone: 'info', title: '2行都可以导入', note: '导入的都是草稿，逐条检查后再上架' },
        '导入2条草稿',
        { tone: 'warning', title: '2行都要改', note: '要改的格子已标出，原因写在最后一列。改好后换一个文件再导入' },
      ],
    );
    eq('H 页：表格的字段列（名称与编号合成首列，数组不画），金额的单位写进表头', tableFields(HOTEL, t.keys).map(tableHeader), [
      '目的地',
      '星级档次',
      '每晚起价（元）',
      '主推房型',
    ]);
    const price = fieldOf(HOTEL, 'nightlyFrom');
    eq(
      'H 页：数按列表的写法，写错的照原样，编号照原样',
      [cellText(price, t.rows[0]!, t.keys), cellText(price, t.rows[5]!, t.keys), cellText(fieldOf(HOTEL, '$code'), t.rows[2]!, t.keys)],
      ['3,400', '2,6OO', 'h-songtsam-meili'],
    );
    eq(
      'H 页的列宽：行号、结果定宽，名称与编号、各字段按内容估（设计系统 H 页的 174 / 58 / 68 / 107 / 128 上下），加上原因的最小宽度放得进 880 的弹窗（832）',
      resultWidths(HOTEL, t),
      { title: 174, fields: { destination: 55, stars: 68, nightlyFrom: 107, roomType: 128 }, total: 814 },
    );
    eq('形似数字的字母：「2,6OO」的两个 O 各自标出', lookalikeParts('2,6OO'), [
      { text: '2,6', mark: false },
      { text: 'O', mark: true },
      { text: 'O', mark: true },
    ]);
    const en = tableOf(checkCsv(HOTEL, [EN_HEAD, ...H_ROWS].join('\n'), HOTEL_ROWS));
    check(
      '英文表头：payload（含键序）与问题都和中文表头的相同',
      JSON.stringify(en?.rows.map((r) => [r.payload, r.issues])) === JSON.stringify(t.rows.map((r) => [r.payload, r.issues])),
    );
    const sub = csvSubmission(t);
    eq(
      '只导入合格的6行：提交表头和合格的6行（原样的格子，\\n 结尾），记下它们原来的行号',
      [parseCsv(sub.csv), sub.csv.includes('\r'), sub.rows, sub.fits],
      [[H_HEAD.split(','), ...[0, 1, 3, 4, 6, 7].map((i) => cellsOfLine(H_ROWS[i]!))], false, [1, 2, 4, 5, 7, 8], true],
    );
    const failed = failedCsv(t);
    eq(
      '下载不合格的行：带 BOM；表头加「不合格原因」；2 行，原因在最后一列',
      [failed.startsWith(CSV_BOM), parseCsv(failed)],
      [
        true,
        [
          [...H_HEAD.split(','), '不合格原因'],
          [...cellsOfLine(H_ROWS[2]!), '酒店编号：这个编号已经有了（松赞梅里山居，已上架）'],
          [...cellsOfLine(H_ROWS[5]!), '每晚起价：要写整数，写的是「2,6OO」'],
        ],
      ],
    );
    check(
      '下载不合格的行：每格都加双引号',
      failed
        .slice(1)
        .split('\r\n')
        .filter(Boolean)
        .every((line) => line.split('","').length === 9 && line.startsWith('"') && line.endsWith('"')),
      failed,
    );
    eq(
      '文件名：模板「酒店导入模板.csv」；不合格的行接在原文件名后面，粘贴的用实体名',
      [
        templateName(HOTEL),
        failedName(HOTEL, { name: '新签酒店-9月.csv', encoding: 'utf-8', text: '' }, 2),
        failedName(HOTEL, { name: null, encoding: null, text: '' }, 3),
      ],
      ['酒店导入模板.csv', '新签酒店-9月-不合格的2行.csv', '酒店-不合格的3行.csv'],
    );

    // 验收 19：以「=」开头的格子在引号内带制表符前缀；改好重新导入，前缀不进数据；再下载一次也不叠加
    const evil = tableOf(checkCsv(HOTEL, [EN_HEAD, 'h-evil,=HYPERLINK("http://x"),三亚,＋五星,一千,@房,亮点,'].join('\n'), HOTEL_ROWS))!;
    const file = failedCsv(evil);
    check(
      '防公式注入：以 =、全角＋、@ 开头的格子在引号内带制表符前缀',
      file.includes(`"${TAB}=HYPERLINK(""http://x"")"`) && file.includes(`"${TAB}＋五星"`) && file.includes(`"${TAB}@房"`),
      file,
    );
    const again = tableOf(checkCsv(HOTEL, file.replace('一千', '1000'), HOTEL_ROWS));
    eq(
      '改好以后原样重新导入：合格，防公式前缀与「不合格原因」列都不进数据',
      again?.rows.map((r) => [r.issues, r.payload.name, r.payload.stars, r.payload.roomType, Object.keys(r.payload)]),
      [
        [
          [],
          '=HYPERLINK("http://x")',
          '＋五星',
          '@房',
          ['id', 'name', 'destination', 'stars', 'nightlyFrom', 'roomType', 'highlights', 'tags'],
        ],
      ],
    );
    eq('改好以后重新导入：提交时去掉「不合格原因」列', again && parseCsv(csvSubmission(again).csv)[0], EN_HEAD.split(','));
    const short = failedCsv(tableOf(checkCsv(HOTEL, [EN_HEAD, 'h-short,名'].join('\n'), HOTEL_ROWS))!);
    eq('少了格子的行：补空格子，原因仍在最后一列', parseCsv(short)[1], ['h-short', '名', '', '', '', '', '', '', '有 2 列，表头有 8 列']);
    const extra = parseCsv(failedCsv(tableOf(checkCsv(HOTEL, [EN_HEAD, 'h-a,名,三亚,五星,100,房,亮点,,多一格'].join('\n'), HOTEL_ROWS))));
    eq('多了格子的行：原因仍在「不合格原因」那一列，多出来的格子照原样放在它右边', extra, [
      [...EN_HEAD.split(','), '不合格原因'],
      ['h-a', '名', '三亚', '五星', '100', '房', '亮点', '', '有 9 列，表头有 8 列', '多一格'],
    ]);
    const yesNo = tableOf(checkCsv(PKG, ['id,demolition', 'p-x,也许'].join('\n')))!;
    eq('是否写错：说明写法，不标形似数字的字母（只有数值格标）', yesNo.rows[0]!.issues[0], {
      col: 'demolition',
      text: '拆旧：要写「是」或「否」，写的是「也许」',
    });
    const twice = failedCsv(tableOf(checkCsv(HOTEL, file, HOTEL_ROWS))!);
    check(
      '再下载一次：前缀不叠加，旧的原因列换成新的',
      twice.includes(`"${TAB}=HYPERLINK`) &&
        !twice.includes(`"${TAB}${TAB}=`) &&
        parseCsv(twice)[0]!.filter((h) => h === '不合格原因').length === 1,
      twice,
    );
  } catch (e) {
    check('第 13.5 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.6 预检：空文件、整份的问题、上限、逐行的各种问题；假包主材；服务端 422 的问题放回原来的行；填写规则与模板
  try {
    eq(
      '空文件、只有表头、表头加空行：停在第2步',
      [checkCsv(HOTEL, ''), checkCsv(HOTEL, H_HEAD), checkCsv(HOTEL, `${H_HEAD}\r\n\r\n,,,,,,,\r\n`)].map((c) => c.kind),
      ['empty', 'empty', 'empty'],
    );
    eq(
      '整份的问题：没有的字段、缺编号列、中文标签与字段名重复、字段名重复、没闭合的引号',
      [
        checkCsv(HOTEL, `${H_HEAD},nope\r\n${H_ROWS[0]},x`),
        checkCsv(HOTEL, '酒店名称\r\n名'),
        checkCsv(HOTEL, `id,${H_HEAD}\r\nh-x,${H_ROWS[0]}`),
        checkCsv(HOTEL, `${EN_HEAD},name\r\n${H_ROWS[0]},x`),
        checkCsv(HOTEL, `${H_HEAD}\r\n"h-x,名`),
      ],
      [
        { kind: 'whole', rows: 1, lines: ['「nope」没有这个字段'] },
        { kind: 'whole', rows: 1, lines: ['「酒店编号」这一列不能少'] },
        { kind: 'whole', rows: 1, lines: ['「酒店编号」表头重复'] },
        { kind: 'whole', rows: 1, lines: ['「酒店名称」表头重复'] },
        { kind: 'whole', rows: null, lines: ['有一个双引号没有闭合'] },
      ],
    );
    const rows250 = Array.from({ length: 250 }, (_, i) => `h-big-${i},名${i},三亚,五星,100,房,亮点,`);
    eq('250 行：在前端就要分份（验收 19）', checkCsv(HOTEL, [H_HEAD, ...rows250].join('\n'), HOTEL_ROWS), {
      kind: 'big',
      rows: 250,
      parts: 2,
    });
    const hugeRow = `h-huge,${'汉'.repeat(22_000)},三亚,五星,100,房,亮点,`;
    eq(
      '有一行连同表头单独一份也超上限：不是「请分成N份」，点名这一行，不画表格（250 行里也有它时先说它）',
      [
        checkCsv(HOTEL, [H_HEAD, H_ROWS[0], hugeRow].join('\n'), HOTEL_ROWS),
        checkCsv(HOTEL, [H_HEAD, ...rows250, hugeRow].join('\n'), HOTEL_ROWS).kind,
      ],
      [{ kind: 'long', rows: 2, long: [2] }, 'long'],
    );
    eq(
      '太长的行：标题写出行号（最多三个），说明写上限',
      [longTitle([2]), longTitle([2, 5, 7]), longTitle([2, 5, 7, 9]), longNote(1), longNote(2)],
      [
        '第2行太长，分成几份也导入不了',
        '第2、5、7行太长，分成几份也导入不了',
        '第2、5、7行等4行太长，分成几份也导入不了',
        '一次最多导入200行，整份不超过60,000个字、64KB。这一行连同表头单独一份也超了',
        '一次最多导入200行，整份不超过60,000个字、64KB。这几行连同表头单独一份也超了',
      ],
    );
    const hugeTable: CsvTable = {
      header: EN_HEAD.split(','),
      keys: EN_HEAD.split(','),
      rows: [{ row: 1, cells: cellsOfLine(hugeRow), payload: {}, issues: [] }],
    };
    check('提交：合格的行放不下时 fits 为假（弹窗据此不发请求）', !csvSubmission(hugeTable).fits);
    const odd = tableOf(
      checkCsv(
        HOTEL,
        [
          H_HEAD,
          'h-a,,三亚,五星,100,房,亮点,',
          'h-b,名,三亚,五星,100,房,,',
          'H_BAD,名,三亚,五星,100,房,亮点,',
          'h-a,名,三亚,五星,100,房,亮点,',
          'h-c,名,三亚,五星,0,房,亮点,',
          'h-d,名,三亚,五星,100,房,亮点,,多一格',
        ].join('\n'),
        HOTEL_ROWS,
      ),
    );
    eq(
      '逐行的问题：上架前检查的写法（没填、至少1条、编号规则、大于0），文件内编号重复点名前一行，列数不对是整行的问题',
      odd?.rows.map((r) => r.issues),
      [
        [{ col: 'name', text: '酒店名称：没填' }],
        [{ col: 'highlights', text: '酒店亮点：至少1条' }],
        [{ col: 'id', text: `酒店编号：${CODE_RULE}` }],
        [{ col: 'id', text: '酒店编号：和第1行重复' }],
        [{ col: 'nightlyFrom', text: '每晚起价：要是大于0的整数' }],
        [{ col: null, text: '有 9 列，表头有 8 列' }],
      ],
    );
    check('列表还没取到：不查编号是否已经有了（服务端兜底）', tableOf(checkCsv(HOTEL, H_CSV))!.rows[2]!.issues.length === 0);
    const withDraft: ListRow[] = [
      ...HOTEL_ROWS,
      { code: 'h-draft-one', status: 'draft', payload: { id: 'h-draft-one', name: '草稿里的酒店' } },
    ];
    eq(
      '编号撞上已有的草稿：写「（名称，草稿）」',
      tableOf(checkCsv(HOTEL, [H_HEAD, 'h-draft-one,名,三亚,五星,100,房,亮点,'].join('\n'), withDraft)).rows[0]?.issues,
      [{ col: 'id', text: '酒店编号：这个编号已经有了（草稿里的酒店，草稿）' }],
    );

    const M_HEAD = '主材编号,主材名称,品类,品牌,计价单位,单价,质保,环保等级';
    const mt = tableOf(
      checkCsv(
        MATERIAL,
        [
          M_HEAD,
          'm-dongpeng-750,东鹏 750×1500 岩板,瓷砖,东鹏,㎡,328,5,',
          'm-marcopolo-800,马可波罗 800×800 抛釉砖,瓷砖,马可波罗,㎡,168,5,E0级',
          'm-x,某,石材,某牌,㎡,100,5,',
          'm-y,某,瓷砖,某牌,㎡,100,五年,',
        ].join('\n'),
        MATERIAL_ROWS,
      ),
    )!;
    eq(
      '假包主材：同一套检查（选填的环保等级空着合格；编号已经有了；不在可选项里；质保写成汉字）',
      mt.rows.map((r) => r.issues),
      [
        [],
        [{ col: 'id', text: '主材编号：这个编号已经有了（马可波罗 800×800 抛釉砖，已上架）' }],
        [{ col: 'category', text: '品类：不在可选项里' }],
        [{ col: 'warrantyYears', text: '质保：要写整数，写的是「五年」', raw: '五年' }],
      ],
    );
    eq(
      '假包主材：表格的字段列与写法（单价的单位跟着计价单位，写在格子里）',
      [
        tableFields(MATERIAL, mt.keys).map(tableHeader),
        cellText(fieldOf(MATERIAL, 'unitPrice'), mt.rows[0]!, mt.keys),
        cellText(fieldOf(MATERIAL, 'warrantyYears'), mt.rows[0]!, mt.keys),
        mt.rows[0]!.payload,
      ],
      [
        ['品类', '品牌', '计价单位', '单价', '质保', '环保等级'],
        '328元/㎡',
        '5年',
        {
          id: 'm-dongpeng-750',
          name: '东鹏 750×1500 岩板',
          category: '瓷砖',
          brand: '东鹏',
          priceUnit: '㎡',
          unitPrice: 328,
          warrantyYears: 5,
        },
      ],
    );
    // 后加的产地、规格（活的假包）：新模板多两列，照样逐行检查；后加以前下载的旧模板没有这两列，每行照上架前检查报两项没填
    const LIVE_M_HEAD = '主材编号,主材名称,品类,品牌,产地,规格,计价单位,单价,质保,环保等级';
    const lmt = tableOf(
      checkCsv(
        LIVE_MATERIAL,
        [
          LIVE_M_HEAD,
          'm-dongpeng-750,东鹏 750×1500 岩板,瓷砖,东鹏,广东东莞,750×1500、600×1200,㎡,328,5,',
          'm-y,某,瓷砖,某牌,,某规格,㎡,100,5,',
        ].join('\n'),
        MATERIAL_ROWS,
      ),
    )!;
    eq(
      '后加的产地、规格：表格多一列产地（规格按「、」分隔，不成列），规格拆成几种；产地空着报「没填」',
      [tableFields(LIVE_MATERIAL, lmt.keys).map(tableHeader), lmt.rows[0]!.payload, lmt.rows[1]!.issues],
      [
        ['品类', '品牌', '产地', '计价单位', '单价', '质保', '环保等级'],
        {
          id: 'm-dongpeng-750',
          name: '东鹏 750×1500 岩板',
          category: '瓷砖',
          brand: '东鹏',
          origin: '广东东莞',
          specs: ['750×1500', '600×1200'],
          priceUnit: '㎡',
          unitPrice: 328,
          warrantyYears: 5,
        },
        [{ col: 'origin', text: '产地：没填' }],
      ],
    );
    eq(
      '后加字段以前的旧模板：每行报「产地：没填」「规格：没填」（不是整份表头的问题）',
      tableOf(checkCsv(LIVE_MATERIAL, [M_HEAD, 'm-a,某,瓷砖,某牌,㎡,100,5,'].join('\n')))?.rows[0]?.issues,
      [
        { col: 'origin', text: '产地：没填' },
        { col: 'specs', text: '规格：没填' },
      ],
    );

    const t = tableOf(checkCsv(HOTEL, H_CSV, HOTEL_ROWS))!;
    const merged = withServerIssues(HOTEL, t, csvSubmission(t).rows, [
      { row: 2, issues: [{ path: 'id', message: '这个编号已经有了' }] },
      { row: 3, issues: [{ path: 'highlights.0', message: 'Too small: expected string to have >=1 characters' }] },
      { row: 0, issues: [{ path: '', message: '一次最多导入 200 行，这份有 201 行' }] },
    ]);
    eq(
      '服务端 422：逐行的问题放回原来的行（提交的第2、3行是原来的第2、4行）；英文说明写「格式不对」；第0行的单独给出',
      [
        merged.table.rows[1]!.issues,
        merged.table.rows[3]!.issues,
        merged.whole,
        merged.table.rows.filter((r) => !r.issues.length).map((r) => r.row),
      ],
      [
        [{ col: 'id', text: '酒店编号：这个编号已经有了' }],
        [{ col: 'highlights', text: '酒店亮点第1条：格式不对' }],
        ['一次最多导入 200 行，这份有 201 行'],
        [1, 5, 7, 8],
      ],
    );

    const meili = HOTELS.find((h) => h.id === 'h-songtsam-meili')!;
    eq(
      '第1步的规则：表头、选填、怎么填；例子照着已有的一条写，编号写示例编号',
      csvRules(travel, HOTEL, meili).map((r) => [r.label, r.optional, r.how, r.example]),
      [
        ['酒店编号', false, CODE_RULE, 'h-songtsam-meili'],
        ['酒店名称', false, '文字', '松赞梅里山居'],
        ['目的地', false, '文字', '云南'],
        ['星级档次', false, '文字', '顶奢'],
        ['每晚起价', false, '整数（元），不写逗号', '4800'],
        ['主推房型', false, '文字', '雪山景观套房'],
        ['酒店亮点', false, '可以写几条，用「、」分隔，至少1条', (meili.highlights as string[]).join('、')],
        ['标签', false, '可以写几个，用「、」分隔', '雪山、藏地、秘境'],
      ],
    );
    eq(
      '第1步的规则：还没有条目时，例子取 placeholder「例：」后面的，没有就空着',
      csvRules(travel, HOTEL).map((r) => r.example),
      ['h-songtsam-meili', null, null, '五星、顶奢', null, '水上别墅', null, null],
    );
    eq(
      '第1步的规则：假包套餐的各种类型（多选、单位、月份、是否、引用、单值的有序子项）',
      csvRules(renovationLPage, PKG).map((r) => r.how),
      [
        CODE_RULE,
        '文字',
        '整数（元），不写逗号',
        '整数（㎡）',
        '一居、两居、三居、四居及以上、别墅，可以写几个，用「、」分隔',
        '可以写几个，用「、」分隔',
        '写出月份，如「6-9月」「11月-次年4月」，或写「全年」',
        '整数（天）',
        '写「是」（含拆旧）或「否」（不含拆旧）',
        '写主材的编号，可以写几个，用「、」分隔',
        '可以写几条，用「、」分隔',
      ],
    );
    eq(
      '第1步的规则：假包主材（单选写其中一个，选填标出）',
      csvRules(renovationLPage, MATERIAL).map((r) => [r.how, r.optional]),
      [
        [CODE_RULE, false],
        ['文字', false],
        ['瓷砖、地板、橱柜、卫浴、门窗、涂料，写其中一个', false],
        ['文字', false],
        ['㎡、延米、件、套，写其中一个', false],
        ['整数（元），不写逗号', false],
        ['整数（年）', false],
        ['ENF级、E0级、E1级，写其中一个', true],
      ],
    );
    eq(
      '第1步的规则：后加的含软装没配两种文字，写「是」或「否」；产地是文字，规格可以写几种，例子照着已有的一件写',
      [
        csvRules(renovation, LIVE_PKG).find((r) => r.label === '含软装')?.how,
        csvRules(renovation, LIVE_MATERIAL, MATERIALS[0])
          .filter((r) => r.label === '产地' || r.label === '规格')
          .map((r) => [r.label, r.optional, r.how, r.example]),
      ],
      [
        '写「是」或「否」',
        [
          ['产地', false, '文字', '广东东莞'],
          ['规格', false, '可以写几种，用「、」分隔', '800×800'],
        ],
      ],
    );
    eq(
      '模板：带 BOM，只有一行表头，写字段的中文标签',
      [templateCsv(HOTEL), templateCsv(MATERIAL)],
      [`${CSV_BOM}${H_HEAD}\r\n`, `${CSV_BOM}${M_HEAD}\r\n`],
    );
    check('模板填上一行就能导入', tableOf(checkCsv(HOTEL, `${templateCsv(HOTEL)}${H_ROWS[0]}`, HOTEL_ROWS))?.rows[0]?.issues.length === 0);
    eq('后加字段的主材模板：表头多产地、规格两列', templateCsv(LIVE_MATERIAL), `${CSV_BOM}${LIVE_M_HEAD}\r\n`);
    check(
      '后加字段的主材模板填上一行就能导入',
      tableOf(checkCsv(LIVE_MATERIAL, `${templateCsv(LIVE_MATERIAL)}m-a,某,瓷砖,某牌,某地,甲、乙,㎡,100,5,`, MATERIAL_ROWS))?.rows[0]
        ?.issues.length === 0,
    );
  } catch (e) {
    check('第 13.6 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }

  // 13.7 弹窗（挂整页：路由、查询缓存、假接口）：五步、空文件、GBK、H 页、下载、只导入合格的、422、连不上、完成、太大、粘贴、假包
  try {
    async function mountList(path: string, viewer: Viewer, lists: Readonly<Record<string, readonly ListRow[]>>) {
      const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
      qc.setQueryData(VIEWER_KEY, viewer);
      for (const [kind, items] of Object.entries(lists)) qc.setQueryData(['catalog', kind], { items });
      const root = createRootRoute({ component: Outlet });
      const tree = root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/catalog/$kind', validateSearch: catalogSearch, component: CatalogPage }),
      ]);
      const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
      await router.load();
      const m = await mount(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      return { ...m, router, qc };
    }
    const D = '.csv-dialog';
    const modal = () => document.querySelector<HTMLElement>(`${D} .ant-modal`);
    const stepNow = () => document.querySelector(`${D} .csv-step[aria-current="step"] .csv-step-name`)?.textContent;
    const squash = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '');
    const footer = () => all<HTMLElement>(document, `${D} .csv-footer button`).map((b) => squash(b.textContent));
    const btn = (label: string) => all<HTMLButtonElement>(document, `${D} button`).find((b) => squash(b.textContent) === label);
    const fileRow = () => document.querySelector(`${D} .csv-file-row`)?.textContent;
    const readError = () => document.querySelector(`${D} .csv-read-error`)?.textContent ?? null;
    const alertTitles = () => texts(document, `${D} .csv-body .ant-alert-title`);
    const resultRows = () => all<HTMLTableRowElement>(document, `${D} .csv-results tbody tr.ant-table-row`);
    const pick = async (name: string, data: Uint8Array<ArrayBuffer> | string) => {
      const input = document.querySelector<HTMLInputElement>(`${D} input[type="file"]`);
      if (!input) {
        check(`选文件：这一步有文件框（${name}）`, false, `在第「${stepNow()}」步`);
        return;
      }
      const file = new File([typeof data === 'string' ? new TextEncoder().encode(data) : data], name, { type: 'text/csv' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      const before = `${stepNow()}|${fileRow()}|${readError()}`;
      await act(async () => {
        input.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
      });
      await until(() => `${stepNow()}|${fileRow()}|${readError()}` !== before);
    };
    // 下载：接住 Blob 和文件名，读出原样的字节（Blob.text() 会吞掉 BOM）
    const downloads: { name: string; bytes: Uint8Array }[] = [];
    const reads: Promise<void>[] = [];
    let lastBlob: Blob | null = null;
    const realCreate = URL.createObjectURL;
    const realClick = (win.HTMLAnchorElement.prototype as unknown as { click(): void }).click;
    URL.createObjectURL = (b: Blob) => {
      lastBlob = b;
      return 'blob:csv-selftest';
    };
    const anchor = win.HTMLAnchorElement.prototype as unknown as { click(this: { download: string }): void };
    anchor.click = function () {
      const name = this.download;
      const b = lastBlob!;
      reads.push(b.arrayBuffer().then((buf) => void downloads.push({ name, bytes: new Uint8Array(buf) })));
    };
    const lastDownload = async () => {
      await Promise.all(reads);
      const d = downloads.at(-1);
      return d
        ? { name: d.name, head: Array.from(d.bytes.subarray(0, 3)), text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(d.bytes) }
        : null;
    };

    let reply: (s: { method: string; url: string; body: unknown }) => Response | Promise<Response> | undefined = () => undefined;
    const api = fakeApi((s) => (s.method === 'POST' ? reply(s) : undefined));
    const posts = () => api.sent.filter((x) => x.method === 'POST');
    const csvSent = (i: number) => parseCsv(((posts()[i]?.body ?? {}) as { csv?: string }).csv ?? '');

    // 带着搜索与筛选进来：「去草稿页签」要把它们清掉
    const searched = `/catalog/hotel?q=${encodeURIComponent('松赞')}&f=${encodeURIComponent('destination:云南')}`;
    const pg = await mountList(searched, owner(travel), { hotel: HOTEL_ROWS });
    eq('进来时地址带着搜索与筛选', pg.router.state.location.search, { q: '松赞', f: ['destination:云南'] });
    const openBtn = () => all<HTMLButtonElement>(pg.box, '.page-actions button').find((b) => squash(b.textContent) === '导入CSV');
    check('打开之前没有下载弹窗的块、没有挂弹窗', modal() === null);
    await click(openBtn());
    await until(() => modal() !== null);
    await motion();
    eq(
      '第1步：标题写出对象，步骤条五步、当前是第1步，880 宽',
      [
        document.querySelector(`${D} .ant-modal-title`)?.textContent,
        texts(document, `${D} .csv-step-name`),
        stepNow(),
        modal()?.style.width,
      ],
      ['从CSV导入酒店', ['下载模板', '选文件', '校验结果', '导入', '完成'], '下载模板', '880px'],
    );
    eq(
      '第1步：规则表每列一行（表头、怎么填、例子取列表的第一条），右下主按钮「选文件」，默认焦点在「下载模板」',
      [
        texts(document, `${D} .csv-rules tbody tr.ant-table-row td:first-child`),
        texts(document, `${D} .csv-rules tbody tr.ant-table-row td:last-child`)[1],
        footer(),
        document.activeElement === btn('下载模板'),
      ],
      [['酒店编号', '酒店名称', '目的地', '星级档次', '每晚起价', '主推房型', '酒店亮点', '标签'], HOTELS[0]!.name, ['选文件'], true],
    );
    const rulesTable = document.querySelector<HTMLTableElement>(`${D} .csv-rules table`);
    eq(
      '第1步：规则表是固定布局（例子再长也撑不开弹窗，只占一行），至少 600 宽，窄屏时在自己的容器里横向滚动；表头、例子定宽',
      [
        rulesTable?.style.tableLayout,
        rulesTable?.style.width,
        rulesTable?.style.minWidth,
        all<HTMLElement>(document, `${D} .csv-rules col`).map((c) => c.style.width),
      ],
      ['fixed', '600px', '100%', ['180px', '', '220px']],
    );
    await click(btn('下载模板'));
    eq('下载模板：文件名、UTF-8 带 BOM、只有一行中文表头', await lastDownload(), {
      name: '酒店导入模板.csv',
      head: [0xef, 0xbb, 0xbf],
      text: `${CSV_BOM}${H_HEAD}\r\n`,
    });

    await click(btn('选文件'));
    eq(
      '第2步：「选文件」「粘贴」两个页签，焦点在「选择文件」，底栏只有「上一步」',
      [stepNow(), texts(document, `${D} .ant-tabs-tab`), document.activeElement === btn('选择文件'), footer()],
      ['选文件', ['选文件', '粘贴'], true, ['上一步']],
    );
    await pick('空.csv', '');
    eq(
      '空文件：停在第2步，文件行下写「这份文件没有要导入的行」，没有导入按钮',
      [stepNow(), fileRow(), readError(), footer()],
      ['选文件', '空.csv按UTF-8读取·0行', '这份文件没有要导入的行', ['上一步']],
    );
    check('文件行下的那一句是 alert：读屏立刻念出来', document.querySelector(`${D} .csv-read-error`)?.getAttribute('role') === 'alert');
    await pick('只有表头.csv', `${CSV_BOM}${H_HEAD}\r\n`);
    eq('只有表头：同样停在第2步', [stepNow(), fileRow(), readError()], ['选文件', '只有表头.csv按UTF-8读取·0行', '这份文件没有要导入的行']);
    await pick('乱码.csv', Uint8Array.from([0xff, 0xfe, 0x41, 0x00]));
    check(
      '解不开的文件：停在第2步，说明怎么另存',
      stepNow() === '选文件' && fileRow() === '乱码.csv' && (readError() ?? '').includes('CSV UTF-8'),
      `${fileRow()} ${readError()}`,
    );
    // 拖放：在拖放区上发 dragover 与 drop，dataTransfer 里放 GBK 文件
    const zone = document.querySelector<HTMLElement>(`${D} .csv-drop`) ?? document.createElement('div');
    const dropEvent = (type: string) => {
      const ev = new win.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
      Object.defineProperty(ev, 'dataTransfer', { value: { files: [new File([GBK_FILE], '新签酒店-GBK.csv', { type: 'text/csv' })] } });
      return ev;
    };
    await act(async () => void zone.dispatchEvent(dropEvent('dragover')));
    const over = zone.className;
    await act(async () => void zone.dispatchEvent(dropEvent('drop')));
    await until(() => stepNow() === '校验结果');
    check('拖进来时拖放区换成 is-over', over.includes('is-over'), over);
    eq(
      'GBK 文件（验收 19）：拖进来就进第3步，文件行写「按GBK读取」，中文照常',
      [stepNow(), fileRow(), resultRows().map((r) => r.querySelector('.csv-title-name')?.textContent)],
      ['校验结果', '新签酒店-GBK.csv按GBK读取·1行换一个文件', ['三亚湾酒店']],
    );
    check('第3步：焦点在这一步的内容上', document.activeElement === document.querySelector(`${D} .csv-body`));
    await click(btn('换一个文件'));
    check('「换一个文件」回到第2步，文件行清掉', stepNow() === '选文件' && fileRow() === undefined);

    await pick('新签酒店-9月.csv', `${CSV_BOM}${H_CSV}`);
    eq(
      'H 页：文件行、汇总（warning）与说明',
      [fileRow(), alertTitles(), document.querySelector(`${D} .csv-body .ant-alert`)?.className.includes('ant-alert-warning')],
      ['新签酒店-9月.csv按UTF-8读取·8行换一个文件', ['6行可以导入，2行要改'], true],
    );
    eq(
      'H 页：表头（名称与编号合成一列，金额的单位写进表头）',
      texts(document, `${D} .csv-results thead th:not(.ant-table-cell-scrollbar)`),
      ['行号', '结果', '酒店名称·编号', '目的地', '星级档次', '每晚起价（元）', '主推房型', '原因'],
    );
    const hr = resultRows();
    eq(
      'H 页：8 行的结果；第3行编号格标出、第6行每晚起价格标出，原因写在最后一列',
      [
        hr.map((r) => squash(r.querySelector('.csv-result')?.textContent)),
        squash(hr[2]?.querySelector('.csv-title-code .csv-bad')?.textContent),
        squash(hr[2]?.querySelector('.csv-reasons')?.textContent),
        squash(hr[5]?.querySelector('td .csv-bad')?.textContent),
        hr[5]?.querySelectorAll('.csv-lookalike').length,
        squash(hr[5]?.querySelector('.csv-reasons')?.textContent),
        all(document, `${D} .csv-results tbody .csv-bad`).length,
      ],
      [
        ['合格', '合格', '要改', '合格', '合格', '要改', '合格', '合格'],
        'h-songtsam-meili',
        '酒店编号：这个编号已经有了（松赞梅里山居，已上架）',
        '2,6OO',
        4,
        '每晚起价：要写整数，写的是「2,6OO」',
        2,
      ],
    );
    eq(
      'H 页：合格的行按列表的写法（「3,400」右对齐），编号用等宽字',
      [
        cellsOf(hr[0]!).map(squash),
        hr[0]?.querySelector('.csv-title-code .mono')?.textContent,
        hr[0]?.querySelectorAll<HTMLElement>('td')[5]?.style.textAlign === 'right',
      ],
      [['1', '合格', '青城山六善酒店h-sixsenses-qingcheng', '四川', '顶奢', '3,400', '山景套房', ''], 'h-sixsenses-qingcheng', true],
    );
    eq('H 页的底栏：上一步、下载不合格的2行（带原因）、只导入合格的6行；没有「全部导入」', footer(), [
      '上一步',
      '下载不合格的2行（带原因）',
      '只导入合格的6行',
    ]);
    await click(btn('下载不合格的2行（带原因）'));
    const fd = await lastDownload();
    eq(
      '下载不合格的行：文件名接在原文件名后、带 BOM、两行加原因',
      [fd?.name, fd?.head, fd && parseCsv(fd.text).map((r) => r.at(-1))],
      [
        '新签酒店-9月-不合格的2行.csv',
        [0xef, 0xbb, 0xbf],
        ['不合格原因', '酒店编号：这个编号已经有了（松赞梅里山居，已上架）', '每晚起价：要写整数，写的是「2,6OO」'],
      ],
    );
    check('预检和下载都没有发请求', posts().length === 0);

    // 只导入合格的6行：服务端说第1行的编号刚被别人用了（422）→ 放回第1行，回到第3步，主按钮变成「只导入合格的5行」
    reply = () =>
      json(
        { error: 'invalid_csv', detail: 'CSV 有 1 处不合格', rows: [{ row: 1, issues: [{ path: 'id', message: '这个编号已经有了' }] }] },
        422,
      );
    await click(btn('只导入合格的6行'));
    await until(() => footer().includes('只导入合格的5行'));
    eq(
      '提交：表头原样（中文）、只有合格的6行；422 的问题放回原来的第1行',
      [
        csvSent(0),
        stepNow(),
        squash(resultRows()[0]?.querySelector('.csv-result')?.textContent),
        squash(resultRows()[0]?.querySelector('.csv-reasons')?.textContent),
      ],
      [[H_HEAD.split(','), ...[0, 1, 3, 4, 6, 7].map((i) => cellsOfLine(H_ROWS[i]!))], '校验结果', '要改', '酒店编号：这个编号已经有了'],
    );

    // 连不上：导入中关不掉，失败后停在第4步、就地报错带重试；重试成功到第5步
    const pending: { fail?: (e: unknown) => void } = {};
    reply = () => new Promise<Response>((_, reject) => void (pending.fail = reject));
    await click(btn('只导入合格的5行'));
    await until(() => pending.fail !== undefined);
    eq(
      '导入中：第4步，「正在导入5条草稿」，右上角关闭点不动，底栏没有按钮',
      [
        stepNow(),
        squash(document.querySelector(`${D} .csv-busy`)?.textContent),
        document.querySelector<HTMLButtonElement>(`${D} .ant-modal-close`)?.disabled,
        footer(),
      ],
      ['导入', '正在导入5条草稿', true, []],
    );
    // 关了照样会建成：按 Esc、点遮罩（先在遮罩上按下再点）都不关
    const maskClick = async () => {
      const wrap = document.querySelector<HTMLElement>(`${D} .ant-modal-wrap`);
      await act(async () => {
        wrap?.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }) as unknown as Event);
        wrap?.click();
      });
    };
    await press(modal(), 'Escape');
    await motion();
    const afterEsc = stepNow();
    await maskClick();
    await motion();
    eq('导入中：按 Esc、点遮罩都关不掉，仍在第4步', [afterEsc, stepNow()], ['导入', '导入']);
    await act(async () => pending.fail?.(new TypeError('Failed to fetch')));
    await until(() => alertTitles().length > 0);
    eq(
      '连不上：停在第4步，就地报错带重试，左边「上一步」',
      [stepNow(), alertTitles(), btn('重试') !== undefined, footer()],
      ['导入', ['服务暂时连不上'], true, ['上一步']],
    );
    reply = (s) => {
      const sent = parseCsv((s.body as { csv: string }).csv);
      const items = sent.slice(1).map((c) => ({ kind: 'hotel', code: c[0], ord: 30, rev: 1, status: 'draft', payload: { id: c[0] } }));
      return json({ items });
    };
    const hotelGets = () => api.sent.filter((x) => x.method === 'GET' && x.url.endsWith('/catalog/hotel')).length;
    const getsBefore = hotelGets();
    await click(btn('重试'));
    await until(() => stepNow() === '完成');
    eq(
      '完成：「已建5条草稿」与「去草稿页签逐条检查后上架」，列表随之重新取',
      [
        squash(document.querySelector(`${D} .csv-done-title`)?.textContent),
        squash(document.querySelector(`${D} .csv-done-note`)?.textContent),
        footer(),
        csvSent(2).length,
        hotelGets() > getsBefore,
      ],
      ['已建5条草稿', '去草稿页签逐条检查后上架', ['关闭', '去草稿页签'], 6, true],
    );
    await click(btn('去草稿页签'));
    await motion();
    eq(
      '去草稿页签：地址换成草稿页签（搜索与筛选清掉），弹窗关上',
      [pg.router.state.location.search, document.querySelector(`${D} .csv-steps`)],
      [{ status: 'draft' }, null],
    );

    // 再打开是新的一轮；250 行在前端就要分份，不发请求；粘贴页签
    const sentBefore = posts().length;
    await click(openBtn());
    await until(() => document.querySelector(`${D} .csv-steps`) !== null);
    await motion();
    check('再打开：回到第1步', stepNow() === '下载模板');
    await click(btn('选文件'));
    const rows250 = Array.from({ length: 250 }, (_, i) => `h-big-${i},名${i},三亚,五星,100,房,亮点,`);
    await pick('大.csv', [H_HEAD, ...rows250].join('\r\n'));
    eq(
      '250 行（验收 19）：第3步写「这份文件太大，请分成2份导入」和上限，没有导入按钮，不发请求',
      [
        stepNow(),
        alertTitles(),
        squash(document.querySelector(`${D} .ant-alert-description`)?.textContent),
        footer(),
        posts().length === sentBefore,
      ],
      ['校验结果', ['这份文件太大，请分成2份导入'], '一次最多导入200行，整份不超过60,000个字、64KB', ['上一步'], true],
    );
    await click(btn('上一步'));
    await pick('长.csv', [H_HEAD, H_ROWS[0], `h-huge,${'汉'.repeat(22_000)},三亚,五星,100,房,亮点,`].join('\r\n'));
    eq(
      '有一行单独也超上限：第3步写「第2行太长」和上限，没有导入按钮，不发请求',
      [stepNow(), alertTitles(), footer(), posts().length === sentBefore],
      ['校验结果', ['第2行太长，分成几份也导入不了'], ['上一步'], true],
    );
    await click(btn('上一步'));
    await click(document.querySelectorAll<HTMLElement>(`${D} .ant-tabs-tab-btn`)[1]);
    const area = document.querySelector<HTMLTextAreaElement>(`${D} textarea`);
    check('粘贴页签：占位是模板的表头，以「例：」开头', area?.placeholder === `例：${H_HEAD}`);
    await click(btn('校验'));
    check('粘贴的是空的：「粘贴的内容里没有要导入的行」', readError() === '粘贴的内容里没有要导入的行' && stepNow() === '选文件');
    await typeInto(area, [EN_HEAD, H_ROWS[0], H_ROWS[1]].join('\n'));
    await click(btn('校验'));
    eq(
      '粘贴英文表头的两行：全部合格，主按钮「导入2条草稿」，没有下载按钮',
      [stepNow(), fileRow(), alertTitles(), footer()],
      ['校验结果', '粘贴的内容2行改粘贴的内容', ['2行都可以导入'], ['上一步', '导入2条草稿']],
    );
    check(
      '全部合格的汇总是 info，不是 warning',
      document.querySelector(`${D} .csv-body .ant-alert`)?.className.includes('ant-alert-info') === true,
    );
    reply = () =>
      json(
        { error: 'invalid_csv', detail: 'x', rows: [{ row: 0, issues: [{ path: '', message: '一次最多导入 200 行，这份有 201 行' }] }] },
        422,
      );
    await click(btn('导入2条草稿'));
    await until(() => alertTitles().includes('无法导入这份文件'));
    eq(
      '服务端说整份不合格（第0行）：回到第3步写出原因，不再给导入按钮',
      [stepNow(), squash(document.querySelectorAll(`${D} .csv-body .ant-alert-description`)[1]?.textContent), footer()],
      ['校验结果', '一次最多导入200行，这份有201行', ['上一步']],
    );
    await press(modal(), 'Escape');
    await motion();
    check('没在导入时按 Esc 关上', document.querySelector(`${D} .csv-steps`) === null);
    await pg.unmount();

    // 假包的主材：同一个弹窗按它的字段画，提交到它的 kind
    const mp = await mountList('/catalog/material', owner(renovationLPage), { material: MATERIAL_ROWS });
    await click(all<HTMLButtonElement>(mp.box, '.page-actions button').find((b) => squash(b.textContent) === '导入CSV'));
    await until(() => modal() !== null);
    await motion();
    eq(
      '假包主材：标题、规则表的表头',
      [
        document.querySelector(`${D} .ant-modal-title`)?.textContent,
        texts(document, `${D} .csv-rules tbody tr.ant-table-row td:first-child`),
      ],
      ['从CSV导入主材', ['主材编号', '主材名称', '品类', '品牌', '计价单位', '单价', '质保', '环保等级（选填）']],
    );
    await click(btn('选文件'));
    await pick(
      '主材.csv',
      ['主材编号,主材名称,品类,品牌,计价单位,单价,质保,环保等级', 'm-dongpeng-750,东鹏 750×1500 岩板,瓷砖,东鹏,㎡,328,5,'].join('\n'),
    );
    eq(
      '假包主材：表头按它的字段，单价带单位',
      [texts(document, `${D} .csv-results thead th:not(.ant-table-cell-scrollbar)`), cellsOf(resultRows()[0]!).map(squash)[6]],
      [['行号', '结果', '主材名称·编号', '品类', '品牌', '计价单位', '单价', '质保', '环保等级', '原因'], '328元/㎡'],
    );
    reply = () => json({ items: [{ kind: 'material', code: 'm-dongpeng-750', ord: 9, rev: 1, status: 'draft', payload: {} }] });
    await click(btn('导入1条草稿'));
    await until(() => stepNow() === '完成');
    check('假包主材：提交到 /catalog/material/import-csv', posts().at(-1)?.url.endsWith('/catalog/material/import-csv') === true);
    await click(btn('关闭'));
    await motion();
    await mp.unmount();

    // 后加的产地、规格（活的假包）：规则表多两行；导入的表格多一列产地（规格按「、」分隔，不成列）；提交的 CSV 原样带着两列
    const lmp = await mountList('/catalog/material', owner(renovation), { material: MATERIAL_ROWS });
    await click(all<HTMLButtonElement>(lmp.box, '.page-actions button').find((b) => squash(b.textContent) === '导入CSV'));
    await until(() => modal() !== null);
    await motion();
    eq('后加的产地、规格：规则表多两行', texts(document, `${D} .csv-rules tbody tr.ant-table-row td:first-child`), [
      '主材编号',
      '主材名称',
      '品类',
      '品牌',
      '产地',
      '规格',
      '计价单位',
      '单价',
      '质保',
      '环保等级（选填）',
    ]);
    await click(btn('选文件'));
    const M_FILE = [
      '主材编号,主材名称,品类,品牌,产地,规格,计价单位,单价,质保,环保等级',
      'm-dongpeng-750,东鹏 750×1500 岩板,瓷砖,东鹏,广东东莞,750×1500、600×1200,㎡,328,5,',
    ];
    await pick('主材.csv', M_FILE.join('\n'));
    eq(
      '后加的产地成列（规格按「、」分隔，不成列）',
      [texts(document, `${D} .csv-results thead th:not(.ant-table-cell-scrollbar)`), cellsOf(resultRows()[0]!).map(squash).slice(5, 8)],
      [
        ['行号', '结果', '主材名称·编号', '品类', '品牌', '产地', '计价单位', '单价', '质保', '环保等级', '原因'],
        ['广东东莞', '㎡', '328元/㎡'],
      ],
    );
    reply = () => json({ items: [{ kind: 'material', code: 'm-dongpeng-750', ord: 9, rev: 1, status: 'draft', payload: {} }] });
    await click(btn('导入1条草稿'));
    await until(() => stepNow() === '完成');
    eq('后加的产地、规格：提交的表头与这一行原样', csvSent(posts().length - 1), M_FILE.map(cellsOfLine));
    await click(btn('关闭'));
    await motion();
    await lmp.unmount();

    // 从空状态导入：建好以后空状态卸了，打开弹窗的按钮不在了；关上以后焦点放到页头的「导入CSV」，不掉到 body
    const ep = await mountList('/catalog/hotel', owner(travel), { hotel: [] });
    const emptyOpen = () => all<HTMLButtonElement>(ep.box, '.state-empty-actions button').find((b) => squash(b.textContent) === '导入CSV');
    const headerOpen = () => all<HTMLButtonElement>(ep.box, '.page-actions button').find((b) => squash(b.textContent) === '导入CSV');
    const opener = emptyOpen();
    check('还没有条目：「导入CSV」在空状态里，页头没有', opener !== undefined && headerOpen() === undefined);
    // 浏览器里点按钮会把焦点放上去（happy-dom 的 click() 不会）
    await act(async () => opener?.focus());
    await click(opener);
    await until(() => stepNow() === '下载模板');
    await motion();
    await maskClick();
    await motion();
    check(
      '不在导入时点遮罩：关上，焦点回到空状态里的「导入CSV」（还在）',
      document.querySelector(`${D} .csv-steps`) === null && document.activeElement === opener,
    );
    await act(async () => opener?.focus());
    await click(opener);
    await until(() => stepNow() === '下载模板');
    await motion();
    await click(btn('选文件'));
    await click(document.querySelectorAll<HTMLElement>(`${D} .ant-tabs-tab-btn`)[1]);
    await typeInto(document.querySelector(`${D} textarea`), [EN_HEAD, H_ROWS[0]].join('\n'));
    await click(btn('校验'));
    reply = () => json({ items: [{ kind: 'hotel', code: 'h-sixsenses-qingcheng', ord: 1, rev: 1, status: 'draft', payload: {} }] });
    await click(btn('导入1条草稿'));
    await until(() => stepNow() === '完成' && headerOpen() !== undefined);
    check(
      '建好以后列表重新取到，空状态卸了，「导入CSV」到了页头',
      emptyOpen() === undefined && headerOpen() !== undefined && !opener?.isConnected,
    );
    await click(btn('关闭'));
    await motion();
    check(
      '关上：打开它的按钮不在了，焦点放到页头的「导入CSV」，不掉到 body',
      document.querySelector(`${D} .csv-steps`) === null && document.activeElement === headerOpen(),
      document.activeElement?.tagName,
    );
    await ep.unmount();

    api.restore();
    URL.createObjectURL = realCreate;
    (win.HTMLAnchorElement.prototype as unknown as { click(): void }).click = realClick;
  } catch (e) {
    check('第 13.7 节跑完、没有半路崩掉', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e));
  }
}

report();
