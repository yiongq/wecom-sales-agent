// 审计日志的自测（console UX spec「逐页设计 · 审计日志（K 页）」、验收 21、不变量 7、22，设计系统 §6.5、§10.0、§10.2 K 页，plan 第 14 步）。
// 数据照设计系统 §10.0 的 8 条审计（时刻 2026-09-26 周六 14:30，Asia/Shanghai）。行业包是本文件里手写的夹具（旅游式、家装式各一份）：
// console 里只有渲染器自测能 import 注册表和假包（scripts/check-boundaries.ts）。
// 1. 纯逻辑（model.ts、audit-search.ts）：地址参数的取舍；类别与「显示登录记录」换算成的 actions；按页取时页尾那一句合并的记录
//    不被截断（多取的留到下一页用、不重取）；按天分组的组标题与每一句、下一行的摘要；详情抽屉的时间、操作者、对象、改动表
//    （字段名取行业包、金额与单位、数组用「、」、有序子项逐项对齐、长文本行内差异）、回滚的提醒、去处与技术详情；
//    每种动作的可见文字里没有动作编码与 UUID（不变量 7）；
// 2. 在 DOM 里挂载（happy-dom）：真的 AuditPage 加照服务端规则算的假接口。请求带 actions、每页 50 条；组与句子；
//    「展开6条」与收起；点类别、开关改地址并按新地址请求（不变量 22）；地址还原筛选；「加载更早的记录」与到底；
//    空、类别下没有记录、出错、翻页出错；详情抽屉（改动表、去处、技术详情折叠、关上后焦点回到那一句）；坐席与匿名不发请求；
//    换一个行业包，类别名与实体名跟着换；整页没有红色。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/audit/audit.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuditEntryView, AuditPage as AuditPageBody, Me, Role } from '../../../src/shared/console-api.js';
import type { EntityType, FieldDef, IndustryPack } from '../../../src/shared/pack.js';
import { AUDIT_ACTIONS, auditActionsParam } from '../../../src/shared/ui-labels.js';
import { auditSearch } from '../audit-search.js';
import type { Viewer } from '../shell/boot.js';
import { VIEWER_KEY } from '../viewer.js';
import { AuditPage } from './AuditPage.js';
import {
  actionsOf,
  type AuditCursor,
  type Cell,
  changeRows,
  charDiff,
  drawerView,
  FIRST_CURSOR,
  groupOptions,
  groupSearch,
  loadAuditChunk,
  loginSearch,
  MAX_EXTRA_FETCHES,
  pairItems,
  timelineGroups,
  valueText,
} from './model.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

check('时区钉成了上海', new Date(Date.UTC(2026, 8, 25, 16)).getDate() === 26);

// ---------------- 夹具 ----------------

const NOW = Date.parse('2026-09-26T14:30:00+08:00');
const at = (hm: string, day = '2026-09-26'): string => new Date(`${day}T${hm}+08:00`).toISOString();

const field = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'text', group: 'g', ...extra });
const entity = (kind: string, label: string, titleKey: string, fields: FieldDef[]): EntityType => ({
  kind,
  label,
  icon: 'box',
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey,
  subtitleKeys: [],
  groups: [{ key: 'g', label: '基本' }],
  lockGroups: {},
  fields,
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});
/** 旅游式的包：字段顺序照旅游包（住宿档次在行程亮点前面），各种字段类型各有一个 */
const TRAVEL: IndustryPack = {
  id: 'fixture-travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [
    entity('route', '线路', 'title', [
      field('$code', '线路编号'),
      field('title', '线路名称'),
      field('days', '天数', { type: 'intUnit', unit: '天' }),
      field('overseas', '境内还是境外', { type: 'boolean', trueLabel: '境外', falseLabel: '境内' }),
      field('priceFrom', '每人起价', { type: 'money', unit: '元/人' }),
      field('segments', '适合客群', { type: 'enum', multiple: true, options: ['家庭', '亲子', '银发'] }),
      field('intensity.level', '体力强度', { type: 'enum', options: ['轻松', '适中', '较累'] }),
      field('intensity.hardest', '最累的一段'),
      field('itinerary', '逐日行程', {
        type: 'subItems',
        itemNoun: '天',
        indexLabel: 'D{n}',
        autoIndexKey: 'day',
        item: [
          { key: 'title', type: 'text', label: '当天标题', group: '' },
          { key: 'detail', type: 'longText', label: '当天安排', group: '' },
          { key: 'hotel', type: 'reference', label: '当晚住宿', group: '', to: 'hotel' },
        ],
      }),
      field('hotelLevel', '住宿档次'),
      field('highlights', '行程亮点', { type: 'subItems', itemNoun: '条', item: [{ key: '', type: 'text', label: '', group: '' }] }),
      field('tags', '标签', { type: 'tags' }),
      field('$status', '状态', { type: 'status' }),
    ]),
    entity('hotel', '酒店', 'name', [
      field('$code', '酒店编号'),
      field('name', '酒店名称'),
      field('nightlyFrom', '每晚起价', { type: 'money', unit: '元/晚' }),
    ]),
  ],
  stages: [],
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'objections', heading: '异议处理', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
};
/** 家装式的包：同样的 kind 换成别的实体名与分组名，界面照样画 */
const HOME: IndustryPack = {
  ...TRAVEL,
  id: 'fixture-home',
  vocabulary: { ...TRAVEL.vocabulary, productNoun: '套餐' },
  entities: [
    entity('route', '装修套餐', 'title', [field('$code', '套餐编号'), field('title', '套餐名称'), field('hotelLevel', '主材档次')]),
  ],
  nav: { catalogGroup: '套餐库', entities: ['route'] },
};
/**
 * 家装假包那样的字段（src/shared/pack-fixtures/renovation.ts）：金额的单位取同一条的计价单位（unitFrom）、月份区间、
 * 按编号存的引用（名字取产品库缓存）；旅游包那样带 yearRoundLabel 的月份区间
 */
const RENO: IndustryPack = {
  ...TRAVEL,
  id: 'fixture-reno',
  vocabulary: { ...TRAVEL.vocabulary, productNoun: '套餐' },
  entities: [
    entity('package', '装修套餐', 'title', [
      field('$code', '套餐编号'),
      field('title', '套餐名称'),
      field('startMonths', '适合开工月份', { type: 'monthRange' }),
      field('bestSeason', '最佳季节', { type: 'monthRange', yearRoundLabel: '全年（不加价）' }),
      field('materials', '包含主材', { type: 'reference', to: 'material', store: 'code', multiple: true }),
      field('featured', '主推主材', { type: 'reference', to: 'material', store: 'label' }),
      field('nodes', '施工节点', {
        type: 'subItems',
        itemNoun: '个节点',
        item: [
          { key: 'name', type: 'text', label: '节点名称', group: '' },
          { key: 'materials', type: 'reference', to: 'material', store: 'code', multiple: true, label: '用到的主材', group: '' },
        ],
      }),
    ]),
    entity('material', '主材', 'name', [
      field('$code', '主材编号'),
      field('name', '主材名称'),
      field('priceUnit', '计价单位', { type: 'enum', options: ['㎡', '延米'] }),
      field('unitPrice', '单价', { type: 'money', unitFrom: 'priceUnit' }),
    ]),
  ],
  nav: { catalogGroup: '套餐库', entities: ['package', 'material'] },
};
const MATERIAL_NAMES: Record<string, string> = { 'm-1': '实木地板', 'm-2': '岩板台面' };
const renoLookups = { itemName: (kind: string, code: string) => (kind === 'material' ? MATERIAL_NAMES[code] : undefined) };

let nextId = 1000;
const entry = (e: Partial<AuditEntryView> & Pick<AuditEntryView, 'action'>): AuditEntryView => ({
  id: (nextId -= 1),
  at: at('14:00:00'),
  actorKind: 'user',
  actorName: '小林',
  targetType: null,
  targetId: null,
  diff: null,
  ...e,
});
const cli = { actorKind: 'platform' as const, actorName: 'user-create' };
const UUID = '9b2f0f5e-0000-4000-8000-000000000001';

const GUIZHOU = '贵州 小七孔·西江千户苗寨 5 日';
const SICHUAN = '四川 稻城亚丁·色达秘境 8 日';
const HOTEL_NAMES = ['青城山六善酒店', '成都锦江宾馆', '大研安缦', '松赞林卡', '拉萨瑞吉', '稻城皇冠'];
const HL_OLD = '色达清晨登坛城对面山坡，俯瞰万座红房子';
const HL_NEW = '色达破晓登坛城对面山坡，拍下万座红房子在晨雾中次第亮起';

