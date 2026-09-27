// 总览的自测（console UX spec「逐页设计 · 总览（A 页）」、验收 10，设计系统 §5.10、§5.11、§6.7、§10.0、§10.2 A 页，plan 第 4 步）。
// 数据照设计系统 §10.0 的场景（时刻 2026-09-26 周六 14:30，Asia/Shanghai）。行业包是本文件里手写的夹具：console 里只有
// 渲染器自测能 import 注册表和假包（scripts/check-boundaries.ts），这里另写一份旅游式的包和一份家装式的包，证明页面只认包里的配置。
// 1. 纯逻辑（model.ts）：「需要你处理」的顺序是 A01、F01、话术草稿、线路草稿、6条酒店草稿，各行的对象与上下文；话术问题的说法
//    不带工具、字段、短语的原文；上架前检查的必须项与建议项；系统状态的三种 Alert；四个业务数和明细；阶段条（不含终态、
//    分支缩进、按最大值缩放、包外的阶段合成「其他」、各行之和等于 AI 接待中）；最近变更先合并再取 5 句、同一天只写一次日期；
//    审计记录取够了没有；
// 2. 在 DOM 里挂载（happy-dom，与渲染器自测共用 selftest-dom.ts）：真的 OverviewPage 加假的后台接口。所有者看到全部五块；
//    某个接口 500 时只有用它的那一块写「没取到」（验收 10：/audit 500 只有「最近变更」出错）；坐席没有「最近变更」和草稿类待办，
//    也不发这些请求；demo 匿名只有「在售」一格、只取产品库列表；审计按页往前取，一次导入不被截断；换一个行业包，
//    实体、阶段、叫法都跟着换，请求的是那个包的 kind；阶段条和业务数链到带 state、stage 的会话列表（验收 10）。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/overview/overview.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import './selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AuditEntryView,
  CatalogItem,
  ContractViolation,
  ConversationCounts,
  ConversationRow,
  DraftCheck,
  Me,
  Role,
  SopOverview,
  Status,
} from '../../../src/shared/console-api.js';
import { auditRuns } from '../../../src/shared/audit-text.js';
import type { EntityType, FieldDef, FieldType, IndustryPack } from '../../../src/shared/pack.js';
import { conversationsSearch } from '../conversations-search.js';
import { ConversationsPage } from '../pages/ConversationsPage.js';
import type { Viewer } from '../shell/boot.js';
import { workbenchHref } from '../shell/model.js';
import { VIEWER_KEY } from '../viewer.js';
import {
  catalogCounts,
  catalogTodos,
  enoughAudit,
  inSaleKpi,
  issueText,
  memberKpis,
  sopProblemText,
  sopTodo,
  stageRows,
  systemView,
  timeline,
  todoOrder,
  updatedWhen,
  waitingTodos,
} from './model.js';
import { OverviewPage } from './OverviewPage.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

check('时区钉成了上海', new Date(Date.UTC(2026, 8, 25, 16)).getDate() === 26);

// ---------------- 夹具：设计系统 §10.0 的场景 ----------------

const NOW = Date.parse('2026-09-26T14:30:00+08:00');
const MIN = 60_000;
const at = (s: string): string => new Date(Date.parse(`${s}+08:00`)).toISOString();

const f = (key: string, type: FieldType, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  type,
  label,
  group: 'basic',
  ...extra,
});
const entity = (kind: string, label: string, icon: string, titleKey: string, fields: FieldDef[]): EntityType => ({
  kind,
  label,
  icon,
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey,
  subtitleKeys: [],
  groups: [{ key: 'basic', label: '基本信息' }],
  lockGroups: {},
  fields,
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});

/** 旅游式的包：必须项是编号、名称、天数、住宿档次、行程亮点、逐日行程（每天的标题与住宿）加「条数与天数一致」，共 7 项；体力强度是建议项 */
const ROUTE = entity('route', '线路', 'route', 'title', [
  f('$code', 'text', '线路编号'),
  f('title', 'text', '线路名称'),
  f('days', 'intUnit', '天数', { unit: '天', min: 1 }),
  f('intensity.level', 'enum', '体力强度', { options: ['轻松', '适中', '较累'], required: false, recommend: true }),
  f('hotelLevel', 'text', '住宿档次'),
  f('highlights', 'tags', '行程亮点'),
  f('itinerary', 'subItems', '逐日行程', {
    countFrom: 'days',
    itemNoun: '天',
    item: [f('title', 'text', '当天标题', { group: '' }), f('hotel', 'text', '当晚住宿', { group: '' })],
  }),
]);
const HOTEL = entity('hotel', '酒店', 'bed-double', 'name', [f('$code', 'text', '酒店编号'), f('name', 'text', '酒店名称')]);
const TRAVEL: IndustryPack = {
  id: 'fixture-travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: { search_routes: '查线路' }, sopFields: {} },
  // 与 nav.entities 的顺序故意不同：页面按 nav 排
  entities: [HOTEL, ROUTE],
  stages: [
    { key: 'greeting', label: '开场' },
    { key: 'discovery', label: '问需' },
    { key: 'recommend', label: '推荐' },
    { key: 'quote', label: '报价' },
    { key: 'objection', label: '异议', branchOf: 'quote' },
    { key: 'closing', label: '促成' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '由代码核对' },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'objections', heading: '异议处理', locked: false },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
};

const conv = (short: string, stage: string, handedOver: boolean, messageCount: number, updatedAt: string): ConversationRow => ({
  id: `wecom:cust_${short}`,
  channel: 'wecom',
  stage,
  handedOver,
  messageCount,
  updatedAt,
});
/** 接口的 ?state=human 按最后动静倒序：F01（8分钟前）在 A01（26分钟前）前面 */
const WAITING = [
  conv('F01', 'handoff', true, 2, new Date(NOW - 8 * MIN).toISOString()),
  conv('A01', 'handoff', true, 7, new Date(NOW - 26 * MIN).toISOString()),
];
const A02 = conv('A02', 'paid', false, 5, at('2026-09-24T17:20:00'));
/** AI 接待中、报价阶段的两个（会话列表按 state、stage 筛选时回它们） */
const QUOTED = [
  conv('C01', 'quote', false, 4, new Date(NOW - 120 * MIN).toISOString()),
  conv('C02', 'quote', false, 4, new Date(NOW - 180 * MIN).toISOString()),
];
const COUNTS: ConversationCounts = {
  total: 13,
  byState: { ai: 10, human: 2, paid: 1 },
  aiByStage: { discovery: 4, recommend: 3, quote: 2, closing: 1 },
  updatedToday: 6,
};

