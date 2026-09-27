// 字段渲染器的自测（console UX spec「行业包通用架构 · 字段类型渲染器」「表单状态与提交」、不变量 12、16，plan 第 3.2 步）。
// console/src 里唯一可以 import 行业包注册表和假包的文件（scripts/check-boundaries.ts 单开的例外）：拿两个包的真实配置逐字段核对。
// 1. 不变量 12：渲染器表、控件读写表、网格规则表的键正好是全部字段类型；每种三种形态都是组件；
// 2. 不变量 16：data/ 下 20 条线路、23 家酒店和假包的样例，打开不改时补丁为空；每个字段（含有序子项的子字段）经控件读出、
//    原样写回，值不变、补丁为空；按 storeAs 存的餐食对现有数据 format(parse(x)) === x；
// 3. 写回的规则：选填清空删键、嵌套对象删空连对象一起删、showWhen 的字段跟着删、必填清空留空值、编号写进 id、键序不变、
//    不改原对象；多选片写回按选项排（验收 18）；规则之外的旧值原样保留；
// 4. 锁定与网格：已上架 / 草稿 / 新建 / 没有编辑权限各自的形态；4 列只给整卡只读、3 个及以上短值的卡片（设计系统 §6.4），
//    E 页的「基本信息」是 4 列，草稿是两列；
// 5. 两个包的每个字段三种形态都画一遍（renderToStaticMarkup），逐类型核对控件和只读的写法；画的时候不写值；
// 6. 实体图标：两个包的实体图标都画得出来，集合里只有 box 自己落到兜底的 box。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/fields/fields.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import fs from 'node:fs';
import path from 'node:path';
import { Box } from 'lucide-react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { packById } from '../../../src/packs/registry.js';
import { sameValue } from '../../../src/shared/catalog.js';
import { renovation } from '../../../src/shared/pack-fixtures/renovation.js';
import { checkItem, ENTITY_ICONS, type EntityType, type FieldDef, type FieldType, type IndustryPack } from '../../../src/shared/pack.js';
import { entityIcon } from '../shell/icons.js';
import { type FieldEnv, FieldEnvContext } from './env.js';
import { FieldGrid } from './FieldGrid.js';
import {
  CODECS,
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
  readValue,
  refItemsOf,
  type RefItem,
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
      obj = writeValue(obj, s, roundTrip(s, obj[s.key]), subs);
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
    state = writeValue(state, f, back, e.fields);
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
check('data/ 下 20 条线路、23 家酒店', ROUTES.length === 20 && HOTELS.length === 23, `${ROUTES.length}、${HOTELS.length}`);
for (const [name, e, items] of SAMPLES) {
  const notEmpty: string[] = [];
  const changed: string[] = [];
  const reordered: string[] = [];
  for (const p of items) {
    const original = deepFreeze(structuredClone(p));
    const opened = formState(original);
    const s0 = submission(original, opened);
    if (Object.keys(s0.set).length || s0.unset.length) notEmpty.push(String(p.id));
    const state = touchAll(e, original, changed);
    const s1 = submission(original, state);
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
  eq('data/ 里的餐食有 6 种写法', [...values].sort(), ['—', '早', '早/午', '早/午/晚', '早/晚', '晚'].sort());
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
  const patch = (next: Payload) => submission(original, next);

  eq('选填的「客户的其他叫法」清空：删键，进 unset', patch(writeValue(s, f('aliases'), [], ROUTE.fields)), { set: {}, unset: ['aliases'] });
  eq(
    '选填的「全程最高海拔」清空（控件给 null）：删键',
    patch(writeValue(s, f('maxAltitude'), CODECS.intUnit.write(null, f('maxAltitude')), ROUTE.fields)),
    {
      set: {},
      unset: ['maxAltitude'],
    },
  );
  const noLevel = writeValue(s, f('intensity.level'), CODECS.enum.write(undefined, f('intensity.level')), ROUTE.fields);
  eq('体力强度选「不填」：最累的一段跟着删，整个 intensity 进 unset', patch(noLevel), { set: {}, unset: ['intensity'] });
  check(
    '体力强度选「不填」后，最累的一段不显示',
    !groupGrid(ROUTE, 'fit', noLevel, ACTIVE).cells.some((c) => c.field.key === 'intensity.hardest'),
  );
  const lighter = writeValue(s, f('intensity.level'), '适中', ROUTE.fields);
  eq('改体力强度：intensity 整体进 set，最累的一段原样带上', patch(lighter), {
    set: { intensity: { level: '适中', hardest: (SICHUAN.intensity as Payload).hardest } },
    unset: [],
  });
  const fresh = writeValue(formState(GUIZHOU_5D), f('intensity.level'), '轻松', ROUTE.fields);
  eq('没有 intensity 的条目选了体力强度：建出 { level }', fresh.intensity, { level: '轻松' });
  eq(
    '这时最累的一段显示出来、算必须项，报「没填」',
    checkItem(ROUTE, fresh).required.map((i) => `${i.label}：${i.message}`),
    ['最累的一段：没填'],
  );
  eq('必填的「线路名称」清空：留空串，进 set，上架前检查报「没填」', patch(writeValue(s, f('title'), '', ROUTE.fields)), {
    set: { title: '' },
    unset: [],
  });
  eq('必填的「标签」清空：留 []（tags 可以是空数组）', patch(writeValue(s, f('tags'), [], ROUTE.fields)), { set: { tags: [] }, unset: [] });
  eq('编号写进 id', writeValue(formState(GUIZHOU_5D), f('$code'), 'r-guizhou-6d', ROUTE.fields).id, 'r-guizhou-6d');
  eq('改一个字段，键序不变', Object.keys(writeValue(s, f('hotelLevel'), '奢华', ROUTE.fields)), Object.keys(SICHUAN));
  check('原对象没被改动（深冻结着，写的是拷贝）', JSON.stringify(original) === JSON.stringify(SICHUAN));
  const e = fieldOf(ROUTE, 'itinerary');
  const days = CODECS.subItems.read(s.itinerary, e) as Payload[];
  const meals = e.item!.find((x) => x.key === 'meals')!;
  const edited = days.map((d, i) => (i === 1 ? writeValue(d, meals, CODECS.enum.write(['晚', '早'], meals), e.item) : d));
  const next = writeValue(s, e, CODECS.subItems.write(edited, e), ROUTE.fields);
  eq('改第2天的餐食：逐日行程整体进 set，只有那一天变了', patch(next).unset, []);
  eq('第2天的餐食写成「早/晚」', ((patch(next).set.itinerary as Payload[])[1] as Payload).meals, '早/晚');
  check(
    '其余几天原样',
    (patch(next).set.itinerary as Payload[]).every((d, i) => i === 1 || sameValue(d, days[i])),
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
  eq('没有编辑权限看已上架的「基本信息」：全是只读短值，4 列', g(ROUTE, 'basic', SICHUAN, READER).columns, 4);
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
    ['overseas:locked:half', 'segments:locked:wide', 'maxAltitude:locked:half', 'intensity.level:edit:half', 'intensity.hardest:edit:half'],
  );
  eq('酒店已上架的「基本信息」：星级档次可改，两列', g(HOTEL, 'basic', HOTELS[0]!, ACTIVE).columns, 2);
  eq('只有 2 个短值的整锁卡片（装修套餐「价格」）：两列', g(PKG, 'price', NUANMU, ACTIVE).columns, 2);
  eq(
    '整锁卡片里有是否、多选引用（装修套餐「施工与条款」）：两列',
    [g(PKG, 'terms', NUANMU, ACTIVE).columns, g(PKG, 'terms', NUANMU, ACTIVE).allLocked],
    [2, true],
  );
  eq('没有编辑权限看主材「基本信息」：编号、名称、单选品类、品牌，4 列', g(MATERIAL, 'basic', MATERIALS[0]!, READER).columns, 4);
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
  const optBool: FieldDef = { ...overseas, required: false };
  check('选填的是否：开关，旁边写当前值', form(optBool, true).includes('ant-switch') && form(optBool, true).includes('>境外<'));
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
    view(fieldOf(ROUTE, 'highlights'), ['一', '二']).includes('<ol class="field-list"><li>一</li><li>二</li></ol>'),
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
}

// ---------------- 6. 实体图标 ----------------
{
  for (const p of [travel, renovation]) {
    for (const e of p.entities) check(`${p.id} 的「${e.label}」图标 ${e.icon} 画得出来`, entityIcon(e.icon) !== Box);
  }
  const fallback = ENTITY_ICONS.filter((n) => entityIcon(n) === Box);
  eq('实体图标集合里只有 box 落到 Box', fallback, ['box']);
}

report();