const create = entry({
  action: 'catalog.create',
  at: at('13:40:00'),
  targetType: 'route',
  targetId: 'r-guizhou-5d',
  diff: {
    id: [null, 'r-guizhou-5d'],
    title: [null, GUIZHOU],
    days: [null, 5],
    overseas: [null, false],
    priceFrom: [null, 13800],
    segments: [null, ['家庭', '亲子', '银发']],
    highlights: [null, ['逛西江千户苗寨', '走小七孔']],
    itinerary: [null, [{ day: 1, title: '贵阳', detail: '接机' }]],
    tags: [null, []],
  },
});
const hotels = HOTEL_NAMES.map((name, i) =>
  entry({
    action: 'catalog.create',
    at: at(`11:20:0${5 - i}`),
    targetType: 'hotel',
    targetId: `h-csv-${i}`,
    diff: { id: [null, `h-csv-${i}`], name: [null, name], nightlyFrom: [null, 1800 + i] },
  }),
);
const update = entry({
  action: 'catalog.update',
  at: at('10:12:44'),
  targetType: 'route',
  targetId: 'r-sichuan-lux',
  diff: {
    highlights: [
      ['登稻城亚丁', HL_OLD, '看新都桥', '住藏家'],
      ['登稻城亚丁', HL_NEW, '看新都桥', '住藏家'],
    ],
    hotelLevel: ['顶级精品', '顶级野奢'],
  },
});
const publish = entry({
  action: 'sop.publish',
  at: at('18:30:00', '2026-09-25'),
  actorName: '老板',
  targetType: 'sop_version',
  targetId: UUID,
  diff: { versionNo: 2, changedKeys: ['objections'] },
});
const userCreate = (email: string, role: string, hm: string): AuditEntryView =>
  entry({
    action: 'platform.user_create',
    at: at(hm, '2026-09-24'),
    ...cli,
    targetType: 'user',
    targetId: UUID,
    diff: { email, role, created: true },
  });
const importConfig = entry({
  action: 'config.import',
  at: at('10:02:00', '2026-09-24'),
  ...cli,
  actorName: 'import-config',
  diff: { sections: 11, routes: 20, hotels: 23 },
});
const tenant = entry({
  action: 'platform.tenant_create',
  at: at('10:01:00', '2026-09-24'),
  ...cli,
  actorName: 'tenant-create',
  targetType: 'tenant',
  diff: { slug: 'demo', name: '云途定制旅行', packId: 'travel' },
});
const login = entry({ action: 'auth.login', at: at('09:00:00'), actorName: '老板', targetType: 'user', targetId: UUID });
/** 设计系统 §10.0 的审计，新的在前（登录记录另放，默认不显示） */
const SCENE: AuditEntryView[] = [
  create,
  ...hotels,
  update,
  login,
  publish,
  userCreate('xiaolin@yuntu.test', 'admin', '10:05:00'),
  userCreate('boss@yuntu.test', 'owner', '10:03:00'),
  importConfig,
  tenant,
];
const lookups = { itemName: (kind: string, code: string) => (kind === 'route' && code === 'r-sichuan-lux' ? SICHUAN : undefined) };

// ---------------- 1. 纯逻辑 ----------------

// 地址参数与筛选
{
  eq('地址参数：合规的留下', auditSearch({ cat: 'catalog', login: 1 }), { cat: 'catalog', login: 1 });
  eq('地址参数：login 写成字符串也认', auditSearch({ login: '1' }).login, 1);
  eq(
    '地址参数：不合规的丢掉，键照样写出来（不然 TanStack 把原样的参数留在 useSearch 里）',
    Object.entries(auditSearch({ cat: 'bogus', login: 2 })),
    [
      ['cat', undefined],
      ['login', undefined],
    ],
  );
  eq('地址参数：原型上的名字不算类别', auditSearch({ cat: 'toString' }).cat, undefined);
  eq('类别：全部且不显示登录记录 = 表里的全部动作去掉登录', actionsOf({}), auditActionsParam('all', false));
  eq('类别：全部且显示登录记录时不带 actions（表外的新动作也列得出来）', actionsOf({ login: 1 }), undefined);
  eq('类别：销售话术只列 sop 的动作', actionsOf({ cat: 'sop' })?.split(','), [
    'sop.publish',
    'sop.rollback',
    'sop.discard',
    'sop.rerender',
  ]);
  check('类别：账号与登录，开关关着时不带登录与退出', !/auth\./.test(actionsOf({ cat: 'account' }) ?? ''));
  check('类别：账号与登录，开关开着时带上登录与退出', /auth\.login.*auth\.logout/.test(actionsOf({ cat: 'account', login: 1 }) ?? ''));
  eq(
    '换类别：开关留着；「全部」不写',
    [groupSearch('sop', { login: 1 }), groupSearch('all', { cat: 'sop', login: 1 })],
    [{ cat: 'sop', login: 1 }, { login: 1 }],
  );
  eq(
    '开关：类别留着；关上不写',
    [loginSearch(true, { cat: 'sop' }), loginSearch(false, { cat: 'sop', login: 1 })],
    [{ cat: 'sop', login: 1 }, { cat: 'sop' }],
  );
  eq(
    '分段控件：五段，产品库那一类的名字取行业包',
    [groupOptions(TRAVEL).map((g) => g.label), groupOptions(HOME)[2]!.label],
    [['全部', '销售话术', '产品库', '账号与登录', '平台与配置'], '套餐库'],
  );
}

// 按页取：页尾那一句合并的记录不截断
{
  /** 照服务端：id 倒序，before 取更早的，limit 条，多一条才给 nextBefore */
  const serve =
    (log: AuditEntryView[], calls: (number | undefined)[]) =>
    async (before: number | undefined): Promise<AuditPageBody> => {
      calls.push(before);
      const rows = log.filter((e) => before === undefined || e.id < before);
      const items = rows.slice(0, 5);
      return { items, nextBefore: rows.length > 5 ? items.at(-1)!.id : null };
    };
  const mk = (n: number, action: string, kind: string | null, minute: number): AuditEntryView[] =>
    Array.from({ length: n }, (_, i) =>
      entry({
        action,
        targetType: kind,
        targetId: kind && `${kind}-${nextId}`,
        // 10 点 minute 分起，每条早 1 秒（同一句里相邻两条不超过 5 分钟）
        at: new Date(Date.parse(at('10:00:00')) + minute * 60_000 - i * 1000).toISOString(),
      }),
    );
  // 3 条单独的 + 6 条同一句（跨在第 5 条的页边上）+ 4 条单独的
  const log = [...mk(3, 'sop.publish', null, 50), ...mk(6, 'catalog.create', 'hotel', 40), ...mk(4, 'sop.discard', null, 30)];
  const calls: (number | undefined)[] = [];
  const get = serve(log, calls);
  const first = await loadAuditChunk(get, FIRST_CURSOR, 5);
  eq('第一页：凑够 5 条后页尾那一句还没完，接着取到它结束（3 + 6 条）', first.items.length, 9);
  eq('第一页：取了两次，第二次从第 5 条之后取', calls, [undefined, log[4]!.id]);
  eq('第一页：多取回来的留到下一页（carry），游标接着服务端给的走', [first.next?.carry.length, first.next?.before], [1, log[9]!.id]);
  const second = await loadAuditChunk(get, first.next!, 5);
  eq('第二页：先用留下的，不重取，余下的正好 4 条', [second.items.map((e) => e.id), calls.length], [log.slice(9).map((e) => e.id), 3]);
  eq('到底了：next 为 null', second.next, null);
  eq(
    '两页连起来就是全部记录，不重不漏',
    [...first.items, ...second.items].map((e) => e.id),
    log.map((e) => e.id),
  );

  // 页尾正好是一句的结尾（下一条是另一种动作）：往后看一眼就停，看到的留到下一页
  const calls2: (number | undefined)[] = [];
  const log2 = [...mk(5, 'catalog.update', 'route', 20), ...mk(3, 'sop.publish', null, 10)];
  const c2 = await loadAuditChunk(serve(log2, calls2), FIRST_CURSOR, 5);
  eq('页尾的同类记录正好合完：这一页 5 条，看过的 3 条留到下一页', [c2.items.length, c2.next?.carry.length, calls2.length], [5, 3, 2]);
  // 页尾是合不了的动作：不往后看
  const calls3: (number | undefined)[] = [];
  const log3 = [...mk(5, 'sop.publish', null, 20), ...mk(3, 'sop.publish', null, 10)];
  const c3 = await loadAuditChunk(serve(log3, calls3), FIRST_CURSOR, 5);
  eq('页尾是合不了的动作：只取一次', [c3.items.length, calls3.length, c3.next?.carry.length], [5, 1, 0]);
  // 一句长得离谱：往后取到上限就停
  const calls4: (number | undefined)[] = [];
  const log4 = mk(5 * (MAX_EXTRA_FETCHES + 4), 'catalog.create', 'hotel', 0).map((e, i) => ({
    ...e,
    at: new Date(NOW - i * 1000).toISOString(),
  }));
  const c4 = await loadAuditChunk(serve(log4, calls4), FIRST_CURSOR, 5);
  eq(
    '一句长得离谱：往后最多再取 MAX_EXTRA_FETCHES 次',
    [calls4.length, c4.items.length, c4.next === null],
    [1 + MAX_EXTRA_FETCHES, 5 * (1 + MAX_EXTRA_FETCHES), false],
  );
  // 空日志
  const c5 = await loadAuditChunk(async () => ({ items: [], nextBefore: null }), FIRST_CURSOR, 5);
  eq('空日志：没有记录，也没有下一页', c5, { items: [], next: null });
  // 接口给了空页却带游标：算到底，不一直取
  let n6 = 0;
  const c6 = await loadAuditChunk(async () => ((n6 += 1), { items: [], nextBefore: 5 }), { before: 9, carry: [] } satisfies AuditCursor, 5);
  eq('空页带游标：只取一次就算到底', [n6, c6.next], [1, null]);
}