const item = (
  kind: string,
  code: string,
  payload: object,
  status: 'draft' | 'active',
  updatedAt: string,
  by: string | null = null,
): CatalogItem => ({ kind, code, ord: 0, status, rev: 1, payload, updatedByName: by, updatedAt }) as unknown as CatalogItem;
const GUIZHOU = {
  id: 'r-guizhou-5d',
  title: '贵州 小七孔·西江千户苗寨 5 日',
  days: 5,
  hotelLevel: '舒适型',
  highlights: ['非遗手作'],
  itinerary: [1, 2, 3, 4, 5].map((d) => ({ title: `第${d}天`, hotel: '凯里' })),
};
const ROUTES: CatalogItem[] = [
  ...Array.from({ length: 19 }, (_, i) =>
    item('route', `r-${i}`, { id: `r-${i}`, title: `线路${i}` }, 'active', at('2026-09-24T10:02:00')),
  ),
  item(
    'route',
    'r-sichuan-lux',
    { id: 'r-sichuan-lux', title: '四川 稻城亚丁·色达秘境 8 日' },
    'active',
    at('2026-09-26T10:12:00'),
    '小林',
  ),
  item('route', 'r-guizhou-5d', GUIZHOU, 'draft', at('2026-09-26T13:40:00'), '小林'),
];
const HOTEL_DRAFTS = ['青城山六善酒店', '成都锦江宾馆', '大研安缦', '丽江金茂', '西双版纳安纳塔拉', '腾冲石头纪'];
const HOTELS: CatalogItem[] = [
  ...Array.from({ length: 23 }, (_, i) => item('hotel', `h-${i}`, { id: `h-${i}`, name: `酒店${i}` }, 'active', at('2026-09-24T10:02:00'))),
  // 同一次 CSV 导入，更新时间相同：按编号排，前 3 个是青城山、锦江、大研
  ...HOTEL_DRAFTS.map((name, i) =>
    item('hotel', `h-new-${'abcdef'[i]}`, { id: `h-new-${i}`, name }, 'draft', at('2026-09-26T11:20:00'), '小林'),
  ),
];

const body = (heading: string | null, n: number, fill = 'x'): string =>
  heading === null ? fill.repeat(n) : `## ${heading}\n\n${fill.repeat(n)}`;
const SOP_SPEC = TRAVEL.sopSections.map(({ key, heading, locked }) => ({ key, heading, locked }));
const PUBLISHED = [
  { key: 'preamble', text: body(null, 232) },
  { key: 'stages', text: body('各阶段目标', 3117) },
  { key: 'tone', text: body('话术原则', 910) },
  { key: 'objections', text: body('异议处理', 531) },
  { key: 'wechat-style', text: body('微信语气规范', 577) },
];
const DRAFT = PUBLISHED.map((s) =>
  s.key === 'tone'
    ? { key: s.key, text: body('话术原则', 954, 'y') }
    : s.key === 'objections'
      ? { key: s.key, text: body('异议处理', 540, 'y') }
      : s,
);
const SOP = {
  published: { id: 'v2', versionNo: 2, status: 'published', sections: PUBLISHED },
  draft: { id: 'd1', versionNo: null, status: 'draft', rev: 4, basedOn: 'v2', sections: DRAFT, stale: false },
  spec: SOP_SPEC,
  budget: { chars: 2303, limit: 2658 },
} as unknown as SopOverview;
const violation = (code: ContractViolation['code'], sectionKey: string | null): ContractViolation => ({
  code,
  sectionKey,
  detail: 'search_route 不是现有的工具名',
});
const CHECK: DraftCheck = {
  promptHash: 'p',
  prefixHash: 'x',
  chars: 2303,
  limit: 2658,
  violations: [violation('unknown_tool', 'tone')],
  rebase: { needed: false, conflicts: [] },
};

const STATUS: Status = {
  mode: 'db',
  tenantSlug: 'yuntu',
  sop: {
    versionId: 'v2',
    versionNo: 2,
    publishedAt: at('2026-09-25T18:30:00'),
    promptHash: 'a',
    toolsHash: 'b',
    prefixHash: 'c',
    sopHash: 'd',
  },
  lock: 'held',
  sopStale: false,
  catalogStale: false,
  index: { indexGeneration: 3, snapshotGeneration: 3, stale: false, lastError: null },
  drift: {
    editedSections: ['tone'],
    catalog: { route: { changed: [], onlyDb: [], onlyImage: [] }, hotel: { changed: [], onlyDb: [], onlyImage: [] } },
  },
};

let auditId = 30;
const audit = (
  when: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  diff: unknown,
  actor: Pick<AuditEntryView, 'actorKind' | 'actorName'> = { actorKind: 'user', actorName: '小林' },
): AuditEntryView => ({ id: (auditId -= 1), at: at(when), ...actor, action, targetType, targetId, diff });
const CLI = { actorKind: 'platform', actorName: null } as const;
/** 设计系统 §10.0 的审计（新的在前）；6 条 CSV 导入的酒店草稿相隔几秒 */
const AUDIT: AuditEntryView[] = [
  audit('2026-09-26T13:40:00', 'catalog.create', 'route', 'r-guizhou-5d', { title: [null, GUIZHOU.title] }),
  ...HOTEL_DRAFTS.map((name, i) =>
    audit(`2026-09-26T11:20:0${5 - i}`, 'catalog.create', 'hotel', `h-new-${'abcdef'[i]}`, { name: [null, name] }),
  ),
  audit('2026-09-26T10:12:00', 'catalog.update', 'route', 'r-sichuan-lux', {
    hotelLevel: ['豪华', '顶级野奢'],
    highlights: [['a'], ['a', 'b']],
  }),
  audit(
    '2026-09-25T18:30:00',
    'sop.publish',
    'sop',
    'v2',
    { versionNo: 2, changedKeys: ['objections'] },
    { actorKind: 'user', actorName: '老板' },
  ),
  audit('2026-09-24T10:05:00', 'platform.user_create', 'user', 'u2', { email: 'xiaolin@yuntu.test', role: 'admin', created: true }, CLI),
  audit('2026-09-24T10:03:00', 'platform.user_create', 'user', 'u1', { email: 'boss@yuntu.test', role: 'owner', created: true }, CLI),
  audit('2026-09-24T10:02:00', 'config.import', null, null, {}, CLI),
  audit('2026-09-24T10:01:00', 'platform.tenant_create', null, null, {}, CLI),
];