// 按天分组的时间线
const groups = timelineGroups(
  SCENE.filter((e) => e !== login),
  TRAVEL,
  lookups,
  NOW,
);
{
  eq(
    '组标题：今天 / 昨天 / 更早的写日期加星期',
    groups.map((g) => g.heading),
    [['今天', '9月26日 周六'], ['昨天', '9月25日 周五'], ['9月24日 周四']],
  );
  const sentence = (l: (typeof groups)[number]['lines'][number]): string => `${l.actor.name} ${l.parts.map((p) => p.text).join('')}`;
  eq(
    '每一句（§10.0 的 8 条，6 条 CSV 导入的酒店草稿合成一句）',
    groups.map((g) => g.lines.map(sentence)),
    [
      [`小林 新建了线路草稿「${GUIZHOU}」`, '小林 新建了6条酒店草稿', `小林 修改了线路「${SICHUAN}」`],
      ['老板 发布了话术v2'],
      ['命令行 为xiaolin@yuntu.test建了账号', '命令行 为boss@yuntu.test建了账号', '命令行 导入了初始配置', '命令行 建了租户'],
    ],
  );
  eq(
    '下一行：新建写编号（等宽）、合并的一句列出前三条的名字「等6条」、修改写改了哪些字段',
    groups[0]!.lines.map((l) => l.summary),
    [
      { text: '线路编号', code: 'r-guizhou-5d' },
      { text: '青城山六善酒店、成都锦江宾馆、大研安缦等6条' },
      { text: '改了：住宿档次、行程亮点' },
    ],
  );
  eq(
    '下一行：发布写改了哪几节，建账号写角色，导入没有摘要',
    [groups[1]!.lines[0]!.summary, groups[2]!.lines[0]!.summary, groups[2]!.lines[2]!.summary],
    [{ text: '改了1节：异议处理' }, { text: '角色：管理员' }, null],
  );
  eq(
    '右边的时刻与悬停的绝对时间',
    [groups[0]!.lines[0]!.time, groups[0]!.lines[0]!.timeTitle, groups[1]!.lines[0]!.timeTitle],
    ['13:40', '9月26日 13:40', '9月25日 18:30'],
  );
  eq(
    '合并的一句：6 条、新的在前，时刻取最新的一条',
    [groups[0]!.lines[1]!.count, groups[0]!.lines[1]!.entries.map((e) => e.targetId), groups[0]!.lines[1]!.time],
    [6, hotels.map((e) => e.targetId), '11:20'],
  );
  eq(
    '操作者：命令行不画头像',
    groups[2]!.lines.map((l) => l.actor.human),
    [false, false, false, false],
  );
  const two = timelineGroups(hotels.slice(0, 2), TRAVEL, lookups, NOW)[0]!.lines[0]!;
  eq('合并的只有两三条：名字全列，不写「等」', two.summary, { text: '青城山六善酒店、成都锦江宾馆' });
  const home = timelineGroups([update], HOME, {}, NOW)[0]!.lines[0]!;
  eq(
    '换一个行业包：实体名、字段名跟着换；缓存里没有名字时写编号',
    [home.parts.map((p) => p.text).join(''), home.summary],
    ['修改了装修套餐「r-sichuan-lux」', { text: '改了：主材档次、另1项' }],
  );
}

// 行内差异与有序子项对齐
{
  const d = charDiff(HL_OLD, HL_NEW);
  eq('行内差异（K 页的例子）：原来划掉「清晨」「俯瞰」', d.before, [
    { text: '色达' },
    { text: '清晨', mark: 'del' },
    { text: '登坛城对面山坡，' },
    { text: '俯瞰', mark: 'del' },
    { text: '万座红房子' },
  ]);
  eq('行内差异：现在加上「破晓」「拍下」「在晨雾中次第亮起」', d.after, [
    { text: '色达' },
    { text: '破晓', mark: 'ins' },
    { text: '登坛城对面山坡，' },
    { text: '拍下', mark: 'ins' },
    { text: '万座红房子' },
    { text: '在晨雾中次第亮起', mark: 'ins' },
  ]);
  eq('行内差异：两处改动之间只隔一个相同的字，并进改动（整词换整词）', charDiff('清晨的山', '破晓的湖'), {
    before: [{ text: '清晨的山', mark: 'del' }],
    after: [{ text: '破晓的湖', mark: 'ins' }],
  });
  eq('行内差异：一样的字没有标记', charDiff('一样', '一样'), { before: [{ text: '一样' }], after: [{ text: '一样' }] });
  eq(
    '行内差异：emoji 这类代理对不拆开',
    charDiff('看🏔️雪山', '看🌊大海')
      .before.map((s) => s.text)
      .join(''),
    '看🏔️雪山',
  );
  const long = 'x'.repeat(600);
  const big = charDiff(`${long}甲`, `乙${long}`);
  check(
    '行内差异：很长时只比头尾，结果照样拼得回原文',
    big.before.map((s) => s.text).join('') === `${long}甲` && big.after.map((s) => s.text).join('') === `乙${long}`,
  );
  eq(
    '有序子项：开头插了一条，后面的都不算改了',
    pairItems(['a', 'b', 'c'], ['n', 'a', 'b', 'c']).map((o) => o.k),
    ['added', 'same', 'same', 'same'],
  );
  eq(
    '有序子项：中间改了一条、末尾删了一条',
    pairItems(['a', 'b', 'c', 'd'], ['a', 'B', 'c']).map((o) => o.k),
    ['same', 'changed', 'same', 'removed'],
  );
}

/** 改动表的一格写成字：删去的写 [-…]，新加的写 [+…] */
const cell = (c: Cell): string =>
  'text' in c ? c.text : c.segs.map((s) => (s.mark === 'del' ? `[-${s.text}]` : s.mark === 'ins' ? `[+${s.text}]` : s.text)).join('');