// ---------------- 1. 纯逻辑 ----------------

const waiting = waitingTodos(WAITING, TRAVEL, NOW, workbenchHref);
eq(
  '等人接手：最后动静早的在前（A01 26分钟前在 F01 8分钟前前面）',
  waiting.map((r) => r.title),
  [
    ['企微客户', 'A01'],
    ['企微客户', 'F01'],
  ],
);
eq(
  '等人接手：上下文只写渠道、消息条数、最后动静',
  waiting.map((r) => r.context.map((s) => s.text)),
  [
    ['企业微信', '7条消息', '最后动静26分钟前'],
    ['企业微信', '2条消息', '最后动静8分钟前'],
  ],
);
eq('等人接手：新标签打开工作台', waiting[0]?.target, { kind: 'workbench', href: '/admin.html#s=wecom%3Acust_A01' });
eq('认不出的渠道不写原码', waitingTodos([{ ...WAITING[0]!, channel: 'fax' }], TRAVEL, NOW, workbenchHref)[0]?.context.length, 2);

const sop = sopTodo(SOP, CHECK, TRAVEL);
eq('话术草稿：改了哪几节、各差多少字', sop?.title, '改了2节：话术原则（+44字）、异议处理（+9字）');
eq('话术草稿：问题用 danger，后跟发布前检查', sop?.context, [
  { text: '1个问题：话术原则里有个工具名写错了', tone: 'danger' },
  { text: '发布前检查6/7通过' },
]);
eq('话术草稿：检查没取到时只写第一行', sopTodo(SOP, undefined, TRAVEL)?.context, []);
eq('没有草稿就没有这一行', sopTodo({ ...SOP, draft: null }, CHECK, TRAVEL), null);
eq(
  '字数减少写「-」，字数不变不写括号',
  sopTodo(
    {
      ...SOP,
      draft: {
        ...SOP.draft!,
        sections: PUBLISHED.map((s) =>
          s.key === 'tone'
            ? { key: s.key, text: body('话术原则', 900) }
            : s.key === 'preamble'
              ? { key: s.key, text: body(null, 232, 'z') }
              : s,
        ),
      },
    },
    CHECK,
    TRAVEL,
  )?.title,
  '改了2节：前言、话术原则（-10字）',
);
eq('草稿和线上一样', sopTodo({ ...SOP, draft: { ...SOP.draft!, sections: PUBLISHED } }, CHECK, TRAVEL)?.title, '草稿和线上一样');
eq(
  '话术草稿：两个问题写「等」，检查通过项按问题的种类数算',
  sopTodo(SOP, { ...CHECK, violations: [violation('phrase_forbidden', 'tone'), violation('phrase_forbidden', 'objections')] }, TRAVEL)
    ?.context,
  [{ text: '2个问题：话术原则里有不能出现的话等', tone: 'danger' }, { text: '发布前检查6/7通过' }],
);
{
  const codes = [
    'structure',
    'locked_changed',
    'phrase_missing',
    'phrase_forbidden',
    'unknown_tool',
    'unknown_field',
    'over_budget',
  ] as const;
  const texts = codes.flatMap((c) => [sopProblemText(violation(c, 'tone'), TRAVEL), sopProblemText(violation(c, null), TRAVEL)]);
  check(
    '话术问题的说法不带工具、字段、短语的原文，也没有英文',
    texts.every((t) => !/[A-Za-z]/.test(t) && t.length > 0),
    texts.join(' / '),
  );
  eq('话术问题：节名取自行业包，前言写「前言」', sopProblemText(violation('unknown_field', 'preamble'), TRAVEL), '前言里有个字段名写错了');
  eq('话术问题：固定规则节点名', sopProblemText(violation('locked_changed', 'stages'), TRAVEL), '固定规则节「各阶段目标」被改了');
}

const lists = [
  { entity: ROUTE, items: ROUTES },
  { entity: HOTEL, items: HOTELS },
];
const catalog = catalogTodos(lists, NOW);
eq(
  '待上架：按最近一条的更新时间倒序，1 条写条目名、多条合成一行',
  catalog.map((r) => r.title),
  ['线路草稿「贵州 小七孔·西江千户苗寨 5 日」', '6条酒店草稿'],
);
eq('待上架：线路草稿的上下文（必须项与建议项由 checkItem 算）', catalog[0]?.context, [
  { text: '小林更新于13:40' },
  { text: '必须项7/7已过' },
  { text: '建议1条没做：体力强度没填（不拦上架）' },
]);
eq('待上架：多条草稿列出前 3 个名称', catalog[1]?.context, [
  { text: '小林更新于11:20' },
  { text: '青城山六善酒店、成都锦江宾馆、大研安缦等6条' },
]);
eq(
  '待上架：图标、动作与去向取自行业包的实体',
  catalog.map((r) => [r.icon, r.type, r.action, r.target]),
  [
    [{ entity: 'route' }, { text: '待上架' }, '去上架', { kind: 'catalog', entity: 'route', code: 'r-guizhou-5d' }],
    [{ entity: 'bed-double' }, { text: '待上架' }, '逐条检查', { kind: 'catalog', entity: 'hotel' }],
  ],
);
{
  const broken = { ...GUIZHOU, itinerary: GUIZHOU.itinerary.map((d, i) => (i === 2 ? { title: d.title } : d)) };
  const one = catalogTodos([{ entity: ROUTE, items: [item('route', 'r-x', broken, 'draft', at('2026-09-26T13:40:00'), '小林')] }], NOW);
  eq('待上架：必须项没过写 danger，有序子项写到第几天', one[0]?.context[1], { text: '必须项6/7：第3天当晚住宿没填', tone: 'danger' });
  const two = catalogTodos(
    [{ entity: ROUTE, items: [item('route', 'r-x', { ...broken, days: 6 }, 'draft', at('2026-09-26T13:40:00'))] }],
    NOW,
  );
  eq('待上架：几处没过写「等」；没有更新人只写「更新于」', two[0]?.context.slice(0, 2), [
    { text: '更新于13:40' },
    { text: '必须项5/7：第3天当晚住宿没填等', tone: 'danger' },
  ]);
  eq('待上架：三条以内不写「等」', catalogTodos([{ entity: HOTEL, items: HOTELS.slice(-2) }], NOW)[0]?.context[1], {
    text: '西双版纳安纳塔拉、腾冲石头纪',
  });
  eq('没有草稿的实体不出现', catalogTodos([{ entity: HOTEL, items: HOTELS.slice(0, 23) }], NOW), []);
  eq(
    '上架前检查的问题：取中文路径的后两段',
    issueText({ path: 'itinerary.2.hotel', label: '逐日行程 · 第3天 · 当晚住宿', message: '没填' }),
    '第3天当晚住宿没填',
  );
  eq(
    '更新时间：昨天与更早',
    [updatedWhen(at('2026-09-25T21:40:00'), NOW), updatedWhen(at('2026-09-24T10:05:00'), NOW)],
    ['昨天21:40', '9月24日 10:05'],
  );
}
eq(
  '需要你处理的顺序（验收 10）：A01、F01、话术草稿、线路草稿、6条酒店草稿',
  todoOrder(waiting, sop, catalog).map((r) => r.key),
  ['conv:wecom:cust_A01', 'conv:wecom:cust_F01', 'sop', 'catalog:route:r-guizhou-5d', 'catalog:hotel'],
);

// 系统状态
eq('系统状态：一切正常', systemView(STATUS, TRAVEL), { ok: true, lead: '一切正常', rest: ['线上话术v2', '产品库改动已生效'] });
{
  const bad = systemView(
    { ...STATUS, lock: 'lost', sopStale: true, catalogStale: true, index: { ...STATUS.index, lastError: 'ECONNRESET' } },
    TRAVEL,
  );
  eq('系统状态：锁断开是 danger，其余是 warning；lastError 只进技术详情', bad, {
    ok: false,
    alerts: [
      { tone: 'danger', text: '暂时无法保存修改：和数据库的锁连接断开了，系统在自动重连。线上话术和产品不受影响。' },
      { tone: 'warning', text: '话术和产品库的最新修改还没载入运行中的系统，正在自动重试。' },
      { tone: 'warning', text: '线路搜索索引在更新，新上架的线路可能暂时搜不到。', tech: [['index.lastError', 'ECONNRESET']] },
    ],
  });
  eq('系统状态：索引在更新、没有报错时照样提醒，不带技术详情', systemView({ ...STATUS, index: { ...STATUS.index, stale: true } }, TRAVEL), {
    ok: false,
    alerts: [{ tone: 'warning', text: '线路搜索索引在更新，新上架的线路可能暂时搜不到。' }],
  });
  eq('系统状态：只有产品库没载入', systemView({ ...STATUS, catalogStale: true }, TRAVEL), {
    ok: false,
    alerts: [{ tone: 'warning', text: '产品库的最新修改还没载入运行中的系统，正在自动重试。' }],
  });
  eq(
    '系统状态：drift 不在总览里',
    systemView({ ...STATUS, drift: { ...STATUS.drift, editedSections: ['tone', 'objections'] } }, TRAVEL).ok,
    true,
  );
}

// 业务数
const kpis = memberKpis({
  counts: COUNTS,
  waiting: WAITING,
  latestPaid: A02,
  catalog: catalogCounts(lists),
  pack: TRAVEL,
  editor: true,
  now: NOW,
});
eq(
  '业务数：四格的名称与数字（同一次 counts）',
  kpis.map((k) => [k.label, k.value]),
  [
    ['会话', 13],
    ['等人接手', 2],
    ['已成交', 1],
    ['在售产品', 43],
  ],
);
eq(
  '业务数：口径',
  kpis.map((k) => k.caption),
  [
    ['企业微信里的客户会话，不含网页试聊'],
    ['AI已转人工、还没成交的会话'],
    ['阶段到了「已支付」的会话'],
    ['线路20', '酒店23，销售助手只推荐这些'],
  ],
);
eq(
  '业务数：明细（设计系统 A 页）',
  kpis.map((k) => k.breakdown),
  [['今天有新动静的6个'], ['最后动静：26分钟前、8分钟前'], ['企微客户', 'A02', '9月24日'], ['另有草稿7条：线路1', '酒店6']],
);
eq(
  '业务数：去向',
  kpis.map((k) => k.target),
  [
    { kind: 'conversations' },
    { kind: 'conversations', state: 'human' },
    { kind: 'conversations', state: 'paid' },
    { kind: 'catalog', entity: 'route' },
  ],
);
{
  const four = [
    ...WAITING,
    conv('B09', 'quote', true, 1, new Date(NOW - 90 * MIN).toISOString()),
    conv('B08', 'quote', true, 1, new Date(NOW - 3 * MIN).toISOString()),
  ];
  const k = memberKpis({
    counts: { ...COUNTS, byState: { ai: 6, human: 6, paid: 0 } },
    waiting: four,
    latestPaid: null,
    catalog: catalogCounts([{ entity: ROUTE, items: [] }]),
    pack: TRAVEL,
    editor: true,
    now: NOW,
  });
  eq(
    '业务数：等人接手的数取 counts（不是那一页的条数）；最后动静最多写 3 个，多的写「等N个」；没有成交',
    [k[1]?.value, k[1]?.breakdown, k[2]?.breakdown],
    [6, ['最后动静：1小时前、26分钟前、8分钟前等6个'], ['还没有成交的会话']],
  );
  eq(
    '在售数为 0：编辑者的明细是「新建线路」',
    [k[3]?.value, k[3]?.breakdown, k[3]?.create],
    [0, null, { entity: 'route', label: '新建线路' }],
  );
  const agent = inSaleKpi(catalogCounts([{ entity: ROUTE, items: [] }]), TRAVEL, { anon: false, editor: false });
  eq('在售数为 0：非编辑者没有新建链接', [agent.breakdown, agent.create], [['没有草稿'], undefined]);
  const noWaiting = memberKpis({
    counts: COUNTS,
    waiting: [],
    latestPaid: A02,
    catalog: catalogCounts(lists),
    pack: TRAVEL,
    editor: false,
    now: NOW,
  });
  eq('等人接手为空', noWaiting[1]?.breakdown, ['现在没有等人接手的会话']);
  const anon = inSaleKpi(
    catalogCounts([{ entity: ROUTE, items: ROUTES.filter((r) => r.status === 'active').map(({ status: _s, ...r }) => r) }]),
    TRAVEL,
    { anon: true, editor: false },
  );
  eq(
    '匿名的在售格：没有状态的条目都算在售，不画明细',
    [anon.value, anon.breakdown, anon.caption],
    [20, null, ['线路20，销售助手只推荐这些']],
  );
}