// 值的写法与改动表
{
  const route = TRAVEL.entities[0]!;
  const f = (key: string): FieldDef => route.fields.find((x) => x.key === key)!;
  eq(
    '值：金额带千分位与单位、带单位的整数、是否写包里的字、数组用「、」、空写「—」、有序子项写条数',
    [
      valueText(f('priceFrom'), 42800),
      valueText(f('days'), 8),
      valueText(f('overseas'), false),
      valueText(f('segments'), ['家庭', '亲子']),
      valueText(f('tags'), []),
      valueText(f('title'), null),
      valueText(f('itinerary'), [{}, {}, {}]),
      valueText(f('highlights'), ['甲', '乙']),
    ],
    ['42,800元/人', '8天', '境内', '家庭、亲子', '—', '—', '3天', '甲、乙'],
  );
  const rows = (diff: Record<string, unknown>) => {
    const out = changeRows(route, diff);
    return {
      rows: out.rows.map((r) => [r.label.join(' · '), cell(r.before), cell(r.after)]),
      untouched: out.untouched,
      unknown: out.unknown,
    };
  };
  eq('改动表：按包里字段的顺序，不按 diff 的键序；子项只列改了的那条', rows(update.diff as Record<string, unknown>), {
    rows: [
      ['住宿档次', '顶级精品', '顶级野奢'],
      ['行程亮点第2条', '色达[-清晨]登坛城对面山坡，[-俯瞰]万座红房子', '色达[+破晓]登坛城对面山坡，[+拍下]万座红房子[+在晨雾中次第亮起]'],
    ],
    untouched: [{ label: '行程亮点', n: 3, noun: '条' }],
    unknown: 0,
  });
  eq(
    '改动表：嵌套字段只写真正变了的子字段；金额；包里没有的键算进「另N项」，不写原名',
    rows({
      intensity: [
        { level: '适中', hardest: '徒步3小时' },
        { level: '适中', hardest: '徒步5小时' },
      ],
      priceFrom: [38000, 42800],
      secretKey: [1, 2],
    }),
    {
      rows: [
        ['每人起价', '38,000元/人', '42,800元/人'],
        ['最累的一段', '徒步3小时', '徒步5小时'],
      ],
      untouched: [],
      unknown: 1,
    },
  );
  eq(
    '改动表：多子字段的有序子项逐项逐字段，长文本行内比，自动编号不算改动；新加的一天写它的标题',
    rows({
      itinerary: [
        [
          { day: 1, title: '成都', detail: '接机后自由活动', hotel: '锦江' },
          { day: 2, title: '丹巴', detail: '车程6小时', hotel: '藏寨' },
        ],
        [
          { day: 1, title: '成都', detail: '接机后自由活动', hotel: '锦江' },
          { day: 2, title: '丹巴', detail: '车程7小时', hotel: '甲居' },
          { day: 3, title: '新都桥', detail: '看日落' },
        ],
      ],
    }),
    {
      rows: [
        ['逐日行程第2天 · 当天安排', '车程[-6]小时', '车程[+7]小时'],
        ['逐日行程第2天 · 当晚住宿', '藏寨', '甲居'],
        ['逐日行程第3天', '—', '新都桥'],
      ],
      untouched: [{ label: '逐日行程', n: 1, noun: '天' }],
      unknown: 0,
    },
  );
  eq(
    '改动表：中间插了一天，后面几天只是编号变了，不算改了',
    rows({
      itinerary: [
        [
          { day: 1, title: '成都', detail: '接机' },
          { day: 2, title: '丹巴', detail: '车程' },
          { day: 3, title: '色达', detail: '看日出' },
        ],
        [
          { day: 1, title: '成都', detail: '接机' },
          { day: 2, title: '四姑娘山', detail: '徒步' },
          { day: 3, title: '丹巴', detail: '车程' },
          { day: 4, title: '色达', detail: '看日出' },
        ],
      ],
    }),
    { rows: [['逐日行程第2天', '—', '四姑娘山']], untouched: [{ label: '逐日行程', n: 3, noun: '天' }], unknown: 0 },
  );
  eq(
    '改动表：编号跟着变的那一天另有改动时，只写真改了的子字段，不写编号',
    rows({
      itinerary: [
        [
          { day: 1, title: '成都', detail: '接机' },
          { day: 2, title: '丹巴', detail: '车程' },
        ],
        [{ day: 1, title: '丹巴', detail: '车程6小时' }],
      ],
    }),
    {
      rows: [
        ['逐日行程第1天 · 当天标题', '成都', '丹巴'],
        ['逐日行程第1天 · 当天安排', '[-接机]', '[+车程6小时]'],
        ['逐日行程第2天', '丹巴', '—'],
      ],
      untouched: [],
      unknown: 0,
    },
  );
  eq(
    '改动表：嵌套对象从没有到有、从有到没有，逐个写子字段，不算认不出',
    [rows({ intensity: [null, { level: '适中', hardest: '徒步3小时' }] }), rows({ intensity: [{ level: '轻松' }, null] })],
    [
      {
        rows: [
          ['体力强度', '—', '适中'],
          ['最累的一段', '—', '徒步3小时'],
        ],
        untouched: [],
        unknown: 0,
      },
      { rows: [['体力强度', '轻松', '—']], untouched: [], unknown: 0 },
    ],
  );
  eq(
    '改动表：子项里包里没有的键改了，算进「另N项」，不写原名',
    rows({
      itinerary: [
        [{ day: 1, title: '成都', detail: '接机', legacyNote: 'a' }],
        [{ day: 1, title: '成都', detail: '接机', legacyNote: 'b' }],
      ],
    }),
    { rows: [], untouched: [], unknown: 1 },
  );
  eq('改动表：diff 不是 [原来, 现在] 的键算认不出', rows({ title: 'x', days: [5, 6] }), {
    rows: [['天数', '5天', '6天']],
    untouched: [],
    unknown: 1,
  });
}

// 月份区间、引用、按另一个字段取单位的金额：与字段渲染器写得一样（ADR-004）
{
  const pkg = RENO.entities[0]!;
  const rows = (diff: Record<string, unknown>, l: typeof renoLookups | object = renoLookups) =>
    changeRows(pkg, diff, l).rows.map((r) => [r.label.join(' · '), cell(r.before), cell(r.after)]);
  eq(
    '月份区间写成「3–6月」，全年写包里的 yearRoundLabel；认不出的写原文',
    rows({
      startMonths: ['3-6月', '3-6月、9-11月'],
      bestSeason: ['4月-10月', '全年'],
    }),
    [
      ['适合开工月份', '3–6月', '3–6、9–11月'],
      ['最佳季节', '4–10月', '全年（不加价）'],
    ],
  );
  eq('月份区间：规则之外、画不出月份的写原文，不写成「—」', rows({ startMonths: ['看天气', '13月'] }), [
    ['适合开工月份', '看天气', '13月'],
  ]);
  eq(
    '引用：按编号存的写目标条目的名字，缓存里没有的写编号；按名称存的原样写；子项里的引用同样',
    rows({
      materials: [['m-1'], ['m-1', 'm-9']],
      featured: ['m-1', 'm-2'],
      nodes: [[{ name: '水电', materials: ['m-1'] }], [{ name: '水电', materials: ['m-2'] }]],
    }),
    [
      ['包含主材', '实木地板', '实木地板、m-9'],
      ['主推主材', 'm-1', 'm-2'],
      ['施工节点第1个节点 · 用到的主材', '实木地板', '岩板台面'],
    ],
  );
  eq('引用：没有对象名的缓存时写编号', rows({ materials: [['m-1'], ['m-2']] }, {}), [['包含主材', 'm-1', 'm-2']]);
  eq(
    '抽屉：改动表里的引用用页面的对象名缓存',
    drawerView(
      entry({ action: 'catalog.update', targetType: 'package', targetId: 'p-1', diff: { materials: [['m-1'], ['m-1', 'm-2']] } }),
      RENO,
      renoLookups,
    ).changes?.rows.map((r) => [cell(r.before), cell(r.after)]),
    [['实木地板', '实木地板、岩板台面']],
  );
  const mat = (action: string, diff: Record<string, unknown>) =>
    drawerView(entry({ action, targetType: 'material', targetId: 'm-1', diff }), RENO, renoLookups).changes!;
  eq(
    '金额：单位取同一条的计价单位（新建、两边都改了单位的修改）；diff 里没有单位时写「元」',
    [
      mat('catalog.create', { id: [null, 'm-1'], name: [null, '实木地板'], priceUnit: [null, '延米'], unitPrice: [null, 98] }).rows.map(
        (r) => cell(r.after),
      ),
      mat('catalog.update', { priceUnit: ['㎡', '延米'], unitPrice: [120, 98] }).rows.map((r) => [cell(r.before), cell(r.after)]),
      mat('catalog.update', { unitPrice: [120, 98] }).rows.map((r) => [cell(r.before), cell(r.after)]),
    ],
    [
      ['m-1', '实木地板', '延米', '98元/延米'],
      [
        ['㎡', '延米'],
        ['120元/㎡', '98元/延米'],
      ],
      [['120元', '98元']],
    ],
  );
}