// 客户停在哪一步
{
  const rows = stageRows(TRAVEL, COUNTS.aiByStage);
  eq(
    '阶段条：阶段名和顺序来自行业包，不含终态',
    rows.map((r) => [r.label, r.count, r.branch]),
    [
      ['开场', 0, false],
      ['问需', 4, false],
      ['推荐', 3, false],
      ['报价', 2, false],
      ['异议', 0, true],
      ['促成', 1, false],
    ],
  );
  eq(
    '阶段条：按最大值缩放（4 → 整条）',
    rows.map((r) => r.ratio),
    [0, 1, 0.75, 0.5, 0, 0.25],
  );
  eq(
    '阶段条：各行之和等于 AI 接待中',
    rows.reduce((n, r) => n + r.count, 0),
    COUNTS.byState.ai,
  );
  const shuffled: IndustryPack = { ...TRAVEL, stages: [TRAVEL.stages[4]!, ...TRAVEL.stages.filter((s) => s.key !== 'objection')] };
  eq(
    '阶段条：分支阶段排在它的主阶段后面（包里写在前面也一样）',
    stageRows(shuffled, COUNTS.aiByStage).map((r) => r.key),
    ['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing'],
  );
  const other = stageRows(TRAVEL, { ...COUNTS.aiByStage, handoff: 1, legacy: 2 });
  eq('阶段条：包里没有的阶段合成「其他」，不能点', other.at(-1), { key: null, label: '其他', count: 3, branch: false, ratio: 0.75 });
  eq(
    '阶段条：没有会话时不画条',
    stageRows(TRAVEL, {}).map((r) => r.ratio),
    [0, 0, 0, 0, 0, 0],
  );
  eq('阶段条：原型上的名字不算阶段', stageRows(TRAVEL, JSON.parse('{"toString": 5}')).at(-1)?.label, '其他');
}

// 最近变更
{
  const itemName = (kind: string, code: string): string | undefined =>
    kind === 'route' && code === 'r-sichuan-lux' ? '四川 稻城亚丁·色达秘境 8 日' : undefined;
  const rows = timeline(AUDIT, TRAVEL, { itemName }, NOW);
  const text = (r: (typeof rows)[number]): string => `${r.actor.name} ${r.parts.map((p) => p.text).join('')}${r.tail ?? ''}`;
  eq('最近变更：先合并再取 5 句（设计系统 A 页）', rows.map(text), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
    '老板 发布了话术v2，改了1节（异议处理）',
    '命令行 为xiaolin@yuntu.test建了账号（角色：管理员）',
  ]);
  eq(
    '最近变更：同一天只在第一条写日期',
    rows.map((r) => r.time),
    ['今天 13:40', '11:20', '10:12', '9月25日 18:30', '9月24日 10:05'],
  );
  eq(
    '最近变更：命令行不画头像；对象用 500',
    [rows[4]?.actor.human, rows[0]?.parts.filter((p) => p.strong).map((p) => p.text)],
    [false, ['贵州 小七孔·西江千户苗寨 5 日']],
  );
  eq('审计取够了：一次导入还没取完', enoughAudit(AUDIT.slice(0, 4), 26), false);
  eq('审计取够了：合出来多于 5 句', enoughAudit(AUDIT, 1), true);
  // 正好 5 句、第 5 句是被页边截断的一次导入：还要往前取，不然会写成「新建了3条酒店草稿」
  const cut = [AUDIT[0]!, AUDIT[7]!, AUDIT[8]!, AUDIT[9]!, ...AUDIT.slice(1, 4)];
  eq('审计取够了：正好 5 句还不算（第 5 句可能没取完）', [auditRuns(cut).length, enoughAudit(cut, 99)], [5, false]);
  eq('审计取够了：没有更早的记录', enoughAudit(AUDIT.slice(0, 2), null), true);
}

// ---------------- 2. 在 DOM 里挂载 ----------------
// 页面的「现在」取 Date.now()：钉在场景时刻（走查用 Playwright 的 page.clock.setFixedTime 做同样的事）
Date.now = () => NOW;

/** 另一份行业包：实体、阶段、叫法都不同，页面照样画（界面不认行业） */
const PKG = entity('package', '装修套餐', 'package', 'title', [f('$code', 'text', '套餐编号'), f('title', 'text', '套餐名称')]);
const MATERIAL = entity('material', '主材', 'layers', 'name', [f('$code', 'text', '主材编号'), f('name', 'text', '主材名称')]);
const HOME: IndustryPack = {
  ...TRAVEL,
  id: 'fixture-home',
  vocabulary: { ...TRAVEL.vocabulary, customer: '业主', productNoun: '方案' },
  entities: [PKG, MATERIAL],
  stages: [
    { key: 'consult', label: '咨询' },
    { key: 'measure', label: '量房' },
    { key: 'design', label: '方案' },
    { key: 'deposit', label: '已付定金', terminal: true },
  ],
  nav: { catalogGroup: '套餐与主材', entities: ['package', 'material'] },
};

interface Server {
  pack: IndustryPack;
  lists: Record<string, object[]>;
  /** 这些路径回 500 */
  fail?: RegExp;
  /** 审计每页最多给几条（不看请求的 limit），用来测按页往前取 */
  auditPage?: number;
}
let server: Server = { pack: TRAVEL, lists: {} };
let requests: string[] = [];
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