// 详情抽屉
{
  const v = drawerView(update, TRAVEL, lookups);
  eq(
    '抽屉：句子一行写完（带补充）',
    `${v.actor.name} ${v.parts.map((p) => p.text).join('')}${v.tail ?? ''}`,
    `小林 修改了线路「${SICHUAN}」的住宿档次、行程亮点`,
  );
  eq('抽屉：时间写到秒、操作者、对象是实体名加编号', v.facts, [
    { label: '时间', text: '2026-09-26 10:12:44' },
    { label: '操作者', text: '小林' },
    { label: '对象', text: '线路', code: 'r-sichuan-lux' },
  ]);
  eq(
    '抽屉：改动表的标题与说明（怎么读行内差异、其余几条没改）',
    [v.changes?.title, v.changes?.created, v.changes?.notes],
    ['改了2处', false, ['划线的字是删去的，加底色的字是新加的', '行程亮点其余3条没改']],
  );
  eq(
    '抽屉：去处是这条线路（实体与编号）；技术详情里是动作编码、对象类型与编号',
    [v.link, v.tech.rows.slice(0, 2)],
    [
      { to: 'catalog', kind: 'route', code: 'r-sichuan-lux', label: '打开这条线路' },
      [
        ['动作', 'catalog.update'],
        ['对象', 'route · r-sichuan-lux'],
      ],
    ],
  );
  check(
    '抽屉：复制的是这条记录的 JSON 原文',
    JSON.parse(v.tech.copy).id === update.id && JSON.parse(v.tech.copy).action === 'catalog.update',
  );
  const c = drawerView(create, TRAVEL, lookups).changes!;
  eq(
    '抽屉：新建只画「字段 · 内容」，只列填了的（空数组不列），有序子项写一格',
    [c.title, c.created, c.rows.map((r) => [r.label[0], 'text' in r.after ? r.after.text : ''])],
    [
      '填了8项',
      true,
      [
        ['线路编号', 'r-guizhou-5d'],
        ['线路名称', GUIZHOU],
        ['天数', '5天'],
        ['境内还是境外', '境内'],
        ['每人起价', '13,800元/人'],
        ['适合客群', '家庭、亲子、银发'],
        ['逐日行程', '1天'],
        ['行程亮点', '逛西江千户苗寨、走小七孔'],
      ],
    ],
  );
  const nested = drawerView(
    entry({
      action: 'catalog.create',
      targetType: 'route',
      targetId: 'r-b',
      diff: { id: [null, 'r-b'], intensity: [null, { level: '较累', hardest: '徒步5小时' }] },
    }),
    TRAVEL,
    {},
  ).changes!;
  eq(
    '抽屉：新建时嵌套对象逐个写子字段，不写 JSON',
    nested.rows.map((r) => [r.label[0], cell(r.after)]),
    [
      ['线路编号', 'r-b'],
      ['体力强度', '较累'],
      ['最累的一段', '徒步5小时'],
    ],
  );
  const act = drawerView(
    entry({ action: 'catalog.activate', targetType: 'route', targetId: 'r-a', diff: { status: ['draft', 'active'] } }),
    TRAVEL,
    {},
  );
  eq(
    '抽屉：上架是一行「状态 · 草稿 · 已上架」',
    act.changes?.rows.map((r) => [r.label, r.before, r.after]),
    [[['状态'], { text: '草稿' }, { text: '已上架' }]],
  );
  const fix = drawerView(
    entry({
      action: 'catalog.locked_fix',
      ...cli,
      actorName: 'catalog-fix',
      targetType: 'hotel',
      targetId: 'h-1',
      diff: { nightlyFrom: [1800, 1880], reason: '合同价写错' },
    }),
    TRAVEL,
    {},
  );
  eq(
    '抽屉：修正多一行「原因」，原因不进改动表，也不算认不出的一项',
    [fix.facts.at(-1), fix.changes?.rows.map((r) => r.label[0]), fix.changes?.title, fix.changes?.notes],
    [{ label: '原因', text: '合同价写错' }, ['每晚起价'], '改了1处', []],
  );
  eq('抽屉：命令行的操作者写「命令行」', fix.facts[1], { label: '操作者', text: '命令行' });
  const odd = (diff: Record<string, unknown>) =>
    drawerView(entry({ action: 'catalog.update', targetType: 'route', targetId: 'r-a', diff }), TRAVEL, {}).changes;
  eq(
    '抽屉：包里没有的键也算进「改了N处」，原名不写；只有这种键时改动表没有行',
    [odd({ hotelLevel: ['顶级精品', '顶级野奢'], legacyKey: [1, 2] }), odd({ legacyKey: [1, 2] })].map((c) => [
      c?.title,
      c?.rows.length,
      c?.notes,
    ]),
    [
      ['改了2处', 1, ['另1项见技术详情']],
      ['改了1处', 0, ['另1项见技术详情']],
    ],
  );
  eq(
    '抽屉：只改了子项里包里没有的键，写「改了1处」与「另1项见技术详情」',
    [odd({ itinerary: [[{ day: 1, title: '成都', legacyNote: 'a' }], [{ day: 1, title: '成都', legacyNote: 'b' }]] })].map((c) => [
      c?.title,
      c?.rows.length,
      c?.notes,
    ]),
    [['改了1处', 0, ['另1项见技术详情']]],
  );
  const pub = drawerView(publish, TRAVEL, {});
  eq(
    '抽屉：话术写版本、去处是销售话术、没有改动表；UUID 只在技术详情里',
    [pub.facts[2], pub.link, pub.changes, pub.tech.rows[1]],
    [{ label: '对象', text: '话术v2' }, { to: 'sop', label: '打开销售话术' }, null, ['对象', `sop_version · ${UUID}`]],
  );
  const rb = (same: boolean) =>
    drawerView(
      entry({
        action: 'sop.rollback',
        actorName: '老板',
        diff: { fromVersionNo: 2, toVersionNo: 3, targetVersionNo: 1, sameHashAsTarget: same },
      }),
      TRAVEL,
      {},
    );
  eq(
    '抽屉：回滚结果与目标版本不同时加一句提醒，相同时不加',
    [rb(false).warning?.title, rb(true).warning],
    ['回滚结果与v1不完全一样', null],
  );
  eq(
    '抽屉：diff 里没写 sameHashAsTarget（形状不对）时不提醒',
    drawerView(entry({ action: 'sop.rollback', diff: { toVersionNo: 3, targetVersionNo: 1 } }), TRAVEL, {}).warning,
    null,
  );
  eq(
    '抽屉：导入初始配置没有对象、没有去处',
    [drawerView(importConfig, TRAVEL, {}).facts.length, drawerView(importConfig, TRAVEL, {}).link],
    [2, null],
  );
  eq(
    '抽屉：换一个包，去处与字段名跟着换',
    [drawerView(update, HOME, {}).link?.label, drawerView(update, HOME, {}).changes?.rows.map((r) => r.label[0])],
    ['打开这条装修套餐', ['主材档次']],
  );
  eq(
    '抽屉：产品库的记录没有编号时没有对象、没有去处（「打开这条」无从链起）',
    [drawerView({ ...update, targetId: null }, TRAVEL, {}).facts.length, drawerView({ ...update, targetId: null }, TRAVEL, {}).link],
    [2, null],
  );

  // 不变量 7：每种动作（加一种表外的）在页面上看得见的字里没有动作编码与 UUID
  const CODES = /\b(sop|catalog|auth|platform|config)\.[a-z_]+/;
  const HEX = /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{12,}/i;
  const bad: string[] = [];
  for (const action of [...Object.keys(AUDIT_ACTIONS), 'billing.charge']) {
    const e = entry({
      action,
      targetType: action.startsWith('catalog.') ? 'route' : 'user',
      targetId: action.startsWith('catalog.') ? 'r-a' : UUID,
      diff: { email: 'a@b.test', role: 'admin' },
    });
    const line = timelineGroups([e], TRAVEL, {}, NOW)[0]!.lines[0]!;
    const dv = drawerView(e, TRAVEL, {});
    const visible = [
      line.actor.name,
      ...line.parts.map((p) => p.text),
      line.summary?.text ?? '',
      line.summary?.code ?? '',
      ...dv.facts.flatMap((f) => [f.label, f.text, f.code ?? '']),
      dv.tail ?? '',
      dv.link?.label ?? '',
      dv.warning?.title ?? '',
      ...(dv.changes?.rows.flatMap((r) => [...r.label, cell(r.before), cell(r.after)]) ?? []),
    ].join(' ');
    if (CODES.test(visible) || HEX.test(visible)) bad.push(`${action}：${visible}`);
  }
  eq('不变量 7：每种动作的句子、摘要、抽屉里没有动作编码与 UUID（只在技术详情里）', bad, []);
}

// ---------------- 2. 在 DOM 里挂载 ----------------
const realNow = Date.now;
Date.now = () => NOW;

interface Server {
  log: AuditEntryView[];
  /** 这些请求回 500 */
  fail?: RegExp;
}
let server: Server = { log: SCENE };
let requests: string[] = [];
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** 照服务端：actions 过滤、before 取更早的、limit 条（默认 50），多一条才给 nextBefore；产品库列表回空 */
function respond(method: string, url: URL): Response {
  const p = url.pathname.replace(/^\/api\/console/, '');
  const q = url.searchParams;
  if (server.fail?.test(`${method} ${p}${url.search}`)) return json(500, { error: 'internal', detail: '故意的' });
  if (method === 'GET' && p === '/audit') {
    const actions = q.get('actions')?.split(',');
    const before = q.get('before') === null ? null : Number(q.get('before'));
    const limit = Number(q.get('limit') ?? 50);
    const rows = server.log.filter((e) => (!actions || actions.includes(e.action)) && (before === null || e.id < before));
    const items = rows.slice(0, limit);
    return json(200, { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null });
  }
  // 产品库列表（对象名的缓存）：线路里有 r-sichuan-lux，审计的 diff 里没有它的名字，句子里的名字从这里来
  if (method === 'GET' && p === '/catalog/route')
    return json(200, { items: [{ kind: 'route', code: 'r-sichuan-lux', payload: { title: SICHUAN } }] });
  if (method === 'GET' && p.startsWith('/catalog/')) return json(200, { items: [] });
  return json(404, { error: 'not_found' });
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  return respond(method, url);
}) as typeof fetch;
const auditRequests = (): string[] => requests.filter((r) => r.startsWith('GET /api/console/audit'));
const paramsOf = (r: string): URLSearchParams => new URL(r.slice(4), 'http://localhost').searchParams;

const me = (role: Role): Me => ({ userId: 'u1', displayName: '老板', role, csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' });
const member = (role: Role, pack = TRAVEL): Viewer => ({ kind: 'member', me: me(role), pack });

async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
}

/** 挂上真的 AuditPage：/audit 的 validateSearch 与 router.tsx 同一个；/catalog/$kind/$code、/sop 是抽屉去处用的空页 */
async function mount(viewer: Viewer, search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/audit', validateSearch: auditSearch, component: AuditPage }),
      createRoute({ getParentRoute: () => root, path: '/catalog/$kind/$code', component: () => null }),
      createRoute({ getParentRoute: () => root, path: '/sop', component: () => null }),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [`/console/audit${search}`] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  await settle(qc);
  const $ = (sel: string, from: ParentNode = box): HTMLElement[] => [...from.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | undefined | null): string => (e?.textContent ?? '').trim();
  return {
    qc,
    router,
    box,
    $,
    text,
    texts: (sel: string): string[] => $(sel).map(text),
    /** 各组：组标题与每句（句子、摘要、时刻） */
    days: (): [string, string[][]][] =>
      $('.au-day').map((d) => [
        text(d.querySelector('.au-day-title')),
        $(':scope > .au-list > .au-row', d).map((row) => [
          text(row.querySelector('.au-sentence')),
          text(row.querySelector('.au-summary')),
          text(row.querySelector(':scope > .au-time')),
        ]),
      ]),
    drawer: (): HTMLElement | null => document.querySelector<HTMLElement>('.au-drawer .ant-drawer-content-wrapper'),
    url: (): string => router.state.location.href,
    async click(el: Element | undefined | null) {
      if (!el) throw new Error('要点的元素不在页面上');
      await act(async () => {
        (el as HTMLElement).click();
      });
      await settle(qc);
    },
    async key(el: Element, k: string) {
      await act(async () => {
        el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }) as unknown as Event);
      });
      await settle(qc);
    },
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
      for (const n of Array.from(document.body.children)) if (n !== box) n.remove();
    },
  };
}

// 2.1 所有者：请求、组、句子、合并的一句
{
  server = { log: SCENE };
  requests = [];
  const m = await mount(member('owner'));
  const reqs = auditRequests();
  eq(
    '请求：一次，每页 50 条，带「全部、不显示登录记录」换算出的 actions',
    [reqs.length, paramsOf(reqs[0]!).get('limit'), paramsOf(reqs[0]!).get('actions')],
    [1, '50', auditActionsParam('all', false)],
  );
  eq(
    '页头：标题与状态句',
    [m.text(m.box.querySelector('h1')), m.text(m.box.querySelector('.page-status'))],
    ['审计日志', '谁在什么时候改了什么'],
  );
  const days = m.days();
  eq(
    '时间线：三组，组标题带星期；登录记录默认不显示',
    days.map((d) => d[0]),
    ['今天·9月26日 周六', '昨天·9月25日 周五', '9月24日 周四'],
  );
  eq('时间线：今天三句（句子、下一行、时刻）', days[0]![1], [
    [`小林 新建了线路草稿「${GUIZHOU}」`, '线路编号r-guizhou-5d', '13:40'],
    ['小林 新建了6条酒店草稿', '青城山六善酒店、成都锦江宾馆、大研安缦等6条·展开6条', '11:20'],
    [`小林 修改了线路「${SICHUAN}」`, '改了：住宿档次、行程亮点', '10:12'],
  ]);
  eq(
    '时间线：时刻悬停写绝对时间',
    m.$(':scope > .au-list > .au-row > .au-time', m.$('.au-day')[1]).map((e) => [e.getAttribute('title'), e.getAttribute('datetime')]),
    [['9月25日 18:30', publish.at]],
  );
  eq('时间线：命令行用方块图标，真人用头像（首字）', [m.$('.au-bot').length, m.texts('.au-avatar')], [4, ['小', '小', '小', '老']]);
  const expand = m.$('.au-expand')[0]!;
  eq('合并的一句：「展开6条」收着', [expand.getAttribute('aria-expanded'), m.$('.au-child').length], ['false', 0]);
  await m.click(expand);
  eq(
    '展开：逐条列出 6 条，每条是能点开抽屉的句子',
    [m.$('.au-expand')[0]!.getAttribute('aria-expanded'), m.texts('.au-child .au-sentence')],
    ['true', HOTEL_NAMES.map((n) => `新建了酒店草稿「${n}」`)],
  );
  check(
    '展开：按钮改写「收起」，aria-controls 指向逐条的列表',
    m.text(m.$('.au-expand')[0]) === '收起' && !!document.getElementById(m.$('.au-expand')[0]!.getAttribute('aria-controls')!),
  );
  await m.click(m.$('.au-row.is-merged .au-sentence')[0]);
  eq('点合并那一句的文字：收起', m.$('.au-child').length, 0);
  eq(
    '到底了：没有「加载更早的记录」，写一句到底了',
    [m.$('.au-more').length, m.text(m.box.querySelector('.au-end'))],
    [0, '没有更早的记录了'],
  );
  eq('整页没有红色（没有 error 类的 Alert）', m.$('.ant-alert-error').length, 0);
  // 不变量 7：默认状态下页面上看得见的字没有动作编码与 UUID
  const visible = m.box.textContent ?? '';
  check(
    '不变量 7：页面文字里没有动作编码与 UUID',
    !/\b(sop|catalog|auth|platform|config)\.[a-z_]/.test(visible) && !/[0-9a-f]{12,}/i.test(visible),
    visible.slice(0, 200),
  );
  await m.unmount();
}