function respond(method: string, url: URL): Response {
  const p = url.pathname.replace(/^\/api\/console/, '');
  const q = url.searchParams;
  if (server.fail?.test(`${method} ${p}`)) return json(500, { error: 'internal', detail: '故意的' });
  if (method === 'GET' && p === '/conversations/counts') return json(200, COUNTS);
  if (method === 'GET' && p === '/conversations' && q.get('state') === 'human') return json(200, { items: WAITING, total: 2 });
  if (method === 'GET' && p === '/conversations' && q.get('state') === 'paid') return json(200, { items: [A02], total: 1 });
  if (method === 'GET' && p === '/conversations') {
    const quoted = q.get('state') === 'ai' && q.get('stage') === 'quote';
    return json(200, { items: quoted ? QUOTED : [], total: quoted ? QUOTED.length : 0 });
  }
  if (method === 'GET' && p === '/sop') return json(200, SOP);
  if (method === 'POST' && p === '/sop/draft/check') return json(200, CHECK);
  if (method === 'GET' && p === '/status') return json(200, STATUS);
  if (method === 'GET' && p.startsWith('/catalog/')) {
    const kind = p.slice('/catalog/'.length);
    return Object.hasOwn(server.lists, kind) ? json(200, { items: server.lists[kind] }) : json(400, { error: 'bad_request' });
  }
  if (method === 'GET' && p === '/audit') {
    const before = q.has('before') ? Number(q.get('before')) : Infinity;
    const size = server.auditPage ?? Number(q.get('limit'));
    const allowed = new Set((q.get('actions') ?? '').split(','));
    const rows = AUDIT.filter((e) => e.id < before && allowed.has(e.action));
    const items = rows.slice(0, size);
    return json(200, { items, nextBefore: rows.length > size ? items.at(-1)!.id : null });
  }
  return json(404, { error: 'not_found' });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  return respond(method, url);
}) as typeof fetch;

const me = (role: Role): Me => ({ userId: 'u1', displayName: '老板', role, csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' });

/** 挂上真的 OverviewPage：路由只有它和几个空页（链接要能算出地址），查询缓存里放好来者；等请求都回来 */
async function mountOverview(viewer: Viewer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  const root = createRootRoute({ component: Outlet });
  const page = (path: string) => createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: OverviewPage }),
      page('/sop'),
      page('/audit'),
      page('/conversations'),
      page('/catalog/$kind'),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: ['/console/'] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
  const $ = (sel: string): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(sel)];
  return {
    box,
    $,
    texts: (sel: string): string[] => $(sel).map((e) => (e.textContent ?? '').trim()),
    hrefs: (sel: string): string[] => $(sel).map((e) => e.getAttribute('href') ?? ''),
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
    },
  };
}

const SCENE = { route: ROUTES, hotel: HOTELS };
const member = (role: Role, pack = TRAVEL): Viewer => ({ kind: 'member', me: me(role), pack });

// 2.1 所有者：五块都在，内容与设计系统 A 页一致
{
  server = { pack: TRAVEL, lists: SCENE };
  requests = [];
  const m = await mountOverview(member('owner'));
  eq('所有者：区块顺序', m.texts('h2'), ['需要你处理', '最近变更', '客户停在哪一步']);
  eq('所有者：标签页标题', document.title, '总览 · 云途定制旅行');
  eq('所有者：页头状态句是租户名与日期', m.texts('.page-status'), ['云途定制旅行·9月26日 周六']);
  eq('需要你处理：5项', m.texts('.ov-count')[0], '5项');
  eq('需要你处理：顺序（验收 10）', m.texts('.ov-todo-title'), [
    '企微客户·A01',
    '企微客户·F01',
    '改了2节：话术原则（+44字）、异议处理（+9字）',
    '线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '6条酒店草稿',
  ]);
  eq('需要你处理：上下文', m.texts('.ov-todo-context'), [
    '企业微信·7条消息·最后动静26分钟前',
    '企业微信·2条消息·最后动静8分钟前',
    '1个问题：话术原则里有个工具名写错了·发布前检查6/7通过',
    '小林更新于13:40·必须项7/7已过·建议1条没做：体力强度没填（不拦上架）',
    '小林更新于11:20·青城山六善酒店、成都锦江宾馆、大研安缦等6条',
  ]);
  eq('需要你处理：danger 只有话术问题那一段', m.texts('.ov-danger'), ['1个问题：话术原则里有个工具名写错了']);
  eq('需要你处理：等人接手画状态胶囊', m.$('.ov-todo .status-human').length, 2);
  eq('需要你处理：整行是链接', m.hrefs('a.ov-todo'), [
    '/admin.html#s=wecom%3Acust_A01',
    '/admin.html#s=wecom%3Acust_F01',
    '/console/sop',
    '/console/catalog/route',
    '/console/catalog/hotel',
  ]);
  eq(
    '需要你处理：工作台在新标签打开',
    m.$('a.ov-todo').map((a) => a.getAttribute('target')),
    ['_blank', '_blank', null, null, null],
  );
  eq('需要你处理：操作', m.texts('.ov-todo-action'), ['打开工作台', '打开工作台', '继续编辑', '去上架', '逐条检查']);
  eq('系统状态：一切正常', m.texts('.ov-system-line'), ['一切正常·线上话术v2·产品库改动已生效']);
  eq('业务数：数字', m.texts('.ov-kpi-value'), ['13', '2', '1', '43']);
  eq('业务数：明细', m.texts('.ov-kpi-detail'), [
    '今天有新动静的6个',
    '最后动静：26分钟前、8分钟前',
    '企微客户·A02·9月24日',
    '另有草稿7条：线路1·酒店6',
  ]);
  eq('业务数：整格链到筛选列表', m.hrefs('a.ov-kpi'), [
    '/console/conversations',
    '/console/conversations?state=human',
    '/console/conversations?state=paid',
    '/console/catalog/route',
  ]);
  eq('客户停在哪一步：计数', m.texts('.ov-stages-block .ov-count'), ['AI接待中的10个']);
  eq(
    '客户停在哪一步：每行链到这一阶段 AI 接待中的会话（验收 10 的「报价」）',
    m.hrefs('a.ov-stage'),
    ['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing'].map((s) => `/console/conversations?state=ai&stage=${s}`),
  );
  eq(
    '客户停在哪一步：0 的行不画条，异议缩进',
    m.$('.ov-stage').map((e) => [e.querySelector('.ov-stage-bar') !== null, e.classList.contains('is-branch')]),
    [
      [false, false],
      [true, false],
      [true, false],
      [true, false],
      [false, true],
      [true, false],
    ],
  );
  eq('客户停在哪一步：区块头链到 AI 接待中', m.hrefs('.ov-stages-block .ov-head-link'), ['/console/conversations?state=ai']);
  eq('最近变更：时间', m.texts('.ov-tl-time'), ['今天 13:40', '11:20', '10:12', '9月25日 18:30', '9月24日 10:05']);
  eq('最近变更：句子', m.texts('.ov-tl-text'), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
    '老板 发布了话术v2，改了1节（异议处理）',
    '命令行 为xiaolin@yuntu.test建了账号（角色：管理员）',
  ]);
  // 头像写名字的首字（设计系统 §6.8，与侧栏用户行相同）
  eq('最近变更：头像与命令行方块', [m.texts('.ov-timeline .avatar'), m.$('.ov-tl-bot').length], [['小', '小', '小', '老'], 1]);
  eq('最近变更：查看全部', m.hrefs('.ov-all'), ['/console/audit']);
  const auditReq = requests.filter((r) => r.startsWith('GET /api/console/audit'));
  check(
    '最近变更：不含登录记录，一页就取够',
    auditReq.length === 1 && !auditReq[0]!.includes('auth.login') && auditReq[0]!.includes('catalog.create'),
    auditReq.join(' | '),
  );
  eq('草稿检查只发一次', requests.filter((r) => r === 'POST /api/console/sop/draft/check').length, 1);
  check('所有者：没有「没取到」', !m.box.textContent?.includes('没取到'));
  await m.unmount();
}