// 2.2 筛选写进地址，按新地址请求；地址还原筛选
{
  server = { log: SCENE };
  requests = [];
  const m = await mount(member('owner'));
  const segment = (label: string): HTMLElement | undefined =>
    m
      .$('.ant-segmented-item')
      .find((e) => m.text(e) === label)
      ?.querySelector<HTMLElement>('input') ?? undefined;
  eq(
    '分段控件：整条轨道不进 Tab 顺序（Tab 直接进选中的那一段）',
    [m.box.querySelector('.ant-segmented')?.getAttribute('tabindex'), segment('全部')?.getAttribute('tabindex')],
    ['-1', null],
  );
  await m.click(segment('销售话术'));
  eq(
    '点「销售话术」：地址 ?cat=sop，请求只带 sop 的动作',
    [m.url(), paramsOf(auditRequests().at(-1)!).get('actions')],
    ['/audit?cat=sop', auditActionsParam('sop', false)],
  );
  eq(
    '只剩话术那一组',
    m.days().map((d) => d[1].map((r) => r[0])),
    [['老板 发布了话术v2']],
  );
  await m.click(m.box.querySelector('[role="switch"]'));
  eq('打开「显示登录记录」：类别留着，地址 ?cat=sop&login=1', m.url(), '/audit?cat=sop&login=1');
  await m.click(segment('账号与登录'));
  eq(
    '换到「账号与登录」：开关留着，请求带上登录',
    [m.url(), paramsOf(auditRequests().at(-1)!).get('actions')],
    ['/audit?cat=account&login=1', auditActionsParam('account', true)],
  );
  check(
    '登录记录显示出来',
    m.days().some((d) => d[1].some((r) => r[0] === '老板 登录了')),
  );
  await m.click(segment('全部'));
  eq(
    '「全部」且显示登录记录：地址只留 login，请求不带 actions',
    [m.url(), paramsOf(auditRequests().at(-1)!).has('actions')],
    ['/audit?login=1', false],
  );
  await m.unmount();

  requests = [];
  const deep = await mount(member('owner'), '?cat=catalog&login=1');
  eq(
    '打开带筛选的地址：分段控件选中产品库、开关开着，请求按地址',
    [
      deep.text(deep.box.querySelector('.ant-segmented-item-selected')),
      deep.box.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
      paramsOf(auditRequests()[0]!).get('actions'),
    ],
    ['产品库', 'true', auditActionsParam('catalog', true)],
  );
  await deep.unmount();
}

// 2.3 加载更早的记录：每页 50 条，页边上的一句不截断
{
  // 52 条：48 条话术发布、6 条同一次导入的酒店草稿（跨在第 50 条上），再 2 条发布
  nextId = 5000;
  let vn = 900;
  const pubs = (n: number, startMin: number): AuditEntryView[] =>
    Array.from({ length: n }, (_, i) =>
      entry({
        action: 'sop.publish',
        actorName: '老板',
        diff: { versionNo: (vn -= 1), changedKeys: [] },
        at: new Date(NOW - (startMin + i) * 60_000).toISOString(),
      }),
    );
  // 按日志的顺序造（id 倒序）：先 47 条发布，再 6 条酒店草稿，再 3 条发布
  const newer = pubs(47, 1);
  const run = HOTEL_NAMES.map((name, i) =>
    entry({
      action: 'catalog.create',
      targetType: 'hotel',
      targetId: `h-${i}`,
      diff: { id: [null, `h-${i}`], name: [null, name] },
      at: new Date(NOW - 200 * 60_000 - i * 1000).toISOString(),
    }),
  );
  server = { log: [...newer, ...run, ...pubs(3, 300)] };
  requests = [];
  const m = await mount(member('owner'));
  const lines = (): string[] => m.days().flatMap((d) => d[1].map((r) => r[0]));
  eq(
    '第一页：凑够 50 条时页尾那一句还没完，接着取：6 条合成一句，不截成「新建了3条」',
    [auditRequests().length, lines().at(-1)],
    [2, '小林 新建了6条酒店草稿'],
  );
  eq('第一页：48 句（47 条发布加合并的一句）', lines().length, 48);
  const more = m.$('.au-more')[0];
  check('还有更早的：底部是「加载更早的记录」', m.text(more) === '加载更早的记录');
  await act(async () => more?.focus());
  await m.click(more);
  eq(
    '加载更早的：先用上次多取的，不再请求；接在后面，不重不漏',
    [auditRequests().length, lines().length, new Set(lines()).size],
    [2, 51, 51],
  );
  eq('到底了', [m.$('.au-more').length, m.$('.au-end').length], [0, 1]);
  check(
    '到底了：按钮换成那一句，焦点跟到那一句上，不掉回 body',
    document.activeElement === m.box.querySelector('.au-end') && m.box.querySelector('.au-end')?.getAttribute('tabindex') === '-1',
    `焦点在 ${document.activeElement?.tagName}.${document.activeElement?.className}`,
  );
  await m.unmount();

  // 翻页出错：已经列出的留着，底部就地写没取到、可以重试
  server = { log: [...pubs(60, 1)] };
  requests = [];
  const e = await mount(member('owner'));
  server.fail = /before=/;
  await act(async () => e.$('.au-more')[0]?.focus());
  await e.click(e.$('.au-more')[0]);
  eq(
    '翻页出错：已列出的 50 条留着，底部是出错提示和重试',
    [e.days().flatMap((d) => d[1]).length, e.$('.ant-alert').length, e.$('.au-more').length],
    [50, 1, 1],
  );
  check('翻页出错：焦点还在「加载更早的记录」上', document.activeElement === e.$('.au-more')[0]);
  server.fail = undefined;
  const retry = e.$('.ant-alert button')[0];
  await act(async () => retry?.focus());
  await e.click(retry);
  eq('重试：接着取到', e.days().flatMap((d) => d[1]).length, 60);
  check(
    '重试：出错提示与按钮都没了，焦点放到「没有更早的记录了」上',
    document.activeElement === e.box.querySelector('.au-end'),
    `焦点在 ${document.activeElement?.tagName}.${document.activeElement?.className}`,
  );
  await e.unmount();

  // 取的时候焦点在别处（这里是分段控件）：取到底也不把焦点挪走
  server = { log: [...pubs(60, 1)] };
  const f = await mount(member('owner'));
  const input = f.$('.ant-segmented-item input')[0];
  await act(async () => input?.focus());
  await f.click(f.$('.au-more')[0]);
  check(
    '焦点在别处时取到底：焦点留在原处',
    f.$('.au-end').length === 1 && document.activeElement === input,
    `焦点在 ${document.activeElement?.tagName}.${document.activeElement?.className}`,
  );
  await f.unmount();
}

// 2.4 空、类别下没有记录、出错
{
  server = { log: [] };
  const none = await mount(member('owner'));
  eq(
    '一条记录都没有：「改动会记在这里」，标题是 h2（紧跟页名 h1，不跳级）',
    [none.text(none.box.querySelector('.state-empty-title')), none.box.querySelector('.state-empty-title')?.tagName],
    ['改动会记在这里', 'H2'],
  );
  await none.unmount();
  server = { log: [login] };
  const filtered = await mount(member('owner'), '?cat=platform&login=1');
  eq(
    '这个类别下没有：说明加「看全部」（清掉类别、开关留着），标题是 h2',
    [
      filtered.text(filtered.box.querySelector('.state-empty-title')),
      filtered.box.querySelector('.state-empty-title')?.tagName,
      filtered.box.querySelector('.state-empty a')?.getAttribute('href'),
    ],
    ['这个类别下没有记录', 'H2', '/console/audit?login=1'],
  );
  await filtered.click(filtered.box.querySelector('.state-empty a'));
  eq(
    '点「看全部」：登录记录列出来',
    filtered.days().flatMap((d) => d[1].map((r) => r[0])),
    ['老板 登录了'],
  );
  await filtered.unmount();
  server = { log: SCENE, fail: /\/audit/ };
  const err = await mount(member('owner'));
  eq(
    '出错：就地写「没取到」加重试',
    [err.text(err.box.querySelector('.ant-alert-title, .ant-alert-message')), err.$('.ant-alert button').length],
    ['没取到', 1],
  );
  server.fail = undefined;
  await err.click(err.$('.ant-alert button')[0]);
  eq('重试后列出来', err.days().length, 3);
  await err.unmount();
}