// 2.2 某个接口出错：只有用它的那一块写「没取到」，其余照常（验收 10）
const blockOf = (e: HTMLElement): string =>
  e.closest('.ov-recent')
    ? '最近变更'
    : e.closest('.ov-stages-block')
      ? '阶段'
      : e.closest('.ov-kpi-block')
        ? '业务数'
        : e.closest('.ov-system')
          ? '系统状态'
          : '需要你处理';
async function failing(fail: RegExp) {
  server = { pack: TRAVEL, lists: SCENE, fail };
  const m = await mountOverview(member('owner'));
  const errs = m.$('.ant-alert').filter((a) => a.textContent?.includes('没取到'));
  const out = {
    blocks: errs.map(blockOf),
    // 自测没套 ThemeProvider，antd 会在两个汉字的按钮中间插空格
    retry: errs.map((a) => [...a.querySelectorAll('button')].some((b) => (b.textContent ?? '').replace(/\s/g, '') === '重试')),
    todos: m.$('.ov-todo-title').length,
    kpis: m.$('.ov-kpi-value').length,
    stages: m.$('.ov-stage').length,
    timeline: m.$('.ov-tl-text').length,
    system: m.texts('.ov-system-line').join(''),
    context: m.texts('.ov-todo-context'),
  };
  await m.unmount();
  return out;
}
{
  const a = await failing(/^GET \/audit$/);
  eq('/audit 500：只有「最近变更」写「没取到 · 重试」', [a.blocks, a.retry], [['最近变更'], [true]]);
  eq('/audit 500：其余块正常', [a.todos, a.kpis, a.stages, a.system], [5, 4, 6, '一切正常·线上话术v2·产品库改动已生效']);
  const s = await failing(/^GET \/status$/);
  eq('/status 500：只有系统状态出错', [s.blocks, s.todos, s.kpis, s.timeline], [['系统状态'], 5, 4, 5]);
  const c = await failing(/^GET \/conversations\/counts$/);
  eq(
    'counts 500：业务数与阶段条出错，待办与最近变更照常',
    [c.blocks, c.todos, c.timeline, c.system !== ''],
    [['业务数', '阶段'], 5, 5, true],
  );
  const k = await failing(/^POST \/sop\/draft\/check$/);
  eq(
    '检查 500：待办照列，话术草稿不写检查结果，块里写「没取到」',
    [k.blocks, k.todos, k.context.some((c) => c.includes('发布前检查'))],
    [['需要你处理'], 5, false],
  );
  const h = await failing(/^GET \/catalog\/hotel$/);
  eq('一个实体的列表 500：待办里只少这一行，业务数出错', [h.blocks, h.todos, h.stages], [['需要你处理', '业务数'], 4, 6]);
}

// 2.3 坐席：没有「最近变更」和草稿类待办，也不发这些请求；右栏挪到左栏的位置
{
  server = { pack: TRAVEL, lists: SCENE };
  requests = [];
  const m = await mountOverview(member('agent'));
  eq('坐席：区块', m.texts('h2'), ['需要你处理', '客户停在哪一步']);
  eq('坐席：待办只有等人接手', m.texts('.ov-todo-title'), ['企微客户·A01', '企微客户·F01']);
  eq('坐席：2项', m.texts('.ov-count')[0], '2项');
  check('坐席：底部只剩一栏', m.$('.ov-bottom.is-single').length === 1 && m.$('.ov-recent').length === 0);
  eq('坐席：业务数四格都在', m.$('.ov-kpi').length, 4);
  const sent = requests.filter((r) => /\/sop|\/audit/.test(r));
  eq('坐席：不取话术、检查、审计', sent, []);
  check('坐席：页头有「只读」胶囊', m.$('.readonly-pill').length === 1);
  await m.unmount();
}
{
  // 没有要处理的事：一句说明，不放按钮
  server = {
    pack: TRAVEL,
    lists: { route: ROUTES.filter((r) => r.status === 'active'), hotel: HOTELS.filter((h) => h.status === 'active') },
  };
  const saved = WAITING.splice(0);
  const m = await mountOverview(member('owner'));
  const sop0 = SOP.draft;
  eq('没有要处理的事（有话术草稿时照列）', m.texts('.ov-todo-title'), ['改了2节：话术原则（+44字）、异议处理（+9字）']);
  await m.unmount();
  (SOP as { draft: unknown }).draft = null;
  const e = await mountOverview(member('owner'));
  eq(
    '没有要处理的事：空状态',
    [e.texts('.state-empty-title'), e.$('.state-empty button').length, e.texts('.ov-count')[0]],
    [['没有要处理的事'], 0, '0项'],
  );
  await e.unmount();
  (SOP as { draft: unknown }).draft = sop0;
  WAITING.push(...saved);
}

// 2.4 demo 匿名：横幅，只有在售一格，只取产品库列表
{
  const anonList = (xs: CatalogItem[]) =>
    xs.filter((x) => x.status === 'active').map((x) => ({ kind: x.kind, code: x.code, payload: x.payload }));
  server = { pack: TRAVEL, lists: { route: anonList(ROUTES), hotel: anonList(HOTELS) } };
  requests = [];
  const m = await mountOverview({ kind: 'anon', pack: TRAVEL });
  eq('匿名：没有待办、阶段、最近变更、系统状态', [m.texts('h2'), m.$('.ov-system').length], [[], 0]);
  eq('匿名：只有在售一格', [m.texts('.ov-kpi-label'), m.texts('.ov-kpi-value'), m.$('.ov-kpi-detail').length], [['在售产品'], ['43'], 0]);
  eq('匿名：只取产品库列表', [...new Set(requests)].sort(), ['GET /api/console/catalog/hotel', 'GET /api/console/catalog/route']);
  check('匿名：演示横幅；页头不写租户名', m.$('.anon-banner').length === 1 && m.texts('.page-status')[0] === '9月26日 周六');
  eq('匿名：标签页标题', document.title, '总览 · 演示');
  await m.unmount();
}

// 2.5 审计按页往前取：每页只给 4 条时，一次导入的 6 条也合成一句
{
  server = { pack: TRAVEL, lists: SCENE, auditPage: 4 };
  requests = [];
  const m = await mountOverview(member('admin'));
  eq('审计分页：句子不被截断', m.texts('.ov-tl-text').slice(0, 3), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
  ]);
  const pages = requests.filter((r) => r.startsWith('GET /api/console/audit'));
  check(
    '审计分页：取到合出 6 句为止（3 页）',
    pages.length === 3 && pages[1]!.includes('before=') && !pages[0]!.includes('before='),
    pages.join(' | '),
  );
  await m.unmount();
}

// 2.6 换一个行业包：实体、阶段、叫法都跟着换，请求的是这个包的 kind
{
  const PKG_ITEMS = [
    item('package', 'p-1', { id: 'p-1', title: '暖木 · 两居全包经典版' }, 'draft', at('2026-09-26T09:00:00'), '小林'),
    item('package', 'p-2', { id: 'p-2', title: '现代简约三居' }, 'active', at('2026-09-24T09:00:00')),
  ];
  const MAT_ITEMS = [item('material', 'm-1', { id: 'm-1', name: '实木地板' }, 'active', at('2026-09-24T09:00:00'))];
  server = { pack: HOME, lists: { package: PKG_ITEMS, material: MAT_ITEMS } };
  requests = [];
  const m = await mountOverview(member('owner', HOME));
  eq('别的行业包：待上架', m.texts('.ov-todo-title').slice(3), ['装修套餐草稿「暖木 · 两居全包经典版」']);
  eq(
    '别的行业包：在售格',
    [m.texts('.ov-kpi-label')[3], m.texts('.ov-kpi-caption')[3], m.texts('.ov-kpi-detail')[3]],
    ['在售方案', '装修套餐1·主材1，销售助手只推荐这些', '另有草稿1条：装修套餐1'],
  );
  eq('别的行业包：已成交的口径取终态阶段名', m.texts('.ov-kpi-caption')[2], '阶段到了「已付定金」的会话');
  eq('别的行业包：阶段条', m.texts('.ov-stage-label'), ['咨询', '量房', '方案', '其他']);
  eq('别的行业包：系统状态的产品库叫法', m.texts('.ov-system-line'), ['一切正常·线上话术v2·套餐与主材改动已生效']);
  eq('别的行业包：请求这个包的实体', [...new Set(requests.filter((r) => r.includes('/catalog/')))].sort(), [
    'GET /api/console/catalog/material',
    'GET /api/console/catalog/package',
  ]);
  check('别的行业包：页面上没有旅游包的实体名', !/线路|酒店/.test(m.box.textContent ?? ''), m.box.textContent ?? '');
  await m.unmount();
}

// 2.7 从阶段条、业务数跳到会话列表：地址里的 state、stage 经 validateSearch 进到接口的查询里（验收 10 的「报价」那一行）。
// 用 router.tsx 同一个 conversationsSearch；列表页整页随第 13 步重做，这里只钉「地址 → 请求 → 页头」这一段
async function mountConversations(search: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, member('owner'));
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/conversations',
        validateSearch: conversationsSearch,
        component: ConversationsPage,
      }),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [`/console/conversations${search}`] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
  const out = {
    status: [...box.querySelectorAll('.page-status')].map((e) => (e.textContent ?? '').trim()),
    rows: [...box.querySelectorAll('.ant-table-tbody tr[data-row-key]')].length,
    all: [...box.querySelectorAll('.page-status a')].map((a) => a.getAttribute('href')),
  };
  await act(async () => r.unmount());
  box.remove();
  qc.clear();
  return out;
}
{
  server = { pack: TRAVEL, lists: SCENE };
  requests = [];
  const quote = await mountConversations('?state=ai&stage=quote');
  eq(
    '会话列表：state、stage 进到请求里',
    requests.filter((r) => r.startsWith('GET /api/console/conversations')),
    ['GET /api/console/conversations?limit=20&offset=0&state=ai&stage=quote'],
  );
  eq(
    '会话列表：只列报价阶段 AI 接待中的会话，页头写明、能看全部',
    [quote.status, quote.rows, quote.all],
    [['只看报价阶段、AI接待中的会话看全部'], 2, ['/console/conversations']],
  );
  requests = [];
  const bad = await mountConversations('?state=bogus&stage=Quote');
  eq(
    '会话列表：不合规的 state、stage 丢掉，不发给接口',
    requests.filter((r) => r.startsWith('GET /api/console/conversations')),
    ['GET /api/console/conversations?limit=20&offset=0'],
  );
  eq('会话列表：没有筛选时页头不写「只看」', bad.status.join(''), '');
}

if (fails.length) {
  console.error(`overview: ${fails.length} 条断言失败（通过 ${pass} 条）`);
  for (const x of fails) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log(`overview: ${pass} 条断言全部通过`);
process.exit(0);