// 2.5 详情抽屉
{
  server = { log: SCENE };
  requests = [];
  const m = await mount(member('owner'));
  const target = m.$('.au-row .au-sentence').find((e) => m.text(e).startsWith('小林 修改了线路'))!;
  eq('句子是打开对话框的按钮', [target.tagName, target.getAttribute('aria-haspopup')], ['BUTTON', 'dialog']);
  await act(async () => target.focus());
  await m.click(target);
  const d = m.drawer();
  check('点一句：抽屉打开', !!d && d.closest('.ant-drawer')?.classList.contains('ant-drawer-open') === true);
  eq(
    '抽屉：标题与句子（一行写完）',
    [m.text(document.querySelector('.au-drawer .ant-drawer-title')), m.text(document.querySelector('.au-detail-sentence'))],
    ['改动详情', `小林 修改了线路「${SICHUAN}」的住宿档次、行程亮点`],
  );
  eq(
    '抽屉：时间、操作者、对象',
    m.$('.au-facts dd', document).map((e) => m.text(e)),
    ['2026-09-26 10:12:44', '小林', '线路·r-sichuan-lux'],
  );
  eq(
    '抽屉：改动表的表头与各行，删去的划线、新加的加底色',
    [
      m.$('.au-table thead th', document).map((e) => m.text(e)),
      m.$('.au-table tbody tr', document).map((tr) => [...tr.children].map((c) => m.text(c))),
      m.$('.au-table del', document).map((e) => m.text(e)),
      m.$('.au-table ins', document).map((e) => m.text(e)),
    ],
    [
      ['字段', '原来', '现在'],
      [
        ['住宿档次', '顶级精品', '顶级野奢'],
        ['行程亮点第2条', HL_OLD, HL_NEW],
      ],
      ['清晨', '俯瞰'],
      ['破晓', '拍下', '在晨雾中次第亮起'],
    ],
  );
  eq('抽屉：表格下的说明', m.text(document.querySelector('.au-notes')), '划线的字是删去的，加底色的字是新加的·行程亮点其余3条没改');
  eq(
    '抽屉：去处「打开这条线路」',
    [m.text(document.querySelector('.au-link')), document.querySelector('.au-link')?.getAttribute('href')],
    ['打开这条线路', '/console/catalog/route/r-sichuan-lux'],
  );
  const tech = document.querySelector<HTMLDetailsElement>('.au-tech details');
  eq(
    '抽屉：技术详情默认折叠，里面有动作编码、JSON 原文与复制按钮',
    [tech?.open, /catalog\.update/.test(tech?.textContent ?? ''), m.text(tech?.querySelector('.tech-details-copy'))],
    [false, true, '复制'],
  );
  eq(
    '选中的那一句：aria-current 与 --selected 底',
    m.$('.au-row.is-selected').map((e) => [m.text(e.querySelector('.au-sentence')), e.getAttribute('aria-current')]),
    [[`小林 修改了线路「${SICHUAN}」`, 'true']],
  );
  // 复制：剪贴板拒绝时选中原文、按钮改写；能写时写「已复制」
  const copyButton = (): HTMLElement | null => document.querySelector<HTMLElement>('.au-tech .tech-details-copy');
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => Promise.reject(new Error('NotAllowedError')) },
  });
  await m.click(copyButton());
  const sel = window.getSelection();
  eq(
    '复制：剪贴板不可用时选中原文，按钮写「已选中，手动复制」',
    [m.text(copyButton()), !!sel?.anchorNode && !!document.querySelector('.au-tech pre')?.contains(sel.anchorNode)],
    ['已选中，手动复制', true],
  );
  sel?.removeAllRanges();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => void copied.push(t) },
  });
  await m.click(copyButton());
  eq(
    '复制：写进剪贴板的是这条记录的 JSON 原文，按钮写「已复制」',
    [m.text(copyButton()), copied.length === 1 && JSON.parse(copied[0]!).id === update.id],
    ['已复制', true],
  );
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  check('抽屉里没有红色', document.querySelectorAll('.au-drawer .ant-alert-error').length === 0);
  // 关之前把焦点放进抽屉：浏览器里 antd 打开时会这样做，happy-dom 里不一定，不放的话焦点一直在那一句上，下一条查不出东西
  const closeButton = (): HTMLElement | null => document.querySelector<HTMLElement>('.au-drawer [aria-label="关闭"]');
  await act(async () => closeButton()?.focus());
  await m.click(closeButton());
  check('关上：抽屉收起，选中的底没了', !document.querySelector('.au-drawer .ant-drawer-open') && m.$('.au-row.is-selected').length === 0);
  check('关上：焦点回到点开它的那一句', document.activeElement === target);

  // 展开合并的一句，点其中一条
  await m.click(m.$('.au-expand')[0]);
  await m.click(m.$('.au-child .au-sentence')[2]);
  eq(
    '展开后的一条：抽屉写这一条，新建只画两栏',
    [
      m.text(document.querySelector('.au-detail-sentence')),
      m.$('.au-table thead th', document).map((e) => m.text(e)),
      m.$('.au-child.is-selected').length,
      m.$('.au-expand')[0]?.getAttribute('aria-expanded'),
    ],
    ['小林 新建了酒店草稿「大研安缦」', ['字段', '内容'], 1, 'true'],
  );
  await m.click(document.querySelector('.au-drawer [aria-label="关闭"]'));
  // 点展开的一条的空白处（时刻上）：同样打开这一条，外面合并的那一句不跟着收起
  await m.click(m.$('.au-child .au-time')[4]);
  eq(
    '点展开的一条的空白处：打开这一条，列表还展开着',
    [m.text(document.querySelector('.au-detail-sentence')), m.$('.au-child').length],
    ['小林 新建了酒店草稿「拉萨瑞吉」', 6],
  );
  await m.click(document.querySelector('.au-drawer [aria-label="关闭"]'));
  // 点一句的空白处（摘要上）：同点句子
  await m.click(m.$('.au-row .au-summary').find((e) => m.text(e).startsWith('改了：住宿档次')));
  eq(
    '点一行的空白处：同点句子',
    m.text(document.querySelector('.au-detail-sentence')),
    `小林 修改了线路「${SICHUAN}」的住宿档次、行程亮点`,
  );
  // 这次打开前焦点在上一次关上时还回去的「拉萨瑞吉」那一条上：antd 自己还焦点的话会还到那里
  await act(async () => closeButton()?.focus());
  await m.click(closeButton());
  check('点在行上打开、焦点原来在别处：关上后焦点回到这一句，不回到原来的地方', document.activeElement === target);

  // 话术：去处是销售话术
  await m.click(m.$('.au-row .au-sentence').find((e) => m.text(e).startsWith('老板 发布了话术')));
  eq(
    '话术的一条：对象写版本、去处是销售话术、没有改动表',
    [
      m.$('.au-facts dd', document).map((e) => m.text(e))[2],
      document.querySelector('.au-link')?.getAttribute('href'),
      document.querySelectorAll('.au-table').length,
    ],
    ['话术v2', '/console/sop', 0],
  );
  await m.click(document.querySelector('.au-link'));
  eq('点去处：到话术页', m.url(), '/sop');
  await m.unmount();
}

// 产品库的去处：点「打开这条线路」到这一条的详情页
{
  server = { log: [update] };
  const m = await mount(member('owner'));
  await m.click(m.$('.au-row .au-sentence')[0]);
  await m.click(document.querySelector('.au-link'));
  eq('点去处：到这条线路的详情', m.url(), '/catalog/route/r-sichuan-lux');
  await m.unmount();
}

// 改的全是包里没有的键（包改过、字段删了）：不画只有表头的表
{
  server = {
    log: [entry({ action: 'catalog.update', targetType: 'route', targetId: 'r-sichuan-lux', diff: { legacyKey: [1, 2] } })],
  };
  const m = await mount(member('owner'));
  await m.click(m.$('.au-row .au-sentence')[0]);
  eq(
    '抽屉：改的全是包里没有的键时写「改了1处」与「另1项见技术详情」，没有表',
    [
      m.text(document.querySelector('.au-changes-title')),
      document.querySelectorAll('.au-table').length,
      m.text(document.querySelector('.au-notes')),
    ],
    ['改了1处', 0, '另1项见技术详情'],
  );
  await m.unmount();
}

// 2.6 坐席与匿名：不发请求，只写一句说明
{
  requests = [];
  const agent = await mount(member('agent'));
  eq(
    '坐席：不请求审计，写明看不到',
    [auditRequests().length, agent.text(agent.box.querySelector('.state-empty-title'))],
    [0, '你的角色看不到审计日志'],
  );
  await agent.unmount();
  requests = [];
  const anon = await mount({ kind: 'anon', pack: TRAVEL });
  eq(
    '匿名：一个请求都不发，写登录后才能看',
    [requests.length, anon.text(anon.box.querySelector('.state-empty-title'))],
    [0, '登录后才能看审计日志'],
  );
  await anon.unmount();
}

// 2.7 换一个行业包：类别名、实体名跟着换
{
  server = { log: [update] };
  const m = await mount(member('owner', HOME));
  eq(
    '家装式的包：分段控件的第三段、句子里的实体名',
    [m.texts('.ant-segmented-item')[2], m.days()[0]![1][0]![0]],
    ['套餐库', `小林 修改了装修套餐「${SICHUAN}」`],
  );
  await m.unmount();
}

Date.now = realNow;
if (fails.length) {
  console.error(`审计日志自测：${fails.length} 条失败（${pass} 条通过）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`审计日志自测：${pass} 条全部通过`);
process.exit(0);
